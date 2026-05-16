import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.js';

/**
 * `api_create_board` contract (0f option (b)). FastAPI preallocates
 * board_id and resolves org_id / owner_user_id server-side, passing
 * them flat; the engine inserts the row (strict parity with the live
 * FastAPI `POST /api/v1/boards` handler). Flat args, no actor/
 * sender_name (matches the other engine-backed board tools + the
 * settled contract); owner auth is FastAPI-side (R2.3). The handler
 * mirrors CreateBoardPayload validators (name trim+non-empty,
 * description trim→null, org_id trim+non-empty) and builds nothing —
 * the engine returns the flat board row.
 */
const SEED = 'board-seed';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(SEED, { withBoardAdmins: true });
  applyBoardConfigColumns(db); // prod board-config superset (NICE 1)
});

afterEach(() => {
  closeTaskflowDb();
});

async function create(args: Record<string, unknown>) {
  const { apiCreateBoardTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiCreateBoardTool.handler(args)).content[0].text);
}

describe('api_create_board MCP tool (engine-backed, 0f option b)', () => {
  it('exports a tool named api_create_board', async () => {
    const { apiCreateBoardTool } = await import('./taskflow-api-board.ts');
    expect(apiCreateBoardTool.tool.name).toBe('api_create_board');
  });

  it('creates the board (handler-parity columns) and returns the flat row', async () => {
    const r = await create({
      board_id: 'board-new-1',
      name: '  New Board  ',
      description: 'a desc',
      org_id: 'o1',
      owner_user_id: 'u1',
    });
    expect(r.success).toBe(true);
    expect(r.data.board).toBeUndefined(); // flat row, not {board:...}
    expect(r.data.id).toBe('board-new-1');
    expect(r.data.name).toBe('New Board'); // trimmed
    expect(r.data.description).toBe('a desc');
    expect(r.data.org_id).toBe('o1');
    expect(r.data.owner_user_id).toBe('u1');
    expect(r.data.board_role).toBe('hierarchy');
    expect(r.data.group_jid).toBe('');
    expect(r.data.group_folder).toBe('');
    expect(String(r.data.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(
      db.prepare('SELECT 1 FROM boards WHERE id = ?').get('board-new-1'),
    ).not.toBeNull();
  });

  it('whitespace-only description is stored as null', async () => {
    const r = await create({ board_id: 'board-new-2', name: 'B', description: '   ', org_id: 'o1' });
    expect(r.success).toBe(true);
    expect(r.data.description).toBeNull();
  });

  it('rejects missing/empty name and non-string board_id with validation_error', async () => {
    expect((await create({ board_id: 'board-x', name: '   ' })).error_code).toBe(
      'validation_error',
    );
    expect((await create({ board_id: 'board-x' })).error_code).toBe('validation_error');
    expect((await create({ board_id: 42, name: 'B' })).error_code).toBe('validation_error');
  });

  it('rejects an empty-string org_id (parity with CreateBoardPayload)', async () => {
    const r = await create({ board_id: 'board-x', name: 'B', org_id: '   ' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
    expect(r.error).toBe('org_id cannot be empty');
  });

  it('duplicate board_id → conflict', async () => {
    await create({ board_id: 'board-dup', name: 'First', org_id: 'o1' });
    const r = await create({ board_id: 'board-dup', name: 'Second', org_id: 'o1' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('conflict');
    expect(r.error).toBe('Board already exists');
  });

  it('operates on the exact plain-UUID board id (no board- prefixing; R2.7)', async () => {
    const UUID = '550e8400-e29b-41d4-a716-446655440000';
    const r = await create({ board_id: UUID, name: 'U', org_id: 'o1' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(UUID);
    expect(
      db.prepare("SELECT 1 FROM boards WHERE id = 'board-' || ?").get(UUID),
    ).toBeNull();
  });
});
