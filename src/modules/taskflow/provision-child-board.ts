import Database from 'better-sqlite3';
import path from 'path';
import type DatabaseType from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { createAgentGroup, getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getAllMessagingGroups,
  getMessagingGroup,
} from '../../db/messaging-groups.js';
import { isValidGroupFolder } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { normalizePhone } from '../../phone.js';
import type { Session } from '../../types.js';
import {
  createBoardFilesystem,
  fixOwnership,
  sanitizeFolder,
  scheduleOnboarding,
  scheduleRunners,
  TASKFLOW_DB_PATH,
  uniqueFolder,
  type BoardConfigRow,
  type BoardRow,
  type BoardRuntimeConfigRow,
} from './provision-shared.js';
import { newTaskId, nonEmptyString } from './util.js';

const REQUIRED = ['person_id', 'person_name', 'person_phone', 'person_role'] as const;

interface ParsedInput {
  personId: string;
  personName: string;
  personPhone: string;
  personRole: string;
  shortCode: string | null;
  groupFolderOverride: string | null;
  groupNameOverride: string | null;
  triggerTurnId: string | null;
}

function parseInput(content: Record<string, unknown>): ParsedInput | null {
  for (const field of REQUIRED) {
    if (!nonEmptyString(content[field])) return null;
  }
  return {
    personId: nonEmptyString(content.person_id)!,
    personName: nonEmptyString(content.person_name)!,
    personPhone: nonEmptyString(content.person_phone)!,
    personRole: nonEmptyString(content.person_role)!,
    shortCode: nonEmptyString(content.short_code)?.toUpperCase() ?? null,
    groupFolderOverride: nonEmptyString(content.group_folder),
    groupNameOverride: nonEmptyString(content.group_name),
    triggerTurnId: nonEmptyString(content.trigger_turn_id),
  };
}

interface ParentLookup {
  parentBoard: BoardRow;
  parentConfig: BoardConfigRow;
  parentRuntime: BoardRuntimeConfigRow;
  callerName: string;
  sourceMessagingGroupPlatformId: string | null;
}

function loadParent(tfDb: DatabaseType.Database, session: Session): ParentLookup | null {
  const callerAgent = getAgentGroup(session.agent_group_id);
  if (!callerAgent) {
    log.warn('provision_child_board: caller agent_group not found', { sessionId: session.id });
    return null;
  }
  const parentBoard = tfDb.prepare('SELECT * FROM boards WHERE group_folder = ?').get(callerAgent.folder) as
    | BoardRow
    | undefined;
  if (!parentBoard) {
    log.warn("provision_child_board: caller's session is not a TaskFlow board", {
      sessionId: session.id,
      folder: callerAgent.folder,
    });
    return null;
  }
  if (parentBoard.hierarchy_level + 1 > parentBoard.max_depth) {
    log.warn('provision_child_board: leaf board cannot create children', {
      boardId: parentBoard.id,
      level: parentBoard.hierarchy_level,
      maxDepth: parentBoard.max_depth,
    });
    return null;
  }
  const parentConfig = tfDb.prepare('SELECT * FROM board_config WHERE board_id = ?').get(parentBoard.id) as
    | BoardConfigRow
    | undefined;
  const parentRuntime = tfDb.prepare('SELECT * FROM board_runtime_config WHERE board_id = ?').get(parentBoard.id) as
    | BoardRuntimeConfigRow
    | undefined;
  if (!parentConfig || !parentRuntime) {
    log.warn('provision_child_board: parent config/runtime missing', { boardId: parentBoard.id });
    return null;
  }
  const sourceMg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : null;
  return {
    parentBoard,
    parentConfig,
    parentRuntime,
    callerName: callerAgent.name,
    sourceMessagingGroupPlatformId: sourceMg?.platform_id ?? null,
  };
}

interface ExistingBoardMatch {
  child_board_id: string;
  person_id: string;
  group_jid: string;
  group_folder: string;
  phone: string;
}

function findExistingBoardElsewhere(
  tfDb: DatabaseType.Database,
  parentBoardId: string,
  personId: string,
  canonicalPhone: string,
): ExistingBoardMatch | null {
  if (canonicalPhone.length < 10) return null;

  const idMatchRows = tfDb
    .prepare(
      `SELECT cbr.child_board_id, cbr.person_id, b.group_jid, b.group_folder, bp.phone
         FROM child_board_registrations cbr
         JOIN boards b ON b.id = cbr.child_board_id
         JOIN board_people bp ON bp.board_id = cbr.child_board_id AND bp.person_id = cbr.person_id
        WHERE cbr.person_id = ?
          AND cbr.parent_board_id != ?
          AND bp.phone IS NOT NULL`,
    )
    .all(personId, parentBoardId) as ExistingBoardMatch[];
  const idMatch = idMatchRows.find((c) => normalizePhone(c.phone) === canonicalPhone);
  if (idMatch) return idMatch;

  const phoneMatchRows = tfDb
    .prepare(
      `SELECT cbr.child_board_id, cbr.person_id, b.group_jid, b.group_folder, bp.phone
         FROM child_board_registrations cbr
         JOIN boards b ON b.id = cbr.child_board_id
         JOIN board_people bp ON bp.board_id = cbr.child_board_id AND bp.person_id = cbr.person_id
        WHERE bp.phone IS NOT NULL
          AND cbr.parent_board_id != ?`,
    )
    .all(parentBoardId) as ExistingBoardMatch[];
  return phoneMatchRows.find((c) => normalizePhone(c.phone) === canonicalPhone) ?? null;
}

function linkExistingBoardToParent(
  tfDb: DatabaseType.Database,
  parentBoard: BoardRow,
  parsed: ParsedInput,
  existing: ExistingBoardMatch,
): void {
  const existingPersonId = existing.person_id;

  tfDb.transaction(() => {
    if (existingPersonId !== parsed.personId) {
      log.info('provision_child_board: unifying person_id to match existing board', {
        from: parsed.personId,
        to: existingPersonId,
      });
      const dupBp = tfDb
        .prepare('SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?')
        .get(parentBoard.id, existingPersonId);
      if (dupBp) {
        tfDb
          .prepare('DELETE FROM board_people WHERE board_id = ? AND person_id = ?')
          .run(parentBoard.id, parsed.personId);
      } else {
        tfDb
          .prepare('UPDATE board_people SET person_id = ? WHERE board_id = ? AND person_id = ?')
          .run(existingPersonId, parentBoard.id, parsed.personId);
      }
      tfDb
        .prepare('UPDATE tasks SET assignee = ? WHERE board_id = ? AND assignee = ?')
        .run(existingPersonId, parentBoard.id, parsed.personId);
      const dupAdmin = tfDb
        .prepare('SELECT 1 FROM board_admins WHERE board_id = ? AND person_id = ?')
        .get(parentBoard.id, existingPersonId);
      if (dupAdmin) {
        tfDb
          .prepare('DELETE FROM board_admins WHERE board_id = ? AND person_id = ?')
          .run(parentBoard.id, parsed.personId);
      } else {
        tfDb
          .prepare('UPDATE board_admins SET person_id = ? WHERE board_id = ? AND person_id = ?')
          .run(existingPersonId, parentBoard.id, parsed.personId);
      }
    }

    const unifiedId = existingPersonId;

    tfDb
      .prepare(
        `INSERT OR IGNORE INTO child_board_registrations (parent_board_id, person_id, child_board_id)
           VALUES (?, ?, ?)`,
      )
      .run(parentBoard.id, unifiedId, existing.child_board_id);

    // notification_group_jid only updates when target differs from parent group
    // (avoids double-delivery when parent and child share a group).
    if (existing.group_jid && existing.group_jid !== parentBoard.group_jid) {
      tfDb
        .prepare('UPDATE board_people SET notification_group_jid = ? WHERE board_id = ? AND person_id = ?')
        .run(existing.group_jid, parentBoard.id, unifiedId);
    }

    tfDb
      .prepare(
        `UPDATE tasks SET child_exec_board_id = ?, child_exec_enabled = 1, child_exec_person_id = ?
           WHERE board_id = ? AND assignee = ? AND child_exec_board_id IS NULL`,
      )
      .run(existing.child_board_id, unifiedId, parentBoard.id, unifiedId);
  })();

  log.info('provision_child_board: existing board linked', {
    parentBoardId: parentBoard.id,
    childBoardId: existing.child_board_id,
  });
}

function computeChildFolderAndName(parsed: ParsedInput): { folder: string; name: string } | null {
  const baseFolder = parsed.groupFolderOverride || sanitizeFolder(parsed.personId) + '-taskflow';
  if (!parsed.groupFolderOverride) {
    log.warn('provision_child_board: group_folder not provided, falling back to person-based name', {
      personId: parsed.personId,
      fallbackFolder: baseFolder,
    });
  }
  const existingFolders = new Set(getAllAgentGroups().map((ag) => ag.folder));
  const folder = uniqueFolder(baseFolder, existingFolders);
  if (!isValidGroupFolder(folder)) {
    log.warn('provision_child_board: invalid group folder name', { folder });
    return null;
  }

  let name = parsed.groupNameOverride || `${parsed.personName} - TaskFlow`;
  // messaging_groups.name IS the chat's display title (the WhatsApp group
  // subject). Two children can't share a subject — append (personName) to
  // disambiguate, matching v1.
  const existingNames = new Set(
    getAllMessagingGroups()
      .map((mg) => mg.name)
      .filter((n): n is string => !!n),
  );
  if (existingNames.has(name)) {
    const withSuffix = name.replace(/ - TaskFlow$/, ` (${parsed.personName}) - TaskFlow`);
    name = withSuffix !== name ? withSuffix : `${name} (${parsed.personName})`;
  }

  return { folder, name };
}

async function deliverPlainText(
  adapter: NonNullable<ReturnType<typeof getChannelAdapter>>,
  platformId: string,
  text: string,
): Promise<void> {
  await adapter.deliver(platformId, null, {
    kind: 'chat',
    content: { type: 'text', text },
  });
}

function seedChildTaskflow(
  tfDb: DatabaseType.Database,
  parsed: ParsedInput,
  parent: ParentLookup,
  childBoardId: string,
  childFolder: string,
  childGroupJid: string,
  ts: string,
): { linkedTasks: number } {
  const canonicalPhone = normalizePhone(parsed.personPhone) || parsed.personPhone;
  const { parentBoard, parentConfig, parentRuntime } = parent;

  // Defensive: provisioning may run against an old-schema taskflow.db
  // without task_history.trigger_turn_id; ALTER is no-op if column exists.
  try {
    tfDb.exec(`ALTER TABLE task_history ADD COLUMN trigger_turn_id TEXT`);
  } catch {
    // already present
  }

  let linkedTasks = 0;

  tfDb.transaction(() => {
    tfDb
      .prepare(
        'INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code, owner_person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        childBoardId,
        childGroupJid,
        childFolder,
        'hierarchy',
        parentBoard.hierarchy_level + 1,
        parentBoard.max_depth,
        parentBoard.id,
        parsed.shortCode,
        parsed.personId,
      );

    tfDb
      .prepare('INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, ?, ?)')
      .run(parentBoard.id, parsed.personId, childBoardId);

    tfDb
      .prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, ?)')
      .run(childBoardId, parentConfig.wip_limit);

    tfDb
      .prepare(
        `INSERT INTO board_runtime_config (
           board_id, language, timezone,
           standup_cron_local, digest_cron_local, review_cron_local,
           standup_cron_utc, digest_cron_utc, review_cron_utc,
           attachment_enabled, attachment_disabled_reason,
           dst_sync_enabled
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        childBoardId,
        parentRuntime.language,
        parentRuntime.timezone,
        parentRuntime.standup_cron_local,
        parentRuntime.digest_cron_local,
        parentRuntime.review_cron_local,
        parentRuntime.standup_cron_utc,
        parentRuntime.digest_cron_utc,
        parentRuntime.review_cron_utc,
        parentRuntime.attachment_enabled,
        parentRuntime.attachment_disabled_reason,
        parentRuntime.dst_sync_enabled,
      );

    tfDb
      .prepare(
        'INSERT INTO board_admins (board_id, person_id, phone, admin_role, is_primary_manager) VALUES (?, ?, ?, ?, ?)',
      )
      .run(childBoardId, parsed.personId, canonicalPhone, 'manager', 1);

    tfDb
      .prepare(
        'INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit, notification_group_jid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        childBoardId,
        parsed.personId,
        parsed.personName,
        canonicalPhone,
        parsed.personRole,
        parentConfig.wip_limit,
        null,
      );

    tfDb
      .prepare('UPDATE board_people SET notification_group_jid = ? WHERE board_id = ? AND person_id = ?')
      .run(childGroupJid, parentBoard.id, parsed.personId);

    const linked = tfDb
      .prepare(
        `UPDATE tasks
            SET child_exec_enabled = 1,
                child_exec_board_id = ?,
                child_exec_person_id = ?,
                column = CASE WHEN column = 'inbox' THEN 'next_action' ELSE column END,
                updated_at = ?
          WHERE board_id = ? AND assignee = ? AND child_exec_enabled = 0`,
      )
      .run(childBoardId, parsed.personId, ts, parentBoard.id, parsed.personId);
    linkedTasks = linked.changes;

    tfDb
      .prepare(
        'INSERT INTO task_history (board_id, task_id, action, by, at, details, trigger_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        parentBoard.id,
        '',
        'child_board_created',
        parsed.personId,
        ts,
        JSON.stringify({ child_board_id: childBoardId, person_id: parsed.personId, auto_provisioned: true }),
        parsed.triggerTurnId,
      );
  })();

  return { linkedTasks };
}

function wireChildV2(
  parent: ParentLookup,
  childAgentGroupId: string,
  folder: string,
  childGroupJid: string,
  childGroupName: string,
): void {
  const ts = new Date().toISOString();
  // Atomic: the 3 inserts (agent_group + messaging_group + wiring) MUST land
  // together — a partial state would leave taskflow.db pointing at a folder
  // that has no live agent, and a retry would see a folder collision.
  getDb().transaction(() => {
    createAgentGroup({
      id: childAgentGroupId,
      name: parent.callerName,
      folder,
      agent_provider: 'claude',
      created_at: ts,
    });

    const messagingGroupId = newTaskId('mg');
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: 'whatsapp',
      platform_id: childGroupJid,
      name: childGroupName,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: ts,
    });

    createMessagingGroupAgent({
      id: newTaskId('mga'),
      messaging_group_id: messagingGroupId,
      agent_group_id: childAgentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: ts,
    });
  })();
}

function buildWelcomeMessage(childGroupName: string): string {
  return `👋 *Bem-vindo ao ${childGroupName}!*\n\nEste é o seu quadro de tarefas pessoal. Aqui você receberá suas tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para ver os comandos disponíveis.`;
}

function buildConfirmationMessage(parsed: ParsedInput, childGroupName: string, childBoardId: string): string {
  return `✅ Quadro de ${parsed.personName} provisionado automaticamente.\n\nGrupo: ${childGroupName}\nQuadro: ${childBoardId}\n\nO quadro estará disponível na próxima interação.`;
}

function buildInviteLinkMessage(
  childGroupName: string,
  personName: string,
  inviteLink: string,
  droppedParticipants: string[] | undefined,
): string {
  const dropped = droppedParticipants?.length
    ? `\n⚠️ Não foi possível adicionar: ${droppedParticipants.map((p) => p.split('@')[0]).join(', ')}`
    : '';
  return `📎 Link de convite para o grupo *${childGroupName}* (${personName}):\n${inviteLink}${dropped}`;
}

export async function handleProvisionChildBoard(
  content: Record<string, unknown>,
  session: Session,
  _inDb: DatabaseType.Database,
): Promise<void> {
  const parsed = parseInput(content);
  if (!parsed) {
    log.warn('provision_child_board: missing required fields', { sessionId: session.id });
    return;
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.createGroup) {
    log.warn('provision_child_board: WhatsApp adapter missing createGroup capability', { sessionId: session.id });
    return;
  }

  const tfDb = new Database(TASKFLOW_DB_PATH);
  try {
    const parent = loadParent(tfDb, session);
    if (!parent) return;

    const alreadyOnThisParent = tfDb
      .prepare('SELECT 1 FROM child_board_registrations WHERE parent_board_id = ? AND person_id = ?')
      .get(parent.parentBoard.id, parsed.personId);
    if (alreadyOnThisParent) {
      log.warn('provision_child_board: child board already registered for this person', {
        parentBoardId: parent.parentBoard.id,
        personId: parsed.personId,
      });
      return;
    }

    const canonicalPhone = normalizePhone(parsed.personPhone);
    const existingElsewhere = findExistingBoardElsewhere(tfDb, parent.parentBoard.id, parsed.personId, canonicalPhone);
    if (existingElsewhere) {
      try {
        linkExistingBoardToParent(tfDb, parent.parentBoard, parsed, existingElsewhere);
      } catch (err) {
        log.error('provision_child_board: failed to link existing board', {
          err,
          parentBoardId: parent.parentBoard.id,
          personId: parsed.personId,
        });
      }
      return;
    }

    const folderAndName = computeChildFolderAndName(parsed);
    if (!folderAndName) return;
    const { folder, name: childGroupName } = folderAndName;
    const childBoardId = `board-${folder}`;

    let createResult: Awaited<ReturnType<NonNullable<typeof adapter.createGroup>>>;
    try {
      const participantJid = adapter.resolvePhoneJid
        ? await adapter.resolvePhoneJid(parsed.personPhone)
        : `${canonicalPhone || parsed.personPhone}@s.whatsapp.net`;
      createResult = await adapter.createGroup(childGroupName, [participantJid]);
      log.info('provision_child_board: WhatsApp group created', {
        jid: createResult.jid,
        subject: createResult.subject,
        inviteLink: createResult.inviteLink,
      });
    } catch (err) {
      log.error('provision_child_board: failed to create WhatsApp group', { err, childGroupName });
      return;
    }
    const childGroupJid = createResult.jid;

    if (createResult.inviteLink && parent.sourceMessagingGroupPlatformId) {
      try {
        await deliverPlainText(
          adapter,
          parent.sourceMessagingGroupPlatformId,
          buildInviteLinkMessage(
            childGroupName,
            parsed.personName,
            createResult.inviteLink,
            createResult.droppedParticipants,
          ),
        );
      } catch (err) {
        log.error('provision_child_board: failed to deliver invite link (non-fatal)', { err });
      }
    }

    const ts = new Date().toISOString();
    let linkedTasks = 0;
    try {
      ({ linkedTasks } = seedChildTaskflow(tfDb, parsed, parent, childBoardId, folder, childGroupJid, ts));
      log.info('provision_child_board: taskflow DB seeded', {
        childBoardId,
        parentBoardId: parent.parentBoard.id,
        linkedTasks,
      });
    } catch (err) {
      log.error('provision_child_board: failed to seed taskflow DB', { err, childBoardId });
      return;
    }

    const childAgentGroupId = newTaskId('ag');
    try {
      wireChildV2(parent, childAgentGroupId, folder, childGroupJid, childGroupName);
      log.info('provision_child_board: v2 wiring complete', { childAgentGroupId, folder, childGroupJid });
    } catch (err) {
      log.error('provision_child_board: failed to wire v2', { err, childAgentGroupId });
      return;
    }

    try {
      initGroupFilesystem({
        id: childAgentGroupId,
        name: parent.callerName,
        folder,
        agent_provider: 'claude',
        created_at: ts,
      });
      createBoardFilesystem({
        groupFolder: folder,
        assistantName: parent.callerName,
        personName: parsed.personName,
        personPhone: parsed.personPhone,
        personId: parsed.personId,
        language: parent.parentRuntime.language,
        timezone: parent.parentRuntime.timezone,
        wipLimit: parent.parentConfig.wip_limit,
        boardId: childBoardId,
        groupName: childGroupName,
        groupContext: `${parsed.personName}'s tasks (private standup channel)`,
        groupJid: childGroupJid,
        boardRole: 'hierarchy',
        hierarchyLevel: parent.parentBoard.hierarchy_level + 1,
        maxDepth: parent.parentBoard.max_depth,
        parentBoardId: parent.parentBoard.id,
        standupCronUtc: parent.parentRuntime.standup_cron_utc,
        digestCronUtc: parent.parentRuntime.digest_cron_utc,
        reviewCronUtc: parent.parentRuntime.review_cron_utc,
        standupCronLocal: parent.parentRuntime.standup_cron_local,
        digestCronLocal: parent.parentRuntime.digest_cron_local,
        reviewCronLocal: parent.parentRuntime.review_cron_local,
        attachmentEnabled: !!parent.parentRuntime.attachment_enabled,
        attachmentReason: parent.parentRuntime.attachment_disabled_reason,
        dstGuardEnabled: !!parent.parentRuntime.dst_sync_enabled,
      });
    } catch (err) {
      log.error('provision_child_board: filesystem step failed (non-fatal)', { err, folder });
    }

    try {
      scheduleRunners({
        tfDb,
        boardId: childBoardId,
        groupFolder: folder,
        groupJid: childGroupJid,
        standupCronUtc: parent.parentRuntime.standup_cron_utc,
        digestCronUtc: parent.parentRuntime.digest_cron_utc,
        reviewCronUtc: parent.parentRuntime.review_cron_utc,
        now: ts,
      });
    } catch (err) {
      log.error('provision_child_board: failed to schedule runners (non-fatal)', { err });
    }

    fixOwnership(
      path.join(GROUPS_DIR, folder),
      path.join(DATA_DIR, 'v2-sessions', childAgentGroupId),
      path.join(DATA_DIR, 'taskflow'),
    );

    if (parent.sourceMessagingGroupPlatformId) {
      try {
        await deliverPlainText(
          adapter,
          parent.sourceMessagingGroupPlatformId,
          buildConfirmationMessage(parsed, childGroupName, childBoardId),
        );
      } catch (err) {
        log.error('provision_child_board: failed to send confirmation (non-fatal)', { err });
      }
    }

    try {
      await deliverPlainText(adapter, childGroupJid, buildWelcomeMessage(childGroupName));
      tfDb.prepare('UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?').run(childBoardId);
    } catch (err) {
      log.error('provision_child_board: failed to send welcome (non-fatal)', { err });
    }

    try {
      scheduleOnboarding(tfDb, {
        groupFolder: folder,
        groupJid: childGroupJid,
        timezone: parent.parentRuntime.timezone,
      });
    } catch (err) {
      log.error('provision_child_board: failed to schedule onboarding (non-fatal)', { err });
    }

    log.info('provision_child_board: complete', {
      childBoardId,
      childGroupJid,
      folder,
      parentBoardId: parent.parentBoard.id,
      personId: parsed.personId,
    });
  } finally {
    tfDb.close();
  }
}
