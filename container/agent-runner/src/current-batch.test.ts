import { afterEach, describe, expect, it } from 'bun:test';

import {
  clearCurrentWebOrigin,
  crossesWebChatBoundary,
  detectWebOrigin,
  setCurrentWebOrigin,
  type WebOriginCtx,
} from './current-batch.js';
import type { RoutingContext } from './formatter.js';
import type { MessageInRow } from './db/messages-in.js';

// Minimal MessageInRow factory — only the fields detectWebOrigin reads.
function msg(id: string, content: string): MessageInRow {
  return {
    id,
    seq: null,
    kind: 'chat',
    timestamp: '2026-05-17T00:00:00.000Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'whatsapp',
    channel_type: 'whatsapp',
    thread_id: null,
    content,
  };
}

const ROUTING: RoutingContext = {
  platformId: 'whatsapp',
  channelType: 'whatsapp',
  threadId: null,
  inReplyTo: 'taskflow-web:42',
};

const webContent = (boardId: string, boardChatId: number) =>
  JSON.stringify({
    text: 'oi',
    sender: 'web',
    origin: 'taskflow_web',
    board_id: boardId,
    board_chat_id: boardChatId,
  });

describe('detectWebOrigin', () => {
  it('builds ctx from the web message content + the batch routing', () => {
    // WHY: the gate in messages-out.ts matches the outbound row's
    // routing against ctx.platform/channel/thread, and writes
    // board_chat using ctx.board_id/board_chat_id — so the ctx must
    // carry the message's board ids AND the batch's triggering routing.
    const ctx = detectWebOrigin([msg('taskflow-web:42', webContent('b1', 42))], ROUTING);
    expect(ctx).toEqual({
      board_id: 'b1',
      board_chat_id: 42,
      platformId: 'whatsapp',
      channelType: 'whatsapp',
      threadId: null,
    } satisfies WebOriginCtx);
  });

  it('is batch-level: ANY web message in the batch triggers it (V1 some())', () => {
    // WHY: V1 semantics are `missedMessages.some(isWebOriginMessage)`,
    // NOT messages[0] only — a web row anywhere in the batch counts.
    const ctx = detectWebOrigin(
      [msg('wa:1', JSON.stringify({ text: 'hi' })), msg('taskflow-web:7', webContent('b9', 7))],
      ROUTING,
    );
    expect(ctx?.board_chat_id).toBe(7);
    expect(ctx?.board_id).toBe('b9');
  });

  it('returns the FIRST web message ids when several are present', () => {
    const ctx = detectWebOrigin(
      [msg('taskflow-web:3', webContent('bX', 3)), msg('taskflow-web:4', webContent('bY', 4))],
      ROUTING,
    );
    expect(ctx?.board_chat_id).toBe(3);
  });

  it('returns null for a non-web batch', () => {
    const ctx = detectWebOrigin(
      [msg('wa:1', JSON.stringify({ text: 'hello' })), msg('wa:2', JSON.stringify({ text: 'yo' }))],
      ROUTING,
    );
    expect(ctx).toBeNull();
  });

  it('anti-spoof: id prefixed but content.origin is NOT taskflow_web → null', () => {
    // WHY (Codex#4): dual check. A user must not forge a board_chat
    // write by sending a message whose id happens to start
    // "taskflow-web:" — the host-injected marker in content is required.
    const ctx = detectWebOrigin(
      [msg('taskflow-web:99', JSON.stringify({ text: 'pwn', origin: 'whatsapp', board_id: 'b', board_chat_id: 99 }))],
      ROUTING,
    );
    expect(ctx).toBeNull();
  });

  it('anti-spoof: content.origin=taskflow_web but id NOT prefixed → null', () => {
    // WHY: both signals are host-controlled together; either alone is
    // insufficient (a chat body can contain arbitrary JSON).
    const ctx = detectWebOrigin([msg('wa:123', webContent('b', 5))], ROUTING);
    expect(ctx).toBeNull();
  });

  it('exact-id hardening: id prefix present but board_chat_id mismatches the id → null', () => {
    // WHY (Codex P3a): the host writes id EXACTLY
    // `taskflow-web:${board_chat_id}` (deterministic). A row whose id
    // is `taskflow-web:42` but whose content claims board_chat_id 99
    // is malformed/forged — `startsWith` would wrongly accept it and
    // write board_chat under the wrong id. Require exact equality.
    const ctx = detectWebOrigin([msg('taskflow-web:42', webContent('b1', 99))], ROUTING);
    expect(ctx).toBeNull();
  });

  it('malformed content JSON on a taskflow-web: id → null, no throw', () => {
    const ctx = detectWebOrigin([msg('taskflow-web:8', '{not valid json')], ROUTING);
    expect(ctx).toBeNull();
  });

  it('web id + valid JSON but missing board ids → null (no partial ctx)', () => {
    const ctx = detectWebOrigin(
      [msg('taskflow-web:8', JSON.stringify({ text: 'x', origin: 'taskflow_web' }))],
      ROUTING,
    );
    expect(ctx).toBeNull();
  });
});

describe('crossesWebChatBoundary', () => {
  // currentWebOrigin is module-global; never let it bleed across tests.
  afterEach(() => clearCurrentWebOrigin());

  const normal = [msg('wa:1', JSON.stringify({ text: 'hi' }))];
  const web = [msg('taskflow-web:7', webContent('b9', 7))];

  it('Guard A — web row arrives during a NON-web turn (ctx null) → true', () => {
    // WHY (Codex P1): pushing this into the active non-web query would
    // emit the web reply with currentWebOrigin===null → delivered to
    // the channel adapter instead of board_chat.
    clearCurrentWebOrigin();
    expect(crossesWebChatBoundary(web, ROUTING)).toBe(true);
  });

  it('Guard B — ANY follow-up during an ACTIVE web turn (ctx set) → true', () => {
    // WHY (Codex resume BLOCKER): a normal WhatsApp follow-up from the
    // same board/group, pushed into the active web query, gets its
    // reply rewritten into board_chat by the still-set ctx (routing
    // matches — same session). The inverse misroute.
    setCurrentWebOrigin({
      board_id: 'b1',
      board_chat_id: 1,
      platformId: 'whatsapp',
      channelType: 'whatsapp',
      threadId: null,
    } satisfies WebOriginCtx);
    expect(crossesWebChatBoundary(normal, ROUTING)).toBe(true);
  });

  it('no boundary — non-web follow-up during a non-web turn → false (normal push proceeds)', () => {
    clearCurrentWebOrigin();
    expect(crossesWebChatBoundary(normal, ROUTING)).toBe(false);
  });

  it('web row during an active web turn → true', () => {
    setCurrentWebOrigin({
      board_id: 'b1',
      board_chat_id: 1,
      platformId: 'whatsapp',
      channelType: 'whatsapp',
      threadId: null,
    } satisfies WebOriginCtx);
    expect(crossesWebChatBoundary(web, ROUTING)).toBe(true);
  });

  it('active web turn with NO pending follow-ups → false (must not end its own stream)', () => {
    // WHY (Codex resume#2 BLOCKER): the follow-up poller fires every
    // interval DURING the active web turn (its triggering row is
    // already markProcessing'd, so pending=[]). The ctx clause must be
    // gated on an actual follow-up — otherwise every web turn's own
    // stream is killed mid-flight before it replies.
    setCurrentWebOrigin({
      board_id: 'b1',
      board_chat_id: 1,
      platformId: 'whatsapp',
      channelType: 'whatsapp',
      threadId: null,
    } satisfies WebOriginCtx);
    expect(crossesWebChatBoundary([], ROUTING)).toBe(false);
  });

  it('active web turn with system-only pending → false (no real follow-up to defer)', () => {
    setCurrentWebOrigin({
      board_id: 'b1',
      board_chat_id: 1,
      platformId: 'whatsapp',
      channelType: 'whatsapp',
      threadId: null,
    } satisfies WebOriginCtx);
    const systemOnly = [{ ...msg('s1', '{}'), kind: 'system' }];
    expect(crossesWebChatBoundary(systemOnly, ROUTING)).toBe(false);
  });

  it('active web turn + trigger=0 accumulate-only follow-up → false (must NOT truncate the web reply)', () => {
    // WHY (Codex resume#3): the guard runs before the poller's own
    // `if (!hasWakeTrigger) return`. A trigger=0 row is never pushed/
    // answered, so it can't misroute — ending the stream for it would
    // truncate the in-flight web reply on mere background chatter. Only
    // a wake-eligible (trigger===1) non-system follow-up can misroute.
    setCurrentWebOrigin({
      board_id: 'b1',
      board_chat_id: 1,
      platformId: 'whatsapp',
      channelType: 'whatsapp',
      threadId: null,
    } satisfies WebOriginCtx);
    const accumulateOnly = [{ ...msg('m1', JSON.stringify({ text: 'bg chatter' })), trigger: 0 }];
    expect(crossesWebChatBoundary(accumulateOnly, ROUTING)).toBe(false);
  });

  it('active web turn + mixed trigger=0/1 pending → true (wake-eligible follow-up present)', () => {
    setCurrentWebOrigin({
      board_id: 'b1',
      board_chat_id: 1,
      platformId: 'whatsapp',
      channelType: 'whatsapp',
      threadId: null,
    } satisfies WebOriginCtx);
    const mixed = [
      { ...msg('m0', JSON.stringify({ text: 'noise' })), trigger: 0 },
      { ...msg('m1', JSON.stringify({ text: 'real reply' })), trigger: 1 },
    ];
    expect(crossesWebChatBoundary(mixed, ROUTING)).toBe(true);
  });
});
