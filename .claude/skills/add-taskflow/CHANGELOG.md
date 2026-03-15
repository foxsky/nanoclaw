# TaskFlow Skill Package Changelog

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
