# Changelog

All notable changes to NanoClaw will be documented in this file.

For detailed release notes, see the [full changelog on the documentation site](https://docs.nanoclaw.dev/changelog).

## [1.2.47] - 2026-04-03

### Upstream Merge (1.2.46 → 1.2.47)
- Mount `store/` read-write for main agent — direct SQLite DB access from the main container
- Shadow `.env` in main container mount (security: credentials via proxy only)
- `requiresTrigger` param added to `register_group` MCP tool (was host-IPC only)
- Breaking change detection relaxed to match `[BREAKING]` anywhere in changelog lines

## [1.2.46] - 2026-04-02

### Upstream Merge (1.2.45 → 1.2.46)
- Reply/quoted message context: messages now store `reply_to_message_id`, `reply_to_message_content`, `reply_to_sender_name` — DB migration adds 3 columns, `formatMessages` renders `<quoted_message>` XML when a message is a reply
- `getNewMessages` gains subquery pagination with configurable `limit` (default 200)
- `formatMessages` now uses `formatLocalTime` with configured timezone (America/Fortaleza) instead of raw ISO timestamps
- Code of Conduct added upstream

## [1.2.45] - 2026-04-01

### Upstream (1.2.43 → 1.2.45)
- Prettier/ESLint formatting on `src/` and `container/agent-runner/src/` (no logic changes)

### Queue Priority + Concurrency
- User messages now drain before scheduled tasks in the group queue — prevents 2h+ delays when scheduled task backlog fills all container slots after a restart
- `MAX_CONCURRENT_CONTAINERS` raised from 5 to 12 — accommodates all TaskFlow boards firing simultaneously while staying within 8 GB RAM bounds

### Auditor Improvements
- Parent board mutation check: `task_history` query now checks both child and parent board IDs — eliminates false `unfulfilledWrite` flags for delegated task operations (ASSE-SECI, Ana Beatriz boards)
- Web origin filter: messages from `web:` prefix senders (QA/test) skipped in auditor — eliminates SEC-SECTI test noise
- Command synonyms: added "consolidar", "atividades", "cancelar" to template

### Schedule Alignment
- Aligned all 18 boards to same BRT times: 08:00 standup, 18:00 digest, 14:00 Friday review (newer boards were 3h late)
- Staggered bursts across 6-minute windows (6 boards at :00, :03, :06) to prevent API rate limit exhaustion
- Fixed `board_runtime_config` source data (19 rows) — new child boards now inherit correct times from provisioning

### Anti-Hallucination Safeguards (refined)
- Post-write verification moved outside `db.transaction()` — now verifies after commit, not inside the transaction where it was dead code (better-sqlite3 guarantees visibility within synchronous transactions)

## [1.2.43] - 2026-03-31

### Upstream (1.2.42 → 1.2.43)
- Stale session auto-recovery: detects `no conversation found|ENOENT|session.*not found` errors and clears broken session IDs so the next retry starts fresh
- npm audit fixes (dependency updates)

### TaskFlow Web Channel
- `send_board_chat` MCP tool: agents can write messages to `board_chat` table for web UI consumption
- `NANOCLAW_ASSISTANT_NAME` env var injected into containers for agent self-identification
- Web origin trigger bypass: messages with `web:` sender prefix skip `requiresTrigger` check
- Web origin output routing: agent responses routed to `board_chat` table instead of WhatsApp for web-originated messages, with WhatsApp fallback on error

### Scheduled Task Prompt Simplification
- Replaced verbose inline prompts for standup/digest/weekly with bare tags (`[TF-STANDUP]`, `[TF-DIGEST]`, `[TF-REVIEW]`)
- Added "Scheduled Task Tags" section to CLAUDE.md template mapping tags to their instruction sections
- Single source of truth: all report behavior defined in the template, not duplicated in 55 DB prompts
- **Before:** agents queried raw SQL and dumped every task → wall of stress on large boards
- **After:** agents call `taskflow_report()` → engine-formatted concise digest with counts, top items, and 3 actionable suggestions

### Anti-Hallucination Safeguards
- **Engine-level post-write verification:** `createTaskInternal()` now SELECT-verifies the inserted row before returning `success: true` — if the INSERT was rolled back or lost, the tool returns `success: false` instead of silently lying
- Template: never display task details from memory — always query DB first (prevents hallucinated task info persisting through session resume)
- Template: post-write verification — agents must check tool response for `success: true` before confirming to user
- Bare task ID mapping: "TXXX" triggers `task_details` query automatically

### Auditor Fix
- Fixed auditor `chat_jid` mismatch: task pointed to old group JID (`120363408855255405@g.us`) instead of registered main channel (`558699916064@s.whatsapp.net`) — reports were sent to a non-existent group and silently lost

### Production Incident (2026-03-30)
- **Root cause:** null dereference in agent-runner `scriptResult.data` (committed in previous session) caused TypeScript strict mode (`TS18047`) to reject compilation inside every container
- **Impact:** all 12 boards down from ~08:00 to 08:15 BRT — zero morning standups delivered, user messages unanswered
- **Resolution:** deployed the `else` block fix, manually re-triggered 18 standup tasks by clearing `last_run` (the `cronSlotAlreadyRan` idempotency guard was blocking re-runs)
- **Lesson:** deploy script should validate container-side TypeScript compilation, not just host-side `tsc`

### WhatsApp Reconnection Resilience
- Reconnect loop now retries indefinitely (exponential backoff 5s→60s, then 2-min intervals) instead of giving up after 5 attempts
- Added 2-minute health check watchdog: detects silently dead connections and triggers recovery
- Stored health check timer handle to prevent duplicate intervals

### Fix: TaskFlow groups silently re-requiring trigger
- MCP `register_group` tool now passes `requiresTrigger` (defaults to `false` for TaskFlow groups)
- `setRegisteredGroup` preserves existing `requires_trigger` value when the field is undefined, instead of resetting to `1` via `INSERT OR REPLACE`
- Root cause: any agent re-registering a group would silently flip `requires_trigger` back to `1` because the MCP tool omitted the field

## [1.2.41] - 2026-03-27

### Upstream (1.2.35 → 1.2.41)
- Replace pino with built-in logger
- Prevent message history overflow via `MAX_MESSAGES_PER_PROMPT`
- `stopContainer` uses `execFileSync` (no shell injection)
- Preserve `isMain` on IPC updates
- Fix single-char `.env` crash
- Remove unused deps (yaml, zod, pino, pino-pretty)
- Ollama skill: opt-in model management tools

### WhatsApp Reconnection Fix
- Fixed reconnection deadlock: `connectInternal()` now awaits `connection='open'` before returning, preventing the reconnect loop from exiting prematurely (8h production outage)
- Fixed half-dead socket stall: `sendMessage()` transport failures now trigger reconnection (filtered to avoid false reconnects on application errors)
- Initial connect retries with backoff on transient startup failures
- LoggedOut (401) during reconnect exits immediately
- 30s timeout on `connectInternal()` — prevents reconnect loop from hanging forever on silent socket failures
- Outgoing message queue persisted to disk — survives process restarts (29 messages lost in Mar 27 incident)

### Image Vision
- Wired end-to-end: WhatsApp image download → sharp resize → base64 → Claude multimodal content blocks
- Handles wrapped images (viewOnceMessageV2, ephemeralMessage)

### Logger Baileys Compatibility
- Added `level`, `child()`, `trace()` to built-in logger for Baileys `ILogger` interface — prevents runtime crash after pino removal

### TaskFlow Isolation
- Moved `getGroupSenderName()` from `config.ts` to `src/group-sender.ts`
- Moved `resolveTaskflowBoardId()` from `container-runner.ts` to `src/taskflow-db.ts`
- Reduces upstream merge conflicts — TaskFlow code no longer modifies core upstream files

### TaskFlow Features
- `reparent_task`: move standalone tasks under existing projects as subtasks (preserves all metadata, undoable)
- `detach_task`: detach subtasks from projects back to standalone (preserves all metadata, undoable)
- Subtask individual deadlines: agents can now set `due_date` on subtasks independently of the parent project
- Fixed duplicate cross-board notifications when assignee is on the parent board
- Template: save notes before completing tasks, multi-assignee guidance, task splitting pattern, archive fallback on "Task not found", enforce reparent over copy+cancel, always confirm write operations in sender's group, link child board projects to parent tasks, delegated tasks fully operable from child boards, "consolidado" synonym, contextual task inference

### Child Board Cross-Board Operations Fix
- Child boards can now modify delegated parent board tasks (move, update, add subtasks, complete)
- Root cause: template led agents to infer a blanket "can't modify parent board" restriction that doesn't exist in the engine
- Caused all CI-SECI (Mauro) failures: 7 missing subtasks, 2 missed renames, 1 missing subtask

### Data Corrections (interaction review)
- SECI: 65 task histories migrated from old T-ids to P-subtask ids after copy+cancel migration
- SECI: P1.4 assignee fixed (lucas), P1.2 assignee fixed (ana-beatriz), P1.10/P20.4 deadlines set
- SECI: P1 (Laizys) linked back to T41 via tag_parent
- TEC: T1 approved (stuck in review 7 days)
- SEC: T80 completed (Thiago's request from Mar 25)
- Thiago: T15 note added ("enviado ao João os nomes")
- Mauro: 7 P2 subtasks created, P3.4 created, P11 renamed "Estratégia", P13 renamed "Ecossistema de Inovação"
- Lucas: T1/T2 orphans archived, P5.5 created for ReadyTI February payment

### Cross-Board Project Rollup
- `refresh_rollup` now counts subtasks of tagged projects, not just directly-tagged tasks
- Auto-triggers rollup from `move()`, `cancel_task`, and `restore_task` when any task with an upward link changes status
- Parent board sees real-time progress of child board project subtasks
- Extracted shared `computeAndApplyRollup` helper — eliminates 80 lines of duplication
- Change-detection guard prevents history spam on no-op rollups
- Added indexes on `linked_parent_board_id`/`linked_parent_task_id` for query performance

### Daily Interaction Auditor
- Automated daily review of all board interactions at 04:00 BRT
- Script phase gathers data from both DBs (messages + TaskFlow) inside container
- AI phase analyzes findings: unfulfilled requests, delays, refusals, template gaps, missing features
- Zero AI cost on clean days (`wakeAgent: false`)
- Detects delayed responses (>5min), agent refusals, write requests without DB mutations
- Weekend catch-up: Monday reviews Fri+Sat+Sun

### Infrastructure
- New `scripts/deploy.sh` with pre-flight import verification on local and production
- Fixed `ContainerInput.script` type (was missing, broke all container agents)
- Fixed `is_main` mapping: added to schema, migration, `getAllRegisteredGroups`, and `setRegisteredGroup`
- Fixed scheduler `isMain` resolution: uses `group.isMain` DB flag instead of folder string comparison
- Fixed null dereference in agent-runner when script errors: prompt enrichment now guarded by `else` block
- Context summarizer switched to `qwen3.5:cloud` primary with `qwen3-coder:latest` fallback

### Post-Merge Test Fixes
- Fixed OneCLI null-safety, TaskFlow test paths, ISO date assertions, English→Portuguese strings
- 899 tests passing across 40 test files

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
