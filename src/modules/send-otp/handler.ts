/**
 * Delivery-action handler for `send_otp` — agent-initiated WhatsApp OTP send.
 *
 * The container-side MCP tool writes a `kind: 'system'` outbound row carrying
 * `{ action: 'send_otp', phone, message }`. The host's delivery loop dispatches
 * here.
 *
 * Permission gate: only sessions whose ORIGIN CHAT is the operator-designated
 * main control may trigger an OTP send. This is the v2 equivalent of v1's
 * `registered_groups.isMain` — the flag is on the messaging group (chat),
 * not on the agent group. That preserves v1's per-CHAT semantics: an agent
 * wired to multiple chats cannot trigger send_otp from a non-main chat
 * just because it can trigger it from the main chat.
 *
 * If the gate fails, the action is silently dropped with a warn log. Same
 * fire-and-forget behavior as v1 — the agent gets no error response because
 * the v2 system action path is fire-and-forget (delivery.ts:255 returns void).
 */
import type Database from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup, getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
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
  // 1. Permission gate (per-chat). Drop if:
  //    - session has no messaging_group_id (DM-only / orphan session)
  //    - session is agent-shared (`session.messaging_group_id` is whichever
  //      chat first created the session, NOT necessarily the chat that
  //      triggered THIS call — see resolveSession in src/session-manager.ts).
  //      Agent-shared sessions can't reliably identify the trigger chat
  //      from the host side, so we fail-closed; v1 didn't have this mode
  //      so this drop preserves v1 semantics for the modes that match v1
  //      (shared / per-thread).
  //    - the messaging group row is missing (stale fk)
  //    - the messaging group is_main_control != 1
  if (!session.messaging_group_id) {
    log.warn('send_otp: session has no messaging_group_id, dropping', { sessionId: session.id });
    return;
  }
  const wiring = getMessagingGroupAgentByPair(session.messaging_group_id, session.agent_group_id);
  // Missing wiring → fail-closed. The session_mode tag tells us whether
  // session.messaging_group_id is a reliable trigger-source identifier;
  // without the wiring row we can't make that determination.
  if (!wiring) {
    log.warn('send_otp: no wiring row for session, dropping (fail-closed)', {
      sessionId: session.id,
      messagingGroupId: session.messaging_group_id,
      agentGroupId: session.agent_group_id,
    });
    return;
  }
  if (wiring.session_mode === 'agent-shared') {
    log.warn('send_otp: agent-shared sessions cannot reliably identify trigger chat, dropping', {
      sessionId: session.id,
      messagingGroupId: session.messaging_group_id,
    });
    return;
  }
  const messagingGroup = getMessagingGroup(session.messaging_group_id);
  if (!messagingGroup || messagingGroup.is_main_control !== 1) {
    log.warn('send_otp: messaging group not authorized (is_main_control != 1)', {
      sessionId: session.id,
      messagingGroupId: session.messaging_group_id,
      hasGroup: !!messagingGroup,
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
  //    credentials missing) we silently drop — there is no fallback.
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

  // 5. Deliver. Pass `content` as an OBJECT, not a stringified JSON — the
  //    WhatsApp adapter at src/channels/whatsapp.ts:624 reads
  //    `message.content` via cast Record<string, unknown> with no JSON.parse.
  //    Stringifying content silently no-ops (Codex BLOCKER #1 from a123cecd).
  await adapter.deliver(jid, null, {
    kind: 'chat',
    content: { type: 'text', text: message },
  });
  log.info('send_otp delivered', { sessionId: session.id, jid });
}
