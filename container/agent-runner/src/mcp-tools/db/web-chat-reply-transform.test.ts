/**
 * 0h-v2 web-chat REPLY gate (memo §0.3 step 4, PINNED gate).
 *
 * Now lands as the TaskFlow overlay's outbound transform (ADR 0006
 * contract 7). `writeMessageOut` is the single outbound writer every
 * reply path funnels through (core.ts send_message/send_file, poll-loop
 * fast-paths, bare-final-text). When the current batch is web-origin
 * (set in current-batch by the poll loop, like `inReplyTo`), the
 * agent's reply to the *triggering* conversation must become a
 * `taskflow_web_chat_reply` system row (→ host writes board_chat),
 * NOT a channel message. `kind:'chat'` does NOT discriminate the
 * triggering reply from an explicit `send_message(to:…)`/a2a (all
 * `kind:'chat'`) — the discriminator is **routing-match** against the
 * batch's triggering routing (V1 `appendAgentOutputToBoardChat`
 * replaced exactly `enqueueAgentOutput(chatJid,…)`). High blast
 * radius: a wrong gate breaks replies on every channel.
 *
 * Importing `./web-chat-reply-transform.js` fires its top-level
 * `registerOutboundTransform(...)` so `writeMessageOut` applies the gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../../db/connection.js';
import { writeMessageOut } from '../../db/messages-out.js';
import {
  clearCurrentWebOrigin,
  getCurrentWebOrigin,
  setCurrentWebOrigin,
} from '../../current-batch.js';
import './web-chat-reply-transform.js';

const TRIGGER = { platformId: '120363@g.us', channelType: 'whatsapp', threadId: null };
const WEB = {
  board_id: 'board-1',
  board_chat_ids: [42],
  ...TRIGGER,
  sender_name: 'Case',
  source_id_prefix: 'ag-board',
};

function rows() {
  return getOutboundDb()
    .prepare('SELECT kind, platform_id, channel_type, thread_id, content FROM messages_out ORDER BY seq')
    .all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  initTestSessionDb();
  clearCurrentWebOrigin();
});
afterEach(() => {
  clearCurrentWebOrigin();
  closeSessionDb();
});

describe('current-batch web-origin context', () => {
  it('set / get / clear round-trips (module state, like inReplyTo)', () => {
    expect(getCurrentWebOrigin()).toBeNull();
    setCurrentWebOrigin(WEB);
    expect(getCurrentWebOrigin()).toEqual(WEB);
    clearCurrentWebOrigin();
    expect(getCurrentWebOrigin()).toBeNull();
  });
});

describe('writeMessageOut — web-origin reply gate', () => {
  it('transforms the triggering-conversation chat reply into a taskflow_web_chat_reply system row', () => {
    setCurrentWebOrigin(WEB);
    writeMessageOut({
      id: 'r1',
      kind: 'chat',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ text: 'the agent reply' }),
    });
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('system');
    expect(r[0].platform_id).toBeNull();
    expect(r[0].channel_type).toBeNull();
    expect(r[0].thread_id).toBeNull();
    const payload = JSON.parse(r[0].content as string);
    const { source_outbound_id, ...rest } = payload;
    expect(rest).toEqual({
      action: 'taskflow_web_chat_reply',
      board_id: 'board-1',
      board_chat_ids: [42],
      text: 'the agent reply',
      sender_name: 'Case',
    });
    // G1: collision-proof, prefix-namespaced UUID (stable per row).
    expect(source_outbound_id).toMatch(
      /^ag-board:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('G2: empty sender_name falls back to "Assistant" (never emit blank → tf 400/lost)', () => {
    setCurrentWebOrigin({ ...WEB, sender_name: '' });
    writeMessageOut({
      id: 'r2',
      kind: 'chat',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ text: 'reply' }),
    });
    expect(JSON.parse(rows()[0].content as string).sender_name).toBe('Assistant');
  });

  it('G2: WHITESPACE-only sender_name also falls back (tf .strip() would 400 → lost)', () => {
    setCurrentWebOrigin({ ...WEB, sender_name: '   ' });
    writeMessageOut({
      id: 'r2b',
      kind: 'chat',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ text: 'reply' }),
    });
    expect(JSON.parse(rows()[0].content as string).sender_name).toBe('Assistant');
  });

  it('G1: empty source_id_prefix → "ag:" prefix, still globally unique', () => {
    setCurrentWebOrigin({ ...WEB, source_id_prefix: '' });
    writeMessageOut({
      id: 'r3',
      kind: 'chat',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ text: 'reply' }),
    });
    expect(JSON.parse(rows()[0].content as string).source_outbound_id).toMatch(
      /^ag:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('does NOT transform a chat sent to a DIFFERENT destination (explicit send/a2a — routing differs)', () => {
    setCurrentWebOrigin(WEB);
    writeMessageOut({
      id: 'r2',
      kind: 'chat',
      platform_id: 'other-dest@g.us', // not the triggering routing
      channel_type: 'whatsapp',
      thread_id: null,
      content: JSON.stringify({ text: 'to a different group' }),
    });
    const r = rows();
    expect(r[0].kind).toBe('chat');
    expect(r[0].platform_id).toBe('other-dest@g.us');
    expect(JSON.parse(r[0].content as string)).toEqual({ text: 'to a different group' });
  });

  it('does NOT transform when there is no web-origin batch (normal turn)', () => {
    writeMessageOut({
      id: 'r3',
      kind: 'chat',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ text: 'normal reply' }),
    });
    expect(rows()[0].kind).toBe('chat');
  });

  it('does NOT transform non-chat rows (system/a2a) even on a web-origin turn', () => {
    setCurrentWebOrigin(WEB);
    writeMessageOut({
      id: 'r4',
      kind: 'system',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ action: 'something_else' }),
    });
    const r = rows();
    expect(r[0].kind).toBe('system');
    expect(JSON.parse(r[0].content as string)).toEqual({ action: 'something_else' });
  });

  it('does NOT transform edit_message / add_reaction (operation rows) even on the triggering routing (Codex)', () => {
    setCurrentWebOrigin(WEB);
    writeMessageOut({
      id: 'r5',
      kind: 'chat',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ operation: 'edit', messageId: '7', text: 'fixed typo' }),
    });
    writeMessageOut({
      id: 'r6',
      kind: 'chat',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ operation: 'reaction', messageId: '7', emoji: '👍' }),
    });
    const r = rows();
    expect(r[0].kind).toBe('chat');
    expect(JSON.parse(r[0].content as string).operation).toBe('edit');
    expect(r[1].kind).toBe('chat');
    expect(JSON.parse(r[1].content as string).operation).toBe('reaction');
  });

  it('does NOT transform send_file rows (content has files) — file would be lost (Codex)', () => {
    setCurrentWebOrigin(WEB);
    writeMessageOut({
      id: 'r7',
      kind: 'chat',
      platform_id: TRIGGER.platformId,
      channel_type: TRIGGER.channelType,
      thread_id: TRIGGER.threadId,
      content: JSON.stringify({ text: '', files: ['report.pdf'] }),
    });
    const r = rows();
    expect(r[0].kind).toBe('chat');
    expect(JSON.parse(r[0].content as string).files).toEqual(['report.pdf']);
  });
});
