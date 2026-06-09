/**
 * SEC#4 (#410, Codex BLOCKER) — broadcast/forward gate on send_message / send_file.
 *
 * WHY: send_message can target ANY host-allowlisted destination, including another board's chat or a
 * peer agent group. A prompt-injected board agent ("forward the roadmap to the other team") is an
 * intra-org data-exfil/forward primitive. The destructive-gate's `broadcast` category exists for
 * exactly this but had no caller (dead). This wires it: a send to a destination OTHER than the
 * current conversation (external) is HELD for admin approval — the same park-for-approval round-trip
 * as the mutate gates. Scope is board agents only (NANOCLAW_TASKFLOW_BOARD_ID set): core non-board
 * agents' send_message is unchanged, and the reply-in-place path is never gated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { setVerbatimIds } from './taskflow-helpers.js';
import { runAsApprovedReplay } from './taskflow-approval.js';
import { sendMessage } from './core.js';

const BOARD_CHANNEL = 'whatsapp';
const BOARD_PLATFORM = 'board-chat@g.us';

beforeEach(() => {
  initTestSessionDb();
  process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-b1';
  // The conversation this session is bound to (the board's own chat).
  getInboundDb()
    .prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, NULL)')
    .run(BOARD_CHANNEL, BOARD_PLATFORM);
  // Two destinations: the board's own chat (same conversation) and a DIFFERENT chat (external/forward).
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id) VALUES
         ('self',  'Self',  'channel', ?, ?, NULL),
         ('other', 'Other', 'channel', 'whatsapp', 'other-board@g.us', NULL)`,
    )
    .run(BOARD_CHANNEL, BOARD_PLATFORM);
});

afterEach(() => {
  closeSessionDb();
  setVerbatimIds(false);
  delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
});

function rows() {
  const all = getOutboundDb().query('SELECT kind, content FROM messages_out').all() as Array<{
    kind: string;
    content: string;
  }>;
  return {
    chat: all.filter((r) => r.kind === 'chat'),
    park: all.filter((r) => r.kind === 'system').map((r) => JSON.parse(r.content) as Record<string, unknown>),
  };
}

describe('send_message broadcast gate (#410)', () => {
  it('replying in place (to omitted) is NOT gated — the message is sent', async () => {
    const res = JSON.parse(JSON.stringify(await sendMessage.handler({ text: 'normal reply' })));
    expect(res.isError).toBeFalsy();
    const { chat, park } = rows();
    expect(chat).toHaveLength(1);
    expect(park).toHaveLength(0);
  });

  it('sending to the SAME conversation by name is NOT gated', async () => {
    await sendMessage.handler({ to: 'self', text: 'still in-conv' });
    const { chat, park } = rows();
    expect(chat).toHaveLength(1);
    expect(park).toHaveLength(0);
  });

  it('forwarding to a DIFFERENT conversation is HELD for approval (parked, not sent)', async () => {
    const res = JSON.parse((await sendMessage.handler({ to: 'other', text: 'leak the roadmap' })).content[0].text);
    expect(res.success).toBe(false);
    expect(res.error_code).toBe('pending_approval');
    expect(res.gate.category).toBe('broadcast');
    const { chat, park } = rows();
    expect(chat).toHaveLength(0); // NOT delivered
    expect(park).toHaveLength(1);
    expect(park[0].action).toBe('taskflow_request_approval');
    expect(park[0].tool).toBe('send_message');
  });

  it('the FastAPI/verbatim surface and the approved replay both BYPASS the gate', async () => {
    setVerbatimIds(true);
    await sendMessage.handler({ to: 'other', text: 'dashboard send' });
    setVerbatimIds(false);
    await runAsApprovedReplay(() => sendMessage.handler({ to: 'other', text: 'approved forward' }));
    const { chat, park } = rows();
    expect(chat).toHaveLength(2); // both delivered
    expect(park).toHaveLength(0);
  });

  it('a non-board agent (no NANOCLAW_TASKFLOW_BOARD_ID) is NOT gated — core send_message unchanged', async () => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    await sendMessage.handler({ to: 'other', text: 'ordinary cross-dest send' });
    const { chat, park } = rows();
    expect(chat).toHaveLength(1);
    expect(park).toHaveLength(0);
  });
});
