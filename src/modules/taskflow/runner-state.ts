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

/** ISO of the runner cron's occurrence strictly before `now` — i.e. its last scheduled run. */
export function previousRunIso(cron: string, now: Date, tz: string): string {
  return CronExpressionParser.parse(cron, { tz, currentDate: now }).prev().toDate().toISOString();
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
}

export function computeRunnerState(deps: RunnerStateDeps): RunnerState {
  const { taskflowDb, inboundDb, boardId, cron, now, timeZone } = deps;
  const since = previousRunIso(cron, now, timeZone);
  const localDate = localDateString(now, timeZone);
  const weekday = localWeekday(now, timeZone);

  const pending =
    count(taskflowDb, "SELECT COUNT(*) n FROM tasks WHERE board_id = ? AND column != 'done'", boardId) > 0;

  // due_date is stored either date-only or as an ISO instant; match the date prefix. (Near-midnight
  // ISO dues use their UTC date — a minor edge; date-only values, the common case, are exact.)
  const dueTaskToday =
    count(
      taskflowDb,
      "SELECT COUNT(*) n FROM tasks WHERE board_id = ? AND column != 'done' AND substr(due_date, 1, 10) = ?",
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
