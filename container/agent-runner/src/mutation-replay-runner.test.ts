import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from './db/connection.ts';
import { TaskflowEngine } from './taskflow-engine.ts';
import { setupEngineDb } from './mcp-tools/taskflow-test-fixtures.ts';
import { runMutation } from './mutation-replay-runner.ts';

let db: Database;
let engine: TaskflowEngine;
const BOARD = 'b1';

beforeEach(() => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
  engine = new TaskflowEngine(db, BOARD);
});

afterEach(() => {
  closeTaskflowDb();
});

describe('runMutation — dispatch v1→v2-mapped call against a v2 TaskflowEngine', () => {
  it('dispatches engine.create successfully and returns its result transparently', () => {
    const result = runMutation(engine, {
      method: 'create',
      params: {
        board_id: BOARD,
        type: 'simple',
        title: 'Replay test',
        sender_name: 'alice',
      },
    });
    expect(result.success).toBe(true);
    expect(typeof (result as { task_id?: string }).task_id).toBe('string');
  });

  it('dispatches engine.move and returns from_column/to_column on success', () => {
    const created = runMutation(engine, {
      method: 'create',
      params: { board_id: BOARD, type: 'simple', title: 'X', sender_name: 'alice' },
    });
    const taskId = (created as { task_id: string }).task_id;

    const moved = runMutation(engine, {
      method: 'move',
      params: { board_id: BOARD, task_id: taskId, action: 'start', sender_name: 'alice' },
    });
    expect(moved.success).toBe(true);
    expect((moved as { to_column: string }).to_column).toBe('in_progress');
  });

  it('returns the engine error shape when the engine rejects (e.g. invalid transition)', () => {
    const created = runMutation(engine, {
      method: 'create',
      params: { board_id: BOARD, type: 'simple', title: 'X', sender_name: 'alice' },
    });
    const taskId = (created as { task_id: string }).task_id;

    // 'approve' from 'inbox' is rejected: alice is self-assignee
    const moved = runMutation(engine, {
      method: 'move',
      params: { board_id: BOARD, task_id: taskId, action: 'approve', sender_name: 'alice' },
    });
    expect(moved.success).toBe(false);
    expect(typeof (moved as { error?: string }).error).toBe('string');
  });

  it('returns an error shape when method does not exist on the engine', () => {
    const result = runMutation(engine, {
      method: 'nonexistent_method',
      params: { board_id: BOARD },
    });
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/Unknown engine method: nonexistent_method/);
  });

  it('catches thrown errors and returns success=false instead of crashing', () => {
    // requireString-style validation throws if a critical param is missing.
    // Engine.move calls requireTask which throws on missing task_id arg.
    const result = runMutation(engine, {
      method: 'move',
      params: {
        board_id: BOARD,
        // task_id omitted on purpose
        action: 'start',
        sender_name: 'alice',
      },
    });
    expect(result.success).toBe(false);
    expect(typeof (result as { error: string }).error).toBe('string');
  });

  it('preserves notifications array from the engine result (does not strip them)', () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const created = runMutation(engine, {
      method: 'create',
      params: {
        board_id: BOARD,
        type: 'simple',
        title: 'Bob task',
        sender_name: 'alice',
        assignee: 'bob',
      },
    });
    expect(created.success).toBe(true);
    // engine.create includes a notifications field when there is a non-self assignee
    expect(Array.isArray((created as { notifications?: unknown[] }).notifications)).toBe(true);
  });

  it('round-trip: create → move → undo restores original column', () => {
    const created = runMutation(engine, {
      method: 'create',
      // type='inbox' so the engine seeds the task in the 'inbox' column
      // (simple/project/recurring default to 'next_action').
      params: { board_id: BOARD, type: 'inbox', title: 'Round trip', sender_name: 'alice' },
    });
    const taskId = (created as { task_id: string }).task_id;

    runMutation(engine, {
      method: 'move',
      params: { board_id: BOARD, task_id: taskId, action: 'start', sender_name: 'alice' },
    });

    const undone = runMutation(engine, {
      method: 'undo',
      params: { board_id: BOARD, sender_name: 'alice' },
    });
    expect(undone.success).toBe(true);

    const col = db.prepare(`SELECT column FROM tasks WHERE id = ?`).get(taskId) as { column: string };
    expect(col.column).toBe('inbox');
  });
});
