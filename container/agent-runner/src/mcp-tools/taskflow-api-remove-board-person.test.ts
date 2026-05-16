import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

/**
 * `api_remove_board_person` engine-behavior contract (R2.8 step 4b-ii).
 * The tool was repointed from pure-SQL hard-delete to
 * `engine.removeBoardPerson` → shared `_removeBoardPersonCore`. This is
 * a DELIBERATE behavior change (design Revision 2.1 R2.4): UI removal
 * now matches the WhatsApp engine path —
 *   - active non-done tasks BLOCK removal (no force): success:true with
 *     a top-level `tasks_to_reassign` + `data.message`; person stays.
 *   - `force:true` unassigns those tasks then deletes.
 *   - `board_admins` rows are cleared alongside `board_people`.
 *   - resolution is by EXACT person_id (R2.1.a — no fuzzy match); the
 *     engine does ZERO owner auth (R2.3 — FastAPI-side).
 * tf-mcontrol maps HTTP (204 vs 200 + list) and re-baselines the
 * golden AFTER wiring (R2.8 step 5). Split to its own file because the
 * engine-backed tool needs the full `setupEngineDb` schema.
 */
const BOARD = 'board-b1';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
});

afterEach(() => {
  closeTaskflowDb();
});

async function remove(args: Record<string, unknown>) {
  const { apiRemoveBoardPersonTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiRemoveBoardPersonTool.handler(args)).content[0].text);
}

describe('api_remove_board_person MCP tool (engine-backed)', () => {
  it('exports a tool named api_remove_board_person', async () => {
    const { apiRemoveBoardPersonTool } = await import('./taskflow-api-board.ts');
    expect(apiRemoveBoardPersonTool.tool.name).toBe('api_remove_board_person');
  });

  it('rejects non-string board_id / person_id and non-boolean force', async () => {
    expect((await remove({ board_id: 42, person_id: 'x' })).error_code).toBe(
      'validation_error',
    );
    expect((await remove({ board_id: BOARD, person_id: 42 })).error_code).toBe(
      'validation_error',
    );
    const r = await remove({ board_id: BOARD, person_id: 'alice', force: 'yes' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
    expect(r.error).toContain('force');
  });

  it('returns not_found for a missing board', async () => {
    const r = await remove({ board_id: 'board-nope', person_id: 'x' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Board not found');
  });

  it('returns not_found when the exact person_id is not on the board', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'bob', 'Bob')`,
    ).run(BOARD);
    // display name must NOT fuzzy-resolve — only the exact person_id.
    const r = await remove({ board_id: BOARD, person_id: 'Bob' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Person not found');
  });

  it('no active tasks → deletes board_people + board_admins; {removed,tasks_unassigned:0}', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'bob', 'Bob')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO board_admins (board_id, person_id, admin_role) VALUES (?, 'bob', 'manager')`,
    ).run(BOARD);
    const r = await remove({ board_id: BOARD, person_id: 'bob' });
    expect(r.success).toBe(true);
    expect(r.data.removed).toBe('Bob');
    expect(r.data.tasks_unassigned).toBe(0);
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=? AND person_id=?').get(BOARD, 'bob'),
    ).toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_admins WHERE board_id=? AND person_id=?').get(BOARD, 'bob'),
    ).toBeNull();
  });

  it('active tasks, no force → success + top-level tasks_to_reassign; person NOT deleted', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'bob', 'Bob')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, column, created_at, updated_at)
       VALUES ('T1', ?, 'Task one', 'bob', 'inbox', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:00.000Z')`,
    ).run(BOARD);
    const r = await remove({ board_id: BOARD, person_id: 'bob' });
    expect(r.success).toBe(true);
    expect(r.tasks_to_reassign).toEqual([{ task_id: 'T1', title: 'Task one' }]);
    expect(typeof r.data.message).toBe('string');
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=? AND person_id=?').get(BOARD, 'bob'),
    ).not.toBeNull();
  });

  it('active tasks + force → unassign + delete; {removed,tasks_unassigned:1}', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'bob', 'Bob')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, column, created_at, updated_at)
       VALUES ('T1', ?, 'Task one', 'bob', 'inbox', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:00.000Z')`,
    ).run(BOARD);
    const r = await remove({ board_id: BOARD, person_id: 'bob', force: true });
    expect(r.success).toBe(true);
    expect(r.data.removed).toBe('Bob');
    expect(r.data.tasks_unassigned).toBe(1);
    const task = db.prepare('SELECT assignee FROM tasks WHERE id=?').get('T1') as {
      assignee: string | null;
    };
    expect(task.assignee).toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=? AND person_id=?').get(BOARD, 'bob'),
    ).toBeNull();
  });
});

/**
 * R2.7 shipped-bug regression: the repointed tool must pass the URL
 * board_id to the engine VERBATIM — never `normalizeAgentIds` (which
 * `board-`-prefixes plain-UUID FastAPI boards and would mutate the
 * wrong board).
 */
describe('api_remove_board_person — plain-UUID board ids', () => {
  const UUID_BOARD = '550e8400-e29b-41d4-a716-446655440000';
  beforeEach(() => {
    db.prepare(`INSERT INTO boards (id, name) VALUES (?, 'UUID Board')`).run(UUID_BOARD);
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'p1', 'P One')`,
    ).run(UUID_BOARD);
  });

  it('operates on the exact UUID board id (no board- prefixing)', async () => {
    const r = await remove({ board_id: UUID_BOARD, person_id: 'p1' });
    expect(r.success).toBe(true);
    expect(r.data.removed).toBe('P One');
    expect(
      db.prepare("SELECT 1 FROM boards WHERE id = 'board-' || ?").get(UUID_BOARD),
    ).toBeNull();
  });
});
