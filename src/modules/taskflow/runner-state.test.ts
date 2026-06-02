import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { computeRunnerState, isMondayLocal, localDateString, previousRunIso } from './runner-state.js';

const TZ = 'America/Fortaleza'; // GMT-3, matches the deployment
const STANDUP_CRON = '0 8 * * 1-5';
// 2026-06-01 12:00Z = 09:00 local Monday (so prev standup run = 08:00 local = 11:00Z).
const MON_NOON_Z = new Date('2026-06-01T12:00:00Z');
const SAT_NOON_Z = new Date('2026-06-06T12:00:00Z');

function seedDbs() {
  const tf = new Database(':memory:');
  tf.exec(
    `CREATE TABLE tasks (id TEXT, board_id TEXT, column TEXT, due_date TEXT);
     CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, at TEXT);`,
  );
  const ib = new Database(':memory:');
  ib.exec(`CREATE TABLE messages_in (id TEXT, kind TEXT, timestamp TEXT);`);
  return { tf, ib };
}
let open: Database.Database[] = [];
function dbs() {
  const { tf, ib } = seedDbs();
  open.push(tf, ib);
  return { tf, ib };
}
afterEach(() => {
  open.forEach((d) => d.close());
  open = [];
});

const deps = (tf: Database.Database, ib: Database.Database, now = MON_NOON_Z) => ({
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
  it('previousRunIso gives the cron occurrence before now', () => {
    expect(previousRunIso(STANDUP_CRON, MON_NOON_Z, TZ)).toBe('2026-06-01T11:00:00.000Z');
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
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T10:00:00Z')").run(); // before 11:00Z
    expect(computeRunnerState(deps(tf, ib)).interactions).toBe(false);
  });

  it('interactions: a member chat message since the previous run counts; a runner task row does not', () => {
    const { tf, ib } = dbs();
    ib.prepare("INSERT INTO messages_in (id, kind, timestamp) VALUES ('m1','task','2026-06-01T11:30:00Z')").run();
    expect(computeRunnerState(deps(tf, ib)).interactions).toBe(false); // runner row, not a member message
    ib.prepare("INSERT INTO messages_in (id, kind, timestamp) VALUES ('m2','chat','2026-06-01T11:30:00Z')").run();
    expect(computeRunnerState(deps(tf, ib)).interactions).toBe(true);
  });
});
