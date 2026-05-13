import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// The detector functions live as closures inside scripts/audit-v1-bugs.ts.
// Mirror the SQL here as a sanity assertion so a future regression in the
// JSON-extract / window math gets caught without a paid replay.
const REASSIGN_ROUND_TRIP_SQL = `
  SELECT a.task_id, a.by, a.at AS a_at, b.at AS b_at
    FROM task_history a JOIN task_history b
      ON a.board_id = b.board_id AND a.task_id = b.task_id
     AND a.by = b.by AND a.id < b.id
     AND (julianday(b.at) - julianday(a.at)) * 1440 BETWEEN 0 AND ?
   WHERE a.board_id = ? AND a.action='reassigned' AND b.action='reassigned'
     AND json_extract(a.details, '$.from_assignee') = json_extract(b.details, '$.to_assignee')
     AND json_extract(a.details, '$.to_assignee')   = json_extract(b.details, '$.from_assignee')
   ORDER BY a.at`;

function seedHistoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL, task_id TEXT NOT NULL,
      action TEXT NOT NULL, "by" TEXT, "at" TEXT NOT NULL, details TEXT
    );
  `);
  return db;
}

describe('audit-v1-bugs: reassign round-trip detector', () => {
  it('flags A→B then B→A within 60 minutes as a round-trip', () => {
    const db = seedHistoryDb();
    db.prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-seci', 'P8', 'reassigned', 'giovanni', '2026-04-07T21:33:16.177Z',
           JSON.stringify({ from_assignee: 'lucas', to_assignee: 'rodrigo-lima' }));
    db.prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-seci', 'P8', 'reassigned', 'giovanni', '2026-04-07T21:36:23.110Z',
           JSON.stringify({ from_assignee: 'rodrigo-lima', to_assignee: 'lucas' }));

    const rows = db.prepare(REASSIGN_ROUND_TRIP_SQL).all(60, 'board-seci') as Array<{ task_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe('P8');
    db.close();
  });

  it('does not flag a sequential A→B then B→C reassign (different second target)', () => {
    // P9 in the seci data: lucas→rodrigo then rodrigo→mauro is iteration,
    // not a round-trip. Must not produce a false-positive bot-error.
    const db = seedHistoryDb();
    db.prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-seci', 'P9', 'reassigned', 'giovanni', '2026-04-07T21:30:00Z',
           JSON.stringify({ from_assignee: 'lucas', to_assignee: 'rodrigo-lima' }));
    db.prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-seci', 'P9', 'reassigned', 'giovanni', '2026-04-07T21:33:00Z',
           JSON.stringify({ from_assignee: 'rodrigo-lima', to_assignee: 'mauro' }));

    const rows = db.prepare(REASSIGN_ROUND_TRIP_SQL).all(60, 'board-seci');
    expect(rows).toEqual([]);
    db.close();
  });

  it('does not flag round-trips when the second reassign is by a different user', () => {
    // Same task, A→B by one user, B→A by another within 60min is a
    // legitimate two-party reassignment workflow, not a bot error.
    const db = seedHistoryDb();
    db.prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-seci', 'P11', 'reassigned', 'giovanni', '2026-04-07T21:30:00Z',
           JSON.stringify({ from_assignee: 'lucas', to_assignee: 'rodrigo-lima' }));
    db.prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-seci', 'P11', 'reassigned', 'mariany', '2026-04-07T21:32:00Z',
           JSON.stringify({ from_assignee: 'rodrigo-lima', to_assignee: 'lucas' }));

    const rows = db.prepare(REASSIGN_ROUND_TRIP_SQL).all(60, 'board-seci');
    expect(rows).toEqual([]);
    db.close();
  });

  it('respects the 60-minute window — pairs further apart are not flagged', () => {
    const db = seedHistoryDb();
    db.prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-seci', 'P12', 'reassigned', 'giovanni', '2026-04-07T10:00:00Z',
           JSON.stringify({ from_assignee: 'lucas', to_assignee: 'rodrigo-lima' }));
    db.prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-seci', 'P12', 'reassigned', 'giovanni', '2026-04-07T11:30:00Z',
           JSON.stringify({ from_assignee: 'rodrigo-lima', to_assignee: 'lucas' }));

    const rows = db.prepare(REASSIGN_ROUND_TRIP_SQL).all(60, 'board-seci');
    expect(rows).toEqual([]);
    db.close();
  });
});
