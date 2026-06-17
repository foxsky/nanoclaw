import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { closeTaskflowDb } from './mcp-tools/db/taskflow-db.ts';
import { setupEngineDb } from './mcp-tools/taskflow-test-fixtures.ts';
import { TaskflowEngine } from './taskflow-engine.ts';

// Engine extension: api_update_task's `add_subtask` accepts an object
// form `{title, due_date?}` (matches the precedent set by rename_subtask,
// reopen_subtask, assign_subtask). String form still works.
// due_date is ISO YYYY-MM-DD calendar-validated (round-trip Date check —
// same gate as the update card's G4 fix). result.subtask: {id, title,
// due_date?} is populated so downstream formatters can build the v2
// add_subtask card without parsing changes[].

const BOARD = 'board-asd-001';

describe('engine.update — add_subtask object form {title, due_date?}', () => {
  let db: Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = setupEngineDb(BOARD, { withBoardAdmins: true });
    engine = new TaskflowEngine(db, BOARD);
    db.exec(
      `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
       VALUES ('P1', '${BOARD}', 'project', 'Parent Project', 'alice', 'in_progress', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
  });

  afterEach(() => { closeTaskflowDb(); });

  it('string form still works (backward-compat)', () => {
    const r = engine.update({
      board_id: BOARD, task_id: 'P1', sender_name: 'alice',
      updates: { add_subtask: 'String subtask' },
    });
    expect(r.success).toBe(true);
    const row = db.prepare(`SELECT title, due_date FROM tasks WHERE parent_task_id = 'P1'`).get() as any;
    expect(row.title).toBe('String subtask');
    expect(row.due_date).toBeNull();
  });

  it('object form persists due_date on the subtask row', () => {
    const r = engine.update({
      board_id: BOARD, task_id: 'P1', sender_name: 'alice',
      updates: { add_subtask: { title: 'With date', due_date: '2026-05-14' } as never },
    });
    expect(r.success).toBe(true);
    const row = db.prepare(`SELECT title, due_date FROM tasks WHERE parent_task_id = 'P1'`).get() as any;
    expect(row.title).toBe('With date');
    expect(row.due_date).toBe('2026-05-14');
  });

  it('result.subtask reflects {id, title, due_date} when due_date present', () => {
    const r = engine.update({
      board_id: BOARD, task_id: 'P1', sender_name: 'alice',
      updates: { add_subtask: { title: 'Has date', due_date: '2026-05-14' } as never },
    });
    expect(r.success).toBe(true);
    const subtask = (r as any).subtask;
    expect(subtask).toBeTruthy();
    expect(subtask.id).toMatch(/^P1\.\d+$/);
    expect(subtask.title).toBe('Has date');
    expect(subtask.due_date).toBe('2026-05-14');
  });

  it('result.subtask omits due_date when not provided (string form)', () => {
    const r = engine.update({
      board_id: BOARD, task_id: 'P1', sender_name: 'alice',
      updates: { add_subtask: 'No date' },
    });
    expect(r.success).toBe(true);
    const subtask = (r as any).subtask;
    expect(subtask).toBeTruthy();
    expect(subtask.title).toBe('No date');
    expect(subtask.due_date).toBeUndefined();
  });

  it('invalid ISO due_date shape → success:false (refuse — engine input contract is ISO)', () => {
    const r = engine.update({
      board_id: BOARD, task_id: 'P1', sender_name: 'alice',
      updates: { add_subtask: { title: 'X', due_date: '14/05/2026' } as never },
    });
    expect(r.success).toBe(false);
    expect((r as any).error).toMatch(/due_date/);
  });

  it('impossible calendar date (Feb 30) → success:false (round-trip Date check)', () => {
    const r = engine.update({
      board_id: BOARD, task_id: 'P1', sender_name: 'alice',
      updates: { add_subtask: { title: 'X', due_date: '2026-02-30' } as never },
    });
    expect(r.success).toBe(false);
    expect((r as any).error).toMatch(/due_date/);
  });

  it('object form missing title → success:false', () => {
    const r = engine.update({
      board_id: BOARD, task_id: 'P1', sender_name: 'alice',
      updates: { add_subtask: { title: '', due_date: '2026-05-14' } as never },
    });
    expect(r.success).toBe(false);
  });
});
