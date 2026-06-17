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
import './emit-hooks.ts'; // side-effect: registers the same-conv dedup postEmit hook under test
import {
  __resetDedupForTesting,
  clearPendingCreateCard,
  consumeDeterministicMutationFlag,
  drainDeterministicMutationFlag,
  markDeterministicMutationEmitted,
  setPendingCreateCard,
  takePendingCreateCard,
} from './mutation-dedup.ts';
import { setVerbatimIds } from './taskflow-helpers.ts';

// Phase-3 unit-2-core / Codex gate P4 (cross-process). State lives in
// `session_state` in outbound.db so the MCP subprocess (mark) and the
// poll-loop main process (consume) see the same row. The same-process
// tests below verify the contract via SQLite (initTestSessionDb sets up
// in-memory outbound DB); the file-backed test proves cross-instance
// (closest in-test analog to cross-process) correctness.

describe('mutation-dedup — FastAPI subprocess gate', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetDedupForTesting();
  });
  afterEach(() => {
    setVerbatimIds(false);
    closeSessionDb();
  });

  it('does NOT write session_state from the FastAPI subprocess (verbatim ids)', () => {
    // The write-side (mark / setPendingCreateCard / clearPendingCreateCard) targets
    // getOutboundDb() = /workspace/outbound.db. In the tf-mcontrol FastAPI subprocess
    // (verbatim true) that would clobber the service session's outbound state. The
    // in-session agent's MCP child NEVER sets verbatim, so the load-bearing
    // cross-process dedup is unaffected — only the FastAPI subprocess is gated. Reads
    // (take/consume) stay unguarded: they're poll-loop/session-side consumers.
    setVerbatimIds(true);
    setPendingCreateCard('T1', 'card');
    markDeterministicMutationEmitted();
    expect(takePendingCreateCard()).toBeNull();
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });
});

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
  // The P4 dedup primitive suppresses redundant model narration. Scope
  // (refined `7dc44f21`):
  //   - bare-text fallback in `dispatchResultText` → SUPPRESS.
  //   - `<message to="<same-conversation>">` blocks after a card →
  //     SUPPRESS via `shouldSuppressSameConvMessage` (mcp-tools/
  //     message-block-dedup.ts).
  //   - `<message to="<other-conversation>">` blocks → BYPASS (legitimate
  //     cross-board relay).
  //   - `send_message` / `send_file` MCP tools → BYPASS (a distinct
  //     agent intent — explicit tool call, not redundant NL). These call
  //     `writeMessageOut` directly and never consult the flag; this test
  //     locks that bypass.
  // Codex P-Audit-2 (2026-05-19) originally acknowledged the broader
  // `<message>` bypass as out-of-scope; the 7dc44f21 refinement narrows
  // it to same-conversation only without breaking the explicit-tool path
  // tested here.
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

describe('mutation-dedup — send_message / send_file mark on same-conv emit (Codex Turn-25 followup)', () => {
  // Codex review on thiago Turn 25 (2026-05-23) found a residual dedup gap:
  // when the model calls send_message MCP AND ALSO emits the same text as
  // bare-text-final, both go through — the dedup flag bypass on send_message
  // (the `ba24ef23` scope decision) holds when the destination is genuinely
  // a DIFFERENT conversation (cross-board relay) but fails when send_message
  // targets the SAME chat the user wrote in (the bare-text-final is then a
  // redundant narration). Fix: send_message/send_file MARK the dedup flag
  // ONLY when the target destination matches the session_routing (same-conv).
  // Cross-conv send keeps the bypass — bare-text in the source conv is a
  // legitimate separate reply.
  const SAME_JID = '120363423211033081@g.us';
  const OTHER_JID = '120363406395935726@g.us';

  beforeEach(() => {
    initTestSessionDb();
    __resetDedupForTesting();
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'whatsapp', ?, NULL)`,
    ).run(SAME_JID);
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('self', 'Self', 'channel', 'whatsapp', ?, NULL)`,
    ).run(SAME_JID);
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('other', 'Other', 'channel', 'whatsapp', ?, NULL)`,
    ).run(OTHER_JID);
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('send_message to SAME-CONV dest MARKS the dedup flag (suppresses subsequent bare-text)', async () => {
    await sendMessage.handler({ to: 'self', text: 'apology' });
    expect(consumeDeterministicMutationFlag()).toBe(true);
  });

  it('send_message to CROSS-CONV dest does NOT mark the dedup flag (cross-board relay preserves bare-text)', async () => {
    await sendMessage.handler({ to: 'other', text: 'relay to other board' });
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('send_file to SAME-CONV dest MARKS the dedup flag', async () => {
    const wsAgent = '/workspace/agent';
    fs.mkdirSync(wsAgent, { recursive: true });
    const filePath = path.join(wsAgent, 'dedup-mark-fixture.txt');
    fs.writeFileSync(filePath, 'hi');
    try {
      await sendFile.handler({ to: 'self', path: filePath, filename: 'fixture.txt' });
    } finally {
      fs.rmSync(filePath, { force: true });
    }
    expect(consumeDeterministicMutationFlag()).toBe(true);
  });

  it('send_file to CROSS-CONV dest does NOT mark the dedup flag', async () => {
    const wsAgent = '/workspace/agent';
    fs.mkdirSync(wsAgent, { recursive: true });
    const filePath = path.join(wsAgent, 'dedup-nomark-fixture.txt');
    fs.writeFileSync(filePath, 'hi');
    try {
      await sendFile.handler({ to: 'other', path: filePath, filename: 'fixture.txt' });
    } finally {
      fs.rmSync(filePath, { force: true });
    }
    expect(consumeDeterministicMutationFlag()).toBe(false);
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

describe('mutation-dedup — pending create card (emit-deferral, #7 wiring)', () => {
  // A no-reparent create stores its card here instead of emitting now;
  // the poll-loop turn-end flushes it. A following api_admin(reparent_task)
  // clears it (the reparent emits the superseding "adicionada" card) —
  // so create-then-reparent nets ONE card. Cross-process via session_state
  // (MCP subprocess stores, poll-loop main flushes).
  beforeEach(() => {
    initTestSessionDb();
    __resetDedupForTesting();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('set then take returns the card; take is read-and-clear', () => {
    setPendingCreateCard('T1', '✅ *Tarefa criada*\n…');
    expect(takePendingCreateCard()).toBe('✅ *Tarefa criada*\n…');
    expect(takePendingCreateCard()).toBeNull();
  });

  it('take with nothing pending → null', () => {
    expect(takePendingCreateCard()).toBeNull();
  });

  it('a second set overwrites (last create this turn wins)', () => {
    setPendingCreateCard('T1', 'first');
    setPendingCreateCard('T2', 'second');
    expect(takePendingCreateCard()).toBe('second');
  });

  it('clear removes the pending card when the task id matches (reparent-supersede)', () => {
    setPendingCreateCard('T9', '✅ *Tarefa criada*\n…');
    clearPendingCreateCard('T9');
    expect(takePendingCreateCard()).toBeNull();
  });

  it('clear with a NON-matching task id leaves the card — a reparent of an unrelated task must not drop a sibling create', () => {
    setPendingCreateCard('T9', '✅ *Tarefa criada*\n…');
    clearPendingCreateCard('T-other');
    expect(takePendingCreateCard()).toBe('✅ *Tarefa criada*\n…');
  });

  it('set also marks the dedup flag — the model bare-text reply is suppressed', () => {
    setPendingCreateCard('T1', '✅ *Tarefa criada*\n…');
    expect(consumeDeterministicMutationFlag()).toBe(true);
  });

  it('best-effort: set/take/clear do NOT throw when the outbound DB is unavailable', () => {
    __setOutboundDbUnavailableForTesting();
    expect(() => setPendingCreateCard('T1', 'x')).not.toThrow();
    expect(takePendingCreateCard()).toBeNull();
    expect(() => clearPendingCreateCard('T1')).not.toThrow();
    initTestSessionDb();
  });
});
