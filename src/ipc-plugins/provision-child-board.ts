import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, getGroupSenderName, PROJECT_ROOT } from '../config.js';
import { createTask } from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import type { IpcHandler } from '../ipc.js';
import { logger } from '../logger.js';
import { computeNextRun } from '../task-scheduler.js';

const TASKFLOW_DB_PATH = path.join(DATA_DIR, 'taskflow', 'taskflow.db');
const TEMPLATE_PATH = path.join(
  PROJECT_ROOT,
  '.claude',
  'skills',
  'add-taskflow',
  'templates',
  'CLAUDE.md.template',
);
const MCP_JSON_CONTENT = JSON.stringify(
  {
    mcpServers: {
      sqlite: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-server-sqlite-npx', '/workspace/taskflow/taskflow.db'],
      },
    },
  },
  null,
  2,
);

const STANDUP_PROMPT =
  "[TF-STANDUP] You are running the morning standup for this group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks, board_people, board_config for your board_id. If no tasks exist, do NOT send any message — just perform housekeeping (archival) silently and exit. Otherwise: 1) Send the Kanban board to this group via send_message (grouped by column, show overdue with 🔴). 2) Include per-person sections in the group message with their personal board, WIP status (X/Y), and prompt for updates. 3) Check for tasks with column = 'done' and updated_at older than 30 days — INSERT them into archive and DELETE from tasks. 4) List any inbox items that need processing. Note: send_message sends to this group only — individual DMs are not supported.";
const DIGEST_PROMPT =
  "[TF-DIGEST] You are generating the manager digest for this task group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks for your board_id. If no tasks exist, do NOT send any message — exit silently. Otherwise consolidate: 🔥 Overdue tasks, ⏳ Tasks due in next 48h, 🚧 Waiting/blocked tasks, 💤 Tasks with no update in 24h+, ✅ Tasks completed today. Format as a concise executive summary and suggest 3 specific follow-up actions with task IDs. Send the digest to this group via send_message. Note: send_message sends to this group only — individual DMs are not supported.";
const REVIEW_PROMPT =
  "[TF-REVIEW] You are running the weekly GTD review for this task group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks and archive for your board_id. If no tasks exist, do NOT send any message — exit silently, even if there was archive activity this week. Otherwise produce: 1) Summary: completed, created, overdue this week. 2) Inbox items pending processing. 3) Waiting tasks older than 5 days (suggest follow-up). 4) Overdue tasks (suggest action). 5) In Progress tasks with no update in 3+ days. 6) Next week preview (deadlines and recurrences). 7) Per-person weekly summaries inline. Send the full review to this group via send_message. Note: send_message sends to this group only — individual DMs are not supported.";

interface BoardRow {
  id: string;
  group_jid: string;
  group_folder: string;
  board_role: string;
  hierarchy_level: number;
  max_depth: number;
  parent_board_id: string | null;
}

interface BoardConfigRow {
  board_id: string;
  wip_limit: number;
}

interface BoardRuntimeConfigRow {
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

/** Wrapper to compute next cron run using the shared computeNextRun from task-scheduler. */
function nextCronRun(cronExpr: string): string | null {
  return computeNextRun({
    schedule_type: 'cron',
    schedule_value: cronExpr,
  } as import('../types.js').ScheduledTask);
}

function sanitizeFolder(personId: string): string {
  return personId
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateClaudeMd(
  templateContent: string,
  replacements: Record<string, string>,
): string {
  let content = templateContent;
  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(key).join(value);
  }
  return content;
}

const handleProvisionChildBoard: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  // --- 1. Validate source authorization ---
  const registeredGroups = deps.registeredGroups();
  const [sourceGroupJid, sourceEntry] = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === sourceGroup,
  ) ?? [undefined, undefined];

  if (!sourceEntry || !sourceEntry.taskflowManaged) {
    logger.warn({ sourceGroup }, 'provision_child_board: not a TaskFlow group');
    return;
  }

  if (
    sourceEntry.taskflowHierarchyLevel === undefined ||
    sourceEntry.taskflowMaxDepth === undefined ||
    sourceEntry.taskflowHierarchyLevel + 1 >= sourceEntry.taskflowMaxDepth
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
    const parentBoard = tfDb
      .prepare('SELECT * FROM boards WHERE group_folder = ?')
      .get(sourceGroup) as BoardRow | undefined;

    if (!parentBoard) {
      logger.warn({ sourceGroup }, 'provision_child_board: parent board not found');
      return;
    }

    const parentConfig = tfDb
      .prepare('SELECT * FROM board_config WHERE board_id = ?')
      .get(parentBoard.id) as BoardConfigRow | undefined;

    const parentRuntime = tfDb
      .prepare('SELECT * FROM board_runtime_config WHERE board_id = ?')
      .get(parentBoard.id) as BoardRuntimeConfigRow | undefined;

    if (!parentConfig || !parentRuntime) {
      logger.warn(
        { boardId: parentBoard.id },
        'provision_child_board: parent config/runtime not found',
      );
      return;
    }

    // --- 4. Check person not already registered ---
    const existing = tfDb
      .prepare(
        'SELECT 1 FROM child_board_registrations WHERE parent_board_id = ? AND person_id = ?',
      )
      .get(parentBoard.id, personId);

    if (existing) {
      logger.warn(
        { parentBoardId: parentBoard.id, personId },
        'provision_child_board: child board already registered for this person',
      );
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
    const existingFolders = new Set(
      Object.values(registeredGroups).map((g) => g.folder),
    );
    if (existingFolders.has(childGroupFolder)) {
      let suffix = 2;
      while (existingFolders.has(`${childGroupFolder}-${suffix}`)) {
        suffix++;
      }
      childGroupFolder = `${childGroupFolder}-${suffix}`;
    }

    if (!isValidGroupFolder(childGroupFolder)) {
      logger.warn(
        { childGroupFolder },
        'provision_child_board: invalid group folder name',
      );
      return;
    }

    const childGroupName =
      typeof data.group_name === 'string' && data.group_name.trim()
        ? data.group_name.trim()
        : personName + ' - TaskFlow';

    const childBoardId = 'board-' + childGroupFolder;

    // --- 6. Resolve phone JID and create WhatsApp group ---
    let childGroupJid: string;
    try {
      const participantJid = deps.resolvePhoneJid
        ? await deps.resolvePhoneJid(personPhone)
        : personPhone + '@s.whatsapp.net';
      const result = await deps.createGroup(childGroupName, [participantJid]);
      childGroupJid = result.jid;
      logger.info(
        { jid: childGroupJid, subject: result.subject },
        'provision_child_board: WhatsApp group created',
      );
    } catch (err) {
      logger.error(
        { err, childGroupName },
        'provision_child_board: failed to create WhatsApp group',
      );
      return;
    }

    // --- 7. Register child group ---
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
      logger.info(
        { jid: childGroupJid, folder: childGroupFolder },
        'provision_child_board: group registered',
      );
    } catch (err) {
      logger.error(
        { err, childGroupJid },
        'provision_child_board: failed to register group',
      );
      return;
    }

    // --- 8. Seed child board in taskflow.db (single transaction) ---
    const now = new Date().toISOString();

    const seedTransaction = tfDb.transaction(() => {
      // Board row
      tfDb
        .prepare(
          'INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          childBoardId,
          childGroupJid,
          childGroupFolder,
          'hierarchy',
          childLevel,
          parentBoard.max_depth,
          parentBoard.id,
        );

      // Child board registration
      tfDb
        .prepare(
          'INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, ?, ?)',
        )
        .run(parentBoard.id, personId, childBoardId);

      // Board config
      tfDb
        .prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, ?)')
        .run(childBoardId, parentConfig.wip_limit);

      // Board runtime config (inherit from parent)
      tfDb
        .prepare(
          `INSERT INTO board_runtime_config (
            board_id, language, timezone,
            standup_cron_local, digest_cron_local, review_cron_local,
            standup_cron_utc, digest_cron_utc, review_cron_utc,
            attachment_enabled, attachment_disabled_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );

      // Board admin (person becomes manager of their own board)
      tfDb
        .prepare(
          'INSERT INTO board_admins (board_id, person_id, phone, admin_role, is_primary_manager) VALUES (?, ?, ?, ?, ?)',
        )
        .run(childBoardId, personId, personPhone, 'manager', 1);

      // Person as member on their board
      tfDb
        .prepare(
          'INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit, notification_group_jid) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          childBoardId,
          personId,
          personName,
          personPhone,
          personRole,
          parentConfig.wip_limit,
          null,
        );

      // Update parent board_people with notification_group_jid
      tfDb
        .prepare(
          'UPDATE board_people SET notification_group_jid = ? WHERE board_id = ? AND person_id = ?',
        )
        .run(childGroupJid, parentBoard.id, personId);

      // Record history
      tfDb
        .prepare(
          'INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES (?, ?, ?, ?, ?, ?)',
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
        );
    });

    try {
      seedTransaction();
      logger.info(
        { childBoardId, parentBoardId: parentBoard.id },
        'provision_child_board: taskflow DB seeded',
      );
    } catch (err) {
      logger.error(
        { err, childBoardId },
        'provision_child_board: failed to seed taskflow DB',
      );
      return;
    }

    // --- 9. Create filesystem ---
    const groupDir = path.join(PROJECT_ROOT, 'groups', childGroupFolder);
    try {
      fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

      // Write .mcp.json
      fs.writeFileSync(
        path.join(groupDir, '.mcp.json'),
        MCP_JSON_CONTENT + '\n',
      );

      // Generate CLAUDE.md from template
      try {
        const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

        const replacements: Record<string, string> = {
          '{{ASSISTANT_NAME}}': assistantName,
          '{{MANAGER_NAME}}': personName,
          '{{MANAGER_PHONE}}': personPhone,
          '{{MANAGER_ID}}': personId,
          '{{LANGUAGE}}': parentRuntime.language,
          '{{TIMEZONE}}': parentRuntime.timezone,
          '{{WIP_LIMIT}}': String(parentConfig.wip_limit),
          '{{BOARD_ID}}': childBoardId,
          '{{GROUP_NAME}}': childGroupName,
          '{{GROUP_CONTEXT}}': `${personName}'s tasks (private standup channel)`,
          '{{GROUP_JID}}': childGroupJid,
          '{{CONTROL_GROUP_HINT}}': '',
          '{{BOARD_ROLE}}': 'hierarchy',
          '{{HIERARCHY_LEVEL}}': String(childLevel),
          '{{MAX_DEPTH}}': String(parentBoard.max_depth),
          '{{PARENT_BOARD_ID}}': parentBoard.id,
          '{{STANDUP_CRON}}': parentRuntime.standup_cron_utc,
          '{{DIGEST_CRON}}': parentRuntime.digest_cron_utc,
          '{{REVIEW_CRON}}': parentRuntime.review_cron_utc,
          '{{STANDUP_CRON_LOCAL}}': parentRuntime.standup_cron_local,
          '{{DIGEST_CRON_LOCAL}}': parentRuntime.digest_cron_local,
          '{{REVIEW_CRON_LOCAL}}': parentRuntime.review_cron_local,
          '{{ATTACHMENT_IMPORT_ENABLED}}': parentRuntime.attachment_enabled
            ? 'true'
            : 'false',
          '{{ATTACHMENT_IMPORT_REASON}}':
            parentRuntime.attachment_disabled_reason || '',
          '{{DST_GUARD_ENABLED}}': parentRuntime.dst_sync_enabled
            ? 'true'
            : 'false',
        };

        const claudeMd = generateClaudeMd(template, replacements);
        fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMd);
        logger.info(
          { path: path.join(groupDir, 'CLAUDE.md') },
          'provision_child_board: CLAUDE.md generated',
        );
      } catch (templateErr: any) {
        if (templateErr?.code === 'ENOENT') {
          logger.warn(
            { templatePath: TEMPLATE_PATH },
            'provision_child_board: template not found, skipping CLAUDE.md generation',
          );
        } else {
          throw templateErr;
        }
      }
    } catch (err) {
      logger.error(
        { err, groupDir },
        'provision_child_board: failed to create filesystem',
      );
      // Continue — group and DB are already provisioned
    }

    // --- 10. Schedule runners ---
    try {
      const runners = [
        { prompt: STANDUP_PROMPT, cron: parentRuntime.standup_cron_utc },
        { prompt: DIGEST_PROMPT, cron: parentRuntime.digest_cron_utc },
        { prompt: REVIEW_PROMPT, cron: parentRuntime.review_cron_utc },
      ] as const;

      const runnerIds = runners.map(({ prompt, cron }) => {
        const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createTask({
          id,
          group_folder: childGroupFolder,
          chat_jid: childGroupJid,
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

      // Store runner IDs in board_runtime_config
      tfDb
        .prepare(
          `UPDATE board_runtime_config SET
            runner_standup_task_id = ?,
            runner_digest_task_id = ?,
            runner_review_task_id = ?
          WHERE board_id = ?`,
        )
        .run(standupId, digestId, reviewId, childBoardId);

      logger.info(
        { standupId, digestId, reviewId },
        'provision_child_board: runners scheduled',
      );
    } catch (err) {
      logger.error(
        { err },
        'provision_child_board: failed to schedule runners',
      );
      // Continue — board is functional without runners
    }

    // --- 11. Fix ownership ---
    try {
      execSync(
        `chown -R nanoclaw:nanoclaw ${JSON.stringify(groupDir)}`,
        { timeout: 5000 },
      );
    } catch {
      // Best-effort; may fail if not running as root
    }

    // --- 12. Send confirmation ---
    if (sourceGroupJid) {
      try {
        await deps.sendMessage(
          sourceGroupJid,
          `✅ Quadro de ${personName} provisionado automaticamente.\n\nGrupo: ${childGroupName}\nQuadro: ${childBoardId}\n\nO quadro estará disponível na próxima interação.`,
          assistantName,
        );
      } catch (err) {
        logger.error(
          { err },
          'provision_child_board: failed to send confirmation',
        );
      }
    }

    // --- 13. Send welcome message to child group ---
    try {
      await deps.sendMessage(
        childGroupJid,
        `👋 *Bem-vindo ao ${childGroupName}!*\n\nEste é o seu quadro de tarefas pessoal. Aqui você receberá suas tarefas, atualizações e automações (standup, resumo, revisão semanal).\n\nDigite \`ajuda\` para ver os comandos disponíveis.`,
        assistantName,
      );
      tfDb
        .prepare('UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?')
        .run(childBoardId);
      logger.info(
        { childGroupJid },
        'provision_child_board: welcome message sent',
      );
    } catch (err) {
      logger.error(
        { err },
        'provision_child_board: failed to send welcome message',
      );
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

export function register(
  reg: (type: string, handler: IpcHandler) => void,
): void {
  reg('provision_child_board', handleProvisionChildBoard);
}
