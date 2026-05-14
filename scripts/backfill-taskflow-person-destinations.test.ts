import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initTaskflowDb } from '../src/taskflow-db.js';
import {
  backfillTaskflowPersonDestinations,
  readPersonNotificationRows,
} from './backfill-taskflow-person-destinations.js';

const TMPROOT = path.join(os.tmpdir(), `nanoclaw-person-dest-test-${process.pid}`);
const now = '2026-05-14T00:00:00.000Z';
let tfPath = '';

function seedBoard(tfDb: Database.Database): void {
  tfDb
    .prepare(
      `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, short_code)
       VALUES ('board-seci-taskflow', '120363001@g.us', 'seci-taskflow', 'hierarchy', 0, 3, 'SECI')`,
    )
    .run();
  tfDb.prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, ?)').run('board-seci-taskflow', 7);
  tfDb
    .prepare(
      `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
       VALUES (?, ?, ?, 'member', ?)`,
    )
    .run('board-seci-taskflow', 'mauro', 'Mauro Cesar', '120363407206502707@g.us');
}

function seedAgentGroup(): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('ag-seci', 'SECI', 'seci-taskflow', 'claude', now);
}

beforeEach(() => {
  fs.mkdirSync(TMPROOT, { recursive: true });
  tfPath = path.join(TMPROOT, `tf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMPROOT, { recursive: true, force: true });
});

describe('backfillTaskflowPersonDestinations', () => {
  it('reads people with notification_group_jid for a board', () => {
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb);

    const rows = readPersonNotificationRows(tfDb, 'board-seci-taskflow');
    tfDb.close();

    expect(rows).toEqual([
      expect.objectContaining({
        board_id: 'board-seci-taskflow',
        group_folder: 'seci-taskflow',
        person_id: 'mauro',
        name: 'Mauro Cesar',
        notification_group_jid: '120363407206502707@g.us',
      }),
    ]);
  });

  it('creates a messaging group and named destination for each person notification route', () => {
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb);
    tfDb.close();
    seedAgentGroup();

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillTaskflowPersonDestinations(ro, { boardId: 'board-seci-taskflow', dryRun: false });
    ro.close();

    expect(report).toMatchObject({
      rows_processed: 1,
      unresolved_boards: 0,
      messaging_groups_inserted: 1,
      destinations_inserted: 1,
    });
    const mg = getDb()
      .prepare(`SELECT id, name FROM messaging_groups WHERE platform_id = ?`)
      .get('120363407206502707@g.us') as { id: string; name: string } | undefined;
    expect(mg).toMatchObject({ name: 'Mauro Cesar' });
    const dest = getDb()
      .prepare(`SELECT local_name, target_id FROM agent_destinations WHERE agent_group_id = ?`)
      .get('ag-seci') as { local_name: string; target_id: string } | undefined;
    expect(dest).toEqual({ local_name: 'Mauro Cesar', target_id: mg?.id });
  });

  it('reuses an existing messaging group for the same JID', () => {
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb);
    tfDb.close();
    seedAgentGroup();
    getDb()
      .prepare(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES ('mg-existing', 'whatsapp', '120363407206502707@g.us', 'Existing Mauro', 1, 'strict', ?)`,
      )
      .run(now);

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillTaskflowPersonDestinations(ro, { boardId: 'board-seci-taskflow', dryRun: false });
    ro.close();

    expect(report.messaging_groups_inserted).toBe(0);
    expect(report.messaging_groups_reused).toBe(1);
    const dest = getDb()
      .prepare(`SELECT target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?`)
      .get('ag-seci', 'Mauro Cesar') as { target_id: string } | undefined;
    expect(dest?.target_id).toBe('mg-existing');
  });
});
