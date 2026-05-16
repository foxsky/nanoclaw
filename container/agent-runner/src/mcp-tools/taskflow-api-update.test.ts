import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

let db: Database;
let taskId: string;

const BOARD = 'board-b1';

beforeEach(async () => {
  db = setupEngineDb(BOARD);
  // Seed a second board member for assignee-change / actor-not-allowed tests.
  db.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'charlie', 'charlie', 'Tecnico')`,
  ).run(BOARD);
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

  it('description keeps explicit assignment commands on api_reassign', async () => {
    const { apiUpdateSimpleTaskTool } = await import('./taskflow-api-update.ts');
    expect(apiUpdateSimpleTaskTool.tool.description).toContain('Do not use for explicit assignment commands');
    expect(apiUpdateSimpleTaskTool.tool.description).toContain('api_reassign');
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

  it('updates visible delegated parent-board task fields through the engine path', async () => {
    const now = new Date().toISOString();
    const parentBoardId = 'board-parent';
    db.exec(`ALTER TABLE boards ADD COLUMN parent_board_id TEXT`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS board_admins (
         board_id TEXT NOT NULL, person_id TEXT NOT NULL, phone TEXT, admin_role TEXT NOT NULL,
         PRIMARY KEY (board_id, person_id, admin_role)
       );
       INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid)
       VALUES ('${parentBoardId}', 'SECI', 'Parent', 'standard', 'seci-taskflow', 'parent@g.us');
       UPDATE boards SET parent_board_id = '${parentBoardId}' WHERE id = '${BOARD}';
       INSERT INTO board_people (board_id, person_id, name, role) VALUES ('${parentBoardId}', 'alice', 'alice', 'member');
       INSERT INTO tasks (
         id, board_id, type, title, assignee, column, due_date,
         requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id,
         created_at, updated_at
       )
       VALUES ('P11.11', '${parentBoardId}', 'simple', 'Delegated parent task', 'alice', 'waiting', '2026-05-29',
               0, 1, '${BOARD}', 'alice', '${now}', '${now}')`,
    );

    const resp = await update({
      board_id: BOARD,
      task_id: 'P11.11',
      sender_name: 'alice',
      due_date: '2026-04-24',
    });
    const result = JSON.parse(resp.content[0].text);
    expect(result.success).toBe(true);

    const row = db
      .prepare(`SELECT due_date FROM tasks WHERE board_id = ? AND id = 'P11.11'`)
      .get(parentBoardId) as { due_date: string } | null;
    expect(row?.due_date).toBe('2026-04-24');
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
