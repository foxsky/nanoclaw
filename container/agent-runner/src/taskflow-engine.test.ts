import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskflowEngine } from './taskflow-engine.js';

const BOARD_ID = 'board-test-001';

const SCHEMA = `
CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, board_role TEXT DEFAULT 'standard', hierarchy_level INTEGER, max_depth INTEGER, parent_board_id TEXT);
CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, role TEXT DEFAULT 'member', wip_limit INTEGER, notification_group_jid TEXT, PRIMARY KEY (board_id, person_id));
CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
CREATE TABLE tasks (id TEXT NOT NULL, board_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'simple', title TEXT NOT NULL, assignee TEXT, next_action TEXT, waiting_for TEXT, column TEXT DEFAULT 'inbox', priority TEXT, due_date TEXT, description TEXT, labels TEXT DEFAULT '[]', blocked_by TEXT DEFAULT '[]', reminders TEXT DEFAULT '[]', next_note_id INTEGER DEFAULT 1, notes TEXT DEFAULT '[]', _last_mutation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, child_exec_enabled INTEGER DEFAULT 0, child_exec_board_id TEXT, child_exec_person_id TEXT, child_exec_rollup_status TEXT, child_exec_last_rollup_at TEXT, child_exec_last_rollup_summary TEXT, linked_parent_board_id TEXT, linked_parent_task_id TEXT, subtasks TEXT, recurrence TEXT, current_cycle TEXT, PRIMARY KEY (board_id, id));
CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza', runner_standup_task_id TEXT, runner_digest_task_id TEXT, runner_review_task_id TEXT, runner_dst_guard_task_id TEXT, standup_cron_local TEXT, digest_cron_local TEXT, review_cron_local TEXT, standup_cron_utc TEXT, digest_cron_utc TEXT, review_cron_utc TEXT, dst_sync_enabled INTEGER DEFAULT 0, dst_last_offset_minutes INTEGER, dst_last_synced_at TEXT, dst_resync_count_24h INTEGER DEFAULT 0, dst_resync_window_started_at TEXT, attachment_enabled INTEGER DEFAULT 1, attachment_disabled_reason TEXT DEFAULT '', attachment_allowed_formats TEXT DEFAULT '["pdf","jpg","png"]', attachment_max_size_bytes INTEGER DEFAULT 10485760, welcome_sent INTEGER DEFAULT 0, standup_target TEXT DEFAULT 'team', digest_target TEXT DEFAULT 'team', review_target TEXT DEFAULT 'team', runner_standup_secondary_task_id TEXT, runner_digest_secondary_task_id TEXT, runner_review_secondary_task_id TEXT);
CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
`;

function seedTestDb(db: Database.Database, boardId: string) {
  db.exec(SCHEMA);

  db.exec(
    `INSERT INTO boards VALUES ('${boardId}', 'test@g.us', 'test', 'standard', 0, 1, NULL)`,
  );
  db.exec(
    `INSERT INTO board_config VALUES ('${boardId}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 4, 1)`,
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
    `INSERT INTO tasks (id, board_id, type, title, assignee, column, priority, created_at, updated_at)
     VALUES ('T-001', '${boardId}', 'simple', 'Fix login bug', 'person-1', 'in_progress', 'high', '${now}', '${now}')`,
  );
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
     VALUES ('T-002', '${boardId}', 'simple', 'Update docs', 'person-2', 'next_action', '${now}', '${now}')`,
  );
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at)
     VALUES ('T-003', '${boardId}', 'simple', 'Review PR', 'inbox', '${now}', '${now}')`,
  );
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
      expect(r.task_id).toBe('T-004');
      expect(r.column).toBe('inbox');

      // Verify task in DB
      const task = engine.getTask('T-004');
      expect(task).toBeTruthy();
      expect(task.title).toBe('Buy supplies');
      expect(task.type).toBe('simple'); // inbox stored as simple
      expect(task.column).toBe('inbox');
      expect(task.assignee).toBeNull();
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
      expect(r.task_id).toBe('T-004');
      expect(r.column).toBe('next_action');

      // Verify task in DB
      const task = engine.getTask('T-004');
      expect(task.title).toBe('Deploy v2');
      expect(task.assignee).toBe('person-2');
      expect(task.column).toBe('next_action');

      // Notification: sender (Alexandre/person-1) != assignee (Giovanni/person-2)
      expect(r.notifications).toHaveLength(1);
      expect(r.notifications![0].target_person_id).toBe('person-2');
      expect(r.notifications![0].message).toContain('T-004');
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
      expect(r.offer_register!.message).toContain('Rafael not registered');
      expect(r.offer_register!.message).toContain('Alexandre');
      expect(r.offer_register!.message).toContain('Giovanni');
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
      expect(r.task_id).toBe('P-004');
      expect(r.column).toBe('inbox'); // no assignee → inbox

      const task = engine.getTask('P-004');
      expect(task.type).toBe('project');
      const subtasks = JSON.parse(task.subtasks);
      expect(subtasks).toHaveLength(3);
      expect(subtasks[0]).toEqual({ id: 'P-004.1', title: 'Design', status: 'pending' });
      expect(subtasks[1]).toEqual({ id: 'P-004.2', title: 'Implement', status: 'pending' });
      expect(subtasks[2]).toEqual({ id: 'P-004.3', title: 'Test', status: 'pending' });
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
      expect(r.task_id).toBe('R-004');

      const task = engine.getTask('R-004');
      expect(task.type).toBe('recurring');
      expect(task.recurrence).toBe('weekly');
      expect(task.due_date).toBeTruthy(); // auto-calculated
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
          `SELECT * FROM task_history WHERE board_id = ? AND task_id = 'T-004'`,
        )
        .all(BOARD_ID) as any[];
      expect(history).toHaveLength(1);
      expect(history[0].action).toBe('created');
      expect(history[0].by).toBe('Alexandre');
      const details = JSON.parse(history[0].details);
      expect(details.title).toBe('History test');
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
      expect(r1.task_id).toBe('T-004');
      expect(r2.task_id).toBe('T-005');

      // Verify next_task_number in DB is now 6
      const config = db
        .prepare(`SELECT next_task_number FROM board_config WHERE board_id = ?`)
        .get(BOARD_ID) as { next_task_number: number };
      expect(config.next_task_number).toBe(6);
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
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, recurrence, due_date, current_cycle, created_at, updated_at)
         VALUES ('R-020', '${BOARD_ID}', 'recurring', 'Weekly check', 'person-1', 'in_progress', 'weekly', '${dueDate}', '0', '${now}', '${now}')`,
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
      expect(r.offer_register!.message).toContain('Rafael not registered');
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

    it('no WIP check on reassignment', () => {
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
      // Should succeed despite WIP limit — by design
      expect(r.success).toBe(true);
      expect(r.tasks_affected).toHaveLength(1);

      const task = engine.getTask('T-001');
      expect(task.assignee).toBe('person-2');
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
      expect(r.changes).toContain('Title changed to "Fix login bug v2"');

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
      expect(r.changes).toContain('Priority set to urgent');

      const task = engine.getTask('T-001');
      expect(task.priority).toBe('urgent');
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
      expect(r.changes).toContain('Due date set to 2026-12-31');

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
      expect(r.changes).toContain('Due date removed');

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
      expect(r1.changes).toContain('Label "frontend" added');

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
      expect(r.changes).toContain('Label "frontend" removed');

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
      expect(r1.changes).toContain('Note #1 added');

      const r2 = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-001',
        sender_name: 'Alexandre',
        updates: { add_note: 'Second note' },
      });
      expect(r2.success).toBe(true);
      expect(r2.changes).toContain('Note #2 added');

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
      expect(r.changes).toContain('Note #1 edited');

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
      expect(r.changes).toContain('Note #2 removed');

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
      expect(r.changes).toContain('Title changed to "Updated by assignee"');
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
      expect(r.changes).toContain('Priority set to high');
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
      expect(details.changes).toContain('Title changed to "History test"');
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
});
