// Integration tests that drive the REAL step scripts via spawnSync, covering the
// main() wiring the pure-helper unit tests can't reach: Guard A's --apply WAL/busy
// guard + dry-run->apply, and Guard B's service/WAL/journal gates + exit-code contract.
// A false-negative regression anywhere in this glue (e.g. moving the busy guard after
// the merge, or a SKIPPED branch exiting 0) passes the unit suite but fails here.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd(); // vitest runs from repo root
const TSX = path.join(REPO, 'node_modules/.bin/tsx');
const FIX = path.join(REPO, 'setup/migrate-v2/fix-creation-defects.ts');
const TASKFLOW = path.join(REPO, 'setup/migrate-v2/taskflow.ts');

const cleanups: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-it-'));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function schema(d: Database.Database) {
  d.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, owner_person_id TEXT, parent_board_id TEXT);
    CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, role TEXT, phone TEXT, wip_limit INTEGER, PRIMARY KEY(board_id, person_id));
    CREATE TABLE board_admins (board_id TEXT, person_id TEXT, phone TEXT, admin_role TEXT, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY(board_id, person_id, admin_role));
    CREATE TABLE tasks (id TEXT PRIMARY KEY, board_id TEXT, assignee TEXT, _last_mutation TEXT, notes TEXT);
    CREATE TABLE archive (id TEXT PRIMARY KEY, board_id TEXT, assignee TEXT, task_snapshot TEXT, history TEXT);
    CREATE TABLE task_history (id TEXT PRIMARY KEY, task_id TEXT, "by" TEXT, details TEXT);
  `);
}

// Minimal Mariany signature: a role/phone-less `mariany` stub + the full `mariany-borges`
// on the same board with the same name, so detectStubDuplicateIdentities flags the pair.
function seedMariany(dbPath: string, opts: { wal: boolean }) {
  const d = new Database(dbPath);
  if (opts.wal) d.pragma('journal_mode = WAL');
  schema(d);
  d.exec(`
    INSERT INTO boards VALUES ('b','jb','mariany-borges',NULL);
    INSERT INTO board_people VALUES
      ('b','mariany','Mariany Borges','','',NULL),
      ('b','mariany-borges','Mariany Borges','Analista','5586',NULL);
    INSERT INTO board_admins VALUES ('b','mariany','','manager',0);
    INSERT INTO tasks VALUES ('T1','b','mariany','{"by":"mariany"}','[]');
  `);
  d.close();
}

function stubCount(dbPath: string): number {
  const d = new Database(dbPath, { readonly: true });
  const n = (d.prepare(`SELECT count(*) c FROM board_people WHERE person_id='mariany'`).get() as { c: number }).c;
  d.close();
  return n;
}

describe('Guard A: fix-creation-defects.ts main() --apply wiring', () => {
  it('refuses (exit 2, no mutation) when a concurrent writer holds the db', () => {
    const dir = tmp();
    const dbPath = path.join(dir, 'taskflow.db');
    seedMariany(dbPath, { wal: true });

    // Hold a write lock so the child's wal_checkpoint(TRUNCATE) reports busy=1.
    const holder = new Database(dbPath);
    holder.pragma('busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare(`INSERT INTO tasks VALUES ('lock','b','x','{}','[]')`).run();
    try {
      const r = spawnSync(TSX, [FIX, dbPath, '--apply'], { encoding: 'utf8' });
      expect(r.status).not.toBe(0); // refused
      expect(`${r.stdout}${r.stderr}`).toMatch(/held by a live writer|busy/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(stubCount(dbPath)).toBe(1); // no partial mutation
  }, 20000);

  it('dry-run then --apply on the SAME WAL-mode file succeeds (the stale-sidecar regression)', () => {
    const dir = tmp();
    const dbPath = path.join(dir, 'taskflow.db');
    seedMariany(dbPath, { wal: true });

    const dry = spawnSync(TSX, [FIX, dbPath], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/DRY-RUN|WOULD merge/);
    expect(stubCount(dbPath)).toBe(1); // dry-run mutates nothing
    expect(fs.existsSync(dbPath + '-shm') || fs.existsSync(dbPath + '-wal')).toBe(true); // sidecars left

    const apply = spawnSync(TSX, [FIX, dbPath, '--apply'], { encoding: 'utf8' });
    expect(apply.status).toBe(0); // does NOT false-refuse on the stale sidecar
    expect(apply.stdout).toMatch(/APPLIED mariany->mariany-borges/);
    expect(stubCount(dbPath)).toBe(0); // merged
  });
});

describe('Guard B: taskflow.ts main() gates + exit-code contract', () => {
  function v1WithDb(seed?: (d: Database.Database) => void): string {
    const v1 = tmp();
    const dbDir = path.join(v1, 'data', 'taskflow');
    fs.mkdirSync(dbDir, { recursive: true });
    const d = new Database(path.join(dbDir, 'taskflow.db'));
    schema(d);
    if (seed) seed(d);
    d.close();
    return v1;
  }
  const run = (v1: string) => spawnSync(TSX, [TASKFLOW, v1], { encoding: 'utf8', cwd: tmp() });

  it('SKIPPED:no v1 taskflow.db exits NON-ZERO (so migrate-v2.sh never reports a green empty migration)', () => {
    const r = spawnSync(TSX, [TASKFLOW, tmp()], { encoding: 'utf8', cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no v1 taskflow\.db/);
    expect(r.status).not.toBe(0);
  });

  it('refuses (exit 1) on a non-empty -wal sidecar', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    fs.writeFileSync(path.join(v1, 'data', 'taskflow', 'taskflow.db-wal'), 'x'.repeat(64));
    const r = run(v1);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncheckpointed WAL/);
  });

  it('refuses (exit 1) on a non-empty rollback -journal (DELETE-mode v1)', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    fs.writeFileSync(path.join(v1, 'data', 'taskflow', 'taskflow.db-journal'), 'x'.repeat(64));
    const r = run(v1);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/rollback journal/);
  });

  it('copies a clean v1 taskflow.db (OK + exit 0) into the cwd target', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    const target = tmp();
    const r = spawnSync(TSX, [TASKFLOW, v1], { encoding: 'utf8', cwd: target });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK:taskflow=copied,boards=1/);
    expect(fs.existsSync(path.join(target, 'data', 'taskflow', 'taskflow.db'))).toBe(true);
  });
});
