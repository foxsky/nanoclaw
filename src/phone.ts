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
 * Compose the canonical `<digits>@s.whatsapp.net` JID without round-tripping
 * to the platform. For verified-on-WhatsApp lookups, use the channel
 * adapter's `lookupPhoneJid` (network call).
 */
export function phoneToWhatsAppJid(phone: string): string {
  const digits = normalizePhone(phone) || phone.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}
