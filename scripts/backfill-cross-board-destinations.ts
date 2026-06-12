#!/usr/bin/env tsx
/**
 * CLI wrapper for the cross-board approval-destination backfill. The reusable
 * function lives in src/modules/taskflow/backfill-cross-board-destinations.ts
 * (so the host startup self-heal can import it); this is the standalone
 * operator/migration CLI.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-cross-board-destinations.ts \
 *     --taskflow-db /path/to/taskflow.db \
 *     [--dry-run]
 */
import Database from 'better-sqlite3';
import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { initDb, getDb, closeDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { backfillCrossBoardDestinations } from '../src/modules/taskflow/backfill-cross-board-destinations.js';

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

function main(): void {
  const args = parseArgs(process.argv);
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const tfDb = new Database(args.taskflowDb, { readonly: true });
  const report = backfillCrossBoardDestinations(tfDb, {
    dryRun: args.dryRun,
    logger: (line) => console.log(line),
  });
  tfDb.close();

  console.log(`\n${args.dryRun ? '=== DRY RUN ===' : '=== BACKFILL COMPLETE ==='}`);
  console.log(`Unresolved (skipped): ${report.unresolved}`);
  console.log(`Child 'parent-*' destinations: ${report.child_inserted} new, ${report.child_skipped} already present`);
  console.log(`Parent 'source-*' destinations: ${report.parent_inserted} new, ${report.parent_skipped} already present`);
  console.log(`Name collisions (wrong target): ${report.name_collisions}`);
  // Surface unresolved links + name collisions as `ERROR:` lines but do NOT
  // exit(1): the migrate-v2.sh run_step promotes the step to "degraded/partial"
  // on any `^ERROR:` line, so the gap is reported in the summary + handoff.json
  // without aborting a cutover that has already copied all core + taskflow
  // state. The host startup self-heal re-runs this backfill idempotently on
  // every boot, so an unresolved/miswired pair is recoverable (fix wiring,
  // reboot) — a hard abort here would strand the operator instead.
  if (report.unresolved > 0) {
    console.error(`ERROR: ${report.unresolved} cross-board link(s) unresolved — no matching v2 agent group; approval forwarding stays unwired for them.`);
  }
  if (report.name_collisions > 0) {
    console.error(`ERROR: ${report.name_collisions} cross-board name collision(s) — a reserved 'parent-'/'source-' destination already points at a different group; approval forwarding is miswired until resolved.`);
  }
  console.log(
    `OK:links=${report.links_processed},child_new=${report.child_inserted},child_skip=${report.child_skipped},parent_new=${report.parent_inserted},parent_skip=${report.parent_skipped},collisions=${report.name_collisions},unresolved=${report.unresolved}`,
  );
  closeDb();
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isCli) main();
