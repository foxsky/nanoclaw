import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.js';
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
  applyBoardConfigColumns(db); // prod board-config superset (NICE 1)
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

/**
 * `engine.createBoard` — 0f option (b): FastAPI preallocates the
 * board_id and owns org resolution; the engine just inserts the row.
 * Strict parity with the live FastAPI handler
 * (`taskflow-api/app/main.py` create_board): INSERT (id, org_id,
 * group_folder='', group_jid='', board_role='hierarchy', name,
 * description, owner_user_id, created_at=datetime('now'),
 * updated_at=datetime('now')) → return the FLAT board row. ZERO engine
 * owner auth (R2.3, FastAPI-side; agents 403'd there). The engine does
 * NOT resolve/create orgs — `org_id` is passed in guaranteed-existing
 * (FastAPI-owned). Constructing the engine for a not-yet-existing board
 * is safe (0f section, Codex-verified).
 */
describe('engine.createBoard', () => {
  const NEW = 'board-new-001';

  it('inserts the board with handler-parity columns; returns the flat row', () => {
    const r = new TaskflowEngine(db, NEW).createBoard(NEW, {
      name: 'New Board',
      description: 'desc',
      owner_user_id: 'u1',
      org_id: 'o1',
    });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.id).toBe(NEW);
    expect(r.data.name).toBe('New Board');
    expect(r.data.description).toBe('desc');
    expect(r.data.owner_user_id).toBe('u1');
    expect(r.data.org_id).toBe('o1');
    expect(r.data.board_role).toBe('hierarchy');
    expect(r.data.group_jid).toBe('');
    expect(r.data.group_folder).toBe('');
    const row = db.prepare('SELECT 1 FROM boards WHERE id = ?').get(NEW);
    expect(row).not.toBeNull();
  });

  it("created_at/updated_at use SQLite datetime('now') format (space, no 'T'/tz)", () => {
    const r = new TaskflowEngine(db, NEW).createBoard(NEW, {
      name: 'X',
      description: null,
      owner_user_id: 'u1',
      org_id: 'o1',
    });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    const fmt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    expect(String(r.data.created_at)).toMatch(fmt);
    expect(String(r.data.updated_at)).toMatch(fmt);
  });

  it('null description is stored/echoed as null', () => {
    const r = new TaskflowEngine(db, NEW).createBoard(NEW, {
      name: 'X',
      description: null,
      owner_user_id: 'u1',
      org_id: 'o1',
    });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.description).toBeNull();
  });

  it('engine does NOT resolve orgs — passes org_id through verbatim', () => {
    const r = new TaskflowEngine(db, NEW).createBoard(NEW, {
      name: 'X',
      description: null,
      owner_user_id: 'u1',
      org_id: 'org-verbatim-xyz',
    });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.org_id).toBe('org-verbatim-xyz');
  });

  it('duplicate board_id → {success:false, error_code:conflict}', () => {
    new TaskflowEngine(db, NEW).createBoard(NEW, {
      name: 'First',
      description: null,
      owner_user_id: 'u1',
      org_id: 'o1',
    });
    const r = new TaskflowEngine(db, NEW).createBoard(NEW, {
      name: 'Second',
      description: null,
      owner_user_id: 'u1',
      org_id: 'o1',
    });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('conflict');
    expect(r.error).toBe('Board already exists');
  });
});

/**
 * `engine.deleteBoard` — strict parity with the live FastAPI
 * `DELETE /api/v1/boards/{id}` handler (deletes dependents then the
 * board row, idempotent 204; no existence check — call_mcp_mutation
 * 404-prechecks before the engine; owner auth FastAPI-side, R2.3),
 * PLUS the tracked bug fix: the FastAPI handler omits `board_holidays`
 * (no FK / ON DELETE), orphaning holiday rows on delete —
 * engine.deleteBoard ALSO clears board_holidays. Multi-DELETE wrapped
 * in one transaction (Codex IMPORTANT-1 pattern — atomic). Each table
 * guarded by existence (mirrors FastAPI `if table_exists`). Self-
 * consistent on the boardId param (no this.boardId core) → no guard.
 */
describe('engine.deleteBoard', () => {
  const B = 'board-del';
  const OTHER = 'board-keep';
  beforeEach(() => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT NOT NULL, holiday_date TEXT NOT NULL, label TEXT, PRIMARY KEY (board_id, holiday_date))`,
    );
    for (const id of [B, OTHER]) {
      db.prepare(`INSERT INTO boards (id, name) VALUES (?, ?)`).run(id, id);
      db.prepare(
        `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'p1', 'P1')`,
      ).run(id);
      db.prepare(
        `INSERT INTO tasks (id, board_id, title, created_at, updated_at) VALUES ('T1', ?, 't', '2026-01-01', '2026-01-01')`,
      ).run(id);
      db.prepare(
        `INSERT INTO board_holidays (board_id, holiday_date, label) VALUES (?, '2026-12-25', 'Natal')`,
      ).run(id);
    }
  });

  it('deletes the board row + board-scoped dependents', () => {
    const r = new TaskflowEngine(db, B).deleteBoard(B);
    expect(r.success).toBe(true);
    expect(db.prepare('SELECT 1 FROM boards WHERE id=?').get(B)).toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=?').get(B),
    ).toBeNull();
    expect(db.prepare('SELECT 1 FROM tasks WHERE board_id=?').get(B)).toBeNull();
  });

  it('BUG FIX: also clears board_holidays (FastAPI handler omits it → orphan)', () => {
    new TaskflowEngine(db, B).deleteBoard(B);
    expect(
      db.prepare('SELECT 1 FROM board_holidays WHERE board_id=?').get(B),
    ).toBeNull();
  });

  it('is board-scoped — other boards untouched', () => {
    new TaskflowEngine(db, B).deleteBoard(B);
    expect(db.prepare('SELECT 1 FROM boards WHERE id=?').get(OTHER)).not.toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=?').get(OTHER),
    ).not.toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_holidays WHERE board_id=?').get(OTHER),
    ).not.toBeNull();
  });

  it('idempotent — deleting a missing/already-deleted board succeeds (FastAPI parity)', () => {
    new TaskflowEngine(db, B).deleteBoard(B);
    const r = new TaskflowEngine(db, B).deleteBoard(B);
    expect(r.success).toBe(true);
    const r2 = new TaskflowEngine(db, 'never-existed').deleteBoard('never-existed');
    expect(r2.success).toBe(true);
  });

  it('robust when a dependent table is absent (mirrors FastAPI table_exists guard)', () => {
    db.exec('DROP TABLE board_holidays');
    const r = new TaskflowEngine(db, B).deleteBoard(B);
    expect(r.success).toBe(true);
    expect(db.prepare('SELECT 1 FROM boards WHERE id=?').get(B)).toBeNull();
  });
});

/**
 * Codex BLOCKER (2026-05-16): the prod taskflow DB is opened with
 * `PRAGMA foreign_keys = ON` (connection.ts:209 initTaskflowDb — the
 * exact path the tf-mcontrol MCP subprocess uses). Several board-owned
 * tables declare `REFERENCES boards(id)` in canonical src/taskflow-db.ts
 * — `board_admins`, `board_groups`, `attachment_audit_log`, and
 * `child_board_registrations` (FK on BOTH parent_board_id AND
 * child_board_id). If deleteBoard's cascade omits any of them,
 * `DELETE FROM boards` raises FOREIGN KEY constraint failed — the
 * method does NOT return idempotent success, it THROWS. The shared
 * setupEngineDb fixture hides this (its schema declares zero
 * REFERENCES), so this block adds genuinely FK-bearing child tables.
 * Single-engine = the engine is now source-of-truth, so leaving
 * FK-backed rows is a real delete bug, not parity-deferred cleanup
 * (Codex scope verdict overturns the prior "mirror old FastAPI list").
 */
describe('engine.deleteBoard — FK-enforced schema (no FK-constraint throw)', () => {
  const PARENT = 'board-b0';
  beforeEach(() => {
    db.exec(
      `CREATE TABLE board_groups (board_id TEXT REFERENCES boards(id), group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, PRIMARY KEY (board_id, group_jid))`,
    );
    db.exec(
      `CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL REFERENCES boards(id), source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL)`,
    );
    db.exec(
      `CREATE TABLE board_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, body TEXT)`,
    );
    // meeting_external_participants + board_id_counters are created (FK-free)
    // by the engine's ensureTaskSchema — seed into those, don't re-create.
    db.prepare(`INSERT INTO boards (id, short_code, name) VALUES (?, 'P0', 'Parent')`).run(PARENT);
    db.prepare(
      `INSERT INTO board_groups (board_id, group_jid, group_folder) VALUES (?, 'g@x', 'f')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO attachment_audit_log (board_id, source, filename, at) VALUES (?, 'whatsapp', 'a.pdf', '2026-01-01')`,
    ).run(BOARD);
    db.prepare(`INSERT INTO board_chat (board_id, body) VALUES (?, 'hi')`).run(BOARD);
    db.prepare(
      `INSERT INTO meeting_external_participants (board_id, meeting_task_id, occurrence_scheduled_at, external_id, created_by, created_at, updated_at) VALUES (?, 'M1', '2026-01-01', 'x', 'p1', '2026-01-01', '2026-01-01')`,
    ).run(BOARD);
    // child_board_registrations exists FK-free in setupEngineDb (SQLite
    // can't ALTER-add a constraint), but the OR-scoping is still a
    // correctness requirement: BOARD as a child of PARENT, and BOARD
    // itself as a parent of PARENT.
    db.prepare(
      `INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, 'pa', ?)`,
    ).run(PARENT, BOARD);
    db.prepare(
      `INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, 'pb', ?)`,
    ).run(BOARD, PARENT);
  });

  it('does NOT throw FOREIGN KEY constraint failed; returns success and removes the board', () => {
    const r = new TaskflowEngine(db, BOARD).deleteBoard(BOARD);
    expect(r.success).toBe(true);
    expect(db.prepare('SELECT 1 FROM boards WHERE id=?').get(BOARD)).toBeNull();
  });

  it('clears the FK-backed board-owned tables (no orphaned referencing rows)', () => {
    new TaskflowEngine(db, BOARD).deleteBoard(BOARD);
    expect(
      db.prepare('SELECT 1 FROM board_groups WHERE board_id=?').get(BOARD),
    ).toBeNull();
    expect(
      db.prepare('SELECT 1 FROM attachment_audit_log WHERE board_id=?').get(BOARD),
    ).toBeNull();
  });

  it('clears child_board_registrations on BOTH the parent and child side', () => {
    new TaskflowEngine(db, BOARD).deleteBoard(BOARD);
    expect(
      db
        .prepare(
          'SELECT 1 FROM child_board_registrations WHERE parent_board_id=? OR child_board_id=?',
        )
        .get(BOARD, BOARD),
    ).toBeNull();
  });

  it('also clears non-FK board-owned state (source-of-truth delete)', () => {
    new TaskflowEngine(db, BOARD).deleteBoard(BOARD);
    expect(db.prepare('SELECT 1 FROM board_chat WHERE board_id=?').get(BOARD)).toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_id_counters WHERE board_id=?').get(BOARD),
    ).toBeNull();
    expect(
      db
        .prepare('SELECT 1 FROM meeting_external_participants WHERE board_id=?')
        .get(BOARD),
    ).toBeNull();
  });

  it('leaves the unrelated parent board row intact', () => {
    new TaskflowEngine(db, BOARD).deleteBoard(BOARD);
    expect(db.prepare('SELECT 1 FROM boards WHERE id=?').get(PARENT)).not.toBeNull();
  });
});

/**
 * Codex review #5 (2026-05-16): canonical `boards.parent_board_id TEXT
 * REFERENCES boards(id)` (src/taskflow-db.ts:25). Deleting a board that
 * is ANOTHER board's hierarchy parent throws FOREIGN KEY constraint
 * failed under PRAGMA foreign_keys=ON — deleteBoard never detaches
 * child boards. The earlier "self-FK out of scope" punt was unsafe
 * (same class as the original FK BLOCKER). Fix: detach children
 * (NULL parent_board_id) before `DELETE FROM boards` — children survive
 * standalone, hierarchy link severed (mirrors the child_board_
 * registrations cleanup). Needs a dedicated FK-bearing boards table
 * (a self-FK cannot be ALTER-added to the shared fixture).
 */
describe('engine.deleteBoard — boards.parent_board_id self-FK (no throw)', () => {
  let fk: Database;
  beforeEach(() => {
    // setupEngineDb-shaped schema (proven constructor-compatible) but
    // with FK enforcement + the canonical boards self-FK, which the
    // shared fixture omits and SQLite can't ALTER-add.
    fk = new Database(':memory:');
    fk.exec('PRAGMA foreign_keys = ON');
    fk.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, short_code TEXT, name TEXT NOT NULL DEFAULT '',
        board_role TEXT NOT NULL DEFAULT 'hierarchy',
        group_folder TEXT NOT NULL DEFAULT '', group_jid TEXT NOT NULL DEFAULT '',
        parent_board_id TEXT REFERENCES boards(id)
      );
      CREATE TABLE board_people (
        board_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
        notification_group_jid TEXT, wip_limit INTEGER,
        PRIMARY KEY (board_id, person_id)
      );
      CREATE TABLE board_runtime_config (
        board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR',
        timezone TEXT NOT NULL DEFAULT 'America/Fortaleza'
      );
      CREATE TABLE board_id_counters (
        board_id TEXT NOT NULL, prefix TEXT NOT NULL,
        next_number INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (board_id, prefix)
      );
      CREATE TABLE tasks (
        id TEXT NOT NULL, board_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'simple', title TEXT NOT NULL,
        assignee TEXT, next_action TEXT, waiting_for TEXT,
        column TEXT DEFAULT 'inbox', priority TEXT, due_date TEXT,
        description TEXT, labels TEXT DEFAULT '[]', blocked_by TEXT DEFAULT '[]',
        reminders TEXT DEFAULT '[]', next_note_id INTEGER DEFAULT 1,
        notes TEXT DEFAULT '[]', _last_mutation TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        child_exec_enabled INTEGER DEFAULT 0, child_exec_board_id TEXT,
        child_exec_person_id TEXT, child_exec_rollup_status TEXT,
        child_exec_last_rollup_at TEXT, child_exec_last_rollup_summary TEXT,
        linked_parent_board_id TEXT, linked_parent_task_id TEXT,
        subtasks TEXT, recurrence TEXT, current_cycle TEXT, parent_task_id TEXT,
        max_cycles INTEGER, recurrence_end_date TEXT, recurrence_anchor TEXT,
        participants TEXT, scheduled_at TEXT,
        requires_close_approval INTEGER NOT NULL DEFAULT 1, created_by TEXT,
        PRIMARY KEY (board_id, id)
      );
      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL,
        task_id TEXT NOT NULL, action TEXT NOT NULL, "by" TEXT,
        "at" TEXT NOT NULL, details TEXT, trigger_turn_id TEXT
      );
      CREATE TABLE child_board_registrations (
        parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT,
        PRIMARY KEY (parent_board_id, person_id)
      );
      CREATE TABLE archive (
        board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL,
        title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL,
        linked_parent_board_id TEXT, linked_parent_task_id TEXT,
        archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT,
        PRIMARY KEY (board_id, task_id)
      );
    `);
    fk.prepare(`INSERT INTO boards (id, short_code, name) VALUES ('par', 'P', 'Parent')`).run();
    fk.prepare(
      `INSERT INTO boards (id, short_code, name, parent_board_id) VALUES ('chi', 'C', 'Child', 'par')`,
    ).run();
  });
  afterEach(() => fk.close());

  it('deleting a hierarchy-parent board does NOT throw; child survives detached', () => {
    const r = new TaskflowEngine(fk, 'par').deleteBoard('par');
    expect(r.success).toBe(true);
    expect(fk.prepare("SELECT 1 FROM boards WHERE id='par'").get()).toBeNull();
    const child = fk
      .prepare("SELECT parent_board_id FROM boards WHERE id='chi'")
      .get() as { parent_board_id: string | null } | null;
    expect(child).not.toBeNull(); // child board survives
    expect(child!.parent_board_id).toBeNull(); // hierarchy link severed
  });
});

/**
 * `engine.addBoardHoliday` / `engine.removeBoardHoliday` — strict
 * parity with the live FastAPI holiday handlers
 * (taskflow-api/app/main.py). board_holidays prod schema:
 * (board_id, holiday_date, label, PK(board_id,holiday_date)). ZERO
 * engine owner auth (R2.3 — FastAPI-side). The date-format regex
 * (^\d{4}-\d{2}-\d{2}$) is handler-side validation_error; the engine
 * persists. add = INSERT OR REPLACE (upsert), no existence check
 * (parity); returns {ok,date,label}. remove = existence check →
 * not_found "Holiday not found" if absent, else DELETE (not
 * idempotent — parity). Self-consistent on the boardId param.
 */
describe('engine board holidays', () => {
  const B = 'board-hol';
  const OTHER = 'board-hol-2';
  beforeEach(() => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT NOT NULL, holiday_date TEXT NOT NULL, label TEXT, PRIMARY KEY (board_id, holiday_date))`,
    );
  });

  it('addBoardHoliday inserts the row and echoes {ok,date,label}', () => {
    const r = new TaskflowEngine(db, B).addBoardHoliday(B, '2026-12-25', 'Natal');
    expect(r).toEqual({ success: true, data: { ok: true, date: '2026-12-25', label: 'Natal' } });
    const row = db
      .prepare('SELECT label FROM board_holidays WHERE board_id=? AND holiday_date=?')
      .get(B, '2026-12-25') as { label: string | null };
    expect(row.label).toBe('Natal');
  });

  it('addBoardHoliday stores/echoes null label when not provided', () => {
    const r = new TaskflowEngine(db, B).addBoardHoliday(B, '2026-01-01', null);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error('unreachable');
    expect(r.data.label).toBeNull();
    const row = db
      .prepare('SELECT label FROM board_holidays WHERE board_id=? AND holiday_date=?')
      .get(B, '2026-01-01') as { label: string | null };
    expect(row.label).toBeNull();
  });

  it('addBoardHoliday is an upsert (re-add same date replaces label; one row)', () => {
    const e = new TaskflowEngine(db, B);
    e.addBoardHoliday(B, '2026-12-25', 'Natal');
    e.addBoardHoliday(B, '2026-12-25', 'Christmas');
    const rows = db
      .prepare('SELECT label FROM board_holidays WHERE board_id=? AND holiday_date=?')
      .all(B, '2026-12-25') as Array<{ label: string }>;
    expect(rows).toEqual([{ label: 'Christmas' }]);
  });

  it('removeBoardHoliday deletes an existing holiday → {success:true}', () => {
    const e = new TaskflowEngine(db, B);
    e.addBoardHoliday(B, '2026-12-25', 'Natal');
    const r = e.removeBoardHoliday(B, '2026-12-25');
    expect(r).toEqual({ success: true });
    expect(
      db.prepare('SELECT 1 FROM board_holidays WHERE board_id=? AND holiday_date=?').get(B, '2026-12-25'),
    ).toBeNull();
  });

  it('removeBoardHoliday → not_found when the holiday is absent (not idempotent; parity)', () => {
    const r = new TaskflowEngine(db, B).removeBoardHoliday(B, '2099-01-01');
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Holiday not found');
  });

  it('holiday ops are board-scoped', () => {
    new TaskflowEngine(db, B).addBoardHoliday(B, '2026-12-25', 'Natal');
    new TaskflowEngine(db, OTHER).addBoardHoliday(OTHER, '2026-12-25', 'Other');
    new TaskflowEngine(db, B).removeBoardHoliday(B, '2026-12-25');
    const row = db
      .prepare('SELECT label FROM board_holidays WHERE board_id=? AND holiday_date=?')
      .get(OTHER, '2026-12-25') as { label: string };
    expect(row.label).toBe('Other');
  });
});
