# Add-Embeddings Skill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `add-embeddings` skill — a generic embedding service powered by BGE-M3 via Ollama. This plan covers only the generic service. TaskFlow integration (search, duplicate detection, context preamble) is in a separate plan.

**Architecture:** Background indexer on host writes vectors to `data/embeddings/embeddings.db`. Containers read pre-computed vectors via read-only mount at `/workspace/embeddings/`.

**Companion plan:** `docs/plans/2026-03-14-taskflow-embeddings-integration.md` (execute after this one)

**Tech Stack:** TypeScript, SQLite (better-sqlite3, WAL mode), Ollama REST API (native fetch), cosine similarity (pure JS)

**Spec:** `docs/plans/2026-03-14-semantic-embeddings-design.md`

---

## File Map

### Ownership

All files are implemented together for the MVP, but ownership determines which skill is responsible for future maintenance.

### New files — add-embeddings skill
| File | Responsibility |
|------|---------------|
| `src/embedding-service.ts` | Generic embedding service (host, read-write). Schema creation, index(), indexer loop, getCollections(), getItemIds(), remove(). |
| `src/embedding-service.test.ts` | Tests for EmbeddingService — schema creation, index idempotency, indexer cycle, model switch, stale cleanup |
| `container/agent-runner/src/embedding-reader.ts` | Read-only embedding query client (container). Opens DB readonly, cosine similarity, search(), findSimilar(). Graceful fallback on missing DB. |

### New files — add-taskflow skill
| File | Responsibility |
|------|---------------|
| `src/taskflow-embedding-sync.ts` | TaskFlow adapter — polls taskflow.db, feeds EmbeddingService, cleans stale embeddings. Knows about TaskFlow tables. |

### Modified files — add-embeddings skill
| File | Changes |
|------|---------|
| `src/container-runner.ts:45-58` | Add `queryVector?`, `ollamaHost?`, `embeddingModel?` to `ContainerInput`. Read `OLLAMA_HOST`/`EMBEDDING_MODEL` via `readEnvFile()`. Add `-e` flags in `buildContainerArgs()`. Add embeddings mount. (queryVector is set by TaskFlow integration plan, not here.) |
| `src/index.ts:393-486` | Instantiate `EmbeddingService` at startup, call `startIndexer()`. |
| `container/agent-runner/src/runtime-config.ts:1-15,40-65` | Add `queryVector?`, `ollamaHost?`, `embeddingModel?` to `ContainerInput`. Add `NANOCLAW_OLLAMA_HOST`, `NANOCLAW_EMBEDDING_MODEL` to `buildNanoclawMcpEnv()`. |

### Modified files — add-taskflow skill
| File | Changes |
|------|---------|
| `src/index.ts:393-486` | Wire `startTaskflowEmbeddingSync()` call (TaskFlow-specific, alongside generic service startup). |
| `container/agent-runner/src/index.ts:540-570` | Read `queryVector` from `containerInput`. Build context preamble via `engine.buildContextSummary()`. Prepend to prompt. |
| `container/agent-runner/src/ipc-mcp-stdio.ts:574-635` | Wrap `taskflow_query` search with async Ollama embed call. Wrap `taskflow_create` with duplicate detection. Add `force_create` to Zod schema. |
| `container/agent-runner/src/taskflow-engine.ts:15-24,4816-4835` | Add `query_vector` to `QueryParams`. Enhance `search` case with semantic ranking. Add `buildContextSummary()` method. |

### Skill packaging files
| File | Owner | Purpose |
|------|-------|---------|
| `.claude/skills/add-embeddings/SKILL.md` | add-embeddings | Installation instructions (4 phases) |
| `.claude/skills/add-embeddings/manifest.yaml` | add-embeddings | Metadata, file lists (generic files only) |

---

## Chunk 1: Core Embedding Service + Tests (add-embeddings)

### Task 1: EmbeddingService — schema, index(), indexer

**Files:**
- Create: `src/embedding-service.ts`
- Create: `src/embedding-service.test.ts`

- [ ] **Step 1: Write failing test — schema auto-creation**

```typescript
// src/embedding-service.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EmbeddingService } from './embedding-service.js';

const TEST_DB_DIR = path.join(__dirname, '..', 'test-embeddings');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'embeddings.db');

afterEach(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('EmbeddingService', () => {
  it('creates schema on instantiation', () => {
    const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
    // DB should exist and have the embeddings table
    const tables = svc.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'"
    ).all();
    expect(tables).toHaveLength(1);
    svc.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: FAIL — `Cannot find module './embedding-service.js'`

- [ ] **Step 3: Write EmbeddingService — constructor, schema, close()**

```typescript
// src/embedding-service.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS embeddings (
  collection TEXT NOT NULL,
  item_id TEXT NOT NULL,
  vector BLOB,
  source_text TEXT NOT NULL,
  model TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, item_id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_collection ON embeddings(collection);
CREATE INDEX IF NOT EXISTS idx_embeddings_pending ON embeddings(collection) WHERE vector IS NULL;
`;

export class EmbeddingService {
  readonly db: Database.Database;
  private readonly ollamaHost: string;
  private readonly model: string;
  private indexerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath: string, ollamaHost: string, model: string) {
    this.ollamaHost = ollamaHost;
    this.model = model;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.stopIndexer();
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test — index() compare-before-write**

```typescript
it('index() inserts new item with vector = NULL', () => {
  const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
  svc.index('tasks:board-1', 'T1', 'Fix the login bug');
  const row = svc.db.prepare(
    'SELECT * FROM embeddings WHERE collection = ? AND item_id = ?'
  ).get('tasks:board-1', 'T1') as any;
  expect(row).toBeDefined();
  expect(row.source_text).toBe('Fix the login bug');
  expect(row.model).toBe('test-model');
  expect(row.vector).toBeNull(); // pending
  svc.close();
});

it('index() skips write when source_text and model unchanged', () => {
  const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
  svc.index('tasks:board-1', 'T1', 'Fix the login bug');
  // Simulate indexer setting the vector
  svc.db.prepare(
    'UPDATE embeddings SET vector = ? WHERE collection = ? AND item_id = ?'
  ).run(Buffer.from(new Float32Array([1, 2, 3]).buffer), 'tasks:board-1', 'T1');
  // Re-index with same text — should NOT null the vector
  svc.index('tasks:board-1', 'T1', 'Fix the login bug');
  const row = svc.db.prepare(
    'SELECT vector FROM embeddings WHERE collection = ? AND item_id = ?'
  ).get('tasks:board-1', 'T1') as any;
  expect(row.vector).not.toBeNull();
  svc.close();
});

it('index() nulls vector when source_text changes', () => {
  const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
  svc.index('tasks:board-1', 'T1', 'Fix the login bug');
  svc.db.prepare(
    'UPDATE embeddings SET vector = ? WHERE collection = ? AND item_id = ?'
  ).run(Buffer.from(new Float32Array([1, 2, 3]).buffer), 'tasks:board-1', 'T1');
  // Re-index with DIFFERENT text
  svc.index('tasks:board-1', 'T1', 'Fix the signup bug');
  const row = svc.db.prepare(
    'SELECT vector, source_text FROM embeddings WHERE collection = ? AND item_id = ?'
  ).get('tasks:board-1', 'T1') as any;
  expect(row.vector).toBeNull(); // re-queued
  expect(row.source_text).toBe('Fix the signup bug');
  svc.close();
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: FAIL — `svc.index is not a function`

- [ ] **Step 7: Implement index()**

Add to `EmbeddingService` class in `src/embedding-service.ts`:

```typescript
index(collection: string, itemId: string, text: string, metadata?: Record<string, any>): void {
  const existing = this.db.prepare(
    'SELECT source_text, model FROM embeddings WHERE collection = ? AND item_id = ?'
  ).get(collection, itemId) as { source_text: string; model: string } | undefined;

  if (existing && existing.source_text === text && existing.model === this.model) {
    return; // unchanged — preserve existing vector
  }

  this.db.prepare(
    `INSERT INTO embeddings (collection, item_id, vector, source_text, model, metadata, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT (collection, item_id) DO UPDATE SET
       vector = NULL, source_text = excluded.source_text, model = excluded.model,
       metadata = excluded.metadata, updated_at = excluded.updated_at`
  ).run(collection, itemId, text, this.model, JSON.stringify(metadata ?? {}), new Date().toISOString());
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Write failing test — remove(), getCollections(), getItemIds()**

```typescript
it('remove() deletes an embedding', () => {
  const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
  svc.index('tasks:board-1', 'T1', 'Fix bug');
  svc.remove('tasks:board-1', 'T1');
  const row = svc.db.prepare(
    'SELECT * FROM embeddings WHERE collection = ? AND item_id = ?'
  ).get('tasks:board-1', 'T1');
  expect(row).toBeUndefined();
  svc.close();
});

it('getCollections() returns distinct collection names', () => {
  const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
  svc.index('tasks:board-1', 'T1', 'A');
  svc.index('tasks:board-2', 'T1', 'B');
  svc.index('messages:group-1', 'M1', 'C');
  expect(svc.getCollections()).toEqual(['messages:group-1', 'tasks:board-1', 'tasks:board-2']);
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
```

- [ ] **Step 10: Implement remove(), removeCollection(), getCollections(), getItemIds()**

```typescript
remove(collection: string, itemId: string): void {
  this.db.prepare('DELETE FROM embeddings WHERE collection = ? AND item_id = ?')
    .run(collection, itemId);
}

removeCollection(collection: string): void {
  this.db.prepare('DELETE FROM embeddings WHERE collection = ?').run(collection);
}

getCollections(prefix?: string): string[] {
  if (prefix) {
    return (this.db.prepare(
      "SELECT DISTINCT collection FROM embeddings WHERE collection LIKE ? ESCAPE '\\' ORDER BY collection"
    ).all(prefix.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%') as Array<{ collection: string }>)
      .map(r => r.collection);
  }
  return (this.db.prepare('SELECT DISTINCT collection FROM embeddings ORDER BY collection')
    .all() as Array<{ collection: string }>).map(r => r.collection);
}

getItemIds(collection: string): string[] {
  return (this.db.prepare('SELECT item_id FROM embeddings WHERE collection = ? ORDER BY item_id')
    .all(collection) as Array<{ item_id: string }>).map(r => r.item_id);
}
```

- [ ] **Step 11: Run all tests**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 12: Write failing test — indexer processes pending items**

```typescript
import { vi } from 'vitest';

it('indexer processes pending items via Ollama', async () => {
  // Mock fetch to simulate Ollama
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      embeddings: [[0.1, 0.2, 0.3]],
    }),
  });
  global.fetch = mockFetch as any;

  const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
  svc.index('tasks:board-1', 'T1', 'Fix the login bug');

  // Run one indexer cycle manually
  await svc.runIndexerCycle();

  const row = svc.db.prepare(
    'SELECT vector, model FROM embeddings WHERE collection = ? AND item_id = ?'
  ).get('tasks:board-1', 'T1') as any;
  expect(row.vector).not.toBeNull();
  expect(row.model).toBe('test-model');

  // Verify Ollama was called with correct model
  expect(mockFetch).toHaveBeenCalledWith(
    'http://localhost:11434/api/embed',
    expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"model":"test-model"'),
    }),
  );

  svc.close();
});
```

- [ ] **Step 13: Implement runIndexerCycle() and startIndexer()/stopIndexer()**

```typescript
async runIndexerCycle(): Promise<void> {
  try {
    // Step 1: Model change detection
    this.db.prepare('UPDATE embeddings SET vector = NULL WHERE model != ?').run(this.model);

    // Step 2: Query pending items
    const pending = this.db.prepare(
      'SELECT collection, item_id, source_text FROM embeddings WHERE vector IS NULL ORDER BY updated_at ASC LIMIT 20'
    ).all() as Array<{ collection: string; item_id: string; source_text: string }>;

    if (pending.length === 0) return;

    // Step 3: Batch-call Ollama
    const texts = pending.map(p => p.source_text);
    const response = await fetch(`${this.ollamaHost}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Ollama embed request failed');
      return;
    }

    const data = await response.json() as { embeddings: number[][] };
    if (!data.embeddings || data.embeddings.length !== pending.length) {
      logger.warn('Ollama returned unexpected embedding count');
      return;
    }

    // Step 4: Update vectors
    const now = new Date().toISOString();
    const update = this.db.prepare(
      'UPDATE embeddings SET vector = ?, model = ?, updated_at = ? WHERE collection = ? AND item_id = ?'
    );
    const tx = this.db.transaction(() => {
      for (let i = 0; i < pending.length; i++) {
        const vector = Buffer.from(new Float32Array(data.embeddings[i]).buffer);
        update.run(vector, this.model, now, pending[i].collection, pending[i].item_id);
      }
    });
    tx();

    logger.info({ count: pending.length }, 'Embedding indexer: batch processed');
  } catch (err) {
    logger.warn({ err }, 'Embedding indexer cycle failed');
  }
}

startIndexer(intervalMs = 10_000): void {
  if (this.indexerTimer) return;
  this.indexerTimer = setInterval(() => {
    this.runIndexerCycle().catch(err =>
      logger.warn({ err }, 'Embedding indexer unhandled error'),
    );
  }, intervalMs);
  // Run first cycle immediately
  this.runIndexerCycle().catch(() => {});
}

stopIndexer(): void {
  if (this.indexerTimer) {
    clearInterval(this.indexerTimer);
    this.indexerTimer = null;
  }
}
```

- [ ] **Step 14: Run all tests**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 15: Write failing test — model switch re-embeds all**

```typescript
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
  await svc2.runIndexerCycle(); // should detect model mismatch and re-embed

  const row = svc2.db.prepare('SELECT model FROM embeddings WHERE item_id = ?').get('T1') as any;
  expect(row.model).toBe('model-B');
  svc2.close();
});
```

- [ ] **Step 16: Write remaining spec-required tests**

```typescript
// Note: EmbeddingReader lives in container/agent-runner/src/ (separate package).
// Its read-only fallback test belongs in the container test suite, not here.
// See docs/plans/2026-03-14-taskflow-embeddings-integration.md for container tests.

it('close() is safe to call multiple times', () => {
  const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
  svc.close();
  // Should not throw on second close
  expect(() => svc.close()).not.toThrow();
});

it('indexer processes all items without starvation', async () => {
  const embeddings: number[][] = [];
  const mockFetch = vi.fn().mockImplementation(async () => {
    return { ok: true, json: async () => ({ embeddings: embeddings }) };
  });
  global.fetch = mockFetch as any;

  const svc = new EmbeddingService(TEST_DB_PATH, 'http://localhost:11434', 'test-model');
  // Insert 50 items
  for (let i = 0; i < 50; i++) {
    svc.index('c', `T${i}`, `text ${i}`);
    embeddings.push([0.1 * i, 0.2, 0.3]);
  }

  // Run 3 cycles (20 per cycle = 60 capacity > 50 items)
  // Reset mock for each cycle to return correct batch size
  for (let cycle = 0; cycle < 3; cycle++) {
    const pending = svc.db.prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE vector IS NULL').get() as { cnt: number };
    const batchSize = Math.min(pending.cnt, 20);
    embeddings.length = 0;
    for (let i = 0; i < batchSize; i++) embeddings.push([0.1, 0.2, 0.3]);
    await svc.runIndexerCycle();
  }

  const remaining = svc.db.prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE vector IS NULL').get() as { cnt: number };
  expect(remaining.cnt).toBe(0);
  svc.close();
});
```

- [ ] **Step 17: Run all tests**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 18: Commit**

```bash
git add src/embedding-service.ts src/embedding-service.test.ts
git commit -m "feat(embeddings): add EmbeddingService — schema, index, indexer, model switch"
```

---

### Task 2: EmbeddingReader (container, read-only)

**Files:**
- Create: `container/agent-runner/src/embedding-reader.ts`

- [ ] **Step 1: Write EmbeddingReader with cosine similarity**

```typescript
// container/agent-runner/src/embedding-reader.ts
import Database from 'better-sqlite3';
import fs from 'fs';

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class EmbeddingReader {
  private db: Database.Database | null = null;

  constructor(dbPath: string) {
    try {
      if (!fs.existsSync(dbPath)) {
        return; // DB not created yet — graceful no-op
      }
      this.db = new Database(dbPath, { readonly: true });
      this.db.pragma('busy_timeout = 5000');
    } catch {
      this.db = null; // corrupted or locked — graceful fallback
    }
  }

  /**
   * Search a collection for items similar to queryVector.
   * Returns ranked results above the threshold.
   */
  search(
    collection: string,
    queryVector: Float32Array,
    opts: { limit?: number; threshold?: number } = {},
  ): Array<{ itemId: string; score: number; metadata: Record<string, any> }> {
    if (!this.db) return [];
    const { limit = 20, threshold = 0.3 } = opts;

    const rows = this.db.prepare(
      'SELECT item_id, vector, metadata FROM embeddings WHERE collection = ? AND vector IS NOT NULL'
    ).all(collection) as Array<{ item_id: string; vector: Buffer; metadata: string }>;

    const results: Array<{ itemId: string; score: number; metadata: Record<string, any> }> = [];
    for (const row of rows) {
      const stored = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
      const score = cosineSimilarity(queryVector, stored);
      if (score >= threshold) {
        let metadata: Record<string, any> = {};
        try { metadata = JSON.parse(row.metadata); } catch {}
        results.push({ itemId: row.item_id, score, metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Find the single most similar item above threshold (for duplicate detection).
   */
  findSimilar(
    collection: string,
    queryVector: Float32Array,
    threshold = 0.85,
  ): { itemId: string; score: number; metadata: Record<string, any> } | null {
    const results = this.search(collection, queryVector, { limit: 1, threshold });
    return results.length > 0 ? results[0] : null;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/embedding-reader.ts
git commit -m "feat(embeddings): add EmbeddingReader — read-only client with cosine similarity"
```

---

## Chunk 2: Host Integration (add-embeddings) + TaskFlow Sync (add-taskflow)

### Task 3: Host wiring — env vars, mount, ContainerInput (add-embeddings)

**Files:**
- Modify: `src/container-runner.ts:45-58,271-273,321-360,96-265`

- [ ] **Step 1: Add fields to ContainerInput (host side)**

In `src/container-runner.ts`, add to the `ContainerInput` interface (after `secrets?` field):

```typescript
queryVector?: string;         // base64-encoded Float32Array
ollamaHost?: string;
embeddingModel?: string;
```

- [ ] **Step 2: Read OLLAMA_HOST and EMBEDDING_MODEL from .env**

In `src/container-runner.ts`, create a helper next to `readSecrets()`:

```typescript
function readEmbeddingConfig(): { ollamaHost: string; embeddingModel: string } {
  const env = readEnvFile(['OLLAMA_HOST', 'EMBEDDING_MODEL']);
  return {
    ollamaHost: env.OLLAMA_HOST ?? '',
    embeddingModel: env.EMBEDDING_MODEL ?? 'bge-m3',
  };
}
```

- [ ] **Step 3: Add embeddings mount to buildVolumeMounts()**

In `src/container-runner.ts`, after the MCP plugins mount (around line 225), add:

```typescript
// Embeddings DB — read-only mount for all containers
const embeddingsDir = path.join(DATA_DIR, 'embeddings');
fs.mkdirSync(embeddingsDir, { recursive: true });
mounts.push({
  hostPath: embeddingsDir,
  containerPath: '/workspace/embeddings',
  readonly: true,
});
```

- [ ] **Step 4: Add `embedding-reader.ts` to CORE_AGENT_RUNNER_FILES**

In `src/container-runner.ts`, find the `CORE_AGENT_RUNNER_FILES` array (around line 73) and add:

```typescript
'embedding-reader.ts',
```

This ensures the file is synced to per-group agent-runner copies for existing groups.

- [ ] **Step 5: Set embeddings config on ContainerInput + pass env vars**

In `runContainerAgent()`, where `input` is built (around line 431), call `readEmbeddingConfig()` ONCE and use the result for both ContainerInput and env vars:

```typescript
const embedCfg = readEmbeddingConfig();
input.ollamaHost = embedCfg.ollamaHost;
input.embeddingModel = embedCfg.embeddingModel;
```

Then in `buildContainerArgs()`, add a parameter for embedding env vars (or pass them before the call):

```typescript
if (input.ollamaHost) {
  args.push('-e', `OLLAMA_HOST=${input.ollamaHost}`);
  args.push('-e', `EMBEDDING_MODEL=${input.embeddingModel}`);
}
```

Note: The `queryVector` field on `ContainerInput` is plumbing only — the generic plan adds the field but does NOT embed the user message. That behavior (calling Ollama to embed the prompt and setting `input.queryVector`) belongs to the TaskFlow integration plan, which owns the "embed message for context preamble" logic.

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 8: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(embeddings): host wiring — env vars, mount, queryVector in ContainerInput"
```

---

### Task 4: Container runtime-config (add-embeddings)

**Files:**
- Modify: `container/agent-runner/src/runtime-config.ts:1-15,40-65`

- [ ] **Step 1: Add fields to ContainerInput (container side)**

In `container/agent-runner/src/runtime-config.ts`, add to `ContainerInput`:

```typescript
queryVector?: string;
ollamaHost?: string;
embeddingModel?: string;
```

- [ ] **Step 2: Add to buildNanoclawMcpEnv()**

In `buildNanoclawMcpEnv()`, add to the `env` object:

```typescript
if (containerInput.ollamaHost) {
  env.NANOCLAW_OLLAMA_HOST = containerInput.ollamaHost;
}
if (containerInput.embeddingModel) {
  env.NANOCLAW_EMBEDDING_MODEL = containerInput.embeddingModel;
}
```

- [ ] **Step 3: Build and verify**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/runtime-config.ts
git commit -m "feat(embeddings): container runtime-config — ContainerInput fields, MCP env"
```

---

### ~~Task 5-6: MOVED to separate plan~~

TaskFlow-specific integration (sync adapter, semantic search wrapping, duplicate detection, context preamble, `buildContextSummary`) has been moved to a separate plan:

**See:** `docs/plans/2026-03-14-taskflow-embeddings-integration.md`

This plan (`add-embeddings`) covers only the generic service. The TaskFlow integration plan should be executed after this one completes.

---

## Chunk 3: Skill Packaging + Verification

---

### Task 5: Skill packaging

**Files:**
- Create: `.claude/skills/add-embeddings/SKILL.md`
- Create: `.claude/skills/add-embeddings/manifest.yaml`

- [ ] **Step 1: Create SKILL.md**

Write the SKILL.md with frontmatter and 4 phases (pre-flight, apply, configure, verify). Reference the spec for exact phase content.

- [ ] **Step 2: Create manifest.yaml**

```yaml
skill: add-embeddings
version: 1.0.0
description: "Generic embedding service via Ollama. Indexes, searches, and deduplicates text in named collections."
core_version: 1.2.12
adds:
  - src/embedding-service.ts
  - src/embedding-service.test.ts
  - container/agent-runner/src/embedding-reader.ts
modifies:
  - src/index.ts                                  # EmbeddingService startup only
  - src/container-runner.ts                       # mount, env vars, queryVector
  - container/agent-runner/src/runtime-config.ts  # ContainerInput fields, MCP env
# TaskFlow-owned changes (NOT in this manifest):
#   - src/taskflow-embedding-sync.ts (new, add-taskflow)
#   - container/agent-runner/src/index.ts (context preamble, add-taskflow)
#   - container/agent-runner/src/ipc-mcp-stdio.ts (search/dup wrap, add-taskflow)
#   - container/agent-runner/src/taskflow-engine.ts (query_vector, add-taskflow)
structured:
  npm_dependencies: {}
  env_additions:
    - OLLAMA_HOST
    - EMBEDDING_MODEL
conflicts: []
depends: []
test: "npx vitest run src/embedding-service.test.ts"
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-embeddings/
git commit -m "feat(embeddings): add-embeddings skill packaging — SKILL.md + manifest"
```

---

### Task 6: End-to-end verification (generic service only)

- [ ] **Step 1: Build host**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 2: Build container**

Run: `./container/build.sh`
Expected: Build complete

- [ ] **Step 3: Run unit tests**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: All tests pass

Note: `EmbeddingReader` (container package) is tested by the companion TaskFlow integration plan's Task 4. The generic plan's test suite covers only `EmbeddingService` (host package). Both are owned by `add-embeddings` but live in different TypeScript packages with separate test runners.

- [ ] **Step 4: Add OLLAMA_HOST and EMBEDDING_MODEL to .env**

```bash
echo 'OLLAMA_HOST=http://192.168.2.13:11434' >> .env
echo 'EMBEDDING_MODEL=bge-m3' >> .env
```

- [ ] **Step 5: Deploy and test**

```bash
rsync -avz dist/ nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/dist/
rsync -avz container/agent-runner/src/ nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/container/agent-runner/src/
ssh nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && docker builder prune -af && ./container/build.sh"
ssh nanoclaw@192.168.2.63 "systemctl --user restart nanoclaw"
```

- [ ] **Step 6: Verify embedding service starts**

Check logs for embedding indexer startup:
```bash
ssh nanoclaw@192.168.2.63 "tail -20 /home/nanoclaw/nanoclaw/logs/nanoclaw.log | grep -i embed"
```
Expected: `Embedding service started` log entry with Ollama host

- [ ] **Step 7: Verify embeddings.db is created and mounted**

```bash
ssh nanoclaw@192.168.2.63 "ls -la /home/nanoclaw/nanoclaw/data/embeddings/"
```
Expected: `embeddings.db` file exists

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat(embeddings): add-embeddings generic service complete"
```

**Next:** Execute `docs/plans/2026-03-14-taskflow-embeddings-integration.md` for TaskFlow-specific integration (semantic search, duplicate detection, context preamble).
