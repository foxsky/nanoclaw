import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forkSqliteDb } from './mutation-replay-fork.js';

let tmproot: string;

beforeEach(() => {
  tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-replay-fork-'));
});

afterEach(() => {
  fs.rmSync(tmproot, { recursive: true, force: true });
});

describe('forkSqliteDb — atomic copy of a SQLite file (+ optional WAL/SHM sidecars)', () => {
  it('copies a single .db file to dest, content byte-identical', () => {
    const src = path.join(tmproot, 'src.db');
    const dest = path.join(tmproot, 'dest.db');
    fs.writeFileSync(src, 'fake-sqlite-bytes-' + 'A'.repeat(100));
    forkSqliteDb(src, dest);
    expect(fs.readFileSync(dest)).toEqual(fs.readFileSync(src));
  });

  it('throws ENOENT-shape error when src does not exist', () => {
    const src = path.join(tmproot, 'missing.db');
    const dest = path.join(tmproot, 'dest.db');
    expect(() => forkSqliteDb(src, dest)).toThrow(/no such file|ENOENT/);
  });

  it('overwrites dest if it already exists', () => {
    const src = path.join(tmproot, 'src.db');
    const dest = path.join(tmproot, 'dest.db');
    fs.writeFileSync(src, 'new');
    fs.writeFileSync(dest, 'old');
    forkSqliteDb(src, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('new');
  });

  it('creates dest parent dir if missing', () => {
    const src = path.join(tmproot, 'src.db');
    const dest = path.join(tmproot, 'deep/nested/dest.db');
    fs.writeFileSync(src, 'x');
    forkSqliteDb(src, dest);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('copies WAL sidecar when present (src.db-wal → dest.db-wal)', () => {
    const src = path.join(tmproot, 'src.db');
    const dest = path.join(tmproot, 'dest.db');
    fs.writeFileSync(src, 'main');
    fs.writeFileSync(src + '-wal', 'wal-bytes');
    forkSqliteDb(src, dest);
    expect(fs.existsSync(dest + '-wal')).toBe(true);
    expect(fs.readFileSync(dest + '-wal', 'utf8')).toBe('wal-bytes');
  });

  it('copies SHM sidecar when present', () => {
    const src = path.join(tmproot, 'src.db');
    const dest = path.join(tmproot, 'dest.db');
    fs.writeFileSync(src, 'main');
    fs.writeFileSync(src + '-shm', 'shm-bytes');
    forkSqliteDb(src, dest);
    expect(fs.existsSync(dest + '-shm')).toBe(true);
    expect(fs.readFileSync(dest + '-shm', 'utf8')).toBe('shm-bytes');
  });

  it('removes stale sidecars at dest before forking (avoids hybrid state)', () => {
    const src = path.join(tmproot, 'src.db');
    const dest = path.join(tmproot, 'dest.db');
    // src has no WAL; dest has a stale one from a previous fork
    fs.writeFileSync(src, 'fresh');
    fs.writeFileSync(dest, 'old');
    fs.writeFileSync(dest + '-wal', 'stale-wal');
    forkSqliteDb(src, dest);
    expect(fs.existsSync(dest + '-wal')).toBe(false);
  });

  it('is idempotent: running twice produces the same dest content', () => {
    const src = path.join(tmproot, 'src.db');
    const dest = path.join(tmproot, 'dest.db');
    fs.writeFileSync(src, 'content-v1');
    forkSqliteDb(src, dest);
    const after1 = fs.readFileSync(dest);
    forkSqliteDb(src, dest);
    const after2 = fs.readFileSync(dest);
    expect(after1).toEqual(after2);
  });
});
