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
 *   - SUPPRESSED: poll-loop `dispatchResultText` bare-text fallback (the
 *     auto-route of unwrapped final text to a sole destination — redundant
 *     model narrative after the deterministic v1 card).
 *   - BYPASS (intentional): `<message to="…">` blocks in the model's final
 *     text, `send_message` / `send_file` MCP tools, and any other direct
 *     `writeMessageOut` caller. These represent the agent's STATED intent
 *     and never consult the flag. Codex P-Audit-2: extending suppression
 *     to these paths would silently swallow explicit agent messages —
 *     out of scope, and locked down by mutation-dedup.test.ts.
 */
import { getOutboundDb } from '../db/connection.js';

const KEY = 'mutation_dedup_flag';

export function markDeterministicMutationEmitted(): void {
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

export function __resetDedupForTesting(): void {
  try {
    getOutboundDb().prepare(`DELETE FROM session_state WHERE key = ?`).run(KEY);
  } catch {
    // Outbound DB may not be initialized in some unit tests; ignore.
  }
}
