#!/usr/bin/env tsx
/**
 * Backfill v2 named destinations from Taskflow's v1-era
 * board_people.notification_group_jid routing data.
 *
 * v1 agents could read notification_group_jid from sqlite and call
 * send_message(target_chat_jid=...). v2 intentionally blocks raw sqlite and
 * raw-JID sends; the equivalent behavior is a first-class named destination
 * in agent_destinations pointing at a messaging_groups row.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-taskflow-person-destinations.ts \
 *     --taskflow-db data/taskflow/taskflow.db \
 *     [--board-id board-seci-taskflow] \
 *     [--dry-run]
 */
import Database from 'better-sqlite3';
import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { initDb, getDb, closeDb, hasTable } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import {
  createDestination,
  getDestinationByName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { runMigrations } from '../src/db/migrations/index.js';

interface PersonNotificationRow {
  board_id: string;
  group_folder: string;
  person_id: string;
  name: string;
  notification_group_jid: string;
}

export interface PersonDestinationBackfillReport {
  rows_processed: number;
  unresolved_boards: number;
  messaging_groups_inserted: number;
  messaging_groups_reused: number;
  destinations_inserted: number;
  destinations_skipped: number;
  dry_run: boolean;
}

function normalizeIdPart(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

export function readPersonNotificationRows(tfDb: Database.Database, boardId?: string): PersonNotificationRow[] {
  const where = [
    boardId ? 'bp.board_id = ?' : '',
    'bp.notification_group_jid IS NOT NULL',
    "TRIM(bp.notification_group_jid) != ''",
  ].filter(Boolean).join(' AND ');
  return tfDb
    .prepare(
      `SELECT bp.board_id, b.group_folder, bp.person_id, bp.name, bp.notification_group_jid
         FROM board_people bp
         JOIN boards b ON b.id = bp.board_id
        WHERE ${where}
        ORDER BY bp.board_id, bp.name`,
    )
    .all(...(boardId ? [boardId] : [])) as PersonNotificationRow[];
}

function findMessagingGroupId(channelType: string, platformId: string): string | null {
  const row = getDb()
    .prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?')
    .get(channelType, platformId) as { id: string } | undefined;
  return row?.id ?? null;
}

function insertMessagingGroup(id: string, platformId: string, name: string, now: string, dryRun: boolean): void {
  if (dryRun) return;
  getDb()
    .prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'whatsapp', ?, ?, 1, 'strict', ?)`,
    )
    .run(id, platformId, name, now);
}

export function backfillTaskflowPersonDestinations(
  tfDb: Database.Database,
  options: { boardId?: string; dryRun: boolean; logger?: (line: string) => void },
): PersonDestinationBackfillReport {
  const log = options.logger ?? (() => undefined);
  if (!hasTable(getDb(), 'agent_destinations')) {
    throw new Error('agent_destinations table missing — agent-to-agent module not installed.');
  }
  const rows = readPersonNotificationRows(tfDb, options.boardId);
  const report: PersonDestinationBackfillReport = {
    rows_processed: rows.length,
    unresolved_boards: 0,
    messaging_groups_inserted: 0,
    messaging_groups_reused: 0,
    destinations_inserted: 0,
    destinations_skipped: 0,
    dry_run: options.dryRun,
  };
  const now = new Date().toISOString();

  for (const row of rows) {
    const agentGroup = getAgentGroupByFolder(row.group_folder);
    if (!agentGroup) {
      report.unresolved_boards++;
      log(`  unresolved board folder=${row.group_folder} board_id=${row.board_id}`);
      continue;
    }

    let messagingGroupId = findMessagingGroupId('whatsapp', row.notification_group_jid);
    if (messagingGroupId) {
      report.messaging_groups_reused++;
    } else {
      messagingGroupId = `mg-taskflow-person-${normalizeIdPart(row.group_folder)}-${normalizeIdPart(row.person_id)}`;
      log(`  ${options.dryRun ? 'DRY: ' : ''}messaging_group ${messagingGroupId} → ${row.notification_group_jid}`);
      insertMessagingGroup(messagingGroupId, row.notification_group_jid, row.name, now, options.dryRun);
      report.messaging_groups_inserted++;
    }

    if (getDestinationByName(agentGroup.id, row.name)) {
      report.destinations_skipped++;
      continue;
    }
    if (options.dryRun) {
      report.destinations_inserted++;
      log(`  DRY: destination ${agentGroup.id} '${row.name}' → ${messagingGroupId}`);
      continue;
    }
    createDestination({
      agent_group_id: agentGroup.id,
      local_name: row.name,
      target_type: 'channel',
      target_id: messagingGroupId,
      created_at: now,
    });
    report.destinations_inserted++;
  }

  return report;
}

interface Args {
  dbPath: string;
  taskflowDb: string;
  boardId?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | true> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--dry-run') { args['dry-run'] = true; continue; }
    if (!key.startsWith('--')) throw new Error(`Unexpected arg: ${key}`);
    args[key.slice(2)] = argv[++i] ?? '';
  }
  if (!args['taskflow-db'] || typeof args['taskflow-db'] !== 'string') {
    console.error('Usage: --taskflow-db <path> [--board-id <board>] [--dry-run]');
    process.exit(2);
  }
  return {
    dbPath: typeof args.db === 'string' ? args.db : path.join(DATA_DIR, 'v2.db'),
    taskflowDb: args['taskflow-db'],
    boardId: typeof args['board-id'] === 'string' ? args['board-id'] : undefined,
    dryRun: args['dry-run'] === true,
  };
}

function main(): void {
  const args = parseArgs(process.argv);
  initDb(args.dbPath);
  runMigrations(getDb());
  const tfDb = new Database(args.taskflowDb, { readonly: true });
  const report = backfillTaskflowPersonDestinations(tfDb, {
    boardId: args.boardId,
    dryRun: args.dryRun,
    logger: (line) => console.log(line),
  });
  tfDb.close();
  console.log(`\n${args.dryRun ? '=== DRY RUN ===' : '=== BACKFILL COMPLETE ==='}`);
  console.log(`Rows processed: ${report.rows_processed}`);
  console.log(`Unresolved boards: ${report.unresolved_boards}`);
  console.log(`Messaging groups: ${report.messaging_groups_inserted} new, ${report.messaging_groups_reused} reused`);
  console.log(`Destinations: ${report.destinations_inserted} new, ${report.destinations_skipped} already present`);
  console.log('\nRestart affected agent containers so inbound destination projections refresh.');
  closeDb();
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isCli) main();
