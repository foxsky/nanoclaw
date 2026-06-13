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
  const r = spawnSync(process.execPath, ['--import', TSX_LOADER, STEP(name), ...args], { encoding: 'utf8', ...opts });
  // Fail loud (not via a confusing assertion mismatch) if the environment can't spawn
  // the child at all — e.g. a sandbox that blocks subprocesses.
  if (r.error) throw new Error(`cannot spawn step '${name}': ${(r.error as Error).message}`);
  return r;
}

function v1WithMessagesDb(seed: (d: Database.Database) => void): string {
  const v1 = tmp();
  fs.mkdirSync(path.join(v1, 'store'), { recursive: true });
  const d = new Database(path.join(v1, 'store', 'messages.db'));
  seed(d);
  d.close();
  return v1;
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
    fs.writeFileSync(
      path.join(bin, 'systemctl'),
      `#!/usr/bin/env bash\nprintf 'ActiveState=active\\nWorkingDirectory=${workingDir}\\n'\n`,
      { mode: 0o755 },
    );
    return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  }
  // Reports an inactive unit so the gate falls through to the WAL/journal/SKIPPED/copy
  // branch deterministically — without this the tests would depend on the host's real
  // `nanoclaw` unit serving a confirmable non-/tmp path (fragile on CI).
  function fakeSystemctlInactive(): NodeJS.ProcessEnv {
    const bin = tmp();
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\nprintf 'ActiveState=inactive\\n'\n`, {
      mode: 0o755,
    });
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
    const r = runStep('taskflow.ts', [tmp()], { cwd: tmp(), env: fakeSystemctlInactive() });
    expect(r.stdout).toMatch(/SKIPPED:no v1 taskflow\.db/);
    expect(r.status).not.toBe(0);
  });

  it('refuses (exit 1) on a non-empty -wal sidecar', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    fs.writeFileSync(path.join(v1, 'data', 'taskflow', 'taskflow.db-wal'), 'x'.repeat(64));
    const r = runStep('taskflow.ts', [v1], { cwd: tmp(), env: fakeSystemctlInactive() });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncheckpointed WAL/);
  });

  it('refuses (exit 1) on a non-empty rollback -journal (DELETE-mode v1)', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    fs.writeFileSync(path.join(v1, 'data', 'taskflow', 'taskflow.db-journal'), 'x'.repeat(64));
    const r = runStep('taskflow.ts', [v1], { cwd: tmp(), env: fakeSystemctlInactive() });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/rollback journal/);
  });

  it('copies a clean v1 taskflow.db (OK + exit 0) into the cwd target', () => {
    const v1 = v1WithDb((d) => d.exec(`INSERT INTO boards VALUES ('b','j','o',NULL)`));
    const target = tmp();
    const r = runStep('taskflow.ts', [v1], { cwd: target, env: fakeSystemctlInactive() });
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

  it('db.ts (v1 has no registered groups)', () => {
    const v1 = v1WithMessagesDb((d) =>
      d.exec(
        `CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER)`,
      ),
    );
    const r = runStep('db.ts', [v1], { cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no registered groups in v1/);
    expect(r.status).not.toBe(0);
  });

  it('groups.ts (no v1 groups/ directory)', () => {
    const r = runStep('groups.ts', [tmp()], { cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no v1 groups\/ directory/);
    expect(r.status).not.toBe(0);
  });

  it('destinations.ts (no taskflow.db to back-fill from)', () => {
    const r = runStep('destinations.ts', [tmp()], { cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no taskflow\.db/);
    expect(r.status).not.toBe(0);
  });

  it('tasks.ts (v1 DB present but no active or paused scheduled tasks)', () => {
    const v1 = v1WithMessagesDb((d) => d.exec(`CREATE TABLE scheduled_tasks (id TEXT, status TEXT)`));
    const r = runStep('tasks.ts', [v1], { cwd: tmp() });
    expect(r.stdout).toMatch(/SKIPPED:no active or paused tasks/);
    expect(r.status).not.toBe(0);
  });
});

describe('Guard E: groups.ts carries v1 persona (F4) + model (F3) into container.json', () => {
  it('writes assistantName from trigger_pattern and model from the session settings.json', () => {
    const v1 = tmp();
    // v1 DB with a board whose persona is @Case and a sibling with no persona.
    fs.mkdirSync(path.join(v1, 'store'), { recursive: true });
    const d = new Database(path.join(v1, 'store', 'messages.db'));
    d.exec(
      `CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER, container_config TEXT);`,
    );
    d.prepare(`INSERT INTO registered_groups VALUES (?, ?, ?, ?, 0, 0, NULL)`).run(
      'tg:1',
      'SECTI - TaskFlow',
      'secti-taskflow',
      '@Case',
    );
    d.prepare(`INSERT INTO registered_groups VALUES (?, ?, ?, ?, 1, 0, NULL)`).run('tg:2', 'Plain', 'plain', '.');
    d.close();
    // v1 groups/ dir (required) + a session settings.json carrying the model.
    fs.mkdirSync(path.join(v1, 'groups', 'secti-taskflow'), { recursive: true });
    fs.mkdirSync(path.join(v1, 'groups', 'plain'), { recursive: true });
    const claudeDir = path.join(v1, 'data', 'sessions', 'secti-taskflow', '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' } }),
    );

    const cwd = tmp();
    const r = runStep('groups.ts', [v1], { cwd });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK:.*configs=1/); // only the @Case board gets a container.json

    const secti = JSON.parse(fs.readFileSync(path.join(cwd, 'groups', 'secti-taskflow', 'container.json'), 'utf8'));
    expect(secti.assistantName).toBe('Case');
    expect(secti.model).toBe('claude-sonnet-4-6');
    // The '.' (respond-to-all) board has no persona and no model → no container.json.
    expect(fs.existsSync(path.join(cwd, 'groups', 'plain', 'container.json'))).toBe(false);
  });

  it('re-run MERGES persona+model into a pre-existing config-only container.json (no clobber)', () => {
    const v1 = tmp();
    fs.mkdirSync(path.join(v1, 'store'), { recursive: true });
    const d = new Database(path.join(v1, 'store', 'messages.db'));
    d.exec(
      `CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER, container_config TEXT);`,
    );
    d.prepare(`INSERT INTO registered_groups VALUES (?, ?, ?, ?, 0, 0, NULL)`).run(
      'tg:1',
      'Case Board',
      'case',
      '@Case',
    );
    d.close();
    fs.mkdirSync(path.join(v1, 'groups', 'case'), { recursive: true });
    const claudeDir = path.join(v1, 'data', 'sessions', 'case', '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-opus-4-8' } }),
    );

    // Simulate a prior/partial migration that already wrote a config-only
    // container.json (mounts) but WITHOUT persona/model.
    const cwd = tmp();
    const v2CaseDir = path.join(cwd, 'groups', 'case');
    fs.mkdirSync(v2CaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(v2CaseDir, 'container.json'),
      JSON.stringify({ additionalMounts: [{ source: '/x', target: '/y' }] }),
    );

    const r = runStep('groups.ts', [v1], { cwd });
    expect(r.status).toBe(0);

    const merged = JSON.parse(fs.readFileSync(path.join(v2CaseDir, 'container.json'), 'utf8'));
    expect(merged.assistantName).toBe('Case'); // added on re-run
    expect(merged.model).toBe('claude-opus-4-8'); // added on re-run
    expect(merged.additionalMounts).toEqual([{ source: '/x', target: '/y' }]); // preserved
  });

  it('re-run does NOT clobber an operator-set assistantName/model', () => {
    const v1 = tmp();
    fs.mkdirSync(path.join(v1, 'store'), { recursive: true });
    const d = new Database(path.join(v1, 'store', 'messages.db'));
    d.exec(
      `CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER, container_config TEXT);`,
    );
    d.prepare(`INSERT INTO registered_groups VALUES (?, ?, ?, ?, 0, 0, NULL)`).run(
      'tg:1',
      'Case Board',
      'case',
      '@Case',
    );
    d.close();
    fs.mkdirSync(path.join(v1, 'groups', 'case'), { recursive: true });
    const claudeDir = path.join(v1, 'data', 'sessions', 'case', '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-opus-4-8' } }),
    );

    const cwd = tmp();
    const v2CaseDir = path.join(cwd, 'groups', 'case');
    fs.mkdirSync(v2CaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(v2CaseDir, 'container.json'),
      JSON.stringify({ assistantName: 'OperatorName', model: 'operator-model' }),
    );

    const r = runStep('groups.ts', [v1], { cwd });
    expect(r.status).toBe(0);

    const kept = JSON.parse(fs.readFileSync(path.join(v2CaseDir, 'container.json'), 'utf8'));
    expect(kept.assistantName).toBe('OperatorName');
    expect(kept.model).toBe('operator-model');
  });
});

describe('Guard D: destinations.ts main() backfills + OK contract', () => {
  it('seeds a per-person destination from board_people.notification_group_jid (OK + exit 0)', () => {
    // db.ts first to materialize the v2 agent_group (folder 'main') + messaging
    // group the backfill resolves against; then a taskflow.db with a person who
    // has a notification group jid; then the step wires the named destination.
    const v1 = v1WithMessagesDb((d) => {
      d.exec(
        `CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER);`,
      );
      d.exec(`INSERT INTO registered_groups VALUES ('tg:123', 'Chat', 'main', NULL, 0, 1);`);
    });
    const cwd = tmp();
    expect(runStep('db.ts', [v1], { cwd }).status).toBe(0);

    const tfDir = path.join(cwd, 'data', 'taskflow');
    fs.mkdirSync(tfDir, { recursive: true });
    const tf = new Database(path.join(tfDir, 'taskflow.db'));
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, board_role TEXT, hierarchy_level INT, max_depth INT, parent_board_id TEXT, short_code TEXT);
      CREATE TABLE board_config (board_id TEXT, wip_limit INT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, role TEXT, notification_group_jid TEXT);
      CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT, child_board_id TEXT);
      INSERT INTO boards VALUES ('b', 'tg:123', 'main', 'hierarchy', 0, 3, NULL, NULL);
      INSERT INTO board_people VALUES ('b', 'ana', 'Ana Souza', 'member', '5599@g.us');
    `);
    tf.close();

    const r = runStep('destinations.ts', [v1], { cwd });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK:.*person_dest=1/);

    const central = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    const dest = central.prepare(`SELECT local_name FROM agent_destinations WHERE local_name = 'Ana Souza'`).get();
    central.close();
    expect(dest).toBeTruthy();
  });

  it('SKIPPED:no taskflow.db exits non-zero even when v2.db exists', () => {
    const v1 = v1WithMessagesDb((d) => {
      d.exec(
        `CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER);`,
      );
      d.exec(`INSERT INTO registered_groups VALUES ('tg:123', 'Chat', 'main', NULL, 0, 1);`);
    });
    const cwd = tmp();
    expect(runStep('db.ts', [v1], { cwd }).status).toBe(0); // v2.db exists, but no taskflow.db
    const r = runStep('destinations.ts', [v1], { cwd });
    expect(r.stdout).toMatch(/SKIPPED:no taskflow\.db/);
    expect(r.status).not.toBe(0);
  });
});

describe('Guard C: tasks.ts legacy prompt shapes', () => {
  it('decodes legacy BLOB scheduled-task prompts to text before JSON insertion', () => {
    const v1 = v1WithMessagesDb((d) => {
      d.exec(`
        CREATE TABLE registered_groups (
          jid TEXT,
          name TEXT,
          folder TEXT,
          trigger_pattern TEXT,
          requires_trigger INTEGER,
          is_main INTEGER
        );
        CREATE TABLE scheduled_tasks (
          id TEXT,
          group_folder TEXT,
          chat_jid TEXT,
          prompt BLOB,
          schedule_type TEXT,
          schedule_value TEXT,
          next_run TEXT,
          status TEXT,
          context_mode TEXT,
          script TEXT
        );
        INSERT INTO registered_groups VALUES ('tg:123', 'Chat', 'main', NULL, 0, 1);
      `);
      d.prepare(`INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'auditor-daily',
        'main',
        'tg:123',
        Buffer.from('daily auditor prompt', 'utf8'),
        'cron',
        '0 8 * * *',
        '2026-06-12T11:00:00.000Z',
        'active',
        'recent',
        null,
      );
    });
    const cwd = tmp();
    const dbStep = runStep('db.ts', [v1], { cwd });
    expect(dbStep.status).toBe(0);

    const r = runStep('tasks.ts', [v1], { cwd });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK:migrated=1,paused=0,skipped=0,failed=0/);

    const central = new Database(path.join(cwd, 'data', 'v2.db'));
    const ag = central.prepare("SELECT id FROM agent_groups WHERE folder = 'main'").get() as { id: string };
    central.close();
    const sessionRoot = path.join(cwd, 'data', 'v2-sessions');
    const inbound = fs
      .readdirSync(path.join(sessionRoot, ag.id), { recursive: true })
      .map((p) => path.join(sessionRoot, ag.id, String(p)))
      .find((p) => p.endsWith('inbound.db'));
    expect(inbound).toBeDefined();
    const db = new Database(inbound!);
    const row = db.prepare("SELECT content FROM messages_in WHERE id = 'auditor-daily'").get() as { content: string };
    db.close();
    const content = JSON.parse(row.content) as { prompt: unknown };
    expect(content.prompt).toBe('daily auditor prompt');
  });
});

describe('Guard G: sessions.ts continuation = authoritative v1 sessions table (Gap #1)', () => {
  function findOutbound(cwd: string, agId: string): string {
    const root = path.join(cwd, 'data', 'v2-sessions', agId);
    const ob = fs
      .readdirSync(root, { recursive: true })
      .map((p) => path.join(root, String(p)))
      .find((p) => p.endsWith('outbound.db'));
    if (!ob) throw new Error('no outbound.db found');
    return ob;
  }

  it('resumes the session_id from the v1 sessions table, NOT the (mtime-clobbered) JSONL sort', () => {
    const v1 = v1WithMessagesDb((d) => {
      d.exec(`
        CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER);
        CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL);
        INSERT INTO registered_groups VALUES ('tg:123', 'Chat', 'main', NULL, 0, 1);
        INSERT INTO sessions VALUES ('main', 'active-session-id');
      `);
    });
    // Two JSONL files; copyTree clobbers mtimes on copy, so the old mtime sort
    // could pick either. The sessions table is authoritative.
    const projDir = path.join(v1, 'data', 'sessions', 'main', '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'active-session-id.jsonl'), '{"type":"summary"}\n');
    fs.writeFileSync(path.join(projDir, 'stale-old-session.jsonl'), '{"type":"summary"}\n');

    const cwd = tmp();
    expect(runStep('db.ts', [v1], { cwd }).status).toBe(0);
    expect(runStep('sessions.ts', [v1], { cwd }).status).toBe(0);

    const central = new Database(path.join(cwd, 'data', 'v2.db'));
    const ag = central.prepare("SELECT id FROM agent_groups WHERE folder = 'main'").get() as { id: string };
    central.close();
    const ob = new Database(findOutbound(cwd, ag.id));
    const cont = ob.prepare(`SELECT value FROM session_state WHERE key = 'continuation:claude'`).get() as
      | { value: string }
      | undefined;
    ob.close();
    expect(cont?.value).toBe('active-session-id');
  });

  it('falls back to a JSONL when the v1 sessions table has no row for the folder', () => {
    const v1 = v1WithMessagesDb((d) => {
      d.exec(`
        CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER);
        CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL);
        INSERT INTO registered_groups VALUES ('tg:123', 'Chat', 'main', NULL, 0, 1);
      `); // no sessions row for 'main'
    });
    const projDir = path.join(v1, 'data', 'sessions', 'main', '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'only-session.jsonl'), '{"type":"summary"}\n');

    const cwd = tmp();
    expect(runStep('db.ts', [v1], { cwd }).status).toBe(0);
    expect(runStep('sessions.ts', [v1], { cwd }).status).toBe(0);

    const central = new Database(path.join(cwd, 'data', 'v2.db'));
    const ag = central.prepare("SELECT id FROM agent_groups WHERE folder = 'main'").get() as { id: string };
    central.close();
    const ob = new Database(findOutbound(cwd, ag.id));
    const cont = ob.prepare(`SELECT value FROM session_state WHERE key = 'continuation:claude'`).get() as
      | { value: string }
      | undefined;
    ob.close();
    expect(cont?.value).toBe('only-session'); // fallback to the present JSONL
  });

  it('a re-run picks up a newly-active session (copyTree always runs, table re-read)', () => {
    const v1 = v1WithMessagesDb((d) => {
      d.exec(`
        CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER);
        CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL);
        INSERT INTO registered_groups VALUES ('tg:123', 'Chat', 'main', NULL, 0, 1);
        INSERT INTO sessions VALUES ('main', 'session-one');
      `);
    });
    const projDir = path.join(v1, 'data', 'sessions', 'main', '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'session-one.jsonl'), '{"type":"summary"}\n');

    const cwd = tmp();
    expect(runStep('db.ts', [v1], { cwd }).status).toBe(0);
    expect(runStep('sessions.ts', [v1], { cwd }).status).toBe(0);

    // v1 advances: a new active session + the table updates. (Old code skipped
    // copyTree on re-run because -workspace-agent already existed → stranded.)
    fs.writeFileSync(path.join(projDir, 'session-two.jsonl'), '{"type":"summary"}\n');
    const v1db = new Database(path.join(v1, 'store', 'messages.db'));
    v1db.prepare(`UPDATE sessions SET session_id = 'session-two' WHERE group_folder = 'main'`).run();
    v1db.close();
    expect(runStep('sessions.ts', [v1], { cwd }).status).toBe(0);

    const central = new Database(path.join(cwd, 'data', 'v2.db'));
    const ag = central.prepare("SELECT id FROM agent_groups WHERE folder = 'main'").get() as { id: string };
    central.close();
    const ob = new Database(findOutbound(cwd, ag.id));
    const cont = ob.prepare(`SELECT value FROM session_state WHERE key = 'continuation:claude'`).get() as
      | { value: string }
      | undefined;
    ob.close();
    expect(cont?.value).toBe('session-two');
  });

  it('emits a degraded ERROR and sets NO continuation when the active session has no copied history', () => {
    const v1 = v1WithMessagesDb((d) => {
      d.exec(`
        CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER);
        CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL);
        INSERT INTO registered_groups VALUES ('tg:123', 'Chat', 'main', NULL, 0, 1);
        INSERT INTO sessions VALUES ('main', 'ghost-session');
      `);
    });
    // .claude project dir exists but holds NO jsonl history.
    const projDir = path.join(v1, 'data', 'sessions', 'main', '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'notes.txt'), 'not a jsonl');

    const cwd = tmp();
    expect(runStep('db.ts', [v1], { cwd }).status).toBe(0);
    const r = runStep('sessions.ts', [v1], { cwd });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/ERROR:session main: v1 active session ghost-session/);

    const central = new Database(path.join(cwd, 'data', 'v2.db'));
    const ag = central.prepare("SELECT id FROM agent_groups WHERE folder = 'main'").get() as { id: string };
    central.close();
    const ob = new Database(findOutbound(cwd, ag.id));
    const cont = ob.prepare(`SELECT value FROM session_state WHERE key = 'continuation:claude'`).get();
    ob.close();
    expect(cont).toBeUndefined();
  });
});

describe('Guard F: tasks.ts migrates paused tasks as paused (F7)', () => {
  it('carries a paused cron task DORMANT (status=paused), migrates active, drops terminal states', () => {
    const v1 = v1WithMessagesDb((d) => {
      d.exec(`
        CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER, is_main INTEGER);
        CREATE TABLE scheduled_tasks (id TEXT, group_folder TEXT, chat_jid TEXT, prompt TEXT, schedule_type TEXT, schedule_value TEXT, next_run TEXT, status TEXT, context_mode TEXT, script TEXT);
        INSERT INTO registered_groups VALUES ('tg:123', 'Chat', 'main', NULL, 0, 1);
      `);
      const ins = d.prepare(`INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      ins.run('act-1', 'main', 'tg:123', 'active daily', 'cron', '0 8 * * *', '2026-06-12T11:00:00.000Z', 'active', 'recent', null);
      ins.run('pause-1', 'main', 'tg:123', 'paused daily', 'cron', '0 9 * * *', '2026-06-12T12:00:00.000Z', 'paused', 'recent', null);
      // Terminal states must NOT migrate.
      ins.run('done-1', 'main', 'tg:123', 'done once', 'once', '', '2026-01-01T00:00:00.000Z', 'completed', 'recent', null);
      ins.run('cancel-1', 'main', 'tg:123', 'cancelled', 'cron', '0 10 * * *', '2026-06-12T13:00:00.000Z', 'cancelled', 'recent', null);
    });
    const cwd = tmp();
    expect(runStep('db.ts', [v1], { cwd }).status).toBe(0);

    const r = runStep('tasks.ts', [v1], { cwd });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/migrated=2/); // active + paused, not the terminal rows
    expect(r.stdout).toMatch(/paused=1/);

    const central = new Database(path.join(cwd, 'data', 'v2.db'));
    const ag = central.prepare("SELECT id FROM agent_groups WHERE folder = 'main'").get() as { id: string };
    central.close();
    const sessionRoot = path.join(cwd, 'data', 'v2-sessions');
    const inbound = fs
      .readdirSync(path.join(sessionRoot, ag.id), { recursive: true })
      .map((p) => path.join(sessionRoot, ag.id, String(p)))
      .find((p) => p.endsWith('inbound.db'));
    expect(inbound).toBeDefined();
    const db = new Database(inbound!);
    const statusOf = (id: string) =>
      (db.prepare("SELECT status FROM messages_in WHERE id = ? AND kind = 'task'").get(id) as
        | { status: string }
        | undefined)?.status;
    const active = statusOf('act-1');
    const paused = statusOf('pause-1');
    const done = statusOf('done-1');
    const cancelled = statusOf('cancel-1');
    db.close();
    expect(active).toBe('pending'); // active → live, fires normally
    expect(paused).toBe('paused'); // F7: paused stays dormant (not auto-resumed)
    expect(done).toBeUndefined(); // completed/once → dropped
    expect(cancelled).toBeUndefined(); // cancelled → dropped
  });
});
