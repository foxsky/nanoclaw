/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { clearRecurrence, getCompletedRecurring, insertRecurrence, type RecurringMessage } from './db.js';

/**
 * Resolve the timezone to interpret a row's cron in. Injected by the caller so this generic module
 * stays TaskFlow-unaware: the host sweep returns a board's own zone for TaskFlow runner rows and
 * undefined for everything else (generic user schedule_task crons), which falls back to TIMEZONE.
 */
export type RowTimezoneResolver = (msg: RecurringMessage) => string | undefined;

export async function handleRecurrence(
  inDb: Database.Database,
  session: Session,
  tzForRow?: RowTimezoneResolver,
): Promise<void> {
  const recurring = getCompletedRecurring(inDb);

  for (const msg of recurring) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      // Interpret the cron in the row's resolved timezone (a board's own zone for TaskFlow runners),
      // defaulting to the global TIMEZONE. v1 did the TZ interpretation (src/v1/task-scheduler.ts:
      // 20-49); without it, "0 9 * * *" fires at 09:00 UTC instead of 09:00 local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz: tzForRow?.(msg) ?? TIMEZONE });
      const nextRun = interval.next().toISOString();
      const prefix = msg.kind === 'task' ? 'task' : 'msg';
      const newId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Atomic: a crash between the insert and the clear would leave the original row with
      // recurrence still set, so the next sweep re-matches it and double-fires the series.
      inDb.transaction(() => {
        insertRecurrence(inDb, msg, newId, nextRun);
        clearRecurrence(inDb, msg.id);
      })();

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.series_id,
        nextRun,
        sessionId: session.id,
      });
    } catch (err) {
      log.error('Failed to compute next recurrence', {
        messageId: msg.id,
        recurrence: msg.recurrence,
        err,
      });
    }
  }
}
