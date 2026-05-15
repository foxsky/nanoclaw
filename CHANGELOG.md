# Changelog

All notable changes to NanoClaw will be documented in this file.

For detailed release notes, see the [full changelog on the documentation site](https://docs.nanoclaw.dev/changelog).

## [Unreleased]

- Fixed Taskflow child-board reassignment parity for parent-board task IDs: `api_reassign` now reports that an ancestor-owned, non-delegated task must be reassigned from the owning parent board instead of asking to register the target person on the local child board.
- Fixed Taskflow child-board reads for parent-board projects: `api_query({ query: "find_task_in_organization" })` now includes parent subtasks delegated to the current board and local tasks linked to that parent project, allowing v2 to answer child-board `P11`-style project lookups with the relevant execution stages instead of only the parent project header.
- Fixed production-snapshot Taskflow Phase 3 replay for boards whose local fixture folder differs from the historical production board folder. Generated production WhatsApp corpora now carry the resolved Taskflow board id, the replay driver forwards it as a replay-only override, and the comparator no longer misclassifies board/project section reports as mutations just because they list completed tasks.
- Added a Phase 3 replay exclusivity guard so paid validation runs fail fast when the background `nanoclaw` host service is active against the same session DB, preventing duplicate containers and contaminated outbound/tool traces.
- Added a production WhatsApp message-corpus extractor for Taskflow Phase 3 coverage expansion. It clones `messages.db`-style agent turns into board-specific semantic replay candidates, preserves observed v1 outbound text, and attaches the matching Taskflow DB snapshot for per-turn restore while explicitly marking that these cases do not include v1 tool-use traces.
- Fixed Laizys/SEAF Taskflow Phase 3 exact-ID note handling: board-prefixed delegated IDs such as `SEC-T41` are preserved through MCP note mutations, and missing exact-ID note updates such as `T1- ...` now ask for confirmation instead of mutating a guessed search candidate.
- Added Laizys/SEAF Phase 3 metadata classification so archived replays can distinguish true v2 behavior bugs from unavailable historical DB snapshots, allocation drift, read-only grounding, and exact-ID confirmation gaps.
- Fixed Taskflow compound-name shorthand resolution so unique non-first tokens such as "Beatriz" can resolve to "Ana Beatriz" for assignees, meeting participants, and named outbound destinations, while ambiguous tokens such as "Silva" now ask with concrete matching options.
- Added non-SECI Phase 3 replay support by parameterizing the Phase 2/3 replay target and adding SETD-SECTI context-chain metadata.
- Fixed SETD Phase 3 ready-for-review updates so delegated parent-board task messages such as "T18 - DFD pronto..." use MCP mutations (`api_update_task` + `api_move`) instead of sending a false confirmation without changing Taskflow state.
- Fixed remaining Taskflow Phase 3 context-chain meeting-forwarding gaps: v2 now deterministically creates dated meetings, adds participants to the latest meeting, forwards "meeting above" notifications using MCP-backed Taskflow state, and accepts recurring meeting-forward confirmations without relying on raw sqlite or slow model exploration.
- Added Taskflow person notification destination backfill from `board_people.notification_group_jid`, preserving v1 raw-JID forwarding behavior through v2 named destinations instead of re-enabling sqlite/JID sends.
- Fixed deterministic Taskflow forwarding for "send message with details" and "ask person to prioritize task" wording, so v2 uses `api_query` plus named-destination `send_message` without model-driven over-searching.
- Fixed Taskflow bulk approval commands such as "aprovar todas as atividades de Nome" so v2 deterministically checks that person's review queue, bulk-approves matching tasks when present, and immediately replies when the current DB has nothing to approve instead of stalling or doing read-only clarification.
- Added first-class Taskflow project-summary reads (`projects`, `project_next_actions`, and `projects_detailed`) so v2 can answer project list, per-project next-action, and detailed project/activity/note report requests with one `api_query` instead of fanning out through dozens of per-project lookups.
- Added a Taskflow full-history replay coverage audit that compares a validated migration corpus against all extracted historical WhatsApp turns, reports uncovered behavior signatures, and emits the next coverage-oriented replay candidate set without running a paid agent replay.
- Fixed Phase 3 custom-corpus replay plumbing so `phase3-driver.ts --corpus` is forwarded into the underlying Phase 2 driver instead of silently replaying the original SECI 30-turn corpus, and scoped the original corpus's default chain-mode turn indexes so generated corpuses stay fresh unless metadata says otherwise.
- Fixed meeting creation parity when a typed participant is not registered: `api_create_meeting_task` now creates the meeting with registered participants, returns `unresolved_participants` plus a registration/external-participant prompt, and avoids causing the agent to fall back to a plain task.
- Fixed a Taskflow coverage-replay no-outbound case by adding explicit formatted output to empty `api_query({ query: 'person_review' })` responses, so bulk approval commands for a person with no current review tasks terminate with a clear answer instead of stalling.
- Added bulk `task_ids` support and formatted confirmations to `api_move`, plus Taskflow template guidance for v1-style "aprovar todas as tarefas/atividades de Nome" commands. This replaces multi-call approval loops with one MCP mutation and prevents read-only "approved" hallucinations.
- Completed the Taskflow Phase 3 compliance closure for the SECI 30-turn migration corpus: v2 now preserves v1-style contextual project hints on standalone activity clarification turns, handles person-review reads deterministically through the MCP-backed `api_query` path, and validates reconstructed pre-turn DB snapshots for the former state-drift cases. The final combined Phase 3 evidence is 29 semantic matches plus one intentionally flagged v1 bug requiring human signoff rather than bug-for-bug reproduction.
- Fixed routing and delivery regressions in channel approval and outbound handling: approved non-threaded groups now keep group/mention engagement, direct denial replies write through a writable outbound DB handle, accumulated context-only follow-ups no longer wake active agent queries, and missing channel adapters now go through delivery retry/failure handling instead of being silently marked delivered.
- Tightened Taskflow Phase 3 compliance comparison so v2 tool/action parity no longer passes when v1 produced a user-visible reply but v2 timed out without outbound output; these cases are now classified as `no_outbound_timeout`.
- Added a Taskflow replay delivery safety fallback: bare final text from an agent is routed to the sole configured destination when exactly one destination exists, while multi-destination sessions still require explicit `<message to="...">` routing.
- Added Taskflow v1-bug audit support through `audit_v1_bugs`, including engine/MCP coverage and template guidance for scheduled daily audits of same-task, same-user self-correction patterns.

## [2.0.48] - 2026-05-09

- **Container config moved to DB.** Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, skills) now lives in the `container_configs` table instead of `groups/<folder>/container.json`. Existing filesystem configs are backfilled automatically on startup. Managed via `ncl groups config get/update` and `config add-mcp-server/remove-mcp-server/add-package/remove-package`.
- **Explicit restart with on-wake messages.** Config CLI operations no longer auto-kill containers. New `ncl groups restart` command with `--rebuild` and `--message` flags. On-wake messages (`on_wake` column on `messages_in`) are only picked up by a fresh container's first poll, preventing dying containers from stealing them during the SIGTERM grace period. Self-mod approval handlers (`install_packages`, `add_mcp_server`) use the same race-free mechanism.
- **Per-group CLI scope.** New `cli_scope` setting on container config (`disabled` / `group` / `global`, default `group`). Controls what the agent can access via `ncl` from inside the container. `disabled` excludes CLI instructions from CLAUDE.md and blocks all requests. `group` (default) restricts to own-group resources with auto-filled args. `global` gives unrestricted access (set automatically for owner agent groups). Includes post-handler result filtering to prevent cross-group data leaks and blocks `cli_scope` escalation from group-scoped agents.

## [2.0.45] - 2026-05-08

- **Admin CLI (`ncl`).** New `ncl` command for querying and modifying the central DB — agent groups, messaging groups, wirings, users, roles, members, destinations, sessions, approvals, and dropped messages. Host-side transport via Unix socket; container-side transport via session DB. Write operations from inside containers go through the approval flow. `list` supports column filtering and `--limit`. Run `ncl help` for usage.
- **v1 → v2 migration.** Run `bash migrate-v2.sh` from the v2 checkout. Finds your v1 install (sibling directory or `NANOCLAW_V1_PATH`), merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders (`CLAUDE.md` → `CLAUDE.local.md`), copies session data with conversation continuity, ports scheduled tasks, interactively selects and installs channels (clack multiselect), copies container skills, builds the agent container, and offers a service switchover to test. Hands off to Claude (`/migrate-from-v1`) for owner seeding, access policy, CLAUDE.md cleanup, and fork customization porting. See [docs/migration-dev.md](docs/migration-dev.md) and [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md).

## [2.0.0] - 2026-04-22

Major version. NanoClaw v2 is a substantial architectural rewrite. Existing forks should run `/migrate-nanoclaw` (clean-base replay of customizations) or `/update-nanoclaw` (selective cherry-pick) before resuming work.

- [BREAKING] **New entity model.** Users, roles (owner/admin), messaging groups, and agent groups are now tracked as separate entities, wired via `messaging_group_agents`. Privilege is user-level instead of channel-level, so the old "main channel = admin" concept is retired. See [docs/architecture.md](docs/architecture.md) and [docs/isolation-model.md](docs/isolation-model.md).
- [BREAKING] **Two-DB session split.** Each session now has `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) with exactly one writer each. Replaces the single shared session DB and eliminates cross-mount SQLite contention. See [docs/db-session.md](docs/db-session.md).
- [BREAKING] **Install flow replaced.** `bash nanoclaw.sh` is the new default: a scripted installer that hands off to Claude Code for error recovery and guided decisions. The `/setup` Claude-guided skill still works as an alternative.
- [BREAKING] **Channels moved to the `channels` branch.** Trunk no longer ships Discord, Slack, Telegram, WhatsApp, iMessage, Teams, Linear, GitHub, WeChat, Matrix, Google Chat, Webex, Resend, or WhatsApp Cloud. Install them per fork via `/add-<channel>` skills, which copy from the `channels` branch. `/update-nanoclaw` will re-install the channels your fork had.
- [BREAKING] **Alternative providers moved to the `providers` branch.** OpenCode, Codex, and Ollama install via `/add-opencode`, `/add-codex`, `/add-ollama-provider`. Claude remains the default provider baked into trunk.
- [BREAKING] **Three-level channel isolation.** Wire channels to their own agent (separate agent groups), share an agent with independent conversations (`session_mode: 'shared'`), or merge channels into one shared session (`session_mode: 'agent-shared'`). Chosen per channel via `/manage-channels`.
- [BREAKING] **Apple Container removed from default setup.** Still available as an opt-in via `/convert-to-apple-container`.
- **Shared-source agent-runner.** Per-group `agent-runner-src/` overlays are gone; all groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments).
- **Agent-runner runtime moved from Node to Bun.** Container image is self-contained; no host-side impact. Host remains on Node + pnpm.
- **OneCLI Agent Vault is the sole credential path.** Containers never receive raw API keys; credentials are injected at request time.

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
