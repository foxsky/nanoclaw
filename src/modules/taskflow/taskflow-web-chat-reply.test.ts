/**
 * 0h-v2 web-chat REPLY host delivery-action (memo §0.3 step 4 / rollout
 * step 5b). Drains the `taskflow_web_chat_reply` system row the
 * container's reply-gate emits (db/messages-out.ts writeMessageOut →
 * delivery.ts pollSweep → handleSystemAction) and POSTs tf's
 * `/internal/board-chat/agent-reply` (folded INSERT agent row +
 * mark-read of the batch's web-origin user rows, one tf txn). Closes
 * the bd2041b BLOCKER. Pure relay: the gate (5a) supplies
 * source_outbound_id + sender_name + the full board_chat_ids list;
 * this maps them onto tf's verified contract and applies the
 * shared 4xx-dead-letter / 5xx-throw classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const postTaskflowInternal = vi.fn();
vi.mock('./internal-api.js', () => ({
  postTaskflowInternal: (...a: unknown[]) => postTaskflowInternal(...a),
}));

import { log } from '../../log.js';

const svc: Session = {
  id: 'taskflow-service',
  agent_group_id: 'taskflow-service',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-05-17T00:00:00Z',
};

function payload(over: Record<string, unknown> = {}) {
  return {
    action: 'taskflow_web_chat_reply',
    board_id: 'board-1',
    board_chat_ids: [41, 42],
    text: 'here is the answer',
    sender_name: 'Case',
    source_outbound_id: 'sess-board:7',
    ...over,
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  postTaskflowInternal.mockReset();
  postTaskflowInternal.mockResolvedValue({
    kind: 'ok',
    data: { board_chat_id: 99, marked_read: 2, duplicate: false },
  });
  errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  errSpy.mockRestore();
  infoSpy.mockRestore();
});

async function reply(content: Record<string, unknown>) {
  const { handleTaskflowWebChatReply } = await import('./taskflow-web-chat-reply.js');
  await handleTaskflowWebChatReply(content, svc, {} as never);
}

describe('handleTaskflowWebChatReply', () => {
  it("POSTs agent-reply mapped onto tf's verified contract", async () => {
    await reply(payload());
    expect(postTaskflowInternal).toHaveBeenCalledOnce();
    expect(postTaskflowInternal).toHaveBeenCalledWith('/internal/board-chat/agent-reply', {
      board_id: 'board-1',
      text: 'here is the answer',
      sender_name: 'Case',
      source_outbound_id: 'sess-board:7',
      in_reply_to_chat_ids: [41, 42],
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['board_id', { board_id: '' }],
    ['text', { text: '   ' }],
    ['sender_name', { sender_name: '' }],
    ['source_outbound_id', { source_outbound_id: '' }],
  ])('FAIL-CLOSED on missing %s — no POST (gate/producer contract mismatch)', async (_f, over) => {
    await reply(payload(over));
    expect(postTaskflowInternal).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED on an empty board_chat_ids list — no POST', async () => {
    // empty would 400 empty_reply_batch anyway; surface the routing
    // bug loud on our side rather than round-trip a guaranteed reject.
    await reply(payload({ board_chat_ids: [] }));
    expect(postTaskflowInternal).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED on a non-positive-int board_chat_ids member — no POST', async () => {
    await reply(payload({ board_chat_ids: [41, 0] }));
    expect(postTaskflowInternal).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('propagates a retry-outcome throw (delivery.ts retries)', async () => {
    postTaskflowInternal.mockRejectedValueOnce(new Error('taskflow internal-api: http_503'));
    await expect(reply(payload())).rejects.toThrow('http_503');
  });

  it('does NOT throw on a terminal (4xx) outcome — dead-letter, no retry', async () => {
    postTaskflowInternal.mockResolvedValueOnce({
      kind: 'terminal',
      errorCode: 'missing_source_outbound_id',
    });
    await expect(reply(payload())).resolves.toBeUndefined();
  });

  it('logs the tf result (duplicate / marked_read) on success', async () => {
    postTaskflowInternal.mockResolvedValueOnce({
      kind: 'ok',
      data: { board_chat_id: 99, marked_read: 0, duplicate: true },
    });
    await reply(payload());
    expect(infoSpy).toHaveBeenCalled();
  });
});
