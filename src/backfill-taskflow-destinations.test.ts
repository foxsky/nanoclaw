import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backfillTaskflowDestinations } from './backfill-taskflow-destinations.js';
import { closeDb, getDb, initTestDb } from './db/index.js';
import { runMigrations } from './db/migrations/index.js';
import { initTaskflowDb } from './taskflow-db.js';

// Migration-fidelity F1/F2: the migration pipeline never invoked the two
// destination backfill translators, so MIGRATED boards lose cross-board
// approval forwarding (parent-/source- names) AND per-person send_message.
// This startup self-heal runs both idempotently. These tests prove a migrated
// parent↔child + a board person get their agent_destinations on first boot.

const TMPROOT = path.join(os.tmpdir(), `nanoclaw-tf-dest-startup-${process.pid}`);
const now = '2026-06-11T00:00:00Z';
let tfPath = '';

function seedBoard(
  tfDb: Database.Database,
  id: string,
  folder: string,
  jid: string,
  parentId: string | null,
  level: number,
): void {
  tfDb
    .prepare(
      `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
       VALUES (?, ?, ?, 'hierarchy', ?, 3, ?, NULL)`,
    )
    .run(id, jid, folder, level, parentId);
  tfDb.prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, 7)').run(id);
}

function seedV2Wiring(agentId: string, folder: string, mgId: string, platformId: string): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, 'claude', ?)`)
    .run(agentId, folder, folder, now);
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, is_main_control, created_at)
       VALUES (?, 'whatsapp', ?, ?, 1, 'strict', 0, ?)`,
    )
    .run(mgId, platformId, folder, now);
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
    )
    .run(`mga-${agentId}`, mgId, agentId, now);
}

function destNames(agentGroupId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT local_name FROM agent_destinations WHERE agent_group_id = ? ORDER BY local_name`)
      .all(agentGroupId) as Array<{ local_name: string }>
  ).map((r) => r.local_name);
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

describe('backfillTaskflowDestinations (startup self-heal, F1/F2)', () => {
  it('creates cross-board AND per-person destinations for migrated boards in one pass', () => {
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent', 'parent-folder', '120363001@g.us', null, 0);
    seedBoard(tfDb, 'board-child', 'child-folder', '120363002@g.us', 'board-parent', 1);
    // a person on the child board → per-person destination
    tfDb
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid) VALUES ('board-child', 'ana', 'Ana Souza', 'member', '120363555@g.us')`,
      )
      .run();
    tfDb.close();
    seedV2Wiring('ag-parent', 'parent-folder', 'mg-parent', '120363001@g.us');
    seedV2Wiring('ag-child', 'child-folder', 'mg-child', '120363002@g.us');

    const ro = new Database(tfPath, { readonly: true });
    backfillTaskflowDestinations(ro);
    ro.close();

    // Cross-board: child knows 'parent-parent-folder', parent knows 'source-child-folder'.
    expect(destNames('ag-child')).toContain('parent-parent-folder');
    expect(destNames('ag-parent')).toContain('source-child-folder');
    // Per-person: the child agent can send to 'Ana Souza'.
    expect(destNames('ag-child')).toContain('Ana Souza');
  });

  it('is idempotent — a second boot creates no new rows', () => {
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent', 'parent-folder', '120363001@g.us', null, 0);
    seedBoard(tfDb, 'board-child', 'child-folder', '120363002@g.us', 'board-parent', 1);
    tfDb.close();
    seedV2Wiring('ag-parent', 'parent-folder', 'mg-parent', '120363001@g.us');
    seedV2Wiring('ag-child', 'child-folder', 'mg-child', '120363002@g.us');

    const ro = new Database(tfPath, { readonly: true });
    backfillTaskflowDestinations(ro);
    const after1 = (getDb().prepare('SELECT count(*) AS n FROM agent_destinations').get() as { n: number }).n;
    backfillTaskflowDestinations(ro); // second boot
    const after2 = (getDb().prepare('SELECT count(*) AS n FROM agent_destinations').get() as { n: number }).n;
    ro.close();

    expect(after1).toBeGreaterThan(0);
    expect(after2).toBe(after1);
  });

  it('is a no-op (no throw) when the agent-to-agent module is not installed', () => {
    getDb().exec('DROP TABLE agent_destinations');
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent', 'parent-folder', '120363001@g.us', null, 0);
    tfDb.close();
    const ro = new Database(tfPath, { readonly: true });
    expect(() => backfillTaskflowDestinations(ro)).not.toThrow();
    ro.close();
  });
});
