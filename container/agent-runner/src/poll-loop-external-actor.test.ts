import { describe, expect, it } from 'bun:test';

import { turnExternalActors } from './poll-loop.ts';
import type { MessageInRow } from './db/messages-in.ts';

// RC5-ext P3 — the poll-loop derivation of the per-turn EXTERNAL actor.
// Enforces board-person XOR external per turn: a pure external turn resolves;
// any co-batched board/system row poisons; two distinct externals → unresolved.

function extRow(externalId: string, extra: Record<string, unknown> = {}): MessageInRow {
  return {
    kind: 'chat',
    trigger: 1,
    content: JSON.stringify({
      text: 'hi',
      actorKind: 'external',
      externalActor: { externalId, displayName: 'X', sourceDmMgId: 'mg-x', boardId: 'board-x', ...extra },
    }),
  } as unknown as MessageInRow;
}
function boardRow(sender: string): MessageInRow {
  return { kind: 'chat', trigger: 1, content: JSON.stringify({ text: 'hi', sender }) } as unknown as MessageInRow;
}
function systemRow(): MessageInRow {
  return { kind: 'system', trigger: 1, content: JSON.stringify({ action: 'x' }) } as unknown as MessageInRow;
}
function contextRow(): MessageInRow {
  // trigger=0 → not a command row → ignored by selectCommandRows
  return { kind: 'chat', trigger: 0, content: JSON.stringify({ text: 'ctx', sender: 'Z' }) } as unknown as MessageInRow;
}

describe('turnExternalActors — pure external turn resolves', () => {
  it('a single external row → one external, not poisoned', () => {
    const r = turnExternalActors([extRow('ext-1')]);
    expect(r.poison).toBe(false);
    expect(r.externals).toEqual([
      { externalId: 'ext-1', displayName: 'X', sourceDmMgId: 'mg-x', boardId: 'board-x' },
    ]);
  });

  it('accumulated (trigger=0) context rows are ignored', () => {
    const r = turnExternalActors([extRow('ext-1'), contextRow()]);
    expect(r.poison).toBe(false);
    expect(r.externals).toHaveLength(1);
  });
});

describe('turnExternalActors — board-person XOR external (poison)', () => {
  it('a board-person chat row co-batched with an external → POISON', () => {
    const r = turnExternalActors([extRow('ext-1'), boardRow('Ana')]);
    expect(r.poison).toBe(true); // the external turn is impure
  });

  it('a system/scheduled row co-batched with an external → POISON', () => {
    const r = turnExternalActors([extRow('ext-1'), systemRow()]);
    expect(r.poison).toBe(true);
  });

  it('a pure board turn → no externals, POISON (external channel must not resolve)', () => {
    const r = turnExternalActors([boardRow('Ana')]);
    expect(r.externals).toHaveLength(0);
    expect(r.poison).toBe(true);
  });
});

describe('turnExternalActors — over-auth defeat + malformed', () => {
  it('two DISTINCT externals are both kept (→ getTurnExternalActor sees >1 → unresolved)', () => {
    const r = turnExternalActors([extRow('ext-1'), extRow('ext-2')]);
    expect(r.poison).toBe(false);
    expect(r.externals.map((e) => e.externalId)).toEqual(['ext-1', 'ext-2']);
  });

  it('an actorKind:external row with an empty externalId is NOT an external → POISON', () => {
    const r = turnExternalActors([extRow('   ')]);
    expect(r.externals).toHaveLength(0);
    expect(r.poison).toBe(true);
  });

  it('no command rows → empty + not poisoned (unresolved by count)', () => {
    const r = turnExternalActors([contextRow()]);
    expect(r.externals).toHaveLength(0);
    expect(r.poison).toBe(false);
  });
});
