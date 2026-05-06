import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { PARTICIPANT_JID_PATTERN, TASKFLOW_DB_PATH, TASKFLOW_SUFFIX } from './provision-shared.js';
import { nonEmptyString } from './util.js';

const MAX_GROUP_SUBJECT_LENGTH = 100;
const MAX_GROUP_PARTICIPANTS = 256;

function normalizeSubject(subject: unknown): string | null {
  const trimmed = nonEmptyString(subject);
  if (!trimmed || trimmed.length > MAX_GROUP_SUBJECT_LENGTH) return null;
  return trimmed;
}

function normalizeParticipants(participants: unknown): string[] | null {
  if (!Array.isArray(participants)) return null;
  if (participants.length === 0 || participants.length > MAX_GROUP_PARTICIPANTS) return null;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    if (typeof p !== 'string') return null;
    const trimmed = p.trim();
    if (!PARTICIPANT_JID_PATTERN.test(trimmed) || seen.has(trimmed)) return null;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface AuthResult {
  ok: boolean;
  /** True iff the caller is a TaskFlow board (not main-control); drives the
   * `- TaskFlow` suffix-append behavior. */
  isTaskflowSource: boolean;
}

function checkAuth(tfDb: DatabaseType.Database, session: Session): AuthResult {
  // Main-control chat: always allowed; the suffix is NOT auto-appended.
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg?.is_main_control === 1) return { ok: true, isTaskflowSource: false };
  }
  // TaskFlow board with depth headroom: allowed; suffix IS auto-appended.
  const callerAgent = getAgentGroup(session.agent_group_id);
  if (!callerAgent) return { ok: false, isTaskflowSource: false };
  const board = tfDb
    .prepare('SELECT hierarchy_level, max_depth FROM boards WHERE group_folder = ?')
    .get(callerAgent.folder) as { hierarchy_level: number; max_depth: number } | undefined;
  if (!board) return { ok: false, isTaskflowSource: false };
  if (board.hierarchy_level + 1 > board.max_depth) return { ok: false, isTaskflowSource: false };
  return { ok: true, isTaskflowSource: true };
}

export async function handleCreateGroup(
  content: Record<string, unknown>,
  session: Session,
  _inDb: DatabaseType.Database,
): Promise<void> {
  const tfDb = new Database(TASKFLOW_DB_PATH);
  try {
    const auth = checkAuth(tfDb, session);
    if (!auth.ok) {
      log.warn('create_group: unauthorized session', {
        sessionId: session.id,
        messagingGroupId: session.messaging_group_id,
        agentGroupId: session.agent_group_id,
      });
      return;
    }

    let subject = normalizeSubject(content.subject);
    const participants = normalizeParticipants(content.participants);
    if (!subject || !participants) {
      log.warn('create_group: invalid payload', {
        sessionId: session.id,
        subjectValid: !!subject,
        participantCount: Array.isArray(content.participants) ? content.participants.length : 0,
      });
      return;
    }

    if (auth.isTaskflowSource && !subject.endsWith(TASKFLOW_SUFFIX)) {
      const suffixed = subject + TASKFLOW_SUFFIX;
      if (suffixed.length <= MAX_GROUP_SUBJECT_LENGTH) subject = suffixed;
    }

    const adapter = getChannelAdapter('whatsapp');
    if (!adapter || !adapter.createGroup) {
      log.warn('create_group: WhatsApp adapter missing createGroup capability', { sessionId: session.id });
      return;
    }

    let resolved = participants;
    if (adapter.resolvePhoneJid) {
      const resolvedAll = await Promise.all(
        participants.map(async (jid) => {
          const phone = jid.replace(/@s\.whatsapp\.net$/, '');
          return adapter.resolvePhoneJid!(phone);
        }),
      );
      // Two distinct input JIDs can resolve to the same canonical JID (phone-
      // number migration on WhatsApp, aliased numbers). groupCreate rejects or
      // silently drops duplicates, so dedupe after resolution while preserving
      // input order.
      const seen = new Set<string>();
      resolved = resolvedAll.filter((jid) => (seen.has(jid) ? false : (seen.add(jid), true)));
    }

    try {
      const result = await adapter.createGroup(subject, resolved);
      log.info('create_group: WhatsApp group created', {
        jid: result.jid,
        subject: result.subject,
        participantCount: participants.length,
      });
    } catch (err) {
      log.error('create_group: failed to create WhatsApp group', {
        err,
        subjectLength: subject.length,
        participantCount: participants.length,
      });
    }
  } finally {
    tfDb.close();
  }
}
