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
  db.exec(`
    CREATE TABLE board_people (
      board_id TEXT,
      person_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT DEFAULT 'member',
      wip_limit INTEGER,
      notification_group_jid TEXT,
      PRIMARY KEY (board_id, person_id)
    );
  `);
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
 * Parity: FastAPI `POST /api/v1/boards/{id}/people` (main.py:2786).
 *   - name required, trimmed, non-empty
 *   - phone optional; person_id = digits-only(phone) OR uuid4 if no phone
 *   - phone with no digits → 400
 *   - role default 'member' (falsy → 'member'), NOT trimmed
 *   - dup (board_id, person_id) → 409
 *   - response echo {ok, person_id, name, phone, role} (golden status 201)
 *   - no sender_name; owner auth FastAPI-side
 *   - must NOT reuse engine register_person (slug id / hierarchy
 *     auto-provision) — direct-SQL parity (Codex finding 5)
 */
async function addPerson(args: Record<string, unknown>) {
  const { apiAddBoardPersonTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiAddBoardPersonTool.handler(args)).content[0].text);
}

describe('api_add_board_person MCP tool', () => {
  it('exports a tool named api_add_board_person', async () => {
    const { apiAddBoardPersonTool } = await import('./taskflow-api-board.ts');
    expect(apiAddBoardPersonTool.tool.name).toBe('api_add_board_person');
  });

  it('derives person_id from phone digits, echoes {ok,person_id,name,phone,role}, inserts the row', async () => {
    const r = await addPerson({
      board_id: BOARD,
      name: 'Alice',
      phone: '+55 (85) 99999-0001',
      role: 'Tecnico',
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      ok: true,
      person_id: '5585999990001',
      name: 'Alice',
      phone: '+55 (85) 99999-0001',
      role: 'Tecnico',
    });
    const row = db
      .prepare('SELECT name, phone, role FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, '5585999990001') as { name: string; phone: string; role: string };
    expect(row).toEqual({ name: 'Alice', phone: '+55 (85) 99999-0001', role: 'Tecnico' });
  });

  it('generates a uuid person_id when no phone, stores phone NULL, echoes phone null', async () => {
    const r = await addPerson({ board_id: BOARD, name: 'Bob' });
    expect(r.success).toBe(true);
    expect(r.data.person_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(r.data.phone).toBeNull();
    expect(r.data.role).toBe('member');
    const row = db
      .prepare('SELECT phone FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, r.data.person_id) as { phone: string | null };
    expect(row.phone).toBeNull();
  });

  it('rejects missing/empty name with validation_error', async () => {
    expect((await addPerson({ board_id: BOARD })).error_code).toBe('validation_error');
    expect((await addPerson({ board_id: BOARD, name: '   ' })).error_code).toBe(
      'validation_error',
    );
  });

  it('rejects a phone with no digits (validation_error)', async () => {
    const r = await addPerson({ board_id: BOARD, name: 'X', phone: 'abc-def' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
  });

  it('returns conflict when the person is already on the board', async () => {
    await addPerson({ board_id: BOARD, name: 'Alice', phone: '5585999990001' });
    const r = await addPerson({ board_id: BOARD, name: 'Alice again', phone: '5585999990001' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('conflict');
  });

  it('defaults role to member when absent or falsy', async () => {
    expect((await addPerson({ board_id: BOARD, name: 'A', phone: '111' })).data.role).toBe(
      'member',
    );
    expect(
      (await addPerson({ board_id: BOARD, name: 'B', phone: '222', role: '' })).data.role,
    ).toBe('member');
  });

  it('returns not_found for a missing board', async () => {
    const r = await addPerson({ board_id: 'board-nope', name: 'A', phone: '999' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});

/**
 * Parity: FastAPI `DELETE /api/v1/boards/{id}/people/{pid}` (main.py:2814).
 *   - person row absent → 404 "Person not found"
 *   - else DELETE the board_people row; 204 no body (golden body=null)
 *   - no sender_name; owner auth FastAPI-side
 */
async function removePerson(args: Record<string, unknown>) {
  const { apiRemoveBoardPersonTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiRemoveBoardPersonTool.handler(args)).content[0].text);
}

describe('api_remove_board_person MCP tool', () => {
  it('exports a tool named api_remove_board_person', async () => {
    const { apiRemoveBoardPersonTool } = await import('./taskflow-api-board.ts');
    expect(apiRemoveBoardPersonTool.tool.name).toBe('api_remove_board_person');
  });

  it('deletes an existing board_people row and returns success with null data', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, '5585999990001', 'Alice', 'Tecnico')`,
    ).run(BOARD);
    const r = await removePerson({ board_id: BOARD, person_id: '5585999990001' });
    expect(r.success).toBe(true);
    expect(r.data).toBeNull();
    const row = db
      .prepare('SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, '5585999990001');
    expect(row).toBeNull();
  });

  it('returns not_found when the person is not on the board', async () => {
    const r = await removePerson({ board_id: BOARD, person_id: 'ghost' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
    expect(r.error).toContain('Person');
  });

  it('returns not_found for a missing board', async () => {
    const r = await removePerson({ board_id: 'board-nope', person_id: 'x' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
    expect(r.error).toContain('Board');
  });

  it('second removal of the same person is not_found (idempotent surface)', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'p2', 'Bob')`,
    ).run(BOARD);
    expect((await removePerson({ board_id: BOARD, person_id: 'p2' })).success).toBe(true);
    const r2 = await removePerson({ board_id: BOARD, person_id: 'p2' });
    expect(r2.success).toBe(false);
    expect(r2.error_code).toBe('not_found');
  });
});
