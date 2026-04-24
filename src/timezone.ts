/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Short pt-BR "DD/MM, HH:MM" form for conversational acks.
 * Returns empty string if the ISO is unparseable so callers can fall back.
 */
export function formatPtBrShort(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString('pt-BR', {
    timeZone: resolveTimezone(timezone),
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
