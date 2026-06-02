import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { applyRunnerGate, gateRunnerMessages } from './runner-gate-apply.js';

// Container-side gate over the pending-message batch (mirror of the host sweep gate, which works on
// messages_in rows). gateRunnerMessages returns per-runner outcomes; applyRunnerGate marks the
// suppressed ones completed (→ host syncs the processing_ack → recurrence advances) and drops them
// from the batch so the warm container never posts a runner the host sweep would have suppressed.
const TZ = 'America/Fortaleza';
const MON = new Date('2026-06-01T12:00:00Z'); // Monday 09:00 local
const STANDUP = '0 8 * * 1-5';
const DIGEST = '0 18 * * 1-5';
const REVIEW = '0 14 * * 5';

function runner(id: string, tag: string, cron: string): MessageInRow {
  return {
    id,
    seq: null,
    kind: 'task',
    timestamp: '2026-06-01T00:00:00Z',
    status: 'pending',
    process_after: null,
    recurrence: cron,
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ prompt: `[${tag}] do the thing`, script: null }),
  };
}
function chat(id: string): MessageInRow {
  return {
    id,
    seq: null,
    kind: 'chat',
    timestamp: '2026-06-01T11:30:00Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ text: 'hi there' }),
  };
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
function inboundDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages_in (id TEXT, kind TEXT, timestamp TEXT);`);
  return db;
}

let open: Database[] = [];
function dbs() {
  const tf = taskflowDb();
  const ib = inboundDb();
  open.push(tf, ib);
  return { tf, ib };
}
afterEach(() => {
  open.forEach((d) => d.close());
  open = [];
});
const opts = (tf: Database, ib: Database) => ({ taskflowDb: tf, inboundDb: ib, boardId: 'b1', now: MON, timeZone: TZ });

describe('gateRunnerMessages', () => {
  it('Idle board: every runner suppressed (fired=false)', () => {
    const { tf, ib } = dbs();
    const msgs = [runner('s', 'TF-STANDUP', STANDUP), runner('d', 'TF-DIGEST', DIGEST), runner('r', 'TF-REVIEW', REVIEW)];
    expect(gateRunnerMessages(msgs, opts(tf, ib))).toEqual([
      { id: 's', job: 'standup', fired: false },
      { id: 'd', job: 'digest', fired: false },
      { id: 'r', job: 'review', fired: false },
    ]);
  });

  it('Stale board on Monday: standup fires, digest + review suppressed', () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','waiting')").run(); // pending, no interactions
    const msgs = [runner('s', 'TF-STANDUP', STANDUP), runner('d', 'TF-DIGEST', DIGEST), runner('r', 'TF-REVIEW', REVIEW)];
    const out = gateRunnerMessages(msgs, opts(tf, ib));
    expect(out.find((o) => o.id === 's')?.fired).toBe(true);
    expect(out.find((o) => o.id === 'd')?.fired).toBe(false);
    expect(out.find((o) => o.id === 'r')?.fired).toBe(false);
  });

  it('Active board: all runners fire (interaction since last run)', () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','in_progress')").run();
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T11:30:00Z')").run(); // after prev runs
    const msgs = [runner('s', 'TF-STANDUP', STANDUP), runner('d', 'TF-DIGEST', DIGEST)];
    expect(gateRunnerMessages(msgs, opts(tf, ib)).every((o) => o.fired)).toBe(true);
  });

  it('ignores non-runner rows (chat, or a recurring task with no [TF-*] tag)', () => {
    const { tf, ib } = dbs();
    const plainTask = { ...runner('x', 'NOT-A-RUNNER', STANDUP), content: JSON.stringify({ prompt: 'just a task' }) };
    expect(gateRunnerMessages([chat('c'), plainTask], opts(tf, ib))).toEqual([]);
  });

  it('A4: a late sweep anchors the window on the firing occurrence (process_after), so missed-window activity still fires', () => {
    const { tf, ib } = dbs();
    // The Monday standup (08:00 local = 11:00Z) was missed — the container only wakes Wed noon. A
    // member chatted Monday 11:30Z: inside the Monday standup's window, but BEFORE a now-anchored
    // window (which starts Tue 11:00Z). No pending task, so the interaction being counted is the only
    // thing that can keep the standup alive. With process_after threaded into the gate, it is.
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T11:30:00Z')").run();
    const s = { ...runner('s', 'TF-STANDUP', STANDUP), process_after: '2026-06-01T11:00:00Z' };
    const out = gateRunnerMessages([s], {
      taskflowDb: tf,
      inboundDb: ib,
      boardId: 'b1',
      now: new Date('2026-06-03T12:00:00Z'),
      timeZone: TZ,
    });
    expect(out).toEqual([{ id: 's', job: 'standup', fired: true }]); // Active via missed-window interaction
  });

  it('gates a foreign-timezone board in its OWN timezone (no guard skip)', () => {
    const { tf, ib } = dbs();
    tf.exec('CREATE TABLE board_runtime_config (board_id TEXT, timezone TEXT)');
    tf.prepare("INSERT INTO board_runtime_config (board_id, timezone) VALUES ('b1','America/New_York')").run();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','waiting')").run(); // stale (pending, no interactions)
    // 2026-06-01T03:30Z = Mon 00:30 in Fortaleza but Sun 23:30 in New York. Gated in the board's own
    // zone (NY) the stale standup must NOT fire (Sunday); gated in the global tz it wrongly would
    // (Monday). Proves the gate judges in board-local time and the guard is gone.
    const out = gateRunnerMessages([runner('s', 'TF-STANDUP', STANDUP)], {
      taskflowDb: tf,
      inboundDb: ib,
      boardId: 'b1',
      now: new Date('2026-06-01T03:30:00Z'),
      timeZone: TZ,
    });
    expect(out).toEqual([{ id: 's', job: 'standup', fired: false }]);
  });
});

describe('applyRunnerGate', () => {
  it('Idle: marks all runners completed and drops them from the batch', () => {
    const { tf, ib } = dbs();
    const calls: string[][] = [];
    const msgs = [runner('s', 'TF-STANDUP', STANDUP), runner('d', 'TF-DIGEST', DIGEST), runner('r', 'TF-REVIEW', REVIEW)];
    const kept = applyRunnerGate(msgs, opts(tf, ib), (ids) => calls.push(ids));
    expect(kept).toEqual([]); // nothing left to process
    expect(calls).toEqual([['s', 'd', 'r']]); // all marked completed once
  });

  it('Stale Monday: keeps standup in the batch, marks digest+review completed', () => {
    const { tf, ib } = dbs();
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','waiting')").run();
    const calls: string[][] = [];
    const s = runner('s', 'TF-STANDUP', STANDUP);
    const kept = applyRunnerGate([s, runner('d', 'TF-DIGEST', DIGEST), runner('r', 'TF-REVIEW', REVIEW)], opts(tf, ib), (ids) =>
      calls.push(ids),
    );
    expect(kept).toEqual([s]); // standup fires
    expect(calls).toEqual([['d', 'r']]); // digest + review suppressed
  });

  it('passes non-runner messages through untouched and never marks them completed', () => {
    const { tf, ib } = dbs();
    const calls: string[][] = [];
    const c = chat('c');
    const kept = applyRunnerGate([c], opts(tf, ib), (ids) => calls.push(ids));
    expect(kept).toEqual([c]);
    expect(calls).toEqual([]); // markCompleted never called when nothing is suppressed
  });
});
