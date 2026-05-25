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
 * Safety contract (Codex gpt-5.5/xhigh BLOCKERs 2026-05-25):
 *
 * 1. WAL gate. migrate-v2.sh runs Phase-1 steps while v1 is still live
 *    (v1 is only stopped later, in the switchover block). v1 uses WAL
 *    journaling, so a live v1 has committed-but-not-checkpointed frames
 *    in `taskflow.db-wal`. A plain file copy of just `taskflow.db` would
 *    silently drop those frames → silent data loss. This step REFUSES
 *    if `-wal` exists and is non-empty: the user must stop v1 first.
 *
 * 2. Exit codes. `run_step` in migrate-v2.sh only routes `SKIPPED:` to
 *    the skip branch on non-zero exit. SKIPPED with exit 0 is reported
 *    as success — that masks "no v1 taskflow.db" as a green migration.
 *    All SKIPPED branches exit non-zero.
 *
 * 3. Atomic write. Plain `copyFileSync` is not atomic — a crash mid-copy
 *    leaves a partial file that the idempotency check could then skip.
 *    Copy to `.migrate-tmp`, size + integrity-check, then atomic rename.
 *
 * 4. Ownership. If migrate-v2.sh is run as root, the copied DB is
 *    root-owned and the container (UID 1000 in this deployment) can't
 *    write to it. When running as root, chown the file + parent dir to
 *    match the project root's owner (typically the service user).
 *
 * Idempotent: skips if v2's taskflow.db already exists with rows. v2's
 * `bootstrapTaskflowDb` may have created an empty 0-byte file before
 * this step ran — that's treated as "not yet populated" and the copy
 * proceeds.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/taskflow.ts <v1-path>
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

/**
 * Detect whether a v1 nanoclaw service unit is currently active. This is
 * the load-bearing check that prevents the WAL race Codex flagged: WAL
 * size is a snapshot, but a live v1 can have an empty WAL at stat time
 * and then write again before/during our copy.
 *
 * Covers user-level systemd (the standard production layout per
 * CLAUDE.md / memory), system-level systemd (sudo-installed unit), and
 * launchd on macOS. Best-effort: if the command is missing or errors
 * unexpectedly, returns `{active:false}` and the caller falls through
 * to the WAL-size backup check.
 */
function isV1ServiceActive(): { active: boolean; how: string } {
  if (process.platform === 'linux') {
    for (const args of [['--user', 'is-active', 'nanoclaw'], ['is-active', 'nanoclaw']]) {
      const r = spawnSync('systemctl', args, { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim() === 'active') {
        return { active: true, how: `systemctl ${args.join(' ')}` };
      }
    }
  } else if (process.platform === 'darwin') {
    const r = spawnSync('launchctl', ['list', 'com.nanoclaw'], { encoding: 'utf8' });
    if (r.status === 0) {
      return { active: true, how: 'launchctl list com.nanoclaw' };
    }
  }
  return { active: false, how: '' };
}

function fixOwnership(target: string, projectRoot: string): void {
  const getuid = process.getuid;
  if (!getuid || getuid() !== 0) return;
  const projectStat = fs.statSync(projectRoot);
  if (projectStat.uid === 0) return;
  try {
    fs.chownSync(target, projectStat.uid, projectStat.gid);
  } catch (e) {
    console.error(`WARN: chown(${target}) → ${projectStat.uid}:${projectStat.gid} failed: ${(e as Error).message}`);
  }
}

function main(): void {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/taskflow.ts <v1-path>');
    process.exit(1);
  }

  const v1Db = path.join(v1Path, 'data', 'taskflow', 'taskflow.db');
  if (!fs.existsSync(v1Db) || fs.statSync(v1Db).size === 0) {
    // v1 install has no TaskFlow surface — legitimate skip. Non-zero
    // exit so run_step routes to the skipped branch (not silent success).
    console.log('SKIPPED:no v1 taskflow.db');
    process.exit(1);
  }

  // Service-running gate — load-bearing against the WAL race. Must come
  // BEFORE the WAL-size snapshot check (a live v1 can have an empty WAL
  // at stat time, then write more after we copy).
  const svc = isV1ServiceActive();
  if (svc.active) {
    console.error('ERROR: v1 nanoclaw service is currently running');
    console.error(`       (detected via: ${svc.how})`);
    console.error('       Copying taskflow.db while v1 is live would lose any');
    console.error('       writes that land between the copy and the cutover.');
    console.error('');
    console.error('       Stop v1 first:');
    console.error('         systemctl --user stop nanoclaw       # Linux (user unit)');
    console.error('         sudo systemctl stop nanoclaw         # Linux (system unit)');
    console.error('         launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist   # macOS');
    console.error('');
    console.error('       Then re-run migrate-v2.sh.');
    process.exit(1);
  }

  // WAL-size backup gate — catches v1 that was killed uncleanly (service
  // probe says "not active" but uncheckpointed frames remain in -wal).
  const v1Wal = v1Db + '-wal';
  if (fs.existsSync(v1Wal) && fs.statSync(v1Wal).size > 0) {
    const walSize = fs.statSync(v1Wal).size;
    console.error('ERROR: v1 taskflow.db has uncheckpointed WAL frames');
    console.error(`       ${v1Wal} (${walSize} bytes)`);
    console.error('       v1 was stopped uncleanly (or is running outside the standard');
    console.error('       service unit — service probe did not detect it).');
    console.error('       Copying just taskflow.db would silently drop those frames.');
    console.error('');
    console.error('       Checkpoint the WAL into the main file:');
    console.error(`         sqlite3 "${v1Db}" 'PRAGMA wal_checkpoint(TRUNCATE); .quit'`);
    console.error('       (sqlite3 CLI may need install: apt install sqlite3)');
    console.error('');
    console.error('       Then re-run migrate-v2.sh.');
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const v2DbDir = path.join(projectRoot, 'data', 'taskflow');
  const v2Db = path.join(v2DbDir, 'taskflow.db');

  if (fs.existsSync(v2Db) && fs.statSync(v2Db).size > 0) {
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
      process.exit(1);
    }
  }

  fs.mkdirSync(v2DbDir, { recursive: true });
  fixOwnership(v2DbDir, projectRoot);

  const v2DbTmp = v2Db + '.migrate-tmp';
  if (fs.existsSync(v2DbTmp)) fs.unlinkSync(v2DbTmp);
  fs.copyFileSync(v1Db, v2DbTmp);

  const v1Stat = fs.statSync(v1Db);
  const tmpStat = fs.statSync(v2DbTmp);
  if (v1Stat.size !== tmpStat.size) {
    fs.unlinkSync(v2DbTmp);
    console.error(`ERROR: copy size mismatch (v1=${v1Stat.size}, tmp=${tmpStat.size})`);
    process.exit(1);
  }

  let boards = 0;
  let tasks = 0;
  const tmpDb = new Database(v2DbTmp, { readonly: true, fileMustExist: true });
  try {
    const integrity = (tmpDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (integrity !== 'ok') {
      tmpDb.close();
      fs.unlinkSync(v2DbTmp);
      console.error(`ERROR: integrity_check on copied taskflow.db: ${integrity}`);
      process.exit(1);
    }
    boards = (tmpDb.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number }).n;
    tasks = (tmpDb.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  } finally {
    tmpDb.close();
  }

  // Atomic rename (same filesystem → atomic on POSIX). Drop the WAL/SHM
  // sidecars sqlite created during our RO integrity-check open — they
  // are bound to the .migrate-tmp basename and would be stale after
  // the rename. v2's first writer will recreate sidecars under the
  // final taskflow.db basename.
  for (const ext of ['-wal', '-shm']) {
    const sidecar = v2DbTmp + ext;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  fs.renameSync(v2DbTmp, v2Db);
  fixOwnership(v2Db, projectRoot);

  console.log(`OK:taskflow=copied,boards=${boards},tasks=${tasks}`);
}

main();
