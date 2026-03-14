# Generic Embedding Service for NanoClaw (BGE-M3)

**Date:** 2026-03-14
**Status:** Approved
**Skill:** `add-embeddings`

## Summary

Add a generic embedding service to NanoClaw powered by BGE-M3 via Ollama. The service indexes, searches, and deduplicates text content organized into named collections. TaskFlow is the first consumer (semantic task search, duplicate detection, augmented context retrieval), but the service is reusable by any future feature (message history search, document search, email search).

## Infrastructure

- **Embedding model:** Configured via `EMBEDDING_MODEL` env var (default deployment: `bge-m3`, 1024 dimensions, multilingual, pt-BR native). All code references the env var — never hardcoded.
- **Ollama instance:** `192.168.2.13:11434` (existing, dedicated machine)
- **Storage:** SQLite (`data/embeddings.db`) — separate DB, not inside taskflow.db
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

Separate database at `data/embeddings.db`. **Schema is created by the `EmbeddingService` constructor** — not by `initTaskflowDb()` or any external migration. The constructor calls `db.exec(SCHEMA)` on every instantiation, using `CREATE TABLE IF NOT EXISTS` (idempotent). This guarantees the table exists before any read/write path, whether on a fresh install or an existing deployment.

The container also opens `embeddings.db` read-only for search — the same constructor is used, so schema is guaranteed there too.

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

**How `index()` works:**
- `index(collection, id, text, metadata)` calls `INSERT OR REPLACE` with `vector = NULL`
- If the `source_text` hasn't changed (same as stored), it's a no-op (the INSERT OR REPLACE produces an identical row, vector stays non-NULL)
- If `source_text` changed, the new row has `vector = NULL`, triggering re-embedding on the next cycle
- This means the consumer (`taskflow-embedding-sync.ts`) can call `index()` on every sync cycle without concern — unchanged items are free

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
    const tasks = tfDb.prepare(
      `SELECT board_id, id, title, description, next_action, assignee, column
       FROM tasks WHERE column != 'done'`
    ).all();

    for (const task of tasks) {
      const collection = `tasks:${task.board_id}`;
      const text = buildSourceText(task);
      service.index(collection, task.id, text, {
        title: task.title,
        assignee: task.assignee,
        column: task.column,
      });
    }

    // Clean collections for deleted tasks
    // (service.index is idempotent — unchanged source_text is a no-op)
  }, 15_000); // slightly offset from embedding indexer
}
```

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

**OLLAMA_HOST delivery chain:**
1. **Host:** `readEnvFile(['OLLAMA_HOST'])` in `container-runner.ts` (same pattern as `readSecrets()`)
2. **Docker:** `-e OLLAMA_HOST=${ollamaHost}` in `buildContainerArgs()`
3. **MCP subprocess:** Add `NANOCLAW_OLLAMA_HOST: process.env.OLLAMA_HOST ?? ''` to `buildNanoclawMcpEnv()` in `runtime-config.ts`
4. **ipc-mcp-stdio.ts:** Reads `process.env.NANOCLAW_OLLAMA_HOST`

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

### Visibility contract

**Problem:** TaskFlow visibility is complex — `visibleTaskScope()` includes both `board_id = ?` AND delegated tasks via `child_exec_board_id = ? AND child_exec_enabled = 1`. A naive host-side query would miss delegated tasks or expose tasks the agent shouldn't see.

**Solution:** The host does NOT reconstruct visibility rules. Instead, it uses the **engine itself** to generate the summary. The host instantiates `TaskflowEngine` with the board's `taskflow.db` and calls a new method `engine.buildContextSummary(queryVector)` that:
1. Uses the existing `visibleTaskScope()` for correct visibility
2. Queries column counts via the same scope
3. Ranks visible tasks against `queryVector` using embeddings from `embeddings.db`
4. Returns a formatted preamble string

This guarantees **visibility parity** — the context preamble shows exactly the same task universe the agent would see via MCP queries. The engine method is synchronous (reads pre-computed vectors, no Ollama call). The async Ollama embed call for the user message happens on the host before calling the engine.

**Applies to:** Standard boards AND delegated child-board views — the engine handles both via `visibleTaskScope()`.

### Flow

**Current flow:**
1. User sends message → host builds prompt from message text
2. Container starts, agent reads CLAUDE.md + queries full board via MCP tools
3. Agent uses ~10,000 tokens loading all tasks

**New flow:**
1. User sends message → host embeds message via Ollama (async) → `queryVector`
2. Host instantiates `TaskflowEngine` for the board, calls `engine.buildContextSummary(queryVector)`
3. Engine queries visible tasks (using `visibleTaskScope()`), ranks by similarity, returns formatted preamble:
   ```
   [Board context: 3 inbox, 5 next_action, 2 in_progress, 1 waiting, 1 overdue (T4, 12/03).
   Relevant tasks for this message:
   - T15 Projeto HomeLab (next_action, Giovanni, prazo 16/03, próxima ação: apresentar arquitetura)
   - T4 Migração nuvem SEMF/DSF (in_progress, Giovanni, prazo 31/03)
   Other tasks: T8 Hackaton SECTI, T9 PowerBI SEMPLAN, ...]
   ```
4. Host prepends preamble to the container prompt
5. Agent has immediate context without querying — can still query MCP for full details if needed

**Token savings:** ~75% reduction (from ~10,000 to ~2,600 for a 50-task board: 200 summary + 2,000 for 10 detailed tasks + 400 for 40 one-liners).

**Fallback:** If Ollama unreachable or no embeddings, no preamble injected — agent queries board as usual.

## Skill Design

This is a **standalone skill** (`add-embeddings`) with **no dependencies** on other skills. It provides a generic embedding service. TaskFlow integration is included but the core service is reusable.

### Skill directory structure

```
.claude/skills/add-embeddings/
├── SKILL.md                                          # Phases: pre-flight, apply, configure, verify
├── manifest.yaml                                     # Metadata, deps, file lists
├── add/
│   └── src/
│       ├── embedding-service.ts                      # Generic embedding service class
│       ├── embedding-service.test.ts                 # Tests
│       └── taskflow-embedding-sync.ts                # TaskFlow adapter (feeds tasks into service)
├── modify/
│   ├── src/
│   │   ├── index.ts                                  # Reference file
│   │   ├── index.ts.intent.md                        # Start embedding service + TaskFlow sync
│   │   ├── container-runner.ts                       # Reference file
│   │   └── container-runner.ts.intent.md             # OLLAMA_HOST env, embeddings.db mount, prompt preamble
│   └── container/agent-runner/src/
│       ├── runtime-config.ts                         # Reference file
│       ├── runtime-config.ts.intent.md               # Add NANOCLAW_OLLAMA_HOST to MCP env
│       ├── ipc-mcp-stdio.ts                          # Reference file
│       ├── ipc-mcp-stdio.ts.intent.md                # Async Ollama wrapping, force_create schema
│       ├── taskflow-engine.ts                        # Reference file
│       └── taskflow-engine.ts.intent.md              # query_vector param, cosine similarity, read embeddings.db
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
  - src/embedding-service.test.ts
  - src/taskflow-embedding-sync.ts
modifies:
  - src/index.ts
  - src/container-runner.ts
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
