import { describe, expect, it } from 'bun:test';

import { deferrableSystemRowIds, followupCrossesActorDomain, turnActorSenders } from './poll-loop.ts';
import type { MessageInRow } from './db/messages-in.ts';

// Actor-domain isolation — a scheduled/system task co-batched with an
// authenticated chat must NOT poison the chat turn's actor (V1→V2 regression:
// #419 over-broadened the per-turn poison to a transient co-batch, so the chat's
// own legitimate mutation got denied). deferrableSystemRowIds returns the
// task-row ids to push to a later poll iteration so the chat turn binds a clean
// single-sender actor while the task runs alone as a pure-system turn (no chat
// actor to borrow — the #419 security property is preserved by the SEPARATION,
// not by poisoning the chat).

function chatRow(id: string, sender: string): MessageInRow {
  return { id, kind: 'chat', trigger: 1, content: JSON.stringify({ text: 'hi', sender }) } as unknown as MessageInRow;
}
function taskRow(id: string, prompt = '[TF-STANDUP]'): MessageInRow {
  return { id, kind: 'task', trigger: 1, content: JSON.stringify({ prompt, script: null }) } as unknown as MessageInRow;
}
function senderlessChat(id: string): MessageInRow {
  return { id, kind: 'chat', trigger: 1, content: JSON.stringify({ text: 'hi' }) } as unknown as MessageInRow;
}
function contextRow(id: string, sender = 'Z'): MessageInRow {
  // trigger=0 → not a command row → never deferred (rides with the chat turn)
  return { id, kind: 'chat', trigger: 0, content: JSON.stringify({ text: 'ctx', sender }) } as unknown as MessageInRow;
}

describe('deferrableSystemRowIds — splits a mixed chat+task batch', () => {
  it('THE regression: an authenticated chat co-batched with a scheduled task defers the task', () => {
    expect(deferrableSystemRowIds([chatRow('c1', 'Thiago'), taskRow('t1')])).toEqual(['t1']);
  });

  it('defers ALL co-batched task rows', () => {
    expect(deferrableSystemRowIds([chatRow('c1', 'Ana'), taskRow('t1', '[TF-STANDUP]'), taskRow('t2', '[TF-DIGEST]')])).toEqual(['t1', 't2']);
  });

  it('two distinct senders + a task → still defers the task (ambiguity is handled separately by turnActorSenders)', () => {
    expect(deferrableSystemRowIds([chatRow('c1', 'Ana'), chatRow('c2', 'Bob'), taskRow('t1')])).toEqual(['t1']);
  });

  it('trigger=0 context rows are never deferred (ride along with the chat turn)', () => {
    expect(deferrableSystemRowIds([chatRow('c1', 'Ana'), taskRow('t1'), contextRow('x1')])).toEqual(['t1']);
  });
});

describe('deferrableSystemRowIds — no split for pure batches', () => {
  it('pure chat batch → no defer', () => {
    expect(deferrableSystemRowIds([chatRow('c1', 'Ana')])).toEqual([]);
  });

  it('pure task/system batch → no defer (runs as a pure-system turn)', () => {
    expect(deferrableSystemRowIds([taskRow('t1'), taskRow('t2')])).toEqual([]);
  });

  it('a senderless chat + a task → no defer (no authenticated chat to protect; the senderless-chat poison is a separate concern, untouched)', () => {
    expect(deferrableSystemRowIds([senderlessChat('c1'), taskRow('t1')])).toEqual([]);
  });
});

describe('the split preserves both V1 parity AND the #419 security property', () => {
  it('the chat remainder resolves to its single authenticated sender (mutations allowed — V1 parity)', () => {
    const batch = [chatRow('c1', '558681512111@s.whatsapp.net'), taskRow('t1')];
    const deferred = new Set(deferrableSystemRowIds(batch));
    const chatTurn = batch.filter((m) => !deferred.has(m.id));
    const actor = turnActorSenders(chatTurn);
    expect(actor.poison).toBe(false);
    expect(actor.senders).toEqual(['558681512111@s.whatsapp.net']);
    expect(actor.system).toBe(false);
  });

  it('the deferred task, run ALONE next iteration, is a pure-system turn — no chat actor to borrow', () => {
    const batch = [chatRow('c1', 'Thiago'), taskRow('t1')];
    const deferred = deferrableSystemRowIds(batch);
    const systemTurn = batch.filter((m) => deferred.includes(m.id));
    const actor = turnActorSenders(systemTurn);
    expect(actor.poison).toBe(true); // unresolved → requiresChatActor denies normal mutations
    expect(actor.system).toBe(true); // pure system → only mayRunChatBundledMutation (standup-archive)
    expect(actor.senders).toEqual([]);
  });
});

describe('followupCrossesActorDomain — end the stream on an actor-domain crossing (both directions)', () => {
  // active = (chatResolved, systemTurn)
  it('(a) active chat turn + incoming task → crosses (end stream; run task as its own turn)', () => {
    expect(followupCrossesActorDomain([taskRow('t1')], /*chatResolved*/ true, /*system*/ false)).toBe(true);
  });

  it('(b) active SYSTEM turn + incoming authenticated chat → crosses (the reverse case Codex flagged)', () => {
    expect(followupCrossesActorDomain([chatRow('c1', 'Ana')], /*chatResolved*/ false, /*system*/ true)).toBe(true);
  });

  it('active chat turn + incoming chat → SAME domain, no cross (push as before)', () => {
    expect(followupCrossesActorDomain([chatRow('c1', 'Ana')], true, false)).toBe(false);
  });

  it('active system turn + incoming task → SAME domain, no cross', () => {
    expect(followupCrossesActorDomain([taskRow('t1')], false, true)).toBe(false);
  });

  it('an already-poisoned multi-sender chat turn (neither resolved nor system) never forces a stream end', () => {
    expect(followupCrossesActorDomain([taskRow('t1')], false, false)).toBe(false);
    expect(followupCrossesActorDomain([chatRow('c1', 'Ana')], false, false)).toBe(false);
  });

  it('a senderless chat follow-up does not count as a chat-domain crossing into a system turn', () => {
    expect(followupCrossesActorDomain([senderlessChat('c1')], false, true)).toBe(false);
  });
});
