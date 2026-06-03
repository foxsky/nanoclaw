import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { EmbeddingService } from './embedding-service.js';
import { buildSourceText, startTaskflowEmbeddingSync } from './taskflow-embedding-sync.js';

const DIR = path.join(import.meta.dirname, '..', 'test-tf-embed-sync');
const EMB = path.join(DIR, 'embeddings.db');

function makeTaskflowDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE tasks (board_id TEXT, id TEXT, title TEXT, description TEXT, next_action TEXT, assignee TEXT, column TEXT)`,
  );
  return db;
}

afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe('buildSourceText', () => {
  it('joins title + description + next_action, trimmed', () => {
    expect(
      buildSourceText({ title: 'Ship the feeder', description: 'port it', next_action: 'write tests' }),
    ).toBe('Ship the feeder port it write tests');
  });

  it('tolerates null description / next_action', () => {
    expect(buildSourceText({ title: 'Solo', description: null, next_action: null })).toBe('Solo');
  });
});

describe('startTaskflowEmbeddingSync', () => {
  it('returns null (disabled) when tfDb is null', () => {
    const svc = new EmbeddingService(EMB, 'http://localhost:11434', 'm');
    const timer = startTaskflowEmbeddingSync(svc, null);
    expect(timer).toBeNull();
    svc.close();
  });

  it('indexes active (non-done) tasks into tasks:<board> and prunes stale embeddings', () => {
    const svc = new EmbeddingService(EMB, 'http://localhost:11434', 'm');
    // Pre-seed a STALE embedding the first sync must prune (no longer an active task).
    svc.index('tasks:board-1', 'T-OLD', 'gone');

    const tfDb = makeTaskflowDb();
    const ins = tfDb.prepare(
      `INSERT INTO tasks (board_id,id,title,description,next_action,assignee,column) VALUES (?,?,?,?,?,?,?)`,
    );
    ins.run('board-1', 'T1', 'Active task', 'desc', 'na', 'alice', 'next_action');
    ins.run('board-1', 'T2', 'Done task', null, null, 'bob', 'done'); // excluded (done)

    const timer = startTaskflowEmbeddingSync(svc, tfDb);
    if (timer) clearInterval(timer); // first sync ran synchronously before return

    // Active T1 indexed; done T2 not indexed; stale T-OLD pruned.
    expect(svc.getItemIds('tasks:board-1')).toEqual(['T1']);
    const row = svc.db
      .prepare('SELECT source_text FROM embeddings WHERE collection = ? AND item_id = ?')
      .get('tasks:board-1', 'T1') as { source_text: string };
    expect(row.source_text).toBe('Active task desc na');

    svc.close();
    tfDb.close();
  });
});
