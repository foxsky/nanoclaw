/**
 * Delivery-action handler for `send_otp` — agent-initiated WhatsApp OTP send.
 *
 * The container-side MCP tool writes a `kind: 'system'` outbound row carrying
 * `{ action: 'send_otp', phone, message }`. The host's delivery loop dispatches
 * here.
 *
 * Permission gate (C1, Codex 2026-05-04): only sessions whose agent group is
 * marked `is_main_control = 1` may trigger an OTP send. This is the v2
 * equivalent of v1's `registered_groups.isMain` — at most one row in
 * `agent_groups` may have value 1 (enforced by partial unique index).
 *
 * If the gate fails, the action is silently dropped with a warn log. Same
 * behavior as v1 — the agent gets no error response because the v2 system
 * action path is fire-and-forget (delivery.ts:255 `await handleSystemAction`
 * returns void).
 */
import type Database from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function handleSendOtp(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  // 1. C1 permission gate — fail closed if the session's agent group is not
  //    the main control. Also fail closed if the row is missing entirely (a
  //    stale agent_group_id pointing nowhere is treated like "not main",
  //    not like an exception, to keep the path silent).
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup || agentGroup.is_main_control !== 1) {
    log.warn('send_otp: agent group not authorized (is_main_control != 1)', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      hasGroup: !!agentGroup,
    });
    return;
  }

  // 2. Validate payload.
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

  // 3. Resolve the WhatsApp adapter. Without it (skill not installed,
  //    credentials missing) we silently drop — there is no fallback channel.
  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.lookupPhoneJid) {
    log.warn('send_otp: WhatsApp adapter unavailable', { sessionId: session.id });
    return;
  }

  // 4. Look up the JID. If the phone isn't on WhatsApp, skip — same as v1.
  const jid = await adapter.lookupPhoneJid(phone);
  if (!jid) {
    log.warn('send_otp: phone not on WhatsApp', { sessionId: session.id, phone });
    return;
  }

  // 5. Deliver the message. Use the standard chat content envelope so it
  //    flows through normalization the same way an agent-sent reply would.
  await adapter.deliver(jid, null, {
    kind: 'chat',
    content: JSON.stringify({ type: 'text', text: message }),
  });
  log.info('send_otp delivered', { sessionId: session.id, jid });
}
