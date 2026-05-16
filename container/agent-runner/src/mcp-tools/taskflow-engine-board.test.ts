import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';
import { TaskflowEngine } from '../taskflow-engine.js';

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
    const r = engine.removeBoardPerson('board-nope', 'bob');
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
