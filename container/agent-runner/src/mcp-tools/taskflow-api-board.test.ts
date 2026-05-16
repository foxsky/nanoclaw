import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb, initTestTaskflowDb } from '../db/connection.js';

/**
 * Parity target: FastAPI `PATCH /api/v1/boards/{id}` (main.py:2744).
 *   - `name`: trim; empty-after-trim is rejected (Pydantic validator)
 *   - `description`: trim; empty/whitespace → stored NULL
 *   - neither provided → board row returned UNCHANGED, no updated_at bump
 *   - otherwise: also `updated_at = datetime('now')`, return the full
 *     flat board row (RETURNING *) — NOT a {board: ...} wrapper
 *   - no `sender_name` (board endpoints resolve no actor; owner auth is
 *     enforced FastAPI-side before call_mcp_mutation)
 */
const BOARD = 'board-b1';
let db: Database;

beforeEach(() => {
  db = initTestTaskflowDb();
  // Prod-shaped boards table (the shared engine fixture omits
  // description/owner_user_id/org_id/timestamps — Codex finding 7).
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY,
      group_jid TEXT NOT NULL DEFAULT '',
      group_folder TEXT NOT NULL DEFAULT '',
      board_role TEXT DEFAULT 'standard',
      hierarchy_level INTEGER,
      max_depth INTEGER,
      parent_board_id TEXT,
      short_code TEXT,
      org_id TEXT,
      name TEXT NOT NULL DEFAULT '',
      description TEXT,
      owner_user_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      owner_person_id TEXT
    );
  `);
  db.prepare(
    `INSERT INTO boards (id, board_role, name, description, org_id, owner_user_id, created_at, updated_at)
     VALUES (?, 'hierarchy', 'Original', 'old desc', 'o1', 'u1', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
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
