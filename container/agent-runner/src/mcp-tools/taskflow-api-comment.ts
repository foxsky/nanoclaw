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
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import { normalizeAgentIds, normalizeEngineNotificationEvents } from './taskflow-helpers.js';
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
    if (typeof args.board_id !== 'string' || args.board_id.trim() === '') {
      return validationError('board_id: required non-empty string');
    }
    if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
      return validationError('task_id: required non-empty string');
    }
    // CreateCommentPayload.validate_author / validate_message (main.py:151):
    // strip, then reject empty — surfaced as the same messages.
    if (typeof args.author_id !== 'string' || args.author_id.trim() === '') {
      return validationError('Author ID is required');
    }
    if (typeof args.message !== 'string' || args.message.trim() === '') {
      return validationError('Comment message is required');
    }

    // ID handling = the sibling note-tool path. normalizeAgentIds is
    // verbatim-AWARE: in the FastAPI subprocess (setVerbatimIds(true))
    // it is a no-op, so board_id AND task_id are used exactly as
    // FastAPI's fetch_task_row already resolved them; for the
    // in-container WhatsApp agent it injects board_id + case-folds
    // task_id like every other task tool. (A blunt unconditional
    // .toUpperCase() here was the `Task not found: TASK-SIMPLE` .61
    // regression — it mangled FastAPI's already-resolved id.)
    const norm = normalizeAgentIds(args);
    const boardId = norm.board_id as string;
    const taskId = norm.task_id as string;
    const authorId = args.author_id.trim();
    const authorName =
      typeof args.author_name === 'string' && args.author_name.trim() !== ''
        ? args.author_name
        : authorId;
    const message = args.message.trim();

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
    return jsonResponse({
      success: true,
      data: result.data,
      notification_events: normalizeEngineNotificationEvents(result),
    });
  },
};

registerTools([apiTaskAddCommentTool]);
