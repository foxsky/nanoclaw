/**
 * MIRROR of the host gate policy at src/modules/taskflow/runner-gate.ts — keep the two in sync.
 * Host and container share no modules (separate runtimes/DB drivers), so this is a deliberate copy.
 *
 * Container-side use: the poll-loop applies this BEFORE markProcessing so a warm container can't
 * post a runner the host sweep would have suppressed (closing the warm-container race). The pure
 * policy is identical to the host's; only the surrounding RunnerState computation differs by driver.
 *
 * Tiers (interactions decide first): Active → keep cadence, digest→resumo; Stale → standup on
 * Monday or a weekday a task is due, else silent; Idle → everything silent.
 */
export type RunnerJob = 'standup' | 'digest' | 'review';

export interface RunnerState {
  /** Any task not in Done (Waiting/blocked included), local or parent-assigned to this board's people. */
  pending: boolean;
  /** Since the last scheduled run: a group message, or a task created/moved/commented. */
  interactions: boolean;
  /** A task is due today AND today is a weekday (weekend due dates resolve to false upstream). */
  dueToday: boolean;
  /** Today is Monday in the board's local timezone. */
  isMonday: boolean;
}

export interface RunnerGateDecision {
  fire: boolean;
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
      if (job === 'standup' && (state.isMonday || state.dueToday)) return { fire: true, summaryMode: false };
      return silent;
    case 'active':
      return { fire: true, summaryMode: job === 'digest' };
  }
}
