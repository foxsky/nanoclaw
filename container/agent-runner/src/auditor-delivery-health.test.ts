// Execution test for the auditor-script.sh `delivery_health` block.
//
// The string-match tests in auditor-dm-detection.test.ts can verify ordering
// and that certain literals appear in the script, but they cannot catch
// SQL-shape regressions. This file extracts the actual SQL from the script
// and runs it against an in-memory better-sqlite3 fixture, then re-applies
// the post-processing JS to assert the resulting `broken_groups` shape.
//
// Past regressions this is meant to guard against:
//   1. Block placed after `msgDb.close()` (2026-04-27 first run crashed)
//   2. SQL missing `WHERE g.taskflow_managed = 1` (would flag the main
//      NanoClaw group + eurotrip as never_sent false positives)

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT_PATH = path.join(import.meta.dirname, 'auditor-script.sh');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf-8');

// Extract the delivery_health SELECT statement from the script. The regex
// matches the prepare() call that joins registered_groups for delivery
// health; pinning to the comment marker keeps it from matching anything
// else.
function extractDeliveryHealthSql(): string {
  const idx = SCRIPT.indexOf('// --- Delivery health');
  if (idx < 0) {
    throw new Error('delivery_health block marker not found in script');
  }
  const tail = SCRIPT.slice(idx);
  const match = tail.match(/msgDb\s*\.prepare\(\s*`([\s\S]*?)`\s*,?\s*\)/);
  if (!match) {
    throw new Error('delivery_health prepare() call not found in script');
  }
  return match[1];
}

interface FlaggedRow {
  folder: string;
  jid: string;
  last_bot_send: string | null;
  human_recent_n: number;
  last_human: string | null;
}

interface BrokenEntry {
  folder: string;
  jid: string;
  kind: 'never_sent' | 'silent_with_recent_human_activity';
  last_bot_send?: string;
  last_human?: string;
  human_recent_n: number;
}

// Re-implements the post-processing loop from auditor-script.sh so the
// test can assert on the final shape, not just the raw SQL output. If you
// edit this, mirror the change in the script.
function postProcess(rows: FlaggedRow[], cutoff: string): BrokenEntry[] {
  const broken: BrokenEntry[] = [];
  for (const row of rows) {
    if (row.last_bot_send === null && row.last_human !== null) {
      broken.push({
        folder: row.folder,
        jid: row.jid,
        kind: 'never_sent',
        last_human: row.last_human,
        human_recent_n: row.human_recent_n,
      });
    } else if (
      row.last_bot_send !== null &&
      row.last_bot_send < cutoff &&
      row.human_recent_n > 0
    ) {
      broken.push({
        folder: row.folder,
        jid: row.jid,
        kind: 'silent_with_recent_human_activity',
        last_bot_send: row.last_bot_send,
        human_recent_n: row.human_recent_n,
      });
    }
  }
  return broken;
}

function setupFixtureDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      folder TEXT NOT NULL UNIQUE,
      name TEXT,
      taskflow_managed INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      timestamp TEXT,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  return db;
}

describe('auditor delivery_health (execution)', () => {
  // Cutoff = 7 days back from a fixed reference timestamp so the test is
  // deterministic regardless of when it runs.
  const NOW = new Date('2026-04-27T04:00:00.000Z');
  const RECENT_DAYS = 7;
  const cutoff = new Date(
    NOW.getTime() - RECENT_DAYS * 86400 * 1000,
  ).toISOString();
  const SQL = extractDeliveryHealthSql();

  it('extracts a SELECT that filters on taskflow_managed = 1', () => {
    expect(SQL).toMatch(/SELECT\s+g\.folder/);
    expect(SQL).toMatch(/FROM\s+registered_groups\s+g/);
    expect(SQL).toMatch(/WHERE\s+g\.taskflow_managed\s*=\s*1/);
  });

  it('flags taskflow group with no bot activity but recent human messages as never_sent', () => {
    const db = setupFixtureDb();
    db.exec(`
      INSERT INTO registered_groups VALUES ('A@g.us', 'group-a', 'Group A', 1);
      INSERT INTO messages VALUES ('m1', 'A@g.us', 0, 0, '2026-04-25T10:00:00.000Z');
      INSERT INTO messages VALUES ('m2', 'A@g.us', 0, 0, '2026-04-26T11:00:00.000Z');
    `);
    const rows = db.prepare(SQL).all(cutoff) as FlaggedRow[];
    const broken = postProcess(rows, cutoff);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      folder: 'group-a',
      jid: 'A@g.us',
      kind: 'never_sent',
      human_recent_n: 2,
    });
  });

  it('flags taskflow group with old bot send + recent human activity as silent_with_recent_human_activity', () => {
    const db = setupFixtureDb();
    db.exec(`
      INSERT INTO registered_groups VALUES ('B@g.us', 'group-b', 'Group B', 1);
      INSERT INTO messages VALUES ('m1', 'B@g.us', 1, 1, '2026-04-01T10:00:00.000Z');
      INSERT INTO messages VALUES ('m2', 'B@g.us', 0, 0, '2026-04-26T11:00:00.000Z');
    `);
    const rows = db.prepare(SQL).all(cutoff) as FlaggedRow[];
    const broken = postProcess(rows, cutoff);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      folder: 'group-b',
      jid: 'B@g.us',
      kind: 'silent_with_recent_human_activity',
      human_recent_n: 1,
    });
    expect(broken[0].last_bot_send).toBe('2026-04-01T10:00:00.000Z');
  });

  it('does NOT flag healthy taskflow group (recent bot send + recent human)', () => {
    const db = setupFixtureDb();
    db.exec(`
      INSERT INTO registered_groups VALUES ('C@g.us', 'group-c', 'Group C', 1);
      INSERT INTO messages VALUES ('m1', 'C@g.us', 1, 1, '2026-04-26T08:00:00.000Z');
      INSERT INTO messages VALUES ('m2', 'C@g.us', 0, 0, '2026-04-26T09:00:00.000Z');
    `);
    const rows = db.prepare(SQL).all(cutoff) as FlaggedRow[];
    const broken = postProcess(rows, cutoff);
    expect(broken).toHaveLength(0);
  });

  it('EXCLUDES non-taskflow groups even when bot has never sent and humans posted recently', () => {
    // This is the regression test for the missing
    // `WHERE g.taskflow_managed = 1` filter. Without it, the main NanoClaw
    // group (`120363408855255405`) and `eurotrip` would surface as
    // never_sent false positives.
    const db = setupFixtureDb();
    db.exec(`
      INSERT INTO registered_groups VALUES ('main@g.us', 'main-group', 'Main', 0);
      INSERT INTO registered_groups VALUES ('euro@g.us', 'eurotrip', 'Eurotrip', 0);
      INSERT INTO messages VALUES ('m1', 'main@g.us', 0, 0, '2026-04-26T10:00:00.000Z');
      INSERT INTO messages VALUES ('m2', 'euro@g.us', 0, 0, '2026-04-26T11:00:00.000Z');
    `);
    const rows = db.prepare(SQL).all(cutoff) as FlaggedRow[];
    const broken = postProcess(rows, cutoff);
    expect(broken).toHaveLength(0);
  });

  it('does NOT flag taskflow group with no human activity at all (nothing to compare against)', () => {
    const db = setupFixtureDb();
    db.exec(`
      INSERT INTO registered_groups VALUES ('D@g.us', 'group-d', 'Group D', 1);
    `);
    const rows = db.prepare(SQL).all(cutoff) as FlaggedRow[];
    const broken = postProcess(rows, cutoff);
    expect(broken).toHaveLength(0);
  });

  it('handles the mixed case (multiple groups, only the broken ones surface)', () => {
    const db = setupFixtureDb();
    db.exec(`
      INSERT INTO registered_groups VALUES ('A@g.us', 'a', 'A', 1);
      INSERT INTO registered_groups VALUES ('B@g.us', 'b', 'B', 1);
      INSERT INTO registered_groups VALUES ('C@g.us', 'c', 'C', 1);
      INSERT INTO registered_groups VALUES ('main@g.us', 'main', 'M', 0);

      -- A: never_sent (2 recent humans, no bot)
      INSERT INTO messages VALUES ('m1', 'A@g.us', 0, 0, '2026-04-26T10:00:00.000Z');
      INSERT INTO messages VALUES ('m2', 'A@g.us', 0, 0, '2026-04-26T11:00:00.000Z');

      -- B: silent_with_recent_human_activity (old bot, 1 recent human)
      INSERT INTO messages VALUES ('m3', 'B@g.us', 1, 1, '2026-03-15T10:00:00.000Z');
      INSERT INTO messages VALUES ('m4', 'B@g.us', 0, 0, '2026-04-26T12:00:00.000Z');

      -- C: healthy (recent bot + recent human)
      INSERT INTO messages VALUES ('m5', 'C@g.us', 1, 1, '2026-04-26T08:00:00.000Z');
      INSERT INTO messages VALUES ('m6', 'C@g.us', 0, 0, '2026-04-26T09:00:00.000Z');

      -- main: would-be never_sent but excluded by filter
      INSERT INTO messages VALUES ('m7', 'main@g.us', 0, 0, '2026-04-26T13:00:00.000Z');
    `);
    const rows = db.prepare(SQL).all(cutoff) as FlaggedRow[];
    const broken = postProcess(rows, cutoff);

    const folders = broken.map((b) => b.folder).sort();
    expect(folders).toEqual(['a', 'b']);

    const a = broken.find((b) => b.folder === 'a')!;
    expect(a.kind).toBe('never_sent');

    const bEntry = broken.find((b) => b.folder === 'b')!;
    expect(bEntry.kind).toBe('silent_with_recent_human_activity');
  });
});
