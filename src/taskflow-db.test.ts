import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { initTaskflowDb } from './taskflow-db.js';

describe('initTaskflowDb', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates board_people with notification_group_jid', () => {
    const db = initTaskflowDb(':memory:');
    const columns = db
      .prepare(`PRAGMA table_info(board_people)`)
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toContain(
      'notification_group_jid',
    );

    db.close();
  });

  it('creates tasks with requires_close_approval', () => {
    const db = initTaskflowDb(':memory:');
    const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
      name: string;
    }>;

    expect(columns.map((column) => column.name)).toContain(
      'requires_close_approval',
    );

    db.close();
  });

  it('adds notification_group_jid to an existing legacy board_people table', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-db-test-'));
    tempDirs.push(tempDir);

    const dbPath = path.join(tempDir, 'taskflow.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE board_people (
        board_id TEXT REFERENCES boards(id),
        person_id TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        role TEXT DEFAULT 'member',
        wip_limit INTEGER,
        PRIMARY KEY (board_id, person_id)
      );
      INSERT INTO boards (id) VALUES ('board-1');
      INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit)
      VALUES ('board-1', 'p1', 'Pat', '5511999999999', 'member', 3);
    `);
    legacyDb.close();

    const db = initTaskflowDb(dbPath);
    const columns = db
      .prepare(`PRAGMA table_info(board_people)`)
      .all() as Array<{ name: string }>;
    const person = db
      .prepare(
        `SELECT person_id, name, notification_group_jid
         FROM board_people
         WHERE board_id = ? AND person_id = ?`,
      )
      .get('board-1', 'p1') as {
      person_id: string;
      name: string;
      notification_group_jid: string | null;
    };

    expect(columns.map((column) => column.name)).toContain(
      'notification_group_jid',
    );
    expect(person).toEqual({
      person_id: 'p1',
      name: 'Pat',
      notification_group_jid: null,
    });

    db.close();
  });

  it('adds requires_close_approval to legacy tasks without name-based backfill', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-db-test-'));
    tempDirs.push(tempDir);

    const dbPath = path.join(tempDir, 'taskflow.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (board_id, person_id));
      CREATE TABLE tasks (
        id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'simple',
        title TEXT NOT NULL,
        assignee TEXT,
        column TEXT DEFAULT 'inbox',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (board_id, id)
      );
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza');
      CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
      CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
      CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
      CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
      CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
      INSERT INTO boards (id) VALUES ('board-1');
      INSERT INTO board_people (board_id, person_id, name) VALUES ('board-1', 'alex', 'Alexandre');
      INSERT INTO board_people (board_id, person_id, name) VALUES ('board-1', 'gio', 'Giovanni');
      INSERT INTO board_runtime_config (board_id) VALUES ('board-1');
      INSERT INTO board_config (board_id) VALUES ('board-1');
      INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
      VALUES ('T1', 'board-1', 'simple', 'Self owned', 'alex', 'next_action', '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z');
      INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
      VALUES ('T2', 'board-1', 'simple', 'Delegated', 'gio', 'next_action', '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z');
      INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
      VALUES ('T3', 'board-1', 'simple', 'Inbox item', NULL, 'inbox', '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z');
      INSERT INTO task_history (board_id, task_id, action, by, at, details)
      VALUES ('board-1', 'T1', 'created', 'Alexandre', '2026-03-10T00:00:00Z', NULL);
      INSERT INTO task_history (board_id, task_id, action, by, at, details)
      VALUES ('board-1', 'T2', 'created', 'Alexandre', '2026-03-10T00:00:00Z', NULL);
    `);
    legacyDb.close();

    const db = initTaskflowDb(dbPath);
    const rows = db
      .prepare(
        `SELECT id, requires_close_approval FROM tasks WHERE board_id = ? ORDER BY id`,
      )
      .all('board-1') as Array<{ id: string; requires_close_approval: number }>;

    expect(rows).toEqual([
      { id: 'T1', requires_close_approval: 1 },
      { id: 'T2', requires_close_approval: 1 },
      { id: 'T3', requires_close_approval: 0 },
    ]);

    db.close();
  });

  it('migrates legacy project subtasks into real task rows', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-db-test-'));
    tempDirs.push(tempDir);

    const dbPath = path.join(tempDir, 'taskflow.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (board_id, person_id));
      CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
      CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
      CREATE TABLE tasks (
        id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'simple',
        title TEXT NOT NULL,
        assignee TEXT,
        next_action TEXT,
        waiting_for TEXT,
        column TEXT DEFAULT 'inbox',
        priority TEXT,
        due_date TEXT,
        description TEXT,
        labels TEXT DEFAULT '[]',
        blocked_by TEXT DEFAULT '[]',
        reminders TEXT DEFAULT '[]',
        next_note_id INTEGER DEFAULT 1,
        notes TEXT DEFAULT '[]',
        _last_mutation TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        child_exec_enabled INTEGER DEFAULT 0,
        child_exec_board_id TEXT,
        child_exec_person_id TEXT,
        child_exec_rollup_status TEXT,
        child_exec_last_rollup_at TEXT,
        child_exec_last_rollup_summary TEXT,
        linked_parent_board_id TEXT,
        linked_parent_task_id TEXT,
        subtasks TEXT,
        recurrence TEXT,
        current_cycle TEXT,
        PRIMARY KEY (board_id, id)
      );
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
      CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza');
      CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
      CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
      INSERT INTO boards (id) VALUES ('board-1');
      INSERT INTO board_people (board_id, person_id, name) VALUES ('board-1', 'rafael', 'Rafael');
      INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES ('board-1', 'rafael', 'board-rafael');
      INSERT INTO board_config (board_id) VALUES ('board-1');
      INSERT INTO board_runtime_config (board_id) VALUES ('board-1');
      INSERT INTO tasks (id, board_id, type, title, assignee, column, subtasks, created_at, updated_at)
      VALUES (
        'P16',
        'board-1',
        'project',
        'Legacy project',
        'manager',
        'next_action',
        '[{"id":"P16.1","title":"Call Jimmy","column":"next_action","assignee":"rafael"}]',
        '2026-03-06T12:39:17Z',
        '2026-03-06T12:39:17Z'
      );
    `);
    legacyDb.close();

    const db = initTaskflowDb(dbPath);
    const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
      name: string;
    }>;
    const subtask = db
      .prepare(
        `SELECT id, parent_task_id, assignee, child_exec_enabled, child_exec_board_id
         FROM tasks WHERE board_id = ? AND id = ?`,
      )
      .get('board-1', 'P16.1') as {
      id: string;
      parent_task_id: string;
      assignee: string;
      child_exec_enabled: number;
      child_exec_board_id: string | null;
    };
    const parent = db
      .prepare(`SELECT subtasks FROM tasks WHERE board_id = ? AND id = ?`)
      .get('board-1', 'P16') as { subtasks: string | null };

    expect(columns.map((column) => column.name)).toContain('parent_task_id');
    expect(subtask).toEqual({
      id: 'P16.1',
      parent_task_id: 'P16',
      assignee: 'rafael',
      child_exec_enabled: 1,
      child_exec_board_id: 'board-rafael',
    });
    expect(parent.subtasks).toBeNull();

    db.close();
  });

  it('reconciles pre-existing subtask rows before clearing legacy JSON', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-db-test-'));
    tempDirs.push(tempDir);

    const dbPath = path.join(tempDir, 'taskflow.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (board_id, person_id));
      CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
      CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
      CREATE TABLE tasks (
        id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'simple',
        title TEXT NOT NULL,
        assignee TEXT,
        next_action TEXT,
        waiting_for TEXT,
        column TEXT DEFAULT 'inbox',
        priority TEXT,
        due_date TEXT,
        description TEXT,
        labels TEXT DEFAULT '[]',
        blocked_by TEXT DEFAULT '[]',
        reminders TEXT DEFAULT '[]',
        next_note_id INTEGER DEFAULT 1,
        notes TEXT DEFAULT '[]',
        _last_mutation TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        child_exec_enabled INTEGER DEFAULT 0,
        child_exec_board_id TEXT,
        child_exec_person_id TEXT,
        child_exec_rollup_status TEXT,
        child_exec_last_rollup_at TEXT,
        child_exec_last_rollup_summary TEXT,
        linked_parent_board_id TEXT,
        linked_parent_task_id TEXT,
        subtasks TEXT,
        recurrence TEXT,
        current_cycle TEXT,
        PRIMARY KEY (board_id, id)
      );
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
      CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza');
      CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
      CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
      INSERT INTO boards (id) VALUES ('board-1');
      INSERT INTO board_people (board_id, person_id, name) VALUES ('board-1', 'rafael', 'Rafael');
      INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES ('board-1', 'rafael', 'board-rafael');
      INSERT INTO board_config (board_id) VALUES ('board-1');
      INSERT INTO board_runtime_config (board_id) VALUES ('board-1');
      INSERT INTO tasks (id, board_id, type, title, assignee, column, subtasks, created_at, updated_at)
      VALUES (
        'P16',
        'board-1',
        'project',
        'Legacy project',
        'manager',
        'next_action',
        '[{"id":"P16.1","title":"Call Jimmy","column":"next_action","assignee":"rafael"}]',
        '2026-03-06T12:39:17Z',
        '2026-03-06T12:39:17Z'
      );
      INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
      VALUES ('P16.1', 'board-1', 'simple', 'Wrong title', NULL, 'inbox', '2026-03-06T12:39:17Z', '2026-03-06T12:39:17Z');
    `);
    legacyDb.close();

    const db = initTaskflowDb(dbPath);
    const subtask = db
      .prepare(
        `SELECT title, parent_task_id, assignee, child_exec_enabled, child_exec_board_id, "column"
         FROM tasks WHERE board_id = ? AND id = ?`,
      )
      .get('board-1', 'P16.1') as {
      title: string;
      parent_task_id: string;
      assignee: string | null;
      child_exec_enabled: number;
      child_exec_board_id: string | null;
      column: string;
    };
    const parent = db
      .prepare(`SELECT subtasks FROM tasks WHERE board_id = ? AND id = ?`)
      .get('board-1', 'P16') as { subtasks: string | null };

    expect(subtask).toEqual({
      title: 'Call Jimmy',
      parent_task_id: 'P16',
      assignee: 'rafael',
      child_exec_enabled: 1,
      child_exec_board_id: 'board-rafael',
      column: 'next_action',
    });
    expect(parent.subtasks).toBeNull();

    db.close();
  });

  it('reconciles pre-existing recurring tasks with child-board linkage', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-db-test-'));
    tempDirs.push(tempDir);

    const dbPath = path.join(tempDir, 'taskflow.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (board_id, person_id));
      CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
      CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
      CREATE TABLE tasks (
        id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'simple',
        title TEXT NOT NULL,
        assignee TEXT,
        next_action TEXT,
        waiting_for TEXT,
        column TEXT DEFAULT 'inbox',
        priority TEXT,
        due_date TEXT,
        description TEXT,
        labels TEXT DEFAULT '[]',
        blocked_by TEXT DEFAULT '[]',
        reminders TEXT DEFAULT '[]',
        next_note_id INTEGER DEFAULT 1,
        notes TEXT DEFAULT '[]',
        _last_mutation TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        child_exec_enabled INTEGER DEFAULT 0,
        child_exec_board_id TEXT,
        child_exec_person_id TEXT,
        child_exec_rollup_status TEXT,
        child_exec_last_rollup_at TEXT,
        child_exec_last_rollup_summary TEXT,
        linked_parent_board_id TEXT,
        linked_parent_task_id TEXT,
        subtasks TEXT,
        recurrence TEXT,
        current_cycle TEXT,
        PRIMARY KEY (board_id, id)
      );
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
      CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza');
      CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
      CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
      INSERT INTO boards (id) VALUES ('board-1');
      INSERT INTO board_people (board_id, person_id, name) VALUES ('board-1', 'rafael', 'Rafael');
      INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES ('board-1', 'rafael', 'board-rafael');
      INSERT INTO board_config (board_id) VALUES ('board-1');
      INSERT INTO board_runtime_config (board_id) VALUES ('board-1');
      INSERT INTO tasks (id, board_id, type, title, assignee, column, recurrence, child_exec_enabled, created_at, updated_at)
      VALUES (
        'R18',
        'board-1',
        'recurring',
        'Legacy recurring',
        'rafael',
        'next_action',
        'monthly',
        0,
        '2026-03-06T12:39:17Z',
        '2026-03-06T12:39:17Z'
      );
    `);
    legacyDb.close();

    const db = initTaskflowDb(dbPath);
    const task = db
      .prepare(
        `SELECT assignee, recurrence, child_exec_enabled, child_exec_board_id, child_exec_person_id
         FROM tasks WHERE board_id = ? AND id = ?`,
      )
      .get('board-1', 'R18') as {
      assignee: string | null;
      recurrence: string | null;
      child_exec_enabled: number;
      child_exec_board_id: string | null;
      child_exec_person_id: string | null;
    };

    expect(task).toEqual({
      assignee: 'rafael',
      recurrence: 'monthly',
      child_exec_enabled: 1,
      child_exec_board_id: 'board-rafael',
      child_exec_person_id: 'rafael',
    });

    db.close();
  });

  it('adds meeting columns (recurrence_anchor, participants, scheduled_at) to legacy tasks table', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-db-test-'));
    tempDirs.push(tempDir);

    const dbPath = path.join(tempDir, 'taskflow.db');
    const legacyDb = new Database(dbPath);
    // Legacy schema without meeting columns
    legacyDb.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (board_id, person_id));
      CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
      CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
      CREATE TABLE tasks (
        id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'simple',
        title TEXT NOT NULL,
        assignee TEXT,
        next_action TEXT,
        waiting_for TEXT,
        column TEXT DEFAULT 'inbox',
        priority TEXT,
        due_date TEXT,
        description TEXT,
        labels TEXT DEFAULT '[]',
        blocked_by TEXT DEFAULT '[]',
        reminders TEXT DEFAULT '[]',
        next_note_id INTEGER DEFAULT 1,
        notes TEXT DEFAULT '[]',
        _last_mutation TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        child_exec_enabled INTEGER DEFAULT 0,
        child_exec_board_id TEXT,
        child_exec_person_id TEXT,
        child_exec_rollup_status TEXT,
        child_exec_last_rollup_at TEXT,
        child_exec_last_rollup_summary TEXT,
        linked_parent_board_id TEXT,
        linked_parent_task_id TEXT,
        subtasks TEXT,
        recurrence TEXT,
        current_cycle TEXT,
        PRIMARY KEY (board_id, id)
      );
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
      CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza');
      CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
      CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
      INSERT INTO boards (id) VALUES ('board-1');
      INSERT INTO board_config (board_id) VALUES ('board-1');
      INSERT INTO board_runtime_config (board_id) VALUES ('board-1');
      INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at)
      VALUES ('T1', 'board-1', 'simple', 'Existing task', 'next_action', '2026-03-06T12:00:00Z', '2026-03-06T12:00:00Z');
    `);
    legacyDb.close();

    const db = initTaskflowDb(dbPath);
    const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('recurrence_anchor');
    expect(colNames).toContain('participants');
    expect(colNames).toContain('scheduled_at');

    // Verify existing data is intact and new columns are NULL
    const task = db
      .prepare(
        `SELECT title, recurrence_anchor, participants, scheduled_at FROM tasks WHERE board_id = ? AND id = ?`,
      )
      .get('board-1', 'T1') as {
      title: string;
      recurrence_anchor: string | null;
      participants: string | null;
      scheduled_at: string | null;
    };
    expect(task.title).toBe('Existing task');
    expect(task.recurrence_anchor).toBeNull();
    expect(task.participants).toBeNull();
    expect(task.scheduled_at).toBeNull();

    db.close();
  });
});
