import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setVerbatimIds } from './taskflow-helpers.js';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.js';
import { apiUpdateBoardTool } from './taskflow-api-board.js';

// R1 (INBOUND from tf-mcontrol, 2026-06-10): api_update_board must accept + persist the four
// board-workflow fields the dashboard board-settings dialog collects — objective, max_agents,
// require_approval_for_done, require_review_before_done — with validation_error on bad shapes.
// (Premise correction: these were NOT pre-existing engine columns; this unit adds them.)
const BOARD = 'board-r1';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD);
  applyBoardConfigColumns(db);
  setVerbatimIds(true); // board tools are FastAPI-only (fastApiOnly wrapper); be realistic
});
afterEach(() => {
  setVerbatimIds(false);
  closeTaskflowDb();
});

async function update(args: Record<string, unknown>) {
  // call the raw handler (the registered tool is fastApiOnly-wrapped); verbatim is set above
  return JSON.parse((await apiUpdateBoardTool.handler({ board_id: BOARD, ...args })).content[0].text);
}
function boardRow() {
  return db
    .prepare(
      'SELECT objective, max_agents, require_approval_for_done, require_review_before_done, name FROM boards WHERE id = ?',
    )
    .get(BOARD) as Record<string, unknown>;
}

describe('R1 — api_update_board accepts the 4 board-workflow fields', () => {
  it('persists objective, max_agents, and the two done-gate flags', async () => {
    const r = await update({
      objective: 'Ship v2',
      max_agents: 3,
      require_approval_for_done: true,
      require_review_before_done: false,
    });
    expect(r.success).toBe(true);
    const row = boardRow();
    expect(row.objective).toBe('Ship v2');
    expect(row.max_agents).toBe(3);
    expect(row.require_approval_for_done).toBe(1); // boolean → 0/1
    expect(row.require_review_before_done).toBe(0);
  });

  it('rejects a negative max_agents with validation_error', async () => {
    const r = await update({ max_agents: -1 });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
    expect(String(r.error)).toMatch(/max_agents/i);
  });

  it('rejects a zero / non-integer max_agents', async () => {
    expect((await update({ max_agents: 0 })).error_code).toBe('validation_error');
    expect((await update({ max_agents: 2.5 })).error_code).toBe('validation_error');
    expect((await update({ max_agents: 'three' })).error_code).toBe('validation_error');
  });

  it('rejects a non-boolean done-gate flag', async () => {
    expect((await update({ require_approval_for_done: 'yes' })).error_code).toBe('validation_error');
    expect((await update({ require_review_before_done: 1 })).error_code).toBe('validation_error');
  });

  it('objective whitespace collapses to null; explicit null clears it', async () => {
    await update({ objective: 'X' });
    const r = await update({ objective: '   ' });
    expect(r.success).toBe(true);
    expect(boardRow().objective).toBeNull();
    await update({ objective: 'Y' });
    await update({ objective: null });
    expect(boardRow().objective).toBeNull();
  });

  it('max_agents null clears it', async () => {
    await update({ max_agents: 4 });
    const r = await update({ max_agents: null });
    expect(r.success).toBe(true);
    expect(boardRow().max_agents).toBeNull();
  });

  it('still updates name/description alongside the new fields (no regression)', async () => {
    const r = await update({ name: 'New Name', max_agents: 5 });
    expect(r.success).toBe(true);
    const row = boardRow();
    expect(row.name).toBe('New Name');
    expect(row.max_agents).toBe(5);
  });

  it('a no-op update (only board_id) still succeeds', async () => {
    const r = await update({});
    expect(r.success).toBe(true);
  });
});
