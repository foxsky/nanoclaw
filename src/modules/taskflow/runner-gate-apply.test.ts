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
    `CREATE TABLE tasks (id TEXT, board_id TEXT, column TEXT, due_date TEXT);
     CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, at TEXT);`,
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
});
