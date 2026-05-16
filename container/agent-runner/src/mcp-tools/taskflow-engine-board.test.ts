import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';
import { TaskflowEngine, normalizePhone } from '../taskflow-engine.js';

/**
 * `engine.updateBoard` — dedicated FastAPI-only board mutation (design
 * Revision 2.1 R2.1: no WhatsApp competitor, so a fresh engine method,
 * not a shared core). This is the single source of board name/desc
 * mutation logic the reworked `api_update_board` tool will call (R2.8
 * step 4b). Auth is NOT here (R2.3: api_service does zero engine owner
 * auth — FastAPI's require_board_owner gates it before call_mcp_mutation).
 *
 * Contract mirrors FastAPI `PATCH /api/v1/boards/{id}` (main.py:2744):
 *   - the engine receives an ALREADY-NORMALIZED write intent (name
 *     pre-trimmed/validated, description pre-trimmed-or-null by the
 *     handler) — the engine does the DB mutation only.
 *   - empty intent → row returned UNCHANGED, NO updated_at bump (an
 *     unchanged PATCH must be idempotent / not touch the timestamp).
 *   - otherwise updated_at = datetime('now'); return the full flat row.
 *   - missing board → {success:false, error_code:'not_found'}.
 */
const BOARD = 'board-b1';
let db: Database;
let engine: TaskflowEngine;

beforeEach(() => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
  // Prod boards columns the shared fixture omits (Codex finding 7).
  db.exec(`ALTER TABLE boards ADD COLUMN description TEXT`);
  db.exec(`ALTER TABLE boards ADD COLUMN updated_at TEXT`);
  db.prepare(
    `UPDATE boards SET name = 'Original', description = 'old desc', updated_at = '2026-01-01 00:00:00' WHERE id = ?`,
  ).run(BOARD);
  engine = new TaskflowEngine(db, BOARD);
});

afterEach(() => {
  closeTaskflowDb();
});

describe('engine.updateBoard', () => {
  it('name + description: updates both, bumps updated_at, returns the flat row', () => {
    const r = engine.updateBoard(BOARD, { name: 'Updated', description: 'new desc' });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.id).toBe(BOARD);
    expect(r.data.name).toBe('Updated');
    expect(r.data.description).toBe('new desc');
    expect(r.data.updated_at).not.toBe('2026-01-01 00:00:00');
  });

  it('name only: leaves description untouched, bumps updated_at', () => {
    const r = engine.updateBoard(BOARD, { name: 'Renamed' });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.name).toBe('Renamed');
    expect(r.data.description).toBe('old desc');
    expect(r.data.updated_at).not.toBe('2026-01-01 00:00:00');
  });

  it('description present as null: stores NULL (clear), bumps updated_at', () => {
    const r = engine.updateBoard(BOARD, { description: null });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.description).toBeNull();
    expect(r.data.updated_at).not.toBe('2026-01-01 00:00:00');
  });

  it('empty intent: returns the unchanged row with NO updated_at bump (idempotent)', () => {
    const r = engine.updateBoard(BOARD, {});
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.name).toBe('Original');
    expect(r.data.description).toBe('old desc');
    expect(r.data.updated_at).toBe('2026-01-01 00:00:00');
  });

  it('missing board → {success:false, error_code:not_found}', () => {
    const r = engine.updateBoard('board-nope', { name: 'X' });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Board not found');
  });
});

/**
 * `engine.removeBoardPerson` — public FastAPI wrapper around the shared
 * `_removeBoardPersonCore` (design Revision 2.1 R2.1.a + R2.4). It does
 * ZERO engine owner auth (R2.3: FastAPI's require_board_owner gates it)
 * and resolves the target by EXACT person_id — NOT the fuzzy
 * `requirePerson()` the WhatsApp `api_admin` path uses (FastAPI routes
 * are exact-id). Surfaces the engine truth verbatim (R2.4):
 *   - no active tasks → delete (incl. board_admins) → {removed,tasks_unassigned:0}
 *   - active tasks, no force → success:true + top-level tasks_to_reassign
 *     + data.message; the person is NOT deleted
 *   - active tasks + force → unassign + delete → {removed,tasks_unassigned:n}
 *   - board / person absent → {success:false, error_code:'not_found'}
 */
describe('engine.removeBoardPerson', () => {
  beforeEach(() => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'bob', 'Bob')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO board_admins (board_id, person_id, admin_role) VALUES (?, 'bob', 'manager')`,
    ).run(BOARD);
  });

  it('missing board → {success:false, error_code:not_found, "Board not found"}', () => {
    // Mirror the real tool call: the engine is constructed with the
    // request's board id (the IMPORTANT-2 guard requires boardId ===
    // this.boardId; a missing board is "row absent", not id divergence).
    const r = new TaskflowEngine(db, 'board-nope').removeBoardPerson('board-nope', 'bob');
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Board not found');
  });

  it('person absent by EXACT id → not_found (no fuzzy resolve)', () => {
    // 'Bob' (display name) must NOT resolve — only the exact person_id.
    const r = engine.removeBoardPerson(BOARD, 'Bob');
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Person not found');
  });

  it('no active tasks → deletes board_people + board_admins; {removed,tasks_unassigned:0}', () => {
    const r = engine.removeBoardPerson(BOARD, 'bob');
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.removed).toBe('Bob');
    expect(r.data.tasks_unassigned).toBe(0);
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=? AND person_id=?').get(BOARD, 'bob'),
    ).toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_admins WHERE board_id=? AND person_id=?').get(BOARD, 'bob'),
    ).toBeNull();
  });

  it('active tasks, no force → success + top-level tasks_to_reassign; person NOT deleted', () => {
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, column, created_at, updated_at)
       VALUES ('T1', ?, 'Task one', 'bob', 'inbox', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:00.000Z')`,
    ).run(BOARD);
    const r = engine.removeBoardPerson(BOARD, 'bob');
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.tasks_to_reassign).toEqual([{ task_id: 'T1', title: 'Task one' }]);
    expect(typeof r.data.message).toBe('string');
    // Not deleted — the caller must reassign or force.
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=? AND person_id=?').get(BOARD, 'bob'),
    ).not.toBeNull();
  });

  it('active tasks + force → unassign + delete; {removed,tasks_unassigned:1}', () => {
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, column, created_at, updated_at)
       VALUES ('T1', ?, 'Task one', 'bob', 'inbox', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:00.000Z')`,
    ).run(BOARD);
    const r = engine.removeBoardPerson(BOARD, 'bob', true);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
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
 * `engine.addBoardPerson` — public FastAPI wrapper around the shared
 * `_addBoardPersonCore` (design Revision 2.1 R2.1.a/R2.2/R2.3). ZERO
 * engine owner auth (R2.3, FastAPI-side). The handler derives the
 * person_id (phone-digits / uuid4) + owns validation_error; this
 * wrapper does: board-exists → R2.2 hierarchy guard → phone
 * canonicalization (same normalizePhone the WhatsApp register_person
 * path uses, for true single-engine parity) → core → map dup to a
 * conflict + build the FastAPI echo.
 *
 * R2.2: UI add-person on a delegating/hierarchy board is the explicit,
 * documented gap (no child-board auto-provision from the subprocess) —
 * reject with error_code 'hierarchy_provision_unsupported' BEFORE any
 * insert (tf-mcontrol maps it to HTTP 422). WhatsApp keeps full
 * auto-provision via api_admin (byte-oracle unaffected).
 */
describe('engine.addBoardPerson', () => {
  beforeEach(() => {
    // Prod columns the shared engine fixture omits: board_people.phone
    // (the core inserts it) + boards.hierarchy_level/max_depth (the R2.2
    // guard reads them via canDelegateDown(); NULL ⇒ non-hierarchy).
    db.exec(`ALTER TABLE board_people ADD COLUMN phone TEXT`);
    db.exec(`ALTER TABLE boards ADD COLUMN hierarchy_level INTEGER`);
    db.exec(`ALTER TABLE boards ADD COLUMN max_depth INTEGER`);
  });

  it('missing board → {success:false, error_code:not_found, "Board not found"}', () => {
    // Mirror the real tool call: engine constructed with the request's
    // board id (IMPORTANT-2 guard requires boardId === this.boardId).
    const r = new TaskflowEngine(db, 'board-nope').addBoardPerson('board-nope', {
      person_id: 'p1',
      name: 'P One',
      phone: null,
      role: 'member',
    });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Board not found');
  });

  it('R2.2: delegating board → hierarchy_provision_unsupported, NO row inserted', () => {
    db.prepare(`UPDATE boards SET hierarchy_level = 0, max_depth = 2 WHERE id = ?`).run(BOARD);
    const r = engine.addBoardPerson(BOARD, {
      person_id: 'p1',
      name: 'P One',
      phone: '5585999990000',
      role: 'member',
    });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('hierarchy_provision_unsupported');
    expect(r.error).toBe(
      'Add this member via WhatsApp until UI child-board provisioning lands',
    );
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=? AND person_id=?').get(BOARD, 'p1'),
    ).toBeNull();
  });

  it('non-hierarchy, no phone → success echo {ok,person_id,name,phone:null,role}; row inserted', () => {
    const r = engine.addBoardPerson(BOARD, {
      person_id: 'uuid-1',
      name: 'Carol',
      phone: null,
      role: 'member',
    });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data).toEqual({
      ok: true,
      person_id: 'uuid-1',
      name: 'Carol',
      phone: null,
      role: 'member',
    });
    const row = db
      .prepare('SELECT name, phone, role FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, 'uuid-1') as { name: string; phone: string | null; role: string };
    expect(row).toEqual({ name: 'Carol', phone: null, role: 'member' });
  });

  it('canonicalizes phone via normalizePhone (single-engine parity) — stored == echoed', () => {
    const input = '+55 (85) 99999-0000';
    const r = engine.addBoardPerson(BOARD, {
      person_id: '5585999990000',
      name: 'Dan',
      phone: input,
      role: 'Tecnico',
    });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    const expected = normalizePhone(input) || input;
    expect(r.data.phone).toBe(expected);
    const row = db
      .prepare('SELECT phone, role FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, '5585999990000') as { phone: string; role: string };
    expect(row.phone).toBe(expected);
    expect(row.role).toBe('Tecnico');
  });

  it('duplicate person_id → {success:false, error_code:conflict}', () => {
    engine.addBoardPerson(BOARD, {
      person_id: 'dup',
      name: 'First',
      phone: null,
      role: 'member',
    });
    const r = engine.addBoardPerson(BOARD, {
      person_id: 'dup',
      name: 'Second',
      phone: null,
      role: 'member',
    });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('conflict');
    expect(r.error).toBe('Person already on this board');
  });
});

/**
 * `engine.updateBoardPerson` — dedicated FastAPI-only wip/role mutation
 * (design Revision 2.1 R2.5; Codex post-impl IMPORTANT 3: ONE method,
 * ONE transaction, ONE board/person existence check — the prior
 * two-method handler sequence re-checked between fields, so a mid-call
 * delete could leave wip changed yet return not_found on role). NOT a
 * shared core — the WhatsApp `api_admin set_wip_limit` keeps its own
 * semantics, which the byte-oracle locks. ZERO engine owner auth (R2.3,
 * FastAPI-side); resolves by EXACT person_id (R2.1.a); board/person →
 * not_found.
 *
 * WIP semantics here are the FastAPI contract: `'wip_limit' in fields`
 * with value `null` CLEARS the limit (the reject-<1-incl-0
 * validation_error stays handler-side). This intentionally DIVERGES
 * from engine `set_wip_limit` (accepts 0, rejects null).
 *
 * R2.5 decision (user, 2026-05-16): a board owner MAY set any
 * `board_people.role` incl. 'Gestor'. 'Gestor' is a deliberate
 * privilege grant — it gates REST task edit/delete of unowned tasks
 * (`taskflow-api-update.ts:172`, `taskflow-engine.ts:2496`). Roles are
 * free-form (no codebase whitelist), so the method persists any
 * (handler-validated, trimmed) role; the Gestor implication is
 * asserted below as INTENTIONAL. Audit-logging deferred (no person/role
 * audit table; analogous WhatsApp privilege ops don't log either).
 */
describe('engine.updateBoardPerson', () => {
  beforeEach(() => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role, wip_limit) VALUES (?, 'bob', 'Bob', 'member', 7)`,
    ).run(BOARD);
  });

  it('missing board → not_found "Board not found"', () => {
    const r = engine.updateBoardPerson('board-nope', 'bob', { role: 'Tecnico' });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Board not found');
  });

  it('missing person (exact id) → not_found "Person not found"', () => {
    const r = engine.updateBoardPerson(BOARD, 'ghost', { role: 'Tecnico' });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Person not found');
  });

  it('wip-only: sets a positive wip_limit, leaves role untouched', () => {
    const r = engine.updateBoardPerson(BOARD, 'bob', { wip_limit: 5 });
    expect(r.success).toBe(true);
    const row = db
      .prepare('SELECT wip_limit, role FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, 'bob') as { wip_limit: number; role: string };
    expect(row).toEqual({ wip_limit: 5, role: 'member' });
  });

  it('wip_limit null CLEARS the limit (FastAPI contract; diverges from engine set_wip_limit)', () => {
    const r = engine.updateBoardPerson(BOARD, 'bob', { wip_limit: null });
    expect(r.success).toBe(true);
    const row = db
      .prepare('SELECT wip_limit FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, 'bob') as { wip_limit: number | null };
    expect(row.wip_limit).toBeNull();
  });

  it('role-only: persists a free-form role, leaves wip_limit untouched', () => {
    const r = engine.updateBoardPerson(BOARD, 'bob', { role: 'Tecnico' });
    expect(r.success).toBe(true);
    const row = db
      .prepare('SELECT wip_limit, role FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, 'bob') as { wip_limit: number; role: string };
    expect(row).toEqual({ wip_limit: 7, role: 'Tecnico' });
  });

  it("INTENTIONAL (R2.5): owner may set role 'Gestor' — a privilege grant gating REST task edit/delete of unowned tasks (taskflow-api-update.ts:172)", () => {
    const r = engine.updateBoardPerson(BOARD, 'bob', { role: 'Gestor' });
    expect(r.success).toBe(true);
    const row = db
      .prepare('SELECT role FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, 'bob') as { role: string };
    // Deliberate: this row now satisfies the `role === 'Gestor'` gate at
    // taskflow-engine.ts:2496 / taskflow-api-update.ts:172. Owner
    // authority over their board's roles is the product intent; the
    // FastAPI owner-precheck (BLOCKER B) gates who may call this.
    expect(row.role).toBe('Gestor');
  });

  it('combined wip + role applied atomically in one existence-checked call', () => {
    const r = engine.updateBoardPerson(BOARD, 'bob', { wip_limit: 3, role: 'Lead' });
    expect(r.success).toBe(true);
    const row = db
      .prepare('SELECT wip_limit, role FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, 'bob') as { wip_limit: number; role: string };
    expect(row).toEqual({ wip_limit: 3, role: 'Lead' });
  });

  it('empty fields is a safe no-op success (handler guards empty body via validation_error)', () => {
    const r = engine.updateBoardPerson(BOARD, 'bob', {});
    expect(r.success).toBe(true);
    const row = db
      .prepare('SELECT wip_limit, role FROM board_people WHERE board_id=? AND person_id=?')
      .get(BOARD, 'bob') as { wip_limit: number; role: string };
    expect(row).toEqual({ wip_limit: 7, role: 'member' }); // unchanged
  });
});
