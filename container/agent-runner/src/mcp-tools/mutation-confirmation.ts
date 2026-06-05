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
import { isTaskflowSubprocess } from './taskflow-helpers.js';
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

/**
 * Emit a deterministic same-conversation TaskFlow message and mark the
 * turn-level suppression flag. Mutation confirmations are the primary
 * producer, but a few v1 read-side TaskFlow wrappers also had a
 * user-visible formatted result. Reusing the same primitive keeps
 * same-conversation dedup semantics identical.
 */
export function emitDeterministicToolMessage(text: string, deps: EmitDeps = {}): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  // The routing-absent gate below relies on the FastAPI subprocess having NO
  // session DB — a deployment assumption that fails open if it can see a
  // /workspace session_routing row (→ emits a user-visible chat row). getVerbatimIds()
  // is the reliable subprocess signal (set unconditionally only in the subprocess
  // entry), so gate on it too. Mirrors dispatchNotificationEvents / the #396 gates.
  if (isTaskflowSubprocess()) return;

  // Best-effort: the tool already succeeded. Reading session routing
  // throws when there is no inbound session DB (tf-mcontrol's standalone
  // FastAPI MCP entrypoint, or an engine-only test context), and the
  // outbound write can fail too. Neither may ever fail the tool result.
  try {
    const routing = (deps.getRouting ?? getSessionRouting)();
    if (!routing.channel_type || !routing.platform_id) return;

    (deps.emit ?? writeMessageOut)({
      id: randomUUID(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: trimmed }),
    });
    markDeterministicMutationEmitted();
  } catch (err) {
    (deps.onError ?? log)(`deterministic tool message emission failed: ${String(err)}`);
  }
}

export function emitMutationConfirmation(
  result: MutationResultShape,
  deps: EmitDeps = {},
): void {
  if (result.success !== true) return;
  const text = typeof result.formatted === 'string' ? result.formatted.trim() : '';
  if (!text) return;
  emitDeterministicToolMessage(text, deps);
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
