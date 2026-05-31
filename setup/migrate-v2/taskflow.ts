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

export type SystemdUnitFacts = { scope: 'user' | 'system'; state: string; installPath: string | null };

// A unit in any of these states may write the db between our probe and the copy.
// `failed` is excluded — a failed unit is not running. Matches the v1 contract.
const DANGEROUS_STATES = new Set(['active', 'reloading', 'activating', 'deactivating']);

/** Parse `systemctl show` key=value output. ExecStart values contain '=', so split on the FIRST '='. */
export function parseSystemctlShow(out: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    props[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return props;
}

/**
 * Install path a unit serves, taken from WorkingDirectory — the nanoclaw service
 * template always sets it (setup/service.ts). null when absent or the systemd
 * default `/`: the caller treats null as "cannot confirm which install" and refuses
 * (safe default). We deliberately do NOT parse ExecStart's argv: its space-joined
 * format cannot unambiguously recover an install path containing spaces, and a
 * truncated path would silently defeat the containment guard — a false-negative that
 * allows copying a live-written db, the one thing this guard must never do.
 */
export function pickInstallPath(props: Record<string, string>): string | null {
  const wd = (props.WorkingDirectory ?? '').trim();
  return wd && wd !== '/' ? wd : null;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isSameOrWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Whether a unit's install path corresponds to the v1 install we're copying.
 * Containment in EITHER direction counts (ExecStart script sits under the root;
 * an odd parent WorkingDirectory still relates). A null install path returns true:
 * we cannot prove it serves a DIFFERENT install, so we keep the safe default (refuse).
 */
export function unitServesInstall(unitPath: string | null, v1Path: string): boolean {
  if (!unitPath) return true;
  const u = realpathOrSelf(unitPath);
  const v = realpathOrSelf(v1Path);
  return isSameOrWithin(u, v) || isSameOrWithin(v, u);
}

/**
 * Decide whether an active v1 systemd unit guards `v1Path`. The v2 unit is always
 * slugged (`nanoclaw-v2-<hash>`), so a literal `nanoclaw` unit is always a v1-STYLE
 * install — but not necessarily THE install we're migrating from. Only suppress the
 * refusal when an active unit PROVABLY serves a different tree; an unconfirmable
 * install path refuses (preserves the pre-existing safe default).
 */
export function activeV1Unit(units: SystemdUnitFacts[], v1Path: string): { active: boolean; how: string } {
  for (const u of units) {
    if (!DANGEROUS_STATES.has(u.state)) continue;
    if (u.installPath && !unitServesInstall(u.installPath, v1Path)) continue;
    const why = u.installPath ? `serves ${u.installPath}` : 'install path unconfirmed';
    return { active: true, how: `systemctl ${u.scope} nanoclaw → ${u.state} (${why})` };
  }
  return { active: false, how: '' };
}

function probeSystemdUnit(scope: 'user' | 'system'): SystemdUnitFacts | null {
  const scopeArgs = scope === 'user' ? ['--user'] : [];
  const r = spawnSync(
    'systemctl',
    [...scopeArgs, 'show', 'nanoclaw', '--property=ActiveState', '--property=WorkingDirectory'],
    { encoding: 'utf8' },
  );
  if (r.error) return null;
  const props = parseSystemctlShow(r.stdout ?? '');
  const state = (props.ActiveState ?? '').trim();
  if (!state) return null;
  return { scope, state, installPath: pickInstallPath(props) };
}

/**
 * Detect whether a v1 nanoclaw is currently running. Load-bearing
 * against the WAL race Codex flagged: WAL size is a snapshot, but a
 * live v1 can have an empty WAL at stat time and then write again
 * before/during our copy.
 *
 * Coverage:
 * - systemd user unit (standard production layout per CLAUDE.md / memory)
 * - systemd system unit (sudo-installed)
 * - launchd on macOS
 * - PID file in v1 path (catches nohup / start-script launches)
 *
 * For systemctl, refuses on any transitional state (active, reloading,
 * activating, deactivating) — not just `active` — because a unit in
 * restart backoff from `Restart=always` can become live between the
 * probe and our copy. The active `nanoclaw` unit is only treated as v1
 * if it actually serves `v1Path` (via its WorkingDirectory):
 * a co-resident `nanoclaw` install pointing elsewhere (e.g. migrating from
 * a snapshot copy) must not block — that case is what the WAL-size + PID
 * backups guard. An unconfirmable install path still refuses.
 *
 * Best-effort: if a probe errors, falls through (the WAL-size backup
 * still catches uncheckpointed state).
 */
function isV1ServiceActive(v1Path: string): { active: boolean; how: string } {
  if (process.platform === 'linux') {
    const units = (['user', 'system'] as const)
      .map((scope) => probeSystemdUnit(scope))
      .filter((u): u is SystemdUnitFacts => u !== null);
    const decision = activeV1Unit(units, v1Path);
    if (decision.active) return decision;
  } else if (process.platform === 'darwin') {
    const r = spawnSync('launchctl', ['list', 'com.nanoclaw'], { encoding: 'utf8' });
    if (r.status === 0) {
      return { active: true, how: 'launchctl list com.nanoclaw' };
    }
  }

  // PID file probe — covers nohup-style / hand-rolled launchers that
  // don't go through systemd or launchd. We're best-effort here: many
  // v1 installs won't have this file at all (that's fine).
  for (const candidate of ['nanoclaw.pid', 'data/nanoclaw.pid', 'run/nanoclaw.pid']) {
    const pidFile = path.join(v1Path, candidate);
    if (!fs.existsSync(pidFile)) continue;
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    try {
      process.kill(pid, 0);
      return { active: true, how: `${candidate} → pid ${pid} alive` };
    } catch (e) {
      // EPERM means the pid EXISTS but we can't signal it (different
      // user). That's still a live writer — refuse. ESRCH (and anything
      // else) means the pid is gone; continue.
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        return { active: true, how: `${candidate} → pid ${pid} alive (other user)` };
      }
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

  // Service-running gate FIRST. Codex flagged: if we skipped on "no
  // v1 taskflow.db" while v1 was live with a 0-byte / absent file,
  // v1 could create + write TaskFlow state during the rest of the
  // migration → silent data loss. The service gate must come before
  // both the existence skip and the WAL-size backup check.
  const svc = isV1ServiceActive(v1Path);
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

  const v1Db = path.join(v1Path, 'data', 'taskflow', 'taskflow.db');
  if (!fs.existsSync(v1Db) || fs.statSync(v1Db).size === 0) {
    // v1 install has no TaskFlow surface — legitimate skip. Non-zero
    // exit so run_step routes to the skipped branch (not silent success).
    console.log('SKIPPED:no v1 taskflow.db');
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

  // DELETE-mode mirror of the WAL gate: a non-empty rollback journal MAY be hot (v1
  // stopped mid-transaction), in which case copying just taskflow.db could capture a
  // partially-written, un-rolled-back page state. We refuse conservatively without
  // distinguishing a hot journal from a benign journal_mode=PERSIST leftover — opening
  // the db cleanly resolves either (a hot journal rolls back; verify, then re-run).
  // Production v1 is WAL, but this step is general — a DELETE-mode v1 leaves -journal.
  const v1Journal = v1Db + '-journal';
  if (fs.existsSync(v1Journal) && fs.statSync(v1Journal).size > 0) {
    console.error('ERROR: v1 taskflow.db has a non-empty rollback journal');
    console.error(`       ${v1Journal} (${fs.statSync(v1Journal).size} bytes)`);
    console.error('       It may be hot (v1 stopped mid-transaction) — copying just taskflow.db');
    console.error('       could then capture an un-rolled-back state. Resolve it first by opening');
    console.error('       the db cleanly (a hot journal rolls back; a benign one is harmless):');
    console.error(`         sqlite3 "${v1Db}" 'PRAGMA integrity_check; .quit'`);
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

if (process.argv[1] && process.argv[1].endsWith('taskflow.ts')) {
  main();
}
