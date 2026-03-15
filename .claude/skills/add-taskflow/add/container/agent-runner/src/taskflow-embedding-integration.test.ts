import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { EmbeddingReader } from './embedding-reader.js';

const TEST_DIR = path.join(import.meta.dirname, '..', 'test-taskflow-embed');
const EMBED_DB = path.join(TEST_DIR, 'embeddings.db');
const TF_DB = path.join(TEST_DIR, 'taskflow.db');

function createEmbeddingsDb(): Database.Database {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(EMBED_DB);
  db.exec(`CREATE TABLE embeddings (
    collection TEXT NOT NULL, item_id TEXT NOT NULL,
    vector BLOB, source_text TEXT NOT NULL, model TEXT NOT NULL,
    metadata TEXT DEFAULT '{}', updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, item_id)
  )`);
  return db;
}

function insertEmbedding(
  db: Database.Database,
  collection: string,
  itemId: string,
  vector: number[],
  metadata: Record<string, any> = {},
): void {
  db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?)').run(
    collection,
    itemId,
    Buffer.from(new Float32Array(vector).buffer),
    `source for ${itemId}`,
    'bge-m3',
    JSON.stringify(metadata),
    new Date().toISOString(),
  );
}

function createTaskflowDb(): Database.Database {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(TF_DB);
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT,
      board_role TEXT DEFAULT 'root', hierarchy_level INTEGER DEFAULT 0,
      max_depth INTEGER DEFAULT 2, parent_board_id TEXT, short_code TEXT
    );
    CREATE TABLE board_people (
      board_id TEXT, person_id TEXT, name TEXT, phone TEXT,
      role TEXT, wip_limit INTEGER DEFAULT 3, notification_group_jid TEXT,
      PRIMARY KEY (board_id, person_id)
    );
    CREATE TABLE board_config (
      board_id TEXT PRIMARY KEY, wip_limit INTEGER DEFAULT 3
    );
    CREATE TABLE board_runtime_config (
      board_id TEXT PRIMARY KEY, language TEXT DEFAULT 'pt-BR',
      timezone TEXT DEFAULT 'America/Fortaleza',
      standup_cron_local TEXT, digest_cron_local TEXT, review_cron_local TEXT,
      standup_cron_utc TEXT, digest_cron_utc TEXT, review_cron_utc TEXT,
      attachment_enabled INTEGER DEFAULT 0, attachment_disabled_reason TEXT,
      dst_sync_enabled INTEGER DEFAULT 0, welcome_sent INTEGER DEFAULT 0
    );
    CREATE TABLE board_admins (
      board_id TEXT, person_id TEXT, phone TEXT,
      admin_role TEXT DEFAULT 'manager', is_primary_manager INTEGER DEFAULT 0,
      PRIMARY KEY (board_id, person_id)
    );
    CREATE TABLE board_holidays (
      board_id TEXT, holiday_date TEXT, label TEXT,
      PRIMARY KEY (board_id, holiday_date)
    );
    CREATE TABLE tasks (
      id TEXT NOT NULL, board_id TEXT NOT NULL,
      type TEXT DEFAULT 'simple', title TEXT NOT NULL,
      assignee TEXT, next_action TEXT, waiting_for TEXT,
      column TEXT DEFAULT 'inbox', priority TEXT,
      requires_close_approval INTEGER DEFAULT 1,
      due_date TEXT, description TEXT,
      labels TEXT DEFAULT '[]', blocked_by TEXT DEFAULT '[]',
      reminders TEXT DEFAULT '[]', next_note_id INTEGER DEFAULT 1,
      notes TEXT DEFAULT '[]', _last_mutation TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      parent_task_id TEXT, recurrence TEXT,
      scheduled_at TEXT, participants TEXT DEFAULT '[]',
      child_exec_enabled INTEGER DEFAULT 0,
      child_exec_board_id TEXT, child_exec_person_id TEXT,
      child_exec_rollup_status TEXT, child_exec_last_rollup_at TEXT,
      child_exec_last_rollup_summary TEXT,
      recurrence_anchor TEXT, max_cycles INTEGER,
      recurrence_end_date TEXT, current_cycle INTEGER DEFAULT 1,
      linked_parent_board_id TEXT, linked_parent_task_id TEXT,
      subtasks TEXT,
      PRIMARY KEY (board_id, id)
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT, task_id TEXT, action TEXT,
      by TEXT, at TEXT, details TEXT
    );
    CREATE TABLE archive (
      board_id TEXT, task_id TEXT, title TEXT, assignee TEXT,
      archived_at TEXT, archive_reason TEXT, task_snapshot TEXT,
      PRIMARY KEY (board_id, task_id)
    );
    CREATE TABLE board_id_counters (
      board_id TEXT NOT NULL, prefix TEXT NOT NULL, next_number INTEGER DEFAULT 1,
      PRIMARY KEY (board_id, prefix)
    );
    CREATE TABLE child_board_registrations (
      parent_board_id TEXT, person_id TEXT, child_board_id TEXT,
      PRIMARY KEY (parent_board_id, person_id)
    );
    CREATE TABLE external_contacts (
      external_id TEXT PRIMARY KEY, display_name TEXT, phone TEXT,
      direct_chat_jid TEXT, status TEXT DEFAULT 'active',
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE meeting_external_participants (
      board_id TEXT, meeting_task_id TEXT, occurrence_scheduled_at TEXT,
      external_id TEXT, invite_status TEXT, invited_at TEXT,
      accepted_at TEXT, revoked_at TEXT, access_expires_at TEXT,
      created_by TEXT, created_at TEXT, updated_at TEXT,
      PRIMARY KEY (board_id, meeting_task_id, occurrence_scheduled_at, external_id)
    );
  `);

  // Seed a board with people and tasks
  const now = new Date().toISOString();
  db.prepare('INSERT INTO boards VALUES (?,?,?,?,?,?,?,?)').run(
    'board-test', 'test@g.us', 'test', 'root', 0, 2, null, 'TST',
  );
  db.prepare('INSERT INTO board_config VALUES (?,?)').run('board-test', 3);
  db.prepare(
    'INSERT INTO board_runtime_config (board_id, language, timezone) VALUES (?,?,?)',
  ).run('board-test', 'pt-BR', 'America/Fortaleza');
  db.prepare('INSERT INTO board_admins VALUES (?,?,?,?,?)').run(
    'board-test', 'alice', '5511999', 'manager', 1,
  );
  db.prepare('INSERT INTO board_people VALUES (?,?,?,?,?,?,?)').run(
    'board-test', 'alice', 'Alice', '5511999', 'manager', 3, null,
  );
  db.prepare(
    `INSERT INTO tasks (board_id, id, title, column, assignee, description, next_action, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run('board-test', 'T1', 'Migração da nuvem', 'in_progress', 'alice', 'Migrar servidores para AWS', 'Verificar backup', now, now);
  db.prepare(
    `INSERT INTO tasks (board_id, id, title, column, assignee, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('board-test', 'T2', 'Comprar monitor novo', 'next_action', 'alice', now, now);
  db.prepare(
    `INSERT INTO tasks (board_id, id, title, column, assignee, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('board-test', 'T3', 'Configurar firewall', 'inbox', null, now, now);

  return db;
}

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Semantic search ranking', () => {
  it('merges lexical + semantic results with boost', async () => {
    const embedDb = createEmbeddingsDb();
    const tfDb = createTaskflowDb();

    // T1 vector is close to query vector, T2 is far, T3 is medium
    insertEmbedding(embedDb, 'tasks:board-test', 'T1', [0.9, 0.1, 0], { title: 'Migração da nuvem' });
    insertEmbedding(embedDb, 'tasks:board-test', 'T2', [0.1, 0.9, 0], { title: 'Comprar monitor novo' });
    insertEmbedding(embedDb, 'tasks:board-test', 'T3', [0.7, 0.3, 0], { title: 'Configurar firewall' });
    embedDb.close();

    const { TaskflowEngine } = await import('./taskflow-engine.js');
    const engine = new TaskflowEngine(tfDb, 'board-test');
    const reader = new EmbeddingReader(EMBED_DB);

    // Query vector close to T1
    const queryVector = new Float32Array([1, 0, 0]);

    const result = engine.query({
      query: 'search',
      search_text: 'nuvem',
      query_vector: queryVector,
      embedding_reader: reader,
    });

    expect(result.success).toBe(true);
    const ids = result.data.map((t: any) => t.id);
    // T1 should be first (semantic match + lexical match on "nuvem")
    expect(ids[0]).toBe('T1');
    // T3 should appear (semantic match, no lexical)
    expect(ids).toContain('T3');

    reader.close();
    tfDb.close();
  });

  it('falls back to lexical when no query_vector', async () => {
    createEmbeddingsDb().close(); // empty embeddings
    const tfDb = createTaskflowDb();

    const { TaskflowEngine } = await import('./taskflow-engine.js');
    const engine = new TaskflowEngine(tfDb, 'board-test');

    const result = engine.query({
      query: 'search',
      search_text: 'monitor',
    });

    expect(result.success).toBe(true);
    expect(result.data.length).toBe(1);
    expect(result.data[0].id).toBe('T2');
    tfDb.close();
  });
});

describe('Duplicate detection', () => {
  it('findSimilar returns match above threshold', () => {
    const embedDb = createEmbeddingsDb();
    insertEmbedding(embedDb, 'tasks:board-test', 'T1', [1, 0, 0], { title: 'Migração da nuvem' });
    embedDb.close();

    const reader = new EmbeddingReader(EMBED_DB);
    // Very similar vector
    const similar = reader.findSimilar(
      'tasks:board-test',
      new Float32Array([0.99, 0.01, 0]),
      0.85,
    );
    expect(similar).not.toBeNull();
    expect(similar!.itemId).toBe('T1');
    expect(similar!.score).toBeGreaterThan(0.85);
    expect(similar!.metadata.title).toBe('Migração da nuvem');
    reader.close();
  });

  it('findSimilar returns null below threshold', () => {
    const embedDb = createEmbeddingsDb();
    insertEmbedding(embedDb, 'tasks:board-test', 'T1', [1, 0, 0], { title: 'Migração da nuvem' });
    embedDb.close();

    const reader = new EmbeddingReader(EMBED_DB);
    // Orthogonal vector
    const similar = reader.findSimilar(
      'tasks:board-test',
      new Float32Array([0, 1, 0]),
      0.85,
    );
    expect(similar).toBeNull();
    reader.close();
  });

  it('returns empty when Ollama unreachable (graceful fallback)', () => {
    // No embeddings DB at all
    const reader = new EmbeddingReader('/tmp/nonexistent/embeddings.db');
    const similar = reader.findSimilar(
      'tasks:board-test',
      new Float32Array([1, 0, 0]),
      0.85,
    );
    expect(similar).toBeNull();
    reader.close();
  });
});

describe('buildContextSummary', () => {
  it('returns preamble with ranked tasks and column counts', async () => {
    const embedDb = createEmbeddingsDb();
    const tfDb = createTaskflowDb();

    insertEmbedding(embedDb, 'tasks:board-test', 'T1', [0.9, 0.1, 0], { title: 'Migração da nuvem' });
    insertEmbedding(embedDb, 'tasks:board-test', 'T2', [0.1, 0.9, 0], { title: 'Comprar monitor novo' });
    insertEmbedding(embedDb, 'tasks:board-test', 'T3', [0.5, 0.5, 0], { title: 'Configurar firewall' });
    embedDb.close();

    const { TaskflowEngine } = await import('./taskflow-engine.js');
    const engine = new TaskflowEngine(tfDb, 'board-test');
    const reader = new EmbeddingReader(EMBED_DB);

    const queryVector = new Float32Array([1, 0, 0]);
    const preamble = engine.buildContextSummary(queryVector, reader);

    expect(preamble).not.toBeNull();
    // Should contain board context with column counts
    expect(preamble).toContain('Board context:');
    expect(preamble).toContain('in_progress');
    // Should contain ranked task details
    expect(preamble).toContain('T1');
    expect(preamble).toContain('Migração da nuvem');
    // Should contain "Other tasks" for non-ranked items
    expect(preamble).toContain('Other tasks');

    reader.close();
    tfDb.close();
  });

  it('returns null when no embeddings exist', async () => {
    createEmbeddingsDb().close(); // empty
    const tfDb = createTaskflowDb();

    const { TaskflowEngine } = await import('./taskflow-engine.js');
    const engine = new TaskflowEngine(tfDb, 'board-test');
    const reader = new EmbeddingReader(EMBED_DB);

    const queryVector = new Float32Array([1, 0, 0]);
    const preamble = engine.buildContextSummary(queryVector, reader);

    expect(preamble).toBeNull();

    reader.close();
    tfDb.close();
  });

  it('returns null when embeddings DB missing', async () => {
    const tfDb = createTaskflowDb();

    const { TaskflowEngine } = await import('./taskflow-engine.js');
    const engine = new TaskflowEngine(tfDb, 'board-test');
    const reader = new EmbeddingReader('/tmp/nonexistent/embeddings.db');

    const queryVector = new Float32Array([1, 0, 0]);
    const preamble = engine.buildContextSummary(queryVector, reader);

    expect(preamble).toBeNull();

    reader.close();
    tfDb.close();
  });
});
