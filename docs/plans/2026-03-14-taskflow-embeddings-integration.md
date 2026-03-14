# TaskFlow Embeddings Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the generic embedding service (from `add-embeddings`) into TaskFlow — semantic search, duplicate detection, augmented context preamble, and the sync adapter.

**Architecture:** TaskFlow-specific code calls the generic `EmbeddingService` (host) and `EmbeddingReader` (container). No modifications to the generic service itself.

**Prerequisite:** `docs/plans/2026-03-14-add-embeddings-implementation.md` must be completed first.

**Tech Stack:** TypeScript, Ollama REST API (native fetch), `EmbeddingReader` for cosine similarity

**Spec:** `docs/plans/2026-03-14-semantic-embeddings-design.md` (Components 2-4)

**Owner:** `add-taskflow` skill

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/taskflow-embedding-sync.ts` | Polls taskflow.db, feeds EmbeddingService, cleans stale embeddings |

### Modified files
| File | Changes |
|------|---------|
| `src/index.ts` | Wire `startTaskflowEmbeddingSync()` alongside generic service startup |
| `container/agent-runner/src/taskflow-engine.ts` | Add `semantic_results` to `QueryParams`. Enhance `search` with semantic ranking. Add `buildContextSummary()`. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Wrap search with Ollama embed call. Wrap create with duplicate detection. Add `force_create` to Zod schema. |
| `container/agent-runner/src/index.ts` | Read `queryVector`, build context preamble, prepend to prompt before `runQuery()`. |

---

## Task 1: TaskFlow Sync Adapter

**Files:**
- Create: `src/taskflow-embedding-sync.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create taskflow-embedding-sync.ts**

See spec Component 2, "Host side (indexing)" section for full implementation. Key points:
- `buildSourceText(task)` = `title + ' ' + (description ?? '') + ' ' + (next_action ?? '')`.trim()
- `startTaskflowEmbeddingSync(service, tfDb, intervalMs)` — polls every 15s
- Indexes all non-done tasks via `service.index(collection, id, text, metadata)`
- Cleans stale embeddings by diffing active set vs stored items

- [ ] **Step 2: Wire into src/index.ts**

Add `startTaskflowEmbeddingSync(embeddingService, getTaskflowDb(DATA_DIR))` after `embeddingService.startIndexer()`.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/taskflow-embedding-sync.ts src/index.ts
git commit -m "feat(taskflow): embedding sync adapter — indexes tasks into generic service"
```

---

## Task 2: Semantic Search + Duplicate Detection

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Add query_vector to QueryParams**

In `taskflow-engine.ts`, add to `QueryParams`:
```typescript
query_vector?: Float32Array;
```

- [ ] **Step 2: Import EmbeddingReader in taskflow-engine.ts**

At the top of the file, add a lazy import (ESM-compatible, loaded once):
```typescript
let _EmbeddingReader: typeof import('./embedding-reader.js').EmbeddingReader | null = null;
function getEmbeddingReader() {
  if (!_EmbeddingReader) {
    try { _EmbeddingReader = require('./embedding-reader.js').EmbeddingReader; } catch { return null; }
  }
  return _EmbeddingReader;
}
```
Note: The container compiles to CJS via the entrypoint, so `require()` works here. If ESM-only, use top-level `await import()` instead.

- [ ] **Step 3: Enhance search case**

The engine owns semantic ranking. In the `search` case, if `query_vector` is provided, open `EmbeddingReader`, compute cosine similarity, merge with lexical results. This is the same ranking logic used by `buildContextSummary()` — both go through the engine. See spec Component 2 for full flow.

- [ ] **Step 4: Wrap taskflow_query in MCP handler**

In `ipc-mcp-stdio.ts`, before `engine.query()`: embed search text via Ollama (async), pass the raw `Float32Array` as `query_vector` to the engine. The MCP handler does NOT do cosine similarity — it only provides the vector. The engine does the ranking.

- [ ] **Step 5: Add duplicate detection to taskflow_create**

In `ipc-mcp-stdio.ts`: add `force_create` to Zod schema. Before `engine.create()`: embed title via Ollama (async), open `EmbeddingReader`, call `reader.findSimilar()`, return `duplicate_warning` if >0.85. Duplicate detection stays in the MCP handler (it needs to short-circuit before `engine.create()`).

- [ ] **Step 5: Build and verify**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(taskflow): semantic search + duplicate detection via embeddings"
```

---

## Task 3: Host message embedding + Context Preamble + buildContextSummary

**Files:**
- Modify: `src/container-runner.ts` (embed user message, set queryVector)
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 0: Embed user message on host (sets containerInput.queryVector)**

In `src/container-runner.ts`, in `runContainerAgent()`, after building the prompt and before spawning the container:

```typescript
// Embed user message for context preamble (async, best-effort, TaskFlow only)
if (input.ollamaHost && group.taskflowManaged) {
  try {
    const resp = await fetch(`${input.ollamaHost}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: input.embeddingModel || 'bge-m3', input: input.prompt }),
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

- [ ] **Step 1: Add buildContextSummary() to TaskflowEngine**

Uses `visibleTaskScope()` for correct visibility. Takes `(queryVector, reader)`. Returns formatted preamble string or null. Uses `personDisplayName()` (NOT `getPersonName()`). See spec Component 4 for full implementation.

Note: `TaskflowEngine` constructor takes `(db: Database.Database, boardId: string)` — a Database instance, NOT a path string.

- [ ] **Step 2: Add context preamble injection in container index.ts**

In `main()`, before `runQuery()`:
- Read `containerInput.queryVector` (base64)
- Open `better-sqlite3` DB instance, pass to `TaskflowEngine` constructor
- Call `engine.buildContextSummary(queryVector, reader)`
- Prepend preamble to prompt

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/index.ts
git commit -m "feat(taskflow): context preamble via buildContextSummary + embeddings"
```

---

## Task 4: Integration Tests

Container-side tests live in the container package (`container/agent-runner/`), not the host test suite.

- [ ] **Step 1: Write EmbeddingReader tests**

In `container/agent-runner/src/embedding-reader.test.ts`:
- Read-only graceful fallback: open non-existent DB → empty results, no crash
- Search returns ranked results above threshold
- findSimilar returns best match or null

- [ ] **Step 2: Write integration test for search wrapping**

Mock Ollama response, verify `engine.query({ query: 'search', query_vector })` merges lexical + semantic results via engine-owned `EmbeddingReader`.

- [ ] **Step 3: Write integration test for duplicate detection fallback**

Mock Ollama as unreachable, verify `taskflow_create` succeeds with console.warn log (no block).

- [ ] **Step 4: Run all tests**

```bash
cd container/agent-runner && npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/embedding-reader.test.ts
git commit -m "test(taskflow): embedding reader + search + duplicate detection integration tests"
```

---

## Task 5: CLAUDE.md Patches + E2E Verification

- [ ] **Step 1: Patch group CLAUDE.md files**

Add to "Tool Response Handling" section of all TaskFlow group CLAUDE.md files:
```
When taskflow_create returns duplicate_warning, present:
"⚠️ Tarefa similar encontrada: *[ID]* — [título] ([similarity]%). Criar mesmo assim?"
If user confirms, re-call with force_create: true.
```

- [ ] **Step 2: Deploy**

```bash
npm run build
rsync dist + container source to remote
docker builder prune + build.sh
systemctl --user restart nanoclaw
```

- [ ] **Step 3: Verify semantic search via WhatsApp**

Send: "buscar tarefas de infraestrutura"
Expected: results include semantically related tasks

- [ ] **Step 4: Verify duplicate detection**

Send: "anotar: Trocar filtro de linha" (when similar task exists)
Expected: warning with similar task ID and similarity percentage

- [ ] **Step 5: Verify context preamble**

Check container logs for preamble generation. The agent should have immediate board context without querying.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(taskflow): embeddings integration complete — search, duplicates, context preamble"
```
