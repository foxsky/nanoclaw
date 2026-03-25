# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

### Evening Digest — No-Stress Mode
- **feat:** Evening digest stripped of operational pressure — no pendências, overdue, stale, or priority suggestions. Keep only compact board summary, celebrations, momentum, and upcoming meetings. Operational pressure stays in the morning standup.
- **fix:** Removed duplicate overdue footer from board view — tasks already marked with ⚠️ in their column sections
- **fix:** Inject current date/day-of-week into all scheduled task prompts — prevents agent from using stale session context (e.g., "weekend is coming" on a Monday)
- **fix:** Stabilized flaky weekly trend test — day-of-week-dependent date computation replaced with deterministic ISO week arithmetic
- **fix:** CLAUDE.md regenerated for all 12 active boards after template updates

### Upstream Merge (1.2.21 → deee4b2)
- Docker stop timeout fix (`-t 1`) for faster container restarts
- Task snapshot refresh after IPC mutations (`onTasksChanged`)
- Security: stop logging user prompt content on container errors
- Remote control stdin fix for service restarts
- ESLint config with error-handling rules
- New skills: Claw CLI, Slack formatting, capabilities/status
- Opt-in diagnostics via PostHog (setup/update only)
- `cleanupOrphans` uses individual stops with `-t 1` (aligned with `stopContainer`)
- Removed duplicate `openai` dependency in package.json

### Board Provisioning
- **fix:** Seed `available_groups.json` during board provisioning — newly provisioned boards were missing this file until their first agent invocation, causing container warnings
- **fix:** Fix `fixOwnership` on child board provisioning to include `data/ipc/{folder}` (root board already did this)
- **refactor:** Extract `seedAvailableGroupsJson()` shared helper in `provision-shared.ts` — used by both root and child board provisioners

### Board View Fixes
- **fix:** Empty summary for 3+ tasks — shows "N tarefa(s)" when nothing notable (no overdue/dates/meetings/projects)
- **fix:** `__none__` display name replaced with board owner name for unassigned tasks

### Data Fixes (production, 2026-03-25)
- Assigned 28 unassigned tasks to board owner (were showing as `__none__`)
- Deleted 11 test/heartbeat tasks from sec-secti board
- Added Mauro Cesar, Lucas Batista, Reginaldo Graça to sec-secti board_people
- Recreated accidentally deleted T-002, T-004

### Container Agent
- **fix:** Skip schema migrations when TaskflowEngine is opened readonly — context preamble was failing with `SqliteError: attempt to write a readonly database` on new boards
- **fix:** Pass `{ readonly: true }` to TaskflowEngine in context preamble builder to match the readonly DB connection

### UX Improvements
- **feat:** Compact board header for digest/weekly reports — column counts instead of full board, cutting message length ~50%
- **feat:** Smart board view — summaries for 3+ tasks per person, details for fewer; board owner always listed first
- **feat:** Motivational message sent as separate message after every digest/weekly — celebration line + warm human summary
- **feat:** Person briefing for 1:1 meetings — "Tarefas do Rafael" returns a structured dispatch view grouped by urgency, with projects expanded
- **feat:** Stale task summaries in digest/weekly — per-person counts instead of listing each task when 3+
- **feat:** Subtasks always show parent project context (e.g., `📁 P24 — Agência INOVATHE / P24.1 — Criação da Agência`)
- **style:** Unified notification layout — all move, rejection, and parent board notifications use consistent format
- **style:** Single separator line after title in confirmations; removed double separators
- **style:** Removed redundant actor name from task moved confirmations

### Direct Transitions
- **feat:** Tasks can move directly to target column without intermediate steps — `wait` from inbox/next_action, `review` from inbox/next_action/waiting, `return` from waiting/review
- **fix:** `waiting_for` cleared when returning task from waiting column (was leaving stale data)

### Container Reliability
- **fix:** Don't preempt busy containers — scheduled tasks wait for idle before closing; prevents data loss where confirmations were sent but DB writes never persisted
- **fix:** Task starvation safeguard — 2-minute timeout forces close if container never goes idle
- **fix:** Clear `pendingClose` on container exit to prevent stale close requests leaking to next run
- **fix:** Extracted `cleanupRun` helper for consistent container state cleanup

### Board Provisioning — Cross-Board Person Matching
- **fix:** Reuse existing child board when person already has one under a different parent — prevents duplicate WhatsApp groups and boards
- **fix:** Phone-based fuzzy matching (digits only, 8+ chars) when person_id doesn't match across branches
- **fix:** Automatic person_id unification in transaction — updates board_people, tasks, board_admins
- **fix:** Hardened per Codex review: PK collision handling, `board_admins` delete-then-insert, dot stripping in phone SQL

### WhatsApp
- **fix:** Verify group participants by count first, not just JID matching — fixes false "missing participant" from LID JID mismatch that caused unnecessary invite links on every group creation
- **fix:** 2-second delay before verification + enriched JID matching with `p.phoneNumber`/`p.lid` from metadata
- **feat:** Forwardable invite message for external meeting participants — includes organizer name and meeting details, ready for manager to forward
- **fix:** Honest external invite status — agent no longer claims "convites enviados" when invites are actually pending (contact hasn't messaged the bot)

### Template & Formatting
- **style:** Always include task title when referencing by ID (e.g., `P24.1 — Criação da Agência`, not just `P24.1`)
- **style:** Subtask display shows parent project first, subtask indented below

### Code Quality
- **refactor:** Extracted `fetchActiveTasks` shared helper — eliminates duplicated task-fetching/orphan-promotion logic
- **refactor:** Hoisted SEP separator to class-level constant
- **refactor:** Extracted `renderStaleTasks` helper for digest/weekly stale summarization
- **fix:** Fixed 17 pre-existing test failures — Portuguese localization + behavioral changes (inbox auto-assign, WIP on reassignment)
- **test:** Added 15 new tests — compact board, direct transitions, regression guards, starvation timer, drain lifecycle

### Data Fixes (production)
- Fixed sec-secti board crash loop — cleared corrupted session, restored service
- Fixed Giovanni's board: T14 concluded, T3/T13/T15 moved to waiting with notes/due dates, T20/T21/T24 recreated with notes
- Fixed Rafael's board: T50 moved to in_progress, P16.1 next_action updated
- Sent overdue confirmations to Alexandre for T-006/T31/T46

- **fix:** Require approval by default before delegated assignees can close tasks; delegated `conclude` now moves to `review` instead of `done`
- **fix:** Suppress duplicate parent-board notifications when creator and parent notification targets resolve to the same group
- **fix:** Self-heal stale TaskFlow `board_id_counters` during task creation so `taskflow_create` can recover from counter drift without SQLite write fallbacks
- **fix:** Harden custom trigger bot-message detection and external DM routing safety
- **feat:** Add TaskFlow schema support for external meeting participants
- **feat:** BGE-M3 embedding service via Ollama — generic host service + container reader for semantic indexing
- **feat:** TaskFlow embeddings integration — semantic search, duplicate detection (0.85 threshold), context preamble injection
- **fix:** Inbox processing promotes tasks in-place via `taskflow_reassign` instead of create-new + cancel-original
- **fix:** Implicit inbox promotion — auto-assign to board owner when user reports progress on unassigned inbox task
- **fix:** 61+ bugs fixed across 14 files (3 rounds of 20 subagents)
- **fix:** WhatsApp group plugin — 7 bugs from 37-bug audit (null guard, participant cap, LID verify, stale socket, JID normalization, droppedParticipants tracking, re-verify catch)
- **fix:** WhatsApp message queue re-queues on send failure instead of losing messages
- **fix:** WhatsApp LID translation for group message senders with `participantAlt` fallback
- **fix:** Sender allowlist device suffix normalization (`:N@s.whatsapp.net` → `@s.whatsapp.net`)
- **feat:** Hierarchical long-term context skill — DAG summarization, FTS5 search, incremental byte-offset cursor, conversation recap preamble, context_search/recall MCP tools
- **fix:** Cron idempotency guard — `cronSlotAlreadyRan()` prevents re-execution on process restart
- **fix:** IPC transient error retry (5 attempts) + error directory eviction (7 days / 1000 files cap)
- **fix:** 18 bugs fixed across 4 rounds of 20 subagents — subtask ID collision, counter seeding regression, WhatsApp reconnection race, DM duplicate delivery, FTS5 MATCH injection, Docker option injection, cleanupOrphans command injection, SDK errors as success, stripInternalTags regex, embedding indexer re-entrancy, DM routing WAL mismatch, delegated task duplication, group name dedup, shutdown retry timer leak, monthly rollup orphans, NFD Unicode in topics, scheduler infinite loop, outputChain hang

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
