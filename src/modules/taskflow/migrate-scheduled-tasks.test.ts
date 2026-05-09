import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INBOUND_SCHEMA } from '../../db/schema.js';
import { initTaskflowDb } from '../../taskflow-db.js';
import { migrateScheduledTasks } from './migrate-scheduled-tasks.js';

const TMPROOT = path.join(os.tmpdir(), `nanoclaw-migrate-scheduled-test-${process.pid}`);

describe('migrateScheduledTasks', () => {
  let dbFile: string;
  let tfDb: Database.Database;
  let inboundDb: Database.Database;

  beforeEach(() => {
    fs.mkdirSync(TMPROOT, { recursive: true });
    dbFile = path.join(TMPROOT, `migrate-${Date.now()}.db`);
    tfDb = initTaskflowDb(dbFile);
    inboundDb = new Database(':memory:');
    inboundDb.exec(INBOUND_SCHEMA);
  });

  afterEach(() => {
    try {
      tfDb.close();
    } catch {}
    try {
      inboundDb.close();
    } catch {}
    fs.rmSync(dbFile, { force: true });
  });

  function seedRow(opts: {
    id: string;
    group_folder?: string;
    chat_jid?: string;
    prompt?: string;
    script?: string | null;
    schedule_type?: 'cron' | 'once';
    schedule_value?: string;
    /** undefined → use default; null → store NULL; string → use as-is. */
    next_run?: string | null;
    status?: string;
  }): void {
    const nextRun = 'next_run' in opts ? opts.next_run : '2099-01-01T08:00:00Z';
    tfDb
      .prepare(
        `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, next_run, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.id,
        opts.group_folder ?? 'test-folder',
        opts.chat_jid ?? '120@g.us',
        opts.prompt ?? 'test prompt',
        opts.script ?? null,
        opts.schedule_type ?? 'cron',
        opts.schedule_value ?? '0 8 * * 1-5',
        nextRun,
        opts.status ?? 'active',
        '2026-01-01T00:00:00Z',
      );
  }

  it('migrates a single active cron row to messages_in with v2 envelope', () => {
    seedRow({
      id: 'task-001',
      prompt: 'STANDUP-PROMPT',
      script: null,
      schedule_type: 'cron',
      schedule_value: '0 8 * * 1-5',
      next_run: '2099-01-01T08:00:00Z',
    });

    const result = migrateScheduledTasks(tfDb, () => inboundDb);

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const rows = inboundDb
      .prepare(`SELECT id, kind, recurrence, content, process_after FROM messages_in`)
      .all() as Array<{
      id: string;
      kind: string;
      recurrence: string | null;
      content: string;
      process_after: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('task-001');
    expect(rows[0]!.kind).toBe('task');
    expect(rows[0]!.recurrence).toBe('0 8 * * 1-5');
    expect(rows[0]!.process_after).toBe('2099-01-01T08:00:00Z');
    const envelope = JSON.parse(rows[0]!.content);
    expect(envelope).toEqual({ prompt: 'STANDUP-PROMPT', script: null });

    // Source row marked migrated.
    const src = tfDb.prepare(`SELECT status FROM scheduled_tasks WHERE id = ?`).get('task-001') as
      | { status: string }
      | undefined;
    expect(src?.status).toBe('migrated');
  });

  it('preserves script field when present (JSON envelope)', () => {
    seedRow({ id: 'task-002', prompt: 'P', script: 'echo hello' });

    migrateScheduledTasks(tfDb, () => inboundDb);

    const row = inboundDb.prepare(`SELECT content FROM messages_in WHERE id = ?`).get('task-002') as
      | { content: string }
      | undefined;
    expect(JSON.parse(row!.content)).toEqual({ prompt: 'P', script: 'echo hello' });
  });

  it('migrates schedule_type=once with recurrence=null', () => {
    seedRow({
      id: 'task-once-1',
      schedule_type: 'once',
      schedule_value: '2099-06-01T12:00:00Z',
      next_run: '2099-06-01T12:00:00Z',
    });

    migrateScheduledTasks(tfDb, () => inboundDb);

    const row = inboundDb
      .prepare(`SELECT recurrence FROM messages_in WHERE id = ?`)
      .get('task-once-1') as { recurrence: string | null } | undefined;
    expect(row?.recurrence).toBeNull();
  });

  it('skips rows already migrated (idempotent re-run)', () => {
    seedRow({ id: 'task-already', status: 'migrated' });

    const result = migrateScheduledTasks(tfDb, () => inboundDb);

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    const rows = inboundDb.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('skips rows with status not in {active, paused}', () => {
    seedRow({ id: 'task-cancelled', status: 'cancelled' });
    seedRow({ id: 'task-completed', status: 'completed' });
    seedRow({ id: 'task-active', status: 'active' });

    const result = migrateScheduledTasks(tfDb, () => inboundDb);

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('counts a per-row failure (no inbound resolved) without aborting', () => {
    seedRow({ id: 'task-no-session', group_folder: 'orphan-folder' });
    seedRow({ id: 'task-ok', group_folder: 'test-folder' });

    let calls = 0;
    const result = migrateScheduledTasks(tfDb, (groupFolder) => {
      calls++;
      return groupFolder === 'orphan-folder' ? null : inboundDb;
    });

    expect(calls).toBe(2);
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(1);
    const okRow = tfDb.prepare(`SELECT status FROM scheduled_tasks WHERE id = ?`).get('task-ok') as
      | { status: string }
      | undefined;
    expect(okRow?.status).toBe('migrated');
    const orphanRow = tfDb
      .prepare(`SELECT status FROM scheduled_tasks WHERE id = ?`)
      .get('task-no-session') as { status: string } | undefined;
    // Orphan stays 'active' so a future run can retry once the session exists.
    expect(orphanRow?.status).toBe('active');
  });

  it('cron row with null next_run computes a fresh next-occurrence (NOT the cron string)', () => {
    seedRow({
      id: 'task-cron-null-next',
      schedule_type: 'cron',
      schedule_value: '0 8 * * 1-5',
      next_run: null,
    });

    migrateScheduledTasks(tfDb, () => inboundDb);

    const row = inboundDb
      .prepare(`SELECT process_after FROM messages_in WHERE id = ?`)
      .get('task-cron-null-next') as { process_after: string } | undefined;
    expect(row).toBeTruthy();
    // process_after must be a valid ISO timestamp (parseable), not a cron string.
    expect(row!.process_after).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(row!.process_after).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('once row with null next_run is failed (no fallback)', () => {
    seedRow({
      id: 'task-once-null-next',
      schedule_type: 'once',
      schedule_value: 'whatever',
      next_run: null,
    });

    const result = migrateScheduledTasks(tfDb, () => inboundDb);
    expect(result.failed).toBe(1);
    expect(result.migrated).toBe(0);
    const inMessages = inboundDb
      .prepare(`SELECT COUNT(*) AS c FROM messages_in WHERE id = ?`)
      .get('task-once-null-next') as { c: number };
    expect(inMessages.c).toBe(0);
  });

  it('idempotent retry after partial-success: insert lands but mark fails; re-run completes without PK collision', () => {
    seedRow({ id: 'task-retry', prompt: 'P' });

    // Simulate insertTask succeeding then markMigrated throwing on the
    // first call. Cross-DB transactions can't span tfDb + inboundDb, so
    // the messages_in row IS persisted; idempotency comes from the
    // exists-check on retry.
    let throwOnce = true;
    const realPrepare = tfDb.prepare.bind(tfDb);
    tfDb.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (throwOnce && /UPDATE scheduled_tasks SET status = 'migrated'/.test(sql)) {
        return {
          ...stmt,
          run: () => {
            throwOnce = false;
            throw new Error('transient failure');
          },
        } as unknown as ReturnType<typeof realPrepare>;
      }
      return stmt;
    }) as typeof tfDb.prepare;

    const r1 = migrateScheduledTasks(tfDb, () => inboundDb);
    expect(r1.failed).toBe(1);
    // After partial-success: messages_in has the row, source row still 'active'.
    const src1 = tfDb
      .prepare(`SELECT status FROM scheduled_tasks WHERE id = ?`)
      .get('task-retry') as { status: string };
    expect(src1.status).toBe('active');
    const inserted1 = inboundDb
      .prepare(`SELECT COUNT(*) AS c FROM messages_in WHERE id = ?`)
      .get('task-retry') as { c: number };
    expect(inserted1.c).toBe(1);

    // Restore prepare and retry — should detect existing messages_in row
    // and skip re-insertion (PK collision avoided), just complete the mark.
    tfDb.prepare = realPrepare;
    const r2 = migrateScheduledTasks(tfDb, () => inboundDb);
    expect(r2.migrated).toBe(1);
    const inserted2 = inboundDb
      .prepare(`SELECT COUNT(*) AS c FROM messages_in WHERE id = ?`)
      .get('task-retry') as { c: number };
    // Still exactly 1 row — no double-insert.
    expect(inserted2.c).toBe(1);
    const src2 = tfDb
      .prepare(`SELECT status FROM scheduled_tasks WHERE id = ?`)
      .get('task-retry') as { status: string };
    expect(src2.status).toBe('migrated');
  });

  it('passes both group_folder and chat_jid to the resolver', () => {
    seedRow({ id: 'task-resolver-args', group_folder: 'gf-1', chat_jid: 'cj-1@g.us' });

    let calledWith: { gf: string; cj: string } | null = null;
    migrateScheduledTasks(tfDb, (gf, cj) => {
      calledWith = { gf, cj };
      return inboundDb;
    });

    expect(calledWith).toEqual({ gf: 'gf-1', cj: 'cj-1@g.us' });
  });
});
