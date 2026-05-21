/**
 * Parse ISO YYYY-MM-DD and reject impossible calendar dates (e.g. 2026-02-30,
 * 2026-13-32). Shape regex alone isn't enough: `new Date('2026-02-30')` yields
 * NaN, which silently passes weekday/holiday checks downstream and would
 * surface in user-facing cards as nonsense like "32/13/2026". Round-trip
 * through Date.UTC ensures the components agree.
 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoCalendarDate(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = ISO_DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return s;
}
