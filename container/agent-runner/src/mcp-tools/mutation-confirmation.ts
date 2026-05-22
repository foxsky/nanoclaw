/**
 * Deterministic post-mutation confirmation emission for the v2 MCP
 * TaskFlow path.
 *
 * v1's poll-loop action handlers performed the mutation AND emitted a
 * formatted "✅ … ━━━" card to the user via `writeReply`. The v1→v2
 * MCP-tool port returns the engine's `formatted` summary only as JSON to
 * the LLM and never delivers it, so on mutation turns the user gets no
 * confirmation (Phase-3 root cause, 2026-05-18). This restores the v1
 * feature deterministically — not via an agent prompt (the card is a
 * deterministic TaskFlow feature, not a model judgement).
 *
 * Guard: emit only when session routing is present. The agent-runner
 * gets it from the host on every container wake; tf-mcontrol's standalone
 * FastAPI MCP entrypoint has no session DB → all-null routing → no emit,
 * so shared mutation tools never turn that entrypoint into a WhatsApp
 * reply emitter. Emission goes through `writeMessageOut`, so it composes
 * with the existing 0h-v2 web-origin gate automatically (web → board_chat,
 * WhatsApp → adapter).
 */
import { randomUUID } from 'node:crypto';

import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, type SessionRouting } from '../db/session-routing.js';
import { markDeterministicMutationEmitted, takePendingCreateCard } from './mutation-dedup.js';
import { log } from './util.js';

interface MutationResultShape {
  success?: boolean;
  formatted?: unknown;
}

interface EmitDeps {
  getRouting?: () => SessionRouting;
  emit?: (msg: {
    kind: string;
    platform_id: string;
    channel_type: string;
    thread_id: string | null;
    content: string;
  }) => void;
  onError?: (msg: string) => void;
}

export function emitMutationConfirmation(
  result: MutationResultShape,
  deps: EmitDeps = {},
): void {
  if (result.success !== true) return;
  const text = typeof result.formatted === 'string' ? result.formatted.trim() : '';
  if (!text) return;

  // Best-effort: the mutation already succeeded. Reading session routing
  // throws when there is no inbound session DB (tf-mcontrol's standalone
  // FastAPI MCP entrypoint, or an engine-only test context), and the
  // outbound write can fail too. Neither may ever fail the mutation —
  // a missing confirmation is a UX degradation, not a mutation failure.
  try {
    const routing = (deps.getRouting ?? getSessionRouting)();
    if (!routing.channel_type || !routing.platform_id) return;

    (deps.emit ?? writeMessageOut)({
      id: randomUUID(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });
    // Mark only after a successful emit (no throw above). Drives
    // dispatchResultText's bare-text fallback suppression so the model's
    // same-turn redundant reply doesn't double-message the user (v1
    // sent only the deterministic card). Codex hot-path gate P4.
    markDeterministicMutationEmitted();
  } catch (err) {
    // Swallowed by design (see above) — but NOT silently: a silent
    // swallow previously hid an emission failure and blocked diagnosing
    // why a reassign turn produced no confirmation. Fail loud here while
    // still never failing the mutation.
    (deps.onError ?? log)(`mutation confirmation emission failed: ${String(err)}`);
  }
}

/**
 * Flush the deferred no-reparent create card (Phase-3 #7) through the
 * shared emit path. Called from poll-loop: once per turn in
 * `dispatchResultText`, plus at the unconditional turn boundary as a
 * safety net for a stream-error / no-result turn (symmetric with
 * `drainDeterministicMutationFlag`). `takePendingCreateCard` is
 * read-and-clear, so across the two call sites it emits at most once.
 */
export function flushPendingCreateCard(): void {
  const card = takePendingCreateCard();
  if (card) emitMutationConfirmation({ success: true, formatted: card });
}
