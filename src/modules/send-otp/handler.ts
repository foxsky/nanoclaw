import type Database from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { checkMainControlSession } from '../taskflow/permission.js';
import { TASKFLOW_SERVICE_ID } from '../taskflow/service-session.js';
import { nonEmptyString } from '../taskflow/util.js';

/**
 * Fire-and-forget: the v2 system action path returns void
 * (delivery.ts:255), so caller never sees an error response — same as v1
 * IPC handlers, by design.
 *
 * Two entry points share the same WhatsApp delivery core but differ in the
 * trust decision:
 *  - `handleSendOtp` (action `send_otp`): the in-container agent path — gated
 *    on the session's messaging group being main-control.
 *  - `handleServiceSendOtp` (action `service_send_otp`): the FastAPI/dashboard
 *    web-login path (Option A, 2026-06-16) — NO main-control gate, but
 *    fail-closed on session identity (see below). The `service_send_otp` row can
 *    only be produced by the FastAPI subprocess (the container tool gates
 *    emission on getVerbatimIds() and writes only to the service outbound), so a
 *    chat agent can never reach this ungated path.
 *
 * Defense-in-depth (Codex BLOCKER 2026-06-16): the host dispatches every
 * `kind:'system'` row by `content.action` ALONE, so the producer-side
 * getVerbatimIds() guard is not the only line of defense. `handleServiceSendOtp`
 * additionally requires the draining session to BE the synthetic
 * `taskflow-service` session — only the service outbound is drained under that
 * identity. A `service_send_otp` row forged into any normal chat session's
 * outbound is dropped here, fail-loud.
 */
async function deliverOtp(content: Record<string, unknown>, session: Session, source: string): Promise<void> {
  const phone = nonEmptyString(content.phone);
  const message = nonEmptyString(content.message);
  if (!phone || !message) {
    log.warn(`${source}: invalid payload`, {
      sessionId: session.id,
      hasPhone: !!phone,
      hasMessage: !!message,
    });
    return;
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.lookupPhoneJid) {
    log.warn(`${source}: WhatsApp adapter unavailable`, { sessionId: session.id });
    return;
  }

  const jid = await adapter.lookupPhoneJid(phone);
  if (!jid) {
    log.warn(`${source}: phone not on WhatsApp`, { sessionId: session.id, phone });
    return;
  }

  // The WhatsApp adapter casts message.content to Record<string,unknown>
  // without JSON.parse; passing a stringified content silently no-ops.
  await adapter.deliver(jid, null, {
    kind: 'chat',
    content: { type: 'text', text: message },
  });
  log.info(`${source} delivered`, { sessionId: session.id, jid });
}

/** In-container agent OTP — gated on main-control. */
export async function handleSendOtp(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  if (!checkMainControlSession(session, 'send_otp')) return;
  return deliverOtp(content, session, 'send_otp');
}

/** FastAPI/dashboard web-login OTP — TRUSTED (no main-control gate), but
 *  fail-closed on session identity: only the synthetic `taskflow-service`
 *  session drains the service outbound, so a forged `service_send_otp` row in
 *  any other session's outbound is dropped (Codex BLOCKER 2026-06-16). */
export async function handleServiceSendOtp(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  if (session.id !== TASKFLOW_SERVICE_ID || session.agent_group_id !== TASKFLOW_SERVICE_ID) {
    log.warn('service_send_otp: rejected non-service session (fail-closed)', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });
    return;
  }
  return deliverOtp(content, session, 'service_send_otp');
}
