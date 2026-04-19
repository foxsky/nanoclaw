import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, PROJECT_ROOT } from '../config.js';
import { getGroupSenderName } from '../group-sender.js';
import { isValidGroupFolder } from '../group-folder.js';
import type { IpcHandler } from '../ipc.js';
import { logger } from '../logger.js';
import { normalizePhone } from '../phone.js';

import {
  createBoardFilesystem,
  fixOwnership,
  MCP_JSON_CONTENT,
  PARTICIPANT_JID_PATTERN,
  sanitizeFolder,
  scheduleOnboarding,
  scheduleRunners,
  seedAvailableGroupsJson,
  TASKFLOW_DB_PATH,
  TASKFLOW_SUFFIX,
  uniqueFolder,
} from './provision-shared.js';

// Default cron schedules (America/Fortaleza, UTC-3)
export const DEFAULT_STANDUP_LOCAL = '0 8 * * 1-5';
export const DEFAULT_DIGEST_LOCAL = '0 18 * * 1-5';
export const DEFAULT_REVIEW_LOCAL = '0 11 * * 5';
export const DEFAULT_STANDUP_UTC = '0 11 * * 1-5';
export const DEFAULT_DIGEST_UTC = '0 21 * * 1-5';
export const DEFAULT_REVIEW_UTC = '0 14 * * 5';

const handleProvisionRootBoard: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  // --- 1. Authorization: main group only ---
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'provision_root_board: only main group can provision root boards',
    );
    return;
  }

  if (!deps.createGroup) {
    logger.warn('provision_root_board: no createGroup dep available');
    return;
  }

  // --- 2. Validate required input ---
  let subject = typeof data.subject === 'string' ? data.subject.trim() : '';
  const personId =
    typeof data.person_id === 'string' ? data.person_id.trim() : '';
  const personName =
    typeof data.person_name === 'string' ? data.person_name.trim() : '';
  const personPhone =
    typeof data.person_phone === 'string' ? data.person_phone.trim() : '';
  const personRole =
    typeof data.person_role === 'string' ? data.person_role.trim() : 'manager';
  const shortCode =
    typeof data.short_code === 'string'
      ? data.short_code.trim().toUpperCase()
      : '';

  // Append " - TaskFlow" suffix if not already present
  if (subject && !subject.endsWith(TASKFLOW_SUFFIX)) {
    const suffixed = subject + TASKFLOW_SUFFIX;
    if (suffixed.length <= 100) {
      subject = suffixed;
    }
  }

  if (!subject || !personId || !personName || !personPhone || !shortCode) {
    logger.warn(
      {
        subject: !!subject,
        personId: !!personId,
        personName: !!personName,
        personPhone: !!personPhone,
        shortCode: !!shortCode,
      },
      'provision_root_board: missing required fields',
    );
    return;
  }

  // Validate participants
  const participants = Array.isArray(data.participants)
    ? data.participants
    : [];
  // Canonicalize so the JID carries the country-code prefix. A raw
  // 11-digit Brazilian phone would otherwise produce an invalid JID.
  const phoneJid = (normalizePhone(personPhone) || personPhone) + '@s.whatsapp.net';
  const allParticipants = new Set<string>([phoneJid]);
  for (const p of participants) {
    if (typeof p === 'string' && PARTICIPANT_JID_PATTERN.test(p.trim())) {
      allParticipants.add(p.trim());
    }
  }

  // --- 3. Parse optional config with defaults ---
  const registeredGroups = deps.registeredGroups();
  const mainEntry = Object.values(registeredGroups).find(
    (g) => g.folder === sourceGroup,
  );
  const trigger =
    typeof data.trigger === 'string'
      ? data.trigger.trim()
      : mainEntry?.trigger || '@Case';
  const requiresTrigger =
    typeof data.requires_trigger === 'boolean' ? data.requires_trigger : false;
  const language =
    typeof data.language === 'string' ? data.language.trim() : 'pt-BR';
  const timezone =
    typeof data.timezone === 'string'
      ? data.timezone.trim()
      : 'America/Fortaleza';
  const wipLimit =
    typeof data.wip_limit === 'number' && data.wip_limit > 0
      ? data.wip_limit
      : 5;
  const maxDepth =
    typeof data.max_depth === 'number' && data.max_depth >= 1
      ? data.max_depth
      : 3;
  const model =
    typeof data.model === 'string' ? data.model.trim() : 'claude-sonnet-4-6';

  // Cron schedules (use provided or defaults)
  const standupLocal =
    typeof data.standup_cron_local === 'string'
      ? data.standup_cron_local
      : DEFAULT_STANDUP_LOCAL;
  const digestLocal =
    typeof data.digest_cron_local === 'string'
      ? data.digest_cron_local
      : DEFAULT_DIGEST_LOCAL;
  const reviewLocal =
    typeof data.review_cron_local === 'string'
      ? data.review_cron_local
      : DEFAULT_REVIEW_LOCAL;
  const standupUtc =
    typeof data.standup_cron_utc === 'string'
      ? data.standup_cron_utc
      : DEFAULT_STANDUP_UTC;
  const digestUtc =
    typeof data.digest_cron_utc === 'string'
      ? data.digest_cron_utc
      : DEFAULT_DIGEST_UTC;
  const reviewUtc =
    typeof data.review_cron_utc === 'string'
      ? data.review_cron_utc
      : DEFAULT_REVIEW_UTC;

  const groupContext =
    typeof data.group_context === 'string'
      ? data.group_context.trim()
      : `${subject} task board`;
  const triggerTurnId =
    typeof data.turnId === 'string' && data.turnId.trim()
      ? data.turnId.trim()
      : null;

  // --- 4. Compute folder and board ID ---
  let groupFolder =
    typeof data.group_folder === 'string' && data.group_folder.trim()
      ? data.group_folder.trim()
      : sanitizeFolder(shortCode) + '-taskflow';

  const existingFolders = new Set(
    Object.values(registeredGroups).map((g) => g.folder),
  );
  groupFolder = uniqueFolder(groupFolder, existingFolders);

  if (!isValidGroupFolder(groupFolder)) {
    logger.warn(
      { groupFolder },
      'provision_root_board: invalid group folder name',
    );
    return;
  }

  const boardId = 'board-' + groupFolder;
  const assistantName = getGroupSenderName(trigger);

  // --- 5. Check board doesn't already exist ---
  let tfDb: Database.Database;
  try {
    fs.mkdirSync(path.dirname(TASKFLOW_DB_PATH), { recursive: true });
    tfDb = new Database(TASKFLOW_DB_PATH);
  } catch (err) {
    logger.error({ err }, 'provision_root_board: cannot open taskflow.db');
    return;
  }

  try {
    const existingBoard = tfDb
      .prepare('SELECT 1 FROM boards WHERE id = ? OR short_code = ?')
      .get(boardId, shortCode);

    try {
      tfDb.exec(`ALTER TABLE task_history ADD COLUMN trigger_turn_id TEXT`);
    } catch {
      // Existing DBs may already have the column.
    }

    if (existingBoard) {
      logger.warn(
        { boardId, shortCode },
        'provision_root_board: board or short_code already exists',
      );
      return;
    }

    // --- 6. Create WhatsApp group ---
    let groupJid: string;
    try {
      const resolvedParticipants = await Promise.all(
        [...allParticipants].map(async (jid) => {
          if (deps.resolvePhoneJid) {
            const phone = jid.replace(/@s\.whatsapp\.net$/, '');
            return deps.resolvePhoneJid(phone);
          }
          return jid;
        }),
      );
      const result = await deps.createGroup(subject, resolvedParticipants);
      groupJid = result.jid;
      logger.info(
        { jid: groupJid, subject: result.subject },
        'provision_root_board: WhatsApp group created',
      );
    } catch (err) {
      logger.error(
        { err, subject },
        'provision_root_board: failed to create WhatsApp group',
      );
      return;
    }

    // --- 7. Seed taskflow.db (single transaction) ---
    // (registerGroup moved to step 8 — seed must succeed before the group is live)
    const now = new Date().toISOString();

    const seedTransaction = tfDb.transaction(() => {
      tfDb
        .prepare(
          'INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          boardId,
          groupJid,
          groupFolder,
          'hierarchy',
          0,
          maxDepth,
          null,
          shortCode,
        );

      tfDb
        .prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, ?)')
        .run(boardId, wipLimit);

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
          boardId,
          language,
          timezone,
          standupLocal,
          digestLocal,
          reviewLocal,
          standupUtc,
          digestUtc,
          reviewUtc,
          1, // attachment_enabled (default on)
          '',
          1, // dst_sync_enabled
        );

      // Canonicalize phone at the write boundary so stored rows are always
      // comparable without prefix juggling at read time. See src/phone.ts.
      const canonicalPhone = normalizePhone(personPhone) || personPhone;

      tfDb
        .prepare(
          'INSERT INTO board_admins (board_id, person_id, phone, admin_role, is_primary_manager) VALUES (?, ?, ?, ?, ?)',
        )
        .run(boardId, personId, canonicalPhone, 'manager', 1);

      tfDb
        .prepare(
          'INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit, notification_group_jid) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          boardId,
          personId,
          personName,
          canonicalPhone,
          personRole,
          wipLimit,
          null,
        );

      tfDb
        .prepare(
          'INSERT INTO task_history (board_id, task_id, action, by, at, details, trigger_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          boardId,
          '',
          'root_board_created',
          personId,
          now,
          JSON.stringify({ board_id: boardId, short_code: shortCode }),
          triggerTurnId,
        );
    });

    try {
      seedTransaction();
      logger.info({ boardId }, 'provision_root_board: taskflow DB seeded');
    } catch (err) {
      logger.error(
        { err, boardId },
        'provision_root_board: failed to seed taskflow DB',
      );
      return;
    }

    // --- 8. Register group (after DB seed to avoid orphan on seed failure) ---
    try {
      deps.registerGroup(groupJid, {
        name: subject,
        folder: groupFolder,
        trigger,
        added_at: new Date().toISOString(),
        requiresTrigger,
        taskflowManaged: true,
        taskflowHierarchyLevel: 0,
        taskflowMaxDepth: maxDepth,
      });
      logger.info(
        { jid: groupJid, folder: groupFolder },
        'provision_root_board: group registered',
      );
    } catch (err) {
      logger.error(
        { err, groupJid },
        'provision_root_board: failed to register group',
      );
      return;
    }

    // --- 9. Create filesystem ---
    try {
      createBoardFilesystem({
        groupFolder,
        assistantName,
        personName,
        personPhone,
        personId,
        language,
        timezone,
        wipLimit,
        boardId,
        groupName: subject,
        groupContext,
        groupJid,
        boardRole: 'hierarchy',
        hierarchyLevel: 0,
        maxDepth,
        parentBoardId: '',
        standupCronUtc: standupUtc,
        digestCronUtc: digestUtc,
        reviewCronUtc: reviewUtc,
        standupCronLocal: standupLocal,
        digestCronLocal: digestLocal,
        reviewCronLocal: reviewLocal,
      });
    } catch (err) {
      logger.error(
        { err, groupFolder },
        'provision_root_board: failed to create filesystem',
      );
    }

    // --- 10. Write settings.json (model override) ---
    try {
      const sessionsDir = path.join(
        DATA_DIR,
        'sessions',
        groupFolder,
        '.claude',
      );
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionsDir, 'settings.json'),
        JSON.stringify({ model }, null, 2) + '\n',
      );
      logger.info(
        { model, groupFolder },
        'provision_root_board: settings.json written',
      );
    } catch (err) {
      logger.error(
        { err },
        'provision_root_board: failed to write settings.json',
      );
    }

    // --- 10b. Seed initial available_groups.json in IPC dir ---
    try {
      seedAvailableGroupsJson(groupFolder);
    } catch (err) {
      logger.warn(
        { err, groupFolder },
        'provision_root_board: failed to seed available_groups.json',
      );
    }

    // --- 11. Schedule runners ---
    try {
      scheduleRunners({
        tfDb,
        boardId,
        groupFolder,
        groupJid,
        standupCronUtc: standupUtc,
        digestCronUtc: digestUtc,
        reviewCronUtc: reviewUtc,
        now,
      });
      logger.info({ boardId }, 'provision_root_board: runners scheduled');
    } catch (err) {
      logger.error({ err }, 'provision_root_board: failed to schedule runners');
    }

    // --- 12. Create IPC directories ---
    try {
      const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder);
      fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
      fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
    } catch (err) {
      logger.error(
        { err },
        'provision_root_board: failed to create IPC directories',
      );
    }

    // --- 13. Fix ownership ---
    fixOwnership(
      path.join(PROJECT_ROOT, 'groups', groupFolder),
      path.join(DATA_DIR, 'sessions', groupFolder),
      path.join(DATA_DIR, 'ipc', groupFolder),
    );

    // --- 14. Send confirmation to main group ---
    const mainGroupJid = Object.entries(registeredGroups).find(
      ([, g]) => g.folder === sourceGroup,
    )?.[0];

    if (mainGroupJid) {
      try {
        await deps.sendMessage(
          mainGroupJid,
          `✅ Quadro raiz *${shortCode}* provisionado.\n\nGrupo: ${subject}\nQuadro: ${boardId}\nPasta: ${groupFolder}\nGerente: ${personName}\n\nO quadro estará disponível na próxima interação.`,
          assistantName,
        );
      } catch (err) {
        logger.error(
          { err },
          'provision_root_board: failed to send confirmation',
        );
      }
    }

    // --- 15. Send welcome message ---
    try {
      await deps.sendMessage(
        groupJid,
        `👋 *Bem-vindo ao ${subject}!*\n\nEste é o seu quadro de tarefas. Aqui você receberá tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para ver os comandos disponíveis.`,
        assistantName,
      );
      tfDb
        .prepare(
          'UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?',
        )
        .run(boardId);
      logger.info({ groupJid }, 'provision_root_board: welcome message sent');
    } catch (err) {
      logger.error(
        { err },
        'provision_root_board: failed to send welcome message',
      );
    }

    // --- Schedule onboarding message (30 min after welcome) ---
    try {
      scheduleOnboarding({ groupFolder, groupJid, timezone });
    } catch (err) {
      logger.error(
        { err },
        'provision_root_board: failed to schedule onboarding',
      );
    }

    logger.info(
      { boardId, groupJid, groupFolder, shortCode, personId },
      'provision_root_board: provisioning complete',
    );
  } finally {
    tfDb.close();
  }
};

export function register(
  reg: (type: string, handler: IpcHandler) => void,
): void {
  reg('provision_root_board', handleProvisionRootBoard);
}
