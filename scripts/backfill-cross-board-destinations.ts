#!/usr/bin/env tsx
/**
 * Standalone OPERATOR CLI for the cross-board approval-destination backfill
 * (dry-run preview, or a manual re-run after fixing wiring). The reusable
 * function lives in src/modules/taskflow/backfill-cross-board-destinations.ts;
 * the host startup self-heal imports it directly, and the cutover migration
 * runs it via the setup/migrate-v2/destinations.ts step — neither goes through
 * this CLI. As an operator tool it exits non-zero when something needs human
 * attention (unresolved links / collisions) so a script/CI can gate on it.
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
    if (k === '--dry-run') {
      args['dry-run'] = true;
      continue;
    }
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
  console.log(`Links processed: ${report.links_processed}`);
  console.log(`Unresolved (skipped): ${report.unresolved}`);
  console.log(`Child 'parent-*' destinations: ${report.child_inserted} new, ${report.child_skipped} already present`);
  console.log(
    `Parent 'source-*' destinations: ${report.parent_inserted} new, ${report.parent_skipped} already present`,
  );
  console.log(`Name collisions (wrong target): ${report.name_collisions}`);
  closeDb();
  // Operator/CI gate: non-zero exit when something needs human attention. (The
  // migration path does NOT use this CLI — destinations.ts surfaces the same
  // conditions as a non-fatal "degraded" step.)
  if (report.unresolved > 0 || report.name_collisions > 0) {
    console.error(
      `\n${report.unresolved} unresolved link(s), ${report.name_collisions} name collision(s) — resolve before relying on cross-board forwarding.`,
    );
    process.exit(1);
  }
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isCli) main();
