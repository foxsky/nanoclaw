import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb, initTestTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';

let db: Database;

/** Sets up an in-memory TaskFlow DB matching v1's `createEngineDb` factory:
 *  base schema (boards, board_people, board_id_counters, tasks-shape,
 *  task_history, archive, child_board_registrations) seeded with one board
 *  and one manager; then runs the engine constructor to apply migrations. */
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
      parent_task_id TEXT,
      max_cycles INTEGER,
      recurrence_end_date TEXT,
      recurrence_anchor TEXT,
      participants TEXT,
      scheduled_at TEXT,
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
    `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'alice', 'alice', 'manager')`,
  ).run(boardId);
  d.prepare(`INSERT INTO board_id_counters (board_id, prefix, next_number) VALUES (?, 'T', 1)`).run(
    boardId,
  );
  new TaskflowEngine(d, boardId);
  return d;
}

const BOARD = 'b1';

beforeEach(() => {
  db = setupEngineDb(BOARD);
});

afterEach(() => {
  closeTaskflowDb();
});

describe('api_create_simple_task MCP tool', () => {
  it('exports a tool with name "api_create_simple_task"', async () => {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    expect(apiCreateSimpleTaskTool.tool.name).toBe('api_create_simple_task');
  });

  it('declares required board_id, title, sender_name and optional assignee/priority/due_date/description', async () => {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiCreateSimpleTaskTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['board_id', 'title', 'sender_name']));
    expect(schema.properties).toHaveProperty('assignee');
    expect(schema.properties).toHaveProperty('priority');
    expect(schema.properties).toHaveProperty('due_date');
    expect(schema.properties).toHaveProperty('description');
  });

  it('returns success with full task data including created_by', async () => {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Test Task from MCP',
      sender_name: 'alice',
      priority: 'normal',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.title).toBe('Test Task from MCP');
    expect(result.data.board_id).toBe(BOARD);
    expect(result.data.board_code).toBe('TF');
    expect(result.data.created_by).toBe('alice');
    expect(result.data.column).toBe('inbox');
    expect(typeof result.data.id).toBe('string');
    expect(Array.isArray(result.notification_events)).toBe(true);
  });

  it('propagates engine error as JSON (not thrown)', async () => {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Should fail',
      sender_name: 'unknownperson',
      assignee: 'nonexistent-assignee',
    });
    const result = JSON.parse(response.content[0].text);
    expect(response.content[0].type).toBe('text');
    expect(typeof result).toBe('object');
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('rejects non-string board_id', async () => {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateSimpleTaskTool.handler({
      board_id: 42 as unknown as string,
      title: 'X',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/board_id/);
  });

  it('rejects non-string title', async () => {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: null as unknown as string,
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/title/);
  });

  it('accepts empty-string required fields (z.string() parity)', async () => {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateSimpleTaskTool.handler({
      board_id: '',
      title: '',
      sender_name: '',
    });
    // Engine path is reached — empty strings pass validation. Response is a
    // JSON-stringified engine result (success=false here because no board ''
    // exists), not an isError-flagged validation failure.
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0].text);
    expect(body.success).toBe(false);
  });

  it('accepts explicit due_date: null (passes through ?? undefined to engine)', async () => {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Null due_date test',
      sender_name: 'alice',
      due_date: null,
    });
    const body = JSON.parse(response.content[0].text);
    expect(body.success).toBe(true);
    expect(body.data.due_date).toBeNull();
  });
});

describe('api_delete_simple_task MCP tool', () => {
  it('exports a tool with name "api_delete_simple_task"', async () => {
    const { apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    expect(apiDeleteSimpleTaskTool.tool.name).toBe('api_delete_simple_task');
  });

  it('declares required board_id, task_id, sender_name; optional sender_is_service', async () => {
    const { apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiDeleteSimpleTaskTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['board_id', 'task_id', 'sender_name']),
    );
    expect(schema.properties).toHaveProperty('sender_is_service');
  });

  it('creator can delete; success with deleted:true; row removed', async () => {
    const { apiCreateSimpleTaskTool, apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const create = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Delete candidate',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(create.content[0].text).data.id;

    const del = await apiDeleteSimpleTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
    });
    const result = JSON.parse(del.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.deleted).toBe(true);
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)).toBeNull();
  });

  it('returns not_found for missing task', async () => {
    const { apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiDeleteSimpleTaskTool.handler({
      board_id: BOARD,
      task_id: 'T-missing',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('not_found');
  });

  it('returns actor_type_not_allowed for assignee-only', async () => {
    const { apiCreateSimpleTaskTool, apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'charlie', 'charlie', 'Tecnico')`,
    ).run(BOARD);
    const create = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Owner test',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(create.content[0].text).data.id;
    db.prepare(`UPDATE tasks SET assignee = 'charlie' WHERE id = ?`).run(taskId);

    const del = await apiDeleteSimpleTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'charlie',
    });
    const result = JSON.parse(del.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('actor_type_not_allowed');
  });

  it('service actor bypasses auth and deletes', async () => {
    const { apiCreateSimpleTaskTool, apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const create = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Service delete',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(create.content[0].text).data.id;

    const del = await apiDeleteSimpleTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'taskflow-api',
      sender_is_service: true,
    });
    const result = JSON.parse(del.content[0].text);
    expect(result.success).toBe(true);
  });

  it('rejects non-string task_id', async () => {
    const { apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiDeleteSimpleTaskTool.handler({
      board_id: BOARD,
      task_id: undefined as unknown as string,
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/task_id/);
  });
});
