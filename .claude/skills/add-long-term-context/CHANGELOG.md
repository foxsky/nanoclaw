# Long-Term Context Skill Changelog

## 2026-03-21

### context_grep — regex + raw session search
- **New MCP tool**: `context_grep` with `mode` (regex/full_text), `scope` (messages/summaries/both), date range, limit
- Searches raw `context_sessions.messages` JSON and `agent_response` text — not just summaries
- Regex mode with ReDoS protection (500-char limit, nested quantifier rejection, 10K row scan cap)
- Full-text mode uses case-insensitive substring matching with LIKE
- Returns snippets (200 chars) with `node_id` for drill-down via `context_recall`
- Total output capped at 40K chars to prevent token bloat
- Ported from upstream lossless-claw `lcm_grep` concept (validated via Codex)

## 2026-03-17

### Ollama Configuration
- **keep_alive: -1** on `/api/generate` calls — summarizer model stays loaded in GPU permanently
- **Timeout increased** from 30s to 60s for larger models

### Model Switch
- **Default model** changed from `llama3.1:8b` → `frob/qwen3.5-instruct:27b` → `qwen3-coder:latest`
- qwen3-coder: 36.6 tok/s (vs 4.5 tok/s for qwen3.5-instruct), concise output, stays on-language
- Hardcoded `DEFAULT_OLLAMA_MODEL` updated in code + `.env` on both local and remote

### Recovery Noise Filter
- `recoverPendingMessages()` now applies `NOISE_VOICE_PROCESSING` and `NOISE_TYPING_INDICATOR` filters
- Prevents spurious container starts from stale `⏳ Processando...` messages on service restart

### Skill File Sync
- Added missing test files to `add/` directory: `context-service.test.ts`, `context-sync.test.ts`, `context-reader.test.ts`

## 2026-03-15

### Initial Release

- **ContextService** (host): Schema with context_cursors, context_nodes, context_sessions, FTS5 + triggers. insertTurn, summarizePending (Ollama/Claude), DAG rollups (daily/weekly/monthly), retention + vacuum.
- **ContextSync** (host): JSONL parser with turn detection (queue-operation dequeue, compact_boundary skip, tool_result continuation, incomplete turn guard). Incremental byte-offset cursor. Background 60s compaction timer with re-entrancy guard.
- **ContextReader** (container): FTS5 search with sanitized MATCH queries, recall with group isolation, timeline, topics (JS tokenization with NFC normalization), getRecentSummaries. Shared db-util.ts with EmbeddingReader.
- **Container integration**: Read-only mount at /workspace/context/, context-reader.ts in CORE_AGENT_RUNNER_FILES, capture hook on container exit (race-safe ref capture).
- **Preamble injection**: Up to 3 recent summaries within 1024-token budget, formatted with local timezone dates.
- **MCP tools**: context_search, context_recall (always), context_timeline + context_topics (progressive unlock at >50 nodes).
- **Skill packaging**: SKILL.md, manifest.yaml, add/, modify/, tests/ directories with reference copies.

### Bug Fixes (from bug hunt)

- **Monthly rollup gate**: Use Monday's month instead of UTC month to prevent orphaning cross-boundary weekly nodes
- **NFD Unicode**: Add .normalize('NFC') before tokenization in topics() for Portuguese text
- **Byte-offset cursor**: Track only complete turns (not EOF) to prevent data loss on incomplete trailing turns
- **Date-only filters**: Append T23:59:59.999Z to date-only inputs in search() and timeline()
- **FTS5 MATCH sanitization**: Wrap tokens in double quotes to prevent metacharacters from causing silent failures
- **Sync re-entrancy**: Add cycleRunning guard to prevent overlapping 60s cycles
- **Monotonic leaf IDs**: Add suffix (:0000, :0001) to prevent timestamp collision data loss
- **Tool result pairing**: Match by tool_use_id when available
- **Manifest**: Remove false add-embeddings dependency, add db-util.ts

### Simplify / Code Quality (from reviews)

- **Shared db-util.ts**: Extract `openReadonlyDb()` + `closeDb()` from ContextReader and EmbeddingReader into shared utility
- **estimateTokens()**: Extract token heuristic (`Math.ceil(len / 3.5)`) into named function in both host and container packages
- **Consolidated readEnvFile**: Single `.env` parse at startup shared between embeddings and context skills
- **Cached prepared statements**: `stmtPruneNodes`, `stmtPruneSessions`, `stmtVacuum` cached in constructor
- **Level constants**: Use `Level.DAILY`/`Level.WEEKLY` instead of magic numbers in rollup prompt selection
- **HTTP error logging**: Log Ollama/Claude non-OK status codes for debugging
- **Timezone in preamble**: Add `timeZone` option to date formatting (TZ env or America/Fortaleza)
- **Shutdown ordering**: Context service closes AFTER queue drain so capture hooks complete first
- **Initial timeout cleanup**: Clear both interval and setTimeout on shutdown
- **Topics N+1 eliminated**: Single SQL query + JS tokenization replaces fts5vocab N+1 pattern
- **Schema migration**: Add `ALTER TABLE` guard for `last_byte_offset` column on existing DBs

### Flood Prevention (core, affects all groups)

- **Message noise filter**: Skip WhatsApp "Processando...", "Gravando...", "Digitando..." indicators before they reach agents
- **Per-group rate limit**: 5-second minimum between new agent invocations, with `pendingRateLimitTimers` Set to prevent drain loop stacking
- **Pre-compiled regex**: `NOISE_VOICE_PROCESSING` and `NOISE_TYPING_INDICATOR` hoisted to module constants
