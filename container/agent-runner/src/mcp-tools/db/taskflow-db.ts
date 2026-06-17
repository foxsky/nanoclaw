/**
 * TaskFlow DB accessors (fork overlay — Contract 6, ADR 0006).
 *
 * The TaskFlow third DB used to live inline in container/agent-runner/src/db/
 * connection.ts. It is fork-owned and now registers through the generic
 * `registerExtraDb` core contract (db/extra-db.ts), keeping the core two-DB
 * layer pristine.
 *
 * journal_mode=DELETE is load-bearing for cross-mount visibility: the host
 * mounts the taskflow DIRECTORY so SQLite's `-journal` sidecar is visible from
 * both sides; WAL's `-shm` mmap is NOT coherent across the host/container
 * VirtioFS boundary, so a cross-mount writer in WAL mode could silently miss
 * the other side's updates. Both the host-side scheduling cron and the
 * in-container engine read+write this file.
 *
 * Importing this module registers the descriptor as a side effect. The named
 * exports below preserve the previous connection.ts API verbatim so consumers
 * (taskflow-api-*, the FastAPI subprocess entry, and tests) call them
 * unchanged — only the import path moves.
 */
import type { Database } from 'bun:sqlite';
import {
  registerExtraDb,
  getExtraDb,
  initExtraDb,
  initTestExtraDb,
  closeExtraDb,
} from '../../db/extra-db.js';

const TASKFLOW = 'taskflow';
const DEFAULT_TASKFLOW_PATH = '/workspace/taskflow/taskflow.db';

registerExtraDb({
  name: TASKFLOW,
  defaultPath: DEFAULT_TASKFLOW_PATH,
  applyPragmas(db: Database) {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
  },
});

/** TaskFlow DB at /workspace/taskflow/taskflow.db. */
export function getTaskflowDb(): Database {
  return getExtraDb(TASKFLOW);
}

/** Open the TaskFlow DB at a caller-supplied path. Used by the standalone
 *  taskflow MCP server entrypoint (`--db <path>` from tf-mcontrol's
 *  MCPSubprocessClient). Call once before the first getTaskflowDb(). */
export function initTaskflowDb(path: string): Database {
  return initExtraDb(TASKFLOW, path);
}

/** For tests — :memory: TaskFlow DB. Schema is the caller's responsibility
 *  (the engine's `ensureTaskSchema()` only fires for non-readonly use).
 *  NOTE: the in-memory DB still runs journal_mode=DELETE via the descriptor;
 *  that is a harmless no-op for :memory: and keeps a single pragma path. */
export function initTestTaskflowDb(): Database {
  return initTestExtraDb(TASKFLOW);
}

export function closeTaskflowDb(): void {
  closeExtraDb(TASKFLOW);
}
