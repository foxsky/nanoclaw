# Add-Embeddings Skill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `add-embeddings` skill — a generic embedding service powered by BGE-M3 via Ollama, with TaskFlow as the first consumer (semantic search, duplicate detection, augmented context).

**Architecture:** Background indexer on host writes vectors to `data/embeddings/embeddings.db`. Containers read pre-computed vectors via read-only mount. Ollama called from container for query-time embeddings (search, duplicate detection). Context preamble built in container's `index.ts` before `runQuery()`.

**Tech Stack:** TypeScript, SQLite (better-sqlite3, WAL mode), Ollama REST API (native fetch), cosine similarity (pure JS)

**Spec:** `docs/plans/2026-03-14-semantic-embeddings-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/embedding-service.ts` | Generic embedding service (host, read-write). Schema creation, index(), indexer loop, getCollections(), getItemIds(), remove(). |
| `src/embedding-service.test.ts` | Tests for EmbeddingService — schema creation, index idempotency, indexer cycle, model switch, stale cleanup |
| `src/taskflow-embedding-sync.ts` | TaskFlow adapter — polls taskflow.db, feeds EmbeddingService, cleans stale embeddings. **Belongs to add-taskflow skill**, not add-embeddings — it knows about TaskFlow tables. |
| `container/agent-runner/src/embedding-reader.ts` | Read-only embedding query client (container). Opens DB readonly, cosine similarity, search(), findSimilar(). Graceful fallback on missing DB. |

### Modified files
| File | Changes |
|------|---------|
| `src/container-runner.ts:45-58` | Add `queryVector?`, `ollamaHost?`, `embeddingModel?` to `ContainerInput`. Read `OLLAMA_HOST`/`EMBEDDING_MODEL` via `readEnvFile()`. Add `-e` flags in `buildContainerArgs()`. Add embeddings mount. Embed user message before container launch. |
| `src/index.ts:393-486` | Instantiate `EmbeddingService` at startup. Start `taskflowEmbeddingSync`. Pass `queryVector` to `ContainerInput`. |
| `container/agent-runner/src/runtime-config.ts:1-15,40-65` | Add `queryVector?`, `ollamaHost?`, `embeddingModel?` to `ContainerInput`. Add `NANOCLAW_OLLAMA_HOST`, `NANOCLAW_EMBEDDING_MODEL` to `buildNanoclawMcpEnv()`. |
| `container/agent-runner/src/index.ts:540-570` | Read `queryVector` from `containerInput`. Build context preamble via `engine.buildContextSummary()`. Prepend to prompt. |
| `container/agent-runner/src/ipc-mcp-stdio.ts:574-635` | Wrap `taskflow_query` search with async Ollama embed call. Wrap `taskflow_create` with duplicate detection. Add `force_create` to Zod schema. |
| `container/agent-runner/src/taskflow-engine.ts:15-24,4816-4835` | Add `query_vector` to `QueryParams`. Enhance `search` case with semantic ranking. Add `buildContextSummary()` method. |

### Skill packaging files
| File | Purpose |
|------|---------|
| `.claude/skills/add-embeddings/SKILL.md` | Installation instructions (4 phases) |
| `.claude/skills/add-embeddings/manifest.yaml` | Metadata, file lists, dependencies |

---

## Chunk 1: Core Embedding Service + Tests

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

- [ ] **Step 16: Run all tests**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 17: Commit**

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

## Chunk 2: Host Integration + TaskFlow Sync

### Task 3: Host wiring — env vars, mount, ContainerInput

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

- [ ] **Step 4: Pass env vars in buildContainerArgs()**

In `src/container-runner.ts`, inside `buildContainerArgs()`, after the existing `-e TZ=` line:

```typescript
const embedCfg = readEmbeddingConfig();
if (embedCfg.ollamaHost) {
  args.push('-e', `OLLAMA_HOST=${embedCfg.ollamaHost}`);
  args.push('-e', `EMBEDDING_MODEL=${embedCfg.embeddingModel}`);
}
```

- [ ] **Step 5: Set ollamaHost and embeddingModel on ContainerInput**

In `runContainerAgent()`, where `input` is built (around line 431), add:

```typescript
const embedCfg = readEmbeddingConfig();
input.ollamaHost = embedCfg.ollamaHost;
input.embeddingModel = embedCfg.embeddingModel;
```

- [ ] **Step 6: Embed user message and set queryVector**

In `runContainerAgent()`, after building the prompt and before spawning the container:

```typescript
// Embed user message for context preamble (async, best-effort)
if (embedCfg.ollamaHost && group.taskflowManaged) {
  try {
    const resp = await fetch(`${embedCfg.ollamaHost}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedCfg.embeddingModel, input: input.prompt }),
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json() as { embeddings: number[][] };
      if (data.embeddings?.[0]) {
        input.queryVector = Buffer.from(new Float32Array(data.embeddings[0]).buffer).toString('base64');
      }
    }
  } catch {
    // Ollama unreachable — skip context preamble
  }
}
```

- [ ] **Step 7: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 8: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(embeddings): host wiring — env vars, mount, queryVector in ContainerInput"
```

---

### Task 4: Container runtime-config + agent-runner index.ts

**Files:**
- Modify: `container/agent-runner/src/runtime-config.ts:1-15,40-65`
- Modify: `container/agent-runner/src/index.ts:540-570`

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

- [ ] **Step 3: Build context preamble in container index.ts**

In `container/agent-runner/src/index.ts`, in `main()`, after reading `containerInput` and before the first `runQuery()` call, add:

```typescript
// Build context preamble from embeddings (if available)
if (containerInput.queryVector && containerInput.isTaskflowManaged && containerInput.taskflowBoardId) {
  try {
    const { EmbeddingReader } = await import('./embedding-reader.js');
    const reader = new EmbeddingReader('/workspace/embeddings/embeddings.db');
    const vectorBuf = Buffer.from(containerInput.queryVector, 'base64');
    const queryVector = new Float32Array(vectorBuf.buffer, vectorBuf.byteOffset, vectorBuf.byteLength / 4);

    // Load TaskflowEngine for buildContextSummary
    const { TaskflowEngine } = await import('./taskflow-engine.js');
    const tfDbPath = '/workspace/taskflow/taskflow.db';
    if (fs.existsSync(tfDbPath)) {
      const engine = new TaskflowEngine(tfDbPath, containerInput.taskflowBoardId);
      const preamble = engine.buildContextSummary(queryVector, reader);
      if (preamble) {
        prompt = preamble + '\n\n' + prompt;
      }
      engine.close();
    }
    reader.close();
  } catch (err) {
    log(`Context preamble skipped: ${err}`);
  }
}
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean build (buildContextSummary not yet implemented — will be added in Task 6)

Note: This step will fail until Task 6 adds `buildContextSummary()` to the engine. For now, commit the wiring and the import will be resolved in Task 6.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/runtime-config.ts container/agent-runner/src/index.ts
git commit -m "feat(embeddings): container wiring — ContainerInput fields, MCP env, preamble injection"
```

---

### Task 5: TaskFlow Embedding Sync (add-taskflow owned, implemented here for first consumer)

**Note:** This file belongs to the `add-taskflow` skill conceptually — it knows about TaskFlow tables. It's implemented here because TaskFlow is the first consumer, but future skill restructuring should move it under add-taskflow.

**Files:**
- Create: `src/taskflow-embedding-sync.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create taskflow-embedding-sync.ts**

```typescript
// src/taskflow-embedding-sync.ts
import type Database from 'better-sqlite3';
import type { EmbeddingService } from './embedding-service.js';
import { logger } from './logger.js';

export function buildSourceText(task: {
  title: string;
  description?: string | null;
  next_action?: string | null;
}): string {
  return [task.title, task.description ?? '', task.next_action ?? ''].join(' ').trim();
}

export function startTaskflowEmbeddingSync(
  service: EmbeddingService,
  tfDb: Database.Database | null,
  intervalMs = 15_000,
): ReturnType<typeof setInterval> | null {
  if (!tfDb) {
    logger.info('TaskFlow DB not found — embedding sync disabled');
    return null;
  }

  const sync = () => {
    try {
      const tasks = tfDb.prepare(
        `SELECT board_id, id, title, description, next_action, assignee, column
         FROM tasks WHERE column != 'done'`
      ).all() as Array<{
        board_id: string; id: string; title: string;
        description: string | null; next_action: string | null;
        assignee: string | null; column: string;
      }>;

      const activeKeys = new Set<string>();
      for (const task of tasks) {
        const collection = `tasks:${task.board_id}`;
        const text = buildSourceText(task);
        service.index(collection, task.id, text, {
          title: task.title,
          assignee: task.assignee,
          column: task.column,
        });
        activeKeys.add(`${collection}\0${task.id}`);
      }

      // Clean stale embeddings
      const allTaskCollections = service.getCollections('tasks:');
      for (const collection of allTaskCollections) {
        const items = service.getItemIds(collection);
        for (const itemId of items) {
          if (!activeKeys.has(`${collection}\0${itemId}`)) {
            service.remove(collection, itemId);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'TaskFlow embedding sync failed');
    }
  };

  // Run first sync immediately
  sync();
  return setInterval(sync, intervalMs);
}
```

- [ ] **Step 2: Wire into src/index.ts**

In `src/index.ts`, after the main loop initialization:

```typescript
import { EmbeddingService } from './embedding-service.js';
import { startTaskflowEmbeddingSync } from './taskflow-embedding-sync.js';

// After existing service initialization:
const embedCfg = readEnvFile(['OLLAMA_HOST', 'EMBEDDING_MODEL']);
if (embedCfg.OLLAMA_HOST) {
  const embeddingService = new EmbeddingService(
    path.join(DATA_DIR, 'embeddings', 'embeddings.db'),
    embedCfg.OLLAMA_HOST,
    embedCfg.EMBEDDING_MODEL || 'bge-m3',
  );
  embeddingService.startIndexer();
  startTaskflowEmbeddingSync(embeddingService, getTaskflowDb(DATA_DIR));
  logger.info({ ollamaHost: embedCfg.OLLAMA_HOST }, 'Embedding service started');
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add src/taskflow-embedding-sync.ts src/index.ts
git commit -m "feat(embeddings): TaskFlow sync adapter + host startup wiring"
```

---

## Chunk 3: Container Integration — Search, Duplicate Detection, Context Preamble

### Task 6: Semantic search + duplicate detection + buildContextSummary

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:15-24,4816-4835`
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:574-635`

- [ ] **Step 1: Add query_vector to QueryParams**

In `container/agent-runner/src/taskflow-engine.ts`, add to `QueryParams` interface:

```typescript
query_vector?: Float32Array;
```

- [ ] **Step 2: Enhance search case with semantic ranking**

In the `search` case of `query()` method, after the existing lexical search, add semantic ranking:

```typescript
case 'search': {
  if (!params.search_text) {
    return { success: false, error: 'Missing required parameter: search_text' };
  }
  const escapedText = params.search_text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const pattern = `%${escapedText}%`;
  const textMatches = this.db
    .prepare(
      `SELECT * FROM tasks
       WHERE ${this.visibleTaskScope()} AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
       ORDER BY id`,
    )
    .all(...this.visibleTaskParams(), pattern, pattern) as any[];

  const idMatch = this.getTask(params.search_text);

  // Semantic ranking (if query_vector provided)
  if (params.query_vector) {
    try {
      const { EmbeddingReader, cosineSimilarity } = require('./embedding-reader.js');
      const reader = new EmbeddingReader('/workspace/embeddings/embeddings.db');
      const collection = `tasks:${this.boardId}`;
      const semanticResults = reader.search(collection, params.query_vector, { limit: 20, threshold: 0.3 });
      reader.close();

      // Build scored result set
      const lexicalIds = new Set(textMatches.map((t: any) => t.id));
      const scored = new Map<string, { task: any; score: number }>();

      // Lexical matches get a boost
      for (const task of textMatches) {
        scored.set(task.id, { task, score: 0.2 }); // lexical boost
      }

      // Merge semantic scores
      for (const sem of semanticResults) {
        const existing = scored.get(sem.itemId);
        if (existing) {
          existing.score += sem.score; // lexical + semantic
        } else {
          // Semantic-only match — need to fetch task data
          const task = this.getTask(sem.itemId);
          if (task) scored.set(sem.itemId, { task, score: sem.score });
        }
      }

      // Sort by score descending
      const ranked = [...scored.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(r => r.task);

      if (idMatch && !ranked.some((t: any) => t.id === idMatch.id && t.board_id === idMatch.board_id)) {
        return { success: true, data: [idMatch, ...ranked] };
      }
      return { success: true, data: ranked };
    } catch {
      // Fallback to lexical only
    }
  }

  if (idMatch && !textMatches.some((t: any) => t.id === idMatch.id && t.board_id === idMatch.board_id)) {
    return { success: true, data: [idMatch, ...textMatches] };
  }
  return { success: true, data: textMatches };
}
```

- [ ] **Step 3: Add buildContextSummary() method**

Add to `TaskflowEngine` class:

```typescript
buildContextSummary(
  queryVector: Float32Array,
  reader: import('./embedding-reader.js').EmbeddingReader,
): string | null {
  try {
    const collection = `tasks:${this.boardId}`;
    const ranked = reader.search(collection, queryVector, { limit: 10, threshold: 0.2 });
    if (ranked.length === 0) return null;

    // Column counts
    const counts = this.db.prepare(
      `SELECT column, COUNT(*) as cnt FROM tasks
       WHERE ${this.visibleTaskScope()} AND column != 'done'
       GROUP BY column`
    ).all(...this.visibleTaskParams()) as Array<{ column: string; cnt: number }>;

    const countMap = new Map(counts.map(c => [c.column, c.cnt]));
    const overdue = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM tasks
       WHERE ${this.visibleTaskScope()} AND due_date < ? AND column != 'done'`
    ).get(...this.visibleTaskParams(), new Date().toISOString().slice(0, 10)) as { cnt: number };

    const parts = ['inbox', 'next_action', 'in_progress', 'waiting', 'review']
      .filter(c => (countMap.get(c) ?? 0) > 0)
      .map(c => `${countMap.get(c)} ${c}`);
    if (overdue.cnt > 0) parts.push(`${overdue.cnt} overdue`);

    const lines = [`[Board context: ${parts.join(', ')}.`];
    lines.push('Relevant tasks for this message:');

    // Top 10 with full details
    for (const item of ranked) {
      const task = this.getTask(item.itemId);
      if (!task) continue;
      const assigneeName = task.assignee ? this.getPersonName(task.assignee) : null;
      const detail = [
        `- ${task.id} ${task.title} (${task.column}`,
        assigneeName ? `, ${assigneeName}` : '',
        task.due_date ? `, prazo ${task.due_date.slice(8, 10)}/${task.due_date.slice(5, 7)}` : '',
        task.next_action ? `, próxima ação: ${task.next_action}` : '',
        ')',
      ].join('');
      lines.push(detail);
    }

    // All other tasks as one-liners
    const rankedIds = new Set(ranked.map(r => r.itemId));
    const others = this.db.prepare(
      `SELECT id, title FROM tasks
       WHERE ${this.visibleTaskScope()} AND column != 'done'
       ORDER BY id`
    ).all(...this.visibleTaskParams()) as Array<{ id: string; title: string }>;

    const otherTasks = others.filter(t => !rankedIds.has(t.id));
    if (otherTasks.length > 0) {
      lines.push(`Other tasks: ${otherTasks.map(t => `${t.id} ${t.title}`).join(', ')}]`);
    } else {
      lines[lines.length - 1] += ']';
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Wrap taskflow_query search with Ollama embed call in ipc-mcp-stdio.ts**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, inside the `taskflow_query` handler, before calling `engine.query()`, add:

```typescript
// Semantic search: embed query text via Ollama
let queryVector: Float32Array | undefined;
if (args.query === 'search' && args.search_text) {
  const ollamaHost = process.env.NANOCLAW_OLLAMA_HOST;
  const embeddingModel = process.env.NANOCLAW_EMBEDDING_MODEL || 'bge-m3';
  if (ollamaHost) {
    try {
      const resp = await fetch(`${ollamaHost}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, input: args.search_text }),
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = await resp.json() as { embeddings: number[][] };
        if (data.embeddings?.[0]) {
          queryVector = new Float32Array(data.embeddings[0]);
        }
      }
    } catch {
      // Ollama unreachable — fallback to lexical
    }
  }
}
const result = engine.query({ ...args, query_vector: queryVector });
```

- [ ] **Step 5: Wrap taskflow_create with duplicate detection**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, add `force_create` to the Zod schema for `taskflow_create`, and add duplicate detection before calling `engine.create()`:

```typescript
// In the Zod schema:
force_create: z.boolean().optional(),

// Before engine.create():
if (!args.force_create) {
  const ollamaHost = process.env.NANOCLAW_OLLAMA_HOST;
  const embeddingModel = process.env.NANOCLAW_EMBEDDING_MODEL || 'bge-m3';
  if (ollamaHost) {
    try {
      const titleText = [args.title, args.description].filter(Boolean).join(' ');
      const resp = await fetch(`${ollamaHost}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, input: titleText }),
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = await resp.json() as { embeddings: number[][] };
        if (data.embeddings?.[0]) {
          const { EmbeddingReader } = await import('./embedding-reader.js');
          const reader = new EmbeddingReader('/workspace/embeddings/embeddings.db');
          const collection = `tasks:${boardId}`;
          const similar = reader.findSimilar(collection, new Float32Array(data.embeddings[0]), 0.85);
          reader.close();
          if (similar) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  duplicate_warning: {
                    similar_task_id: similar.itemId,
                    similar_task_title: similar.metadata?.title ?? similar.itemId,
                    similarity: Math.round(similar.score * 100),
                  },
                  error: `Tarefa similar encontrada: ${similar.itemId} — ${similar.metadata?.title ?? '?'} (${Math.round(similar.score * 100)}%). Criar mesmo assim?`,
                }),
              }],
            };
          }
        }
      }
    } catch {
      logger.warn({ reason: 'ollama_unreachable' }, 'Duplicate detection skipped');
    }
  }
}
// Remove force_create before passing to engine
const { force_create, ...createArgs } = args;
const result = engine.create(createArgs);
```

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(embeddings): semantic search, duplicate detection, buildContextSummary"
```

---

## Chunk 4: Skill Packaging + Final Verification

### Task 7: Skill packaging

**Files:**
- Create: `.claude/skills/add-embeddings/SKILL.md`
- Create: `.claude/skills/add-embeddings/manifest.yaml`

- [ ] **Step 1: Create SKILL.md**

Write the SKILL.md with frontmatter and 4 phases (pre-flight, apply, configure, verify). Reference the spec for exact phase content.

- [ ] **Step 2: Create manifest.yaml**

```yaml
skill: add-embeddings
version: 1.0.0
description: "Generic embedding service with semantic search, duplicate detection, and context retrieval. First consumer: TaskFlow."
core_version: 1.2.12
adds:
  - src/embedding-service.ts
  - src/embedding-service.test.ts
  - container/agent-runner/src/embedding-reader.ts
# Note: src/taskflow-embedding-sync.ts belongs to add-taskflow skill, not here
modifies:
  - src/index.ts
  - src/container-runner.ts
  - container/agent-runner/src/index.ts
  - container/agent-runner/src/runtime-config.ts
  - container/agent-runner/src/ipc-mcp-stdio.ts
  - container/agent-runner/src/taskflow-engine.ts
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

### Task 8: End-to-end verification

- [ ] **Step 1: Build host**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 2: Build container**

Run: `./container/build.sh`
Expected: Build complete

- [ ] **Step 3: Run unit tests**

Run: `npx vitest run src/embedding-service.test.ts`
Expected: All tests pass

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

- [ ] **Step 6: Verify via WhatsApp**

Send a semantic search query to a TaskFlow group: "buscar tarefas de infraestrutura"
Expected: results include tasks semantically related (e.g., "Migração da nuvem") even without keyword match

- [ ] **Step 7: Verify duplicate detection**

Create a task similar to an existing one: "anotar: Trocar filtro de linha"
Expected: warning if a similar task exists

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat(embeddings): add-embeddings skill complete — search, duplicates, context preamble"
```
