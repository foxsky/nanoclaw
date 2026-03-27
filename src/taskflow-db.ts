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
  parent_board_id TEXT REFERENCES boards(id),
  short_code TEXT
);

CREATE TABLE IF NOT EXISTS board_people (
  board_id TEXT REFERENCES boards(id),
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT DEFAULT 'member',
  wip_limit INTEGER,
  notification_group_jid TEXT,
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

CREATE TABLE IF NOT EXISTS board_groups (
  board_id TEXT REFERENCES boards(id),
  group_jid TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  group_role TEXT DEFAULT 'team',
  PRIMARY KEY (board_id, group_jid)
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
  requires_close_approval INTEGER NOT NULL DEFAULT 1,
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
  parent_task_id TEXT,
  subtasks TEXT,
  recurrence TEXT,
  recurrence_anchor TEXT,
  current_cycle TEXT,
  max_cycles INTEGER,
  recurrence_end_date TEXT,
  participants TEXT,
  scheduled_at TEXT,
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
  attachment_max_size_bytes INTEGER DEFAULT 10485760,
  welcome_sent INTEGER DEFAULT 0,
  standup_target TEXT DEFAULT 'team',
  digest_target TEXT DEFAULT 'team',
  review_target TEXT DEFAULT 'team',
  runner_standup_secondary_task_id TEXT,
  runner_digest_secondary_task_id TEXT,
  runner_review_secondary_task_id TEXT,
  country TEXT,
  state TEXT,
  city TEXT
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

CREATE TABLE IF NOT EXISTS board_holidays (
  board_id TEXT NOT NULL,
  holiday_date TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (board_id, holiday_date)
);

CREATE TABLE IF NOT EXISTS board_config (
  board_id TEXT PRIMARY KEY REFERENCES boards(id),
  columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]',
  wip_limit INTEGER DEFAULT 5,
  next_task_number INTEGER DEFAULT 1,
  next_project_number INTEGER DEFAULT 1,
  next_recurring_number INTEGER DEFAULT 1,
  next_note_id INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS board_id_counters (
  board_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (board_id, prefix)
);

CREATE TABLE IF NOT EXISTS external_contacts (
  external_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  direct_chat_jid TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS meeting_external_participants (
  board_id TEXT NOT NULL,
  meeting_task_id TEXT NOT NULL,
  occurrence_scheduled_at TEXT NOT NULL,
  external_id TEXT NOT NULL,
  invite_status TEXT NOT NULL DEFAULT 'pending',
  invited_at TEXT,
  accepted_at TEXT,
  revoked_at TEXT,
  access_expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (board_id, meeting_task_id, occurrence_scheduled_at, external_id)
);
`;

function linkedChildBoardFor(
  db: Database.Database,
  boardId: string,
  personId: string | null,
): {
  child_exec_enabled: number;
  child_exec_board_id: string | null;
  child_exec_person_id: string | null;
} {
  if (!personId) {
    return {
      child_exec_enabled: 0,
      child_exec_board_id: null,
      child_exec_person_id: null,
    };
  }
  const row = db
    .prepare(
      `SELECT child_board_id FROM child_board_registrations
       WHERE parent_board_id = ? AND person_id = ?`,
    )
    .get(boardId, personId) as { child_board_id: string } | undefined;
  if (!row) {
    return {
      child_exec_enabled: 0,
      child_exec_board_id: null,
      child_exec_person_id: null,
    };
  }
  return {
    child_exec_enabled: 1,
    child_exec_board_id: row.child_board_id,
    child_exec_person_id: personId,
  };
}

function legacySubtaskColumn(subtask: {
  status?: string;
  column?: string;
}): string {
  if (typeof subtask.column === 'string' && subtask.column.trim() !== '') {
    return subtask.column;
  }
  return subtask.status === 'done' ? 'done' : 'next_action';
}

function migrateLegacyProjectSubtasks(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, board_id, assignee, priority, created_at, updated_at, subtasks
       FROM tasks
       WHERE type = 'project' AND subtasks IS NOT NULL AND subtasks != '' AND subtasks != '[]'`,
    )
    .all() as Array<{
    id: string;
    board_id: string;
    assignee: string | null;
    priority: string | null;
    created_at: string;
    updated_at: string;
    subtasks: string;
  }>;

  const subtaskRow = db.prepare(
    `SELECT id, title, assignee, "column", parent_task_id, priority,
            child_exec_enabled, child_exec_board_id, child_exec_person_id
       FROM tasks
      WHERE board_id = ? AND id = ?`,
  );
  const insertSubtask = db.prepare(
    `INSERT INTO tasks (
      id, board_id, type, title, assignee, column,
      parent_task_id, priority, labels,
      child_exec_enabled, child_exec_board_id, child_exec_person_id,
      _last_mutation, created_at, updated_at
    ) VALUES (?, ?, 'simple', ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
  );
  const reconcileSubtask = db.prepare(
    `UPDATE tasks
        SET title = ?, assignee = ?, "column" = ?, parent_task_id = ?, priority = ?,
            child_exec_enabled = ?, child_exec_board_id = ?, child_exec_person_id = ?
      WHERE board_id = ? AND id = ?`,
  );
  const clearLegacySubtasks = db.prepare(
    `UPDATE tasks SET subtasks = NULL WHERE board_id = ? AND id = ?`,
  );

  for (const row of rows) {
    let subtasks: any[];
    try {
      subtasks = JSON.parse(row.subtasks ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) continue;

    let allMigrated = true;
    for (let i = 0; i < subtasks.length; i++) {
      const subtask = subtasks[i] ?? {};
      const subtaskId =
        typeof subtask.id === 'string' && subtask.id.trim() !== ''
          ? subtask.id
          : `${row.id}.${i + 1}`;
      const title =
        typeof subtask.title === 'string' && subtask.title.trim() !== ''
          ? subtask.title
          : `Subtask ${i + 1}`;
      const assignee =
        typeof subtask.assignee === 'string' && subtask.assignee.trim() !== ''
          ? subtask.assignee
          : row.assignee;
      const column = legacySubtaskColumn(subtask);
      const childLink = linkedChildBoardFor(db, row.board_id, assignee ?? null);
      const existing = subtaskRow.get(row.board_id, subtaskId) as
        | {
            id: string;
            title: string;
            assignee: string | null;
            column: string;
            parent_task_id: string | null;
            priority: string | null;
            child_exec_enabled: number;
            child_exec_board_id: string | null;
            child_exec_person_id: string | null;
          }
        | undefined;

      if (!existing) {
        insertSubtask.run(
          subtaskId,
          row.board_id,
          title,
          assignee ?? null,
          column,
          row.id,
          row.priority ?? null,
          childLink.child_exec_enabled,
          childLink.child_exec_board_id,
          childLink.child_exec_person_id,
          null,
          row.created_at,
          row.updated_at,
        );
      } else {
        reconcileSubtask.run(
          title,
          assignee ?? null,
          column,
          row.id,
          row.priority ?? null,
          childLink.child_exec_enabled,
          childLink.child_exec_board_id,
          childLink.child_exec_person_id,
          row.board_id,
          subtaskId,
        );
      }
    }

    for (let i = 0; i < subtasks.length; i++) {
      const subtask = subtasks[i] ?? {};
      const subtaskId =
        typeof subtask.id === 'string' && subtask.id.trim() !== ''
          ? subtask.id
          : `${row.id}.${i + 1}`;
      const assignee =
        typeof subtask.assignee === 'string' && subtask.assignee.trim() !== ''
          ? subtask.assignee
          : row.assignee;
      const expectedColumn = legacySubtaskColumn(subtask);
      const expectedChildLink = linkedChildBoardFor(
        db,
        row.board_id,
        assignee ?? null,
      );
      const existing = subtaskRow.get(row.board_id, subtaskId) as
        | {
            title: string;
            assignee: string | null;
            column: string;
            parent_task_id: string | null;
            priority: string | null;
            child_exec_enabled: number;
            child_exec_board_id: string | null;
            child_exec_person_id: string | null;
          }
        | undefined;
      if (
        !existing ||
        existing.parent_task_id !== row.id ||
        existing.assignee !== (assignee ?? null) ||
        existing.column !== expectedColumn ||
        existing.child_exec_enabled !== expectedChildLink.child_exec_enabled ||
        (existing.child_exec_board_id ?? null) !==
          expectedChildLink.child_exec_board_id ||
        (existing.child_exec_person_id ?? null) !==
          expectedChildLink.child_exec_person_id
      ) {
        allMigrated = false;
        break;
      }
    }

    if (allMigrated) {
      clearLegacySubtasks.run(row.board_id, row.id);
    }
  }
}

function reconcileDelegationLinks(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, board_id, assignee, child_exec_enabled, child_exec_board_id, child_exec_person_id
         FROM tasks
        WHERE assignee IS NOT NULL
          AND (
            parent_task_id IS NOT NULL
            OR recurrence IS NOT NULL
          )`,
    )
    .all() as Array<{
    id: string;
    board_id: string;
    assignee: string | null;
    child_exec_enabled: number;
    child_exec_board_id: string | null;
    child_exec_person_id: string | null;
  }>;

  const update = db.prepare(
    `UPDATE tasks
        SET child_exec_enabled = ?, child_exec_board_id = ?, child_exec_person_id = ?
      WHERE board_id = ? AND id = ?`,
  );

  for (const row of rows) {
    const expected = linkedChildBoardFor(
      db,
      row.board_id,
      row.assignee ?? null,
    );
    if (
      row.child_exec_enabled !== expected.child_exec_enabled ||
      (row.child_exec_board_id ?? null) !== expected.child_exec_board_id ||
      (row.child_exec_person_id ?? null) !== expected.child_exec_person_id
    ) {
      update.run(
        expected.child_exec_enabled,
        expected.child_exec_board_id,
        expected.child_exec_person_id,
        row.board_id,
        row.id,
      );
    }
  }
}

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
  const taskColumns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
    name: string;
  }>;
  const hasRequiresCloseApproval = taskColumns.some(
    (column) => column.name === 'requires_close_approval',
  );
  try {
    db.exec(`ALTER TABLE board_people ADD COLUMN notification_group_jid TEXT`);
  } catch {
    // Existing DBs may already have the column.
  }
  if (!hasRequiresCloseApproval) {
    try {
      db.exec(
        'ALTER TABLE tasks ADD COLUMN requires_close_approval INTEGER NOT NULL DEFAULT 1',
      );
    } catch {}
    db.exec(`
      UPDATE tasks
         SET requires_close_approval = 0
       WHERE assignee IS NULL
    `);
  }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`);
  } catch {
    // Existing DBs may already have the column.
  }
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN max_cycles INTEGER');
  } catch {}
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN recurrence_end_date TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN recurrence_anchor TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN participants TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN scheduled_at TEXT');
  } catch {}
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(board_id, parent_task_id) WHERE parent_task_id IS NOT NULL`,
  );
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN linked_parent_board_id TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN linked_parent_task_id TEXT');
  } catch {}
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_linked_parent ON tasks(board_id, linked_parent_board_id, linked_parent_task_id) WHERE linked_parent_board_id IS NOT NULL AND linked_parent_task_id IS NOT NULL`,
  );

  /* --- Performance indexes for task_history and archive queries --- */
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_task_history_board_task ON task_history(board_id, task_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_task_history_board_at ON task_history(board_id, at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_archive_board_assignee ON archive(board_id, assignee)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_archive_board_archived_at ON archive(board_id, archived_at)`,
  );

  /* --- board_holidays table (migration for existing DBs) --- */
  db.exec(`CREATE TABLE IF NOT EXISTS board_holidays (
    board_id TEXT NOT NULL, holiday_date TEXT NOT NULL, label TEXT,
    PRIMARY KEY (board_id, holiday_date)
  )`);
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN short_code TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE board_runtime_config ADD COLUMN country TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE board_runtime_config ADD COLUMN state TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE board_runtime_config ADD COLUMN city TEXT`);
  } catch {}

  /* --- Per-prefix counters (P, T, R) --- */
  try {
    db.exec(
      'ALTER TABLE board_config ADD COLUMN next_project_number INTEGER DEFAULT 1',
    );
  } catch {}
  try {
    db.exec(
      'ALTER TABLE board_config ADD COLUMN next_recurring_number INTEGER DEFAULT 1',
    );
  } catch {}
  // Seed new counters from existing task IDs (one-time migration).
  // Split into two independent statements so one counter's default doesn't
  // trigger a regression of the other counter (e.g., deleted P-tasks causing
  // next_project_number to regress when only next_recurring_number = 1).
  db.exec(`
    UPDATE board_config SET
      next_project_number = COALESCE((
        SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) + 1
        FROM tasks WHERE tasks.board_id = board_config.board_id AND id GLOB 'P[0-9]*' AND id NOT GLOB 'P*.*'
      ), next_project_number)
    WHERE next_project_number = 1
  `);
  db.exec(`
    UPDATE board_config SET
      next_recurring_number = COALESCE((
        SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) + 1
        FROM tasks WHERE tasks.board_id = board_config.board_id AND id GLOB 'R[0-9]*'
      ), next_recurring_number)
    WHERE next_recurring_number = 1
  `);
  migrateLegacyProjectSubtasks(db);
  reconcileDelegationLinks(db);

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

/**
 * Resolve the TaskFlow board ID from the database.
 * The group folder (e.g. "sec-secti") is not the board ID — we need to look up
 * the actual board ID (e.g. "board-sec-taskflow") from the boards table.
 */
export function resolveTaskflowBoardId(
  groupFolder: string,
  taskflowManaged: boolean,
  explicitBoardId?: string,
): string | undefined {
  if (explicitBoardId) return explicitBoardId;
  if (!taskflowManaged) return undefined;

  const dbPath = path.join(DATA_DIR, 'taskflow', 'taskflow.db');
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');

    const direct = db
      .prepare(`SELECT id FROM boards WHERE group_folder = ? LIMIT 1`)
      .get(groupFolder) as { id: string } | undefined;
    if (direct?.id) {
      return direct.id;
    }

    const mapped = db
      .prepare(
        `SELECT board_id FROM board_groups WHERE group_folder = ? LIMIT 1`,
      )
      .get(groupFolder) as { board_id: string } | undefined;
    return mapped?.board_id;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
