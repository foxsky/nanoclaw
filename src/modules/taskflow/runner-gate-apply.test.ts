import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { gateScheduledRunners } from './runner-gate-apply.js';

const TZ = 'America/Fortaleza';
const MON = new Date('2026-06-01T12:00:00Z'); // Monday 09:00 local
const STANDUP = '0 8 * * 1-5';
const DIGEST = '0 18 * * 1-5';
const REVIEW = '0 14 * * 5';

function envelope(prompt: string) {
  return JSON.stringify({ prompt, script: null });
}

function inboundDb() {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE messages_in (id TEXT PRIMARY KEY, kind TEXT, content TEXT, recurrence TEXT,
       status TEXT, trigger INTEGER, process_after TEXT, timestamp TEXT);`,
  );
  return db;
}
function taskflowDb() {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE tasks (id TEXT, board_id TEXT, column TEXT, due_date TEXT, assignee TEXT);
     CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, at TEXT);
     CREATE TABLE boards (id TEXT, parent_board_id TEXT);
     CREATE TABLE board_people (board_id TEXT, person_id TEXT);`,
  );
  return db;
}
function addRunner(db: Database.Database, id: string, tag: string, cron: string) {
  db.prepare(
    `INSERT INTO messages_in (id, kind, content, recurrence, status, trigger, process_after)
     VALUES (?, 'task', ?, ?, 'pending', 1, '2000-01-01T00:00:00Z')`, // process_after in the past = due
  ).run(id, envelope(`[${tag}] do the thing`), cron);
}
function status(db: Database.Database, id: string): string {
  return (db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;
}

let open: Database.Database[] = [];
function dbs() {
  const ib = inboundDb();
  const tf = taskflowDb();
  open.push(ib, tf);
  return { ib, tf };
}
afterEach(() => {
  open.forEach((d) => d.close());
  open = [];
});
const opts = { boardId: 'b1', now: MON, timeZone: TZ };

describe('gateScheduledRunners', () => {
  it('Idle board: suppresses all three runners (marks them completed → no wake, recurrence still advances)', () => {
    const { ib, tf } = dbs();
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    addRunner(ib, 'd', 'TF-DIGEST', DIGEST);
    addRunner(ib, 'r', 'TF-REVIEW', REVIEW);
    gateScheduledRunners(ib, tf, opts);
    expect([status(ib, 's'), status(ib, 'd'), status(ib, 'r')]).toEqual(['completed', 'completed', 'completed']);
  });

  it('Stale board on Monday: standup stays pending (fires), digest + review suppressed', () => {
    const { ib, tf } = dbs();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','waiting')").run(); // pending, no interactions
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    addRunner(ib, 'd', 'TF-DIGEST', DIGEST);
    addRunner(ib, 'r', 'TF-REVIEW', REVIEW);
    gateScheduledRunners(ib, tf, opts);
    expect(status(ib, 's')).toBe('pending'); // fires
    expect(status(ib, 'd')).toBe('completed'); // suppressed
    expect(status(ib, 'r')).toBe('completed'); // suppressed
  });

  it('Active board: all runners stay pending (interaction since last run)', () => {
    const { ib, tf } = dbs();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','in_progress')").run();
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T11:30:00Z')").run(); // after prev runs
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    addRunner(ib, 'd', 'TF-DIGEST', DIGEST);
    gateScheduledRunners(ib, tf, opts);
    expect([status(ib, 's'), status(ib, 'd')]).toEqual(['pending', 'pending']);
  });

  it('never touches a non-runner message (no [TF-*] tag)', () => {
    const { ib, tf } = dbs();
    ib.prepare(
      `INSERT INTO messages_in (id, kind, content, recurrence, status, trigger, process_after)
       VALUES ('human','chat',?,NULL,'pending',1,'2000-01-01T00:00:00Z')`,
    ).run(JSON.stringify({ text: 'hi there' }));
    gateScheduledRunners(ib, tf, opts);
    expect(status(ib, 'human')).toBe('pending'); // untouched
  });

  it('returns per-runner outcomes for logging', () => {
    const { ib, tf } = dbs();
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    const out = gateScheduledRunners(ib, tf, opts);
    expect(out).toEqual([{ id: 's', job: 'standup', fired: false }]); // idle → suppressed
  });

  it('a compute error never suppresses the runner — it propagates to the fail-open wrapper, row stays pending', () => {
    const { ib, tf } = dbs();
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    tf.exec('DROP TABLE tasks'); // computeRunnerState's first query throws
    // The throw must reach gateDueRunnersForSession's fail-open try/catch (FS-coupled, Codex-verified)
    // WITHOUT having marked the runner completed first — i.e. an error must never silence a board.
    expect(() => gateScheduledRunners(ib, tf, opts)).toThrow();
    expect(status(ib, 's')).toBe('pending');
  });

  it('gates a foreign-timezone board in its OWN timezone (no guard skip)', () => {
    const { ib, tf } = dbs();
    tf.exec('CREATE TABLE board_runtime_config (board_id TEXT, timezone TEXT)');
    tf.prepare("INSERT INTO board_runtime_config (board_id, timezone) VALUES ('b1','America/New_York')").run();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','waiting')").run(); // stale: pending, no interactions
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    // 2026-06-01T03:30Z = Mon 00:30 in Fortaleza but Sun 23:30 in New York. Gated in the board's own
    // zone (NY) the stale standup must NOT fire (Sunday); gated in the global tz it wrongly would
    // (Monday). Proves the gate judges in board-local time and the guard is gone.
    gateScheduledRunners(ib, tf, { boardId: 'b1', now: new Date('2026-06-01T03:30:00Z'), timeZone: TZ });
    expect(status(ib, 's')).toBe('completed'); // suppressed in NY (Sunday) → marked completed
  });
});
