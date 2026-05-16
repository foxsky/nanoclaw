import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.js';

/**
 * `api_add_holiday` / `api_remove_holiday` contract. Strict parity
 * with the live FastAPI `POST/DELETE /boards/{id}/holidays` handlers
 * (board_holidays prod schema: PK(board_id,holiday_date)). Flat args,
 * no actor/sender_name (consistent with the engine-backed siblings);
 * owner auth FastAPI-side (R2.3); board_id verbatim (R2.7). add: date
 * regex YYYY-MM-DD (validation_error), upsert, echo {ok,date,label};
 * remove: existence-checked → not_found "Holiday not found" if absent
 * (NOT idempotent — parity), 204 → {success:true,data:null}.
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

async function add(args: Record<string, unknown>) {
  const { apiAddHolidayTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiAddHolidayTool.handler(args)).content[0].text);
}
async function remove(args: Record<string, unknown>) {
  const { apiRemoveHolidayTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiRemoveHolidayTool.handler(args)).content[0].text);
}

describe('api_add_holiday MCP tool (engine-backed)', () => {
  it('exports a tool named api_add_holiday', async () => {
    const { apiAddHolidayTool } = await import('./taskflow-api-board.ts');
    expect(apiAddHolidayTool.tool.name).toBe('api_add_holiday');
  });

  it('inserts the holiday and echoes {ok,date,label}', async () => {
    const r = await add({ board_id: SEED, date: '2026-12-25', label: 'Natal' });
    expect(r).toEqual({ success: true, data: { ok: true, date: '2026-12-25', label: 'Natal' } });
    const row = db
      .prepare('SELECT label FROM board_holidays WHERE board_id=? AND holiday_date=?')
      .get(SEED, '2026-12-25') as { label: string };
    expect(row.label).toBe('Natal');
  });

  it('falsy/missing label → null (parity with `body.get("label") or None`)', async () => {
    expect((await add({ board_id: SEED, date: '2026-01-01' })).data.label).toBeNull();
    expect((await add({ board_id: SEED, date: '2026-01-02', label: '' })).data.label).toBeNull();
  });

  it('is an upsert (re-add same date replaces label)', async () => {
    await add({ board_id: SEED, date: '2026-12-25', label: 'Natal' });
    await add({ board_id: SEED, date: '2026-12-25', label: 'Christmas' });
    const rows = db
      .prepare('SELECT label FROM board_holidays WHERE board_id=? AND holiday_date=?')
      .all(SEED, '2026-12-25') as Array<{ label: string }>;
    expect(rows).toEqual([{ label: 'Christmas' }]);
  });

  it('rejects a non-YYYY-MM-DD date and missing board_id with validation_error', async () => {
    expect((await add({ board_id: SEED, date: '25/12/2026' })).error_code).toBe(
      'validation_error',
    );
    expect((await add({ board_id: SEED, date: '2026-1-1' })).error_code).toBe(
      'validation_error',
    );
    expect((await add({ board_id: 42, date: '2026-12-25' })).error_code).toBe(
      'validation_error',
    );
  });
});

describe('api_remove_holiday MCP tool (engine-backed)', () => {
  it('exports a tool named api_remove_holiday', async () => {
    const { apiRemoveHolidayTool } = await import('./taskflow-api-board.ts');
    expect(apiRemoveHolidayTool.tool.name).toBe('api_remove_holiday');
  });

  it('deletes an existing holiday → {success:true,data:null} (204)', async () => {
    await add({ board_id: SEED, date: '2026-12-25', label: 'Natal' });
    const r = await remove({ board_id: SEED, holiday_date: '2026-12-25' });
    expect(r).toEqual({ success: true, data: null });
    expect(
      db.prepare('SELECT 1 FROM board_holidays WHERE board_id=? AND holiday_date=?').get(SEED, '2026-12-25'),
    ).toBeNull();
  });

  it('absent holiday → not_found "Holiday not found" (NOT idempotent; parity)', async () => {
    const r = await remove({ board_id: SEED, holiday_date: '2099-01-01' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Holiday not found');
  });

  it('rejects missing board_id / holiday_date with validation_error', async () => {
    expect((await remove({ holiday_date: '2026-12-25' })).error_code).toBe(
      'validation_error',
    );
    expect((await remove({ board_id: SEED })).error_code).toBe('validation_error');
  });

  it('operates on the exact plain-UUID board id (no board- prefixing; R2.7)', async () => {
    const UUID = '550e8400-e29b-41d4-a716-446655440000';
    await add({ board_id: UUID, date: '2026-12-25', label: 'U' });
    const r = await remove({ board_id: UUID, holiday_date: '2026-12-25' });
    expect(r.success).toBe(true);
    expect(
      db.prepare("SELECT 1 FROM board_holidays WHERE board_id = 'board-' || ?").get(UUID),
    ).toBeNull();
  });
});
