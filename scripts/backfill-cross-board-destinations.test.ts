import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initTaskflowDb } from '../src/taskflow-db.js';
import {
  backfillCrossBoardDestinations,
  type BackfillReport,
} from './backfill-cross-board-destinations.js';

const TMPROOT = path.join(os.tmpdir(), `nanoclaw-backfill-test-${process.pid}`);
const now = '2026-05-11T00:00:00Z';
let tfPath = '';

function seedBoard(
  tfDb: Database.Database,
  id: string,
  folder: string,
  groupJid: string,
  parentId: string | null,
  level: number,
): void {
  tfDb
    .prepare(
      `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, groupJid, folder, 'hierarchy', level, 3, parentId, null);
  tfDb.prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, ?)').run(id, 7);
}

function seedV2Wiring(agentId: string, folder: string, mgId: string, platformId: string): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(agentId, 'Case', folder, 'claude', now);
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, is_main_control, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(mgId, 'whatsapp', platformId, folder, 1, 'strict', 0, now);
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`mga-${agentId}`, mgId, agentId, 'pattern', '.', 'all', 'drop', 'shared', 0, now);
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

describe('backfillCrossBoardDestinations — A12-part-2 one-shot migration', () => {
  it('inserts both directional destinations for a primary-parent pair', () => {
    // Why this matters: the cutover precondition for cross_board_subtask_mode
    // ='approval' is that every wired parent↔child pair has BOTH symbolic
    // destinations. Without them, send_message fails at the MCP tool's
    // findByName lookup and approval forwarding silently drops.
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent', 'parent-folder', '120363001@g.us', null, 0);
    seedBoard(tfDb, 'board-child', 'child-folder', '120363002@g.us', 'board-parent', 1);
    tfDb.close();

    seedV2Wiring('ag-parent', 'parent-folder', 'mg-parent', '120363001@g.us');
    seedV2Wiring('ag-child', 'child-folder', 'mg-child', '120363002@g.us');

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillCrossBoardDestinations(ro, { dryRun: false });
    ro.close();

    expect(report).toMatchObject<Partial<BackfillReport>>({
      links_processed: 1,
      unresolved: 0,
      child_inserted: 1,
      parent_inserted: 1,
    });

    const childDest = getDb()
      .prepare(`SELECT target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?`)
      .get('ag-child', 'parent-parent-folder') as { target_id: string } | undefined;
    expect(childDest?.target_id).toBe('mg-parent');

    const parentDest = getDb()
      .prepare(`SELECT target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?`)
      .get('ag-parent', 'source-child-folder') as { target_id: string } | undefined;
    expect(parentDest?.target_id).toBe('mg-child');
  });

  it('is idempotent — second run skips already-present destinations and inserts nothing new', () => {
    // Why this matters: ops will dry-run, then run for real, then maybe re-run
    // after fixing unresolved cases. The script must be safely re-runnable.
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent', 'parent-folder', '120363001@g.us', null, 0);
    seedBoard(tfDb, 'board-child', 'child-folder', '120363002@g.us', 'board-parent', 1);
    tfDb.close();
    seedV2Wiring('ag-parent', 'parent-folder', 'mg-parent', '120363001@g.us');
    seedV2Wiring('ag-child', 'child-folder', 'mg-child', '120363002@g.us');

    const ro = new Database(tfPath, { readonly: true });
    backfillCrossBoardDestinations(ro, { dryRun: false });
    const second = backfillCrossBoardDestinations(ro, { dryRun: false });
    ro.close();

    expect(second.child_inserted).toBe(0);
    expect(second.parent_inserted).toBe(0);
    expect(second.child_skipped).toBe(1);
    expect(second.parent_skipped).toBe(1);
  });

  it('dry-run reports the same insert plan without writing rows', () => {
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent', 'parent-folder', '120363001@g.us', null, 0);
    seedBoard(tfDb, 'board-child', 'child-folder', '120363002@g.us', 'board-parent', 1);
    tfDb.close();
    seedV2Wiring('ag-parent', 'parent-folder', 'mg-parent', '120363001@g.us');
    seedV2Wiring('ag-child', 'child-folder', 'mg-child', '120363002@g.us');

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillCrossBoardDestinations(ro, { dryRun: true });
    ro.close();

    expect(report.dry_run).toBe(true);
    expect(report.child_inserted).toBe(1);
    expect(report.parent_inserted).toBe(1);

    const rowCount = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM agent_destinations`)
      .get() as { n: number };
    expect(rowCount.n).toBe(0); // no actual writes during dry-run
  });

  it('multi-parent: one child via child_board_registrations gets a parent-* destination per linked parent', () => {
    // Why this matters: the cross-parent unification path (the Codex finding
    // that opened A12-part-2) creates child_board_registrations rows. The
    // child must route per-parent approval responses to the correct group.
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent-A', 'parent-a', '120363001@g.us', null, 0);
    seedBoard(tfDb, 'board-parent-B', 'parent-b', '120363002@g.us', null, 0);
    seedBoard(tfDb, 'board-child', 'shared-child', '120363003@g.us', 'board-parent-A', 1);
    // Cross-parent: child ALSO registered under parent-B.
    tfDb
      .prepare(`INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, ?, ?)`)
      .run('board-parent-B', 'p-xyz', 'board-child');
    tfDb.close();

    seedV2Wiring('ag-parent-a', 'parent-a', 'mg-parent-a', '120363001@g.us');
    seedV2Wiring('ag-parent-b', 'parent-b', 'mg-parent-b', '120363002@g.us');
    seedV2Wiring('ag-child', 'shared-child', 'mg-child', '120363003@g.us');

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillCrossBoardDestinations(ro, { dryRun: false });
    ro.close();

    expect(report.links_processed).toBe(2);
    expect(report.child_inserted).toBe(2); // one per parent

    const childDests = getDb()
      .prepare(`SELECT local_name FROM agent_destinations WHERE agent_group_id = ? ORDER BY local_name`)
      .all('ag-child') as { local_name: string }[];
    expect(childDests.map((d) => d.local_name)).toEqual(['parent-parent-a', 'parent-parent-b']);
  });

  it('unresolved: skips and reports pairs where the v2 agent_group is missing', () => {
    // Why this matters: prod may have legacy board rows whose agent_groups
    // were renamed/removed in v2. The script must not crash; ops needs the
    // count to drive cleanup.
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent', 'parent-folder', '120363001@g.us', null, 0);
    seedBoard(tfDb, 'board-child', 'child-folder', '120363002@g.us', 'board-parent', 1);
    tfDb.close();
    // Seed ONLY the parent's v2 wiring; child has no agent_group.
    seedV2Wiring('ag-parent', 'parent-folder', 'mg-parent', '120363001@g.us');

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillCrossBoardDestinations(ro, { dryRun: false });
    ro.close();

    expect(report.links_processed).toBe(1);
    expect(report.unresolved).toBe(1);
    expect(report.child_inserted).toBe(0);
    expect(report.parent_inserted).toBe(0);
  });
});
