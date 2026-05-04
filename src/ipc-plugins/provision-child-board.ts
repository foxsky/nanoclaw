import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR, PROJECT_ROOT } from '../config.js';
import { getGroupSenderName } from '../group-sender.js';
import { isValidGroupFolder } from '../group-folder.js';
import { getTurnId, type IpcHandler } from '../ipc.js';
import { logger } from '../log.js';
import { normalizePhone } from '../phone.js';

import {
  BoardConfigRow,
  BoardRow,
  BoardRuntimeConfigRow,
  createBoardFilesystem,
  fixOwnership,
  sanitizeFolder,
  scheduleOnboarding,
  scheduleRunners,
  seedAvailableGroupsJson,
  TASKFLOW_DB_PATH,
  uniqueFolder,
} from './provision-shared.js';

const handleProvisionChildBoard: IpcHandler = async (data, sourceGroup, isMain, deps) => {
  // --- 1. Validate source authorization ---
  const registeredGroups = deps.registeredGroups();
  const [sourceGroupJid, sourceEntry] = Object.entries(registeredGroups).find(([, g]) => g.folder === sourceGroup) ?? [
    undefined,
    undefined,
  ];

  if (!sourceEntry || !sourceEntry.taskflowManaged) {
    logger.warn({ sourceGroup }, 'provision_child_board: not a TaskFlow group');
    return;
  }

  if (
    sourceEntry.taskflowHierarchyLevel === undefined ||
    sourceEntry.taskflowMaxDepth === undefined ||
    sourceEntry.taskflowHierarchyLevel + 1 > sourceEntry.taskflowMaxDepth
  ) {
    logger.warn(
      {
        sourceGroup,
        level: sourceEntry.taskflowHierarchyLevel,
        maxDepth: sourceEntry.taskflowMaxDepth,
      },
      'provision_child_board: leaf board cannot create children',
    );
    return;
  }

  if (!deps.createGroup) {
    logger.warn('provision_child_board: no createGroup dep available');
    return;
  }

  const assistantName = getGroupSenderName(sourceEntry.trigger);

  // --- 2. Validate input ---
  const personId = typeof data.person_id === 'string' ? data.person_id.trim() : '';
  const personName = typeof data.person_name === 'string' ? data.person_name.trim() : '';
  const personPhone = typeof data.person_phone === 'string' ? data.person_phone.trim() : '';
  const personRole = typeof data.person_role === 'string' ? data.person_role.trim() : '';
  const shortCode = typeof data.short_code === 'string' ? data.short_code.trim().toUpperCase() : null;
  const triggerTurnId = getTurnId(data) ?? null;

  if (!personId || !personName || !personPhone || !personRole) {
    logger.warn(
      { personId, personName, personPhone: !!personPhone, personRole },
      'provision_child_board: missing required fields',
    );
    return;
  }

  // --- 3. Read parent board info from taskflow.db ---
  let tfDb: Database.Database;
  try {
    tfDb = new Database(TASKFLOW_DB_PATH);
  } catch (err) {
    logger.error({ err }, 'provision_child_board: cannot open taskflow.db');
    return;
  }

  try {
    const parentBoard = tfDb.prepare('SELECT * FROM boards WHERE group_folder = ?').get(sourceGroup) as
      | BoardRow
      | undefined;

    // Defensive: this plugin INSERTs task_history rows with trigger_turn_id
    // below (~L529). On old-schema taskflow.db instances the column is
    // missing and the INSERT would throw. initTaskflowDb adds it too, but
    // provisioning paths may run against DBs that weren't opened through
    // initTaskflowDb — keep the ALTER here.
    try {
      tfDb.exec(`ALTER TABLE task_history ADD COLUMN trigger_turn_id TEXT`);
    } catch {
      // column already exists
    }

    if (!parentBoard) {
      logger.warn({ sourceGroup }, 'provision_child_board: parent board not found');
      return;
    }

    const parentConfig = tfDb.prepare('SELECT * FROM board_config WHERE board_id = ?').get(parentBoard.id) as
      | BoardConfigRow
      | undefined;

    const parentRuntime = tfDb.prepare('SELECT * FROM board_runtime_config WHERE board_id = ?').get(parentBoard.id) as
      | BoardRuntimeConfigRow
      | undefined;

    if (!parentConfig || !parentRuntime) {
      logger.warn({ boardId: parentBoard.id }, 'provision_child_board: parent config/runtime not found');
      return;
    }

    // --- 4. Check person not already registered ---
    const existing = tfDb
      .prepare('SELECT 1 FROM child_board_registrations WHERE parent_board_id = ? AND person_id = ?')
      .get(parentBoard.id, personId);

    if (existing) {
      logger.warn(
        { parentBoardId: parentBoard.id, personId },
        'provision_child_board: child board already registered for this person',
      );
      return;
    }

    // --- 4b. Check if person already has a board under a DIFFERENT parent ---
    // person_id is only unique within a single parent board — two unrelated
    // people on different parent boards can share the same person_id string
    // (e.g., "joao"). Matching on person_id alone would cross-link unrelated
    // people, so we require phone agreement: either person_id match AND phone
    // match, or phone-only match. Name-only matching is intentionally NOT used.
    type ExistingBoardMatch = {
      child_board_id: string;
      person_id: string;
      group_jid: string;
      group_folder: string;
    };
    // Canonicalize both the incoming phone and the stored phones so the
    // match survives 55-prefix inconsistencies (Brazilian numbers get stored
    // with and without the country code, and the old REPLACE chain only
    // stripped separators — not the CC). See src/phone.ts.
    const canonicalPhone = normalizePhone(personPhone);
    const hasUsablePhone = canonicalPhone.length >= 10;
    let existingElsewhere: ExistingBoardMatch | undefined;

    // Primary match: person_id + phone (both must agree, since person_id alone
    // is NOT globally unique across parent boards).
    if (hasUsablePhone) {
      const candidates = tfDb
        .prepare(
          `SELECT cbr.child_board_id, cbr.person_id, b.group_jid, b.group_folder, bp.phone
           FROM child_board_registrations cbr
           JOIN boards b ON b.id = cbr.child_board_id
           JOIN board_people bp ON bp.board_id = cbr.child_board_id AND bp.person_id = cbr.person_id
           WHERE cbr.person_id = ?
             AND cbr.parent_board_id != ?
             AND bp.phone IS NOT NULL`,
        )
        .all(personId, parentBoard.id) as Array<ExistingBoardMatch & { phone: string }>;
      existingElsewhere = candidates.find((c) => normalizePhone(c.phone) === canonicalPhone);
    }

    // Fallback: match by phone number alone (different person_id string,
    // but same physical phone — still the same person).
    if (!existingElsewhere && hasUsablePhone) {
      const candidates = tfDb
        .prepare(
          `SELECT cbr.child_board_id, cbr.person_id, b.group_jid, b.group_folder, bp.phone
             FROM child_board_registrations cbr
             JOIN boards b ON b.id = cbr.child_board_id
             JOIN board_people bp ON bp.board_id = cbr.child_board_id AND bp.person_id = cbr.person_id
             WHERE bp.phone IS NOT NULL
               AND cbr.parent_board_id != ?`,
        )
        .all(parentBoard.id) as Array<ExistingBoardMatch & { phone: string }>;
      existingElsewhere = candidates.find((c) => normalizePhone(c.phone) === canonicalPhone);
      if (existingElsewhere) {
        logger.info(
          {
            personId,
            matchedPersonId: existingElsewhere.person_id,
            phone: canonicalPhone,
          },
          'provision_child_board: matched existing board by phone number',
        );
      }
    }

    if (existingElsewhere) {
      const existingPersonId = existingElsewhere.person_id;

      logger.info(
        {
          parentBoardId: parentBoard.id,
          personId,
          existingPersonId,
          existingBoard: existingElsewhere.child_board_id,
        },
        'provision_child_board: person already has a board under another parent — linking instead of creating',
      );

      // Wrap the entire link+unify in a transaction for atomicity
      const linkTransaction = tfDb.transaction(() => {
        // If the person_id differs, unify on this parent board
        if (existingPersonId !== personId) {
          logger.info(
            { from: personId, to: existingPersonId },
            'provision_child_board: unifying person_id to match existing board',
          );
          // Check for PK collision before updating
          const alreadyExists = tfDb
            .prepare(`SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?`)
            .get(parentBoard.id, existingPersonId);
          if (alreadyExists) {
            // Person already exists with the target ID — delete the duplicate
            tfDb.prepare(`DELETE FROM board_people WHERE board_id = ? AND person_id = ?`).run(parentBoard.id, personId);
          } else {
            tfDb
              .prepare(`UPDATE board_people SET person_id = ? WHERE board_id = ? AND person_id = ?`)
              .run(existingPersonId, parentBoard.id, personId);
          }
          // Update tasks (all columns, including done)
          tfDb
            .prepare(`UPDATE tasks SET assignee = ? WHERE board_id = ? AND assignee = ?`)
            .run(existingPersonId, parentBoard.id, personId);
          // Update board_admins — delete old row if target already exists to avoid PK collision
          const existingAdmin = tfDb
            .prepare(`SELECT 1 FROM board_admins WHERE board_id = ? AND person_id = ?`)
            .get(parentBoard.id, existingPersonId);
          if (existingAdmin) {
            tfDb.prepare(`DELETE FROM board_admins WHERE board_id = ? AND person_id = ?`).run(parentBoard.id, personId);
          } else {
            tfDb
              .prepare(`UPDATE board_admins SET person_id = ? WHERE board_id = ? AND person_id = ?`)
              .run(existingPersonId, parentBoard.id, personId);
          }
        }

        const unifiedId = existingPersonId;

        // Register the cross-parent link
        tfDb
          .prepare(
            `INSERT OR IGNORE INTO child_board_registrations (parent_board_id, person_id, child_board_id)
             VALUES (?, ?, ?)`,
          )
          .run(parentBoard.id, unifiedId, existingElsewhere!.child_board_id);

        // Set notification_group_jid — but only if the target group differs
        // from the parent board's own group. Redirecting to the same group is
        // always redundant and used to cause double-delivery (the person gets
        // both the board-level parent_notification AND a person-targeted copy
        // in the same WhatsApp group).
        const targetGroupJid = existingElsewhere!.group_jid;
        if (targetGroupJid && targetGroupJid !== parentBoard.group_jid) {
          tfDb
            .prepare(`UPDATE board_people SET notification_group_jid = ? WHERE board_id = ? AND person_id = ?`)
            .run(targetGroupJid, parentBoard.id, unifiedId);
        }

        // Retroactively link unlinked tasks
        tfDb
          .prepare(
            `UPDATE tasks SET child_exec_board_id = ?, child_exec_enabled = 1, child_exec_person_id = ?
             WHERE board_id = ? AND assignee = ? AND child_exec_board_id IS NULL`,
          )
          .run(existingElsewhere!.child_board_id, unifiedId, parentBoard.id, unifiedId);
      });

      try {
        linkTransaction();
        logger.info(
          {
            parentBoardId: parentBoard.id,
            childBoardId: existingElsewhere.child_board_id,
          },
          'provision_child_board: existing board linked successfully',
        );
      } catch (err) {
        logger.error(
          { err, parentBoardId: parentBoard.id, personId },
          'provision_child_board: failed to link existing board',
        );
      }
      return;
    }

    // --- 5. Compute child values ---
    const childLevel = parentBoard.hierarchy_level + 1;

    let childGroupFolder =
      typeof data.group_folder === 'string' && data.group_folder.trim()
        ? data.group_folder.trim()
        : sanitizeFolder(personId) + '-taskflow';
    if (!(typeof data.group_folder === 'string' && data.group_folder.trim())) {
      logger.warn(
        { personId, fallbackFolder: childGroupFolder },
        'provision_child_board: group_folder not provided, falling back to person-based name. Child boards should use division/sector names.',
      );
    }

    // Ensure folder uniqueness
    const existingFolders = new Set(Object.values(registeredGroups).map((g) => g.folder));
    childGroupFolder = uniqueFolder(childGroupFolder, existingFolders);

    if (!isValidGroupFolder(childGroupFolder)) {
      logger.warn({ childGroupFolder }, 'provision_child_board: invalid group folder name');
      return;
    }

    let childGroupName =
      typeof data.group_name === 'string' && data.group_name.trim()
        ? data.group_name.trim()
        : personName + ' - TaskFlow';

    // Ensure child group name doesn't duplicate any existing group
    const existingNames = new Set(Object.values(registeredGroups).map((g) => g.name));
    if (existingNames.has(childGroupName)) {
      const deduplicated = childGroupName.replace(/ - TaskFlow$/, ` (${personName}) - TaskFlow`);
      // If regex didn't match (name doesn't end with " - TaskFlow"), append directly
      childGroupName = deduplicated !== childGroupName ? deduplicated : `${childGroupName} (${personName})`;
    }

    const childBoardId = 'board-' + childGroupFolder;

    // --- 6. Resolve phone JID and create WhatsApp group ---
    let childGroupJid: string;
    try {
      const participantJid = deps.resolvePhoneJid
        ? await deps.resolvePhoneJid(personPhone)
        : (canonicalPhone || personPhone) + '@s.whatsapp.net';
      const result = await deps.createGroup(childGroupName, [participantJid]);
      childGroupJid = result.jid;
      logger.info(
        {
          jid: childGroupJid,
          subject: result.subject,
          inviteLink: result.inviteLink,
        },
        'provision_child_board: WhatsApp group created',
      );
      if (result.inviteLink) {
        // Send invite link with dropped participant info so the manager knows who to forward it to
        const dropped = result.droppedParticipants?.length
          ? `\n⚠️ Não foi possível adicionar: ${result.droppedParticipants.map((p) => p.split('@')[0]).join(', ')}`
          : '';
        try {
          await deps.sendMessage(
            sourceGroupJid!,
            `📎 Link de convite para o grupo *${childGroupName}* (${personName}):\n${result.inviteLink}${dropped}`,
          );
        } catch {}
      }
    } catch (err) {
      logger.error({ err, childGroupName }, 'provision_child_board: failed to create WhatsApp group');
      return;
    }

    // --- 7. Seed child board in taskflow.db (single transaction) ---
    const now = new Date().toISOString();

    const seedTransaction = tfDb.transaction(() => {
      // Keep `boards.owner_person_id` in sync with `child_board_registrations.person_id`.
      tfDb
        .prepare(
          'INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code, owner_person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          childBoardId,
          childGroupJid,
          childGroupFolder,
          'hierarchy',
          childLevel,
          parentBoard.max_depth,
          parentBoard.id,
          shortCode,
          personId,
        );

      tfDb
        .prepare('INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, ?, ?)')
        .run(parentBoard.id, personId, childBoardId);

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
        .run(childBoardId, personId, canonicalPhone || personPhone, 'manager', 1);

      tfDb
        .prepare(
          'INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit, notification_group_jid) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          childBoardId,
          personId,
          personName,
          canonicalPhone || personPhone,
          personRole,
          parentConfig.wip_limit,
          null,
        );

      // Update parent board_people with notification_group_jid
      tfDb
        .prepare('UPDATE board_people SET notification_group_jid = ? WHERE board_id = ? AND person_id = ?')
        .run(childGroupJid, parentBoard.id, personId);

      // Retroactively link existing tasks assigned to this person
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
        .run(childBoardId, personId, now, parentBoard.id, personId);

      if (linked.changes > 0) {
        logger.info(
          {
            count: linked.changes,
            parentBoardId: parentBoard.id,
            personId,
            childBoardId,
          },
          'provision_child_board: retroactively linked existing tasks',
        );
      }

      tfDb
        .prepare(
          'INSERT INTO task_history (board_id, task_id, action, by, at, details, trigger_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          parentBoard.id,
          '',
          'child_board_created',
          personId,
          now,
          JSON.stringify({
            child_board_id: childBoardId,
            person_id: personId,
            auto_provisioned: true,
          }),
          triggerTurnId,
        );
    });

    try {
      seedTransaction();
      logger.info({ childBoardId, parentBoardId: parentBoard.id }, 'provision_child_board: taskflow DB seeded');
    } catch (err) {
      logger.error({ err, childBoardId }, 'provision_child_board: failed to seed taskflow DB');
      return;
    }

    // --- 8. Register child group (after DB seed to avoid orphan on seed failure) ---
    try {
      deps.registerGroup(childGroupJid, {
        name: childGroupName,
        folder: childGroupFolder,
        trigger: sourceEntry.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        taskflowManaged: true,
        taskflowHierarchyLevel: childLevel,
        taskflowMaxDepth: sourceEntry.taskflowMaxDepth,
      });
      logger.info({ jid: childGroupJid, folder: childGroupFolder }, 'provision_child_board: group registered');
    } catch (err) {
      logger.error({ err, childGroupJid }, 'provision_child_board: failed to register group');
      return;
    }

    // --- 9. Create filesystem ---
    try {
      createBoardFilesystem({
        groupFolder: childGroupFolder,
        assistantName,
        personName,
        personPhone,
        personId,
        language: parentRuntime.language,
        timezone: parentRuntime.timezone,
        wipLimit: parentConfig.wip_limit,
        boardId: childBoardId,
        groupName: childGroupName,
        groupContext: `${personName}'s tasks (private standup channel)`,
        groupJid: childGroupJid,
        boardRole: 'hierarchy',
        hierarchyLevel: childLevel,
        maxDepth: parentBoard.max_depth,
        parentBoardId: parentBoard.id,
        standupCronUtc: parentRuntime.standup_cron_utc,
        digestCronUtc: parentRuntime.digest_cron_utc,
        reviewCronUtc: parentRuntime.review_cron_utc,
        standupCronLocal: parentRuntime.standup_cron_local,
        digestCronLocal: parentRuntime.digest_cron_local,
        reviewCronLocal: parentRuntime.review_cron_local,
        attachmentEnabled: !!parentRuntime.attachment_enabled,
        attachmentReason: parentRuntime.attachment_disabled_reason,
        dstGuardEnabled: !!parentRuntime.dst_sync_enabled,
      });
    } catch (err) {
      logger.error({ err, childGroupFolder }, 'provision_child_board: failed to create filesystem');
      // Continue — group and DB are already provisioned
    }

    // --- 9b. Seed initial available_groups.json in IPC dir ---
    try {
      seedAvailableGroupsJson(childGroupFolder);
    } catch (err) {
      logger.warn({ err, childGroupFolder }, 'provision_child_board: failed to seed available_groups.json');
    }

    // --- 10. Schedule runners ---
    try {
      scheduleRunners({
        tfDb,
        boardId: childBoardId,
        groupFolder: childGroupFolder,
        groupJid: childGroupJid,
        standupCronUtc: parentRuntime.standup_cron_utc,
        digestCronUtc: parentRuntime.digest_cron_utc,
        reviewCronUtc: parentRuntime.review_cron_utc,
        now,
      });
      logger.info({ childBoardId }, 'provision_child_board: runners scheduled');
    } catch (err) {
      logger.error({ err }, 'provision_child_board: failed to schedule runners');
      // Continue — board is functional without runners
    }

    // --- 11. Fix ownership ---
    fixOwnership(path.join(PROJECT_ROOT, 'groups', childGroupFolder), path.join(DATA_DIR, 'ipc', childGroupFolder));

    // --- 12. Send confirmation ---
    if (sourceGroupJid) {
      try {
        await deps.sendMessage(
          sourceGroupJid,
          `✅ Quadro de ${personName} provisionado automaticamente.\n\nGrupo: ${childGroupName}\nQuadro: ${childBoardId}\n\nO quadro estará disponível na próxima interação.`,
          assistantName,
        );
      } catch (err) {
        logger.error({ err }, 'provision_child_board: failed to send confirmation');
      }
    }

    // --- 13. Send welcome message to child group ---
    try {
      await deps.sendMessage(
        childGroupJid,
        `👋 *Bem-vindo ao ${childGroupName}!*\n\nEste é o seu quadro de tarefas pessoal. Aqui você receberá suas tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para ver os comandos disponíveis.`,
        assistantName,
      );
      tfDb.prepare('UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?').run(childBoardId);
      logger.info({ childGroupJid }, 'provision_child_board: welcome message sent');
    } catch (err) {
      logger.error({ err }, 'provision_child_board: failed to send welcome message');
    }

    // --- 14. Schedule onboarding message (30 min after welcome) ---
    try {
      scheduleOnboarding({
        groupFolder: childGroupFolder,
        groupJid: childGroupJid,
        timezone: parentRuntime.timezone,
      });
    } catch (err) {
      logger.error({ err }, 'provision_child_board: failed to schedule onboarding');
    }

    logger.info(
      {
        childBoardId,
        childGroupJid,
        childGroupFolder,
        parentBoardId: parentBoard.id,
        personId,
      },
      'provision_child_board: provisioning complete',
    );
  } finally {
    tfDb.close();
  }
};

export function register(reg: (type: string, handler: IpcHandler) => void): void {
  reg('provision_child_board', handleProvisionChildBoard);
}
