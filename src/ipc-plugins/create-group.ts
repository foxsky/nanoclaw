import type { IpcHandler } from '../ipc.js';
import { logger } from '../logger.js';
import {
  PARTICIPANT_JID_PATTERN,
  TASKFLOW_SUFFIX,
} from './provision-shared.js';

const MAX_GROUP_SUBJECT_LENGTH = 100;
const MAX_GROUP_PARTICIPANTS = 256;

function normalizeSubject(subject: unknown): string | null {
  if (typeof subject !== 'string') return null;
  const trimmed = subject.trim();
  if (!trimmed || trimmed.length > MAX_GROUP_SUBJECT_LENGTH) return null;
  return trimmed;
}

function normalizeParticipants(participants: unknown): string[] | null {
  if (!Array.isArray(participants)) return null;
  if (
    participants.length === 0 ||
    participants.length > MAX_GROUP_PARTICIPANTS
  ) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const participant of participants) {
    if (typeof participant !== 'string') return null;
    const trimmed = participant.trim();
    if (!PARTICIPANT_JID_PATTERN.test(trimmed) || seen.has(trimmed)) {
      return null;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function canCreateGroupFromSource(
  sourceGroup: string,
  isMain: boolean,
  deps: Parameters<IpcHandler>[3],
): boolean {
  if (isMain) return true;

  const sourceEntry = Object.values(deps.registeredGroups()).find(
    (group) => group.folder === sourceGroup,
  );

  if (!sourceEntry || sourceEntry.taskflowManaged !== true) {
    return false;
  }

  if (
    sourceEntry.taskflowHierarchyLevel !== undefined &&
    sourceEntry.taskflowMaxDepth !== undefined
  ) {
    // Runtime levels are 0-based while maxDepth is the board depth ceiling.
    // A group may create one more level only if the next runtime level still
    // fits under the configured maximum depth.
    return (
      sourceEntry.taskflowHierarchyLevel + 1 <= sourceEntry.taskflowMaxDepth
    );
  }

  return false;
}

const handleCreateGroup: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  if (!canCreateGroupFromSource(sourceGroup, isMain, deps)) {
    logger.warn({ sourceGroup }, 'Unauthorized create_group attempt blocked');
    return;
  }
  if (!deps.createGroup) {
    logger.warn('create_group handler: no createGroup dep available');
    return;
  }
  // If we reached here with !isMain, the auth check above already confirmed
  // this is a valid TaskFlow source (managed + within depth limit).
  const isTaskflowSource = !isMain;
  let subject = normalizeSubject(data.subject);
  const participants = normalizeParticipants(data.participants);
  if (!subject || !participants) {
    logger.warn(
      {
        sourceGroup,
        subjectValid: !!subject,
        participantCount: Array.isArray(data.participants)
          ? data.participants.length
          : undefined,
      },
      'Invalid create_group request',
    );
    return;
  }
  if (isTaskflowSource && !subject.endsWith(TASKFLOW_SUFFIX)) {
    const suffixed = subject + TASKFLOW_SUFFIX;
    if (suffixed.length <= MAX_GROUP_SUBJECT_LENGTH) {
      subject = suffixed;
    }
  }

  try {
    // Resolve participant JIDs via WhatsApp lookup when available
    let resolvedParticipants = participants;
    if (deps.resolvePhoneJid) {
      resolvedParticipants = await Promise.all(
        participants.map(async (jid) => {
          const phone = jid.replace(/@s\.whatsapp\.net$/, '');
          return deps.resolvePhoneJid!(phone);
        }),
      );
      // Two distinct input JIDs can resolve to the same canonical JID (e.g.
      // phone-number migration on WhatsApp, or aliased numbers). WhatsApp's
      // groupCreate rejects or silently drops duplicate participants, so
      // dedupe after resolution while preserving input order.
      const seenResolved = new Set<string>();
      resolvedParticipants = resolvedParticipants.filter((jid) => {
        if (seenResolved.has(jid)) return false;
        seenResolved.add(jid);
        return true;
      });
    }

    const result = await deps.createGroup(subject, resolvedParticipants);
    logger.info(
      { jid: result.jid, participantCount: participants.length },
      'Group created via IPC',
    );
  } catch (err) {
    logger.error(
      {
        err,
        subjectLength: subject.length,
        participantCount: participants.length,
      },
      'Failed to create group via IPC',
    );
  }
};

export function register(
  reg: (type: string, handler: IpcHandler) => void,
): void {
  reg('create_group', handleCreateGroup);
}
