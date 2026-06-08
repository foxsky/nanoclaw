import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { applyRunnerGate, gateRunnerMessages, isBoardHolidayToday } from './runner-gate-apply.js';

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

  it('A4 retry path: a backoff-rewritten process_after still anchors on the real occurrence, so the runner fires', () => {
    const { tf, ib } = dbs();
    // The Monday standup (08:00 local = 11:00Z) fired, the container claimed it and crashed;
    // resetStuckProcessingRows rewrote process_after to now+backoff = 11:05Z, a NON-occurrence. A task
    // changed at Mon 06:00 local (09:00Z) — BEFORE the standup but inside its real window
    // (Fri 11:00Z, Mon 11:00Z]. No pending task, so only that interaction can keep the standup alive.
    // Snapping the backoff anchor to the Monday occurrence keeps it; anchoring naively on 11:05Z would
    // collapse the window and wrongly suppress the retry.
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T09:00:00Z')").run(); // Mon 06:00 local
    const s = { ...runner('s', 'TF-STANDUP', STANDUP), process_after: '2026-06-01T11:05:00Z' };
    const out = gateRunnerMessages([s], {
      taskflowDb: tf,
      inboundDb: ib,
      boardId: 'b1',
      now: new Date('2026-06-01T13:00:00Z'),
      timeZone: TZ,
    });
    expect(out).toEqual([{ id: 's', job: 'standup', fired: true }]); // Active via real-window interaction
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

// V1 parity (mirror of the host gateScheduledRunners holiday skip in
// src/modules/taskflow/runner-gate-apply.ts): scheduled standup/digest/review do NOT fire on a
// registered board holiday. The skip runs BEFORE the activity gate (so it suppresses even an active
// board), keys the holiday on the board's local date, fails OPEN (a check error must never silence a
// board forever), and honors a TASKFLOW_HOLIDAY_EXEMPT folder/folder:kind override that forces the
// post through. A warm container must apply the same skip so it can't beat the host sweep onto a
// holiday post.
function addHoliday(db: Database, boardId: string, date: string, label: string | null = null) {
  db.exec('CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT, holiday_date TEXT, label TEXT)');
  db.prepare('INSERT INTO board_holidays (board_id, holiday_date, label) VALUES (?, ?, ?)').run(boardId, date, label);
}
function makeActive(tf: Database) {
  tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','in_progress')").run();
  tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T11:30:00Z')").run(); // interaction
}

describe('gateRunnerMessages — holiday skip (V1 parity)', () => {
  it('suppresses all three runners on a registered board holiday, even when the board is active', () => {
    const { tf, ib } = dbs();
    makeActive(tf); // would otherwise fire all three
    addHoliday(tf, 'b1', '2026-06-01', 'Corpus Christi'); // MON local date in Fortaleza
    const msgs = [runner('s', 'TF-STANDUP', STANDUP), runner('d', 'TF-DIGEST', DIGEST), runner('r', 'TF-REVIEW', REVIEW)];
    const out = gateRunnerMessages(msgs, opts(tf, ib));
    expect(out).toEqual([
      { id: 's', job: 'standup', fired: false },
      { id: 'd', job: 'digest', fired: false },
      { id: 'r', job: 'review', fired: false },
    ]);
  });

  it('does NOT suppress when today is not a holiday (active board still fires)', () => {
    const { tf, ib } = dbs();
    makeActive(tf);
    addHoliday(tf, 'b1', '2025-12-25', 'Natal'); // a different day
    const out = gateRunnerMessages([runner('s', 'TF-STANDUP', STANDUP)], opts(tf, ib));
    expect(out).toEqual([{ id: 's', job: 'standup', fired: true }]); // active board fires, no holiday reason
  });

  it('fails OPEN when board_holidays is missing/unreadable (active board fires, never silenced)', () => {
    const { tf, ib } = dbs(); // taskflowDb() has no board_holidays table → query throws
    makeActive(tf);
    const out = gateRunnerMessages([runner('s', 'TF-STANDUP', STANDUP)], opts(tf, ib));
    expect(out).toEqual([{ id: 's', job: 'standup', fired: true }]);
  });

  it('TASKFLOW_HOLIDAY_EXEMPT forces the post past the holiday skip (folder + folder:kind)', () => {
    const prev = process.env.TASKFLOW_HOLIDAY_EXEMPT;
    process.env.TASKFLOW_HOLIDAY_EXEMPT = 'board-x:standup';
    try {
      const { tf, ib } = dbs();
      makeActive(tf);
      addHoliday(tf, 'b1', '2026-06-01', 'Feriado');
      const out = gateRunnerMessages([runner('s', 'TF-STANDUP', STANDUP), runner('d', 'TF-DIGEST', DIGEST)], {
        ...opts(tf, ib),
        agentGroupFolder: 'board-x',
      });
      // standup exempt → past the holiday skip → active board fires it; digest not exempt → suppressed
      expect(out.find((o) => o.id === 's')).toEqual({ id: 's', job: 'standup', fired: true });
      expect(out.find((o) => o.id === 'd')).toEqual({ id: 'd', job: 'digest', fired: false });
    } finally {
      if (prev === undefined) delete process.env.TASKFLOW_HOLIDAY_EXEMPT;
      else process.env.TASKFLOW_HOLIDAY_EXEMPT = prev;
    }
  });

  it('isBoardHolidayToday: holiday+label on the day, false off the day, fail-open on a missing table', () => {
    const { tf } = dbs();
    addHoliday(tf, 'b1', '2026-06-01', 'Corpus Christi');
    expect(isBoardHolidayToday(tf, 'b1', MON, TZ)).toMatchObject({
      holiday: true,
      label: 'Corpus Christi',
      date: '2026-06-01',
    });
    expect(isBoardHolidayToday(tf, 'b1', new Date('2026-06-02T12:00:00Z'), TZ)).toMatchObject({ holiday: false });
    const empty = taskflowDb();
    open.push(empty);
    expect(isBoardHolidayToday(empty, 'b1', MON, TZ)).toMatchObject({ holiday: false });
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
