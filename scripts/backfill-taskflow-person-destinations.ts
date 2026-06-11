#!/usr/bin/env tsx
/**
 * CLI wrapper for the per-person destination backfill. The reusable function
 * lives in src/modules/taskflow/backfill-taskflow-person-destinations.ts (so the
 * host startup self-heal imports it); this is the standalone operator/migration CLI.
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
import { initDb, getDb, closeDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { backfillTaskflowPersonDestinations } from '../src/modules/taskflow/backfill-taskflow-person-destinations.js';

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
  console.log(`Display-name collisions: ${report.name_collisions}`);
  console.log('\nRestart affected agent containers so inbound destination projections refresh.');
  // Fail-loud gate for the cutover migrate step: a name collision means a
  // person's send_message would mis-route to a same-named teammate.
  if (report.name_collisions > 0 || report.unresolved_boards > 0) {
    console.error(`ERROR: ${report.name_collisions} name collision(s), ${report.unresolved_boards} unresolved board(s) — resolve before relying on per-person forwarding.`);
    closeDb();
    process.exit(1);
  }
  closeDb();
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isCli) main();
