import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTaskflowDb } from './taskflow-db.js';
import {
  migrateBoard,
  migrateWithConfig,
  resolveDefaultProjectRoot,
} from './migrate-to-sqlite.js';

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
  managers?: Array<{ name: string; phone: string; role?: string }>;
}): any {
  return {
    meta: {
      schema_version: '1.0',
      language: 'pt-BR',
      timezone: 'America/Fortaleza',
      manager: { name: 'Miguel', phone: '558699916064' },
      managers: overrides?.managers,
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

function sampleArchiveJson(tasks: unknown[] = []): any {
  return { tasks };
}

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
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'taskflow-migrate-test-'),
  );
  const groupDir = path.join(tempRoot, folder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'CLAUDE.md'),
    'You are Tars, the task management assistant for Miguel. You manage a Kanban+GTD board for the test board.\n',
  );

  const template =
    '# {{ASSISTANT_NAME}} — TaskFlow ({{GROUP_NAME}})\n' +
    'You are {{ASSISTANT_NAME}}, the task management assistant for {{MANAGER_NAME}}. You manage a Kanban+GTD board for {{GROUP_CONTEXT}}.\n' +
    'Board {{BOARD_ID}} for {{GROUP_JID}} managed by {{MANAGER_ID}}.\n';
  try {
    migrateBoard({
      folder,
      groupDir,
      regGroup: {
        jid: groupJid,
        name: groupName,
        folder,
        trigger_pattern: '@Tars',
      },
      tasksJson,
      archiveJson,
      taskflowDb,
      messagesDb,
      template,
      assistantName: 'Tars',
    });

    const mcpPath = path.join(groupDir, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const claudePath = path.join(groupDir, 'CLAUDE.md');
    expect(fs.existsSync(claudePath)).toBe(true);
    expect(fs.readFileSync(claudePath, 'utf-8')).not.toContain(
      '{{MANAGER_ID}}',
    );
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.md.pre-migration'))).toBe(
      true,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function createTempProject(opts?: {
  folder?: string;
  groupJid?: string;
  groupName?: string;
  tasksJson?: ReturnType<typeof sampleTasksJson>;
  archiveJson?: ReturnType<typeof sampleArchiveJson>;
}): {
  tempRoot: string;
  folder: string;
  groupJid: string;
  groupName: string;
  groupDir: string;
  messagesDbPath: string;
  taskflowDbPath: string;
  cleanup: () => void;
} {
  const folder = opts?.folder ?? 'test-taskflow';
  const groupJid = opts?.groupJid ?? '120363000000@g.us';
  const groupName = opts?.groupName ?? 'Test TaskFlow';
  const tasksJson = opts?.tasksJson ?? sampleTasksJson();
  const archiveJson = opts?.archiveJson ?? sampleArchiveJson();

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'taskflow-migrate-project-'),
  );
  const groupsDir = path.join(tempRoot, 'groups');
  const groupDir = path.join(groupsDir, folder);
  const storeDir = path.join(tempRoot, 'store');
  const dataTaskflowDir = path.join(tempRoot, 'data', 'taskflow');
  const templateDir = path.join(
    tempRoot,
    '.claude',
    'skills',
    'add-taskflow',
    'templates',
  );

  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(dataTaskflowDir, { recursive: true });
  fs.mkdirSync(templateDir, { recursive: true });

  fs.writeFileSync(
    path.join(groupDir, 'TASKS.json'),
    JSON.stringify(tasksJson, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(groupDir, 'ARCHIVE.json'),
    JSON.stringify(archiveJson, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(groupDir, 'CLAUDE.md'),
    'You are Tars, the task management assistant for Miguel. You manage a Kanban+GTD board for the temp project board.\n',
  );
  fs.writeFileSync(
    path.join(templateDir, 'CLAUDE.md.template'),
    [
      '# {{ASSISTANT_NAME}} — TaskFlow ({{GROUP_NAME}})',
      'You are {{ASSISTANT_NAME}}, the task management assistant for {{MANAGER_NAME}}. You manage a Kanban+GTD board for {{GROUP_CONTEXT}}.',
      'Board {{BOARD_ID}} for {{GROUP_JID}} managed by {{MANAGER_ID}}.',
      '',
    ].join('\n'),
  );

  const messagesDbPath = path.join(storeDir, 'messages.db');
  const messagesDb = new Database(messagesDbPath);
  messagesDb.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE scheduled_tasks (
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
  messagesDb
    .prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at)
       VALUES (?, ?, ?, '@Tars', ?)`,
    )
    .run(groupJid, groupName, folder, new Date().toISOString());

  const runnerIds = [
    tasksJson.meta.runner_task_ids.standup,
    tasksJson.meta.runner_task_ids.digest,
    tasksJson.meta.runner_task_ids.review,
    tasksJson.meta.runner_task_ids.dst_guard,
  ].filter((value): value is string => Boolean(value));
  for (const runnerId of runnerIds) {
    messagesDb
      .prepare(
        `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at)
         VALUES (?, ?, ?, ?, 'cron', '0 11 * * 1-5', 'active', ?)`,
      )
      .run(
        runnerId,
        folder,
        groupJid,
        'Read /workspace/group/TASKS.json...',
        new Date().toISOString(),
      );
  }
  messagesDb.close();

  fs.writeFileSync(path.join(tempRoot, '.env'), 'ASSISTANT_NAME=Tars\n');

  return {
    tempRoot,
    folder,
    groupJid,
    groupName,
    groupDir,
    messagesDbPath,
    taskflowDbPath: path.join(dataTaskflowDir, 'taskflow.db'),
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
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

  it('resolves the default project root from the script location, not cwd', () => {
    expect(
      resolveDefaultProjectRoot(
        'file:///tmp/example/dist/migrate-to-sqlite.js',
      ),
    ).toBe('/tmp/example');
    expect(
      resolveDefaultProjectRoot('file:///tmp/example/src/migrate-to-sqlite.ts'),
    ).toBe('/tmp/example');
  });

  function seedRegisteredGroup(folder: string, jid: string, name: string) {
    messagesDb
      .prepare(
        `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at)
         VALUES (?, ?, ?, '@Tars', ?)`,
      )
      .run(jid, name, folder, new Date().toISOString());
  }

  function seedScheduledTask(
    id: string,
    folder: string,
    jid: string,
    prompt: string,
  ) {
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
      .get(`board-${folder}`) as {
      wip_limit: number;
      next_task_number: number;
    };

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
      .prepare(
        'SELECT * FROM board_people WHERE board_id = ? ORDER BY person_id',
      )
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

  it('migrates meta.managers into board_admins and preserves delegate roles', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson({
        people: [
          {
            id: 'miguel-custom',
            name: 'Miguel',
            phone: '558699916064',
            role: 'Diretor',
            wip_limit: 3,
          },
          {
            id: 'rafael',
            name: 'Rafael',
            phone: '558699900000',
            role: 'Tecnico',
            wip_limit: 3,
          },
        ],
        managers: [
          { name: 'Miguel', phone: '558699916064', role: 'manager' },
          { name: 'Rafael', phone: '558699900000', role: 'delegate' },
        ],
      }),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const admins = taskflowDb
      .prepare(
        'SELECT person_id, phone, admin_role, is_primary_manager FROM board_admins WHERE board_id = ? ORDER BY admin_role DESC, person_id',
      )
      .all(`board-${folder}`) as Array<{
      person_id: string;
      phone: string;
      admin_role: string;
      is_primary_manager: number;
    }>;

    expect(admins).toEqual([
      {
        person_id: 'miguel-custom',
        phone: '558699916064',
        admin_role: 'manager',
        is_primary_manager: 1,
      },
      {
        person_id: 'rafael',
        phone: '558699900000',
        admin_role: 'delegate',
        is_primary_manager: 0,
      },
    ]);
  });

  it('uses the migrated manager person_id in CLAUDE placeholders', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson({
        people: [
          {
            id: 'miguel-custom',
            name: 'Miguel',
            phone: '558699916064',
            role: 'Diretor',
            wip_limit: 3,
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

    // `runMigration()` already asserted the file was rendered.
    // This helper test validates the per-board rendering path separately.
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'taskflow-migrate-placeholder-'),
    );
    const groupDir = path.join(tempRoot, folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'CLAUDE.md'),
      'You manage a Kanban+GTD board for placeholder test.\n',
    );
    try {
      migrateBoard({
        folder,
        groupDir,
        regGroup: {
          jid,
          name: 'Test TaskFlow',
          folder,
          trigger_pattern: '@Tars',
        },
        tasksJson: sampleTasksJson({
          people: [
            {
              id: 'miguel-custom',
              name: 'Miguel',
              phone: '558699916064',
              role: 'Diretor',
              wip_limit: 3,
            },
          ],
        }),
        archiveJson: sampleArchiveJson(),
        taskflowDb,
        messagesDb,
        template:
          '# {{ASSISTANT_NAME}}\nManager {{MANAGER_ID}}\nBoard {{BOARD_ID}}\n',
        assistantName: 'Tars',
      });

      const rendered = fs.readFileSync(
        path.join(groupDir, 'CLAUDE.md'),
        'utf-8',
      );
      expect(rendered).toContain('Manager miguel-custom');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
      .prepare(
        'SELECT taskflow_managed FROM registered_groups WHERE folder = ?',
      )
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
      .prepare('SELECT * FROM attachment_audit_log WHERE board_id = ?')
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

  it('resolves attachment audit actors through migrated board_people, including synthesized manager rows', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    runMigration({
      tasksJson: sampleTasksJson({
        people: [],
        attachment_audit_trail: [
          {
            source: 'attachment',
            filename: 'manager-update.pdf',
            timestamp: '2026-02-28T15:00:00.000Z',
            actor_phone: '558699916064',
            action: 'update_tasks',
            created_task_ids: [],
            updated_task_ids: ['T-001'],
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
        'SELECT actor_person_id FROM attachment_audit_log WHERE board_id = ?',
      )
      .get(`board-${folder}`) as { actor_person_id: string | null };

    expect(auditLog.actor_person_id).toBe('miguel');
  });

  it('is idempotent: re-running migration does not duplicate task_history or attachment_audit_log', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    const migrationOpts = {
      tasksJson: sampleTasksJson({
        tasks: [
          {
            id: 'T-001',
            type: 'simple',
            title: 'Test task',
            assignee: 'giovanni',
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
    };

    // Run migration twice
    runMigration(migrationOpts);
    runMigration(migrationOpts);

    const boardId = `board-${folder}`;

    // task_history should have exactly 2 entries (not 4)
    const historyCount = (
      taskflowDb
        .prepare(
          'SELECT COUNT(*) as count FROM task_history WHERE board_id = ?',
        )
        .get(boardId) as { count: number }
    ).count;
    expect(historyCount).toBe(2);

    // attachment_audit_log should have exactly 1 entry (not 2)
    const auditCount = (
      taskflowDb
        .prepare(
          'SELECT COUNT(*) as count FROM attachment_audit_log WHERE board_id = ?',
        )
        .get(boardId) as { count: number }
    ).count;
    expect(auditCount).toBe(1);

    // tasks should still have exactly 1 entry (INSERT OR REPLACE is already idempotent)
    const taskCount = (
      taskflowDb
        .prepare('SELECT COUNT(*) as count FROM tasks WHERE board_id = ?')
        .get(boardId) as { count: number }
    ).count;
    expect(taskCount).toBe(1);
  });

  it('prunes stale board-scoped rows when the legacy source changes before a rerun', () => {
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
        managers: [
          { name: 'Miguel', phone: '558699916064', role: 'manager' },
          { name: 'Alexandre', phone: '558698300049', role: 'delegate' },
        ],
      }),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

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
        ],
        managers: [{ name: 'Miguel', phone: '558699916064', role: 'manager' }],
      }),
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    const boardId = `board-${folder}`;
    const people = taskflowDb
      .prepare(
        'SELECT person_id FROM board_people WHERE board_id = ? ORDER BY person_id',
      )
      .all(boardId) as Array<{ person_id: string }>;
    expect(people.map((row) => row.person_id)).toEqual(['giovanni', 'miguel']);

    const admins = taskflowDb
      .prepare(
        'SELECT person_id, admin_role FROM board_admins WHERE board_id = ? ORDER BY person_id, admin_role',
      )
      .all(boardId) as Array<{ person_id: string; admin_role: string }>;
    expect(admins).toEqual([{ person_id: 'miguel', admin_role: 'manager' }]);
  });

  it('rewrites DST guard prompt when runner_dst_guard_task_id is present', () => {
    const folder = 'test-taskflow';
    const jid = '120363000000@g.us';
    seedRegisteredGroup(folder, jid, 'Test TaskFlow');

    // Seed old JSON-mode runner prompts including DST guard
    seedScheduledTask(
      'task-standup-1',
      folder,
      jid,
      'Read /workspace/group/TASKS.json...',
    );
    seedScheduledTask(
      'task-digest-1',
      folder,
      jid,
      'Read /workspace/group/TASKS.json...',
    );
    seedScheduledTask(
      'task-review-1',
      folder,
      jid,
      'Read /workspace/group/TASKS.json...',
    );
    seedScheduledTask(
      'task-dst-guard-1',
      folder,
      jid,
      '[TF-DST-GUARD] Read /workspace/group/TASKS.json meta.dst_sync...',
    );

    // Create TASKS.json with dst_guard runner ID set
    const tasksJson = sampleTasksJson();
    tasksJson.meta.runner_task_ids.dst_guard = 'task-dst-guard-1';
    tasksJson.meta.dst_sync.enabled = true;

    runMigration({
      tasksJson,
      archiveJson: sampleArchiveJson(),
      taskflowDb,
      messagesDb,
      folder,
      groupJid: jid,
      groupName: 'Test TaskFlow',
    });

    // Verify DST guard prompt was rewritten
    const dstRunner = messagesDb
      .prepare('SELECT prompt FROM scheduled_tasks WHERE id = ?')
      .get('task-dst-guard-1') as { prompt: string };

    expect(dstRunner.prompt).not.toContain('TASKS.json');
    expect(dstRunner.prompt).toContain('[TF-DST-GUARD]');
    expect(dstRunner.prompt).toContain('board_runtime_config');
    expect(dstRunner.prompt).toContain(`board-${folder}`);

    // Verify the other runners were also rewritten
    const standupRunner = messagesDb
      .prepare('SELECT prompt FROM scheduled_tasks WHERE id = ?')
      .get('task-standup-1') as { prompt: string };
    expect(standupRunner.prompt).not.toContain('TASKS.json');
    expect(standupRunner.prompt).toContain('/workspace/taskflow/taskflow.db');
  });

  it('runs the real top-level migration path against project files', () => {
    const project = createTempProject();

    try {
      const summary = migrateWithConfig({
        projectRoot: project.tempRoot,
        dryRun: false,
      });

      expect(summary.discoveredCount).toBe(1);
      expect(summary.migratedCount).toBe(1);
      expect(summary.skippedCount).toBe(0);
      expect(fs.existsSync(path.join(project.groupDir, '.mcp.json'))).toBe(
        true,
      );
      expect(
        fs.existsSync(path.join(project.groupDir, 'CLAUDE.md.pre-migration')),
      ).toBe(true);
      expect(fs.existsSync(project.taskflowDbPath)).toBe(true);

      const migratedTaskflowDb = new Database(project.taskflowDbPath, {
        readonly: true,
      });
      const board = migratedTaskflowDb
        .prepare('SELECT id FROM boards WHERE id = ?')
        .get(`board-${project.folder}`) as { id: string };
      expect(board.id).toBe(`board-${project.folder}`);
      migratedTaskflowDb.close();

      const migratedMessagesDb = new Database(project.messagesDbPath, {
        readonly: true,
      });
      const reg = migratedMessagesDb
        .prepare(
          'SELECT taskflow_managed, taskflow_hierarchy_level, taskflow_max_depth FROM registered_groups WHERE folder = ?',
        )
        .get(project.folder) as {
        taskflow_managed: number;
        taskflow_hierarchy_level: number;
        taskflow_max_depth: number;
      };
      expect(reg.taskflow_managed).toBe(1);
      expect(reg.taskflow_hierarchy_level).toBe(0);
      expect(reg.taskflow_max_depth).toBe(1);
      migratedMessagesDb.close();
    } finally {
      project.cleanup();
    }
  });

  it('keeps real files untouched in dry-run while still exercising the top-level path', () => {
    const tasksJson = sampleTasksJson({
      managers: [{ name: 'Miguel', phone: '558699916064', role: 'manager' }],
    });
    tasksJson.meta.runner_task_ids.dst_guard = 'task-dst-guard-1';
    tasksJson.meta.dst_sync.enabled = true;

    const project = createTempProject({
      tasksJson,
    });
    const originalClaude = fs.readFileSync(
      path.join(project.groupDir, 'CLAUDE.md'),
      'utf-8',
    );

    try {
      const summary = migrateWithConfig({
        projectRoot: project.tempRoot,
        dryRun: true,
      });

      expect(summary.discoveredCount).toBe(1);
      expect(summary.migratedCount).toBe(1);
      expect(summary.dryRun).toBe(true);

      expect(fs.existsSync(path.join(project.groupDir, '.mcp.json'))).toBe(
        false,
      );
      expect(
        fs.readFileSync(path.join(project.groupDir, 'CLAUDE.md'), 'utf-8'),
      ).toBe(originalClaude);

      const messagesDb = new Database(project.messagesDbPath, {
        readonly: true,
      });
      const columns = messagesDb
        .prepare(`PRAGMA table_info(registered_groups)`)
        .all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === 'taskflow_managed')).toBe(
        false,
      );
      const prompt = (
        messagesDb
          .prepare('SELECT prompt FROM scheduled_tasks WHERE id = ?')
          .get('task-standup-1') as { prompt: string }
      ).prompt;
      expect(prompt).toContain('TASKS.json');
      messagesDb.close();

      expect(fs.existsSync(project.taskflowDbPath)).toBe(false);
    } finally {
      project.cleanup();
    }
  });
});
