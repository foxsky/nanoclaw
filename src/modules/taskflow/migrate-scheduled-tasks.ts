/** One-shot migrator for legacy scheduled_tasks rows.
 *
 *  Older boards have rows in `taskflow.db.scheduled_tasks` that nothing
 *  reads anymore — v2's host-sweep polls `messages_in` instead. This
 *  migrator reads each active/paused row, resolves the matching session's
 *  inbound.db, inserts the equivalent kind='task' row via insertTask
 *  (preserving the source row's id so board_runtime_config back-references
 *  survive), then marks the source row status='migrated'.
 *
 *  Idempotency model: the insert + mark-migrated pair lives across two
 *  separate SQLite connections (inboundDb + tfDb), so a single transaction
 *  can't span them — a host crash between insert and mark leaves a partial
 *  state. Re-runs detect this via an existence check on `messages_in.id`:
 *  if the row already exists, skip the insert (avoiding PK collision) and
 *  retry only the mark. Per-row failure (no session, malformed cron, etc.)
 *  is logged + counted but does not abort the rest of the batch.
 *
 *  NOT preserved from the source row: `context_mode`, `last_run`,
 *  `last_result`, and the `trigger_*` columns. None are read by v2
 *  scheduling. */
import type Database from 'better-sqlite3';

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getAllMessagingGroups } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { insertTask } from '../scheduling/db.js';
import { ensureSessionInbound, nextCronRun, taskEnvelope } from './provision-shared.js';
import { TIMEZONE } from '../../config.js';

export interface MigrateResult {
  migrated: number;
  skipped: number;
  failed: number;
}

export type InboundResolver = (groupFolder: string, chatJid: string) => Database.Database | null;

interface ScheduledTaskRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script: string | null;
  schedule_type: 'cron' | 'once';
  schedule_value: string;
  next_run: string | null;
  status: string;
}

export function migrateScheduledTasks(tfDb: Database.Database, resolveInbound: InboundResolver): MigrateResult {
  const result: MigrateResult = { migrated: 0, skipped: 0, failed: 0 };
  // Graceful no-op if the table has already been dropped (post-2.3.g.4 hosts).
  if (!scheduledTasksTableExists(tfDb)) return result;

  // Pull only active/paused rows; migrated/completed/cancelled are skip-counted
  // in a separate query so the post-drain steady state has zero work to do.
  const migratable = tfDb
    .prepare(
      `SELECT id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, next_run, status
       FROM scheduled_tasks
       WHERE status IN ('active', 'paused')`,
    )
    .all() as ScheduledTaskRow[];
  const skippedCount = (
    tfDb.prepare(`SELECT COUNT(*) AS c FROM scheduled_tasks WHERE status NOT IN ('active', 'paused')`).get() as {
      c: number;
    }
  ).c;
  result.skipped = skippedCount;

  const markMigrated = tfDb.prepare(`UPDATE scheduled_tasks SET status = 'migrated' WHERE id = ?`);

  for (const row of migratable) {
    try {
      const inboundDb = resolveInbound(row.group_folder, row.chat_jid);
      if (!inboundDb) {
        log.warn('migrateScheduledTasks: no session for row, will retry on next run', {
          taskId: row.id,
          groupFolder: row.group_folder,
          chatJid: row.chat_jid,
        });
        result.failed++;
        continue;
      }

      // For cron rows with NULL next_run, compute a fresh next-occurrence
      // in TIMEZONE (matches v2's recurrence handler). For once rows with
      // NULL next_run, fail — there's no reasonable fallback.
      let processAfter: string | null = row.next_run;
      if (processAfter === null) {
        if (row.schedule_type === 'cron') {
          processAfter = nextCronRun(row.schedule_value, TIMEZONE);
        }
      }
      if (processAfter === null) {
        log.warn('migrateScheduledTasks: cannot compute process_after, skipping', {
          taskId: row.id,
          scheduleType: row.schedule_type,
          scheduleValue: row.schedule_value,
        });
        result.failed++;
        continue;
      }

      const recurrence = row.schedule_type === 'cron' ? row.schedule_value : null;

      // Cross-DB idempotency: a single transaction can't span tfDb +
      // inboundDb (better-sqlite3 transactions are per-connection), so
      // we detect prior partial-success instead. If messages_in already
      // has this id, the insertTask already ran on a previous attempt;
      // skip re-inserting (would PK-collide) and just retry the mark.
      const exists = inboundDb.prepare(`SELECT 1 FROM messages_in WHERE id = ?`).get(row.id) as
        | { 1: number }
        | undefined;
      if (!exists) {
        insertTask(inboundDb, {
          id: row.id,
          processAfter,
          recurrence,
          platformId: null,
          channelType: null,
          threadId: null,
          content: taskEnvelope(row.prompt, row.script),
        });
      }
      markMigrated.run(row.id);
      result.migrated++;
    } catch (err) {
      log.error('migrateScheduledTasks: per-row failure (continuing)', { taskId: row.id, err });
      result.failed++;
    }
  }

  log.info('migrateScheduledTasks: done', { ...result });
  return result;
}

/** Default resolver: maps (group_folder, chat_jid) → session inbound.db
 *  via the central v2.db wiring. Caches each opened handle so multi-row
 *  migration into the same session opens once. Returns `{resolve, closeAll}`;
 *  the caller MUST call closeAll to release the file handles.
 *
 *  Note: `ensureSessionInbound` invokes `resolveSession('shared')` which
 *  CREATES a session row if none exists for this (agent_group,
 *  messaging_group) pair. That's intentional — v2's host-sweep needs a
 *  session row to find the inbound.db that holds the migrated tasks. */
export function defaultInboundResolver(): { resolve: InboundResolver; closeAll: () => void } {
  const platformToMessaging = new Map<string, string>();
  for (const mg of getAllMessagingGroups()) platformToMessaging.set(mg.platform_id, mg.id);

  const opened = new Map<string, Database.Database>();
  const resolve: InboundResolver = (groupFolder, chatJid) => {
    const ag = getAgentGroupByFolder(groupFolder);
    const messagingGroupId = platformToMessaging.get(chatJid);
    if (!ag || !messagingGroupId) return null;
    const cacheKey = `${ag.id}:${messagingGroupId}`;
    const cached = opened.get(cacheKey);
    if (cached) return cached;
    const db = ensureSessionInbound(ag.id, messagingGroupId);
    opened.set(cacheKey, db);
    return db;
  };
  const closeAll = () => {
    for (const db of opened.values()) {
      try {
        db.close();
      } catch {}
    }
    opened.clear();
  };
  return { resolve, closeAll };
}

function scheduledTasksTableExists(tfDb: Database.Database): boolean {
  const row = tfDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'`)
    .get();
  return !!row;
}

/** Drops the legacy `scheduled_tasks` table once the migrator has drained
 *  every active/paused row. Called from host startup right after
 *  `migrateScheduledTasks` so the table's lifetime ends as soon as the
 *  last source row has been moved over. Safety: if any row still has
 *  status `active` or `paused`, leaves the table alone so the operator
 *  can retry on the next startup. Idempotent on already-dropped DBs. */
export function dropScheduledTasksIfDrained(tfDb: Database.Database): boolean {
  if (!scheduledTasksTableExists(tfDb)) return false;
  const undrained = (
    tfDb
      .prepare(`SELECT COUNT(*) AS c FROM scheduled_tasks WHERE status IN ('active', 'paused')`)
      .get() as { c: number }
  ).c;
  if (undrained > 0) {
    log.warn('dropScheduledTasksIfDrained: undrained rows remain, skipping drop', { undrained });
    return false;
  }
  tfDb.exec(`DROP TABLE scheduled_tasks`);
  log.info('dropScheduledTasksIfDrained: legacy table removed');
  return true;
}
