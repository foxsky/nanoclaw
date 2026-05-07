import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

let db: Database;


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
