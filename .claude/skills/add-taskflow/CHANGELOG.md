# TaskFlow Skill Package Changelog

## 2026-03-17

### Ollama Configuration
- **keep_alive: -1** on all Ollama calls (embed + generate) — models stay loaded in GPU permanently
- **Default summarizer model** changed from `llama3.1:8b` to `frob/qwen3.5-instruct:27b`
- **Summarizer timeout** increased from 30s to 60s for larger model

### Duplicate Prevention (engine-level)
- **Hard block ≥95% similarity**: `taskflow_create` refuses creation, `force_create` cannot override
- **Soft warning 85-94%**: unchanged behavior, `force_create` still works
- **CLAUDE.md**: repeated "Inbox: ..." is not a confirmation — agent must remind user task exists

### Motivational Digest Closing
- **Explicit prohibitions** against pressure/blame language in evening digest
- **Bad day guidance**: "find the human story" even with zero completions and many overdue items
- **Friday close**: perspective on the week, not just the day

### Default Assignment
- Tasks created without explicit assignee are automatically assigned to the sender

### Reminder Time Handling
- Agent must ask for time when not specified, never silently default to 12h
- If user doesn't answer or says "tanto faz", default to 08:00 (start of business)

### Recovery Noise Filter (core)
- `recoverPendingMessages()` now filters `⏳ Processando...` and typing indicators
- Prevents spurious container starts and unwanted standups on service restart

### Skill File Sync
- Populated missing files in 4 skills to match their manifests:
  - add-embeddings: `add/` (4 files) + `modify/` (3 files)
  - add-image-vision: `add/plugins/image-vision/` (4 files)
  - add-long-term-context: `add/` test files (3 files)
  - add-taskflow: `modify/` (container-runtime.ts, group-queue.ts)

## 2026-03-15 (continued)

### Bug Hunt Fixes (rounds 1-4, 20 agents)

- **fix:** Counter seeding regression — split OR-joined UPDATE into two independent statements so one counter's default doesn't trigger regression of the other (taskflow-db.ts)
- **fix:** Subtask ID collision after deletion — use max existing suffix instead of count to prevent P1.3 collision when P1.2 was cancelled (taskflow-engine.ts)
- **fix:** Delegated task duplication in `buildContextSummary` — use actual `task.board_id` for rankedIds set instead of `this.boardId` (taskflow-engine.ts)
- **fix:** Group name deduplication fails without ` - TaskFlow` suffix — fallback appends `(personName)` directly (provision-child-board.ts)
- **fix:** SDK error results reported as `status: 'success'` — now correctly reports `status: 'error'` with error details for max_turns, budget, execution errors (agent-runner/index.ts)

### Long-Term Context Integration

- **Conversation recap preamble**: Up to 3 recent summaries injected before each agent session (after embedding preamble)
- **MCP tools**: `context_search`, `context_recall` available to all agents for conversation history search

### Flood Prevention (core)

- **Message noise filter**: Skip WhatsApp "Processando..." indicators — prevented 786-message flood on Giovanni's board
- **Per-group rate limit**: 5-second minimum between agent invocations with drain-loop prevention

### Template Updates

- **Reminder vs inbox**: Intent-based analysis replaces keyword-to-tool mapping. "Lembrar" defaults to reminder, asks for time if missing.
- **Implicit inbox promotion**: Auto-assign to board owner on organic interaction with inbox tasks

## 2026-03-15

### Embeddings Integration (semantic search, duplicate detection, context preamble)

- **Semantic search**: MCP handler embeds query via Ollama, injects `embedding_reader` into engine; engine owns ranking with composite keys (`board_id:task_id`) and +0.2 semantic boost
- **Duplicate detection**: `force_create` flag in `taskflow_create` Zod schema; 0.85 cosine threshold via `ollamaEmbed()` + `findSimilar()`; returns `duplicate_warning` with similar task info
- **Context preamble**: Host embeds user message → `containerInput.queryVector` (base64) → container builds preamble via `engine.buildContextSummary(queryVector, reader)` using `visibleTaskScope()` → prepended to prompt
- **Taskflow embedding sync**: `src/taskflow-embedding-sync.ts` polls taskflow.db every 15s, feeds `EmbeddingService` with `buildSourceText(task)` = title + description + next_action
- **CLAUDE.md template**: Added Duplicate Detection section to all 11 group templates

### Inbox Processing Fix

- **In-place promotion**: Inbox items now promoted via `taskflow_reassign` + `taskflow_update` on existing task instead of create-new + cancel-original; preserves task ID, history, and counter
- **CLAUDE.md template**: Updated Inbox Processing section with WRONG/RIGHT examples and `taskflow_reassign` auto-moves inbox→next_action

### Implicit Inbox Promotion

- **Auto-assign on organic interaction**: When a user reports progress on an inbox task without specifying an assignee, agent auto-assigns to board owner and executes immediately — no more asking "do you want me to assign it first?"
- **CLAUDE.md template**: Added "Implicit inbox promotion (organic interaction)" subsection before formal triage flow

### WhatsApp Group Plugin Fixes (37-bug audit)

- **#9**: Null guard on `groupCreate` result — crash on `result.id` when API returns null
- **#20**: Off-by-one participant cap — creator not counted in 1024 limit
- **#21**: LID JID participants falsely reported as "dropped" — added `translateJid()` in verify steps
- **#22**: Stale listener after socket reconnect — `reconnecting` flag prevents concurrent reconnects, `sock.end(undefined)` before new socket
- **#24**: `@c.us` and `@lid` JID suffixes not stripped in `resolvePhoneJid()` — normalize to `@s.whatsapp.net`
- **#33**: `droppedParticipants` tracking — caller now knows which participants need invite link
- **#36**: Re-verify catch block now sets `allAdded = false` instead of assuming success

### Message Formatting Standardization

- **Consistent response format**: All TaskFlow agent responses use standardized formatting with separator lines, bold headers, and emoji column indicators

### Bug Fixes (61+ across 3 rounds of 20 subagents)

- Comprehensive sweep across 14 files — see commit `1a1d95a` for full list
- Key fixes: env.ts path resolution, group-folder.ts sanitization, credential-proxy.ts auth, mount-security.ts validation, sender-allowlist.ts device suffix normalization
- WhatsApp: message queue re-queue on send failure, LID translation for group message senders, `participantAlt` fallback

### Skill Manifest Updates

- Added to manifest: `dm-routing.ts`, `taskflow-embedding-sync.ts`, `container-runtime.ts`, `group-queue.ts`, `whatsapp-add-participants.ts`, `whatsapp-check-groups.ts`, `whatsapp-fix-groups.ts`
- All add/modify reference copies synced to match live code

## 2026-03-08

### Meeting Notes Feature

- **Meeting type** with `M`-prefix IDs via `board_id_counters`
- **Schema**: `participants TEXT` and `scheduled_at TEXT` columns on tasks
- **Recurring anchor**: `recurrence_anchor TEXT` persisted for recurring meetings
- **Phase-tagged notes**: auto-tagged from column state (`pre`/`meeting`/`post`), with `parent_note_id`, `status` (`open`/`checked`/`task_created`/`inbox_created`/`dismissed`), `processed_at`, `processed_by`, `created_task_id`
- **8 meeting query types**: `meetings`, `meeting_agenda`, `meeting_minutes`, `upcoming_meetings`, `meeting_participants`, `meeting_open_items`, `meeting_history`, `meeting_minutes_at`
- **Minutes triage**: `process_minutes` lists open items, `process_minutes_decision` atomically creates follow-up task/inbox and marks note
- **WIP exclusion**: meetings do not count against WIP limits
- **Open-minutes warning**: soft warning when concluding meeting with unprocessed notes
- **Cancel notifications**: participants notified on meeting cancellation
- **Recurring meeting advance**: archives occurrence to `task_history` (not `archive` table), advances `scheduled_at`, preserves participants
- **Base packaged schema sync**: bundled `taskflow-db.ts` and restore paths include meeting fields
- **Board view**: calendar prefix, `scheduled_at` time, participant count display
- **Report integration**: `upcoming_meetings` and `meetings_with_open_minutes` in standup/digest/weekly
- **Scheduled notifications**: day-based reminders and exact-time start notifications keyed to `scheduled_at`, plus minutes-processed notifications propagated
- **MCP schema**: meeting type in `taskflow_create`, 8 queries in `taskflow_query`, meeting fields in `taskflow_update`, `process_minutes`/`process_minutes_decision` in `taskflow_admin`
- **CLAUDE.md template**: meeting commands, notes, scheduling, participants, movement, triage, queries, display, schema reference
- **Participant permissions**: meeting participants can add/triage notes without being assignee or manager
