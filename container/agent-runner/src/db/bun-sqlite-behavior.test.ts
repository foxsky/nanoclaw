import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';

// L0 guardrail for GOTCHAS → "bun:sqlite `.get()` returns null, not undefined".
//
// This PINS the runtime fact the footgun rests on: under `bun:sqlite` a `.get()`
// with no matching row returns `null`, whereas `better-sqlite3` (the host) returns
// `undefined`. If Bun ever changes this — or someone swaps the driver — this test
// fails loudly, which is the reminder.
//
// It deliberately pins the BEHAVIOR, not usage: a `.get() === undefined`
// source-lint is too noisy to be a guardrail (JS `Map.get`/`Array` legitimately
// return `undefined`, so it cries wolf and gets ignored). The actionable rule is
// the GOTCHAS entry: in container code, treat a missing row as `null` (`if (!row)`
// / `== null`), never `=== undefined`.
describe('bun:sqlite behavior contract', () => {
  it('.get() on a no-row query returns null (NOT undefined)', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const missing = db.prepare('SELECT * FROM t WHERE id = ?').get(999);
    expect(missing).toBeNull();
    expect(missing).not.toBeUndefined();
    db.close();
  });

  it('.get() on a matching row returns the row', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.run("INSERT INTO t (id, v) VALUES (1, 'x')");
    const row = db.prepare('SELECT v FROM t WHERE id = ?').get(1) as { v: string } | null;
    expect(row?.v).toBe('x');
    db.close();
  });
});
