/**
 * Host-side hard gate for the scheduled TaskFlow runners. Runs in the sweep BEFORE the
 * due-message wake: for each due [TF-*] runner row it computes the board's state and applies
 * decideRunnerGate. Suppressed runners are marked `completed` so they (a) drop out of
 * countDueMessages → no container wake, and (b) get advanced to their next occurrence by the
 * existing handleRecurrence fanout (which keys off status='completed' AND recurrence). Fired
 * runners are left pending and wake/post as usual.
 *
 * Only `kind='task'` recurring rows whose content carries a [TF-STANDUP|DIGEST|REVIEW] tag are
 * touched — human messages and one-shot tasks are never affected. The digest's resumo trim is
 * not a per-occurrence signal (that would propagate via insertRecurrence): under this policy the
 * digest only ever fires for active boards, so its prompt is unconditionally the resumo form.
 */
import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR, TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import { isValidTimezone } from '../../timezone.js';
import { resolveTaskflowBoardId } from '../../taskflow-db.js';
import { computeRunnerState } from './runner-state.js';
import { decideRunnerGate, type RunnerJob } from './runner-gate.js';

const JOB_TAGS: ReadonlyArray<[string, RunnerJob]> = [
  ['[TF-STANDUP]', 'standup'],
  ['[TF-DIGEST]', 'digest'],
  ['[TF-REVIEW]', 'review'],
];

function jobFromContent(content: string): RunnerJob | null {
  for (const [tag, job] of JOB_TAGS) if (content.includes(tag)) return job;
  return null;
}

/** True iff the envelope carries an EXACT TaskFlow runner tag ([TF-STANDUP|DIGEST|REVIEW]).
 *  Used by the sweep's recurrence resolver to scope per-board TZ to runner rows only — generic
 *  user schedule_task rows must keep the global zone. Single-sources the tag list via jobFromContent. */
export function isTfRunnerContent(content: string): boolean {
  return jobFromContent(content) !== null;
}

export interface GateRunnersOpts {
  boardId: string;
  now: Date;
  timeZone: string;
}

export interface GateOutcome {
  id: string;
  job: RunnerJob;
  fired: boolean;
}

interface DueRunnerRow {
  id: string;
  content: string;
  recurrence: string;
}

/**
 * The board's configured timezone, or undefined if it can't be determined (missing table/row).
 * Undefined → gate falls back to the global zone (the case for every board today).
 */
function boardTimezone(taskflowDb: Database.Database, boardId: string): string | undefined {
  try {
    const row = taskflowDb.prepare('SELECT timezone FROM board_runtime_config WHERE board_id = ?').get(boardId) as
      | { timezone: string | null }
      | undefined;
    const tz = row?.timezone ?? undefined;
    // Validate so a corrupt board_runtime_config.timezone falls back to the gate's zone (consistent
    // with provision/recurrence) instead of throwing into cron-parser and fail-opening the runner.
    return tz && isValidTimezone(tz) ? tz : undefined;
  } catch {
    return undefined;
  }
}

export function gateScheduledRunners(
  inDb: Database.Database,
  taskflowDb: Database.Database,
  opts: GateRunnersOpts,
): GateOutcome[] {
  // Judge each runner in the board's OWN timezone (Option A per-board TZ), falling back to the gate's
  // zone when the board has none (every board today). Fire time is scheduled in the same board zone
  // (provision + handleRecurrence), so the gate window and the actual fire instant agree.
  const tz = boardTimezone(taskflowDb, opts.boardId) ?? opts.timeZone;

  const due = inDb
    .prepare(
      `SELECT id, content, recurrence FROM messages_in
       WHERE status = 'pending' AND trigger = 1 AND kind = 'task' AND recurrence IS NOT NULL
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
         AND content LIKE '%[TF-%'`,
    )
    .all() as DueRunnerRow[];

  const complete = inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?");
  const outcomes: GateOutcome[] = [];

  for (const row of due) {
    const job = jobFromContent(row.content);
    if (!job) continue; // matched [TF- loosely but no known job tag — leave it alone
    const state = computeRunnerState({
      taskflowDb,
      inboundDb: inDb,
      boardId: opts.boardId,
      cron: row.recurrence,
      now: opts.now,
      timeZone: tz,
    });
    const { fire } = decideRunnerGate(job, state);
    if (!fire) complete.run(row.id);
    outcomes.push({ id: row.id, job, fired: fire });
  }
  return outcomes;
}

const DUE_TF_RUNNER_COUNT = `SELECT COUNT(*) n FROM messages_in
   WHERE status = 'pending' AND trigger = 1 AND kind = 'task' AND recurrence IS NOT NULL
     AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
     AND content LIKE '%[TF-%'`;

/**
 * Sweep entry point: gate this session's due TaskFlow runners against the board's state, called
 * before the wake in host-sweep. Fail-open — board resolution / taskflow.db open is wrapped so any
 * error leaves the runner pending to fire as before (never silences a board on an internal error).
 * No-ops cheaply (one COUNT) when no [TF-*] runner is due, so non-TaskFlow sessions and idle ticks
 * never open taskflow.db.
 */
export function gateDueRunnersForSession(inDb: Database.Database, agentGroupFolder: string): void {
  try {
    const { n } = inDb.prepare(DUE_TF_RUNNER_COUNT).get() as { n: number };
    if (n === 0) return;

    const boardId = resolveTaskflowBoardId(agentGroupFolder, true);
    if (!boardId) return;

    const tfDb = new Database(path.join(DATA_DIR, 'taskflow', 'taskflow.db'), {
      readonly: true,
      fileMustExist: true,
    });
    tfDb.pragma('busy_timeout = 5000');
    try {
      const outcomes = gateScheduledRunners(inDb, tfDb, { boardId, now: new Date(), timeZone: TIMEZONE });
      const suppressed = outcomes.filter((o) => !o.fired).map((o) => o.job);
      if (suppressed.length) log.info('Gated scheduled runners (suppressed)', { boardId, jobs: suppressed });
    } finally {
      tfDb.close();
    }
  } catch (err) {
    log.warn('Runner gating skipped (fail-open)', { agentGroupFolder, err });
  }
}
