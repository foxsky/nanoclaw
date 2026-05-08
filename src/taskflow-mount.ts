/** Host-side helpers for the per-container taskflow.db mount.
 *
 *  The host owns `<DATA_DIR>/taskflow/taskflow.db` (a SINGLE global file
 *  containing all boards across all agent groups). The directory
 *  `<DATA_DIR>/taskflow/` is mounted read-write into every agent container
 *  at `/workspace/taskflow/` so that SQLite's `-journal` sidecar can live
 *  next to the main DB regardless of which side opens it. */
import fs from 'node:fs';
import path from 'node:path';

import { initTaskflowDb } from './taskflow-db.js';

export function taskflowDir(dataDir: string): string {
  return path.join(dataDir, 'taskflow');
}

export function taskflowDbPath(dataDir: string): string {
  return path.join(taskflowDir(dataDir), 'taskflow.db');
}

/** Ensure the TaskFlow DB exists with full schema. If absent, bootstraps
 *  via `initTaskflowDb` which runs `TASKFLOW_SCHEMA` (CREATE TABLE IF
 *  NOT EXISTS) plus the in-place ALTER TABLE migrations. Idempotent —
 *  reopening an existing populated DB just re-runs the IF-NOT-EXISTS
 *  guards and exits. */
export function ensureTaskflowDb(dataDir: string): string {
  const dbPath = taskflowDbPath(dataDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // initTaskflowDb opens (creates if missing), runs schema/migrations,
  // sets DELETE journal mode + busy_timeout, then we close immediately
  // so the lazy host-side opens (taskflow-db.ts/dm-routing.ts) own the
  // long-lived handle.
  const db = initTaskflowDb(dbPath);
  db.close();
  return dbPath;
}
