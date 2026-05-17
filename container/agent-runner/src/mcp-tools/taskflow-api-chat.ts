/**
 * `api_send_chat` — 0h-v2 web-chat INGRESS tool for tf-mcontrol's
 * `POST /boards/{id}/chat` (memo §0.3). Dashboard-only `board_chat`
 * round-trip, NOT WhatsApp.
 *
 * Two effects, in order:
 *   1. `engine.apiSendChat` INSERTs the `board_chat` user row (the
 *      transcript `GET /chat` renders) — ALWAYS happens (V1 parity:
 *      `POST /chat` always records the message).
 *   2. Best-effort agent wake: enqueue a `taskflow_web_chat_inbound`
 *      system action on the service-session bus so the host
 *      delivery-action writes a trigger-bypassed `messages_in`. If the
 *      `--service-outbound-db` path is absent (tf fail-mode (b)) or the
 *      enqueue fails, the message is STILL recorded; the result carries
 *      `agent_notified:false` + `notify_error` (surfaced, never
 *      silently dropped) and the call does NOT fail — the transcript is
 *      correct regardless.
 *
 * board_id is used verbatim (handoff BLOCKER 2026-05-16: FastAPI passes
 * the trusted URL-path id; `normalizeAgentIds` is verbatim-aware and a
 * no-op in the subprocess). Auth/actor resolved FastAPI-side, flat.
 */
import { getTaskflowDb } from '../db/connection.js';
import { enqueueWebChatInbound } from '../db/taskflow-outbound.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import { getServiceOutboundDbPath, normalizeAgentIds } from './taskflow-helpers.js';
import type { McpToolDefinition } from './types.js';
import { jsonResponse } from './util.js';

function validationError(error: string) {
  return jsonResponse({ success: false, error_code: 'validation_error', error });
}

export const apiSendChatTool: McpToolDefinition = {
  tool: {
    name: 'api_send_chat',
    description:
      'Post a message to a board\'s dashboard web chat (board_chat transcript; visible in the TaskFlow dashboard, NOT WhatsApp); delegates to engine.apiSendChat and wakes the agent via the service bus. board_id is used verbatim; the sender is resolved by the API layer and passed flat.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        sender_name: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['board_id', 'content'],
    },
  },
  async handler(args) {
    // normalizeAgentIds FIRST (verbatim-aware; no-op in the FastAPI
    // subprocess) — mirrors every sibling FastAPI tool.
    const norm = normalizeAgentIds(args);
    if (typeof norm.board_id !== 'string' || norm.board_id.trim() === '') {
      return validationError('board_id: required non-empty string');
    }
    if (typeof norm.content !== 'string' || norm.content.trim() === '') {
      return validationError('content: required non-empty string');
    }
    const boardId = norm.board_id as string;
    const content = (norm.content as string).trim();
    const senderName =
      typeof norm.sender_name === 'string' && norm.sender_name.trim() !== ''
        ? (norm.sender_name as string)
        : 'web';

    // Engine throw MUST become a structured {success:false,
    // error_code:'internal_error'} envelope, never a JSON-RPC error
    // (FastAPI's parse_mcp_mutation_result → opaque 503). Sibling-tool
    // convention.
    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const result = engine.apiSendChat({ board_id: boardId, sender_name: senderName, content });
      if (!result.success || !result.data) {
        return jsonResponse({
          success: false,
          error_code: (result as { error_code?: string }).error_code ?? 'internal_error',
          error: result.error,
        });
      }
      const row = result.data as { id: number; created_at: string };

      // Best-effort agent wake — fail-mode (b): never throw the tool,
      // never silently drop; the board_chat row is already recorded.
      let agentNotified = false;
      let notifyError: string | undefined;
      const svc = getServiceOutboundDbPath();
      if (!svc) {
        notifyError = 'service-outbound-db not configured (agent not woken; message recorded)';
      } else {
        try {
          enqueueWebChatInbound(svc, {
            id: `taskflow-web:${row.id}`,
            board_id: boardId,
            board_chat_id: row.id,
            sender_name: senderName,
            content,
            created_at: row.created_at,
          });
          agentNotified = true;
        } catch (e: unknown) {
          notifyError = e instanceof Error ? e.message : String(e);
        }
      }

      return jsonResponse({
        success: true,
        data: result.data,
        agent_notified: agentNotified,
        ...(notifyError ? { notify_error: notifyError } : {}),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error_code: 'internal_error', error: msg });
    }
  },
};

registerTools([apiSendChatTool]);
