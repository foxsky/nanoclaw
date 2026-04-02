import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcDeps, IpcHandler } from '../ipc.js';
import { register } from './send-otp.js';

describe('send_otp IPC plugin', () => {
  let handler: IpcHandler;
  let deps: IpcDeps;
  let sendMessage: ReturnType<typeof vi.fn>;
  let lookupPhoneJid: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let registered: IpcHandler | undefined;
    register((type, candidate) => {
      if (type === 'send_otp') registered = candidate;
    });
    if (!registered) throw new Error('send_otp handler not registered');
    handler = registered;

    sendMessage = vi.fn(async () => {});
    lookupPhoneJid = vi.fn(async () => '5585999991234@s.whatsapp.net');

    deps = {
      sendMessage: sendMessage as IpcDeps['sendMessage'],
      registeredGroups: () => ({}),
      registerGroup: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      lookupPhoneJid: lookupPhoneJid as IpcDeps['lookupPhoneJid'],
      onTasksChanged: () => {},
    };
  });

  it('registers handler for send_otp type', () => {
    let registeredType: string | undefined;
    register((type) => {
      registeredType = type;
    });
    expect(registeredType).toBe('send_otp');
  });

  it('sends the OTP message when the phone exists on WhatsApp', async () => {
    await handler(
      {
        type: 'send_otp',
        phone: '+55 85 99999-1234',
        message: 'Seu codigo: 123456',
      },
      'main',
      true,
      deps,
    );

    expect(lookupPhoneJid).toHaveBeenCalledOnce();
    expect(lookupPhoneJid).toHaveBeenCalledWith('+55 85 99999-1234');
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      '5585999991234@s.whatsapp.net',
      'Seu codigo: 123456',
    );
  });

  it('rejects requests from non-main groups', async () => {
    await handler(
      {
        type: 'send_otp',
        phone: '+5585999991234',
        message: 'Seu codigo: 123456',
      },
      'taskflow-group',
      false,
      deps,
    );

    expect(lookupPhoneJid).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send when the phone is not on WhatsApp', async () => {
    lookupPhoneJid.mockResolvedValueOnce(null);

    await handler(
      {
        type: 'send_otp',
        phone: '+5585999991234',
        message: 'Seu codigo: 123456',
      },
      'main',
      true,
      deps,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads', async () => {
    await handler(
      {
        type: 'send_otp',
        phone: '   ' ,
        message: '',
      },
      'main',
      true,
      deps,
    );

    expect(lookupPhoneJid).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
