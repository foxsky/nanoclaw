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
import { ensureColdDmForExternal } from './cold-dm.js';
import { nonEmptyString } from './util.js';

/**
 * Shared fail-closed deliver primitive: map an engine-resolved WhatsApp
 * JID → `messaging_groups` (central v2.db) → channel adapter and deliver a
 * text. ZERO taskflow.db reads (Codex#3): the caller must already hold a
 * resolved `@g.us`/`@s.whatsapp.net` JID. Returns true on delivery, false
 * on any fail-closed condition (logged here, never a guessed destination).
 * Used by both `taskflow_notify` (comment push) and
 * `taskflow_dispatch_notifications` (engine cross-chat notifications).
 */
export async function deliverTextToWhatsAppJid(
  jid: string,
  text: string,
  ctx: Record<string, unknown>,
): Promise<boolean> {
  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.deliver) {
    log.error('taskflow notify: WhatsApp adapter unavailable — not delivering', { ...ctx, jid });
    return false;
  }

  let mg = getMessagingGroupByPlatform('whatsapp', jid);
  // RC5-ext: a DM to a never-contacted external has no messaging_group. Resolve
  // it (onWhatsApp round-trip + cold-DM provisioning) instead of fail-closing.
  // ONLY for DM JIDs — a missing GROUP (`@g.us`) stays fail-closed (a group can't
  // be onWhatsApp-resolved and must never be guessed).
  if (!mg && jid.endsWith('@s.whatsapp.net')) {
    mg = (await ensureColdDmForExternal(adapter, jid, ctx)) ?? undefined;
  }
  if (!mg) {
    log.error('taskflow notify: no messaging_group for JID — not delivering', { ...ctx, jid });
    return false;
  }
  // Fail-soft, NO retry: a thrown adapter.deliver must not bubble. The host
  // marks the outbound row delivered only after the handler returns, so a
  // throw mid-batch would re-run the whole handler and re-send already-sent
  // events (duplicate notifications). Swallow + log instead.
  try {
    await adapter.deliver(mg.platform_id, null, {
      kind: 'chat',
      content: { type: 'text', text },
    });
    return true;
  } catch (err) {
    log.error('taskflow notify: adapter.deliver threw — dropping (no retry)', { ...ctx, jid, err: String(err) });
    return false;
  }
}

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

  if (await deliverTextToWhatsAppJid(jid, text, ctx)) {
    log.info('taskflow_notify delivered', { ...ctx, jid });
  }
}
