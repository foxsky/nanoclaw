/**
 * `api_task_add_comment` — single-engine MCP tool for the tf-mcontrol
 * `POST /boards/{id}/tasks/{tid}/comments` handler (retired onto
 * `engine.apiAddTaskComment`); the in-container WhatsApp agent uses the
 * same engine method. Flat FastAPI contract: the author is resolved
 * FastAPI-side (resolve_board_actor) and passed flat — NO sender_name /
 * actor parsing here, owner/access auth stays FastAPI-side (R2.3).
 *
 * ID handling (handoff BLOCKER 2026-05-16): `board_id` is used VERBATIM
 * — `normalizeAgentIds`' board-prefix branch breaks plain-UUID
 * web-POST boards, and every board-config/people tool already takes the
 * id from FastAPI's trusted URL path. `task_id` IS uppercased (the
 * handoff explicitly calls out this tool as one that needs task-id
 * normalization; engine ids are canonical-uppercase, e.g. SEC-T41).
 *
 * Result: FastAPI-parity 201 body as `data` + `notification_events`
 * (kept as past-tense observability — owner decision 2026-05-16: the
 * WhatsApp host path delivers them; FastAPI ignores them post-0j-a;
 * FastAPI-originated push delivery is the tracked 0h-v2 / Phase-3 item).
 */
import { getTaskflowDb } from './db/taskflow-db.js';
import { TaskflowEngine } from '../taskflow-engine.js';
// Author resolution (person_id-keying for the engine's self-comment notification
// suppression, plus the live-adapter JID phone match) lives in the shared
// resolveAuthenticatedSenderPerson — same rules as normalizeAgentIds' actor bind.
import { resolveAuthenticatedSenderPerson } from './actor-person-resolution.js';
import { requiresChatActor } from './chat-actor-guard.js';
import { isApprovedReplay } from './replay-flag.js';
import { registerTools } from './server.js';
import { getVerbatimIds, normalizeAgentIds } from './taskflow-helpers.js';
import { getTurnActor } from './turn-actor.js';
import { safeNotificationEvents } from './taskflow-api-mutate.js';
import { enqueueDeferredNotificationsInSession } from './pending-notification-dispatch.js';
import { dispatchNotificationEvents } from './taskflow-notify-dispatch.js';
import type { McpToolDefinition } from './types.js';
import { jsonResponse } from './util.js';

function validationError(error: string) {
  return jsonResponse({ success: false, error_code: 'validation_error', error });
}

export const apiTaskAddCommentTool: McpToolDefinition = {
  tool: {
    name: 'api_task_add_comment',
    description:
      'Add a comment to a task (a task_history action=comment row + updated_at bump); delegates to engine.apiAddTaskComment. board_id is used verbatim; the author is resolved by the API layer and passed flat.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        task_id: { type: 'string' },
        author_id: { type: 'string' },
        author_name: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['board_id', 'task_id', 'author_id', 'message'],
    },
  },
  async handler(args) {
    // ID handling = the sibling note-tool path, and it MUST run BEFORE
    // validation (Codex #3): normalizeAgentIds is verbatim-AWARE — in
    // the FastAPI subprocess (setVerbatimIds(true)) it is a no-op, so
    // board_id AND task_id are used exactly as FastAPI's fetch_task_row
    // already resolved them; for the in-container WhatsApp agent it
    // INJECTS board_id from NANOCLAW_TASKFLOW_BOARD_ID + case-folds
    // task_id like every other task tool. Validating board_id before
    // this ran rejected the legitimate env-injection path.
    const norm = normalizeAgentIds(args);
    if (typeof norm.board_id !== 'string' || norm.board_id.trim() === '') {
      return validationError('board_id: required non-empty string');
    }
    if (typeof norm.task_id !== 'string' || norm.task_id.trim() === '') {
      return validationError('task_id: required non-empty string');
    }
    // SEC#13 (#419): the comment author is a model arg (author_id/author_name are
    // resolved OUTSIDE parseTaskActorArgs, so normalizeAgentIds' sender_name bind never
    // reaches them). On the in-session chat surface OVERWRITE both with the authenticated
    // per-turn actor so an injected agent cannot attribute a comment to any board member.
    // requiresChatActor (this tool's wrapper) already denied an unresolved turn, so the
    // actor resolves here; author_id is bound to the canonical person_id and author_name
    // to the display name. The FastAPI subprocess (verbatim) keeps its server-resolved
    // author. Replay is excluded for symmetry (comments are never parked, but the guard
    // would have proceeded). Bind BEFORE the non-empty author validation below.
    if (process.env.NANOCLAW_TASKFLOW_BOARD_ID && !getVerbatimIds() && !isApprovedReplay()) {
      const actor = getTurnActor();
      if (actor.resolved) {
        // Shared resolver (delta-parity audit 2026-06-10): also resolves a
        // native-WhatsApp JID sender via board_people.phone, so live-adapter
        // comments attribute to the real person instead of a raw JID.
        const person = resolveAuthenticatedSenderPerson(norm.board_id as string, actor.sender, getTaskflowDb());
        norm.author_name = person?.name ?? actor.sender;
        norm.author_id = person?.personId ?? actor.sender;
      }
    }
    // CreateCommentPayload.validate_author / validate_message (main.py:151):
    // strip, then reject empty — surfaced as the same messages.
    if (typeof norm.author_id !== 'string' || norm.author_id.trim() === '') {
      return validationError('Author ID is required');
    }
    if (typeof norm.message !== 'string' || norm.message.trim() === '') {
      return validationError('Comment message is required');
    }
    const boardId = norm.board_id as string;
    const taskId = norm.task_id as string;
    const authorId = (norm.author_id as string).trim();
    const authorName =
      typeof norm.author_name === 'string' && norm.author_name.trim() !== ''
        ? norm.author_name
        : authorId;
    const message = (norm.message as string).trim();

    // Engine call + notification normalization wrapped in try/catch like
    // every sibling FastAPI tool (api_update_simple_task etc.): an
    // engine-side throw MUST become a structured {success:false,
    // error_code:'internal_error'} envelope, never escape as a JSON-RPC
    // error (which FastAPI's parse_mcp_mutation_result rejects as
    // "missing boolean success" → opaque 503).
    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const result = engine.apiAddTaskComment({
        board_id: boardId,
        task_id: taskId,
        author_id: authorId,
        author_name: authorName,
        message,
      });
      if (!result.success) {
        return jsonResponse({
          success: false,
          error_code: (result as { error_code?: string }).error_code,
          error: result.error,
        });
      }
      // Fail-soft: the comment has already committed, so a malformed engine
      // notification must not flip it to success:false via the catch below.
      const notification_events = safeNotificationEvents(result);
      // #396: a comment on a task assigned to a still-provisioning cross-board
      // person produces a null-JID deferred_notification — persist it (in-session,
      // fail-soft) so it's delivered once their board provisions, then dispatch.
      enqueueDeferredNotificationsInSession(boardId, notification_events, taskId, {});
      dispatchNotificationEvents(notification_events, boardId ? { boardId } : {});
      return jsonResponse({
        success: true,
        data: result.data,
        notification_events,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error_code: 'internal_error', error: msg });
    }
  },
};

// #419: commenting requires an authenticated chat actor (see chat-actor-guard.ts).
registerTools([requiresChatActor(apiTaskAddCommentTool)]);
