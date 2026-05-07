import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb, initTestTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';

let db: Database;
let taskId: string;

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
    CREATE TABLE board_admins (
      board_id TEXT NOT NULL, person_id TEXT NOT NULL,
      phone TEXT, admin_role TEXT NOT NULL,
      PRIMARY KEY (board_id, person_id, admin_role)
    );
  `);
  d.prepare(`INSERT INTO boards (id, short_code, name) VALUES (?, 'TF', 'Test Board')`).run(boardId);
  d.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'alice', 'alice', 'manager')`,
  ).run(boardId);
  d.prepare(
    `INSERT INTO board_admins (board_id, person_id, admin_role) VALUES (?, 'alice', 'manager')`,
  ).run(boardId);
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
    title: 'Note test task',
    sender_name: 'alice',
  });
  taskId = JSON.parse(create.content[0].text).data.id;
});

afterEach(() => {
  closeTaskflowDb();
});

describe('api_task_add_note MCP tool', () => {
  it('exports a tool with name "api_task_add_note"', async () => {
    const { apiTaskAddNoteTool } = await import('./taskflow-api-notes.ts');
    expect(apiTaskAddNoteTool.tool.name).toBe('api_task_add_note');
  });

  it('declares required board_id, task_id, sender_name, text; optional sender_is_service, parent_note_id', async () => {
    const { apiTaskAddNoteTool } = await import('./taskflow-api-notes.ts');
    const schema = apiTaskAddNoteTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['board_id', 'task_id', 'sender_name', 'text']),
    );
    expect(schema.properties).toHaveProperty('sender_is_service');
    expect(schema.properties).toHaveProperty('parent_note_id');
  });

  it('adds a note to a task (sender_is_service bypasses manager check)', async () => {
    const { apiTaskAddNoteTool } = await import('./taskflow-api-notes.ts');
    const resp = await apiTaskAddNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      sender_is_service: true,
      text: 'First note',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(true);
    const row = db.prepare('SELECT notes FROM tasks WHERE id = ?').get(taskId) as
      | { notes: string }
      | null;
    const notes = JSON.parse(row!.notes);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('First note');
  });

  it('rejects empty text (z.string().min(1))', async () => {
    const { apiTaskAddNoteTool } = await import('./taskflow-api-notes.ts');
    const resp = await apiTaskAddNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      text: '',
    });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/text/);
  });

  it('rejects non-integer parent_note_id', async () => {
    const { apiTaskAddNoteTool } = await import('./taskflow-api-notes.ts');
    const resp = await apiTaskAddNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      text: 'reply',
      parent_note_id: 1.5 as unknown as number,
    });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/parent_note_id/);
  });
});

describe('api_task_edit_note MCP tool', () => {
  it('exports a tool with name "api_task_edit_note"', async () => {
    const { apiTaskEditNoteTool } = await import('./taskflow-api-notes.ts');
    expect(apiTaskEditNoteTool.tool.name).toBe('api_task_edit_note');
  });

  it('edits an existing note (sender_is_service)', async () => {
    const { apiTaskAddNoteTool, apiTaskEditNoteTool } = await import('./taskflow-api-notes.ts');
    await apiTaskAddNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      sender_is_service: true,
      text: 'Original',
    });
    const resp = await apiTaskEditNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      sender_is_service: true,
      note_id: 1,
      text: 'Edited',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(true);
  });

  it('rejects non-integer note_id', async () => {
    const { apiTaskEditNoteTool } = await import('./taskflow-api-notes.ts');
    const resp = await apiTaskEditNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      note_id: 'one' as unknown as number,
      text: 'Whatever',
    });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/note_id/);
  });

  it('rejects empty text', async () => {
    const { apiTaskEditNoteTool } = await import('./taskflow-api-notes.ts');
    const resp = await apiTaskEditNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      note_id: 1,
      text: '',
    });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/text/);
  });
});

describe('api_task_remove_note MCP tool', () => {
  it('exports a tool with name "api_task_remove_note"', async () => {
    const { apiTaskRemoveNoteTool } = await import('./taskflow-api-notes.ts');
    expect(apiTaskRemoveNoteTool.tool.name).toBe('api_task_remove_note');
  });

  it('removes an existing note (sender_is_service)', async () => {
    const { apiTaskAddNoteTool, apiTaskRemoveNoteTool } = await import('./taskflow-api-notes.ts');
    await apiTaskAddNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      sender_is_service: true,
      text: 'To be removed',
    });
    const resp = await apiTaskRemoveNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      sender_is_service: true,
      note_id: 1,
    });
    expect(JSON.parse(resp.content[0].text).success).toBe(true);
  });

  it('rejects non-integer note_id', async () => {
    const { apiTaskRemoveNoteTool } = await import('./taskflow-api-notes.ts');
    const resp = await apiTaskRemoveNoteTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      note_id: 1.5 as unknown as number,
    });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/note_id/);
  });
});
