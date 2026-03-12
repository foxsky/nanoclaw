import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, PROJECT_ROOT } from '../config.js';
import { createTask } from '../db.js';
import { logger } from '../logger.js';
import { computeNextRun } from '../task-scheduler.js';

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
  return computeNextRun({
    schedule_type: 'cron',
    schedule_value: cronExpr,
  } as import('../types.js').ScheduledTask);
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

export function uniqueFolder(
  base: string,
  existingFolders: Set<string>,
): string {
  if (!existingFolders.has(base)) return base;
  let suffix = 2;
  while (existingFolders.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

export function generateClaudeMd(
  templateContent: string,
  replacements: Record<string, string>,
): string {
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

export function scheduleOnboarding(params: {
  groupFolder: string;
  groupJid: string;
  timezone?: string;
}): void {
  const now = Date.now();
  const tz = params.timezone || 'America/Fortaleza';
  const day1RunAt = new Date(now + 30 * 60 * 1000);

  // "09:00 on weekdays" — anchored after Day 1 so Day 2 is always later
  const cron = CronExpressionParser.parse('0 9 * * 1-5', {
    tz,
    currentDate: day1RunAt,
  });

  for (let i = 0; i < ONBOARDING_FILES.length; i++) {
    const file = ONBOARDING_FILES[i];
    let runAt: Date;
    if (i === 0) {
      // Day 1: 30 minutes from now (regardless of weekday)
      runAt = day1RunAt;
    } else {
      // Days 2-5: next distinct weekdays at 09:00 local (DST-aware)
      runAt = cron.next().toDate();
    }
    const id = `task-onboard-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const runAtIso = runAt.toISOString();
    createTask({
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
    logger.info(
      { taskId: id, file, groupFolder: params.groupFolder, runAt: runAtIso },
      'Onboarding task scheduled',
    );
  }
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

export function scheduleRunners(params: ScheduleRunnersParams): void {
  const {
    tfDb,
    boardId,
    groupFolder,
    groupJid,
    standupCronUtc,
    digestCronUtc,
    reviewCronUtc,
    now,
  } = params;
  const runners = [
    { prompt: STANDUP_PROMPT, cron: standupCronUtc },
    { prompt: DIGEST_PROMPT, cron: digestCronUtc },
    { prompt: REVIEW_PROMPT, cron: reviewCronUtc },
  ] as const;

  const runnerIds = runners.map(({ prompt, cron }) => {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createTask({
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

  const [standupId, digestId, reviewId] = runnerIds;

  tfDb
    .prepare(
      `UPDATE board_runtime_config SET
        runner_standup_task_id = ?,
        runner_digest_task_id = ?,
        runner_review_task_id = ?
      WHERE board_id = ?`,
    )
    .run(standupId, digestId, reviewId, boardId);

  logger.info(
    { standupId, digestId, reviewId, boardId },
    'Board runners scheduled',
  );
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

export function createBoardFilesystem(
  params: CreateBoardFilesystemParams,
): void {
  const groupDir = path.join(PROJECT_ROOT, 'groups', params.groupFolder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // .mcp.json
  fs.writeFileSync(path.join(groupDir, '.mcp.json'), MCP_JSON_CONTENT + '\n');

  // Onboarding series (5-day GTD course, read by scheduled onboarding tasks)
  for (const file of ONBOARDING_FILES) {
    const src = path.join(PROJECT_ROOT, 'container', file);
    try {
      fs.copyFileSync(src, path.join(groupDir, file));
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        logger.warn({ path: src }, 'Onboarding file not found, skipping copy');
      } else {
        throw err;
      }
    }
  }

  // CLAUDE.md from template
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
      '{{ATTACHMENT_IMPORT_ENABLED}}': params.attachmentEnabled
        ? 'true'
        : 'false',
      '{{ATTACHMENT_IMPORT_REASON}}': params.attachmentReason || '',
      '{{DST_GUARD_ENABLED}}':
        params.dstGuardEnabled !== false ? 'true' : 'false',
    };
    const claudeMd = generateClaudeMd(template, replacements);
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMd);
    logger.info(
      { path: path.join(groupDir, 'CLAUDE.md') },
      'CLAUDE.md generated',
    );
  } catch (templateErr: any) {
    if (templateErr?.code === 'ENOENT') {
      logger.warn(
        { templatePath: TEMPLATE_PATH },
        'Template not found, skipping CLAUDE.md generation',
      );
    } else {
      throw templateErr;
    }
  }
}

export function fixOwnership(...paths: string[]): void {
  try {
    execSync(
      `chown -R nanoclaw:nanoclaw ${paths.map((p) => JSON.stringify(p)).join(' ')}`,
      { timeout: 5000 },
    );
  } catch {
    // Best-effort; may fail if not running as root
  }
}
