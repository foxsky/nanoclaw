/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
let currentInReplyTo: string | null = null;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

/**
 * 0h-v2 web-chat (memo §0.3 step 4). Set by the poll loop (next to
 * `setCurrentInReplyTo`) when the batch contains ≥1
 * `origin:'taskflow_web'` message — V1's batch-level
 * `some(isWebOriginMessage)`. `writeMessageOut` reads it: a
 * `kind:'chat'` row whose routing matches the batch's TRIGGERING
 * routing (the reply to THIS conversation, not an explicit
 * destination / a2a) is rewritten into a `taskflow_web_chat_reply`
 * system row → host writes board_chat, never the WhatsApp adapter.
 * Carries the triggering routing so the writer can do that match.
 */
export interface WebOriginCtx {
  board_id: string;
  board_chat_id: number;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
}

let currentWebOrigin: WebOriginCtx | null = null;

export function setCurrentWebOrigin(ctx: WebOriginCtx | null): void {
  currentWebOrigin = ctx;
}

export function clearCurrentWebOrigin(): void {
  currentWebOrigin = null;
}

export function getCurrentWebOrigin(): WebOriginCtx | null {
  return currentWebOrigin;
}

