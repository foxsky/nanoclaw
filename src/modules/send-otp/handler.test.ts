/**
 * v2 send_otp host-side delivery action handler — TDD-RED→GREEN spec.
 *
 * v1 semantics (src/ipc-plugins/send-otp.ts, deleted in Step 2.2.b):
 *   1. Permission gate: only the "main" control group could call send_otp.
 *      v2 reintroduces this via `agent_groups.is_main_control` (Codex C1
 *      recommendation, 2026-05-04). The handler reads the session's agent
 *      group and drops the action if `is_main_control !== 1`.
 *   2. Validate phone + message are non-empty strings.
 *   3. Call `lookupPhoneJid(phone)` on the WhatsApp adapter.
 *   4. If JID resolved, call `adapter.deliver()` with the message text.
 *   5. If JID null (phone not on WhatsApp), warn + drop.
 *
 * Layer split (per Codex): host is authoritative; the container MCP tool
 * does NOT gate calls — it just writes the outbound system row. The host
 * handler is the only enforcement point for the privilege check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '../../channels/adapter.js';
import type { AgentGroup, Session } from '../../types.js';

const fakeSession: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-main',
  messaging_group_id: 'mg-1',
  thread_id: null,
  agent_provider: 'claude',
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-05-04T00:00:00Z',
};

const mainAgentGroup: AgentGroup = {
  id: 'ag-main',
  name: 'main',
  folder: 'main',
  agent_provider: 'claude',
  created_at: '2026-05-04T00:00:00Z',
  is_main_control: 1,
};

const nonMainAgentGroup: AgentGroup = {
  ...mainAgentGroup,
  id: 'ag-board-123',
  is_main_control: 0,
};

let mockWhatsAppAdapter: Partial<ChannelAdapter> | undefined;
let agentGroupLookup: Map<string, AgentGroup>;

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn((channelType: string) => {
    if (channelType === 'whatsapp') return mockWhatsAppAdapter;
    return undefined;
  }),
}));

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn((id: string) => agentGroupLookup.get(id)),
}));

beforeEach(() => {
  agentGroupLookup = new Map([[mainAgentGroup.id, mainAgentGroup]]);
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

describe('handleSendOtp delivery action handler (host side, C1 gate)', () => {
  it('drops the action when session.agent_group_id has is_main_control = 0 (v1 isMain parity)', async () => {
    agentGroupLookup.set(nonMainAgentGroup.id, nonMainAgentGroup);
    const nonMainSession: Session = { ...fakeSession, agent_group_id: nonMainAgentGroup.id };
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      nonMainSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('drops the action when no agent group exists for the session id (fail-closed)', async () => {
    const orphanSession: Session = { ...fakeSession, agent_group_id: 'ag-deleted' };
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      orphanSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('on main agent group + valid input, calls lookupPhoneJid then deliver', async () => {
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
    const content = typeof payload.content === 'string' ? JSON.parse(payload.content) : payload.content;
    expect(content.text).toBe('Codigo: 123456');
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
    // No adapter → silent drop, no throw (consistent with v1 deps.lookupPhoneJid absence).
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
