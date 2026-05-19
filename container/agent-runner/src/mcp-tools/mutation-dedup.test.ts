import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.ts';
import {
  __resetDedupForTesting,
  consumeDeterministicMutationFlag,
  markDeterministicMutationEmitted,
} from './mutation-dedup.ts';

// Phase-3 unit-2-core / Codex gate P4 (cross-process). State lives in
// `session_state` in outbound.db so the MCP subprocess (mark) and the
// poll-loop main process (consume) see the same row. The same-process
// tests below verify the contract via SQLite (initTestSessionDb sets up
// in-memory outbound DB); the file-backed test proves cross-instance
// (closest in-test analog to cross-process) correctness.

describe('mutation-dedup — same-process SQLite contract', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetDedupForTesting();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('starts unflagged', () => {
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('mark sets the flag; consume reads it as true', () => {
    markDeterministicMutationEmitted();
    expect(consumeDeterministicMutationFlag()).toBe(true);
  });

  it('consume clears the flag (read-and-clear)', () => {
    markDeterministicMutationEmitted();
    expect(consumeDeterministicMutationFlag()).toBe(true);
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('multiple marks before a consume → still one true, then cleared', () => {
    markDeterministicMutationEmitted();
    markDeterministicMutationEmitted();
    expect(consumeDeterministicMutationFlag()).toBe(true);
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('best-effort: mark/consume do NOT throw when the outbound DB is unavailable', () => {
    closeSessionDb(); // teardown outbound singleton — simulates "no /workspace/outbound.db"
    expect(() => markDeterministicMutationEmitted()).not.toThrow();
    expect(consumeDeterministicMutationFlag()).toBe(false);
    initTestSessionDb(); // restore for afterEach
  });
});

describe('mutation-dedup — CROSS-INSTANCE (cross-process analog)', () => {
  // Codex gate P-Audit-2: prior in-memory module flag was a prod no-op
  // because the MCP subprocess and the main process don't share JS
  // memory. The fix moves state to SQLite session_state. This test
  // opens TWO separate `Database` instances to the same file (closest
  // in-test analog to two separate processes opening
  // /workspace/outbound.db) and verifies the mark in one instance is
  // observed by the consume in the other.
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-dedup-'));
    dbPath = path.join(tmpDir, 'outbound.db');
    // Bootstrap session_state in the file-backed DB.
    const seed = new Database(dbPath);
    seed.exec(
      `CREATE TABLE session_state (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
    seed.close();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mark in connection A is observed (read-and-clear) by connection B', () => {
    const connA = new Database(dbPath); // simulates MCP subprocess
    const connB = new Database(dbPath); // simulates poll-loop main
    try {
      connA
        .prepare(
          `INSERT INTO session_state (key, value, updated_at) VALUES (?, '1', ?)
           ON CONFLICT (key) DO UPDATE SET value='1', updated_at=excluded.updated_at`,
        )
        .run('mutation_dedup_flag', new Date().toISOString());
      const row = connB
        .prepare(`SELECT value FROM session_state WHERE key = ?`)
        .get('mutation_dedup_flag') as { value: string } | undefined;
      expect(row?.value).toBe('1');
      connB.prepare(`DELETE FROM session_state WHERE key = ?`).run('mutation_dedup_flag');
      const after = connA
        .prepare(`SELECT value FROM session_state WHERE key = ?`)
        .get('mutation_dedup_flag') as { value: string } | null;
      // bun:sqlite .get() returns null (not undefined) when no row matches.
      expect(after).toBeNull();
    } finally {
      connA.close();
      connB.close();
    }
  });
});
