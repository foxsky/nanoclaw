/**
 * 0h-v2 web-chat REPLY host delivery-action (memo §0.3 step 4 / rollout
 * step 5b). Drains the `taskflow_web_chat_reply` system row the
 * container reply-gate emits (`db/messages-out.ts` writeMessageOut →
 * `delivery.ts` pollSweep → `handleSystemAction`) and POSTs tf's
 * `/internal/board-chat/agent-reply` — ONE tf txn: INSERT the agent
 * board_chat row (idempotent on `source_outbound_id`) + mark-read the
 * batch's web-origin user rows. Closes the `bd2041b` BLOCKER.
 *
 * Pure relay + fail-closed. The reply-gate (step 5a) supplies
 * `source_outbound_id` (= `{session_id}:{outbound_msg_id}`, globally
 * unique → tf's single-column dedupe), `sender_name` (= ASSISTANT_NAME)
 * and the FULL batch `board_chat_ids` (V1 batch-level mark-read
 * targets). This handler validates them and maps onto tf's
 * source-verified contract; `postTaskflowInternal` applies the
 * 4xx-dead-letter / 5xx-throw classification (the v3 ACK Q3/Q4):
 * a retry-outcome THROWS → `delivery.ts` retries; a 4xx is logged
 * (dead-letter) and we return normally so it is NOT retried.
 *
 * Registration is intentionally deferred to the step-5a commit so the
 * action goes live atomically with the gate that produces this exact
 * payload shape (no registered-but-always-rejecting intermediate).
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { postTaskflowInternal } from './internal-api.js';
import { nonEmptyString } from './util.js';

function positiveIntList(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)) return null;
  return v as number[];
}

export async function handleTaskflowWebChatReply(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const ctx = { sessionId: session.id, boardId: content.board_id };

  const boardId = nonEmptyString(content.board_id);
  if (!boardId) {
    log.error('taskflow_web_chat_reply: missing board_id — not replying', ctx);
    return;
  }
  const text = nonEmptyString(content.text);
  if (!text) {
    log.error('taskflow_web_chat_reply: missing/empty text — not replying', { ...ctx, boardId });
    return;
  }
  const senderName = nonEmptyString(content.sender_name);
  if (!senderName) {
    log.error('taskflow_web_chat_reply: missing sender_name — not replying', { ...ctx, boardId });
    return;
  }
  const sourceOutboundId = nonEmptyString(content.source_outbound_id);
  if (!sourceOutboundId) {
    log.error('taskflow_web_chat_reply: missing source_outbound_id — not replying', {
      ...ctx,
      boardId,
    });
    return;
  }
  const boardChatIds = positiveIntList(content.board_chat_ids);
  if (!boardChatIds) {
    log.error('taskflow_web_chat_reply: empty/invalid board_chat_ids — not replying', {
      ...ctx,
      boardId,
    });
    return;
  }

  const r = await postTaskflowInternal('/internal/board-chat/agent-reply', {
    board_id: boardId,
    text,
    sender_name: senderName,
    source_outbound_id: sourceOutboundId,
    in_reply_to_chat_ids: boardChatIds,
  });
  log.info('taskflow_web_chat_reply: agent-reply', {
    ...ctx,
    boardId,
    sourceOutboundId,
    outcome: r.kind,
    result: r.kind === 'ok' ? r.data : undefined,
  });
}
