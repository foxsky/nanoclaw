import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskflowEngine, maskPhoneForDisplay, normalizePhone } from './taskflow-engine.js';

const BOARD_ID = 'board-test-001';

const SCHEMA = `
CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, board_role TEXT DEFAULT 'standard', hierarchy_level INTEGER, max_depth INTEGER, parent_board_id TEXT, short_code TEXT);
ALTER TABLE boards ADD COLUMN owner_person_id TEXT;
CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, role TEXT DEFAULT 'member', wip_limit INTEGER, notification_group_jid TEXT, PRIMARY KEY (board_id, person_id));
CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
CREATE TABLE tasks (id TEXT NOT NULL, board_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'simple', title TEXT NOT NULL, assignee TEXT, next_action TEXT, waiting_for TEXT, column TEXT DEFAULT 'inbox', priority TEXT, requires_close_approval INTEGER NOT NULL DEFAULT 1, due_date TEXT, description TEXT, labels TEXT DEFAULT '[]', blocked_by TEXT DEFAULT '[]', reminders TEXT DEFAULT '[]', next_note_id INTEGER DEFAULT 1, notes TEXT DEFAULT '[]', _last_mutation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, child_exec_enabled INTEGER DEFAULT 0, child_exec_board_id TEXT, child_exec_person_id TEXT, child_exec_rollup_status TEXT, child_exec_last_rollup_at TEXT, child_exec_last_rollup_summary TEXT, linked_parent_board_id TEXT, linked_parent_task_id TEXT, parent_task_id TEXT, subtasks TEXT, recurrence TEXT, current_cycle TEXT, max_cycles INTEGER, recurrence_end_date TEXT, participants TEXT, scheduled_at TEXT, PRIMARY KEY (board_id, id));
CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza', runner_standup_task_id TEXT, runner_digest_task_id TEXT, runner_review_task_id TEXT, runner_dst_guard_task_id TEXT, standup_cron_local TEXT, digest_cron_local TEXT, review_cron_local TEXT, standup_cron_utc TEXT, digest_cron_utc TEXT, review_cron_utc TEXT, dst_sync_enabled INTEGER DEFAULT 0, dst_last_offset_minutes INTEGER, dst_last_synced_at TEXT, dst_resync_count_24h INTEGER DEFAULT 0, dst_resync_window_started_at TEXT, attachment_enabled INTEGER DEFAULT 1, attachment_disabled_reason TEXT DEFAULT '', attachment_allowed_formats TEXT DEFAULT '["pdf","jpg","png"]', attachment_max_size_bytes INTEGER DEFAULT 10485760, welcome_sent INTEGER DEFAULT 0, standup_target TEXT DEFAULT 'team', digest_target TEXT DEFAULT 'team', review_target TEXT DEFAULT 'team', runner_standup_secondary_task_id TEXT, runner_digest_secondary_task_id TEXT, runner_review_secondary_task_id TEXT);
CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_project_number INTEGER DEFAULT 1, next_recurring_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
`;

function seedTestDb(db: Database.Database, boardId: string) {
  db.exec(SCHEMA);

  db.exec(
    `INSERT INTO boards VALUES ('${boardId}', 'test@g.us', 'test', 'standard', 0, 1, NULL, NULL, NULL)`,
  );
  db.exec(
    `INSERT INTO board_config VALUES ('${boardId}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 4, 1, 1, 1)`,
  );
  db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${boardId}')`);
  db.exec(
    `INSERT INTO board_admins VALUES ('${boardId}', 'person-1', '5585999990001', 'manager', 1)`,
  );
  db.exec(
    `INSERT INTO board_people VALUES ('${boardId}', 'person-1', 'Alexandre', '5585999990001', 'Gestor', 3, NULL)`,
  );
  db.exec(
    `INSERT INTO board_people VALUES ('${boardId}', 'person-2', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`,
  );

  const now = new Date().toISOString();
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, assignee, column, priority, requires_close_approval, created_at, updated_at)
     VALUES ('T-001', '${boardId}', 'simple', 'Fix login bug', 'person-1', 'in_progress', 'high', 0, '${now}', '${now}')`,
  );
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
     VALUES ('T-002', '${boardId}', 'simple', 'Update docs', 'person-2', 'next_action', 0, '${now}', '${now}')`,
  );
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at)
     VALUES ('T-003', '${boardId}', 'simple', 'Review PR', 'inbox', '${now}', '${now}')`,
  );
}

function seedChildBoard(
  db: Database.Database,
  opts: {
    parentBoardId: string;
    childBoardId: string;
    personId: string;
    name: string;
  },
) {
  db.exec(
    `INSERT INTO boards VALUES ('${opts.childBoardId}', '${opts.childBoardId}@g.us', '${opts.childBoardId}', 'standard', 1, 1, '${opts.parentBoardId}', NULL, NULL)`,
  );
  db.exec(
    `INSERT INTO board_config VALUES ('${opts.childBoardId}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 1, 1, 1, 1)`,
  );
  db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${opts.childBoardId}')`);
  db.exec(
    `INSERT INTO board_people VALUES ('${opts.childBoardId}', '${opts.personId}', '${opts.name}', NULL, 'Dev', 3, NULL)`,
  );
  db.exec(
    `INSERT INTO board_admins VALUES ('${opts.childBoardId}', '${opts.personId}', '5585999990009', 'manager', 1)`,
  );
}

function seedLinkedTask(
  db: Database.Database,
  visibleBoardId: string,
  overrides?: Partial<{
    ownerBoardId: string;
    taskId: string;
    assignee: string;
    column: string;
    title: string;
  }>,
) {
  const ownerBoardId = overrides?.ownerBoardId ?? 'board-parent';
  const taskId = overrides?.taskId ?? 'T-900';
  const assignee = overrides?.assignee ?? 'person-2';
  const column = overrides?.column ?? 'next_action';
  const title = overrides?.title ?? 'Linked task';
  const now = new Date().toISOString();

  db.exec(
    `INSERT INTO boards VALUES ('${ownerBoardId}', 'parent@g.us', 'parent-group', 'standard', 0, 1, NULL, NULL, NULL)`,
  );
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
     VALUES ('${taskId}', '${ownerBoardId}', 'simple', '${title}', '${assignee}', '${column}', 1, 1, '${visibleBoardId}', '${assignee}', '${now}', '${now}')`,
  );

  return { ownerBoardId, taskId };
}

describe('TaskflowEngine', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, BOARD_ID);
    engine = new TaskflowEngine(db, BOARD_ID);
  });

  afterEach(() => {
    db.close();
  });

  /* ---------------------------------------------------------------- */
  /*  resolvePerson                                                    */
  /* ---------------------------------------------------------------- */

  describe('resolvePerson', () => {
    it('finds a person by exact name', () => {
      const p = engine.resolvePerson('Alexandre');
      expect(p).toEqual({ person_id: 'person-1', name: 'Alexandre' });
    });

    it('finds a person case-insensitively', () => {
      const p = engine.resolvePerson('giovanni');
      expect(p).toEqual({ person_id: 'person-2', name: 'Giovanni' });
    });

    it('returns null for unknown name', () => {
      expect(engine.resolvePerson('Nobody')).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  getTask                                                          */
  /* ---------------------------------------------------------------- */

  describe('getTask', () => {
    it('returns a task by id', () => {
      const t = engine.getTask('T-001');
      expect(t).toBeTruthy();
      expect(t.title).toBe('Fix login bug');
    });

    it('returns null for missing task', () => {
      expect(engine.getTask('T-999')).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: board                                                     */
  /* ---------------------------------------------------------------- */

  describe('query: board', () => {
    it('returns tasks grouped by column', () => {
      const result = engine.query({ query: 'board' });
      expect(result.success).toBe(true);
      const cols = result.data.columns;
      expect(cols.in_progress).toHaveLength(1);
      expect(cols.in_progress[0].id).toBe('T-001');
      expect(cols.next_action).toHaveLength(1);
      expect(cols.inbox).toHaveLength(1);
    });

    it('includes linked_tasks key (even if empty)', () => {
      const result = engine.query({ query: 'board' });
      expect(result.data.linked_tasks).toEqual([]);
    });

    it('includes linked tasks in the visible board columns and linked_tasks list', () => {
      seedLinkedTask(db, BOARD_ID, { taskId: 'T-901', column: 'next_action' });

      const result = engine.query({ query: 'board' });
      expect(result.success).toBe(true);
      expect(result.data.columns.next_action.some((t: any) => t.id === 'T-901')).toBe(true);
      expect(result.data.linked_tasks.some((t: any) => t.id === 'T-901')).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: column views                                              */
  /* ---------------------------------------------------------------- */

  describe('query: column views', () => {
    it('inbox returns inbox tasks', () => {
      const r = engine.query({ query: 'inbox' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-003');
    });

    it('in_progress returns in_progress tasks', () => {
      const r = engine.query({ query: 'in_progress' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-001');
    });

    it('next_action returns next_action tasks', () => {
      const r = engine.query({ query: 'next_action' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-002');
    });

    it('waiting returns empty when no waiting tasks', () => {
      const r = engine.query({ query: 'waiting' });
      expect(r.data).toHaveLength(0);
    });

    it('review returns empty when no review tasks', () => {
      const r = engine.query({ query: 'review' });
      expect(r.data).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: person_tasks                                              */
  /* ---------------------------------------------------------------- */

  describe('query: person_tasks', () => {
    it('returns all tasks for a named person', () => {
      const r = engine.query({ query: 'person_tasks', person_name: 'Alexandre' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-001');
    });

    it('errors for unknown person', () => {
      const r = engine.query({ query: 'person_tasks', person_name: 'Unknown' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Person not found/);
    });

    it('errors when person_name is missing', () => {
      const r = engine.query({ query: 'person_tasks' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Missing required parameter/);
    });

    it('includes linked tasks assigned to that person in the current board scope', () => {
      seedLinkedTask(db, BOARD_ID, { taskId: 'T-902', assignee: 'person-1' });

      const r = engine.query({ query: 'person_tasks', person_name: 'Alexandre' });
      expect(r.success).toBe(true);
      expect(r.data.some((t: any) => t.id === 'T-902')).toBe(true);
    });

    it('includes parent_title for subtasks with parent_task_id', () => {
      const now = new Date().toISOString();
      // Create a parent project
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES ('P-100', '${BOARD_ID}', 'project', 'My Project', 'person-1', 'next_action', 0, '${now}', '${now}')`,
      );
      // Create a subtask under that project
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, parent_task_id, created_at, updated_at)
         VALUES ('P-100.1', '${BOARD_ID}', 'simple', 'Subtask A', 'person-1', 'next_action', 0, 'P-100', '${now}', '${now}')`,
      );

      const r = engine.query({ query: 'person_tasks', person_name: 'Alexandre' });
      expect(r.success).toBe(true);
      const subtask = r.data.find((t: any) => t.id === 'P-100.1');
      expect(subtask).toBeDefined();
      expect(subtask.parent_task_id).toBe('P-100');
      expect(subtask.parent_title).toBe('My Project');

      // Top-level tasks should have null parent_title
      const topLevel = r.data.find((t: any) => t.id === 'T-001');
      expect(topLevel).toBeDefined();
      expect(topLevel.parent_title).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: my_tasks                                                  */
  /* ---------------------------------------------------------------- */

  describe('query: my_tasks', () => {
    it('returns tasks for sender_name', () => {
      const r = engine.query({ query: 'my_tasks', sender_name: 'Giovanni' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-002');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: task_details                                              */
  /* ---------------------------------------------------------------- */

  describe('query: task_details', () => {
    it('returns task with recent history', () => {
      // Insert some history entries
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-001', 'created', 'person-1', '${now}', 'task created')`,
      );
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-001', 'moved', 'person-1', '${now}', 'inbox -> in_progress')`,
      );

      const r = engine.query({ query: 'task_details', task_id: 'T-001' });
      expect(r.success).toBe(true);
      expect(r.data.task.title).toBe('Fix login bug');
      expect(r.data.recent_history).toHaveLength(2);
    });

    it('errors for unknown task_id', () => {
      const r = engine.query({ query: 'task_details', task_id: 'T-999' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Task not found/);
    });

    it('errors when task_id is missing', () => {
      const r = engine.query({ query: 'task_details' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Missing required parameter/);
    });

    it('loads linked-task history from the owning board', () => {
      const { ownerBoardId, taskId } = seedLinkedTask(db, BOARD_ID, { taskId: 'T-903' });
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${ownerBoardId}', '${taskId}', 'moved', 'person-2', '${now}', 'linked history')`,
      );

      const r = engine.query({ query: 'task_details', task_id: taskId });
      expect(r.success).toBe(true);
      expect(r.data.task.id).toBe(taskId);
      expect(r.data.recent_history).toHaveLength(1);
      expect(r.data.recent_history[0].board_id).toBe(ownerBoardId);
    });

    it('orders project subtasks numerically (not lexicographically) when there are 10+', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES ('P-500', '${BOARD_ID}', 'project', 'Big Project', 'person-1', 'next_action', 0, '${now}', '${now}')`,
      );
      // Insert subtasks in reverse order to guard against "happens to be insert order" passes.
      for (let i = 12; i >= 1; i--) {
        db.exec(
          `INSERT INTO tasks (id, board_id, type, title, column, requires_close_approval, parent_task_id, created_at, updated_at)
           VALUES ('P-500.${i}', '${BOARD_ID}', 'simple', 'Sub ${i}', 'next_action', 0, 'P-500', '${now}', '${now}')`,
        );
      }

      const r = engine.query({ query: 'task_details', task_id: 'P-500' });
      expect(r.success).toBe(true);
      const ids = r.data.subtask_rows.map((s: any) => s.id);
      // Lexicographic order would yield: P-500.1, P-500.10, P-500.11, P-500.12, P-500.2, ...
      // Numeric order must yield: P-500.1, P-500.2, ..., P-500.12.
      expect(ids).toEqual([
        'P-500.1', 'P-500.2', 'P-500.3', 'P-500.4', 'P-500.5', 'P-500.6',
        'P-500.7', 'P-500.8', 'P-500.9', 'P-500.10', 'P-500.11', 'P-500.12',
      ]);
    });

    it('handles legacy subtasks without {parent}.{N} suffix safely', () => {
      // Production has rows whose `parent_task_id` was reassigned without
      // renaming the task ID — e.g. `M1` (meeting) or `T84` (simple task)
      // linked under project P11, or `P10.1` (originally a subtask of P10)
      // reparented under P11. These are pre-existing data-integrity issues
      // unrelated to the ordering bug being fixed here; the query must not
      // throw on them, and canonical subtasks must still sort numerically.
      //
      // CAST(SUBSTR(id, LENGTH(parent)+2) AS INTEGER) uses the character
      // AFTER parent-length+dot. For M1/T42 (id shorter than the offset)
      // SUBSTR is empty → CAST=0. For P-600.3 under parent P-700 (same-
      // length prefix), SUBSTR yields '3' → CAST=3, so it interleaves
      // with canonical P-700.3 by lex tiebreak. This is strictly no worse
      // than pre-fix lex ordering, and the canonical case is fixed.
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES ('P-700', '${BOARD_ID}', 'project', 'Mixed legacy parents', 'person-1', 'next_action', 0, '${now}', '${now}')`,
      );
      const ids = [
        'P-700.11', 'P-700.2', 'P-700.1', // canonical, inserted out of order
        'M9',                              // meeting linked as child of P-700
        'T42',                             // simple task linked as child of P-700
        'P-600.3',                         // reparented subtask (same-length prefix)
      ];
      for (const id of ids) {
        db.exec(
          `INSERT INTO tasks (id, board_id, type, title, column, requires_close_approval, parent_task_id, created_at, updated_at)
           VALUES ('${id}', '${BOARD_ID}', 'simple', 'Sub ${id}', 'next_action', 0, 'P-700', '${now}', '${now}')`,
        );
      }

      const r = engine.query({ query: 'task_details', task_id: 'P-700' });
      expect(r.success).toBe(true);
      const orderedIds = r.data.subtask_rows.map((s: any) => s.id);
      // Sort keys: M9=0, T42=0, P-700.1=1, P-700.2=2, P-600.3=3, P-700.11=11.
      // Ties tie-break by t.id (lex).
      expect(orderedIds).toEqual([
        'M9', 'T42',             // CAST=0 cluster, lex tiebreak
        'P-700.1',               // CAST=1
        'P-700.2',               // CAST=2
        'P-600.3',               // CAST=3 (foreign-parent with numeric suffix)
        'P-700.11',              // CAST=11
      ]);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: task_history                                              */
  /* ---------------------------------------------------------------- */

  describe('query: task_history', () => {
    it('returns full history for a task', () => {
      const now = new Date().toISOString();
      for (let i = 0; i < 8; i++) {
        db.exec(
          `INSERT INTO task_history (board_id, task_id, action, by, at)
           VALUES ('${BOARD_ID}', 'T-002', 'action-${i}', 'person-2', '${now}')`,
        );
      }
      const r = engine.query({ query: 'task_history', task_id: 'T-002' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(8);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: overdue                                                   */
  /* ---------------------------------------------------------------- */

  describe('query: overdue', () => {
    it('returns tasks with past due_date', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.toISOString().slice(0, 10);
      db.exec(
        `UPDATE tasks SET due_date = '${yStr}' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.query({ query: 'overdue' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-001');
    });

    it('excludes tasks in done column', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.toISOString().slice(0, 10);
      db.exec(
        `UPDATE tasks SET due_date = '${yStr}', column = 'done'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.query({ query: 'overdue' });
      expect(r.data).toHaveLength(0);
    });

    it('returns empty when no tasks are overdue', () => {
      const r = engine.query({ query: 'overdue' });
      expect(r.data).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: due_today / due_tomorrow                                  */
  /* ---------------------------------------------------------------- */

  describe('query: due_today', () => {
    it('finds tasks due today', () => {
      const t = new Date().toISOString().slice(0, 10);
      db.exec(
        `UPDATE tasks SET due_date = '${t}' WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );
      const r = engine.query({ query: 'due_today' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-002');
    });
  });

  describe('query: due_tomorrow', () => {
    it('finds tasks due tomorrow', () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const tStr = d.toISOString().slice(0, 10);
      db.exec(
        `UPDATE tasks SET due_date = '${tStr}' WHERE board_id = '${BOARD_ID}' AND id = 'T-003'`,
      );
      const r = engine.query({ query: 'due_tomorrow' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-003');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: search                                                    */
  /* ---------------------------------------------------------------- */

  describe('query: search', () => {
    it('matches on title', () => {
      const r = engine.query({ query: 'search', search_text: 'login' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-001');
    });

    it('matches on description', () => {
      db.exec(
        `UPDATE tasks SET description = 'This relates to the auth system'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );
      const r = engine.query({ query: 'search', search_text: 'auth' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-002');
    });

    it('returns empty for no matches', () => {
      const r = engine.query({ query: 'search', search_text: 'zzzzz' });
      expect(r.data).toHaveLength(0);
    });

    it('errors when search_text is missing', () => {
      const r = engine.query({ query: 'search' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/search_text/);
    });

    it('resolves raw task ID as search_text', () => {
      const r = engine.query({ query: 'search', search_text: 'T-001' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-001');
    });

    it('resolves prefixed task ID as search_text on delegated task', () => {
      seedLinkedTask(db, BOARD_ID, {
        ownerBoardId: 'board-parent-search',
        taskId: 'T-050',
        assignee: 'person-2',
        column: 'in_progress',
        title: 'Prefixed search target',
      });
      db.exec(`UPDATE boards SET short_code = 'PAR' WHERE id = 'board-parent-search'`);

      const r = engine.query({ query: 'search', search_text: 'PAR-T-050' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-050');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: priority filters                                          */
  /* ---------------------------------------------------------------- */

  describe('query: urgent / high_priority', () => {
    it('urgent returns only urgent tasks', () => {
      db.exec(
        `UPDATE tasks SET priority = 'urgent'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-003'`,
      );
      const r = engine.query({ query: 'urgent' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-003');
    });

    it('high_priority returns urgent + high tasks', () => {
      const r = engine.query({ query: 'high_priority' });
      // T-001 has priority='high'
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-001');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: by_label                                                  */
  /* ---------------------------------------------------------------- */

  describe('query: by_label', () => {
    it('finds tasks with a matching label', () => {
      db.exec(
        `UPDATE tasks SET labels = '["frontend","urgent-fix"]'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.query({ query: 'by_label', label: 'frontend' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-001');
    });

    it('returns empty when no tasks match', () => {
      const r = engine.query({ query: 'by_label', label: 'nonexistent' });
      expect(r.data).toHaveLength(0);
    });

    it('errors when label is missing', () => {
      const r = engine.query({ query: 'by_label' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/label/);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: statistics                                                */
  /* ---------------------------------------------------------------- */

  describe('query: statistics', () => {
    it('returns board-level stats', () => {
      const r = engine.query({ query: 'statistics' });
      expect(r.success).toBe(true);
      expect(r.data.total_active).toBe(3);
      expect(r.data.by_column.in_progress).toBe(1);
      expect(r.data.by_column.next_action).toBe(1);
      expect(r.data.by_column.inbox).toBe(1);
      expect(r.data.overdue).toBe(0);
      // 2 assignees: person-1 and person-2; T-003 has no assignee
      expect(r.data.avg_tasks_per_person).toBe(1.5);
    });

    it('counts overdue correctly in statistics', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.toISOString().slice(0, 10);
      db.exec(
        `UPDATE tasks SET due_date = '${yStr}'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.query({ query: 'statistics' });
      expect(r.data.overdue).toBe(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: person_statistics                                         */
  /* ---------------------------------------------------------------- */

  describe('query: person_statistics', () => {
    it('returns per-person stats', () => {
      const r = engine.query({
        query: 'person_statistics',
        person_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.data.person).toBe('Alexandre');
      expect(r.data.total_active).toBe(1);
      expect(r.data.by_column.in_progress).toBe(1);
      expect(r.data.completed).toBe(0);
      expect(r.data.completion_rate).toBe(0);
    });

    it('accounts for archived tasks in completion rate', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO archive (board_id, task_id, type, title, assignee, archive_reason, archived_at, task_snapshot)
         VALUES ('${BOARD_ID}', 'T-OLD', 'simple', 'Old task', 'person-1', 'done', '${now}', '{}')`,
      );
      const r = engine.query({
        query: 'person_statistics',
        person_name: 'Alexandre',
      });
      // 1 active + 1 completed = 2 total; completion rate = 50%
      expect(r.data.completed).toBe(1);
      expect(r.data.completion_rate).toBe(50);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: find_person_in_organization                               */
  /* ---------------------------------------------------------------- */

  describe('query: find_person_in_organization', () => {
    function seedOrgTree(db: Database.Database) {
      // Org tree:
      //   root (seci-secti) ─┬─ child (BOARD_ID = seci-taskflow)
      //                      ├─ sibling (thiago-taskflow)
      //                      └─ sibling2 (setec-secti-taskflow)
      db.exec(
        `INSERT INTO boards VALUES ('board-root', 'root@g.us', 'seci-secti', 'standard', 0, 2, NULL, NULL, NULL);
         INSERT INTO boards VALUES ('board-sibling', 'sibling@g.us', 'thiago-taskflow', 'standard', 1, 2, 'board-root', NULL, 'thiago');
         INSERT INTO boards VALUES ('board-sibling2', 'sibling2@g.us', 'setec-secti-taskflow', 'standard', 1, 2, 'board-root', NULL, 'rafael');
         UPDATE boards SET parent_board_id = 'board-root', hierarchy_level = 1 WHERE id = '${BOARD_ID}';
         INSERT INTO board_people VALUES ('board-root', 'rafael', 'RAFAEL AMARAL CHAVES', '558699487547', 'Dev', 3, NULL);
         INSERT INTO board_people VALUES ('board-root', 'thiago', 'Thiago Carvalho', '5586981512111', 'Dev', 3, NULL);
         INSERT INTO board_people VALUES ('board-sibling', 'thiago', 'Thiago Carvalho', '5586981512111', 'Dev', 3, 'thiago-override@g.us');
         INSERT INTO board_people VALUES ('board-sibling2', 'rafael', 'RAFAEL AMARAL CHAVES', '558699487547', 'Dev', 3, NULL);`,
      );
    }

    it('finds a person by partial name across the org tree', () => {
      seedOrgTree(db);
      const r = engine.query({ query: 'find_person_in_organization', search_text: 'Rafael' });
      expect(r.success).toBe(true);
      const rows = r.data as Array<{ board_group_folder: string; name: string }>;
      expect(rows.map((x) => x.board_group_folder).sort()).toEqual([
        'seci-secti',
        'setec-secti-taskflow',
      ]);
      expect(rows.every((x) => x.name === 'RAFAEL AMARAL CHAVES')).toBe(true);
    });

    it('handles multiple comma-separated names', () => {
      seedOrgTree(db);
      const r = engine.query({
        query: 'find_person_in_organization',
        search_text: 'Rafael, Thiago',
      });
      expect(r.success).toBe(true);
      const names = new Set((r.data as any[]).map((x) => x.name));
      expect(names).toEqual(new Set(['RAFAEL AMARAL CHAVES', 'Thiago Carvalho']));
      expect((r.data as any[]).length).toBe(4); // 2 Rafael + 2 Thiago
    });

    it('prefers notification_group_jid over board.group_jid for routing_jid', () => {
      seedOrgTree(db);
      const r = engine.query({ query: 'find_person_in_organization', search_text: 'Thiago' });
      const siblingMatch = (r.data as any[]).find((x) => x.board_group_folder === 'thiago-taskflow');
      expect(siblingMatch.routing_jid).toBe('thiago-override@g.us');
      const rootMatch = (r.data as any[]).find((x) => x.board_group_folder === 'seci-secti');
      expect(rootMatch.routing_jid).toBe('root@g.us');
    });

    it('is case-insensitive', () => {
      seedOrgTree(db);
      const r = engine.query({ query: 'find_person_in_organization', search_text: 'rafael' });
      expect((r.data as any[]).length).toBe(2);
    });

    it('returns empty array for unknown names', () => {
      seedOrgTree(db);
      const r = engine.query({
        query: 'find_person_in_organization',
        search_text: 'NonexistentPerson',
      });
      expect(r.success).toBe(true);
      expect(r.data).toEqual([]);
    });

    it('errors when search_text is missing', () => {
      seedOrgTree(db);
      const r = engine.query({ query: 'find_person_in_organization' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/search_text/);
    });

    it('errors when search_text is only whitespace/commas', () => {
      seedOrgTree(db);
      const r = engine.query({
        query: 'find_person_in_organization',
        search_text: ' , , ',
      });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/at least one name/);
    });

    it('searches the current board too (no hierarchy)', () => {
      // Default test setup has this board with no parent_board_id; the local
      // people (Alexandre, Giovanni) must still be findable.
      const r = engine.query({ query: 'find_person_in_organization', search_text: 'Alexandre' });
      expect((r.data as any[]).length).toBe(1);
      expect((r.data as any[])[0].name).toBe('Alexandre');
    });

    it('returns phone_masked instead of raw phone', () => {
      seedOrgTree(db);
      const r = engine.query({ query: 'find_person_in_organization', search_text: 'Rafael' });
      const row = (r.data as any[])[0];
      expect(row).not.toHaveProperty('phone');
      expect(row.phone_masked).toBe('•••7547');
    });

    it('escapes LIKE wildcards in search_text (% does not enumerate directory)', () => {
      seedOrgTree(db);
      const r = engine.query({ query: 'find_person_in_organization', search_text: '%' });
      // Without escaping, "%" would match every name in the org. With
      // escaping + ESCAPE '\', it becomes a literal "%" that appears
      // nowhere in any name, so zero matches.
      expect(r.success).toBe(true);
      expect((r.data as any[]).length).toBe(0);
    });

    it('escapes underscore wildcard in search_text', () => {
      seedOrgTree(db);
      const r = engine.query({ query: 'find_person_in_organization', search_text: '_' });
      expect((r.data as any[]).length).toBe(0);
    });

    it('does not cluster orphan boards under a dangling parent_board_id', () => {
      // Two unrelated orphan boards both point at 'board-phantom' (a
      // non-existent row). Without root-validation, getOrgBoardIds would
      // pick 'board-phantom' as root and cluster both orphans as one "org".
      db.exec(`INSERT INTO boards VALUES ('board-orphan-a', 'oa@g.us', 'orphan-a', 'standard', 0, 1, 'board-phantom', NULL, NULL);
               INSERT INTO boards VALUES ('board-orphan-b', 'ob@g.us', 'orphan-b', 'standard', 0, 1, 'board-phantom', NULL, NULL);
               INSERT INTO board_people VALUES ('board-orphan-a', 'p-a', 'Alice Orphan', '558111111111', 'Dev', 3, NULL);
               INSERT INTO board_people VALUES ('board-orphan-b', 'p-b', 'Bob Orphan', '558222222222', 'Dev', 3, NULL);`);
      const orphanEngine = new TaskflowEngine(db, 'board-orphan-a');
      const r = orphanEngine.query({
        query: 'find_person_in_organization',
        search_text: 'Orphan',
      });
      // Must NOT return Bob (who lives on the other orphan sharing the phantom parent)
      const names = (r.data as any[]).map((x) => x.name);
      expect(names).toEqual(['Alice Orphan']);
    });

    it('handles a parent_board_id cycle without infinite-looping', () => {
      // A cycle A→B→A should terminate lineage walking and still return
      // everyone in the cycle's reachable subtree.
      db.exec(`INSERT INTO boards VALUES ('board-cyc-a', 'a@g.us', 'cyc-a', 'standard', 0, 1, 'board-cyc-b', NULL, NULL);
               INSERT INTO boards VALUES ('board-cyc-b', 'b@g.us', 'cyc-b', 'standard', 0, 1, 'board-cyc-a', NULL, NULL);
               INSERT INTO board_people VALUES ('board-cyc-a', 'pa', 'Cyc Alice', '558333333333', 'Dev', 3, NULL);
               INSERT INTO board_people VALUES ('board-cyc-b', 'pb', 'Cyc Alice', '558444444444', 'Dev', 3, NULL);`);
      const cycEngine = new TaskflowEngine(db, 'board-cyc-a');
      const r = cycEngine.query({
        query: 'find_person_in_organization',
        search_text: 'Cyc Alice',
      });
      // Both cycle boards reachable — the cycle-break returns one as "root"
      // and the descendant walk picks up the other via parent_board_id.
      expect((r.data as any[]).length).toBe(2);
    });

    it('returns null phone_masked for people with null phone', () => {
      seedOrgTree(db);
      db.exec(
        `INSERT INTO board_people VALUES ('board-root', 'p-nophone', 'No Phone Person', NULL, 'Dev', 3, NULL);`,
      );
      const r = engine.query({
        query: 'find_person_in_organization',
        search_text: 'No Phone',
      });
      const row = (r.data as any[])[0];
      expect(row.name).toBe('No Phone Person');
      expect(row.phone_masked).toBeNull();
    });

    it('flags home-board rows via is_owner (person_id matches boards.owner_person_id)', () => {
      // Lets the agent pick the home-board row when one human appears on
      // multiple boards — its `name` is WhatsApp-canonical.
      seedOrgTree(db);
      const r = engine.query({
        query: 'find_person_in_organization',
        search_text: 'Rafael, Thiago',
      });
      const rows = r.data as Array<{ board_group_folder: string; is_owner: boolean }>;
      const byFolder = Object.fromEntries(rows.map((x) => [x.board_group_folder, x.is_owner]));
      expect(byFolder['seci-secti']).toBe(false);            // root — nobody's home
      expect(byFolder['thiago-taskflow']).toBe(true);        // Thiago's home
      expect(byFolder['setec-secti-taskflow']).toBe(true);   // Rafael's home
    });

    it('returns is_owner=false when boards.owner_person_id is NULL', () => {
      // Must tolerate NULL (un-backfilled boards) without crashing.
      seedOrgTree(db);
      db.exec(`UPDATE boards SET owner_person_id = NULL WHERE id = 'board-sibling'`);
      const r = engine.query({
        query: 'find_person_in_organization',
        search_text: 'Thiago',
      });
      const rows = r.data as Array<{ board_group_folder: string; is_owner: boolean }>;
      const thiagoHome = rows.find((x) => x.board_group_folder === 'thiago-taskflow');
      expect(thiagoHome?.is_owner).toBe(false);
    });

    it('returns all matches when 3+ boards share the same name (ordering)', () => {
      seedOrgTree(db);
      // Add a third Rafael on a fresh descendant
      db.exec(`INSERT INTO boards VALUES ('board-sibling3', 'sib3@g.us', 'new-sibling', 'standard', 1, 2, 'board-root', NULL, NULL);
               INSERT INTO board_people VALUES ('board-sibling3', 'rafael', 'RAFAEL AMARAL CHAVES', '558999999999', 'Dev', 3, NULL);`);
      const r = engine.query({
        query: 'find_person_in_organization',
        search_text: 'Rafael',
      });
      // 3 matches, ordered by group_folder, then name
      const folders = (r.data as any[]).map((x) => x.board_group_folder);
      expect(folders).toEqual(['new-sibling', 'seci-secti', 'setec-secti-taskflow']);
    });
  });

  describe('maskPhoneForDisplay', () => {
    it('returns null for null input', () => {
      expect(maskPhoneForDisplay(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(maskPhoneForDisplay('')).toBeNull();
    });

    it('masks long numbers to bullets + last 4 digits', () => {
      expect(maskPhoneForDisplay('558699487547')).toBe('•••7547');
    });

    it('strips non-digit characters before masking', () => {
      expect(maskPhoneForDisplay('+55 (86) 99948-7547')).toBe('•••7547');
    });

    it('bullets the whole string when fewer than 5 digits', () => {
      expect(maskPhoneForDisplay('1234')).toBe('••••');
      expect(maskPhoneForDisplay('12')).toBe('••');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: month_statistics                                          */
  /* ---------------------------------------------------------------- */

  describe('query: month_statistics', () => {
    it('returns monthly created / completed counts', () => {
      const r = engine.query({ query: 'month_statistics' });
      expect(r.success).toBe(true);
      // All 3 tasks were created "now" (this month)
      expect(r.data.created).toBe(3);
      expect(r.data.completed).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: summary                                                   */
  /* ---------------------------------------------------------------- */

  describe('query: summary', () => {
    it('returns board summary', () => {
      const r = engine.query({ query: 'summary' });
      expect(r.success).toBe(true);
      expect(r.data.total_tasks).toBe(3);
      expect(r.data.in_progress).toBe(1);
      expect(r.data.overdue).toBe(0);
      expect(r.data.blocked).toBe(0);
    });

    it('detects blocked tasks', () => {
      db.exec(
        `UPDATE tasks SET blocked_by = '["T-001"]'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );
      const r = engine.query({ query: 'summary' });
      expect(r.data.blocked).toBe(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: archive                                                   */
  /* ---------------------------------------------------------------- */

  describe('query: archive', () => {
    it('returns archived tasks most recent first', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO archive (board_id, task_id, type, title, archive_reason, archived_at, task_snapshot)
         VALUES ('${BOARD_ID}', 'A-001', 'simple', 'Old task 1', 'done', '2025-01-01T10:00:00Z', '{}')`,
      );
      db.exec(
        `INSERT INTO archive (board_id, task_id, type, title, archive_reason, archived_at, task_snapshot)
         VALUES ('${BOARD_ID}', 'A-002', 'simple', 'Old task 2', 'done', '${now}', '{}')`,
      );
      const r = engine.query({ query: 'archive' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(2);
      // Most recent first
      expect(r.data[0].task_id).toBe('A-002');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: archive_search                                            */
  /* ---------------------------------------------------------------- */

  describe('query: archive_search', () => {
    it('searches archived tasks by title', () => {
      db.exec(
        `INSERT INTO archive (board_id, task_id, type, title, archive_reason, archived_at, task_snapshot)
         VALUES ('${BOARD_ID}', 'A-003', 'simple', 'Deploy pipeline fix', 'done', '2025-06-01', '{}')`,
      );
      const r = engine.query({ query: 'archive_search', search_text: 'pipeline' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].task_id).toBe('A-003');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: agenda                                                    */
  /* ---------------------------------------------------------------- */

  describe('query: agenda', () => {
    it('returns overdue + due_today + in_progress', () => {
      const t = new Date().toISOString().slice(0, 10);
      db.exec(
        `UPDATE tasks SET due_date = '${t}'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-003'`,
      );
      const r = engine.query({ query: 'agenda' });
      expect(r.success).toBe(true);
      expect(r.data.overdue).toHaveLength(0);
      expect(r.data.due_today).toHaveLength(1);
      expect(r.data.due_today[0].id).toBe('T-003');
      expect(r.data.in_progress).toHaveLength(1);
      expect(r.data.in_progress[0].id).toBe('T-001');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: changes_today                                             */
  /* ---------------------------------------------------------------- */

  describe('query: changes_today', () => {
    it('returns history entries from today', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at)
         VALUES ('${BOARD_ID}', 'T-001', 'moved', 'person-1', '${now}')`,
      );
      // Insert old entry that should NOT appear
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at)
         VALUES ('${BOARD_ID}', 'T-001', 'created', 'person-1', '2020-01-01T00:00:00Z')`,
      );
      const r = engine.query({ query: 'changes_today' });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].action).toBe('moved');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: changes_since                                             */
  /* ---------------------------------------------------------------- */

  describe('query: changes_since', () => {
    it('returns history since a given date', () => {
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at)
         VALUES ('${BOARD_ID}', 'T-001', 'created', 'person-1', '2025-06-01T10:00:00Z')`,
      );
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at)
         VALUES ('${BOARD_ID}', 'T-002', 'moved', 'person-2', '2025-07-15T10:00:00Z')`,
      );
      const r = engine.query({ query: 'changes_since', since: '2025-07-01' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].task_id).toBe('T-002');
    });

    it('errors when since is missing', () => {
      const r = engine.query({ query: 'changes_since' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/since/);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  API adapter reads                                                */
  /* ---------------------------------------------------------------- */

  describe('API adapter reads', () => {
    it('apiBoardActivity returns parsed rows for local-today changes', () => {
      const now = new Date().toISOString();
      db.exec(`UPDATE boards SET short_code = 'DEV' WHERE id = '${BOARD_ID}'`);
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-001', 'create', 'person-1', '${now}', '{"source":"seed"}')`,
      );
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-001', 'update', 'person-1', '2020-01-01T00:00:00Z', '{"source":"old"}')`,
      );

      const result = engine.apiBoardActivity({ mode: 'changes_today' });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'create',
        by: 'person-1',
        details: { source: 'seed' },
      });
    });

    it('apiFilterBoardTasks translates assignee and priority for API consumers', () => {
      db.exec(`UPDATE boards SET short_code = 'DEV' WHERE id = '${BOARD_ID}'`);
      db.exec(
        `UPDATE tasks
         SET priority = 'urgent', labels = '["backend"]', notes = '[{"id":"n1","author":"Alexandre","content":"Context","created_at":"2026-03-01T10:00:00Z"}]'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const result = engine.apiFilterBoardTasks({ filter: 'urgent' });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: 'T-001',
        board_id: BOARD_ID,
        board_code: 'DEV',
        assignee: 'Alexandre',
        priority: 'urgente',
      });
      expect(result.data[0].labels).toEqual(['backend']);
      expect(result.data[0].notes).toHaveLength(1);
    });

    it('apiLinkedTasks returns board-local linked tasks with parent titles', () => {
      const now = new Date().toISOString();
      db.exec(`UPDATE boards SET short_code = 'DEV' WHERE id = '${BOARD_ID}'`);
      db.exec(
        `INSERT INTO tasks (
          id, board_id, type, title, assignee, column, requires_close_approval,
          child_exec_board_id, parent_task_id, created_at, updated_at
        )
        VALUES (
          'T-099', '${BOARD_ID}', 'simple', 'Linked child board task', 'person-2', 'next_action', 0,
          'board-child-1', 'T-001', '${now}', '${now}'
        )`,
      );

      const result = engine.apiLinkedTasks();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: 'T-099',
        board_id: BOARD_ID,
        board_code: 'DEV',
        assignee: 'Giovanni',
        parent_task_title: 'Fix login bug',
        child_exec_board_id: 'board-child-1',
      });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  query: person_waiting / person_review / person_completed         */
  /* ---------------------------------------------------------------- */

  describe('query: person_waiting', () => {
    it('returns waiting tasks for a person', () => {
      db.exec(
        `UPDATE tasks SET column = 'waiting', assignee = 'person-1'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-003'`,
      );
      const r = engine.query({ query: 'person_waiting', person_name: 'Alexandre' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe('T-003');
    });
  });

  describe('query: person_review', () => {
    it('returns review tasks for a person', () => {
      db.exec(
        `UPDATE tasks SET column = 'review', assignee = 'person-2'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-003'`,
      );
      const r = engine.query({ query: 'person_review', person_name: 'Giovanni' });
      expect(r.data).toHaveLength(1);
    });
  });

  describe('query: person_completed', () => {
    it('returns archived tasks for a person', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO archive (board_id, task_id, type, title, assignee, archive_reason, archived_at, task_snapshot)
         VALUES ('${BOARD_ID}', 'A-010', 'simple', 'Done task', 'person-1', 'done', '${now}', '{}')`,
      );
      const r = engine.query({ query: 'person_completed', person_name: 'Alexandre' });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].task_id).toBe('A-010');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Unknown query type                                               */
  /* ---------------------------------------------------------------- */

  describe('unknown query type', () => {
    it('returns error for unrecognized query', () => {
      const r = engine.query({ query: 'nonexistent_query' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Unknown query type/);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  create                                                           */
  /* ---------------------------------------------------------------- */

  describe('create', () => {
    it('creates inbox capture', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'inbox',
        title: 'Buy supplies',
        sender_name: 'Giovanni',
      });
      expect(r.success).toBe(true);
      expect(r.task_id).toBe('T4');
      expect(r.column).toBe('inbox');

      // Verify task in DB
      const task = engine.getTask('T4');
      expect(task).toBeTruthy();
      expect(task.title).toBe('Buy supplies');
      expect(task.type).toBe('simple'); // inbox stored as simple
      expect(task.column).toBe('inbox');
      expect(task.assignee).toBe('person-2'); // engine auto-assigns sender
    });

    it('creates assigned task', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Deploy v2',
        assignee: 'Giovanni',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.task_id).toBe('T4');
      expect(r.column).toBe('next_action');

      // Verify task in DB
      const task = engine.getTask('T4');
      expect(task.title).toBe('Deploy v2');
      expect(task.assignee).toBe('person-2');
      expect(task.column).toBe('next_action');

      // Notification: sender (Alexandre/person-1) != assignee (Giovanni/person-2)
      expect(r.notifications).toHaveLength(1);
      expect(r.notifications![0].target_person_id).toBe('person-2');
      expect(r.notifications![0].message).toContain('T4');
    });

    it('returns offer_register for unknown assignee', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Some task',
        assignee: 'Rafael',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.offer_register).toBeTruthy();
      expect(r.offer_register!.name).toBe('Rafael');
      expect(r.offer_register!.message).toContain('não está cadastrado');
      expect(r.offer_register!.message).toContain('Alexandre');
      expect(r.offer_register!.message).toContain('Giovanni');
      // Fixture is a hierarchy board (level 0, max_depth 1) → message MUST
      // include the division/sector ask so the bot's verbatim-send covers
      // all four required fields. Prior gap: Edilson 2026-04-10 SETD-SECTI.
      expect(r.offer_register!.message).toContain('sigla da divisão/setor');
    });

    it('creates project with subtasks', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'project',
        title: 'Redesign homepage',
        subtasks: ['Design', 'Implement', 'Test'],
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.task_id).toBe('P1');
      expect(r.column).toBe('next_action'); // auto-assigns sender → next_action

      const task = engine.getTask('P1');
      expect(task.type).toBe('project');
      // Subtasks are stored as real task rows with parent_task_id
      const subtaskRows = db
        .prepare(`SELECT id, title, column FROM tasks WHERE board_id = ? AND parent_task_id = ? ORDER BY id`)
        .all(BOARD_ID, 'P1') as Array<{ id: string; title: string; column: string }>;
      expect(subtaskRows).toHaveLength(3);
      expect(subtaskRows[0]).toMatchObject({ id: 'P1.1', title: 'Design', column: 'next_action' });
      expect(subtaskRows[1]).toMatchObject({ id: 'P1.2', title: 'Implement', column: 'next_action' });
      expect(subtaskRows[2]).toMatchObject({ id: 'P1.3', title: 'Test', column: 'next_action' });
    });

    it('creates subtask rows with child-board linkage for delegated assignees', () => {
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-gio')`,
      );
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-gio',
        personId: 'person-2',
        name: 'Giovanni',
      });

      const r = engine.create({
        board_id: BOARD_ID,
        type: 'project',
        title: 'Launch outreach',
        subtasks: [{ title: 'Call Jimmy', assignee: 'Giovanni' }],
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      expect(r.task_id).toBe('P1');

      const subtask = db
        .prepare(
          `SELECT id, parent_task_id, assignee, child_exec_enabled, child_exec_board_id, child_exec_person_id
           FROM tasks WHERE board_id = ? AND id = ?`,
        )
        .get(BOARD_ID, 'P1.1') as {
        id: string;
        parent_task_id: string;
        assignee: string;
        child_exec_enabled: number;
        child_exec_board_id: string | null;
        child_exec_person_id: string | null;
      };
      expect(subtask).toEqual({
        id: 'P1.1',
        parent_task_id: 'P1',
        assignee: 'person-2',
        child_exec_enabled: 1,
        child_exec_board_id: 'board-child-gio',
        child_exec_person_id: 'person-2',
      });

      const childEngine = new TaskflowEngine(db, 'board-child-gio');
      expect(childEngine.getTask('P1.1')?.id).toBe('P1.1');
    });

    it('notifications for delegated tasks include board prefix', () => {
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-notif')`,
      );
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-notif',
        personId: 'person-2',
        name: 'Giovanni',
      });
      db.exec(`UPDATE boards SET short_code = 'TST' WHERE id = '${BOARD_ID}'`);

      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Delegated with prefix',
        assignee: 'Giovanni',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      expect(r.notifications).toBeDefined();
      expect(r.notifications!.length).toBeGreaterThan(0);
      // The notification goes to the child board, so it should show the prefixed ID
      expect(r.notifications![0].message).toContain('TST-');
    });

    it('self-update notifications to parent board do NOT include prefix', () => {
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-selfup')`,
      );
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-selfup',
        personId: 'person-2',
        name: 'Giovanni',
      });
      db.exec(`UPDATE boards SET short_code = 'TST' WHERE id = '${BOARD_ID}'`);

      // Create a task assigned to Giovanni (delegated to child board)
      const createResult = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Self-update check',
        assignee: 'Giovanni',
        sender_name: 'Alexandre',
      });
      expect(createResult.success).toBe(true);
      const taskId = createResult.task_id!;

      // Now Giovanni moves the task from the child board perspective
      const childEngine = new TaskflowEngine(db, 'board-child-selfup');
      const moveResult = childEngine.move({
        board_id: 'board-child-selfup',
        task_id: taskId,
        action: 'start',
        sender_name: 'Giovanni',
      });

      expect(moveResult.success).toBe(true);
      // The self-update notification goes to the creator (Alexandre) on the parent board
      // It should NOT have the prefix since Alexandre views tasks from the parent board
      if (moveResult.notifications && moveResult.notifications.length > 0) {
        expect(moveResult.notifications[0].message).not.toContain('TST-');
      }
    });

    it('creates recurring task', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'recurring',
        title: 'Weekly standup',
        recurrence: 'weekly',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.task_id).toBe('R1');

      const task = engine.getTask('R1');
      expect(task.type).toBe('recurring');
      expect(task.recurrence).toBe('weekly');
      expect(task.due_date).toBeTruthy(); // auto-calculated
    });

    it('creates recurring task with child-board linkage for delegated assignees', () => {
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-gio')`,
      );
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-gio',
        personId: 'person-2',
        name: 'Giovanni',
      });

      const r = engine.create({
        board_id: BOARD_ID,
        type: 'recurring',
        title: 'Monthly report',
        recurrence: 'monthly',
        assignee: 'Giovanni',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      expect(r.task_id).toBe('R1');

      const task = db
        .prepare(
          `SELECT id, assignee, child_exec_enabled, child_exec_board_id, child_exec_person_id
           FROM tasks WHERE board_id = ? AND id = ?`,
        )
        .get(BOARD_ID, 'R1') as {
        id: string;
        assignee: string;
        child_exec_enabled: number;
        child_exec_board_id: string | null;
        child_exec_person_id: string | null;
      };
      expect(task).toEqual({
        id: 'R1',
        assignee: 'person-2',
        child_exec_enabled: 1,
        child_exec_board_id: 'board-child-gio',
        child_exec_person_id: 'person-2',
      });

      const childEngine = new TaskflowEngine(db, 'board-child-gio');
      expect(childEngine.getTask('R1')?.id).toBe('R1');
    });

    it('defaults delegated tasks to require close approval', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Needs approval',
        assignee: 'Giovanni',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      expect(engine.getTask(r.task_id!)?.requires_close_approval).toBe(1);
    });

    it('defaults self-assigned tasks to not require close approval', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Self owned',
        assignee: 'Alexandre',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      expect(engine.getTask(r.task_id!)?.requires_close_approval).toBe(0);
    });

    it('non-manager cannot create assigned task', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Should fail',
        assignee: 'Alexandre',
        sender_name: 'Giovanni', // not a manager
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Only managers');
      expect(r.error).toContain('Giovanni');
    });

    it('records history', () => {
      engine.create({
        board_id: BOARD_ID,
        type: 'inbox',
        title: 'History test',
        sender_name: 'Alexandre',
      });

      const history = db
        .prepare(
          `SELECT * FROM task_history WHERE board_id = ? AND task_id = 'T4'`,
        )
        .all(BOARD_ID) as any[];
      expect(history).toHaveLength(1);
      expect(history[0].action).toBe('created');
      expect(history[0].by).toBe('Alexandre');
      const details = JSON.parse(history[0].details);
      expect(details.title).toBe('History test');
    });

    it('records trigger_turn_id in history when present', () => {
      const engineWithTurn = new TaskflowEngine(db, BOARD_ID, {
        triggerTurnId: 'turn-123',
      });

      engineWithTurn.create({
        board_id: BOARD_ID,
        type: 'inbox',
        title: 'Turn-bound history test',
        sender_name: 'Alexandre',
      });

      const history = db
        .prepare(
          `SELECT trigger_turn_id FROM task_history WHERE board_id = ? AND task_id = 'T4'`,
        )
        .all(BOARD_ID) as Array<{ trigger_turn_id: string | null }>;
      expect(history).toHaveLength(1);
      expect(history[0].trigger_turn_id).toBe('turn-123');
    });

    it('increments task number', () => {
      const r1 = engine.create({
        board_id: BOARD_ID,
        type: 'inbox',
        title: 'First',
        sender_name: 'Alexandre',
      });
      const r2 = engine.create({
        board_id: BOARD_ID,
        type: 'inbox',
        title: 'Second',
        sender_name: 'Alexandre',
      });
      expect(r1.task_id).toBe('T4');
      expect(r2.task_id).toBe('T5');

      // Verify counter in board_id_counters is now 6
      const counter = db
        .prepare(`SELECT next_number FROM board_id_counters WHERE board_id = ? AND prefix = 'T'`)
        .get(BOARD_ID) as { next_number: number };
      expect(counter.next_number).toBe(6);
    });

    it('self-heals a stale task counter when the proposed ID already exists', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at)
         VALUES ('T4', '${BOARD_ID}', 'simple', 'Existing T4', 'inbox', '${now}', '${now}')`,
      );
      db.prepare(`UPDATE board_id_counters SET next_number = 4 WHERE board_id = ? AND prefix = 'T'`)
        .run(BOARD_ID);

      const result = engine.create({
        board_id: BOARD_ID,
        type: 'inbox',
        title: 'Counter repair',
        sender_name: 'Alexandre',
      });

      expect(result.success).toBe(true);
      expect(result.task_id).toBe('T5');

      const counter = db
        .prepare(`SELECT next_number FROM board_id_counters WHERE board_id = ? AND prefix = 'T'`)
        .get(BOARD_ID) as { next_number: number };
      expect(counter.next_number).toBe(6);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  move                                                             */
  /* ---------------------------------------------------------------- */

  describe('move', () => {
    it('start: next_action -> in_progress', () => {
      // T-002 is in next_action, assigned to person-2 (Giovanni)
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'start',
        sender_name: 'Alexandre', // manager
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('next_action');
      expect(r.to_column).toBe('in_progress');

      const task = engine.getTask('T-002');
      expect(task.column).toBe('in_progress');
    });

    it('moves a linked task and writes back to the owning board row', () => {
      const { ownerBoardId, taskId } = seedLinkedTask(db, BOARD_ID, {
        taskId: 'T-904',
        assignee: 'person-2',
        column: 'next_action',
      });

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: taskId,
        action: 'start',
        sender_name: 'Giovanni',
      });

      expect(r.success).toBe(true);
      expect(r.to_column).toBe('in_progress');

      const ownerRow = db
        .prepare(`SELECT board_id, "column" FROM tasks WHERE board_id = ? AND id = ?`)
        .get(ownerBoardId, taskId) as { board_id: string; column: string };
      expect(ownerRow.board_id).toBe(ownerBoardId);
      expect(ownerRow.column).toBe('in_progress');

      const historyRow = db
        .prepare(
          `SELECT board_id, action FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(ownerBoardId, taskId) as { board_id: string; action: string };
      expect(historyRow.board_id).toBe(ownerBoardId);
      expect(historyRow.action).toBe('start');
    });

    it('start: WIP exceeded -> error with wip_warning', () => {
      // person-2 (Giovanni) has wip_limit=3; put 3 tasks in_progress for them
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-010', '${BOARD_ID}', 'simple', 'WIP1', 'person-2', 'in_progress', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-011', '${BOARD_ID}', 'simple', 'WIP2', 'person-2', 'in_progress', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-012', '${BOARD_ID}', 'simple', 'WIP3', 'person-2', 'in_progress', '${now}', '${now}')`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'start',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('WIP limit');
      expect(r.wip_warning).toBeTruthy();
      expect(r.wip_warning!.person).toBe('Giovanni');
      expect(r.wip_warning!.current).toBe(3);
      expect(r.wip_warning!.limit).toBe(3);
    });

    it('force_start: WIP exceeded -> succeeds (manager only)', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-010', '${BOARD_ID}', 'simple', 'WIP1', 'person-2', 'in_progress', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-011', '${BOARD_ID}', 'simple', 'WIP2', 'person-2', 'in_progress', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-012', '${BOARD_ID}', 'simple', 'WIP3', 'person-2', 'in_progress', '${now}', '${now}')`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'force_start',
        sender_name: 'Alexandre', // manager
      });
      expect(r.success).toBe(true);
      expect(r.to_column).toBe('in_progress');
    });

    it('force_start: non-manager -> permission denied', () => {
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'force_start',
        sender_name: 'Giovanni', // not a manager
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Permission denied');
      expect(r.error).toContain('manager');
    });

    it('wait: in_progress -> waiting with reason', () => {
      // T-001 is in_progress, assigned to person-1 (Alexandre)
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'wait',
        sender_name: 'Alexandre',
        reason: 'Waiting for client response',
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('in_progress');
      expect(r.to_column).toBe('waiting');

      const task = engine.getTask('T-001');
      expect(task.column).toBe('waiting');
      expect(task.waiting_for).toBe('Waiting for client response');
    });

    it('resume: waiting -> in_progress', () => {
      // First move T-001 to waiting
      db.exec(
        `UPDATE tasks SET column = 'waiting' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'resume',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('waiting');
      expect(r.to_column).toBe('in_progress');

      const task = engine.getTask('T-001');
      expect(task.column).toBe('in_progress');
    });

    it('return: in_progress -> next_action', () => {
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'return',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('in_progress');
      expect(r.to_column).toBe('next_action');

      const task = engine.getTask('T-001');
      expect(task.column).toBe('next_action');
    });

    it('review: in_progress -> review', () => {
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'review',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('in_progress');
      expect(r.to_column).toBe('review');

      const task = engine.getTask('T-001');
      expect(task.column).toBe('review');
    });

    it('approve: review -> done (manager, not self)', () => {
      // Move T-002 (assigned to person-2) to review
      db.exec(
        `UPDATE tasks SET column = 'review' WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'approve',
        sender_name: 'Alexandre', // manager, not the assignee (person-2)
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('review');
      expect(r.to_column).toBe('done');

      const task = engine.getTask('T-002');
      expect(task.column).toBe('done');
    });

    it('approve: self-approve -> denied', () => {
      // Move T-001 (assigned to person-1 Alexandre) to review
      db.exec(
        `UPDATE tasks SET column = 'review' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'approve',
        sender_name: 'Alexandre', // manager but also the assignee
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Self-approval');
    });

    it('reject: review -> in_progress with reason', () => {
      // Move T-002 to review
      db.exec(
        `UPDATE tasks SET column = 'review' WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'reject',
        sender_name: 'Alexandre',
        reason: 'Missing tests',
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('review');
      expect(r.to_column).toBe('in_progress');

      const task = engine.getTask('T-002');
      expect(task.column).toBe('in_progress');
    });

    it('conclude: any -> done', () => {
      // T-002 is in next_action; conclude should work from any non-done column
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'conclude',
        sender_name: 'Alexandre', // manager
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('next_action');
      expect(r.to_column).toBe('done');
    });

    it('conclude by assignee routes to review when close approval is required', () => {
      db.exec(
        `UPDATE tasks SET requires_close_approval = 1 WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'conclude',
        sender_name: 'Giovanni',
      });

      expect(r.success).toBe(true);
      expect(r.approval_gate_applied).toBe(true);
      expect(r.from_column).toBe('next_action');
      expect(r.to_column).toBe('review');
      expect(engine.getTask('T-002')?.column).toBe('review');

      const history = db
        .prepare(
          `SELECT action, details FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(BOARD_ID, 'T-002') as { action: string; details: string };
      expect(history.action).toBe('review');
      expect(JSON.parse(history.details).requested_action).toBe('conclude');
    });

    it('conclude by assignee still routes to review even if the assignee is manager on the child board', () => {
      seedChildBoard(db, {
        parentBoardId: 'board-parent-gio',
        childBoardId: 'board-child-gio',
        personId: 'person-2',
        name: 'Giovanni',
      });
      const { taskId } = seedLinkedTask(db, 'board-child-gio', {
        ownerBoardId: 'board-parent-gio',
        taskId: 'T-906',
        assignee: 'person-2',
        column: 'next_action',
      });
      const childEngine = new TaskflowEngine(db, 'board-child-gio');

      const r = childEngine.move({
        board_id: 'board-child-gio',
        task_id: taskId,
        action: 'conclude',
        sender_name: 'Giovanni',
      });

      expect(r.success).toBe(true);
      expect(r.approval_gate_applied).toBe(true);
      expect(r.to_column).toBe('review');
      expect(db.prepare(`SELECT "column" FROM tasks WHERE board_id = ? AND id = ?`).get('board-parent-gio', taskId)).toEqual({ column: 'review' });
    });

    it('suppresses duplicate creator notification when parent notification targets the same group', () => {
      const { ownerBoardId, taskId } = seedLinkedTask(db, BOARD_ID, {
        taskId: 'T-905',
        assignee: 'person-2',
        column: 'next_action',
      });
      db.exec(
        `UPDATE board_people SET notification_group_jid = 'parent@g.us' WHERE board_id = '${BOARD_ID}' AND person_id = 'person-1'`,
      );
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', '${taskId}', 'created', 'Alexandre', '${now}', '{"title":"Linked task"}')`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: taskId,
        action: 'conclude',
        sender_name: 'Giovanni',
      });

      expect(r.success).toBe(true);
      expect(r.parent_notification?.parent_group_jid).toBe('parent@g.us');
      expect(r.notifications).toBeUndefined();

      const ownerRow = db
        .prepare(`SELECT "column" FROM tasks WHERE board_id = ? AND id = ?`)
        .get(ownerBoardId, taskId) as { column: string };
      expect(ownerRow.column).toBe('review');
    });

    it('reopen: done -> next_action', () => {
      // Move T-001 to done first
      db.exec(
        `UPDATE tasks SET column = 'done' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'reopen',
        sender_name: 'Alexandre', // manager
      });
      expect(r.success).toBe(true);
      expect(r.from_column).toBe('done');
      expect(r.to_column).toBe('next_action');

      const task = engine.getTask('T-001');
      expect(task.column).toBe('next_action');
    });

    it('invalid transition -> error (start from waiting)', () => {
      // T-001 is in_progress; move to waiting first
      db.exec(
        `UPDATE tasks SET column = 'waiting' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'start',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Cannot "start"');
      expect(r.error).toContain('waiting');
    });

    it('records history on move', () => {
      engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'review',
        sender_name: 'Alexandre',
      });

      const history = db
        .prepare(
          `SELECT * FROM task_history WHERE board_id = ? AND task_id = 'T-001'`,
        )
        .all(BOARD_ID) as any[];
      expect(history.length).toBeGreaterThanOrEqual(1);
      const entry = history[history.length - 1];
      expect(entry.action).toBe('review');
      expect(entry.by).toBe('Alexandre');
      const details = JSON.parse(entry.details);
      expect(details.from).toBe('in_progress');
      expect(details.to).toBe('review');
    });

    it('notification: move by non-assignee returns notification', () => {
      // T-002 assigned to person-2 (Giovanni), moved by Alexandre (person-1)
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'start',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.notifications).toHaveLength(1);
      expect(r.notifications![0].target_person_id).toBe('person-2');
      expect(r.notifications![0].message).toContain('T-002');
    });

    it('notification: self-move returns no notification', () => {
      // T-001 assigned to person-1 (Alexandre), moved by Alexandre
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'review',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.notifications).toBeUndefined();
    });

    it('dependency resolution on approve', () => {
      // T-002 blocked by T-001
      db.exec(
        `UPDATE tasks SET blocked_by = '["T-001"]' WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );
      // Move T-001 to review, then approve
      db.exec(
        `UPDATE tasks SET column = 'review' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      // Add a delegate so we can approve (Alexandre is assignee so can't self-approve)
      db.exec(
        `INSERT INTO board_admins VALUES ('${BOARD_ID}', 'person-2', '5585999990002', 'delegate', 0)`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'approve',
        sender_name: 'Giovanni', // delegate, not assignee
      });
      expect(r.success).toBe(true);

      // T-002's blocked_by should now be empty
      const t2 = engine.getTask('T-002');
      const blockedBy = JSON.parse(t2.blocked_by);
      expect(blockedBy).toEqual([]);
    });

    it('recurring task cycles on conclude', () => {
      // Create a recurring task
      const now = new Date().toISOString();
      const dueDate = new Date().toISOString().slice(0, 10);
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, recurrence, due_date, current_cycle, created_at, updated_at)
         VALUES ('R-020', '${BOARD_ID}', 'recurring', 'Weekly check', 'person-1', 'in_progress', 0, 'weekly', '${dueDate}', '0', '${now}', '${now}')`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'R-020',
        action: 'conclude',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.recurring_cycle).toBeTruthy();
      expect(r.recurring_cycle!.cycle_number).toBe(1);
      // The task should have been reopened to next_action by advanceRecurringTask
      const task = engine.getTask('R-020');
      expect(task.column).toBe('next_action');
      expect(task.current_cycle).toBe('1');
    });

    it('wait directly from next_action', () => {
      db.exec(
        `UPDATE tasks SET column = 'next_action', assignee = 'person-1' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'wait',
        reason: 'Aguardando resposta',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      const task = engine.getTask('T-001');
      expect(task.column).toBe('waiting');
      expect(task.waiting_for).toBe('Aguardando resposta');
    });

    it('wait directly from inbox', () => {
      db.exec(
        `UPDATE tasks SET column = 'inbox', assignee = 'person-1' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'wait',
        reason: 'Esperando aprovação',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      const task = engine.getTask('T-001');
      expect(task.column).toBe('waiting');
    });

    it('review directly from next_action', () => {
      db.exec(
        `UPDATE tasks SET column = 'next_action', assignee = 'person-1' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'review',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      const task = engine.getTask('T-001');
      expect(task.column).toBe('review');
    });

    it('review directly from waiting', () => {
      db.exec(
        `UPDATE tasks SET column = 'waiting', assignee = 'person-1' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'review',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      const task = engine.getTask('T-001');
      expect(task.column).toBe('review');
    });

    it('return directly from waiting clears waiting_for', () => {
      db.exec(
        `UPDATE tasks SET column = 'waiting', assignee = 'person-1', waiting_for = 'Client reply' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'return',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      const task = engine.getTask('T-001');
      expect(task.column).toBe('next_action');
      expect(task.waiting_for).toBeNull();
    });

    it('return directly from review', () => {
      db.exec(
        `UPDATE tasks SET column = 'review', assignee = 'person-1' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'return',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      const task = engine.getTask('T-001');
      expect(task.column).toBe('next_action');
    });

    it('review directly from inbox', () => {
      db.exec(
        `UPDATE tasks SET column = 'inbox', assignee = 'person-1' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'review',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      const task = engine.getTask('T-001');
      expect(task.column).toBe('review');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  move → completion notification integration                        */
  /* ---------------------------------------------------------------- */

  describe('move → buildCompletionNotification integration', () => {
    beforeEach(() => {
      db.prepare(
        `UPDATE board_people SET notification_group_jid = ? WHERE board_id = ? AND person_id = ?`,
      ).run('notif@g.us', BOARD_ID, 'person-2');
    });

    it('cheerful variant: fresh one-shot task emits cheerful message on conclude', () => {
      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'conclude',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      expect(r.to_column).toBe('done');
      expect(r.notifications).toBeDefined();
      expect(r.notifications!.length).toBeGreaterThan(0);
      const msg = r.notifications![0].message;
      expect(msg).toContain('🎉 *Tarefa concluída!*');
      expect(msg).toContain('*T-002* — Update docs');
      expect(msg).toContain('👤 *Entregue por:* Giovanni');
      expect(msg).toContain('🎯 *Próximas Ações → Concluída*');
      expect(msg.match(/━━━━━━━━━━━━━━/g)?.length).toBe(1);
    });

    it('loud variant: old task includes duration + reconstructed flow', () => {
      const oldDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      db.prepare(`UPDATE tasks SET created_at = ? WHERE board_id = ? AND id = ?`)
        .run(oldDate, BOARD_ID, 'T-002');
      db.prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(BOARD_ID, 'T-002', 'moved', 'Alexandre', '2026-04-18T10:00:00Z', JSON.stringify({ from: 'inbox', to: 'next_action' }));

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'conclude',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      const msg = r.notifications![0].message;
      expect(msg.match(/━━━━━━━━━━━━━━/g)?.length).toBe(2);
      expect(msg).toContain('🎉 *Tarefa concluída!*');
      expect(msg).toMatch(/Giovanni entregou em \d+ dias 👏/);
      expect(msg).toContain('_Fluxo: ');
      expect(msg).toContain('Concluída');
    });

    it('requires_close_approval=1 forces loud even on fresh tasks', () => {
      db.prepare(`UPDATE tasks SET requires_close_approval = 1 WHERE board_id = ? AND id = ?`)
        .run(BOARD_ID, 'T-002');

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'conclude',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      const msg = r.notifications![0].message;
      expect(msg.match(/━━━━━━━━━━━━━━/g)?.length).toBe(2);
      expect(msg).toContain('🎉 *Tarefa concluída!*');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  reassign                                                         */
  /* ---------------------------------------------------------------- */

  describe('reassign', () => {
    it('reassign single task (confirmed)', () => {
      // T-001 is in_progress, assigned to person-1 (Alexandre)
      // Alexandre (manager) reassigns to Giovanni
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-001',
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      expect(r.success).toBe(true);
      expect(r.tasks_affected).toHaveLength(1);
      expect(r.tasks_affected![0].task_id).toBe('T-001');
      expect(r.tasks_affected![0].title).toBe('Fix login bug');
      expect(r.tasks_affected![0].was_linked).toBe(false);

      // Verify in DB
      const task = engine.getTask('T-001');
      expect(task.assignee).toBe('person-2');

      // Verify history was recorded
      const history = db
        .prepare(
          `SELECT * FROM task_history WHERE board_id = ? AND task_id = 'T-001' AND action = 'reassigned'`,
        )
        .all(BOARD_ID) as any[];
      expect(history).toHaveLength(1);
      expect(history[0].by).toBe('Alexandre');
      const details = JSON.parse(history[0].details);
      expect(details.from_assignee).toBe('person-1');
      expect(details.to_assignee).toBe('person-2');
    });

    it('reassign dry run', () => {
      // confirmed=false: returns requires_confirmation, no DB changes
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-001',
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: false,
      });
      expect(r.success).toBe(true);
      expect(r.requires_confirmation).toBeTruthy();
      expect(r.requires_confirmation).toContain('T-001');
      expect(r.requires_confirmation).toContain('Giovanni');
      expect(r.tasks_affected).toHaveLength(1);

      // DB should NOT have changed
      const task = engine.getTask('T-001');
      expect(task.assignee).toBe('person-1'); // still the original assignee
    });

    it('unknown target person → offer_register', () => {
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-001',
        target_person: 'Rafael',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      expect(r.success).toBe(false);
      expect(r.offer_register).toBeTruthy();
      expect(r.offer_register!.name).toBe('Rafael');
      expect(r.offer_register!.message).toContain('não está cadastrado');
      expect(r.offer_register!.message).toContain('Alexandre');
      expect(r.offer_register!.message).toContain('Giovanni');
    });

    it('reassign linked task → auto-relinks', () => {
      const now = new Date().toISOString();
      // Set up T-001 with child_exec_enabled=1
      db.exec(
        `UPDATE tasks SET child_exec_enabled = 1, child_exec_board_id = 'child-board-1', child_exec_person_id = 'person-1'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      // Register a child board for person-2 (Giovanni)
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'child-board-2')`,
      );

      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-001',
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      expect(r.success).toBe(true);
      expect(r.tasks_affected).toHaveLength(1);
      expect(r.tasks_affected![0].was_linked).toBe(true);
      expect(r.tasks_affected![0].relinked_to).toBe('child-board-2');

      // Verify DB
      const task = engine.getTask('T-001');
      expect(task.assignee).toBe('person-2');
      expect(task.child_exec_enabled).toBe(1);
      expect(task.child_exec_board_id).toBe('child-board-2');
      expect(task.child_exec_person_id).toBe('person-2');
    });

    it('reassign linked task to person without child board → unlinks', () => {
      // Set up T-001 with child_exec_enabled=1
      db.exec(
        `UPDATE tasks SET child_exec_enabled = 1, child_exec_board_id = 'child-board-1', child_exec_person_id = 'person-1'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      // person-2 (Giovanni) has NO child_board_registrations entry

      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-001',
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      expect(r.success).toBe(true);
      expect(r.tasks_affected![0].was_linked).toBe(true);
      expect(r.tasks_affected![0].relinked_to).toBeUndefined();

      // Verify DB: unlinked
      const task = engine.getTask('T-001');
      expect(task.child_exec_enabled).toBe(0);
      expect(task.child_exec_board_id).toBeNull();
      expect(task.child_exec_person_id).toBeNull();
    });

    it('single-task reassign to same person → error', () => {
      // T-001 is assigned to person-1 (Alexandre); Alexandre reassigns to Alexandre
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-001',
        target_person: 'Alexandre',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('already assigned');
    });

    it('reassign delegated task from child board → relinks using parent board registrations', () => {
      // Seed a parent board with a task delegated to this (child) board
      const { ownerBoardId, taskId } = seedLinkedTask(db, BOARD_ID, {
        taskId: 'T-910',
        assignee: 'person-1', // Alexandre on child board
      });

      // Register person-2 (Giovanni) as having a child board on the PARENT board
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${ownerBoardId}', 'person-2', 'child-board-giovanni')`,
      );
      // (person-2 already exists on BOARD_ID from seedTestDb)

      // Reassign T-910 from person-1 to Giovanni, from the child board engine
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: taskId,
        target_person: 'Giovanni',
        sender_name: 'Alexandre', // manager
        confirmed: true,
      });
      expect(r.success).toBe(true);
      expect(r.tasks_affected).toHaveLength(1);
      expect(r.tasks_affected![0].was_linked).toBe(true);
      expect(r.tasks_affected![0].relinked_to).toBe('child-board-giovanni');

      // Verify the task was relinked, not unlinked
      const task = db
        .prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = ?`)
        .get(ownerBoardId, taskId) as any;
      expect(task.child_exec_enabled).toBe(1);
      expect(task.child_exec_board_id).toBe('child-board-giovanni');
      expect(task.child_exec_person_id).toBe('person-2');
    });

    it('reassign delegated task to person not on parent board → succeeds, parent board shows under accountable person', () => {
      const { ownerBoardId, taskId } = seedLinkedTask(db, BOARD_ID, {
        taskId: 'T-920',
        assignee: 'person-1',
      });

      db.exec(
        `INSERT INTO board_people VALUES ('${BOARD_ID}', 'person-ext', 'Reginaldo', '5585999990099', 'Analista', 3, NULL)`,
      );

      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: taskId,
        target_person: 'Reginaldo',
        sender_name: 'Alexandre',
        confirmed: true,
      });

      // Reassignment succeeds — delegation is allowed
      expect(r.success).toBe(true);

      // DB has the new assignee
      const task = db
        .prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = ?`)
        .get(ownerBoardId, taskId) as any;
      expect(task.assignee).toBe('person-ext');

      // On the PARENT board, formatBoardView should show the task under person-1 (Alexandre)
      // with a delegation indicator, not under person-ext (Reginaldo)
      const parentEngine = new TaskflowEngine(db, ownerBoardId);
      // Add person-1 to parent board so the board has someone
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${ownerBoardId}', 'person-1', 'Alexandre', '5585999990001', 'Dev', 3, NULL)`,
      );
      db.exec(
        `INSERT OR IGNORE INTO board_admins VALUES ('${ownerBoardId}', 'person-1', '5585999990001', 'manager', 1)`,
      );
      const boardView = (parentEngine as any).formatBoardView('board');
      // Task should appear under Alexandre (accountable), not Reginaldo
      expect(boardView).toContain('Alexandre');
      // Should show delegation indicator with Reginaldo's name
      expect(boardView).toContain('Reginaldo');
    });

    it('reassign delegated task to person on both child and parent board → succeeds', () => {
      const { ownerBoardId, taskId } = seedLinkedTask(db, BOARD_ID, {
        taskId: 'T-940',
        assignee: 'person-1',
      });

      db.exec(
        `INSERT INTO board_people VALUES ('${ownerBoardId}', 'person-2', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`,
      );

      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: taskId,
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });

      expect(r.success).toBe(true);
      const task = db
        .prepare(`SELECT assignee FROM tasks WHERE board_id = ? AND id = ?`)
        .get(ownerBoardId, taskId) as any;
      expect(task.assignee).toBe('person-2');
    });

    it('bulk transfer all tasks', () => {
      // person-1 (Alexandre) has T-001 (in_progress); add another active task
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-050', '${BOARD_ID}', 'simple', 'Bulk task', 'person-1', 'next_action', '${now}', '${now}')`,
      );

      const r = engine.reassign({
        board_id: BOARD_ID,
        source_person: 'Alexandre',
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      expect(r.success).toBe(true);
      expect(r.tasks_affected).toHaveLength(2);
      expect(r.tasks_affected!.map((t) => t.task_id).sort()).toEqual(['T-001', 'T-050']);

      // Verify DB
      const t1 = engine.getTask('T-001');
      const t50 = engine.getTask('T-050');
      expect(t1.assignee).toBe('person-2');
      expect(t50.assignee).toBe('person-2');
    });

    it('bulk transfer: no active tasks → error', () => {
      // Add a third person with no tasks
      db.exec(
        `INSERT INTO board_people VALUES ('${BOARD_ID}', 'person-3', 'Carlos', '5585999990003', 'Dev', 3, NULL)`,
      );

      const r = engine.reassign({
        board_id: BOARD_ID,
        source_person: 'Carlos',
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('No active tasks');
      expect(r.error).toContain('Carlos');
    });

    it('bulk transfer: same person → error', () => {
      const r = engine.reassign({
        board_id: BOARD_ID,
        source_person: 'Giovanni',
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('same person');
    });

    it('permission: assignee can reassign own task', () => {
      // T-002 is assigned to person-2 (Giovanni); Giovanni reassigns it
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-002',
        target_person: 'Alexandre',
        sender_name: 'Giovanni', // assignee, not manager
        confirmed: true,
      });
      expect(r.success).toBe(true);
      expect(r.tasks_affected).toHaveLength(1);

      const task = engine.getTask('T-002');
      expect(task.assignee).toBe('person-1');
    });

    it('permission: manager can reassign any task', () => {
      // T-002 is assigned to person-2 (Giovanni); Alexandre (manager) reassigns it
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-002',
        target_person: 'Alexandre',
        sender_name: 'Alexandre', // manager
        confirmed: true,
      });
      expect(r.success).toBe(true);
      expect(r.tasks_affected).toHaveLength(1);

      const task = engine.getTask('T-002');
      expect(task.assignee).toBe('person-1');
    });

    it('permission: non-owner/non-manager → denied', () => {
      // T-001 is assigned to person-1 (Alexandre); Giovanni (not manager) tries to reassign it
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-001',
        target_person: 'Giovanni',
        sender_name: 'Giovanni', // not assignee, not manager
        confirmed: true,
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Permission denied');
    });

    it('WIP check on reassignment', () => {
      // person-2 (Giovanni) has wip_limit=3; put 3 tasks in_progress for them
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-010', '${BOARD_ID}', 'simple', 'WIP1', 'person-2', 'in_progress', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-011', '${BOARD_ID}', 'simple', 'WIP2', 'person-2', 'in_progress', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
         VALUES ('T-012', '${BOARD_ID}', 'simple', 'WIP3', 'person-2', 'in_progress', '${now}', '${now}')`,
      );

      // Reassign T-001 (in_progress, assigned to person-1) to person-2 who is at WIP limit
      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: 'T-001',
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });
      // Engine now enforces WIP limits on reassignment
      expect(r.success).toBe(false);
      expect(r.error).toContain('WIP limit exceeded');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  update                                                           */
  /* ---------------------------------------------------------------- */

  describe('update', () => {
    it('update title', () => {
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre', // assignee (person-1)
        updates: { title: 'Fix login bug v2' },
      });
      expect(r.success).toBe(true);
      expect(r.task_id).toBe('T-001');
      expect(r.changes).toContain('Título alterado para "Fix login bug v2"');

      const task = engine.getTask('T-001');
      expect(task.title).toBe('Fix login bug v2');
    });

    it('update priority', () => {
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { priority: 'urgent' },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Prioridade: urgent');

      const task = engine.getTask('T-001');
      expect(task.priority).toBe('urgent');
    });

    it('manager can change close approval policy', () => {
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-002',
        sender_name: 'Alexandre',
        updates: { requires_close_approval: true },
      });

      expect(r.success).toBe(true);
      expect(r.changes).toContain('Aprovação para concluir ativada');
      expect(engine.getTask('T-002')?.requires_close_approval).toBe(1);
    });

    it('non-manager cannot change close approval policy', () => {
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-002',
        sender_name: 'Giovanni',
        updates: { requires_close_approval: true },
      });

      expect(r.success).toBe(false);
      expect(r.error).toContain('only managers');
    });

    it('child-board manager cannot change close approval policy on a linked parent task', () => {
      seedChildBoard(db, {
        parentBoardId: 'board-parent-gio',
        childBoardId: 'board-child-gio',
        personId: 'person-2',
        name: 'Giovanni',
      });
      const { taskId } = seedLinkedTask(db, 'board-child-gio', {
        ownerBoardId: 'board-parent-gio',
        taskId: 'T-907',
        assignee: 'person-2',
      });
      const childEngine = new TaskflowEngine(db, 'board-child-gio');

      const r = childEngine.update({
        board_id: 'board-child-gio',
        task_id: taskId,
        sender_name: 'Giovanni',
        updates: { requires_close_approval: false },
      });

      expect(r.success).toBe(false);
      expect(r.error).toContain('owning board');
      expect(db.prepare(`SELECT requires_close_approval FROM tasks WHERE board_id = ? AND id = ?`).get('board-parent-gio', taskId)).toEqual({ requires_close_approval: 1 });
    });

    it('approval-gated conclude from waiting clears waiting_for', () => {
      db.exec(
        `UPDATE tasks SET column = 'waiting', waiting_for = 'Client reply', requires_close_approval = 1 WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'conclude',
        sender_name: 'Giovanni',
      });

      expect(r.success).toBe(true);
      expect(r.to_column).toBe('review');
      expect(db.prepare(`SELECT waiting_for FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, 'T-002')).toEqual({ waiting_for: null });
    });

    it('invalid priority -> error', () => {
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { priority: 'critical' as any },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Invalid priority');
      expect(r.error).toContain('critical');
    });

    it('set due_date', () => {
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { due_date: '2026-12-31' },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Prazo definido: 2026-12-31');

      const task = engine.getTask('T-001');
      expect(task.due_date).toBe('2026-12-31');
    });

    it('remove due_date (null)', () => {
      // First set a due_date
      db.exec(
        `UPDATE tasks SET due_date = '2026-06-15' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { due_date: null },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Prazo removido');

      const task = engine.getTask('T-001');
      expect(task.due_date).toBeNull();
    });

    it('add label (idempotent)', () => {
      const r1 = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { add_label: 'frontend' },
      });
      expect(r1.success).toBe(true);
      expect(r1.changes).toContain('Etiqueta "frontend" adicionada');

      // Add same label again — should be idempotent, no duplicate
      const r2 = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { add_label: 'frontend' },
      });
      expect(r2.success).toBe(true);
      // No "added" change since it was already present
      expect(r2.changes!.some((c) => c.includes('frontend'))).toBe(false);

      const task = engine.getTask('T-001');
      const labels = JSON.parse(task.labels);
      // Only one instance of 'frontend'
      expect(labels.filter((l: string) => l === 'frontend')).toHaveLength(1);
    });

    it('remove label', () => {
      // Set up labels
      db.exec(
        `UPDATE tasks SET labels = '["frontend","backend"]' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { remove_label: 'frontend' },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Etiqueta "frontend" removida');

      const task = engine.getTask('T-001');
      const labels = JSON.parse(task.labels);
      expect(labels).toEqual(['backend']);
    });

    it('add note (auto-increment ID)', () => {
      const r1 = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { add_note: 'First note' },
      });
      expect(r1.success).toBe(true);
      expect(r1.changes).toContain('Nota: First note');

      const r2 = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { add_note: 'Second note' },
      });
      expect(r2.success).toBe(true);
      expect(r2.changes).toContain('Nota: Second note');

      const task = engine.getTask('T-001');
      const notes = JSON.parse(task.notes);
      expect(notes).toHaveLength(2);
      expect(notes[0].id).toBe(1);
      expect(notes[0].text).toBe('First note');
      expect(notes[0].by).toBe('Alexandre');
      expect(notes[1].id).toBe(2);
      expect(notes[1].text).toBe('Second note');
      expect(task.next_note_id).toBe(3);
    });

    it('edit note by ID', () => {
      // Seed a note
      db.exec(
        `UPDATE tasks SET notes = '[{"id":1,"text":"Original","at":"2026-01-01","by":"Alexandre"}]', next_note_id = 2
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { edit_note: { id: 1, text: 'Edited text' } },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Nota #1 editada: Edited text');

      const task = engine.getTask('T-001');
      const notes = JSON.parse(task.notes);
      expect(notes[0].text).toBe('Edited text');
    });

    it('remove note by ID', () => {
      // Seed two notes
      db.exec(
        `UPDATE tasks SET notes = '[{"id":1,"text":"Keep","at":"2026-01-01","by":"Alexandre"},{"id":2,"text":"Remove","at":"2026-01-01","by":"Alexandre"}]', next_note_id = 3
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { remove_note: 2 },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Nota #2 removida');

      const task = engine.getTask('T-001');
      const notes = JSON.parse(task.notes);
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe(1);
    });

    it('note not found -> error', () => {
      // edit_note on a task with no notes
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { edit_note: { id: 99, text: 'nope' } },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Note #99 not found');
    });

    it('description max 500 chars -> error', () => {
      const longDesc = 'x'.repeat(501);
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { description: longDesc },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('500 character limit');
    });

    it('permission: assignee can update', () => {
      // T-002 assigned to person-2 (Giovanni); Giovanni updates it
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-002',
        sender_name: 'Giovanni',
        updates: { title: 'Updated by assignee' },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Título alterado para "Updated by assignee"');
    });

    it('permission: manager can update any task', () => {
      // T-002 assigned to person-2 (Giovanni); Alexandre (manager) updates it
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-002',
        sender_name: 'Alexandre',
        updates: { priority: 'high' },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Prioridade: high');
    });

    it('permission: non-owner/non-manager -> denied', () => {
      // T-001 assigned to person-1 (Alexandre); Giovanni (not manager) tries to update
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Giovanni',
        updates: { title: 'Should fail' },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Permission denied');
    });

    it('records history', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { title: 'History test' },
      });

      const history = db
        .prepare(
          `SELECT * FROM task_history WHERE board_id = ? AND task_id = 'T-001' AND action = 'updated'`,
        )
        .all(BOARD_ID) as any[];
      expect(history).toHaveLength(1);
      expect(history[0].by).toBe('Alexandre');
      const details = JSON.parse(history[0].details);
      expect(details.changes).toContain('Título alterado para "History test"');
    });

    it('notification: update by non-assignee returns notification', () => {
      // T-002 assigned to person-2 (Giovanni), updated by Alexandre (person-1)
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-002',
        sender_name: 'Alexandre',
        updates: { priority: 'urgent' },
      });
      expect(r.success).toBe(true);
      expect(r.notifications).toHaveLength(1);
      expect(r.notifications![0].target_person_id).toBe('person-2');
      expect(r.notifications![0].message).toContain('T-002');
    });

    it('notification: self-update returns no notification', () => {
      // T-001 assigned to person-1 (Alexandre), updated by Alexandre
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { priority: 'low' },
      });
      expect(r.success).toBe(true);
      expect(r.notifications).toBeUndefined();
    });

    it('assign_subtask links the subtask to the assignee child board', () => {
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-gio')`,
      );
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-gio',
        personId: 'person-2',
        name: 'Giovanni',
      });
      engine.create({
        board_id: BOARD_ID,
        type: 'project',
        title: 'Sales follow-up',
        subtasks: ['Call Jimmy'],
        sender_name: 'Alexandre',
      });

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'P1',
        sender_name: 'Alexandre',
        updates: {
          assign_subtask: {
            id: 'P1.1',
            assignee: 'Giovanni',
          },
        },
      });

      expect(r.success).toBe(true);
      const subtask = db
        .prepare(
          `SELECT assignee, child_exec_enabled, child_exec_board_id, child_exec_person_id, "column"
           FROM tasks WHERE board_id = ? AND id = ?`,
        )
        .get(BOARD_ID, 'P1.1') as {
        assignee: string;
        child_exec_enabled: number;
        child_exec_board_id: string | null;
        child_exec_person_id: string | null;
        column: string;
      };
      expect(subtask).toEqual({
        assignee: 'person-2',
        child_exec_enabled: 1,
        child_exec_board_id: 'board-child-gio',
        child_exec_person_id: 'person-2',
        column: 'next_action',
      });

      const childEngine = new TaskflowEngine(db, 'board-child-gio');
      expect(childEngine.getTask('P1.1')?.id).toBe('P1.1');
    });

    // Pending: delegated subtask rename/reopen must write to the owning board
    // and history. Blocked on cross-board subtask visibility — the child engine
    // currently can't see parent task P1. Tracked in
    // docs/superpowers/plans/2026-04-09-cross-board-subtask-phase1.md.
    it.todo('delegated subtask rename and reopen write to the owning board and history');

    it('unassign_subtask clears child-board linkage', () => {
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-gio')`,
      );
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-gio',
        personId: 'person-2',
        name: 'Giovanni',
      });
      engine.create({
        board_id: BOARD_ID,
        type: 'project',
        title: 'Sales follow-up',
        subtasks: [{ title: 'Call Jimmy', assignee: 'Giovanni' }],
        sender_name: 'Alexandre',
      });

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'P1',
        sender_name: 'Alexandre',
        updates: {
          unassign_subtask: 'P1.1',
        },
      });

      expect(r.success).toBe(true);
      const subtask = db
        .prepare(
          `SELECT assignee, child_exec_enabled, child_exec_board_id, child_exec_person_id
           FROM tasks WHERE board_id = ? AND id = ?`,
        )
        .get(BOARD_ID, 'P1.1') as {
        assignee: string | null;
        child_exec_enabled: number;
        child_exec_board_id: string | null;
        child_exec_person_id: string | null;
      };
      expect(subtask).toEqual({
        assignee: null,
        child_exec_enabled: 0,
        child_exec_board_id: null,
        child_exec_person_id: null,
      });

      const childEngine = new TaskflowEngine(db, 'board-child-gio');
      expect(childEngine.getTask('P1.1')).toBeNull();
    });

    it('unassign_subtask on delegated subtask writes history to owning board', () => {
      // Regression: recordHistory was called without the taskBoardId argument,
      // so history for a cross-board subtask was incorrectly written to
      // this.boardId instead of the owning (parent) board.
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-unassign';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'parent-u@g.us', 'parent-unassign', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
         VALUES ('P-200', '${parentBoardId}', 'project', 'Parent project', 'person-1', 'in_progress', 1, 1, '${BOARD_ID}', 'person-1', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
         VALUES ('P-200.1', '${parentBoardId}', 'simple', 'Sub task', 'person-1', 'next_action', 'P-200', 0, 1, '${BOARD_ID}', 'person-1', '${now}', '${now}')`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'P-200',
        sender_name: 'Alexandre',
        updates: {
          unassign_subtask: 'P-200.1',
        },
      });

      expect(r.success).toBe(true);

      // History row for the subtask unassign must live on the OWNING board.
      const hist = db
        .prepare(
          `SELECT board_id FROM task_history WHERE task_id = ? AND action = 'unassigned'`,
        )
        .get('P-200.1') as { board_id: string } | undefined;
      expect(hist).toBeDefined();
      expect(hist?.board_id).toBe(parentBoardId);
    });

    it('assign_subtask on delegated project to person not on parent board → succeeds (delegation allowed)', () => {
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-sub';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'parent@g.us', 'parent-group', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
         VALUES ('P-100', '${parentBoardId}', 'project', 'Parent project', 'person-1', 'in_progress', 1, 1, '${BOARD_ID}', 'person-1', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
         VALUES ('P-100.1', '${parentBoardId}', 'simple', 'Sub task', 'person-1', 'next_action', 'P-100', 0, 1, '${BOARD_ID}', 'person-1', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO board_people VALUES ('${BOARD_ID}', 'person-ext', 'Reginaldo', '5585999990099', 'Analista', 3, NULL)`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'P-100',
        sender_name: 'Alexandre',
        updates: {
          assign_subtask: { id: 'P-100.1', assignee: 'Reginaldo' },
        },
      });

      expect(r.success).toBe(true);
      const sub = db
        .prepare(`SELECT assignee FROM tasks WHERE board_id = ? AND id = ?`)
        .get(parentBoardId, 'P-100.1') as any;
      expect(sub.assignee).toBe('person-ext');
    });

    it('query(task_details) resolves a parent-board meeting where a child-board person participates', () => {
      // Regression 2026-04-13: Ana Beatriz (on child board) typed "M1" to
      // see a meeting on Carlos's parent board with her as a participant.
      // task_details only checked local + delegated; meeting-participant
      // visibility existed for the prefixed-ID path but not the unprefixed
      // one. Fixed via getVisibleTask() which extends lookup to meetings
      // on ancestor boards.
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-mtg-visibility';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'parent-mv@g.us', 'parent-mv', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      // Link BOARD_ID as a child of the meeting's parent so lineage resolves.
      db.exec(
        `UPDATE boards SET parent_board_id = '${parentBoardId}' WHERE id = '${BOARD_ID}'`,
      );
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${BOARD_ID}', 'ana-beatriz', 'Ana Beatriz', '5585000000001', 'Dev', 3, NULL)`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, participants, created_at, updated_at)
         VALUES ('M-Visibility', '${parentBoardId}', 'meeting', 'Parent-board meeting', 'giovanni', 'next_action', 0, 0, '["ana-beatriz"]', '${now}', '${now}')`,
      );

      const r = engine.query({ query: 'task_details', task_id: 'M-Visibility' });
      expect(r.success).toBe(true);
      expect(r.data.task.id).toBe('M-Visibility');
      expect(r.data.task.board_id).toBe(parentBoardId);
      expect(r.data.task.type).toBe('meeting');
    });

    it('does NOT visibility-leak meetings from non-lineage boards (Codex B)', () => {
      // Guardrail against person_id collisions across unrelated boards:
      // 'ana-beatriz' may also exist on some completely unrelated board's
      // meeting. getVisibleTask() must restrict the fallback to ancestors
      // of this.boardId — i.e. this board's parent_board_id chain.
      const now = new Date().toISOString();
      const unrelated = 'board-unrelated';
      db.exec(
        `INSERT INTO boards VALUES ('${unrelated}', 'unrelated@g.us', 'unrelated-group', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      // BOARD_ID has NO parent link to 'unrelated'.
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${BOARD_ID}', 'ana-beatriz', 'Ana Beatriz', '5585000000001', 'Dev', 3, NULL)`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, participants, created_at, updated_at)
         VALUES ('M-OutOfScope', '${unrelated}', 'meeting', 'Stranger meeting', 'outsider', 'next_action', 0, 0, '["ana-beatriz"]', '${now}', '${now}')`,
      );

      const r = engine.query({ query: 'task_details', task_id: 'M-OutOfScope' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/not found/i);
    });

    it('prefers local simple task over a cross-board meeting with same ID', () => {
      // Ordering guardrail: getVisibleTask falls back ONLY after the local
      // and delegated lookups miss, so a real local task always wins.
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-collide';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'collide@g.us', 'collide-group', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      db.exec(
        `UPDATE boards SET parent_board_id = '${parentBoardId}' WHERE id = '${BOARD_ID}'`,
      );
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${BOARD_ID}', 'ana-beatriz', 'Ana Beatriz', '5585000000001', 'Dev', 3, NULL)`,
      );
      // Local simple task 'Z9'.
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES ('Z9', '${BOARD_ID}', 'simple', 'Local task', 'person-1', 'next_action', 1, '${now}', '${now}')`,
      );
      // Same-ID meeting on ancestor where ana-beatriz participates.
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, participants, created_at, updated_at)
         VALUES ('Z9', '${parentBoardId}', 'meeting', 'Distractor meeting', 'giovanni', 'next_action', 0, '["ana-beatriz"]', '${now}', '${now}')`,
      );

      const r = engine.query({ query: 'task_details', task_id: 'Z9' });
      expect(r.success).toBe(true);
      expect(r.data.task.board_id).toBe(BOARD_ID);
      expect(r.data.task.type).toBe('simple');
    });

    it('malformed participants JSON does not throw — query fails closed', () => {
      // isBoardMeetingParticipant wraps JSON.parse in try/catch so a
      // single bad row in a multi-row meeting scan does not abort the
      // whole request. The candidate is treated as "no local
      // participants" and we fall through to the next candidate (or
      // null). Verify by seeding garbage JSON in participants.
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-malformed';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'malformed@g.us', 'malformed-group', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      db.exec(
        `UPDATE boards SET parent_board_id = '${parentBoardId}' WHERE id = '${BOARD_ID}'`,
      );
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${BOARD_ID}', 'ana-beatriz', 'Ana Beatriz', '5585000000001', 'Dev', 3, NULL)`,
      );
      // Bad JSON in participants column.
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, participants, created_at, updated_at)
         VALUES ('M-Bad', '${parentBoardId}', 'meeting', 'Meeting with bad JSON', 'giovanni', 'next_action', 0, 0, 'not-valid-json{', '${now}', '${now}')`,
      );

      const r = engine.query({ query: 'task_details', task_id: 'M-Bad' });
      // Falls through to "not found" rather than throwing.
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/not found/i);
    });

    it('prefixed-ID write paths still rejected for participant-only access (Codex B/D follow-up)', () => {
      // First Codex review v2 caught that getTask() still honored
      // participant visibility on the prefixed-ID branch (e.g. SECI-M1
      // would resolve from a child board even with no delegation),
      // re-opening the cross-board mutation hole. Strict getTask() now
      // refuses prefixed-ID participant lookups; only getVisibleTask()
      // (read paths) honors them.
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-prefix-write';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'pp@g.us', 'pp', 'standard', 0, 1, NULL, 'PP', NULL)`,
      );
      db.exec(
        `UPDATE boards SET parent_board_id = '${parentBoardId}' WHERE id = '${BOARD_ID}'`,
      );
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${BOARD_ID}', 'ana-beatriz', 'Ana Beatriz', '5585000000001', 'Dev', 3, NULL)`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, participants, created_at, updated_at)
         VALUES ('M-PP', '${parentBoardId}', 'meeting', 'Prefixed meeting', 'giovanni', 'next_action', 0, 0, '["ana-beatriz"]', '${now}', '${now}')`,
      );

      // Read with prefix succeeds (participant on lineage board).
      const readR = engine.query({ query: 'task_details', task_id: 'PP-M-PP' });
      expect(readR.success).toBe(true);

      // Write with prefix fails — getTask() refuses.
      const updR = engine.update({
        board_id: BOARD_ID,
        task_id: 'PP-M-PP',
        sender_name: 'Ana Beatriz',
        updates: { add_note: 'Trying to mutate via prefix' },
      });
      expect(updR.success).toBe(false);
      expect(updR.error).toMatch(/not found/i);
    });

    it('mutation paths stay strict — participant cannot update a cross-board meeting (Codex D)', () => {
      // Visibility is a read-only concession. update()/move()/dependency
      // must keep using getTask(), which does NOT honor participant
      // visibility. A child-board participant trying to update meeting
      // state on the parent board gets "Task not found" and no mutation.
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-mtg-write';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'pw@g.us', 'pw', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      db.exec(
        `UPDATE boards SET parent_board_id = '${parentBoardId}' WHERE id = '${BOARD_ID}'`,
      );
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${BOARD_ID}', 'ana-beatriz', 'Ana Beatriz', '5585000000001', 'Dev', 3, NULL)`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, participants, scheduled_at, created_at, updated_at)
         VALUES ('M-ReadOnly', '${parentBoardId}', 'meeting', 'Parent meeting', 'giovanni', 'next_action', 0, 0, '["ana-beatriz"]', '2026-05-01T14:00:00.000Z', '${now}', '${now}')`,
      );

      // Read is visible (via task_details).
      expect(
        engine.query({ query: 'task_details', task_id: 'M-ReadOnly' }).success,
      ).toBe(true);

      // Write is rejected — update() uses the strict getTask().
      const updR = engine.update({
        board_id: BOARD_ID,
        task_id: 'M-ReadOnly',
        sender_name: 'Ana Beatriz',
        updates: { add_note: 'Ana tried to mutate this' },
      });
      expect(updR.success).toBe(false);
      expect(updR.error).toMatch(/not found/i);

      // Move also rejected.
      const movR = engine.move({
        board_id: BOARD_ID,
        task_id: 'M-ReadOnly',
        action: 'work',
        sender_name: 'Ana Beatriz',
      });
      expect(movR.success).toBe(false);
      expect(movR.error).toMatch(/not found/i);
    });

    it('add_participant on delegated meeting to person not on parent board → succeeds (delegation allowed)', () => {
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-mtg';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'parent@g.us', 'parent-group-mtg', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id, participants, created_at, updated_at)
         VALUES ('M-100', '${parentBoardId}', 'meeting', 'Team sync', 'person-1', 'next_action', 1, 1, '${BOARD_ID}', 'person-1', '[]', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${BOARD_ID}', 'person-ext', 'Reginaldo', '5585999990099', 'Analista', 3, NULL)`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'M-100',
        sender_name: 'Alexandre',
        updates: {
          add_participant: 'Reginaldo',
        },
      });

      expect(r.success).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  weekday guard (intended_weekday)                                 */
  /* ---------------------------------------------------------------- */

  describe('weekday guard', () => {
    // In America/Fortaleza (board default), 2026-04-16 is Thursday, 17 is Friday.

    it('rejects taskflow_create meeting when intended_weekday disagrees with scheduled_at', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Alinhamento',
        scheduled_at: '2026-04-17T11:00:00', // Friday
        intended_weekday: 'quinta-feira',    // user asked for Thursday
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(false);
      expect(r.error).toMatch(/weekday_mismatch/);
      expect(r.error).toMatch(/quinta-feira/);
      expect(r.error).toMatch(/sexta-feira/);
    });

    it('accepts taskflow_create when intended_weekday matches', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Alinhamento',
        scheduled_at: '2026-04-16T11:00:00', // Thursday
        intended_weekday: 'quinta-feira',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      expect(r.task_id).toMatch(/^M/);
    });

    it('accepts create when intended_weekday is omitted (opt-in guard)', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Alinhamento',
        scheduled_at: '2026-04-17T11:00:00',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
    });

    it('accepts create when intended_weekday is an unknown label (graceful skip)', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Alinhamento',
        scheduled_at: '2026-04-17T11:00:00',
        intended_weekday: 'gibberish-day',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
    });

    it('rejects taskflow_update scheduled_at when intended_weekday disagrees (Giovanni regression)', () => {
      // Seed a meeting to update.
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, scheduled_at, created_at, updated_at)
         VALUES ('M-Guard', '${BOARD_ID}', 'meeting', 'Reunião', 'person-1', 'next_action', 0, '2026-04-20T14:00:00.000Z', '${now}', '${now}')`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'M-Guard',
        sender_name: 'Alexandre',
        updates: {
          scheduled_at: '2026-04-17T11:00:00', // Friday
          intended_weekday: 'quinta-feira',    // user said Thursday
        },
      });

      expect(r.success).toBe(false);
      expect(r.error).toMatch(/weekday_mismatch/);
    });

    it('accepts taskflow_update when intended_weekday matches the new scheduled_at', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, scheduled_at, created_at, updated_at)
         VALUES ('M-Guard-OK', '${BOARD_ID}', 'meeting', 'Reunião', 'person-1', 'next_action', 0, '2026-04-20T14:00:00.000Z', '${now}', '${now}')`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'M-Guard-OK',
        sender_name: 'Alexandre',
        updates: {
          scheduled_at: '2026-04-16T11:00:00',
          intended_weekday: 'quinta',
        },
      });

      expect(r.success).toBe(true);
    });

    it('rejects create task when intended_weekday disagrees with due_date', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Entrega',
        due_date: '2026-04-17', // Friday
        intended_weekday: 'quinta-feira',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(false);
      expect(r.error).toMatch(/weekday_mismatch/);
    });

    it('rejects at the board-timezone boundary (UTC-only evaluation would pass)', () => {
      // 2026-04-17T02:00:00 local (Fortaleza, UTC-3) is still Friday locally
      // but in UTC is 2026-04-17T05:00:00Z — same day, but evaluating weekday
      // on the raw local string must use board tz.
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Dawn meeting',
        scheduled_at: '2026-04-17T02:00:00',
        intended_weekday: 'quinta-feira',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(false);
      expect(r.error).toMatch(/weekday_mismatch/);
    });

    it('DST round-trip: fall-back, unambiguous, and spring-forward gap in America/New_York', () => {
      const dstBoardId = 'board-dst-rt';
      db.exec(
        `INSERT INTO boards VALUES ('${dstBoardId}', 'dst2@g.us', 'dst2', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      db.exec(
        `INSERT INTO board_config VALUES ('${dstBoardId}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 1, 1, 1, 1)`,
      );
      db.exec(
        `INSERT INTO board_runtime_config (board_id, timezone) VALUES ('${dstBoardId}', 'America/New_York')`,
      );
      db.exec(
        `INSERT INTO board_people VALUES ('${dstBoardId}', 'person-1', 'Alexandre', '5585999990001', 'Gestor', 3, NULL)`,
      );
      db.exec(
        `INSERT INTO board_admins VALUES ('${dstBoardId}', 'person-1', '5585999990001', 'manager', 1)`,
      );

      const dstEngine = new TaskflowEngine(db, dstBoardId);

      const storedScheduledAt = (taskId: string): string => {
        const row = db
          .prepare(`SELECT scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
          .get(dstBoardId, taskId) as { scheduled_at: string };
        return row.scheduled_at;
      };

      // --- Case 1: Fall-back 02:30 Nov 1 (ambiguous, after transition → EST UTC-5) ---
      const r1 = dstEngine.create({
        board_id: dstBoardId,
        type: 'meeting',
        title: 'Post fall-back',
        scheduled_at: '2026-11-01T02:30:00',
        allow_non_business_day: true,
        sender_name: 'Alexandre',
      });
      expect(r1.success).toBe(true);
      // 02:30 EST = 07:30Z (NOT 06:30Z which would be 01:30 EST — the pre-fix bug)
      expect(storedScheduledAt(r1.task_id!)).toBe('2026-11-01T07:30:00.000Z');

      // --- Case 2: Unambiguous 09:00 Nov 2 (well after fall-back, EST UTC-5) ---
      const r2 = dstEngine.create({
        board_id: dstBoardId,
        type: 'meeting',
        title: 'Morning after',
        scheduled_at: '2026-11-02T09:00:00',
        sender_name: 'Alexandre',
      });
      // 2026-11-02 is a Monday — business day.
      expect(r2.success).toBe(true);
      expect(storedScheduledAt(r2.task_id!)).toBe('2026-11-02T14:00:00.000Z');

      // --- Case 3: Spring-forward gap 02:30 Mar 8 (non-existent — round forward to EDT) ---
      const r3 = dstEngine.create({
        board_id: dstBoardId,
        type: 'meeting',
        title: 'Spring-forward gap',
        scheduled_at: '2026-03-08T02:30:00',
        allow_non_business_day: true, // 2026-03-08 is a Sunday
        sender_name: 'Alexandre',
      });
      expect(r3.success).toBe(true);
      // Nonexistent 02:30 EST rolls forward into the EDT period — the local
      // wall-clock that actually exists is 03:30 EDT = 07:30Z.
      expect(storedScheduledAt(r3.task_id!)).toBe('2026-03-08T07:30:00.000Z');

      // --- Case 4: Ambiguous 01:30 Nov 1 (occurs twice — pick first/EDT) ---
      const r4 = dstEngine.create({
        board_id: dstBoardId,
        type: 'meeting',
        title: 'Fall-back first occurrence',
        scheduled_at: '2026-11-01T01:30:00',
        allow_non_business_day: true,
        sender_name: 'Alexandre',
      });
      expect(r4.success).toBe(true);
      // 01:30 EDT = 05:30Z (first of two occurrences)
      expect(storedScheduledAt(r4.task_id!)).toBe('2026-11-01T05:30:00.000Z');
    });

    it('rejects meeting scheduled on a Saturday without allow_non_business_day', () => {
      // 2026-04-18 is a Saturday.
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Weekend meeting',
        scheduled_at: '2026-04-18T10:00:00',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(false);
      expect(r.non_business_day_warning).toBe(true);
      expect(r.original_date).toBe('2026-04-18');
      expect(r.error).toMatch(/Meeting date/);
      expect(r.error).toMatch(/sábado/);
      expect(r.suggested_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('accepts weekend meeting when allow_non_business_day is explicit', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Intentional saturday',
        scheduled_at: '2026-04-18T10:00:00',
        allow_non_business_day: true,
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
      expect(r.task_id).toMatch(/^M/);
    });

    it('rejects meeting scheduled on a registered holiday', () => {
      // Register a holiday via the engine's own admin path (also primes the cache).
      db.exec(
        `CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT, holiday_date TEXT, label TEXT, PRIMARY KEY (board_id, holiday_date))`,
      );
      db.exec(
        `INSERT OR REPLACE INTO board_holidays (board_id, holiday_date, label) VALUES ('${BOARD_ID}', '2026-04-15', 'Aniversário da cidade')`,
      );
      // 2026-04-15 is a Wednesday (not a weekend) so only the holiday triggers.
      engine = new TaskflowEngine(db, BOARD_ID);

      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'On a holiday',
        scheduled_at: '2026-04-15T10:00:00',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(false);
      expect(r.non_business_day_warning).toBe(true);
      expect(r.reason).toMatch(/feriado/);
    });

    it('rejects update that reschedules meeting onto a Sunday', () => {
      // 2026-04-19 is a Sunday.
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, scheduled_at, created_at, updated_at)
         VALUES ('M-Weekend', '${BOARD_ID}', 'meeting', 'Reunião', 'person-1', 'next_action', 0, '2026-04-20T14:00:00.000Z', '${now}', '${now}')`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'M-Weekend',
        sender_name: 'Alexandre',
        updates: {
          scheduled_at: '2026-04-19T10:00:00',
        },
      });

      expect(r.success).toBe(false);
      expect(r.non_business_day_warning).toBe(true);
      expect(r.error).toMatch(/domingo/);
    });

    it('UTC-suffixed scheduled_at is checked using BOARD-LOCAL calendar date, not the lexical prefix', () => {
      // 2026-04-18T02:00:00Z is Saturday in UTC but FRIDAY local in Fortaleza (UTC-3):
      // 02:00Z - 3h = 23:00 local on 2026-04-17 (Friday). The guard should use
      // the local date (Fri) and accept, not the lexical prefix (Sat) and reject.
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Late Friday briefing',
        scheduled_at: '2026-04-18T02:00:00Z',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);
    });

    it('UTC-suffixed scheduled_at IS rejected when the local calendar date is actually a weekend', () => {
      // 2026-04-19T10:00:00Z is Sunday in UTC AND Sunday local in Fortaleza
      // (10:00Z - 3h = 07:00 local Sunday). Guard must fire.
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Sunday morning call',
        scheduled_at: '2026-04-19T10:00:00Z',
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(false);
      expect(r.non_business_day_warning).toBe(true);
      expect(r.original_date).toBe('2026-04-19');
    });

    it('recurring meeting anchored on a weekend with explicit allow_non_business_day succeeds', () => {
      // 2026-04-18 is a Saturday. With an explicit opt-in the weekly recurrence
      // should be accepted and subsequent cycle advances should advance from
      // the Saturday anchor (so the next occurrence is the following Saturday).
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Weekend weekly standup',
        scheduled_at: '2026-04-18T09:00:00',
        recurrence: 'weekly',
        allow_non_business_day: true,
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(true);

      const stored = db
        .prepare(`SELECT scheduled_at, recurrence, recurrence_anchor FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, r.task_id!) as { scheduled_at: string; recurrence: string; recurrence_anchor: string };
      expect(stored.recurrence).toBe('weekly');
      // 09:00 local Fortaleza → 12:00Z
      expect(stored.scheduled_at).toBe('2026-04-18T12:00:00.000Z');
      expect(stored.recurrence_anchor).toBe('2026-04-18T12:00:00.000Z');
    });

    it('non-meeting tasks with due_date still use the "Due date" label (back-compat)', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Weekend deadline',
        due_date: '2026-04-18', // Saturday
        sender_name: 'Alexandre',
      });

      expect(r.success).toBe(false);
      expect(r.non_business_day_warning).toBe(true);
      expect(r.error).toMatch(/Due date/);
      expect(r.error).not.toMatch(/Meeting date/);
    });

    it('honors weekday across DST fall-back in America/New_York', () => {
      // Seed a board pinned to a DST-observing zone. 2026-11-01 is DST fall-back
      // Sunday in New York (02:00 EDT → 01:00 EST). 01:30 local is Sunday
      // regardless of which side of the overlap it resolves to.
      const dstBoardId = 'board-dst-test';
      db.exec(
        `INSERT INTO boards VALUES ('${dstBoardId}', 'dst@g.us', 'dst', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      db.exec(
        `INSERT INTO board_config VALUES ('${dstBoardId}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 1, 1, 1, 1)`,
      );
      db.exec(
        `INSERT INTO board_runtime_config (board_id, timezone) VALUES ('${dstBoardId}', 'America/New_York')`,
      );
      db.exec(
        `INSERT INTO board_people VALUES ('${dstBoardId}', 'person-1', 'Alexandre', '5585999990001', 'Gestor', 3, NULL)`,
      );
      db.exec(
        `INSERT INTO board_admins VALUES ('${dstBoardId}', 'person-1', '5585999990001', 'manager', 1)`,
      );

      const dstEngine = new TaskflowEngine(db, dstBoardId);

      const matches = dstEngine.create({
        board_id: dstBoardId,
        type: 'meeting',
        title: 'Fall-back Sunday call',
        scheduled_at: '2026-11-01T01:30:00',
        intended_weekday: 'sunday',
        allow_non_business_day: true,
        sender_name: 'Alexandre',
      });
      expect(matches.success).toBe(true);

      const mismatches = dstEngine.create({
        board_id: dstBoardId,
        type: 'meeting',
        title: 'Wrong weekday on fall-back',
        scheduled_at: '2026-11-01T01:30:00',
        intended_weekday: 'monday',
        allow_non_business_day: true,
        sender_name: 'Alexandre',
      });
      expect(mismatches.success).toBe(false);
      expect(mismatches.error).toMatch(/weekday_mismatch/);
    });
  });

  describe('legacy project subtask migration', () => {
    it('migrates JSON subtasks into real rows that the child board can conclude', () => {
      const legacyDb = new Database(':memory:');
      legacyDb.exec(`
        CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, board_role TEXT DEFAULT 'standard', hierarchy_level INTEGER, max_depth INTEGER, parent_board_id TEXT, short_code TEXT);
ALTER TABLE boards ADD COLUMN owner_person_id TEXT;
        CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, role TEXT DEFAULT 'member', wip_limit INTEGER, notification_group_jid TEXT, PRIMARY KEY (board_id, person_id));
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
          subtasks TEXT,
          recurrence TEXT,
          current_cycle TEXT,
          PRIMARY KEY (board_id, id)
        );
        CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
        CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
        CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza');
        CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
        CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 17, next_note_id INTEGER DEFAULT 1);

        INSERT INTO boards VALUES ('board-parent', 'parent@g.us', 'parent', 'standard', 0, 1, NULL, NULL, NULL);
        INSERT INTO boards VALUES ('board-rafael', 'rafael@g.us', 'rafael', 'standard', 1, 1, 'board-parent', NULL, NULL);
        INSERT INTO board_config VALUES ('board-parent', '["inbox","next_action","in_progress","waiting","review","done"]', 5, 17, 1);
        INSERT INTO board_config VALUES ('board-rafael', '["inbox","next_action","in_progress","waiting","review","done"]', 5, 1, 1);
        INSERT INTO board_runtime_config (board_id) VALUES ('board-parent');
        INSERT INTO board_runtime_config (board_id) VALUES ('board-rafael');
        INSERT INTO board_people VALUES ('board-parent', 'person-1', 'Alexandre', NULL, 'Gestor', 3, NULL);
        INSERT INTO board_people VALUES ('board-parent', 'rafael', 'Rafael', NULL, 'Dev', 3, NULL);
        INSERT INTO board_people VALUES ('board-rafael', 'rafael', 'Rafael', NULL, 'Dev', 3, NULL);
        INSERT INTO board_admins VALUES ('board-parent', 'person-1', '5585999990001', 'manager', 1);
        INSERT INTO board_admins VALUES ('board-rafael', 'rafael', '5585999990008', 'manager', 1);
        INSERT INTO child_board_registrations VALUES ('board-parent', 'rafael', 'board-rafael');
        INSERT INTO tasks (id, board_id, type, title, assignee, column, subtasks, created_at, updated_at)
        VALUES (
          'P16',
          'board-parent',
          'project',
          'Legacy project',
          'person-1',
          'next_action',
          '[{"id":"P16.1","title":"Preparar resumo","column":"done","assignee":"person-1"},{"id":"P16.2","title":"Call Jimmy","column":"next_action","assignee":"rafael"}]',
          '2026-03-06T12:39:17Z',
          '2026-03-06T12:39:17Z'
        );
      `);

      const parentEngine = new TaskflowEngine(legacyDb, 'board-parent');
      const childEngine = new TaskflowEngine(legacyDb, 'board-rafael');

      const migrated = legacyDb
        .prepare(
          `SELECT parent_task_id, child_exec_enabled, child_exec_board_id, child_exec_person_id
           FROM tasks WHERE board_id = ? AND id = ?`,
        )
        .get('board-parent', 'P16.2') as {
        parent_task_id: string;
        child_exec_enabled: number;
        child_exec_board_id: string | null;
        child_exec_person_id: string | null;
      };
      expect(migrated).toEqual({
        parent_task_id: 'P16',
        child_exec_enabled: 1,
        child_exec_board_id: 'board-rafael',
        child_exec_person_id: 'rafael',
      });
      expect(childEngine.getTask('P16.2')?.id).toBe('P16.2');
      legacyDb.exec(
        `UPDATE tasks SET requires_close_approval = 0 WHERE board_id = 'board-parent' AND id = 'P16.2'`,
      );

      const moveResult = childEngine.move({
        board_id: 'board-rafael',
        task_id: 'P16.2',
        action: 'conclude',
        sender_name: 'Rafael',
      });
      expect(moveResult.success).toBe(true);
      expect(parentEngine.getTask('P16.2')?.column).toBe('done');

      const parent = legacyDb
        .prepare(`SELECT subtasks FROM tasks WHERE board_id = ? AND id = ?`)
        .get('board-parent', 'P16') as { subtasks: string | null };
      expect(parent.subtasks).toBeNull();

      legacyDb.close();
    });

    it('reconciles pre-existing subtask rows and restores migrated projects with children', () => {
      const legacyDb = new Database(':memory:');
      legacyDb.exec(`
        CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, board_role TEXT DEFAULT 'standard', hierarchy_level INTEGER, max_depth INTEGER, parent_board_id TEXT, short_code TEXT);
ALTER TABLE boards ADD COLUMN owner_person_id TEXT;
        CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, role TEXT DEFAULT 'member', wip_limit INTEGER, notification_group_jid TEXT, PRIMARY KEY (board_id, person_id));
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
          subtasks TEXT,
          recurrence TEXT,
          current_cycle TEXT,
          PRIMARY KEY (board_id, id)
        );
        CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
        CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
        CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza');
        CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
        CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 17, next_note_id INTEGER DEFAULT 1);

        INSERT INTO boards VALUES ('board-parent', 'parent@g.us', 'parent', 'standard', 0, 1, NULL, NULL, NULL);
        INSERT INTO boards VALUES ('board-rafael', 'rafael@g.us', 'rafael', 'standard', 1, 1, 'board-parent', NULL, NULL);
        INSERT INTO board_config VALUES ('board-parent', '["inbox","next_action","in_progress","waiting","review","done"]', 5, 17, 1);
        INSERT INTO board_config VALUES ('board-rafael', '["inbox","next_action","in_progress","waiting","review","done"]', 5, 1, 1);
        INSERT INTO board_runtime_config (board_id) VALUES ('board-parent');
        INSERT INTO board_runtime_config (board_id) VALUES ('board-rafael');
        INSERT INTO board_people VALUES ('board-parent', 'person-1', 'Alexandre', NULL, 'Gestor', 3, NULL);
        INSERT INTO board_people VALUES ('board-parent', 'rafael', 'Rafael', NULL, 'Dev', 3, NULL);
        INSERT INTO board_people VALUES ('board-rafael', 'rafael', 'Rafael', NULL, 'Dev', 3, NULL);
        INSERT INTO board_admins VALUES ('board-parent', 'person-1', '5585999990001', 'manager', 1);
        INSERT INTO board_admins VALUES ('board-rafael', 'rafael', '5585999990008', 'manager', 1);
        INSERT INTO child_board_registrations VALUES ('board-parent', 'rafael', 'board-rafael');
        INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, subtasks, created_at, updated_at)
        VALUES (
          'P16',
          'board-parent',
          'project',
          'Legacy project',
          'person-1',
          'next_action',
          0,
          '[{"id":"P16.1","title":"Preparar resumo","column":"done","assignee":"person-1"},{"id":"P16.2","title":"Call Jimmy","column":"next_action","assignee":"rafael"}]',
          '2026-03-06T12:39:17Z',
          '2026-03-06T12:39:17Z'
        );
        INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, created_at, updated_at)
        VALUES ('P16.2', 'board-parent', 'simple', 'Wrong title', NULL, 'inbox', 1, 0, '2026-03-06T12:39:17Z', '2026-03-06T12:39:17Z');
      `);

      const parentEngine = new TaskflowEngine(legacyDb, 'board-parent');
      const childEngine = new TaskflowEngine(legacyDb, 'board-rafael');

      const migrated = legacyDb
        .prepare(
          `SELECT title, parent_task_id, assignee, "column", child_exec_enabled, child_exec_board_id, child_exec_person_id
           FROM tasks WHERE board_id = ? AND id = ?`,
        )
        .get('board-parent', 'P16.2') as {
        title: string;
        parent_task_id: string;
        assignee: string | null;
        column: string;
        child_exec_enabled: number;
        child_exec_board_id: string | null;
        child_exec_person_id: string | null;
      };
      expect(migrated).toEqual({
        title: 'Call Jimmy',
        parent_task_id: 'P16',
        assignee: 'rafael',
        column: 'next_action',
        child_exec_enabled: 1,
        child_exec_board_id: 'board-rafael',
        child_exec_person_id: 'rafael',
      });

      const cancelResult = parentEngine.admin({
        board_id: 'board-parent',
        action: 'cancel_task',
        sender_name: 'Alexandre',
        task_id: 'P16',
      });
      expect(cancelResult.success).toBe(true);
      expect(parentEngine.getTask('P16.1')).toBeNull();
      expect(parentEngine.getTask('P16.2')).toBeNull();

      const restoreResult = parentEngine.admin({
        board_id: 'board-parent',
        action: 'restore_task',
        sender_name: 'Alexandre',
        task_id: 'P16',
      });
      expect(restoreResult.success).toBe(true);
      expect(parentEngine.getTask('P16')?.title).toBe('Legacy project');
      expect(parentEngine.getTask('P16.1')?.parent_task_id).toBe('P16');
      expect(parentEngine.getTask('P16.2')?.parent_task_id).toBe('P16');
      expect(childEngine.getTask('P16.2')?.id).toBe('P16.2');

      legacyDb.close();
    });

    it('reconciles existing real subtask rows even when parent legacy JSON is already empty', () => {
      const legacyDb = new Database(':memory:');
      legacyDb.exec(`
        ${SCHEMA}
      `);
      legacyDb.exec(
        `INSERT INTO boards VALUES ('board-sec-taskflow', 'sec@g.us', 'sec', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO boards VALUES ('board-setec-secti-taskflow', 'setec@g.us', 'setec', 'standard', 1, 1, 'board-sec-taskflow', NULL, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO board_config VALUES ('board-sec-taskflow', '["inbox","next_action","in_progress","waiting","review","done"]', 5, 17, 1, 1, 1)`,
      );
      legacyDb.exec(
        `INSERT INTO board_config VALUES ('board-setec-secti-taskflow', '["inbox","next_action","in_progress","waiting","review","done"]', 5, 1, 1, 1, 1)`,
      );
      legacyDb.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('board-sec-taskflow')`);
      legacyDb.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('board-setec-secti-taskflow')`);
      legacyDb.exec(
        `INSERT INTO board_people VALUES ('board-sec-taskflow', 'miguel', 'Miguel', NULL, 'Gestor', 3, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO board_people VALUES ('board-sec-taskflow', 'rafael', 'Rafael', NULL, 'Dev', 3, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO board_people VALUES ('board-setec-secti-taskflow', 'rafael', 'Rafael', NULL, 'Dev', 3, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO board_admins VALUES ('board-sec-taskflow', 'miguel', '5585999990001', 'manager', 1)`,
      );
      legacyDb.exec(
        `INSERT INTO board_admins VALUES ('board-setec-secti-taskflow', 'rafael', '5585999990002', 'manager', 1)`,
      );
      legacyDb.exec(
        `INSERT INTO child_board_registrations VALUES ('board-sec-taskflow', 'rafael', 'board-setec-secti-taskflow')`,
      );
      legacyDb.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, "column", created_at, updated_at)
         VALUES ('P16', 'board-sec-taskflow', 'project', 'Acesso ao Spia', 'miguel', 'next_action', '2026-03-06T12:39:17Z', '2026-03-06T12:39:17Z')`,
      );
      legacyDb.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, "column", requires_close_approval, parent_task_id, child_exec_enabled, created_at, updated_at)
         VALUES ('P16.2', 'board-sec-taskflow', 'simple', 'Confirmar com o Jimmy', 'rafael', 'next_action', 0, 'P16', 0, '2026-03-06T12:39:17Z', '2026-03-06T12:39:17Z')`,
      );

      const parentEngine = new TaskflowEngine(legacyDb, 'board-sec-taskflow');
      const childEngine = new TaskflowEngine(legacyDb, 'board-setec-secti-taskflow');

      const row = legacyDb
        .prepare(
          `SELECT child_exec_enabled, child_exec_board_id, child_exec_person_id
           FROM tasks WHERE board_id = ? AND id = ?`,
        )
        .get('board-sec-taskflow', 'P16.2') as {
        child_exec_enabled: number;
        child_exec_board_id: string | null;
        child_exec_person_id: string | null;
      };
      expect(row).toEqual({
        child_exec_enabled: 1,
        child_exec_board_id: 'board-setec-secti-taskflow',
        child_exec_person_id: 'rafael',
      });
      expect(childEngine.getTask('P16.2')?.id).toBe('P16.2');

      const move = childEngine.move({
        board_id: 'board-setec-secti-taskflow',
        task_id: 'P16.2',
        action: 'conclude',
        sender_name: 'Rafael',
      });
      expect(move.success).toBe(true);
      expect(parentEngine.getTask('P16.2')?.column).toBe('done');

      legacyDb.close();
    });

    it('reconciles pre-existing recurring tasks with delegated child-board linkage', () => {
      const legacyDb = new Database(':memory:');
      legacyDb.exec(`
        ${SCHEMA}
      `);
      legacyDb.exec(
        `INSERT INTO boards VALUES ('board-sec-taskflow', 'sec@g.us', 'sec', 'standard', 0, 1, NULL, NULL, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO boards VALUES ('board-setec-secti-taskflow', 'setec@g.us', 'setec', 'standard', 1, 1, 'board-sec-taskflow', NULL, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO board_config VALUES ('board-sec-taskflow', '["inbox","next_action","in_progress","waiting","review","done"]', 5, 17, 1, 1, 1)`,
      );
      legacyDb.exec(
        `INSERT INTO board_config VALUES ('board-setec-secti-taskflow', '["inbox","next_action","in_progress","waiting","review","done"]', 5, 1, 1, 1, 1)`,
      );
      legacyDb.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('board-sec-taskflow')`);
      legacyDb.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('board-setec-secti-taskflow')`);
      legacyDb.exec(
        `INSERT INTO board_people VALUES ('board-sec-taskflow', 'miguel', 'Miguel', NULL, 'Gestor', 3, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO board_people VALUES ('board-sec-taskflow', 'rafael', 'Rafael', NULL, 'Dev', 3, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO board_people VALUES ('board-setec-secti-taskflow', 'rafael', 'Rafael', NULL, 'Dev', 3, NULL)`,
      );
      legacyDb.exec(
        `INSERT INTO board_admins VALUES ('board-sec-taskflow', 'miguel', '5585999990001', 'manager', 1)`,
      );
      legacyDb.exec(
        `INSERT INTO board_admins VALUES ('board-setec-secti-taskflow', 'rafael', '5585999990002', 'manager', 1)`,
      );
      legacyDb.exec(
        `INSERT INTO child_board_registrations VALUES ('board-sec-taskflow', 'rafael', 'board-setec-secti-taskflow')`,
      );
      legacyDb.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, "column", recurrence, child_exec_enabled, created_at, updated_at)
         VALUES ('R18', 'board-sec-taskflow', 'recurring', 'Monthly report', 'rafael', 'next_action', 'monthly', 0, '2026-03-06T12:39:17Z', '2026-03-06T12:39:17Z')`,
      );

      new TaskflowEngine(legacyDb, 'board-sec-taskflow');
      const childEngine = new TaskflowEngine(legacyDb, 'board-setec-secti-taskflow');

      const row = legacyDb
        .prepare(
          `SELECT child_exec_enabled, child_exec_board_id, child_exec_person_id
           FROM tasks WHERE board_id = ? AND id = ?`,
        )
        .get('board-sec-taskflow', 'R18') as {
        child_exec_enabled: number;
        child_exec_board_id: string | null;
        child_exec_person_id: string | null;
      };
      expect(row).toEqual({
        child_exec_enabled: 1,
        child_exec_board_id: 'board-setec-secti-taskflow',
        child_exec_person_id: 'rafael',
      });
      expect(childEngine.getTask('R18')?.id).toBe('R18');

      legacyDb.close();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  dependency                                                       */
  /* ---------------------------------------------------------------- */

  describe('dependency', () => {
    it('add dependency happy path', () => {
      // T-001 depends on T-002
      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-001',
        target_task_id: 'T-002',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.task_id).toBe('T-001');
      expect(r.change).toContain('blocked by T-002');

      // Verify in DB
      const task = engine.getTask('T-001');
      const blockedBy = JSON.parse(task.blocked_by);
      expect(blockedBy).toContain('T-002');

      // Verify history recorded
      const history = db
        .prepare(
          `SELECT * FROM task_history WHERE board_id = ? AND task_id = 'T-001' AND action = 'dep_added'`,
        )
        .all(BOARD_ID) as any[];
      expect(history).toHaveLength(1);
      expect(history[0].by).toBe('Alexandre');
    });

    it('circular dependency detection (A→B→A)', () => {
      // First: T-001 depends on T-002 (T-001 blocked by T-002)
      const r1 = engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-001',
        target_task_id: 'T-002',
        sender_name: 'Alexandre',
      });
      expect(r1.success).toBe(true);

      // Now try: T-002 depends on T-001 (T-002 blocked by T-001) → should fail (cycle)
      const r2 = engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-002',
        target_task_id: 'T-001',
        sender_name: 'Alexandre',
      });
      expect(r2.success).toBe(false);
      expect(r2.error).toContain('Circular dependency');
    });

    it('transitive circular dependency detection (A→B→C→A)', () => {
      // T-001 blocked by T-002
      engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-001',
        target_task_id: 'T-002',
        sender_name: 'Alexandre',
      });
      // T-002 blocked by T-003
      engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-002',
        target_task_id: 'T-003',
        sender_name: 'Alexandre',
      });
      // Now try: T-003 blocked by T-001 → should fail (cycle: T-003→T-001→T-002→T-003)
      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-003',
        target_task_id: 'T-001',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Circular dependency');
    });

    it('self-dependency → error', () => {
      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-001',
        target_task_id: 'T-001',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('cannot depend on itself');
    });

    it('duplicate dependency → error', () => {
      engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-001',
        target_task_id: 'T-002',
        sender_name: 'Alexandre',
      });
      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-001',
        target_task_id: 'T-002',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Duplicate dependency');
    });

    it('remove dependency happy path', () => {
      // First add
      engine.dependency({
        board_id: BOARD_ID,
        action: 'add_dep',
        task_id: 'T-001',
        target_task_id: 'T-002',
        sender_name: 'Alexandre',
      });

      // Then remove
      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'remove_dep',
        task_id: 'T-001',
        target_task_id: 'T-002',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.change).toContain('no longer blocked by T-002');

      // Verify in DB
      const task = engine.getTask('T-001');
      const blockedBy = JSON.parse(task.blocked_by);
      expect(blockedBy).not.toContain('T-002');
    });

    it('remove non-existent dependency → error', () => {
      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'remove_dep',
        task_id: 'T-001',
        target_task_id: 'T-002',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Dependency not found');
    });

    it('add reminder happy path', () => {
      // First set a due date on T-001
      engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { due_date: '2026-04-15' },
      });

      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'add_reminder',
        task_id: 'T-001',
        reminder_days: 3,
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.change).toContain('3 day(s) before due date');
      expect(r.change).toContain('2026-04-12');

      // Verify stored in DB
      const task = engine.getTask('T-001');
      const reminders = JSON.parse(task.reminders);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].days).toBe(3);
      expect(reminders[0].date).toBe('2026-04-12');
    });

    it('reminder without due_date → error', () => {
      // T-003 has no due_date
      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'add_reminder',
        task_id: 'T-003',
        reminder_days: 2,
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('no due date');
    });

    it('remove reminder', () => {
      // Set due date and add a reminder first
      engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { due_date: '2026-04-15' },
      });
      engine.dependency({
        board_id: BOARD_ID,
        action: 'add_reminder',
        task_id: 'T-001',
        reminder_days: 3,
        sender_name: 'Alexandre',
      });

      // Now remove all reminders
      const r = engine.dependency({
        board_id: BOARD_ID,
        action: 'remove_reminder',
        task_id: 'T-001',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.change).toContain('All reminders removed');

      // Verify in DB
      const task = engine.getTask('T-001');
      const reminders = JSON.parse(task.reminders);
      expect(reminders).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  admin                                                            */
  /* ---------------------------------------------------------------- */

  describe('admin', () => {
    it('board_runtime_config has cross_board_subtask_mode column after engine init', () => {
      const row = db
        .prepare(`SELECT cross_board_subtask_mode FROM board_runtime_config WHERE board_id = ?`)
        .get(BOARD_ID) as { cross_board_subtask_mode: string } | undefined;
      expect(row).toBeTruthy();
      expect(row!.cross_board_subtask_mode).toBe('open');
    });

    it('register person (hierarchy board requires group_name + group_folder)', () => {
      // Fixture is level 0, max_depth 1 — canDelegateDown() is true, so both
      // group_name and group_folder must be supplied or the engine rejects.
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Carlos Silva',
        phone: '5585999990003',
        role: 'Dev',
        group_name: 'CARLOS-DIV - TaskFlow',
        group_folder: 'carlos-div-taskflow',
      });
      expect(r.success).toBe(true);
      expect(r.person_id).toBe('carlos-silva');
      expect(r.data.name).toBe('Carlos Silva');

      // Verify in DB
      const person = engine.resolvePerson('Carlos Silva');
      expect(person).toBeTruthy();
      expect(person!.person_id).toBe('carlos-silva');
    });

    it('register person on hierarchy board without group_name/group_folder → rejected', () => {
      // Regression guard for the Edilson 2026-04-10 bug: calling
      // register_person on a hierarchy board without group_name/group_folder
      // used to half-register the person and fall through to the host's
      // provision-child-board.ts fallback, which named the child board after
      // the person. Now the engine refuses before touching board_people.
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Edilson',
        phone: '5585999990099',
        role: 'Scrum Master',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('group_name');
      expect(r.error).toContain('group_folder');
      expect(r.error).toContain('division');

      // Verify no row was created in board_people
      const person = engine.resolvePerson('Edilson');
      expect(person).toBeNull();
    });

    it('register person on hierarchy board with whitespace-only group_name → rejected', () => {
      // The validation uses trim().length > 0, so whitespace-only strings
      // are equivalent to missing. Guard against a bot that might pass a
      // literal space as a placeholder when it doesn't know the sigla yet.
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Edilson',
        phone: '5585999990099',
        role: 'Scrum Master',
        group_name: '   ',
        group_folder: 'edilson-taskflow',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('group_name');

      // Also the symmetric case
      const r2 = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Edilson',
        phone: '5585999990099',
        role: 'Scrum Master',
        group_name: 'EDI - TaskFlow',
        group_folder: '\t\n',
      });
      expect(r2.success).toBe(false);
      expect(r2.error).toContain('group_folder');

      // Neither attempt should have created a row
      expect(engine.resolvePerson('Edilson')).toBeNull();
    });

    it('register person on a LEAF board without group_name/group_folder → allowed', () => {
      // Flip the fixture to a leaf configuration (level == max_depth) so
      // canDelegateDown() returns false, then verify the validation does NOT
      // trigger and the 3-field form still succeeds. This is the explicit
      // regression guard against a validation that over-fires on leaves.
      db.exec(
        `UPDATE boards SET hierarchy_level = 1, max_depth = 1 WHERE id = '${BOARD_ID}'`,
      );

      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Leaf Only',
        phone: '5585999990111',
        role: 'Dev',
      });
      expect(r.success).toBe(true);
      expect(r.person_id).toBe('leaf-only');
      expect(engine.resolvePerson('Leaf Only')).toBeTruthy();
    });

    it('register person on hierarchy board with group_name/group_folder but no phone → rejected', () => {
      // Tightening of the Edilson fix (Codex 2026-04-11 flagged this as a
      // residual gap). Without phone, auto_provision_request never fires
      // (it's gated on `params.phone` at taskflow-engine.ts:5971), so a
      // user who typed the sigla expecting a child board would silently
      // get a no-op. The engine now refuses the call instead.
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Staff Only',
        // no phone
        role: 'Coordinator',
        group_name: 'STAFF - TaskFlow',
        group_folder: 'staff-taskflow',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('phone');
      expect(r.error).toContain('auto-provisioned');

      // Verify no row was created in board_people
      expect(engine.resolvePerson('Staff Only')).toBeNull();
    });

    it('register person on a LEAF board without phone → allowed (phone optional on leaves)', () => {
      // Phone optionality is preserved on leaf boards, where register_person
      // is not coupled to auto-provisioning. This keeps the legitimate
      // "observer / stakeholder without WhatsApp" flow working on flat
      // single-level boards. Counterpart to the earlier leaf-board test
      // that covered group_name/group_folder optionality.
      db.exec(
        `UPDATE boards SET hierarchy_level = 1, max_depth = 1 WHERE id = '${BOARD_ID}'`,
      );

      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Observer',
        // no phone
        role: 'Observer',
      });
      expect(r.success).toBe(true);
      expect(r.person_id).toBe('observer');
      expect(engine.resolvePerson('Observer')).toBeTruthy();
    });

    it('register person on hierarchy board missing all three (phone + group_name + group_folder) → error lists all three', () => {
      // Regression guard: when multiple fields are missing, the dynamic
      // `missing.join(', ')` in the error message should include every
      // missing field so the bot can ask for them in a single prompt
      // instead of discovering them one-by-one across multiple retries.
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Edilson',
        // no phone, no group_name, no group_folder — bare 1-field call
        role: 'Scrum Master',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('phone');
      expect(r.error).toContain('group_name');
      expect(r.error).toContain('group_folder');
      expect(engine.resolvePerson('Edilson')).toBeNull();
    });

    it('register person on legacy board with max_depth=NULL → canDelegateDown is false, 3-field form allowed', () => {
      // Pre-hierarchy boards (created before the hierarchy schema was
      // introduced) have max_depth = NULL in the `boards` table. Per
      // canDelegateDown() at L1110, NULL max_depth returns false, so the
      // board is treated as a leaf and the new validation does not fire.
      // Guard against accidentally breaking legacy single-level installs.
      db.exec(
        `UPDATE boards SET max_depth = NULL WHERE id = '${BOARD_ID}'`,
      );

      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'register_person',
        sender_name: 'Alexandre',
        person_name: 'Legacy',
        phone: '5585999990222',
        role: 'Dev',
        // no group_name / group_folder — legacy non-hierarchical board
      });
      expect(r.success).toBe(true);
      expect(r.person_id).toBe('legacy');
      expect(engine.resolvePerson('Legacy')).toBeTruthy();
    });

    it('offer_register on a LEAF board does NOT include the division/sigla ask', () => {
      // Regression guard for buildOfferRegisterError's hierarchy branch at
      // L1824. On hierarchy boards the method appends the sigla ask; on
      // leaf boards it MUST NOT, otherwise the bot would ask the user for
      // a division/sector that doesn't exist in a flat single-level setup.
      // Counterpart to the 'returns offer_register for unknown assignee'
      // test that asserts the sigla ask IS present on the hierarchy fixture.
      db.exec(
        `UPDATE boards SET hierarchy_level = 1, max_depth = 1 WHERE id = '${BOARD_ID}'`,
      );

      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Some task',
        assignee: 'Rafael',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.offer_register).toBeTruthy();
      expect(r.offer_register!.message).toContain('não está cadastrado');
      // The base 3-field wording is still there
      expect(r.offer_register!.message).toContain('telefone');
      expect(r.offer_register!.message).toContain('cargo');
      // But the hierarchy sigla ask MUST NOT be present on a leaf
      expect(r.offer_register!.message).not.toContain('sigla da divisão/setor');
      expect(r.offer_register!.message).not.toContain('SETD');
    });

    it('remove person → lists tasks to reassign', () => {
      // person-1 (Alexandre) has T-001 in in_progress
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'remove_person',
        sender_name: 'Alexandre',
        person_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.tasks_to_reassign).toBeTruthy();
      expect(r.tasks_to_reassign!.length).toBeGreaterThanOrEqual(1);
      expect(r.tasks_to_reassign!.some((t) => t.task_id === 'T-001')).toBe(true);

      // Person should still be in DB (not removed yet, because tasks need reassignment)
      const person = engine.resolvePerson('Alexandre');
      expect(person).toBeTruthy();
    });

    it('remove person with force → unassigns tasks', () => {
      // person-2 (Giovanni) has T-002 in next_action
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'remove_person',
        sender_name: 'Alexandre',
        person_name: 'Giovanni',
        force: true,
      });
      expect(r.success).toBe(true);
      expect(r.data.removed).toBe('Giovanni');
      expect(r.data.tasks_unassigned).toBeGreaterThanOrEqual(1);

      // Verify person removed
      const person = engine.resolvePerson('Giovanni');
      expect(person).toBeNull();

      // Verify task unassigned
      const task = engine.getTask('T-002');
      expect(task.assignee).toBeNull();
    });

    it('remove last manager → error', () => {
      // There's only one manager (person-1, Alexandre). Try to remove admin.
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'remove_admin',
        sender_name: 'Alexandre',
        person_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('last manager');
    });

    it('add manager', () => {
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'add_manager',
        sender_name: 'Alexandre',
        person_name: 'Giovanni',
      });
      expect(r.success).toBe(true);
      expect(r.person_id).toBe('person-2');
      expect(r.data.role).toBe('manager');

      // Verify in DB
      const row = db
        .prepare(
          `SELECT * FROM board_admins WHERE board_id = ? AND person_id = 'person-2' AND admin_role = 'manager'`,
        )
        .get(BOARD_ID);
      expect(row).toBeTruthy();
    });

    it('add delegate', () => {
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'add_delegate',
        sender_name: 'Alexandre',
        person_name: 'Giovanni',
      });
      expect(r.success).toBe(true);
      expect(r.person_id).toBe('person-2');
      expect(r.data.role).toBe('delegate');

      // Verify in DB
      const row = db
        .prepare(
          `SELECT * FROM board_admins WHERE board_id = ? AND person_id = 'person-2' AND admin_role = 'delegate'`,
        )
        .get(BOARD_ID);
      expect(row).toBeTruthy();
    });

    it('remove admin (not last manager)', () => {
      // First add Giovanni as a second manager
      engine.admin({
        board_id: BOARD_ID,
        action: 'add_manager',
        sender_name: 'Alexandre',
        person_name: 'Giovanni',
      });

      // Now remove Alexandre as admin — should succeed since Giovanni is also a manager
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'remove_admin',
        sender_name: 'Giovanni', // Giovanni is now a manager too
        person_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.data.removed_admin).toBe('Alexandre');

      // Verify Alexandre is no longer in board_admins
      const row = db
        .prepare(
          `SELECT * FROM board_admins WHERE board_id = ? AND person_id = 'person-1'`,
        )
        .get(BOARD_ID);
      expect(row).toBeFalsy();
    });

    it('set WIP limit', () => {
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'set_wip_limit',
        sender_name: 'Alexandre',
        person_name: 'Giovanni',
        wip_limit: 5,
      });
      expect(r.success).toBe(true);
      expect(r.data.person).toBe('Giovanni');
      expect(r.data.wip_limit).toBe(5);

      // Verify in DB
      const row = db
        .prepare(
          `SELECT wip_limit FROM board_people WHERE board_id = ? AND person_id = 'person-2'`,
        )
        .get(BOARD_ID) as { wip_limit: number };
      expect(row.wip_limit).toBe(5);
    });

    it('cancel task → moves to archive', () => {
      // Record some history first
      engine.recordHistory('T-001', 'created', 'Alexandre', 'initial');

      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'cancel_task',
        sender_name: 'Alexandre',
        task_id: 'T-001',
      });
      expect(r.success).toBe(true);
      expect(r.data.cancelled).toBe('T-001');
      expect(r.data.title).toBe('Fix login bug');

      // Task should be gone from tasks table
      const task = engine.getTask('T-001');
      expect(task).toBeNull();

      // Task should be in archive
      const archived = db
        .prepare(
          `SELECT * FROM archive WHERE board_id = ? AND task_id = 'T-001'`,
        )
        .get(BOARD_ID) as any;
      expect(archived).toBeTruthy();
      expect(archived.archive_reason).toBe('cancelled');
      expect(archived.title).toBe('Fix login bug');

      // Verify snapshot contains the full task
      const snapshot = JSON.parse(archived.task_snapshot);
      expect(snapshot.title).toBe('Fix login bug');
      expect(snapshot.column).toBe('in_progress');

      // Verify history was saved
      const history = JSON.parse(archived.history);
      expect(history.length).toBeGreaterThanOrEqual(1);
    });

    it('restore task from archive', () => {
      // First cancel a task to create an archive entry
      engine.admin({
        board_id: BOARD_ID,
        action: 'cancel_task',
        sender_name: 'Alexandre',
        task_id: 'T-002',
      });

      // Verify it's archived
      expect(engine.getTask('T-002')).toBeNull();

      // Now restore it
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'restore_task',
        sender_name: 'Alexandre',
        task_id: 'T-002',
      });
      expect(r.success).toBe(true);
      expect(r.data.restored).toBe('T-002');
      expect(r.data.title).toBe('Update docs');

      // Task should be back in tasks table
      const task = engine.getTask('T-002');
      expect(task).toBeTruthy();
      expect(task.title).toBe('Update docs');
      expect(task.requires_close_approval).toBe(0);

      // Archive entry should be gone
      const archived = db
        .prepare(
          `SELECT * FROM archive WHERE board_id = ? AND task_id = 'T-002'`,
        )
        .get(BOARD_ID);
      expect(archived).toBeFalsy();
    });

    it('restore project from archive recreates subtask rows', () => {
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-gio')`,
      );
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-gio',
        personId: 'person-2',
        name: 'Giovanni',
      });
      engine.create({
        board_id: BOARD_ID,
        type: 'project',
        title: 'Project restore',
        subtasks: [{ title: 'Call Jimmy', assignee: 'Giovanni' }, 'Prepare deck'],
        sender_name: 'Alexandre',
      });

      const cancelResult = engine.admin({
        board_id: BOARD_ID,
        action: 'cancel_task',
        sender_name: 'Alexandre',
        task_id: 'P1',
      });
      expect(cancelResult.success).toBe(true);
      expect(engine.getTask('P1')).toBeNull();
      expect(engine.getTask('P1.1')).toBeNull();
      expect(engine.getTask('P1.2')).toBeNull();

      const restoreResult = engine.admin({
        board_id: BOARD_ID,
        action: 'restore_task',
        sender_name: 'Alexandre',
        task_id: 'P1',
      });
      expect(restoreResult.success).toBe(true);

      const restoredProject = engine.getTask('P1');
      expect(restoredProject?.title).toBe('Project restore');
      const restoredSubtasks = db
        .prepare(
          `SELECT id, parent_task_id, assignee, child_exec_enabled, child_exec_board_id
           FROM tasks WHERE board_id = ? AND parent_task_id = ? ORDER BY id`,
        )
        .all(BOARD_ID, 'P1') as Array<{
        id: string;
        parent_task_id: string;
        assignee: string | null;
        child_exec_enabled: number;
        child_exec_board_id: string | null;
      }>;
      expect(restoredSubtasks).toEqual([
        {
          id: 'P1.1',
          parent_task_id: 'P1',
          assignee: 'person-2',
          child_exec_enabled: 1,
          child_exec_board_id: 'board-child-gio',
        },
        {
          id: 'P1.2',
          parent_task_id: 'P1',
          assignee: 'person-1', // inherited from project (auto-assigned to sender)
          child_exec_enabled: 0,
          child_exec_board_id: null,
        },
      ]);
    });

    it('restore non-existent archive → error', () => {
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'restore_task',
        sender_name: 'Alexandre',
        task_id: 'T-999',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Archived task not found');
    });

    it('process inbox → returns inbox items', () => {
      // T-003 is in inbox
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'process_inbox',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.tasks).toBeTruthy();
      expect(r.tasks!.length).toBeGreaterThanOrEqual(1);
      expect(r.tasks!.some((t: any) => t.id === 'T-003')).toBe(true);
      expect(r.data.count).toBeGreaterThanOrEqual(1);
    });

    it('non-manager → permission denied', () => {
      const r = engine.admin({
        board_id: BOARD_ID,
        action: 'process_inbox',
        sender_name: 'Giovanni', // not a manager
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Permission denied');
      expect(r.error).toContain('Giovanni');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  undo                                                             */
  /* ---------------------------------------------------------------- */

  describe('undo', () => {
    it('undo happy path (within 60s)', () => {
      // Move T-001 from in_progress to review (this sets _last_mutation)
      const moveResult = engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'review',
        sender_name: 'Alexandre',
      });
      expect(moveResult.success).toBe(true);
      expect(moveResult.to_column).toBe('review');

      // Verify task is now in review
      let task = engine.getTask('T-001');
      expect(task.column).toBe('review');

      // Undo the move
      const undoResult = engine.undo({
        board_id: BOARD_ID,
        sender_name: 'Alexandre',
      });
      expect(undoResult.success).toBe(true);
      expect(undoResult.task_id).toBe('T-001');
      expect(undoResult.undone_action).toBe('review');

      // Verify task is restored to in_progress
      task = engine.getTask('T-001');
      expect(task.column).toBe('in_progress');

      // Verify _last_mutation was cleared
      expect(task._last_mutation).toBeNull();

      // Verify history records the undo
      const history = db
        .prepare(
          `SELECT * FROM task_history WHERE board_id = ? AND task_id = 'T-001' AND action = 'undone'`,
        )
        .all(BOARD_ID) as any[];
      expect(history).toHaveLength(1);
      expect(history[0].by).toBe('Alexandre');
    });

    it('undo expired (>60s) → error', () => {
      // Move T-001, then manually set _last_mutation.at to 2 minutes ago
      engine.move({
        board_id: BOARD_ID,
        task_id: 'T-001',
        action: 'review',
        sender_name: 'Alexandre',
      });

      // Override _last_mutation with a timestamp 2 minutes in the past
      const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString();
      const expiredMutation = JSON.stringify({
        action: 'review',
        by: 'Alexandre',
        at: twoMinutesAgo,
        snapshot: { column: 'in_progress', assignee: 'person-1', due_date: null, updated_at: twoMinutesAgo },
      });
      db.exec(
        `UPDATE tasks SET _last_mutation = '${expiredMutation}' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.undo({
        board_id: BOARD_ID,
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('expired');
    });

    it('undo creation → error (suggest cancelar)', () => {
      // Create a task (sets _last_mutation with action='created')
      const createResult = engine.create({
        board_id: BOARD_ID,
        type: 'inbox',
        title: 'New task to undo',
        sender_name: 'Alexandre',
      });
      expect(createResult.success).toBe(true);

      // Clear _last_mutation on other tasks so only the newly created one has it
      db.exec(
        `UPDATE tasks SET _last_mutation = NULL WHERE board_id = '${BOARD_ID}' AND id != '${createResult.task_id}'`,
      );

      const r = engine.undo({
        board_id: BOARD_ID,
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('cancelar');
    });

    it('no mutation to undo → error', () => {
      // Clear all _last_mutation values
      db.exec(
        `UPDATE tasks SET _last_mutation = NULL WHERE board_id = '${BOARD_ID}'`,
      );

      const r = engine.undo({
        board_id: BOARD_ID,
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('no recent mutations');
    });

    it('permission: only mutation author or manager', () => {
      // Giovanni moves T-002 (he is assignee, which is allowed for start)
      engine.move({
        board_id: BOARD_ID,
        task_id: 'T-002',
        action: 'start',
        sender_name: 'Giovanni',
      });

      // Clear _last_mutation on other tasks so only T-002 has it
      db.exec(
        `UPDATE tasks SET _last_mutation = NULL WHERE board_id = '${BOARD_ID}' AND id != 'T-002'`,
      );

      // Register a third person (non-manager) who tries to undo Giovanni's action
      db.exec(
        `INSERT INTO board_people VALUES ('${BOARD_ID}', 'person-3', 'Carlos', '5585999990003', 'Dev', 3, NULL)`,
      );

      const r = engine.undo({
        board_id: BOARD_ID,
        sender_name: 'Carlos', // not the author, not a manager
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Permission denied');
      expect(r.error).toContain('Giovanni'); // the mutation author

      // Manager (Alexandre) CAN undo Giovanni's action
      const r2 = engine.undo({
        board_id: BOARD_ID,
        sender_name: 'Alexandre', // manager
      });
      expect(r2.success).toBe(true);
      expect(r2.task_id).toBe('T-002');

      // Verify task is back in next_action
      const task = engine.getTask('T-002');
      expect(task.column).toBe('next_action');
    });

    it('child board can undo a delegated subtask mutation', () => {
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-gio')`,
      );
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-gio',
        personId: 'person-2',
        name: 'Giovanni',
      });
      engine.create({
        board_id: BOARD_ID,
        type: 'project',
        title: 'Delegated project',
        subtasks: [{ title: 'Call Jimmy', assignee: 'Giovanni' }],
        sender_name: 'Alexandre',
      });
      db.exec(
        `UPDATE tasks SET requires_close_approval = 0 WHERE board_id = '${BOARD_ID}' AND id = 'P1.1'`,
      );

      const childEngine = new TaskflowEngine(db, 'board-child-gio');
      const moveResult = childEngine.move({
        board_id: 'board-child-gio',
        task_id: 'P1.1',
        action: 'conclude',
        sender_name: 'Giovanni',
      });
      expect(moveResult.success).toBe(true);
      expect(engine.getTask('P1.1')?.column).toBe('done');

      const undoResult = childEngine.undo({
        board_id: 'board-child-gio',
        sender_name: 'Giovanni',
      });
      expect(undoResult.success).toBe(true);
      expect(undoResult.task_id).toBe('P1.1');
      expect(engine.getTask('P1.1')?.column).toBe('next_action');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  report                                                           */
  /* ---------------------------------------------------------------- */

  describe('report', () => {
    it('standup returns correct sections', () => {
      const todayStr = new Date().toISOString().slice(0, 10);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.toISOString().slice(0, 10);

      // Make T-001 overdue (in_progress with past due_date)
      db.exec(
        `UPDATE tasks SET due_date = '${yStr}' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      // T-001 is already in_progress, assigned to person-1 (Alexandre)
      const r = engine.report({ board_id: BOARD_ID, type: 'standup' });
      expect(r.success).toBe(true);
      expect(r.data).toBeTruthy();
      expect(r.data!.date).toBe(todayStr);

      // Overdue: T-001
      expect(r.data!.overdue).toHaveLength(1);
      expect(r.data!.overdue[0].id).toBe('T-001');
      expect(r.data!.overdue[0].assignee_name).toBe('Alexandre');
      expect(r.data!.overdue[0].due_date).toBe(yStr);

      // In-progress: T-001
      expect(r.data!.in_progress).toHaveLength(1);
      expect(r.data!.in_progress[0].id).toBe('T-001');

      // Per-person: should have entries for Alexandre and Giovanni
      expect(r.data!.per_person).toHaveLength(2);
      const alex = r.data!.per_person.find((p) => p.name === 'Alexandre');
      expect(alex).toBeTruthy();
      expect(alex!.in_progress).toBe(1);
      expect(alex!.waiting).toBe(0);

      const gio = r.data!.per_person.find((p) => p.name === 'Giovanni');
      expect(gio).toBeTruthy();
      expect(gio!.in_progress).toBe(0);

      // Standup should NOT have stats
      expect(r.data!.stats).toBeUndefined();

      // Standup: blocked / completed_today / changes_today_count are empty/zero
      expect(r.data!.blocked).toEqual([]);
      expect(r.data!.completed_today).toEqual([]);
      expect(r.data!.changes_today_count).toBe(0);
    });

    it('digest includes completed_today and blocked', () => {
      const todayStr = new Date().toISOString().slice(0, 10);
      const now = new Date().toISOString();

      // Move T-001 to done today (via history)
      db.exec(
        `UPDATE tasks SET column = 'done' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-001', 'conclude', 'person-1', '${now}', '${JSON.stringify({ from: 'in_progress', to: 'done' })}')`,
      );

      // Make T-002 blocked
      db.exec(
        `UPDATE tasks SET blocked_by = '["T-003"]' WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      // Add another history entry today
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-002', 'updated', 'person-2', '${now}', 'added blocker')`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
      expect(r.success).toBe(true);

      // Completed today: T-001
      expect(r.data!.completed_today).toHaveLength(1);
      expect(r.data!.completed_today[0].id).toBe('T-001');
      expect(r.data!.completed_today[0].assignee_name).toBe('Alexandre');

      // Blocked: T-002
      expect(r.data!.blocked).toHaveLength(1);
      expect(r.data!.blocked[0].id).toBe('T-002');
      expect(r.data!.blocked[0].blocked_by).toEqual(['T-003']);

      // Changes today count: 2 history entries
      expect(r.data!.changes_today_count).toBe(2);

      // Per-person should have completed_today counts
      const alex = r.data!.per_person.find((p) => p.name === 'Alexandre');
      expect(alex!.completed_today).toBe(1);

      // Should NOT have weekly stats
      expect(r.data!.stats).toBeUndefined();
      expect(r.data!.formatted_report).toContain('🎉');
      // Celebration shows per-person summary, not individual task list
      expect(r.data!.formatted_report).toContain('Alexandre');
      expect(r.data!.formatted_report).toContain('concluída(s)');
      // T-002 is blocked but digest no longer shows pendências (no-stress evening)
      // Blocked tasks are still in data.blocked for the agent to use if needed
      expect(r.data!.blocked).toHaveLength(1);
    });

    it('weekly includes stats and trend', () => {
      const now = new Date().toISOString();
      const todayStr = new Date().toISOString().slice(0, 10);

      // Create some history entries this week
      // T-001 moved to done this week
      db.exec(
        `UPDATE tasks SET column = 'done' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-001', 'conclude', 'person-1', '${now}', '${JSON.stringify({ from: 'in_progress', to: 'done' })}')`,
      );

      // T-003 created this week
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-003', 'created', 'person-1', '${now}', 'task created')`,
      );

      // Add a "completed last week" entry for trend comparison.
      // Compute last week's Wednesday dynamically to guarantee it always
      // falls in the previous ISO week (Mon-Sun), regardless of which
      // day of the week the test runs.
      const lastWeekDate = new Date();
      const dow = lastWeekDate.getUTCDay(); // 0=Sun … 6=Sat
      const daysSinceMonday = dow === 0 ? 6 : dow - 1;
      // Go to this Monday, then back 4 days = last Wednesday
      lastWeekDate.setUTCDate(lastWeekDate.getUTCDate() - daysSinceMonday - 4);
      const lwStr = lastWeekDate.toISOString();

      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-002', 'approve', 'person-2', '${lwStr}', '${JSON.stringify({ from: 'review', to: 'done' })}')`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'weekly' });
      expect(r.success).toBe(true);

      // Should have stats
      expect(r.data!.stats).toBeTruthy();
      expect(r.data!.stats!.completed_week).toBe(1); // T-001 done this week
      expect(r.data!.stats!.created_week).toBe(1);   // T-003 created this week
      expect(r.data!.stats!.total_active).toBe(2);    // T-002 and T-003 (T-001 is done)
      expect(r.data!.stats!.trend).toBe('same');       // 1 this week, 1 last week

      // Per-person should have completed_week
      const alex = r.data!.per_person.find((p) => p.name === 'Alexandre');
      expect(alex!.completed_week).toBeDefined();

      // Also has digest fields
      expect(r.data!.completed_today).toBeDefined();
      expect(r.data!.blocked).toBeDefined();
      expect(r.data!.changes_today_count).toBeGreaterThanOrEqual(0);
      expect(r.data!.formatted_report).toContain('🏆 *Revisão Semanal*');
      expect(r.data!.formatted_report).toContain('*✅ Concluídas na semana:*');
      expect(r.data!.formatted_report).toContain('*T-001*');
      expect(r.data!.formatted_report).toContain('*Alexandre*');
    });

    it('digest and weekly formatted reports preserve prefixed linked task ids', () => {
      seedLinkedTask(db, BOARD_ID, {
        ownerBoardId: 'board-parent-sec',
        taskId: 'T9',
        assignee: 'person-2',
        column: 'next_action',
        title: 'Linked parent task',
      });
      db.exec(`UPDATE boards SET short_code = 'SEC' WHERE id = 'board-parent-sec'`);

      const digest = engine.report({ board_id: BOARD_ID, type: 'digest' });
      const weekly = engine.report({ board_id: BOARD_ID, type: 'weekly' });

      // Compact header doesn't list individual tasks — check that the board query still shows them
      const board = engine.query({ board_id: BOARD_ID, query: 'board' });
      expect(board.success).toBe(true);
      expect((board as any).data.formatted_board).toContain('SEC-T9');

      // Digest/weekly compact header shows column counts, not individual task IDs
      expect(digest.data!.formatted_report).toContain('próximas');
      expect(weekly.data!.formatted_report).toContain('próximas');
    });

    it('digest uses compact board header instead of full board', () => {
      const now = new Date().toISOString();
      db.exec(`UPDATE tasks SET column = 'done' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`);
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-001', 'conclude', 'person-1', '${now}', '${JSON.stringify({ from: 'in_progress', to: 'done' })}')`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
      expect(r.success).toBe(true);
      const report = r.data!.formatted_report!;

      expect(report).toContain('📋 *TASKFLOW BOARD*');
      expect(report).toContain('tarefas');
      expect(report).toMatch(/📥 \d+ inbox/);
      const headerEnd = report.indexOf('🎉');
      const headerSection = headerEnd > 0 ? report.slice(0, headerEnd) : report.slice(0, 200);
      expect(headerSection).not.toContain('👤');
      expect(report).toContain('concluída(s) hoje');
    });

    it('weekly uses compact board header instead of full board', () => {
      const now = new Date().toISOString();
      db.exec(`UPDATE tasks SET column = 'done' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`);
      db.exec(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES ('${BOARD_ID}', 'T-001', 'conclude', 'person-1', '${now}', '${JSON.stringify({ from: 'in_progress', to: 'done' })}')`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'weekly' });
      expect(r.success).toBe(true);
      const report = r.data!.formatted_report!;

      expect(report).toContain('📋 *TASKFLOW BOARD*');
      const headerEnd = report.indexOf('🏆');
      const headerSection = headerEnd > 0 ? report.slice(0, headerEnd) : report.slice(0, 200);
      expect(headerSection).not.toContain('👤');
      expect(report).toContain('concluída(s) na semana');
    });

    it('standup still uses full board view with person groupings', () => {
      const r = engine.report({ board_id: BOARD_ID, type: 'standup' });
      expect(r.success).toBe(true);
      const board = r.data!.formatted_board!;

      expect(board).toContain('👤');
      expect(board).toContain('T-001');
      expect(board).toContain('T-002');
    });

    it('digest compact header omits completed line when zero completions', () => {
      const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
      expect(r.success).toBe(true);
      const report = r.data!.formatted_report!;

      expect(report).toContain('📋 *TASKFLOW BOARD*');
      expect(report).not.toContain('concluída(s) hoje');
    });

    it('digest compact header on empty board shows zero counts', () => {
      db.exec(`DELETE FROM tasks WHERE board_id = '${BOARD_ID}'`);

      const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
      expect(r.success).toBe(true);
      const report = r.data!.formatted_report!;

      expect(report).toContain('📋 *TASKFLOW BOARD*');
      expect(report).toContain('0 tarefas');
      expect(report).not.toContain('📥');
      expect(report).not.toContain('⏭️');
      expect(report).not.toContain('🔄');
    });

    it('on-demand board query still uses full board view', () => {
      const r = engine.query({ board_id: BOARD_ID, query: 'board' });
      expect(r.success).toBe(true);
      const board = (r as any).data.formatted_board;

      expect(board).toContain('👤');
      expect(board).toContain('T-001');
    });

    it('empty board returns valid structure', () => {
      // Delete all tasks
      db.exec(`DELETE FROM tasks WHERE board_id = '${BOARD_ID}'`);
      // Delete all people too
      db.exec(`DELETE FROM board_people WHERE board_id = '${BOARD_ID}'`);

      const r = engine.report({ board_id: BOARD_ID, type: 'standup' });
      expect(r.success).toBe(true);
      expect(r.data!.overdue).toEqual([]);
      expect(r.data!.in_progress).toEqual([]);
      expect(r.data!.review).toEqual([]);
      expect(r.data!.due_today).toEqual([]);
      expect(r.data!.waiting).toEqual([]);
      expect(r.data!.blocked).toEqual([]);
      expect(r.data!.completed_today).toEqual([]);
      expect(r.data!.changes_today_count).toBe(0);
      expect(r.data!.per_person).toEqual([]);

      // Weekly on empty board
      const rw = engine.report({ board_id: BOARD_ID, type: 'weekly' });
      expect(rw.success).toBe(true);
      expect(rw.data!.stats).toBeTruthy();
      expect(rw.data!.stats!.total_active).toBe(0);
      expect(rw.data!.stats!.completed_week).toBe(0);
      expect(rw.data!.stats!.created_week).toBe(0);
      expect(rw.data!.stats!.trend).toBe('same');
    });

    it('excludes delegated tasks with active rollup from stale_24h', () => {
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - 2);
      const staleIso = staleDate.toISOString();

      // T-001 is in_progress — make it stale and delegated with active rollup
      db.exec(
        `UPDATE tasks SET updated_at = '${staleIso}', child_exec_enabled = 1,
         child_exec_board_id = 'board-child', child_exec_rollup_status = 'active',
         child_exec_last_rollup_summary = '2 ativo(s)'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      // T-002 is next_action — make it stale but NOT delegated
      db.exec(
        `UPDATE tasks SET updated_at = '${staleIso}'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
      expect(r.success).toBe(true);
      const staleIds = (r.data as any).stale_24h.map((t: any) => t.id);
      expect(staleIds).toContain('T-002');
      expect(staleIds).not.toContain('T-001');
    });

    it('includes delegated tasks with no_work_yet rollup in stale_24h', () => {
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - 2);
      const staleIso = staleDate.toISOString();

      // Delegated but child hasn't started work
      db.exec(
        `UPDATE tasks SET updated_at = '${staleIso}', child_exec_enabled = 1,
         child_exec_board_id = 'board-child', child_exec_rollup_status = 'no_work_yet'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
      expect(r.success).toBe(true);
      const staleIds = (r.data as any).stale_24h.map((t: any) => t.id);
      expect(staleIds).toContain('T-001');
    });

    it('includes delegated tasks with null rollup in stale_24h', () => {
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - 2);
      const staleIso = staleDate.toISOString();

      // Delegated but rollup never ran
      db.exec(
        `UPDATE tasks SET updated_at = '${staleIso}', child_exec_enabled = 1,
         child_exec_board_id = 'board-child'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
      expect(r.success).toBe(true);
      const staleIds = (r.data as any).stale_24h.map((t: any) => t.id);
      expect(staleIds).toContain('T-001');
    });

    it('excludes delegated tasks with active rollup from waiting list', () => {
      // Put T-001 in waiting with active rollup
      db.exec(
        `UPDATE tasks SET column = 'waiting', waiting_for = 'Child board',
         child_exec_enabled = 1, child_exec_board_id = 'board-child',
         child_exec_rollup_status = 'blocked',
         child_exec_last_rollup_summary = '1 aguardando'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      // Put T-002 in waiting without delegation
      db.exec(
        `UPDATE tasks SET column = 'waiting', waiting_for = 'Client reply'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'standup' });
      expect(r.success).toBe(true);
      const waitingIds = r.data!.waiting.map((t: any) => t.id);
      expect(waitingIds).toContain('T-002');
      expect(waitingIds).not.toContain('T-001');
    });

    it('excludes delegated tasks with active rollup from weekly stale_tasks', () => {
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - 4);
      const staleIso = staleDate.toISOString();

      db.exec(
        `UPDATE tasks SET updated_at = '${staleIso}', child_exec_enabled = 1,
         child_exec_board_id = 'board-child', child_exec_rollup_status = 'active'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      db.exec(
        `UPDATE tasks SET updated_at = '${staleIso}'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'weekly' });
      expect(r.success).toBe(true);
      const staleIds = (r.data as any).stale_tasks.map((t: any) => t.id);
      expect(staleIds).toContain('T-002');
      expect(staleIds).not.toContain('T-001');
    });

    it('formatted board shows rollup summary for delegated tasks', () => {
      db.exec(
        `UPDATE tasks SET column = 'waiting', child_exec_enabled = 1,
         child_exec_board_id = 'board-child', child_exec_rollup_status = 'active',
         child_exec_last_rollup_summary = '2 ativo(s), 1 concluído(s)'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );

      const r = engine.report({ board_id: BOARD_ID, type: 'standup' });
      expect(r.success).toBe(true);
      expect(r.data!.formatted_board).toContain('📊 2 ativo(s), 1 concluído(s)');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  reconcileDelegationLinks                                         */
  /* ---------------------------------------------------------------- */

  describe('reconcileDelegationLinks', () => {
    it('clears stale rollup when child board registration is removed', () => {
      const now = new Date().toISOString();
      // Set up child board registration
      seedChildBoard(db, {
        parentBoardId: BOARD_ID,
        childBoardId: 'board-child-recon',
        personId: 'person-2',
        name: 'Giovanni',
      });
      db.exec(
        `INSERT INTO child_board_registrations VALUES ('${BOARD_ID}', 'person-2', 'board-child-recon')`,
      );
      // T-002 is assigned to person-2 — set delegation + rollup
      db.exec(
        `UPDATE tasks SET child_exec_enabled = 1, child_exec_board_id = 'board-child-recon',
         child_exec_person_id = 'person-2', child_exec_rollup_status = 'active',
         child_exec_last_rollup_at = '${now}', child_exec_last_rollup_summary = '1 ativo(s)'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-002'`,
      );

      // Now remove the child board registration (simulating board deletion)
      db.exec(
        `DELETE FROM child_board_registrations WHERE parent_board_id = '${BOARD_ID}' AND person_id = 'person-2'`,
      );

      // Re-create engine to trigger reconciliation
      const freshEngine = new TaskflowEngine(db, BOARD_ID);

      // T-002 should have delegation cleared
      const task = freshEngine.getTask('T-002');
      expect(task.child_exec_enabled).toBe(0);
      expect(task.child_exec_board_id).toBeNull();
      // Rollup metadata should also be cleared
      expect(task.child_exec_rollup_status).toBeNull();
      expect(task.child_exec_last_rollup_summary).toBeNull();
    });

    it('reconciles top-level tasks, not just subtasks', () => {
      const now = new Date().toISOString();
      // T-001 is a top-level task (no parent_task_id, no recurrence)
      // Set stale delegation metadata
      db.exec(
        `UPDATE tasks SET child_exec_enabled = 1, child_exec_board_id = 'board-ghost',
         child_exec_person_id = 'person-1', child_exec_rollup_status = 'active'
         WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`,
      );
      // No child_board_registrations row for person-1 → delegation is stale

      // Re-create engine to trigger reconciliation
      const freshEngine = new TaskflowEngine(db, BOARD_ID);

      const task = freshEngine.getTask('T-001');
      expect(task.child_exec_enabled).toBe(0);
      expect(task.child_exec_board_id).toBeNull();
      expect(task.child_exec_rollup_status).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  bounded recurrence                                               */
  /* ---------------------------------------------------------------- */

  describe('bounded recurrence', () => {
    it('creates recurring task with max_cycles', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'recurring',
        title: 'Bounded weekly',
        recurrence: 'weekly',
        max_cycles: 6,
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.task_id).toMatch(/^R/);

      const task = engine.getTask(r.task_id!);
      expect(task.max_cycles).toBe(6);
      expect(task.recurrence_end_date).toBeNull();
    });

    it('creates recurring task with recurrence_end_date', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'recurring',
        title: 'End-dated weekly',
        recurrence: 'weekly',
        recurrence_end_date: '2026-12-31',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);

      const task = engine.getTask(r.task_id!);
      expect(task.recurrence_end_date).toBe('2026-12-31');
      expect(task.max_cycles).toBeNull();
    });

    it('rejects creation with both max_cycles and recurrence_end_date', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'recurring',
        title: 'Both bounds',
        recurrence: 'weekly',
        max_cycles: 6,
        recurrence_end_date: '2026-12-31',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Cannot set both');
    });

    it('rejects bounded recurrence on non-recurring task', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'simple',
        title: 'Not recurring',
        max_cycles: 3,
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('requires a recurring task');
    });

    it('expires recurring task when max_cycles reached', () => {
      const now = new Date().toISOString();
      const dueDate = new Date().toISOString().slice(0, 10);
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, recurrence, due_date, current_cycle, max_cycles, created_at, updated_at)
         VALUES ('R-MC1', '${BOARD_ID}', 'recurring', 'One-shot recurring', 'person-1', 'in_progress', 0, 'daily', '${dueDate}', '0', 1, '${now}', '${now}')`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'R-MC1',
        action: 'conclude',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.recurring_cycle).toBeTruthy();
      expect(r.recurring_cycle!.expired).toBe(true);
      expect(r.recurring_cycle!.reason).toBe('max_cycles');
      expect(r.recurring_cycle!.new_due_date).toBeUndefined();

      const task = engine.getTask('R-MC1');
      expect(task.column).toBe('done');
      expect(task.current_cycle).toBe('1');
    });

    it('expires recurring task when recurrence_end_date passed', () => {
      const now = new Date().toISOString();
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, recurrence, due_date, current_cycle, recurrence_end_date, created_at, updated_at)
         VALUES ('R-ED1', '${BOARD_ID}', 'recurring', 'Past-end monthly', 'person-1', 'in_progress', 0, 'monthly', '2020-01-01', '0', '2020-01-01', '${now}', '${now}')`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'R-ED1',
        action: 'conclude',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.recurring_cycle).toBeTruthy();
      expect(r.recurring_cycle!.expired).toBe(true);
      expect(r.recurring_cycle!.reason).toBe('end_date');
    });

    it('advances normally when no bounds set', () => {
      const now = new Date().toISOString();
      const dueDate = new Date().toISOString().slice(0, 10);
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, recurrence, due_date, current_cycle, created_at, updated_at)
         VALUES ('R-UB1', '${BOARD_ID}', 'recurring', 'Unbounded weekly', 'person-1', 'in_progress', 0, 'weekly', '${dueDate}', '0', '${now}', '${now}')`,
      );

      const r = engine.move({
        board_id: BOARD_ID,
        task_id: 'R-UB1',
        action: 'conclude',
        sender_name: 'Alexandre',
      });
      expect(r.success).toBe(true);
      expect(r.recurring_cycle).toBeTruthy();
      expect(r.recurring_cycle!.expired).toBe(false);
      expect(r.recurring_cycle!.new_due_date).toBeDefined();
    });

    it('updates max_cycles on recurring task', () => {
      const now = new Date().toISOString();
      const dueDate = new Date().toISOString().slice(0, 10);
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, recurrence, due_date, current_cycle, created_at, updated_at)
         VALUES ('R-UM1', '${BOARD_ID}', 'recurring', 'Update me', 'person-1', 'in_progress', 'weekly', '${dueDate}', '0', '${now}', '${now}')`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'R-UM1',
        sender_name: 'Alexandre',
        updates: { max_cycles: 12 },
      });
      expect(r.success).toBe(true);
      expect(r.changes).toContain('Limite de ciclos: 12');

      const task = engine.getTask('R-UM1');
      expect(task.max_cycles).toBe(12);
    });

    it('setting recurrence_end_date clears max_cycles', () => {
      const now = new Date().toISOString();
      const dueDate = new Date().toISOString().slice(0, 10);
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, recurrence, due_date, current_cycle, max_cycles, created_at, updated_at)
         VALUES ('R-CL1', '${BOARD_ID}', 'recurring', 'Clear cycles', 'person-1', 'in_progress', 'weekly', '${dueDate}', '0', 10, '${now}', '${now}')`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'R-CL1',
        sender_name: 'Alexandre',
        updates: { recurrence_end_date: '2026-12-31' },
      });
      expect(r.success).toBe(true);

      const task = engine.getTask('R-CL1');
      expect(task.max_cycles).toBeNull();
      expect(task.recurrence_end_date).toBe('2026-12-31');
    });

    it('rejects update with both bounds', () => {
      const now = new Date().toISOString();
      const dueDate = new Date().toISOString().slice(0, 10);
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, recurrence, due_date, current_cycle, created_at, updated_at)
         VALUES ('R-RJ1', '${BOARD_ID}', 'recurring', 'Reject both', 'person-1', 'in_progress', 'weekly', '${dueDate}', '0', '${now}', '${now}')`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'R-RJ1',
        sender_name: 'Alexandre',
        updates: { max_cycles: 5, recurrence_end_date: '2026-12-31' },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Cannot set both');
    });

    it('recurring project with bounded recurrence expires on conclude', () => {
      const now = new Date().toISOString();
      const dueDate = new Date().toISOString().slice(0, 10);
      // Insert a recurring project directly with subtask rows already done
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, recurrence, due_date, current_cycle, max_cycles, subtasks, created_at, updated_at)
         VALUES ('P-BR1', '${BOARD_ID}', 'project', 'Bounded project', 'person-1', 'in_progress', 0, 'weekly', '${dueDate}', '0', 1, '${JSON.stringify([{ id: 'P-BR1.1', title: 'Step A', status: 'done' }, { id: 'P-BR1.2', title: 'Step B', status: 'done' }]).replace(/'/g, "''")}', '${now}', '${now}')`,
      );
      // Insert subtask rows in done column
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, created_at, updated_at)
         VALUES ('P-BR1.1', '${BOARD_ID}', 'simple', 'Step A', 'person-1', 'done', 'P-BR1', '${now}', '${now}')`,
      );
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, created_at, updated_at)
         VALUES ('P-BR1.2', '${BOARD_ID}', 'simple', 'Step B', 'person-1', 'done', 'P-BR1', '${now}', '${now}')`,
      );

      const cr = engine.move({
        board_id: BOARD_ID,
        task_id: 'P-BR1',
        action: 'conclude',
        sender_name: 'Alexandre',
      });
      expect(cr.success).toBe(true);
      expect(cr.recurring_cycle).toBeTruthy();
      expect(cr.recurring_cycle!.expired).toBe(true);
      expect(cr.recurring_cycle!.reason).toBe('max_cycles');

      const task = engine.getTask('P-BR1');
      expect(task.column).toBe('done');
    });

    it('undo restores max_cycles after update', () => {
      const now = new Date().toISOString();
      const dueDate = new Date().toISOString().slice(0, 10);
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, recurrence, due_date, current_cycle, max_cycles, created_at, updated_at)
         VALUES ('R-UN1', '${BOARD_ID}', 'recurring', 'Undo cycles', 'person-1', 'in_progress', 'weekly', '${dueDate}', '0', 5, '${now}', '${now}')`,
      );

      // Update max_cycles to 12
      engine.update({
        board_id: BOARD_ID,
        task_id: 'R-UN1',
        sender_name: 'Alexandre',
        updates: { max_cycles: 12 },
      });

      let task = engine.getTask('R-UN1');
      expect(task.max_cycles).toBe(12);

      // Undo the update
      const undoResult = engine.undo({
        board_id: BOARD_ID,
        sender_name: 'Alexandre',
      });
      expect(undoResult.success).toBe(true);

      task = engine.getTask('R-UN1');
      expect(task.max_cycles).toBe(5);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  merge_project                                                     */
  /* ---------------------------------------------------------------- */

  describe('merge_project', () => {
    const MERGE_BOARD = 'board-merge';
    let db: Database.Database;
    let engine: TaskflowEngine;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(SCHEMA);

      db.exec(`INSERT INTO boards VALUES ('${MERGE_BOARD}', 'merge@g.us', 'merge', 'standard', 0, 1, NULL, NULL, NULL)`);
      db.exec(`INSERT INTO board_config VALUES ('${MERGE_BOARD}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 10, 5, 1, 1)`);
      db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${MERGE_BOARD}')`);
      db.exec(`INSERT INTO board_admins VALUES ('${MERGE_BOARD}', 'person-mgr', '5585999990001', 'manager', 1)`);
      db.exec(`INSERT INTO board_people VALUES ('${MERGE_BOARD}', 'person-mgr', 'Manager', '5585999990001', 'Gestor', 3, NULL)`);
      db.exec(`INSERT INTO board_people VALUES ('${MERGE_BOARD}', 'person-dev', 'Developer', '5585999990002', 'Dev', 3, NULL)`);

      const now = new Date().toISOString();

      // Target project P1 with one existing subtask P1.1
      db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
               VALUES ('P1', '${MERGE_BOARD}', 'project', 'Target Project', 'person-mgr', 'in_progress', '${now}', '${now}')`);
      db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, created_at, updated_at)
               VALUES ('P1.1', '${MERGE_BOARD}', 'simple', 'Existing subtask', 'person-dev', 'next_action', 'P1', '${now}', '${now}')`);

      // Source project P2 with two subtasks P2.1, P2.2
      db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, priority, created_at, updated_at)
               VALUES ('P2', '${MERGE_BOARD}', 'project', 'Source Project', 'person-dev', 'in_progress', 'high', '${now}', '${now}')`);
      db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, due_date, notes, next_note_id, created_at, updated_at)
               VALUES ('P2.1', '${MERGE_BOARD}', 'simple', 'Migrate subtask A', 'person-dev', 'in_progress', 'P2', '2026-04-20', '[]', 1, '${now}', '${now}')`);
      db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, blocked_by, notes, next_note_id, created_at, updated_at)
               VALUES ('P2.2', '${MERGE_BOARD}', 'simple', 'Migrate subtask B', 'person-mgr', 'next_action', 'P2', '["P2.1"]', '[{"id":1,"text":"existing note","at":"${now}","by":"Manager"}]', 2, '${now}', '${now}')`);

      // History for subtasks
      db.exec(`INSERT INTO task_history (board_id, task_id, action, by, at, details)
               VALUES ('${MERGE_BOARD}', 'P2.1', 'created', 'Manager', '${now}', '{}')`);
      db.exec(`INSERT INTO task_history (board_id, task_id, action, by, at, details)
               VALUES ('${MERGE_BOARD}', 'P2.2', 'created', 'Manager', '${now}', '{}')`);

      // Source project also has notes
      db.exec(`UPDATE tasks SET notes = '[{"id":1,"text":"project-level note","at":"${now}","by":"Manager"}]', next_note_id = 2
               WHERE board_id = '${MERGE_BOARD}' AND id = 'P2'`);

      engine = new TaskflowEngine(db, MERGE_BOARD);
    });

    afterEach(() => { db.close(); });

    it('merges source subtasks into target project with new IDs', () => {
      const r = engine.admin({
        board_id: MERGE_BOARD,
        action: 'merge_project',
        source_project_id: 'P2',
        target_project_id: 'P1',
        sender_name: 'Manager',
      });
      expect(r.success).toBe(true);
      expect(r.merged).toEqual({ 'P2.1': 'P1.2', 'P2.2': 'P1.3' });
      expect(r.source_archived).toBe('P2');

      // P1.2 exists on same board with P2.1's title and metadata
      const p12 = db.prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = 'P1.2'`).get(MERGE_BOARD) as any;
      expect(p12).toBeTruthy();
      expect(p12.title).toBe('Migrate subtask A');
      expect(p12.parent_task_id).toBe('P1');
      expect(p12.due_date).toBe('2026-04-20');

      // P1.3 exists with P2.2's existing notes + migration note appended
      const p13 = db.prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = 'P1.3'`).get(MERGE_BOARD) as any;
      expect(p13).toBeTruthy();
      expect(p13.title).toBe('Migrate subtask B');
      const notes = JSON.parse(p13.notes);
      expect(notes.length).toBeGreaterThanOrEqual(2);
      expect(notes.some((n: any) => n.text.includes('Migrada de P2.2'))).toBe(true);

      // Old IDs no longer exist
      expect(db.prepare(`SELECT 1 FROM tasks WHERE id = 'P2.1'`).get()).toBeUndefined();
      expect(db.prepare(`SELECT 1 FROM tasks WHERE id = 'P2.2'`).get()).toBeUndefined();

      // History rekeyed
      const hist = db.prepare(`SELECT * FROM task_history WHERE task_id = 'P1.2'`).all();
      expect(hist.length).toBeGreaterThanOrEqual(1);

      // Source project archived
      const archived = db.prepare(`SELECT * FROM archive WHERE task_id = 'P2'`).get() as any;
      expect(archived).toBeTruthy();
      expect(archived.archive_reason).toBe('merged');
    });

    it('rekeys blocked_by references from old subtask IDs to new ones', () => {
      engine.admin({
        board_id: MERGE_BOARD,
        action: 'merge_project',
        source_project_id: 'P2',
        target_project_id: 'P1',
        sender_name: 'Manager',
      });

      // P2.2 had blocked_by: ["P2.1"]. After merge, P1.3 should have blocked_by: ["P1.2"]
      const p13 = db.prepare(`SELECT blocked_by FROM tasks WHERE board_id = ? AND id = 'P1.3'`).get(MERGE_BOARD) as any;
      const blockedBy = JSON.parse(p13.blocked_by);
      expect(blockedBy).toContain('P1.2');
      expect(blockedBy).not.toContain('P2.1');
    });

    it('adds migration notes on target project', () => {
      engine.admin({
        board_id: MERGE_BOARD,
        action: 'merge_project',
        source_project_id: 'P2',
        target_project_id: 'P1',
        sender_name: 'Manager',
      });

      const p1 = db.prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = 'P1'`).get(MERGE_BOARD) as any;
      const notes = JSON.parse(p1.notes);
      expect(notes.some((n: any) => n.text.includes('mesclado') || n.text.includes('Migrada'))).toBe(true);
      expect(notes.some((n: any) => n.text.includes('project-level note') || n.text.includes('[de P2]'))).toBe(true);
    });

    it('rejects when source is not a project', () => {
      db.exec(`INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at)
               VALUES ('T5', '${MERGE_BOARD}', 'simple', 'Not a project', 'inbox', '${new Date().toISOString()}', '${new Date().toISOString()}')`);

      const r = engine.admin({
        board_id: MERGE_BOARD,
        action: 'merge_project',
        source_project_id: 'T5',
        target_project_id: 'P1',
        sender_name: 'Manager',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('project');
    });

    it('rejects when source equals target', () => {
      const r = engine.admin({
        board_id: MERGE_BOARD,
        action: 'merge_project',
        source_project_id: 'P1',
        target_project_id: 'P1',
        sender_name: 'Manager',
      });
      expect(r.success).toBe(false);
    });

    it('rejects for non-managers', () => {
      const r = engine.admin({
        board_id: MERGE_BOARD,
        action: 'merge_project',
        source_project_id: 'P2',
        target_project_id: 'P1',
        sender_name: 'Developer',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('manager');
    });

    it('rejects when source is a delegated (non-local) project', () => {
      // Regression guard for Codex gpt-5.4 review finding: archiveTask uses
      // this.boardId for the archive INSERT, so a delegated source would land
      // the archive row on the wrong board. The guard ensures only local
      // projects can be merged as the source.
      const PARENT = 'board-merge-parent';
      db.exec(`INSERT INTO boards VALUES ('${PARENT}', 'p@g.us', 'mp', 'standard', 0, 2, NULL, NULL, NULL)`);
      db.exec(`INSERT INTO board_config VALUES ('${PARENT}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 1, 5, 1, 1)`);
      db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${PARENT}')`);
      const now = new Date().toISOString();
      // Project on PARENT board, delegated to MERGE_BOARD via child_exec
      db.exec(`INSERT INTO tasks (id, board_id, type, title, column, child_exec_enabled, child_exec_board_id, created_at, updated_at)
               VALUES ('P9', '${PARENT}', 'project', 'Delegated proj', 'in_progress', 1, '${MERGE_BOARD}', '${now}', '${now}')`);
      db.exec(`INSERT INTO tasks (id, board_id, type, title, column, parent_task_id, created_at, updated_at)
               VALUES ('P9.1', '${PARENT}', 'simple', 'Delegated sub', 'next_action', 'P9', '${now}', '${now}')`);

      // Try to merge the delegated P9 (non-local to MERGE_BOARD) into local P1
      const r = engine.admin({
        board_id: MERGE_BOARD,
        action: 'merge_project',
        source_project_id: 'P9',
        target_project_id: 'P1',
        sender_name: 'Manager',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('not local');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  cross-board subtask mode                                         */
  /* ---------------------------------------------------------------- */

  describe('cross-board subtask mode', () => {
    const PARENT_BOARD = 'board-parent-xbs';
    const CHILD_BOARD = 'board-child-xbs';
    let db: Database.Database;
    let childEngine: TaskflowEngine;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(SCHEMA);

      // Parent board (level 0, max_depth 2)
      db.exec(`INSERT INTO boards VALUES ('${PARENT_BOARD}', 'parent@g.us', 'parent', 'standard', 0, 2, NULL, 'PAR', NULL)`);
      db.exec(`INSERT INTO board_config VALUES ('${PARENT_BOARD}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 1, 2, 1, 1)`);
      db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${PARENT_BOARD}')`);
      db.exec(`INSERT INTO board_people VALUES ('${PARENT_BOARD}', 'person-dev', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`);
      db.exec(`INSERT INTO board_admins VALUES ('${PARENT_BOARD}', 'person-mgr', '5585999990001', 'manager', 1)`);
      db.exec(`INSERT INTO board_people VALUES ('${PARENT_BOARD}', 'person-mgr', 'Miguel', '5585999990001', 'Gestor', 3, NULL)`);

      // Child board (level 1, max_depth 2)
      db.exec(`INSERT INTO boards VALUES ('${CHILD_BOARD}', 'child@g.us', 'child', 'standard', 1, 2, '${PARENT_BOARD}', 'CHI', NULL)`);
      db.exec(`INSERT INTO board_config VALUES ('${CHILD_BOARD}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 1, 1, 1, 1)`);
      db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${CHILD_BOARD}')`);
      db.exec(`INSERT INTO board_people VALUES ('${CHILD_BOARD}', 'person-dev', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`);
      db.exec(`INSERT INTO board_admins VALUES ('${CHILD_BOARD}', 'person-dev', '5585999990002', 'manager', 1)`);

      // Link child board registration
      db.exec(`INSERT INTO child_board_registrations VALUES ('${PARENT_BOARD}', 'person-dev', '${CHILD_BOARD}')`);

      const now = new Date().toISOString();

      // P1 — project on parent board, delegated to child board via child_exec
      db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
               VALUES ('P1', '${PARENT_BOARD}', 'project', 'Website Redesign', 'person-dev', 'in_progress', 1, '${CHILD_BOARD}', 'person-dev', '${now}', '${now}')`);

      // P1.1 — existing subtask, also delegated
      db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
               VALUES ('P1.1', '${PARENT_BOARD}', 'simple', 'Design mockups', 'person-dev', 'next_action', 'P1', 1, '${CHILD_BOARD}', 'person-dev', '${now}', '${now}')`);

      // Child board engine instance
      childEngine = new TaskflowEngine(db, CHILD_BOARD);
    });

    afterEach(() => { db.close(); });

    it('mode=open (default): child board can add subtask to delegated project', () => {
      const r = childEngine.update({
        board_id: CHILD_BOARD,
        task_id: 'P1',
        sender_name: 'Giovanni',
        updates: { add_subtask: 'Implement login page' },
      });
      expect(r.success).toBe(true);
      // Subtask created on PARENT board with ID P1.2
      const subtask = db.prepare(`SELECT * FROM tasks WHERE id = 'P1.2' AND board_id = ?`).get(PARENT_BOARD);
      expect(subtask).toBeTruthy();
    });

    it('mode=blocked: child board cannot add subtask to delegated project', () => {
      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'blocked' WHERE board_id = '${PARENT_BOARD}'`);

      const r = childEngine.update({
        board_id: CHILD_BOARD,
        task_id: 'P1',
        sender_name: 'Giovanni',
        updates: { add_subtask: 'Implement login page' },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('não permite');
      const subtask = db.prepare(`SELECT * FROM tasks WHERE id = 'P1.2'`).get();
      expect(subtask).toBeUndefined();
    });

    it('mode=approval: creates pending request with parent board target_chat_jid', () => {
      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'approval' WHERE board_id = '${PARENT_BOARD}'`);

      const r = childEngine.update({
        board_id: CHILD_BOARD,
        task_id: 'P1',
        sender_name: 'Giovanni',
        updates: { add_subtask: 'Implement login page' },
      });
      expect(r.success).toBe(false);
      expect((r as any).pending_approval).toBeTruthy();
      expect((r as any).pending_approval.request_id).toMatch(/^req-\d+-[a-z0-9]+$/);
      expect((r as any).pending_approval.target_chat_jid).toBe('parent@g.us');
      expect((r as any).pending_approval.parent_board_id).toBe(PARENT_BOARD);
      expect((r as any).pending_approval.message).toContain('🔔 *Solicitação de subtarefa*');
      expect((r as any).pending_approval.message).toContain('Implement login page');
      expect((r as any).pending_approval.message).toContain('aprovar');
      expect((r as any).pending_approval.message).toContain('rejeitar');

      // No subtask created yet
      const subtask = db.prepare(`SELECT * FROM tasks WHERE id = 'P1.2'`).get();
      expect(subtask).toBeUndefined();

      // Request persisted
      const req = db.prepare(`SELECT * FROM subtask_requests WHERE request_id = ?`).get((r as any).pending_approval.request_id) as any;
      expect(req).toBeTruthy();
      expect(req.source_board_id).toBe(CHILD_BOARD);
      expect(req.target_board_id).toBe(PARENT_BOARD);
      expect(req.parent_task_id).toBe('P1');
      expect(req.status).toBe('pending');
      expect(req.requested_by).toBe('Giovanni');
      const subtasks = JSON.parse(req.subtasks_json);
      expect(subtasks[0].title).toBe('Implement login page');
    });

    it('handle_subtask_approval approve: creates subtask on parent board + notifies child', () => {
      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'approval' WHERE board_id = '${PARENT_BOARD}'`);

      // Child creates the request
      const pending = childEngine.update({
        board_id: CHILD_BOARD,
        task_id: 'P1',
        sender_name: 'Giovanni',
        updates: { add_subtask: 'Review docs' },
      });
      const requestId = (pending as any).pending_approval.request_id;

      // Parent manager approves
      const parentEngine = new TaskflowEngine(db, PARENT_BOARD);
      const r = parentEngine.admin({
        board_id: PARENT_BOARD,
        action: 'handle_subtask_approval',
        sender_name: 'Miguel',
        request_id: requestId,
        decision: 'approve',
      });
      expect(r.success).toBe(true);
      expect((r as any).data.decision).toBe('approve');
      expect((r as any).data.created_subtask_ids).toContain('P1.2');
      expect((r as any).notifications).toBeDefined();
      expect((r as any).notifications[0].target_chat_jid).toBe('child@g.us');

      // Subtask created on parent board
      const sub = db.prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = 'P1.2'`).get(PARENT_BOARD) as any;
      expect(sub).toBeTruthy();
      expect(sub.title).toBe('Review docs');
      expect(sub.parent_task_id).toBe('P1');

      // Request marked approved
      const req = db.prepare(`SELECT * FROM subtask_requests WHERE request_id = ?`).get(requestId) as any;
      expect(req.status).toBe('approved');
      expect(req.resolved_by).toBe('Miguel');
    });

    it('handle_subtask_approval reject: marks rejected, no subtask, notifies child with reason', () => {
      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'approval' WHERE board_id = '${PARENT_BOARD}'`);

      const pending = childEngine.update({
        board_id: CHILD_BOARD,
        task_id: 'P1',
        sender_name: 'Giovanni',
        updates: { add_subtask: 'Useless task' },
      });
      const requestId = (pending as any).pending_approval.request_id;

      const parentEngine = new TaskflowEngine(db, PARENT_BOARD);
      const r = parentEngine.admin({
        board_id: PARENT_BOARD,
        action: 'handle_subtask_approval',
        sender_name: 'Miguel',
        request_id: requestId,
        decision: 'reject',
        reason: 'fora de escopo',
      });
      expect(r.success).toBe(true);
      expect((r as any).data.decision).toBe('reject');
      expect((r as any).notifications[0].message).toContain('fora de escopo');

      // No subtask
      expect(db.prepare(`SELECT * FROM tasks WHERE id = 'P1.2'`).get()).toBeUndefined();

      const req = db.prepare(`SELECT * FROM subtask_requests WHERE request_id = ?`).get(requestId) as any;
      expect(req.status).toBe('rejected');
      expect(req.reason).toBe('fora de escopo');
    });

    it('handle_subtask_approval rejects non-pending requests (idempotency)', () => {
      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'approval' WHERE board_id = '${PARENT_BOARD}'`);

      const pending = childEngine.update({
        board_id: CHILD_BOARD,
        task_id: 'P1',
        sender_name: 'Giovanni',
        updates: { add_subtask: 'T' },
      });
      const requestId = (pending as any).pending_approval.request_id;

      const parentEngine = new TaskflowEngine(db, PARENT_BOARD);
      parentEngine.admin({
        board_id: PARENT_BOARD,
        action: 'handle_subtask_approval',
        sender_name: 'Miguel',
        request_id: requestId,
        decision: 'approve',
      });

      // Second attempt → rejected
      const r = parentEngine.admin({
        board_id: PARENT_BOARD,
        action: 'handle_subtask_approval',
        sender_name: 'Miguel',
        request_id: requestId,
        decision: 'reject',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('already approved');
    });

    it('handle_subtask_approval rejects unknown request_id', () => {
      const parentEngine = new TaskflowEngine(db, PARENT_BOARD);
      const r = parentEngine.admin({
        board_id: PARENT_BOARD,
        action: 'handle_subtask_approval',
        sender_name: 'Miguel',
        request_id: 'req-does-not-exist',
        decision: 'approve',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('not found');
    });

    it('handle_subtask_approval approve rejects when proposed assignee is not registered on parent board', () => {
      // Seed child board with a person not registered on parent board
      db.exec(`INSERT INTO board_people VALUES ('${CHILD_BOARD}', 'person-new', 'Ana', '5585999990003', 'QA', 3, NULL)`);
      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'approval' WHERE board_id = '${PARENT_BOARD}'`);

      // Create a request where the child thinks Ana is the assignee
      // (we manually insert since the normal flow uses task.assignee)
      const now = new Date().toISOString();
      const reqId = 'req-test-ana';
      db.exec(`INSERT INTO subtask_requests VALUES (
        '${reqId}', '${CHILD_BOARD}', '${PARENT_BOARD}', 'P1',
        '[{"title":"Task for Ana","assignee":"Ana"}]',
        'Giovanni', 'person-dev', 'pending', NULL, NULL, NULL, '${now}', NULL
      )`);

      const parentEngine = new TaskflowEngine(db, PARENT_BOARD);
      const r = parentEngine.admin({
        board_id: PARENT_BOARD,
        action: 'handle_subtask_approval',
        sender_name: 'Miguel',
        request_id: reqId,
        decision: 'approve',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Ana');
      expect(r.error).toContain('não está cadastrad');
      expect((r as any).offer_register).toBeTruthy();

      // Request stays pending so it can be retried after registration
      const req = db.prepare(`SELECT status FROM subtask_requests WHERE request_id = ?`).get(reqId) as any;
      expect(req.status).toBe('pending');
    });

    it('approval mode refuses if parent board has no boards row or group_jid', () => {
      // Drop the parent board's registry row to simulate data integrity issue
      db.exec(`DELETE FROM boards WHERE id = '${PARENT_BOARD}'`);
      // Re-add it but with NULL group_jid... actually NOT NULL so use empty string
      // Simulating by setting the row to a missing board case: just removing and
      // not re-adding is the realistic case.

      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'approval' WHERE board_id = '${PARENT_BOARD}'`);

      const r = childEngine.update({
        board_id: CHILD_BOARD,
        task_id: 'P1',
        sender_name: 'Giovanni',
        updates: { add_subtask: 'Test' },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('quadro pai');
      expect((r as any).pending_approval).toBeUndefined();

      // No request was persisted
      const reqCount = db.prepare(`SELECT COUNT(*) as c FROM subtask_requests`).get() as any;
      expect(reqCount.c).toBe(0);
    });

    it('handle_subtask_approval rejects non-managers', () => {
      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'approval' WHERE board_id = '${PARENT_BOARD}'`);

      const pending = childEngine.update({
        board_id: CHILD_BOARD,
        task_id: 'P1',
        sender_name: 'Giovanni',
        updates: { add_subtask: 'T' },
      });
      const requestId = (pending as any).pending_approval.request_id;

      // Giovanni is a person on the parent board but NOT a manager
      const parentEngine = new TaskflowEngine(db, PARENT_BOARD);
      const r = parentEngine.admin({
        board_id: PARENT_BOARD,
        action: 'handle_subtask_approval',
        sender_name: 'Giovanni',
        request_id: requestId,
        decision: 'approve',
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('manager');
    });

    it('mode check only fires for cross-board — same-board add_subtask always allowed', () => {
      db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'blocked' WHERE board_id = '${PARENT_BOARD}'`);
      const parentEngine = new TaskflowEngine(db, PARENT_BOARD);

      const r = parentEngine.update({
        board_id: PARENT_BOARD,
        task_id: 'P1',
        sender_name: 'Miguel',
        updates: { add_subtask: 'Implement login page' },
      });
      expect(r.success).toBe(true);
    });
  });
});


describe('apiDeleteSimpleTask', () => {
  const BOARD = 'board-001'
  let db: Database.Database
  let taskId: string

  function createDeleteTestDb(): Database.Database {
    const d = new Database(':memory:')
    d.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, short_code TEXT, name TEXT NOT NULL DEFAULT '', board_role TEXT NOT NULL DEFAULT 'hierarchy', group_folder TEXT NOT NULL DEFAULT '', group_jid TEXT NOT NULL DEFAULT '');
      CREATE TABLE board_people (board_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY (board_id, person_id));
      CREATE TABLE board_id_counters (board_id TEXT NOT NULL, prefix TEXT NOT NULL, next_number INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (board_id, prefix));
      CREATE TABLE tasks (id TEXT NOT NULL, board_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'simple', title TEXT NOT NULL, assignee TEXT, column TEXT DEFAULT 'inbox', priority TEXT, requires_close_approval INTEGER NOT NULL DEFAULT 1, due_date TEXT, description TEXT, labels TEXT DEFAULT '[]', blocked_by TEXT DEFAULT '[]', reminders TEXT DEFAULT '[]', next_note_id INTEGER DEFAULT 1, notes TEXT DEFAULT '[]', _last_mutation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, child_exec_enabled INTEGER DEFAULT 0, child_exec_board_id TEXT, child_exec_person_id TEXT, child_exec_rollup_status TEXT, child_exec_last_rollup_at TEXT, child_exec_last_rollup_summary TEXT, linked_parent_board_id TEXT, linked_parent_task_id TEXT, subtasks TEXT, recurrence TEXT, current_cycle TEXT, parent_task_id TEXT, max_cycles INTEGER, recurrence_end_date TEXT, recurrence_anchor TEXT, participants TEXT, scheduled_at TEXT, created_by TEXT, PRIMARY KEY (board_id, id));
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, "by" TEXT, "at" TEXT NOT NULL, details TEXT, trigger_turn_id TEXT);
      CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
      CREATE TABLE IF NOT EXISTS child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
      INSERT INTO boards (id, short_code, name) VALUES ('board-001', 'TF', 'Delete Test Board');
      INSERT INTO board_people (board_id, person_id, name, role) VALUES ('board-001', 'person-1', 'Alice', 'Gestor');
      INSERT INTO board_people (board_id, person_id, name, role) VALUES ('board-001', 'person-2', 'Bob', 'Tecnico');
      INSERT INTO board_id_counters (board_id, prefix, next_number) VALUES ('board-001', 'T', 1);
    `)
    new TaskflowEngine(d, 'board-001')
    return d
  }

  function insertTask(d: Database.Database, id: string, createdBy: string | null = 'Alice'): void {
    const now = new Date().toISOString()
    d.prepare(
      "INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at, created_by) VALUES (?, ?, 'simple', ?, 'inbox', ?, ?, ?)"
    ).run(id, BOARD, `Task ${id}`, now, now, createdBy)
  }

  beforeEach(() => {
    db = createDeleteTestDb()
    taskId = 'T-del-1'
    insertTask(db, taskId)
  })

  afterEach(() => { db.close() })

  it('allows creator to delete and archives the task', () => {
    const engine = new TaskflowEngine(db, BOARD)
    const result = engine.apiDeleteSimpleTask({ board_id: BOARD, task_id: taskId, sender_name: 'Alice' })
    expect(result.success).toBe(true)
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)).toBeUndefined()
    expect(db.prepare('SELECT task_id FROM archive WHERE task_id = ?').get(taskId)).toBeTruthy()
    const history = db.prepare(
      'SELECT action, "by" FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1'
    ).get(BOARD, taskId) as any
    expect(history.action).toBe('delete')
    expect(history.by).toBe('Alice')
  })

  it('blocks assignee-only delete', () => {
    db.prepare('UPDATE tasks SET assignee = ? WHERE id = ? AND board_id = ?').run('Bob', taskId, BOARD)
    const engine = new TaskflowEngine(db, BOARD)
    const result = engine.apiDeleteSimpleTask({ board_id: BOARD, task_id: taskId, sender_name: 'Bob' }) as any
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('actor_type_not_allowed')
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)).toBeTruthy()
  })

  it('allows Gestor to delete any task', () => {
    const engine = new TaskflowEngine(db, BOARD)
    const result = engine.apiDeleteSimpleTask({ board_id: BOARD, task_id: taskId, sender_name: 'Alice' })
    expect(result.success).toBe(true)
  })

  it('legacy row with null created_by is Gestor-only for delete', () => {
    insertTask(db, 'T-legacy', null)
    const engine = new TaskflowEngine(db, BOARD)
    const result = engine.apiDeleteSimpleTask({ board_id: BOARD, task_id: 'T-legacy', sender_name: 'Bob' }) as any
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('actor_type_not_allowed')
  })

  it('returns conflict for delegated tasks', () => {
    db.prepare("UPDATE tasks SET child_exec_board_id = 'board-child' WHERE id = ? AND board_id = ?").run(taskId, BOARD)
    const engine = new TaskflowEngine(db, BOARD)
    const result = engine.apiDeleteSimpleTask({ board_id: BOARD, task_id: taskId, sender_name: 'Alice' }) as any
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('conflict')
  })

  it('returns not_found for missing task', () => {
    const engine = new TaskflowEngine(db, BOARD)
    const result = engine.apiDeleteSimpleTask({ board_id: BOARD, task_id: 'T-missing', sender_name: 'Alice' }) as any
    expect(result.success).toBe(false)
    expect(result.error_code).toBe('not_found')
  })

  it('service actor bypasses authorization and deletes', () => {
    const engine = new TaskflowEngine(db, BOARD)
    const result = engine.apiDeleteSimpleTask({ board_id: BOARD, task_id: taskId, sender_name: 'taskflow-api', sender_is_service: true })
    expect(result.success).toBe(true)
  })
})

// Parity guard: this fixture table MUST match src/phone.test.ts exactly.
// If either the engine or the host normalizePhone is changed, both copies
// and both fixture tables must be updated together — otherwise the host
// ----- T12 magnetism guard -----

function seedMagnetismMsgDb(): Database.Database {
  const msgDb = new Database(':memory:');
  msgDb.exec(`
    CREATE TABLE messages (
      id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE agent_turn_messages (
      turn_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_chat_jid TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      sender_name TEXT,
      message_timestamp TEXT NOT NULL,
      PRIMARY KEY (turn_id, message_id, message_chat_jid)
    );
  `);
  return msgDb;
}

function insertMsg(
  msgDb: Database.Database,
  row: {
    id: string;
    chat_jid: string;
    content: string;
    timestamp: string;
    is_from_me?: 0 | 1;
    is_bot_message?: 0 | 1;
  },
) {
  msgDb
    .prepare(
      `INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.chat_jid,
      row.content,
      row.timestamp,
      row.is_from_me ?? 0,
      row.is_bot_message ?? 0,
    );
}

function linkTurn(
  msgDb: Database.Database,
  turnId: string,
  messageId: string,
  chatJid: string,
  ordinal: number,
  timestamp: string,
) {
  msgDb
    .prepare(
      `INSERT INTO agent_turn_messages
         (turn_id, message_id, message_chat_jid, ordinal, message_timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(turnId, messageId, chatJid, ordinal, timestamp);
}

describe('T12 magnetism guard — checkTaskIdMagnetism', () => {
  let db: Database.Database;
  let msgDb: Database.Database;
  const CHAT = 'chat-1@g.us';
  const TURN = 'turn-magnetism-1';

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, BOARD_ID);
    msgDb = seedMagnetismMsgDb();
  });

  afterEach(() => {
    db.close();
    msgDb.close();
  });

  function mkEngine(mode: 'off' | 'shadow' | 'enforce' = 'shadow'): TaskflowEngine {
    return new TaskflowEngine(db, BOARD_ID, {
      triggerTurnId: TURN,
      chatJid: CHAT,
      messagesDb: msgDb,
      guardMode: mode,
    });
  }

  it('FIRES: user has no refs, prior bot asked about T13 with "?", agent picks T12', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Case: Cancelar T13? Confirme com sim.',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'só retire o prazo',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine();
    const r = engine.checkTaskIdMagnetism({ task_id: 'T12' });
    expect(r).toEqual({ shape: 'firing', expected: 'T13' });
  });

  it('CLEAR: user message contains an explicit task ref', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Cancelar T13?',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'fechar T12 agora',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine();
    expect(engine.checkTaskIdMagnetism({ task_id: 'T12' })).toEqual({
      shape: 'clear',
    });
  });

  it('CLEAR: bot msg has 3+ refs (digest/board shape)', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Digest: T1, T2, T3, T4 pendentes.',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'só retire o prazo',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine();
    expect(engine.checkTaskIdMagnetism({ task_id: 'T1' })).toEqual({
      shape: 'clear',
    });
  });

  it('CLEAR: bot msg is not a confirmation (no ? or verb)', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Entendi que você quer T13.',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'ok',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine();
    expect(engine.checkTaskIdMagnetism({ task_id: 'T12' })).toEqual({
      shape: 'clear',
    });
  });

  it('CLEAR: confirmed_task_id override bypasses the guard', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Cancelar T13?',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'só retire o prazo',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine();
    expect(
      engine.checkTaskIdMagnetism({ task_id: 'T12', confirmed_task_id: 'T12' }),
    ).toEqual({ shape: 'clear' });
  });

  it('CLEAR: guard off mode returns clear regardless of shape', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Cancelar T13?',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'só retire o prazo',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine('off');
    expect(engine.checkTaskIdMagnetism({ task_id: 'T12' })).toEqual({
      shape: 'clear',
    });
  });

  it('CLEAR: fails open when messagesDb missing', () => {
    const engine = new TaskflowEngine(db, BOARD_ID, {
      triggerTurnId: TURN,
      chatJid: CHAT,
      messagesDb: null,
      guardMode: 'enforce',
    });
    expect(engine.checkTaskIdMagnetism({ task_id: 'T12' })).toEqual({
      shape: 'clear',
    });
  });

  it('FIRES: concatenates consecutive bot messages within 30s ("Cancelar T13?" + "Confirme com sim.")', () => {
    insertMsg(msgDb, {
      id: 'bot-a',
      chat_jid: CHAT,
      content: 'Cancelar T13?',
      timestamp: '2026-04-23T15:08:25.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'bot-b',
      chat_jid: CHAT,
      content: 'Confirme com sim.',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'só retire o prazo',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine();
    const r = engine.checkTaskIdMagnetism({ task_id: 'T12' });
    expect(r).toEqual({ shape: 'firing', expected: 'T13' });
  });

  it('enforce mode: engine.move() returns ambiguous_task_context error', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Cancelar T13?',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'só retire o prazo',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine('enforce');
    const r = engine.move({
      board_id: BOARD_ID,
      task_id: 'T-002',
      action: 'start',
      sender_name: 'Alexandre',
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('ambiguous_task_context');
    expect(r.expected_task_id).toBe('T13');
    expect(r.actual_task_id).toBe('T-002');
  });

  it('shadow mode: engine.move() succeeds but writes magnetism_shadow_flag to task_history', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Cancelar T13?',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'só retire o prazo',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine('shadow');
    const r = engine.move({
      board_id: BOARD_ID,
      task_id: 'T-002',
      action: 'start',
      sender_name: 'Alexandre',
    });
    expect(r.success).toBe(true);
    const flags = db
      .prepare(
        `SELECT action, details FROM task_history WHERE task_id = 'T-002' AND action = 'magnetism_shadow_flag'`,
      )
      .all() as Array<{ action: string; details: string }>;
    expect(flags).toHaveLength(1);
    expect(JSON.parse(flags[0].details)).toMatchObject({
      expected: 'T13',
      mode: 'shadow',
      path: 'move',
    });
  });

  it('records magnetism_override in task_history when confirmed_task_id is passed', () => {
    insertMsg(msgDb, {
      id: 'bot-1',
      chat_jid: CHAT,
      content: 'Cancelar T13?',
      timestamp: '2026-04-23T15:08:30.000Z',
      is_from_me: 1,
    });
    insertMsg(msgDb, {
      id: 'user-1',
      chat_jid: CHAT,
      content: 'só retire o prazo',
      timestamp: '2026-04-23T15:08:37.000Z',
    });
    linkTurn(msgDb, TURN, 'user-1', CHAT, 0, '2026-04-23T15:08:37.000Z');

    const engine = mkEngine('enforce');
    const r = engine.move({
      board_id: BOARD_ID,
      task_id: 'T-002',
      action: 'start',
      sender_name: 'Alexandre',
      confirmed_task_id: 'T-002',
    });
    expect(r.success).toBe(true);
    const overrides = db
      .prepare(
        `SELECT details FROM task_history WHERE task_id = 'T-002' AND action = 'magnetism_override'`,
      )
      .all() as Array<{ details: string }>;
    expect(overrides).toHaveLength(1);
  });
});

describe('completion notification (three-variant policy)', () => {
  describe('completionVariant', () => {
    it('returns quiet for recurring tasks regardless of age', () => {
      expect(
        TaskflowEngine.completionVariant({
          recurrence: 'weekly',
          requires_close_approval: 1,
          created_at: '2024-01-01T00:00:00Z',
        }),
      ).toBe('quiet');
    });

    it('returns loud when requires_close_approval is truthy', () => {
      expect(
        TaskflowEngine.completionVariant({
          recurrence: null,
          requires_close_approval: 1,
          created_at: new Date().toISOString(),
        }),
      ).toBe('loud');
    });

    it('returns loud when task is older than 7 days', () => {
      const created = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
      expect(
        TaskflowEngine.completionVariant({
          recurrence: null,
          requires_close_approval: 0,
          created_at: created,
        }),
      ).toBe('loud');
    });

    it('returns cheerful for default one-shot tasks under 7 days', () => {
      const created = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
      expect(
        TaskflowEngine.completionVariant({
          recurrence: null,
          requires_close_approval: 0,
          created_at: created,
        }),
      ).toBe('cheerful');
    });

    it('7-day boundary: exactly 7d old is loud (inclusive)', () => {
      const exactly7 = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
      expect(
        TaskflowEngine.completionVariant({
          recurrence: null,
          requires_close_approval: 0,
          created_at: exactly7,
        }),
      ).toBe('loud');

      const justUnder7 = new Date(Date.now() - 7 * 86400 * 1000 + 1000).toISOString();
      expect(
        TaskflowEngine.completionVariant({
          recurrence: null,
          requires_close_approval: 0,
          created_at: justUnder7,
        }),
      ).toBe('cheerful');
    });

    it('handles string/boolean truthy encodings of requires_close_approval', () => {
      expect(
        TaskflowEngine.completionVariant({
          recurrence: null,
          requires_close_approval: '1',
          created_at: new Date().toISOString(),
        }),
      ).toBe('loud');
      expect(
        TaskflowEngine.completionVariant({
          recurrence: null,
          requires_close_approval: true,
          created_at: new Date().toISOString(),
        }),
      ).toBe('loud');
    });
  });

  describe('renderCompletionMessage', () => {
    const base = { taskId: 'T71', title: 'eMails FMC', assigneeName: 'Lucas' };

    it('quiet: create-card skeleton with single SEP, no celebration emoji', () => {
      const msg = TaskflowEngine.renderCompletionMessage({ variant: 'quiet', ...base });
      expect(msg).toContain('✅ *Tarefa concluída*');
      expect(msg).toContain('━━━━━━━━━━━━━━');
      expect(msg).toContain('*T71* — eMails FMC');
      expect(msg).toContain('👤 *Entregue por:* Lucas');
      expect(msg).not.toContain('🎉');
    });

    it('cheerful: celebration header with single SEP and column transition line', () => {
      const msg = TaskflowEngine.renderCompletionMessage({
        variant: 'cheerful',
        ...base,
        fromColumn: 'review',
      });
      expect(msg).toContain('🎉 *Tarefa concluída!*');
      expect(msg).toContain('━━━━━━━━━━━━━━');
      expect(msg).toContain('👤 *Entregue por:* Lucas');
      expect(msg).toContain('🎯 *Revisão → Concluída*');
    });

    it('loud: bookending SEPs, inline prose, italicized fluxo', () => {
      const created = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
      const msg = TaskflowEngine.renderCompletionMessage({
        variant: 'loud',
        ...base,
        createdAt: created,
        flow: 'Em Andamento → Revisão → Concluída',
      });
      expect(msg.match(/━━━━━━━━━━━━━━/g)?.length).toBe(2);
      expect(msg).toContain('🎉 *Tarefa concluída!*');
      expect(msg).toContain('Lucas entregou em 3 dias 👏');
      expect(msg).toContain('_Fluxo: Em Andamento → Revisão → Concluída_');
    });

    it('loud: handles created today ("hoje") and single-day ("em 1 dia")', () => {
      const todayMsg = TaskflowEngine.renderCompletionMessage({
        variant: 'loud',
        ...base,
        createdAt: new Date().toISOString(),
        flow: 'Inbox → Concluída',
      });
      expect(todayMsg).toContain('Lucas entregou hoje 👏');

      const oneDay = new Date(Date.now() - 1 * 86400 * 1000).toISOString();
      const oneDayMsg = TaskflowEngine.renderCompletionMessage({
        variant: 'loud',
        ...base,
        createdAt: oneDay,
        flow: 'Inbox → Concluída',
      });
      expect(oneDayMsg).toContain('Lucas entregou em 1 dia 👏');
    });

    it('formatDuration: same-day completion (12h elapsed) says "hoje", not "em 1 dia"', () => {
      // Regression guard for the Math.round → Math.floor fix.
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      expect(TaskflowEngine.formatDuration(twelveHoursAgo)).toBe('hoje');
      const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
      expect(TaskflowEngine.formatDuration(twentyThreeHoursAgo)).toBe('hoje');
    });
  });

  describe('computeTaskFlow', () => {
    let db: Database.Database;
    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE task_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          board_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          action TEXT NOT NULL,
          by TEXT,
          at TEXT NOT NULL,
          details TEXT
        );
      `);
    });
    afterEach(() => db.close());

    it('produces ordered unique flow from moved/start/conclude rows', () => {
      const insert = db.prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insert.run('b1', 'T1', 'start', 'x', '2026-04-20T10:00:00Z', JSON.stringify({ from: 'inbox', to: 'in_progress' }));
      insert.run('b1', 'T1', 'moved', 'x', '2026-04-21T10:00:00Z', JSON.stringify({ from: 'in_progress', to: 'review' }));
      insert.run('b1', 'T1', 'conclude', 'x', '2026-04-22T10:00:00Z', JSON.stringify({ from: 'review', to: 'done' }));

      expect(TaskflowEngine.computeTaskFlow(db, 'b1', 'T1')).toBe(
        'Inbox → Em Andamento → Revisão → Concluída',
      );
    });

    it('collapses consecutive duplicate columns', () => {
      const insert = db.prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insert.run('b1', 'T1', 'moved', 'x', '2026-04-20T10:00:00Z', JSON.stringify({ from: 'inbox', to: 'next_action' }));
      insert.run('b1', 'T1', 'moved', 'x', '2026-04-21T10:00:00Z', JSON.stringify({ from: 'next_action', to: 'next_action' }));
      insert.run('b1', 'T1', 'conclude', 'x', '2026-04-22T10:00:00Z', JSON.stringify({ from: 'next_action', to: 'done' }));

      expect(TaskflowEngine.computeTaskFlow(db, 'b1', 'T1')).toBe(
        'Inbox → Próximas Ações → Concluída',
      );
    });

    it('falls back to "Concluída" when no history rows exist', () => {
      expect(TaskflowEngine.computeTaskFlow(db, 'b1', 'T-missing')).toBe('Concluída');
    });

    it('skips malformed JSON details without throwing', () => {
      db.prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('b1', 'T1', 'moved', 'x', '2026-04-20T10:00:00Z', '{this is not valid json');
      db.prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('b1', 'T1', 'conclude', 'x', '2026-04-21T10:00:00Z', JSON.stringify({ from: 'review', to: 'done' }));
      expect(TaskflowEngine.computeTaskFlow(db, 'b1', 'T1')).toBe('Revisão → Concluída');
    });
  });

  describe('columnLabelPlain', () => {
    it('strips leading emoji+space', () => {
      expect(TaskflowEngine.columnLabelPlain('done')).toBe('Concluída');
      expect(TaskflowEngine.columnLabelPlain('review')).toBe('Revisão');
      expect(TaskflowEngine.columnLabelPlain('in_progress')).toBe('Em Andamento');
    });

    it('returns the raw label unchanged when no leading emoji is present', () => {
      expect(TaskflowEngine.columnLabelPlain('unknown_col')).toBe('unknown_col');
    });
  });
});

// will write rows the engine can't look up (or vice versa).
describe('normalizePhone parity with host src/phone.ts', () => {
  const fixtures: Array<[string, string]> = [
    ['5585999991234', '5585999991234'],
    ['+55 (85) 99999-1234', '5585999991234'],
    ['86999986334', '5586999986334'],
    ['8688080333', '558688080333'],
    ['558699487547', '558699487547'],
    ['', ''],
    ['   ---', ''],
    ['1234567', '1234567'],
    ['08599991234', '08599991234'],
    ['442079460958', '442079460958'],
  ];
  for (const [input, expected] of fixtures) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizePhone(input)).toBe(expected);
    });
  }
});
