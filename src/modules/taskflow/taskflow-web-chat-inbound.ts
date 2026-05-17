/**
 * 0h-v2 web-chat INGRESS host delivery-action (memo §0.3 step 2).
 *
 * `delivery.ts` pollSweep drains the `taskflow_web_chat_inbound` system
 * row the engine enqueued (api_send_chat → enqueueWebChatInbound) into
 * the TaskFlow service session's outbound.db; `handleSystemAction`
 * dispatches here.
 *
 * NOT a `taskflow_notify` clone — the opposite operation.
 * `taskflow_notify`: resolve group_jid → **deliver to the WhatsApp
 * adapter** (egress). This: resolve the SAME shared primitive
 * (`getMessagingGroupByPlatform` — already shared, no extraction) →
 * **inject a trigger-bypassed `messages_in` row into the board's
 * session** (ingress, never the adapter). Zero duplicated business
 * logic; `taskflow_notify` untouched.
 *
 * Codex#3-safe: the payload carries the engine-resolved `group_jid`
 * (engine is in-subprocess with the correct `--db`), so the host does
 * ZERO taskflow.db reads — only `group_jid → messaging_group (central
 * v2.db) → session`. FAIL-CLOSED (Codex#2): any unresolvable hop logs
 * an error and writes nothing — never a guessed destination, never a
 * silent success. The injected row is `trigger=1` so the agent
 * processes it with NO `@mention` (V1 `!hasWebOrigin` parity) and
 * carries `origin:'taskflow_web'` — the marker the in-container
 * poll-loop reply-router keys on (next unit). Idempotent on
 * `taskflow-web:${board_chat_id}` (insertMessage is NOT id-idempotent;
 * a crash-then-redrain would otherwise throw UNIQUE).
 */
import type Database from 'better-sqlite3';

import { findSession, getMessagingGroupByPlatform } from '../../db/index.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { nonEmptyString } from './util.js';

export async function handleTaskflowWebChatInbound(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const ctx = { sessionId: session.id, boardId: content.board_id };

  const groupJid = nonEmptyString(content.group_jid);
  if (!groupJid) {
    log.error('taskflow_web_chat_inbound: missing engine-resolved group_jid — not ingesting', ctx);
    return;
  }
  const text = nonEmptyString(content.content);
  if (!text) {
    log.error('taskflow_web_chat_inbound: missing/empty content — not ingesting', { ...ctx, groupJid });
    return;
  }
  const boardChatId = content.board_chat_id;
  if (typeof boardChatId !== 'number') {
    log.error('taskflow_web_chat_inbound: missing board_chat_id — not ingesting', { ...ctx, groupJid });
    return;
  }

  const mg = getMessagingGroupByPlatform('whatsapp', groupJid);
  if (!mg) {
    log.error('taskflow_web_chat_inbound: no messaging_group for group_jid — not ingesting', {
      ...ctx,
      groupJid,
    });
    return;
  }

  const target = findSession(mg.id, null);
  if (!target) {
    log.error('taskflow_web_chat_inbound: no active session for messaging_group — not ingesting', {
      ...ctx,
      groupJid,
      messagingGroupId: mg.id,
    });
    return;
  }

  const senderName = nonEmptyString(content.sender_name) ?? 'web';
  const messageContent = JSON.stringify({
    text,
    sender: senderName,
    // Load-bearing: the in-container poll-loop keys the web-origin
    // reply-router on `origin === 'taskflow_web'` (memo §0.3 step 4).
    origin: 'taskflow_web',
    board_id: content.board_id,
    board_chat_id: boardChatId,
  });

  try {
    writeSessionMessage(target.agent_group_id, target.id, {
      id: `taskflow-web:${boardChatId}`,
      kind: 'chat',
      timestamp: nonEmptyString(content.created_at) ?? new Date().toISOString(),
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: null,
      content: messageContent,
      // V1 `!hasWebOrigin` trigger-bypass: web chat ALWAYS wakes the
      // agent, no `@mention`/trigger pattern required.
      trigger: 1,
    });
    log.info('taskflow_web_chat_inbound ingested', {
      ...ctx,
      sessionId: target.id,
      boardChatId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE constraint')) {
      // Crash-then-redrain: this board_chat row was already ingested.
      // Idempotent no-op, not a failure.
      log.info('taskflow_web_chat_inbound: already ingested (idempotent skip)', {
        ...ctx,
        boardChatId,
      });
      return;
    }
    log.error('taskflow_web_chat_inbound: write failed — not ingested', { ...ctx, boardChatId, err: msg });
  }
}
