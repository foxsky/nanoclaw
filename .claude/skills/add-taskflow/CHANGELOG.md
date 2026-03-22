# TaskFlow Skill Package Changelog

## 2026-03-22

### UX Overhaul — Board Readability
- **Compact board header**: Digest/weekly reports replace full Kanban board with column counts, cutting message length ~50%
- **Smart board view**: Standup/on-demand board shows summaries for 3+ tasks per person, details for fewer; board owner first
- **Motivational message**: Separate send_message after digest/weekly — celebration line + warm human summary
- **Person briefing**: "Tarefas do Rafael" returns structured dispatch view grouped by urgency, projects expanded with subtasks
- **Stale summaries**: 3+ stale tasks show per-person counts instead of individual listings
- **Parent project context**: Subtasks display parent project (📁 P24 — Agência INOVATHE / P24.1)
- **Notification layout**: Unified format with single separator, removed redundant actor names
- **Separator cleanup**: Confirmations use one separator after title, no double separators

### Direct Transitions
- **wait/review/return** accept more source columns — no intermediate chaining, one move = one notification
- **waiting_for cleanup**: Cleared on any exit from waiting column, not just resume/done/review

### Container Reliability
- **No busy preemption**: Scheduled tasks wait for idle containers instead of killing mid-query
- **Starvation timer**: 2-minute timeout forces close if container never goes idle
- **pendingClose leak fix**: Stale close requests don't carry to next container run

### Code Quality
- Extracted `fetchActiveTasks`, `renderStaleTasks`, `cleanupRun` shared helpers
- Hoisted SEP to class constant
- Fixed 17 pre-existing test failures (Portuguese localization)
- Added 15 new tests (compact board, direct transitions, starvation, drain lifecycle)

## 2026-03-18

### Fixed
- **Auto-assign to sender**: Tasks created without an explicit assignee are now auto-assigned to the sender (board owner). Previously only meetings did this; other types sat unassigned in inbox. Eliminates unowned tasks and the confusion of assigned-vs-unassigned inbox states.
- **Start from inbox**: `start` and `force_start` now allow tasks in `inbox` column directly, removing two special-case branches. Previously, assigned inbox tasks had no valid `start` path — agents would thrash and resort to raw SQL.
- **Digest credits assignee**: Evening digest closing now names the person who completed a task ("Laizys resolveu") rather than crediting the board owner.
- **Timezone handling**: `scheduled_at` passed without `Z` suffix is now treated as local time (board timezone) and automatically converted to UTC by the engine. Values with `Z` are kept as-is for backward compatibility. All notification messages (reminders, start, reschedule, invites) now display local time via `utcToLocal`.
- **Cross-board meeting visibility**: Child board agents can now view meetings on parent boards where their people are participants or organizer. `getTask()` extended with `isBoardMeetingParticipant` check.
- **External participants in task_details**: `task_details` query now includes `external_participants` for meeting tasks.
- **Meeting query board_id**: `meeting_participants`, `meeting_history`, and `meeting_minutes_at` now use the owning board ID for all lookups, fixing incorrect results when queried from child boards.
- **Tool descriptions**: `scheduled_at` in `taskflow_create` and `taskflow_update` now describes local time format, explicitly instructing agents not to append `Z`.

### Parent Board Notifications for Task Updates
- **feat:** `taskflow_update` now sends parent board notifications when a child board updates a delegated task (notes, priority, due date changes). Previously only `taskflow_move` (column transitions) notified the parent board, so update notes from child boards went unnoticed.
- **refactor:** Extracted `buildParentNotification()`, `getBoardGroupJid()`, and `deduplicateNotificationsForParent()` helpers — shared between `move()` and `update()`, eliminating duplicated parent notification logic.
- **refactor:** Extracted `ParentNotification` type — replaces inline `{ parent_group_jid: string; message: string }` in `MoveResult`, `UpdateResult`, and `ipc-mcp-stdio.ts`.

### Timezone Fix for schedule_task Reminders
- **fix:** CLAUDE.md template now explicitly instructs agents that `schedule_value` for `once` tasks is LOCAL time (no `Z` suffix). Previously agents would store UTC values without `Z`, causing `new Date()` to interpret them as local time — reminders fired 3 hours late in GMT-3 zones.
- **fix:** Clarified `scheduled_at` (taskflow_create DB field, stored as UTC with `Z`) vs `schedule_value` (schedule_task IPC, interpreted as local time without `Z`).

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
