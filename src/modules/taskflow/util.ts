export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function newTaskId(prefix = 'task'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** True iff every named field in `content` is a non-empty trimmed string. */
export function requireFields(content: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((f) => nonEmptyString(content[f]) !== null);
}
