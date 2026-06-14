/**
 * RC5-ext shared cold-DM provisioner.
 *
 * Both the OUTBOUND path (`taskflow-notify.ts` — deliver a meeting
 * notification to a never-contacted external) and the INBOUND path (the
 * unrouted-DM resolver — route that external's reply back to a board) need
 * to resolve a never-contacted external's DM to a real `messaging_group`.
 * Sharing one provisioner means one onWhatsApp() round-trip contract and one
 * canonicalization invariant across both directions.
 *
 * The external was invited but never messaged, so a notification arrives as a
 * string-built `${phone}@s.whatsapp.net` JID with NO messaging_group. The
 * host — the only side with a WhatsApp socket — round-trips the phone via
 * `onWhatsApp()` (`lookupPhoneJid`): this BOTH confirms the number is a real
 * WhatsApp account AND returns the server-canonical JID (fixing the BR mobile
 * 9th-digit form a string build can't), then lazily cold-provisions a DM
 * messaging_group so delivery/routing has a real entity and future contact
 * skips the round-trip. Returns null (→ caller fails closed, never delivers to
 * or routes a guess) when the adapter can't look up, the number isn't on
 * WhatsApp, or the lookup throws.
 */
import type { ChannelAdapter } from '../../channels/adapter.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/index.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';

export async function ensureColdDmForExternal(
  adapter: ChannelAdapter,
  dmJid: string,
  ctx: Record<string, unknown>,
): Promise<MessagingGroup | null> {
  if (!adapter.lookupPhoneJid) {
    log.error('cold-dm: adapter has no onWhatsApp lookup — cannot resolve external DM', { ...ctx, jid: dmJid });
    return null;
  }
  const phone = dmJid.replace(/@s\.whatsapp\.net$/, '').replace(/:\d+$/, '');
  let canonical: string | null;
  try {
    canonical = await adapter.lookupPhoneJid(phone);
  } catch (err) {
    log.error('cold-dm: onWhatsApp lookup threw — not resolving', { ...ctx, phone, err: String(err) });
    return null;
  }
  if (!canonical) {
    log.error('cold-dm: number not on WhatsApp — not resolving', { ...ctx, phone });
    return null;
  }
  // Defense-in-depth: keep the "never a non-DM guess" invariant LOCAL, not just
  // a property of the adapter contract — a lookup that ever returned a
  // group/garbage JID must fail closed here, not provision against it.
  if (!canonical.endsWith('@s.whatsapp.net')) {
    log.error('cold-dm: onWhatsApp returned a non-DM JID — not resolving', { ...ctx, phone, canonical });
    return null;
  }
  // Find-or-create the cold-DM messaging_group keyed on the SERVER-canonical
  // JID (the round-trip may have corrected the 9th digit). `strict`
  // unknown-sender policy: cold-DM mgs carry no wirings, so inbound from the
  // external is handled by the unrouted-DM resolver, not generic routing.
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
    // first (UNIQUE). Re-read and use the winner instead of failing the batch.
    const raced = getMessagingGroupByPlatform('whatsapp', canonical);
    if (raced) return raced;
    log.error('cold-dm: cold-DM provisioning failed — not resolving', {
      ...ctx,
      jid: canonical,
      err: String(err),
    });
    return null;
  }
  log.info('cold-dm: cold-provisioned external DM messaging_group', {
    ...ctx,
    messagingGroupId: mg.id,
    jid: canonical,
  });
  return mg;
}
