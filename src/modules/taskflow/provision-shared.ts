import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import type { ChannelAdapter } from '../../channels/adapter.js';
import { DATA_DIR, GROUPS_DIR, PROJECT_ROOT } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { isValidGroupFolder } from '../../group-folder.js';
import { createTask } from '../../taskflow-db.js';
import { log } from '../../log.js';
import { newTaskId } from './util.js';

export const TASKFLOW_DB_PATH = path.join(DATA_DIR, 'taskflow', 'taskflow.db');
export const TEMPLATE_PATH = path.join(
  PROJECT_ROOT,
  '.claude',
  'skills',
  'add-taskflow',
  'templates',
  'CLAUDE.md.template',
);
export const MCP_JSON_CONTENT = JSON.stringify(
  {
    mcpServers: {
      sqlite: {
        type: 'stdio',
        command: '/app/node_modules/.bin/mcp-server-sqlite-npx',
        args: ['/workspace/taskflow/taskflow.db'],
      },
    },
  },
  null,
  2,
);

export const TASKFLOW_SUFFIX = ' - TaskFlow';
export const PARTICIPANT_JID_PATTERN = /^\d{6,20}@s\.whatsapp\.net$/;

export const PARENT_BOARD_HINT =
  " IMPORTANT — Parent board tasks: After querying your own board, also check for tasks assigned to this board's people on parent boards. Query: SELECT parent_board_id FROM boards WHERE id = YOUR_BOARD_ID. If parent_board_id is not null, query: SELECT * FROM tasks WHERE board_id = PARENT_BOARD_ID AND assignee IN (SELECT person_id FROM board_people WHERE board_id = YOUR_BOARD_ID) AND column != 'done'. Include these parent-board tasks in a separate \"Tarefas do quadro superior\" section, clearly labeled with the parent board name.";

export const STANDUP_PROMPT =
  "[TF-STANDUP] You are running the morning standup for this group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks, board_people, board_config for your board_id. If no tasks exist on your board AND no parent-board tasks are assigned to your people, do NOT send any message — just perform housekeeping (archival) silently and exit. Otherwise: 1) Send the Kanban board to this group via send_message (grouped by column, show overdue with 🔴). 2) Include per-person sections in the group message with their personal board, WIP status (X/Y), and prompt for updates. 3) Check for tasks with column = 'done' and updated_at older than 30 days — INSERT them into archive and DELETE from tasks. 4) List any inbox items that need processing. Note: send_message sends to this group only — individual DMs are not supported." +
  PARENT_BOARD_HINT;
export const DIGEST_PROMPT =
  '[TF-DIGEST] You are generating the manager digest for this task group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks for your board_id. If no tasks exist on your board AND no parent-board tasks are assigned to your people, do NOT send any message — exit silently. Otherwise consolidate: 🔥 Overdue tasks, ⏳ Tasks due in next 48h, 🚧 Waiting/blocked tasks, 💤 Tasks with no update in 24h+, ✅ Tasks completed today. Format as a concise executive summary and suggest 3 specific follow-up actions with task IDs. Send the digest to this group via send_message. Note: send_message sends to this group only — individual DMs are not supported.' +
  PARENT_BOARD_HINT;
export const REVIEW_PROMPT =
  '[TF-REVIEW] You are running the weekly GTD review for this task group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks and archive for your board_id. If no tasks exist on your board AND no parent-board tasks are assigned to your people, do NOT send any message — exit silently, even if there was archive activity this week. Otherwise produce: 1) Summary: completed, created, overdue this week. 2) Inbox items pending processing. 3) Waiting tasks older than 5 days (suggest follow-up). 4) Overdue tasks (suggest action). 5) In Progress tasks with no update in 3+ days. 6) Next week preview (deadlines and recurrences). 7) Per-person weekly summaries inline. Send the full review to this group via send_message. Note: send_message sends to this group only — individual DMs are not supported.' +
  PARENT_BOARD_HINT;

export interface BoardRow {
  id: string;
  group_jid: string;
  group_folder: string;
  board_role: string;
  hierarchy_level: number;
  max_depth: number;
  parent_board_id: string | null;
  short_code: string | null;
}

export interface BoardConfigRow {
  board_id: string;
  wip_limit: number;
}

export interface BoardRuntimeConfigRow {
  board_id: string;
  language: string;
  timezone: string;
  standup_cron_local: string;
  digest_cron_local: string;
  review_cron_local: string;
  standup_cron_utc: string;
  digest_cron_utc: string;
  review_cron_utc: string;
  attachment_enabled: number;
  attachment_disabled_reason: string;
  dst_sync_enabled: number;
}

export function nextCronRun(cronExpr: string): string | null {
  try {
    return CronExpressionParser.parse(cronExpr, { tz: 'UTC' }).next().toISOString();
  } catch {
    return null;
  }
}

export function sanitizeFolder(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function uniqueFolder(base: string, existingFolders: Set<string>): string {
  if (!existingFolders.has(base)) return base;
  let suffix = 2;
  while (existingFolders.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

export function generateClaudeMd(templateContent: string, replacements: Record<string, string>): string {
  let content = templateContent;
  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(key).join(value);
  }
  return content;
}

export const ONBOARDING_FILES = [
  'gtd-01-inbox-whatsapp.md',
  'gtd-02-esclarecer-whatsapp.md',
  'gtd-03-organizar-whatsapp.md',
  'gtd-04-revisao-whatsapp.md',
  'gtd-05-executar-whatsapp.md',
] as const;

function onboardingPrompt(filename: string): string {
  return `[TF-ONBOARDING] Read the file /workspace/group/${filename} and send its EXACT contents verbatim to this group via send_message. Do NOT modify, summarize, or add any text — send the file contents as-is. If the file does not exist, do nothing.`;
}

/**
 * Day 1 fires 30 minutes after provisioning; days 2-5 fire at 09:00 local
 * on the next 4 distinct weekdays. Wrapped in a single transaction so a
 * crash mid-loop never leaves a partial onboarding series.
 */
export function scheduleOnboarding(
  tfDb: Database.Database,
  params: { groupFolder: string; groupJid: string; timezone?: string },
): void {
  const tz = params.timezone || 'America/Fortaleza';
  const day1RunAt = new Date(Date.now() + 30 * 60 * 1000);

  const cron = CronExpressionParser.parse('0 9 * * 1-5', { tz, currentDate: day1RunAt });
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const day1LocalDate = localDate.format(day1RunAt);

  tfDb.transaction(() => {
    for (let i = 0; i < ONBOARDING_FILES.length; i++) {
      const file = ONBOARDING_FILES[i]!;
      let runAt: Date;
      if (i === 0) {
        runAt = day1RunAt;
      } else {
        runAt = cron.next().toDate();
        // First cron tick can land on the same local date as day 1 if
        // provisioning happened before 09:00; advance once more so days
        // are distinct.
        if (i === 1 && localDate.format(runAt) === day1LocalDate) {
          runAt = cron.next().toDate();
        }
      }
      const id = newTaskId('task-onboard');
      const runAtIso = runAt.toISOString();
      createTask(tfDb, {
        id,
        group_folder: params.groupFolder,
        chat_jid: params.groupJid,
        prompt: onboardingPrompt(file),
        schedule_type: 'once',
        schedule_value: runAtIso,
        context_mode: 'isolated',
        next_run: runAtIso,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      log.info('Onboarding task scheduled', { taskId: id, file, groupFolder: params.groupFolder, runAt: runAtIso });
    }
  })();
}

export interface ScheduleRunnersParams {
  tfDb: Database.Database;
  boardId: string;
  groupFolder: string;
  groupJid: string;
  standupCronUtc: string;
  digestCronUtc: string;
  reviewCronUtc: string;
  now: string;
}

/**
 * The 3 inserts + 1 UPDATE run in a single transaction so a crash never
 * leaves board_runtime_config pointing at an orphaned task id.
 */
export function scheduleRunners(params: ScheduleRunnersParams): void {
  const { tfDb, boardId, groupFolder, groupJid, standupCronUtc, digestCronUtc, reviewCronUtc, now } = params;
  const runners = [
    { prompt: STANDUP_PROMPT, cron: standupCronUtc },
    { prompt: DIGEST_PROMPT, cron: digestCronUtc },
    { prompt: REVIEW_PROMPT, cron: reviewCronUtc },
  ] as const;

  let standupId = '';
  let digestId = '';
  let reviewId = '';

  tfDb.transaction(() => {
    const ids = runners.map(({ prompt, cron }) => {
      const id = newTaskId();
      createTask(tfDb, {
        id,
        group_folder: groupFolder,
        chat_jid: groupJid,
        prompt,
        schedule_type: 'cron',
        schedule_value: cron,
        context_mode: 'group',
        next_run: nextCronRun(cron),
        status: 'active',
        created_at: now,
      });
      return id;
    });
    [standupId, digestId, reviewId] = ids;

    tfDb
      .prepare(
        `UPDATE board_runtime_config SET
          runner_standup_task_id = ?,
          runner_digest_task_id = ?,
          runner_review_task_id = ?
        WHERE board_id = ?`,
      )
      .run(standupId, digestId, reviewId, boardId);
  })();

  log.info('Board runners scheduled', { standupId, digestId, reviewId, boardId });
}

export interface CreateBoardFilesystemParams {
  groupFolder: string;
  assistantName: string;
  personName: string;
  personPhone: string;
  personId: string;
  language: string;
  timezone: string;
  wipLimit: number;
  boardId: string;
  groupName: string;
  groupContext: string;
  groupJid: string;
  boardRole: string;
  hierarchyLevel: number;
  maxDepth: number;
  parentBoardId: string;
  standupCronUtc: string;
  digestCronUtc: string;
  reviewCronUtc: string;
  standupCronLocal: string;
  digestCronLocal: string;
  reviewCronLocal: string;
  controlGroupHint?: string;
  attachmentEnabled?: boolean;
  attachmentReason?: string;
  dstGuardEnabled?: boolean;
}

export function createBoardFilesystem(params: CreateBoardFilesystemParams): void {
  const groupDir = path.join(GROUPS_DIR, params.groupFolder);
  // logs/ is referenced by the agent template's deny-list — its existence
  // is part of the contract even though nothing reads it.
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  fs.writeFileSync(path.join(groupDir, '.mcp.json'), MCP_JSON_CONTENT + '\n');

  for (const file of ONBOARDING_FILES) {
    const src = path.join(PROJECT_ROOT, 'container', file);
    try {
      fs.copyFileSync(src, path.join(groupDir, file));
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException)?.code;
      if (errCode === 'ENOENT') {
        log.warn('Onboarding file not found, skipping copy', { path: src });
      } else {
        throw err;
      }
    }
  }

  try {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    const replacements: Record<string, string> = {
      '{{ASSISTANT_NAME}}': params.assistantName,
      '{{MANAGER_NAME}}': params.personName,
      '{{MANAGER_PHONE}}': params.personPhone,
      '{{MANAGER_ID}}': params.personId,
      '{{LANGUAGE}}': params.language,
      '{{TIMEZONE}}': params.timezone,
      '{{WIP_LIMIT}}': String(params.wipLimit),
      '{{BOARD_ID}}': params.boardId,
      '{{GROUP_NAME}}': params.groupName,
      '{{GROUP_CONTEXT}}': params.groupContext,
      '{{GROUP_JID}}': params.groupJid,
      '{{CONTROL_GROUP_HINT}}': params.controlGroupHint || '',
      '{{BOARD_ROLE}}': params.boardRole,
      '{{HIERARCHY_LEVEL}}': String(params.hierarchyLevel),
      '{{MAX_DEPTH}}': String(params.maxDepth),
      '{{PARENT_BOARD_ID}}': params.parentBoardId,
      '{{STANDUP_CRON}}': params.standupCronUtc,
      '{{DIGEST_CRON}}': params.digestCronUtc,
      '{{REVIEW_CRON}}': params.reviewCronUtc,
      '{{STANDUP_CRON_LOCAL}}': params.standupCronLocal,
      '{{DIGEST_CRON_LOCAL}}': params.digestCronLocal,
      '{{REVIEW_CRON_LOCAL}}': params.reviewCronLocal,
      '{{ATTACHMENT_IMPORT_ENABLED}}': params.attachmentEnabled ? 'true' : 'false',
      '{{ATTACHMENT_IMPORT_REASON}}': params.attachmentReason || '',
      '{{DST_GUARD_ENABLED}}': params.dstGuardEnabled !== false ? 'true' : 'false',
    };
    const claudeMd = generateClaudeMd(template, replacements);
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), claudeMd);
    log.info('CLAUDE.local.md generated', { path: path.join(groupDir, 'CLAUDE.local.md') });
  } catch (err) {
    const errCode = (err as NodeJS.ErrnoException)?.code;
    if (errCode === 'ENOENT') {
      log.warn('Template not found, skipping CLAUDE.local.md generation', { templatePath: TEMPLATE_PATH });
    } else {
      throw err;
    }
  }
}

/**
 * Best-effort chown of TaskFlow-managed paths to nanoclaw:nanoclaw so the
 * container (UID 1000) can read/write them.
 *
 * Silently fails if not running as root — fine for dev environments where
 * the host user is already nanoclaw and chown is a no-op.
 */
export function fixOwnership(...paths: string[]): void {
  try {
    execSync(`chown -R nanoclaw:nanoclaw ${paths.map((p) => JSON.stringify(p)).join(' ')}`, { timeout: 5000 });
  } catch {
    // Best-effort
  }
}

/**
 * Sends a plain-text chat message via the channel adapter. Object content
 * is required — adapters cast `message.content` to Record<string,unknown>
 * with no JSON.parse, so a stringified payload silently no-ops.
 */
export async function deliverPlainText(adapter: ChannelAdapter, platformId: string, text: string): Promise<void> {
  await adapter.deliver(platformId, null, {
    kind: 'chat',
    content: { type: 'text', text },
  });
}

export function markWelcomeSent(tfDb: Database.Database, boardId: string): void {
  tfDb.prepare('UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?').run(boardId);
}

export function buildWelcomeMessage(groupName: string, lead = 'Bem-vindo ao'): string {
  return `👋 *${lead} ${groupName}!*\n\nEste é o seu quadro de tarefas. Aqui você receberá tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para ver os comandos disponíveis.`;
}

export interface WireV2Params {
  agentGroupId: string;
  agentName: string;
  folder: string;
  groupJid: string;
  groupName: string;
  engageMode: 'pattern' | 'mention';
  engagePattern: string | null;
}

/**
 * Atomic 3-row insert (agent_group + messaging_group + wiring). All must
 * land together — partial state would leave taskflow.db pointing at a
 * folder that has no live agent, and a retry would see a folder collision.
 */
export function wireV2(params: WireV2Params): void {
  const ts = new Date().toISOString();
  getDb().transaction(() => {
    createAgentGroup({
      id: params.agentGroupId,
      name: params.agentName,
      folder: params.folder,
      agent_provider: 'claude',
      created_at: ts,
    });

    const messagingGroupId = newTaskId('mg');
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: 'whatsapp',
      platform_id: params.groupJid,
      name: params.groupName,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: ts,
    });

    createMessagingGroupAgent({
      id: newTaskId('mga'),
      messaging_group_id: messagingGroupId,
      agent_group_id: params.agentGroupId,
      engage_mode: params.engageMode,
      engage_pattern: params.engagePattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: ts,
    });
  })();
}

/**
 * Pick a folder name unique against existing agent_groups.folder values.
 * Returns null if the result fails the on-disk-folder safety check.
 */
export function pickUniqueAgentFolder(base: string, existingFolders: Set<string>): string | null {
  const folder = uniqueFolder(base, existingFolders);
  return isValidGroupFolder(folder) ? folder : null;
}
