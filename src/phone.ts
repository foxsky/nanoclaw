/**
 * Canonicalize a phone number to Brazilian E164 digits (no '+', no separators).
 *
 * Storage form is the digits-only string used as:
 *   - board_people.phone / board_admins.phone / external_contacts.phone
 *   - the local-part of WhatsApp JIDs: `${normalizePhone(p)}@s.whatsapp.net`
 *
 * Rules:
 *   1. Strip all non-digit characters.
 *   2. If the result is 12–13 digits and starts with '55', treat it as
 *      already-canonical Brazilian E164 (landline/pre-2012 or post-2012 mobile).
 *   3. If the result is 10–11 digits and the first digit is not 0, treat it
 *      as a Brazilian number missing its country code and prepend '55'.
 *   4. Otherwise return the digits unchanged — international number, a trunk-
 *      prefixed call (leading 0), too short, or already too long.
 *
 * Rule (3) has a documented false-positive: a 10-digit US/Canada NANP number
 * whose area code is 11-99 will get '55' prepended. This is accepted — the
 * user base is Brazilian government workers, no non-Brazilian phones have
 * been observed in 3+ years of production data.
 *
 * Fixed-point: canonicalizing an already-canonical string returns it unchanged,
 * so this is safe to call repeatedly and on migration data.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return '';

  // Already canonical: 55 + 2-digit DDD + 8 or 9 digit subscriber.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    return digits;
  }

  // Brazilian number missing country code. Reject leading-0 (trunk prefix).
  if ((digits.length === 10 || digits.length === 11) && digits[0] !== '0') {
    return '55' + digits;
  }

  // International, trunk-prefixed, too short, or too long — leave alone.
  return digits;
}

/**
 * RC5 — Brazilian mobile 9th-digit equivalence. Mirrors the container copy in
 * `container/agent-runner/src/taskflow-engine.ts` (both must stay in sync). A BR
 * mobile is the same human whether stored with the mandatory leading '9' on the
 * subscriber (13-digit) or without it (12-digit). Returns the set of canonical
 * forms equivalent to `phone` so the two forms match. Only MOBILE subscribers
 * carry the 9th digit — a landline (subscriber starting 2–5) yields only its own
 * form, so a 9-inserted variant can never collide with a real mobile.
 */
// Conservative-by-design: reconcile ONLY post-2012-migration numbers (old
// 8-digit mobiles started 6–9 → migrated 13-digit is 9 + [6-9] + 7 digits, with
// a 9-less 12-digit twin). Natively-9-digit mobiles (9[1-5]…) never had an
// 8-digit form, so they need no reconciliation; widening to them would let a
// 9-inserted variant collide with a landline (landlines start 2–5).
const BR_MOBILE_13 = /^9[6-9]\d{7}$/;
const BR_MOBILE_12 = /^[6-9]\d{7}$/;

export function brPhoneMatchVariants(phone: string): string[] {
  const c = normalizePhone(phone);
  if (!c.startsWith('55')) return c ? [c] : [];
  const ddd = c.slice(2, 4);
  const sub = c.slice(4);
  const variants = new Set<string>([c]);
  if (BR_MOBILE_13.test(sub)) {
    variants.add('55' + ddd + sub.slice(1));
  } else if (BR_MOBILE_12.test(sub)) {
    variants.add('55' + ddd + '9' + sub);
  }
  return [...variants];
}

/**
 * Compose the canonical `<digits>@s.whatsapp.net` JID without round-tripping
 * to the platform. For verified-on-WhatsApp lookups, use the channel
 * adapter's `lookupPhoneJid` (network call).
 */
export function phoneToWhatsAppJid(phone: string): string {
  const digits = normalizePhone(phone) || phone.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

/**
 * Returns true when `value` looks like a WhatsApp JID — a group (`@g.us`),
 * a personal handle (`@s.whatsapp.net`), or a broadcast (`@broadcast`).
 * Recognizer only; does NOT validate the local-part. Use this when you need
 * to distinguish a raw JID from a destination_name in routing/decision code.
 */
export function isWhatsAppJid(value: string | null | undefined): boolean {
  if (!value) return false;
  return /@(g\.us|s\.whatsapp\.net|broadcast)$/i.test(value);
}
