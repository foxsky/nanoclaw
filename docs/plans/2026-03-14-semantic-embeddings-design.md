# Generic Embedding Service for NanoClaw (BGE-M3)

**Date:** 2026-03-14
**Status:** Approved
**Skill:** `add-embeddings`

## Summary

Add a generic embedding service to NanoClaw powered by BGE-M3 via Ollama. The service indexes, searches, and deduplicates text content organized into named collections. TaskFlow is the first consumer (semantic task search, duplicate detection, augmented context retrieval), but the service is reusable by any future feature (message history search, document search, email search).

## Infrastructure

- **Embedding model:** Configured via `EMBEDDING_MODEL` env var (default deployment: `bge-m3`, 1024 dimensions, multilingual, pt-BR native). All code references the env var — never hardcoded.
- **Ollama instance:** `192.168.2.13:11434` (existing, dedicated machine)
- **Storage:** SQLite (`data/embeddings/embeddings.db`) — own directory, own mount, independent of TaskFlow
- **Vector search:** Pure JS cosine similarity (sufficient for <1000 items per collection)
- **Config:** `OLLAMA_HOST` and `EMBEDDING_MODEL` in `.env`

## Architecture

The embedding service is a standalone module with no knowledge of TaskFlow, tasks, or boards. Consumers (TaskFlow being the first) register collections and call the service API.

```
                        Embedding Service (generic)
                     ┌──────────────────────────────────┐
                     │  embedding-service.ts             │
                     │                                    │
                     │  • index(collection, id, text)     │
                     │  • search(collection, query, opts) │
                     │  • findSimilar(collection, text)   │
                     │  • remove(collection, id)          │
                     │  • removeCollection(collection)    │
                     │                                    │
                     │  Background indexer:               │
                     │  • processes pending queue          │
                     │  • calls Ollama BGE-M3              │
                     │  • stores vectors in embeddings.db  │
                     └──────────┬─────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
   │ TaskFlow     │    │ Future:      │    │ Future:      │
   │ (first       │    │ Message      │    │ PDF/Email    │
   │  consumer)   │    │ History      │    │ Search       │
   └──────────────┘    └──────────────┘    └──────────────┘
```

**Key decisions:**
- Embedding service is **generic** — it knows about collections and items, not tasks or boards
- Storage is in its own `data/embeddings.db`, not inside `taskflow.db` — clean separation, no coupling
- Host process owns the service — containers access pre-computed vectors via shared DB mount
- Container calls Ollama directly for query-time embeddings (search, duplicate check)
- If Ollama unreachable, all features fall back silently to existing behavior
- `OLLAMA_HOST` loaded on host via `readEnvFile()`. Delivered to container via Docker `-e` flag in `buildContainerArgs()`. Inside container, forwarded to MCP subprocess via `buildNanoclawMcpEnv()` in `runtime-config.ts` (add `NANOCLAW_OLLAMA_HOST` to the env whitelist).
- No dependency on `add-taskflow` — the embedding service works independently. TaskFlow integration is done by the TaskFlow code calling the service.

## Storage Schema

Separate database at `data/embeddings/embeddings.db`. Own directory, independent of TaskFlow.

### Two access modes

The embedding DB has two distinct clients with different lifecycles:

1. **`EmbeddingService` (host, read-write):** Created once in `src/index.ts` at startup. Constructor opens the DB in read-write mode, runs `db.exec(SCHEMA)` to bootstrap/migrate the schema, then starts the background indexer. This is the ONLY writer.

2. **`EmbeddingReader` (container, read-only):** A lightweight read-only class used inside the container for search and duplicate detection. Opens the DB with `{ readonly: true }` — does NOT attempt schema creation. If `embeddings.db` doesn't exist yet (first-ever boot, before the host indexer runs), the reader returns empty results gracefully (no crash, no schema error). The file is mounted read-only into the container via Docker `-v data/embeddings.db:/workspace/embeddings.db:ro`.

This split guarantees: (a) schema is created only by the host writer, (b) the container never writes, (c) a missing DB on first boot is a no-op not a crash.

### Journal mode and concurrency

The host `EmbeddingService` opens the DB with **WAL mode** (`PRAGMA journal_mode=WAL`) and `busy_timeout: 5000`. WAL allows:
- One writer (host indexer) + multiple concurrent readers (containers) without blocking
- Readers see a consistent snapshot even during writes
- No lock contention between host writes and container reads

The container's `EmbeddingReader` opens read-only — WAL mode is inherited from the DB file and requires no configuration on the reader side.

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  collection TEXT NOT NULL,
  item_id TEXT NOT NULL,
  vector BLOB,                -- NULL means pending indexing
  source_text TEXT NOT NULL,
  model TEXT NOT NULL,         -- NO DEFAULT — always set from config
  metadata TEXT DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, item_id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_collection ON embeddings(collection);
CREATE INDEX IF NOT EXISTS idx_embeddings_pending ON embeddings(collection) WHERE vector IS NULL;
```

- `collection`: namespace for items (e.g., `"tasks:board-seci-taskflow"`, `"messages:sec-secti"`)
- `item_id`: unique within a collection (e.g., task ID `"T15"`, message ID)
- `vector`: Float32Array as Buffer (1024 × 4 bytes = 4KB per item). **NULL means pending** — the indexer picks up NULL vectors for processing.
- `source_text`: the text that was embedded — used to detect when re-embedding is needed
- `metadata`: optional JSON for consumer-specific data (e.g., `{"title": "...", "assignee": "..."}`)
- `model`: the model that produced the vector. **No default** — always set from the single config source (`EMBEDDING_MODEL` env var). On model change, all items are marked for re-embedding.
- Index on `collection` for scoped queries; partial index on `vector IS NULL` for efficient pending-item lookup

## Component 1: Embedding Service

**File:** `src/embedding-service.ts`

A class that encapsulates all embedding operations. No knowledge of TaskFlow.

```typescript
class EmbeddingService {
  constructor(dbPath: string, ollamaHost: string, model: string)

  // Index a single item (queued for async processing)
  index(collection: string, itemId: string, text: string, metadata?: Record<string, any>): void

  // Index multiple items in one call
  indexBatch(items: Array<{ collection: string; itemId: string; text: string; metadata?: Record<string, any> }>): void

  // Search a collection by text similarity (calls Ollama for query embedding)
  async search(collection: string, queryText: string, opts?: {
    limit?: number;        // default 20
    threshold?: number;    // default 0.3
  }): Promise<Array<{ itemId: string; score: number; metadata: Record<string, any> }>>

  // Find the most similar existing item (for duplicate detection)
  async findSimilar(collection: string, text: string, threshold?: number):
    Promise<{ itemId: string; score: number; metadata: Record<string, any> } | null>

  // Remove a single item
  remove(collection: string, itemId: string): void

  // Remove all items in a collection
  removeCollection(collection: string): void

  // Start background processing loop (call once at startup)
  startIndexer(intervalMs?: number): void

  // Stop background processing
  stopIndexer(): void
}
```

### Background Indexer

The `startIndexer()` method runs `setInterval(10_000)`. Each cycle:

1. **Model change detection** — if configured model differs from stored, mark ALL for re-embedding (runs once per model change, not every cycle):
   ```sql
   UPDATE embeddings SET vector = NULL WHERE model != ?
   ```
   This uses the configured `EMBEDDING_MODEL` (single source of truth) — never a hardcoded string.

2. **Query pending items** — staleness decided entirely in SQL, no post-fetch JS filtering. Uses deterministic ordering (`ORDER BY updated_at ASC`) so oldest items are processed first — no starvation:
   ```sql
   SELECT collection, item_id, source_text
   FROM embeddings
   WHERE vector IS NULL
   ORDER BY updated_at ASC
   LIMIT 20
   ```
   The `vector IS NULL` condition catches both new items (inserted by `index()`) and model-change invalidated items (set to NULL in step 1). The partial index `idx_embeddings_pending` makes this query fast.

3. **Batch-call Ollama:**
   ```
   POST /api/embed { "model": "<EMBEDDING_MODEL>", "input": [text1, text2, ...] }
   ```
   Model name comes from the single config source, never hardcoded.

4. **Update vectors:**
   ```sql
   UPDATE embeddings SET vector = ?, model = ?, updated_at = ? WHERE collection = ? AND item_id = ?
   ```

**How `index()` works — compare-before-write:**

`index()` does NOT blindly `INSERT OR REPLACE` (which would destroy existing vectors). Instead it uses an explicit two-step check:

```typescript
index(collection: string, itemId: string, text: string, metadata?: Record<string, any>): void {
  const existing = this.db.prepare(
    `SELECT source_text, model FROM embeddings WHERE collection = ? AND item_id = ?`
  ).get(collection, itemId) as { source_text: string; model: string } | undefined;

  if (existing && existing.source_text === text && existing.model === this.model) {
    // Source text and model unchanged — skip, preserve existing vector
    return;
  }

  // New item OR source_text/model changed — upsert with vector = NULL (pending)
  this.db.prepare(
    `INSERT INTO embeddings (collection, item_id, vector, source_text, model, metadata, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT (collection, item_id) DO UPDATE SET
       vector = NULL, source_text = excluded.source_text, model = excluded.model,
       metadata = excluded.metadata, updated_at = excluded.updated_at`
  ).run(collection, itemId, text, this.model, JSON.stringify(metadata ?? {}), new Date().toISOString());
}
```

Key behaviors:
- **Unchanged items:** `SELECT` finds matching `source_text` and `model` → early return, no write, existing vector preserved
- **Changed items:** `INSERT ... ON CONFLICT DO UPDATE` sets `vector = NULL` → indexer picks it up next cycle
- **New items:** `INSERT` with `vector = NULL` → indexer picks it up
- The periodic TaskFlow sync calls `index()` for every active task — unchanged tasks are a cheap SELECT + comparison, NOT a destructive REPLACE

**No starvation guarantee:** Since pending items are selected purely by `WHERE vector IS NULL ORDER BY updated_at ASC LIMIT 20`, every item will eventually be processed. After a model change that invalidates 500 items, it takes 25 cycles (250 seconds) to re-embed all — no items are skipped.

**Error handling:** Ollama failures logged as warnings, never crash. Retry next cycle. DB uses `busy_timeout: 5000`.

## Component 2: TaskFlow Integration — Semantic Search

TaskFlow is the first consumer. The integration happens in two places:

### Host side (indexing)

**File:** `src/index.ts` — after main loop starts, register a TaskFlow indexer that watches for task changes:

```typescript
const embeddingService = new EmbeddingService(
  path.join(DATA_DIR, 'embeddings.db'),
  ollamaHost,
  embeddingModel,
);
embeddingService.startIndexer();

// TaskFlow task indexer — polls taskflow.db and feeds embedding service
startTaskflowEmbeddingSync(embeddingService, getTaskflowDb());
```

**File:** `src/taskflow-embedding-sync.ts` — thin adapter that reads tasks from taskflow.db and calls `embeddingService.index()`:

```typescript
function startTaskflowEmbeddingSync(service: EmbeddingService, tfDb: Database) {
  setInterval(() => {
    // 1. Index all active tasks (idempotent — unchanged source_text is a no-op)
    const tasks = tfDb.prepare(
      `SELECT board_id, id, title, description, next_action, assignee, column
       FROM tasks WHERE column != 'done'`
    ).all();

    const activeKeys = new Set<string>(); // "collection\0item_id"
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

    // 2. Remove stale embeddings for tasks that are done, archived, or deleted.
    //    Query all task collections from embeddings.db and remove any item
    //    not in the active set.
    const allTaskCollections = service.getCollections('tasks:');
    for (const collection of allTaskCollections) {
      const items = service.getItemIds(collection);
      for (const itemId of items) {
        if (!activeKeys.has(`${collection}\0${itemId}`)) {
          service.remove(collection, itemId);
        }
      }
    }
  }, 15_000); // slightly offset from embedding indexer
}
```

**Cleanup lifecycle:** When a task moves to `done`, gets archived, or is cancelled/deleted, it disappears from the `WHERE column != 'done'` query. On the next sync cycle (≤15s), its embedding is removed. This ensures:
- Completed tasks don't appear in semantic search results
- Archived tasks don't trigger false duplicate warnings
- Deleted boards' tasks are cleaned up (their collections empty out naturally)

**Helper methods on EmbeddingService:**
- `getCollections(prefix?: string)`: returns distinct collection names (optionally filtered by prefix)
- `getItemIds(collection: string)`: returns all item IDs in a collection (lightweight — no vector data loaded)

### Container side (search + duplicate detection)

**Integration point:** The async MCP handler in `ipc-mcp-stdio.ts`.

**Semantic search flow:**

```
MCP handler receives taskflow_query({ query: 'search', search_text: '...' })
  │
  ├─ 1. Async: embed search_text via Ollama (2s timeout)
  │     POST http://$OLLAMA_HOST/api/embed { model: 'bge-m3', input: search_text }
  │     → queryVector (Float32Array) or null on failure
  │
  ├─ 2. Pass queryVector to engine:
  │     engine.query({ query: 'search', search_text, query_vector: queryVector })
  │
  └─ 3. Inside engine.query() (sync):
       ├─ Lexical: LIKE '%text%' → textMatches[]
       ├─ If queryVector provided:
       │   Load embeddings for collection 'tasks:{boardId}' from embeddings.db
       │   Cosine similarity in JS → semanticMatches[]
       │   Merge: lexical matches get +0.2 boost
       │   Filter by threshold (>0.3)
       │   Sort by score, return top 20
       └─ If no queryVector: return lexical only (fallback)
```

**Note:** The engine reads from `embeddings.db` (not `taskflow.db`). The container needs read access to `data/embeddings.db` — add as an additional mount in `container-runner.ts`.

**Cosine similarity (pure JS):**
```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Environment variable delivery chains:**

Both `OLLAMA_HOST` and `EMBEDDING_MODEL` follow the same propagation path:

1. **Host:** `readEnvFile(['OLLAMA_HOST', 'EMBEDDING_MODEL'])` in `container-runner.ts` (same pattern as `readSecrets()`)
2. **Docker:** `-e OLLAMA_HOST=${ollamaHost} -e EMBEDDING_MODEL=${embeddingModel}` in `buildContainerArgs()`
3. **MCP subprocess:** Add both to `buildNanoclawMcpEnv()` in `runtime-config.ts`:
   ```typescript
   NANOCLAW_OLLAMA_HOST: process.env.OLLAMA_HOST ?? '',
   NANOCLAW_EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? 'bge-m3',
   ```
4. **ipc-mcp-stdio.ts:** Reads `process.env.NANOCLAW_OLLAMA_HOST` and `process.env.NANOCLAW_EMBEDDING_MODEL`

This guarantees the host indexer and container query paths use the **same model** — both derive from the single `.env` source, threaded through the same explicit chain. The `'bge-m3'` fallback in step 3 is a safety net only — the `.env` file should always set `EMBEDDING_MODEL`.

## Component 3: TaskFlow Integration — Duplicate Detection

**Integration point:** The async MCP handler in `ipc-mcp-stdio.ts`, wrapping `taskflow_create`.

The Ollama embed call is async and happens BEFORE calling `engine.create()` (which is sync/transactional). This avoids holding the SQLite transaction open during a network call.

**Flow:**

```
MCP handler receives taskflow_create({ title: '...', ... })
  │
  ├─ 1. If force_create: true, skip to step 5
  │
  ├─ 2. Async: embed title+description via Ollama (2s timeout)
  │     → newVector or null on failure
  │
  ├─ 3. If newVector: load embeddings for 'tasks:{boardId}', find best match
  │     (sync: reads from embeddings.db, JS cosine similarity)
  │
  ├─ 4. If best match > 0.85:
  │     return {
  │       success: false,
  │       duplicate_warning: {
  │         similar_task_id: 'T7',
  │         similar_task_title: 'Trocar filtro de linha',
  │         similarity: 0.89
  │       },
  │       error: 'Tarefa similar encontrada: T7 — Trocar filtro... (89%). Criar mesmo assim?'
  │     }
  │
  └─ 5. Call engine.create(params) — existing sync transactional flow unchanged
```

**New param:** `force_create?: boolean` added to the MCP tool Zod schema for `taskflow_create` in `ipc-mcp-stdio.ts`. This param is consumed by the MCP handler (to skip the duplicate check) and is NOT passed to `engine.create()` — the engine's `CreateParams` is unchanged.

**CLAUDE.md instruction:**
```
When taskflow_create returns duplicate_warning, present:
"⚠️ Tarefa similar encontrada: *[ID]* — [título] ([similarity]%). Criar mesmo assim?"
If user confirms, re-call with force_create: true.
```

**If Ollama unreachable:** Skip duplicate check silently — never block creation.

## Component 4: TaskFlow Integration — Augmented Context Retrieval

**Integration point:** `src/container-runner.ts` (or `src/index.ts`), before container launch. Modifies the **prompt preamble** written to the container input, NOT a snapshot file.

**Clarification:** There is no TaskFlow "snapshot file" — the container reads taskflow.db directly via MCP tools. The context optimization works by injecting a compact board summary into the **prompt text** that the agent receives, reducing the need for the agent to query the full board on every session start.

### Build boundary constraint

**Problem:** `TaskflowEngine` lives in `container/agent-runner/src/` — a separate TypeScript package compiled by the container's `tsconfig.json`, not the host's. The host cannot `import { TaskflowEngine }` without restructuring the build layout.

**Solution:** The context preamble is generated **inside the container** by the engine (which already has visibility rules), NOT on the host. The host's only role is embedding the user message and injecting the query vector into `containerInput.prompt`.

### Visibility contract

Visibility is handled by the engine's existing `visibleTaskScope()` — no rules are duplicated on the host. The new `buildContextSummary()` method lives in `taskflow-engine.ts` (container side) and uses the same scope as all other queries.

### Delivery mechanism: prompt injection

The context summary is injected into `containerInput.prompt` **before the SDK query starts** — not via MCP tool responses or system context. This is the simplest and most reliable path:

1. Host embeds the user message via Ollama → `queryVector`
2. Host passes `queryVector` as base64 in `containerInput.queryVector`
3. In `container/agent-runner/src/index.ts`, before calling `runQuery()`, the agent-runner:
   - Reads `containerInput.queryVector` (if present)
   - Instantiates `TaskflowEngine` + `EmbeddingReader`
   - Calls `engine.buildContextSummary(queryVector)` → preamble string
   - Prepends preamble to `prompt` before passing it to `runQuery()`

This uses the existing `containerInput.prompt` → `runQuery(prompt)` path in `index.ts`. No MCP tool call needed. The agent sees the preamble as part of its initial prompt — before it decides to call any tools.

**Why prompt injection (not MCP tool):**
- MCP tools only fire after the agent decides to call them — too late to replace the "load the board" behavior
- Prompt injection happens before the SDK query starts — the agent has context from the first token
- No CLAUDE.md changes needed ("call this tool first") — the preamble is just there
- Same mechanism as `containerInput.imageAttachments` — proven pattern

### Flow

**Current flow:**
1. User sends message → host builds prompt
2. Container starts, agent queries full board via MCP tools (~10,000 tokens)

**New flow:**
1. User sends message → host embeds message via Ollama → `queryVector`
2. Host sets `containerInput.queryVector = base64(queryVector)`
3. Container `index.ts` reads queryVector, calls `engine.buildContextSummary(queryVector)`:
   - Uses `visibleTaskScope()` for correct visibility (standard + delegated)
   - Loads vectors from `embeddings.db` via `EmbeddingReader`
   - Ranks visible tasks by cosine similarity
   - Returns formatted preamble:
   ```
   [Board context: 3 inbox, 5 next_action, 2 in_progress, 1 waiting, 1 overdue (T4, 12/03).
   Relevant tasks for this message:
   - T15 Projeto HomeLab (next_action, Giovanni, prazo 16/03, próxima ação: apresentar arquitetura)
   - T4 Migração nuvem SEMF/DSF (in_progress, Giovanni, prazo 31/03)
   Other tasks: T8 Hackaton SECTI, T9 PowerBI SEMPLAN, ...]
   ```
4. Preamble prepended to prompt → `runQuery(preamble + '\n\n' + prompt)`
5. Agent has context from first token — can still query MCP for full details if needed

**Token savings:** ~75% reduction (from ~10,000 to ~2,600 for a 50-task board).

**Fallback:** If no queryVector provided (Ollama unreachable) or `EmbeddingReader` returns empty, skip preamble — agent queries board as usual.

### embeddings.db storage and mount

The DB lives at `data/embeddings/embeddings.db` — its own directory, independent of TaskFlow. The directory (not the file) is mounted so SQLite WAL journal files (`-wal`, `-shm`) persist correctly — same pattern as the TaskFlow mount.

**New mount in `container-runner.ts`** (always added, not gated by `taskflowManaged`):
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

**Lifecycle:**
- Host creates `data/embeddings/` directory and `embeddings.db` at `EmbeddingService` instantiation (startup, before any container launch)
- Container opens `/workspace/embeddings/embeddings.db` read-only via `EmbeddingReader`
- If DB file doesn't exist yet (first boot race): directory mount succeeds (empty dir), `EmbeddingReader` catches the open error, returns empty results — no crash
- First indexer cycle populates the DB; subsequent container launches see data
- Mount is always present — works for TaskFlow boards, main group, and any future non-TaskFlow groups

## Skill Design

This is a **standalone skill** (`add-embeddings`) with **no dependencies** on other skills. It provides a generic embedding service. TaskFlow integration is included but the core service is reusable.

### Skill directory structure

```
.claude/skills/add-embeddings/
├── SKILL.md                                          # Phases: pre-flight, apply, configure, verify
├── manifest.yaml                                     # Metadata, deps, file lists
├── add/
│   └── src/
│       ├── embedding-service.ts                      # Generic embedding service (host, read-write)
│       ├── embedding-reader.ts                       # Read-only query client (container)
│       ├── embedding-service.test.ts                 # Tests
│       └── taskflow-embedding-sync.ts                # TaskFlow adapter (feeds tasks into service)
├── modify/
│   ├── src/
│   │   ├── index.ts                                  # Reference file
│   │   ├── index.ts.intent.md                        # Start embedding service + TaskFlow sync
│   │   ├── container-runner.ts                       # Reference file
│   │   └── container-runner.ts.intent.md             # OLLAMA_HOST + EMBEDDING_MODEL env vars, queryVector in containerInput
│   └── container/agent-runner/src/
│       ├── index.ts                                  # Reference file
│       ├── index.ts.intent.md                        # Read queryVector from containerInput, build context preamble, prepend to prompt
│       ├── runtime-config.ts                         # Reference file
│       ├── runtime-config.ts.intent.md               # Add NANOCLAW_OLLAMA_HOST + NANOCLAW_EMBEDDING_MODEL to MCP env
│       ├── ipc-mcp-stdio.ts                          # Reference file
│       ├── ipc-mcp-stdio.ts.intent.md                # Async Ollama wrapping, force_create schema
│       ├── taskflow-engine.ts                        # Reference file
│       └── taskflow-engine.ts.intent.md              # query_vector param, cosine similarity, buildContextSummary()
└── tests/
    └── embeddings.test.ts                            # Skill integration test
```

### manifest.yaml

```yaml
skill: add-embeddings
version: 1.0.0
description: "Generic embedding service with semantic search, duplicate detection, and context retrieval. First consumer: TaskFlow."
core_version: 1.2.12
adds:
  - src/embedding-service.ts
  - src/embedding-reader.ts
  - src/embedding-service.test.ts
  - src/taskflow-embedding-sync.ts
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
test: "npx vitest run --config vitest.skills.config.ts .claude/skills/add-embeddings/tests/embeddings.test.ts"
```

### SKILL.md phases

1. **Pre-flight:** Check Ollama is reachable (`curl $OLLAMA_HOST/api/tags`), verify BGE-M3 model is loaded
2. **Apply code changes:** Copy files from `add/`, apply modifications using `modify/` intent files as guidance, rebuild (`npm run build && ./container/build.sh`)
3. **Configure:** Add `OLLAMA_HOST` and `EMBEDDING_MODEL` to `.env`. If TaskFlow is installed, patch existing group CLAUDE.md files with `duplicate_warning` handling instruction
4. **Verify:** If TaskFlow installed, send a search query via WhatsApp and confirm semantic results; create a near-duplicate task and confirm warning. Otherwise, verify indexer starts in logs.

### CLAUDE.md changes (TaskFlow only)

During Phase 3, if TaskFlow is installed, the skill patches existing group CLAUDE.md files to add:
```
When taskflow_create returns duplicate_warning, present:
"⚠️ Tarefa similar encontrada: *[ID]* — [título] ([similarity]%). Criar mesmo assim?"
If user confirms, re-call with force_create: true.
```

## Design Decisions

### Q: Context preamble for delegated child-board views?
**A: Yes.** The `buildContextSummary()` method uses `visibleTaskScope()` which handles both standard and delegated views. No special case needed.

### Q: Silent fallback for duplicate detection?
**A: Silent fallback with audit logging.** When Ollama is unreachable and duplicate detection is skipped, the MCP handler logs a warning: `logger.warn({ reason: 'ollama_unreachable' }, 'Duplicate detection skipped')`. The task is still created successfully. This is an acceptable trade-off for MVP — the alternative (blocking creation) is worse UX. Monitoring the log for repeated `ollama_unreachable` warnings surfaces the issue operationally.

### Q: Model configuration — single source of truth
**A:** `EMBEDDING_MODEL` env var is the single canonical source. Every path that writes or reads model information derives from this value:
- `EmbeddingService` constructor reads it once and stores as `this.model`
- `index()` writes `this.model` to the `model` column
- Indexer step 1 compares `model != this.model` to detect changes
- Ollama embed calls use `this.model` as the request model
- No hardcoded model strings anywhere in code (the schema has no DEFAULT on `model` column)

## Required Test Coverage

| Test | What it validates |
|------|-------------------|
| **Schema auto-creation** | Start from empty `data/` dir → `EmbeddingService` constructor creates `embeddings.db` with correct schema before any operation |
| **Indexer no-starvation** | Insert 150 items → model change → verify all 150 get re-embedded over multiple cycles (no items stuck) |
| **Visibility parity** | Delegated board: `buildContextSummary()` returns same task set as `visibleTaskScope()` query |
| **Model switch reindex** | Change `EMBEDDING_MODEL` → verify all vectors set to NULL → verify re-embed uses new model |
| **Duplicate detection fallback** | Mock Ollama as unreachable → verify `taskflow_create` succeeds with warning log (no block) |
| **Source text idempotency** | Call `index()` twice with same text → verify vector is NOT re-computed (no unnecessary Ollama calls) |
| **WAL concurrency** | Host writer + container reader concurrent access → reader gets consistent results, no SQLITE_BUSY errors |
| **Stale cleanup** | Move task to done → next sync cycle removes its embedding → search no longer returns it |
| **Read-only graceful fallback** | `EmbeddingReader` opens non-existent `embeddings.db` → returns empty results, no crash |

## Configuration

```env
# .env
OLLAMA_HOST=http://192.168.2.13:11434
EMBEDDING_MODEL=bge-m3
```

Hardcoded for MVP (tunable later):
- Similarity threshold: 0.85 (duplicate detection)
- Search threshold: 0.3 (semantic search)
- Indexer interval: 10,000ms
- Ollama timeout: 2,000ms
- Batch size: 20 items per indexer cycle

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Ollama unreachable | Indexer warns + retries next cycle. Search returns lexical only. Create skips duplicate check. Prompt preamble skipped. |
| embeddings.db locked | Indexer retries next cycle (busy_timeout: 5000ms). |
| Malformed vector from Ollama | Skip that item, log warning. |
| embeddings.db missing | Auto-created on first `new EmbeddingService()` call. |
| BGE-M3 model not loaded in Ollama | Ollama returns error, treated as unreachable. |
| Model changed in .env | Indexer detects mismatch, marks all items for re-embedding (`vector = NULL`). |
| TaskFlow not installed | Embedding service starts but TaskFlow sync is skipped (no taskflow.db). Generic service still works for future consumers. |
