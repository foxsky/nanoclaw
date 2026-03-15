# Hierarchical Long-Term Context Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every NanoClaw agent access to a compressed, searchable history of its group's past conversations via hierarchical DAG summarization.

**Architecture:** Host-side ContextService writes to `data/context/context.db` (SQLite WAL). Container-side ContextReader mounts the DB read-only for preamble injection and MCP tools. Background ContextSync captures turns from JSONL transcripts and runs DAG compaction (daily → weekly → monthly rollups). Summarization via configurable Ollama or Claude backend.

**Tech Stack:** TypeScript, better-sqlite3, FTS5, Ollama/Claude API, Vitest

**Design Spec:** `docs/plans/2026-03-15-lossless-context-design.md`

---

## Codex Review Findings (must fix during implementation)

The plan was reviewed by Codex (gpt-5.4, high reasoning). These issues must be resolved by the implementing agent:

1. **Cursor must not advance past incomplete turns.** The plan advances cursor to EOF unconditionally. Fix: only advance cursor to the end of the last *complete* turn (user+assistant pair). Store actual `last_assistant_uuid` from the JSONL entry, not the timestamp. Wrap cursor update + leaf/session inserts in a single transaction.

2. **Trigger bootstrap is broken.** Splitting SQL on `;` corrupts multi-statement trigger bodies (BEGIN...END blocks contain `;`). Fix: execute each trigger as a separate `db.exec()` call, not by splitting on `;`. Also, prepared-statement field initializers (`this.db.prepare(...)`) must be called inside the constructor after `this.db` is assigned, not as class field initializers.

3. **Weekly/monthly rollup discovery is stubbed.** The plan leaves comments instead of code. Fix: implement full calendar-boundary logic — find weeks/months that have ended, gather their children, and call rollup. Also implement `topics()` method and `context_topics` MCP tool (not deferred).

4. **Host integration ordering and signature.** Task 9 uses `contextService` in container-runner.ts before Task 10 creates it. Fix: reorder — Task 10 (service init in index.ts) first, then Task 9 (container-runner modifications). Also specify how `contextService` is passed to `runContainerAgent()` — add it as a parameter or use a module-level setter, and update the call site in `runAgent()` (`src/index.ts:454`).

5. **Close-hook insertion point misses branches.** The container close handler has multiple early returns. Fix: place the capture call at the top of the close handler (before any branching), guarded by `if (contextService && newSessionId)`. The capture is fire-and-forget so it's safe even on error paths.

6. **Preamble order is wrong.** `prompt = recap + '\n\n' + prompt` prepends recap before the embedding preamble. Fix: insert recap AFTER the embedding preamble block, so the order is: embedding preamble → conversation recap → user message.

7. **ContextReader API gaps.** `search()` ignores `dateFrom`/`dateTo` params. `recall()` doesn't parse JSON for `messages`/`tool_calls`. `timeline()` returns all levels instead of best-detail. `topics()` is missing. Fix: implement all per the spec's SQL templates and API contract.

8. **Retention not in single transaction.** `applyRetention()` runs two separate UPDATE statements. Fix: wrap in `this.db.transaction()`. Use the spec's lockstep pattern — prune nodes and sessions in one transaction.

9. **Code snippets need cleanup.** Missing `import { vi } from 'vitest'`, placeholder `seedDb()` SQL, uncommented interfaces, `callSummarizer` needs `await` on the return. Fix during implementation — these are typos, not design issues.

10. **Missing test cases.** Add tests for: cursor non-advance on incomplete turns, `compact_boundary` skip, weekly/monthly boundary rollups, preamble budget fallback (3→2→1), search date filtering, `context_topics`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/context-service.ts` | Create | Host-side service: schema, CRUD, summarization, rollups, retention |
| `src/context-sync.ts` | Create | JSONL parsing, incremental cursor capture, background compaction timer |
| `container/agent-runner/src/context-reader.ts` | Create | Container-side read-only reader: search, recall, timeline, topics |
| `src/context-service.test.ts` | Create | Unit tests for ContextService |
| `container/agent-runner/src/context-reader.test.ts` | Create | Unit tests for ContextReader |
| `src/container-runner.ts` | Modify | Add context mount, capture hook on container exit, CORE_AGENT_RUNNER_FILES |
| `src/index.ts` | Modify | Service init, sync timer, shutdown cleanup |
| `container/agent-runner/src/index.ts` | Modify | Context preamble injection |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modify | Register context_search, context_recall (+ progressive tools) |

---

## Chunk 1: ContextService — Schema and Core CRUD

### Task 1: ContextService schema and constructor

**Files:**
- Create: `src/context-service.ts`
- Test: `src/context-service.test.ts`

- [ ] **Step 1: Write the failing test for schema creation**

```typescript
// src/context-service.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import Database from 'better-sqlite3';
import { ContextService } from './context-service.js';

const TEST_DIR = '/tmp/context-service-test';
const TEST_DB = `${TEST_DIR}/context.db`;

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ContextService', () => {
  it('creates schema on instantiation', () => {
    const svc = new ContextService(TEST_DB, {
      summarizer: 'ollama',
      ollamaHost: 'http://localhost:11434',
      retainDays: 90,
    });
    const db = new Database(TEST_DB, { readonly: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('context_cursors');
    expect(tableNames).toContain('context_nodes');
    expect(tableNames).toContain('context_sessions');
    // FTS5 virtual table
    const vtables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'context_fts%'",
    ).all();
    expect(vtables.length).toBeGreaterThanOrEqual(1);
    db.close();
    svc.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context-service.test.ts`
Expected: FAIL — module `./context-service.js` not found

- [ ] **Step 3: Write minimal ContextService with schema**

```typescript
// src/context-service.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface ContextConfig {
  summarizer: 'ollama' | 'claude';
  summarizerModel?: string;
  ollamaHost?: string;
  retainDays: number;
}

export interface SessionMessage {
  sender: string;
  content: string;
  timestamp: string;
}

export interface ToolCallSummary {
  tool: string;
  resultSummary: string;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS context_cursors (
  group_folder  TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  last_entry_index INTEGER NOT NULL DEFAULT 0,
  last_assistant_uuid TEXT,
  updated_at    TEXT NOT NULL
);

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

// FTS triggers must be created separately (CREATE TRIGGER IF NOT EXISTS not supported in all contexts for FTS)
const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS context_fts_insert AFTER INSERT ON context_nodes
  WHEN NEW.summary IS NOT NULL
  BEGIN INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary); END;

CREATE TRIGGER IF NOT EXISTS context_fts_update AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NOT NULL AND OLD.summary IS NOT NULL
  BEGIN
    DELETE FROM context_fts WHERE node_id = OLD.id;
    INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary);
  END;

CREATE TRIGGER IF NOT EXISTS context_fts_first AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NOT NULL AND OLD.summary IS NULL
  BEGIN INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary); END;

CREATE TRIGGER IF NOT EXISTS context_fts_clear AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NULL AND OLD.summary IS NOT NULL
  BEGIN DELETE FROM context_fts WHERE node_id = OLD.id; END;

CREATE TRIGGER IF NOT EXISTS context_fts_delete AFTER DELETE ON context_nodes
  WHEN OLD.summary IS NOT NULL
  BEGIN DELETE FROM context_fts WHERE node_id = OLD.id; END;
`;

export class ContextService {
  readonly db: Database.Database;
  private config: ContextConfig;

  constructor(dbPath: string, config: ContextConfig) {
    this.config = config;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Triggers need to be created statement-by-statement
    for (const stmt of TRIGGERS.split(';').map(s => s.trim()).filter(Boolean)) {
      this.db.exec(stmt + ';');
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* idempotent */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-service.ts src/context-service.test.ts
git commit -m "feat(context): add ContextService schema and constructor"
```

### Task 2: captureNewTurns — leaf node and session creation

**Files:**
- Modify: `src/context-service.ts`
- Test: `src/context-service.test.ts`

- [ ] **Step 1: Write failing test for captureNewTurns**

```typescript
it('creates leaf node and session from captured turn', () => {
  const svc = new ContextService(TEST_DB, {
    summarizer: 'ollama', ollamaHost: '', retainDays: 90,
  });

  const now = new Date().toISOString();
  const count = svc.insertTurn('test-group', 'session-123', {
    userMessage: 'T1 serviço iniciado',
    agentResponse: 'T1 movido para Em Andamento',
    toolCalls: [{ tool: 'taskflow_move', resultSummary: 'ok' }],
    timestamp: now,
  });

  expect(count).toBe(1);

  // Verify leaf node created
  const node = svc.db.prepare(
    "SELECT * FROM context_nodes WHERE group_folder = 'test-group' AND level = 0",
  ).get() as any;
  expect(node).toBeTruthy();
  expect(node.id).toMatch(/^leaf:test-group:/);
  expect(node.summary).toBeNull(); // Not yet summarized

  // Verify session created
  const session = svc.db.prepare(
    "SELECT * FROM context_sessions WHERE group_folder = 'test-group'",
  ).get() as any;
  expect(session).toBeTruthy();
  expect(session.session_id).toBe('session-123');
  expect(JSON.parse(session.messages)).toHaveLength(1);

  svc.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context-service.test.ts`
Expected: FAIL — `svc.insertTurn is not a function`

- [ ] **Step 3: Implement insertTurn**

Add to `ContextService`:

```typescript
export interface CapturedTurn {
  userMessage: string;
  agentResponse: string;
  toolCalls: ToolCallSummary[];
  timestamp: string;
  senderName?: string;
}

// In the class, add prepared statements in constructor:
private stmtInsertNode = this.db.prepare(`
  INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
  VALUES (?, ?, 0, NULL, ?, ?, ?)
`);

private stmtInsertSession = this.db.prepare(`
  INSERT INTO context_sessions (id, group_folder, session_id, messages, agent_response, tool_calls, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

insertTurn(groupFolder: string, sessionId: string, turn: CapturedTurn): number {
  const nodeId = `leaf:${groupFolder}:${turn.timestamp}`;
  const now = new Date().toISOString();
  const messages: SessionMessage[] = [{
    sender: turn.senderName ?? 'user',
    content: turn.userMessage,
    timestamp: turn.timestamp,
  }];

  const txn = this.db.transaction(() => {
    this.stmtInsertNode.run(nodeId, groupFolder, turn.timestamp, turn.timestamp, now);
    this.stmtInsertSession.run(
      nodeId, groupFolder, sessionId,
      JSON.stringify(messages),
      turn.agentResponse,
      JSON.stringify(turn.toolCalls),
      now,
    );
  });
  txn();
  return 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-service.ts src/context-service.test.ts
git commit -m "feat(context): add insertTurn for leaf node + session creation"
```

### Task 3: summarizePending — Ollama/Claude summarization

**Files:**
- Modify: `src/context-service.ts`
- Test: `src/context-service.test.ts`

- [ ] **Step 1: Write failing test for summarizePending**

```typescript
it('summarizes pending leaf nodes', async () => {
  const svc = new ContextService(TEST_DB, {
    summarizer: 'ollama', ollamaHost: 'http://localhost:11434',
    summarizerModel: 'llama3.1', retainDays: 90,
  });

  // Insert a turn (leaf with summary=NULL)
  svc.insertTurn('test-group', 'sess-1', {
    userMessage: 'T1 serviço iniciado dia 15 as 7:00',
    agentResponse: 'T1 movido para Em Andamento, atribuído a Alexandre',
    toolCalls: [{ tool: 'taskflow_move', resultSummary: 'ok' }],
    timestamp: new Date().toISOString(),
  });

  // Mock fetch for Ollama
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ response: 'Alexandre reported T1 progress. Task moved to in-progress.' }),
  });
  global.fetch = mockFetch as any;

  const count = await svc.summarizePending(5);
  expect(count).toBe(1);

  // Verify summary was set
  const node = svc.db.prepare(
    "SELECT summary, token_count, model FROM context_nodes WHERE level = 0",
  ).get() as any;
  expect(node.summary).toBe('Alexandre reported T1 progress. Task moved to in-progress.');
  expect(node.token_count).toBeGreaterThan(0);
  expect(node.model).toBe('llama3.1');

  // Verify FTS was updated
  const fts = svc.db.prepare(
    "SELECT * FROM context_fts WHERE node_id = ?",
  ).get(node.id ?? svc.db.prepare("SELECT id FROM context_nodes WHERE level = 0").get()?.id) as any;
  expect(fts).toBeTruthy();

  svc.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context-service.test.ts`
Expected: FAIL — `svc.summarizePending is not a function`

- [ ] **Step 3: Implement summarizePending**

Add to `ContextService`:

```typescript
private stmtSelectPending = this.db.prepare(`
  SELECT cn.id, cs.messages, cs.agent_response, cs.tool_calls
  FROM context_nodes cn
  JOIN context_sessions cs ON cs.id = cn.id
  WHERE cn.level = 0 AND cn.summary IS NULL
  ORDER BY cn.created_at ASC
  LIMIT ?
`);

private stmtUpdateSummary = this.db.prepare(`
  UPDATE context_nodes SET summary = ?, token_count = ?, model = ? WHERE id = ?
`);

async summarizePending(limit = 5): Promise<number> {
  const pending = this.stmtSelectPending.all(limit) as Array<{
    id: string; messages: string; agent_response: string | null; tool_calls: string | null;
  }>;
  let count = 0;
  for (const row of pending) {
    const messages = JSON.parse(row.messages) as SessionMessage[];
    const userMsg = messages.map(m => m.content).join('\n');
    const tools = row.tool_calls ? JSON.parse(row.tool_calls) as ToolCallSummary[] : [];
    const toolNames = tools.map(t => t.tool).join(', ') || 'none';

    const prompt = `Summarize this conversation turn concisely. Include:
- Who sent the message and what they asked/reported
- What actions the assistant took
- Any decisions made or information exchanged
- Key outcome

User message:
${userMsg}

Assistant response:
${row.agent_response ?? '(no response)'}

Tools called: ${toolNames}

Write a concise summary in the same language as the conversation.`;

    const summary = await this.callSummarizer(prompt);
    if (summary && summary.length > 20) {
      const tokenCount = Math.ceil(summary.length / 3.5);
      const model = this.config.summarizer === 'claude' ? 'haiku-4.5' : (this.config.summarizerModel ?? 'llama3.1');
      this.stmtUpdateSummary.run(summary, tokenCount, model, row.id);
      count++;
    }
  }
  return count;
}

private async callSummarizer(prompt: string): Promise<string | null> {
  try {
    if (this.config.summarizer === 'claude') {
      return this.callClaude(prompt);
    }
    return this.callOllama(prompt);
  } catch {
    return null;
  }
}

private async callOllama(prompt: string): Promise<string | null> {
  if (!this.config.ollamaHost) return null;
  const resp = await fetch(`${this.config.ollamaHost}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: this.config.summarizerModel ?? 'llama3.1',
      prompt,
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as { response?: string };
  return data.response ?? null;
}

private async callClaude(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-service.ts src/context-service.test.ts
git commit -m "feat(context): add summarizePending with Ollama/Claude backend"
```

### Task 4: DAG rollups — daily, weekly, monthly

**Files:**
- Modify: `src/context-service.ts`
- Test: `src/context-service.test.ts`

- [ ] **Step 1: Write failing test for rollupDaily**

```typescript
it('creates daily rollup from leaf summaries', async () => {
  const svc = new ContextService(TEST_DB, {
    summarizer: 'ollama', ollamaHost: 'http://localhost:11434',
    summarizerModel: 'test', retainDays: 90,
  });

  // Insert 2 leaves with summaries for yesterday
  const yesterday = '2026-03-14';
  for (let i = 0; i < 2; i++) {
    const ts = `${yesterday}T${10 + i}:00:00.000Z`;
    const nodeId = `leaf:test-group:${ts}`;
    svc.db.prepare(`INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
      VALUES (?, 'test-group', 0, ?, ?, ?, 20, 'test', ?)`).run(
      nodeId, `Summary ${i}`, ts, ts, new Date().toISOString(),
    );
  }

  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ response: 'Daily summary for March 14.' }),
  });
  global.fetch = mockFetch as any;

  const dailyId = await svc.rollupDaily('test-group', yesterday);
  expect(dailyId).toBe(`daily:test-group:${yesterday}`);

  const daily = svc.db.prepare("SELECT * FROM context_nodes WHERE id = ?").get(dailyId) as any;
  expect(daily.level).toBe(1);
  expect(daily.summary).toBe('Daily summary for March 14.');

  // Verify children linked
  const children = svc.db.prepare("SELECT * FROM context_nodes WHERE parent_id = ?").all(dailyId);
  expect(children).toHaveLength(2);

  svc.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context-service.test.ts`
Expected: FAIL — `svc.rollupDaily is not a function`

- [ ] **Step 3: Implement rollupDaily, rollupWeekly, rollupMonthly**

Add to `ContextService`:

```typescript
async rollupDaily(groupFolder: string, date: string): Promise<string | null> {
  return this.rollup(groupFolder, 0, 1, `daily:${groupFolder}:${date}`, date, date);
}

async rollupWeekly(groupFolder: string, weekStart: string): Promise<string | null> {
  const weekEnd = this.addDays(weekStart, 6);
  const weekLabel = this.isoWeek(weekStart);
  return this.rollup(groupFolder, 1, 2, `weekly:${groupFolder}:${weekLabel}`, weekStart, weekEnd);
}

async rollupMonthly(groupFolder: string, month: string): Promise<string | null> {
  // month is YYYY-MM
  const monthStart = `${month}-01`;
  const monthEnd = this.lastDayOfMonth(month);
  return this.rollup(groupFolder, 2, 3, `monthly:${groupFolder}:${month}`, monthStart, monthEnd);
}

private async rollup(
  groupFolder: string, childLevel: number, parentLevel: number,
  parentId: string, rangeStart: string, rangeEnd: string,
): Promise<string | null> {
  // Check if rollup already exists
  const existing = this.db.prepare("SELECT id FROM context_nodes WHERE id = ?").get(parentId);
  if (existing) return null;

  // Get children
  const children = this.db.prepare(`
    SELECT id, summary FROM context_nodes
    WHERE group_folder = ? AND level = ? AND parent_id IS NULL
      AND time_start >= ? AND time_start <= ? || 'T23:59:59.999Z'
      AND summary IS NOT NULL AND pruned_at IS NULL
    ORDER BY time_start ASC
  `).all(groupFolder, childLevel, rangeStart, rangeEnd) as Array<{ id: string; summary: string }>;

  if (children.length === 0) return null;

  const levelName = parentLevel === 1 ? 'day' : parentLevel === 2 ? 'week' : 'month';
  const combinedSummaries = children.map(c => c.summary).join('\n\n');
  const prompt = this.rollupPrompt(levelName, combinedSummaries);
  const summary = await this.callSummarizer(prompt);
  if (!summary || summary.length <= 20) return null;

  const now = new Date().toISOString();
  const tokenCount = Math.ceil(summary.length / 3.5);
  const model = this.config.summarizer === 'claude' ? 'haiku-4.5' : (this.config.summarizerModel ?? 'llama3.1');

  this.db.transaction(() => {
    this.db.prepare(`
      INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(parentId, groupFolder, parentLevel, summary, rangeStart, rangeEnd + 'T23:59:59.999Z', tokenCount, model, now);

    const updateParent = this.db.prepare("UPDATE context_nodes SET parent_id = ? WHERE id = ?");
    for (const child of children) {
      updateParent.run(parentId, child.id);
    }
  })();

  return parentId;
}

private rollupPrompt(level: string, summaries: string): string {
  const instructions: Record<string, string> = {
    day: `Summarize the day's activity from these session summaries. Group by theme, not chronologically. Highlight:
- Tasks created, completed, or moved
- Key decisions and their rationale
- Open questions or pending items
- Notable interactions`,
    week: `Summarize the week's activity from these daily summaries. Focus on:
- Overall progress and velocity
- Key accomplishments
- Recurring themes or blockers
- Status changes across the week`,
    month: `Summarize the month's activity from these weekly summaries. Capture:
- Major milestones and deliverables
- Trends and patterns
- Strategic decisions
- State at month-end`,
  };
  return `${instructions[level] ?? instructions.day}

${summaries}

Write a concise summary in the same language as the sessions.`;
}

private addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

private isoWeek(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

private lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-service.ts src/context-service.test.ts
git commit -m "feat(context): add DAG rollups — daily, weekly, monthly"
```

### Task 5: Retention and vacuum

**Files:**
- Modify: `src/context-service.ts`
- Test: `src/context-service.test.ts`

- [ ] **Step 1: Write failing test for retention**

```typescript
it('soft-deletes leaves and dailies older than retainDays', () => {
  const svc = new ContextService(TEST_DB, {
    summarizer: 'ollama', ollamaHost: '', retainDays: 90,
  });

  // Insert old leaf (100 days ago)
  const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
  const nodeId = `leaf:test-group:${oldDate}`;
  svc.db.prepare(`INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
    VALUES (?, 'test-group', 0, 'old summary', ?, ?, ?)`).run(nodeId, oldDate, oldDate, oldDate);
  svc.db.prepare(`INSERT INTO context_sessions (id, group_folder, messages, created_at)
    VALUES (?, 'test-group', '[]', ?)`).run(nodeId, oldDate);

  const pruned = svc.applyRetention();
  expect(pruned).toBe(1);

  const node = svc.db.prepare("SELECT pruned_at FROM context_nodes WHERE id = ?").get(nodeId) as any;
  expect(node.pruned_at).toBeTruthy();

  svc.close();
});
```

- [ ] **Step 2: Run test, verify failure, implement, verify pass**

Add to `ContextService`:

```typescript
applyRetention(): number {
  const cutoff = new Date(Date.now() - this.config.retainDays * 86400000).toISOString();
  const now = new Date().toISOString();
  const result = this.db.prepare(`
    UPDATE context_nodes SET pruned_at = ?
    WHERE pruned_at IS NULL AND level <= 1 AND created_at < ?
  `).run(now, cutoff);
  // Also prune matching sessions
  this.db.prepare(`
    UPDATE context_sessions SET pruned_at = ?
    WHERE pruned_at IS NULL AND id IN (
      SELECT id FROM context_nodes WHERE pruned_at IS NOT NULL AND level = 0
    )
  `).run(now);
  return result.changes;
}

vacuum(): number {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const result = this.db.prepare(
    "DELETE FROM context_nodes WHERE pruned_at IS NOT NULL AND pruned_at < ?",
  ).run(cutoff);
  return result.changes;
}
```

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run src/context-service.test.ts`

```bash
git add src/context-service.ts src/context-service.test.ts
git commit -m "feat(context): add retention and vacuum"
```

---

## Chunk 2: ContextSync — JSONL Parsing and Background Compaction

### Task 6: JSONL transcript parser

**Files:**
- Create: `src/context-sync.ts`
- Test: `src/context-service.test.ts` (reuse)

- [ ] **Step 1: Write failing test for JSONL parsing**

```typescript
// In context-service.test.ts or a new context-sync.test.ts
import { parseTurnsFromJsonl } from './context-sync.js';

it('extracts turns from JSONL entries', () => {
  const entries = [
    { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-03-15T10:00:00Z' },
    { type: 'user', message: { role: 'user', content: 'T1 serviço iniciado' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'T1 movido para Em Andamento' },
      { type: 'tool_use', name: 'taskflow_move' },
    ]}},
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: '1', content: 'ok' },
    ]}},
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Pronto, T1 atualizado.' },
    ]}},
  ];

  const turns = parseTurnsFromJsonl(entries, 0);
  expect(turns).toHaveLength(1);
  expect(turns[0].userMessage).toContain('T1 serviço iniciado');
  expect(turns[0].agentResponse).toContain('Pronto, T1 atualizado');
  expect(turns[0].toolCalls).toHaveLength(1);
  expect(turns[0].toolCalls[0].tool).toBe('taskflow_move');
});
```

- [ ] **Step 2: Implement parseTurnsFromJsonl**

```typescript
// src/context-sync.ts
import { CapturedTurn, ToolCallSummary } from './context-service.js';

export interface JsonlEntry {
  type: string;
  operation?: string;
  timestamp?: string;
  subtype?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; name?: string; content?: string; tool_use_id?: string }>;
  };
}

export function parseTurnsFromJsonl(entries: JsonlEntry[], startIndex: number): Array<CapturedTurn & { endIndex: number }> {
  const turns: Array<CapturedTurn & { endIndex: number }> = [];
  let currentTurn: Partial<CapturedTurn> & { tools: ToolCallSummary[]; startIdx: number } | null = null;
  let skipNextUser = false; // For compact_boundary

  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];

    // Skip non-relevant types
    if (entry.type !== 'user' && entry.type !== 'assistant' && entry.type !== 'queue-operation' && entry.type !== 'system') {
      continue;
    }

    // Detect compact_boundary — skip the next user entry
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      skipNextUser = true;
      continue;
    }

    // queue-operation dequeue = turn boundary
    if (entry.type === 'queue-operation' && entry.operation === 'dequeue') {
      // Finalize previous turn if complete
      if (currentTurn?.userMessage && currentTurn?.agentResponse) {
        turns.push({
          userMessage: currentTurn.userMessage,
          agentResponse: currentTurn.agentResponse,
          toolCalls: currentTurn.tools,
          timestamp: currentTurn.timestamp!,
          endIndex: i - 1,
        });
      }
      currentTurn = { tools: [], startIdx: i, timestamp: entry.timestamp ?? new Date().toISOString() };
      continue;
    }

    if (entry.type === 'user' && entry.message) {
      if (skipNextUser) { skipNextUser = false; continue; }

      const content = entry.message.content;
      if (typeof content === 'string') {
        // Could be a real user message or compaction summary — check for compaction prefix
        if (content.startsWith('This session is being continued from a previous conversation')) {
          continue; // Skip compaction summary
        }
        // New turn start (fallback when no dequeue)
        if (currentTurn?.userMessage && currentTurn?.agentResponse) {
          turns.push({
            userMessage: currentTurn.userMessage,
            agentResponse: currentTurn.agentResponse,
            toolCalls: currentTurn.tools,
            timestamp: currentTurn.timestamp!,
            endIndex: i - 1,
          });
        }
        currentTurn = { userMessage: content, tools: [], startIdx: i, timestamp: new Date().toISOString() };
      } else if (Array.isArray(content)) {
        const hasNonToolResult = content.some(b => b.type !== 'tool_result');
        if (hasNonToolResult) {
          // New turn — extract text blocks
          if (currentTurn?.userMessage && currentTurn?.agentResponse) {
            turns.push({
              userMessage: currentTurn.userMessage,
              agentResponse: currentTurn.agentResponse,
              toolCalls: currentTurn.tools,
              timestamp: currentTurn.timestamp!,
              endIndex: i - 1,
            });
          }
          const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          currentTurn = { userMessage: text, tools: [], startIdx: i, timestamp: new Date().toISOString() };
        } else {
          // Tool results — part of current turn
          for (const block of content) {
            if (block.type === 'tool_result' && currentTurn) {
              currentTurn.tools.push({
                tool: block.tool_use_id ?? 'unknown',
                resultSummary: (block.content ?? '').slice(0, 200),
              });
            }
          }
        }
      }
    }

    if (entry.type === 'assistant' && entry.message) {
      const content = entry.message.content;
      if (Array.isArray(content) && currentTurn) {
        const textBlocks = content.filter(b => b.type === 'text').map(b => b.text ?? '');
        const toolUseBlocks = content.filter(b => b.type === 'tool_use');

        if (textBlocks.length > 0) {
          currentTurn.agentResponse = textBlocks.join('\n');
        }
        for (const tu of toolUseBlocks) {
          currentTurn.tools.push({ tool: tu.name ?? 'unknown', resultSummary: '' });
        }
      }
    }
  }

  // Finalize last turn
  if (currentTurn?.userMessage && currentTurn?.agentResponse) {
    turns.push({
      userMessage: currentTurn.userMessage,
      agentResponse: currentTurn.agentResponse,
      toolCalls: currentTurn.tools,
      timestamp: currentTurn.timestamp!,
      endIndex: entries.length - 1,
    });
  }

  return turns;
}
```

- [ ] **Step 3: Run test, verify pass, commit**

```bash
git add src/context-sync.ts src/context-service.test.ts
git commit -m "feat(context): add JSONL transcript parser with turn detection"
```

### Task 7: captureAgentTurn and startContextSync

**Files:**
- Modify: `src/context-sync.ts`
- Test: `src/context-service.test.ts`

- [ ] **Step 1: Implement captureAgentTurn (reads JSONL, uses cursor)**

```typescript
// Add to context-sync.ts
import fs from 'fs';
import path from 'path';
import { ContextService } from './context-service.js';
import { logger } from './logger.js';

const DATA_DIR = process.env.DATA_DIR ?? 'data';

function jsonlPath(groupFolder: string, sessionId: string): string {
  return path.join(DATA_DIR, 'sessions', groupFolder, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`);
}

export async function captureAgentTurn(
  service: ContextService,
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  try {
    const filePath = jsonlPath(groupFolder, sessionId);
    if (!fs.existsSync(filePath)) return;

    // Read cursor
    const cursor = service.db.prepare(
      "SELECT session_id, last_entry_index FROM context_cursors WHERE group_folder = ?",
    ).get(groupFolder) as { session_id: string; last_entry_index: number } | undefined;

    let startIndex = 0;
    if (cursor) {
      if (cursor.session_id === sessionId) {
        startIndex = cursor.last_entry_index;
      }
      // else: session changed, reset to 0
    }

    // Read JSONL
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    if (startIndex >= lines.length) return;

    const entries: JsonlEntry[] = [];
    for (let i = startIndex; i < lines.length; i++) {
      try { entries.push(JSON.parse(lines[i])); } catch { /* skip malformed */ }
    }

    const turns = parseTurnsFromJsonl(entries, 0);
    if (turns.length === 0) return;

    for (const turn of turns) {
      service.insertTurn(groupFolder, sessionId, turn);
    }

    // Update cursor
    const newIndex = startIndex + entries.length;
    const lastUuid = turns[turns.length - 1].timestamp; // best-effort
    const now = new Date().toISOString();
    service.db.prepare(`
      INSERT INTO context_cursors (group_folder, session_id, last_entry_index, last_assistant_uuid, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_folder) DO UPDATE SET
        session_id = excluded.session_id,
        last_entry_index = excluded.last_entry_index,
        last_assistant_uuid = excluded.last_assistant_uuid,
        updated_at = excluded.updated_at
    `).run(groupFolder, sessionId, newIndex, lastUuid, now);

    logger.info({ groupFolder, turns: turns.length }, 'Captured agent turns');
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Context capture failed');
  }
}
```

- [ ] **Step 2: Implement startContextSync (60s compaction timer)**

```typescript
export function startContextSync(service: ContextService): NodeJS.Timeout {
  let lastVacuum = 0;

  const cycle = async () => {
    try {
      await service.summarizePending(5);

      // Discover groups
      const groups = service.db.prepare(
        "SELECT DISTINCT group_folder FROM context_cursors",
      ).all() as { group_folder: string }[];

      const today = new Date().toISOString().slice(0, 10);
      const now = new Date();

      for (const { group_folder } of groups) {
        // Daily rollups for completed days
        const pendingDays = service.db.prepare(`
          SELECT DISTINCT substr(time_start, 1, 10) as day FROM context_nodes
          WHERE group_folder = ? AND level = 0 AND parent_id IS NULL
            AND summary IS NOT NULL AND pruned_at IS NULL
            AND substr(time_start, 1, 10) < ?
        `).all(group_folder, today) as { day: string }[];

        for (const { day } of pendingDays) {
          await service.rollupDaily(group_folder, day);
        }

        // Weekly rollups for completed weeks
        // (similar pattern — find weeks where all dailies exist and week has ended)
        // ... (implement based on calendar boundary check)

        // Monthly rollups for completed months
        // ... (similar)
      }

      service.applyRetention();

      // Vacuum once per day
      if (Date.now() - lastVacuum > 86400000) {
        service.vacuum();
        lastVacuum = Date.now();
      }
    } catch (err) {
      logger.warn({ err }, 'Context sync cycle failed');
    }
  };

  // Run first cycle after 30s delay (let startup complete)
  setTimeout(cycle, 30_000);
  return setInterval(cycle, 60_000);
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/context-sync.ts
git commit -m "feat(context): add captureAgentTurn and startContextSync"
```

---

## Chunk 3: ContextReader — Container-Side Read-Only Client

### Task 8: ContextReader with search, recall, preamble methods

**Files:**
- Create: `container/agent-runner/src/context-reader.ts`
- Create: `container/agent-runner/src/context-reader.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// container/agent-runner/src/context-reader.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import Database from 'better-sqlite3';
import { ContextReader } from './context-reader.js';

const TEST_DIR = '/tmp/context-reader-test';
const TEST_DB = `${TEST_DIR}/context.db`;

function seedDb(): Database.Database {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(TEST_DB);
  db.pragma('foreign_keys = ON');
  // Create schema (same as context-service)
  db.exec(`CREATE TABLE context_nodes (...)`); // full schema
  db.exec(`CREATE TABLE context_sessions (...)`);
  db.exec(`CREATE VIRTUAL TABLE context_fts USING fts5(node_id UNINDEXED, group_folder UNINDEXED, summary)`);
  // Insert test data
  db.prepare(`INSERT INTO context_nodes VALUES (?, ?, 0, ?, ?, ?, NULL, 20, 'test', ?, NULL)`)
    .run('leaf:grp:2026-03-15T10:00', 'grp', 'Alexandre reported T1 progress', '2026-03-15T10:00', '2026-03-15T10:00', new Date().toISOString());
  db.prepare(`INSERT INTO context_fts VALUES (?, ?, ?)`)
    .run('leaf:grp:2026-03-15T10:00', 'grp', 'Alexandre reported T1 progress');
  return db;
}

afterEach(() => { fs.rmSync(TEST_DIR, { recursive: true, force: true }); });

describe('ContextReader', () => {
  it('returns empty for non-existent DB', () => {
    const reader = new ContextReader('/nonexistent/context.db');
    expect(reader.getRecentSummaries('grp', 3)).toEqual([]);
    expect(reader.search('grp', 'test')).toEqual([]);
    reader.close();
  });

  it('searches summaries via FTS5', () => {
    const db = seedDb();
    db.close();
    const reader = new ContextReader(TEST_DB);
    const results = reader.search('grp', 'Alexandre');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].summary).toContain('Alexandre');
    reader.close();
  });

  it('enforces group isolation on recall', () => {
    const db = seedDb();
    db.close();
    const reader = new ContextReader(TEST_DB);
    // Try to recall with wrong group
    const result = reader.recall('other-group', 'leaf:grp:2026-03-15T10:00');
    expect(result).toBeNull();
    reader.close();
  });
});
```

- [ ] **Step 2: Implement ContextReader**

```typescript
// container/agent-runner/src/context-reader.ts
import Database from 'better-sqlite3';
import fs from 'fs';

export interface ContextNode { /* same as spec */ }
export interface ContextSession { /* same as spec */ }

export class ContextReader {
  private db: Database.Database | null = null;

  constructor(dbPath: string) {
    try {
      if (!fs.existsSync(dbPath)) return;
      this.db = new Database(dbPath, { readonly: true });
      this.db.pragma('busy_timeout = 5000');
    } catch {
      this.db = null;
    }
  }

  getRecentSummaries(group: string, limit: number): ContextNode[] {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT * FROM context_nodes
      WHERE group_folder = ? AND level = 0 AND summary IS NOT NULL AND pruned_at IS NULL
      ORDER BY time_start DESC LIMIT ?
    `).all(group, limit) as ContextNode[];
  }

  search(group: string, query: string, options?: { dateFrom?: string; dateTo?: string; limit?: number }): ContextNode[] {
    if (!this.db) return [];
    const limit = options?.limit ?? 10;
    return this.db.prepare(`
      SELECT cn.* FROM context_fts cf
      JOIN context_nodes cn ON cn.id = cf.node_id
      WHERE context_fts MATCH ? AND cf.group_folder = ? AND cn.pruned_at IS NULL
      ORDER BY rank LIMIT ?
    `).all(query, group, limit) as ContextNode[];
  }

  recall(group: string, nodeId: string): { summary: ContextNode; sessions: ContextSession[]; children: ContextNode[]; detail_pruned: boolean } | null {
    if (!this.db) return null;
    const node = this.db.prepare(
      "SELECT * FROM context_nodes WHERE id = ? AND group_folder = ? AND pruned_at IS NULL",
    ).get(nodeId, group) as ContextNode | undefined;
    if (!node) return null;

    const sessions = this.db.prepare(
      "SELECT * FROM context_sessions WHERE id = ? AND group_folder = ? AND pruned_at IS NULL",
    ).all(nodeId, group) as ContextSession[];

    const children = this.db.prepare(
      "SELECT * FROM context_nodes WHERE parent_id = ? AND group_folder = ? AND pruned_at IS NULL",
    ).all(nodeId, group) as ContextNode[];

    const allChildrenPruned = node.level > 0 && children.length === 0 && sessions.length === 0;

    return { summary: node, sessions, children, detail_pruned: allChildrenPruned };
  }

  timeline(group: string, dateFrom: string, dateTo: string): ContextNode[] {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT * FROM context_nodes
      WHERE group_folder = ? AND time_start >= ? AND time_end <= ? AND pruned_at IS NULL
      ORDER BY level DESC, time_start ASC
    `).all(group, dateFrom, dateTo + 'T23:59:59.999Z') as ContextNode[];
  }

  getNodeCount(group: string): number {
    if (!this.db) return 0;
    return (this.db.prepare("SELECT COUNT(*) as c FROM context_nodes WHERE group_folder = ? AND pruned_at IS NULL").get(group) as { c: number }).c;
  }

  close(): void {
    try { this.db?.close(); } catch { /* idempotent */ }
    this.db = null;
  }
}
```

- [ ] **Step 3: Run tests, commit**

```bash
npx vitest run container/agent-runner/src/context-reader.test.ts
git add container/agent-runner/src/context-reader.ts container/agent-runner/src/context-reader.test.ts
git commit -m "feat(context): add ContextReader with search, recall, group isolation"
```

---

## Chunk 4: Host Integration — container-runner.ts and index.ts

### Task 9: Container runner — mount, capture hook, CORE_AGENT_RUNNER_FILES

**Files:**
- Modify: `src/container-runner.ts:76-84` (add to CORE_AGENT_RUNNER_FILES)
- Modify: `src/container-runner.ts:221-228` (add context mount)
- Modify: `src/container-runner.ts:627+` (add capture hook on close)

- [ ] **Step 1: Add `context-reader.ts` to CORE_AGENT_RUNNER_FILES**

In `src/container-runner.ts`, find the `CORE_AGENT_RUNNER_FILES` array (~line 76) and add:

```typescript
const CORE_AGENT_RUNNER_FILES = [
  'index.ts',
  'ipc-mcp-stdio.ts',
  'ipc-tooling.ts',
  'runtime-config.ts',
  'taskflow-engine.ts',
  'embedding-reader.ts',
  'context-reader.ts',         // <-- add this
  path.join('mcp-plugins', 'create-group.ts'),
] as const;
```

- [ ] **Step 2: Add context directory mount**

Near the embeddings mount (~line 221), add:

```typescript
// --- add-long-term-context skill ---
const contextDir = path.join(DATA_DIR, 'context');
fs.mkdirSync(contextDir, { recursive: true });
mounts.push({
  hostPath: contextDir,
  containerPath: '/workspace/context',
  readonly: true,
});
```

- [ ] **Step 3: Add capture hook in container on('close') handler**

In the `container.on('close')` handler (~line 627), after successful output parsing, add:

```typescript
// --- add-long-term-context skill: capture turns on container exit ---
if (contextService && newSessionId) {
  captureAgentTurn(contextService, group.folder, newSessionId).catch(() => {});
}
```

Note: `contextService` is passed from `index.ts` via a module-level reference or parameter.

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(context): add mount, capture hook, and core file sync"
```

### Task 10: Host startup — service init, sync timer, shutdown

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add context service initialization**

After the `// --- add-embeddings skill ---` block (~line 734), add:

```typescript
// --- add-long-term-context skill ---
let contextService: ContextService | null = null;
let contextSyncTimer: ReturnType<typeof setInterval> | null = null;
{
  const { readEnvFile: readEnv } = await import('./env.js');
  const ctxEnv = readEnv(['OLLAMA_HOST', 'CONTEXT_SUMMARIZER', 'CONTEXT_SUMMARIZER_MODEL', 'CONTEXT_RETAIN_DAYS']);
  const { ContextService } = await import('./context-service.js');
  const { startContextSync } = await import('./context-sync.js');

  contextService = new ContextService(
    path.join(DATA_DIR, 'context', 'context.db'),
    {
      summarizer: (ctxEnv.CONTEXT_SUMMARIZER as 'ollama' | 'claude') || 'ollama',
      summarizerModel: ctxEnv.CONTEXT_SUMMARIZER_MODEL,
      ollamaHost: ctxEnv.OLLAMA_HOST,
      retainDays: parseInt(ctxEnv.CONTEXT_RETAIN_DAYS || '90'),
    },
  );
  contextSyncTimer = startContextSync(contextService);
  logger.info('Long-term context service started');
}
```

- [ ] **Step 2: Add shutdown cleanup**

In the `shutdown` function (~line 760), add before existing cleanup:

```typescript
if (contextSyncTimer) clearInterval(contextSyncTimer);
contextService?.close();
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(context): add host startup init and shutdown cleanup"
```

---

## Chunk 5: Container Integration — Preamble and MCP Tools

### Task 11: Context preamble injection

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Add preamble injection after embedding preamble**

After the embedding preamble block (~line 601), add:

```typescript
// --- add-long-term-context skill: conversation recap preamble ---
try {
  const { ContextReader } = await import('./context-reader.js');
  const ctxReader = new ContextReader('/workspace/context/context.db');
  try {
    const recents = ctxReader.getRecentSummaries(containerInput.groupFolder, 3);
    if (recents.length > 0) {
      let budget = 1024;
      const selected: typeof recents = [];
      for (const node of recents) {
        const cost = node.token_count ?? Math.ceil((node.summary?.length ?? 0) / 3.5);
        if (budget - cost < 0 && selected.length > 0) break;
        selected.push(node);
        budget -= cost;
      }
      if (selected.length > 0) {
        const lines = selected.reverse().map(n => {
          const d = new Date(n.time_start);
          const dateStr = d.toLocaleDateString('pt-BR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return `[${dateStr}] ${n.summary}`;
        });
        const recap = `--- Recent conversation history ---\n${lines.join('\n')}\n---`;
        prompt = recap + '\n\n' + prompt;
        log(`Context recap injected (${selected.length} summaries, ${recap.length} chars)`);
      }
    }
  } finally {
    ctxReader.close();
  }
} catch (err) {
  log(`Context recap skipped: ${err}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(context): inject conversation recap preamble"
```

### Task 12: MCP tools — context_search, context_recall, progressive unlock

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Register context_search and context_recall tools**

After existing tool registrations, add:

```typescript
// --- add-long-term-context skill: MCP retrieval tools ---
{
  const { ContextReader } = await import('./context-reader.js');
  const ctxReader = new ContextReader('/workspace/context/context.db');

  server.tool(
    'context_search',
    'Search conversation history for this group. Returns summaries matching the query.',
    {
      query: z.string().describe('Search terms (keywords, names, task IDs)'),
      date_from: z.string().optional().describe('ISO date, e.g. 2026-03-01'),
      date_to: z.string().optional().describe('ISO date, e.g. 2026-03-15'),
      limit: z.number().optional().default(10),
    },
    async (args) => {
      const results = ctxReader.search(groupFolder, args.query, {
        dateFrom: args.date_from, dateTo: args.date_to, limit: args.limit,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results.map(r => ({
          node_id: r.id, summary: r.summary, date: r.time_start, level: r.level,
        })), null, 2) }],
      };
    },
  );

  server.tool(
    'context_recall',
    'Expand a summary to see original session messages. Use after context_search to get details.',
    {
      node_id: z.string().describe('Node ID from context_search results'),
    },
    async (args) => {
      const result = ctxReader.recall(groupFolder, args.node_id);
      if (!result) {
        return { content: [{ type: 'text' as const, text: 'Node not found or access denied.' }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // Progressive unlock: timeline + topics at >50 nodes
  const nodeCount = ctxReader.getNodeCount(groupFolder);
  if (nodeCount > 50) {
    server.tool(
      'context_timeline',
      'Chronological summary list for a date range. Auto-selects best detail level.',
      {
        date_from: z.string().describe('Start date'),
        date_to: z.string().describe('End date'),
      },
      async (args) => {
        const results = ctxReader.timeline(groupFolder, args.date_from, args.date_to);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      },
    );

    // context_topics — deferred until topics() is fully implemented
  }

  // Cleanup on process exit
  process.on('exit', () => ctxReader.close());
}
```

- [ ] **Step 2: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(context): register MCP tools — context_search, context_recall, progressive unlock"
```

---

## Chunk 6: Skill Packaging and Final Verification

### Task 13: Create skill structure

**Files:**
- Create: `.claude/skills/add-long-term-context/SKILL.md`
- Create: `.claude/skills/add-long-term-context/manifest.yaml`

- [ ] **Step 1: Create SKILL.md**

```markdown
---
name: add-long-term-context
description: Hierarchical long-term context for NanoClaw agents — DAG summarization, FTS5 search, incremental turn capture
version: 1.0.0
type: structured
---

# Long-Term Context

Gives every NanoClaw agent access to compressed, searchable conversation history via hierarchical DAG summarization.

## What It Does

- Captures each agent turn incrementally from JSONL transcripts
- Summarizes turns via Ollama (default) or Claude Haiku
- Rolls up into daily → weekly → monthly summaries
- Injects a brief conversation recap into each agent session
- Provides `context_search` and `context_recall` MCP tools for deeper exploration
```

- [ ] **Step 2: Create manifest.yaml**

```yaml
name: add-long-term-context
description: Hierarchical long-term context via DAG summarization
version: 1.0.0

adds:
  - src/context-service.ts
  - src/context-sync.ts
  - container/agent-runner/src/context-reader.ts
  - src/context-service.test.ts
  - container/agent-runner/src/context-reader.test.ts

modifies:
  - src/container-runner.ts
  - src/index.ts
  - container/agent-runner/src/index.ts
  - container/agent-runner/src/ipc-mcp-stdio.ts
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-long-term-context/
git commit -m "feat(context): add skill packaging — SKILL.md and manifest.yaml"
```

### Task 14: Build, rebuild container, E2E smoke test

- [ ] **Step 1: Build TypeScript**

```bash
npm run build
```

- [ ] **Step 2: Rebuild container**

```bash
./container/build.sh
```

- [ ] **Step 3: Add .env configuration**

```bash
echo '# Long-Term Context' >> .env
echo 'CONTEXT_SUMMARIZER=ollama' >> .env
echo 'CONTEXT_SUMMARIZER_MODEL=llama3.1' >> .env
echo 'CONTEXT_RETAIN_DAYS=90' >> .env
```

- [ ] **Step 4: Run unit tests**

```bash
npx vitest run src/context-service.test.ts
npx vitest run container/agent-runner/src/context-reader.test.ts
```

- [ ] **Step 5: Restart service and verify**

```bash
systemctl restart nanoclaw
sleep 10
# Check logs for "Long-term context service started"
tail -50 logs/nanoclaw.log | grep -i context
# Check DB was created
ls -la data/context/context.db
```

- [ ] **Step 6: Final commit**

```bash
git add .env
git commit -m "feat(context): add .env configuration for long-term context"
```
