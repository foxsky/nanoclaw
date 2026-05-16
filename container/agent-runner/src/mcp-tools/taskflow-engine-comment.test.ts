import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';
import { TaskflowEngine } from '../taskflow-engine.js';

/**
 * `engine.apiAddTaskComment` — the single-engine source of truth for
 * task comments (the tf-mcontrol `POST /tasks/{id}/comments` raw-SQL
 * handler is being retired onto this method; the in-container WhatsApp
 * agent uses the SAME method). A comment is a `task_history`
 * `action='comment'` row (distinct from notes, which live in
 * `tasks.notes`) + a `tasks.updated_at` bump.
 *
 * Notification: engine-canonical resolution (assignee is a person_id,
 * consistent with the 5 sibling notifying tools / resolveNotifTarget) —
 * notify the assignee unless there is none or the author IS the
 * assignee. **DELIBERATE v1 divergence (owner-approved 2026-05-16):**
 * the comment is shown IN FULL in the notification — NO `message[:80]`
 * truncation and NO "Digite <id> para ver detalhes" pull-pointer that
 * v1 `notify_task_commented` used. Single engine ⇒ WhatsApp + FastAPI
 * both inherit this.
 *
 * Auth is NOT here (R2.3 — FastAPI's require_board_access /
 * resolve_board_actor gates + resolves the author before the call;
 * payload validation is the tool handler's job).
 */
const BOARD = 'board-c1';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
  db.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid) VALUES (?, 'bob', 'Bob', 'member', 'g-bob@x')`,
  ).run(BOARD);
  db.prepare(
    `INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('T1', ?, 'Fix login', 'bob', '2026-01-01', '2026-01-01')`,
  ).run(BOARD);
  db.prepare(
    `INSERT INTO tasks (id, board_id, title, created_at, updated_at) VALUES ('T2', ?, 'Unassigned', '2026-01-01', '2026-01-01')`,
  ).run(BOARD);
});

afterEach(() => {
  closeTaskflowDb();
});

function comment(args: {
  board_id?: string;
  task_id: string;
  author_id: string;
  author_name: string;
  message: string;
}) {
  return new TaskflowEngine(db, BOARD).apiAddTaskComment({
    board_id: args.board_id ?? BOARD,
    task_id: args.task_id,
    author_id: args.author_id,
    author_name: args.author_name,
    message: args.message,
  });
}

describe('engine.apiAddTaskComment', () => {
  it("writes a task_history action='comment' row + bumps tasks.updated_at", () => {
    const r = comment({
      task_id: 'T1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'looks broken',
    });
    expect(r.success).toBe(true);
    const row = db
      .prepare(
        `SELECT action, "by", details FROM task_history WHERE board_id=? AND task_id='T1' AND action='comment'`,
      )
      .get(BOARD) as { action: string; by: string; details: string };
    expect(row).toEqual({ action: 'comment', by: 'alice', details: 'looks broken' });
    const t = db.prepare(`SELECT updated_at FROM tasks WHERE board_id=? AND id='T1'`).get(BOARD) as {
      updated_at: string;
    };
    expect(t.updated_at).not.toBe('2026-01-01');
  });

  it('returns the FastAPI-parity data shape {id,task_id,author_id,author_name,message,created_at}', () => {
    const r = comment({
      task_id: 'T1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'hi',
    }) as { success: true; data: Record<string, unknown> };
    expect(r.success).toBe(true);
    expect(Object.keys(r.data).sort()).toEqual(
      ['author_id', 'author_name', 'created_at', 'id', 'message', 'task_id'].sort(),
    );
    expect(r.data.task_id).toBe('T1');
    expect(r.data.author_id).toBe('alice');
    expect(r.data.author_name).toBe('Alice');
    expect(r.data.message).toBe('hi');
    expect(typeof r.data.id).toBe('number');
  });

  it('notifies the assignee (engine-canonical: assignee person_id, author != assignee)', () => {
    const r = comment({
      task_id: 'T1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'please check',
    }) as { success: true; notifications: Array<Record<string, unknown>> };
    expect(r.notifications).toHaveLength(1);
    expect(r.notifications[0].target_person_id).toBe('bob');
    expect(r.notifications[0].notification_group_jid).toBe('g-bob@x');
  });

  it('shows the FULL comment inline — no [:80] truncation, no "Digite … detalhes" tail (owner-approved v1 divergence)', () => {
    const long = 'x'.repeat(200);
    const r = comment({
      task_id: 'T1',
      author_id: 'alice',
      author_name: 'Alice',
      message: long,
    }) as { success: true; notifications: Array<{ message: string }> };
    const m = r.notifications[0].message;
    expect(m).toContain(long); // entire 200-char body present, untruncated
    expect(m).not.toContain('...');
    expect(m).not.toContain('Digite');
    expect(m).toBe(`💬 *Novo comentário na sua tarefa*\n\n*T1* — Fix login\n*Alice:* ${long}`);
  });

  it('does NOT notify when the task has no assignee', () => {
    const r = comment({
      task_id: 'T2',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'orphan',
    }) as { success: true; notifications: unknown[] };
    expect(r.notifications).toEqual([]);
  });

  it('does NOT notify when the author IS the assignee', () => {
    const r = comment({
      task_id: 'T1',
      author_id: 'bob',
      author_name: 'Bob',
      message: 'note to self',
    }) as { success: true; notifications: unknown[] };
    expect(r.notifications).toEqual([]);
  });

  it('notifies a NAME-keyed assignee too (Codex #1: api_update_simple_task stores tasks.assignee as the display name, not person_id)', () => {
    // `Bob` is the display name; person_id is `bob`. Pre-fix the engine
    // did `WHERE person_id = task.assignee` → no row for a name →
    // notification silently dead for every task last touched via
    // api_update_simple_task / legacy v1. Must resolve by person_id OR
    // name and notify the resolved person.
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('T-name', ?, 'Name-keyed', 'Bob', '2026-01-01', '2026-01-01')`,
    ).run(BOARD);
    const r = comment({
      task_id: 'T-name',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'ping',
    }) as { success: true; notifications: Array<Record<string, unknown>> };
    expect(r.success).toBe(true);
    expect(r.notifications).toHaveLength(1);
    expect(r.notifications[0].target_person_id).toBe('bob');
    expect(r.notifications[0].notification_group_jid).toBe('g-bob@x');
  });

  it('does NOT notify when the resolved assignee IS the author (name-keyed; skip on resolved person_id)', () => {
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('T-self', ?, 'Self', 'Bob', '2026-01-01', '2026-01-01')`,
    ).run(BOARD);
    const r = comment({
      task_id: 'T-self',
      author_id: 'bob', // resolved actor person_id == the assignee's person_id
      author_name: 'Bob',
      message: 'note to self',
    }) as { success: true; notifications: unknown[] };
    expect(r.notifications).toEqual([]);
  });

  it('resolves a person_id-vs-name collision deterministically — person_id wins (Codex #2: no ORDER BY → wrong person)', () => {
    // `board_people.name` is NOT unique and can collide with another
    // person's person_id. With (person_id=? OR name=?) + bare .get()
    // and no ORDER BY, SQLite returns an arbitrary (rowid-order) row →
    // the WRONG person gets notified / wrong self-skip. Insert the
    // name-collision row FIRST so a rowid-order .get() would pick it.
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'alpha', 'beta')`,
    ).run(BOARD); // person 'alpha' whose NAME is 'beta' (inserted first)
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, notification_group_jid) VALUES (?, 'beta', 'Zeta', 'g-beta@x')`,
    ).run(BOARD); // person whose person_id IS 'beta'
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('T-coll', ?, 'Collide', 'beta', '2026-01-01', '2026-01-01')`,
    ).run(BOARD);
    const r = comment({
      task_id: 'T-coll',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'who gets pinged?',
    }) as { success: true; notifications: Array<Record<string, unknown>> };
    expect(r.notifications).toHaveLength(1);
    // The person whose person_id === 'beta' must win, not the person
    // merely *named* 'beta'.
    expect(r.notifications[0].target_person_id).toBe('beta');
    expect(r.notifications[0].notification_group_jid).toBe('g-beta@x');
  });

  it('returns not_found for a missing task (FastAPI fetch_task_row 404 parity)', () => {
    const r = comment({
      task_id: 'NOPE',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'x',
    }) as { success: false; error_code: string };
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});
