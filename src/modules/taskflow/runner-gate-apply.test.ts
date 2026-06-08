import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { gateScheduledRunners, isBoardHolidayToday } from './runner-gate-apply.js';

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
function addRunner(
  db: Database.Database,
  id: string,
  tag: string,
  cron: string,
  processAfter = '2000-01-01T00:00:00Z', // past = due; sentinel keeps the window wide for non-A4 tests
) {
  db.prepare(
    `INSERT INTO messages_in (id, kind, content, recurrence, status, trigger, process_after)
     VALUES (?, 'task', ?, ?, 'pending', 1, ?)`,
  ).run(id, envelope(`[${tag}] do the thing`), cron, processAfter);
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

  it('A4: a late sweep anchors the window on the firing occurrence (process_after), so missed-window activity still fires', () => {
    const { ib, tf } = dbs();
    // The Monday standup (08:00 local = 11:00Z) was missed — the sweep is down until Wed noon.
    // A member chatted Monday 11:30Z: inside the Monday standup's window, but BEFORE the window a
    // now-anchored gate would use (which starts Tue 11:00Z). No pending task, so the ONLY thing that
    // can keep the standup alive is that interaction being counted. With process_after threaded, it is.
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T11:30:00Z')").run();
    addRunner(ib, 's', 'TF-STANDUP', STANDUP, '2026-06-01T11:00:00Z');
    gateScheduledRunners(ib, tf, { boardId: 'b1', now: new Date('2026-06-03T12:00:00Z'), timeZone: TZ });
    expect(status(ib, 's')).toBe('pending'); // Active via the missed-window interaction → fires
  });

  it('A4 retry path: a backoff-rewritten process_after still anchors on the real occurrence, so the runner fires', () => {
    const { ib, tf } = dbs();
    // The Monday standup (08:00 local = 11:00Z) fired, a container claimed it and crashed;
    // resetStuckProcessingRows rewrote process_after to now+backoff = 11:05Z, a NON-occurrence. A
    // member changed a task at Mon 06:00 local (09:00Z) — BEFORE the standup but inside its real
    // window (Fri 11:00Z, Mon 11:00Z]. No pending task, so only that interaction can keep the standup
    // alive. Snapping the backoff anchor to the Monday occurrence keeps it; anchoring naively on
    // 11:05Z collapses the window to (Mon 11:00Z, now] and would wrongly suppress the retry.
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T09:00:00Z')").run(); // Mon 06:00 local
    addRunner(ib, 's', 'TF-STANDUP', STANDUP, '2026-06-01T11:05:00Z'); // retry-backoff instant
    gateScheduledRunners(ib, tf, { boardId: 'b1', now: new Date('2026-06-01T13:00:00Z'), timeZone: TZ });
    expect(status(ib, 's')).toBe('pending'); // Active via the real-window interaction → fires
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

// V1 parity (taskflow-automation-gate-runtime.isBoardHolidayToday + task-scheduler holiday skip):
// scheduled standup/digest/review do NOT fire on a registered board holiday. The skip runs BEFORE
// the activity gate (so it suppresses even an active board), keys the holiday on the board's local
// date, fails OPEN (a check error must never silence a board forever), and honors a
// TASKFLOW_HOLIDAY_EXEMPT board/board:kind override that forces the post through.
describe('gateScheduledRunners — holiday skip (V1 parity)', () => {
  function addHoliday(db: Database.Database, boardId: string, date: string, label: string | null = null) {
    db.exec('CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT, holiday_date TEXT, label TEXT)');
    db.prepare('INSERT INTO board_holidays (board_id, holiday_date, label) VALUES (?, ?, ?)').run(boardId, date, label);
  }
  function makeActive(tf: Database.Database) {
    tf.prepare("INSERT INTO tasks (id, board_id, column) VALUES ('T1','b1','in_progress')").run();
    tf.prepare("INSERT INTO task_history (board_id, at) VALUES ('b1','2026-06-01T11:30:00Z')").run(); // interaction
  }

  it('suppresses all three runners on a registered board holiday, even when the board is active', () => {
    const { ib, tf } = dbs();
    makeActive(tf); // would otherwise fire all three
    addHoliday(tf, 'b1', '2026-06-01', 'Corpus Christi'); // MON local date in Fortaleza
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    addRunner(ib, 'd', 'TF-DIGEST', DIGEST);
    addRunner(ib, 'r', 'TF-REVIEW', REVIEW);
    const out = gateScheduledRunners(ib, tf, opts);
    expect([status(ib, 's'), status(ib, 'd'), status(ib, 'r')]).toEqual(['completed', 'completed', 'completed']);
    expect(out.every((o) => !o.fired && o.reason === 'holiday')).toBe(true);
  });

  it('does NOT suppress when today is not a holiday (active board still fires)', () => {
    const { ib, tf } = dbs();
    makeActive(tf);
    addHoliday(tf, 'b1', '2025-12-25', 'Natal'); // a different day
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    gateScheduledRunners(ib, tf, opts);
    expect(status(ib, 's')).toBe('pending'); // fires
  });

  it('fails OPEN when board_holidays is missing/unreadable (active board fires, never silenced)', () => {
    const { ib, tf } = dbs(); // taskflowDb() has no board_holidays table → query throws
    makeActive(tf);
    addRunner(ib, 's', 'TF-STANDUP', STANDUP);
    gateScheduledRunners(ib, tf, opts);
    expect(status(ib, 's')).toBe('pending');
  });

  it('TASKFLOW_HOLIDAY_EXEMPT forces the post past the holiday skip (folder + folder:kind)', () => {
    const prev = process.env.TASKFLOW_HOLIDAY_EXEMPT;
    process.env.TASKFLOW_HOLIDAY_EXEMPT = 'board-x:standup';
    try {
      const { ib, tf } = dbs();
      makeActive(tf);
      addHoliday(tf, 'b1', '2026-06-01', 'Feriado');
      addRunner(ib, 's', 'TF-STANDUP', STANDUP);
      addRunner(ib, 'd', 'TF-DIGEST', DIGEST);
      gateScheduledRunners(ib, tf, { ...opts, agentGroupFolder: 'board-x' });
      // standup exempt → past the holiday skip → active board fires it; digest not exempt → suppressed
      expect(status(ib, 's')).toBe('pending');
      expect(status(ib, 'd')).toBe('completed');
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
