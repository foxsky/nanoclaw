import type Database from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { checkMainControlSession } from '../taskflow/permission.js';
import { nonEmptyString } from '../taskflow/util.js';

/**
 * Fire-and-forget: the v2 system action path returns void
 * (delivery.ts:255), so caller never sees an error response — same as v1
 * IPC handlers, by design.
 */
export async function handleSendOtp(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  if (!checkMainControlSession(session, 'send_otp')) return;

  const phone = nonEmptyString(content.phone);
  const message = nonEmptyString(content.message);
  if (!phone || !message) {
    log.warn('send_otp: invalid payload', {
      sessionId: session.id,
      hasPhone: !!phone,
      hasMessage: !!message,
    });
    return;
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.lookupPhoneJid) {
    log.warn('send_otp: WhatsApp adapter unavailable', { sessionId: session.id });
    return;
  }

  const jid = await adapter.lookupPhoneJid(phone);
  if (!jid) {
    log.warn('send_otp: phone not on WhatsApp', { sessionId: session.id, phone });
    return;
  }

  // The WhatsApp adapter casts message.content to Record<string,unknown>
  // without JSON.parse; passing a stringified content silently no-ops.
  await adapter.deliver(jid, null, {
    kind: 'chat',
    content: { type: 'text', text: message },
  });
  log.info('send_otp delivered', { sessionId: session.id, jid });
}
