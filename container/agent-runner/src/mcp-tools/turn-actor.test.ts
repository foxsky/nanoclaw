import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  __setOutboundDbUnavailableForTesting,
  closeSessionDb,
  initOutboundDb,
  initTestSessionDb,
} from '../db/connection.ts';
import {
  __resetTurnActorForTesting,
  addTurnActorSenders,
  clearTurnActor,
  getTurnActor,
  mayRunChatBundledMutation,
  setTurnActor,
} from './turn-actor.ts';

// #419 (SEC#13) — durable per-turn authenticated-actor channel. State lives in
// `session_state` in outbound.db so the poll-loop main process (setTurnActor)
// and the MCP child (getTurnActor inside the guard/normalizeAgentIds) see the
// same row. The cross-process describe spawns a genuinely separate `bun` process
// to prove the SQLite-file channel crosses true OS process boundaries.

describe('turn-actor — fail-closed resolution rule', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('a never-written channel is UNRESOLVED — a turn with no actor must DENY', () => {
    expect(getTurnActor()).toEqual({ resolved: false });
  });

  it('exactly ONE distinct non-empty sender → RESOLVED', () => {
    setTurnActor(['Ana']);
    expect(getTurnActor()).toEqual({ resolved: true, sender: 'Ana' });
  });

  it('the SAME sender repeated stays RESOLVED', () => {
    setTurnActor(['Ana', 'Ana', ' Ana ']);
    expect(getTurnActor()).toEqual({ resolved: true, sender: 'Ana' });
  });

  it('TWO distinct senders in one batch → UNRESOLVED (mixed-batch over-auth defeat)', () => {
    setTurnActor(['Ana', 'Mallory']);
    expect(getTurnActor()).toEqual({ resolved: false });
  });

  it('ZERO senders → UNRESOLVED', () => {
    setTurnActor([]);
    expect(getTurnActor()).toEqual({ resolved: false });
  });

  it('POISON forces UNRESOLVED even with exactly one sender (non-chat row co-batched)', () => {
    // A scheduled/system trigger row co-batched with one manager chat must not
    // let non-chat content ride that chat actor (Codex #419).
    setTurnActor(['Ana'], true);
    expect(getTurnActor()).toEqual({ resolved: false });
  });

  it('empty / whitespace-only senders are dropped before the distinct-one test', () => {
    setTurnActor(['', '   ', 'Ana']);
    expect(getTurnActor()).toEqual({ resolved: true, sender: 'Ana' });
    setTurnActor(['', '   ']);
    expect(getTurnActor()).toEqual({ resolved: false });
  });

  it('addTurnActorSenders ACCUMULATES across follow-up pushes (cross-push defeat)', () => {
    setTurnActor(['Ana']);
    expect(getTurnActor()).toEqual({ resolved: true, sender: 'Ana' });
    // a follow-up from the SAME sender stays resolved
    addTurnActorSenders(['Ana']);
    expect(getTurnActor()).toEqual({ resolved: true, sender: 'Ana' });
    // a follow-up from a DIFFERENT sender makes the turn unresolved — and STAYS
    // unresolved (it is the union, not last-writer): A's in-flight tool can no
    // longer ride B.
    addTurnActorSenders(['Carlos']);
    expect(getTurnActor()).toEqual({ resolved: false });
  });

  it('addTurnActorSenders carries the poison flag forward (sticky)', () => {
    setTurnActor(['Ana']);
    addTurnActorSenders([], true); // a poisoned follow-up
    expect(getTurnActor()).toEqual({ resolved: false });
  });

  it('clearTurnActor resets to UNRESOLVED at the turn boundary', () => {
    setTurnActor(['Ana']);
    clearTurnActor();
    expect(getTurnActor()).toEqual({ resolved: false });
  });

  it('setTurnActor is fresh per initial batch (a new turn overwrites the prior one)', () => {
    setTurnActor(['Ana', 'Mallory']); // unresolved
    setTurnActor(['Carlos']); // new turn, fresh
    expect(getTurnActor()).toEqual({ resolved: true, sender: 'Carlos' });
  });

  it('best-effort: set/get/clear do NOT throw when the outbound DB is unavailable, and get FAILS CLOSED', () => {
    __setOutboundDbUnavailableForTesting();
    expect(() => setTurnActor(['Ana'])).not.toThrow();
    expect(getTurnActor()).toEqual({ resolved: false });
    expect(() => addTurnActorSenders(['Bob'])).not.toThrow();
    expect(() => clearTurnActor()).not.toThrow();
    initTestSessionDb(); // restore for afterEach
  });
});

describe('turn-actor — mayRunChatBundledMutation (api_report standup housekeeping gate)', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('ALLOWS when the actor resolves (a real manager standup)', () => {
    setTurnActor(['Ana']);
    expect(mayRunChatBundledMutation()).toBe(true);
  });

  it('ALLOWS on a pure SYSTEM/scheduled turn (the model-driven scheduled standup)', () => {
    // poll-loop derives this for a kind="task" standup runner: no chat senders, poison, system.
    setTurnActor([], true, true);
    expect(getTurnActor()).toEqual({ resolved: false }); // still not a privileged actor
    expect(mayRunChatBundledMutation()).toBe(true); // but housekeeping may run
  });

  it('DENIES an ambiguous multi-sender chat turn', () => {
    setTurnActor(['Ana', 'Mallory']);
    expect(mayRunChatBundledMutation()).toBe(false);
  });

  it('DENIES a poisoned-but-not-system chat turn (one chat sender + a co-batched non-chat row)', () => {
    setTurnActor(['Ana'], true, false);
    expect(mayRunChatBundledMutation()).toBe(false);
  });

  it('DENIES when the channel was never written', () => {
    expect(mayRunChatBundledMutation()).toBe(false);
  });

  it('a follow-up chat push drops the system flag (scheduled turn that then gets a chat row)', () => {
    setTurnActor([], true, true); // scheduled system turn
    expect(mayRunChatBundledMutation()).toBe(true);
    addTurnActorSenders(['Ana'], false, false); // a chat row arrives
    expect(mayRunChatBundledMutation()).toBe(false); // no longer a pure system turn
  });

  it('FAILS CLOSED (denies housekeeping) when the outbound DB is unavailable', () => {
    setTurnActor([], true, true);
    __setOutboundDbUnavailableForTesting();
    expect(mayRunChatBundledMutation()).toBe(false); // read error must NOT look like a system turn
    initTestSessionDb();
  });
});

describe('turn-actor — CROSS-PROCESS (real Bun.spawn child)', () => {
  let tmpDir: string;
  let dbPath: string;
  const CHILD = path.join(import.meta.dir, 'turn-actor-set-child.ts');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-actor-xproc-'));
    dbPath = path.join(tmpDir, 'outbound.db');
  });
  afterEach(() => {
    closeSessionDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('actor set by a spawned child process is read by the parent', async () => {
    const proc = Bun.spawn(['bun', CHILD, dbPath, 'Ana'], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);

    initOutboundDb(dbPath);
    expect(getTurnActor()).toEqual({ resolved: true, sender: 'Ana' });
  });

  it('a mixed-sender batch written by the child reads UNRESOLVED in the parent', async () => {
    const proc = Bun.spawn(['bun', CHILD, dbPath, 'Ana', 'Mallory'], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    initOutboundDb(dbPath);
    expect(getTurnActor()).toEqual({ resolved: false });
  });
});
