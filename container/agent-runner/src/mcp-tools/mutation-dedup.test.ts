import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  __setOutboundDbUnavailableForTesting,
  closeSessionDb,
  getInboundDb,
  initOutboundDb,
  initTestSessionDb,
} from '../db/connection.ts';
import { getUndeliveredMessages } from '../db/messages-out.ts';
import { sendFile, sendMessage } from './core.ts';
import {
  __resetDedupForTesting,
  consumeDeterministicMutationFlag,
  drainDeterministicMutationFlag,
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
    // closeSessionDb() alone would not work — getOutboundDb() lazily
    // re-creates a file-backed DB on any host with a writable /workspace.
    __setOutboundDbUnavailableForTesting();
    expect(() => markDeterministicMutationEmitted()).not.toThrow();
    expect(consumeDeterministicMutationFlag()).toBe(false);
    initTestSessionDb(); // restore for afterEach
  });
});

describe('mutation-dedup — CROSS-PROCESS (real Bun.spawn child)', () => {
  // Codex gate P-Audit-2: the prior in-memory module flag was a prod
  // no-op because the MCP server runs as a SEPARATE `bun` subprocess
  // with its own JS heap — module memory does not propagate. The fix
  // moved state to outbound.db `session_state`. This spawns a genuinely
  // separate process that calls the REAL markDeterministicMutationEmitted();
  // the parent then calls the REAL consumeDeterministicMutationFlag() —
  // proving the SQLite-file primitive works across true process
  // boundaries, where the module boolean failed. (Supersedes the earlier
  // two-Database-objects-in-one-process analog.)
  let tmpDir: string;
  let dbPath: string;
  const CHILD = path.join(import.meta.dir, 'mutation-dedup-mark-child.ts');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-dedup-xproc-'));
    dbPath = path.join(tmpDir, 'outbound.db');
  });
  afterEach(() => {
    closeSessionDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flag marked by a spawned child process is consumed by the parent', async () => {
    const proc = Bun.spawn(['bun', CHILD, dbPath], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);

    // Parent process opens the SAME file the child wrote — separate
    // process, separate connection, separate JS heap.
    initOutboundDb(dbPath);
    expect(consumeDeterministicMutationFlag()).toBe(true);
    // Read-and-clear holds across the process boundary too.
    expect(consumeDeterministicMutationFlag()).toBe(false);
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

  it('send_file MCP tool also bypasses the flag (mirrors send_message)', async () => {
    // Seed a real file under /workspace/agent so sendFile's existsSync gate passes.
    const wsAgent = '/workspace/agent';
    fs.mkdirSync(wsAgent, { recursive: true });
    const filePath = path.join(wsAgent, 'dedup-bypass-fixture.txt');
    fs.writeFileSync(filePath, 'hi');
    markDeterministicMutationEmitted();
    try {
      await sendFile.handler({ to: 'peer', path: filePath, filename: 'fixture.txt' });
    } finally {
      fs.rmSync(filePath, { force: true });
    }
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(consumeDeterministicMutationFlag()).toBe(true);
  });
});

describe('mutation-dedup — turn-boundary drain (Codex P-Audit-3 leak prevention)', () => {
  // If a mutation marks the flag inside an MCP tool and the provider stream
  // then errors / closes without ever emitting a `result` event,
  // dispatchResultText (the ONLY consume site) never runs and the flag
  // leaks into the next turn — silently suppressing that turn's bare-text
  // fallback. Codex P-Audit-3 (2026-05-21) source-verified the two paths
  // that miss the consume: poll-loop.ts:3677-3698 (catch → writes error
  // row) and poll-loop.ts:3704-3706 (no-result branch). `drainDeterministic
  // MutationFlag` is the unconditional turn-end cleanup wired at line 3706.
  beforeEach(() => {
    initTestSessionDb();
    __resetDedupForTesting();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('drain clears a set flag — turn-boundary leak prevention', () => {
    markDeterministicMutationEmitted();
    drainDeterministicMutationFlag();
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('drain on an unmarked flag is a no-op', () => {
    drainDeterministicMutationFlag();
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });
});
