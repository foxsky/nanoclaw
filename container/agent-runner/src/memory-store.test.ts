import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { Database } from 'bun:sqlite';

import {
  blobToVector,
  cosineSimilarity,
  fuseByRrf,
  hybridSearchMemory,
  insertMemory,
  openMemoryDb,
  pruneMemories,
  recentMemories,
  sanitizeFtsQuery,
  searchMemory,
  vectorToBlob,
} from './memory-store.js';

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

describe('fuseByRrf (hybrid FTS5 + vector rank fusion)', () => {
  // RRF fuses on RANK, not raw score, so FTS5 bm25 and cosine never need to be on the
  // same scale — that scale-independence is the whole reason to use it here.
  it('ranks an item present in BOTH lists above one that tops a single list', () => {
    // x is rank-1 in the keyword list only; y is rank-2 keyword AND rank-1 vector.
    // Cross-list agreement must win — that is the point of hybrid fusion.
    const fused = fuseByRrf([['x', 'y'], ['y']]);
    expect(fused[0].id).toBe('y');
    expect(fused.map((r) => r.id)).toContain('x');
  });

  it('orders by summed reciprocal rank across lists', () => {
    const fused = fuseByRrf([
      ['a', 'b', 'c'],
      ['a', 'b', 'd'],
    ]);
    const ids = fused.map((r) => r.id);
    expect(ids[0]).toBe('a'); // rank-1 in both
    expect(ids[1]).toBe('b'); // rank-2 in both
    expect(ids.slice(2).sort()).toEqual(['c', 'd']); // each in one list only
  });

  it('caps results to limit', () => {
    expect(fuseByRrf([['a', 'b', 'c', 'd']], { limit: 2 })).toHaveLength(2);
  });

  it('returns [] for no lists / all-empty lists', () => {
    expect(fuseByRrf([])).toEqual([]);
    expect(fuseByRrf([[], []])).toEqual([]);
  });

  it('degrades to the single provided list order (FTS5-only fallback when no vectors)', () => {
    expect(fuseByRrf([['a', 'b', 'c']]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('vector storage (hybrid embeddings)', () => {
  it('cosineSimilarity: identical=1, orthogonal=0, dim-mismatch guarded to 0', () => {
    const a = Float32Array.from([1, 0, 0]);
    expect(cosineSimilarity(a, Float32Array.from([1, 0, 0]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0, 6);
    // A stored vector from a different model (wrong dim) must score 0, not silently truncate.
    expect(cosineSimilarity(a, Float32Array.from([1, 0]))).toBe(0);
  });

  it('vectorToBlob/blobToVector round-trips a vector through the BLOB column', () => {
    const v = Float32Array.from([0.5, -0.25, 0.125, 1]);
    expect(Array.from(blobToVector(vectorToBlob(v)))).toEqual(Array.from(v));
  });

  it('insertMemory persists a provided vector (read back via blobToVector)', () => {
    db = openMemoryDb(':memory:');
    const id = insertMemory(db, { board_id: 'b1', text: 'deploy tuesday', vector: Float32Array.from([0.1, 0.2, 0.3]) });
    const row = db.query('SELECT vector FROM memories WHERE id = $id').get({ $id: id }) as { vector: Uint8Array };
    const v = blobToVector(row.vector);
    expect(v.length).toBe(3);
    expect(v[0]).toBeCloseTo(0.1, 5);
  });

  it('insertMemory stores NULL vector when none is provided (FTS5-only memory stays valid)', () => {
    db = openMemoryDb(':memory:');
    const id = insertMemory(db, { board_id: 'b1', text: 'no vector here' });
    const row = db.query('SELECT vector FROM memories WHERE id = $id').get({ $id: id }) as {
      vector: Uint8Array | null;
    };
    expect(row.vector).toBeNull();
    // and it is still searchable via FTS5
    expect(searchMemory(db, 'b1', 'vector', 5)).toHaveLength(1);
  });

  it('openMemoryDb migrates a legacy (vector-less) memories table by adding the column', () => {
    const file = path.join(os.tmpdir(), `mem-mig-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    try {
      const legacy = new Database(file);
      legacy.exec(`
        CREATE TABLE memories (
          rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'note', text TEXT NOT NULL, source_session TEXT,
          source_ts TEXT, created_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE memories_fts USING fts5(text);
      `);
      legacy
        .query(
          `INSERT INTO memories (id, board_id, kind, text, created_at) VALUES ('m1','b1','note','legacy row','2026-01-01')`,
        )
        .run();
      legacy.query(`INSERT INTO memories_fts (rowid, text) VALUES (1, 'legacy row')`).run();
      legacy.close();

      const migrated = openMemoryDb(file);
      const cols = (migrated.query('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('vector');
      // the pre-existing row survives the migration and stays searchable
      expect(searchMemory(migrated, 'b1', 'legacy', 5)).toHaveLength(1);
      migrated.close();
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-journal`, { force: true });
    }
  });
});

describe('hybridSearchMemory (FTS5 + vector fusion)', () => {
  it('with no queryVector, is exactly FTS5 searchMemory (safe drop-in fallback)', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'b1', text: 'the deploy window is Tuesday', vector: Float32Array.from([1, 0, 0]) });
    insertMemory(db, { board_id: 'b1', text: 'unrelated grocery list', vector: Float32Array.from([0, 1, 0]) });
    const hy = hybridSearchMemory(db, 'b1', 'deploy', null, 5).map((r) => r.text);
    const fts = searchMemory(db, 'b1', 'deploy', 5).map((r) => r.text);
    expect(hy).toEqual(fts);
  });

  it('recalls a paraphrase that shares NO keywords (vector-only hit FTS5 misses)', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'b1', text: 'Bruno leads the mobile app team', vector: Float32Array.from([1, 0, 0]) });
    insertMemory(db, { board_id: 'b1', text: 'grocery list for the weekend', vector: Float32Array.from([0, 1, 0]) });
    // Zero token overlap → FTS5 finds nothing; the query vector is near Bruno's, so hybrid recalls it.
    expect(searchMemory(db, 'b1', 'handset division lead', 5)).toHaveLength(0);
    const hits = hybridSearchMemory(db, 'b1', 'handset division lead', Float32Array.from([0.98, 0.02, 0]), 5);
    expect(hits.map((h) => h.text)).toContain('Bruno leads the mobile app team');
  });

  it('ranks a both-keyword-AND-vector match above a keyword-only match', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'b1', text: 'deploy schedule alpha', vector: Float32Array.from([1, 0, 0]) });
    insertMemory(db, { board_id: 'b1', text: 'deploy schedule beta', vector: Float32Array.from([0, 1, 0]) });
    const hits = hybridSearchMemory(db, 'b1', 'deploy schedule', Float32Array.from([1, 0, 0]), 5);
    expect(hits[0].text).toBe('deploy schedule alpha'); // also matches the vector → fused to the top
  });

  it('stays board-scoped under hybrid recall', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'a', text: 'alpha secret', vector: Float32Array.from([1, 0, 0]) });
    insertMemory(db, { board_id: 'b', text: 'beta secret', vector: Float32Array.from([1, 0, 0]) });
    const hits = hybridSearchMemory(db, 'a', 'secret', Float32Array.from([1, 0, 0]), 5);
    expect(hits.map((h) => h.text)).toEqual(['alpha secret']);
  });
});

describe('recentMemories (once-per-session auto-recall source)', () => {
  it('returns the newest memories first, board-scoped, capped at limit', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'b1', text: 'oldest fact' });
    insertMemory(db, { board_id: 'b1', text: 'middle fact' });
    insertMemory(db, { board_id: 'b1', text: 'newest fact' });
    insertMemory(db, { board_id: 'other', text: 'other board fact' });
    const recent = recentMemories(db, 'b1', 2).map((m) => m.text);
    expect(recent).toEqual(['newest fact', 'middle fact']); // rowid-desc tiebreak on equal created_at
    expect(recentMemories(db, 'b1', 10).map((m) => m.text)).not.toContain('other board fact');
  });

  it('returns [] for a board with no memories', () => {
    db = openMemoryDb(':memory:');
    expect(recentMemories(db, 'empty', 10)).toEqual([]);
  });
});

describe('pruneMemories (P4 forgetting — opt-in, board-scoped, FTS-consistent)', () => {
  it('no policy → no-op (returns 0, deletes nothing)', () => {
    db = openMemoryDb(':memory:');
    insertMemory(db, { board_id: 'b1', text: 'keep me' });
    expect(pruneMemories(db, 'b1', {})).toBe(0);
    expect(searchMemory(db, 'b1', 'keep', 5)).toHaveLength(1);
  });

  it('age cap deletes rows older than maxAgeDays, keeps recent ones, and keeps FTS in sync', () => {
    db = openMemoryDb(':memory:');
    const oldId = insertMemory(db, { board_id: 'b1', text: 'ancient decision' });
    insertMemory(db, { board_id: 'b1', text: 'fresh decision' });
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    db.query('UPDATE memories SET created_at = $c WHERE id = $id').run({ $c: old, $id: oldId });
    expect(pruneMemories(db, 'b1', { maxAgeDays: 90, nowMs: Date.now() })).toBe(1);
    // gone from BOTH base and FTS — no orphan row, no error
    expect(searchMemory(db, 'b1', 'ancient', 5)).toHaveLength(0);
    expect(searchMemory(db, 'b1', 'fresh', 5)).toHaveLength(1);
  });

  it('budget cap keeps only the N most-recent and deletes the older excess', () => {
    db = openMemoryDb(':memory:');
    for (let i = 0; i < 5; i++) insertMemory(db, { board_id: 'b1', text: `memory number ${i}` });
    expect(pruneMemories(db, 'b1', { keepTopN: 3 })).toBe(2);
    const remaining = recentMemories(db, 'b1', 10).map((m) => m.text);
    expect(remaining).toHaveLength(3);
    expect(remaining).toContain('memory number 4'); // newest kept
    expect(remaining).not.toContain('memory number 0'); // oldest pruned
  });

  it('is board-scoped — pruning one board never touches another', () => {
    db = openMemoryDb(':memory:');
    for (let i = 0; i < 5; i++) insertMemory(db, { board_id: 'a', text: `a fact ${i}` });
    insertMemory(db, { board_id: 'b', text: 'b fact' });
    pruneMemories(db, 'a', { keepTopN: 2 });
    expect(searchMemory(db, 'b', 'fact', 10)).toHaveLength(1);
    expect(recentMemories(db, 'a', 10)).toHaveLength(2);
  });

  it('creates the (board_id, created_at) recency index for indexed prune/recall sorts', () => {
    db = openMemoryDb(':memory:');
    const idx = (db.query('PRAGMA index_list(memories)').all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain('idx_memories_board_created');
  });

  it('leaves no orphan FTS rows — a later insert + search stays consistent', () => {
    db = openMemoryDb(':memory:');
    for (let i = 0; i < 4; i++) insertMemory(db, { board_id: 'b1', text: `report ${i}` });
    pruneMemories(db, 'b1', { keepTopN: 1 });
    insertMemory(db, { board_id: 'b1', text: 'report new' });
    expect(searchMemory(db, 'b1', 'report', 10).map((m) => m.text)).toContain('report new');
  });

  it('rolls back atomically when the base delete fails — no partial FTS loss', () => {
    db = openMemoryDb(':memory:');
    for (let i = 0; i < 4; i++) insertMemory(db, { board_id: 'b1', text: `report ${i}` });
    // FTS delete runs first; force the *base* delete to abort mid-transaction. The whole
    // transaction must roll back, restoring the already-deleted FTS rows (no orphan/half-loss).
    db.exec(`CREATE TRIGGER block_del BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    expect(() => pruneMemories(db, 'b1', { keepTopN: 1 })).toThrow();
    db.exec('DROP TRIGGER block_del');
    expect(searchMemory(db, 'b1', 'report', 10)).toHaveLength(4);
  });
});
