/**
 * Per-board gating policy for the scheduled TaskFlow runners (standup / digest / review).
 *
 * Motivation: ~10 boards × 3 daily/weekly crons produced a bot-like burst of WhatsApp messages
 * that the platform flagged. The host computes each board's state at fire time and suppresses a
 * runner BEFORE waking the agent (a hard gate, not a prompt request), so quiet boards go silent.
 *
 * Tiers (interactions decide first):
 *   - Active: had interactions since the last run → keep the cadence, but trim the digest to a resumo.
 *   - Stale:  pending work but no interactions → one standup on Monday, plus any weekday a task is
 *             due that day; digest + weekly review stay silent.
 *   - Idle:   nothing pending and no interactions → everything silent.
 *
 * This module is pure policy. The caller computes `RunnerState` (pending / interactions / dueToday /
 * isMonday) from taskflow.db + inbound messages in the board's local timezone, and acts on `fire`.
 * (`summaryMode` is advisory and currently unconsumed — the digest's resumo form is baked into
 * `DIGEST_PROMPT` at provision, not applied from this flag.) `dueToday` already folds in "today is a
 * weekday" (weekend due dates → false).
 */
export type RunnerJob = 'standup' | 'digest' | 'review';

export interface RunnerState {
  /** Any task not in Done (Waiting/blocked included). */
  pending: boolean;
  /** Since the last scheduled run: a group message, or a task created/moved/commented. */
  interactions: boolean;
  /** A task is due today AND today is a weekday (weekend due dates resolve to false upstream). */
  dueToday: boolean;
  /** Today is Monday in the board's local timezone. */
  isMonday: boolean;
}

export interface RunnerGateDecision {
  /** Whether this runner should wake the agent and post at all. */
  fire: boolean;
  /** When firing a digest for an active board, render the short resumo instead of the full breakdown. */
  summaryMode: boolean;
}

function tier(state: RunnerState): 'active' | 'stale' | 'idle' {
  if (state.interactions) return 'active';
  if (state.pending) return 'stale';
  return 'idle';
}

export function decideRunnerGate(job: RunnerJob, state: RunnerState): RunnerGateDecision {
  const silent: RunnerGateDecision = { fire: false, summaryMode: false };
  switch (tier(state)) {
    case 'idle':
      return silent;
    case 'stale':
      // Only the standup speaks for a stale board, and only on Monday or a weekday with a due task.
      if (job === 'standup' && (state.isMonday || state.dueToday)) return { fire: true, summaryMode: false };
      return silent;
    case 'active':
      // Keep the daily standup and Friday review intact; shrink only the evening digest.
      return { fire: true, summaryMode: job === 'digest' };
  }
}
