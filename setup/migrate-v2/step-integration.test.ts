// Integration tests that drive the REAL step scripts as subprocesses, covering the
// main() wiring the pure-helper unit tests can't reach. Harness uses `node --import
// <abs tsx loader>` (cwd-independent, no tsx-CLI IPC child) so it runs in restricted
// sandboxes and CI alike.
import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx/esm');
const STEP = (name: string) => path.join(REPO, 'setup/migrate-v2', name);

const cleanups: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-it-'));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function runStep(name: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, ['--import', TSX_LOADER, STEP(name), ...args], { encoding: 'utf8', ...opts });
}

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
  it('busy guard runs BEFORE the merge (a WAL reader makes checkpoint busy but still allows writes)', () => {
    const dbPath = path.join(tmp(), 'taskflow.db');
    seedMariany(dbPath, { wal: true });
    // A reader snapshot with an uncheckpointed frame past it makes wal_checkpoint(TRUNCATE)
    // return busy=1 WITHOUT taking a write lock — so if the busy check ran AFTER the merge,
    // the merge would mutate (the reader doesn't block writes). Asserting no mutation proves
    // the check fires first. (A BEGIN IMMEDIATE writer would block the merge too and couldn't
    // distinguish the ordering.)
    const seed = new Database(dbPath);
    seed.prepare(`INSERT INTO tasks VALUES ('f1','b','x','{}','[]')`).run();
    const reader = new Database(dbPath);
    reader.pragma('busy_timeout = 0');
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) AS c FROM tasks').get(); // snapshot @ f1
    seed.prepare(`INSERT INTO tasks VALUES ('f2','b','x','{}','[]')`).run(); // frame past the snapshot
    try {
      const r = runStep('fix-creation-defects.ts', [dbPath, '--apply']);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/held by a live writer|busy/i);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      seed.close();
    }
    expect(stubCount(dbPath)).toBe(1); // un-merged → busy check ran before the merge
  }, 20000);

  it('dry-run then --apply on the SAME WAL-mode file succeeds (the stale-sidecar regression)', () => {
    const dbPath = path.join(tmp(), 'taskflow.db');
    seedMariany(dbPath, { wal: true });

    const dry = runStep('fix-creation-defects.ts', [dbPath]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/DRY-RUN|WOULD merge/);
    expect(stubCount(dbPath)).toBe(1);
    expect(fs.existsSync(dbPath + '-shm') || fs.existsSync(dbPath + '-wal')).toBe(true);

    const apply = runStep('fix-creation-defects.ts', [dbPath, '--apply']);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toMatch(/APPLIED mariany->mariany-borges/);
    expect(stubCount(dbPath)).toBe(0);
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
  // A fake `systemctl` on PATH lets us exercise probeSystemdUnit -> parseSystemctlShow ->
  // pickInstallPath -> unitServesInstall -> activeV1Unit -> main() end-to-end with a
  // controlled active-unit response (the real systemctl here serves /root/nanoclaw, not v1).
  function fakeSystemctl(workingDir: string): NodeJS.ProcessEnv {
    const bin = tmp();
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\nprintf 'ActiveState=active\\nWorkingDirectory=${workingDir}\\n'\n`, { mode: 0o755 });
    return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  }

  it('refuses (exit 1) when an active nanoclaw unit SERVES v1Path — probe→parse→decision (A-HIGH)', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    const r = runStep('taskflow.ts', [v1], { cwd: tmp(), env: fakeSystemctl(v1) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/service is currently running/);
    expect(r.stderr).toContain(`serves ${v1}`);
  });

  it('does NOT refuse when the active unit serves a DIFFERENT install (the path-verify fix)', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    const r = runStep('taskflow.ts', [v1], { cwd: tmp(), env: fakeSystemctl('/some/other/install') });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK:taskflow=copied/);
  });

  it('SKIPPED:no v1 taskflow.db exits NON-ZERO (so migrate-v2.sh never reports a green empty migration)', () => {
    const r = runStep('taskflow.ts', [tmp()], { cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no v1 taskflow\.db/);
    expect(r.status).not.toBe(0);
  });

  it('refuses (exit 1) on a non-empty -wal sidecar', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    fs.writeFileSync(path.join(v1, 'data', 'taskflow', 'taskflow.db-wal'), 'x'.repeat(64));
    const r = runStep('taskflow.ts', [v1], { cwd: tmp() });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncheckpointed WAL/);
  });

  it('refuses (exit 1) on a non-empty rollback -journal (DELETE-mode v1)', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    fs.writeFileSync(path.join(v1, 'data', 'taskflow', 'taskflow.db-journal'), 'x'.repeat(64));
    const r = runStep('taskflow.ts', [v1], { cwd: tmp() });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/rollback journal/);
  });

  it('copies a clean v1 taskflow.db (OK + exit 0) into the cwd target', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    const target = tmp();
    const r = runStep('taskflow.ts', [v1], { cwd: target });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK:taskflow=copied,boards=1/);
    expect(fs.existsSync(path.join(target, 'data', 'taskflow', 'taskflow.db'))).toBe(true);
  });
});

// run_step treats any zero exit as success before checking for SKIPPED:, so a SKIPPED
// branch MUST exit non-zero or a missing v1 input is reported as a green migration.
describe('migration steps: SKIPPED on missing input exits non-zero (run_step contract)', () => {
  it('env.ts (no v1 .env)', () => {
    const r = runStep('env.ts', [tmp()], { cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no v1 \.env/);
    expect(r.status).not.toBe(0);
  });
  it('sessions.ts (no v1 sessions dir)', () => {
    const r = runStep('sessions.ts', [tmp()], { cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no v1 data\/sessions/);
    expect(r.status).not.toBe(0);
  });
  it('tasks.ts (no v1 messages.db)', () => {
    const r = runStep('tasks.ts', [tmp()], { cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no v1 DB/);
    expect(r.status).not.toBe(0);
  });
});
