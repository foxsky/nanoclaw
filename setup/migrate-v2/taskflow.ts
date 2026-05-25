/**
 * migrate-v2 step: taskflow
 *
 * Copy v1's global taskflow.db into v2. v1's `data/taskflow/taskflow.db`
 * holds the canonical TaskFlow state (boards, tasks, subtasks, audit,
 * board_people, ...). Per Codex review 2026-05-25 — the migration was
 * silently NOT copying this file, so v2 cutover would have started with
 * an empty TaskFlow surface (all 36 groups → 0 tasks).
 *
 * Source: ${v1Path}/data/taskflow/taskflow.db
 * Target: ${process.cwd()}/data/taskflow/taskflow.db
 *
 * After copy, v2's host startup runs `bootstrapTaskflowDb` →
 * `initTaskflowDb` which applies idempotent ALTER TABLE migrations for
 * any schema drift. Verified 2026-05-25: v1 and v2 column counts match
 * (boards: 15, tasks: 38). Cross-version migration helpers handle older
 * v1 shapes if they surface.
 *
 * WAL safety: assumes v1's service is STOPPED before this runs (per the
 * migrate-from-v1 runbook). Stopped service → WAL checkpointed → plain
 * file copy is consistent. For pre-cutover dry-runs against a live v1,
 * accept slight torn-write drift (last committed checkpoint is what
 * lands; recent uncommitted writes from -wal may be missed).
 *
 * Idempotent: skips if v2's taskflow.db already exists with rows. v2's
 * `bootstrapTaskflowDb` may have created an empty 0-byte file before
 * this step ran — that's treated as "not yet populated" and the copy
 * proceeds.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/taskflow.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

function main(): void {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/taskflow.ts <v1-path>');
    process.exit(1);
  }

  const v1Db = path.join(v1Path, 'data', 'taskflow', 'taskflow.db');
  if (!fs.existsSync(v1Db) || fs.statSync(v1Db).size === 0) {
    console.log('SKIPPED:no v1 taskflow.db');
    return;
  }

  const v2DbDir = path.join(process.cwd(), 'data', 'taskflow');
  const v2Db = path.join(v2DbDir, 'taskflow.db');

  // Idempotent: if v2 already has a populated taskflow.db, leave it
  // alone (re-running migrate-v2.sh must not clobber existing state).
  if (fs.existsSync(v2Db) && fs.statSync(v2Db).size > 0) {
    // Treat "has rows" as populated. An empty 0-byte file is what
    // bootstrapTaskflowDb leaves before any writes — copy proceeds.
    let populated = false;
    try {
      const probe = new Database(v2Db, { readonly: true });
      const row = probe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='boards'`).get() as { n: number };
      if (row.n > 0) {
        const boards = probe.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number };
        if (boards.n > 0) populated = true;
      }
      probe.close();
    } catch {
      // Corrupt/empty — fall through to copy.
    }
    if (populated) {
      console.log('SKIPPED:v2 taskflow.db already populated');
      return;
    }
  }

  fs.mkdirSync(v2DbDir, { recursive: true });

  // Plain file copy. Stopped-v1 assumption → WAL checkpointed → main
  // .db file is the canonical state. WAL/SHM sidecars (if present)
  // are NOT copied — v2 will start a fresh WAL on first open.
  fs.copyFileSync(v1Db, v2Db);

  // Read stats from the copy. Open RO so we don't trigger writes that
  // could interact with v1's open file (paranoia — the copy is on a
  // different inode now, but it's cheap).
  const db = new Database(v2Db, { readonly: true, fileMustExist: true });
  try {
    const boards = (db.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number }).n;
    const tasks = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    console.log(`OK:taskflow=copied,boards=${boards},tasks=${tasks}`);
  } finally {
    db.close();
  }
}

main();
