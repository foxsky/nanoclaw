import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcDeps, IpcHandler } from '../ipc.js';
import type { RegisteredGroup } from '../types.js';

// Redirect TASKFLOW_DB_PATH to a per-process temp file BEFORE importing the
// handler (or any module that resolves it). All other exports from
// provision-shared remain the real implementation.
// vi.hoisted() is required so the temp dir computation runs before vi.mock's
// hoisted factory reads it.
const { TEST_DB_DIR, TEST_DB_PATH } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsMod = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osMod = require('os') as typeof import('os');
  const dir = fsMod.mkdtempSync(
    pathMod.join(osMod.tmpdir(), 'provision-child-board-test-'),
  );
  return { TEST_DB_DIR: dir, TEST_DB_PATH: pathMod.join(dir, 'taskflow.db') };
});

vi.mock('./provision-shared.js', async () => {
  const actual =
    await vi.importActual<typeof import('./provision-shared.js')>(
      './provision-shared.js',
    );
  return {
    ...actual,
    TASKFLOW_DB_PATH: TEST_DB_PATH,
    // Stub side-effects that write to the real filesystem outside the
    // TEST_DB_DIR sandbox (groups/, data/ipc/, chown subprocess). Tests only
    // need to verify DB state; the post-seed filesystem ops leak into
    // the repo and confuse git status.
    createBoardFilesystem: () => {},
    seedAvailableGroupsJson: () => {},
    scheduleRunners: () => {},
    fixOwnership: () => {},
  };
});

// eslint-disable-next-line import/first
import { register } from './provision-child-board.js';

afterAll(() => {
  try {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

describe('provision_child_board IPC plugin', () => {
  let registeredGroups: Record<string, RegisteredGroup>;
  let handler: IpcHandler;
  let deps: IpcDeps;
  let createGroup: ReturnType<typeof vi.fn>;
  let registerGroup: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let registered: IpcHandler | undefined;
    register((type, candidate) => {
      if (type === 'provision_child_board') registered = candidate;
    });
    if (!registered)
      throw new Error('provision_child_board handler not registered');
    handler = registered;

    createGroup = vi.fn(async (subject: string, participants: string[]) => ({
      jid: 'child-group@g.us',
      subject,
      participants,
    }));

    registerGroup = vi.fn();
    sendMessage = vi.fn(async () => {});

    registeredGroups = {
      'parent@g.us': {
        name: 'Parent TaskFlow',
        folder: 'parent-taskflow',
        trigger: '@Tars',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
        taskflowHierarchyLevel: 1,
        taskflowMaxDepth: 3,
      },
      'leaf@g.us': {
        name: 'Leaf TaskFlow',
        folder: 'leaf-taskflow',
        trigger: '@Tars',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
        taskflowHierarchyLevel: 3,
        taskflowMaxDepth: 3,
      },
      'plain@g.us': {
        name: 'Plain Group',
        folder: 'plain-group',
        trigger: '@Tars',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'no-depth@g.us': {
        name: 'No Depth TaskFlow',
        folder: 'no-depth-taskflow',
        trigger: '@Tars',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
      },
    };

    deps = {
      sendMessage: sendMessage as IpcDeps['sendMessage'],
      registeredGroups: () => registeredGroups,
      registerGroup: registerGroup as IpcDeps['registerGroup'],
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
      createGroup: createGroup as IpcDeps['createGroup'],
    };
  });

  const validData = {
    person_id: 'joao',
    person_name: 'João Silva',
    person_phone: '5585999990000',
    person_role: 'desenvolvedor',
  };

  it('registers handler for provision_child_board type', () => {
    let registeredType: string | undefined;
    register((type) => {
      registeredType = type;
    });
    expect(registeredType).toBe('provision_child_board');
  });

  it('rejects non-TaskFlow groups', async () => {
    await handler(validData, 'plain-group', false, deps);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects groups without TaskFlow marker', async () => {
    await handler(validData, 'unknown-group', false, deps);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects leaf boards (level + 1 > max_depth)', async () => {
    await handler(validData, 'leaf-taskflow', false, deps);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects TaskFlow groups without depth metadata', async () => {
    await handler(validData, 'no-depth-taskflow', false, deps);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects when createGroup dep is not available', async () => {
    const depsWithoutCreateGroup = { ...deps, createGroup: undefined };
    await handler(validData, 'parent-taskflow', false, depsWithoutCreateGroup);
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('rejects missing person_id', async () => {
    await handler(
      { ...validData, person_id: '' },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects missing person_name', async () => {
    await handler(
      { ...validData, person_name: '' },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects missing person_phone', async () => {
    await handler(
      { ...validData, person_phone: '' },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects missing person_role', async () => {
    await handler(
      { ...validData, person_role: '' },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects non-string fields', async () => {
    await handler(
      { ...validData, person_id: 123 },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });
});

describe('provision_child_board cross-board person matching', () => {
  let handler: IpcHandler;
  let deps: IpcDeps;
  let createGroup: ReturnType<typeof vi.fn>;

  function openTestDb(): Database.Database {
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        board_role TEXT DEFAULT 'standard',
        hierarchy_level INTEGER,
        max_depth INTEGER,
        parent_board_id TEXT,
        short_code TEXT,
        owner_person_id TEXT
      );
      CREATE TABLE IF NOT EXISTS board_people (
        board_id TEXT,
        person_id TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        role TEXT DEFAULT 'member',
        wip_limit INTEGER,
        notification_group_jid TEXT,
        PRIMARY KEY (board_id, person_id)
      );
      CREATE TABLE IF NOT EXISTS board_admins (
        board_id TEXT,
        person_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        admin_role TEXT NOT NULL,
        is_primary_manager INTEGER DEFAULT 0,
        PRIMARY KEY (board_id, person_id, admin_role)
      );
      CREATE TABLE IF NOT EXISTS board_config (
        board_id TEXT PRIMARY KEY,
        wip_limit INTEGER DEFAULT 5
      );
      CREATE TABLE IF NOT EXISTS board_runtime_config (
        board_id TEXT PRIMARY KEY,
        language TEXT DEFAULT 'pt-BR',
        timezone TEXT DEFAULT 'America/Fortaleza',
        standup_cron_local TEXT,
        digest_cron_local TEXT,
        review_cron_local TEXT,
        standup_cron_utc TEXT,
        digest_cron_utc TEXT,
        review_cron_utc TEXT,
        attachment_enabled INTEGER DEFAULT 1,
        attachment_disabled_reason TEXT DEFAULT '',
        dst_sync_enabled INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS child_board_registrations (
        parent_board_id TEXT,
        person_id TEXT NOT NULL,
        child_board_id TEXT,
        PRIMARY KEY (parent_board_id, person_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT,
        board_id TEXT NOT NULL,
        title TEXT,
        assignee TEXT,
        column TEXT,
        updated_at TEXT,
        child_exec_enabled INTEGER DEFAULT 0,
        child_exec_board_id TEXT,
        child_exec_person_id TEXT,
        PRIMARY KEY (board_id, id)
      );
      CREATE TABLE IF NOT EXISTS task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        by TEXT,
        at TEXT NOT NULL,
        details TEXT
      );
    `);
    return db;
  }

  function seedBoards(db: Database.Database): void {
    // Parent A (source in this test) — brand-new, no registrations yet.
    db.prepare(
      'INSERT INTO boards (id, group_jid, group_folder, hierarchy_level, max_depth) VALUES (?, ?, ?, ?, ?)',
    ).run('board-parent-a', 'parent-a@g.us', 'parent-a-taskflow', 1, 3);
    db.prepare(
      'INSERT INTO board_config (board_id, wip_limit) VALUES (?, ?)',
    ).run('board-parent-a', 5);
    db.prepare(
      `INSERT INTO board_runtime_config (board_id, standup_cron_local, digest_cron_local, review_cron_local, standup_cron_utc, digest_cron_utc, review_cron_utc) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'board-parent-a',
      '0 9 * * 1-5',
      '0 18 * * 1-5',
      '0 9 * * 1',
      '0 12 * * 1-5',
      '0 21 * * 1-5',
      '0 12 * * 1',
    );

    // Parent B — unrelated parent board that already owns a child for a
    // different person who happens to share the person_id "joao".
    db.prepare(
      'INSERT INTO boards (id, group_jid, group_folder, hierarchy_level, max_depth) VALUES (?, ?, ?, ?, ?)',
    ).run('board-parent-b', 'parent-b@g.us', 'parent-b-taskflow', 1, 3);

    // Parent B's child: person_id "joao" = Joana Santos, phone 5522222222222.
    db.prepare(
      'INSERT INTO boards (id, group_jid, group_folder, hierarchy_level, max_depth, parent_board_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'board-parent-b-joao',
      'parent-b-joao@g.us',
      'parent-b-joao-taskflow',
      2,
      3,
      'board-parent-b',
    );
    db.prepare(
      'INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, ?, ?)',
    ).run('board-parent-b', 'joao', 'board-parent-b-joao');
    db.prepare(
      'INSERT INTO board_people (board_id, person_id, name, phone, role) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'board-parent-b-joao',
      'joao',
      'Joana Santos',
      '5522222222222',
      'manager',
    );
  }

  beforeEach(() => {
    // Wipe the shared test DB between cases.
    try {
      fs.rmSync(TEST_DB_PATH, { force: true });
      fs.rmSync(TEST_DB_PATH + '-wal', { force: true });
      fs.rmSync(TEST_DB_PATH + '-shm', { force: true });
    } catch {
      // First run — nothing to clean.
    }

    let registered: IpcHandler | undefined;
    register((type, candidate) => {
      if (type === 'provision_child_board') registered = candidate;
    });
    if (!registered) throw new Error('handler not registered');
    handler = registered;

    createGroup = vi.fn(async () => {
      // Stop execution before the handler touches the filesystem,
      // container runners, onboarding schedule, etc. We only want to
      // assert whether the handler reached the WhatsApp-group-creation
      // step (i.e., decided "create new board", not "link existing").
      throw new Error('test-short-circuit: createGroup called');
    });

    deps = {
      sendMessage: vi.fn(async () => {}) as IpcDeps['sendMessage'],
      registeredGroups: () => ({
        'parent-a@g.us': {
          name: 'Parent A TaskFlow',
          folder: 'parent-a-taskflow',
          trigger: '@Tars',
          added_at: '2024-01-01T00:00:00.000Z',
          taskflowManaged: true,
          taskflowHierarchyLevel: 1,
          taskflowMaxDepth: 3,
        },
        'parent-b@g.us': {
          name: 'Parent B TaskFlow',
          folder: 'parent-b-taskflow',
          trigger: '@Tars',
          added_at: '2024-01-01T00:00:00.000Z',
          taskflowManaged: true,
          taskflowHierarchyLevel: 1,
          taskflowMaxDepth: 3,
        },
      }),
      registerGroup: vi.fn() as IpcDeps['registerGroup'],
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
      createGroup: createGroup as IpcDeps['createGroup'],
    };
  });

  it('does NOT cross-link unrelated people that share the same person_id string', async () => {
    // Parent B already has a child board for person_id "joao" = Joana
    // Santos (phone 5522222222222). Now Parent A provisions a different
    // person who ALSO happens to use person_id "joao" — "João Silva" with
    // a completely different phone. The handler must NOT treat them as
    // the same person and link Silva to Joana's board.
    const db = openTestDb();
    seedBoards(db);
    db.close();

    await handler(
      {
        person_id: 'joao',
        person_name: 'João Silva',
        person_phone: '5511111111111',
        person_role: 'desenvolvedor',
      },
      'parent-a-taskflow',
      false,
      deps,
    );

    // If the handler correctly rejects the cross-link, it proceeds to
    // create a new WhatsApp group (step 6) — our mock throws there.
    expect(createGroup).toHaveBeenCalledOnce();

    // And critically: NO registration was inserted on Parent A that
    // points to Parent B's child board.
    const verify = new Database(TEST_DB_PATH, { readonly: true });
    const row = verify
      .prepare(
        `SELECT child_board_id FROM child_board_registrations
         WHERE parent_board_id = 'board-parent-a' AND person_id = 'joao'`,
      )
      .get() as { child_board_id: string } | undefined;
    verify.close();
    expect(row?.child_board_id).not.toBe('board-parent-b-joao');
  });

  it('DOES link when person_id AND phone both match an existing child board', async () => {
    // Same person_id "joao" on Parent B's child — but here we use the
    // matching phone (5522222222222). That's the "same real person moving
    // under another parent" case, which SHOULD link instead of creating.
    const db = openTestDb();
    seedBoards(db);
    db.close();

    await handler(
      {
        person_id: 'joao',
        person_name: 'Joana Santos',
        person_phone: '5522222222222',
        person_role: 'gerente',
      },
      'parent-a-taskflow',
      false,
      deps,
    );

    // Handler should take the link path — createGroup must NOT run.
    expect(createGroup).not.toHaveBeenCalled();

    const verify = new Database(TEST_DB_PATH, { readonly: true });
    const row = verify
      .prepare(
        `SELECT child_board_id FROM child_board_registrations
         WHERE parent_board_id = 'board-parent-a' AND person_id = 'joao'`,
      )
      .get() as { child_board_id: string } | undefined;
    verify.close();
    expect(row?.child_board_id).toBe('board-parent-b-joao');
  });

  it('falls back to phone-only match when person_id differs but phone is the same (rename case)', () => {
    // Codex flagged this as the compensating behavior for the
    // "same person_id + different phone → no link" rule. The other
    // direction — "different person_id + same phone" — MUST link, because
    // person_ids get renamed (e.g. 'joao' → 'joao_silva') while the phone
    // stays stable. Pin this fallback so the query isn't silently dropped.
    const db = openTestDb();
    seedBoards(db);
    db.close();

    return handler(
      {
        person_id: 'joao_silva',            // renamed from 'joao'
        person_name: 'João Silva',
        person_phone: '5522222222222',      // same phone as Parent B's joao
        person_role: 'desenvolvedor',
      },
      'parent-a-taskflow',
      false,
      deps,
    ).then(() => {
      // Handler must take the link path (NOT createGroup).
      expect(createGroup).not.toHaveBeenCalled();

      // The handler unifies the person_id to match the existing child board
      // (so tasks across parents stay consistent). Registration is written
      // under the unified ID ('joao'), not the originally-passed
      // ('joao_silva') — verify both the link target and the unification.
      const verify = new Database(TEST_DB_PATH, { readonly: true });
      const row = verify
        .prepare(
          `SELECT person_id, child_board_id FROM child_board_registrations
           WHERE parent_board_id = 'board-parent-a'`,
        )
        .get() as { person_id: string; child_board_id: string } | undefined;
      verify.close();
      expect(row?.child_board_id).toBe('board-parent-b-joao');
      expect(row?.person_id).toBe('joao');
    });
  });

  it('creates a new board when BOTH person_id and phone differ (intentional false negative)', async () => {
    // Codex concern: if a person changes BOTH phone and person_id while
    // moving across parent boards, we have no reliable signal that they
    // are the same human (name matching is intentionally excluded because
    // it produced worse collisions than creating a fresh board). This test
    // pins the current policy: different person_id AND different phone →
    // create a fresh child board, even if by chance the human is the same.
    // Reverting this policy would re-open the original cross-link bug.
    const db = openTestDb();
    seedBoards(db);
    db.close();

    await handler(
      {
        person_id: 'joao_silva',           // different from Parent B's 'joao'
        person_name: 'João Silva',          // Parent B has 'Joana Santos'
        person_phone: '5511111111111',      // Parent B has 5522222222222
        person_role: 'desenvolvedor',
      },
      'parent-a-taskflow',
      false,
      deps,
    );

    // Must take the create path — our stub createGroup throws, ending here.
    expect(createGroup).toHaveBeenCalledOnce();

    const verify = new Database(TEST_DB_PATH, { readonly: true });
    const row = verify
      .prepare(
        `SELECT child_board_id FROM child_board_registrations
         WHERE parent_board_id = 'board-parent-a' AND person_id = 'joao_silva'`,
      )
      .get() as { child_board_id: string } | undefined;
    verify.close();
    // No link to Parent B's existing joao board was written.
    expect(row?.child_board_id).not.toBe('board-parent-b-joao');
  });

  it('writes owner_person_id on the new boards row so downstream lookups stay consistent', async () => {
    // Every new provision must populate `boards.owner_person_id` in the same
    // transaction as `child_board_registrations`, or read paths that group
    // by person_id will fragment.
    const db = openTestDb();
    seedBoards(db);
    db.close();

    // Default fixture throws on createGroup to short-circuit. We need it to
    // succeed so we reach the seedTransaction.
    createGroup.mockImplementationOnce(async () => ({
      jid: 'new-child@g.us',
      subject: 'NEW - TaskFlow',
      inviteLink: null,
    }));

    await handler(
      {
        person_id: 'zelia',
        person_name: 'Zélia Teste',
        person_phone: '5585987654321',
        person_role: 'Analista',
        group_name: 'NEW - TaskFlow',
        group_folder: 'new-taskflow',
      },
      'parent-a-taskflow',
      false,
      deps,
    );

    const verify = new Database(TEST_DB_PATH, { readonly: true });
    const row = verify
      .prepare(
        `SELECT id, group_folder, parent_board_id, owner_person_id
           FROM boards
          WHERE group_jid = 'new-child@g.us'`,
      )
      .get() as
      | {
          id: string;
          group_folder: string;
          parent_board_id: string;
          owner_person_id: string;
        }
      | undefined;
    verify.close();

    expect(row).toBeDefined();
    expect(row?.owner_person_id).toBe('zelia');
    expect(row?.parent_board_id).toBe('board-parent-a');
  });
});
