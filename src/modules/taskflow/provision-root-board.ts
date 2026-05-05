import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type DatabaseType from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { createAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroup } from '../../db/messaging-groups.js';
import { isValidGroupFolder } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { normalizePhone } from '../../phone.js';
import type { Session } from '../../types.js';
import { checkMainControlSession } from './permission.js';
import {
  createBoardFilesystem,
  fixOwnership,
  PARTICIPANT_JID_PATTERN,
  sanitizeFolder,
  scheduleOnboarding,
  scheduleRunners,
  TASKFLOW_DB_PATH,
  TASKFLOW_SUFFIX,
  uniqueFolder,
} from './provision-shared.js';
import { newTaskId, nonEmptyString } from './util.js';

const DEFAULT_STANDUP_LOCAL = '0 8 * * 1-5';
const DEFAULT_DIGEST_LOCAL = '0 18 * * 1-5';
const DEFAULT_REVIEW_LOCAL = '0 11 * * 5';
const DEFAULT_STANDUP_UTC = '0 11 * * 1-5';
const DEFAULT_DIGEST_UTC = '0 21 * * 1-5';
const DEFAULT_REVIEW_UTC = '0 14 * * 5';

const REQUIRED = ['subject', 'person_id', 'person_name', 'person_phone', 'short_code'] as const;

interface ParsedInput {
  subject: string;
  personId: string;
  personName: string;
  personPhone: string;
  personRole: string;
  shortCode: string;
  participants: string[];
  trigger: string;
  requiresTrigger: boolean;
  language: string;
  timezone: string;
  wipLimit: number;
  maxDepth: number;
  model: string;
  groupContext: string;
  groupFolderOverride: string | null;
  cron: {
    standupLocal: string;
    digestLocal: string;
    reviewLocal: string;
    standupUtc: string;
    digestUtc: string;
    reviewUtc: string;
  };
}

function parseInput(content: Record<string, unknown>): ParsedInput | null {
  for (const field of REQUIRED) {
    if (!nonEmptyString(content[field])) return null;
  }
  let subject = nonEmptyString(content.subject)!;
  if (!subject.endsWith(TASKFLOW_SUFFIX)) {
    const suffixed = subject + TASKFLOW_SUFFIX;
    // WhatsApp group subject limit is 100 chars; only suffix when it fits.
    if (suffixed.length <= 100) subject = suffixed;
  }
  const participantsRaw = Array.isArray(content.participants) ? content.participants : [];
  const participants = participantsRaw
    .filter((p): p is string => typeof p === 'string' && PARTICIPANT_JID_PATTERN.test(p.trim()))
    .map((p) => p.trim());
  return {
    subject,
    personId: nonEmptyString(content.person_id)!,
    personName: nonEmptyString(content.person_name)!,
    personPhone: nonEmptyString(content.person_phone)!,
    personRole: nonEmptyString(content.person_role) ?? 'manager',
    shortCode: nonEmptyString(content.short_code)!.toUpperCase(),
    participants,
    trigger: nonEmptyString(content.trigger) ?? '@Case',
    requiresTrigger: typeof content.requires_trigger === 'boolean' ? content.requires_trigger : false,
    language: nonEmptyString(content.language) ?? 'pt-BR',
    timezone: nonEmptyString(content.timezone) ?? 'America/Fortaleza',
    wipLimit: typeof content.wip_limit === 'number' && content.wip_limit > 0 ? content.wip_limit : 5,
    maxDepth: typeof content.max_depth === 'number' && content.max_depth >= 1 ? content.max_depth : 3,
    model: nonEmptyString(content.model) ?? 'claude-sonnet-4-6',
    groupContext: nonEmptyString(content.group_context) ?? `${subject} task board`,
    groupFolderOverride: nonEmptyString(content.group_folder),
    cron: {
      standupLocal: nonEmptyString(content.standup_cron_local) ?? DEFAULT_STANDUP_LOCAL,
      digestLocal: nonEmptyString(content.digest_cron_local) ?? DEFAULT_DIGEST_LOCAL,
      reviewLocal: nonEmptyString(content.review_cron_local) ?? DEFAULT_REVIEW_LOCAL,
      standupUtc: nonEmptyString(content.standup_cron_utc) ?? DEFAULT_STANDUP_UTC,
      digestUtc: nonEmptyString(content.digest_cron_utc) ?? DEFAULT_DIGEST_UTC,
      reviewUtc: nonEmptyString(content.review_cron_utc) ?? DEFAULT_REVIEW_UTC,
    },
  };
}

function computeFolder(parsed: ParsedInput): string | null {
  const base = parsed.groupFolderOverride || sanitizeFolder(parsed.shortCode) + '-taskflow';
  // agent_groups.folder is the on-disk identity for groups/<folder>/ — the v2
  // source of truth for folder collision. messaging_groups don't carry a
  // folder column; using their name would miss collisions for already-created
  // agent groups.
  const existing = new Set(getAllAgentGroups().map((ag) => ag.folder));
  const folder = uniqueFolder(base, existing);
  return isValidGroupFolder(folder) ? folder : null;
}

function buildWelcomeMessage(subject: string): string {
  return `👋 *Bem-vindo ao ${subject}!*\n\nEste é o seu quadro de tarefas. Aqui você receberá tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para ver os comandos disponíveis.`;
}

function buildConfirmationMessage(parsed: ParsedInput, boardId: string, folder: string): string {
  return `✅ Quadro raiz *${parsed.shortCode}* provisionado.\n\nGrupo: ${parsed.subject}\nQuadro: ${boardId}\nPasta: ${folder}\nGerente: ${parsed.personName}\n\nO quadro estará disponível na próxima interação.`;
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

function seedTaskflow(
  tfDb: DatabaseType.Database,
  parsed: ParsedInput,
  boardId: string,
  folder: string,
  groupJid: string,
  triggerTurnId: string | null,
): void {
  const canonicalPhone = normalizePhone(parsed.personPhone) || parsed.personPhone;
  const ts = new Date().toISOString();

  // Defensive: provisioning may run against old-schema DBs without
  // task_history.trigger_turn_id. ALTER is no-op if column exists.
  try {
    tfDb.exec(`ALTER TABLE task_history ADD COLUMN trigger_turn_id TEXT`);
  } catch {
    // already present
  }

  tfDb.transaction(() => {
    tfDb
      .prepare(
        'INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(boardId, groupJid, folder, 'hierarchy', 0, parsed.maxDepth, null, parsed.shortCode);

    tfDb.prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, ?)').run(boardId, parsed.wipLimit);

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
        parsed.language,
        parsed.timezone,
        parsed.cron.standupLocal,
        parsed.cron.digestLocal,
        parsed.cron.reviewLocal,
        parsed.cron.standupUtc,
        parsed.cron.digestUtc,
        parsed.cron.reviewUtc,
        1,
        '',
        1,
      );

    tfDb
      .prepare(
        'INSERT INTO board_admins (board_id, person_id, phone, admin_role, is_primary_manager) VALUES (?, ?, ?, ?, ?)',
      )
      .run(boardId, parsed.personId, canonicalPhone, 'manager', 1);

    tfDb
      .prepare(
        'INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit, notification_group_jid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(boardId, parsed.personId, parsed.personName, canonicalPhone, parsed.personRole, parsed.wipLimit, null);

    tfDb
      .prepare(
        'INSERT INTO task_history (board_id, task_id, action, by, at, details, trigger_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        boardId,
        '',
        'root_board_created',
        parsed.personId,
        ts,
        JSON.stringify({ board_id: boardId, short_code: parsed.shortCode }),
        triggerTurnId,
      );
  })();
}

function wireV2(parsed: ParsedInput, agentGroupId: string, folder: string, groupJid: string): void {
  const ts = new Date().toISOString();
  createAgentGroup({
    id: agentGroupId,
    name: parsed.trigger.startsWith('@') ? parsed.trigger.slice(1) : parsed.trigger,
    folder,
    agent_provider: 'claude',
    created_at: ts,
  });

  const messagingGroupId = newTaskId('mg');
  createMessagingGroup({
    id: messagingGroupId,
    channel_type: 'whatsapp',
    platform_id: groupJid,
    name: parsed.subject,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: ts,
  });

  // engage_mode='pattern' with engage_pattern='.' = "respond to all messages",
  // mirroring v1 TaskFlow's requiresTrigger=false default. When the operator
  // explicitly opts into trigger-only routing, switch to mention mode.
  const engageMode = parsed.requiresTrigger ? 'mention' : 'pattern';
  const engagePattern = parsed.requiresTrigger ? null : '.';
  createMessagingGroupAgent({
    id: newTaskId('mga'),
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: ts,
  });
}

function writeAgentSettingsJson(agentGroupId: string, model: string): void {
  const settingsDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch {
    // first write or unreadable — start fresh
  }
  const merged = { ...existing, model };
  fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + '\n');
}

export async function handleProvisionRootBoard(
  content: Record<string, unknown>,
  session: Session,
  _inDb: DatabaseType.Database,
): Promise<void> {
  if (!checkMainControlSession(session, 'provision_root_board')) return;

  const parsed = parseInput(content);
  if (!parsed) {
    log.warn('provision_root_board: missing required fields', { sessionId: session.id });
    return;
  }

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter || !adapter.createGroup) {
    log.warn('provision_root_board: WhatsApp adapter missing createGroup capability', { sessionId: session.id });
    return;
  }

  const folder = computeFolder(parsed);
  if (!folder) {
    log.warn('provision_root_board: invalid group folder', { sessionId: session.id });
    return;
  }
  const boardId = `board-${folder}`;

  fs.mkdirSync(path.dirname(TASKFLOW_DB_PATH), { recursive: true });
  const tfDb = new Database(TASKFLOW_DB_PATH);
  try {
    const existing = tfDb.prepare('SELECT 1 FROM boards WHERE id = ? OR short_code = ?').get(boardId, parsed.shortCode);
    if (existing) {
      log.warn('provision_root_board: board or short_code already exists', { boardId, shortCode: parsed.shortCode });
      return;
    }

    // Resolve participant JIDs (manager + extras), deduplicated.
    const managerDigits = normalizePhone(parsed.personPhone) || parsed.personPhone.replace(/\D/g, '');
    const managerJid = `${managerDigits}@s.whatsapp.net`;
    const allParticipants = new Set<string>([managerJid, ...parsed.participants]);

    let groupJid: string;
    try {
      const result = await adapter.createGroup(parsed.subject, [...allParticipants]);
      groupJid = result.jid;
      log.info('provision_root_board: WhatsApp group created', { jid: groupJid, subject: result.subject });
    } catch (err) {
      log.error('provision_root_board: failed to create WhatsApp group', { err, subject: parsed.subject });
      return;
    }

    try {
      seedTaskflow(tfDb, parsed, boardId, folder, groupJid, nonEmptyString(content.trigger_turn_id));
      log.info('provision_root_board: taskflow DB seeded', { boardId });
    } catch (err) {
      log.error('provision_root_board: failed to seed taskflow DB', { err, boardId });
      return;
    }

    const agentGroupId = newTaskId('ag');
    try {
      wireV2(parsed, agentGroupId, folder, groupJid);
      log.info('provision_root_board: v2 wiring complete', { agentGroupId, folder, groupJid });
    } catch (err) {
      log.error('provision_root_board: failed to wire v2', { err, agentGroupId });
      return;
    }

    try {
      initGroupFilesystem({
        id: agentGroupId,
        name: parsed.trigger.startsWith('@') ? parsed.trigger.slice(1) : parsed.trigger,
        folder,
        agent_provider: 'claude',
        created_at: new Date().toISOString(),
      });
      createBoardFilesystem({
        groupFolder: folder,
        assistantName: parsed.trigger.startsWith('@') ? parsed.trigger.slice(1) : parsed.trigger,
        personName: parsed.personName,
        personPhone: parsed.personPhone,
        personId: parsed.personId,
        language: parsed.language,
        timezone: parsed.timezone,
        wipLimit: parsed.wipLimit,
        boardId,
        groupName: parsed.subject,
        groupContext: parsed.groupContext,
        groupJid,
        boardRole: 'hierarchy',
        hierarchyLevel: 0,
        maxDepth: parsed.maxDepth,
        parentBoardId: '',
        standupCronUtc: parsed.cron.standupUtc,
        digestCronUtc: parsed.cron.digestUtc,
        reviewCronUtc: parsed.cron.reviewUtc,
        standupCronLocal: parsed.cron.standupLocal,
        digestCronLocal: parsed.cron.digestLocal,
        reviewCronLocal: parsed.cron.reviewLocal,
      });
    } catch (err) {
      log.error('provision_root_board: filesystem step failed (non-fatal)', { err, folder });
    }

    try {
      writeAgentSettingsJson(agentGroupId, parsed.model);
    } catch (err) {
      log.error('provision_root_board: failed to write settings.json (non-fatal)', { err });
    }

    try {
      scheduleRunners({
        tfDb,
        boardId,
        groupFolder: folder,
        groupJid,
        standupCronUtc: parsed.cron.standupUtc,
        digestCronUtc: parsed.cron.digestUtc,
        reviewCronUtc: parsed.cron.reviewUtc,
        now: new Date().toISOString(),
      });
    } catch (err) {
      log.error('provision_root_board: failed to schedule runners (non-fatal)', { err });
    }

    fixOwnership(
      path.join(GROUPS_DIR, folder),
      path.join(DATA_DIR, 'v2-sessions', agentGroupId),
      path.join(DATA_DIR, 'taskflow'),
    );

    // Confirmation back to the operator's main control chat.
    const mainGroup = getMessagingGroup(session.messaging_group_id!);
    if (mainGroup) {
      try {
        await deliverPlainText(adapter, mainGroup.platform_id, buildConfirmationMessage(parsed, boardId, folder));
      } catch (err) {
        log.error('provision_root_board: failed to send confirmation (non-fatal)', { err });
      }
    }

    // Welcome to the new board's chat + flip welcome_sent.
    try {
      await deliverPlainText(adapter, groupJid, buildWelcomeMessage(parsed.subject));
      tfDb.prepare('UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?').run(boardId);
    } catch (err) {
      log.error('provision_root_board: failed to send welcome (non-fatal)', { err });
    }

    try {
      scheduleOnboarding(tfDb, { groupFolder: folder, groupJid, timezone: parsed.timezone });
    } catch (err) {
      log.error('provision_root_board: failed to schedule onboarding (non-fatal)', { err });
    }

    log.info('provision_root_board: complete', { boardId, groupJid, folder, shortCode: parsed.shortCode });
  } finally {
    tfDb.close();
  }
}
