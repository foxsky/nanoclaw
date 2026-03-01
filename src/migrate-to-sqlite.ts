/**
 * TaskFlow Migration: JSON → SQLite
 *
 * Migrates existing standard TaskFlow boards from TASKS.json/ARCHIVE.json
 * to the unified SQLite store (data/taskflow/taskflow.db).
 *
 * Pre-requisites:
 *   1. Stop nanoclaw service: systemctl stop nanoclaw
 *   2. npm run build (so initTaskflowDb is available)
 *
 * Usage:
 *   node dist/migrate-to-sqlite.js [--dry-run]
 *
 * What it does:
 *   1. Initializes data/taskflow/taskflow.db
 *   2. For each group folder with TASKS.json:
 *      - Migrates meta, people, tasks, archive → SQLite tables
 *      - Creates .mcp.json for SQLite MCP access
 *      - Regenerates CLAUDE.md from the updated template
 *   3. Updates registered_groups with taskflow metadata
 *   4. Updates scheduled runner prompts from JSON-mode to SQLite-mode
 *
 * Post-migration:
 *   - Restart service: systemctl restart nanoclaw
 *   - Old JSON files are kept as backup (not deleted)
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { initTaskflowDb } from './taskflow-db.js';

// Paths relative to project root
const PROJECT_ROOT = process.cwd();
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const STORE_DIR = path.join(PROJECT_ROOT, 'store');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const TEMPLATE_PATH = path.join(
  PROJECT_ROOT,
  '.claude/skills/add-taskflow/templates/CLAUDE.md.template',
);

const DRY_RUN = process.argv.includes('--dry-run');

// --- Types for legacy JSON data ---

interface LegacyManager {
  name: string;
  phone: string;
}

interface LegacyPerson {
  id: string;
  name: string;
  phone: string;
  role: string;
  wip_limit: number;
}

interface LegacyHistoryEntry {
  action: string;
  by?: string;
  at: string;
  details?: string;
}

interface LegacyTask {
  id: string;
  type: string;
  title: string;
  assignee?: string;
  next_action?: string;
  waiting_for?: string;
  column: string;
  priority?: string;
  due_date?: string;
  description?: string;
  labels?: string[];
  blocked_by?: string[];
  reminders?: Array<{ type: string; value: string; task_id?: string }>;
  next_note_id?: number;
  notes?: Array<{ id: number; text: string; at: string; by?: string }>;
  created_at: string;
  updated_at: string;
  history?: LegacyHistoryEntry[];
  subtasks?: unknown;
  recurrence?: unknown;
  current_cycle?: unknown;
  linked_parent_board_id?: string;
  linked_parent_task_id?: string;
}

interface LegacyDstSync {
  enabled: boolean;
  last_offset_minutes: number;
  last_synced_at: string | null;
  resync_count_24h: number;
  resync_window_started_at: string | null;
}

interface LegacyAttachmentAudit {
  source: string;
  filename: string;
  timestamp: string;
  actor_phone: string;
  action: string;
  created_task_ids: string[];
  updated_task_ids: string[];
  rejected_mutations: unknown[];
}

interface LegacyMeta {
  schema_version: string;
  language: string;
  timezone: string;
  manager: LegacyManager;
  managers?: Array<{ name: string; phone: string; role?: string }>;
  attachment_policy: {
    enabled: boolean;
    disabled_reason: string;
    allowed_formats: string[];
    max_size_bytes: number;
  };
  wip_limit_default: number;
  columns: string[];
  runner_task_ids: {
    standup: string | null;
    digest: string | null;
    review: string | null;
    dst_guard: string | null;
  };
  runner_crons_local: {
    standup: string;
    digest: string;
    review: string;
  };
  runner_crons_utc: {
    standup: string;
    digest: string;
    review: string;
  };
  dst_sync: LegacyDstSync;
  attachment_audit_trail: LegacyAttachmentAudit[];
}

interface LegacyTasksJson {
  meta: LegacyMeta;
  people: LegacyPerson[];
  tasks: LegacyTask[];
  next_id: number;
}

interface LegacyArchiveJson {
  tasks: LegacyTask[];
}

// --- SQLite-mode runner prompts ---

const STANDUP_PROMPT =
  "[TF-STANDUP] You are running the morning standup for this group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks, board_people, board_config for your board_id. If no tasks exist, do NOT send any message — just perform housekeeping (archival) silently and exit. Otherwise: 1) Send the Kanban board to this group via send_message (grouped by column, show overdue with 🔴). 2) Include per-person sections in the group message with their personal board, WIP status (X/Y), and prompt for updates. 3) Check for tasks with column = 'done' and updated_at older than 30 days — INSERT them into archive and DELETE from tasks. 4) List any inbox items that need processing. Note: send_message sends to this group only — individual DMs are not supported.";

const DIGEST_PROMPT =
  '[TF-DIGEST] You are generating the manager digest for this task group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks for your board_id. If no tasks exist, do NOT send any message — exit silently. Otherwise consolidate: 🔥 Overdue tasks, ⏳ Tasks due in next 48h, 🚧 Waiting/blocked tasks, 💤 Tasks with no update in 24h+, ✅ Tasks completed today. Format as a concise executive summary and suggest 3 specific follow-up actions with task IDs. Send the digest to this group via send_message. Note: send_message sends to this group only — individual DMs are not supported.';

const REVIEW_PROMPT =
  '[TF-REVIEW] You are running the weekly GTD review for this task group. Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks and archive for your board_id. If no tasks exist, do NOT send any message — exit silently, even if there was archive activity this week. Otherwise produce: 1) Summary: completed, created, overdue this week. 2) Inbox items pending processing. 3) Waiting tasks older than 5 days (suggest follow-up). 4) Overdue tasks (suggest action). 5) In Progress tasks with no update in 3+ days. 6) Next week preview (deadlines and recurrences). 7) Per-person weekly summaries inline. Send the full review to this group via send_message. Note: send_message sends to this group only — individual DMs are not supported.';

// --- Helper functions ---

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function log(msg: string): void {
  const prefix = DRY_RUN ? '[DRY RUN] ' : '';
  console.log(`${prefix}${msg}`);
}

// --- Main migration ---

function migrate(): void {
  log('=== TaskFlow JSON → SQLite Migration ===\n');

  // 1. Discover boards to migrate
  const boardFolders: string[] = [];
  for (const entry of fs.readdirSync(GROUPS_DIR)) {
    const tasksPath = path.join(GROUPS_DIR, entry, 'TASKS.json');
    if (fs.existsSync(tasksPath)) {
      boardFolders.push(entry);
    }
  }

  if (boardFolders.length === 0) {
    log('No TASKS.json files found in groups/. Nothing to migrate.');
    return;
  }

  log(
    `Found ${boardFolders.length} board(s) to migrate: ${boardFolders.join(', ')}\n`,
  );

  // 2. Read template
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`ERROR: Template not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  // 3. Open messages.db
  const messagesDbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(messagesDbPath)) {
    console.error(`ERROR: messages.db not found at ${messagesDbPath}`);
    process.exit(1);
  }
  const messagesDb = new Database(messagesDbPath);

  // Ensure taskflow columns exist in registered_groups
  try {
    messagesDb.exec(
      `ALTER TABLE registered_groups ADD COLUMN taskflow_managed INTEGER DEFAULT 0`,
    );
    log('Added taskflow_managed column to registered_groups');
  } catch {
    /* column already exists */
  }
  try {
    messagesDb.exec(
      `ALTER TABLE registered_groups ADD COLUMN taskflow_hierarchy_level INTEGER`,
    );
    log('Added taskflow_hierarchy_level column to registered_groups');
  } catch {
    /* column already exists */
  }
  try {
    messagesDb.exec(
      `ALTER TABLE registered_groups ADD COLUMN taskflow_max_depth INTEGER`,
    );
    log('Added taskflow_max_depth column to registered_groups');
  } catch {
    /* column already exists */
  }

  // 4. Initialize taskflow.db
  const taskflowDbPath = path.join(DATA_DIR, 'taskflow', 'taskflow.db');
  log(`Initializing TaskFlow DB at ${taskflowDbPath}`);
  let taskflowDb: Database.Database;
  if (!DRY_RUN) {
    taskflowDb = initTaskflowDb(taskflowDbPath);
  } else {
    // In dry-run mode, use in-memory DB to validate SQL
    taskflowDb = initTaskflowDb(':memory:');
  }

  // 5. Get registered groups from messages.db
  const registeredGroups = messagesDb
    .prepare('SELECT jid, name, folder, trigger_pattern FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
  }>;
  const groupsByFolder = new Map(registeredGroups.map((g) => [g.folder, g]));

  // Read ASSISTANT_NAME from .env
  let assistantName = 'Tars';
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^ASSISTANT_NAME=(.+)$/m);
    if (match) assistantName = match[1].trim();
  }

  // 6. Migrate each board
  for (const folder of boardFolders) {
    log(`\n--- Migrating: ${folder} ---`);

    const groupDir = path.join(GROUPS_DIR, folder);
    const tasksPath = path.join(groupDir, 'TASKS.json');
    const archivePath = path.join(groupDir, 'ARCHIVE.json');

    // Read TASKS.json
    const tasksJson: LegacyTasksJson = JSON.parse(
      fs.readFileSync(tasksPath, 'utf-8'),
    );
    const meta = tasksJson.meta;

    // Read ARCHIVE.json (may not exist)
    let archiveJson: LegacyArchiveJson = { tasks: [] };
    if (fs.existsSync(archivePath)) {
      archiveJson = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
    }

    // Get registered group info
    const regGroup = groupsByFolder.get(folder);
    if (!regGroup) {
      console.error(
        `  WARNING: No registered group found for folder '${folder}'. Skipping.`,
      );
      continue;
    }

    const boardId = `board-${folder}`;
    const managerId = slugify(meta.manager.name);

    log(`  Board ID: ${boardId}`);
    log(`  Group JID: ${regGroup.jid}`);
    log(`  Manager: ${meta.manager.name} (${meta.manager.phone})`);
    log(`  People: ${tasksJson.people.map((p) => p.name).join(', ')}`);
    log(
      `  Tasks: ${tasksJson.tasks.length}, Archived: ${archiveJson.tasks.length}`,
    );

    if (DRY_RUN) {
      log('  [Skipping writes in dry-run mode]');
      continue;
    }

    // --- Insert into taskflow.db ---

    const insertBoard = taskflowDb.transaction(() => {
      // boards
      taskflowDb
        .prepare(
          `INSERT OR REPLACE INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id)
           VALUES (?, ?, ?, 'standard', NULL, 1, NULL)`,
        )
        .run(boardId, regGroup.jid, folder);

      // board_config
      taskflowDb
        .prepare(
          `INSERT OR REPLACE INTO board_config (board_id, columns, wip_limit, next_task_number, next_note_id)
           VALUES (?, ?, ?, ?, 1)`,
        )
        .run(
          boardId,
          JSON.stringify(meta.columns),
          meta.wip_limit_default,
          tasksJson.next_id,
        );

      // board_runtime_config
      taskflowDb
        .prepare(
          `INSERT OR REPLACE INTO board_runtime_config (
            board_id, language, timezone,
            runner_standup_task_id, runner_digest_task_id, runner_review_task_id, runner_dst_guard_task_id,
            standup_cron_local, digest_cron_local, review_cron_local,
            standup_cron_utc, digest_cron_utc, review_cron_utc,
            dst_sync_enabled, dst_last_offset_minutes, dst_last_synced_at,
            dst_resync_count_24h, dst_resync_window_started_at,
            attachment_enabled, attachment_disabled_reason,
            attachment_allowed_formats, attachment_max_size_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          boardId,
          meta.language,
          meta.timezone,
          meta.runner_task_ids.standup,
          meta.runner_task_ids.digest,
          meta.runner_task_ids.review,
          meta.runner_task_ids.dst_guard,
          meta.runner_crons_local.standup,
          meta.runner_crons_local.digest,
          meta.runner_crons_local.review,
          meta.runner_crons_utc.standup,
          meta.runner_crons_utc.digest,
          meta.runner_crons_utc.review,
          meta.dst_sync.enabled ? 1 : 0,
          meta.dst_sync.last_offset_minutes,
          meta.dst_sync.last_synced_at,
          meta.dst_sync.resync_count_24h,
          meta.dst_sync.resync_window_started_at,
          meta.attachment_policy.enabled ? 1 : 0,
          meta.attachment_policy.disabled_reason,
          JSON.stringify(meta.attachment_policy.allowed_formats),
          meta.attachment_policy.max_size_bytes,
        );

      // board_people — from people[]
      const insertPerson = taskflowDb.prepare(
        `INSERT OR REPLACE INTO board_people (board_id, person_id, name, phone, role, wip_limit)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const person of tasksJson.people) {
        insertPerson.run(
          boardId,
          person.id,
          person.name,
          person.phone,
          person.role,
          person.wip_limit,
        );
      }

      // Ensure the manager is also in board_people (may be missing from legacy people[])
      const managerInPeople = tasksJson.people.find(
        (p) => p.phone === meta.manager.phone,
      );
      if (!managerInPeople) {
        insertPerson.run(
          boardId,
          managerId,
          meta.manager.name,
          meta.manager.phone,
          'manager',
          null,
        );
      }

      // board_admins — manager as primary admin
      taskflowDb
        .prepare(
          `INSERT OR REPLACE INTO board_admins (board_id, person_id, phone, admin_role, is_primary_manager)
           VALUES (?, ?, ?, 'manager', 1)`,
        )
        .run(boardId, managerId, meta.manager.phone);

      // tasks — from tasks[]
      const insertTask = taskflowDb.prepare(
        `INSERT OR REPLACE INTO tasks (
          id, board_id, type, title, assignee, next_action, waiting_for, column,
          priority, due_date, description, labels, blocked_by, reminders,
          next_note_id, notes, _last_mutation, created_at, updated_at,
          subtasks, recurrence, current_cycle,
          linked_parent_board_id, linked_parent_task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertHistory = taskflowDb.prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      for (const task of tasksJson.tasks) {
        insertTask.run(
          task.id,
          boardId,
          task.type || 'simple',
          task.title,
          task.assignee || null,
          task.next_action || null,
          task.waiting_for || null,
          task.column || 'inbox',
          task.priority || null,
          task.due_date || null,
          task.description || null,
          JSON.stringify(task.labels || []),
          JSON.stringify(task.blocked_by || []),
          JSON.stringify(task.reminders || []),
          task.next_note_id || 1,
          JSON.stringify(task.notes || []),
          null,
          task.created_at,
          task.updated_at,
          task.subtasks ? JSON.stringify(task.subtasks) : null,
          task.recurrence ? JSON.stringify(task.recurrence) : null,
          task.current_cycle ? JSON.stringify(task.current_cycle) : null,
          task.linked_parent_board_id || null,
          task.linked_parent_task_id || null,
        );

        // task_history — from task.history[]
        const history = task.history || [];
        // Cap at 50 entries (keep newest)
        const historyToMigrate =
          history.length > 50 ? history.slice(history.length - 50) : history;
        for (const entry of historyToMigrate) {
          insertHistory.run(
            boardId,
            task.id,
            entry.action,
            entry.by || null,
            entry.at,
            entry.details || null,
          );
        }
      }

      // archive — from ARCHIVE.json tasks[]
      const insertArchive = taskflowDb.prepare(
        `INSERT OR REPLACE INTO archive (
          board_id, task_id, type, title, assignee,
          archive_reason, linked_parent_board_id, linked_parent_task_id,
          archived_at, task_snapshot, history
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const task of archiveJson.tasks) {
        const history = task.history || [];
        const latestAction =
          history.length > 0 ? history[history.length - 1] : null;
        const archiveReason =
          latestAction?.action === 'cancelled' ? 'cancelled' : 'completed';
        const archivedAt = latestAction?.at || task.updated_at;

        // Remove inline history from snapshot
        const { history: _h, ...snapshotData } = task;
        const taskSnapshot = JSON.stringify(snapshotData);

        // Truncate history to 20 entries for archive
        const archiveHistory =
          history.length > 20 ? history.slice(history.length - 20) : history;

        insertArchive.run(
          boardId,
          task.id,
          task.type || 'simple',
          task.title,
          task.assignee || null,
          archiveReason,
          task.linked_parent_board_id || null,
          task.linked_parent_task_id || null,
          archivedAt,
          taskSnapshot,
          JSON.stringify(archiveHistory),
        );
      }

      // attachment_audit_log — from meta.attachment_audit_trail[]
      if (
        meta.attachment_audit_trail &&
        meta.attachment_audit_trail.length > 0
      ) {
        const insertAudit = taskflowDb.prepare(
          `INSERT INTO attachment_audit_log (board_id, source, filename, at, actor_person_id, affected_task_refs)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );

        for (const entry of meta.attachment_audit_trail) {
          // Resolve actor_phone to person_id
          const actorPerson = tasksJson.people.find(
            (p) => p.phone === entry.actor_phone,
          );
          const actorPersonId = actorPerson?.id || null;

          // Combine task refs
          const affectedRefs = {
            action: entry.action,
            created_task_ids: entry.created_task_ids,
            updated_task_ids: entry.updated_task_ids,
            rejected_mutations: entry.rejected_mutations,
          };

          insertAudit.run(
            boardId,
            entry.source || 'attachment',
            entry.filename,
            entry.timestamp,
            actorPersonId,
            JSON.stringify(affectedRefs),
          );
        }
      }
    });

    insertBoard();
    log('  ✓ Inserted board data into taskflow.db');

    // --- Create .mcp.json ---
    const mcpConfig = {
      mcpServers: {
        sqlite: {
          type: 'stdio',
          command: 'npx',
          args: [
            '-y',
            'mcp-server-sqlite-npx',
            '/workspace/taskflow/taskflow.db',
          ],
        },
      },
    };
    fs.writeFileSync(
      path.join(groupDir, '.mcp.json'),
      JSON.stringify(mcpConfig, null, 2) + '\n',
    );
    log('  ✓ Created .mcp.json');

    // --- Regenerate CLAUDE.md ---
    // Back up old CLAUDE.md
    const claudePath = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      fs.copyFileSync(
        claudePath,
        path.join(groupDir, 'CLAUDE.md.pre-migration'),
      );
      log('  ✓ Backed up old CLAUDE.md → CLAUDE.md.pre-migration');
    }

    // Derive GROUP_CONTEXT from existing CLAUDE.md
    let groupContext = regGroup.name;
    if (fs.existsSync(claudePath)) {
      const oldClaude = fs.readFileSync(claudePath, 'utf-8');
      const contextMatch = oldClaude.match(
        /You manage a Kanban\+GTD board for (.+)\./,
      );
      if (contextMatch) {
        groupContext = contextMatch[1];
      }
    }

    const placeholders: Record<string, string> = {
      '{{ASSISTANT_NAME}}': assistantName,
      '{{GROUP_NAME}}': regGroup.name,
      '{{GROUP_FOLDER}}': folder,
      '{{MANAGER_NAME}}': meta.manager.name,
      '{{MANAGER_PHONE}}': meta.manager.phone,
      '{{MANAGER_ID}}': managerId,
      '{{GROUP_CONTEXT}}': groupContext,
      '{{LANGUAGE}}': meta.language,
      '{{TIMEZONE}}': meta.timezone,
      '{{WIP_LIMIT}}': String(meta.wip_limit_default),
      '{{STANDUP_CRON_LOCAL}}': meta.runner_crons_local.standup,
      '{{DIGEST_CRON_LOCAL}}': meta.runner_crons_local.digest,
      '{{REVIEW_CRON_LOCAL}}': meta.runner_crons_local.review,
      '{{STANDUP_CRON}}': meta.runner_crons_utc.standup,
      '{{DIGEST_CRON}}': meta.runner_crons_utc.digest,
      '{{REVIEW_CRON}}': meta.runner_crons_utc.review,
      '{{GROUP_JID}}': regGroup.jid,
      '{{ATTACHMENT_IMPORT_ENABLED}}': meta.attachment_policy.enabled
        ? 'true'
        : 'false',
      '{{ATTACHMENT_IMPORT_REASON}}': meta.attachment_policy.disabled_reason,
      '{{DST_GUARD_ENABLED}}': meta.dst_sync.enabled ? 'true' : 'false',
      '{{BOARD_ROLE}}': 'standard',
      '{{BOARD_ID}}': boardId,
      '{{HIERARCHY_LEVEL}}': '',
      '{{HIERARCHY_LEVEL_SQL}}': 'null',
      '{{MAX_DEPTH}}': '1',
      '{{MAX_DEPTH_SQL}}': '1',
      '{{PARENT_BOARD_ID}}': '',
    };

    let rendered = template;
    for (const [placeholder, value] of Object.entries(placeholders)) {
      rendered = rendered.split(placeholder).join(value);
    }

    fs.writeFileSync(claudePath, rendered);
    log('  ✓ Regenerated CLAUDE.md from template');

    // --- Update registered_groups ---
    messagesDb
      .prepare(
        `UPDATE registered_groups
         SET taskflow_managed = 1, taskflow_hierarchy_level = 0, taskflow_max_depth = 1
         WHERE folder = ?`,
      )
      .run(folder);
    log('  ✓ Updated registered_groups (taskflow_managed=1, level=0, depth=1)');

    // --- Update runner prompts in scheduled_tasks ---
    const runnerUpdates: Array<{ id: string | null; prompt: string }> = [
      { id: meta.runner_task_ids.standup, prompt: STANDUP_PROMPT },
      { id: meta.runner_task_ids.digest, prompt: DIGEST_PROMPT },
      { id: meta.runner_task_ids.review, prompt: REVIEW_PROMPT },
    ];

    const updatePrompt = messagesDb.prepare(
      `UPDATE scheduled_tasks SET prompt = ? WHERE id = ?`,
    );

    for (const { id, prompt } of runnerUpdates) {
      if (id) {
        const result = updatePrompt.run(prompt, id);
        if (result.changes > 0) {
          log(`  ✓ Updated runner prompt: ${id}`);
        } else {
          log(`  ⚠ Runner task not found: ${id}`);
        }
      }
    }

    // DST guard runner prompt (if present)
    if (meta.runner_task_ids.dst_guard) {
      const dstPrompt = `[TF-DST-GUARD] Check if UTC offset for timezone '${meta.timezone}' has changed. Query board_runtime_config for board_id='${boardId}'. Compare current UTC offset with dst_last_offset_minutes. If different: recompute UTC cron expressions from local crons, UPDATE board_runtime_config, then recreate the standup/digest/review scheduled_tasks with new cron values. Update dst_last_synced_at and dst_resync_count_24h.`;
      const dstResult = updatePrompt.run(
        dstPrompt,
        meta.runner_task_ids.dst_guard,
      );
      if (dstResult.changes > 0) {
        log(
          `  ✓ Updated DST guard runner prompt: ${meta.runner_task_ids.dst_guard}`,
        );
      }
    }

    log(`  ✓ Migration complete for ${folder}`);
  }

  // 7. Summary
  taskflowDb!.close();
  messagesDb.close();

  log('\n=== Migration Summary ===');
  log(`Boards migrated: ${boardFolders.length}`);
  log(`TaskFlow DB: ${DRY_RUN ? '(in-memory, dry run)' : taskflowDbPath}`);
  log('\nNext steps:');
  log('  1. Verify: sqlite3 data/taskflow/taskflow.db "SELECT * FROM boards;"');
  log(
    '  2. Verify: sqlite3 store/messages.db "SELECT folder, taskflow_managed FROM registered_groups WHERE taskflow_managed = 1;"',
  );
  log('  3. Restart: systemctl restart nanoclaw');
  log('  4. Keep old TASKS.json/ARCHIVE.json as backups');
}

// CLI entry point
const isMain = process.argv[1]?.endsWith('migrate-to-sqlite.js');
if (isMain) {
  migrate();
}

export { migrate };
