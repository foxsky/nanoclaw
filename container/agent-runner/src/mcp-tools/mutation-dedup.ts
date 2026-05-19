/**
 * Phase-3 unit-2-core / Codex gate P4 — double-emit dedup primitive.
 *
 * v1 only ever sent the deterministic mutation confirmation card. v2's
 * MCP path now emits that card AND the model still produces a bare-text
 * final reply for the same conversation, doubling the user-facing
 * message on every mutation turn (SECI prompt explicitly asks the model
 * to always reply after a write). This primitive lets the deterministic
 * path mark the turn and the bare-text dispatch consume-and-suppress.
 *
 * Read-and-clear: each turn's single `dispatchResultText` consumes the
 * flag, so no explicit per-turn reset is needed at the call sites. A
 * test-only reset is exposed for unit-test isolation.
 */
let flagged = false;

export function markDeterministicMutationEmitted(): void {
  flagged = true;
}

export function consumeDeterministicMutationFlag(): boolean {
  const was = flagged;
  flagged = false;
  return was;
}

export function __resetDedupForTesting(): void {
  flagged = false;
}
