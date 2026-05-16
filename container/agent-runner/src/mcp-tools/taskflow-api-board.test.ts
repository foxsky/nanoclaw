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

/**
 * `api_update_board` was repointed at `engine.updateBoard` (R2.8 step
 * 4b-i) and now constructs the engine, which needs the full schema —
 * its tests moved to `taskflow-api-update-board.test.ts` with a
 * `setupEngineDb` fixture. The 3 tools below stay pure-SQL on the
 * minimal fixture until their own repoint units.
 */

/**
 * `api_add_board_person` was repointed at `engine.addBoardPerson`
 * (R2.8 step 4b-iii) — a deliberate behavior change (R2.2 hierarchy
 * guard, phone canonicalized like the WhatsApp path). Its tests +
 * the add plain-UUID R2.7 regression moved to
 * `taskflow-api-add-board-person.test.ts` on a `setupEngineDb`
 * fixture.
 */

// api_add_board_person tests live in taskflow-api-add-board-person.test.ts
// (engine-backed; needs the full setupEngineDb schema).

/**
 * `api_remove_board_person` was repointed at `engine.removeBoardPerson`
 * (R2.8 step 4b-ii) — a deliberate behavior change per R2.4 (active
 * tasks block / force / board_admins cleanup). Its tests moved to
 * `taskflow-api-remove-board-person.test.ts` on a `setupEngineDb`
 * fixture (engine construction needs the full schema).
 */

/**
 * Parity: FastAPI `PATCH /api/v1/boards/{id}/people/{pid}` (main.py:2919).
 *   - body keys ⊆ {wip_limit, role} and non-empty → else 400
 *   - wip_limit: null OR positive int; bool/float/≤0 → 400
 *   - role: null OR non-empty string; stored + echoed .strip()'d
 *   - "wip_limit" in body → UPDATE (incl. null→NULL); role!=null → UPDATE
 *   - echo {ok, person_id, wip_limit, role} (golden status 200)
 *   - person absent → 404; no sender_name; owner auth FastAPI-side
 */
async function updatePerson(args: Record<string, unknown>) {
  const { apiUpdateBoardPersonTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiUpdateBoardPersonTool.handler(args)).content[0].text);
}

describe('api_update_board_person MCP tool', () => {
  const PID = 'upd-me';
  beforeEach(() => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role, wip_limit) VALUES (?, ?, 'Ann', 'member', 2)`,
    ).run(BOARD, PID);
  });

  it('exports a tool named api_update_board_person', async () => {
    const { apiUpdateBoardPersonTool } = await import('./taskflow-api-board.ts');
    expect(apiUpdateBoardPersonTool.tool.name).toBe('api_update_board_person');
  });

  it('updates wip_limit + role (role trimmed), echoes {ok,person_id,wip_limit,role}', async () => {
    const r = await updatePerson({
      board_id: BOARD,
      person_id: PID,
      wip_limit: 5,
      role: '  Gestor  ',
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ ok: true, person_id: PID, wip_limit: 5, role: 'Gestor' });
    const row = db
      .prepare('SELECT wip_limit, role FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, PID) as { wip_limit: number; role: string };
    expect(row).toEqual({ wip_limit: 5, role: 'Gestor' });
  });

  it('explicit null wip_limit sets the column NULL and echoes null', async () => {
    const r = await updatePerson({ board_id: BOARD, person_id: PID, wip_limit: null });
    expect(r.success).toBe(true);
    expect(r.data.wip_limit).toBeNull();
    const row = db
      .prepare('SELECT wip_limit FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, PID) as { wip_limit: number | null };
    expect(row.wip_limit).toBeNull();
  });

  it('role-only update leaves wip_limit untouched; echo wip_limit null', async () => {
    const r = await updatePerson({ board_id: BOARD, person_id: PID, role: 'Tecnico' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ ok: true, person_id: PID, wip_limit: null, role: 'Tecnico' });
    const row = db
      .prepare('SELECT wip_limit FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, PID) as { wip_limit: number };
    expect(row.wip_limit).toBe(2); // unchanged
  });

  it('rejects wip_limit that is zero, negative, float, or boolean', async () => {
    for (const bad of [0, -1, 1.5, true]) {
      const r = await updatePerson({ board_id: BOARD, person_id: PID, wip_limit: bad });
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('validation_error');
    }
  });

  it('rejects empty/whitespace role', async () => {
    expect(
      (await updatePerson({ board_id: BOARD, person_id: PID, role: '   ' })).error_code,
    ).toBe('validation_error');
  });

  it('rejects empty body and unknown keys', async () => {
    expect((await updatePerson({ board_id: BOARD, person_id: PID })).error_code).toBe(
      'validation_error',
    );
    expect(
      (await updatePerson({ board_id: BOARD, person_id: PID, name: 'X' })).error_code,
    ).toBe('validation_error');
  });

  it('returns not_found when the person is not on the board', async () => {
    const r = await updatePerson({ board_id: BOARD, person_id: 'ghost', role: 'X' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});

// R2.7 plain-UUID regressions now live per-tool with each repointed
// tool (taskflow-api-update-board.test.ts, taskflow-api-remove-board-
// person.test.ts, taskflow-api-add-board-person.test.ts). The last
// pure-SQL tool here (api_update_board_person) keeps verbatim board_id
// by construction (no normalizeAgentIds import in taskflow-api-board.ts).
