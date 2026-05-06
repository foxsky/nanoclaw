export function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

export function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Mirrors v1's `z.string()`: returns the value if it is any string
 * (including empty), otherwise null. Pair with the caller's own
 * empty-or-not policy. For trim-and-reject-empty, use `nonEmptyString`.
 */
export function requireString(args: Record<string, unknown>, key: string): string | null {
  return typeof args[key] === 'string' ? (args[key] as string) : null;
}
