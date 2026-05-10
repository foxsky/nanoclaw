import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

let db: Database;


const BOARD = 'b1';

beforeEach(() => {
  // withBoardAdmins: true is required for engine.move (which always calls
  // isManager() to compute permissions). Strict superset — does not affect
  // create/delete tests which don't query board_admins.
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
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

describe('api_create_meeting_task MCP tool (A10)', () => {
  it('exports a tool with name "api_create_meeting_task"', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    expect(apiCreateMeetingTaskTool.tool.name).toBe('api_create_meeting_task');
  });

  it('declares required board_id/title/sender_name and optional scheduled_at/participants/assignee/priority', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiCreateMeetingTaskTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['board_id', 'title', 'sender_name']));
    expect(schema.properties).toHaveProperty('scheduled_at');
    expect(schema.properties).toHaveProperty('participants');
    expect(schema.properties).toHaveProperty('assignee');
    expect(schema.properties).toHaveProperty('priority');
    expect(schema.properties).toHaveProperty('recurrence');
    expect(schema.properties).toHaveProperty('max_cycles');
    // description is intentionally absent — engine.create CreateParams has
    // no description slot, so advertising it at MCP would be a silent drop.
    expect(schema.properties).not.toHaveProperty('description');
  });

  it('creates a meeting → returns success with type=meeting and M-prefix id', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'Quarterly review',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.type).toBe('meeting');
    expect(result.data.id).toMatch(/^M\d+$/);
    expect(result.data.title).toBe('Quarterly review');
    expect(Array.isArray(result.notification_events)).toBe(true);
  });

  it('creates a meeting with scheduled_at → persisted (engine normalizes to UTC)', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'SEMA',
      sender_name: 'alice',
      scheduled_at: '2026-06-15T14:00:00Z',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.scheduled_at).toBeTruthy();
  });

  it('creates a meeting with participants → resolved + stored', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'Sync with bob',
      sender_name: 'alice',
      participants: ['bob'],
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const row = db.prepare(`SELECT participants FROM tasks WHERE id = ?`).get(result.data.id) as {
      participants: string;
    };
    expect(row.participants).toBe(JSON.stringify(['bob']));
  });

  it('engine rejects meeting with due_date → propagated as error', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'Bad meeting',
      sender_name: 'alice',
      due_date: '2026-06-15',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/scheduled_at/);
  });

  it('engine rejects recurring meeting without scheduled_at → propagated as error', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'Weekly standup',
      sender_name: 'alice',
      recurrence: 'weekly',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/scheduled_at/);
  });

  it('rejects non-string board_id', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: 42 as unknown as string,
      title: 'X',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/board_id/);
  });

  it('rejects non-array participants', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'X',
      sender_name: 'alice',
      participants: 'bob' as unknown as string[],
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/participants/);
  });

  it('rejects non-integer max_cycles', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'X',
      sender_name: 'alice',
      max_cycles: 1.5 as unknown as number,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/max_cycles/);
  });

  it('rejects non-string recurrence_anchor', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'X',
      sender_name: 'alice',
      recurrence_anchor: 42 as unknown as string,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/recurrence_anchor/);
  });

  it('multiple non-self non-assignee participants → one notification_event each', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member'), (?, 'carol', 'carol', 'member')`,
    ).run(BOARD, BOARD);
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'Tri-party sync',
      sender_name: 'alice',
      participants: ['bob', 'carol'],
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    // alice is sender + auto-assignee; bob and carol each get a notification
    expect(result.notification_events.length).toBe(2);
    const targets = result.notification_events.map((n: { target_person_id: string }) => n.target_person_id).sort();
    expect(targets).toEqual(['bob', 'carol']);
  });
});

describe('api_move MCP tool (A11.1)', () => {
  it('exports a tool with name "api_move"', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    expect(apiMoveTool.tool.name).toBe('api_move');
  });

  it('declares required board_id/task_id/action/sender_name and optional reason/subtask_id/confirmed_task_id; action enum covers 10 transitions', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiMoveTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['board_id', 'task_id', 'action', 'sender_name']),
    );
    expect(schema.properties).toHaveProperty('reason');
    expect(schema.properties).toHaveProperty('subtask_id');
    expect(schema.properties).toHaveProperty('confirmed_task_id');
    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining([
        'start', 'wait', 'resume', 'return', 'review',
        'approve', 'reject', 'conclude', 'reopen', 'force_start',
      ]),
    );
  });

  it('happy path: start inbox task → response shows from=inbox, to=in_progress', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Move me',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: taskId,
      action: 'start',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.task_id).toBe(taskId);
    expect(result.data.from_column).toBe('inbox');
    expect(result.data.to_column).toBe('in_progress');
    expect(Array.isArray(result.notification_events)).toBe(true);
  });

  it('wait action with reason: persists reason in task_history', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Wait me',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: taskId,
      action: 'wait',
      sender_name: 'alice',
      reason: 'blocked on Edilson',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.to_column).toBe('waiting');

    const historyRow = db
      .prepare(`SELECT details FROM task_history WHERE task_id = ? AND action = 'wait' LIMIT 1`)
      .get(taskId) as { details: string } | undefined;
    expect(historyRow).toBeDefined();
    expect(historyRow!.details).toMatch(/blocked on Edilson/);
  });

  it('rejects unknown action via schema enum', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: 'T1',
      action: 'teleport' as unknown as 'start',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/action/);
  });

  it('engine rejects invalid transition (approve from inbox) → propagated as Permission denied (self-assignee) or invalid-transition', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Bad transition',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: taskId,
      action: 'approve',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    // alice IS self-assignee (auto-assigned at create) AND task is in inbox.
    // Permission check fires first → "Self-approval is not allowed".
    expect(result.error).toMatch(/Self-approval|Cannot.*approve/);
  });

  it('engine rejects move on missing task → propagated as "Task not found"', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: 'T-missing',
      action: 'start',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Task not found/);
  });

  it('rejects non-string task_id', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: undefined as unknown as string,
      action: 'start',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/task_id/);
  });

  it('rejects non-string reason', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: 'T1',
      action: 'wait',
      sender_name: 'alice',
      reason: 42 as unknown as string,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/reason/);
  });

  it('move-with-notification: non-self assignee receives notification_event', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Bob task',
      sender_name: 'alice',
      assignee: 'bob',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;
    // alice (manager, non-assignee) moves bob's task → bob gets notified
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: taskId,
      action: 'start',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.notification_events.length).toBeGreaterThanOrEqual(1);
    const targets = result.notification_events.map((n: { target_person_id: string }) => n.target_person_id);
    expect(targets).toContain('bob');
  });
});
