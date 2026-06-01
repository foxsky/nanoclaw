import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { insertMemory, openMemoryDb, sanitizeFtsQuery, searchMemory } from './memory-store.js';

let db: ReturnType<typeof openMemoryDb> | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

describe('sanitizeFtsQuery', () => {
  it('quotes each term (implicit AND) and strips FTS5 operators', () => {
    expect(sanitizeFtsQuery('deploy plan')).toBe('"deploy" "plan"');
    expect(sanitizeFtsQuery('foo* "bar (')).toBe('"foo" "bar"');
  });
  it('returns empty for a no-token query', () => {
    expect(sanitizeFtsQuery('   "*(  ')).toBe('');
  });
  it('keeps unicode word chars (accented names)', () => {
    expect(sanitizeFtsQuery('reunião Mariany')).toBe('"reunião" "Mariany"');
  });
});

describe('memory store (FTS5, board-scoped, provenance)', () => {
  it('insert then search returns the memory with provenance', () => {
    db = openMemoryDb(':memory:');
    const id = insertMemory(db, {
      board_id: 'b1',
      text: 'the deploy window is Tuesday 9am',
      kind: 'fact',
      source_session: 'sess-1',
      source_ts: '2026-05-31T12:00:00Z',
    });
    expect(id).toMatch(/^mem-/);

    const hits = searchMemory(db, 'b1', 'deploy window', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('the deploy window is Tuesday 9am');
    expect(hits[0].source_session).toBe('sess-1');
    expect(hits[0].source_ts).toBe('2026-05-31T12:00:00Z');
    expect(hits[0].kind).toBe('fact');
    expect(hits[0].created_at).toBeTruthy();
  });

  it('scopes search to the board (no cross-board leak)', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'a', text: 'secret alpha note' });
    insertMemory(db, { board_id: 'b', text: 'secret beta note' });

    expect(searchMemory(db, 'a', 'secret', 5).map((m) => m.text)).toEqual(['secret alpha note']);
    expect(searchMemory(db, 'b', 'secret', 5).map((m) => m.text)).toEqual(['secret beta note']);
  });

  it('respects the limit and does not throw on FTS5-special-char queries', () => {
    db = openMemoryDb(':memory:');
    for (let i = 0; i < 5; i++) insertMemory(db, { board_id: 'b', text: `report number ${i}` });
    expect(searchMemory(db, 'b', 'report* (', 2)).toHaveLength(2);
  });

  it('returns [] for an empty/operator-only query', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'b', text: 'anything' });
    expect(searchMemory(db, 'b', '  *(  ', 5)).toEqual([]);
  });
});

describe('durability + integrity (file-backed)', () => {
  it('persists across close + reopen on a real file; reopening an existing db re-runs DDL harmlessly', () => {
    const file = path.join(os.tmpdir(), `mem-durable-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    try {
      const first = openMemoryDb(file);
      insertMemory(first, { board_id: 'b1', text: 'the deploy window is Tuesday', kind: 'fact' });
      first.close();

      const reopened = openMemoryDb(file); // CREATE ... IF NOT EXISTS runs again on a populated db
      const hits = searchMemory(reopened, 'b1', 'deploy', 5);
      expect(hits).toHaveLength(1);
      expect(hits[0].text).toBe('the deploy window is Tuesday');
      reopened.close();
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-journal`, { force: true });
    }
  });

  it('rejects a duplicate id atomically — no orphaned FTS row from the failed insert', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'b1', text: 'first note', id: 'mem-dup' });
    expect(() => insertMemory(db, { board_id: 'b1', text: 'second note', id: 'mem-dup' })).toThrow();
    // The failed insert must not have written a half-row into the FTS index.
    expect(searchMemory(db, 'b1', 'second', 5)).toHaveLength(0);
    expect(searchMemory(db, 'b1', 'first', 5)).toHaveLength(1);
  });
});
