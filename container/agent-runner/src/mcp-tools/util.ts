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

/** Shared response wrapper for handlers that JSON-stringify a payload
 *  (TaskFlow mutate tools). Distinct from `ok`/`err` which wrap plain
 *  text strings. */
export function jsonResponse(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/** Parses the 4 args common to all task-mutation MCP tools (delete,
 *  update, add/edit/remove note). Returns a discriminated union so the
 *  handler can early-return on validation failure with TS narrowing. */
export type TaskActorArgs = {
  ok: true;
  boardId: string;
  taskId: string;
  senderName: string;
  senderIsService: boolean | undefined;
};
export type TaskActorParseResult =
  | TaskActorArgs
  | { ok: false; error: ReturnType<typeof err> };

export function parseTaskActorArgs(args: Record<string, unknown>): TaskActorParseResult {
  const boardId = requireString(args, 'board_id');
  if (boardId === null) return { ok: false, error: err('board_id: required string') };
  const taskId = requireString(args, 'task_id');
  if (taskId === null) return { ok: false, error: err('task_id: required string') };
  const senderName = requireString(args, 'sender_name');
  if (senderName === null) return { ok: false, error: err('sender_name: required string') };
  let senderIsService: boolean | undefined;
  if (args.sender_is_service !== undefined) {
    if (typeof args.sender_is_service !== 'boolean') {
      return { ok: false, error: err('sender_is_service: expected boolean') };
    }
    senderIsService = args.sender_is_service;
  }
  return { ok: true, boardId, taskId, senderName, senderIsService };
}
