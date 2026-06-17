/**
 * 0h-v2 web-chat REPLY gate (TaskFlow overlay — ADR 0006 contract 7).
 *
 * Extracted verbatim from the fork's inline `writeMessageOut` gate.
 * Registers an outbound transform: when the current batch is web-origin
 * (set in `current-batch` by the poll loop, like `inReplyTo`), the
 * agent's reply to the TRIGGERING conversation becomes a
 * `taskflow_web_chat_reply` system row (→ host writes board_chat),
 * NOT a channel message. The discriminator is routing-match against the
 * batch's triggering routing (V1 `appendAgentOutputToBoardChat`
 * replaced exactly `enqueueAgentOutput(chatJid,…)`). System / a2a /
 * other-destination / operation / file rows pass through untouched.
 */
import { randomUUID } from 'node:crypto';

import { getCurrentWebOrigin } from '../../current-batch.js';
import type { WriteMessageOut } from '../../db/messages-out.js';
import { registerOutboundTransform } from '../../db/outbound-transform.js';

/**
 * True only for a plain agent text reply: JSON content with a string
 * `text`, NO `operation` (edit_message/add_reaction — core.ts:208/249)
 * and NO `files` (send_file — core.ts:166). The web-chat gate transforms
 * ONLY these; operation/file rows pass through untouched (Codex review —
 * they must not be corrupted into board_chat text).
 */
function isPlainTextReply(content: string): boolean {
  try {
    const c = JSON.parse(content) as {
      text?: unknown;
      operation?: unknown;
      files?: unknown;
    };
    return (
      typeof c.text === 'string' && c.operation === undefined && c.files === undefined
    );
  } catch {
    return false;
  }
}

/**
 * The web-chat reply gate. If the batch is web-origin and this is the
 * reply to the TRIGGERING conversation (kind:'chat' + routing == the
 * batch's triggering routing — NOT an explicit `send_message(to:…)`/a2a,
 * which carry different routing), rewrite it into a
 * `taskflow_web_chat_reply` system row so the host writes board_chat
 * instead of delivering to the WhatsApp adapter. System/a2a/other-
 * destination rows pass through untouched.
 */
function webChatReplyTransform(msg: WriteMessageOut): WriteMessageOut {
  const web = getCurrentWebOrigin();
  if (
    web &&
    msg.kind === 'chat' &&
    (msg.platform_id ?? null) === web.platformId &&
    (msg.channel_type ?? null) === web.channelType &&
    (msg.thread_id ?? null) === web.threadId &&
    isPlainTextReply(msg.content)
  ) {
    // isPlainTextReply guaranteed a string `.text` with no
    // `operation` (edit/reaction — core.ts:208/249) and no `files`
    // (send_file — core.ts:166): those pass through UNCHANGED. V1's
    // `appendAgentOutputToBoardChat` only ever routed the agent's
    // text; edits/reactions/files are out of web-chat scope.
    const text = (JSON.parse(msg.content) as { text: string }).text;
    return {
      ...msg,
      kind: 'system',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: JSON.stringify({
        action: 'taskflow_web_chat_reply',
        board_id: web.board_id,
        // FULL batch list of web-origin user rows (V1 batch-level
        // mark-read targets) → tf agent-reply.in_reply_to_chat_ids.
        board_chat_ids: web.board_chat_ids,
        text,
        // G2: never emit an empty sender_name (RunnerConfig.assistantName
        // defaults to '' and the host CLI accepts blank) — tf would 400
        // missing_sender_name and 5b would fail-closed → reply silently
        // lost. Matches the codebase fallback (providers/claude.ts).
        sender_name: web.sender_name.trim() || 'Assistant',
        // G1: globally-unique, collision-proof, stable idempotency key.
        // randomUUID() (not generateId()'s timestamp+rand6, which can
        // collide same-ms same-group); written ONCE into this row so
        // delivery.ts retries re-POST the same key → tf dedupes. The
        // agent-group prefix is for traceability only ('ag' if blank).
        source_outbound_id: `${web.source_id_prefix || 'ag'}:${randomUUID()}`,
      }),
    };
  }
  return msg;
}

registerOutboundTransform(webChatReplyTransform);
