/**
 * v2 send_otp host-side delivery action handler — TDD-RED→GREEN spec.
 *
 * Permission gate (corrected design after Codex review of a123cecd):
 *   - v1 stored isMain on `registered_groups` (per-CHAT). The closest v2
 *     equivalent is `messaging_groups.is_main_control` (see migration
 *     module-taskflow-main-control). The handler checks
 *     `session.messaging_group_id` → `getMessagingGroup(...).is_main_control === 1`.
 *   - Sessions with messaging_group_id = null (DM-only or rare orphan
 *     states) cannot pass the gate — fail-closed.
 *
 * Adapter contract: `adapter.deliver(jid, null, { kind:'chat', content:OBJECT })`
 *   - WhatsApp adapter at src/channels/whatsapp.ts:624 reads
 *     `message.content` as Record<string, unknown> (no JSON.parse). Passing
 *     a stringified content silently no-ops (Codex BLOCKER #1 from a123cecd).
 *   - Test asserts `content` IS the object literal, not a string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '../../channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';

const fakeSession: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-main',
  messaging_group_id: 'mg-main',
  thread_id: null,
  agent_provider: 'claude',
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-05-04T00:00:00Z',
};

const mainMessagingGroup: MessagingGroup = {
  id: 'mg-main',
  channel_type: 'whatsapp',
  platform_id: '120363999@g.us',
  name: 'Main Control',
  is_group: 1,
  unknown_sender_policy: 'strict',
  is_main_control: 1,
  created_at: '2026-05-04T00:00:00Z',
};

const nonMainMessagingGroup: MessagingGroup = {
  ...mainMessagingGroup,
  id: 'mg-board-123',
  platform_id: '120363111@g.us',
  name: 'Board 123',
  is_main_control: 0,
};

let mockWhatsAppAdapter: Partial<ChannelAdapter> | undefined;
let messagingGroupLookup: Map<string, MessagingGroup>;
let wiringLookup: Map<string, MessagingGroupAgent>;

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn((channelType: string) => {
    if (channelType === 'whatsapp') return mockWhatsAppAdapter;
    return undefined;
  }),
}));

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn((id: string) => messagingGroupLookup.get(id)),
  getMessagingGroupAgentByPair: vi.fn((messagingGroupId: string, agentGroupId: string) =>
    wiringLookup.get(`${messagingGroupId}|${agentGroupId}`),
  ),
}));

function makeWiring(
  messagingGroupId: string,
  agentGroupId: string,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): MessagingGroupAgent {
  return {
    id: `mga-${messagingGroupId}-${agentGroupId}`,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: sessionMode,
    priority: 0,
    created_at: '2026-05-04T00:00:00Z',
  };
}

beforeEach(() => {
  messagingGroupLookup = new Map([[mainMessagingGroup.id, mainMessagingGroup]]);
  // Default: a 'shared' wiring so the agent-shared early-drop is bypassed.
  wiringLookup = new Map([
    [
      `${mainMessagingGroup.id}|${fakeSession.agent_group_id}`,
      makeWiring(mainMessagingGroup.id, fakeSession.agent_group_id, 'shared'),
    ],
  ]);
  mockWhatsAppAdapter = {
    name: 'whatsapp',
    channelType: 'whatsapp',
    supportsThreads: false,
    setup: vi.fn(),
    teardown: vi.fn(),
    isConnected: () => true,
    deliver: vi.fn(async () => 'wa-msg-id-1'),
    lookupPhoneJid: vi.fn(async () => '5585999991234@s.whatsapp.net'),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleSendOtp delivery action handler (host side, messaging-group gate)', () => {
  it('drops the action when session.messaging_group_id has is_main_control = 0 (v1 isMain parity, per-CHAT)', async () => {
    messagingGroupLookup.set(nonMainMessagingGroup.id, nonMainMessagingGroup);
    // Add wiring so we pass the wiring gate and actually exercise the is_main_control check.
    wiringLookup.set(
      `${nonMainMessagingGroup.id}|${fakeSession.agent_group_id}`,
      makeWiring(nonMainMessagingGroup.id, fakeSession.agent_group_id, 'shared'),
    );
    const nonMainSession: Session = { ...fakeSession, messaging_group_id: nonMainMessagingGroup.id };
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      nonMainSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('drops when wiring row is missing (fail-closed against stale fk)', async () => {
    wiringLookup.clear();
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      fakeSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('drops the action when the wiring is agent-shared (session.messaging_group_id is unreliable trigger source)', async () => {
    // Override wiring to agent-shared. session.messaging_group_id still points at
    // mainMessagingGroup (which has is_main_control=1), so the simple gate WOULD pass.
    // But agent-shared sessions don't carry trigger-chat identity reliably, so we drop.
    wiringLookup.set(
      `${mainMessagingGroup.id}|${fakeSession.agent_group_id}`,
      makeWiring(mainMessagingGroup.id, fakeSession.agent_group_id, 'agent-shared'),
    );
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      fakeSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('drops the action when session.messaging_group_id is null (DM-only / orphan, fail-closed)', async () => {
    const orphanSession: Session = { ...fakeSession, messaging_group_id: null };
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      orphanSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('drops when no messaging group exists for the session id (fail-closed)', async () => {
    // Wiring row points at a stale messaging_group_id that has no row in
    // messaging_groups (e.g., the chat row was deleted but the wiring lingered).
    wiringLookup.set(
      `mg-deleted|${fakeSession.agent_group_id}`,
      makeWiring('mg-deleted', fakeSession.agent_group_id, 'shared'),
    );
    const orphanSession: Session = { ...fakeSession, messaging_group_id: 'mg-deleted' };
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      orphanSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('on main messaging group + valid input, calls lookupPhoneJid then deliver with OBJECT content (adapter contract)', async () => {
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      fakeSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).toHaveBeenCalledWith('+5585999991234');
    expect(mockWhatsAppAdapter!.deliver).toHaveBeenCalledOnce();
    const deliverArgs = (mockWhatsAppAdapter!.deliver as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(deliverArgs[0]).toBe('5585999991234@s.whatsapp.net'); // platform_id (the JID)
    expect(deliverArgs[1]).toBeNull(); // thread_id
    const payload = deliverArgs[2];
    expect(payload.kind).toBe('chat');
    // The WhatsApp adapter casts message.content to Record<string, unknown>
    // and reads .text directly — a stringified content is a no-op (BLOCKER #1).
    // Assert the content IS an object, not a JSON string.
    expect(typeof payload.content).toBe('object');
    expect(payload.content).not.toBeNull();
    expect((payload.content as { type?: string }).type).toBe('text');
    expect((payload.content as { text?: string }).text).toBe('Codigo: 123456');
  });

  it('does not call deliver when lookupPhoneJid returns null (phone not on WhatsApp)', async () => {
    (mockWhatsAppAdapter!.lookupPhoneJid as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999000000', message: 'Codigo: 123456' },
      fakeSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('drops payloads with empty phone', async () => {
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp({ action: 'send_otp', phone: '   ', message: 'Codigo: 123456' }, fakeSession, {} as never);
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('drops payloads with empty message', async () => {
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp({ action: 'send_otp', phone: '+5585999991234', message: '' }, fakeSession, {} as never);
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('drops the action when no WhatsApp adapter is registered', async () => {
    mockWhatsAppAdapter = undefined;
    const { handleSendOtp } = await import('./handler.js');
    await expect(
      handleSendOtp(
        { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
        fakeSession,
        {} as never,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('send-otp module index', () => {
  it('registers handleSendOtp as the "send_otp" delivery action on import', async () => {
    const registerSpy = vi.fn();
    vi.doMock('../../delivery.js', () => ({ registerDeliveryAction: registerSpy }));
    await import('./index.js');
    expect(registerSpy).toHaveBeenCalledWith('send_otp', expect.any(Function));
    vi.doUnmock('../../delivery.js');
  });
});
