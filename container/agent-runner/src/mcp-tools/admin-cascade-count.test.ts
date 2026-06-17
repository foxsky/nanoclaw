import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { TaskflowEngine } from '../taskflow-engine.js';
import { closeTaskflowDb } from './db/taskflow-db.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

// SEC#10 (#416): countAdminCascade is the READ-ONLY preflight that lets the api_admin gate size a
// cancel_task / restore_task project-cascade BEFORE mutating. It MUST match exactly what the real
// mutation touches (the gate threshold is meaningless if the count over/under-reports), and a single
// non-project / childless target MUST be exactly 1 so routine cancels never gate.

const BOARD = 'board-cc';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD);
});
afterEach(() => {
  closeTaskflowDb();
});

function seedTask(id: string, type: string, parent: string | null = null): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, board_id, type, title, column, requires_close_approval, created_at, updated_at, parent_task_id)
     VALUES (?, ?, ?, ?, 'next_action', 1, ?, ?, ?)`,
  ).run(id, BOARD, type, `Task ${id}`, now, now, parent);
}

function seedArchive(taskId: string, archivedSubtasks: unknown[]): void {
  const now = new Date().toISOString();
  const snapshot = JSON.stringify({ id: taskId, type: 'project', title: `Archived ${taskId}`, archived_subtasks: archivedSubtasks });
  db.prepare(
    `INSERT INTO archive (board_id, task_id, type, title, assignee, archive_reason, archived_at, task_snapshot, history)
     VALUES (?, ?, 'project', ?, NULL, 'cancelled', ?, ?, '[]')`,
  ).run(BOARD, taskId, `Archived ${taskId}`, now, snapshot);
}

describe('countAdminCascade — cancel_task', () => {
  it('counts a project + ALL its direct subtasks (the rows archiveTask deletes)', () => {
    seedTask('P1', 'project');
    seedTask('P1.1', 'simple', 'P1');
    seedTask('P1.2', 'simple', 'P1');
    seedTask('P1.3', 'simple', 'P1');
    const engine = new TaskflowEngine(db, BOARD);
    expect(engine.countAdminCascade('cancel_task', 'P1')).toBe(4); // 1 project + 3 subtasks
  });

  it('counts exactly 1 for a non-project task (no cascade → never gates)', () => {
    seedTask('T1', 'simple');
    const engine = new TaskflowEngine(db, BOARD);
    expect(engine.countAdminCascade('cancel_task', 'T1')).toBe(1);
  });

  it('counts exactly 1 for a childless project', () => {
    seedTask('P2', 'project');
    const engine = new TaskflowEngine(db, BOARD);
    expect(engine.countAdminCascade('cancel_task', 'P2')).toBe(1);
  });

  it('returns null for an unknown task (gate skips; real handler errors)', () => {
    const engine = new TaskflowEngine(db, BOARD);
    expect(engine.countAdminCascade('cancel_task', 'NOPE')).toBeNull();
  });
});

describe('countAdminCascade — restore_task', () => {
  it('counts the archived project + each restorable archived_subtask (mirrors the restore loop)', () => {
    seedArchive('PA', [
      { snapshot: { id: 'PA.1' } },
      { snapshot: { id: 'PA.2' } },
      { snapshot: { id: 'PA.3' } },
      { snapshot: { id: 'PA.4' } },
    ]);
    const engine = new TaskflowEngine(db, BOARD);
    expect(engine.countAdminCascade('restore_task', 'PA')).toBe(5); // 1 + 4
  });

  it('counts 1 for an archive with no subtasks', () => {
    seedArchive('PB', []);
    const engine = new TaskflowEngine(db, BOARD);
    expect(engine.countAdminCascade('restore_task', 'PB')).toBe(1);
  });

  it('ignores malformed archived_subtasks entries (no snapshot.id) — matches the loop skip guard', () => {
    seedArchive('PC', [{ snapshot: { id: 'PC.1' } }, { snapshot: {} }, { nope: true }, null]);
    const engine = new TaskflowEngine(db, BOARD);
    expect(engine.countAdminCascade('restore_task', 'PC')).toBe(2); // 1 + 1 valid child
  });

  it('returns null for an unknown archive', () => {
    const engine = new TaskflowEngine(db, BOARD);
    expect(engine.countAdminCascade('restore_task', 'NOPE')).toBeNull();
  });
});
