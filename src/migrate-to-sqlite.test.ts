import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTaskflowDb } from './taskflow-db.js';

/**
 * Integration tests for the JSON → SQLite migration logic.
 *
 * These tests create temp directories with sample TASKS.json + ARCHIVE.json,
 * run the migration logic, and verify the SQLite state.
 */

// Sample TASKS.json matching the deployed board structure
function sampleTasksJson(overrides?: {
  tasks?: unknown[];
  people?: unknown[];
  attachment_audit_trail?: unknown[];
}) {
  return {
    meta: {
      schema_version: '1.0',
      language: 'pt-BR',
      timezone: 'America/Fortaleza',
      manager: { name: 'Miguel', phone: '558699916064' },
      attachment_policy: {
        enabled: true,
        disabled_reason: '',
        allowed_formats: ['pdf', 'jpg', 'png'],
        max_size_bytes: 10485760,
      },
      wip_limit_default: 3,
      columns: [
        'inbox',
        'next_action',
        'in_progress',
        'waiting',
        'review',
        'done',
      ],
      runner_task_ids: {
        standup: 'task-standup-1',
        digest: 'task-digest-1',
        review: 'task-review-1',
        dst_guard: null,
      },
      runner_crons_local: {
        standup: '0 8 * * 1-5',
        digest: '0 18 * * 1-5',
        review: '0 11 * * 5',
      },
      runner_crons_utc: {
        standup: '0 11 * * 1-5',
        digest: '0 21 * * 1-5',
        review: '0 14 * * 5',
      },
      dst_sync: {
        enabled: false,
        last_offset_minutes: -180,
        last_synced_at: null,
        resync_count_24h: 0,
        resync_window_started_at: null,
      },
      attachment_audit_trail: overrides?.attachment_audit_trail || [],
    },
    people: overrides?.people || [
      {
        id: 'giovanni',
        name: 'Giovanni',
        phone: '558688983914',
        role: 'Tecnico',
        wip_limit: 3,
      },
    ],
    tasks: overrides?.tasks || [],
    next_id: 1,
  };
}

function sampleArchiveJson(tasks: unknown[] = []) {
  return { tasks };
}

// Minimal migration function extracted from migrate-to-sqlite.ts
// This avoids needing the full script's filesystem layout (groups/, store/, .env)
function runMigration(opts: {
  tasksJson: ReturnType<typeof sampleTasksJson>;
  archiveJson: ReturnType<typeof sampleArchiveJson>;
  taskflowDb: Database.Database;
  messagesDb: Database.Database;
  folder: string;
  groupJid: string;
  groupName: string;
}) {
  const {
    tasksJson,
    archiveJson,
    taskflowDb,
    messagesDb,
    folder,
    groupJid,
    groupName,
  } = opts;
  const meta = tasksJson.meta;
  const boardId = `board-${folder}`;
  const managerId = meta.manager.name.toLowerCase();

  // boards
  taskflowDb
    .prepare(
      `INSERT OR REPLACE INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id)
       VALUES (?, ?, ?, 'standard', NULL, 1, NULL)`,
    )
    .run(boardId, groupJid, folder);

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

  // board_people
  const insertPerson = taskflowDb.prepare(
    `INSERT OR REPLACE INTO board_people (board_id, person_id, name, phone, role, wip_limit)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const person of tasksJson.people as Array<{
    id: string;
    name: string;
    phone: string;
    role: string;
    wip_limit: number;
  }>) {
    insertPerson.run(
      boardId,
      person.id,
      person.name,
      person.phone,
      person.role,
      person.wip_limit,
    );
  }

  // Ensure manager in board_people
  const managerInPeople = (
    tasksJson.people as Array<{ phone: string }>
  ).find((p) => p.phone === meta.manager.phone);
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

  // board_admins
  taskflowDb
    .prepare(
      `INSERT OR REPLACE INTO board_admins (board_id, person_id, phone, admin_role, is_primary_manager)
       VALUES (?, ?, ?, 'manager', 1)`,
    )
    .run(boardId, managerId, meta.manager.phone);

  // tasks
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

  for (const task of tasksJson.tasks as Array<{
    id: string;
    type?: string;
    title: string;
    assignee?: string;
    next_action?: string;
    waiting_for?: string;
    column?: string;
    priority?: string;
    due_date?: string;
    description?: string;
    labels?: string[];
    blocked_by?: string[];
    reminders?: unknown[];
    next_note_id?: number;
    notes?: unknown[];
    created_at: string;
    updated_at: string;
    history?: Array<{
      action: string;
      by?: string;
      at: string;
      details?: string;
    }>;
    subtasks?: unknown;
    recurrence?: unknown;
    current_cycle?: unknown;
    linked_parent_board_id?: string;
    linked_parent_task_id?: string;
  }>) {
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

    const history = task.history || [];
    for (const entry of history) {
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

  // archive
  for (const task of archiveJson.tasks as Array<{
    id: string;
    type?: string;
    title: string;
    assignee?: string;
    updated_at: string;
    history?: Array<{ action: string; at: string }>;
    linked_parent_board_id?: string;
    linked_parent_task_id?: string;
  }>) {
    const history = task.history || [];
    const latestAction =
      history.length > 0 ? history[history.length - 1] : null;
    const archiveReason =
      latestAction?.action === 'cancelled' ? 'cancelled' : 'completed';
    const archivedAt = latestAction?.at || task.updated_at;
    const { history: _h, ...snapshotData } = task;
    const archiveHistory =
      history.length > 20 ? history.slice(history.length - 20) : history;

    taskflowDb
      .prepare(
        `INSERT OR REPLACE INTO archive (
          board_id, task_id, type, title, assignee,
          archive_reason, linked_parent_board_id, linked_parent_task_id,
          archived_at, task_snapshot, history
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        boardId,
        task.id,
        task.type || 'simple',
        task.title,
        task.assignee || null,
        archiveReason,
        task.linked_parent_board_id || null,
        task.linked_parent_task_id || null,
        archivedAt,
        JSON.stringify(snapshotData),
        JSON.stringify(archiveHistory),
      );
  }

  // attachment_audit_log
  if (
    meta.attachment_audit_trail &&
    meta.attachment_audit_trail.length > 0
  ) {
    for (const entry of meta.attachment_audit_trail as Array<{
      source?: string;
      filename: string;
      timestamp: string;
      actor_phone: string;
      action: string;
      created_task_ids: string[];
      updated_task_ids: string[];
      rejected_mutations: unknown[];
    }>) {
      const actorPerson = (
        tasksJson.people as Array<{ id: string; phone: string }>
      ).find((p) => p.phone === entry.actor_phone);
      taskflowDb
        .prepare(
          `INSERT INTO attachment_audit_log (board_id, source, filename, at, actor_person_id, affected_task_refs)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          boardId,
          entry.source || 'attachment',
          entry.filename,
          entry.timestamp,
          actorPerson?.id || null,
          JSON.stringify({
            action: entry.action,
            created_task_ids: entry.created_task_ids,
            updated_task_ids: entry.updated_task_ids,
            rejected_mutations: entry.rejected_mutations,
          }),
        );
    }
  }

  // Update registered_groups
  messagesDb
    .prepare(
      `UPDATE registered_groups
       SET taskflow_managed = 1, taskflow_hierarchy_level = 0, taskflow_max_depth = 1
       WHERE folder = ?`,
    )
    .run(folder);

  // Update runner prompts
  const STANDUP_PROMPT =
    '[TF-STANDUP] You are running the morning standup for this group. Query the board from /workspace/taskflow/taskflow.db';
  const DIGEST_PROMPT =
    '[TF-DIGEST] You are generating the manager digest for this task group. Query the board from /workspace/taskflow/taskflow.db';
  const REVIEW_PROMPT =
    '[TF-REVIEW] You are running the weekly GTD review for this task group. Query the board from /workspace/taskflow/taskflow.db';

  const updatePrompt = messagesDb.prepare(
    `UPDATE scheduled_tasks SET prompt = ? WHERE id = ?`,
  );

  if (meta.runner_task_ids.standup) {
    updatePrompt.run(STANDUP_PROMPT, meta.runner_task_ids.standup);
  }
  if (meta.runner_task_ids.digest) {
    updatePrompt.run(DIGEST_PROMPT, meta.runner_task_ids.digest);
  }
  if (meta.runner_task_ids.review) {
    updatePrompt.run(REVIEW_PROMPT, meta.runner_task_ids.review);
  }
}

describe('migrate-to-sqlite', () => {
  let taskflowDb: Database.Database;
  let messagesDb: Database.Database;

  beforeEach(() => {
    // Create in-memory databases
    taskflowDb = initTaskflowDb(':memory:');
    messagesDb = new Database(':memory:');

    // Create messages.db schema (minimal)
    messagesDb.exec(`
      CREATE TABLE IF NOT EXISTS registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        taskflow_managed INTEGER DEFAULT 0,
        taskflow_hierarchy_level INTEGER,
        taskflow_max_depth INTEGER
      );
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        context_mode TEXT DEFAULT 'isolated',
        next_run TEXT,
        last_run TEXT,
        last_result TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    taskflowDb?.close();
    messagesDb?.close();
  });

  function seedRegisteredGroup(folder: string, jid: string, name: string) {
    messagesDb
      .prepare(
        `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at)
         VALUES (?, ?, ?, '@Tars', ?)`,
      )
      .run(jid, name, folder, new Date().toISOString());
  }

  function seedScheduledTask(id: string, folder: string, jid: string, prompt: string) {
    messagesDb
      .prepare(
        `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at)
         VALUES (?, ?, ?, ?, 'cron', '0 11 * * 1-5', 'active', ?)`,
      )
      .run(id, folder, jid, prompt, new Date().toISOString());
  }

  it('migrates board metadata into boards table', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson(),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const board = taskflowDb
      .prepare('SELECT * FROM boards WHERE id = ?')
      .get(`board-${folder}`) as {
      id: string;
      group_jid: string;
      board_role: string;
      hierarchy_level: number | null;
      max_depth: number;
    };

    expect(board).toBeDefined();
    expect(board.group_jid).toBe(jid);
    expect(board.board_role).toBe('standard');
    expect(board.hierarchy_level).toBeNull();
    expect(board.max_depth).toBe(1);
  });

  it('migrates board_config with correct next_task_number', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    const tasksJson = sampleTasksJson();
    tasksJson.next_id = 42;

    runMigration({
      tasksJson,
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const config = taskflowDb
      .prepare('SELECT * FROM board_config WHERE board_id = ?')
      .get(`board-${folder}`) as { wip_limit: number; next_task_number: number };

    expect(config.wip_limit).toBe(3);
    expect(config.next_task_number).toBe(42);
  });

  it('migrates board_runtime_config with runner task IDs', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson(),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const runtime = taskflowDb
      .prepare('SELECT * FROM board_runtime_config WHERE board_id = ?')
      .get(`board-${folder}`) as {
      language: string;
      timezone: string;
      runner_standup_task_id: string;
      standup_cron_utc: string;
      attachment_enabled: number;
    };

    expect(runtime.language).toBe('pt-BR');
    expect(runtime.timezone).toBe('America/Fortaleza');
    expect(runtime.runner_standup_task_id).toBe('task-standup-1');
    expect(runtime.standup_cron_utc).toBe('0 11 * * 1-5');
    expect(runtime.attachment_enabled).toBe(1);
  });

  it('migrates people into board_people', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson({
        people: [
          {
            id: 'giovanni',
            name: 'Giovanni',
            phone: '558688983914',
            role: 'Tecnico',
            wip_limit: 3,
          },
          {
            id: 'alexandre',
            name: 'Alexandre',
            phone: '558698300049',
            role: 'Tecnico',
            wip_limit: 5,
          },
        ],
      }),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const people = taskflowDb
      .prepare('SELECT * FROM board_people WHERE board_id = ? ORDER BY person_id')
      .all(`board-${folder}`) as Array<{
      person_id: string;
      name: string;
      phone: string;
    }>;

    // 2 people + manager (who is not in the people array)
    expect(people.length).toBe(3);
    expect(people.map((p) => p.person_id)).toContain('giovanni');
    expect(people.map((p) => p.person_id)).toContain('alexandre');
    expect(people.map((p) => p.person_id)).toContain('miguel');
  });

  it('adds manager to board_admins as primary', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson(),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const admins = taskflowDb
      .prepare('SELECT * FROM board_admins WHERE board_id = ?')
      .all(`board-${folder}`) as Array<{
      person_id: string;
      admin_role: string;
      is_primary_manager: number;
    }>;

    expect(admins.length).toBe(1);
    expect(admins[0].person_id).toBe('miguel');
    expect(admins[0].admin_role).toBe('manager');
    expect(admins[0].is_primary_manager).toBe(1);
  });

  it('migrates tasks with history', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson({
        tasks: [
          {
            id: 'T-001',
            type: 'simple',
            title: 'Test task',
            assignee: 'giovanni',
            next_action: 'Do the thing',
            column: 'in_progress',
            created_at: '2026-02-28T10:00:00.000Z',
            updated_at: '2026-02-28T12:00:00.000Z',
            history: [
              {
                action: 'created',
                by: 'miguel',
                at: '2026-02-28T10:00:00.000Z',
              },
              {
                action: 'moved_to_in_progress',
                by: 'giovanni',
                at: '2026-02-28T12:00:00.000Z',
              },
            ],
          },
        ],
      }),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const tasks = taskflowDb
      .prepare('SELECT * FROM tasks WHERE board_id = ?')
      .all(`board-${folder}`) as Array<{ id: string; title: string }>;

    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe('T-001');
    expect(tasks[0].title).toBe('Test task');

    const history = taskflowDb
      .prepare('SELECT * FROM task_history WHERE board_id = ? AND task_id = ?')
      .all(`board-${folder}`, 'T-001') as Array<{ action: string }>;

    expect(history.length).toBe(2);
    expect(history[0].action).toBe('created');
    expect(history[1].action).toBe('moved_to_in_progress');
  });

  it('migrates archived tasks with correct archive_reason', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson(),
      archiveJson: sampleArchiveJson([
        {
          id: 'T-010',
          type: 'simple',
          title: 'Completed task',
          assignee: 'giovanni',
          updated_at: '2026-02-20T10:00:00.000Z',
          history: [
            {
              action: 'completed',
              by: 'miguel',
              at: '2026-02-20T10:00:00.000Z',
            },
          ],
        },
        {
          id: 'T-011',
          type: 'simple',
          title: 'Cancelled task',
          assignee: 'giovanni',
          updated_at: '2026-02-21T10:00:00.000Z',
          history: [
            {
              action: 'cancelled',
              by: 'miguel',
              at: '2026-02-21T10:00:00.000Z',
            },
          ],
        },
      ]),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const archived = taskflowDb
      .prepare(
        'SELECT task_id, archive_reason FROM archive WHERE board_id = ? ORDER BY task_id',
      )
      .all(`board-${folder}`) as Array<{
      task_id: string;
      archive_reason: string;
    }>;

    expect(archived.length).toBe(2);
    expect(archived[0].task_id).toBe('T-010');
    expect(archived[0].archive_reason).toBe('completed');
    expect(archived[1].task_id).toBe('T-011');
    expect(archived[1].archive_reason).toBe('cancelled');
  });

  it('sets registered_groups.taskflow_managed=1', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    // Verify before migration
    const before = messagesDb
      .prepare('SELECT taskflow_managed FROM registered_groups WHERE folder = ?')
      .get(folder) as { taskflow_managed: number };
    expect(before.taskflow_managed).toBe(0);

    runMigration({
      tasksJson: sampleTasksJson(),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const after = messagesDb
      .prepare(
        'SELECT taskflow_managed, taskflow_hierarchy_level, taskflow_max_depth FROM registered_groups WHERE folder = ?',
      )
      .get(folder) as {
      taskflow_managed: number;
      taskflow_hierarchy_level: number;
      taskflow_max_depth: number;
    };

    expect(after.taskflow_managed).toBe(1);
    expect(after.taskflow_hierarchy_level).toBe(0);
    expect(after.taskflow_max_depth).toBe(1);
  });

  it('rewrites runner prompts to SQLite mode', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    // Seed old JSON-mode runner prompts
    seedScheduledTask(
      'task-standup-1',
      folder,
      jid,
      'Read /workspace/group/TASKS.json. If tasks[] is empty...',
    );
    seedScheduledTask(
      'task-digest-1',
      folder,
      jid,
      'Read /workspace/group/TASKS.json. Consolidate...',
    );
    seedScheduledTask(
      'task-review-1',
      folder,
      jid,
      'Read /workspace/group/TASKS.json and /workspace/group/ARCHIVE.json...',
    );

    runMigration({
      tasksJson: sampleTasksJson(),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const runners = messagesDb
      .prepare(
        'SELECT id, prompt FROM scheduled_tasks WHERE group_folder = ? ORDER BY id',
      )
      .all(folder) as Array<{ id: string; prompt: string }>;

    expect(runners.length).toBe(3);
    for (const runner of runners) {
      expect(runner.prompt).not.toContain('TASKS.json');
      expect(runner.prompt).not.toContain('ARCHIVE.json');
      expect(runner.prompt).toContain('/workspace/taskflow/taskflow.db');
    }
  });

  it('preserves task counts after migration', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    const activeTasks = [
      {
        id: 'T-001',
        type: 'simple',
        title: 'Task 1',
        column: 'in_progress',
        assignee: 'giovanni',
        created_at: '2026-02-28T10:00:00.000Z',
        updated_at: '2026-02-28T12:00:00.000Z',
      },
      {
        id: 'T-002',
        type: 'simple',
        title: 'Task 2',
        column: 'inbox',
        created_at: '2026-02-28T11:00:00.000Z',
        updated_at: '2026-02-28T11:00:00.000Z',
      },
      {
        id: 'T-003',
        type: 'simple',
        title: 'Task 3',
        column: 'waiting',
        assignee: 'giovanni',
        waiting_for: 'External vendor',
        created_at: '2026-02-28T09:00:00.000Z',
        updated_at: '2026-02-28T09:30:00.000Z',
      },
    ];

    const archivedTasks = [
      {
        id: 'T-010',
        type: 'simple',
        title: 'Done task',
        assignee: 'giovanni',
        updated_at: '2026-02-20T10:00:00.000Z',
        history: [
          {
            action: 'completed',
            at: '2026-02-20T10:00:00.000Z',
          },
        ],
      },
    ];

    runMigration({
      tasksJson: sampleTasksJson({ tasks: activeTasks }),
      archiveJson: sampleArchiveJson(archivedTasks),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const taskCount = (
      taskflowDb
        .prepare('SELECT COUNT(*) as count FROM tasks WHERE board_id = ?')
        .get(`board-${folder}`) as { count: number }
    ).count;

    const archiveCount = (
      taskflowDb
        .prepare('SELECT COUNT(*) as count FROM archive WHERE board_id = ?')
        .get(`board-${folder}`) as { count: number }
    ).count;

    expect(taskCount).toBe(3);
    expect(archiveCount).toBe(1);
  });

  it('migrates attachment audit trail', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson({
        attachment_audit_trail: [
          {
            source: 'attachment',
            filename: 'tasks.pdf',
            timestamp: '2026-02-28T15:00:00.000Z',
            actor_phone: '558688983914',
            action: 'create_tasks',
            created_task_ids: ['T-001'],
            updated_task_ids: [],
            rejected_mutations: [],
          },
        ],
      }),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const auditLog = taskflowDb
      .prepare(
        'SELECT * FROM attachment_audit_log WHERE board_id = ?',
      )
      .all(`board-${folder}`) as Array<{
      source: string;
      filename: string;
      actor_person_id: string;
      affected_task_refs: string;
    }>;

    expect(auditLog.length).toBe(1);
    expect(auditLog[0].source).toBe('attachment');
    expect(auditLog[0].filename).toBe('tasks.pdf');
    expect(auditLog[0].actor_person_id).toBe('giovanni');

    const refs = JSON.parse(auditLog[0].affected_task_refs);
    expect(refs.action).toBe('create_tasks');
    expect(refs.created_task_ids).toContain('T-001');
  });
});
