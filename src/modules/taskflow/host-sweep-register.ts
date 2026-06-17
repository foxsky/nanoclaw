/**
 * ADR 0006 contract #4 registration — TaskFlow host-sweep hooks.
 *
 * Registers the two fork behaviors that used to be inline in src/host-sweep.ts:
 *   1. The due-message gate: suppress idle/stale-board [TF-*] runners before the
 *      wake (gateDueRunnersForSession — internally fail-open, #387 lock-tested).
 *   2. The recurrence per-board timezone resolver: TaskFlow runner rows advance in
 *      the board's OWN timezone (Option A per-board TZ); every other row returns
 *      undefined so handleRecurrence falls back to the global TIMEZONE. The board
 *      TZ is resolved at most once per session per tick (memoized in the closure).
 *
 * Side-effect module: imported by src/modules/taskflow/index.ts.
 */
import { registerDueMessageGate, registerRecurrenceTzResolver } from '../../host-sweep-extensions.js';
import { resolveBoardTimezone } from '../../taskflow-db.js';
import { gateDueRunnersForSession, isTfRunnerContent } from './runner-gate-apply.js';

registerDueMessageGate(gateDueRunnersForSession);

registerRecurrenceTzResolver((agentGroupFolder) => {
  let boardTz: string | undefined;
  let boardTzResolved = false;
  return (msg) => {
    if (msg.kind !== 'task' || !isTfRunnerContent(msg.content)) return undefined;
    if (!boardTzResolved) {
      boardTz = resolveBoardTimezone(agentGroupFolder);
      boardTzResolved = true;
    }
    return boardTz;
  };
});
