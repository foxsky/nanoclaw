/** Shared in-memory TaskFlow DB factory for MCP-tool tests. Mirrors v1's
 *  `createEngineDb` factory: explicit base schema (boards, board_people,
 *  board_id_counters, tasks, task_history, archive,
 *  child_board_registrations) seeded with one board + one manager; then
 *  the engine constructor runs to ensure the rest of the schema. */
import type { Database } from 'bun:sqlite';
import { initTestTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';

export interface SetupEngineDbOptions {
  /** Add a `board_admins` table + seed alice as 'manager'. Required for
   *  engine.isManager() to return true (note tools, dispatch flows). */
  withBoardAdmins?: boolean;
}

export function setupEngineDb(boardId: string, opts: SetupEngineDbOptions = {}): Database {
  const d = initTestTaskflowDb();
  d.exec('PRAGMA journal_mode = WAL');
  d.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, short_code TEXT, name TEXT NOT NULL DEFAULT '',
      board_role TEXT NOT NULL DEFAULT 'hierarchy',
      group_folder TEXT NOT NULL DEFAULT '',
      group_jid TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE board_people (
      board_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      notification_group_jid TEXT,
      wip_limit INTEGER,
      PRIMARY KEY (board_id, person_id)
    );
    CREATE TABLE board_runtime_config (
      board_id TEXT PRIMARY KEY,
      language TEXT NOT NULL DEFAULT 'pt-BR',
      timezone TEXT NOT NULL DEFAULT 'America/Fortaleza'
    );
    CREATE TABLE board_id_counters (
      board_id TEXT NOT NULL, prefix TEXT NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (board_id, prefix)
    );
    CREATE TABLE tasks (
      id TEXT NOT NULL, board_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'simple', title TEXT NOT NULL,
      assignee TEXT, next_action TEXT, waiting_for TEXT,
      column TEXT DEFAULT 'inbox', priority TEXT, due_date TEXT,
      description TEXT, labels TEXT DEFAULT '[]',
      blocked_by TEXT DEFAULT '[]', reminders TEXT DEFAULT '[]',
      next_note_id INTEGER DEFAULT 1, notes TEXT DEFAULT '[]',
      _last_mutation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      child_exec_enabled INTEGER DEFAULT 0,
      child_exec_board_id TEXT, child_exec_person_id TEXT,
      child_exec_rollup_status TEXT, child_exec_last_rollup_at TEXT,
      child_exec_last_rollup_summary TEXT,
      linked_parent_board_id TEXT, linked_parent_task_id TEXT,
      subtasks TEXT, recurrence TEXT, current_cycle TEXT,
      parent_task_id TEXT, max_cycles INTEGER,
      recurrence_end_date TEXT, recurrence_anchor TEXT,
      participants TEXT, scheduled_at TEXT,
      requires_close_approval INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      PRIMARY KEY (board_id, id)
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL, task_id TEXT NOT NULL,
      action TEXT NOT NULL, "by" TEXT,
      "at" TEXT NOT NULL, details TEXT, trigger_turn_id TEXT
    );
    CREATE TABLE child_board_registrations (
      parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT,
      PRIMARY KEY (parent_board_id, person_id)
    );
    CREATE TABLE archive (
      board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL,
      linked_parent_board_id TEXT, linked_parent_task_id TEXT,
      archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT,
      PRIMARY KEY (board_id, task_id)
    );
  `);
  if (opts.withBoardAdmins) {
    d.exec(`
      CREATE TABLE board_admins (
        board_id TEXT NOT NULL, person_id TEXT NOT NULL,
        phone TEXT, admin_role TEXT NOT NULL,
        PRIMARY KEY (board_id, person_id, admin_role)
      );
    `);
  }
  d.prepare(`INSERT INTO boards (id, short_code, name) VALUES (?, 'TF', 'Test Board')`).run(boardId);
  d.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'alice', 'alice', 'manager')`,
  ).run(boardId);
  if (opts.withBoardAdmins) {
    d.prepare(
      `INSERT INTO board_admins (board_id, person_id, admin_role) VALUES (?, 'alice', 'manager')`,
    ).run(boardId);
  }
  d.prepare(`INSERT INTO board_id_counters (board_id, prefix, next_number) VALUES (?, 'T', 1)`).run(
    boardId,
  );
  new TaskflowEngine(d, boardId);
  return d;
}
