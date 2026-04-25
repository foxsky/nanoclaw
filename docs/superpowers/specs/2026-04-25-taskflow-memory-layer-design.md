# TaskFlow Memory Layer — Design Spec (v2.2, manual-only MVP)

**Date:** 2026-04-25
**Status:** Draft, pending implementation
**Revision:** v2.2 after 3 internal reviewers + 4 Codex (gpt-5.5/high) skeptical rounds
**API base:** `redis-developer/openclaw-redis-agent-memory` (design pattern)
**Storage base:** existing `add-embeddings` skill (BGE-M3 / Ollama / SQLite WAL)
**Pilot scope:** all TaskFlow-managed boards from day 1, kill-switch via env var

---

## Why v2 (what changed from v1)

v1 of this spec proposed a background extractor + auto-capture + auto-recall on every triggered turn, using local Ollama qwen3-coder. Three internal reviewers and a Codex (gpt-5.5/high) review identified:

| v1 problem | v2 resolution |
|---|---|
| `containerInput.systemPrependContext` is a fabricated API field | Drop the invented field. Use existing prompt-mutation pattern at `container/agent-runner/src/index.ts:687-718` (same path as the existing task-context preamble) |
| Auto-recall on "every triggered turn" was false — follow-up IPC queries at `index.ts:956-958` set `prompt = nextMessage.text` and skip the recall recomputation | Extract the recall logic into a `buildMemoryPreamble()` helper called in BOTH the initial container start AND inside the IPC follow-up loop. Container does its own `ollamaEmbed()` per IPC message |
| Cursor file race on simultaneous extractor processes | Eliminated — no extractor in v2 |
| qwen3-coder for structured JSON extraction is unvalidated; was disqualified vs gemma4 in 2026-04-15 audit shootout for natural-language reasoning | Eliminated — no extractor in v2. Defer auto-capture until a real JSON-quality eval is done |
| Recall hit rate >40% target was implausible (most TaskFlow turns are task state, which extractor explicitly filters) | Replaced with `memory_store` call count as the health metric; recall is gravy |
| Functional duplication with existing `add-long-term-context` skill (already does qwen3-coder summarization + preamble injection + MCP tools) | Manual+curated facts via `memory_store` ARE complementary to summarization. Auto-extractor would have BEEN duplication; manual layer is not. |
| Production bug record doesn't support "preferences/conventions" as the central pain | Acknowledged. v2 ships as additive infrastructure with explicit deferral; if the real pain is elsewhere, kill-switch is cheap and we lose only ~3 days of work, not 5+ ongoing |

**Net effect:** ~50% less code, no qwen3-coder gamble, no cursor race, alignment with the actual prompt-injection architecture. Manual write surface gives the agent explicit control. Auto-capture deferred to a v3 spec gated on real evidence.

---

## 1. Goal

Add a long-term memory layer to NanoClaw TaskFlow boards so the agent can persist and recall slow-moving meta-knowledge (preferences, conventions, naming, disambiguations, role facts) across turns and across container starts, without requiring a session-resume architectural fix.

The agent decides what to remember (via the `memory_store` MCP tool); auto-recall surfaces relevant memories on every turn (initial + follow-up IPC).

## 2. Non-goals

- Background extractor / auto-capture (deferred to v3 pending JSON-quality eval, hit-rate evidence, GPU headroom on `.13`)
- Substitute for the engine-side T12 magnetism guard (already shipped Phase 1)
- Substitute for the session-per-turn architectural fix (separate, deferred)
- Cross-board fact promotion (`memory:global` scope) — deferred
- Lint pass for contradictions ("user said X then said not-X") — deferred
- Sender deduplication across phone changes (JID alias table) — deferred
- TTL eviction by age — deferred
- Per-fact confidence scores — all manual writes treated equally

## 3. Architecture

```
HOST (src/)
─────────────────────────────────────────────────────────────────
  data/ipc/{groupFolder}/memory-writes/  (IPC pipe in)
                  │
                  ▼
  memory-service.ts (host watcher, integrated into existing src/ipc.ts polling loop)
                  │  parses op=store|forget JSON
                  │  routes to EmbeddingService.index() or scoped delete
                  ▼
  EmbeddingService.index(           ◄── existing add-embeddings
    'memory:user:{boardId}:{jid}'
    or 'memory:board:{boardId}',
    contentHash,
    factText,
    {category, entities, senderJid, senderName, capturedAt, source})
                  │
                  ▼  existing 10s indexer cycle embeds via bge-m3
                  data/embeddings/embeddings.db (WAL)


CONTAINER (container/agent-runner/src/)
─────────────────────────────────────────────────────────────────
  Per-turn auto-recall preamble (called in TWO places now):
    1. Initial container start (index.ts:~700, after task-context preamble)
    2. Inside IPC follow-up loop (index.ts:~957, after prompt = nextMessage.text)

    buildMemoryPreamble(prompt, boardId, senderJid):
      queryVector = await ollamaEmbed(stripEnvelope(prompt))
                  │
                  ▼
      memory-reader.ts (wrapper around existing EmbeddingReader)
                  │  query both memory:board:{boardId}
                  │       and  memory:user:{boardId}:{jid}
                  │  threshold 0.5, top K, ~500 token budget
                  ▼
      formatRelevantMemoriesBlock() ──► <relevant-memories>...</relevant-memories>
                                         prepended via prompt = block + '\n\n' + prompt

  Manual MCP tools (registered in ipc-mcp-stdio.ts):
    memory_store(text, category, scope?, entities?)
    memory_recall(query, scope?, limit?, category?)
    memory_forget(memoryId)
```

**Skill packaging:** `add-memory` is a new generic skill, depends on `add-embeddings`. Reusable on non-TaskFlow groups via per-group flag.

## 4. Decisions locked

| Decision | Choice |
|---|---|
| Scope model | `memory:board:{boardId}` + `memory:user:{boardId}:{senderJid}`. Cross-board (`memory:global`) deferred. |
| Capture trigger | **Manual only via `memory_store` MCP tool.** Auto-extractor deferred. |
| Categories | `preference \| fact \| decision \| entity \| other` (mirrors openclaw plugin) |
| Hygiene | Content-hash dedup via existing `EmbeddingService` UPSERT compare-before-write. Manual `memory_forget` MCP tool. No active near-dup lint at MVP. |
| Recall surface | Auto preamble injection (~500 tokens) on **every** initial start AND **every** IPC follow-up + manual `memory_recall` MCP tool |
| Recall threshold | 0.5 (passed explicitly to `EmbeddingReader.search`; reader's default is 0.3) |
| Rollout | All TaskFlow boards from day 1. Kill-switch via env var (`NANOCLAW_MEMORY=off\|on`) + per-board flag (`registered_groups.memory_enabled`). |
| Cross-process writes | IPC pipe (`data/ipc/{groupFolder}/memory-writes/`). Container writes JSON files; host watcher applies. Read/write split preserved (`embeddings.db` mount stays `:ro` in container). |
| Fact text language | English (uniform for dedup + human review) |
| Recall recomputation | **Per IPC follow-up** — fixes v1 bug where follow-up turns inherited stale preamble |

## 5. Components

### 5.1 New files

| Path | Responsibility |
|---|---|
| `src/memory-service.ts` | Host helpers: `collectionName({scope, boardId, senderJid})`, `contentHash(category, text)`, `forgetScoped(boardId, memoryIdPrefix)`. IPC handler invoked from existing `src/ipc.ts` polling loop for `memory-writes/` directory. Lifecycle: passive (no background loop, no own timer). |
| `container/agent-runner/src/memory-reader.ts` | Container-side wrapper around existing `EmbeddingReader`. Exposes `recall(boardId, senderJid, queryVector, opts)` querying both collections (two `EmbeddingReader.search()` calls + merge-by-score), applying threshold (0.5) and token budget (500). Exposes `formatRelevantMemoriesBlock(hits, budget)`. Exposes `buildMemoryPreamble(prompt, boardId, senderJid, ollamaHost, embeddingModel)` — the all-in-one helper called from `container/agent-runner/src/index.ts`. |
| `.claude/skills/add-memory/SKILL.md` | Skill manifest. Declares dependency on `add-embeddings`. Phase-by-phase install flow (preflight Ollama check, code merge, env var, build, restart, verify). |
| `.claude/skills/add-memory/manifest.yaml` | Standard NanoClaw skill manifest. |
| `migrations/2026-04-25-memory-enabled.sql` | `ALTER TABLE registered_groups ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0;` plus pilot `UPDATE` to 1 for `taskflow_managed=1` rows. |

### 5.2 Modified files (additive only)

| Path | Change |
|---|---|
| `src/ipc.ts` | ~100 lines (~60 for memory bucket + ~40 for `processIpcOnce` export refactor — original ~15 estimate was optimistic per Codex round 5). The existing per-group loop has **hardcoded buckets** (`messages`, `tasks`, `otp` at `ipc.ts:891`) and dispatches by `data.type` — not generic. Two integration choices: (a) add `memory-writes` as a fourth hardcoded bucket with its own `processMemoryIpc(data)` handler that switches on `data.op` (`store`/`forget`); (b) reuse the existing `tasks` bucket by adding `data.type === 'memory_op'` and a new sub-dispatcher. **Choice (a) is preferred** — keeps memory ops on their own write path with isolated `.errors/` quarantine and avoids polluting the tasks dispatcher. Reuses the existing retry/unlink primitive. **Refactor for testability**: `startIpcWatcher` is currently a perpetual `setTimeout` closure (`ipc.ts:815, 1208-1211`) carrying `deps`, `pendingNotifications`, retry/error handling, eviction state, multi-bucket dispatch. The refactor extracts the per-cycle body into `processIpcOnce(groupDir, ctx)` and re-implements `startIpcWatcher` as a wrapper that calls it on a timer; non-trivial because of closure-captured state — must lift state into a `ctx` object. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | ~80 lines: register 3 MCP tools (`memory_store`, `memory_recall`, `memory_forget`); each writes to `/workspace/ipc/memory-writes/` via the existing IPC write pattern. (The container's `/workspace/ipc/` IS the host's `data/ipc/{groupFolder}/` — the per-group scoping is enforced by the mount in `container-runner.ts:267-274`, not by container-supplied paths.) Tool descriptions are gating UX. |
| `container/agent-runner/src/index.ts` | ~30 lines at two locations: (a) after the existing task-context preamble block (~line 729), call `buildMemoryPreamble(prompt, ...)` and prepend to `prompt`; (b) inside the IPC follow-up loop after `prompt = nextMessage.text` (~line 957), do the same. DRY by importing the helper from `memory-reader.ts`. |

### 5.3 Files NOT touched

- `taskflow-engine.ts` (no engine changes)
- `container-runner.ts` (mount + env already wired by add-embeddings; host-side `input.prompt` embedding at `:546-563` is fine for the initial start, container handles its own embedding for IPC follow-ups)
- `embedding-service.ts` (consumed as-is, no method additions)
- `EmbeddingReader.search` (consumed as-is; we pass `opts.threshold=0.5` explicitly to override its default of 0.3)

## 6. Data flow

### 6.1 Manual write path (container → host)

Agent invokes `memory_store(text, category, scope?, entities?)` MCP tool. Tool body:

1. Validates input (category in enum, text 5-280 chars, scope ∈ {user, board}, entities array)
2. Computes `contentHash = sha1(category + ':' + normalize(text).toLowerCase())`
3. **Does NOT compute collection name** — the host derives it from the IPC file's mount path + the JSON's `scope` + (for user scope) `metadata.senderJid`. The container only writes `scope` and `metadata.senderJid`; the rest is server-side.
4. Reads `senderJid` from `containerInput.senderJid` (initial start) or the most recent `nextMessage.turnContext?.senderJid` (IPC follow-up). The container does NOT accept a senderJid argument from the agent — the agent cannot specify "which user this is about"; it's always the current message sender.
5. Writes JSON to `/workspace/ipc/memory-writes/{ts}-store-{contentHash[0:8]}.json` (the container's `/workspace/ipc/` is mounted from host `data/ipc/{groupFolder}/`; container cannot see other groups' folders):
   ```json
   {
     "op": "store",
     "scope": "user",
     "contentHash": "a3f1b9c842de...",
     "text": "Prefers concise replies, no emojis",
     "metadata": {
       "category": "preference", "entities": [],
       "senderJid": "5585999@s.whatsapp.net", "senderName": "Maria",
       "capturedAt": "2026-04-25T18:42:11.000Z",
       "source": "manual_store"
     }
   }
   ```
   **Note**: the JSON does NOT contain a `collection` field. **The host derives the collection name from the IPC pipe's mount path** (which board's directory the file came from) + the `scope` + `senderJid`. The container cannot lie about which board the memory belongs to, because the container-supplied collection field doesn't exist — this closes the cross-board store hole that v2 spec originally had.
5. Returns `{memoryId: contentHash, action: 'queued'}` to agent

Host-side `src/ipc.ts` polling loop:

1. New bucket `memory-writes/` added to the per-group scan at `ipc.ts:891` (the loop currently scans `messages`, `tasks`, `otp` — adds a fourth)
2. New handler `processMemoryIpc(data, groupFolder)` invoked when `data.op` ∈ `{store, forget}`
3. **Collection derivation (security boundary)**: handler computes `collection` server-side:
   - `scope === 'board'` → `memory:board:${groupFolder}` (groupFolder from path; immune to spoofing)
   - `scope === 'user'` → `memory:user:${groupFolder}:${resolvedSenderJid}` where `resolvedSenderJid` is **server-validated**:
     - Host queries `messages.db`: `SELECT sender FROM messages WHERE chat_jid = ? AND is_from_me = 0 AND timestamp >= datetime('now', '-10 minutes') ORDER BY timestamp DESC LIMIT 5` (where `chat_jid` is the registered group's JID for this `groupFolder`)
     - If `data.metadata.senderJid` matches one of the recent inbound senders → use it
     - If no match → fall back to the most-recent inbound sender (`recent[0]`), log warn `memory.spoof_attempt` with the mismatched value
     - If no recent senders at all (rare — bot turn with no recent inbound) → reject with `error_code='no_recent_sender'`, move file to `.errors/`
   - Container's `data` JSON contains `scope` + `metadata.senderJid` but NOT `collection`. The host never trusts a container-supplied collection name AND validates `senderJid` against recent message history. **This closes both cross-board AND same-board sender-spoofing holes.**
4. Dispatches by `data.op`:
   - `store` → `EmbeddingService.index(derivedCollection, contentHash, text, metadata)` — UPSERT compare-before-write makes identical writes no-ops
   - `forget` → scoped delete (see §6.3) — also derives collection scope from path, so forget can only target this board's collections
5. On success: `unlink` the file
6. On parse error: move to `data/ipc/{groupFolder}/memory-writes/.errors/` (per-bucket quarantine; **separate from** the global `data/ipc/errors/` used by the existing watcher)
7. **Memory ops are idempotent at the storage layer** — existing IPC retry-up-to-5 logic is safe (re-running `index()` with same contentHash is a no-op via compare-before-write; re-running scoped `forget` on already-deleted ID is a no-op)

Latency: write→queryable is bound by `IPC_POLL_INTERVAL` + indexer cycle (~10-15s typically). MCP tool returns `action: 'queued'` immediately and does NOT block.

### 6.2 Auto-recall preamble (container, per turn)

Two call sites in `container/agent-runner/src/index.ts`:

**A. Initial container start** (after the existing task-context preamble at line 718):

```typescript
// After the existing task-context preamble injection
if (containerInput.isTaskflowManaged && containerInput.taskflowBoardId
    && process.env.NANOCLAW_MEMORY !== 'off'
    && containerInput.memoryEnabled === true) {
  try {
    const { buildMemoryPreamble } = await import('./memory-reader.js');
    const memoryBlock = await buildMemoryPreamble(
      prompt,                                    // current prompt (may already have task preamble)
      containerInput.taskflowBoardId,
      containerInput.senderJid ?? null,
      containerInput.ollamaHost,
      containerInput.embeddingModel,
    );
    if (memoryBlock) {
      prompt = memoryBlock + '\n\n' + prompt;
      log(`Memory preamble injected (${memoryBlock.length} chars)`);
    }
  } catch (err) {
    log(`Memory preamble skipped: ${err}`);
  }
}
```

**B. IPC follow-up loop** (after `prompt = nextMessage.text` at line 957):

```typescript
prompt = nextMessage.text;
containerInput.turnContext = nextMessage.turnContext;

// v2 fix: re-run memory recall on every IPC follow-up.
// The host doesn't pre-embed follow-up prompts (only initial), so the
// container does its own embedding via ollamaEmbed.
if (containerInput.isTaskflowManaged && containerInput.taskflowBoardId
    && process.env.NANOCLAW_MEMORY !== 'off'
    && containerInput.memoryEnabled === true) {
  try {
    const { buildMemoryPreamble } = await import('./memory-reader.js');
    const memoryBlock = await buildMemoryPreamble(
      prompt,
      containerInput.taskflowBoardId,
      nextMessage.turnContext?.senderJid ?? containerInput.senderJid ?? null,
      containerInput.ollamaHost,
      containerInput.embeddingModel,
    );
    if (memoryBlock) {
      prompt = memoryBlock + '\n\n' + prompt;
      log(`IPC memory preamble injected (${memoryBlock.length} chars)`);
    }
  } catch (err) {
    log(`IPC memory preamble skipped: ${err}`);
  }
}
```

`buildMemoryPreamble` internals (in `memory-reader.ts`):

```typescript
export async function buildMemoryPreamble(
  promptText: string,
  boardId: string,
  senderJid: string | null,
  ollamaHost: string,
  embeddingModel: string,
): Promise<string> {
  const stripped = stripEnvelopeForSearch(promptText);
  if (stripped.length < 2) return '';

  // Embed the stripped prompt
  const queryVector = await ollamaEmbedLocal(stripped, ollamaHost, embeddingModel);
  if (!queryVector) return '';   // Ollama unreachable, fail open

  const reader = new EmbeddingReader('/workspace/embeddings/embeddings.db');
  try {
    const boardHits = reader.search(`memory:board:${boardId}`, queryVector,
                                    { limit: 5, threshold: 0.5 });
    const userHits = senderJid
      ? reader.search(`memory:user:${boardId}:${senderJid}`, queryVector,
                      { limit: 5, threshold: 0.5 })
      : [];

    const merged = [
      ...boardHits.map(h => ({ ...h, scope: 'board' as const })),
      ...userHits.map(h  => ({ ...h, scope: 'user'  as const })),
    ].sort((a, b) => b.score - a.score);

    return formatRelevantMemoriesBlock(merged, /* budget */ 500);
  } finally {
    reader.close();
  }
}
```

**Sender JID for follow-ups**: `nextMessage.turnContext?.senderJid` is the new addition we'll need to plumb through the IPC `AgentTurnContext` (the existing `IpcInputMessage` shape is `{text, turnContext}`; we extend `AgentTurnContext` with `senderJid?: string`, see §9.3). Falls back to `containerInput.senderJid` if missing.

`ollamaEmbedLocal` is a small inline helper (or refactored from the existing `ollamaEmbed` in `ipc-mcp-stdio.ts:60-75` into a shared module). Same fetch pattern, 2s timeout, returns `Float32Array | null`.

### 6.3 Manual forget path

`memory_forget(memoryId)` writes:
```json
{ "op": "forget", "memoryId": "a3f1b9c842de" }
```
The `memoryId` may be a full 40-char sha1 contentHash OR a prefix (≥8 chars). Host resolver:

1. Scopes search to `memory:board:{groupFolder}` and `memory:user:{groupFolder}:%` collections only
2. Runs `SELECT collection, item_id FROM embeddings WHERE collection LIKE ('memory:board:'||?||'%' OR 'memory:user:'||?||':%') AND item_id LIKE ?||'%'` with `(groupFolder, groupFolder, prefix)`
3. If exactly 1 match: `EmbeddingService.remove(collection, item_id)`
4. If 0 matches: idempotent no-op, logs warn
5. If >1 match: rejects with `error_code='ambiguous_prefix'`, logs warn (defensive — should not occur at 12-char prefix)

**Security boundary**: cross-board AND same-board sender-spoofing operations are structurally impossible because:
1. The container's mount only allows writes to its own `data/ipc/{groupFolder}/memory-writes/` (enforced by docker mount in `container-runner.ts:267-274`)
2. The host watcher derives `groupFolder` from the IPC file's path, not from container-supplied data
3. The host derives `collection` from `groupFolder` + `scope` + (for user scope) a **server-validated** `senderJid` (checked against recent `messages.db` inbound senders for this group, see §6.1 step 3)
4. The forget LIKE filter only matches `memory:board:${groupFolder}` and `memory:user:${groupFolder}:%`

A container for board-A cannot store to nor forget from board-B's memory namespace. A container that lies about senderJid within its own board gets the most-recent valid inbound sender substituted in, and the discrepancy logged as `memory.spoof_attempt`.

## 7. Extractor design (DEFERRED)

v1 specified a background extractor calling Ollama qwen3-coder on every triggered turn with a strict prompt. v2 explicitly defers this. Required before resurrection:

1. **JSON-quality eval**: fixture-based shootout of qwen3-coder vs gemma4 vs glm-5.1:cloud on a labeled set of 100+ turns. Measure parse rate, schema-validity rate, false-positive rate, false-negative rate. Target ≥90% parse, ≥80% schema-valid, <10% FP rate.
2. **Hit-rate floor**: with ≥30 days of manual `memory_store` data, measure what fraction of turns semantically match an existing memory at threshold 0.5. If <10%, auto-capture has no marginal value over manual.
3. **GPU headroom on `.13`**: measure baseline load (existing bge-m3 indexer + vLLM-MLX :8000 + qwen3-coder summarization for long-term-context). Add an extractor benchmark; require <50% utilization at peak.
4. **Cursor design without race**: SQLite-backed cursor in `embeddings.db` (new table) with row-level locking, OR enforce single-host-process invariant.
5. **Anti-dup retry semantics**: spec how retry interacts with already-stored facts (the v1 race where existing memories suppress re-extraction).

When all five conditions are met, re-spec auto-capture as v3. Until then: agent uses `memory_store` explicitly when it judges a fact worth remembering. The "agent doesn't realize it matters" failure mode is acknowledged and accepted at MVP — fixing it correctly requires the auto-extractor, which we're not yet equipped to ship.

## 8. MCP tool surface

Three tools registered in `ipc-mcp-stdio.ts`. Descriptions are what the LLM sees and gates usage on.

### 8.1 `memory_store`

```typescript
description:
  'Save a slow-moving fact about the user or board to long-term memory. ' +
  'Use when: (a) user explicitly signals to remember ("lembre disso", ' +
  '"anote", "não esquece"), or (b) the user states a stable preference, ' +
  'convention, naming/disambiguation, or identity fact in passing that you ' +
  'judge worth carrying forward. ' +
  'Do NOT use for task state (use taskflow_* tools), one-time events, ' +
  'specific dates, or speculation. ' +
  'Background auto-capture is NOT enabled — if you do not call this tool, ' +
  'the fact will not be remembered. ' +
  'IMPORTANT: in script-driven scheduled tasks (no human inbound), you MUST ' +
  'use scope="board" — scope="user" writes will be rejected.'

inputSchema:
  text:     z.string().min(5).max(280)  // one English sentence
  category: z.enum(['preference','fact','decision','entity','other'])
  scope:    z.enum(['user','board']).optional()  // default 'user'
  entities: z.array(z.string()).max(10).optional()

returns: { memoryId, action: 'queued' }
```

(No `collection` in return — the agent doesn't need to know the collection name; that's a server-side detail. Agent works with `memoryId` (contentHash prefix) for forget operations.)

### 8.2 `memory_recall`

```typescript
description:
  'Search long-term memory for facts about the user or board. ' +
  'Auto-recall already injects relevant memories at every turn start in ' +
  '<relevant-memories> — use this tool ONLY for explicit deep-dives ' +
  '("o que você sabe sobre Maria?") or when auto-recall returned nothing relevant. ' +
  'Returns memories tagged with scope, category, score, and a memoryId you can ' +
  'pass to memory_forget if a memory is wrong.'

inputSchema:
  query:    z.string().min(2).max(500)
  scope:    z.enum(['user','board','both']).optional()  // default 'both'
  limit:    z.number().int().min(1).max(20).optional()  // default 10
  category: z.enum([...categories]).optional()

returns: human-readable text block:
  Found 3 memories matching "Maria preferences":
  [user, preference, score 0.83, 2026-04-12, id=a3f1b9c842de] Prefers concise replies, no emojis
  [user, entity, score 0.71, 2026-04-08, id=7e2c44b1f098] Full name is Maria Silva
  [board, fact, score 0.55, 2026-04-15, id=b8a902c3e7d4] Team prefixes meetings with 'M' instead of 'R'
```

### 8.3 `memory_forget`

```typescript
description:
  'Permanently delete a memory by ID. Use when: (a) user says "esquece isso", ' +
  '"isso está errado", "remova essa memória"; (b) you discover a stored memory ' +
  'is wrong (user clarified a fact, role changed, preference shifted). ' +
  'The memoryId comes from a prior memory_recall result or the auto-recall preamble. ' +
  'You can ONLY forget memories from THIS board — cross-board deletion is blocked.'

inputSchema:
  memoryId: z.string()

returns: { action: 'queued' }

security: scoped to this board's collections only — host watcher rejects cross-board IDs
```

### 8.4 Auto-recall preamble (always-on, no MCP tool)

Format:
```
<relevant-memories>
[user, preference, id=a3f1b9c842de] Prefers concise replies, no emojis
[user, entity, id=7e2c44b1f098] Full name is Maria Silva
[board, fact, id=b8a902c3e7d4] Team prefixes meetings with 'M' instead of 'R'
[user, fact, id=c4f8e081a2bf] When user says T12 they mean migration task, not test
</relevant-memories>

```

Token budget: 500 (~8-10 facts max with the 12-char ID prefix overhead). MemoryId truncated to 12 chars (48-bit collision space). Agent can pass any prefix (≥8 chars) to `memory_forget`.

### 8.5 Kill-switch matrix

| State | Auto-recall | memory_store | memory_recall | memory_forget |
|---|---|---|---|---|
| `NANOCLAW_MEMORY=on` + group flag=1 | inject if hits | writes (queued) | reads | deletes (queued) |
| `NANOCLAW_MEMORY=on` + group flag=0 | skip | `error_code='memory_disabled_for_board'` | same | same |
| `NANOCLAW_MEMORY=off` (any group) | skip | `error_code='memory_disabled'` | same | same |

Tools always **register** so disabling doesn't crash the MCP server — they short-circuit in their execute body. The container reads `containerInput.memoryEnabled` (new field, plumbed from host) and `process.env.NANOCLAW_MEMORY`.

### 8.6 Combined preamble token budget

Each successive `prompt = X + '\n\n' + prompt` mutation prepends to the front. Tracing the actual code execution order in `container/agent-runner/src/index.ts`:

1. `prompt = containerInput.prompt` (line 688)
2. Line ~717: `prompt = task_preamble + '\n\n' + prompt` → `task → user`
3. **NEW** at line ~729 (after task block, before recap block): `prompt = memory + '\n\n' + prompt` → `memory → task → user`
4. Line ~768: `prompt = recap + '\n\n' + prompt` → `recap → memory → task → user`

**Final order: `recap → memory → task → user`.** Recap (most general background) at the front, memory (slow-moving facts about user/board), task (query-specific task hits), user message at the end (closest to attention).

Combined upper bound: ~2500 tokens of preamble for a TaskFlow turn with all three layers active. At 165k auto-compact window (per project memory: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000`), this is <2% of budget — acceptable. Prompt cache (system prompt) is unaffected; preambles are user-prompt content. Per-turn token cost is +500 input tokens when memory has hits, 0 when empty.

If combined preamble proves too noisy in practice: the easiest knob is the memory budget (drop from 500 → 250 tokens, ~5 facts max).

## 9. Schema additions

### 9.1 Migration

```sql
-- migrations/2026-04-25-memory-enabled.sql
ALTER TABLE registered_groups
  ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE registered_groups
   SET memory_enabled = 1
 WHERE taskflow_managed = 1;
```

Applied via existing migration runner pattern in `src/db.ts` (idempotent — `ADD COLUMN` errors swallowed if column already exists, per `src/db.ts:181-327` pattern).

### 9.2 Embeddings DB

No schema change. Reuses the existing `embeddings.db` schema as-is. Memory rows use new collection prefixes (`memory:board:*`, `memory:user:*`). The `metadata` TEXT column stores `{category, scope, entities, senderJid, senderName, capturedAt, source}` as JSON.

### 9.3 Type additions

```typescript
// container/agent-runner/src/runtime-config.ts
interface AgentTurnContext {
  turnId: string;
  senderJid?: string;        // NEW: needed for per-user collection routing on follow-ups
}

interface ContainerInput {
  // ... existing fields
  memoryEnabled?: boolean;   // NEW: from registered_groups.memory_enabled, gates recall + tools
  senderJid?: string;        // NEW: initial sender (initial container start)
}
```

Plumbing:

- **Initial container start**: host sets `containerInput.senderJid` when invoking `runContainerAgent` (reads from the WhatsApp message's `sender` field). Today's call site at `src/index.ts:759-770` does NOT pass `senderJid`; this is a new field to add to the call.
- **IPC follow-up messages**: host extends `AgentTurnContext` (already passed through `IpcInputMessage`) to carry `senderJid`. `src/group-queue.ts:223-261` `sendMessage(groupJid, text, turnContext?)` requires no signature change — the caller building the `turnContext` just sets `senderJid` from the inbound WhatsApp message.
- **Inbound→container delivery path**: when a follow-up WhatsApp message arrives for a group with an active container, an IPC file is written into `data/ipc/{groupFolder}/input/` via `GroupQueue.sendMessage` (`src/group-queue.ts:223-261`). The caller building the `turnContext` argument must populate `senderJid` from the inbound message's `sender` field.
  - **Important — implementation prerequisite**: at HEAD, `GroupQueue.sendMessage` may have no active production callers wiring TaskFlow follow-ups (the channel-handler → IPC path may use a different enqueue mechanism, or the active-container follow-up path may need to be added). The implementation plan must (a) locate the actual current code path by tracing how WhatsApp inbound messages reach `data/ipc/{groupFolder}/input/`, OR (b) explicitly add a caller to `GroupQueue.sendMessage` from the inbound message handler if no such path exists. **Previous spec drafts misattributed this**: `src/ipc.ts:1156` is outbound notification consolidation (unrelated), and `src/index.ts` dispatches but does not directly enqueue follow-ups. Verify against HEAD before implementing.
- **Container reader**: `nextMessage.turnContext?.senderJid` (initial: `containerInput.senderJid`). Falls back to `null` → board-scope-only recall.

Host also sets `containerInput.memoryEnabled` from a `registered_groups.memory_enabled` lookup at container-start time.

### 9.4 Container env forwarding (kill-switch)

`src/container-runner.ts` currently forwards only `OLLAMA_HOST` and `EMBEDDING_MODEL` env vars to the spawned docker container (`container-runner.ts:530-538`). The kill-switch env var must be added to that splice block:

```typescript
// container-runner.ts ~line 530
if (process.env.NANOCLAW_MEMORY) {
  containerArgs.splice(
    containerArgs.length - 1, 0,
    '-e', `NANOCLAW_MEMORY=${process.env.NANOCLAW_MEMORY}`,
  );
}
```

Without this, the container sees `process.env.NANOCLAW_MEMORY === undefined` and the recall preamble + MCP tool gating both default-on regardless of the host env var. **This is a load-bearing change for the kill-switch to work** — the spec is incomplete without it.

### 9.5 Runtime artifacts

| Path | Format | Lifecycle |
|---|---|---|
| `data/ipc/{groupFolder}/memory-writes/` | Flat dir of JSON files | Created on first write; host watcher consumes + unlinks |
| `data/ipc/{groupFolder}/memory-writes/.errors/` | Failed JSON quarantine | 7d eviction (existing IPC pattern) |

(No cursor file — extractor is deferred.)

## 10. Failure modes

### 10.1 Recall (container) — all fail open

| Scenario | Behavior |
|---|---|
| `embeddings.db` missing | `MemoryReader` returns `[]`, no preamble |
| `embeddings.db` locked | `openReadonlyDb` retries → `[]` |
| `ollamaEmbed` timeout (2s) | No preamble |
| `ollamaEmbed` malformed response | No preamble |
| No `memory:*` collection yet (cold start) | Search returns `[]` |
| Memory rows have `vector=NULL` (recently written, indexer hasn't caught up) | Reader's `WHERE vector IS NOT NULL` filter excludes them; ~10s later they appear |
| Token budget exceeded mid-format | Break early, partial preamble |
| `NANOCLAW_MEMORY=off` or `memory_enabled=0` | Skip preamble entirely |

### 10.2 MCP tools

| Scenario | Behavior |
|---|---|
| IPC dir missing | `mkdir -p` then write |
| IPC filesystem full | Tool returns `{error_code: 'write_failed'}` |
| `memory_forget` on non-existent ID | Host: idempotent no-op (no error) |
| `memory_forget` ambiguous prefix (>1 match) | Host rejects, logs warn (defensive — should not occur at 12-char prefix) |
| Cross-board forget attempt | Host blocks structurally — IPC pipe path determines `groupFolder`, container can't lie |
| Concurrent stores with same `contentHash` | Host UPSERT compare-before-write absorbs; no dupes |
| Container submits invalid `op` | Host moves file to `.errors/` |
| IPC retry-up-to-5 on transient error | Memory ops are idempotent; safe |
| IPC write→queryable latency | ~10-15s (poll interval + indexer cycle); MCP returns `action='queued'` |

### 10.3 Boundary cases

| Case | Behavior |
|---|---|
| Sender JID changes (phone change) | Memory under old JID orphaned; no auto-merge. Manual `memory_forget` if user requests. |
| Board folder rename | Old `memory:*:{oldFolder}:*` collections orphaned; ops migration via SQL |
| `senderJid` missing from IPC follow-up `turnContext` | `buildMemoryPreamble` falls back to `containerInput.senderJid`; if that's also null (rare — script-driven scheduled task), falls back to board-scope only and skips user-scope query. Logs debug. |
| Script-driven scheduled task calling `memory_store(scope='user')` | Server-side validation rejects with `error_code='no_recent_sender'` because there's no recent human inbound to verify against. Scripts must use `scope='board'` explicitly. The agent's tool description must mention this constraint to gate misuse — added to §8.1 wording. |
| Multi-board container restart with pending IPC writes | All `memory-writes/` files survive restart (no cursor). Host watcher resumes processing on first poll cycle. |
| Conflicting facts ("Mike" → later "Miguel") | Both stored, recall returns both ranked, agent reasons. Lint deferred. |
| Deleted upstream `messages` row | Memory persists; we don't follow upstream deletes |

### 10.4 Mid-session kill-switch drift (accepted limitation)

The container reads `containerInput.memoryEnabled` once at start. If the host UPDATEs `registered_groups.memory_enabled=0` mid-session (per-board rollback), **the running container still has the cached value** and continues to run recall + accept memory_store calls until it exits.

**Acceptable because:**
- Most TaskFlow containers exit shortly after their turn (via `_close` sentinel after the agent finishes)
- The next container start picks up the new flag value (host re-reads on each `runContainerAgent` call)
- The fleet-wide kill-switch (`NANOCLAW_MEMORY=off`) requires service restart to take effect anyway, so similar latency

**Operator workflow for immediate per-board disable**:
1. `UPDATE registered_groups SET memory_enabled=0 WHERE folder='X'` (takes effect on next container start)
2. To evict any currently-active container for that group: `touch data/ipc/{folder}/input/_close` — this is the existing close-sentinel mechanism (`container/agent-runner/src/index.ts:684-685, 950-953`); container exits at next IPC poll, next start picks up `memory_enabled=0`. Operator-runnable shell command, not an internal API.

## 11. Observability

Structured `logger.info` lines:

```typescript
// Per memory write (success)
logger.info({
  collection, contentHash, category, action, source: 'manual_store'
}, 'memory.write');

// Per recall (initial container start OR IPC follow-up)
logger.info({
  groupFolder, senderJid, callSite: 'initial' | 'ipc_followup',
  hits: { board, user },
  injectedTokens, latencyMs
}, 'memory.recall');

// Hourly summary (in-memory aggregation, flushed on the hour)
logger.info({
  windowStart, windowEnd,
  totalStoreCalls, totalRecallCalls, totalForgetCalls,
  totalRecallHits,           // recall calls that returned ≥1 hit
  recallHitRate,             // totalRecallHits / totalRecallCalls
  ipcQueueDepthMax
}, 'memory.summary.hourly');
```

Key metrics for the eval window:

- **`totalStoreCalls`** — agent's actual memory engagement. If <1/day fleet-wide, agent isn't using the tool and the layer has no value.
- **`recallHitRate`** — fraction of turns where preamble was non-empty. Honest expectation: low single digits early; could grow over time as the memory bank fills.
- **`memory.write source`** field — currently always `manual_store`; future-proofs for v3 auto-extractor.

## 12. Testing strategy

TDD throughout. ~30 tests across unit + integration (down from v1's ~45-55 due to extractor removal).

### 12.1 Unit tests

**`memory-service.test.ts` (~14 tests)**

```
Helpers:
  ✓ collectionName('board', 'foo') === 'memory:board:foo'
  ✓ collectionName('user', 'foo', 'jid@s') === 'memory:user:foo:jid@s'
  ✓ contentHash deterministic (same inputs → same hash)
  ✓ contentHash case-insensitive on text
  ✓ contentHash includes category (preference vs fact differ)

IPC handler:
  ✓ store op → EmbeddingService.index called with correct args
  ✓ store op → idempotent on retry (compare-before-write absorbs)
  ✓ forget op (full hash) → EmbeddingService.remove called, scoped
  ✓ forget op (12-char prefix) → resolves prefix, deletes single match
  ✓ forget op (ambiguous prefix) → rejects, logs warn
  ✓ forget op (no match) → idempotent no-op, logs warn
  ✓ cross-board forget structurally impossible (path-derived groupFolder)
  ✓ unknown op → moves file to .errors/
  ✓ malformed JSON → moves file to .errors/
```

**`memory-reader.test.ts` (~12 tests)**

```
recall():
  ✓ queries both memory:board:* and memory:user:* with same vector
  ✓ passes opts.threshold=0.5 explicitly (overrides reader's 0.3 default)
  ✓ merges results, sorts by score
  ✓ takes top K (default 10)
  ✓ filters by category if given
  ✓ board-only (no senderJid) skips user query, returns board hits

formatRelevantMemoriesBlock():
  ✓ stops adding lines when budget exceeded
  ✓ returns empty string when no hits
  ✓ formats <relevant-memories> wrapper correctly
  ✓ truncates memoryId to 12 chars in output
  ✓ tags each line with [scope, category, id=...]

buildMemoryPreamble():
  ✓ end-to-end: prompt → embed → search → format
  ✓ Ollama unreachable → returns '' (fail open)
```

**MCP tool additions in `ipc-mcp-stdio.test.ts` (~9 tests)**

```
memory_store:
  ✓ writes IPC file with correct shape
  ✓ kill-switch env=off → returns error_code='memory_disabled'
  ✓ memory_enabled=0 → returns error_code='memory_disabled_for_board'
  ✓ rejects text<5 chars or >280 chars

memory_recall:
  ✓ embeds query, calls reader, formats result
  ✓ kill-switch off → returns empty
  ✓ scope='both' default

memory_forget:
  ✓ writes IPC file with op=forget
  ✓ kill-switch off → returns error_code
```

### 12.2 Integration tests (`memory-integration.test.ts`, ~7 tests)

`:memory:` SQLite + mocked fetch + **real `src/ipc.ts` polling loop** (not isolated handler):

- Manual store → IPC pipe → real polling loop picks up → host watcher → embeddings.db row → indexer embeds → recall returns
- Idempotency: store same fact twice → no duplicate rows (content-hash dedup)
- Forget: store fact, recall returns it, forget by prefix, recall returns nothing
- Kill-switch: `NANOCLAW_MEMORY=off` → no writes processed, no preamble
- Per-board flag: `memory_enabled=0` → tool returns disabled error
- **Cross-board store attempt**: container A's IPC dir contains a JSON with metadata.senderJid pointing to board B's user — host derives collection from path (board A's dir), NOT metadata; verify the resulting collection is `memory:user:{boardA}:{senderJid}` regardless. **This is the security boundary test.**
- **Real watcher integration**: depends on the `processIpcOnce(groupDir, ctx)` refactor in §5.2 (~40 lines). The integration test imports `processIpcOnce`, sets up a temp `data/ipc/{folder}/memory-writes/` dir + a stub `ctx` (deps mocks), writes a fixture JSON, calls `processIpcOnce` once, asserts the file is consumed and the row appears in embeddings.db.
- **Sender spoof fallback**: container writes a JSON with `metadata.senderJid='OTHER@s.whatsapp.net'` while `messages.db` recent-inbound for this groupFolder shows only `MARIA@s.whatsapp.net`. Run `processMemoryIpc`. Assert: row is stored under `memory:user:{groupFolder}:MARIA@s.whatsapp.net` (the recent inbound, not the spoof), and `logger.warn` was called with `memory.spoof_attempt`.
- **No-recent-inbound rejection**: container writes a JSON with `op=store, scope=user, metadata.senderJid=...` for a groupFolder that has zero recent inbound messages (e.g., script-driven scheduled task). Assert: file moves to `.errors/`, host emits `error_code='no_recent_sender'`, no row in embeddings.db.
- **Cross-board store** (existing test, updated to v2.2 semantics): container A writes a JSON with `metadata.senderJid` belonging to board B's user. The host derives `groupFolder` from board A's path. Assert: collection is `memory:user:{boardA}:{spoof_or_fallback_jid}` (NEVER `memory:*:{boardB}:*`); the file cannot escape board A's namespace regardless of metadata content.

### 12.3 Real-Ollama tests (gated, opt-in)

`memory-ollama.test.ts` runs only when `OLLAMA_HOST` set + `bge-m3` reachable:

- bge-m3 produces 1024-dim vector for English fact text
- Recall returns stored fact when query is semantically close
- Recall returns nothing when query is semantically distant

Skipped in CI by default; ops run pre-deploy.

### 12.4 Performance budgets

| Path | Budget | Test |
|---|---|---|
| Recall path (mocked embed) | <20ms | unit asserts |
| Recall path (real bge-m3) | <100ms p95 | manual sample |
| Auto-recall preamble tokens | ≤500 | unit asserts |
| IPC store latency (write→queryable) | <30s p95 | integration timing |

### 12.5 Post-deploy validation

```sql
-- Memory growth per board, last 7 days
SELECT collection, COUNT(*) AS facts,
       MIN(updated_at) AS first_write, MAX(updated_at) AS last_write
  FROM embeddings
 WHERE collection LIKE 'memory:%'
 GROUP BY collection ORDER BY facts DESC;
```

```bash
# Recall hit rate
journalctl --user -u nanoclaw --since "1 day ago" \
  | grep memory.summary.hourly | jq '.recallHitRate' \
  | awk '{s+=$1;n++} END {print s/n}'

# Manual store call volume
journalctl --user -u nanoclaw --since "1 day ago" \
  | grep -c 'memory.write'

# IPC queue depth (should always be ~0)
ls /root/nanoclaw/data/ipc/*/memory-writes/ 2>/dev/null | wc -l
```

E2E smoke test via existing `scheduled_tasks` pattern: insert one-shot task that calls `memory_store(text=..., category=..., scope='board')` then `memory_recall(query=..., scope='board')` and verifies the fact comes back. **Must use `scope='board'`** because scheduled tasks are script-driven with no recent human inbound, and `scope='user'` writes are rejected with `error_code='no_recent_sender'` (see §6.1 step 3 server-side validation).

## 13. Rollout plan

1. Land code, run all tests (`tsc --noEmit`, vitest, real-Ollama tests if available)
2. Commit migration file
3. Deploy via `./scripts/deploy.sh` (existing pattern)
4. On host startup, migration auto-applies; `memory_enabled=1` set for all `taskflow_managed=1` rows
5. Verify in logs:
   ```
   memory.recall callSite=initial hits.user=N hits.board=M
   memory.recall callSite=ipc_followup hits.user=N hits.board=M
   ```
6. Verify smoke-test E2E (scheduled_task pattern above)
7. Wait 7 days, check `memory.write` volume (should be >0/day fleet-wide once agent starts using the tool)

### Rollback

Two layers:

1. **Per-board:** `UPDATE registered_groups SET memory_enabled=0 WHERE folder='setd-secti-taskflow';` — takes effect on next container start. Active containers retain cached value (see §10.4 mid-session drift). For immediate effect on a chatty board, also evict the active container with `touch data/ipc/setd-secti-taskflow/input/_close` (or wait for natural turn-end).
2. **Fleet-wide:** set `NANOCLAW_MEMORY=off` in service env, `systemctl --user restart nanoclaw`. Effective immediately on restart for all new containers; existing containers exit at restart anyway.

Schema rollback: not needed. `ADD COLUMN` is non-destructive; orphaned memory rows in `embeddings.db` cost a few MB and can stay.

## 14. Deferred items (explicit non-goals at MVP)

- Background extractor / auto-capture (deferred to v3, gated on §7 conditions)
- Cross-board fact promotion (`memory:global` scope)
- Lint pass for contradictions
- Sender deduplication across phone changes
- TTL eviction by age
- Per-fact confidence scores
- Dedicated audit log table (structured `logger.info` is the audit trail)

## 15. Success criteria (30-day eval window)

After 30 days of operation:

| Metric | Target | Measure |
|---|---|---|
| Manual `memory_store` call volume | ≥10/day fleet-wide | `grep -c memory.write` in logs |
| Per-board memory growth | ≥3 facts/board active board | `SELECT COUNT(*) FROM embeddings WHERE collection LIKE 'memory:%' GROUP BY collection` |
| Recall calls returning ≥1 hit | ≥10% of recall calls (much lower bar than v1's 40% — manual writes are sparse early) | hourly summary `recallHitRate` |
| Audit hallucination rate | No regression vs baseline | Kipp daily audit |
| Disk growth | <50MB | `du -sh data/embeddings/` |
| Recall latency p95 | <200ms | `memory.recall.latencyMs` |

If `memory_store` call volume is 0/day after 30 days: agent isn't using the tool. Possible causes: tool description is wrong, agent doesn't perceive value, no scenarios trigger the gating heuristics. Action: re-tune tool description, OR conclude memory layer has no marginal value and disable.

If recall hit rate is <5%: memory bank is too sparse OR queries don't semantically match facts. Action: inspect logs to see which turns had relevant memories that *weren't* hit, tune threshold or rewrite.

If both metrics look good after 30 days: gather data for v3 auto-extractor proposal (the deferred §7 conditions become measurable).
