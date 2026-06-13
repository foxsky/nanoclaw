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

import type { ChannelAdapter } from '../../channels/adapter.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/index.js';
import { log } from '../../log.js';
import type { MessagingGroup, Session } from '../../types.js';
import { nonEmptyString } from './util.js';

/**
 * RC5-ext delivery: resolve a never-contacted external's DM so a meeting
 * notification can actually reach them. Such a notification arrives as a
 * string-built `${phone}@s.whatsapp.net` JID with NO messaging_group (the
 * external was invited but never messaged, so `direct_chat_jid` was null). The
 * host — the only side with a WhatsApp socket — round-trips the phone via
 * `onWhatsApp()` (`lookupPhoneJid`): this BOTH confirms the number is a real
 * WhatsApp account AND returns the server-canonical JID (fixing the BR mobile
 * 9th-digit form a string build can't), then lazily cold-provisions a DM
 * messaging_group so delivery has a real entity and future notifications skip
 * the round-trip. Returns null (→ caller fails closed, never delivers to a
 * guess) when the adapter can't look up, the number isn't on WhatsApp, or the
 * lookup throws. Inbound routing from this external (so replies reach a board)
 * still needs `resolveExternalDm` wired — a separate unit.
 */
async function ensureColdDmForExternal(
  adapter: ChannelAdapter,
  dmJid: string,
  ctx: Record<string, unknown>,
): Promise<MessagingGroup | null> {
  if (!adapter.lookupPhoneJid) {
    log.error('taskflow notify: adapter has no onWhatsApp lookup — cannot resolve external DM', { ...ctx, jid: dmJid });
    return null;
  }
  const phone = dmJid.replace(/@s\.whatsapp\.net$/, '').replace(/:\d+$/, '');
  let canonical: string | null;
  try {
    canonical = await adapter.lookupPhoneJid(phone);
  } catch (err) {
    log.error('taskflow notify: onWhatsApp lookup threw — not delivering', { ...ctx, phone, err: String(err) });
    return null;
  }
  if (!canonical) {
    log.error('taskflow notify: number not on WhatsApp — not delivering', { ...ctx, phone });
    return null;
  }
  // Defense-in-depth: keep the "never deliver to a non-DM guess" invariant LOCAL,
  // not just a property of the adapter contract — a lookup that ever returned a
  // group/garbage JID must fail closed here, not provision + deliver to it.
  if (!canonical.endsWith('@s.whatsapp.net')) {
    log.error('taskflow notify: onWhatsApp returned a non-DM JID — not delivering', { ...ctx, phone, canonical });
    return null;
  }
  // Find-or-create the cold-DM messaging_group keyed on the SERVER-canonical JID
  // (the round-trip may have corrected the 9th digit). `strict` unknown-sender
  // policy: this only enables OUTBOUND delivery here; inbound from the external
  // stays gated until resolveExternalDm is wired.
  const existing = getMessagingGroupByPlatform('whatsapp', canonical);
  if (existing) return existing;
  const mg: MessagingGroup = {
    id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel_type: 'whatsapp',
    platform_id: canonical,
    name: phone,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  };
  try {
    createMessagingGroup(mg);
  } catch (err) {
    // A concurrent host process inserted the same (channel_type, platform_id)
    // first (UNIQUE). Re-read and use the winner instead of aborting the batch —
    // a thrown insert must not bubble and force a re-run/re-send (fail-soft).
    const raced = getMessagingGroupByPlatform('whatsapp', canonical);
    if (raced) return raced;
    log.error('taskflow notify: cold-DM provisioning failed — not delivering', {
      ...ctx,
      jid: canonical,
      err: String(err),
    });
    return null;
  }
  log.info('taskflow notify: cold-provisioned external DM messaging_group', {
    ...ctx,
    messagingGroupId: mg.id,
    jid: canonical,
  });
  return mg;
}

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
