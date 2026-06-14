import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { __setOutboundDbUnavailableForTesting, closeSessionDb, initTestSessionDb } from '../db/connection.ts';
import {
  __resetTurnExternalActorForTesting,
  addTurnExternalActorEntries,
  clearTurnExternalActor,
  getTurnExternalActor,
  setTurnExternalActor,
  type ExternalActorContext,
} from './turn-external-actor.ts';

// RC5-ext P3 (C3) — durable per-turn EXTERNAL-actor channel. Mirrors SEC#13's
// turn-actor: state lives in session_state (outbound.db) so the poll-loop main
// process (set/add) and the MCP child (get) see one row. AUTH = externalId only;
// resolution is fail-closed (resolved iff !poison && exactly one externalId).

const maria: ExternalActorContext = {
  externalId: 'ext-1',
  displayName: 'Maria',
  sourceDmMgId: 'mg-cold-1',
  boardId: 'board-1',
};
const bob: ExternalActorContext = {
  externalId: 'ext-2',
  displayName: 'Bob',
  sourceDmMgId: 'mg-cold-2',
  boardId: 'board-2',
};

describe('turn-external-actor — fail-closed resolution', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnExternalActorForTesting();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('a never-written channel is UNRESOLVED', () => {
    expect(getTurnExternalActor()).toEqual({ resolved: false });
  });

  it('exactly ONE external → RESOLVED with full context', () => {
    setTurnExternalActor([maria]);
    expect(getTurnExternalActor()).toEqual({ resolved: true, ...maria });
  });

  it('the SAME externalId repeated stays RESOLVED', () => {
    setTurnExternalActor([maria, { ...maria, displayName: 'Maria (dup)' }]);
    expect(getTurnExternalActor()).toEqual({ resolved: true, ...maria }); // first wins, deduped
  });

  it('TWO distinct externals in one batch → UNRESOLVED (over-auth defeat)', () => {
    setTurnExternalActor([maria, bob]);
    expect(getTurnExternalActor()).toEqual({ resolved: false });
  });

  it('poison → UNRESOLVED even with a single external', () => {
    setTurnExternalActor([maria], true);
    expect(getTurnExternalActor()).toEqual({ resolved: false });
  });

  it('an entry with an empty externalId is dropped (not a resolvable actor)', () => {
    setTurnExternalActor([{ ...maria, externalId: '   ' }]);
    expect(getTurnExternalActor()).toEqual({ resolved: false });
  });

  it('externalId is trimmed', () => {
    setTurnExternalActor([{ ...maria, externalId: '  ext-1  ' }]);
    expect(getTurnExternalActor()).toEqual({ resolved: true, ...maria });
  });
});

describe('turn-external-actor — accumulate across follow-up pushes', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnExternalActorForTesting();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('a second DISTINCT external pushed later makes the turn permanently UNRESOLVED', () => {
    setTurnExternalActor([maria]);
    expect(getTurnExternalActor()).toEqual({ resolved: true, ...maria });
    addTurnExternalActorEntries([bob]);
    expect(getTurnExternalActor()).toEqual({ resolved: false });
  });

  it('the same external pushed again stays RESOLVED', () => {
    setTurnExternalActor([maria]);
    addTurnExternalActorEntries([maria]);
    expect(getTurnExternalActor()).toEqual({ resolved: true, ...maria });
  });

  it('poison is sticky across pushes (OR)', () => {
    setTurnExternalActor([maria]);
    addTurnExternalActorEntries([], true);
    expect(getTurnExternalActor()).toEqual({ resolved: false });
  });
});

describe('turn-external-actor — lifecycle + failure', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnExternalActorForTesting();
  });
  afterEach(() => {
    closeSessionDb();
    __setOutboundDbUnavailableForTesting(false);
  });

  it('clear removes the binding (no stale actor carries into the next turn)', () => {
    setTurnExternalActor([maria]);
    clearTurnExternalActor();
    expect(getTurnExternalActor()).toEqual({ resolved: false });
  });

  it('a read failure fails CLOSED (unresolved), never a stale single external', () => {
    setTurnExternalActor([maria]);
    __setOutboundDbUnavailableForTesting(true);
    expect(getTurnExternalActor()).toEqual({ resolved: false });
  });
});
