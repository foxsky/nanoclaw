import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { cosineSimilarity, EmbeddingReader } from './embedding-reader.ts';

function f32ToBlob(v: number[]): Uint8Array {
  const arr = new Float32Array(v);
  return new Uint8Array(arr.buffer.slice(0));
}

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function seedDb(
  rows: Array<{ collection: string; itemId: string; vector: number[] | null; meta?: Record<string, unknown> }>,
): string {
  dir = mkdtempSync(join(tmpdir(), 'emb-reader-'));
  const path = join(dir, 'embeddings.db');
  const db = new Database(path);
  db.exec(
    `CREATE TABLE embeddings (collection TEXT, item_id TEXT, vector BLOB, source_text TEXT, model TEXT, metadata TEXT, updated_at TEXT, PRIMARY KEY(collection,item_id))`,
  );
  const ins = db.prepare(
    `INSERT INTO embeddings (collection,item_id,vector,source_text,model,metadata,updated_at) VALUES ($c,$i,$v,'txt','m',$m,'now')`,
  );
  for (const r of rows) {
    ins.run({ $c: r.collection, $i: r.itemId, $v: r.vector ? f32ToBlob(r.vector) : null, $m: JSON.stringify(r.meta ?? {}) });
  }
  db.close();
  return path;
}

describe('cosineSimilarity', () => {
  it('1 for identical, 0 for orthogonal, 0 for length mismatch (dim guard)', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosineSimilarity(new Float32Array([1, 0, 0]), new Float32Array([1, 0]))).toBe(0);
  });
});

describe('EmbeddingReader', () => {
  it('returns [] when the db file does not exist (graceful no-op)', () => {
    const r = new EmbeddingReader('/nonexistent/embeddings.db');
    expect(r.search('tasks:b1', new Float32Array([1, 0]))).toEqual([]);
    r.close();
  });

  it('ranks by cosine, filters by threshold, skips null vectors + other collections', () => {
    const path = seedDb([
      { collection: 'tasks:b1', itemId: 'T1', vector: [1, 0, 0], meta: { title: 'A' } },
      { collection: 'tasks:b1', itemId: 'T2', vector: [0, 1, 0] }, // orthogonal → below threshold
      { collection: 'tasks:b1', itemId: 'T3', vector: null }, // pending (no vector) → skipped
      { collection: 'tasks:b2', itemId: 'X1', vector: [1, 0, 0] }, // other collection → excluded
    ]);
    const r = new EmbeddingReader(path);
    const res = r.search('tasks:b1', new Float32Array([1, 0, 0]), { threshold: 0.3 });
    expect(res.map((x) => x.itemId)).toEqual(['T1']);
    expect(res[0].score).toBeCloseTo(1);
    expect(res[0].metadata.title).toBe('A');
    r.close();
  });

  it('findSimilar returns the top match above threshold, else null', () => {
    const path = seedDb([{ collection: 'tasks:b1', itemId: 'T1', vector: [1, 0, 0] }]);
    const r = new EmbeddingReader(path);
    expect(r.findSimilar('tasks:b1', new Float32Array([1, 0, 0]), 0.85)?.itemId).toBe('T1');
    expect(r.findSimilar('tasks:b1', new Float32Array([0, 1, 0]), 0.85)).toBeNull();
    r.close();
  });
});
