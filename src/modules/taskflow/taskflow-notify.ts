/**
 * 0h-v2 Option A — Unit 3: `taskflow_notify` host delivery-action.
 *
 * Drains FastAPI-originated outbound rows the engine enqueued via
 * `enqueueOutboundMessage` into the TaskFlow service session's
 * outbound.db. `src/delivery.ts`'s pollSweep → handleSystemAction
 * dispatches here.
 *
 * Codex#3 binding correction (memo §0.1): the host and the FastAPI MCP
 * subprocess may read DIFFERENT taskflow.db files, so this handler does
 * **ZERO taskflow.db reads**. The engine resolves all TaskFlow-side
 * routing (person→notification_group_jid, board→group_jid) in-subprocess
 * at enqueue time and puts the resolved chat JID in the payload. Here we
 * only map resolved-JID → `messaging_groups` (central v2.db) → channel
 * adapter.
 *
 * FAIL-CLOSED (Codex#2 / tf fail-mode (b)): any unresolvable routing
 * logs an error and does NOT deliver — never to a guessed destination,
 * never a silent success. TaskFlow notification targets are WhatsApp
 * groups (`@g.us`), mirroring the send-otp precedent. A `{kind:'person'}`
 * target reaching the host means the caller failed to resolve it; the
 * host cannot (no trustworthy taskflow.db), so that is a fail-closed
 * contract violation, not a lookup to attempt.
 */
import type Database from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroupByPlatform } from '../../db/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { nonEmptyString } from './util.js';

export async function handleTaskflowNotify(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const ctx = { sessionId: session.id, boardId: content.board_id };

  const text = nonEmptyString(content.text);
  if (!text) {
    log.error('taskflow_notify: missing/empty text — not delivering', ctx);
    return;
  }

  const target = content.target as { kind?: unknown; group_jid?: unknown } | null | undefined;
  if (!target || typeof target !== 'object') {
    log.error('taskflow_notify: missing target — not delivering', ctx);
    return;
  }
  if (target.kind !== 'group') {
    // Codex#3: an unresolved {kind:'person'} (or unknown kind) reaching
    // the host is a contract violation — the engine must resolve
    // person→jid in-subprocess. The host will NOT touch taskflow.db.
    log.error('taskflow_notify: target not engine-resolved to a group JID — not delivering', {
      ...ctx,
      targetKind: target.kind,
    });
    return;
  }

  const jid = nonEmptyString(target.group_jid);
  if (!jid) {
    log.error('taskflow_notify: group target missing group_jid — not delivering', ctx);
    return;
  }

  const mg = getMessagingGroupByPlatform('whatsapp', jid);
  if (!mg) {
    log.error('taskflow_notify: no messaging_group for JID — not delivering', { ...ctx, jid });
    return;
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.deliver) {
    log.error('taskflow_notify: WhatsApp adapter unavailable — not delivering', { ...ctx, jid });
    return;
  }

  await adapter.deliver(mg.platform_id, null, {
    kind: 'chat',
    content: { type: 'text', text },
  });
  log.info('taskflow_notify delivered', { ...ctx, jid });
}
