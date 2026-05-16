import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.js';

/**
 * `api_update_board` behavioral contract (R2.8 step 4b-i). Split out of
 * `taskflow-api-board.test.ts` because the repointed tool now constructs
 * the engine (`engine.updateBoard`), which needs the full schema —
 * `setupEngineDb` provides it, the old minimal `boards`+`board_people`
 * fixture does not. The other 3 board tools stay pure-SQL on the old
 * fixture until their own repoint units.
 *
 * `update_board` has NO WhatsApp competitor (design Revision 2.1 R2.1),
 * so the repoint is behavior-PRESERVING: these are the exact assertions
 * that guarded the pre-repoint pure-SQL tool — they are the regression
 * gate and must stay green across the engine repoint.
 *
 * Parity target: FastAPI `PATCH /api/v1/boards/{id}` (main.py:2744):
 *   - `name`: trim; empty-after-trim rejected (validation_error)
 *   - `description`: trim; empty/whitespace → stored NULL
 *   - neither provided → board row returned UNCHANGED, no updated_at bump
 *   - otherwise updated_at = datetime('now'); full flat row (RETURNING *)
 *   - no `sender_name` (owner auth is FastAPI-side, R2.3)
 */
const BOARD = 'board-b1';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
  applyBoardConfigColumns(db); // prod board-config superset (NICE 1)
  // Match the original board-test seed (board_role 'hierarchy' is the
  // setupEngineDb column default; the rest set here).
  db.prepare(
    `UPDATE boards SET name = 'Original', description = 'old desc',
       org_id = 'o1', owner_user_id = 'u1',
       created_at = '2026-01-01 00:00:00', updated_at = '2026-01-01 00:00:00'
     WHERE id = ?`,
  ).run(BOARD);
});

afterEach(() => {
  closeTaskflowDb();
});

async function update(args: Record<string, unknown>) {
  const { apiUpdateBoardTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiUpdateBoardTool.handler(args)).content[0].text);
}

describe('api_update_board MCP tool', () => {
  it('exports a tool named api_update_board', async () => {
    const { apiUpdateBoardTool } = await import('./taskflow-api-board.ts');
    expect(apiUpdateBoardTool.tool.name).toBe('api_update_board');
  });

  it('updates name + description, bumps updated_at, returns the flat board row', async () => {
    const r = await update({ board_id: BOARD, name: 'Updated', description: 'new desc' });
    expect(r.success).toBe(true);
    // flat row, not a {board:...} wrapper (Codex finding 4)
    expect(r.data.board).toBeUndefined();
    expect(r.data.id).toBe(BOARD);
    expect(r.data.name).toBe('Updated');
    expect(r.data.description).toBe('new desc');
    expect(r.data.updated_at).not.toBe('2026-01-01 00:00:00');
    // unrelated columns preserved
    expect(r.data.board_role).toBe('hierarchy');
    expect(r.data.owner_user_id).toBe('u1');
  });

  it('trims name and rejects empty-after-trim', async () => {
    const r = await update({ board_id: BOARD, name: '   ' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
    const row = db.prepare('SELECT name FROM boards WHERE id = ?').get(BOARD) as { name: string };
    expect(row.name).toBe('Original'); // not mutated
  });

  it('trims a provided name before storing', async () => {
    const r = await update({ board_id: BOARD, name: '  Spaced  ' });
    expect(r.success).toBe(true);
    expect(r.data.name).toBe('Spaced');
  });

  it('stores NULL when description is whitespace-only', async () => {
    const r = await update({ board_id: BOARD, description: '   ' });
    expect(r.success).toBe(true);
    expect(r.data.description).toBeNull();
  });

  it('no-op (no name/description) returns the row unchanged with NO updated_at bump', async () => {
    const r = await update({ board_id: BOARD });
    expect(r.success).toBe(true);
    expect(r.data.name).toBe('Original');
    expect(r.data.updated_at).toBe('2026-01-01 00:00:00');
  });

  it('explicit name:null with no description is a no-op (no error, no bump)', async () => {
    const r = await update({ board_id: BOARD, name: null });
    expect(r.success).toBe(true);
    expect(r.data.name).toBe('Original');
    expect(r.data.updated_at).toBe('2026-01-01 00:00:00');
  });

  it('returns not_found for a missing board', async () => {
    const r = await update({ board_id: 'board-nope', name: 'X' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});

/**
 * R2.7 shipped-bug regression (moved here with the engine repoint):
 * FastAPI creates plain-UUID boards. `api_update_board` must pass the
 * URL board_id to `engine.updateBoard` VERBATIM — never
 * `normalizeAgentIds` (which `board-`-prefixes non-prefixed ids and
 * would look up / mutate the wrong board).
 */
describe('api_update_board — plain-UUID board ids (no board- prefixing)', () => {
  const UUID_BOARD = '550e8400-e29b-41d4-a716-446655440000';
  beforeEach(() => {
    db.prepare(
      `INSERT INTO boards (id, board_role, name, created_at, updated_at)
       VALUES (?, 'hierarchy', 'UUID Board', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    ).run(UUID_BOARD);
  });

  it('operates on the exact UUID id (engine repoint preserves verbatim board_id)', async () => {
    const r = await update({ board_id: UUID_BOARD, name: 'Renamed' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(UUID_BOARD);
    expect(r.data.name).toBe('Renamed');
    // The non-prefixed id was NOT rewritten to `board-550e...`.
    const stray = db
      .prepare("SELECT 1 FROM boards WHERE id = 'board-' || ?")
      .get(UUID_BOARD);
    expect(stray).toBeNull();
  });
});
