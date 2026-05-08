import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureTaskflowDb, taskflowDbPath, taskflowDir } from './taskflow-mount.js';

describe('taskflowDir / taskflowDbPath', () => {
  it('returns canonical paths derived from DATA_DIR', () => {
    expect(taskflowDir('/some/data')).toBe('/some/data/taskflow');
    expect(taskflowDbPath('/some/data')).toBe('/some/data/taskflow/taskflow.db');
  });
});

describe('ensureTaskflowDb', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-mount-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates dir + DB with full schema when nothing exists', () => {
    const dataDir = path.join(tmpRoot, 'data');
    const dbPath = ensureTaskflowDb(dataDir);
    expect(dbPath).toBe(path.join(dataDir, 'taskflow', 'taskflow.db'));
    expect(fs.existsSync(dbPath)).toBe(true);
    // initTaskflowDb seeded the boards/tasks tables.
    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    db.close();
    const names = tables.map((t) => t.name);
    expect(names).toContain('boards');
    expect(names).toContain('tasks');
    expect(names).toContain('task_history');
  });

  it('preserves existing data on reopen (idempotent)', () => {
    const dataDir = path.join(tmpRoot, 'data');
    ensureTaskflowDb(dataDir);
    // Seed a board to verify the second call doesn't wipe it.
    const dbPath = taskflowDbPath(dataDir);
    {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO boards (id, group_jid, group_folder) VALUES ('b-test', '120@g.us', 'tg')`,
      ).run();
      db.close();
    }
    ensureTaskflowDb(dataDir);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT id FROM boards WHERE id = ?`).get('b-test');
    db.close();
    expect(row).toBeTruthy();
  });

  it('opens the DB in journal_mode=DELETE (cross-mount safety)', () => {
    const dataDir = path.join(tmpRoot, 'data');
    const dbPath = ensureTaskflowDb(dataDir);
    const db = new Database(dbPath);
    const mode = db.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string };
    db.close();
    expect(mode.journal_mode).toBe('delete');
  });
});
