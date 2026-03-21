import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { ContextService } from './context-service.js';

const TEST_DIR = path.join(import.meta.dirname, '..', 'test-context');
const TEST_DB = path.join(TEST_DIR, 'context.db');

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/* ================================================================== */
/*  Schema creation                                                    */
/* ================================================================== */

describe('ContextService — schema', () => {
  it('creates all tables and indexes on instantiation', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    const db = new Database(TEST_DB, { readonly: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('context_cursors');
    expect(tableNames).toContain('context_nodes');
    expect(tableNames).toContain('context_sessions');

    // FTS5 virtual table
    const vtables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'context_fts%'",
      )
      .all();
    expect(vtables.length).toBeGreaterThanOrEqual(1);

    // Triggers
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'context_fts%'",
      )
      .all() as { name: string }[];
    const triggerNames = triggers.map((t) => t.name);
    expect(triggerNames).toContain('context_fts_insert');
    expect(triggerNames).toContain('context_fts_update');
    expect(triggerNames).toContain('context_fts_first');
    expect(triggerNames).toContain('context_fts_clear');
    expect(triggerNames).toContain('context_fts_delete');

    db.close();
    svc.close();
  });

  it('is idempotent — opening twice does not throw', () => {
    const svc1 = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });
    svc1.close();
    const svc2 = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });
    svc2.close();
  });
});

/* ================================================================== */
/*  insertTurn                                                         */
/* ================================================================== */

describe('ContextService — insertTurn', () => {
  it('creates leaf node and session from a captured turn', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    const now = '2026-03-15T10:30:00.000Z';
    const count = svc.insertTurn('test-group', 'session-123', {
      userMessage: 'T1 servico iniciado',
      agentResponse: 'T1 movido para Em Andamento',
      toolCalls: [{ tool: 'taskflow_move', resultSummary: 'ok' }],
      timestamp: now,
    });

    expect(count).toBe(1);

    // Verify leaf node
    const node = svc.db
      .prepare(
        "SELECT * FROM context_nodes WHERE group_folder = 'test-group' AND level = 0",
      )
      .get() as any;
    expect(node).toBeTruthy();
    expect(node.id).toMatch(
      new RegExp(
        `^leaf:test-group:${now.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d{4}$`,
      ),
    );
    expect(node.summary).toBeNull();
    expect(node.level).toBe(0);

    // Verify session
    const session = svc.db
      .prepare(
        "SELECT * FROM context_sessions WHERE group_folder = 'test-group'",
      )
      .get() as any;
    expect(session).toBeTruthy();
    expect(session.id).toBe(node.id);
    expect(session.session_id).toBe('session-123');
    expect(JSON.parse(session.messages)).toHaveLength(1);
    expect(session.agent_response).toBe('T1 movido para Em Andamento');
    expect(JSON.parse(session.tool_calls)).toHaveLength(1);

    svc.close();
  });

  it('uses OR IGNORE to handle duplicate leaf IDs', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    const ts = '2026-03-15T10:30:00.000Z';
    svc.insertTurn('grp', 'sess', {
      userMessage: 'first',
      agentResponse: 'response',
      toolCalls: [],
      timestamp: ts,
    });

    // Second insert with same timestamp should not throw
    expect(() =>
      svc.insertTurn('grp', 'sess', {
        userMessage: 'second',
        agentResponse: 'response2',
        toolCalls: [],
        timestamp: ts,
      }),
    ).not.toThrow();

    // Both nodes exist (monotonic suffix makes IDs unique even with same timestamp)
    const nodes = svc.db
      .prepare(
        "SELECT * FROM context_nodes WHERE group_folder = 'grp' AND level = 0",
      )
      .all();
    expect(nodes).toHaveLength(2);

    svc.close();
  });

  it('inserts multiple turns for the same group', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    for (let i = 0; i < 3; i++) {
      svc.insertTurn('grp', 'sess', {
        userMessage: `msg ${i}`,
        agentResponse: `resp ${i}`,
        toolCalls: [],
        timestamp: `2026-03-15T1${i}:00:00.000Z`,
      });
    }

    const count = svc.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM context_nodes WHERE group_folder = 'grp'",
      )
      .get() as { cnt: number };
    expect(count.cnt).toBe(3);

    svc.close();
  });
});

/* ================================================================== */
/*  summarizePending                                                   */
/* ================================================================== */

describe('ContextService — summarizePending', () => {
  it('summarizes pending leaf nodes via Ollama', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      summarizerModel: 'llama3.1',
      retainDays: 90,
    });

    svc.insertTurn('test-group', 'sess-1', {
      userMessage: 'T1 servico iniciado dia 15 as 7:00',
      agentResponse: 'T1 movido para Em Andamento, atribuido a Alexandre',
      toolCalls: [{ tool: 'taskflow_move', resultSummary: 'ok' }],
      timestamp: '2026-03-15T07:00:00.000Z',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response:
          'Alexandre reported T1 progress. Task moved to in-progress and assigned to Alexandre.',
      }),
    });
    global.fetch = mockFetch as any;

    const count = await svc.summarizePending(5);
    expect(count).toBe(1);

    // Verify summary was set
    const node = svc.db
      .prepare(
        'SELECT summary, token_count, model FROM context_nodes WHERE level = 0',
      )
      .get() as any;
    expect(node.summary).toBe(
      'Alexandre reported T1 progress. Task moved to in-progress and assigned to Alexandre.',
    );
    expect(node.token_count).toBeGreaterThan(0);
    expect(node.token_count).toBe(Math.ceil(node.summary.length / 3.5));
    expect(node.model).toBe('llama3.1');

    // Verify FTS was updated (via trigger)
    const nodeRow = svc.db
      .prepare('SELECT id FROM context_nodes WHERE level = 0')
      .get() as any;
    const fts = svc.db
      .prepare('SELECT * FROM context_fts WHERE node_id = ?')
      .get(nodeRow.id) as any;
    expect(fts).toBeTruthy();
    expect(fts.summary).toBe(node.summary);

    // Verify Ollama was called correctly
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    svc.close();
  });

  it('summarizes via Claude when configured', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'claude',
      anthropicApiKey: 'test-key',
      retainDays: 90,
    });

    svc.insertTurn('grp', 'sess', {
      userMessage: 'check status',
      agentResponse: 'All tasks up to date.',
      toolCalls: [],
      timestamp: '2026-03-15T09:00:00.000Z',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            text: 'User requested status check. All tasks confirmed up to date.',
          },
        ],
      }),
    });
    global.fetch = mockFetch as any;

    const count = await svc.summarizePending(5);
    expect(count).toBe(1);

    const node = svc.db
      .prepare('SELECT model FROM context_nodes WHERE level = 0')
      .get() as any;
    expect(node.model).toBe('haiku-4.5');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    );

    svc.close();
  });

  it('skips summaries that are too short (<=20 chars)', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    svc.insertTurn('grp', 'sess', {
      userMessage: 'hello',
      agentResponse: 'hi',
      toolCalls: [],
      timestamp: '2026-03-15T09:00:00.000Z',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'too short' }),
    });
    global.fetch = mockFetch as any;

    const count = await svc.summarizePending(5);
    expect(count).toBe(0);

    const node = svc.db
      .prepare('SELECT summary FROM context_nodes WHERE level = 0')
      .get() as any;
    expect(node.summary).toBeNull();

    svc.close();
  });

  it('handles Ollama failure gracefully', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    svc.insertTurn('grp', 'sess', {
      userMessage: 'test msg',
      agentResponse: 'test resp',
      toolCalls: [],
      timestamp: '2026-03-15T09:00:00.000Z',
    });

    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    global.fetch = mockFetch as any;

    const count = await svc.summarizePending(5);
    expect(count).toBe(0);

    // Node still has NULL summary
    const node = svc.db
      .prepare('SELECT summary FROM context_nodes WHERE level = 0')
      .get() as any;
    expect(node.summary).toBeNull();

    svc.close();
  });

  it('respects limit parameter', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    for (let i = 0; i < 5; i++) {
      svc.insertTurn('grp', 'sess', {
        userMessage: `msg ${i}`,
        agentResponse: `response ${i}`,
        toolCalls: [],
        timestamp: `2026-03-15T1${i}:00:00.000Z`,
      });
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: 'This is a valid summary with enough characters to pass.',
      }),
    });
    global.fetch = mockFetch as any;

    const count = await svc.summarizePending(2);
    expect(count).toBe(2);

    const summarized = svc.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM context_nodes WHERE level = 0 AND summary IS NOT NULL',
      )
      .get() as { cnt: number };
    expect(summarized.cnt).toBe(2);

    svc.close();
  });
});

/* ================================================================== */
/*  FTS5 triggers                                                      */
/* ================================================================== */

describe('ContextService — FTS5 triggers', () => {
  it('inserts into FTS when node is created with summary', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    // Directly insert a node with a summary (simulating a rollup node)
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES ('test-node', 'grp', 1, 'A test summary for FTS', '2026-03-14', '2026-03-14', ?)`,
      )
      .run(new Date().toISOString());

    const fts = svc.db
      .prepare("SELECT * FROM context_fts WHERE node_id = 'test-node'")
      .get() as any;
    expect(fts).toBeTruthy();
    expect(fts.summary).toBe('A test summary for FTS');

    svc.close();
  });

  it('updates FTS when summary changes from NULL to non-NULL (first summarization)', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    svc.insertTurn('grp', 'sess', {
      userMessage: 'test message for summarization',
      agentResponse: 'agent response to test message',
      toolCalls: [],
      timestamp: '2026-03-15T09:00:00.000Z',
    });

    // Before summarization: no FTS entry — look up actual node ID
    const node = svc.db
      .prepare(
        "SELECT id FROM context_nodes WHERE group_folder = 'grp' AND level = 0",
      )
      .get() as any;
    const nodeId = node.id;
    let fts = svc.db
      .prepare('SELECT * FROM context_fts WHERE node_id = ?')
      .get(nodeId) as any;
    expect(fts).toBeUndefined();

    // Summarize
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response:
          'User sent a test message and received a response from the agent.',
      }),
    });
    global.fetch = mockFetch as any;

    await svc.summarizePending(1);

    // After summarization: FTS entry should exist
    fts = svc.db
      .prepare('SELECT * FROM context_fts WHERE node_id = ?')
      .get(nodeId) as any;
    expect(fts).toBeTruthy();
    expect(fts.summary).toContain('test message');

    svc.close();
  });

  it('removes FTS entry when summary is set to NULL', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES ('n1', 'grp', 1, 'Summary text here', '2026-03-14', '2026-03-14', ?)`,
      )
      .run(new Date().toISOString());

    // Verify FTS entry exists
    let fts = svc.db
      .prepare("SELECT * FROM context_fts WHERE node_id = 'n1'")
      .get();
    expect(fts).toBeTruthy();

    // Set summary to NULL (re-summarization retry)
    svc.db
      .prepare("UPDATE context_nodes SET summary = NULL WHERE id = 'n1'")
      .run();

    fts = svc.db
      .prepare("SELECT * FROM context_fts WHERE node_id = 'n1'")
      .get();
    expect(fts).toBeUndefined();

    svc.close();
  });

  it('removes FTS entry when node is deleted', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES ('n2', 'grp', 1, 'Some summary for deletion test', '2026-03-14', '2026-03-14', ?)`,
      )
      .run(new Date().toISOString());

    // Delete the node
    svc.db.prepare("DELETE FROM context_nodes WHERE id = 'n2'").run();

    const fts = svc.db
      .prepare("SELECT * FROM context_fts WHERE node_id = 'n2'")
      .get();
    expect(fts).toBeUndefined();

    svc.close();
  });

  it('updates FTS when summary changes from one value to another', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES ('n3', 'grp', 1, 'Original summary text', '2026-03-14', '2026-03-14', ?)`,
      )
      .run(new Date().toISOString());

    svc.db
      .prepare(
        "UPDATE context_nodes SET summary = 'Updated summary text' WHERE id = 'n3'",
      )
      .run();

    const fts = svc.db
      .prepare("SELECT * FROM context_fts WHERE node_id = 'n3'")
      .get() as any;
    expect(fts).toBeTruthy();
    expect(fts.summary).toBe('Updated summary text');

    // Only one entry should exist
    const allFts = svc.db
      .prepare("SELECT * FROM context_fts WHERE node_id = 'n3'")
      .all();
    expect(allFts).toHaveLength(1);

    svc.close();
  });
});

/* ================================================================== */
/*  summarizer failure alerting                                        */
/* ================================================================== */

describe('ContextService — summarizer failure alerting', () => {
  it('logs ERROR after 10 consecutive failures, resets on success', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    const now = new Date().toISOString();

    // Insert 12 pending leaves
    for (let i = 0; i < 12; i++) {
      const nodeId = `leaf:grp:2026-03-14T${String(i).padStart(2, '0')}:00:00.000Z`;
      svc.db
        .prepare(
          `INSERT INTO context_nodes (id, group_folder, level, time_start, time_end, created_at)
         VALUES (?, 'grp', 0, ?, ?, ?)`,
        )
        .run(nodeId, `2026-03-14T${String(i).padStart(2, '0')}:00:00.000Z`,
          `2026-03-14T${String(i).padStart(2, '0')}:00:00.000Z`, now);
      svc.db
        .prepare(
          `INSERT INTO context_sessions (id, group_folder, messages, agent_response, created_at)
         VALUES (?, 'grp', '[]', 'resp', ?)`,
        )
        .run(nodeId, now);
    }

    // Mock fetch to always fail (non-OK)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    global.fetch = mockFetch as any;

    // Run 2 cycles of 5 = 10 failures
    await svc.summarizePending(5);
    await svc.summarizePending(5);

    // Access private field to verify counter
    expect((svc as any).consecutiveFailures).toBe(10);

    // Now make it succeed
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Recovery summary after outage.' }),
    });

    await svc.summarizePending(2);

    // Counter should reset
    expect((svc as any).consecutiveFailures).toBe(0);

    svc.close();
  });
});

/* ================================================================== */
/*  rollupDaily                                                        */
/* ================================================================== */

describe('ContextService — rollupDaily', () => {
  it('creates daily rollup from leaf summaries', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      summarizerModel: 'test',
      retainDays: 90,
    });

    // Insert 2 leaves with summaries for 2026-03-14
    const date = '2026-03-14';
    for (let i = 0; i < 2; i++) {
      const ts = `${date}T${String(10 + i).padStart(2, '0')}:00:00.000Z`;
      const nodeId = `leaf:test-group:${ts}`;
      svc.db
        .prepare(
          `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
         VALUES (?, 'test-group', 0, ?, ?, ?, 20, 'test', ?)`,
        )
        .run(nodeId, `Summary ${i}`, ts, ts, new Date().toISOString());
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response:
          'Daily summary for March 14. Two sessions about task progress.',
      }),
    });
    global.fetch = mockFetch as any;

    const dailyId = await svc.rollupDaily('test-group', date);
    expect(dailyId).toBe(`daily:test-group:${date}`);

    // Verify daily node
    const daily = svc.db
      .prepare('SELECT * FROM context_nodes WHERE id = ?')
      .get(dailyId) as any;
    expect(daily.level).toBe(1);
    expect(daily.summary).toBe(
      'Daily summary for March 14. Two sessions about task progress.',
    );
    expect(daily.token_count).toBeGreaterThan(0);

    // Verify children linked to parent
    const children = svc.db
      .prepare('SELECT * FROM context_nodes WHERE parent_id = ?')
      .all(dailyId);
    expect(children).toHaveLength(2);

    // Verify FTS entry for the daily node
    const fts = svc.db
      .prepare('SELECT * FROM context_fts WHERE node_id = ?')
      .get(dailyId) as any;
    expect(fts).toBeTruthy();

    svc.close();
  });

  it('returns null if rollup already exists', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    const date = '2026-03-14';

    // Insert leaf
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
       VALUES (?, 'grp', 0, 'leaf summary', ?, ?, 10, 'test', ?)`,
      )
      .run(
        `leaf:grp:${date}T10:00:00.000Z`,
        `${date}T10:00:00.000Z`,
        `${date}T10:00:00.000Z`,
        new Date().toISOString(),
      );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: 'Daily summary for the test rollup dedup check.',
      }),
    });
    global.fetch = mockFetch as any;

    // First rollup should succeed
    const first = await svc.rollupDaily('grp', date);
    expect(first).toBeTruthy();

    // Second rollup should return null (already exists)
    const second = await svc.rollupDaily('grp', date);
    expect(second).toBeNull();

    svc.close();
  });

  it('adopts late-arriving orphans into existing rollup', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    const date = '2026-03-14';
    const now = new Date().toISOString();

    // Insert first leaf and create the daily rollup
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
       VALUES (?, 'grp', 0, 'early leaf', ?, ?, 10, 'test', ?)`,
      )
      .run(`leaf:grp:${date}T09:00:00.000Z`, `${date}T09:00:00.000Z`, `${date}T09:00:00.000Z`, now);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Daily rollup summary.' }),
    });
    global.fetch = mockFetch as any;

    const dailyId = await svc.rollupDaily('grp', date);
    expect(dailyId).toBeTruthy();

    // Verify first leaf is linked
    const earlyLeaf = svc.db.prepare('SELECT parent_id FROM context_nodes WHERE id = ?')
      .get(`leaf:grp:${date}T09:00:00.000Z`) as any;
    expect(earlyLeaf.parent_id).toBe(dailyId);

    // Now insert a late-arriving orphan (summarized after the rollup was created)
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
       VALUES (?, 'grp', 0, 'late orphan', ?, ?, 10, 'test', ?)`,
      )
      .run(`leaf:grp:${date}T21:00:00.000Z`, `${date}T21:00:00.000Z`, `${date}T21:00:00.000Z`, now);

    // Re-run rollup — should adopt the orphan, not create a new daily
    const second = await svc.rollupDaily('grp', date);
    expect(second).toBeNull(); // still returns null (existing rollup)

    // Verify the orphan was adopted
    const lateLeaf = svc.db.prepare('SELECT parent_id FROM context_nodes WHERE id = ?')
      .get(`leaf:grp:${date}T21:00:00.000Z`) as any;
    expect(lateLeaf.parent_id).toBe(dailyId);

    // Total children should be 2
    const children = svc.db.prepare('SELECT COUNT(*) as cnt FROM context_nodes WHERE parent_id = ?')
      .get(dailyId) as any;
    expect(children.cnt).toBe(2);

    svc.close();
  });

  it('returns null when no children exist for the date', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    const result = await svc.rollupDaily('grp', '2026-03-14');
    expect(result).toBeNull();

    svc.close();
  });

  it('only picks up unsummarized=false and unparented leaves', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });

    const date = '2026-03-14';
    const now = new Date().toISOString();

    // Leaf with summary (eligible)
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
       VALUES ('leaf:grp:${date}T10:00:00.000Z', 'grp', 0, 'summarized leaf', '${date}T10:00:00.000Z', '${date}T10:00:00.000Z', 10, 'test', ?)`,
      )
      .run(now);

    // Leaf without summary (NOT eligible for rollup)
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES ('leaf:grp:${date}T11:00:00.000Z', 'grp', 0, NULL, '${date}T11:00:00.000Z', '${date}T11:00:00.000Z', ?)`,
      )
      .run(now);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: 'Daily rollup picking only summarized leaves as expected.',
      }),
    });
    global.fetch = mockFetch as any;

    const dailyId = await svc.rollupDaily('grp', date);
    expect(dailyId).toBeTruthy();

    // Only 1 child should be linked (the summarized one)
    const children = svc.db
      .prepare('SELECT * FROM context_nodes WHERE parent_id = ?')
      .all(dailyId);
    expect(children).toHaveLength(1);

    svc.close();
  });
});

/* ================================================================== */
/*  rollupWeekly                                                       */
/* ================================================================== */

describe('ContextService — rollupWeekly', () => {
  it('creates weekly rollup from daily nodes', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      summarizerModel: 'test',
      retainDays: 90,
    });

    const now = new Date().toISOString();
    // Week of Mar 2-8 2026 (Monday to Sunday)
    const weekStart = '2026-03-02';
    for (let day = 2; day <= 4; day++) {
      const date = `2026-03-${String(day).padStart(2, '0')}`;
      svc.db
        .prepare(
          `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
         VALUES (?, 'grp', 1, ?, ?, ?, 30, 'test', ?)`,
        )
        .run(
          `daily:grp:${date}`,
          `Daily summary for ${date}`,
          `${date}T00:00:00.000Z`,
          `${date}T23:59:59.999Z`,
          now,
        );
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response:
          'Weekly summary for the first week of March. Good progress overall.',
      }),
    });
    global.fetch = mockFetch as any;

    const weeklyId = await svc.rollupWeekly('grp', weekStart);
    expect(weeklyId).toMatch(/^weekly:grp:2026-W10$/);

    const weekly = svc.db
      .prepare('SELECT * FROM context_nodes WHERE id = ?')
      .get(weeklyId) as any;
    expect(weekly.level).toBe(2);
    expect(weekly.summary).toContain('Weekly summary');

    // Children linked
    const children = svc.db
      .prepare('SELECT * FROM context_nodes WHERE parent_id = ?')
      .all(weeklyId);
    expect(children).toHaveLength(3);

    svc.close();
  });
});

/* ================================================================== */
/*  rollupMonthly                                                      */
/* ================================================================== */

describe('ContextService — rollupMonthly', () => {
  it('creates monthly rollup from weekly nodes', async () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      summarizerModel: 'test',
      retainDays: 90,
    });

    const now = new Date().toISOString();
    // Insert 3 weekly nodes in February 2026
    for (let week = 1; week <= 3; week++) {
      const weekStart = `2026-02-${String(week * 7).padStart(2, '0')}`;
      svc.db
        .prepare(
          `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
         VALUES (?, 'grp', 2, ?, ?, ?, 50, 'test', ?)`,
        )
        .run(
          `weekly:grp:2026-W0${week + 4}`,
          `Weekly summary for week ${week + 4}`,
          `${weekStart}T00:00:00.000Z`,
          `${weekStart}T23:59:59.999Z`,
          now,
        );
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response:
          'Monthly summary for February 2026. Significant progress made.',
      }),
    });
    global.fetch = mockFetch as any;

    const monthlyId = await svc.rollupMonthly('grp', '2026-02');
    expect(monthlyId).toBe('monthly:grp:2026-02');

    const monthly = svc.db
      .prepare('SELECT * FROM context_nodes WHERE id = ?')
      .get(monthlyId) as any;
    expect(monthly.level).toBe(3);
    expect(monthly.summary).toContain('Monthly summary');

    const children = svc.db
      .prepare('SELECT * FROM context_nodes WHERE parent_id = ?')
      .all(monthlyId);
    expect(children).toHaveLength(3);

    svc.close();
  });
});

/* ================================================================== */
/*  applyRetention                                                     */
/* ================================================================== */

describe('ContextService — applyRetention', () => {
  it('soft-deletes leaves and dailies older than retainDays', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    const now = new Date().toISOString();
    // Old leaf (100 days ago)
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
    const oldNodeId = `leaf:grp:${oldDate}`;
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES (?, 'grp', 0, 'old summary', ?, ?, ?)`,
      )
      .run(oldNodeId, oldDate, oldDate, oldDate);
    svc.db
      .prepare(
        `INSERT INTO context_sessions (id, group_folder, messages, created_at)
       VALUES (?, 'grp', '[]', ?)`,
      )
      .run(oldNodeId, oldDate);

    // Recent leaf (10 days ago) — should NOT be pruned
    const recentDate = new Date(Date.now() - 10 * 86400000).toISOString();
    const recentNodeId = `leaf:grp:${recentDate}`;
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES (?, 'grp', 0, 'recent summary', ?, ?, ?)`,
      )
      .run(recentNodeId, recentDate, recentDate, recentDate);

    const pruned = svc.applyRetention();
    expect(pruned).toBe(1);

    // Old node should be pruned
    const oldNode = svc.db
      .prepare('SELECT pruned_at FROM context_nodes WHERE id = ?')
      .get(oldNodeId) as any;
    expect(oldNode.pruned_at).toBeTruthy();

    // Old session should also be pruned
    const oldSession = svc.db
      .prepare('SELECT pruned_at FROM context_sessions WHERE id = ?')
      .get(oldNodeId) as any;
    expect(oldSession.pruned_at).toBeTruthy();

    // Recent node should NOT be pruned
    const recentNode = svc.db
      .prepare('SELECT pruned_at FROM context_nodes WHERE id = ?')
      .get(recentNodeId) as any;
    expect(recentNode.pruned_at).toBeNull();

    svc.close();
  });

  it('soft-deletes old daily rollups (level 1) but not weeklies (level 2)', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();

    // Old daily
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES ('daily:grp:old', 'grp', 1, 'old daily', ?, ?, ?)`,
      )
      .run(oldDate, oldDate, oldDate);

    // Old weekly — should NOT be pruned (kept forever)
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES ('weekly:grp:old', 'grp', 2, 'old weekly', ?, ?, ?)`,
      )
      .run(oldDate, oldDate, oldDate);

    // Old monthly — should NOT be pruned
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
       VALUES ('monthly:grp:old', 'grp', 3, 'old monthly', ?, ?, ?)`,
      )
      .run(oldDate, oldDate, oldDate);

    const pruned = svc.applyRetention();
    expect(pruned).toBe(1); // Only the daily

    const daily = svc.db
      .prepare("SELECT pruned_at FROM context_nodes WHERE id = 'daily:grp:old'")
      .get() as any;
    expect(daily.pruned_at).toBeTruthy();

    const weekly = svc.db
      .prepare(
        "SELECT pruned_at FROM context_nodes WHERE id = 'weekly:grp:old'",
      )
      .get() as any;
    expect(weekly.pruned_at).toBeNull();

    const monthly = svc.db
      .prepare(
        "SELECT pruned_at FROM context_nodes WHERE id = 'monthly:grp:old'",
      )
      .get() as any;
    expect(monthly.pruned_at).toBeNull();

    svc.close();
  });

  it('returns 0 when nothing to prune', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    const pruned = svc.applyRetention();
    expect(pruned).toBe(0);

    svc.close();
  });
});

/* ================================================================== */
/*  vacuum                                                             */
/* ================================================================== */

describe('ContextService — vacuum', () => {
  it('hard-deletes nodes pruned more than 30 days ago', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    const longAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    const nodeId = 'leaf:grp:old-vacuum-test';

    // Insert a pruned node (pruned 40 days ago — exceeds 30-day vacuum threshold)
    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at, pruned_at)
       VALUES (?, 'grp', 0, 'pruned summary', ?, ?, ?, ?)`,
      )
      .run(nodeId, longAgo, longAgo, longAgo, longAgo);

    // Insert a matching session (ON DELETE CASCADE should remove this)
    svc.db
      .prepare(
        `INSERT INTO context_sessions (id, group_folder, messages, created_at, pruned_at)
       VALUES (?, 'grp', '[]', ?, ?)`,
      )
      .run(nodeId, longAgo, longAgo);

    const deleted = svc.vacuum();
    expect(deleted).toBe(1);

    // Node should be gone
    const node = svc.db
      .prepare('SELECT * FROM context_nodes WHERE id = ?')
      .get(nodeId);
    expect(node).toBeUndefined();

    // Session should also be gone (CASCADE)
    const session = svc.db
      .prepare('SELECT * FROM context_sessions WHERE id = ?')
      .get(nodeId);
    expect(session).toBeUndefined();

    svc.close();
  });

  it('does not delete nodes pruned less than 30 days ago', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    const recently = new Date(Date.now() - 10 * 86400000).toISOString();
    const nodeId = 'leaf:grp:recent-prune';

    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at, pruned_at)
       VALUES (?, 'grp', 0, 'recently pruned', ?, ?, ?, ?)`,
      )
      .run(nodeId, recently, recently, recently, recently);

    const deleted = svc.vacuum();
    expect(deleted).toBe(0);

    const node = svc.db
      .prepare('SELECT * FROM context_nodes WHERE id = ?')
      .get(nodeId);
    expect(node).toBeTruthy();

    svc.close();
  });

  it('FTS entry is removed when node is vacuum-deleted', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });

    const longAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    const nodeId = 'leaf:grp:vacuum-fts-test';

    svc.db
      .prepare(
        `INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at, pruned_at)
       VALUES (?, 'grp', 0, 'summary for vacuum FTS test node', ?, ?, ?, ?)`,
      )
      .run(nodeId, longAgo, longAgo, longAgo, longAgo);

    // FTS entry should exist (trigger fires on insert with summary)
    let fts = svc.db
      .prepare('SELECT * FROM context_fts WHERE node_id = ?')
      .get(nodeId);
    expect(fts).toBeTruthy();

    svc.vacuum();

    // FTS entry should be removed (trigger fires on delete)
    fts = svc.db
      .prepare('SELECT * FROM context_fts WHERE node_id = ?')
      .get(nodeId);
    expect(fts).toBeUndefined();

    svc.close();
  });
});

/* ================================================================== */
/*  close()                                                            */
/* ================================================================== */

describe('ContextService — close', () => {
  it('is safe to call multiple times', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: '',
      retainDays: 90,
    });
    svc.close();
    expect(() => svc.close()).not.toThrow();
  });
});
