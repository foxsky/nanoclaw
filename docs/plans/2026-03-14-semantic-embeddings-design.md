# Semantic Embeddings for TaskFlow (BGE-M3)

**Date:** 2026-03-14
**Status:** Approved
**Skill:** `add-embeddings`

## Summary

Integrate BGE-M3 embeddings via Ollama into TaskFlow for semantic task search, duplicate detection on creation, and augmented context retrieval for agent sessions. Delivered as a new NanoClaw skill (`add-embeddings`).

## Infrastructure

- **Embedding model:** BGE-M3 (1024 dimensions, multilingual, pt-BR native)
- **Ollama instance:** `192.168.2.13:11434` (existing, dedicated machine)
- **Storage:** SQLite (taskflow.db) — direct `db.prepare()` calls, no abstraction layer
- **Vector search:** Pure JS cosine similarity (sufficient for <1000 tasks)
- **Config:** `OLLAMA_HOST` and `EMBEDDING_MODEL` in `.env`

## Architecture

Hybrid approach — background indexer on host + query functions in container MCP handler.

```
Host Process                          Docker Container
┌────────────────────────┐           ┌──────────────────────────┐
│ Embedding Indexer      │           │ ipc-mcp-stdio.ts         │
│ (setInterval 10s)      │           │ (async MCP handler)      │
│                        │           │                          │
│ • finds un-embedded    │           │ taskflow_query 'search': │
│   tasks in taskflow.db │           │   1. call Ollama (async) │
│ • calls Ollama BGE-M3  │           │   2. engine.query()      │
│ • stores vectors in    │           │      (sync, reads vecs)  │
│   task_embeddings      │           │   3. return ranked       │
│                        │           │                          │
│ Context Builder        │           │ taskflow_create:         │
│ • embeds user message  │           │   1. call Ollama (async) │
│   before container     │           │   2. check duplicates    │
│   launch               │           │      (sync, reads vecs)  │
│ • builds augmented     │           │   3. if dup, return warn │
│   prompt preamble      │           │   4. else engine.create()│
└───────────┬────────────┘           └──────────────────────────┘
            │                                    │
            ▼                                    ▼
     ┌──────────────┐                   Ollama @ 192.168.2.13
     │ taskflow.db  │                   (container has LAN access)
     │ ┌──────────┐ │
     │ │ tasks    │ │   ◄── shared mount
     │ │ task_emb │ │
     │ └──────────┘ │
     └──────────────┘
```

**Key decisions:**
- Host owns the indexer — containers never write embeddings
- Semantic search and duplicate detection happen in the **async MCP handler** (`ipc-mcp-stdio.ts`), NOT inside the synchronous `taskflow-engine.ts` methods. The MCP handler calls Ollama (async), then passes results to the engine (sync).
- Container has LAN access to Ollama at `192.168.2.13` (verified via `curl` from container)
- Indexer runs in the main process (setInterval), not a separate service
- If Ollama unreachable, all features fall back silently to existing behavior
- `OLLAMA_HOST` loaded on host via `readEnvFile(['OLLAMA_HOST', 'EMBEDDING_MODEL'])` (same pattern as secrets). Delivered to container via Docker `-e` flag in `buildContainerArgs()`. Inside container, forwarded to MCP subprocess via `buildNanoclawMcpEnv()` in `runtime-config.ts` (add `NANOCLAW_OLLAMA_HOST` to the env whitelist).

## Storage Schema

One new table in `taskflow-db.ts` (added to `initTaskflowDb()` using `CREATE TABLE IF NOT EXISTS` — idempotent, no `ALTER TABLE` migration needed):

```sql
CREATE TABLE IF NOT EXISTS task_embeddings (
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  vector BLOB NOT NULL,
  source_text TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'bge-m3',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (board_id, task_id)
);
```

- `vector`: Float32Array as Buffer (1024 × 4 bytes = 4KB per task)
- `source_text`: canonical formula is `buildSourceText(task)` = `task.title + ' ' + (task.description ?? '') + ' ' + (task.next_action ?? '')` — trimmed. The SAME function is used in both the indexer (to detect staleness) and in the SQL comparison query. This prevents byte-mismatch false positives.
- `model`: tracks which model produced the vector. On model change (env var differs from stored model), the indexer re-embeds all tasks.
- No vector index — full scan + JS cosine is sufficient at current scale

## Component 1: Background Indexer

**File:** `src/embedding-indexer.ts`

**Lifecycle:** `startEmbeddingIndexer(db)` called from `index.ts` after main loop starts. Runs `setInterval(10_000)`. DB connection uses `busy_timeout: 5000` to handle WAL contention with container.

**Each cycle:**

1. Query all non-done tasks with their current embedding state:
   ```sql
   SELECT t.board_id, t.id, t.title, t.description, t.next_action,
          e.source_text AS existing_source, e.model AS existing_model
   FROM tasks t
   LEFT JOIN task_embeddings e ON t.board_id = e.board_id AND t.id = e.task_id
   WHERE t.column != 'done'
   LIMIT 100
   ```
   Then in JS: filter to tasks where `existing_source !== buildSourceText(task) || existing_model !== currentModel` (null existing_source means new task). Take first 20 for this cycle's batch.

2. Build source texts, batch-call Ollama:
   ```
   POST /api/embed { "model": "bge-m3", "input": [text1, text2, ...] }
   ```

3. Upsert embeddings:
   ```sql
   INSERT OR REPLACE INTO task_embeddings (board_id, task_id, vector, source_text, model, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ```

4. Clean orphans (uses NOT EXISTS instead of multi-column NOT IN, which SQLite doesn't support):
   ```sql
   DELETE FROM task_embeddings
   WHERE NOT EXISTS (
     SELECT 1 FROM tasks
     WHERE tasks.board_id = task_embeddings.board_id
       AND tasks.id = task_embeddings.task_id
       AND tasks.column != 'done'
   )
   ```

**Cross-board note:** The indexer embeds tasks from ALL boards. This is intentional — the host process is trusted. The container-side query always filters by `board_id` via `visibleTaskScope()`, so no cross-board data leaks.

**Error handling:** Ollama failures logged as warnings, never crash. Retry next cycle.

## Component 2: Semantic Search

**Integration point:** The async MCP handler in `ipc-mcp-stdio.ts`, NOT inside the synchronous `taskflow-engine.ts`.

The `taskflow-engine.ts` query method remains synchronous. The async Ollama call happens in the MCP handler before calling the engine.

**Flow when user searches:**

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
       │   Load task_embeddings for visible tasks
       │   Cosine similarity in JS → semanticMatches[]
       │   Merge: lexical matches get +0.2 boost
       │   Filter by threshold (>0.3)
       │   Sort by score, return top 20
       └─ If no queryVector: return lexical only (fallback)
```

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

## Component 3: Duplicate Detection

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
  ├─ 3. If newVector: load task_embeddings for this board, find best match
  │     (sync: reads from taskflow.db, JS cosine similarity)
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

## Component 4: Augmented Context Retrieval

**Integration point:** `src/container-runner.ts` (or `src/index.ts`), before container launch. Modifies the **prompt preamble** written to the container input, NOT a snapshot file.

**Clarification:** There is no TaskFlow "snapshot file" — the container reads taskflow.db directly via MCP tools. The context optimization works by injecting a compact board summary into the **prompt text** that the agent receives, reducing the need for the agent to query the full board on every session start.

**Current flow:**
1. User sends message → host builds prompt from message text
2. Container starts, agent reads CLAUDE.md + queries full board via MCP tools
3. Agent uses ~10,000 tokens loading all tasks

**New flow:**
1. User sends message → host embeds message via Ollama
2. Host queries taskflow.db for board summary + ranked tasks
3. Host prepends a context preamble to the prompt:
   ```
   [Board context: 3 inbox, 5 next_action, 2 in_progress, 1 waiting, 1 overdue (T4, 12/03).
   Relevant tasks for this message:
   - T15 Projeto HomeLab (next_action, Giovanni, prazo 16/03, próxima ação: apresentar arquitetura)
   - T4 Migração nuvem SEMF/DSF (in_progress, Giovanni, prazo 31/03)
   Other tasks: T8 Hackaton SECTI, T9 PowerBI SEMPLAN, ...]
   ```
4. Agent has immediate context without querying — can still query MCP for full details if needed

**Token savings:** Agent skips the initial "show me the board" query in most sessions. Estimated ~75% reduction in board-loading tokens (from ~10,000 to ~2,600 for a 50-task board: 200 summary + 2,000 for 10 detailed tasks + 400 for 40 one-liners).

**Fallback:** If Ollama unreachable or no embeddings, no preamble injected — agent queries board as usual.

## Skill Design

This is a **standalone skill** (`add-embeddings`), NOT an upgrade to the `add-taskflow` skill. It follows the NanoClaw structured skill format (same as `add-image-vision`, `add-voice-transcription`, etc.).

### Skill directory structure

```
.claude/skills/add-embeddings/
├── SKILL.md                                          # Phases: pre-flight, apply, configure, verify
├── manifest.yaml                                     # Metadata, deps, file lists
├── add/
│   └── src/
│       ├── embedding-indexer.ts                      # Background indexer (host side)
│       ├── embedding-indexer.test.ts                 # Tests
│       └── embedding-utils.ts                        # Ollama client, cosine similarity, buildSourceText
├── modify/
│   ├── src/
│   │   ├── taskflow-db.ts                            # Reference file
│   │   ├── taskflow-db.ts.intent.md                  # Add task_embeddings table
│   │   ├── index.ts                                  # Reference file
│   │   ├── index.ts.intent.md                        # Start indexer after main loop
│   │   ├── container-runner.ts                       # Reference file
│   │   └── container-runner.ts.intent.md             # OLLAMA_HOST env, prompt preamble
│   └── container/agent-runner/src/
│       ├── runtime-config.ts                         # Reference file
│       ├── runtime-config.ts.intent.md               # Add NANOCLAW_OLLAMA_HOST to MCP env
│       ├── ipc-mcp-stdio.ts                          # Reference file
│       ├── ipc-mcp-stdio.ts.intent.md                # Async Ollama wrapping, force_create schema
│       ├── taskflow-engine.ts                        # Reference file
│       └── taskflow-engine.ts.intent.md              # query_vector param, cosine similarity
└── tests/
    └── embeddings.test.ts                            # Skill integration test
```

### manifest.yaml

```yaml
skill: add-embeddings
version: 1.0.0
description: "Semantic search, duplicate detection, and context retrieval via BGE-M3 embeddings"
core_version: 1.2.12
adds:
  - src/embedding-indexer.ts
  - src/embedding-indexer.test.ts
  - src/embedding-utils.ts
modifies:
  - src/taskflow-db.ts
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
depends:
  - add-taskflow
test: "npx vitest run --config vitest.skills.config.ts .claude/skills/add-embeddings/tests/embeddings.test.ts"
```

### SKILL.md phases

1. **Pre-flight:** Check Ollama is reachable (`curl $OLLAMA_HOST/api/tags`), verify BGE-M3 model is loaded, check `add-taskflow` is already applied (look for `src/taskflow-db.ts`)
2. **Apply code changes:** Copy files from `add/`, apply modifications using `modify/` intent files as guidance, rebuild (`npm run build && ./container/build.sh`)
3. **Configure:** Add `OLLAMA_HOST` and `EMBEDDING_MODEL` to `.env`, patch existing group CLAUDE.md files with `duplicate_warning` handling instruction
4. **Verify:** Send a search query via WhatsApp, confirm semantic results appear; create a near-duplicate task, confirm warning is shown

### Dependency

Requires `add-taskflow` to be installed first (needs `taskflow.db`, MCP tools, TaskFlow-managed groups). Declared in `manifest.yaml` as `depends: [add-taskflow]`.

### CLAUDE.md changes

During Phase 3, the skill patches existing group CLAUDE.md files to add to the "Tool Response Handling" section:
```
When taskflow_create returns duplicate_warning, present:
"⚠️ Tarefa similar encontrada: *[ID]* — [título] ([similarity]%). Criar mesmo assim?"
If user confirms, re-call with force_create: true.
```
This does NOT modify the `add-taskflow` template. Future boards provisioned after the skill is installed will get this instruction from the merged codebase automatically.

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
- Batch size: 20 tasks per indexer cycle

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Ollama unreachable | Indexer warns + retries next cycle. Search returns lexical only. Create skips duplicate check. Prompt preamble skipped. |
| taskflow.db locked | Indexer retries next cycle (busy_timeout: 5000ms). |
| Malformed vector from Ollama | Skip that task, log warning. |
| task_embeddings table missing | Auto-created by `CREATE TABLE IF NOT EXISTS` in initTaskflowDb(). |
| BGE-M3 model not loaded in Ollama | Ollama returns error, treated as unreachable. |
| Model changed in .env | Indexer detects `model` mismatch, re-embeds all tasks over next cycles. |
| Board deleted | Orphan cleanup removes embeddings for tasks no longer in `tasks` table. |
