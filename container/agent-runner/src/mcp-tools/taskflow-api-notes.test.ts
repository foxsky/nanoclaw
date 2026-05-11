import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

let db: Database;
let taskId: string;

const BOARD = 'board-b1';

beforeEach(async () => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
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
      expect.arrayContaining(['task_id', 'sender_name', 'text']),
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
