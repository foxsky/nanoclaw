import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeSessionDb, closeTaskflowDb, initTestSessionDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';
import { setVerbatimIds } from './taskflow-helpers.js';
import { __resetTurnActorForTesting, clearTurnActor, setTurnActor } from './turn-actor.js';

let db: Database;


const BOARD = 'board-b1';

beforeEach(() => {
  // withBoardAdmins: true is required for engine.move (which always calls
  // isManager() to compute permissions). Strict superset — does not affect
  // create/delete tests which don't query board_admins.
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
});

afterEach(() => {
  closeTaskflowDb();
  setVerbatimIds(false); // a test may flip this to exercise an engine-output (non-gated) path
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
    expect(schema.required).toEqual(expect.arrayContaining(['title', 'sender_name']));
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
      expect.arrayContaining(['task_id', 'sender_name']),
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

  it('service actor bypasses auth and deletes (FastAPI/verbatim; chat cannot assert service — SEC#12)', async () => {
    // Service authority is honored on the FastAPI/verbatim entry (server-resolved actor), where #418's
    // chat actor-binding is bypassed. A raw chat call can no longer claim sender_is_service (forced
    // false in normalizeAgentIds) — the chat-surface strip is covered in taskflow-helpers.test.ts.
    setVerbatimIds(true);
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
    expect(schema.required).toEqual(expect.arrayContaining(['title', 'sender_name']));
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

  it('creates a meeting when a typed participant is not registered and surfaces the registration prompt', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'Sync with Cleonildo',
      sender_name: 'alice',
      participants: ['Cleonildo'],
      scheduled_at: '2026-06-15T14:00:00Z',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.type).toBe('meeting');
    expect(result.data.id).toMatch(/^M\d+$/);
    expect(result.unresolved_participants).toEqual(['Cleonildo']);
    expect(result.offer_register.message).toContain('Cleonildo');
    const row = db.prepare(`SELECT participants FROM tasks WHERE id = ?`).get(result.data.id) as {
      participants: string | null;
    };
    expect(row.participants).toBe(JSON.stringify([]));
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

  // Arg-shape rejections return {success:false,error_code:'validation_error'}
  // (HTTP 422 on the FastAPI surface), not raw err() text (→503).
  it('rejects non-string board_id with validation_error', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: 42 as unknown as string,
      title: 'X',
      sender_name: 'alice',
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/board_id/);
  });

  it('rejects non-array participants with validation_error', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'X',
      sender_name: 'alice',
      participants: 'bob' as unknown as string[],
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/participants/);
  });

  it('rejects non-integer max_cycles with validation_error', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'X',
      sender_name: 'alice',
      max_cycles: 1.5 as unknown as number,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/max_cycles/);
  });

  it('rejects non-string recurrence_anchor with validation_error', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'X',
      sender_name: 'alice',
      recurrence_anchor: 42 as unknown as string,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/recurrence_anchor/);
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

  it('rejects non-boolean requires_close_approval on meeting tool with validation_error', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'X',
      sender_name: 'alice',
      requires_close_approval: 'yes' as unknown as boolean,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/requires_close_approval/);
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

  it('unresolved meeting participant already in org prompts reuse instead of phone registration', async () => {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    db.exec(`ALTER TABLE boards ADD COLUMN parent_board_id TEXT`);
    db.exec(`ALTER TABLE boards ADD COLUMN owner_person_id TEXT`);
    db.exec(`ALTER TABLE board_people ADD COLUMN phone TEXT`);
    db.exec(
      `INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid, parent_board_id, owner_person_id)
       VALUES ('board-root', NULL, 'Root', 'standard', 'root-folder', 'root@g.us', NULL, NULL);
       INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid, parent_board_id, owner_person_id)
       VALUES ('board-laizys', NULL, 'Laizys', 'standard', 'laizys-taskflow', 'laizys@g.us', 'board-root', 'laizys');
       UPDATE boards SET parent_board_id = 'board-root' WHERE id = '${BOARD}';
       INSERT INTO board_people (board_id, person_id, name, role, phone)
       VALUES ('board-laizys', 'laizys', 'Laizys', 'owner', '5586999993003')`,
    );

    const response = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD,
      title: 'Reunião FMS — Ponto Eletrônico',
      sender_name: 'alice',
      participants: ['Laizys'],
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.offer_register.message).toContain('Laizys está na organização em laizys-taskflow');
    expect(result.offer_register.message).toContain('encaminhar os detalhes para o quadro dela');
    expect(result.offer_register.message).not.toContain('informe o telefone');
  });
});

describe('api_move MCP tool (A11.1)', () => {
  it('exports a tool with name "api_move"', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    expect(apiMoveTool.tool.name).toBe('api_move');
    expect(apiMoveTool.tool.description).toContain('SEC-T41 must stay SEC-T41');
  });

  it('declares required action/sender_name, single task_id or bulk task_ids, and optional reason/subtask_id/confirmed_task_id; action enum covers 10 transitions', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiMoveTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['action', 'sender_name']),
    );
    expect(schema.required).not.toContain('task_id');
    expect(schema.properties).toHaveProperty('task_id');
    expect(schema.properties).toHaveProperty('task_ids');
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
    expect(result.data.formatted).toContain(`${taskId} — Move me`);
    expect(Array.isArray(result.notification_events)).toBe(true);
  });

  it('bulk approve: task_ids moves all review tasks and returns a formatted summary', async () => {
    const { apiCreateSimpleTaskTool, apiMoveTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const first = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Bulk first',
      sender_name: 'alice',
      assignee: 'bob',
    });
    const second = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Bulk second',
      sender_name: 'alice',
      assignee: 'bob',
    });
    const firstId = JSON.parse(first.content[0].text).data.id;
    const secondId = JSON.parse(second.content[0].text).data.id;
    await apiMoveTool.handler({ board_id: BOARD, task_id: firstId, action: 'review', sender_name: 'alice' });
    await apiMoveTool.handler({ board_id: BOARD, task_id: secondId, action: 'review', sender_name: 'alice' });

    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_ids: [firstId.toLowerCase(), secondId.toLowerCase()],
      action: 'approve',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.bulk).toBe(true);
    expect(result.data.success_count).toBe(2);
    expect(result.data.formatted).toContain('2 de 2 tarefa(s)');
    expect(result.data.results.map((r: { task_id: string }) => r.task_id)).toEqual([firstId, secondId]);
    const rows = db
      .query(`SELECT id, column FROM tasks WHERE board_id = ? AND id IN (?, ?) ORDER BY id`)
      .all(BOARD, firstId, secondId) as Array<{ id: string; column: string }>;
    expect(rows.map((r) => r.column)).toEqual(['done', 'done']);
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

  it('declares required board_id/action/sender_name; action enum covers all admin actions', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiAdminTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['action', 'sender_name']));
    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining([
        'register_person', 'remove_person', 'add_manager', 'add_delegate', 'remove_admin',
        'set_wip_limit', 'set_cross_board_subtask_mode', 'cancel_task', 'restore_task', 'process_inbox', 'manage_holidays',
        'process_minutes', 'process_minutes_decision', 'accept_external_invite',
        'reparent_task', 'detach_task', 'merge_project', 'handle_subtask_approval',
      ]),
    );
    expect(schema.properties.cross_board_subtask_mode.enum).toEqual(['open', 'approval', 'blocked']);
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

  it('set_cross_board_subtask_mode persists runtime config and records history', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    // #411: this is now a gated (structure/policy) action on the chat surface — held for approval.
    // This test exercises the ENGINE-OUTPUT persistence path, so run it as the FastAPI/verbatim surface
    // (gate bypassed), exactly as the dashboard/approved-replay would. The chat-parks contract is
    // covered separately in taskflow-api-mutate-gate.test.ts.
    setVerbatimIds(true);
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'set_cross_board_subtask_mode',
      sender_name: 'alice',
      cross_board_subtask_mode: 'approval',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.data).toEqual({ key: 'cross_board_subtask_mode', value: 'approval' });

    const row = db
      .prepare('SELECT cross_board_subtask_mode FROM board_runtime_config WHERE board_id = ?')
      .get(BOARD) as { cross_board_subtask_mode: string };
    expect(row.cross_board_subtask_mode).toBe('approval');

    const history = db
      .prepare('SELECT action, details FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1')
      .get(BOARD, 'BOARD') as { action: string; details: string };
    expect(history.action).toBe('config_changed');
    expect(JSON.parse(history.details)).toEqual({
      key: 'cross_board_subtask_mode',
      value: 'approval',
    });
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

  it('reparent_task success returns parent_title AND task_title (feeds the v1 create card)', async () => {
    const { apiCreateTaskTool, apiCreateSimpleTaskTool, apiAdminTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const proj = JSON.parse(
      (await apiCreateTaskTool.handler({
        board_id: BOARD, type: 'project', title: 'Operação da SECTI', sender_name: 'alice', assignee: 'bob',
      })).content[0].text,
    );
    const child = JSON.parse(
      (await apiCreateSimpleTaskTool.handler({
        board_id: BOARD, title: 'Treinamento E-governe', sender_name: 'alice',
      })).content[0].text,
    );
    const result = JSON.parse(
      (await apiAdminTool.handler({
        board_id: BOARD, action: 'reparent_task', sender_name: 'alice',
        task_id: child.data.id, target_parent_id: proj.data.id,
      })).content[0].text,
    );
    expect(result.success).toBe(true);
    // finalizeMutationResult nests the engine result under data:rest, so
    // the engine's own data + the wrapper-set `formatted` land here. The
    // intent: api_admin(reparent_task) now carries the byte-faithful v1
    // "adicionada" create card (this is the seci create-divergence fix).
    expect(result.data.data.parent_title).toBe('Operação da SECTI');
    expect(result.data.data.task_title).toBe('Treinamento E-governe');
    expect(result.data.formatted).toBe(
      `✅ *${child.data.id} adicionada*\n━━━━━━━━━━━━━━\n\n📁 *${proj.data.id}* — Operação da SECTI\n   📋 *${child.data.id}* — Treinamento E-governe`,
    );
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

  it('description routes explicit assignment commands through api_reassign', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    expect(apiReassignTool.tool.description).toContain('atribuir P11.23 para Rodrigo');
    expect(apiReassignTool.tool.description).toContain('do not route those through api_update_simple_task');
  });

  it('declares required board_id/target_person/sender_name/confirmed; optional task_id/source_person', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiReassignTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['target_person', 'sender_name', 'confirmed']),
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
    // No-parent reassign with a known previous assignee → De/Para card, identical
    // to the poll-loop deterministic path (path parity; the task was created by
    // alice so it carried her as the prior assignee).
    expect(result.data.formatted).toBe(`✅ *${taskId}* reatribuída\n━━━━━━━━━━━━━━\n\n👤 *De:* alice\n👤 *Para:* bob`);
    const row = db
      .prepare('SELECT assignee FROM tasks WHERE id = ?')
      .get(taskId) as { assignee: string };
    expect(row.assignee).toBe('bob');
  });

  it('canonicalizes target display name to board_people.name in the v1 card (Codex P1 fix)', async () => {
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'lucas', 'Lucas', 'member')`,
    ).run(BOARD);
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Solicitar acesso',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;
    // Input is the LOWERCASE alias 'lucas'; v1 canonicalizes via
    // engine.resolvePerson(...)?.name → 'Lucas' (poll-loop.ts:2320 then
    // formatReassignReply at 2339). The card must mirror that — the *Para:* line
    // shows the canonical 'Lucas', not the raw 'lucas' input (the card is now the
    // De/Para form since the task carried alice as its prior assignee).
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      task_id: taskId,
      target_person: 'lucas',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.formatted).toBe(
      `✅ *${taskId}* reatribuída\n━━━━━━━━━━━━━━\n\n👤 *De:* alice\n👤 *Para:* Lucas`,
    );
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
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/board_id/);
  });

  it('rejects non-string target_person', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 42 as unknown as string,
      sender_name: 'alice',
      confirmed: true,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/target_person/);
  });

  it('rejects non-boolean confirmed', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 'bob',
      sender_name: 'alice',
      confirmed: 'yes' as unknown as boolean,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/confirmed/);
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
    expect(commitResult.data.formatted).toContain('✅ 2 tarefas reatribuídas para carol:');
    expect(commitResult.data.formatted).toContain(`• *${t1}* — Bulk 1`);
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
    expect(schema.required).toEqual(expect.arrayContaining(['sender_name']));
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
    expect(result.error_code).toBe('not_found'); // R2: mapped code (was codeless)
  });

  it('R2: rejects a non-boolean force with validation_error (FastAPI arg-shape)', async () => {
    const { apiUndoTool } = await import('./taskflow-api-mutate.ts');
    const r = JSON.parse((await apiUndoTool.handler({ board_id: BOARD, sender_name: 'alice', force: 'yes' })).content[0].text);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
    expect(String(r.error)).toMatch(/force/i);
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
    expect(result.error_code).toBe('conflict'); // R2: mapped code
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
    expect(result.error_code).toBe('permission_denied'); // R2: mapped code
  });

  it('rejects non-string board_id with validation_error (R2: structured, not codeless)', async () => {
    const { apiUndoTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUndoTool.handler({
      board_id: 42 as unknown as string,
      sender_name: 'alice',
    });
    const r = JSON.parse(response.content[0].text);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
    expect(String(r.error)).toMatch(/board_id/);
  });

  it('rejects non-boolean force with validation_error (R2)', async () => {
    const { apiUndoTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUndoTool.handler({
      board_id: BOARD,
      sender_name: 'alice',
      force: 'yes' as unknown as boolean,
    });
    const r = JSON.parse(response.content[0].text);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
    expect(String(r.error)).toMatch(/force/);
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
    expect(schema.required).toEqual(expect.arrayContaining(['type']));
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

  it('description: activity/step wording → add_subtask (single call); only literal-"tarefa" project-ID add → create+reparent', async () => {
    const { apiCreateTaskTool, apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    // create+reparent preserved for the literal-"tarefa" project-ID command
    expect(apiCreateTaskTool.tool.description).toContain('adicionar em P3 a tarefa X');
    expect(apiCreateTaskTool.tool.description).toContain('api_admin action=reparent_task');
    expect(apiUpdateTaskTool.tool.description).toContain('Only the literal-"tarefa" project-ID add command');
    expect(apiUpdateTaskTool.tool.description).toContain('adicionar em P3 a tarefa X');
    // activity/step wording routes to add_subtask as a SINGLE update call —
    // the Turn-9 fix: v2 had split "incluir na P22 uma atividade" into
    // api_update_task + api_create_task where v1 did one add_subtask.
    expect(apiUpdateTaskTool.tool.description).toContain('incluir na P22 uma atividade X');
    expect(apiUpdateTaskTool.tool.description).toContain(
      'never split it into api_update_task + api_create_task',
    );
  });

  it('declares required board_id/title/sender_name/type; type enum simple|project|recurring|inbox', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiCreateTaskTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['title', 'sender_name', 'type']),
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

  it('asks before creating a near-duplicate active assigned task', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'rafael', 'Rafael', 'member')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO tasks (board_id, id, type, title, assignee, column, created_at, updated_at, created_by)
       VALUES (?, 'T97', 'simple', 'Redundância de Internet/Licitação/SEMA', 'rafael', 'next_action', '2026-04-01', '2026-04-01', 'alice')`,
    ).run(BOARD);

    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'simple',
      title: 'Redundância internet SEMA/Licitação',
      sender_name: 'alice',
      assignee: 'Rafael',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.duplicate_candidate).toBe(true);
    expect(result.data.task.id).toBe('T97');
    expect(result.data.formatted).toContain('Deseja usar a T97 existente');
    const created = db
      .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE board_id = ? AND title = ?`)
      .get(BOARD, 'Redundância internet SEMA/Licitação') as { count: number };
    expect(created.count).toBe(0);
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
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/type/);
  });

  it('rejects unknown type value', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'bogus' as unknown as 'simple',
      title: 'X',
      sender_name: 'alice',
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/type/);
  });

  it('rejects non-string board_id', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiCreateTaskTool.handler({
      board_id: 42 as unknown as string,
      type: 'simple',
      title: 'X',
      sender_name: 'alice',
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/board_id/);
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
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/subtasks/);
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
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/recurrence/);
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
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/requires_close_approval/);
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
      expect.arrayContaining(['task_id', 'sender_name', 'updates']),
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
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/updates/);
  });

  it('rejects non-object updates (e.g. string)', async () => {
    const { apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: 'T1',
      sender_name: 'alice',
      updates: 'add_note' as unknown as Record<string, unknown>,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/updates/);
  });

  it('forwards through to engine.update — confirmed_task_id magnetism param accepted', async () => {
    const { apiCreateSimpleTaskTool, apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'X', sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;
    const response = await apiUpdateTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
      updates: { add_note: 'X' },
      confirmed_task_id: taskId,
    });
    expect(JSON.parse(response.content[0].text).success).toBe(true);
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

describe('api_query MCP tool (A5.2.3 — composite read-side wrapper)', () => {
  it('exports a tool with name "api_query"', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    expect(apiQueryTool.tool.name).toBe('api_query');
  });

  it('declares required board_id/query; common optional discriminator fields present', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiQueryTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['query']));
    expect(schema.properties).toHaveProperty('task_id');
    expect(schema.properties).toHaveProperty('person_name');
    expect(schema.properties).toHaveProperty('sender_name');
    expect(schema.properties).toHaveProperty('search_text');
    expect(schema.properties).toHaveProperty('label');
    expect(schema.properties).toHaveProperty('since');
    expect(schema.properties).toHaveProperty('at');
  });

  it('documents exact task ID scope for dotted subtasks', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    expect(apiQueryTool.tool.description).toContain('Exact IDs stay exact');
    expect(apiQueryTool.tool.description).toContain('task_id=P6.7');
    expect(apiQueryTool.tool.description).toContain('not parent P6');
  });

  it('documents org-scoped person lookup for cross-board contact reuse', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    expect(apiQueryTool.tool.description).toContain('find_person_in_organization');
    expect(apiQueryTool.tool.description).toContain('routing_jid');
    expect(apiQueryTool.tool.description).toContain('instead of asking for phone numbers');
  });

  it('query=board → returns column-grouped tasks', async () => {
    const { apiCreateSimpleTaskTool, apiQueryTool } = await import('./taskflow-api-mutate.ts');
    await apiCreateSimpleTaskTool.handler({ board_id: BOARD, title: 'X', sender_name: 'alice' });
    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'board',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.columns).toBeDefined();
  });

  it('query=task_details with task_id → returns the specific task', async () => {
    const { apiCreateSimpleTaskTool, apiQueryTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'Lookup target', sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'task_details',
      task_id: taskId,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('query=search uses token fallback for non-contiguous Portuguese phrases', async () => {
    const { apiCreateTaskTool, apiQueryTool } = await import('./taskflow-api-mutate.ts');
    await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'simple',
      title: 'Extrato de contas da PMT nos bancos pelo Banco Central',
      sender_name: 'alice',
    });

    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'search',
      search_text: 'extrato contas PMT bancos',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data[0].title).toBe('Extrato de contas da PMT nos bancos pelo Banco Central');
    expect(result.result_count).toBe(1);
    expect(result.primary_match.title).toBe('Extrato de contas da PMT nos bancos pelo Banco Central');
    expect(result.formatted_search_results).toContain('1 tarefa encontrada');
    expect(result.formatted_search_results).toContain('Extrato de contas da PMT nos bancos pelo Banco Central');
  });

  it('query=search returns a compact no-match summary', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'search',
      search_text: 'termo inexistente no quadro',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.result_count).toBe(0);
    expect(result.primary_match).toBeNull();
    expect(result.data).toEqual([]);
    expect(result.formatted_search_results).toBe('Nenhuma tarefa encontrada para "termo inexistente no quadro".');
  });

  it('query=task_details returns a compact formatted project summary with subtasks', async () => {
    const { apiCreateTaskTool, apiQueryTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateTaskTool.handler({
      board_id: BOARD,
      type: 'project',
      title: 'Operação da SECTI',
      sender_name: 'alice',
      subtasks: ['Treinamento E-governe', 'Pesquisa TIC Governo 2025'],
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'task_details',
      task_id: taskId,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data.formatted_task_details).toContain(`*${taskId}* — Operação da SECTI`);
    expect(result.data.formatted_task_details).toContain('Treinamento E-governe');
    expect(result.data.formatted_task_details).toContain('Pesquisa TIC Governo 2025');
    expect(result.data.subtask_rows).toBeUndefined();
    expect(result.data.subtask_count).toBe(2);
    expect(result.data.subtasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Treinamento E-governe' }),
        expect.objectContaining({ title: 'Pesquisa TIC Governo 2025' }),
      ]),
    );
  });

  it('engine rejects unknown query discriminator', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'definitely_not_a_real_query',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
  });

  // Phase 3 compliance — Turn 17 (T43 read on sibling board).
  // The wrapper must preserve the engine's cross-board scope; nothing in the
  // wrapper should accidentally board-scope the query.
  it('query=find_task_in_organization routes through to engine (cross-board read)', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    // The shared test fixture omits `parent_board_id` from `boards` (it
    // mirrors v1's minimal schema). Add it locally — ALTER TABLE is the
    // same forward-migration pattern the engine uses for new columns.
    db.exec(`ALTER TABLE boards ADD COLUMN parent_board_id TEXT`);
    // Seed a sibling board + cross-board task within the same org tree.
    const now = new Date().toISOString();
    db.exec(
      `INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid, parent_board_id)
       VALUES ('board-root', NULL, 'Root', 'standard', 'root-folder', 'root@g.us', NULL);
       INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid, parent_board_id)
       VALUES ('board-sibling', NULL, 'Sibling', 'standard', 'sibling-folder', 'sib@g.us', 'board-root');
       UPDATE boards SET parent_board_id = 'board-root' WHERE id = '${BOARD}';`,
    );
    db.exec(
      `INSERT INTO tasks (id, board_id, type, title, column, requires_close_approval, created_at, updated_at)
       VALUES ('T43', 'board-sibling', 'simple', 'Cobrar ofício', 'next_action', 0, '${now}', '${now}')`,
    );

    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'find_task_in_organization',
      task_id: 'T43',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].task_id).toBe('T43');
    expect(result.data[0].board_id).toBe('board-sibling');
  });

  it('query=find_person_in_organization falls back to one-edit name matching only when exact normalized matching misses', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    db.exec(`ALTER TABLE boards ADD COLUMN parent_board_id TEXT`);
    db.exec(`ALTER TABLE boards ADD COLUMN owner_person_id TEXT`);
    db.exec(`ALTER TABLE board_people ADD COLUMN phone TEXT`);
    db.exec(
      `INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid, parent_board_id, owner_person_id)
       VALUES ('board-root', NULL, 'Root', 'standard', 'root-folder', 'root@g.us', NULL, NULL);
       INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid, parent_board_id, owner_person_id)
       VALUES ('board-laizys', NULL, 'Laizys', 'standard', 'laizys-taskflow', 'laizys@g.us', 'board-root', 'laizys');
       UPDATE boards SET parent_board_id = 'board-root' WHERE id = '${BOARD}';
       INSERT INTO board_people (board_id, person_id, name, role)
       VALUES ('board-laizys', 'laizys', 'Laizys', 'owner'),
              ('${BOARD}', 'ana-beatriz', 'Ana Beatriz', 'member'),
              ('${BOARD}', 'maria-silva', 'Maria Silva', 'member'),
              ('${BOARD}', 'ana-silva', 'Ana Silva', 'member'),
              ('${BOARD}', 'silvia', 'Silvia', 'member')`,
    );

    const typoResponse = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'find_person_in_organization',
      search_text: 'Laisys',
    });
    const typoResult = JSON.parse(typoResponse.content[0].text);
    expect(typoResult.success).toBe(true);
    expect(typoResult.data.map((row: { person_id: string }) => row.person_id)).toEqual(['laizys']);

    const tokenResponse = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'find_person_in_organization',
      search_text: 'Beatriz',
    });
    const tokenResult = JSON.parse(tokenResponse.content[0].text);
    expect(tokenResult.data.map((row: { person_id: string }) => row.person_id)).toEqual(['ana-beatriz']);

    const ambiguousResponse = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'find_person_in_organization',
      search_text: 'Silva',
    });
    const ambiguousResult = JSON.parse(ambiguousResponse.content[0].text);
    expect(ambiguousResult.data.map((row: { person_id: string }) => row.person_id).sort()).toEqual([
      'ana-silva',
      'maria-silva',
    ]);
  });

  it('query=find_task_in_organization promotes parent project current-board summary', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    db.exec(`ALTER TABLE boards ADD COLUMN parent_board_id TEXT`);
    const now = new Date().toISOString();
    db.exec(
      `INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid, parent_board_id)
       VALUES ('board-root', 'SECI', 'Root', 'standard', 'seci-taskflow', 'root@g.us', NULL);
       UPDATE boards SET parent_board_id = 'board-root' WHERE id = '${BOARD}';
       INSERT INTO board_people VALUES ('board-root', 'person-1', 'Alexandre', '5585999990001', 'Dev', 3, NULL);
       INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
       VALUES ('P11', 'board-root', 'project', 'Operação da SECTI', 'person-1', 'next_action', 0, '${now}', '${now}');
       INSERT INTO tasks (
         id, board_id, type, title, assignee, column, requires_close_approval,
         child_exec_enabled, child_exec_board_id, child_exec_person_id,
         parent_task_id, created_at, updated_at
       )
       VALUES ('P11.11', 'board-root', 'simple', 'Sistema de ponto', 'person-1', 'waiting', 0,
               1, '${BOARD}', 'person-1', 'P11', '${now}', '${now}')`,
    );

    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'find_task_in_organization',
      task_id: 'P11',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.primary_match.formatted_task_details).toContain('*P11.11*');
    expect(result.primary_match.formatted_task_details).toContain('Sistema de ponto');
    expect(result.data[0].formatted_task_details).toBe(result.primary_match.formatted_task_details);
  });

  // Option B (v2-native daily v1-bug monitor). The wrapper must pass
  // `audit_v1_bugs` through to the engine and honor the optional `since`
  // filter. Same-task / same-user / <60min self-correction pairs on
  // THIS board only.
  it('query=audit_v1_bugs returns same-board self-correction pairs', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO task_history (board_id, task_id, action, "by", "at", details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(BOARD, 'M1', 'updated', 'giovanni', '2026-04-14T11:04:11Z',
      JSON.stringify({ changes: ['Reunião reagendada para 17/04/2026 às 11:00'] }));
    db.prepare(
      `INSERT INTO task_history (board_id, task_id, action, "by", "at", details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(BOARD, 'M1', 'updated', 'giovanni', '2026-04-14T11:36:29Z',
      JSON.stringify({ changes: ['Reunião reagendada para 16/04/2026 às 11:00'] }));

    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'audit_v1_bugs',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].pattern).toBe('date_field_correction');
    expect(result.data[0].task_id).toBe('M1');
  });

  // Arg-shape rejections return a structured {success:false,
  // error_code:'validation_error'} envelope (maps to HTTP 422 on the
  // FastAPI surface), NOT raw err() text (which the dashboard parser
  // cannot decode → 503 transport error).
  it('rejects non-string board_id with validation_error', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiQueryTool.handler({
      board_id: 42 as unknown as string,
      query: 'board',
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/board_id/);
  });

  it('rejects missing query with validation_error', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiQueryTool.handler({
      board_id: BOARD,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/query/);
  });

  it('rejects non-string task_id with validation_error', async () => {
    const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiQueryTool.handler({
      board_id: BOARD,
      query: 'task_details',
      task_id: 42 as unknown as string,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/task_id/);
  });
});

describe('api_hierarchy MCP tool (A5.2.4)', () => {
  it('exports a tool with name "api_hierarchy"', async () => {
    const { apiHierarchyTool } = await import('./taskflow-api-mutate.ts');
    expect(apiHierarchyTool.tool.name).toBe('api_hierarchy');
  });

  it('declares required board_id/action/task_id/sender_name; action enum covers 4 ops', async () => {
    const { apiHierarchyTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiHierarchyTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['action', 'task_id', 'sender_name']),
    );
    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining(['link', 'unlink', 'refresh_rollup', 'tag_parent']),
    );
  });

  it('rejects unknown action via enum', async () => {
    const { apiHierarchyTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiHierarchyTool.handler({
      board_id: BOARD,
      action: 'nuke' as unknown as 'link',
      task_id: 'T1',
      sender_name: 'alice',
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/action/);
  });

  it('engine rejects unlink on missing task → propagated as error', async () => {
    const { apiHierarchyTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiHierarchyTool.handler({
      board_id: BOARD,
      action: 'unlink',
      task_id: 'T-missing',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('rejects non-string board_id', async () => {
    const { apiHierarchyTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiHierarchyTool.handler({
      board_id: 42 as unknown as string,
      action: 'unlink',
      task_id: 'T1',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/board_id/);
  });

  it('rejects non-string parent_task_id', async () => {
    const { apiHierarchyTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiHierarchyTool.handler({
      board_id: BOARD,
      action: 'tag_parent',
      task_id: 'T1',
      sender_name: 'alice',
      parent_task_id: 42 as unknown as string,
    });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).toBe('validation_error');
    expect(result.error).toMatch(/parent_task_id/);
  });
});

describe('api_dependency MCP tool (A5.2.4)', () => {
  it('exports a tool with name "api_dependency"', async () => {
    const { apiDependencyTool } = await import('./taskflow-api-mutate.ts');
    expect(apiDependencyTool.tool.name).toBe('api_dependency');
  });

  it('declares required board_id/action/task_id/sender_name; action enum covers 4 ops', async () => {
    const { apiDependencyTool } = await import('./taskflow-api-mutate.ts');
    const schema = apiDependencyTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['action', 'task_id', 'sender_name']),
    );
    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining(['add_dep', 'remove_dep', 'add_reminder', 'remove_reminder']),
    );
  });

  it('rejects unknown action via enum', async () => {
    const { apiDependencyTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiDependencyTool.handler({
      board_id: BOARD,
      action: 'cascade' as unknown as 'add_dep',
      task_id: 'T1',
      sender_name: 'alice',
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/action/);
  });

  it('add_dep happy path: persists target_task_id in blocked_by', async () => {
    const { apiCreateSimpleTaskTool, apiDependencyTool } = await import('./taskflow-api-mutate.ts');
    const created1 = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'A', sender_name: 'alice',
    });
    const created2 = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'B', sender_name: 'alice',
    });
    const t1 = JSON.parse(created1.content[0].text).data.id;
    const t2 = JSON.parse(created2.content[0].text).data.id;

    const response = await apiDependencyTool.handler({
      board_id: BOARD,
      action: 'add_dep',
      task_id: t1,
      target_task_id: t2,
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    const row = db.prepare(`SELECT blocked_by FROM tasks WHERE id = ?`).get(t1) as { blocked_by: string };
    expect(row.blocked_by).toContain(t2);
  });

  it('engine rejects add_dep with missing target_task_id', async () => {
    const { apiCreateSimpleTaskTool, apiDependencyTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD, title: 'X', sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;

    const response = await apiDependencyTool.handler({
      board_id: BOARD,
      action: 'add_dep',
      task_id: taskId,
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/target_task_id/);
  });

  it('rejects non-integer reminder_days', async () => {
    const { apiDependencyTool } = await import('./taskflow-api-mutate.ts');
    const response = await apiDependencyTool.handler({
      board_id: BOARD,
      action: 'add_reminder',
      task_id: 'T1',
      sender_name: 'alice',
      reminder_days: 1.5 as unknown as number,
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/reminder_days/);
  });
});

describe('api_reschedule_meeting MCP tool', () => {
  async function makeMeeting(title: string, scheduledAt?: string) {
    const { apiCreateMeetingTaskTool } = await import('./taskflow-api-mutate.ts');
    const r = await apiCreateMeetingTaskTool.handler({
      board_id: BOARD, title, sender_name: 'alice',
      ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    });
    return JSON.parse(r.content[0].text).data.id as string;
  }
  async function makeSimple(title: string) {
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const r = await apiCreateSimpleTaskTool.handler({ board_id: BOARD, title, sender_name: 'alice' });
    return JSON.parse(r.content[0].text).data.id as string;
  }
  const scheduledAt = (id: string): string | null =>
    (db.prepare('SELECT scheduled_at FROM tasks WHERE id = ?').get(id) as { scheduled_at: string | null }).scheduled_at;

  it('resolves a uniquely-named meeting and reschedules it, ignoring same-keyword non-meeting tasks', async () => {
    const { apiRescheduleMeetingTool } = await import('./taskflow-api-mutate.ts');
    const mId = await makeMeeting('Reunião SDU Sul — Integração/QGIS/STM', '2026-04-29T12:00:00Z');
    // Same keyword on a SIMPLE task — must NOT dilute the match (scope=meeting).
    const sId = await makeSimple('Integração/QGIS/STM SDU Sul');
    await makeSimple('Carta de Serviço SDU Leste');

    const resp = await apiRescheduleMeetingTool.handler({
      board_id: BOARD, meeting: 'SDU Sul', scheduled_at: '2026-05-05T12:00:00Z', sender_name: 'alice',
    });
    const out = JSON.parse(resp.content[0].text);
    expect(out.success).toBe(true);
    const meeting = db.prepare('SELECT scheduled_at FROM tasks WHERE id = ?').get(mId) as { scheduled_at: string };
    expect(meeting.scheduled_at).toContain('2026-05-05');
    // the same-keyword simple task was untouched
    const simple = db.prepare('SELECT scheduled_at FROM tasks WHERE id = ?').get(sId) as { scheduled_at: string | null };
    expect(simple.scheduled_at).toBeNull();
  });

  it('returns ambiguity as success:true + data.candidates (no mutation) when 2+ meetings match the name', async () => {
    // Q6: a 2+-match is a "did you mean?" disambiguation, NOT an error. It
    // returns success:true with the candidates under `data` (the dashboard
    // parser keeps only result.data on success → renders a picker). The
    // discriminated-union `ok` stays false so BOTH callers short-circuit
    // BEFORE engine.update — proving no wrong reschedule on an ambiguous match.
    const { apiRescheduleMeetingTool } = await import('./taskflow-api-mutate.ts');
    const a = await makeMeeting('Reunião SDU Norte', '2026-04-29T12:00:00Z');
    const b = await makeMeeting('Reunião SDU Centro', '2026-04-30T12:00:00Z');
    const resp = await apiRescheduleMeetingTool.handler({
      board_id: BOARD, meeting: 'SDU', scheduled_at: '2026-05-05T12:00:00Z', sender_name: 'alice',
    });
    const out = JSON.parse(resp.content[0].text);
    expect(out.success).toBe(true);
    expect(out.data.candidates).toHaveLength(2);
    expect(out.error).toMatch(/Qual delas|2 reuni/i);
    // neither meeting moved — the candidates outcome must NOT mutate
    expect(scheduledAt(a)).toContain('2026-04-29');
    expect(scheduledAt(b)).toContain('2026-04-30');
  });

  it('returns not_found when no meeting matches', async () => {
    const { apiRescheduleMeetingTool } = await import('./taskflow-api-mutate.ts');
    await makeMeeting('Reunião SDU Sul', '2026-04-29T12:00:00Z');
    const resp = await apiRescheduleMeetingTool.handler({
      board_id: BOARD, meeting: 'Inexistente XYZ', scheduled_at: '2026-05-05T12:00:00Z', sender_name: 'alice',
    });
    const out = JSON.parse(resp.content[0].text);
    expect(out.success).toBe(false);
    expect(out.error_code).toBe('not_found');
    expect(out.error).toMatch(/não encontrei|nenhuma reuni/i);
  });

  it('accepts an explicit M-id and reschedules it directly', async () => {
    const { apiRescheduleMeetingTool } = await import('./taskflow-api-mutate.ts');
    const mId = await makeMeeting('Reunião Qualquer', '2026-04-29T12:00:00Z');
    const resp = await apiRescheduleMeetingTool.handler({
      board_id: BOARD, meeting: mId, scheduled_at: '2026-05-06T09:00:00Z', sender_name: 'alice',
    });
    const out = JSON.parse(resp.content[0].text);
    expect(out.success).toBe(true);
    expect(scheduledAt(mId)).toContain('2026-05-06');
  });

  it('rejects an M-id that is not a meeting (type guard on the explicit-id path)', async () => {
    const { apiRescheduleMeetingTool } = await import('./taskflow-api-mutate.ts');
    // A non-meeting task whose id happens to be M-shaped — the guard must reject it.
    db.exec(`INSERT INTO tasks (id, board_id, type, title, column, requires_close_approval, created_at, updated_at)
             VALUES ('M99', '${BOARD}', 'simple', 'Not a meeting', 'next_action', 0, '2026-01-01', '2026-01-01')`);
    const resp = await apiRescheduleMeetingTool.handler({
      board_id: BOARD, meeting: 'M99', scheduled_at: '2026-05-05T09:00:00Z', sender_name: 'alice',
    });
    const out = JSON.parse(resp.content[0].text);
    expect(out.success).toBe(false);
    expect(out.error_code).toBe('not_found');
    expect(out.error).toMatch(/não é uma reunião/i);
    // unchanged: still type simple, no scheduled_at applied
    expect(scheduledAt('M99')).toBeNull();
  });

  it('rejects an explicit M-id of a meeting only DELEGATED to this board (resolution stays board-local)', async () => {
    const { apiRescheduleMeetingTool } = await import('./taskflow-api-mutate.ts');
    // M88 is OWNED by another board but child-exec delegated to BOARD. engine.getTask()
    // would resolve it (delegated-here fallback), but the meeting tools' contract is
    // board-local — matching the name-resolution path (resolveMeetingCandidates is
    // WHERE board_id = ?). A /simplify refactor accidentally broadened this; guard it.
    db.exec(`INSERT INTO tasks (id, board_id, type, title, column, requires_close_approval,
               child_exec_enabled, child_exec_board_id, created_at, updated_at)
             VALUES ('M88', 'board-other', 'meeting', 'Delegated Meeting', 'next_action', 0,
               1, '${BOARD}', '2026-04-29T12:00:00Z', '2026-01-01')`);
    const resp = await apiRescheduleMeetingTool.handler({
      board_id: BOARD, meeting: 'M88', scheduled_at: '2026-05-05T09:00:00Z', sender_name: 'alice',
    });
    const out = JSON.parse(resp.content[0].text);
    expect(out.success).toBe(false);
    expect(out.error_code).toBe('not_found');
    expect(out.error).toMatch(/não é uma reunião/i);
    // the delegated meeting on the other board is untouched
    expect(scheduledAt('M88')).toBeNull();
  });

  it('api_note_meeting notes the MEETING by name, not a same-named project', async () => {
    const { apiNoteMeetingTool, apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    // A project and a meeting sharing "Novos Sites" — the note must go to the meeting (M-id).
    await apiCreateTaskTool.handler({ board_id: BOARD, type: 'project', title: 'Novos Sites', sender_name: 'alice' });
    const mId = await makeMeeting('Projeto Novos Sites — Reunião Interna', '2026-05-06T12:00:00Z');
    const resp = await apiNoteMeetingTool.handler({
      board_id: BOARD, meeting: 'Novos Sites', text: 'Lançamento definido para 25/05.', sender_name: 'alice',
    });
    const out = JSON.parse(resp.content[0].text);
    expect(out.success).toBe(true);
    const notes = (db.prepare('SELECT notes FROM tasks WHERE id = ?').get(mId) as { notes: string }).notes;
    expect(notes).toContain('Lançamento definido para 25/05');
  });

  // Q6 irreversible-mutation guard: a 2+-match on the NOTE path must return
  // the success:true + data.candidates disambiguation WITHOUT writing a note
  // to any candidate. A note append is irreversible, so this is the load-
  // bearing regression test for the ambiguity flip (callers branch on the
  // internal `ok:false` and never reach engine.update).
  it('note: ambiguity returns success:true + data.candidates and writes NO note to any candidate', async () => {
    const { apiNoteMeetingTool } = await import('./taskflow-api-mutate.ts');
    const a = await makeMeeting('Reunião SDU Norte', '2026-04-29T12:00:00Z');
    const b = await makeMeeting('Reunião SDU Centro', '2026-04-30T12:00:00Z');
    const resp = await apiNoteMeetingTool.handler({
      board_id: BOARD, meeting: 'SDU', text: 'Decisão X', sender_name: 'alice',
    });
    const out = JSON.parse(resp.content[0].text);
    expect(out.success).toBe(true);
    expect(out.data.candidates).toHaveLength(2);
    const notesA = (db.prepare('SELECT notes FROM tasks WHERE id = ?').get(a) as { notes: string | null }).notes;
    const notesB = (db.prepare('SELECT notes FROM tasks WHERE id = ?').get(b) as { notes: string | null }).notes;
    expect(notesA ?? '').not.toContain('Decisão X');
    expect(notesB ?? '').not.toContain('Decisão X');
  });

  it('reschedule: missing meeting → validation_error', async () => {
    const { apiRescheduleMeetingTool } = await import('./taskflow-api-mutate.ts');
    const resp = await apiRescheduleMeetingTool.handler({
      board_id: BOARD, scheduled_at: '2026-05-05T12:00:00Z', sender_name: 'alice',
    });
    expect(resp.isError).toBeUndefined();
    const out = JSON.parse(resp.content[0].text);
    expect(out.error_code).toBe('validation_error');
    expect(out.error).toMatch(/meeting/);
  });

  it('note: missing text → validation_error', async () => {
    const { apiNoteMeetingTool } = await import('./taskflow-api-mutate.ts');
    const resp = await apiNoteMeetingTool.handler({
      board_id: BOARD, meeting: 'Whatever', sender_name: 'alice',
    });
    expect(resp.isError).toBeUndefined();
    const out = JSON.parse(resp.content[0].text);
    expect(out.error_code).toBe('validation_error');
    expect(out.error).toMatch(/text/);
  });
});

describe('maybeSemanticSearch (#385 — query embed + reader injection)', () => {
  const cfg = {
    NANOCLAW_TASKFLOW_EMBED_MODEL: 'bge-m3',
    NANOCLAW_TASKFLOW_EMBED_URL: 'http://h:11434',
  } as NodeJS.ProcessEnv;
  const fakeEmbed = async () => new Float32Array([1, 2, 3]);

  it('no-op for non-search queries', async () => {
    const { maybeSemanticSearch } = await import('./taskflow-api-mutate.ts');
    const qp = { query: 'board' } as any;
    expect(await maybeSemanticSearch(qp, { env: cfg, embed: fakeEmbed })).toBeNull();
    expect(qp.query_vector).toBeUndefined();
    expect(qp.embedding_reader).toBeUndefined();
  });

  it('no-op when search_text is missing', async () => {
    const { maybeSemanticSearch } = await import('./taskflow-api-mutate.ts');
    const qp = { query: 'search' } as any;
    expect(await maybeSemanticSearch(qp, { env: cfg, embed: fakeEmbed })).toBeNull();
    expect(qp.query_vector).toBeUndefined();
  });

  it('no-op when the embed config is absent (feeder off → lexical)', async () => {
    const { maybeSemanticSearch } = await import('./taskflow-api-mutate.ts');
    const qp = { query: 'search', search_text: 'mobile app' } as any;
    expect(await maybeSemanticSearch(qp, { env: {} as NodeJS.ProcessEnv, embed: fakeEmbed })).toBeNull();
    expect(qp.query_vector).toBeUndefined();
  });

  it('injects query_vector + a reader when configured and embed returns a vector', async () => {
    const { maybeSemanticSearch } = await import('./taskflow-api-mutate.ts');
    const qp = { query: 'search', search_text: 'mobile app' } as any;
    const reader = await maybeSemanticSearch(qp, {
      env: cfg,
      embed: fakeEmbed,
      readerPath: '/nonexistent/embeddings.db', // EmbeddingReader is graceful when absent
    });
    expect(reader).not.toBeNull();
    expect(Array.from(qp.query_vector as Float32Array)).toEqual([1, 2, 3]);
    expect(qp.embedding_reader).toBe(reader);
    reader?.close();
  });

  it('no-op when embed returns null (Ollama unavailable → lexical)', async () => {
    const { maybeSemanticSearch } = await import('./taskflow-api-mutate.ts');
    const qp = { query: 'search', search_text: 'mobile app' } as any;
    expect(await maybeSemanticSearch(qp, { env: cfg, embed: async () => null })).toBeNull();
    expect(qp.query_vector).toBeUndefined();
  });
});

describe('#399 — add_external_participant for a never-contacted invitee', () => {
  it('returns success:true (not a phantom failure) and surfaces the pending invite as an in_chat_notice', async () => {
    const { apiCreateMeetingTaskTool, apiUpdateTaskTool } = await import('./taskflow-api-mutate.ts');
    const meeting = JSON.parse(
      (
        await apiCreateMeetingTaskTool.handler({
          board_id: BOARD,
          title: 'Reunião SECTI',
          sender_name: 'alice',
          scheduled_at: '2026-06-15T14:00:00Z',
        })
      ).content[0].text,
    );
    expect(meeting.success).toBe(true);

    const res = JSON.parse(
      (
        await apiUpdateTaskTool.handler({
          board_id: BOARD,
          task_id: meeting.data.id,
          sender_name: 'alice',
          updates: { add_external_participant: { name: 'Katia', phone: '5585999990000' } },
        })
      ).content[0].text,
    );

    // Pre-#399 the engine's no-JID "Convite pendente" group notification hit
    // the missing-routing-target throw inside finalizeMutationResult, so the
    // tool returned success:false even though the participant WAS registered.
    // Now it is an in_chat_notice (shown in-chat, not host-dispatched).
    expect(res.success).toBe(true);
    const notice = (res.notification_events as Array<{ kind: string; message: string }>).find(
      (e) => e.kind === 'in_chat_notice',
    );
    expect(notice).toBeDefined();
    expect(notice!.message).toContain('Convite pendente');
  });
});

describe('emitAutoProvisionIfRequested (#390 — restore V1 auto-provision-on-register)', () => {
  const REQ = {
    person_id: 'p-katia',
    person_name: 'Katia',
    person_phone: '5585999990000',
    person_role: 'member',
    group_name: 'Divisão X',
    group_folder: 'div-x',
    message: 'Quadro filho para Katia será provisionado automaticamente.',
  };

  it('emits a provision_child_board system row carrying the auto_provision_request fields', async () => {
    const { emitAutoProvisionIfRequested } = await import('./taskflow-api-mutate.ts');
    const calls: Array<{ id: string; kind: string; content: string }> = [];
    const emitted = emitAutoProvisionIfRequested({ success: true, auto_provision_request: REQ } as any, {
      id: 'fixed',
      emit: (m) => {
        calls.push(m);
        return 1;
      },
    });
    expect(emitted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('system');
    const payload = JSON.parse(calls[0].content);
    expect(payload.action).toBe('provision_child_board');
    expect(payload.person_id).toBe('p-katia');
    expect(payload.person_phone).toBe('5585999990000');
    expect(payload.group_folder).toBe('div-x');
  });

  it('no-ops in the FastAPI subprocess (verbatim ids) — defense-in-depth; api_admin is not allowlisted today', async () => {
    const { emitAutoProvisionIfRequested } = await import('./taskflow-api-mutate.ts');
    const { setVerbatimIds } = await import('./taskflow-helpers.ts');
    setVerbatimIds(true);
    try {
      let called = false;
      const emitted = emitAutoProvisionIfRequested({ success: true, auto_provision_request: REQ } as any, {
        emit: () => {
          called = true;
          return 1;
        },
      });
      expect(emitted).toBe(false);
      expect(called).toBe(false);
    } finally {
      setVerbatimIds(false);
    }
  });

  it('no-ops when there is no auto_provision_request (non-delegating board / no phone)', async () => {
    const { emitAutoProvisionIfRequested } = await import('./taskflow-api-mutate.ts');
    let called = false;
    expect(
      emitAutoProvisionIfRequested({ success: true } as any, {
        emit: () => {
          called = true;
          return 1;
        },
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });

  it('no-ops on a failed admin result (do not provision for a registration that did not happen)', async () => {
    const { emitAutoProvisionIfRequested } = await import('./taskflow-api-mutate.ts');
    let called = false;
    emitAutoProvisionIfRequested({ success: false, auto_provision_request: REQ } as any, {
      emit: () => {
        called = true;
        return 1;
      },
    });
    expect(called).toBe(false);
  });

  it('never throws if the emit fails — a committed registration must not report failure', async () => {
    const { emitAutoProvisionIfRequested } = await import('./taskflow-api-mutate.ts');
    expect(() =>
      emitAutoProvisionIfRequested({ success: true, auto_provision_request: REQ } as any, {
        emit: () => {
          throw new Error('unable to open database file');
        },
      }),
    ).not.toThrow();
  });
});

describe('maybeFindEmbedDuplicate (#392 — semantic create-time dup-detect)', () => {
  const EMBED_ENV = {
    NANOCLAW_TASKFLOW_EMBED_MODEL: 'bge-m3',
    NANOCLAW_TASKFLOW_EMBED_URL: 'http://ollama:11434',
  } as unknown as NodeJS.ProcessEnv;
  const vec = Float32Array.from([1, 0, 0]);

  it('no-ops (null) when the embed env is absent (→ lexical-only, no check)', async () => {
    const { maybeFindEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const r = await maybeFindEmbedDuplicate(db, BOARD, 'simple', 'Comprar café', {
      env: {} as NodeJS.ProcessEnv,
      embed: async () => vec,
      search: async () => [{ itemId: 'whatever', score: 0.99 }],
    });
    expect(r).toBeNull();
  });

  it('no-ops for non simple/project types (inbox/meeting are not dup-checked)', async () => {
    const { maybeFindEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const r = await maybeFindEmbedDuplicate(db, BOARD, 'meeting', 'Reunião', {
      env: EMBED_ENV,
      embed: async () => vec,
      search: async () => [{ itemId: 'x', score: 0.99 }],
    });
    expect(r).toBeNull();
  });

  it('returns { row, score } for a semantic match that is a live (non-done) task', async () => {
    const { apiCreateTaskTool, maybeFindEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const created = JSON.parse(
      (await apiCreateTaskTool.handler({ board_id: BOARD, type: 'simple', title: 'Migrar o servidor de e-mail', sender_name: 'alice' })).content[0].text,
    );
    const id = created.data.id;
    const r = await maybeFindEmbedDuplicate(db, BOARD, 'simple', 'mover o servidor de email', {
      env: EMBED_ENV,
      embed: async () => vec,
      search: async (collection) => {
        expect(collection).toBe(`tasks:${BOARD}`);
        return [{ itemId: id, score: 0.97 }];
      },
    });
    expect(r).not.toBeNull();
    expect(String(r!.row.id)).toBe(id);
    expect(r!.score).toBeCloseTo(0.97);
  });

  it('ignores a match whose task no longer exists / is done', async () => {
    const { maybeFindEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const r = await maybeFindEmbedDuplicate(db, BOARD, 'simple', 'gone', {
      env: EMBED_ENV,
      embed: async () => vec,
      search: async () => [{ itemId: 'T-does-not-exist', score: 0.99 }],
    });
    expect(r).toBeNull();
  });

  it('skips a stale/deleted top hit and returns the lower-ranked LIVE duplicate (Codex-1)', async () => {
    const { apiCreateTaskTool, maybeFindEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const live = JSON.parse(
      (await apiCreateTaskTool.handler({ board_id: BOARD, type: 'simple', title: 'Configurar backup noturno', sender_name: 'alice' })).content[0].text,
    );
    const r = await maybeFindEmbedDuplicate(db, BOARD, 'simple', 'agendar o backup', {
      env: EMBED_ENV,
      embed: async () => vec,
      // top hit is a stale vector with no live row; the live dup is ranked lower.
      search: async () => [
        { itemId: 'T-stale-deleted', score: 0.99 },
        { itemId: live.data.id, score: 0.96 },
      ],
    });
    expect(r).not.toBeNull();
    expect(String(r!.row.id)).toBe(live.data.id);
    expect(r!.score).toBeCloseTo(0.96);
  });

  it('ignores a nearest match of a DIFFERENT task type (mirrors the lexical t.type filter, Codex-2)', async () => {
    const { apiCreateMeetingTaskTool, maybeFindEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const meeting = JSON.parse(
      (await apiCreateMeetingTaskTool.handler({ board_id: BOARD, title: 'Planejamento trimestral', sender_name: 'alice', scheduled_at: '2026-06-15T14:00:00Z' })).content[0].text,
    );
    // A 'simple' create whose nearest vector is a MEETING must NOT be flagged.
    const r = await maybeFindEmbedDuplicate(db, BOARD, 'simple', 'planejamento', {
      env: EMBED_ENV,
      embed: async () => vec,
      search: async () => [{ itemId: meeting.data.id, score: 0.99 }],
    });
    expect(r).toBeNull();
  });
});

describe('api_create_task dup-detection wiring (#392)', () => {
  const EMBED_ENV = {
    NANOCLAW_TASKFLOW_EMBED_MODEL: 'bge-m3',
    NANOCLAW_TASKFLOW_EMBED_URL: 'http://ollama:11434',
  } as unknown as NodeJS.ProcessEnv;
  const vec = Float32Array.from([1, 0, 0]);

  async function makeEmbedDup(score: number, title: string) {
    const { apiCreateTaskTool, maybeFindEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const created = JSON.parse(
      (await apiCreateTaskTool.handler({ board_id: BOARD, type: 'simple', title, sender_name: 'alice' })).content[0].text,
    );
    return maybeFindEmbedDuplicate(db, BOARD, 'simple', `${title} (variação)`, {
      env: EMBED_ENV,
      embed: async () => vec,
      search: async () => [{ itemId: created.data.id, score }],
    });
  }

  it('resolveEmbedDuplicate HARD-blocks a >= 0.95 match (success:false, duplicate_hard_block, mentions force_create)', async () => {
    const { TaskflowEngine } = await import('../taskflow-engine.ts');
    const { resolveEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const dup = await makeEmbedDup(0.97, 'Atualizar firmware dos roteadores');
    const res = JSON.parse(resolveEmbedDuplicate(new TaskflowEngine(db, BOARD), dup!).content[0].text);
    expect(res.success).toBe(false);
    expect(res.error_code).toBe('duplicate_hard_block');
    expect(res.error).toContain('force_create');
  });

  it('resolveEmbedDuplicate returns a SOFT duplicate_candidate for an [0.85, 0.95) match', async () => {
    const { TaskflowEngine } = await import('../taskflow-engine.ts');
    const { resolveEmbedDuplicate } = await import('./taskflow-api-mutate.ts');
    const dup = await makeEmbedDup(0.88, 'Revisar contrato de locação');
    const res = JSON.parse(resolveEmbedDuplicate(new TaskflowEngine(db, BOARD), dup!).content[0].text);
    expect(res.success).toBe(true);
    expect(res.data.duplicate_candidate).toBe(true);
  });

  it('force_create:true bypasses dup-detection and creates despite a duplicate', async () => {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    await apiCreateTaskTool.handler({ board_id: BOARD, type: 'simple', title: 'Comprar cabos de rede', sender_name: 'alice' });
    // Same title again, no force → soft duplicate_candidate (lexical, no create).
    const dupRes = JSON.parse(
      (await apiCreateTaskTool.handler({ board_id: BOARD, type: 'simple', title: 'Comprar cabos de rede', sender_name: 'alice' })).content[0].text,
    );
    expect(dupRes.data?.duplicate_candidate).toBe(true);
    // With force_create → actually creates the second task.
    const forced = JSON.parse(
      (await apiCreateTaskTool.handler({ board_id: BOARD, type: 'simple', title: 'Comprar cabos de rede', sender_name: 'alice', force_create: true })).content[0].text,
    );
    expect(forced.success).toBe(true);
    expect(forced.data.duplicate_candidate).toBeUndefined();
    expect(forced.data.id).toBeTruthy();
  });
});

// finalizeMutationResult runs normalizeEngineNotificationEvents POST-commit and
// before the success check. normalize THROWS on a malformed engine notification
// (#399 fixed one case — invite-pending group/no-JID — but the other validation
// throws remain). A committed mutation (success:true) must NEVER be flipped to
// success:false because the engine handed back a malformed notification: the bad
// notifications are dropped (logged), the mutation still reports success. This is
// the only post-commit throw left in finalize — the emit/dispatch side-effects
// are already individually fail-soft.
describe('finalizeMutationResult — notification normalization is fail-soft', () => {
  it('keeps success:true when normalization throws on a committed mutation', async () => {
    const { finalizeMutationResult } = await import('./taskflow-api-mutate.ts');
    const res = finalizeMutationResult({
      success: true,
      task_id: 'T1',
      notifications: 'not-an-array', // → normalize throws "expected array"
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.notification_events).toEqual([]);
  });

  it('still reports failure (and does not throw) when normalization throws on a failed result', async () => {
    const { finalizeMutationResult } = await import('./taskflow-api-mutate.ts');
    const res = finalizeMutationResult({ success: false, notifications: 'not-an-array' });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.notification_events).toEqual([]);
  });

  it('normalizes well-formed notifications unchanged (guard does not swallow valid events)', async () => {
    const { finalizeMutationResult } = await import('./taskflow-api-mutate.ts');
    const res = finalizeMutationResult({
      success: true,
      task_id: 'T2',
      notifications: [{ target_kind: 'dm', target_chat_jid: '55@s', message: 'oi' }],
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.notification_events).toEqual([
      { kind: 'direct_message', target_chat_jid: '55@s', message: 'oi' },
    ]);
  });
});

// Codex re-verify: the post-commit-throw class is NOT just finalizeMutationResult.
// Two more post-commit, pre-response operations could throw and flip a COMMITTED
// mutation to success:false (→ agent retries → double create/update):
//   • finalizeCreatedTaskResult re-normalizes notifications post-create (line ~362)
//   • the update + meeting-reschedule paths read getBoardTimezone and format with
//     toLocaleDateString, which throws on a garbage tz in board_runtime_config.
// Both are closed via shared fail-soft helpers; pin the intent.
describe('post-commit finalizers — fail-soft against secondary-work throws', () => {
  it('safeNotificationEvents: malformed notifications → [] (never throws)', async () => {
    const { safeNotificationEvents } = await import('./taskflow-api-mutate.ts');
    expect(safeNotificationEvents({ notifications: 'not-an-array' })).toEqual([]);
  });

  it('safeNotificationEvents: well-formed notifications normalize unchanged', async () => {
    const { safeNotificationEvents } = await import('./taskflow-api-mutate.ts');
    expect(
      safeNotificationEvents({ notifications: [{ target_kind: 'dm', target_chat_jid: '55@s', message: 'oi' }] }),
    ).toEqual([{ kind: 'direct_message', target_chat_jid: '55@s', message: 'oi' }]);
  });

  it('safeBoardTimeZone: a garbage tz in board_runtime_config → default, never throws', async () => {
    const { safeBoardTimeZone } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_runtime_config (board_id, timezone) VALUES (?, 'Not/AZone')
       ON CONFLICT(board_id) DO UPDATE SET timezone = excluded.timezone`,
    ).run(BOARD);
    expect(safeBoardTimeZone(db, BOARD)).toBe('America/Fortaleza');
  });

  it('safeBoardTimeZone: a valid tz is returned as-is', async () => {
    const { safeBoardTimeZone } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_runtime_config (board_id, timezone) VALUES (?, 'America/Sao_Paulo')
       ON CONFLICT(board_id) DO UPDATE SET timezone = excluded.timezone`,
    ).run(BOARD);
    expect(safeBoardTimeZone(db, BOARD)).toBe('America/Sao_Paulo');
  });

  it('finalizeCreatedTaskResult: a committed create survives a malformed notification (success:true)', async () => {
    const { apiCreateSimpleTaskTool, finalizeCreatedTaskResult } = await import('./taskflow-api-mutate.ts');
    const { TaskflowEngine } = await import('../taskflow-engine.ts');
    const created = JSON.parse(
      (await apiCreateSimpleTaskTool.handler({ board_id: BOARD, title: 'Keep me', sender_name: 'alice' })).content[0].text,
    );
    const engine = new TaskflowEngine(db, BOARD);
    const res = finalizeCreatedTaskResult(db, engine, BOARD, {
      success: true,
      task_id: created.data.id,
      notifications: 'not-an-array', // engine handed back a malformed notification
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.notification_events).toEqual([]);
  });
});

// Bulk api_move does NOT route through finalizeMutationResult — it normalizes
// each committed sub-move's notifications directly. That per-success normalize
// must be fail-soft too: a malformed notification from ONE committed move must
// not throw and flip the whole bulk result (multiple committed moves) to
// success:false. Per-success isolation also matters — one bad result drops only
// its own events, not the others'.
describe('bulkMoveNotificationEvents — per-success fail-soft (bulk move has no finalizer)', () => {
  it('drops a malformed sub-move notification without throwing, keeping the others', async () => {
    const { bulkMoveNotificationEvents } = await import('./taskflow-api-mutate.ts');
    const out = bulkMoveNotificationEvents([
      { notifications: 'not-an-array' }, // committed move, engine handed back garbage
      { notifications: [{ target_kind: 'dm', target_chat_jid: '55@s', message: 'oi' }] },
    ]);
    expect(out).toEqual([[], [{ kind: 'direct_message', target_chat_jid: '55@s', message: 'oi' }]]);
  });
});

// SEC#13 (#419) — END-TO-END: the per-turn actor binding makes the ENGINE deny a
// spoofed manager. This is the real proof that (a) overwriting sender_name with a
// non-manager real sender defeats isManager spoofing, and (b) the UNRESOLVED_SENDER
// sentinel resolves to a hard permission_denied at the engine layer.
describe('SEC#13 (#419) — engine denies a spoofed/unresolved manager on the chat surface', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
    // 'alice' is seeded as a manager by setupEngineDb(withBoardAdmins). Add 'bob' as a
    // plain member (NOT a manager) to stand in for the authenticated, non-privileged sender.
    db.prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`).run(BOARD);
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = BOARD;
  });
  afterEach(() => {
    clearTurnActor();
    closeSessionDb();
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  async function setWip(senderName: string) {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const r = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: senderName, // what the MODEL asserts — must be overwritten by the turn actor
      person_name: 'bob',
      wip_limit: 3,
    });
    return JSON.parse(r.content[0].text);
  }

  it('SPOOF DEFEATED: the real sender is a non-manager (bob); naming the manager (alice) is overwritten → permission_denied', async () => {
    setTurnActor(['bob']); // the authenticated inbound sender of this turn
    const r = await setWip('alice'); // model claims to be the manager
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/not a manager/i);
  });

  it('UNRESOLVED → denied: a mixed-sender batch deletes sender_name (backstop) so the raw handler refuses, never running as the model manager', async () => {
    // The requiresChatActor WRAPPER denies an unresolved turn with permission_denied
    // (locked in chat-actor-guard.test.ts). This exercises the RAW handler's
    // belt-and-suspenders backstop: normalizeAgentIds deletes the spoofed sender_name →
    // the tool's own required-field check refuses (err() → isError text). Either way it
    // never runs as 'alice'.
    setTurnActor(['bob', 'mallory']); // two distinct senders → unresolved
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const r = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
      wip_limit: 3,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/sender_name/i);
  });

  it('LEGIT manager still works: when the authenticated sender IS the manager, the action succeeds', async () => {
    setTurnActor(['alice']); // alice really sent this turn
    const r = await setWip('bob'); // even with a wrong model sender_name, it binds to alice
    expect(r.success).toBe(true);
    const row = db
      .prepare('SELECT wip_limit FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, 'bob') as { wip_limit: number };
    expect(row.wip_limit).toBe(3);
  });
});

// SEC#13 (#419) — api_report stays a READ, but type='standup' bundles a board MUTATION
// (auto-archive of old done tasks). An UNAUTHENTICATED chat turn must not trigger it; a
// resolved manager standup and the pure scheduled/system standup still archive (Codex #419
// re-review BLOCKER: api_report(standup) archived via an unresolved turn).
describe('SEC#13 (#419) — api_report(standup) housekeeping is gated by the per-turn actor', () => {
  const OLD = '2020-01-01T00:00:00.000Z'; // > 30 days ago → eligible for auto-archive

  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, type, column, parent_task_id, created_at, updated_at)
       VALUES ('OLD1', ?, 'ancient done task', 'simple', 'done', NULL, ?, ?)`,
    ).run(BOARD, OLD, OLD);
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = BOARD;
  });
  afterEach(() => {
    clearTurnActor();
    closeSessionDb();
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  async function standup() {
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    return JSON.parse((await apiReportTool.handler({ board_id: BOARD, type: 'standup' })).content[0].text);
  }
  function oldTaskStillLive(): boolean {
    return !!db.prepare(`SELECT 1 FROM tasks WHERE board_id = ? AND id = 'OLD1'`).get(BOARD);
  }

  it('UNRESOLVED chat turn: the report still returns, but the bundled auto-archive does NOT run', async () => {
    setTurnActor(['ana', 'mallory']); // mixed → unresolved, not system
    const r = await standup();
    expect(r.success).toBe(true); // the READ still works
    expect(oldTaskStillLive()).toBe(true); // the MUTATION was gated
  });

  it('RESOLVED manager standup: the auto-archive runs', async () => {
    setTurnActor(['alice']);
    const r = await standup();
    expect(r.success).toBe(true);
    expect(oldTaskStillLive()).toBe(false); // archived
  });

  it('PURE SYSTEM/scheduled standup turn: the auto-archive runs', async () => {
    setTurnActor([], true, true); // a kind="task" scheduled standup runner
    const r = await standup();
    expect(r.success).toBe(true);
    expect(oldTaskStillLive()).toBe(false); // archived
  });

  it('UNRESOLVED chat api_report(any type): the read works but the engine is constructed READ-ONLY — no constructor/archive task mutation', async () => {
    // Codex #419 re-review BLOCKER: a non-readonly TaskflowEngine constructor runs
    // migrateLegacyProjectSubtasks + reconcileDelegationLinks (task writes). An unauthenticated
    // chat report must construct read-only — the report still returns, but NOTHING is mutated.
    setTurnActor(['ana', 'mallory']); // unresolved
    const { apiReportTool } = await import('./taskflow-api-mutate.ts');
    const r = JSON.parse((await apiReportTool.handler({ board_id: BOARD, type: 'digest' })).content[0].text);
    expect(r.success).toBe(true); // the READ works under readonly construction
    expect(oldTaskStillLive()).toBe(true); // no archive AND no constructor-side mutation
  });
});

// R4 (INBOUND tf-mcontrol 2026-06-10): api_create_task accepts an optional parent_task_id so the
// dashboard can create a subtask under an existing project in ONE atomic call (no orphan window) —
// validated with the same checks reparent_task runs (parent exists, is a project, same board).
describe('R4 — api_create_task parent_task_id (atomic subtask creation)', () => {
  async function create(args: Record<string, unknown>) {
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    return JSON.parse((await apiCreateTaskTool.handler({ board_id: BOARD, sender_name: 'alice', ...args })).content[0].text);
  }

  it('creates a task already parented under an existing project', async () => {
    const proj = await create({ type: 'project', title: 'Operação' });
    expect(proj.success).toBe(true);
    const projId = proj.data.id;
    const sub = await create({ type: 'simple', title: 'Subtarefa', parent_task_id: projId });
    expect(sub.success).toBe(true);
    const row = db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(sub.data.id) as { parent_task_id: string };
    expect(row.parent_task_id).toBe(projId);
  });

  it('rejects a non-existent parent with not_found AND creates nothing (atomic)', async () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c;
    const r = await create({ type: 'simple', title: 'Orphan?', parent_task_id: 'P999' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
    const after = (db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c;
    expect(after).toBe(before); // no orphan task was created
  });

  it('rejects a parent that is not a project with validation_error', async () => {
    const simple = await create({ type: 'simple', title: 'Not a project' });
    const r = await create({ type: 'simple', title: 'Child', parent_task_id: simple.data.id });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
    expect(String(r.error)).toMatch(/not a project/i);
  });

  it('omitting parent_task_id creates a normal top-level task (no regression)', async () => {
    const r = await create({ type: 'simple', title: 'Top level' });
    expect(r.success).toBe(true);
    const row = db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(r.data.id) as { parent_task_id: string | null };
    expect(row.parent_task_id == null).toBe(true);
  });
});
