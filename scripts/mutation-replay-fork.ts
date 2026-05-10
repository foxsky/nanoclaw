/**
 * A2.1.b — DB fork helper for mutation-replay.
 *
 * Copies a SQLite file (and any WAL/SHM sidecars) from `src` to `dest`,
 * cleaning stale sidecars at `dest` so the destination opens as a fresh
 * snapshot of the source. The mutation-replay runner forks the canonical
 * prod taskflow.db per call so each mutation runs against a pristine copy.
 *
 * Pure filesystem op. No SQLite library needed — we treat the files as
 * opaque bytes. The destination opens cleanly because:
 *   - WAL mode: copying main + -wal + -shm preserves the rolled-up state.
 *   - DELETE mode: only the main file exists; sidecars handled if any drift.
 */

import fs from 'node:fs';
import path from 'node:path';

const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export function forkSqliteDb(src: string, dest: string): void {
  // Always read the main file first so a missing src fails fast (ENOENT).
  const mainBytes = fs.readFileSync(src);

  // Ensure dest parent exists.
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Remove any stale sidecars at dest before we (maybe) write fresh ones.
  // Without this, a previous fork's -wal could mask a fresh-no-WAL main file
  // and the engine would open hybrid state.
  for (const suffix of SIDECAR_SUFFIXES) {
    const stale = dest + suffix;
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }

  fs.writeFileSync(dest, mainBytes);

  // Copy sidecars if present at src.
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecarSrc = src + suffix;
    if (fs.existsSync(sidecarSrc)) {
      const sidecarBytes = fs.readFileSync(sidecarSrc);
      fs.writeFileSync(dest + suffix, sidecarBytes);
    }
  }
}
