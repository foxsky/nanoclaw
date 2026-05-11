/** Host-side helpers for the per-container taskflow.db mount.
 *
 *  The host owns `<DATA_DIR>/taskflow/taskflow.db` (a SINGLE global file
 *  containing all boards across all agent groups). The directory
 *  `<DATA_DIR>/taskflow/` is mounted read-write into every agent container
 *  at `/workspace/taskflow/` so that SQLite's `-journal` sidecar can live
 *  next to the main DB regardless of which side opens it. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { initTaskflowDb } from './taskflow-db.js';

export function taskflowDir(dataDir: string): string {
  return path.join(dataDir, 'taskflow');
}

export function taskflowDbPath(dataDir: string): string {
  return path.join(taskflowDir(dataDir), 'taskflow.db');
}

/** Run heavy schema bootstrap once at host startup. Subsequent processes
 *  (container spawns, lazy host opens) hit a fully-migrated file. */
export function bootstrapTaskflowDb(dataDir: string): string {
  const dbPath = taskflowDbPath(dataDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = initTaskflowDb(dbPath);
  db.close();
  return dbPath;
}

/** Hot-path guard called on every container spawn. Asserts the DB exists
 *  (host startup should have bootstrapped it) and the parent dir is in
 *  place — does NOT re-run schema migrations. */
export function ensureTaskflowDb(dataDir: string): string {
  const dbPath = taskflowDbPath(dataDir);
  if (!fs.existsSync(dbPath)) {
    // Host bootstrap didn't run (test harness, manual spawn, etc.) — fall
    // back to one-shot init. Idempotent CREATE TABLE IF NOT EXISTS makes
    // this safe even under a first-spawn race.
    return bootstrapTaskflowDb(dataDir);
  }
  return dbPath;
}

/** Reopen helper for direct host-side writers. Sets the cross-mount
 *  invariants on the new connection (busy_timeout, foreign_keys) without
 *  rerunning schema. The first call on an existing file should already
 *  be in DELETE journal mode (set by bootstrapTaskflowDb at host start);
 *  this opens with the same mode for any new connection. */
export function openTaskflowDb(dataDir: string): Database.Database {
  const db = new Database(taskflowDbPath(dataDir));
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

