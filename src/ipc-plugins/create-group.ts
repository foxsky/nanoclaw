import type { IpcHandler } from '../ipc.js';
import { logger } from '../logger.js';

const MAX_GROUP_SUBJECT_LENGTH = 100;
const MAX_GROUP_PARTICIPANTS = 256;
const PARTICIPANT_JID_PATTERN = /^\d{6,20}@s\.whatsapp\.net$/;

function normalizeSubject(subject: unknown): string | null {
  if (typeof subject !== 'string') return null;
  const trimmed = subject.trim();
  if (!trimmed || trimmed.length > MAX_GROUP_SUBJECT_LENGTH) return null;
  return trimmed;
}

function normalizeParticipants(participants: unknown): string[] | null {
  if (!Array.isArray(participants)) return null;
  if (participants.length === 0 || participants.length > MAX_GROUP_PARTICIPANTS) {
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
    // Runtime levels are 0-based; maxDepth is a 1-based depth count
    // (e.g., maxDepth 2 = root + one child). Leaf boards are at level == maxDepth - 1.
    return sourceEntry.taskflowHierarchyLevel + 1 < sourceEntry.taskflowMaxDepth;
  }

  return false;
}

const handleCreateGroup: IpcHandler = async (data, sourceGroup, isMain, deps) => {
  if (!canCreateGroupFromSource(sourceGroup, isMain, deps)) {
    logger.warn({ sourceGroup }, 'Unauthorized create_group attempt blocked');
    return;
  }
  if (!deps.createGroup) {
    logger.warn('create_group handler: no createGroup dep available');
    return;
  }
  const subject = normalizeSubject(data.subject);
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
  try {
    const result = await deps.createGroup(subject, participants);
    logger.info(
      { jid: result.jid, participantCount: participants.length },
      'Group created via IPC',
    );
  } catch (err) {
    logger.error(
      { err, subjectLength: subject.length, participantCount: participants.length },
      'Failed to create group via IPC',
    );
  }
};

export function register(reg: (type: string, handler: IpcHandler) => void): void {
  reg('create_group', handleCreateGroup);
}
