/**
 * Host-side computation of a board's RunnerState at runner fire time, for the gating policy in
 * runner-gate.ts. Reads the shared taskflow.db (tasks + task_history, board_id-scoped) and the
 * session's inbound.db (member messages = kind='chat'; runner rows are kind='task'). The
 * "since last run" window is the runner's own previous cron occurrence. All day/date reasoning
 * is in the board's local timezone (the crons are stored local), so weekend/Monday/due-today
 * land on the right calendar day.
 */
import { CronExpressionParser } from 'cron-parser';
import type Database from 'better-sqlite3';

import type { RunnerState } from './runner-gate.js';

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function localWeekday(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
}

export function isMondayLocal(now: Date, tz: string): boolean {
  return localWeekday(now, tz) === 'Mon';
}

/** Local calendar date as 'YYYY-MM-DD' (en-CA renders ISO order). */
export function localDateString(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    now,
  );
}

/**
 * ISO of the runner's PREVIOUS scheduled run — the occurrence before the one firing now.
 * The gate only runs on already-due rows, so `now >= the firing occurrence`; a single prev()
 * from now returns that firing occurrence (window ≈ a few seconds → active boards wrongly look
 * idle). Step back twice: first prev() = the occurrence being fired, second = the prior run.
 * For a daily runner that's ~24h ago; for the weekly review, ~1 week ago.
 */
export function previousRunIso(cron: string, now: Date, tz: string): string {
  const it = CronExpressionParser.parse(cron, { tz, currentDate: now });
  it.prev(); // the occurrence currently firing (<= now)
  return it.prev().toDate().toISOString(); // the run before it
}

/**
 * ISO of the scheduled run before the occurrence the firing row belongs to, given the row's
 * `process_after` as `anchor`. Anchoring on the occurrence instead of `now` keeps the interactions
 * window correct when the sweep is delayed and `now` has drifted past it (A4).
 *
 * `anchor` is usually an exact cron occurrence, but the retry path rewrites process_after to
 * now+backoff (resetStuckProcessingRows → retryWithBackoff), a NON-occurrence instant slightly
 * after the real tick. So first snap to the occurrence AT-OR-BEFORE the anchor (the +1ms makes an
 * exact-occurrence anchor count as "at"), then step back once. Without the snap a backoff anchor
 * would step back only to its own firing occurrence and collapse the window (Codex gpt-5.5).
 */
export function previousRunBefore(cron: string, anchor: Date, tz: string): string {
  const occurrence = CronExpressionParser.parse(cron, { tz, currentDate: new Date(anchor.getTime() + 1) })
    .prev()
    .toDate();
  return CronExpressionParser.parse(cron, { tz, currentDate: occurrence }).prev().toDate().toISOString();
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface RunnerStateDeps {
  taskflowDb: Database.Database;
  inboundDb: Database.Database;
  boardId: string;
  cron: string;
  now: Date;
  timeZone: string;
  /** The firing row's `process_after` (ISO) — when set, the interactions window is anchored on this
   *  scheduled occurrence rather than `now`, so a delayed/overdue sweep can't shift it (A4). */
  firingInstant?: string | null;
}

export function computeRunnerState(deps: RunnerStateDeps): RunnerState {
  const { taskflowDb, inboundDb, boardId, cron, now, timeZone, firingInstant } = deps;
  const since = firingInstant
    ? previousRunBefore(cron, new Date(firingInstant), timeZone)
    : previousRunIso(cron, now, timeZone);
  const localDate = localDateString(now, timeZone);
  const weekday = localWeekday(now, timeZone);

  // Reportable work = local pending OR parent-board tasks assigned to THIS board's people — the
  // PARENT_BOARD_HINT scope the runners themselves report (provision-shared.ts). Without the parent
  // clause a child/delegated board with only delegated work would read Idle and be wrongly silenced.
  const pending =
    count(
      taskflowDb,
      `SELECT (
         EXISTS(SELECT 1 FROM tasks WHERE board_id = ? AND column != 'done')
         OR EXISTS(SELECT 1 FROM tasks
              WHERE board_id = (SELECT parent_board_id FROM boards WHERE id = ?)
                AND column != 'done'
                AND assignee IN (SELECT person_id FROM board_people WHERE board_id = ?))
       ) AS n`,
      boardId,
      boardId,
      boardId,
    ) > 0;

  // due_date is stored either date-only or as an ISO instant; match the date prefix. (Near-midnight
  // ISO dues use their UTC date — a minor edge; date-only values, the common case, are exact.) Same
  // local-or-parent-assigned scope as pending.
  const dueTaskToday =
    count(
      taskflowDb,
      `SELECT (
         EXISTS(SELECT 1 FROM tasks WHERE board_id = ? AND column != 'done' AND substr(due_date, 1, 10) = ?)
         OR EXISTS(SELECT 1 FROM tasks
              WHERE board_id = (SELECT parent_board_id FROM boards WHERE id = ?)
                AND column != 'done'
                AND assignee IN (SELECT person_id FROM board_people WHERE board_id = ?)
                AND substr(due_date, 1, 10) = ?)
       ) AS n`,
      boardId,
      localDate,
      boardId,
      boardId,
      localDate,
    ) > 0;
  const dueToday = WEEKDAYS.has(weekday) && dueTaskToday;

  const taskChanged =
    count(taskflowDb, 'SELECT COUNT(*) n FROM task_history WHERE board_id = ? AND at > ?', boardId, since) > 0;
  const memberPosted =
    count(inboundDb, "SELECT COUNT(*) n FROM messages_in WHERE kind = 'chat' AND timestamp > ?", since) > 0;
  const interactions = taskChanged || memberPosted;

  return { pending, interactions, dueToday, isMonday: isMondayLocal(now, timeZone) };
}
