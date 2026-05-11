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

  it('requires_close_approval=true is forwarded for meetings (/simplify parallel fix)', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'Approval-gated meeting',
      sender_name: 'alice',
      requires_close_approval: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const row = db
      .prepare(`SELECT requires_close_approval FROM tasks WHERE id = ?`)
      .get(result.data.id) as { requires_close_approval: number };
    expect(row.requires_close_approval).toBe(1);
  });

  it('rejects non-boolean requires_close_approval on meeting tool', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'X',
      sender_name: 'alice',
      requires_close_approval: 'yes' as unknown as boolean,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/requires_close_approval/);
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

describe('api_admin MCP tool (A11.2)', () => {
  it('exports a tool with name "api_admin"', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    expect(apiAdminTool.tool.name).toBe('api_admin');
  });

  it('declares required board_id/action/sender_name; action enum covers all 17 admin actions', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiAdminTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['board_id', 'action', 'sender_name']));
    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining([
        'register_person', 'remove_person', 'add_manager', 'add_delegate', 'remove_admin',
        'set_wip_limit', 'cancel_task', 'restore_task', 'process_inbox', 'manage_holidays',
        'process_minutes', 'process_minutes_decision', 'accept_external_invite',
        'reparent_task', 'detach_task', 'merge_project', 'handle_subtask_approval',
      ]),
    );
  });

  it('cancel_task happy path: archives task, success', async () => {
    const { apiCreateSimpleTaskTool, apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Cancel me',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'cancel_task',
      sender_name: 'alice',
      task_id: taskId,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
    expect(row).toBeNull();
    const archived = db.prepare('SELECT task_id FROM archive WHERE task_id = ?').get(taskId) as
      | { task_id: string }
      | null;
    expect(archived?.task_id).toBe(taskId);
  });

  it('set_wip_limit happy path: persists wip_limit on board_people', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
      wip_limit: 3,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const row = db
      .prepare('SELECT wip_limit FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, 'bob') as { wip_limit: number };
    expect(row.wip_limit).toBe(3);
  });

  it('engine rejects set_wip_limit with negative value', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
      wip_limit: -1,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/wip_limit/);
  });

  it('engine rejects reparent_task missing target_parent_id', async () => {
    const { apiCreateSimpleTaskTool, apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Orphan',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'reparent_task',
      sender_name: 'alice',
      task_id: taskId,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/target_parent_id/);
  });

  it('rejects unknown action via schema enum', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'nuke_board' as unknown as 'cancel_task',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/action/);
  });

  it('rejects non-number wip_limit', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
      wip_limit: '3' as unknown as number,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/wip_limit/);
  });

  it('rejects non-string person_name', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'register_person',
      sender_name: 'alice',
      person_name: 42 as unknown as string,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/person_name/);
  });

  it('rejects non-boolean confirmed', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'cancel_task',
      sender_name: 'alice',
      task_id: 'T1',
      confirmed: 'yes' as unknown as boolean,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/confirmed/);
  });

  it('rejects non-array holidays', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'manage_holidays',
      sender_name: 'alice',
      holiday_operation: 'add',
      holidays: 'not-an-array' as unknown as Array<{ date: string }>,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/holidays/);
  });

  it('engine rejects cancel_task on missing task → propagated', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'cancel_task',
      sender_name: 'alice',
      task_id: 'T-missing',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Task not found/);
  });

  it('rejects decision="approve" with action="process_minutes_decision" (per-action enum narrowing)', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'process_minutes_decision',
      sender_name: 'alice',
      decision: 'approve',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/process_minutes_decision/);
  });

  it('rejects decision="create_task" with action="handle_subtask_approval" (per-action enum narrowing)', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'handle_subtask_approval',
      sender_name: 'alice',
      decision: 'create_task',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/handle_subtask_approval/);
  });

  it('rejects malformed holidays element (missing date)', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'manage_holidays',
      sender_name: 'alice',
      holiday_operation: 'add',
      holidays: [{ label: 'no date here' }] as unknown as Array<{ date: string }>,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/holidays\[0\]\.date/);
  });

  it('rejects create object missing required type', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'process_minutes_decision',
      sender_name: 'alice',
      decision: 'create_task',
      create: { title: 'No type' } as unknown as { type: string; title: string },
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/create\.type/);
  });

  it('rejects non-integer holiday_year', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'manage_holidays',
      sender_name: 'alice',
      holiday_operation: 'set_year',
      holiday_year: 2026.5,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/holiday_year/);
  });
});

describe('api_reassign MCP tool (A11.3)', () => {
  it('exports a tool with name "api_reassign"', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    expect(apiReassignTool.tool.name).toBe('api_reassign');
  });

  it('declares required board_id/target_person/sender_name/confirmed; optional task_id/source_person', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiReassignTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['board_id', 'target_person', 'sender_name', 'confirmed']),
    );
    expect(schema.properties).toHaveProperty('task_id');
    expect(schema.properties).toHaveProperty('source_person');
  });

  it('single-task confirmed=true: reassigns assignee and persists', async () => {
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Reassign me',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiReassignTool.handler({
      board_id: BOARD,
      task_id: taskId,
      target_person: 'bob',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data.tasks_affected)).toBe(true);
    expect(result.data.tasks_affected.length).toBe(1);
    const row = db
      .prepare('SELECT assignee FROM tasks WHERE id = ?')
      .get(taskId) as { assignee: string };
    expect(row.assignee).toBe('bob');
  });

  it('dry run (confirmed=false): returns requires_confirmation in data, no DB change', async () => {
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Dry-run me',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiReassignTool.handler({
      board_id: BOARD,
      task_id: taskId,
      target_person: 'bob',
      sender_name: 'alice',
      confirmed: false,
    });
    const result = JSON.parse(response.content[0].text);
    // Engine returns success=true on dry-run with requires_confirmation set.
    expect(result.success).toBe(true);
    expect(typeof result.data.requires_confirmation).toBe('string');
    expect(result.data.requires_confirmation).toMatch(/confirmed=true to execute/);
    const row = db
      .prepare('SELECT assignee FROM tasks WHERE id = ?')
      .get(taskId) as { assignee: string };
    expect(row.assignee).toBe('alice'); // unchanged
  });

  it('engine rejects neither task_id nor source_person provided', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 'bob',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/task_id|source_person/);
  });

  it('engine rejects missing task → Task not found propagated', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      task_id: 'T-missing',
      target_person: 'alice',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Task not found/);
  });

  it('engine rejects reassign to same person', async () => {
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Same person',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiReassignTool.handler({
      board_id: BOARD,
      task_id: taskId,
      target_person: 'alice',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already assigned/);
  });

  it('rejects non-string board_id', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReassignTool.handler({
      board_id: 42 as unknown as string,
      target_person: 'bob',
      sender_name: 'alice',
      confirmed: true,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/board_id/);
  });

  it('rejects non-string target_person', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 42 as unknown as string,
      sender_name: 'alice',
      confirmed: true,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/target_person/);
  });

  it('rejects non-boolean confirmed', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 'bob',
      sender_name: 'alice',
      confirmed: 'yes' as unknown as boolean,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/confirmed/);
  });

  it('bulk transfer (source_person): reassigns all active tasks; dry-run preserves them', async () => {
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member'), (?, 'carol', 'carol', 'member')`,
    ).run(BOARD, BOARD);
    // alice (manager) assigns 2 tasks to bob
    const c1 = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'Bulk 1', sender_name: 'alice', assignee: 'bob',
    });
    const c2 = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'Bulk 2', sender_name: 'alice', assignee: 'bob',
    });
    const t1 = JSON.parse(c1.content[0].text).data.id;
    const t2 = JSON.parse(c2.content[0].text).data.id;

    // Dry run — should list both tasks, leave assignees alone
    const dry = await apiReassignTool.handler({
      board_id: BOARD,
      source_person: 'bob',
      target_person: 'carol',
      sender_name: 'alice',
      confirmed: false,
    });
    const dryResult = JSON.parse(dry.content[0].text);
    expect(dryResult.success).toBe(true);
    expect(dryResult.data.tasks_affected.length).toBe(2);
    expect(
      (db.prepare('SELECT assignee FROM tasks WHERE id = ?').get(t1) as { assignee: string }).assignee,
    ).toBe('bob');

    // Commit — both tasks move to carol
    const commit = await apiReassignTool.handler({
      board_id: BOARD,
      source_person: 'bob',
      target_person: 'carol',
      sender_name: 'alice',
      confirmed: true,
    });
    const commitResult = JSON.parse(commit.content[0].text);
    expect(commitResult.success).toBe(true);
    expect(commitResult.data.tasks_affected.length).toBe(2);
    expect(
      (db.prepare('SELECT assignee FROM tasks WHERE id = ?').get(t1) as { assignee: string }).assignee,
    ).toBe('carol');
    expect(
      (db.prepare('SELECT assignee FROM tasks WHERE id = ?').get(t2) as { assignee: string }).assignee,
    ).toBe('carol');
  });

  it('engine rejects permission denied: non-manager non-assignee cannot reassign', async () => {
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member'), (?, 'carol', 'carol', 'member')`,
    ).run(BOARD, BOARD);
    // alice (manager) creates a task assigned to bob
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Bob task',
      sender_name: 'alice',
      assignee: 'bob',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    // carol (non-manager, non-assignee) tries to reassign → denied
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      task_id: taskId,
      target_person: 'carol',
      sender_name: 'carol',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Permission denied/);
    // Confirm assignee unchanged
    const row = db
      .prepare('SELECT assignee FROM tasks WHERE id = ?')
      .get(taskId) as { assignee: string };
    expect(row.assignee).toBe('bob');
  });

  it('reassign-with-notification: target person gets notified', async () => {
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Notify me',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiReassignTool.handler({
      board_id: BOARD,
      task_id: taskId,
      target_person: 'bob',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.notification_events.length).toBeGreaterThanOrEqual(1);
    const targets = result.notification_events.map((n: { target_person_id: string }) => n.target_person_id);
    expect(targets).toContain('bob');
  });
});

describe('api_undo MCP tool (A11.4)', () => {
  it('exports a tool with name "api_undo"', async () => {
    const { apiUndoTool } = await import('./taskflow-api-mutate.ts');
    expect(apiUndoTool.tool.name).toBe('api_undo');
  });

  it('declares required board_id/sender_name and optional force', async () => {
    const { apiUndoTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiUndoTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['board_id', 'sender_name']));
    expect(schema.properties).toHaveProperty('force');
    expect(schema.properties.force.type).toBe('boolean');
  });

  it('happy path: undo a recent move → reverts to previous column', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool, apiUndoTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Undo me',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    await apiMoveTool.handler({
      board_id: BOARD,
      task_id: taskId,
      action: 'start',
      sender_name: 'alice',
    });
    expect(
      (db.prepare('SELECT column FROM tasks WHERE id = ?').get(taskId) as { column: string }).column,
    ).toBe('in_progress');

    const undoResponse = await apiUndoTool.handler({
      board_id: BOARD,
      sender_name: 'alice',
    });
    const undoResult = JSON.parse(undoResponse.content[0].text);
    expect(undoResult.success).toBe(true);
    expect(undoResult.data.task_id).toBe(taskId);
    // engine.undo records the original action verb (`start`, `wait`, ...), not 'moved'
    expect(undoResult.data.undone_action).toBe('start');
    expect(
      (db.prepare('SELECT column FROM tasks WHERE id = ?').get(taskId) as { column: string }).column,
    ).toBe('inbox');
  });

  it('engine rejects "Nothing to undo" on empty mutation history', async () => {
    const { apiUndoTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUndoTool.handler({
      board_id: BOARD,
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Nothing to undo/);
  });

  it('engine rejects undo of creation (only "created" mutation exists)', async () => {
    const { apiCreateSimpleTaskTool, apiUndoTool } = await import('./taskflow-api-mutate.ts');
    await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Only created',
      sender_name: 'alice',
    });

    const response = await apiUndoTool.handler({
      board_id: BOARD,
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Cannot undo creation/);
  });

  it('engine rejects permission: non-author non-manager cannot undo', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool, apiUndoTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Alice mutates',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;
    await apiMoveTool.handler({
      board_id: BOARD,
      task_id: taskId,
      action: 'start',
      sender_name: 'alice',
    });

    // bob (non-author, non-manager) tries to undo alice's move
    const response = await apiUndoTool.handler({
      board_id: BOARD,
      sender_name: 'bob',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Permission denied/);
  });

  it('rejects non-string board_id', async () => {
    const { apiUndoTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUndoTool.handler({
      board_id: 42 as unknown as string,
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/board_id/);
  });

  it('rejects non-boolean force', async () => {
    const { apiUndoTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUndoTool.handler({
      board_id: BOARD,
      sender_name: 'alice',
      force: 'yes' as unknown as boolean,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/force/);
  });

  it('WIP guard: force=false hits WIP error; force=true (manager) bypasses', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool, apiUndoTool } = await import('./taskflow-api-mutate.ts');
    // alice (manager) is WIP-limited to 1. Build state where undoing the
    // most recent mutation would restore a task INTO in_progress while
    // another task already occupies alice's WIP slot.
    //
    // engine.move's WIP check fires on 'start'/'resume'/'reject' — but NOT
    // 'force_start' (manager-only override). We use force_start to push
    // T3 into in_progress past the limit so we can then `wait` it (no WIP
    // check on the way out) and create the undo-target snapshot.
    db.prepare(`UPDATE board_people SET wip_limit = 1 WHERE board_id = ? AND person_id = 'alice'`).run(BOARD);

    // T2 (so it gets ID T2): start → fills WIP slot.
    const c1 = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'T1 inbox', sender_name: 'alice',
    });
    expect(JSON.parse(c1.content[0].text).data.id).toBe('T1');
    const c2 = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'T2 wip', sender_name: 'alice',
    });
    expect(JSON.parse(c2.content[0].text).data.id).toBe('T2');
    await apiMoveTool.handler({ board_id: BOARD, task_id: 'T2', action: 'start', sender_name: 'alice' });

    // T3: force_start (bypasses WIP gate) → wait. Latest mutation now is
    // T3.wait with snapshot.column='in_progress'.
    const c3 = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'T3', sender_name: 'alice',
    });
    const t3 = JSON.parse(c3.content[0].text).data.id;
    const forceStart = await apiMoveTool.handler({
      board_id: BOARD, task_id: t3, action: 'force_start', sender_name: 'alice',
    });
    expect(JSON.parse(forceStart.content[0].text).success).toBe(true);
    await apiMoveTool.handler({ board_id: BOARD, task_id: t3, action: 'wait', sender_name: 'alice' });

    // Undo T3.wait without force → WIP error (restoring t3 into in_progress
    // would mean alice has 2 in_progress, exceeding wip_limit=1).
    const noForce = await apiUndoTool.handler({ board_id: BOARD, sender_name: 'alice' });
    const noForceResult = JSON.parse(noForce.content[0].text);
    expect(noForceResult.success).toBe(false);
    expect(noForceResult.error).toMatch(/WIP limit/);

    // Undo with force=true (alice is manager) → succeeds, restoring t3 to in_progress.
    const withForce = await apiUndoTool.handler({
      board_id: BOARD,
      sender_name: 'alice',
      force: true,
    });
    const withForceResult = JSON.parse(withForce.content[0].text);
    expect(withForceResult.success).toBe(true);
    expect(withForceResult.data.task_id).toBe(t3);
    expect(
      (db.prepare('SELECT column FROM tasks WHERE id = ?').get(t3) as { column: string }).column,
    ).toBe('in_progress');
  });
});

describe('api_report MCP tool (A11.5)', () => {
  it('exports a tool with name "api_report"', async () => {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    expect(apiReportTool.tool.name).toBe('api_report');
  });

  it('declares required board_id/type; type enum standup/digest/weekly', async () => {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiReportTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['board_id', 'type']));
    expect(schema.properties.type.enum).toEqual(
      expect.arrayContaining(['standup', 'digest', 'weekly']),
    );
  });

  it('standup happy path: returns data with overdue/in_progress/review arrays', async () => {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReportTool.handler({
      board_id: BOARD,
      type: 'standup',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.date).toBeDefined();
    expect(Array.isArray(result.data.overdue)).toBe(true);
    expect(Array.isArray(result.data.in_progress)).toBe(true);
    expect(Array.isArray(result.data.review)).toBe(true);
    expect(Array.isArray(result.data.waiting)).toBe(true);
    expect(Array.isArray(result.data.per_person)).toBe(true);
  });

  it('digest type: returns formatted_report and next_48h', async () => {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReportTool.handler({
      board_id: BOARD,
      type: 'digest',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(typeof result.data.formatted_report).toBe('string');
    expect(Array.isArray(result.data.next_48h)).toBe(true);
  });

  it('weekly type: returns formatted_report and stats', async () => {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReportTool.handler({
      board_id: BOARD,
      type: 'weekly',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(typeof result.data.formatted_report).toBe('string');
    expect(result.data.stats).toBeDefined();
    expect(typeof result.data.stats.total_active).toBe('number');
  });

  it('report after task creation shows the task in in_progress', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool, apiReportTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Active work',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;
    await apiMoveTool.handler({
      board_id: BOARD,
      task_id: taskId,
      action: 'start',
      sender_name: 'alice',
    });

    const response = await apiReportTool.handler({
      board_id: BOARD,
      type: 'standup',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const ids = result.data.in_progress.map((t: { id: string }) => t.id);
    expect(ids).toContain(taskId);
  });

  it('rejects non-string board_id', async () => {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReportTool.handler({
      board_id: 42 as unknown as string,
      type: 'standup',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/board_id/);
  });

  it('rejects invalid type enum value', async () => {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReportTool.handler({
      board_id: BOARD,
      type: 'monthly' as unknown as 'standup',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/type/);
  });

  it('rejects missing type', async () => {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReportTool.handler({
      board_id: BOARD,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/type/);
  });
});

describe('api_create_task MCP tool (A5.2.1 — multi-type create)', () => {
  it('exports a tool with name "api_create_task"', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    expect(apiCreateTaskTool.tool.name).toBe('api_create_task');
  });

  it('declares required board_id/title/sender_name/type; type enum simple|project|recurring|inbox', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiCreateTaskTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['board_id', 'title', 'sender_name', 'type']),
    );
    expect(schema.properties.type.enum).toEqual(
      expect.arrayContaining(['simple', 'project', 'recurring', 'inbox']),
    );
    // 'meeting' is intentionally NOT in this tool's enum — use api_create_meeting_task instead
    expect(schema.properties.type.enum).not.toContain('meeting');
  });

  it('type=simple → task created in next_action column (NOT inbox)', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'simple',
      title: 'Simple task',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.column).toBe('next_action');
    expect(result.data.id).toMatch(/^T\d+$/);
  });

  it('type=inbox → task created in inbox column', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'inbox',
      title: 'Inbox capture',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.column).toBe('inbox');
    expect(result.data.id).toMatch(/^T\d+$/);
  });

  it('type=project with subtasks → P-prefix id, subtasks created', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'project',
      title: 'Big project',
      sender_name: 'alice',
      assignee: 'bob',
      subtasks: ['Step A', 'Step B'],
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.id).toMatch(/^P\d+$/);
    // Subtasks live under the parent project id
    const subRows = db
      .prepare(`SELECT id, title FROM tasks WHERE parent_task_id = ? ORDER BY id`)
      .all(result.data.id) as Array<{ id: string; title: string }>;
    expect(subRows.length).toBe(2);
    expect(subRows.map((r) => r.title)).toEqual(['Step A', 'Step B']);
  });

  it('type=recurring with recurrence → R-prefix id, recurrence persisted', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'recurring',
      title: 'Weekly review',
      sender_name: 'alice',
      recurrence: 'weekly',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.id).toMatch(/^R\d+$/);
    const row = db
      .prepare(`SELECT recurrence FROM tasks WHERE id = ?`)
      .get(result.data.id) as { recurrence: string };
    expect(row.recurrence).toBe('weekly');
  });

  it('rejects type=meeting (use api_create_meeting_task instead)', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'meeting' as unknown as 'simple',
      title: 'Meeting',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/type/);
  });

  it('rejects unknown type value', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'bogus' as unknown as 'simple',
      title: 'X',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/type/);
  });

  it('rejects non-string board_id', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: 42 as unknown as string,
      type: 'simple',
      title: 'X',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/board_id/);
  });

  it('rejects non-array subtasks', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'project',
      title: 'X',
      sender_name: 'alice',
      subtasks: 'oops' as unknown as string[],
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/subtasks/);
  });

  it('rejects invalid recurrence enum value', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'recurring',
      title: 'X',
      sender_name: 'alice',
      recurrence: 'biweekly' as unknown as 'weekly',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/recurrence/);
  });

  it('requires_close_approval=true is forwarded to the engine (Codex IMPORTANT fix)', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'simple',
      title: 'Needs approval',
      sender_name: 'alice',
      requires_close_approval: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const row = db
      .prepare(`SELECT requires_close_approval FROM tasks WHERE id = ?`)
      .get(result.data.id) as { requires_close_approval: number };
    expect(row.requires_close_approval).toBe(1);
  });

  it('rejects non-boolean requires_close_approval', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'simple',
      title: 'X',
      sender_name: 'alice',
      requires_close_approval: 'yes' as unknown as boolean,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/requires_close_approval/);
  });
});

describe('api_update_task MCP tool (A5.2.2 — composite updates wrapper)', () => {
  it('exports a tool with name "api_update_task"', async () => {
    const { apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    expect(apiUpdateTaskTool.tool.name).toBe('api_update_task');
  });

  it('declares required board_id/task_id/sender_name/updates; updates is an object', async () => {
    const { apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiUpdateTaskTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['board_id', 'task_id', 'sender_name', 'updates']),
    );
    expect(schema.properties.updates.type).toBe('object');
  });

  it('add_note: engine appends a note row to the task', async () => {
    const { apiCreateSimpleTaskTool, apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'Note target', sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      updates: { add_note: 'Important context' },
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const row = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(taskId) as { notes: string };
    expect(row.notes).toMatch(/Important context/);
  });

  it('due_date: persists the new due_date on the task', async () => {
    const { apiCreateSimpleTaskTool, apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'Date target', sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      updates: { due_date: '2026-12-01' },
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const row = db.prepare(`SELECT due_date FROM tasks WHERE id = ?`).get(taskId) as { due_date: string };
    expect(row.due_date).toBe('2026-12-01');
  });

  it('title: renames the task', async () => {
    const { apiCreateSimpleTaskTool, apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'Old name', sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      updates: { title: 'New name' },
    });
    expect(JSON.parse(response.content[0].text).success).toBe(true);
    const row = db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(taskId) as { title: string };
    expect(row.title).toBe('New name');
  });

  it('engine rejects update on missing task → "Task not found" propagated', async () => {
    const { apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: 'T-missing',
      sender_name: 'alice',
      updates: { add_note: 'X' },
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Task not found/);
  });

  it('rejects non-string board_id', async () => {
    const { apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUpdateTaskTool.handler({
      board_id: 42 as unknown as string,
      task_id: 'T1',
      sender_name: 'alice',
      updates: { add_note: 'X' },
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/board_id/);
  });

  it('rejects missing updates field', async () => {
    const { apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: 'T1',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/updates/);
  });

  it('rejects non-object updates (e.g. string)', async () => {
    const { apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: 'T1',
      sender_name: 'alice',
      updates: 'add_note' as unknown as Record<string, unknown>,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/updates/);
  });

  it('empty updates object → engine no-ops with success=true (engine does not require operations)', async () => {
    const { apiCreateSimpleTaskTool, apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'X', sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;
    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      updates: {},
    });
    const result = JSON.parse(response.content[0].text);
    // engine.update doesn't gate on empty updates — succeeds as no-op.
    // Mirrors v1 behavior. Caller is expected to send at least one op.
    expect(result.success).toBe(true);
  });
});
