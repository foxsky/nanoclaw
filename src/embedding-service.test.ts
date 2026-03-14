import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { EmbeddingService } from './embedding-service.js';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', 'test-embeddings');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'embeddings.db');

afterEach(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('EmbeddingService', () => {
  /* --- Schema --- */

  it('creates schema on instantiation', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    const tables = svc.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
      .all();
    expect(tables).toHaveLength(1);
    svc.close();
  });

  /* --- index() --- */

  it('index() inserts new item with vector = NULL', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    svc.index('tasks:board-1', 'T1', 'Fix the login bug');
    const row = svc.db
      .prepare('SELECT * FROM embeddings WHERE collection = ? AND item_id = ?')
      .get('tasks:board-1', 'T1') as any;
    expect(row).toBeDefined();
    expect(row.source_text).toBe('Fix the login bug');
    expect(row.model).toBe('test-model');
    expect(row.vector).toBeNull();
    svc.close();
  });

  it('index() skips write when source_text and model unchanged', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    svc.index('tasks:board-1', 'T1', 'Fix the login bug');
    // Simulate indexer setting the vector
    svc.db
      .prepare('UPDATE embeddings SET vector = ? WHERE collection = ? AND item_id = ?')
      .run(Buffer.from(new Float32Array([1, 2, 3]).buffer), 'tasks:board-1', 'T1');
    // Re-index with same text — should NOT null the vector
    svc.index('tasks:board-1', 'T1', 'Fix the login bug');
    const row = svc.db
      .prepare('SELECT vector FROM embeddings WHERE collection = ? AND item_id = ?')
      .get('tasks:board-1', 'T1') as any;
    expect(row.vector).not.toBeNull();
    svc.close();
  });

  it('index() nulls vector when source_text changes', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    svc.index('tasks:board-1', 'T1', 'Fix the login bug');
    svc.db
      .prepare('UPDATE embeddings SET vector = ? WHERE collection = ? AND item_id = ?')
      .run(Buffer.from(new Float32Array([1, 2, 3]).buffer), 'tasks:board-1', 'T1');
    // Re-index with DIFFERENT text
    svc.index('tasks:board-1', 'T1', 'Fix the signup bug');
    const row = svc.db
      .prepare('SELECT vector, source_text FROM embeddings WHERE collection = ? AND item_id = ?')
      .get('tasks:board-1', 'T1') as any;
    expect(row.vector).toBeNull();
    expect(row.source_text).toBe('Fix the signup bug');
    svc.close();
  });

  /* --- remove / getCollections / getItemIds --- */

  it('remove() deletes an embedding', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    svc.index('tasks:board-1', 'T1', 'Fix bug');
    svc.remove('tasks:board-1', 'T1');
    const row = svc.db
      .prepare('SELECT * FROM embeddings WHERE collection = ? AND item_id = ?')
      .get('tasks:board-1', 'T1');
    expect(row).toBeUndefined();
    svc.close();
  });

  it('getCollections() returns distinct collection names', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    svc.index('tasks:board-1', 'T1', 'A');
    svc.index('tasks:board-2', 'T1', 'B');
    svc.index('messages:group-1', 'M1', 'C');
    expect(svc.getCollections()).toEqual([
      'messages:group-1',
      'tasks:board-1',
      'tasks:board-2',
    ]);
    expect(svc.getCollections('tasks:')).toEqual(['tasks:board-1', 'tasks:board-2']);
    svc.close();
  });

  it('getItemIds() returns item IDs in a collection', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    svc.index('tasks:board-1', 'T1', 'A');
    svc.index('tasks:board-1', 'T2', 'B');
    expect(svc.getItemIds('tasks:board-1')).toEqual(['T1', 'T2']);
    svc.close();
  });

  /* --- Indexer --- */

  it('indexer processes pending items via Ollama', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });
    global.fetch = mockFetch as any;

    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    svc.index('tasks:board-1', 'T1', 'Fix the login bug');

    await svc.runIndexerCycle();

    const row = svc.db
      .prepare('SELECT vector, model FROM embeddings WHERE collection = ? AND item_id = ?')
      .get('tasks:board-1', 'T1') as any;
    expect(row.vector).not.toBeNull();
    expect(row.model).toBe('test-model');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"model":"test-model"'),
      }),
    );

    svc.close();
  });

  it('model change marks all items for re-embedding', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });
    global.fetch = mockFetch as any;

    // Index with model-A
    const svc1 = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'model-A');
    svc1.index('c', 'T1', 'text');
    await svc1.runIndexerCycle();
    svc1.close();

    // Re-open with model-B
    const svc2 = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'model-B');
    await svc2.runIndexerCycle();

    const row = svc2.db
      .prepare('SELECT model FROM embeddings WHERE item_id = ?')
      .get('T1') as any;
    expect(row.model).toBe('model-B');
    svc2.close();
  });

  it('indexer processes all items without starvation', async () => {
    let batchSize = 0;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      batchSize = body.input.length;
      return {
        ok: true,
        json: async () => ({
          embeddings: Array.from({ length: batchSize }, () => [0.1, 0.2, 0.3]),
        }),
      };
    });
    global.fetch = mockFetch as any;

    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    for (let i = 0; i < 50; i++) {
      svc.index('c', `T${i}`, `text ${i}`);
    }

    // Run enough cycles to process all 50 (20 per cycle)
    for (let cycle = 0; cycle < 4; cycle++) {
      await svc.runIndexerCycle();
    }

    const remaining = svc.db
      .prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE vector IS NULL')
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(0);
    svc.close();
  });

  /* --- close() safety --- */

  it('close() is safe to call multiple times', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    svc.close();
    expect(() => svc.close()).not.toThrow();
  });
});
