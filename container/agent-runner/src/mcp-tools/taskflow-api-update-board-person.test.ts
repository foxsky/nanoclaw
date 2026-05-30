import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

/**
 * `api_update_board_person` engine-behavior contract (R2.8 step 4b-iv).
 * Repointed from pure-SQL to the dedicated FastAPI method
 * `engine.updateBoardPerson` (Revision 2.1 R2.5 + Codex post-impl
 * IMPORTANT 3: one transactional, single existence-checked call; ZERO
 * engine owner auth, R2.3). The FastAPI contract is UNCHANGED, so the
 * repoint stays behavior-PRESERVING — these
 * are the exact assertions that guarded the pre-repoint pure-SQL tool
 * and stay the regression gate.
 *
 * Parity target: FastAPI `PATCH /api/v1/boards/{id}/people/{pid}`
 * (main.py:2919):
 *   - body keys ⊆ {wip_limit, role} and non-empty → else validation_error
 *   - wip_limit: null OR positive int; bool/float/≤0 → validation_error
 *   - role: null OR non-empty string; stored + echoed .strip()'d
 *   - "wip_limit" in body → UPDATE (incl. null→NULL); role!=null → UPDATE
 *   - echo {ok, person_id, wip_limit, role}; person absent → not_found
 *   - no sender_name (owner auth is FastAPI-side, R2.3)
 *
 * Note: setting role 'Gestor' is a DELIBERATE privilege grant (gates
 * REST task edit/delete of unowned tasks; R2.5) — exercised below via
 * the trimmed-role test, asserted as intentional in
 * taskflow-engine-board.test.ts.
 */
const BOARD = 'board-b1';
const PID = 'upd-me';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
  db.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role, wip_limit) VALUES (?, ?, 'Ann', 'member', 2)`,
  ).run(BOARD, PID);
});

afterEach(() => {
  closeTaskflowDb();
});

async function updatePerson(args: Record<string, unknown>) {
  const { apiUpdateBoardPersonTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiUpdateBoardPersonTool.handler(args)).content[0].text);
}

describe('api_update_board_person MCP tool (engine-backed)', () => {
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

/**
 * R2.7 shipped-bug regression: the repointed tool must pass the URL
 * board_id to the engine VERBATIM — never `normalizeAgentIds` (which
 * `board-`-prefixes plain-UUID FastAPI boards).
 */
describe('api_update_board_person — plain-UUID board ids', () => {
  const UUID_BOARD = '550e8400-e29b-41d4-a716-446655440000';
  beforeEach(() => {
    db.prepare(`INSERT INTO boards (id, name) VALUES (?, 'UUID Board')`).run(UUID_BOARD);
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'p1', 'P One', 'member')`,
    ).run(UUID_BOARD);
  });

  it('operates on the exact UUID board id (no board- prefixing)', async () => {
    const r = await updatePerson({ board_id: UUID_BOARD, person_id: 'p1', role: 'Lead' });
    expect(r.success).toBe(true);
    const row = db
      .prepare('SELECT role FROM board_people WHERE board_id=? AND person_id=?')
      .get(UUID_BOARD, 'p1') as { role: string };
    expect(row.role).toBe('Lead');
    expect(
      db.prepare("SELECT 1 FROM boards WHERE id = 'board-' || ?").get(UUID_BOARD),
    ).toBeNull();
  });
});
