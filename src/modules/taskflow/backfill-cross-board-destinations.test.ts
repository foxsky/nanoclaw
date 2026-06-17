import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
// Fork-coupled test: register the main-control migration so runMigrations()
// adds the is_main_control column this test depends on.
import './migrations-register.js';
import { createDestination } from '../../modules/agent-to-agent/db/agent-destinations.js';
import { initTaskflowDb } from '../../taskflow-db.js';
import { backfillCrossBoardDestinations, type BackfillReport } from './backfill-cross-board-destinations.js';
import { seedBoard, seedV2Wiring } from './backfill-test-helpers.js';

const TMPROOT = path.join(os.tmpdir(), `nanoclaw-backfill-test-${process.pid}`);
const now = '2026-05-11T00:00:00Z';
let tfPath = '';

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

  it('flags a name collision when a reserved parent-* name already points at a different group', () => {
    // Why this matters (Codex migration-fidelity review): a stale/partial prior
    // migration can leave `parent-<folder>` wired to the WRONG messaging group.
    // Counting it as a benign skip would leave approval forwarding silently
    // miswired. The backfill must surface it (degraded) and NOT overwrite.
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb, 'board-parent', 'parent-folder', '120363001@g.us', null, 0);
    seedBoard(tfDb, 'board-child', 'child-folder', '120363002@g.us', 'board-parent', 1);
    tfDb.close();
    seedV2Wiring('ag-parent', 'parent-folder', 'mg-parent', '120363001@g.us');
    seedV2Wiring('ag-child', 'child-folder', 'mg-child', '120363002@g.us');
    // Pre-existing WRONG wiring: child's 'parent-parent-folder' → some other group.
    createDestination({
      agent_group_id: 'ag-child',
      local_name: 'parent-parent-folder',
      target_type: 'channel',
      target_id: 'mg-stale-wrong',
      created_at: now,
    });

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillCrossBoardDestinations(ro, { dryRun: false });
    ro.close();

    expect(report.name_collisions).toBe(1);
    expect(report.child_skipped).toBe(1);
    expect(report.child_inserted).toBe(0);
    // The wrong row is left untouched — operator resolves it.
    const childDest = getDb()
      .prepare(`SELECT target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?`)
      .get('ag-child', 'parent-parent-folder') as { target_id: string };
    expect(childDest.target_id).toBe('mg-stale-wrong');
    // The parent direction is fresh, so it still inserts normally.
    expect(report.parent_inserted).toBe(1);
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

    const rowCount = getDb().prepare(`SELECT COUNT(*) AS n FROM agent_destinations`).get() as { n: number };
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
