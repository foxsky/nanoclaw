#!/usr/bin/env tsx
/**
 * Standalone OPERATOR CLI for the per-person destination backfill (dry-run
 * preview, or a manual re-run after fixing wiring). The reusable function lives
 * in src/modules/taskflow/backfill-taskflow-person-destinations.ts; the host
 * startup self-heal imports it directly, and the cutover migration runs it via
 * the setup/migrate-v2/destinations.ts step — neither goes through this CLI. As
 * an operator tool it exits non-zero when something needs human attention
 * (unresolved boards / collisions) so a script/CI can gate on it.
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
    if (key === '--dry-run') {
      args['dry-run'] = true;
      continue;
    }
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
  closeDb();
  // Operator/CI gate: non-zero exit when something needs human attention. (The
  // migration path does NOT use this CLI — destinations.ts surfaces the same
  // conditions as a non-fatal "degraded" step.)
  if (report.name_collisions > 0 || report.unresolved_boards > 0) {
    console.error(
      `\n${report.name_collisions} name collision(s), ${report.unresolved_boards} unresolved board(s) — resolve before relying on per-person forwarding.`,
    );
    process.exit(1);
  }
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isCli) main();
