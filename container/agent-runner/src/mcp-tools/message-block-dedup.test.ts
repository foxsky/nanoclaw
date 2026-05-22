import { describe, expect, it } from 'bun:test';

import type { DestinationEntry } from '../destinations.ts';
import type { RoutingContext } from '../formatter.ts';
import { shouldSuppressSameConvMessage } from './message-block-dedup.ts';

// Phase-3 #7 follow-up: locks the refined dedup scope. The
// `<message>`-block carve-out from ba24ef23 is preserved for
// cross-conversation relays; same-conversation `<message>` blocks
// after a mutation card are now suppressed (the redundant model
// NL the bare-text fallback already would have caught, just
// `<message>`-wrapped).

const ROUTING_WA: RoutingContext = {
  platformId: '120363400000000000@g.us',
  channelType: 'whatsapp',
  threadId: null,
  inReplyTo: null,
};

const SAME_WA_DEST: DestinationEntry = {
  name: 'self',
  displayName: 'Self',
  type: 'channel',
  channelType: 'whatsapp',
  platformId: '120363400000000000@g.us',
};

const OTHER_WA_DEST: DestinationEntry = {
  name: 'other',
  displayName: 'Other',
  type: 'channel',
  channelType: 'whatsapp',
  platformId: '120363499999999999@g.us',
};

const OTHER_CHANNEL_DEST: DestinationEntry = {
  name: 'tg',
  displayName: 'Telegram',
  type: 'channel',
  channelType: 'telegram',
  platformId: '120363400000000000@g.us',
};

describe('shouldSuppressSameConvMessage — refined #7 dedup scope', () => {
  it('flag unset → never suppress (the dedup is inert)', () => {
    expect(shouldSuppressSameConvMessage(false, SAME_WA_DEST, ROUTING_WA)).toBe(false);
    expect(shouldSuppressSameConvMessage(false, OTHER_WA_DEST, ROUTING_WA)).toBe(false);
  });

  it('flag set + channel dest matching platform_id AND channel_type → suppress (same-conv redundant NL)', () => {
    expect(shouldSuppressSameConvMessage(true, SAME_WA_DEST, ROUTING_WA)).toBe(true);
  });

  it('flag set + channel dest different platform_id → BYPASS (cross-board relay preserved)', () => {
    expect(shouldSuppressSameConvMessage(true, OTHER_WA_DEST, ROUTING_WA)).toBe(false);
  });

  it('flag set + channel dest different channel_type → BYPASS (cross-channel relay)', () => {
    expect(shouldSuppressSameConvMessage(true, OTHER_CHANNEL_DEST, ROUTING_WA)).toBe(false);
  });

  it('flag set + agent dest whose agentGroupId == inbound originator → suppress (agent-to-self)', () => {
    const agentRouting: RoutingContext = { platformId: 'ag-peer', channelType: 'agent', threadId: null, inReplyTo: null };
    const agentDest: DestinationEntry = { name: 'peer', displayName: 'Peer', type: 'agent', agentGroupId: 'ag-peer' };
    expect(shouldSuppressSameConvMessage(true, agentDest, agentRouting)).toBe(true);
  });

  it('flag set + agent dest different agentGroupId → BYPASS', () => {
    const agentRouting: RoutingContext = { platformId: 'ag-peer', channelType: 'agent', threadId: null, inReplyTo: null };
    const otherAgent: DestinationEntry = { name: 'other-agent', displayName: 'Other', type: 'agent', agentGroupId: 'ag-other' };
    expect(shouldSuppressSameConvMessage(true, otherAgent, agentRouting)).toBe(false);
  });

  it('flag set + agent dest but inbound was from a channel (not an agent) → BYPASS', () => {
    const agentDest: DestinationEntry = { name: 'peer', displayName: 'Peer', type: 'agent', agentGroupId: '120363400000000000@g.us' };
    expect(shouldSuppressSameConvMessage(true, agentDest, ROUTING_WA)).toBe(false);
  });

  it('flag set but routing has no current conversation (null platformId) → never suppress', () => {
    const noConvRouting: RoutingContext = { platformId: null, channelType: null, threadId: null, inReplyTo: null };
    expect(shouldSuppressSameConvMessage(true, SAME_WA_DEST, noConvRouting)).toBe(false);
  });
});
