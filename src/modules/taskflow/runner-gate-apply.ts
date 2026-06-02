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
 * Undefined → assume the board shares the gate's zone (the case for every board today) and gate
 * normally; a defined value that differs trips the per-board-TZ guard below.
 */
function boardTimezone(taskflowDb: Database.Database, boardId: string): string | undefined {
  try {
    const row = taskflowDb.prepare('SELECT timezone FROM board_runtime_config WHERE board_id = ?').get(boardId) as
      | { timezone: string | null }
      | undefined;
    return row?.timezone ?? undefined;
  } catch {
    return undefined;
  }
}

export function gateScheduledRunners(
  inDb: Database.Database,
  taskflowDb: Database.Database,
  opts: GateRunnersOpts,
): GateOutcome[] {
  // Per-board-TZ guard. The runner's FIRE time is scheduled in the deploy TZ (scheduleRunners +
  // handleRecurrence both parse the local cron in the global TIMEZONE), so the gate can only judge
  // Monday/due-today/since-last-run correctly for boards in that same zone. For a board configured
  // in a different timezone, skip gating entirely — let every runner fire as it would pre-gate —
  // rather than suppress it against the wrong calendar day. (Full per-board gating is deferred: it
  // needs the cron itself to move to the board's zone; see the per-board-TZ handoff.)
  const boardTz = boardTimezone(taskflowDb, opts.boardId);
  if (boardTz && boardTz !== opts.timeZone) {
    log.warn('Runner gating skipped — board timezone differs from gate timezone (runners fire ungated)', {
      boardId: opts.boardId,
      boardTz,
      gateTz: opts.timeZone,
    });
    return [];
  }

  const due = inDb
    .prepare(
      `SELECT id, content, recurrence FROM messages_in
       WHERE status = 'pending' AND trigger = 1 AND recurrence IS NOT NULL
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
      timeZone: opts.timeZone,
    });
    const { fire } = decideRunnerGate(job, state);
    if (!fire) complete.run(row.id);
    outcomes.push({ id: row.id, job, fired: fire });
  }
  return outcomes;
}

const DUE_TF_RUNNER_COUNT = `SELECT COUNT(*) n FROM messages_in
   WHERE status = 'pending' AND trigger = 1 AND recurrence IS NOT NULL
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
