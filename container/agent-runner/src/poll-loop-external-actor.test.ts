import { describe, expect, it } from 'bun:test';

import {
  batchHasExternalActorRow,
  externalActorCommandRows,
  turnActorSenders,
  turnExternalActors,
} from './poll-loop.ts';
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

  it('Codex B1: a malformed external row that ALSO carries a sender poisons BOTH channels', () => {
    const malformed = extRow('ext-1', { /* externalActor extras */ });
    // inject a board sender into the same external row
    (malformed as { content: string }).content = JSON.stringify({
      text: 'hi',
      sender: 'BossManager',
      actorKind: 'external',
      externalActor: { externalId: 'ext-1', displayName: 'X', sourceDmMgId: 'mg', boardId: 'b' },
    });
    // external channel: rejected (sender present) → no external resolves
    const ext = turnExternalActors([malformed]);
    expect(ext.externals).toHaveLength(0);
    expect(ext.poison).toBe(true);
    // board channel: the external row never yields a board sender → poisoned
    const board = turnActorSenders([malformed]);
    expect(board.senders).toHaveLength(0);
    expect(board.poison).toBe(true);
    expect(board.system).toBe(false); // a chat row, not a pure-system turn
  });

  it('no command rows → empty + not poisoned (unresolved by count)', () => {
    const r = turnExternalActors([contextRow()]);
    expect(r.externals).toHaveLength(0);
    expect(r.poison).toBe(false);
  });
});

describe('batchHasExternalActorRow — the fail-closed gate trigger (Codex B2/B3)', () => {
  it('true for a pure external turn', () => {
    expect(batchHasExternalActorRow([extRow('ext-1')])).toBe(true);
  });
  it('true for a malformed external+sender row (keys on the marker, not resolution)', () => {
    const malformed = { kind: 'chat', trigger: 1, content: JSON.stringify({ text: 'x', sender: 'A', actorKind: 'external' }) } as unknown as MessageInRow;
    expect(batchHasExternalActorRow([malformed])).toBe(true);
  });
  it('false for a board turn, a system turn, and trigger=0 external context', () => {
    expect(batchHasExternalActorRow([boardRow('Ana')])).toBe(false);
    expect(batchHasExternalActorRow([systemRow()])).toBe(false);
    const extCtx = { kind: 'chat', trigger: 0, content: JSON.stringify({ text: 'x', actorKind: 'external' }) } as unknown as MessageInRow;
    expect(batchHasExternalActorRow([extCtx])).toBe(false); // not wake-eligible
  });
});

describe('externalActorCommandRows — the confined-prompt / follow-up-drop row selector (C4c)', () => {
  it('returns ONLY the external wake-eligible rows', () => {
    const ext = extRow('ext-1');
    expect(externalActorCommandRows([ext])).toEqual([ext]);
  });

  it('EXCLUDES a co-batched board CONTEXT row (trigger=0) — no board-private leak into the external prompt', () => {
    const ext = extRow('ext-1');
    const rows = [ext, contextRow()];
    const selected = externalActorCommandRows(rows);
    expect(selected).toEqual([ext]); // the board context row is never in the confined prompt
  });

  it('EXCLUDES a co-batched board COMMAND row (trigger=1) — only the external rows are selected', () => {
    const ext = extRow('ext-1');
    const selected = externalActorCommandRows([ext, boardRow('Ana')]);
    expect(selected).toEqual([ext]);
  });

  it('selects a malformed external+sender row (keys on the marker; the gate fails closed on it separately)', () => {
    const malformed = { kind: 'chat', trigger: 1, content: JSON.stringify({ text: 'x', sender: 'A', actorKind: 'external' }) } as unknown as MessageInRow;
    expect(externalActorCommandRows([malformed])).toEqual([malformed]);
  });

  it('empty for a pure board turn', () => {
    expect(externalActorCommandRows([boardRow('Ana'), systemRow()])).toEqual([]);
  });
});
