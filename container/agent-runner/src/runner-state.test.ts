import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { computeRunnerState, isMondayLocal, localDateString, previousRunIso } from './runner-state.js';

// Container mirror of the host runner-state tests (src/modules/taskflow/runner-state.test.ts).
// Same intent, bun:sqlite driver — the warm container must compute the board's RunnerState
// identically to the host sweep so both gate the same way (closing the warm-container race).
const TZ = 'America/Fortaleza'; // GMT-3, matches the deployment
const STANDUP_CRON = '0 8 * * 1-5';
// 2026-06-01 12:00Z = 09:00 local Monday (so prev standup run = 08:00 local = 11:00Z).
const MON_NOON_Z = new Date('2026-06-01T12:00:00Z');
const SAT_NOON_Z = new Date('2026-06-06T12:00:00Z');

function seedDbs() {
  const tf = new Database(':memory:');
  tf.exec(
    `CREATE TABLE tasks (id TEXT, board_id TEXT, column TEXT, due_date TEXT, assignee TEXT);
     CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, at TEXT);
     CREATE TABLE boards (id TEXT, parent_board_id TEXT);
     CREATE TABLE board_people (board_id TEXT, person_id TEXT);`,
  );
  const ib = new Database(':memory:');
  ib.exec(`CREATE TABLE messages_in (id TEXT, kind TEXT, timestamp TEXT);`);
  return { tf, ib };
}
let open: Database[] = [];
function dbs() {
  const { tf, ib } = seedDbs();
  open.push(tf, ib);
  return { tf, ib };
}
afterEach(() => {
  open.forEach((d) => d.close());
  open = [];
});

const deps = (tf: Database, ib: Database, now = MON_NOON_Z) => ({
  taskflowDb: tf,
  inboundDb: ib,
  boardId: 'b1',
  cron: STANDUP_CRON,
  now,
  timeZone: TZ,
});

describe('local date helpers', () => {
  it('isMondayLocal is true for a Monday morning in the local zone', () => {
    expect(isMondayLocal(MON_NOON_Z, TZ)).toBe(true);
    expect(isMondayLocal(SAT_NOON_Z, TZ)).toBe(false);
  });
  it('localDateString returns the local calendar date (not the UTC one)', () => {
    // 2026-06-01T02:00Z is still 2026-05-31 23:00 in GMT-3.
    expect(localDateString(new Date('2026-06-01T02:00:00Z'), TZ)).toBe('2026-05-31');
  });
  it('previousRunIso gives the run BEFORE the one firing now (not the current occurrence)', () => {
    // Now = Mon 09:00 local; the standup firing now is Mon 08:00 (11:00Z). The *previous* run
    // is the prior weekday's 08:00 = Fri 2026-05-29 08:00 local (11:00Z). A single prev() would
    // wrongly return today's 08:00 and collapse the interactions window.
    expect(previousRunIso(STANDUP_CRON, MON_NOON_Z, TZ)).toBe('2026-05-29T11:00:00.000Z');
  });
});

describe('computeRunnerState', () => {
  it('empty board on a Monday: nothing pending, no interactions, not due', () => {
    const { tf, ib } = dbs();
    expect(computeRunnerState(deps(tf, ib))).toEqual({
      pending: false,
      interactions: false,
      dueToday: false,
      isMonday: true,
    });
  });

  it('a Waiting task counts as pending (not Done)', () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','waiting')").run();
    expect(computeRunnerState(deps(tf, ib)).pending).toBe(true);
  });

  it('a Done-only board is not pending', () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','done')").run();
    expect(computeRunnerState(deps(tf, ib)).pending).toBe(false);
  });

  it('dueToday is true for a task due today on a weekday (date-prefix match, board-local date)', () => {
    const { tf, ib } = dbs();
    tf.prepare(
      "INSERT INTO tasks (id, board_id, column, due_date) VALUES ('T1','b1','next_action','2026-06-01')",
    ).run();
    expect(computeRunnerState(deps(tf, ib)).dueToday).toBe(true);
  });

  it('dueToday is false on a weekend even if a task is due that day', () => {
    const { tf, ib } = dbs();
    tf.prepare(
      "INSERT INTO tasks (id, board_id, column, due_date) VALUES ('T1','b1','next_action','2026-06-06')",
    ).run();
    expect(computeRunnerState(deps(tf, ib, SAT_NOON_Z)).dueToday).toBe(false);
  });

  it('interactions: a task_history change since the previous run counts', () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T11:30:00Z')").run(); // after 11:00Z
    expect(computeRunnerState(deps(tf, ib)).interactions).toBe(true);
  });

  it('interactions: activity BEFORE the previous run does not count', () => {
    const { tf, ib } = dbs();
    // Previous standup run is Fri 2026-05-29 11:00Z; seed activity before it (Thu) → not in window.
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-05-28T10:00:00Z')").run();
    expect(computeRunnerState(deps(tf, ib)).interactions).toBe(false);
  });

  it('interactions: a member chat message since the previous run counts; a runner task row does not', () => {
    const { tf, ib } = dbs();
    ib.prepare("INSERT INTO messages_in (id, kind, timestamp) VALUES ('m1','task','2026-06-01T11:30:00Z')").run();
    expect(computeRunnerState(deps(tf, ib)).interactions).toBe(false); // runner row, not a member message
    ib.prepare("INSERT INTO messages_in (id, kind, timestamp) VALUES ('m2','chat','2026-06-01T11:30:00Z')").run();
    expect(computeRunnerState(deps(tf, ib)).interactions).toBe(true);
  });

  // Child/delegated boards: a board's reportable work includes parent-board tasks assigned to its
  // own people (the PARENT_BOARD_HINT scope the runners report). Without this the gate would
  // silence a hierarchy board that has only delegated work. (Codex gpt-5.5/xhigh finding.)
  it("child board: a parent-board task assigned to THIS board's person counts as pending", () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO boards (id, parent_board_id) VALUES ('b1','p-board')").run();
    tf.prepare("INSERT INTO board_people (board_id, person_id) VALUES ('b1','alice')").run();
    // No local task on b1; one pending parent task assigned to alice (a b1 person).
    tf.prepare(
      "INSERT INTO tasks (id, board_id, column, assignee) VALUES ('PT1','p-board','in_progress','alice')",
    ).run();
    expect(computeRunnerState(deps(tf, ib)).pending).toBe(true);
  });

  it('child board: a parent task assigned to someone NOT on this board does not count', () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO boards (id, parent_board_id) VALUES ('b1','p-board')").run();
    tf.prepare("INSERT INTO board_people (board_id, person_id) VALUES ('b1','alice')").run();
    tf.prepare("INSERT INTO tasks (id, board_id, column, assignee) VALUES ('PT1','p-board','in_progress','bob')").run();
    expect(computeRunnerState(deps(tf, ib)).pending).toBe(false);
  });

  it("child board: a parent task assigned to this board's person due today drives dueToday", () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO boards (id, parent_board_id) VALUES ('b1','p-board')").run();
    tf.prepare("INSERT INTO board_people (board_id, person_id) VALUES ('b1','alice')").run();
    tf.prepare(
      "INSERT INTO tasks (id, board_id, column, assignee, due_date) VALUES ('PT1','p-board','in_progress','alice','2026-06-01')",
    ).run();
    expect(computeRunnerState(deps(tf, ib)).dueToday).toBe(true);
  });
});
