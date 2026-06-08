import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import type { ChannelAdapter } from '../../channels/adapter.js';
import { DATA_DIR, GROUPS_DIR, PROJECT_ROOT, TIMEZONE } from '../../config.js';
import { isValidTimezone } from '../../timezone.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { isValidGroupFolder } from '../../group-folder.js';
import { migrateBoardClaudeMd } from './migrate-board-claudemd.js';
import { insertTask } from '../scheduling/db.js';
import { log } from '../../log.js';
import { openInboundDb, resolveSession } from '../../session-manager.js';
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

// Motivational-only scheduled posts (V1 parity). A scheduled [TF-STANDUP] /
// [TF-DIGEST] / [TF-REVIEW] run sends ONE warm motivational narrative written
// FROM the report data — never the rendered formatted_board / formatted_report
// task list. The rendered board/report is reserved for explicit on-demand human
// requests (e.g. "mostrar o quadro"), handled by the per-board CLAUDE.md.
// Each prompt reads via api_report (the registered v2 report tool; board_id is
// auto-filled) so the agent has the data to narrate, then sends a single
// send_message. PARENT_BOARD_HINT is retained so the narrative also accounts for
// this board's people's parent-board tasks (read scope only — the runner gate's
// runner-state check assumes the runners report that scope).
export const STANDUP_PROMPT =
  "[TF-STANDUP] You are running the morning standup for this group. Read the board data with api_report({ type: 'standup' }) — do NOT send its formatted_board. Also run the bundled housekeeping it performs (auto-archive of done tasks older than 30 days) silently. If no tasks exist on your board AND no parent-board tasks are assigned to your people, do NOT send any message — exit silently. Otherwise send EXACTLY ONE send_message: a warm good-morning motivational narrative written from that data — who's moving things, what's overdue or due today, what's blocked on others, completions and streaks — naming people, acknowledging dependencies honestly, encouraging, never pressuring or guilting. If meetings exist for today, mention them naturally in the prose. NEVER send the rendered board (formatted_board) or a per-column task list. The full board is reserved for explicit on-demand requests. Note: send_message sends to this group only — individual DMs are not supported." +
  PARENT_BOARD_HINT;
export const DIGEST_PROMPT =
  "[TF-DIGEST] You are sending the evening digest for this task group. Read the board data with api_report({ type: 'digest' }) — do NOT send its formatted_report. If no tasks exist on your board AND no parent-board tasks are assigned to your people, do NOT send any message — exit silently. Otherwise send EXACTLY ONE send_message: a warm evening motivational narrative written from that data — completions today (credit the person who did the work by name), what's in flight, what's overdue or due soon, what's blocked, streaks, and any meetings with unprocessed minutes — in flowing prose, never a per-task or per-column list, never pressuring or guilting. On Fridays, close the week: look at the whole week, name what this person or team made possible, then let them go into the weekend. NEVER send the rendered report (formatted_report) or a task list. The full report is reserved for explicit on-demand requests. Note: send_message sends to this group only — individual DMs are not supported." +
  PARENT_BOARD_HINT;
export const REVIEW_PROMPT =
  "[TF-REVIEW] You are running the weekly (Friday) review for this task group. Read the week's data with api_report({ type: 'weekly' }) — do NOT send its formatted_report. If no tasks exist on your board AND no parent-board tasks are assigned to your people, do NOT send any message — exit silently, even if there was archive activity this week. Otherwise send EXACTLY ONE send_message: a warm end-of-week motivational narrative written from that data — the week's completions and who delivered (name them), backlog trend (created vs completed), what's still overdue or stuck, streaks, next week's deadlines, and any meetings with open minutes — in flowing prose, never a per-column list, never pressuring or guilting. Close the week with encouragement and recognition of effort. NEVER send the rendered report (formatted_report) or a task list. The full report is reserved for explicit on-demand requests. Note: send_message sends to this group only — individual DMs are not supported." +
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

/**
 * Resolve a v2 agent folder to a taskflow board, falling back to the
 * board_groups many-to-many table when boards.group_folder doesn't match
 * directly. Mirrors src/taskflow-db.ts:resolveTaskflowBoardId but returns
 * the full BoardRow (callers need hierarchy_level/max_depth/etc.).
 *
 * Used by provision_child_board and create_group, where v1-level folder
 * drift between registered_groups.folder (carried into agent_groups by
 * migrate-v2/db.ts) and boards.group_folder (preserved verbatim in v1's
 * taskflow.db) means a direct boards lookup would miss the parent for
 * groups whose folder was renamed in v2 but not in the board. The
 * board_groups insert performed in /migrate-from-v1 Phase 1b is the
 * only thing that gets resolution back to working — but only if both
 * code paths consult it. Without this helper, those two MCP tools
 * would silently no-op for drifted folders.
 */
export function findBoardByFolder(tfDb: Database.Database, folder: string): BoardRow | undefined {
  const direct = tfDb.prepare('SELECT * FROM boards WHERE group_folder = ? LIMIT 1').get(folder) as
    | BoardRow
    | undefined;
  if (direct) return direct;
  // ORDER BY board_id for determinism — board_groups has PRIMARY KEY
  // (board_id, group_jid), so the SAME group_folder can legally appear in
  // multiple rows pointing to different boards (e.g., an operator-side
  // misconfiguration). Without ORDER BY, SQLite's row order is undefined
  // and the same call could resolve to different boards across reruns or
  // after a VACUUM — causing nondeterministic provision_child_board /
  // create_group authorization.
  const mapping = tfDb
    .prepare('SELECT board_id FROM board_groups WHERE group_folder = ? ORDER BY board_id LIMIT 1')
    .get(folder) as { board_id: string } | undefined;
  if (!mapping) return undefined;
  return tfDb.prepare('SELECT * FROM boards WHERE id = ? LIMIT 1').get(mapping.board_id) as BoardRow | undefined;
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

export interface SeedBoardCoreParams {
  boardId: string;
  groupJid: string;
  folder: string;
  hierarchyLevel: number;
  maxDepth: number;
  parentBoardId: string | null;
  shortCode: string | null;
  /** null for root boards; the provisioned person for child boards. */
  ownerPersonId: string | null;
  wipLimit: number;
  /** All runtime values pre-resolved by the caller (root from input, child
   *  inherited from the parent's `board_runtime_config`). */
  runtime: Omit<BoardRuntimeConfigRow, 'board_id'>;
  /** The provisioned person, who is also the board's primary manager. */
  person: { personId: string; name: string; phone: string; role: string };
}

/**
 * Seeds the five board-defining rows shared by root and child provisioning:
 * `boards`, `board_config`, `board_runtime_config`, `board_admins` (primary
 * manager = the provisioned person), and `board_people`. Every value is
 * resolved by the caller (root from operator input, child inherited from the
 * parent), so this stays a pure write of already-decided state. The caller
 * owns the surrounding transaction and any handler-specific writes
 * (`task_history`, `child_board_registrations`, parent-task re-linking); call
 * this INSIDE that `tfDb.transaction` so the board seed is atomic with them.
 */
export function seedBoardCore(tfDb: Database.Database, p: SeedBoardCoreParams): void {
  tfDb
    .prepare(
      'INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code, owner_person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      p.boardId,
      p.groupJid,
      p.folder,
      'hierarchy',
      p.hierarchyLevel,
      p.maxDepth,
      p.parentBoardId,
      p.shortCode,
      p.ownerPersonId,
    );

  tfDb.prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, ?)').run(p.boardId, p.wipLimit);

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
      p.boardId,
      p.runtime.language,
      p.runtime.timezone,
      p.runtime.standup_cron_local,
      p.runtime.digest_cron_local,
      p.runtime.review_cron_local,
      p.runtime.standup_cron_utc,
      p.runtime.digest_cron_utc,
      p.runtime.review_cron_utc,
      p.runtime.attachment_enabled,
      p.runtime.attachment_disabled_reason,
      p.runtime.dst_sync_enabled,
    );

  tfDb
    .prepare(
      'INSERT INTO board_admins (board_id, person_id, phone, admin_role, is_primary_manager) VALUES (?, ?, ?, ?, ?)',
    )
    .run(p.boardId, p.person.personId, p.person.phone, 'manager', 1);

  tfDb
    .prepare(
      'INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit, notification_group_jid) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(p.boardId, p.person.personId, p.person.name, p.person.phone, p.person.role, p.wipLimit, null);
}

/** v2 task envelope shape expected by the agent runner: it does
 *  `JSON.parse(content)` and reads `.prompt` and `.script`. Raw strings
 *  silently corrupt — use this helper at every insertTask call site. */
export function taskEnvelope(prompt: string, script: string | null = null): string {
  return JSON.stringify({ prompt, script });
}

export function nextCronRun(cronExpr: string, tz: string = 'UTC'): string | null {
  try {
    return CronExpressionParser.parse(cronExpr, { tz }).next().toISOString();
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

/**
 * Render a board's CLAUDE.md for provisioning: fill `{{placeholders}}`, then normalize the
 * template's v1 `taskflow_*` tool vocabulary to the registered v2 `api_*` names. The template
 * ships in v1 vocabulary (it is also the source the migration path rewrites for existing
 * boards); without this step a freshly-provisioned board would instruct the agent to call
 * tools that are not registered. Same substitution as the migration path — one source of truth.
 */
export function renderBoardClaudeMd(templateContent: string, replacements: Record<string, string>): string {
  return migrateBoardClaudeMd(generateClaudeMd(templateContent, replacements)).output;
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
export function scheduleOnboarding(params: { inboundDb: Database.Database; timezone?: string }): void {
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

  params.inboundDb.transaction(() => {
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
      insertTask(params.inboundDb, {
        id,
        processAfter: runAtIso,
        recurrence: null,
        platformId: null,
        channelType: null,
        threadId: null,
        content: taskEnvelope(onboardingPrompt(file)),
      });
      log.info('Onboarding task scheduled', { taskId: id, file, runAt: runAtIso });
    }
  })();
}

export interface ScheduleRunnersParams {
  /** Taskflow DB — only used for the board_runtime_config UPDATE that
   *  records which task IDs are this board's runners (lifecycle ops). */
  tfDb: Database.Database;
  /** Session inbound.db — where the host poll loop reads tasks. */
  inboundDb: Database.Database;
  boardId: string;
  /** Local cron expressions (the board_runtime_config `*_cron_local` columns, NOT `*_cron_utc`),
   *  interpreted in `boardTimezone`. The recurrence fanout (handleRecurrence) re-parses the same
   *  local cron in the same board zone, so the first run and every subsequent run share one zone. */
  standupCronLocal: string;
  digestCronLocal: string;
  reviewCronLocal: string;
  /** The board's IANA timezone (board_runtime_config.timezone); the local crons above are
   *  interpreted in it. Omitted → global TIMEZONE (every board today is the deploy zone, so the
   *  default is a no-op). */
  boardTimezone?: string;
}

/**
 * Cross-DB write order: tfDb UPDATE FIRST (with pre-generated task IDs),
 * inboundDb INSERT SECOND. Failure mode if host crashes between them is
 * `board_runtime_config` pointing at task IDs that don't exist in
 * messages_in — re-provision overwrites these stale IDs cleanly.
 *
 * If we did INSERT first then UPDATE, a crash in between would leave 3
 * recurring messages_in rows firing forever with no `board_runtime_config`
 * handle to find them by — operator could not cancel without manual SQL.
 */
export function scheduleRunners(params: ScheduleRunnersParams): void {
  const { tfDb, inboundDb, boardId, standupCronLocal, digestCronLocal, reviewCronLocal } = params;
  // Interpret the local crons in the board's own zone (Option A per-board TZ). An invalid/garbage
  // board timezone falls back to the global TIMEZONE so a corrupt board_runtime_config never leaves
  // a board with NO runners (nextCronRun would otherwise throw on a bad zone); a Fortaleza board is
  // the no-op default. handleRecurrence (the fanout) and the runner gate now parse the same local
  // cron in this same zone, so a runner's fire time and the gate's window stay aligned.
  const tz = params.boardTimezone && isValidTimezone(params.boardTimezone) ? params.boardTimezone : TIMEZONE;
  const runners = [
    { prompt: STANDUP_PROMPT, cron: standupCronLocal },
    { prompt: DIGEST_PROMPT, cron: digestCronLocal },
    { prompt: REVIEW_PROMPT, cron: reviewCronLocal },
  ] as const;

  const planned = runners.map(({ prompt, cron }) => {
    const processAfter = nextCronRun(cron, tz);
    if (processAfter === null) {
      throw new Error(`scheduleRunners: nextCronRun returned null for cron='${cron}'`);
    }
    return {
      id: newTaskId(),
      processAfter,
      recurrence: cron,
      content: taskEnvelope(prompt),
    };
  });

  const [standupId, digestId, reviewId] = [planned[0]!.id, planned[1]!.id, planned[2]!.id];
  tfDb
    .prepare(
      `UPDATE board_runtime_config SET
        runner_standup_task_id = ?,
        runner_digest_task_id = ?,
        runner_review_task_id = ?
      WHERE board_id = ?`,
    )
    .run(standupId, digestId, reviewId, boardId);

  inboundDb.transaction(() => {
    for (const p of planned) {
      insertTask(inboundDb, {
        id: p.id,
        processAfter: p.processAfter,
        recurrence: p.recurrence,
        platformId: null,
        channelType: null,
        threadId: null,
        content: p.content,
      });
    }
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
    const claudeMd = renderBoardClaudeMd(template, replacements);
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

export function buildRootWelcomeMessage(groupName: string): string {
  return `👋 *Bem-vindo ao ${groupName}!*\n\nEste é o seu quadro de tarefas. Aqui você receberá tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para ver os comandos disponíveis.`;
}

export function buildChildWelcomeMessage(groupName: string): string {
  return `👋 *Bem-vindo ao ${groupName}!*\n\nEste é o seu quadro de tarefas pessoal. Aqui você receberá suas tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para ver os comandos disponíveis.`;
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

/** Eagerly create the session for a freshly-wired board and return its
 *  inbound.db handle, so the provision flow can write recurring/onboarding
 *  task messages directly into v2's scheduler queue. The caller must
 *  close the handle. */
export function ensureSessionInbound(agentGroupId: string, messagingGroupId: string): Database.Database {
  const { session } = resolveSession(agentGroupId, messagingGroupId, null, 'shared');
  return openInboundDb(agentGroupId, session.id);
}

/**
 * Atomic 3-row insert (agent_group + messaging_group + wiring). All must
 * land together — partial state would leave taskflow.db pointing at a
 * folder that has no live agent, and a retry would see a folder collision.
 */
export function wireV2(params: WireV2Params): { messagingGroupId: string } {
  const ts = new Date().toISOString();
  const messagingGroupId = newTaskId('mg');
  getDb().transaction(() => {
    createAgentGroup({
      id: params.agentGroupId,
      name: params.agentName,
      folder: params.folder,
      agent_provider: 'claude',
      created_at: ts,
    });

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
  return { messagingGroupId };
}

/**
 * Pick a folder name unique against existing agent_groups.folder values.
 * Returns null if the result fails the on-disk-folder safety check.
 */
export function pickUniqueAgentFolder(base: string, existingFolders: Set<string>): string | null {
  const folder = uniqueFolder(base, existingFolders);
  return isValidGroupFolder(folder) ? folder : null;
}
