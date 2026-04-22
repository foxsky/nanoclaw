import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskflowEngine } from './taskflow-engine.js';

export function createMutationTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY,
      short_code TEXT,
      group_folder TEXT NOT NULL DEFAULT '',
      group_jid TEXT NOT NULL DEFAULT '',
      board_role TEXT NOT NULL DEFAULT 'standard'
    );
    CREATE TABLE board_people (
      board_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT,
      wip_limit INTEGER,
      PRIMARY KEY (board_id, person_id)
    );
    CREATE TABLE board_id_counters (
      board_id TEXT NOT NULL,
      prefix TEXT NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (board_id, prefix)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      board_code TEXT,
      title TEXT NOT NULL,
      assignee TEXT,
      "column" TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT,
      due_date TEXT,
      type TEXT NOT NULL DEFAULT 'simple',
      labels TEXT,
      description TEXT,
      notes TEXT,
      parent_task_id TEXT,
      scheduled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,
      requires_close_approval INTEGER NOT NULL DEFAULT 0,
      child_exec_board_id TEXT,
      child_exec_person_id TEXT,
      child_exec_rollup_status TEXT
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      by TEXT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      details TEXT,
      trigger_turn_id TEXT
    );
    INSERT INTO boards (id, short_code, group_folder, group_jid, board_role)
      VALUES ('board-001', 'B001', 'test', 'test@g.us', 'standard');
    INSERT INTO board_people (board_id, person_id, name, phone, role)
      VALUES ('board-001', 'person-1', 'Alice', '5551001', 'Gestor'),
             ('board-001', 'person-2', 'Bob', '5551002', 'Tecnico');
    INSERT INTO board_id_counters (board_id, prefix, next_number)
      VALUES ('board-001', 'T', 1);
  `);
  return db;
}

describe('apiCreateSimpleTask', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = createMutationTestDb();
    engine = new TaskflowEngine(db, 'board-001');
  });
  afterEach(() => { db.close(); });

  it('creates a task with default column and priority', async () => {
    const result = await engine.apiCreateSimpleTask({ title: 'Test task', sender_name: 'Alice' });
    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(data.title).toBe('Test task');
    expect(data.column).toBe('inbox');
    expect(data.priority).toBe('normal');
    expect(data.created_by).toBe('Alice');
    expect((result as any).notification_events).toEqual([]);
  });

  it('allocates a T-number task id', async () => {
    const result = await engine.apiCreateSimpleTask({ title: 'My task', sender_name: 'Alice' });
    expect((result as any).data.id).toMatch(/^T\d+$/);
  });

  it('records a created history entry with correct board_id', async () => {
    const result = await engine.apiCreateSimpleTask({ title: 'Hist task', sender_name: 'Alice' });
    const taskId = (result as any).data.id;
    const hist = db.prepare(
      "SELECT * FROM task_history WHERE task_id = ? AND action = 'created'"
    ).get(taskId) as any;
    expect(hist).toBeTruthy();
    expect(hist.board_id).toBe('board-001');
    expect(hist.by).toBe('web-api');
  });

  it('assigns to named person and emits deferred notification', async () => {
    const result = await engine.apiCreateSimpleTask({ title: 'Assigned', sender_name: 'Alice', assignee: 'Bob' });
    expect((result as any).data.assignee).toBe('Bob');
    const evts = (result as any).notification_events;
    expect(evts).toHaveLength(1);
    expect(evts[0].kind).toBe('deferred_notification');
    expect(evts[0].target_person_id).toBe('person-2');
    expect(evts[0].board_id).toBe('board-001');
  });

  it('does not emit notification when sender self-assigns', async () => {
    const result = await engine.apiCreateSimpleTask({ title: 'Self', sender_name: 'Alice', assignee: 'Alice' });
    expect((result as any).notification_events).toHaveLength(0);
  });

  it('returns validation_error for unknown assignee', async () => {
    const result = await engine.apiCreateSimpleTask({ title: 'Bad', sender_name: 'Alice', assignee: 'nobody' });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('validation_error');
  });

  it('normalizes English priority to Portuguese', async () => {
    const result = await engine.apiCreateSimpleTask({ title: 'Urgent', sender_name: 'Alice', priority: 'urgent' });
    expect((result as any).data.priority).toBe('urgente');
  });

  it('returns not_found when board counter does not exist', async () => {
    const engine2 = new TaskflowEngine(db, 'board-999');
    const result = await engine2.apiCreateSimpleTask({ title: 'No board', sender_name: 'Alice' });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('not_found');
  });
});
