/**
 * Phase-3 unit-2-core / Codex gate P4 — cross-process dedup primitive.
 *
 * The agent-runner runs MCP tools as a SEPARATE `bun` subprocess
 * (src/index.ts wires `command:'bun', args:['run',mcp-tools/index.ts]`
 * + StdioServerTransport). emitMutationConfirmation marks from the MCP
 * subprocess; dispatchResultText consumes from the poll-loop main
 * process. A module-level boolean would NOT propagate across processes
 * (Codex gate finding 2026-05-19: prior in-memory impl was a prod no-op).
 *
 * State is held in the outbound DB's `session_state` table — both
 * processes open the same `/workspace/outbound.db` via `getOutboundDb`,
 * so a committed INSERT in the MCP child is visible to a SELECT in the
 * main process. Read-and-clear semantics so each turn's single
 * `dispatchResultText` consumes the flag (no explicit per-turn reset
 * needed at the call sites). Best-effort try/catch matches the
 * surrounding emit-path philosophy — a dedup-storage failure must
 * NEVER fail the mutation that already succeeded.
 *
 * SCOPE — which emission paths the flag suppresses (Codex P-Audit-2 closure):
 *   - SUPPRESSED: poll-loop `dispatchResultText` bare-text fallback at
 *     `poll-loop.ts:3990-4000` — the auto-route of unwrapped final text
 *     to a sole destination (redundant model narrative after the
 *     deterministic v1 card).
 *   - BYPASS (intentional): cross-conversation explicit emission paths —
 *     `send_message`/`send_file` to a DIFFERENT chat than the inbound's
 *     session_routing, and `<message to=…>` blocks targeting a different
 *     conversation (legitimate cross-board relay). Bare-text in the
 *     source conv is then a separate legitimate reply.
 *   - SUPPRESSED (refined #7 follow-up): a `<message to="<same-conv>">`
 *     block right after a deterministic mutation card is the same
 *     redundant model narration the bare-text fallback already kills —
 *     `<message>`-wrapped. Gated by `shouldSuppressSameConvMessage`
 *     (mcp-tools/message-block-dedup.ts) and locked by its tests.
 *   - PRODUCERS of the flag: `emitMutationConfirmation` (TaskFlow
 *     mutation cards) AND — as of `7914f979` Codex Turn-25 follow-up —
 *     `send_message`/`send_file` when their target matches the inbound's
 *     `session_routing` (same-conv). The Turn-25 finding: model called
 *     send_message + emitted same text as bare-text-final, both went
 *     through. The cross-conv bypass is preserved (cross-board relay
 *     still works). KNOWN LIMITATIONS (Codex 2026-05-23):
 *     (a) A2A under-match — `markIfSameConv` checks session_routing
 *     which is null for agent-shared sessions; an A2A reply that should
 *     be "same-conv" (channel='agent', dest=source-agent-group) won't
 *     mark. `shouldSuppressSameConvMessage` handles this case via the
 *     per-turn routing param; markIfSameConv doesn't have that param.
 *     Acceptable: A2A send_message+bare-text duplication is not observed
 *     in any current corpus; revisit when an A2A regression surfaces.
 *     (b) Content-blind — any same-conv send_message suppresses ANY
 *     later bare-text, not just duplicates. A legitimate "ack via tool,
 *     then bare follow-up question" would lose the follow-up. Trade-off
 *     accepted: the model rarely does ack+followup; if a regression
 *     surfaces, the fix is content-equality (store send_message text,
 *     compare to bare-text before suppressing).
 *   - Other internal `writeMessageOut` callers (sendToDestination for
 *     both the bare-text branch and the `<message>`-block branch share
 *     that primitive) inherit the suppression behavior of their dispatch
 *     site, not the writer.
 */
import { getOutboundDb } from '../db/connection.js';
import { isTaskflowSubprocess } from './taskflow-helpers.js';

const KEY = 'mutation_dedup_flag';

export function markDeterministicMutationEmitted(): void {
  // Write-side is in-session ONLY: the tf-mcontrol FastAPI subprocess (verbatim ids)
  // must not write session_state to /workspace/outbound.db (it would clobber the
  // service session's outbound state). The in-session agent's MCP child never sets
  // verbatim, so the cross-process dedup it relies on is unaffected. Read-side
  // (consume/take/drain) stays unguarded — those run only in the poll-loop/session.
  if (isTaskflowSubprocess()) return;
  try {
    const db = getOutboundDb();
    db.prepare(
      `INSERT INTO session_state (key, value, updated_at)
       VALUES (?, '1', ?)
       ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
    ).run(KEY, new Date().toISOString());
  } catch {
    // Best-effort: the mutation already succeeded; a flag write
    // failure must not fail it. dispatchResultText falls back to
    // emitting the model's bare-text reply (no suppression).
  }
}

export function consumeDeterministicMutationFlag(): boolean {
  try {
    const db = getOutboundDb();
    const row = db
      .prepare(`SELECT value FROM session_state WHERE key = ?`)
      .get(KEY) as { value: string } | undefined;
    if (row) {
      db.prepare(`DELETE FROM session_state WHERE key = ?`).run(KEY);
      return true;
    }
  } catch {
    // see markDeterministicMutationEmitted — best-effort.
  }
  return false;
}

/**
 * Turn-boundary drain. Codex P-Audit-3 (2026-05-21): a mutation may mark
 * the flag and the provider stream may then error / close without emitting
 * the `result` event, so `dispatchResultText`'s consume never runs and
 * the flag leaks into the next turn (silently suppressing that turn's
 * bare-text fallback). Call from the unconditional turn-end path in
 * poll-loop to clear any stale mark. Separate name from consume to make
 * the intent at the call site explicit: "drain, don't care about state".
 */
export function drainDeterministicMutationFlag(): void {
  consumeDeterministicMutationFlag();
}

/**
 * Pending-create-card slot (Phase-3 #7 emit-deferral). A no-reparent
 * create cannot emit its "Tarefa criada"/"Projeto criado" card eagerly:
 * `api_create_task` has no parent param, so "add task to project" is
 * always create THEN `api_admin(reparent_task)`, and an eager emit would
 * double-emit (create card + the reparent's "adicionada" card). Instead
 * the create STORES its card here; a following reparent CLEARS it (the
 * reparent emits the superseding card); the poll-loop turn-end FLUSHES
 * whatever remains. Same cross-process `session_state` mechanism as the
 * dedup flag — MCP subprocess stores/clears, poll-loop main flushes.
 */
const PENDING_CREATE_CARD_KEY = 'pending_create_card';

/** Store a no-reparent create card for end-of-turn flush, keyed by the
 *  created task id. Also marks the dedup flag so the model's redundant
 *  bare-text reply is suppressed. A second call overwrites (last create
 *  this turn wins; v1's combined "N tarefas criadas" multi-create card
 *  is a separate builder, out of scope). */
export function setPendingCreateCard(taskId: string, card: string): void {
  if (isTaskflowSubprocess()) return; // in-session only — see markDeterministicMutationEmitted
  try {
    getOutboundDb()
      .prepare(
        `INSERT INTO session_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(PENDING_CREATE_CARD_KEY, JSON.stringify({ taskId, card }), new Date().toISOString());
  } catch {
    // Best-effort — see markDeterministicMutationEmitted.
  }
  markDeterministicMutationEmitted();
}

/** Drop the pending create card ONLY when it belongs to `taskId` — called
 *  by a reparent, which emits the superseding "adicionada" card itself.
 *  Task-id-matched so a same-turn reparent of an UNRELATED task does not
 *  silently drop a sibling standalone create's confirmation. */
export function clearPendingCreateCard(taskId: string): void {
  if (isTaskflowSubprocess()) return; // in-session only — see markDeterministicMutationEmitted
  try {
    const db = getOutboundDb();
    const row = db
      .prepare(`SELECT value FROM session_state WHERE key = ?`)
      .get(PENDING_CREATE_CARD_KEY) as { value: string } | undefined;
    if (!row) return;
    const parsed = JSON.parse(row.value) as { taskId?: string };
    if (parsed.taskId === taskId) {
      db.prepare(`DELETE FROM session_state WHERE key = ?`).run(PENDING_CREATE_CARD_KEY);
    }
  } catch {
    // Best-effort — see markDeterministicMutationEmitted.
  }
}

/** Read-and-clear the pending create card. Called once per turn from
 *  `dispatchResultText`; returns the card text, or null when no
 *  no-reparent create occurred. */
export function takePendingCreateCard(): string | null {
  try {
    const db = getOutboundDb();
    const row = db
      .prepare(`SELECT value FROM session_state WHERE key = ?`)
      .get(PENDING_CREATE_CARD_KEY) as { value: string } | undefined;
    if (row) {
      db.prepare(`DELETE FROM session_state WHERE key = ?`).run(PENDING_CREATE_CARD_KEY);
      const parsed = JSON.parse(row.value) as { card?: string };
      return typeof parsed.card === 'string' ? parsed.card : null;
    }
  } catch {
    // Best-effort — see markDeterministicMutationEmitted.
  }
  return null;
}

export function __resetDedupForTesting(): void {
  try {
    const db = getOutboundDb();
    db.prepare(`DELETE FROM session_state WHERE key = ?`).run(KEY);
    db.prepare(`DELETE FROM session_state WHERE key = ?`).run(PENDING_CREATE_CARD_KEY);
  } catch {
    // Outbound DB may not be initialized in some unit tests; ignore.
  }
}
