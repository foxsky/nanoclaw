# Hierarchical Long-Term Context — Design Spec

**Date:** 2026-03-15
**Skill:** `add-long-term-context`
**Status:** Approved design

## Goal

Give every NanoClaw agent access to a compressed, searchable history of its group's past conversations through hierarchical summarization. Recent interactions are preserved in full detail; older ones are progressively compressed into daily, weekly, and monthly summaries. Agents can search history and drill down into recent sessions for full transcript detail.

## Problem

NanoClaw agents run in ephemeral containers. Each invocation starts with only the group's CLAUDE.md and the current user message (plus an embedding-based task context preamble for TaskFlow groups). The agent has no memory of past conversations — it can't recall decisions made last week, context from previous interactions, or patterns in user behavior. This leads to repetitive questions, lost context, and missed continuity.

## NanoClaw Session Model

**This design must accommodate NanoClaw's long-lived session reuse model:**

- Non-TaskFlow groups **resume the same Claude session** across turns (`index.ts:405-407`). Only the `session_id` is persisted in SQLite on the host; `resumeSessionAt` (lastAssistantUuid) exists only within one container lifetime (`container/agent-runner/src/index.ts:603`) and is NOT persisted across container restarts.
- TaskFlow groups **force fresh sessions** per invocation (`group.taskflowManaged === true` discards persisted session).
- A single JSONL transcript file grows across multiple turns for resumed sessions. It may contain transcript branching (documented in `DEBUG_CHECKLIST.md:5`).
- The container runner also resumes within a single container lifetime via a query loop (`container/agent-runner/src/index.ts:603-642`).

**Consequence:** The capture unit is NOT "session finalization." It is **incremental turn capture** — each agent invocation produces new entries appended to a possibly long-lived JSONL transcript. The context service must track a durable cursor per group to avoid re-processing old turns.

## Architecture

### Components

| Component | File | Side | Role |
|---|---|---|---|
| ContextService | `src/context-service.ts` | Host | SQLite write operations, summarization calls, DAG compaction, retention |
| ContextReader | `container/agent-runner/src/context-reader.ts` | Container | Read-only access to summaries for preamble + MCP tools |
| ContextSync | `src/context-sync.ts` | Host | Session capture after agent runs, background compaction timer |
| MCP tools | `container/agent-runner/src/ipc-mcp-stdio.ts` | Container | `context_search`, `context_recall` (+ progressive unlock) |
| Container integration | `src/container-runner.ts` + `container/agent-runner/src/index.ts` | Both | Mount DB, inject recap preamble |

### Data Flow

```
Agent container exits (after one or more query turns)
  → Host calls captureAgentTurn(groupFolder, sessionId)
  → ContextSync reads JSONL transcript, starting from the stored cursor
  → Extracts only NEW entries since last capture (incremental)
  → For each user→assistant exchange found:
      Stores in context_sessions + creates leaf node (summary = NULL)
  → Updates cursor to last processed entry position
  → Background compaction cycle (every 60s):
      1. Summarize pending leaves via Ollama/Claude (max 5/cycle)
      2. Roll up completed days → daily nodes (level 1)
      3. Roll up completed weeks → weekly nodes (level 2)
      4. Roll up completed months → monthly nodes (level 3)
      5. Apply retention (soft-delete old leaves/dailies)
      6. Vacuum (hard-delete pruned rows >30 days old, once/day)

Agent container starts
  → container-runner mounts context.db read-only
  → index.ts opens ContextReader, assembles brief recap preamble
  → Preamble prepended to prompt (after embedding preamble, before user message)
  → MCP tools registered for deeper exploration
```

### DAG Structure (Time-Bucketed)

```
Monthly [Mar 2026]                              ← level 3
├── Weekly [Week 11: Mar 10-16]                 ← level 2
│   ├── Daily [Mon Mar 10]                      ← level 1
│   │   ├── leaf: turn 08:30 (standup prompt)   ← level 0
│   │   ├── leaf: turn 10:20 (task update)      ← level 0
│   │   └── leaf: turn 14:45 (inbox processing) ← level 0
│   ├── Daily [Tue Mar 11]                      ← level 1
│   │   └── ...
│   └── ...
├── Weekly [Week 12: Mar 17-23]                 ← level 2
│   └── ...
```

**Leaf node = one turn** (one host prompt batch → agent response). A "turn" may contain multiple user messages batched together by the host (`index.ts:551` joins pending messages into one prompt) or by the container's IPC loop (`container/agent-runner/src/index.ts:364` joins multiple IPC files). The leaf captures the entire batch as one exchange — not individual messages. A single long-lived session may produce many leaf nodes across days.

**Rollup rules:**
- A daily rollup is created after the day ends (never for today)
- A weekly rollup is created after the week ends (never for the current week)
- A monthly rollup is created after the month ends
- Empty days/weeks produce no nodes — gaps are normal

## Database

**Location:** `data/context/context.db` (SQLite, WAL mode, `busy_timeout=5000`)

**WAL + read-only mount note:** SQLite in WAL mode requires `-wal` and `-shm` files for read-only connections. The host `ContextService` must open the DB (creating WAL/SHM files) before any container starts. This is guaranteed because `ContextService` is initialized at host startup in `index.ts`, before any message processing begins. The mount is the **directory** `data/context/` (not the file), so all three files (`.db`, `-wal`, `-shm`) are visible. Container opens with `{ readonly: true }` — if WAL/SHM don't exist yet (e.g., host just restarted and hasn't opened DB), the reader gracefully returns empty results.

### Schema

All tables use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for safe re-entry (matching `embedding-service.ts` pattern). Schema version tracked via `PRAGMA user_version`.

```sql
PRAGMA foreign_keys = ON;

-- Incremental capture cursor: tracks how far we've read each group's transcript
CREATE TABLE IF NOT EXISTS context_cursors (
  group_folder  TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,         -- current JSONL session ID
  last_entry_index INTEGER NOT NULL DEFAULT 0,  -- line offset in the JSONL file
  last_byte_offset INTEGER NOT NULL DEFAULT 0,  -- byte offset for efficient seeking (avoids re-reading entire file)
  last_assistant_uuid TEXT,            -- UUID of last processed assistant message (best-effort consistency check only — NOT persisted by the host session model, only used within the context cursor for detecting transcript branch drift)
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_nodes (
  id            TEXT PRIMARY KEY,
  group_folder  TEXT NOT NULL,
  level         INTEGER NOT NULL,     -- 0=leaf, 1=daily, 2=weekly, 3=monthly
  summary       TEXT,                 -- NULL until summarized
  time_start    TEXT NOT NULL,        -- ISO8601
  time_end      TEXT NOT NULL,        -- ISO8601
  parent_id     TEXT REFERENCES context_nodes(id) ON DELETE SET NULL,  -- rollup node that absorbed this; SET NULL if parent is deleted (orphan recovery)
  token_count   INTEGER,             -- estimated tokens in summary
  model         TEXT,                 -- model that produced the summary
  created_at    TEXT NOT NULL,
  pruned_at     TEXT                  -- ISO8601, soft delete timestamp
);

CREATE TABLE IF NOT EXISTS context_sessions (
  id            TEXT PRIMARY KEY,     -- matches leaf node id
  group_folder  TEXT NOT NULL,
  session_id    TEXT,                 -- JSONL session ID for traceability/debugging
  messages      TEXT NOT NULL,        -- JSON: [{sender, content, timestamp}]
  agent_response TEXT,
  tool_calls    TEXT,                 -- JSON: [{tool, result_summary}]
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

-- Full-text search over summaries.
-- Uses a standalone FTS5 table (NOT content-sync, NOT contentless) to avoid
-- the rowid/column-read restrictions of content='' tables. The trade-off is
-- duplicate storage of summary text, but summaries are small (~200 words each).
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  node_id UNINDEXED,   -- stored but not searchable (used for joins, not matching)
  group_folder UNINDEXED,  -- stored for group-scoped filtering
  summary              -- the only indexed/searchable column
);

-- fts5vocab for topic extraction (used by context_topics tool)
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts_vocab USING fts5vocab(context_fts, row);

-- Keep FTS in sync via triggers on context_nodes.
-- INVARIANT: context_nodes.id is immutable (PK, never updated). Triggers depend on this.
CREATE TRIGGER IF NOT EXISTS context_fts_insert AFTER INSERT ON context_nodes
  WHEN NEW.summary IS NOT NULL
  BEGIN INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary); END;

CREATE TRIGGER IF NOT EXISTS context_fts_update AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NOT NULL AND OLD.summary IS NOT NULL
  BEGIN
    DELETE FROM context_fts WHERE node_id = OLD.id;
    INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary);
  END;

-- Summary went from NULL to non-NULL (first summarization)
CREATE TRIGGER IF NOT EXISTS context_fts_first AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NOT NULL AND OLD.summary IS NULL
  BEGIN INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary); END;

-- Handle summary set back to NULL (re-summarization retry)
CREATE TRIGGER IF NOT EXISTS context_fts_clear AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NULL AND OLD.summary IS NOT NULL
  BEGIN DELETE FROM context_fts WHERE node_id = OLD.id; END;

CREATE TRIGGER IF NOT EXISTS context_fts_delete AFTER DELETE ON context_nodes
  WHEN OLD.summary IS NOT NULL
  BEGIN DELETE FROM context_fts WHERE node_id = OLD.id; END;
```

**FTS5 search strategy:** Standalone FTS5 table with `node_id` and `group_folder` as UNINDEXED stored columns. Search uses `summary` column only, then joins back to `context_nodes` for full metadata:
```sql
SELECT cn.* FROM context_fts cf
  JOIN context_nodes cn ON cn.id = cf.node_id
  WHERE context_fts MATCH ? AND cf.group_folder = ? AND cn.pruned_at IS NULL
  ORDER BY rank
  LIMIT ?
```
Group filtering uses `cf.group_folder` (FTS-side UNINDEXED column) for early filtering, plus `cn.pruned_at IS NULL` on the join. The `node_id UNINDEXED` and `group_folder UNINDEXED` declarations ensure these columns are stored for retrieval/filtering but do NOT pollute the FTS5 search index or topic extraction via fts5vocab.

### Node ID Format

- Leaf: `leaf:{group_folder}:{ISO8601_timestamp}` (timestamp of the user message that started the turn)
- Daily: `daily:{group_folder}:{YYYY-MM-DD}`
- Weekly: `weekly:{group_folder}:{YYYY-Www}` (ISO week)
- Monthly: `monthly:{group_folder}:{YYYY-MM}`

Node IDs are deterministic but contain `group_folder`, which means they are guessable across groups. All read operations enforce `WHERE group_folder = ?` to maintain isolation (see ContextReader API).

### Retention Policy

**This is NOT lossless retention.** Original session transcripts and fine-grained daily summaries are eventually pruned. What survives indefinitely are the weekly and monthly rollup summaries — compressed but permanent. The trade-off is explicit: full drill-down detail is available within the retention window; beyond that, only hierarchical summaries remain.

- **Leaves + sessions:** Soft delete after 90 days (`CONTEXT_RETAIN_DAYS=90` in `.env`). `applyRetention()` sets `pruned_at` on both `context_nodes` (level 0) and `context_sessions` for matching leaf IDs in a **single transaction** to keep them in lockstep.
- **Daily rollups:** Soft delete after 90 days (same transaction as leaves)
- **Weekly and monthly rollups:** Kept forever — these are the permanent historical record
- **Hard delete:** Rows with `pruned_at` older than 30 days are permanently removed by the vacuum cycle (runs once per day). Simply `DELETE FROM context_nodes WHERE pruned_at < ?` — the `ON DELETE CASCADE` FK automatically removes the corresponding `context_sessions` row.
- **`context_recall` after pruning:** When drill-down is requested on a weekly/monthly node whose children have been pruned, only the rollup summary is returned with a `"detail_pruned": true` flag. The agent sees "detailed session data is no longer available for this period."

**Note on the original messages:** The raw messages always remain in `store/messages.db` (the main message store). The retention policy only affects the context DAG's leaf nodes and session extracts — not the source messages themselves. If a user needs to recover exact message text beyond the 90-day window, `messages.db` is the authoritative source.

## Summarization

### Backend

Configurable via `.env`:

```env
CONTEXT_SUMMARIZER=ollama          # or 'claude'
CONTEXT_SUMMARIZER_MODEL=llama3.1  # Ollama model name (ignored if claude)
```

**Ollama (default):** `POST ${OLLAMA_HOST}/api/generate` with the summarization prompt. Uses the same Ollama instance as embeddings (192.168.2.13). Timeout: 30s per call.

**Claude (optional):** Haiku 4.5 via Anthropic API. Uses `ANTHROPIC_API_KEY` from `.env`. ~$0.001 per summary.

### Summarization Prompts

**Leaf summary (single turn → ~50-150 words):**
```
Summarize this conversation turn concisely. Include:
- Who sent the message and what they asked/reported
- What actions the assistant took (task updates, assignments, captures)
- Any decisions made or information exchanged
- Key outcome

User message:
{user_message}

Assistant response:
{agent_response}

Tools called: {tool_names}

Write a concise summary in the same language as the conversation.
```

**Daily rollup (leaves → ~150-250 words):**
```
Summarize the day's activity from these session summaries. Group by theme, not chronologically. Highlight:
- Tasks created, completed, or moved
- Key decisions and their rationale
- Open questions or pending items
- Notable interactions

{leaf_summaries}

Write a concise daily summary in the same language as the sessions.
```

**Weekly rollup (dailies → ~200-300 words):**
```
Summarize the week's activity from these daily summaries. Focus on:
- Overall progress and velocity
- Key accomplishments
- Recurring themes or blockers
- Status changes across the week

{daily_summaries}
```

**Monthly rollup (weeklies → ~200-300 words):**
```
Summarize the month's activity from these weekly summaries. Capture:
- Major milestones and deliverables
- Trends and patterns
- Strategic decisions
- State at month-end

{weekly_summaries}
```

## ContextService API

`src/context-service.ts`

```typescript
// ContextService owns DB operations only (schema, CRUD, summarization, rollups, retention).
// JSONL parsing and incremental capture live in context-sync.ts (separation of concerns).
class ContextService {
  constructor(dbPath: string, config: ContextConfig)

  // Insert a single captured turn as a leaf node + session record (transactional)
  insertTurn(groupFolder: string, sessionId: string, turn: CapturedTurn): number

  // Summarization
  summarizePending(limit?: number): Promise<number>  // returns count processed

  // DAG compaction
  rollupDaily(groupFolder: string, date: string): Promise<string | null>
  rollupWeekly(groupFolder: string, weekStart: string): Promise<string | null>
  rollupMonthly(groupFolder: string, month: string): Promise<string | null>

  // Retention
  applyRetention(): number  // returns count pruned
  vacuum(): number          // returns count hard-deleted

  // Lifecycle
  close(): void
}

// context-sync.ts — JSONL parsing, cursor management, background compaction
function captureAgentTurn(service: ContextService, groupFolder: string, sessionId: string): Promise<void>
function startContextSync(service: ContextService): NodeJS.Timeout

interface ContextConfig {
  summarizer: 'ollama' | 'claude';
  summarizerModel?: string;       // Ollama model name
  ollamaHost?: string;            // reads from OLLAMA_HOST env
  anthropicApiKey?: string;       // passed from caller (reads .env via readEnvFile at startup)
  retainDays: number;             // default 90
}

interface SessionMessage {
  sender: string;
  content: string;
  timestamp: string;
}

interface ToolCallSummary {
  tool: string;
  resultSummary: string;
}
```

**Cached prepared statements** for all frequent queries (insert node, insert session, select pending, select by group+level, FTS search).

## ContextReader API

`container/agent-runner/src/context-reader.ts`

```typescript
class ContextReader {
  constructor(dbPath: string)  // readonly: true

  // Preamble — returns the N most recent leaf-level (level 0) summaries for the group.
  // Only returns nodes where summary IS NOT NULL and pruned_at IS NULL.
  getRecentSummaries(group: string, limit: number): ContextNode[]

  // Tools
  search(group: string, query: string, options?: {
    dateFrom?: string; dateTo?: string; limit?: number;
  }): ContextNode[]

  // For leaf nodes: returns summary + original session messages.
  // For rollup nodes (daily/weekly/monthly): returns summary + non-pruned child node summaries.
  // Query: SELECT * FROM context_nodes WHERE parent_id = ? AND group_folder = ? AND pruned_at IS NULL
  // If ALL children are pruned, returns { detail_pruned: true } with only the rollup summary.
  // This applies at every level: weekly nodes may have pruned daily children after 90 days.
  // SECURITY: group_folder is required and enforced via WHERE id = ? AND group_folder = ?
  // to prevent cross-group data access via guessable node IDs.
  recall(group: string, nodeId: string): {
    summary: ContextNode;
    sessions: ContextSession[];   // empty if sessions pruned or node is a rollup
    children: ContextNode[];      // non-pruned child summaries for rollup nodes
    detail_pruned: boolean;       // true if all children/sessions have been pruned
  } | null

  timeline(group: string, dateFrom: string, dateTo: string): ContextNode[]

  // Extracts top terms from FTS5 using fts5vocab (see Topics Extraction below)
  topics(group: string): { topic: string; nodeCount: number; lastSeen: string }[]

  getNodeCount(group: string): number

  close(): void
}
```

**Types:**
```typescript
interface ContextNode {
  id: string;
  group_folder: string;
  level: number;
  summary: string | null;
  time_start: string;
  time_end: string;
  parent_id: string | null;
  token_count: number | null;
  model: string | null;
  created_at: string;
}

interface ContextSession {
  id: string;
  group_folder: string;
  messages: SessionMessage[];    // parsed from JSON
  agent_response: string | null;
  tool_calls: ToolCallSummary[]; // parsed from JSON
  created_at: string;
}
```

**Group isolation SQL templates for all read paths:**
```sql
-- getRecentSummaries
SELECT * FROM context_nodes
  WHERE group_folder = ? AND level = 0 AND summary IS NOT NULL AND pruned_at IS NULL
  ORDER BY time_start DESC LIMIT ?

-- getNodeCount
SELECT COUNT(*) FROM context_nodes WHERE group_folder = ? AND pruned_at IS NULL

-- timeline (auto-selects best level for date range)
SELECT * FROM context_nodes
  WHERE group_folder = ? AND time_start >= ? AND time_end <= ? AND pruned_at IS NULL
  ORDER BY level DESC, time_start ASC

-- recall (root node must also be non-pruned)
SELECT * FROM context_nodes WHERE id = ? AND group_folder = ? AND pruned_at IS NULL
SELECT * FROM context_nodes WHERE parent_id = ? AND group_folder = ? AND pruned_at IS NULL
SELECT * FROM context_sessions WHERE id = ? AND group_folder = ? AND pruned_at IS NULL
```

**Graceful fallback:** If DB doesn't exist (`!fs.existsSync`), all methods return empty. No exceptions.

### Topics Extraction

The `topics()` method uses a single SQL query + JS-side tokenization to avoid N+1 FTS queries:

1. Fetch all non-pruned summaries for the group in one query:
   ```sql
   SELECT summary, time_end FROM context_nodes
   WHERE group_folder = ? AND summary IS NOT NULL AND pruned_at IS NULL
   ```
2. Tokenize each summary in JavaScript: lowercase, split on non-alphanumeric, filter stop words and terms < 3 chars, deduplicate per document
3. Count term frequency across all summaries, track `lastSeen` per term
4. Return top 20 terms ranked by group-specific count

This approach eliminates the N+1 pattern entirely (no `fts5vocab` or per-term MATCH queries needed). The `fts5vocab` table remains in the schema but is not used by `topics()`.

The `context_topics` tool is only unlocked at >50 nodes and is not on the hot path.

## Context Preamble Injection

**In `container/agent-runner/src/index.ts`**, after embedding preamble and before `runQuery()`:

```
1. Open ContextReader at /workspace/context/context.db
2. reader.getRecentSummaries(groupFolder, 3)
3. If results exist and total token_count < 1024:
   Format as:
     --- Recent conversation history ---
     [Mar 14, 14:30] Alexandre reported progress on T1, assigned to him, moved to in-progress.
     [Mar 14, 10:20] Standup: 13 tasks, 7 inbox. No overdue items.
     [Mar 15, 08:15] Miguel captured T65 (geladeira mola) in inbox.
     ---
4. Prepend to prompt
5. Close reader in finally block
```

**Token budget:** 1024 tokens for recap preamble. If the 3 most recent summaries exceed this, reduce to 2, then 1.

**Order in final prompt:** Conversation recap → Embedding preamble → User message (both blocks prepend to `prompt`; the recap runs second so it ends up first in the final string. Both are agent context — ordering between them is not semantically critical.)

## MCP Retrieval Tools

Registered in `container/agent-runner/src/ipc-mcp-stdio.ts`.

### Always Available

**`context_search`**
```typescript
{
  name: 'context_search',
  description: 'Search conversation history for this group. Returns summaries matching the query.',
  inputSchema: {
    query: z.string().describe('Search terms (keywords, names, task IDs)'),
    date_from: z.string().optional().describe('ISO date, e.g. 2026-03-01'),
    date_to: z.string().optional().describe('ISO date, e.g. 2026-03-15'),
    limit: z.number().optional().default(10),
  }
}
```

**`context_recall`**
```typescript
{
  name: 'context_recall',
  description: 'Expand a summary to see original session messages. Use after context_search to get details.',
  inputSchema: {
    node_id: z.string().describe('Node ID from context_search results'),
  }
}
// Handler injects group_folder from NANOCLAW_GROUP_FOLDER env var (set by MCP env builder).
// Calls reader.recall(groupFolder, nodeId) — enforces WHERE id = ? AND group_folder = ?
// so agents cannot access another group's context even with a valid node_id.
```

### Progressive Unlock (>50 nodes)

**`context_timeline`**
```typescript
{
  name: 'context_timeline',
  description: 'Chronological summary list for a date range. Auto-selects best detail level.',
  inputSchema: {
    date_from: z.string().describe('Start date'),
    date_to: z.string().describe('End date'),
  }
}
```

**`context_topics`**
```typescript
{
  name: 'context_topics',
  description: 'List distinct topics from conversation history with frequency and last seen date.',
  inputSchema: {}
}
```

### Tool Registration Logic

```typescript
const reader = new ContextReader(CONTEXT_DB_PATH);
const nodeCount = reader.getNodeCount(groupFolder);

// Always register
registerTool('context_search', ...);
registerTool('context_recall', ...);

if (nodeCount > 50) {
  registerTool('context_timeline', ...);
  registerTool('context_topics', ...);
}
```

## Container Integration

### container-runner.ts

1. **Mount:** `data/context/` → `/workspace/context/:ro` (directory mount, same pattern as embeddings and taskflow mounts). Container accesses DB at `/workspace/context/context.db`.

2. **Post-turn hook:** A single capture trigger to avoid double-firing:
   - **On container exit only.** Call `captureAgentTurn(contextService, groupFolder, sessionId)` once in the `container.on('close')` handler (`container-runner.ts:627`). This is the only unambiguous "all writing is done" signal — the JSONL is complete and no partial lines exist.
   - For **non-TaskFlow groups** (query loop), the container eventually exits when idle timeout fires or when the group queue preempts it. At that point, the capture reads all new turns accumulated since the last cursor position. Multiple user→assistant exchanges may be captured in one batch — this is correct and efficient.
   - For **TaskFlow groups** (fresh session, no query loop), the container exits after each invocation. Capture happens immediately after.
   - **Why not on streamed output:** The container emits multiple stdout markers per query round (per-result markers during the query + a null-result session-update marker after). Hooking streamed output would double-trigger and could capture partial state mid-query. Container exit is the only safe boundary.
   - Fire-and-forget — errors are logged, never block the next message.

3. **Add `context-reader.ts` to `CORE_AGENT_RUNNER_FILES`** array in `container-runner.ts:76-84`. This array is synced to every per-group `agent-runner-src/` directory on **every container start** via `syncCoreAgentRunnerFiles()` (`container-runner.ts:86-98`), so existing groups receive the new file automatically — no migration needed.

### Incremental Turn Capture

The capture unit is a **turn** (one user message → one agent response), not a session. NanoClaw's long-lived sessions mean the JSONL transcript grows across many turns. The context service uses a durable cursor to avoid reprocessing.

**Cursor mechanism:**

The `context_cursors` table stores per-group state:
- `session_id` — the current JSONL file being tracked
- `last_entry_index` — the **next** line to read (0-based). After processing lines 0-9, cursor is set to 10. The next capture starts reading from line 10. This is "exclusive end" semantics, same as array slice — no off-by-one ambiguity.
- `last_assistant_uuid` — UUID of the last captured assistant message (for branch-safety validation)

**JSONL file location (host-side):**
```
data/sessions/{group_folder}/.claude/projects/-workspace-group/{session_id}.jsonl
```
The `-workspace-group` path segment is a Claude SDK convention (the project directory mapped from `/workspace/group/` inside the container). This convention could change on SDK upgrades — isolate path construction into a single helper function.

**When capture is triggered:**

Capture fires **only on container exit** (`container.on('close')` handler). This is the single unambiguous signal that the JSONL is complete and no partial lines exist.

- **Non-TaskFlow groups:** The container stays alive across turns via the query loop (`container/agent-runner/src/index.ts:603-642`). It exits when idle timeout fires or when preempted by group-queue. At exit, the capture reads ALL new turns accumulated since the last cursor position — multiple user→assistant exchanges may be captured in one batch.
- **TaskFlow groups:** The container exits after each invocation (fresh session, no query loop). Each invocation produces a new JSONL file (new session ID), so the cursor resets to 0.
- **Why container-exit only:** The container emits multiple stdout markers per query round (per-result markers + session-update markers). Hooking streamed output would double-trigger and could capture partial state mid-query. Container exit guarantees the JSONL is fully written.

**Capture flow (`captureAgentTurn`):**

1. Look up cursor for `group_folder` in `context_cursors`
2. Construct the JSONL host path from `session_id`: `data/sessions/{group_folder}/.claude/projects/-workspace-group/{session_id}.jsonl`
3. If JSONL file doesn't exist, return 0 (no-op, don't update cursor)
4. If `session_id` changed from cursor, reset `last_entry_index` to 0. Session IDs are UUIDs — each unique session_id corresponds to exactly one JSONL file, never reused.
5. Read JSONL transcript starting from line `last_entry_index` (exclusive-end cursor — this is the first unprocessed line). Since capture fires only on container exit, the JSONL is fully written — no partial-line risk.
6. Parse new entries. Skip any entry whose `type` is not `user`, `assistant`, or `queue-operation`:
   - **`queue-operation` with `operation: "dequeue"`** is the most reliable turn-boundary marker in long-lived sessions. Each dequeue signals a new host-to-container invocation. Its `timestamp` is the authoritative turn timestamp. `enqueue` operations (subagent task notifications) are NOT turn boundaries — ignore them.
   - **`system` entries with `subtype: "compact_boundary"`** mark SDK context compaction. The `user` entry immediately following a compact_boundary is a synthetic compaction summary (content starts with "This session is being continued..."), NOT a real user message. **Skip it** — do not create a leaf node for compaction summaries.
   - **New turn starts when:** a `queue-operation` dequeue is encountered, OR (fallback) a `type: 'user'` entry has `message.content` as an array containing at least one block that is NOT a `tool_result`. Note: real user messages almost always use array content (not plain string). Plain string content on a user entry is typically the post-compaction synthetic summary.
   - **Within a turn:** `type: 'assistant'` entries with `message.content` as block array → extract `text` blocks as response, `tool_use` blocks for tool call names. `type: 'user'` entries with `message.content` as array of only `tool_result` blocks → part of the same turn (tool results, extract first 200 chars each).
   - **Turn ends when:** the next turn-boundary marker (dequeue or new real user message) appears, or EOF is reached.
   - **Completeness test:** A turn is only persisted as a leaf node if it contains BOTH a user message AND at least one assistant response with a `text` block. Incomplete turns (user message without assistant response, e.g., from a preempted container or mid-query capture) are skipped — the cursor does NOT advance past them, so they will be re-evaluated on the next capture. Since capture fires only on container exit, incomplete turns should be rare (only on hard kills like SIGKILL/OOM).
   - **Subagent transcripts** (`subagents/` subdirectory under the session path) are out of scope — the capture is driven by `session_id` passed from the host, which always points to the main session JSONL.
7. Each completed turn becomes one leaf node + one session record.
8. Update cursor with new `last_entry_index` and `last_assistant_uuid`
9. All in one transaction (cursor update + leaf/session inserts)

**Session ID tracking:** The host passes `ContainerOutput.newSessionId` to `captureAgentTurn`. If the session ID differs from the stored cursor, the cursor resets. This handles both TaskFlow (always fresh → new file) and non-TaskFlow (resume → same growing file) groups correctly.

**Branch safety:** If `last_assistant_uuid` doesn't match the expected position in the JSONL (transcript branching, per `DEBUG_CHECKLIST.md:5`), log a warning and scan forward from the cursor position until we find new entries that haven't been captured. The UUID acts as a consistency check, not a hard requirement.

**Input truncation:** If extracted messages for a single turn exceed 4000 tokens (~16K chars), truncate tool results first, then older content, keeping the user query and final agent response intact.

**Token estimation:** `token_count` stored on nodes is estimated as `Math.ceil(summary.length / 3.5)` — calibrated for Portuguese text (primary language). No tokenizer dependency needed.

### context-sync.ts API

```typescript
/**
 * Starts the background compaction timer (60s interval).
 * Each cycle:
 *   1. service.summarizePending(5) — process up to 5 pending leaves
 *   2. For each group with leaves from completed days (calendar boundary passed): service.rollupDaily()
 *   3. For each group with dailies from completed weeks (calendar boundary passed): service.rollupWeekly()
 *   4. For each group with weeklies from completed months (calendar boundary passed): service.rollupMonthly()
 *   Rollup precondition is CALENDAR BOUNDARY, not "all children exist." Sparse days/weeks
 *   (no activity on some days) are normal — rollup summarizes whatever children exist.
 *   5. service.applyRetention() — soft-delete old leaves/dailies
 *   6. service.vacuum() — hard-delete (once per day only, tracked by last-vacuum timestamp)
 *
 * Groups are discovered from context_cursors table (SELECT DISTINCT group_folder).
 * Returns NodeJS.Timeout for cleanup on shutdown.
 */
function startContextSync(service: ContextService): NodeJS.Timeout

/**
 * Called by container-runner.ts after each agent container exits.
 * Calls service.captureNewTurns() which reads JSONL from cursor position.
 * Fire-and-forget — errors are logged, never thrown.
 */
function captureAgentTurn(
  service: ContextService,
  groupFolder: string,
  sessionId: string
): Promise<void>
```

### index.ts (host startup)

```typescript
// --- add-long-term-context skill ---
import { ContextService } from './context-service.js';
import { startContextSync } from './context-sync.js';

const contextService = new ContextService('data/context/context.db', {
  summarizer: (process.env.CONTEXT_SUMMARIZER as 'ollama' | 'claude') || 'ollama',
  summarizerModel: process.env.CONTEXT_SUMMARIZER_MODEL,
  ollamaHost: process.env.OLLAMA_HOST,
  retainDays: parseInt(process.env.CONTEXT_RETAIN_DAYS || '90'),
});

const contextSyncTimer = startContextSync(contextService);

// On shutdown:
clearInterval(contextSyncTimer);
contextService.close();
```

## Configuration (.env)

```env
# Long-Term Context (add-long-term-context skill)
CONTEXT_SUMMARIZER=ollama              # 'ollama' or 'claude'
CONTEXT_SUMMARIZER_MODEL=llama3.1      # Ollama model (ignored if claude)
CONTEXT_RETAIN_DAYS=90                 # Soft-delete leaves/dailies after N days
```

Uses existing `OLLAMA_HOST` and `ANTHROPIC_API_KEY` from `.env` — no new connection settings needed.

## Skill Structure

```
.claude/skills/add-long-term-context/
├── SKILL.md
├── manifest.yaml
├── add/
│   ├── src/context-service.ts
│   ├── src/context-sync.ts
│   └── container/agent-runner/src/context-reader.ts
├── modify/
│   ├── src/container-runner.ts
│   ├── src/index.ts
│   ├── container/agent-runner/src/ipc-mcp-stdio.ts
│   └── container/agent-runner/src/index.ts
└── tests/
    ├── context-service.test.ts
    └── context-reader.test.ts
```

**No dependency on add-taskflow or add-embeddings.** This is a fully generic skill. Any group type benefits from conversation history.

## Relationship with Existing Conversation Archive

NanoClaw already has a `PreCompact` hook (`container/agent-runner/src/index.ts:170-209`) that reads the same JSONL transcript source and writes markdown conversation archives to `groups/{name}/conversations/{date}-{summary}.md`. This runs inside the container during SDK session compaction.

**Coexistence policy:**
- The PreCompact markdown archive **remains as-is**. It serves a different purpose: human-readable archives stored alongside the group's CLAUDE.md, accessible to the agent via filesystem reads.
- The new context DAG is a **separate, structured pipeline** optimized for search, compression, and preamble injection. It reads from the same JSONL source but via host-side incremental cursor capture, not container-side hooks.
- **No dependency between them.** The PreCompact hook fires on SDK compaction events (which may not happen every turn). The context capture fires on every container exit. They may cover overlapping turns but produce different artifacts (markdown vs SQLite DAG).
- **No conflict.** Both read the JSONL transcript but neither modifies it. The JSONL is written by the Claude SDK and is immutable from both pipelines' perspective.
- **No file-handle contention.** The PreCompact hook runs **inside** the container and reads the JSONL at its container path (`/home/node/.claude/projects/-workspace-group/{session}.jsonl`). The context capture runs on the **host** and reads the same file at its host path (`data/sessions/{group}/.claude/projects/-workspace-group/{session}.jsonl`). They run in different mount namespaces.
- If a future simplification is desired, the PreCompact archive could be deprecated in favor of `context_recall` — but that is out of scope for this design.

## Error Handling

- **Ollama/Claude unreachable:** Skip summarization, retry next cycle. Leaf nodes accumulate with `summary = NULL` until the backend recovers.
- **DB locked:** `busy_timeout=5000` handles transient locks. If still locked, skip and retry.
- **DB missing in container:** ContextReader returns empty results. No preamble injected. Tools return empty arrays.
- **Corrupted DAG (orphan nodes, missing parents):** `parent_id` has `ON DELETE SET NULL` FK — if a parent is deleted, children become orphans with `parent_id = NULL`. Rollup queries select children by `WHERE parent_id IS NULL AND level = N AND group_folder = ?` — orphans at the correct level are picked up in the next rollup cycle automatically.
- **Summarization produces empty/garbage:** Validate summary length > 20 chars. Reject and retry if too short.
- **Oversized turn:** If a single turn's messages exceed 4000 tokens (~16K chars), truncate tool results first, then older content, keeping user query and final agent response. This caps Ollama/Claude input size.
- **Ollama timeout on large input:** 30s timeout per call. If it times out, the leaf stays with `summary = NULL` and is retried next cycle.
- **JSONL file not found:** For new groups or before the first agent invocation, the JSONL file may not exist. `captureAgentTurn` returns 0 and does not update the cursor.
- **Session ID change (cursor reset):** When `captureAgentTurn` detects a different session ID than the stored cursor, it resets `last_entry_index` to 0 and reads the new JSONL file from the beginning. Session IDs are UUIDs; each corresponds to exactly one JSONL file, never reused.
- **No partial-line risk:** Capture fires only on container exit — the JSONL is fully written and closed by the time capture reads it.
- **Transcript branching:** If `last_assistant_uuid` doesn't match the expected position, log a warning and scan forward. New entries are identified by line offset — the cursor never goes backward.

## Testing

- **context-service.test.ts:** Schema creation, captureNewTurns with cursor advancement, cursor reset on session ID change, multiple turns from same JSONL, summarizePending (mock LLM), rollup at each level (daily/weekly/monthly), retention + vacuum with CASCADE, FTS5 triggers (insert/update/delete/clear)
- **context-reader.test.ts:** Search via FTS5 with group isolation, recall with group enforcement (reject cross-group), recall with sessions (leaf), recall with pruned sessions (summary only), recall on rollup node (children), getRecentSummaries (leaf level only), graceful fallback on missing DB, getNodeCount, topics via fts5vocab, progressive tool unlock threshold

## Future Considerations (Not in Scope)

- Embedding-based semantic search over summaries (currently FTS5 keyword only)
- Cross-group context (agent in group A recalls conversation from group B)
- Export/import DAG for backup or migration
- WebSocket live updates for monitoring compaction progress
