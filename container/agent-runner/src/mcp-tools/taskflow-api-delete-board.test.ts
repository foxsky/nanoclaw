import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.js';

/**
 * `api_delete_board` contract. Strict parity with the live FastAPI
 * `DELETE /api/v1/boards/{id}` handler (idempotent 204; owner auth
 * FastAPI-side, R2.3) PLUS the tracked bug fix: the FastAPI handler
 * omits `board_holidays`, orphaning holiday rows on board delete —
 * `engine.deleteBoard` also clears it. Flat args (board_id only), no
 * actor/sender_name (consistent with the engine-backed siblings).
 * 204 → {success:true, data:null}.
 */
const SEED = 'board-seed';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(SEED, { withBoardAdmins: true });
  applyBoardConfigColumns(db); // prod board-config superset (NICE 1)
  db.exec(
    `CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT NOT NULL, holiday_date TEXT NOT NULL, label TEXT, PRIMARY KEY (board_id, holiday_date))`,
  );
});

afterEach(() => {
  closeTaskflowDb();
});

async function del(args: Record<string, unknown>) {
  const { apiDeleteBoardTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiDeleteBoardTool.handler(args)).content[0].text);
}

function seedBoard(id: string) {
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

describe('api_delete_board MCP tool (engine-backed)', () => {
  it('exports a tool named api_delete_board', async () => {
    const { apiDeleteBoardTool } = await import('./taskflow-api-board.ts');
    expect(apiDeleteBoardTool.tool.name).toBe('api_delete_board');
  });

  it('deletes the board + dependents and returns {success:true,data:null} (204)', async () => {
    seedBoard('board-del');
    const r = await del({ board_id: 'board-del' });
    expect(r).toEqual({ success: true, data: null });
    expect(db.prepare('SELECT 1 FROM boards WHERE id=?').get('board-del')).toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id=?').get('board-del'),
    ).toBeNull();
    expect(db.prepare('SELECT 1 FROM tasks WHERE board_id=?').get('board-del')).toBeNull();
  });

  it('BUG FIX: also clears board_holidays (FastAPI handler omits it)', async () => {
    seedBoard('board-del');
    await del({ board_id: 'board-del' });
    expect(
      db.prepare('SELECT 1 FROM board_holidays WHERE board_id=?').get('board-del'),
    ).toBeNull();
  });

  it('is board-scoped — a sibling board is untouched', async () => {
    seedBoard('board-del');
    seedBoard('board-keep');
    await del({ board_id: 'board-del' });
    expect(db.prepare('SELECT 1 FROM boards WHERE id=?').get('board-keep')).not.toBeNull();
    expect(
      db.prepare('SELECT 1 FROM board_holidays WHERE board_id=?').get('board-keep'),
    ).not.toBeNull();
  });

  it('is idempotent (re-delete / missing board → success,data:null)', async () => {
    seedBoard('board-del');
    expect(await del({ board_id: 'board-del' })).toEqual({ success: true, data: null });
    expect(await del({ board_id: 'board-del' })).toEqual({ success: true, data: null });
    expect(await del({ board_id: 'never-existed' })).toEqual({
      success: true,
      data: null,
    });
  });

  it('rejects a non-string board_id with validation_error', async () => {
    const r = await del({ board_id: 42 });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
  });

  it('operates on the exact plain-UUID board id (no board- prefixing; R2.7)', async () => {
    const UUID = '550e8400-e29b-41d4-a716-446655440000';
    seedBoard(UUID);
    const r = await del({ board_id: UUID });
    expect(r.success).toBe(true);
    expect(db.prepare('SELECT 1 FROM boards WHERE id=?').get(UUID)).toBeNull();
    expect(
      db.prepare("SELECT 1 FROM boards WHERE id = 'board-' || ?").get(UUID),
    ).toBeNull();
  });
});
