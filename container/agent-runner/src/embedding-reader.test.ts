import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { EmbeddingReader, cosineSimilarity } from './embedding-reader.js';

const TEST_DIR = path.join(import.meta.dirname, '..', 'test-embeddings');
const TEST_DB = path.join(TEST_DIR, 'embeddings.db');

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function seedDb(): Database.Database {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(TEST_DB);
  db.exec(`CREATE TABLE embeddings (
    collection TEXT NOT NULL, item_id TEXT NOT NULL,
    vector BLOB, source_text TEXT NOT NULL, model TEXT NOT NULL,
    metadata TEXT DEFAULT '{}', updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, item_id)
  )`);
  return db;
}

describe('EmbeddingReader', () => {
  it('returns empty results for non-existent DB', () => {
    const reader = new EmbeddingReader('/tmp/does-not-exist/embeddings.db');
    expect(reader.search('c', new Float32Array([1, 0, 0]))).toEqual([]);
    expect(reader.findSimilar('c', new Float32Array([1, 0, 0]))).toBeNull();
    reader.close();
  });

  it('search returns ranked results above threshold', () => {
    const db = seedDb();
    const v1 = Buffer.from(new Float32Array([1, 0, 0]).buffer);
    const v2 = Buffer.from(new Float32Array([0.9, 0.1, 0]).buffer);
    const v3 = Buffer.from(new Float32Array([0, 0, 1]).buffer); // orthogonal
    db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?)').run(
      'c', 'A', v1, 'a', 'm', '{}', '',
    );
    db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?)').run(
      'c', 'B', v2, 'b', 'm', '{}', '',
    );
    db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?)').run(
      'c', 'C', v3, 'c', 'm', '{}', '',
    );
    db.close();

    const reader = new EmbeddingReader(TEST_DB);
    const results = reader.search('c', new Float32Array([1, 0, 0]), {
      threshold: 0.5,
    });
    expect(results.length).toBe(2); // A and B, not C
    expect(results[0].itemId).toBe('A'); // highest score
    reader.close();
  });

  it('findSimilar returns best match or null', () => {
    const db = seedDb();
    db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?)').run(
      'c', 'A',
      Buffer.from(new Float32Array([1, 0, 0]).buffer),
      'a', 'm', '{"title":"test"}', '',
    );
    db.close();

    const reader = new EmbeddingReader(TEST_DB);
    const match = reader.findSimilar('c', new Float32Array([1, 0, 0]), 0.9);
    expect(match).not.toBeNull();
    expect(match!.itemId).toBe('A');
    expect(match!.metadata.title).toBe('test');

    const noMatch = reader.findSimilar('c', new Float32Array([0, 0, 1]), 0.9);
    expect(noMatch).toBeNull();
    reader.close();
  });

  it('ignores rows with NULL vector', () => {
    const db = seedDb();
    db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?)').run(
      'c', 'A', null, 'a', 'm', '{}', '',
    );
    db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?)').run(
      'c', 'B',
      Buffer.from(new Float32Array([1, 0, 0]).buffer),
      'b', 'm', '{}', '',
    );
    db.close();

    const reader = new EmbeddingReader(TEST_DB);
    const results = reader.search('c', new Float32Array([1, 0, 0]), {
      threshold: 0.0,
    });
    expect(results.length).toBe(1);
    expect(results[0].itemId).toBe('B');
    reader.close();
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(
      cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3])),
    ).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(
      cosineSimilarity(new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0])),
    ).toBeCloseTo(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(
      cosineSimilarity(new Float32Array([0, 0, 0]), new Float32Array([1, 2, 3])),
    ).toBe(0);
  });
});
