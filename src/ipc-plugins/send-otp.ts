import type { IpcHandler } from '../ipc.js';
import { logger } from '../log.js';

function normalizePhone(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  return trimmed || null;
}

function normalizeMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed || null;
}

const handleSendOtp: IpcHandler = async (data, sourceGroup, isMain, deps) => {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'send_otp: only main group may send OTP messages');
    return;
  }

  if (!deps.lookupPhoneJid) {
    logger.warn('send_otp: no lookupPhoneJid dep available');
    return;
  }

  const phone = normalizePhone(data.phone);
  const message = normalizeMessage(data.message);
  if (!phone || !message) {
    logger.warn({ sourceGroup, hasPhone: !!phone, hasMessage: !!message }, 'send_otp: invalid payload');
    return;
  }

  const jid = await deps.lookupPhoneJid(phone);
  if (!jid) {
    logger.warn({ phone, sourceGroup }, 'send_otp: phone is not on WhatsApp');
    return;
  }

  await deps.sendMessage(jid, message);
  logger.info({ jid, sourceGroup }, 'OTP delivered via IPC');
};

export function register(reg: (type: string, handler: IpcHandler) => void): void {
  reg('send_otp', handleSendOtp);
}
