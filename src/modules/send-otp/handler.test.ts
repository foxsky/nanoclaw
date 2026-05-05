/**
 * Handler-level tests. The shared main-control gate has its own integration
 * test (../taskflow/permission.test.ts); here we mock the helper to a
 * controllable boolean and exercise the handler's logic above and below it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '../../channels/adapter.js';
import type { Session } from '../../types.js';

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

let mockWhatsAppAdapter: Partial<ChannelAdapter> | undefined;
let gateAllow: boolean;

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn((channelType: string) => {
    if (channelType === 'whatsapp') return mockWhatsAppAdapter;
    return undefined;
  }),
}));

vi.mock('../taskflow/permission.js', () => ({
  checkMainControlSession: vi.fn(() => gateAllow),
}));

beforeEach(() => {
  gateAllow = true;
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

describe('handleSendOtp', () => {
  it('drops when the gate denies', async () => {
    gateAllow = false;
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      fakeSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('on gate-allow + valid input, calls lookupPhoneJid then deliver with OBJECT content', async () => {
    const { handleSendOtp } = await import('./handler.js');
    await handleSendOtp(
      { action: 'send_otp', phone: '+5585999991234', message: 'Codigo: 123456' },
      fakeSession,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.lookupPhoneJid).toHaveBeenCalledWith('+5585999991234');
    expect(mockWhatsAppAdapter!.deliver).toHaveBeenCalledOnce();
    const deliverArgs = (mockWhatsAppAdapter!.deliver as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(deliverArgs[0]).toBe('5585999991234@s.whatsapp.net');
    expect(deliverArgs[1]).toBeNull();
    const payload = deliverArgs[2];
    expect(payload.kind).toBe('chat');
    // Adapter casts message.content to Record<string,unknown> with no JSON.parse;
    // a stringified content silently no-ops, so this assertion is load-bearing.
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
