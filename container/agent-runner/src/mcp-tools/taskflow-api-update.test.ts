import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb, initTestTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';

let db: Database;
let taskId: string;

/** Mirrors v1's `createEngineDb` factory + a created task for update tests. */
function setupEngineDb(boardId: string): Database {
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
      PRIMARY KEY (board_id, person_id)
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
  d.prepare(`INSERT INTO boards (id, short_code, name) VALUES (?, 'TF', 'Test Board')`).run(boardId);
  d.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'alice', 'alice', 'manager'), (?, 'charlie', 'charlie', 'Tecnico')`,
  ).run(boardId, boardId);
  d.prepare(`INSERT INTO board_id_counters (board_id, prefix, next_number) VALUES (?, 'T', 1)`).run(
    boardId,
  );
  new TaskflowEngine(d, boardId);
  return d;
}

const BOARD = 'b1';

beforeEach(async () => {
  db = setupEngineDb(BOARD);
  const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
  const create = await apiCreateSimpleTaskTool.handler({
    board_id: BOARD,
    title: 'Original',
    sender_name: 'alice',
  });
  taskId = JSON.parse(create.content[0].text).data.id;
});

afterEach(() => {
  closeTaskflowDb();
});

async function update(args: Record<string, unknown>) {
  const { apiUpdateSimpleTaskTool } = await import('./taskflow-api-update.ts');
  return apiUpdateSimpleTaskTool.handler(args);
}

describe('api_update_simple_task MCP tool', () => {
  it('exports a tool with name "api_update_simple_task"', async () => {
    const { apiUpdateSimpleTaskTool } = await import('./taskflow-api-update.ts');
    expect(apiUpdateSimpleTaskTool.tool.name).toBe('api_update_simple_task');
  });

  it('updates present fields', async () => {
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      title: 'Updated',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.title).toBe('Updated');
  });

  it('does not alter absent fields', async () => {
    db.prepare(`UPDATE tasks SET priority = 'urgente' WHERE id = ?`).run(taskId);
    await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      title: 'New',
    });
    const row = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(taskId) as
      | { priority: string }
      | null;
    expect(row?.priority).toBe('urgente');
  });

  it('records an updated history entry', async () => {
    await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      title: 'Changed',
    });
    const hist = db
      .prepare(`SELECT * FROM task_history WHERE task_id = ? AND action = 'updated'`)
      .get(taskId);
    expect(hist).toBeTruthy();
  });

  it('returns not_found for unknown task_id', async () => {
    const resp = await update({
      board_id: BOARD,
      task_id: 'T999',
      sender_name: 'alice',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('not_found');
  });

  it('returns conflict when moving to done with close_approval required', async () => {
    db.prepare(`UPDATE tasks SET requires_close_approval = 1 WHERE id = ?`).run(taskId);
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      column: 'done',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('conflict');
  });

  it('allows move to done without close_approval', async () => {
    db.prepare(`UPDATE tasks SET requires_close_approval = 0 WHERE id = ?`).run(taskId);
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      column: 'done',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.column).toBe('done');
  });

  it('returns actor_type_not_allowed for unrelated board member', async () => {
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'charlie',
      title: 'Hijack',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('actor_type_not_allowed');
  });

  it('Gestor can modify any task', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'dave', 'dave', 'Gestor')`,
    ).run(BOARD);
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'dave',
      title: 'Admin edit',
    });
    expect(JSON.parse(resp.content[0].text).success).toBe(true);
  });

  it('service account bypasses auth check', async () => {
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'taskflow-api',
      sender_is_service: true,
      title: 'Service edit',
    });
    expect(JSON.parse(resp.content[0].text).success).toBe(true);
  });

  it('task with null created_by is open to any board member', async () => {
    db.prepare(`UPDATE tasks SET created_by = NULL WHERE id = ?`).run(taskId);
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'charlie',
      title: 'Open task',
    });
    expect(JSON.parse(resp.content[0].text).success).toBe(true);
  });

  it('assignee can modify task', async () => {
    await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      assignee: 'charlie',
    });
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'charlie',
      title: 'By assignee',
    });
    expect(JSON.parse(resp.content[0].text).success).toBe(true);
  });

  it('emits deferred notification when assignee changes', async () => {
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      assignee: 'charlie',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.notification_events).toHaveLength(1);
    expect(result.notification_events[0].target_person_id).toBe('charlie');
  });

  it('returns validation_error for unknown assignee', async () => {
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      assignee: 'nobody',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('validation_error');
  });

  it('clears assignee when null is passed', async () => {
    await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      assignee: 'charlie',
    });
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      assignee: null,
    });
    expect(JSON.parse(resp.content[0].text).data.assignee).toBeNull();
  });

  it('rejects non-string board_id', async () => {
    const resp = await update({
      board_id: 42 as unknown as string,
      task_id: taskId,
      sender_name: 'alice',
    });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/board_id/);
  });

  it('priority synonym mapping (urgent → urgente)', async () => {
    await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      priority: 'urgent',
    });
    const row = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(taskId) as
      | { priority: string }
      | null;
    expect(row?.priority).toBe('urgente');
  });

  it('labels: trims items per v1 zod .trim() transform', async () => {
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      labels: ['  foo  ', '\tbar\n'],
    });
    expect(JSON.parse(resp.content[0].text).success).toBe(true);
    const row = db.prepare('SELECT labels FROM tasks WHERE id = ?').get(taskId) as
      | { labels: string }
      | null;
    expect(JSON.parse(row!.labels)).toEqual(['foo', 'bar']);
  });

  it('labels: rejects whitespace-only items (zod .min(1) after trim)', async () => {
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      labels: ['valid', '   '],
    });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/labels/);
  });

  it('labels: undefined clears to "[]" via SET-clause ?? null path', async () => {
    db.prepare(`UPDATE tasks SET labels = '["pre-existing"]' WHERE id = ?`).run(taskId);
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      labels: undefined,
    });
    expect(JSON.parse(resp.content[0].text).success).toBe(true);
    const row = db.prepare('SELECT labels FROM tasks WHERE id = ?').get(taskId) as
      | { labels: string }
      | null;
    expect(row?.labels).toBe('[]');
  });

  it('description: null clears the field (zod .nullable() parity)', async () => {
    db.prepare(`UPDATE tasks SET description = 'pre' WHERE id = ?`).run(taskId);
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      description: null,
    });
    expect(JSON.parse(resp.content[0].text).data.description).toBeNull();
  });

  it('explicit assignee: undefined treated as present-with-clear (zod .optional() parity)', async () => {
    // First set assignee, then call update with explicit undefined to clear.
    await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      assignee: 'charlie',
    });
    const resp = await update({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      assignee: undefined,
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(true);
    // 'assignee' in args was true, so assignee = ?? null → cleared.
    expect(result.data.assignee).toBeNull();
  });
});
