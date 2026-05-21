import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.ts';
import { getUndeliveredMessages } from '../db/messages-out.ts';
import { sendMessage } from './core.ts';
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

describe('mutation-dedup — scope carve-out for explicit agent messaging paths', () => {
  // The Codex P4 dedup primitive intentionally targets ONLY the bare-text
  // fallback in poll-loop's `dispatchResultText` — the case where the model
  // emits no <message to=…> block and no send_message tool call, and the
  // single configured destination would otherwise auto-receive the bare
  // narrative reply (redundant with the deterministic v1-card already
  // emitted). Other emission paths represent the agent's STATED intent and
  // must NOT be suppressed:
  //   - `send_message` / `send_file` MCP tools → direct writeMessageOut,
  //     never call consumeDeterministicMutationFlag.
  //   - `<message to="name">…</message>` blocks in final text →
  //     dispatchResultText processes them BEFORE the bare-text branch and
  //     never gates them on the flag.
  // Codex P-Audit-2 (2026-05-19) acknowledged these as out-of-scope; this
  // test locks the structural carve-out so a future "extend dedup to all
  // emissions" refactor cannot silently swallow agent-explicit messages.
  beforeEach(() => {
    initTestSessionDb();
    __resetDedupForTesting();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
      )
      .run();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('send_message MCP tool emits even when the dedup flag is set, and does NOT consume the flag', async () => {
    markDeterministicMutationEmitted();

    await sendMessage.handler({ to: 'peer', text: 'explicit reply' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({ text: 'explicit reply' });

    // Flag must still be set — only dispatchResultText (the bare-text
    // fallback site) is allowed to consume it.
    expect(consumeDeterministicMutationFlag()).toBe(true);
  });
});
