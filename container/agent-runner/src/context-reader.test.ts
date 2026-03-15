import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {
  ContextReader,
  type ContextNode,
  type RecallResult,
} from './context-reader.js';

const TEST_DIR = path.join(import.meta.dirname, '..', 'test-context');
const TEST_DB = path.join(TEST_DIR, 'context.db');

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  Schema — mirrors src/context-service.ts                            */
/* ------------------------------------------------------------------ */

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS context_nodes (
  id            TEXT PRIMARY KEY,
  group_folder  TEXT NOT NULL,
  level         INTEGER NOT NULL,
  summary       TEXT,
  time_start    TEXT NOT NULL,
  time_end      TEXT NOT NULL,
  parent_id     TEXT REFERENCES context_nodes(id) ON DELETE SET NULL,
  token_count   INTEGER,
  model         TEXT,
  created_at    TEXT NOT NULL,
  pruned_at     TEXT
);

CREATE TABLE IF NOT EXISTS context_sessions (
  id            TEXT PRIMARY KEY,
  group_folder  TEXT NOT NULL,
  session_id    TEXT,
  messages      TEXT NOT NULL,
  agent_response TEXT,
  tool_calls    TEXT,
  created_at    TEXT NOT NULL,
  pruned_at     TEXT,
  FOREIGN KEY (id) REFERENCES context_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_group_level ON context_nodes(group_folder, level, time_start);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON context_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_pending ON context_nodes(level, summary) WHERE summary IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_group ON context_sessions(group_folder, created_at);
CREATE INDEX IF NOT EXISTS idx_nodes_pruned ON context_nodes(pruned_at) WHERE pruned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_group_time ON context_nodes(group_folder, time_start, time_end);

CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  node_id UNINDEXED,
  group_folder UNINDEXED,
  summary
);

CREATE VIRTUAL TABLE IF NOT EXISTS context_fts_vocab USING fts5vocab(context_fts, row);
`;

const TRIGGER_FTS_INSERT = `
CREATE TRIGGER IF NOT EXISTS context_fts_insert AFTER INSERT ON context_nodes
  WHEN NEW.summary IS NOT NULL
  BEGIN INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary); END;
`;

const TRIGGER_FTS_UPDATE = `
CREATE TRIGGER IF NOT EXISTS context_fts_update AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NOT NULL AND OLD.summary IS NOT NULL
  BEGIN
    DELETE FROM context_fts WHERE node_id = OLD.id;
    INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary);
  END;
`;

const TRIGGER_FTS_FIRST = `
CREATE TRIGGER IF NOT EXISTS context_fts_first AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NOT NULL AND OLD.summary IS NULL
  BEGIN INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary); END;
`;

const TRIGGER_FTS_CLEAR = `
CREATE TRIGGER IF NOT EXISTS context_fts_clear AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NULL AND OLD.summary IS NOT NULL
  BEGIN DELETE FROM context_fts WHERE node_id = OLD.id; END;
`;

const TRIGGER_FTS_DELETE = `
CREATE TRIGGER IF NOT EXISTS context_fts_delete AFTER DELETE ON context_nodes
  WHEN OLD.summary IS NOT NULL
  BEGIN DELETE FROM context_fts WHERE node_id = OLD.id; END;
`;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function seedDb(): Database.Database {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(TEST_DB);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.exec(TRIGGER_FTS_INSERT);
  db.exec(TRIGGER_FTS_UPDATE);
  db.exec(TRIGGER_FTS_FIRST);
  db.exec(TRIGGER_FTS_CLEAR);
  db.exec(TRIGGER_FTS_DELETE);
  return db;
}

function insertNode(
  db: Database.Database,
  opts: {
    id: string;
    group: string;
    level: number;
    summary: string | null;
    timeStart: string;
    timeEnd: string;
    parentId?: string | null;
    prunedAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, parent_id, token_count, model, created_at, pruned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.group,
    opts.level,
    opts.summary,
    opts.timeStart,
    opts.timeEnd,
    opts.parentId ?? null,
    opts.summary ? Math.ceil(opts.summary.length / 3.5) : null,
    opts.summary ? 'test-model' : null,
    new Date().toISOString(),
    opts.prunedAt ?? null,
  );
}

function insertSession(
  db: Database.Database,
  opts: {
    id: string;
    group: string;
    messages: Array<{ sender: string; content: string; timestamp: string }>;
    agentResponse?: string | null;
    toolCalls?: Array<{ tool: string; resultSummary: string }>;
    prunedAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO context_sessions (id, group_folder, session_id, messages, agent_response, tool_calls, created_at, pruned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.group,
    'session-1',
    JSON.stringify(opts.messages),
    opts.agentResponse ?? null,
    opts.toolCalls ? JSON.stringify(opts.toolCalls) : null,
    new Date().toISOString(),
    opts.prunedAt ?? null,
  );
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ContextReader', () => {
  describe('graceful fallback', () => {
    it('returns empty results for non-existent DB', () => {
      const reader = new ContextReader('/tmp/does-not-exist/context.db');
      expect(reader.getRecentSummaries('g', 10)).toEqual([]);
      expect(reader.search('g', 'test')).toEqual([]);
      expect(reader.recall('g', 'node-1')).toBeNull();
      expect(reader.timeline('g', '2026-01-01', '2026-12-31')).toEqual([]);
      expect(reader.topics('g')).toEqual([]);
      expect(reader.getNodeCount('g')).toBe(0);
      reader.close();
    });

    it('close() is idempotent', () => {
      const reader = new ContextReader('/tmp/does-not-exist/context.db');
      reader.close();
      reader.close(); // should not throw
    });
  });

  describe('getRecentSummaries', () => {
    it('returns only leaf-level summaries for the given group', () => {
      const db = seedDb();
      // Group A — leaf with summary
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Summary for group A turn 1',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      // Group A — leaf with summary (more recent)
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Summary for group A turn 2',
        timeStart: '2026-03-10T11:00:00Z',
        timeEnd: '2026-03-10T11:00:00Z',
      });
      // Group B — should not appear
      insertNode(db, {
        id: 'leaf:b:1',
        group: 'group-b',
        level: 0,
        summary: 'Summary for group B',
        timeStart: '2026-03-10T12:00:00Z',
        timeEnd: '2026-03-10T12:00:00Z',
      });
      // Group A — unsummarized leaf (should not appear)
      insertNode(db, {
        id: 'leaf:a:3',
        group: 'group-a',
        level: 0,
        summary: null,
        timeStart: '2026-03-10T13:00:00Z',
        timeEnd: '2026-03-10T13:00:00Z',
      });
      // Group A — daily rollup (level 1, should not appear)
      insertNode(db, {
        id: 'daily:a:2026-03-10',
        group: 'group-a',
        level: 1,
        summary: 'Daily summary',
        timeStart: '2026-03-10T00:00:00Z',
        timeEnd: '2026-03-10T23:59:59Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const results = reader.getRecentSummaries('group-a', 10);
      expect(results.length).toBe(2);
      // Most recent first
      expect(results[0].id).toBe('leaf:a:2');
      expect(results[1].id).toBe('leaf:a:1');
      reader.close();
    });

    it('excludes pruned nodes', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Active node',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Pruned node',
        timeStart: '2026-03-10T11:00:00Z',
        timeEnd: '2026-03-10T11:00:00Z',
        prunedAt: '2026-03-12T00:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const results = reader.getRecentSummaries('group-a', 10);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('leaf:a:1');
      reader.close();
    });

    it('respects limit parameter', () => {
      const db = seedDb();
      for (let i = 0; i < 5; i++) {
        insertNode(db, {
          id: `leaf:a:${i}`,
          group: 'group-a',
          level: 0,
          summary: `Summary ${i}`,
          timeStart: `2026-03-10T${String(10 + i).padStart(2, '0')}:00:00Z`,
          timeEnd: `2026-03-10T${String(10 + i).padStart(2, '0')}:00:00Z`,
        });
      }
      db.close();

      const reader = new ContextReader(TEST_DB);
      const results = reader.getRecentSummaries('group-a', 3);
      expect(results.length).toBe(3);
      reader.close();
    });
  });

  describe('search', () => {
    it('returns FTS5 matches scoped to group', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Discussed deployment pipeline improvements',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:b:1',
        group: 'group-b',
        level: 0,
        summary: 'Discussed deployment strategy for production',
        timeStart: '2026-03-10T11:00:00Z',
        timeEnd: '2026-03-10T11:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const results = reader.search('group-a', 'deployment');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('leaf:a:1');
      reader.close();
    });

    it('excludes pruned nodes from search results', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Active deployment discussion',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Pruned deployment discussion',
        timeStart: '2026-03-09T10:00:00Z',
        timeEnd: '2026-03-09T10:00:00Z',
        prunedAt: '2026-03-12T00:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const results = reader.search('group-a', 'deployment');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('leaf:a:1');
      reader.close();
    });

    it('supports dateFrom/dateTo filtering', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Meeting about architecture decisions',
        timeStart: '2026-03-08T10:00:00Z',
        timeEnd: '2026-03-08T10:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Meeting about architecture review',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      // Only the March 10 node should match
      const results = reader.search('group-a', 'architecture', {
        dateFrom: '2026-03-09T00:00:00Z',
        dateTo: '2026-03-11T00:00:00Z',
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('leaf:a:2');
      reader.close();
    });

    it('respects limit option', () => {
      const db = seedDb();
      for (let i = 0; i < 5; i++) {
        insertNode(db, {
          id: `leaf:a:${i}`,
          group: 'group-a',
          level: 0,
          summary: `Sprint planning session number ${i}`,
          timeStart: `2026-03-${String(10 + i).padStart(2, '0')}T10:00:00Z`,
          timeEnd: `2026-03-${String(10 + i).padStart(2, '0')}T10:00:00Z`,
        });
      }
      db.close();

      const reader = new ContextReader(TEST_DB);
      const results = reader.search('group-a', 'sprint', { limit: 2 });
      expect(results.length).toBe(2);
      reader.close();
    });

    it('returns empty for malformed FTS query', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Test summary',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      // Invalid FTS5 syntax — should not throw, return empty
      const results = reader.search('group-a', 'AND OR NOT');
      expect(results).toEqual([]);
      reader.close();
    });
  });

  describe('recall', () => {
    it('returns leaf node with session data', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'User asked about task status',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      insertSession(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        messages: [
          {
            sender: 'Alice',
            content: 'What is the status of task 42?',
            timestamp: '2026-03-10T10:00:00Z',
          },
        ],
        agentResponse: 'Task 42 is in progress.',
        toolCalls: [{ tool: 'taskflow_update', resultSummary: 'Updated task status' }],
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const result = reader.recall('group-a', 'leaf:a:1');
      expect(result).not.toBeNull();
      expect(result!.summary.id).toBe('leaf:a:1');
      expect(result!.sessions.length).toBe(1);
      expect(result!.sessions[0].messages[0].sender).toBe('Alice');
      expect(result!.sessions[0].tool_calls[0].tool).toBe('taskflow_update');
      expect(result!.children.length).toBe(0);
      expect(result!.detail_pruned).toBe(false);
      reader.close();
    });

    it('enforces group isolation — rejects cross-group access', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Secret data for group A',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      // Try to access group-a's node from group-b
      const result = reader.recall('group-b', 'leaf:a:1');
      expect(result).toBeNull();
      reader.close();
    });

    it('returns null for pruned node', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Pruned node',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
        prunedAt: '2026-03-12T00:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const result = reader.recall('group-a', 'leaf:a:1');
      expect(result).toBeNull();
      reader.close();
    });

    it('returns rollup node with children', () => {
      const db = seedDb();
      // Daily rollup
      insertNode(db, {
        id: 'daily:a:2026-03-10',
        group: 'group-a',
        level: 1,
        summary: 'Daily summary for March 10',
        timeStart: '2026-03-10T00:00:00Z',
        timeEnd: '2026-03-10T23:59:59Z',
      });
      // Children
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Morning standup discussion',
        timeStart: '2026-03-10T09:00:00Z',
        timeEnd: '2026-03-10T09:00:00Z',
        parentId: 'daily:a:2026-03-10',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Afternoon code review',
        timeStart: '2026-03-10T14:00:00Z',
        timeEnd: '2026-03-10T14:00:00Z',
        parentId: 'daily:a:2026-03-10',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const result = reader.recall('group-a', 'daily:a:2026-03-10');
      expect(result).not.toBeNull();
      expect(result!.summary.level).toBe(1);
      expect(result!.children.length).toBe(2);
      expect(result!.sessions.length).toBe(0);
      expect(result!.detail_pruned).toBe(false);
      reader.close();
    });

    it('returns detail_pruned true when all children are pruned', () => {
      const db = seedDb();
      // Daily rollup
      insertNode(db, {
        id: 'daily:a:2026-03-10',
        group: 'group-a',
        level: 1,
        summary: 'Daily summary for March 10',
        timeStart: '2026-03-10T00:00:00Z',
        timeEnd: '2026-03-10T23:59:59Z',
      });
      // All children are pruned
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Pruned child 1',
        timeStart: '2026-03-10T09:00:00Z',
        timeEnd: '2026-03-10T09:00:00Z',
        parentId: 'daily:a:2026-03-10',
        prunedAt: '2026-03-15T00:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Pruned child 2',
        timeStart: '2026-03-10T14:00:00Z',
        timeEnd: '2026-03-10T14:00:00Z',
        parentId: 'daily:a:2026-03-10',
        prunedAt: '2026-03-15T00:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const result = reader.recall('group-a', 'daily:a:2026-03-10');
      expect(result).not.toBeNull();
      expect(result!.detail_pruned).toBe(true);
      expect(result!.children.length).toBe(0);
      // The rollup summary is still available
      expect(result!.summary.summary).toBe('Daily summary for March 10');
      reader.close();
    });

    it('returns detail_pruned true when leaf session is pruned', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Summary still available',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      // Session exists but is pruned
      insertSession(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        messages: [{ sender: 'Alice', content: 'Hello', timestamp: '2026-03-10T10:00:00Z' }],
        prunedAt: '2026-03-15T00:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const result = reader.recall('group-a', 'leaf:a:1');
      expect(result).not.toBeNull();
      expect(result!.detail_pruned).toBe(true);
      expect(result!.sessions.length).toBe(0);
      expect(result!.summary.summary).toBe('Summary still available');
      reader.close();
    });

    it('returns null for non-existent node', () => {
      const db = seedDb();
      db.close();

      const reader = new ContextReader(TEST_DB);
      const result = reader.recall('group-a', 'non-existent');
      expect(result).toBeNull();
      reader.close();
    });
  });

  describe('timeline', () => {
    it('returns chronological summaries within date range', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Before range',
        timeStart: '2026-03-01T10:00:00Z',
        timeEnd: '2026-03-01T10:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'In range',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      insertNode(db, {
        id: 'daily:a:2026-03-10',
        group: 'group-a',
        level: 1,
        summary: 'Daily in range',
        timeStart: '2026-03-10T00:00:00Z',
        timeEnd: '2026-03-10T23:59:59Z',
      });
      insertNode(db, {
        id: 'leaf:a:3',
        group: 'group-a',
        level: 0,
        summary: 'After range',
        timeStart: '2026-03-20T10:00:00Z',
        timeEnd: '2026-03-20T10:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const results = reader.timeline(
        'group-a',
        '2026-03-09T00:00:00Z',
        '2026-03-11T00:00:00Z',
      );
      expect(results.length).toBe(2);
      // Higher level first
      expect(results[0].level).toBe(1);
      expect(results[1].level).toBe(0);
      reader.close();
    });

    it('excludes other groups and pruned nodes', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Group A node',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:b:1',
        group: 'group-b',
        level: 0,
        summary: 'Group B node',
        timeStart: '2026-03-10T11:00:00Z',
        timeEnd: '2026-03-10T11:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Pruned node',
        timeStart: '2026-03-10T12:00:00Z',
        timeEnd: '2026-03-10T12:00:00Z',
        prunedAt: '2026-03-12T00:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const results = reader.timeline(
        'group-a',
        '2026-03-09T00:00:00Z',
        '2026-03-11T00:00:00Z',
      );
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('leaf:a:1');
      reader.close();
    });
  });

  describe('topics', () => {
    it('returns group-scoped topic counts', () => {
      const db = seedDb();
      // Group A — multiple nodes mentioning "deployment"
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Deployment pipeline configuration and testing',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Deployment monitoring dashboard setup',
        timeStart: '2026-03-11T10:00:00Z',
        timeEnd: '2026-03-11T10:00:00Z',
      });
      // Group B — also mentions deployment (should not count for group-a)
      insertNode(db, {
        id: 'leaf:b:1',
        group: 'group-b',
        level: 0,
        summary: 'Deployment strategy for production release',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const topics = reader.topics('group-a');
      expect(topics.length).toBeGreaterThan(0);

      const deploymentTopic = topics.find((t) => t.topic === 'deployment');
      expect(deploymentTopic).toBeDefined();
      expect(deploymentTopic!.nodeCount).toBe(2); // only group-a nodes
      expect(deploymentTopic!.lastSeen).toBe('2026-03-11T10:00:00Z');
      reader.close();
    });

    it('filters out stop words', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'The quick brown fox jumps over the lazy dog',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const topics = reader.topics('group-a');
      // "the" and "over" are stop words — should not appear
      const stopWordTopics = topics.filter(
        (t) => t.topic === 'the' || t.topic === 'over',
      );
      expect(stopWordTopics.length).toBe(0);
      reader.close();
    });

    it('returns empty for group with no FTS data', () => {
      const db = seedDb();
      // Only group-b has data
      insertNode(db, {
        id: 'leaf:b:1',
        group: 'group-b',
        level: 0,
        summary: 'Some content for group B only',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      const topics = reader.topics('group-a');
      expect(topics.length).toBe(0);
      reader.close();
    });
  });

  describe('getNodeCount', () => {
    it('counts non-pruned nodes for the group', () => {
      const db = seedDb();
      insertNode(db, {
        id: 'leaf:a:1',
        group: 'group-a',
        level: 0,
        summary: 'Active node 1',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:2',
        group: 'group-a',
        level: 0,
        summary: 'Active node 2',
        timeStart: '2026-03-10T11:00:00Z',
        timeEnd: '2026-03-10T11:00:00Z',
      });
      insertNode(db, {
        id: 'leaf:a:3',
        group: 'group-a',
        level: 0,
        summary: 'Pruned node',
        timeStart: '2026-03-10T12:00:00Z',
        timeEnd: '2026-03-10T12:00:00Z',
        prunedAt: '2026-03-12T00:00:00Z',
      });
      // Different group
      insertNode(db, {
        id: 'leaf:b:1',
        group: 'group-b',
        level: 0,
        summary: 'Other group node',
        timeStart: '2026-03-10T10:00:00Z',
        timeEnd: '2026-03-10T10:00:00Z',
      });
      db.close();

      const reader = new ContextReader(TEST_DB);
      expect(reader.getNodeCount('group-a')).toBe(2);
      expect(reader.getNodeCount('group-b')).toBe(1);
      expect(reader.getNodeCount('non-existent')).toBe(0);
      reader.close();
    });
  });
});
