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
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';

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

/**
 * 0h-v2 web-chat batch detection (memo §0.3 step 4). V1 batch-level
 * `missedMessages.some(isWebOriginMessage)`: a batch is web-origin iff
 * ANY message is a host-injected web-chat row. DUAL anti-spoof check
 * (Codex#4 + Codex P3a): BOTH the `origin:'taskflow_web'` content
 * marker AND an EXACT id match to the host's deterministic
 * `taskflow-web:${board_chat_id}` are required. A normal inbound
 * message can carry arbitrary JSON in its body but cannot make its
 * router-assigned id exactly equal `taskflow-web:${its own claimed
 * board_chat_id}`; requiring exact equality (not just the prefix)
 * also rejects a row whose id/board_chat_id disagree. The ctx carries
 * the first web row's board ids plus
 * the batch's triggering routing (the gate in `messages-out.ts` matches
 * an outbound row's routing against this to find the reply to THIS
 * conversation, not a cross-destination send). Returns null on
 * malformed/partial rows — never a partial ctx.
 */
export function detectWebOrigin(
  messages: MessageInRow[],
  routing: RoutingContext,
): WebOriginCtx | null {
  for (const m of messages) {
    if (!m.id.startsWith('taskflow-web:')) continue;
    let parsed: { origin?: unknown; board_id?: unknown; board_chat_id?: unknown };
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (
      parsed.origin !== 'taskflow_web' ||
      typeof parsed.board_id !== 'string' ||
      typeof parsed.board_chat_id !== 'number' ||
      m.id !== `taskflow-web:${parsed.board_chat_id}`
    ) {
      continue;
    }
    return {
      board_id: parsed.board_id,
      board_chat_id: parsed.board_chat_id,
      platformId: routing.platformId,
      channelType: routing.channelType,
      threadId: routing.threadId,
    };
  }
  return null;
}

/**
 * 0h-v2 (Codex P1 + resume BLOCKER). The `processQuery` follow-up
 * poller must NOT merge a follow-up across the web-chat boundary in
 * EITHER direction:
 *  (A) a web row arriving during a NON-web turn (`currentWebOrigin`
 *      still null) would have its reply emitted with no ctx → wrongly
 *      delivered to the channel adapter instead of board_chat;
 *  (B) ANY follow-up arriving during an ACTIVE web turn
 *      (`currentWebOrigin` set by the outer loop) would have its reply
 *      rewritten into board_chat by the still-set ctx — routing-match
 *      cannot save a same-session WhatsApp follow-up (TaskFlow boards
 *      ARE WhatsApp groups; identical platform/channel/thread).
 * Either way the stream must end and the rows stay pending for the
 * outer loop's per-batch `setCurrentWebOrigin(detectWebOrigin(...))`.
 */
export function crossesWebChatBoundary(
  pending: MessageInRow[],
  routing: RoutingContext,
): boolean {
  // The ctx clause (B) MUST be gated on a WAKE-ELIGIBLE non-system
  // follow-up (`trigger === 1`, mirroring the poller's own downstream
  // `!hasWakeTrigger` push gate). Two reasons: (1) the poller's
  // interval fires every tick DURING the active web turn itself (its
  // triggering row is already markProcessing'd, so pending=[]) — an
  // ungated ctx clause would `query.end()` the turn before it replies
  // (Codex resume#2); (2) a trigger=0 accumulate-only row is never
  // pushed/answered, so it can't misroute — ending the stream for it
  // would truncate the in-flight web reply on background chatter
  // (Codex resume#3). The detectWebOrigin clause (A) already implies a
  // non-system row, and a web row is always trigger=1 by ingress.
  const hasWakeFollowUp = pending.some((m) => m.kind !== 'system' && m.trigger === 1);
  return (
    detectWebOrigin(pending, routing) !== null || (hasWakeFollowUp && getCurrentWebOrigin() !== null)
  );
}

