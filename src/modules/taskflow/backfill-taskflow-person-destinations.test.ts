import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { initTaskflowDb } from '../../taskflow-db.js';
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

  it('DETECTS a display-name collision (two people, same name, different JIDs) instead of silently mis-routing', () => {
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb); // Mauro Cesar → 120363407206502707@g.us
    // A SECOND distinct person with the SAME display name but a DIFFERENT JID.
    tfDb
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
         VALUES (?, ?, ?, 'member', ?)`,
      )
      .run('board-seci-taskflow', 'mauro2', 'Mauro Cesar', '120363999999999@g.us');
    tfDb.close();
    seedAgentGroup();

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillTaskflowPersonDestinations(ro, { boardId: 'board-seci-taskflow', dryRun: false });
    ro.close();

    // First person wired; second is a collision (name already maps elsewhere) —
    // counted + surfaced, NOT silently overwritten or mis-routed.
    expect(report.destinations_inserted).toBe(1);
    expect(report.destinations_skipped).toBe(1);
    expect(report.name_collisions).toBe(1);
    // The single destination still points at the FIRST person's group (unchanged).
    const dest = getDb()
      .prepare(`SELECT target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?`)
      .get('ag-seci', 'Mauro Cesar') as { target_id: string } | undefined;
    const mg1 = getDb()
      .prepare(`SELECT id FROM messaging_groups WHERE platform_id = ?`)
      .get('120363407206502707@g.us') as { id: string };
    expect(dest?.target_id).toBe(mg1.id);
  });

  it('dry-run still detects an in-run duplicate-name collision (writes nothing)', () => {
    // Why this matters (Codex NICE): dry-run writes no rows, so the 2nd person
    // would not be seen via getDestinationByName. The in-memory planned-insert
    // map makes the PREVIEW report the same collision a real run would catch —
    // otherwise an operator dry-running before cutover gets a false all-clear.
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb); // Mauro Cesar → 120363407206502707@g.us
    tfDb
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
         VALUES (?, ?, ?, 'member', ?)`,
      )
      .run('board-seci-taskflow', 'mauro2', 'Mauro Cesar', '120363999999999@g.us');
    tfDb.close();
    seedAgentGroup();

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillTaskflowPersonDestinations(ro, { boardId: 'board-seci-taskflow', dryRun: true });
    ro.close();

    expect(report.name_collisions).toBe(1);
    expect(report.destinations_inserted).toBe(1); // WOULD-insert the first only
    expect(report.destinations_skipped).toBe(1);
    // Nothing actually written during dry-run.
    const rowCount = getDb().prepare(`SELECT COUNT(*) AS n FROM agent_destinations`).get() as { n: number };
    expect(rowCount.n).toBe(0);
  });

  it('does NOT throw when two person_ids normalize alike but route to different JIDs', () => {
    // Why this matters (Codex xhigh MEDIUM): the messaging_group id used to be
    // derived from normalizeIdPart(person_id). 'ana-1' and 'ana_1' normalize to
    // the SAME string, so two distinct people with DIFFERENT JIDs generated the
    // same id → the 2nd insert threw UNIQUE and aborted the whole pass (wedging
    // boot self-heal). The id is now derived from the JID, so they don't collide.
    const tfDb = initTaskflowDb(tfPath);
    seedBoard(tfDb); // Mauro Cesar (unrelated, distinct name+jid)
    tfDb
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
         VALUES (?, ?, ?, 'member', ?)`,
      )
      .run('board-seci-taskflow', 'ana-1', 'Ana Alpha', '120363111111111@g.us');
    tfDb
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
         VALUES (?, ?, ?, 'member', ?)`,
      )
      .run('board-seci-taskflow', 'ana_1', 'Ana Beta', '120363222222222@g.us');
    tfDb.close();
    seedAgentGroup();

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillTaskflowPersonDestinations(ro, { boardId: 'board-seci-taskflow', dryRun: false });
    ro.close();

    // All three people wired; no UNIQUE throw, no false collision.
    expect(report.rows_processed).toBe(3);
    expect(report.messaging_groups_inserted).toBe(3);
    expect(report.destinations_inserted).toBe(3);
    expect(report.name_collisions).toBe(0);
    // The two Anas point at DISTINCT messaging groups (their distinct JIDs).
    const anaTargets = getDb()
      .prepare(
        `SELECT target_id FROM agent_destinations WHERE agent_group_id = ? AND local_name IN ('Ana Alpha','Ana Beta')`,
      )
      .all('ag-seci') as { target_id: string }[];
    expect(new Set(anaTargets.map((r) => r.target_id)).size).toBe(2);
  });

  it('reuses one group for two same-named people who share a JID (not a collision)', () => {
    // Why this matters (Codex xhigh NICE): same agent, same display name, SAME
    // JID, different person_id is a legitimately shared notification group — it
    // must reuse the group and skip the duplicate destination WITHOUT counting a
    // collision (the JID-keyed dedup makes both resolve to the same target).
    const tfDb = initTaskflowDb(tfPath);
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
      .run('board-seci-taskflow', 'p1', 'Shared Team', '120363777@g.us');
    tfDb
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
         VALUES (?, ?, ?, 'member', ?)`,
      )
      .run('board-seci-taskflow', 'p2', 'Shared Team', '120363777@g.us');
    tfDb.close();
    seedAgentGroup();

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillTaskflowPersonDestinations(ro, { boardId: 'board-seci-taskflow', dryRun: false });
    ro.close();

    expect(report.messaging_groups_inserted).toBe(1);
    expect(report.messaging_groups_reused).toBe(1);
    expect(report.destinations_inserted).toBe(1);
    expect(report.destinations_skipped).toBe(1);
    expect(report.name_collisions).toBe(0); // same target → not a collision
  });

  it('dry-run reuses one group for two same-JID people via plannedMgByJid (no false collision, no writes)', () => {
    // Why this matters (Codex confirmation NICE): exercises the dry-run dedup
    // path directly. With nothing written, the 2nd same-JID person must resolve
    // through plannedMgByJid (reused), so it is NOT a false collision.
    const tfDb = initTaskflowDb(tfPath);
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
      .run('board-seci-taskflow', 'p1', 'Shared Team', '120363777@g.us');
    tfDb
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
         VALUES (?, ?, ?, 'member', ?)`,
      )
      .run('board-seci-taskflow', 'p2', 'Shared Team', '120363777@g.us');
    tfDb.close();
    seedAgentGroup();

    const ro = new Database(tfPath, { readonly: true });
    const report = backfillTaskflowPersonDestinations(ro, { boardId: 'board-seci-taskflow', dryRun: true });
    ro.close();

    expect(report.messaging_groups_inserted).toBe(1); // WOULD-insert once
    expect(report.messaging_groups_reused).toBe(1); // 2nd resolves via plannedMgByJid
    expect(report.destinations_inserted).toBe(1);
    expect(report.destinations_skipped).toBe(1);
    expect(report.name_collisions).toBe(0);
    const rowCount = getDb().prepare(`SELECT COUNT(*) AS n FROM agent_destinations`).get() as { n: number };
    expect(rowCount.n).toBe(0); // dry-run writes nothing
  });
});
