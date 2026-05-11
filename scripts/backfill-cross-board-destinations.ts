#!/usr/bin/env tsx
/**
 * A12-part-2 backfill: register cross-board approval destinations for
 * existing parent↔child wirings that predate A12.
 *
 * Each (parent_board, child_board) pair gets two agent_destinations rows
 * (idempotent — skipped when present):
 *   - On child agent: local_name='parent-<parent_folder>' → parent's
 *     messaging_group.
 *   - On parent agent: local_name='source-<child_folder>' → child's
 *     messaging_group.
 *
 * Pairs are walked from taskflow.db: boards.parent_board_id (primary
 * parent) UNION child_board_registrations (multi-parent links). The
 * board → agent_group bridge goes through messaging_groups.platform_id =
 * boards.group_jid, then messaging_group_agents.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-cross-board-destinations.ts \
 *     --taskflow-db /path/to/taskflow.db \
 *     [--dry-run]
 *
 * Dry-run mode prints the planned INSERTs without writing anything.
 */

import Database from 'better-sqlite3';
import { initDb, getDb, closeDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { hasTable } from '../src/db/connection.js';
import {
  createDestination,
  getDestinationByName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';

interface Args {
  taskflowDb: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | true> = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') { args['dry-run'] = true; continue; }
    if (!k.startsWith('--')) throw new Error(`Unexpected arg: ${k}`);
    args[k.slice(2)] = argv[++i] ?? '';
  }
  if (!args['taskflow-db'] || typeof args['taskflow-db'] !== 'string') {
    console.error('Usage: --taskflow-db <path> [--dry-run]');
    process.exit(2);
  }
  return { taskflowDb: args['taskflow-db'], dryRun: args['dry-run'] === true };
}

interface BoardLink {
  parent_board_id: string;
  parent_folder: string;
  parent_group_jid: string;
  child_board_id: string;
  child_folder: string;
  child_group_jid: string;
}

function readBoardLinks(tfDb: Database.Database): BoardLink[] {
  // Primary-parent edges via boards.parent_board_id + cross-parent
  // registrations via child_board_registrations. UNION dedupes.
  return tfDb
    .prepare(
      `SELECT p.id AS parent_board_id, p.group_folder AS parent_folder, p.group_jid AS parent_group_jid,
              c.id AS child_board_id,  c.group_folder AS child_folder,  c.group_jid  AS child_group_jid
         FROM boards c
         JOIN boards p ON p.id = c.parent_board_id
        WHERE c.parent_board_id IS NOT NULL
       UNION
       SELECT p.id, p.group_folder, p.group_jid,
              c.id, c.group_folder, c.group_jid
         FROM child_board_registrations cbr
         JOIN boards p ON p.id = cbr.parent_board_id
         JOIN boards c ON c.id = cbr.child_board_id`,
    )
    .all() as BoardLink[];
}

function resolveAgentAndMessagingGroup(
  groupFolder: string,
  groupJid: string,
): { agent_group_id: string; messaging_group_id: string } | null {
  const ag = getAgentGroupByFolder(groupFolder);
  if (!ag) return null;
  const mg = getDb()
    .prepare(
      `SELECT mg.id AS messaging_group_id
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mga.agent_group_id = ? AND mg.platform_id = ?`,
    )
    .get(ag.id, groupJid) as { messaging_group_id: string } | undefined;
  if (!mg) return null;
  return { agent_group_id: ag.id, messaging_group_id: mg.messaging_group_id };
}

function main() {
  const args = parseArgs(process.argv);
  initDb();
  runMigrations(getDb());
  if (!hasTable(getDb(), 'agent_destinations')) {
    console.error('agent_destinations table missing — agent-to-agent module not installed. Abort.');
    process.exit(1);
  }

  const tfDb = new Database(args.taskflowDb, { readonly: true });
  const links = readBoardLinks(tfDb);
  tfDb.close();
  console.log(`Found ${links.length} parent↔child links in taskflow.db.`);

  let parentSkipped = 0, childSkipped = 0, parentInserted = 0, childInserted = 0, unresolved = 0;
  const now = new Date().toISOString();

  for (const link of links) {
    const parent = resolveAgentAndMessagingGroup(link.parent_folder, link.parent_group_jid);
    const child = resolveAgentAndMessagingGroup(link.child_folder, link.child_group_jid);
    if (!parent || !child) {
      console.warn(`  unresolved: parent_folder=${link.parent_folder} child_folder=${link.child_folder}`);
      unresolved++;
      continue;
    }

    const parentDestName = `parent-${link.parent_folder}`;
    const sourceDestName = `source-${link.child_folder}`;

    if (getDestinationByName(child.agent_group_id, parentDestName)) {
      childSkipped++;
    } else if (args.dryRun) {
      console.log(`  DRY: child ${child.agent_group_id} += '${parentDestName}' → ${parent.messaging_group_id}`);
      childInserted++;
    } else {
      createDestination({
        agent_group_id: child.agent_group_id,
        local_name: parentDestName,
        target_type: 'channel',
        target_id: parent.messaging_group_id,
        created_at: now,
      });
      childInserted++;
    }

    if (getDestinationByName(parent.agent_group_id, sourceDestName)) {
      parentSkipped++;
    } else if (args.dryRun) {
      console.log(`  DRY: parent ${parent.agent_group_id} += '${sourceDestName}' → ${child.messaging_group_id}`);
      parentInserted++;
    } else {
      createDestination({
        agent_group_id: parent.agent_group_id,
        local_name: sourceDestName,
        target_type: 'channel',
        target_id: child.messaging_group_id,
        created_at: now,
      });
      parentInserted++;
    }
  }

  console.log(`\n${args.dryRun ? '=== DRY RUN ===' : '=== BACKFILL COMPLETE ==='}`);
  console.log(`Links processed: ${links.length}`);
  console.log(`Unresolved (skipped): ${unresolved}`);
  console.log(`Child 'parent-*' destinations: ${childInserted} new, ${childSkipped} already present`);
  console.log(`Parent 'source-*' destinations: ${parentInserted} new, ${parentSkipped} already present`);
  console.log(`\nNote: running sessions need writeDestinations() to see new rows — restart`);
  console.log(`affected agent containers, or trigger a router event that wakes them.`);

  closeDb();
}

main();
