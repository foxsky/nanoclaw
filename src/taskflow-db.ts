/**
 * TaskFlow Database Initialization
 *
 * Creates and seeds data/taskflow/taskflow.db with the TaskFlow schema.
 * Uses better-sqlite3 (already a host dependency).
 *
 * Called by the /add-taskflow SKILL.md wizard during setup.
 * CLI usage: node dist/taskflow-db.js [dbPath]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

const TASKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  group_jid TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  board_role TEXT DEFAULT 'standard',
  hierarchy_level INTEGER,
  max_depth INTEGER,
  parent_board_id TEXT REFERENCES boards(id)
);

CREATE TABLE IF NOT EXISTS board_people (
  board_id TEXT REFERENCES boards(id),
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT DEFAULT 'member',
  wip_limit INTEGER,
  PRIMARY KEY (board_id, person_id)
);

CREATE TABLE IF NOT EXISTS board_admins (
  board_id TEXT REFERENCES boards(id),
  person_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  admin_role TEXT NOT NULL,
  is_primary_manager INTEGER DEFAULT 0,
  PRIMARY KEY (board_id, person_id, admin_role)
);

CREATE TABLE IF NOT EXISTS child_board_registrations (
  parent_board_id TEXT REFERENCES boards(id),
  person_id TEXT NOT NULL,
  child_board_id TEXT REFERENCES boards(id),
  PRIMARY KEY (parent_board_id, person_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  board_id TEXT NOT NULL REFERENCES boards(id),
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

CREATE TABLE IF NOT EXISTS task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  by TEXT,
  at TEXT NOT NULL,
  details TEXT
);

CREATE TABLE IF NOT EXISTS archive (
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  assignee TEXT,
  archive_reason TEXT NOT NULL,
  linked_parent_board_id TEXT,
  linked_parent_task_id TEXT,
  archived_at TEXT NOT NULL,
  task_snapshot TEXT NOT NULL,
  history TEXT,
  PRIMARY KEY (board_id, task_id)
);

CREATE TABLE IF NOT EXISTS board_runtime_config (
  board_id TEXT PRIMARY KEY REFERENCES boards(id),
  language TEXT NOT NULL DEFAULT 'pt-BR',
  timezone TEXT NOT NULL DEFAULT 'America/Fortaleza',
  runner_standup_task_id TEXT,
  runner_digest_task_id TEXT,
  runner_review_task_id TEXT,
  runner_dst_guard_task_id TEXT,
  standup_cron_local TEXT,
  digest_cron_local TEXT,
  review_cron_local TEXT,
  standup_cron_utc TEXT,
  digest_cron_utc TEXT,
  review_cron_utc TEXT,
  dst_sync_enabled INTEGER DEFAULT 0,
  dst_last_offset_minutes INTEGER,
  dst_last_synced_at TEXT,
  dst_resync_count_24h INTEGER DEFAULT 0,
  dst_resync_window_started_at TEXT,
  attachment_enabled INTEGER DEFAULT 1,
  attachment_disabled_reason TEXT DEFAULT '',
  attachment_allowed_formats TEXT DEFAULT '["pdf","jpg","png"]',
  attachment_max_size_bytes INTEGER DEFAULT 10485760
);

CREATE TABLE IF NOT EXISTS attachment_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id),
  source TEXT NOT NULL,
  filename TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_person_id TEXT,
  affected_task_refs TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS board_config (
  board_id TEXT PRIMARY KEY REFERENCES boards(id),
  columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]',
  wip_limit INTEGER DEFAULT 5,
  next_task_number INTEGER DEFAULT 1,
  next_note_id INTEGER DEFAULT 1
);
`;

/**
 * Initialize the TaskFlow database at the given path (or default location).
 * Creates the directory, database file, enables WAL mode, and creates all tables.
 * Idempotent — safe to call multiple times.
 */
export function initTaskflowDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.join(DATA_DIR, 'taskflow', 'taskflow.db');
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(TASKFLOW_SCHEMA);

  return db;
}

// CLI entry point: node dist/taskflow-db.js [dbPath]
const isMain = process.argv[1]?.endsWith('taskflow-db.js');
if (isMain) {
  const dbPath = process.argv[2];
  const db = initTaskflowDb(dbPath);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  console.log(
    `TaskFlow DB initialized at ${dbPath ?? path.join(DATA_DIR, 'taskflow', 'taskflow.db')}`,
  );
  console.log(`Tables: ${tables.map((t) => t.name).join(', ')}`);
  db.close();
}
