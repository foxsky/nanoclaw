import { afterEach, describe, expect, it } from 'bun:test';

import { isExternalBoardSend } from './poll-loop.js';
import type { DestinationEntry } from './destinations.js';
import type { RoutingContext } from './formatter.js';

// SEC#11 BLOCKER (whole-epic Codex xhigh): the model's `<message to="...">` final output is
// dispatched (poll-loop dispatchResultText → sendToDestination) through the SAME destinations table
// as the send_message MCP tool, but with NO #410 broadcast gate. A prompt-injected board agent could
// emit `<message to="other-board">{board data}</message>` and exfiltrate cross-board without ever
// calling the gated send_message. isExternalBoardSend is the fail-closed predicate that suppresses
// any model-final send leaving the current conversation on a board session.

const SAVED = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
afterEach(() => {
  if (SAVED === undefined) delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  else process.env.NANOCLAW_TASKFLOW_BOARD_ID = SAVED;
});

const here: RoutingContext = {
  channelType: 'whatsapp',
  platformId: 'board-group@g.us',
  threadId: null,
  inReplyTo: null,
};

const sameConv: DestinationEntry = { name: 'self', displayName: 'self', type: 'channel', channelType: 'whatsapp', platformId: 'board-group@g.us' };
const otherBoard: DestinationEntry = { name: 'other', displayName: 'Other Board', type: 'channel', channelType: 'whatsapp', platformId: 'other-group@g.us' };
const agentDest: DestinationEntry = { name: 'companion', displayName: 'companion', type: 'agent', agentGroupId: 'ag-xyz' };

describe('isExternalBoardSend', () => {
  it('SUPPRESSES a board model-final send leaving the current conversation', () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-1';
    expect(isExternalBoardSend(otherBoard, here)).toBe(true); // cross-board channel
    expect(isExternalBoardSend(agentDest, here)).toBe(true); // a wired sub-agent destination
  });

  it('ALLOWS a board reply that stays in the current conversation', () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-1';
    expect(isExternalBoardSend(sameConv, here)).toBe(false);
  });

  it('does NOT gate non-board (generic) agents — feature unchanged', () => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    expect(isExternalBoardSend(otherBoard, here)).toBe(false);
  });

  it('treats an unknown current conversation as not-external (mirrors maybeParkBroadcast)', () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-1';
    const unknown: RoutingContext = { channelType: null, platformId: null, threadId: null, inReplyTo: null };
    expect(isExternalBoardSend(otherBoard, unknown)).toBe(false);
  });
});
