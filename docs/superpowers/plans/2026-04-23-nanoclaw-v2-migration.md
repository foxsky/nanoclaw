# NanoClaw v2 Migration Plan (v2.2 — Codex feature-evaluation update)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. At every phase gate, pause for user sign-off before proceeding.

**Revision history:**
- v1 (2026-04-23 first draft) — superseded. Three-agent review + Codex gpt-5.5/xhigh validation found ~30 concrete bugs and multiple strategy errors. See git history for v1.
- v2 (2026-04-23 rewrite) — corrects file counts, command syntax, adds Phase -1 infra prep, rewrites Phase 5 cutover model (Baileys auth prohibits per-group shadow), extends timeline to 12-16 weeks, adds strategic decision section.
- v2.1 (2026-04-30 delta re-review) — folds in `v2.0.10 → v2.0.21` upstream changes. Adds Phase -1.5 security back-port, expands Phase 0 (circuit breaker + native-proxy re-merge), Phase 2 (channel-approval surface), Phase 3 (schedule_task content JSON routing, `namespacedPlatformId()` rule, register field-name regression). Codex-corrected delta numbers (183 commits, 76 files, +4632/-576 LOC).
- v2.2 (2026-04-30 features evaluation) — Codex gpt-5.5/high independent evaluation of v2 features for our skills surfaced **9 missed feature areas** (sender-approval, channel-approval, ask_user_question/pending_questions, scheduling improvements, unregistered_senders audit, named destinations as outbound ACL, self-mod, mount allowlist, new upstream skills). Adds **Phase 2.5: TaskFlow Permissions Adoption** (Weeks 5-6, between WhatsApp re-port and isMain rewrite) — re-prioritized as Codex's #1 recommendation. Downscopes cross-board a2a to "visible-text MVP" reusing existing `subtask_requests` + `handle_subtask_approval`. Net timeline: 14-18 weeks full-time.

---

**Goal:** Migrate our fork from `nanoclaw@1.2.53` to upstream `v2.x` (currently `2.0.21`; 577 commits behind / 886 ahead at last fetch 2026-04-30) with **zero TaskFlow data loss**, a tested rollback recipe validated before production cutover, and minimal service disruption to 31 live government IT TaskFlow groups.

**Architecture:** Parallel-worktree development, fleet-level cutover. Reuse upstream's `migrate/v1-to-v2` driver for platform-schema migration; preserve `data/taskflow/taskflow.db` verbatim; mechanically port `container/agent-runner/` from Node+better-sqlite3 to Bun+bun:sqlite; re-port TaskFlow WhatsApp hooks against the v2-native adapter; install `use-native-credential-proxy` skill to avoid OneCLI adoption; add a TaskFlow sidecar table for custom columns that have no v2 equivalent. **Per-group 24h shadow is NOT used** — Baileys auth is shared state, so two processes cannot hold the same WhatsApp identity. Cutover is fleet-level with a tested 15-minute rollback SLA.

**Tech Stack:** Bun 1.3.x (container), Node + pnpm@10.33.0 (host), SQLite (`bun:sqlite` container / `better-sqlite3` host), Anthropic Agent SDK 0.2.116, bash heredocs for audit scripts, Docker + Proxmox VM orchestration.

**Source-grounded facts:** See `/root/.claude/projects/-root-nanoclaw/memory/project_v2_migration_assessment.md` for citation-grounded state. If any fact in this plan conflicts with upstream code at execution time, STOP and reconcile before proceeding.

---

## Strategic decisions (resolved in this rewrite)

1. **Cutover model: fleet-level, not per-group.** Baileys' `useMultiFileAuthState` (src/channels/whatsapp.ts:173) uses a single shared auth directory; two processes racing on it corrupt Signal keys. Per-group 24h shadow from v1 is physically impossible with a single WhatsApp identity. **Decision:** use Phase 4 test-group shadow (on dedicated `test-taskflow`/`e2e-taskflow` with separate auth) as the sole pre-cutover validation; cut all 28 prod groups over in a scheduled window with a tested 15-minute rollback SLA. If later we adopt a second WhatsApp number for prod-shadow, that's a follow-up project, not a phase-0 blocker.

2. **IPC stays file-based.** Codex verified v2 still supports `.heartbeat` + `outbox/` file channels (`src/session-manager.ts:59-62`; `host-sweep.ts:5-8`). Our 9 `src/ipc-plugins/*.ts` stay as-is. Rewriting them as `messages_out` system-action MCP tools is deferred to a post-cutover project.

3. **OneCLI NOT adopted.** `use-native-credential-proxy` skill handles the escape (`upstream/skill/native-credential-proxy`). Our `project_onecli_decision.md` survives v2 with minor work.

4. **TaskFlow DB preserved.** `data/taskflow/taskflow.db` is fully orthogonal to v2 platform schema. Migrator leaves `data/` untouched. Our 4 TaskFlow-custom columns on `registered_groups` (`taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth`, `is_main`) move to a new `taskflow_groups` sidecar table keyed on `messaging_groups.id`.

5. **`outbound_messages` durable queue preserved as fork-private.** Our 2026-04-14 SIGKILL-resilience fix (`src/db.ts:151`) has no v2 equivalent. Keep it as a fork-private table alongside v2's `messages_out`.

6. **Personal WhatsApp (Baileys), not WhatsApp Cloud.** Confirmed at `src/channels/whatsapp.ts`. `upstream/channels` v2-native adapter has the same assumption. Phase 2 verifies this before re-porting hooks.

7. **Timeline: 12-16 weeks full-time, 6+ months part-time.** Each phase has explicit pause-points. Do not attempt to compress.

---

## v2.0.21 delta re-review (2026-04-30, Codex-corrected)

Fold-in of upstream changes since `v2.0.10` baseline (`git diff --shortstat 78b0ad68..upstream/main` = **183 commits, 76 files changed, ~4632 insertions / ~576 deletions**). **No new `[BREAKING]` items in CHANGELOG since 2.0.0** — architecture is stable, deltas are patches + features.

> Counts revised after Codex gpt-5.5/high read-only validation flagged the original v2.1 numbers as wrong. Initial v2.1 cited 576/72/3939/580; the actual `git diff --shortstat` against `v2.0.10` is the row above. Lesson: anchor stats to a real `git rev-list`/`shortstat`, never to commit-list scrolling.

| # | Delta | Affects | Phase |
|---|-------|---------|-------|
| 1 | OneCLI mandate tightened: `src/container-runner.ts:449-459` now `throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials')`. Was caught at L437-451 with "spawn continues with no credentials." | **Native-credential-proxy branch is bit-rotted against v2.0.21.** `git merge-tree` reports conflicts in `src/container-runner.ts`, `src/config.ts`, `src/container-runner.test.ts`, `setup/verify.ts`. The branch's `container-runner.ts` is structurally older and imports `credential-proxy.js`, not the v2 OneCLI path. The escape **concept** likely still works, but the branch needs repair before relying on it. Phase 0 Task 0.3 must repair + boot-test, not just re-merge. | Phase 0 Task 0.3 |
| 2 | `schedule_task` MCP tool now writes routing into **content JSON** (`platformId`, `channelType`, `threadId`) — not just row columns. Without it, host-sweep falls through to the "Routing recovery" retry prompt. (Commit `8dd004ca`, 2026-04-30.) | Our Kipp/digest/standup `scheduled_tasks` custom seeder must populate these three fields in content JSON. | Phase 3 Task 3.5 |
| 3 | New `src/platform-id.ts` exports `namespacedPlatformId(channel, raw)`: returns raw unchanged when (a) `raw` is **already prefixed** with `${channel}:` (idempotent fast-path), (b) raw contains `@` (WhatsApp/iMessage), (c) starts with `+` (Signal DM), or (d) starts with `group:` (Signal group). Chat-SDK adapters (Telegram/Discord/Slack/Teams) get prefix. | Our 31 boards are WhatsApp `@g.us` JIDs → skip prefix. The TaskFlow-groups seeder must route every JID through this rule and is idempotent because of (a). | Phase 3 Task 3.4 |
| 4 | `setup/register.ts` regression fix (`fc375ca7`): upstream itself just fixed `createMessagingGroupAgent` being called with **legacy field names**. | Our seeder copy-pasted from earlier upstream samples may inherit the broken fields. Diff against current upstream before running. | Phase 3 Task 3.4 |
| 5 | Channel-approval flow expanded — `git diff --numstat 78b0ad68..upstream/main -- src/modules/permissions/` shows **+439 / -98 net (+341)** across the module. Per-file: `channel-approval.ts` +163/-54 (net +109), `index.ts` +262/-38 (net +224). Earlier "+217" / "+300" were diffstat churn widths, not insertions. Feature: agent selection + free-text naming. | WhatsApp re-port wire-up surface bigger than v2 plan estimated, but smaller than the original "+600" estimate suggested. Phase 2 estimate bumped from 1-2 weeks to 2-3 weeks remains directionally correct. | Phase 2 Task 2.2 |
| 6 | Startup circuit breaker shipped (`2bf296b0` + `336e01d2` hardening). On by default. | Could block boots if any of our 31 boards trip init-time errors. Smoke-test on a single board before fleet cutover. | Phase -1 Task -1.6 (NEW) |
| 7 | `fix(claude-provider): respect operator-set CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`98898489`). | Our `=165000` setting is honored without patches. Strike the env-semantics worry from the SDK 0.2.111 audit. | Phase 3 Task 3.1 |
| 8 | **Security:** path traversal fixes in attachment handling — `7e37b13a` (channel-inbound), `6e5e568d` + `2a3be9ec` (agent-sent file names). New `src/attachment-safety.ts` module. **Primitive is `isSafeAttachmentName()`** (`src/attachment-safety.ts:18-22`): rejects names with path separators, `..` segments, NUL bytes, or empty basenames. **NOT an extension allowlist** — MIME/type mapping in `session-manager.ts:263-277, 375-383` only derives a fallback name when no explicit name exists. | Same bug class may exist in v1.2.53. Back-port the basename guard + MIME-derived fallback to our v1 fork **now**, independent of v2 migration. Don't describe it as an extension allowlist. | Phase -1.5 (NEW) |
| 9 | `add-signal-v2` skill folded back into `add-signal` (`b6be3b9b`). | Pattern signal: channel ports likely won't need separate v2-suffix branches. Lowers Phase 2 complexity slightly. **Caveat:** don't infer all channel ports will be this easy — Signal happened to have a clean fold-back, WhatsApp's customizations are deeper. | Phase 2 |
| 10 | **(REMOVED — Codex correction.)** Earlier draft cited `nc` CLI scaffold (`3a3d2ee6`) as part of v2.0.21. **Not on `upstream/main`**: `git merge-base --is-ancestor 3a3d2ee6 upstream/main` returns false; the commit lives on `upstream/nc-cli` only. No `bin/nc` or `src/cli/*` exists on main. | Out-of-scope until `nc-cli` branch is merged upstream. | n/a |
| 11 | **(NEW — Codex addition.)** Provider-selection precedence fix (`5845a5a9`): provider precedence is now `sessions.agent_provider → agent_groups.agent_provider → container.json → claude` (`src/container-runner.ts:184-204`). Per-provider continuation keying (`81ef193e`). | Material **only if our fork uses non-Claude providers** (Codex/OpenCode/Ollama at the agent level) or sets per-session/per-group provider overrides. Today our fork is Anthropic-SDK-only with Ollama used outside the agent (Kipp / semantic audit / extractor stack), so impact is low. Verify in Phase 0 that none of our `agent_groups` or `sessions` rows set `agent_provider`. | Phase 0 Task 0.6 (env+provider audit) |

### v2.2 additions — Codex feature evaluation (2026-04-30)

Items 12-20 surfaced by Codex gpt-5.5/high independent evaluation. These are **feature opportunities**, not migration risks — the migration plan still works without them, but adopting them during the migration is the highest-leverage path.

| # | Feature | Affects our skills | Phase |
|---|---------|--------------------|-------|
| 12 | **Unknown-sender approval** (`src/modules/permissions/sender-approval.ts`, migration 011, commit `622a3708`). Drops + logs messages from non-members; admin can approve and replay (or block permanently). | HIGH fit for 31 government boards. Replaces our current trigger-pattern-based gating. Admins get a structured approval flow for new members. | Phase 2.5 (NEW) |
| 13 | **Unknown-channel registration** (`src/modules/permissions/channel-approval.ts`, migration 012, commits `719f97e4` + `db198377`). Owner/admin approves a new DM/group → wires it to existing or new agent. | HIGH fit for controlled government onboarding. Today board provisioning is operator-driven; v2 lets admins request new channels via approval UI. | Phase 2.5 (NEW) |
| 14 | **`agent_destinations` is the outbound ACL for ALL sends** (channels and agents), not just a2a (`src/modules/agent-to-agent/db/agent-destinations.ts`, commit `e83ffbc1`). | HIGH fit. We treated this as a2a-specific. Actually controls every outbound `send_message` target — a unified permission map for board → board, board → admin DM, etc. | Phase 2.5 + Phase 6 (a2a-lite) |
| 15 | **`ask_user_question` + `pending_questions`** (`container/agent-runner/src/mcp-tools/interactive.ts`, `src/modules/interactive/index.ts`, commit `c31bb02c`). v2-native card-style approval primitive. | HIGH/MED fit. Replaces hypothetical `/aprovar abc123` text protocol in cross-board forwarding. Use for parent-admin approval prompts in Phase 6 a2a-lite. | Phase 6 (a2a-lite) |
| 16 | **Scheduling improvements**: `update_task` MCP tool, deduped `list_tasks`, timezone parsing, pre-agent `script` support (`container/agent-runner/src/mcp-tools/scheduling.ts`, `src/modules/scheduling/*`, commits `cdf18e60`, `dcfa12ea`, `8dd004ca`). | HIGH fit. Simplifies our Kipp/digest/standup runners. Today our `task-scheduler.ts` re-implements this; v2 has it natively. | Phase 3 Task 3.5 (incorporate before re-implementing fork-private) |
| 17 | **`unregistered_senders` audit table** (migration 008, commit `39d2af99`). Operations visibility into blocked/dropped people and channels. | HIGH fit for ops monitoring. Pairs with Item 12 — we get an audit trail of who tried to message which board and was rejected. | Phase 2.5 |
| 18 | **Self-mod container config** (`src/modules/self-mod/*`, `container/agent-runner/src/mcp-tools/self-mod.ts`, commits `75c2fde2`, `3b8240a9`). Agents can request `install_packages` / `add_mcp_server`; admin approval applies to `groups/<folder>/container.json`. | MED fit; **probably disable** for prod TaskFlow boards (low trust ceiling). May enable for a sandboxed dev board. | Out-of-scope for fleet; opt-in per-board |
| 19 | **Mount allowlist** at `~/.config/nanoclaw/mount-allowlist.json` + `additionalMounts` in container.json (`src/modules/mount-security/index.ts`, `src/container-config.ts`). | MED fit. Relevant when wiring `add-gmail-tool` / `add-gcal-tool` (need mount for OneCLI stub credentials at `~/.gmail-mcp/`, `~/.calendar-mcp/`). | Tier 2 follow-up (Phase 6 cleanup) |
| 20 | **New upstream skills** since 1.2.53: `add-gmail-tool`, `add-dashboard`, `add-atomic-chat-tool`, `manage-mounts`; container-side `frontend-engineer`, `self-customize`, `welcome`. Plus `init-first-agent` host skill. | MED fit. `add-gmail-tool` + `add-dashboard` worth piloting on one board post-cutover. Others board-local utilities. | Phase 6 cleanup or post-cutover |

**Codex priority headline** (executive summary verbatim): *"Your Tier 1 has the right themes but the wrong order for migration risk. I would put v2 permissions/approval/destination seeding first, TaskFlow prompt composition second, and a2a-lite third."*

**Drift trajectory:** ~25 upstream commits/day at this rate. By Phase 0 entry (~3-4 weeks out), upstream will be ~700 commits further along. **Recommendation:** pin the migration baseline to a specific upstream commit hash at Phase -1 entry; only re-merge upstream `main` between phases, with a delta re-review at each merge. Document the pinned hash in the Phase -1 sign-off.

---

## Critical file map (corrected from v1)

### Bun port — 17 container files + 16 src files (was wrongly stated as 15)

Container side (`container/agent-runner/src/`, all import `better-sqlite3`):
`taskflow-engine.ts`, `taskflow-mcp-server.ts`, `semantic-audit.ts`, `embedding-reader.ts`, `context-reader.ts`, `db-util.ts`, `ipc-mcp-stdio.ts`, `index.ts`, `auditor-script.sh` (heredoc), `digest-skip-script.sh` (heredoc), plus 6 `*.test.ts` files and `taskflow-embedding-integration.test.ts`. = 17 files.

Host side (`src/`, all import `better-sqlite3`): enumerate at execution time via `grep -l better-sqlite3 src/*.ts`. Count expected: 16 + `package.json`. Host keeps Node+better-sqlite3 — only the agent-runner moves to Bun. No host-side port needed for this dep.

### isMain privilege sites — 103 hits across 18 files (was wrongly stated as 5-10)

| File | Hits | Context |
|------|------|---------|
| `src/ipc.ts` | 28 | Entire IPC auth model |
| `src/container-runner.ts` | 13 | Mount/container wiring |
| `src/index.ts` | ~8 | Main message routing + scheduled triggers |
| `src/mount-security.ts` | 4 | Mount security gates |
| `src/task-scheduler.ts` | 3 | Scheduled-task execution auth |
| `src/session-commands.ts` | 1 | Session command handler |
| `src/config.ts` | 1 | `MAIN_GROUP_FOLDER` constant |
| `src/db.ts` | 2+ | `is_main` column schema + queries |
| `src/types.ts` | 1 | Core type definition |
| plus test files (~8) | ~40 | Test assertions on `isMain` |

Phase 3 Task 3.3 must enumerate every site from the grep, not rely on the v1 plan's list. Expect ~4 weeks of isMain rewriting, not 1.

### SQL call sites in `taskflow-engine.ts` — 579 (was wrongly stated as 30)

- 272 `prepare(...)` calls
- 110 `run(...)` calls
- 94 `get(...)` calls (plus 128 raw references to be audited)
- 69 `all(...)` calls
- 25 `exec(...)` calls
- 9 `transaction(...)()` calls

**Good news:** Codex confirmed NO named-parameter (`$name`) usage. Mechanical port is safe for all 579 sites.

### Dockerfile compile sites — 2 locations, both must change

- **Build time** at `container/Dockerfile:51`: `RUN npm run build` produces compiled JS.
- **Runtime** at `container/Dockerfile:59` (inside inline `RUN printf` entrypoint block): `npx tsc --outDir /tmp/dist` recompiles on every container start.

Both must be replaced with Bun's direct-TS execution. Task 1.6 must rewrite the entire inline `printf` entrypoint block.

### Tables/schema migration targets

| Our table | V2 strategy | Notes |
|-----------|-------------|-------|
| `registered_groups` (v1) | → `messaging_groups` + `messaging_group_agents` + `agent_groups` (v2 `src/db/schema.ts:12-56`) | Migration via `migrate-v2.sh`; our 4 custom cols go to new `taskflow_groups` sidecar |
| `scheduled_tasks` (v1 `src/db.ts:45`) | → fork-private in v2; upstream has no equivalent seeder | **Custom seeder required** |
| `outbound_messages` (v1 `src/db.ts:151`) | preserved as fork-private | Keeps our 2026-04-14 SIGKILL-resilience fix |
| `agent_turn_messages` (v1) | preserved as fork-private | Kipp audit depends on it; v2 has no turn concept |
| `send_message_log` (v1) | preserved as fork-private | v2's `delivered` table lacks `trigger_*` correlation |
| `data/taskflow/taskflow.db` (entire) | untouched | Migrator ignores `data/` |

### Env propagation — NEW critical section

V2's safe env allowlist **omits**: `OLLAMA_HOST`, `EMBEDDING_MODEL`, all `NANOCLAW_SEMANTIC_AUDIT_*` keys. These envs drive Kipp's model routing, semantic audit, and embeddings. Without a patch to the allowlist, they don't propagate to containers under v2 → semantic audit silently breaks.

Our current passing at `src/container-runner.ts:383`: 6 keys including `NANOCLAW_SEMANTIC_AUDIT_OLLAMA_HOST`, `NANOCLAW_SEMANTIC_AUDIT_MODEL`, `NANOCLAW_SEMANTIC_AUDIT_TIMEOUT_MS`, `NANOCLAW_SEMANTIC_AUDIT_TEMPERATURE`, `NANOCLAW_SEMANTIC_AUDIT_MAX_TOKENS`, `NANOCLAW_SEMANTIC_AUDIT_MODE`.

Phase 3 adds a TaskFlow env allowlist extension.

### Upstream paths we depend on (read-only)

- `upstream/migrate/v1-to-v2:migrate-v2.sh` — positional `<v1-path>` arg (NOT env var). Exits nonzero on missing arg.
- `upstream/migrate/v1-to-v2:setup/migrate.ts` — driver orchestration.
- `upstream/migrate/v1-to-v2:setup/migrate/seed-v2.ts` — 1:1 `jid → platform_id`; skips + warns on `channel_type='unknown'`. Output path: `path.join(v2Root, 'data', 'v2.db')` where `v2Root` defaults to `$V1_ROOT/.v2-sibling` or similar — **verify exact path at execution time**.
- `upstream/skill/native-credential-proxy` — OneCLI escape.
- `upstream/skill/migrate-nanoclaw` — clean-base replay methodology.
- `upstream/channels:src/channels/whatsapp.ts` — v2-native Baileys adapter.
- `upstream/main:container/agent-runner/src/db/connection.ts` — `bun:sqlite` idioms.
- `upstream/main:src/db/schema.ts` — v2 entity model; `engage_pattern` lives on `messaging_group_agents` at L42-49 (NOT on `messaging_groups`).
- `upstream/main:container/Dockerfile:67-69` — pinned `BUN_VERSION=1.3.12`.

---

## Revised prerequisites (BLOCKING — verify before Phase -1)

- [ ] **Disk: ≥30GB free locally** (`df -h / | awk 'NR==2 {gsub("G","",$4); exit ($4<30)}'` returns 0). Current state: 2.4GB free at plan drafting — blocker.
- [ ] **Audit-fix stability.** Commit `ed52fa7` has survived ≥3 consecutive Kipp daily audits (04:00 local) without regression; `actor_first_name_heuristic_hits` emitted in each.
- [ ] **User commit to timeline.** Explicit agreement to 12-16 week full-time window (or 6-month part-time). Phase gate sign-offs required.
- [ ] **Clean working tree** both local and prod.
- [ ] **Backup policy for `.env`.** Copy `/root/nanoclaw/.env` to `/root/.env-pre-v2-backup-<date>` with `chmod 400` before any migration step.

---

## Phase -1: Infrastructure Prep (Week 0, ~3 days)

**Goal:** Create the preconditions for Phase 0. No code changes to app; all changes are infra + operational tooling.

**Success criteria:**
- Local + prod disk ≥30GB free.
- Immutable prod DB snapshot pinned with `chattr +i` or equivalent.
- `nanoclaw-agent:v1-rollback` Docker tag pinned locally AND remotely, also saved as `.tar` for cold-rollback.
- `scripts/rollback-to-v1.sh` written, tested against a simulated mid-cutover failure on a disposable scratch.
- Migration baseline pinned to a specific upstream commit hash (per "Drift trajectory" recommendation in delta re-review). Hash recorded in the Phase -1 sign-off.
- Circuit-breaker boot smoke (Task -1.6, delta #6) passes on a single test board.

### Task -1.1: Reclaim disk space

- [ ] **Step 1: Check current state**

```bash
df -h /
ls -lahS ~/.ollama/models/blobs 2>/dev/null | head -10
sudo -n docker system df
```

- [ ] **Step 2: Reclaim per `reference_prod_disk_diagnostics.md`**

Recipe: docker builder prune → ollama partial blobs → dangling images. On local (`/root`): apply each until free >30GB. On prod: same but scoped to verify `nanoclaw-agent:latest` is NOT touched.

- [ ] **Step 3: Verify**

```bash
df -h / | awk 'NR==2 && $4+0 < 30 {exit 1}'  # fails if <30GB free
```

- [ ] **Step 4: Document + commit the recovery log**

### Task -1.2: Pin 1.x Docker image for rollback

- [ ] **Step 1: Tag the currently-running image**

```bash
# On prod:
ssh nanoclaw@192.168.2.63 "sudo -n docker tag nanoclaw-agent:latest nanoclaw-agent:v1-rollback && sudo -n docker save -o /home/nanoclaw/backup/v1-image.tar nanoclaw-agent:v1-rollback"
```

- [ ] **Step 2: Verify the saved tar can be loaded**

```bash
ssh nanoclaw@192.168.2.63 "sudo -n docker load -i /home/nanoclaw/backup/v1-image.tar < /dev/null | head -3"
```

Expected: "Loaded image" message.

- [ ] **Step 3: Same on local if dev container exists.**

### Task -1.3: Immutable prod snapshot

- [ ] **Step 1: Fresh prod snapshot**

```bash
mkdir -p /tmp/prod-snapshot-$(date +%Y%m%d)/{store,data/taskflow}
scp nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/store/messages.db /tmp/prod-snapshot-$(date +%Y%m%d)/store/
scp nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db /tmp/prod-snapshot-$(date +%Y%m%d)/data/taskflow/
```

- [ ] **Step 2: Immutable-mark**

```bash
sudo chattr +i /tmp/prod-snapshot-$(date +%Y%m%d)/store/messages.db || chmod -R a-w /tmp/prod-snapshot-$(date +%Y%m%d)
md5sum /tmp/prod-snapshot-$(date +%Y%m%d)/store/messages.db > /tmp/prod-snapshot-$(date +%Y%m%d)/md5.txt
md5sum /tmp/prod-snapshot-$(date +%Y%m%d)/data/taskflow/taskflow.db >> /tmp/prod-snapshot-$(date +%Y%m%d)/md5.txt
```

- [ ] **Step 3: Record the baseline.**

### Task -1.4: Write and test `scripts/rollback-to-v1.sh`

- [ ] **Step 1: Write the script**

Contents (skeleton):
```bash
#!/usr/bin/env bash
set -euo pipefail
# Restore 1.x state in under 15 minutes.

SNAPSHOT_DIR="${1:?usage: rollback-to-v1.sh <snapshot-dir>}"
V1_SHA="${V1_SHA:?set V1_SHA to the 1.x git SHA to restore}"

# 1. Stop v2
ssh nanoclaw@192.168.2.63 "systemctl --user stop nanoclaw"

# 2. Restore code
ssh nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && git reset --hard $V1_SHA"

# 3. Restore DBs from immutable snapshot
scp $SNAPSHOT_DIR/store/messages.db nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/store/messages.db
scp $SNAPSHOT_DIR/data/taskflow/taskflow.db nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db

# 4. Restore 1.x container image
ssh nanoclaw@192.168.2.63 "sudo -n docker tag nanoclaw-agent:v1-rollback nanoclaw-agent:latest"

# 5. Restart
ssh nanoclaw@192.168.2.63 "systemctl --user start nanoclaw"
sleep 10
ssh nanoclaw@192.168.2.63 "systemctl --user is-active nanoclaw"  # must print 'active'
```

- [ ] **Step 2: Dry-run on a sandbox**

Create a disposable test VM or use the shadow slice from Phase 4. Simulate a broken v2 state (corrupt DB, missing image, etc.), run `rollback-to-v1.sh`, measure wall-clock time. Must be <15 min and end with service active.

- [ ] **Step 3: Commit the script.**

### Task -1.5: Prepare user-communication plan

- [ ] **Step 1: Draft PT-BR notification templates**

Two templates in `docs/runbooks/v2-cutover-comms-pt-br.md`:
1. T-72h notice: "Queridos usuários, na madrugada de DD/MM entre HH:MM e HH:MM o bot será atualizado. Mensagens enviadas nesse intervalo podem sofrer atraso. Contato de emergência: [phone/email]."
2. T-0 rollback notice (if needed): "Detectamos um problema. Revertendo para a versão anterior. Mensagens entre HH:MM e HH:MM podem ter sido perdidas — por favor reenvie."

- [ ] **Step 2: Identify escalation contacts** for each of the 28 groups (board owner / group admin). Document in the runbook.

### Task -1.6: Circuit breaker boot smoke test (NEW, delta #6)

Upstream `2.0.21` ships a startup circuit breaker (`src/circuit-breaker.ts`, hardened in `336e01d2`) that's on by default. Verify a single-board v2 boot does not trip it before committing to a fleet cutover.

- [ ] **Step 1: In the throwaway worktree from Phase 0 Task 0.1**, boot one test board through the v2 entrypoint and tail the breaker state from logs.
- [ ] **Step 2: Inject one transient error** (e.g., temporarily rename a credential) and verify the breaker opens, then closes cleanly after the error is fixed (delta #6 fixed an off-by-one + ENOENT path here — the breaker should reset on throw, not stay open).
- [ ] **Step 3: Document the breaker's failure threshold + reset window** in `docs/runbooks/v2-on-call.md` so Phase 4 drillers know how to diagnose a tripped breaker on prod.

### Task -1.7: Phase -1 sign-off

- [ ] Present to user. Wait for explicit approval before Phase -1.5.

---

## Phase -1.5: Security back-port to v1 (NEW, delta #8)

**Goal:** Port the upstream attachment path-traversal fix (`7e37b13a` + `6e5e568d` + `2a3be9ec`) to our v1.2.53 fork. Do this independently of v2 migration — it's a security fix, not a migration step.

**The actual primitive (Codex-corrected):** v2's `src/attachment-safety.ts:18-22` exposes `isSafeAttachmentName(name)` which **rejects** names containing path separators (`/`, `\`), `..` segments, NUL bytes, or empty basenames. MIME-type-derived extension is used **only as a fallback** when no explicit filename was provided (`session-manager.ts:263-277, 375-383`). The fix is NOT a safe-extension allowlist.

**Success criteria:**
- Our v1 attachment-handling code path validates inbound + agent-sent filenames via a basename guard equivalent to `isSafeAttachmentName()`.
- A MIME-derived fallback name is used when filename is absent.
- A failing test exists for each of the rejection vectors (`..`, `/`, `\`, NUL, empty).
- The fix lands on `main`, ships through `deploy.sh` to prod, soaks for 48h before Phase 0 begins.

### Task -1.5.1: Identify our v1 attachment code path

- [ ] **Step 1:** Grep our `src/` and `container/agent-runner/src/` for filename derivation in inbound + agent-sent attachment handlers.
- [ ] **Step 2:** Compare against `upstream/main:src/attachment-safety.ts` and the patched call-sites in `upstream/main:src/session-manager.ts`. Identify the equivalent locations in our code.

### Task -1.5.2: Write failing test

- [ ] **Step 1:** Reproduce the path traversal: an inbound attachment with filename `../../etc/passwd` or similar, asserting that the handler must reject or sanitize.
- [ ] **Step 2:** Run; expect FAIL on v1.2.53 if the bug is present. If the test PASSES on v1, document why (e.g., we sanitize elsewhere) and skip Task -1.5.3.

### Task -1.5.3: Port the sanitizer

- [ ] **Step 1:** Adapt `attachment-safety.ts` to our codebase (no Bun deps; works under Node). Keep the same `isSafeAttachmentName()` primitive (basename guard rejecting separators, `..`, NUL, empty) plus the MIME-type-derived **fallback** name path for nameless attachments.
- [ ] **Step 2:** Wire it into the call-sites identified in Task -1.5.1.
- [ ] **Step 3:** Run the tests from Task -1.5.2 (one per rejection vector); verify all PASS.
- [ ] **Step 4:** Codex review (read-only) before commit, per `feedback_review_before_deploy.md`.
- [ ] **Step 5:** Commit, deploy via `./scripts/deploy.sh`, soak 48h with prod attachment traffic.

### Task -1.5.4: Phase -1.5 sign-off

- [ ] 48h clean prod soak. No regressions in attachment delivery. Then proceed to Phase 0.

---

## Phase 0: Reconnaissance & Gate (Week 1)

**Goal:** Prove the highest-risk assumptions before any commit to our repo. If any gate fails, STOP.

**Success criteria:**
- `migrate-v2.sh` + `setup/migrate.ts` successfully transform `/tmp/prod-snapshot-*/store/messages.db` into v2's triplet without data loss, writing to `<v2Root>/data/v2.db` (NOT `/tmp/migration-dryrun/data/v2.db` — verified path at execution time).
- `use-native-credential-proxy` skill boots a v2 container without OneCLI.
- Bun + `bun:sqlite` runtime-smoke-test on `taskflow-engine.ts` returns real data from our `taskflow.db`.
- V2-native WhatsApp adapter on `upstream/channels` pairs + receives + stores a test message (test number, NOT prod).
- Env allowlist audit: `OLLAMA_HOST`, `EMBEDDING_MODEL`, `NANOCLAW_SEMANTIC_AUDIT_*` propagation verified or patched.
- `.env` safety audit: `migrate-v2.sh` does not mutate `.env`.

### Task 0.1: Spawn throwaway v2 worktree

```bash
cd /root/nanoclaw
git fetch upstream --prune
git worktree add ../nanoclaw-v2 upstream/main --detach
```

### Task 0.2: Test the upstream migrator (CORRECTED)

- [ ] **Step 1: Stage a sacrificial copy (read-only source)**

```bash
rm -rf /tmp/migration-dryrun
mkdir -p /tmp/migration-dryrun/store /tmp/migration-dryrun/data/taskflow
cp /tmp/prod-snapshot-<DATE>/store/messages.db /tmp/migration-dryrun/store/
cp /tmp/prod-snapshot-<DATE>/data/taskflow/taskflow.db /tmp/migration-dryrun/data/taskflow/
# Immutable source is preserved by chattr; this cp uses the already-chmod'd snapshot.
```

- [ ] **Step 2: Record pre-migration state**

```bash
md5sum /tmp/migration-dryrun/store/messages.db > /tmp/migration-dryrun/pre.md5
sqlite3 /tmp/migration-dryrun/store/messages.db "SELECT name, COUNT(*) FROM sqlite_master sm LEFT JOIN (SELECT 'messages' n, COUNT(*) c FROM messages UNION SELECT 'registered_groups', COUNT(*) FROM registered_groups UNION SELECT 'scheduled_tasks', COUNT(*) FROM scheduled_tasks) ON sm.name = n WHERE type='table';" > /tmp/migration-dryrun/pre-counts.txt
```

- [ ] **Step 3: Run migrate-v2.sh with CORRECT syntax (positional arg, NOT env var)**

```bash
cd /root/nanoclaw-v2
git fetch upstream migrate/v1-to-v2:migrate/v1-to-v2
git checkout migrate/v1-to-v2
# CORRECT invocation — positional path:
bash migrate-v2.sh /tmp/migration-dryrun 2>&1 | tee /tmp/migration-dryrun/migrate.log
```

Expected: exits 0. If it fails because we're missing v2 deps or config, record the failure mode exactly.

- [ ] **Step 4: Verify the actual output path (do NOT assume `/tmp/migration-dryrun/data/v2.db`)**

```bash
find /tmp/migration-dryrun -name 'v2.db' -o -name 'v2-*.db' 2>/dev/null
# Also check if seed-v2.ts wrote to a sibling dir:
ls /tmp/migration-dryrun.v2 2>/dev/null
ls /tmp/*v2* 2>/dev/null
```

Record the actual output path. Inspect `upstream/migrate/v1-to-v2:setup/migrate/seed-v2.ts` for the `v2Root` derivation if path is not obvious.

- [ ] **Step 5: Verify NO mutation of source `messages.db`**

```bash
md5sum /tmp/migration-dryrun/store/messages.db > /tmp/migration-dryrun/post.md5
diff /tmp/migration-dryrun/pre.md5 /tmp/migration-dryrun/post.md5
```

Expected: identical. If different, migrator is mutating in place — rollback risk escalates.

- [ ] **Step 6: Verify row counts and `channel_type='unknown'` skips**

```bash
sqlite3 <actual-v2.db-path> "SELECT 'messaging_groups', COUNT(*) FROM messaging_groups UNION SELECT 'agent_groups', COUNT(*) FROM agent_groups UNION SELECT 'users', COUNT(*) FROM users UNION SELECT 'user_roles', COUNT(*) FROM user_roles;"
grep -i 'unknown\|skip\|channel_type' /tmp/migration-dryrun/migrate.log
```

Record: how many of our 28 TaskFlow-managed groups ended up in `messaging_groups` vs how many were skipped with an `unknown` warning. **Any skipped TaskFlow group is a blocker** — fix the upstream inference or add a fork-private seed for that group.

- [ ] **Step 7: Gate decision.** Document in Phase-0-gate-report.md.

### Task 0.3: Verify native-credential-proxy skill (UPDATED, delta #1)

**Note:** v2.0.21's `src/container-runner.ts:459` is now a hard throw on missing OneCLI gateway (`'OneCLI gateway not applied — refusing to spawn container without credentials'`). The native-credential-proxy escape still works — the skill swaps OneCLI imports out entirely — but the merge surface against current upstream `main` is bigger than v2.0.10. Verify clean merge before relying on the escape.

- [ ] **Step 1: Merge the skill onto the worktree's upstream/main**

```bash
cd /root/nanoclaw-v2
git checkout upstream/main -- .
git fetch upstream skill/native-credential-proxy
git merge upstream/skill/native-credential-proxy
# If conflicts beyond package-lock.json, STOP — record exact files, escalate to user.
```

- [ ] **Step 2: Confirm the hard-throw at L459 is removed by the merge**

```bash
grep -n 'OneCLI gateway not applied' src/container-runner.ts
# Expected: no match (the skill replaces this code path).
```

If the throw still exists, the skill needs an update for v2.0.21 — STOP and report.

- [ ] **Step 3: Boot a test container**

```bash
cd /root/nanoclaw-v2
pnpm install --frozen-lockfile
pnpm run build
NANOCLAW_USE_NATIVE_CREDENTIAL_PROXY=1 node dist/scripts/dev-container.js 2>&1 | tee /tmp/v2-cred-test.log
```

Expected: container boots without OneCLI failure. If the entrypoint differs, consult `upstream/main:package.json` scripts.

### Task 0.4: Bun + bun:sqlite smoke test (CORRECTED)

- [ ] **Step 1: Create scratch dir with proper Bun project**

```bash
mkdir -p /tmp/bun-smoke && cd /tmp/bun-smoke
bun init -y  # creates package.json — required before bun add
bun add -d @types/bun typescript
cp /root/nanoclaw/container/agent-runner/src/taskflow-engine.ts .
cp /tmp/prod-snapshot-<DATE>/data/taskflow/taskflow.db .
```

- [ ] **Step 2: Apply the mechanical changes** (see Task 1.4 for full scope).

- [ ] **Step 3: Runtime smoke-test a read-only path.**

### Task 0.5: WhatsApp v2-native adapter boot

- [ ] **Step 1: Install the v2 WhatsApp skill.**

- [ ] **Step 2: Pair a TEST phone number (NOT prod).**

- [ ] **Step 3: Send + receive "ping".**

### Task 0.6: Env allowlist audit (NEW)

- [ ] **Step 1: Grep v2 allowlist**

```bash
cd /root/nanoclaw-v2
git grep -n 'OLLAMA_HOST\|EMBEDDING_MODEL\|NANOCLAW_SEMANTIC_AUDIT' -- src/
# Expected: missing entries in v2's safe-env set.
```

- [ ] **Step 2: Identify the allowlist file**

Likely `src/container-runner.ts` or `src/env.ts` or similar. Record the exact location where the envs would need to be added.

- [ ] **Step 3: Write a minimal patch that adds our 6 semantic-audit keys + Ollama + Embedding.** Stage for Phase 3 application.

### Task 0.7: `.env` safety audit (NEW)

- [ ] **Step 1: Grep migration for `.env` handling**

```bash
cd /root/nanoclaw-v2
git log upstream/migrate/v1-to-v2 --all -- migrate-v2.sh setup/ | head -30
git grep -n '\.env' upstream/migrate/v1-to-v2 -- migrate-v2.sh setup/
```

- [ ] **Step 2: Run migrator on a copy-of-`.env`**

```bash
cp /root/nanoclaw/.env /tmp/migration-dryrun/.env
md5sum /tmp/migration-dryrun/.env > /tmp/migration-dryrun/env-pre.md5
bash migrate-v2.sh /tmp/migration-dryrun  # re-run
md5sum /tmp/migration-dryrun/.env > /tmp/migration-dryrun/env-post.md5
diff /tmp/migration-dryrun/env-pre.md5 /tmp/migration-dryrun/env-post.md5
```

Expected: identical. If migrator touches `.env`, document exactly what it does.

### Task 0.8: Phase 0 gate

- [ ] Compile all gate results. Present to user. Do NOT proceed without explicit approval.

---

## Phase 1: Bun Runtime Port (Weeks 2-3)

**Goal:** Port `container/agent-runner/src/*` (17 files) to Bun + `bun:sqlite`. Rewrite Dockerfile's two TS-compile sites. Rewrite `auditor-script.sh` heredoc for `bun:sqlite`.

**Success criteria:**
- `bun x tsc --noEmit` passes on all 17 container files.
- `bun test` passes (all existing vitest tests compile under bun:test).
- Local container rebuilds with Bun entrypoint (no `npx tsc` at runtime OR buildtime).
- Extracted auditor heredoc runs under `bun` against prod snapshot; output matches 1.x within ±5%.

### Task 1.1: Create migration branch

```bash
cd /root/nanoclaw
git checkout -b feat/v2-migration main
git push -u origin feat/v2-migration
```

### Task 1.2: Update container/agent-runner/package.json

- [ ] Remove `better-sqlite3` + `@types/better-sqlite3`.
- [ ] Add `@types/bun` devDep.
- [ ] Bump SDK to `^0.2.116`.
- [ ] Remove `"build"` script.
- [ ] `bun install` and commit `bun.lock`.

### Task 1.3: Update container/agent-runner/tsconfig.json

- [ ] Add `"types": ["bun"]`, drop `outDir`/`declaration`, keep `NodeNext`.

### Task 1.4: Mechanical port across 17 files

- [ ] **Step 1: Write `container/agent-runner/src/bun-smoke.test.ts`** (from v1 plan — still valid). Covers `.prepare().run().changes/.lastInsertRowid`, `.transaction(fn)()`, pragmas.

- [ ] **Step 2: Run the smoke test** — must PASS before any file changes. (Gate: Codex's API-compat claim.)

- [ ] **Step 3: Port each file**

Files (all, including the ones v1 plan missed — `db-util.ts`, `ipc-mcp-stdio.ts`):
- `taskflow-engine.ts` (9k lines, 579 SQL sites — all mechanical)
- `taskflow-mcp-server.ts`
- `semantic-audit.ts` (type-only — trivial)
- `embedding-reader.ts` (Buffer→Uint8Array may need cast)
- `context-reader.ts`
- `db-util.ts`
- `ipc-mcp-stdio.ts`
- `index.ts` (L708 dynamic import)
- `taskflow-engine.test.ts`, `taskflow-mcp-server.test.ts`, `context-reader.test.ts`, `semantic-audit.test.ts`, `embedding-reader.test.ts`, `taskflow-embedding-integration.test.ts`

Per file:
```bash
sed -i "s|^import Database from 'better-sqlite3';|import { Database } from 'bun:sqlite';|" <file>
sed -i 's|Database\.Database|Database|g' <file>  # only 2 occurrences in taskflow-engine.ts
```

- [ ] **Step 4: Fix MCP loader at `src/index.ts:678`** — path-based `.js` import must become `.ts` (Bun runs TS directly).

- [ ] **Step 5: Type-check and test the full container-runner**

```bash
cd /root/nanoclaw/container/agent-runner
bun x tsc --noEmit 2>&1 | tail -20
bun test 2>&1 | tail -20
```

Expected: zero errors, all tests PASS.

- [ ] **Step 6: Commit per file** (small commits make bisect tractable).

### Task 1.5: Rewrite `auditor-script.sh` heredoc

- [ ] **Step 1: Swap `require("better-sqlite3")` → `require("bun:sqlite")`**

Both in `auditor-script.sh` (L12) and `digest-skip-script.sh` (L31). Verify constructor signature `new Database(path, {readonly: true})` works under bun:sqlite (Codex verified via `upstream/main:container/agent-runner/src/db/connection.ts:34`).

- [ ] **Step 2: Change script invoker**

`NODE_PATH=/app/node_modules node /tmp/auditor.js` → `bun /tmp/auditor.js`. (Note: `NODE_PATH` is dead under Bun; remove for cleanliness.)

- [ ] **Step 3: Smoke against prod snapshot** — output matches 1.x within ±5%.

### Task 1.6: Rewrite container/Dockerfile (TWO sites)

**v1 plan was wrong** — there is no `container/entrypoint.sh`. The entrypoint is inline in Dockerfile's `RUN printf` block.

- [ ] **Step 1: Read current Dockerfile lines 51 + 59**

Line 51: `RUN npm run build` (build-time TS compile).
Line 59: inside `RUN printf '#!/bin/bash ... npx tsc --outDir /tmp/dist ... node /tmp/dist/index.js ...'` (runtime compile).

- [ ] **Step 2: Remove both compile sites + install Bun**

Add (pinned version, per upstream):
```dockerfile
ARG BUN_VERSION=1.3.12
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && bun --version
```

Remove `RUN npm run build`. Rewrite the inline entrypoint's `npx tsc ... && node` to `bun run /app/src/index.ts`.

- [ ] **Step 3: Also remove `apt-get install make g++`** (line 42) — these were for better-sqlite3 native compile, no longer needed.

- [ ] **Step 4: Verify UID 1000 preservation**

Bun's install-to-`/usr/local` runs as root, but the image's `USER node` directive (per `USER 1000`) applies after. Confirm by:
```bash
./container/build.sh
docker run --rm -it nanoclaw-agent:latest id
# Must print uid=1000(node)
```

- [ ] **Step 5: Local rebuild + smoke**.

### Task 1.7: Phase 1 gate

---

## Phase 2: WhatsApp Re-port (Weeks 4-6, was 4-5; delta #5)

**Goal:** Port TaskFlow's WhatsApp hooks against v2-native adapter. The hooks don't all live in `whatsapp.ts` — they span `db.ts`, `router.ts`, `group-sender.ts`, `ipc.ts`, `container-runner.ts`, `mount-security.ts`. **Estimate bumped from 2 weeks to 2-3 weeks** because upstream's channel-approval flow grew ~600 lines (`modules/permissions/channel-approval.ts` +217, `modules/permissions/index.ts` +300) between v2.0.10 and v2.0.21 — agent selection + free-text naming. The wire-up surface that previously took 1-2 weeks now takes 2-3.

### Task 2.1: Hook inventory (CORRECTED scope)

- [ ] **Step 1: Grep TaskFlow hooks across ALL WhatsApp-adjacent files**

```bash
cd /root/nanoclaw
grep -rn 'taskflow\|TaskFlow\|@Case\|@Tars\|trigger_pattern\|isMainGroup\|taskflow_managed' src/*.ts | tee /tmp/tf-hooks-full-inventory.txt
wc -l /tmp/tf-hooks-full-inventory.txt
```

- [ ] **Step 2: Categorize** each hit:
- Routing (trigger detection)
- Outbound formatting
- Session isolation
- Data persistence
- Privilege checks (maps to Phase 3 isMain rewrite)

### Task 2.2: Port each hook (CORRECTED v2 target)

**Corrected target schema:** `engage_pattern` lives on `messaging_group_agents`, NOT `messaging_groups` (per Codex verification of `upstream/main:src/db/schema.ts:42-49`).

**Delta #5 note:** Permissions module is now `modules/permissions/index.ts` (+300 LOC) + `modules/permissions/channel-approval.ts` (+217 LOC). Hooks that previously read a single `isMain` flag now flow through agent-group permission checks with potentially multiple agents per group. Read the full v2.0.21 permissions module before writing any hook — don't assume the v2.0.10 shape.

Per hook:
- [ ] Write a test capturing v1 behavior.
- [ ] Implement against v2 primitives (`messaging_group_agents.engage_pattern`, `user_roles.role`, agent-group permission helpers from `modules/permissions/index.ts`).
- [ ] Commit.

### Task 2.3: E2E on one WhatsApp test number

Test separate from prod pairing.

### Task 2.4: Phase 2 gate

---

## Phase 2.5: TaskFlow Permissions Adoption (NEW v2.2, Weeks 5-6)

**Goal:** Adopt v2's permissions/approval/destinations stack for TaskFlow boards. Codex's #1 recommendation from the 2026-04-30 feature evaluation. Surfaces the highest-leverage v2 features (deltas #12, #13, #14, #17) that the prior plan version omitted.

**Why now (between Phase 2 and Phase 3):** Phase 2 lands v2-native WhatsApp adapter; Phase 3 rewrites 103 `isMain` sites. Permissions adoption needs (a) v2 WhatsApp wired (Phase 2 done) and (b) the new `users` / `agent_group_members` / `user_roles` tables to be the privilege source (Phase 3 prerequisite). Phase 2.5 is where we seed those tables for TaskFlow's 31 boards before the isMain rewrite uses them.

**Success criteria:**
- For each of the 31 boards: `users`, `user_roles`, `agent_group_members`, `user_dms` populated from current TaskFlow `board_people` / `board_admins`.
- `agent_destinations` seeded as the outbound ACL per board (board → its parent agent group; board → admin DM where applicable).
- `messaging_groups.unknown_sender_policy='request_approval'` enabled on all 31 boards. New non-member message → admin approval card via `ask_user_question`.
- `unregistered_senders` audit table populates correctly when a non-member messages a board.
- Migration script `scripts/migrate-taskflow-users.ts` is idempotent and re-runnable.

### Task 2.5.1: Inventory current TaskFlow privilege state

- [ ] **Step 1:** Enumerate the source-of-truth tables for board membership today.

```bash
sqlite3 store/messages.db "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'board_%' OR name LIKE '%admin%' OR name LIKE '%people%' OR name LIKE '%role%')"
sqlite3 data/taskflow/taskflow.db ".schema board_people"
sqlite3 data/taskflow/taskflow.db ".schema board_admins"
```

Record: rows per board, fields per row. This becomes the input to the migration script.

- [ ] **Step 2:** Per board (sample 3 boards), reconstruct: who is admin, who is a member, what is their phone JID, what is the `board_id → messaging_group_id` mapping. Document in Phase 2.5 prep notes.

### Task 2.5.2: Seed v2 permission tables from TaskFlow source-of-truth

Write `scripts/migrate-taskflow-users.ts` (~250 LOC) that:

- [ ] **Step 1:** For each row in `board_people` / `board_admins`:
  - Insert into `users` (id derived from phone JID), upsert by JID
  - Insert into `agent_group_members` (`agent_group_id`, `user_id`, `joined_at`)
  - Insert into `user_roles` (`user_id`, `role IN ('owner','admin','member')`, `agent_group_id` scope) — `admin` for board admins, `member` for board people, `owner` for the platform owner (currently `is_main` boards)
  - Insert into `user_dms` if the user has had a 1:1 conversation with the bot

- [ ] **Step 2:** Idempotency: every `INSERT` is `INSERT OR IGNORE` keyed on (user_id, agent_group_id, role). Re-running the script after partial failure must not duplicate rows.

- [ ] **Step 3:** Diff report: emit a CSV showing per-board users + roles before/after. Spot-check 3 boards manually before bulk run.

- [ ] **Step 4:** Run on the dryrun migrated DB from Phase 0 Task 0.2. Verify counts match expectations.

### Task 2.5.3: Seed `agent_destinations` as outbound ACL

Per Codex finding (delta #14): `agent_destinations` is not a2a-only. It's the outbound permission map. This task seeds it for the cross-board flow we already need.

- [ ] **Step 1:** For each child board, insert one row:
  - `agent_group_id = <child board agent_group>`
  - `local_name = 'parent'`
  - `target_type = 'agent'`
  - `target_agent_group_id = <parent board agent_group>`

- [ ] **Step 2:** For each parent board, insert siblings of one child each (named `child-<short_code>`).

- [ ] **Step 3:** For boards with admin DMs, insert one row per admin:
  - `local_name = 'admin-<short_name>'`
  - `target_type = 'channel'`
  - `target_platform_id = <admin JID>`

- [ ] **Step 4:** Refresh per-session `destinations` projection via `writeDestinations()` for any running session. Sleep one container wake cycle and verify projection rows match.

### Task 2.5.4: Enable unknown-sender approval policy

- [ ] **Step 1:** For each `messaging_groups` row:
  ```sql
  UPDATE messaging_groups
  SET unknown_sender_policy = 'request_approval'
  WHERE id IN (<31 TaskFlow board IDs>);
  ```

- [ ] **Step 2:** Verify `messaging_group_agents` rows have `sender_scope='known'` and `ignored_message_policy='accumulate'` (so dropped messages are logged, not silently discarded).

- [ ] **Step 3:** End-to-end test on test-taskflow board:
  - Send a message from a phone number NOT in `agent_group_members`
  - Verify: message lands in `unregistered_senders` table, NOT in the agent's session
  - Verify: an `ask_user_question` card appears in the parent group asking the admin to approve
  - Admin approves → message is replayed; admin rejects → message stays in `unregistered_senders`

### Task 2.5.5: PT-BR copy for approval cards

- [ ] **Step 1:** Translate the v2 default approval-card copy to PT-BR. Default is English; we need:
  - "User <name> not recognized. Approve?" → "Usuário <nome> não reconhecido. Aprovar?"
  - "Approve" / "Reject" → "Aprovar" / "Rejeitar"
- [ ] **Step 2:** Wire the PT-BR copy via `groups/<board>/CLAUDE.md` fragment OR (better) via a fork-private patch to `src/modules/permissions/sender-approval.ts` strings. Decide based on what v2 exposes.
- [ ] **Step 3:** Test approval-card rendering on test-taskflow.

### Task 2.5.6: Adopt v2 scheduling natives where possible (delta #16)

Codex finding: v2 has `update_task`, deduped `list_tasks`, timezone parsing, pre-agent `script` support. Today `task-scheduler.ts` re-implements much of this fork-privately.

- [ ] **Step 1:** Map our Kipp/digest/standup recurring tasks to v2's scheduling primitives. Sample one (e.g. Kipp 04:00 cron) and rewrite it via v2's `update_task` MCP tool from a one-shot init script.
- [ ] **Step 2:** Verify v2's recurrence + timezone handling matches our expectations (especially the holiday/weekday-contradiction handling we shipped 2026-04-29).
- [ ] **Step 3:** If v2's primitives suffice, plan to retire fork-private `task-scheduler.ts` in Phase 6. If they don't, document the gap and keep our scheduler.

### Task 2.5.7: Phase 2.5 gate

- [ ] All 31 boards have populated v2 permission tables (counts match source-of-truth ±0 rows).
- [ ] `agent_destinations` seeded; per-session projection refreshed.
- [ ] Unknown-sender approval verified on test-taskflow with both approve and reject paths.
- [ ] PT-BR copy applied.
- [ ] Scheduling-primitive feasibility documented (Item 16 outcome).
- [ ] Present to user. Wait for explicit approval before Phase 3.

---

## Phase 3: isMain Rewrite + Schema Migration + Env Patch (Weeks 7-10, was 6-9)

**Goal:** Rewrite ~103 isMain sites across 18 files. Create TaskFlow sidecar tables. Port scheduled_tasks. Patch v2 env allowlist.

**Phase 2.5 dependency:** This phase replaces `isMain` checks with `hasAdminRole(senderUserId, agentGroupId)` queries against `user_roles`. Phase 2.5 must have populated `user_roles` for all 31 boards before this phase begins, otherwise the rewritten check returns `false` for every legitimate admin.

### Task 3.1: SDK 0.2.111/0.2.113 behavioral audit

- [ ] Read SDK release notes for env semantics changes (0.2.111) + native-binary-spawn changes (0.2.113).
- [ ] Grep our code for affected patterns; patch each.

**Delta #7:** Strike the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` worry from this audit — upstream `98898489 fix(claude-provider): respect operator-set CLAUDE_CODE_AUTO_COMPACT_WINDOW` (in v2.0.21) confirms our `=165000` setting is honored without patches. Verify the fix is in the merge base before relying on it.

### Task 3.2: TaskFlow sidecar table

Create `container/agent-runner/src/db/migrations/100-taskflow-sidecar.ts`:

```sql
CREATE TABLE IF NOT EXISTS taskflow_groups (
  messaging_group_id TEXT PRIMARY KEY
    REFERENCES messaging_groups(id) ON DELETE CASCADE,
  taskflow_managed INTEGER NOT NULL DEFAULT 0,
  taskflow_hierarchy_level INTEGER NOT NULL DEFAULT 0,
  taskflow_max_depth INTEGER NOT NULL DEFAULT 3,
  trigger_pattern TEXT,
  created_at TEXT NOT NULL  -- written by callers via nowIso(), per upstream convention
);
CREATE INDEX IF NOT EXISTS idx_tfg_managed ON taskflow_groups(taskflow_managed);
```

**Note** (Codex correction): use explicit `nowIso()` at INSERT time, not `DEFAULT (datetime('now'))` — upstream convention.

### Task 3.3: Rewrite 103 isMain sites across 18 files

This is the largest task in the plan — 4 weeks realistic for full coverage + tests.

- [ ] **Step 1: Enumerate all 103 sites**

```bash
grep -rn 'isMain\|is_main\|MAIN_GROUP_FOLDER\|isMainGroup' src/ container/ | tee /tmp/ismain-sites.txt
```

- [ ] **Step 2: Per site (batched by file):**
- Write a test that captures v1 behavior.
- Replace the check: `isMainGroup` → `await hasAdminRole(senderUserId, agentGroupId)`.
- `hasAdminRole` queries `user_roles` WHERE role IN ('owner','admin') AND (agent_group_id = ? OR agent_group_id IS NULL).
- Test + commit per logical group.

Priority files (most sites, most critical):
1. `src/ipc.ts` (28 sites) — Week 6.
2. `src/container-runner.ts` (13 sites) — Week 7 early.
3. `src/index.ts` (~8 sites) — Week 7 mid.
4. `src/mount-security.ts`, `src/task-scheduler.ts`, `src/session-commands.ts` — Week 7 late.
5. Tests (~40 sites) — Week 8.
6. Edge cases (db.ts queries, types.ts type refs) — Week 9 early.

### Task 3.4: Custom migration script for TaskFlow columns (UPDATED, deltas #3 + #4)

Create `scripts/migrate-taskflow-groups.ts`:

- [ ] Reads our `registered_groups` rows.
- [ ] For each: finds corresponding `messaging_groups` row by `platform_id == namespacedPlatformId('whatsapp', jid)`.
- [ ] **Delta #3 — `namespacedPlatformId()` rule:** import from `upstream/main:src/platform-id.ts`. WhatsApp `@g.us` JIDs contain `@` → the helper returns the raw JID unchanged (no `whatsapp:` prefix). Do NOT manually prepend a prefix. Test with one of our 31 board JIDs end-to-end before bulk-running.
- [ ] **Delta #4 — `createMessagingGroupAgent` field-name regression:** upstream `fc375ca7` just fixed this helper being called with legacy field names. Before any seed-v2 invocation in our scripts, diff `setup/register.ts` at the migration baseline against the latest upstream `main`; copy the corrected field set verbatim. Do NOT trust earlier samples.
- [ ] If `taskflow_managed=1`: inserts `taskflow_groups` row.
- [ ] **Handles `channel_type='unknown'` skip**: if seed-v2.ts skipped a JID we need, manually seed via direct INSERT into `messaging_groups` with `channel_type='whatsapp'` inferred + `platform_id` produced by `namespacedPlatformId()`.
- [ ] Logs every migration; produces a diff report.

### Task 3.5: `scheduled_tasks` re-creation (UPDATED, delta #2)

- [ ] **Step 1: Read upstream scheduling model**

`upstream/main:container/agent-runner/src/mcp-tools/scheduling.ts` + `upstream/main:src/db/schema.ts`. Determine how v2 stores recurring/one-shot scheduled tasks.

- [ ] **Step 2: Confirm the post-`8dd004ca` content-JSON contract**

Upstream `8dd004ca` (2026-04-30) fixed a silent bug where `schedule_task` wrote routing onto outbound system-message **row columns** but `handleScheduleTask` read it from the message **content JSON**. Result: every `kind='task'` row landed in `messages_in` with all-null routing → host-sweep fell through to a "Routing recovery" retry prompt, costing one extra LLM turn per scheduled-task wake (and failing outright when destinations table had no channel row).

```bash
git show upstream/main:container/agent-runner/src/mcp-tools/scheduling.ts | grep -A 5 'platformId\|channelType\|threadId'
# Expected: all three fields appear in the content JSON object passed to schedule_task.
```

- [ ] **Step 3: Write a v1→v2 `scheduled_tasks` seeder**

Per our Kipp cron (`0 4 * * *`), digest cron, standup cron, etc., create equivalents in v2's model. **The seeder must populate `platformId`, `channelType`, `threadId` in the content JSON for every recurring task** — otherwise host-sweep falls into the recovery loop on each wake. Test each individually before commit.

- [ ] **Step 4: Verify routing fields land in content JSON, not row columns**

```bash
sqlite3 <v2.db> "SELECT json_extract(content, '$.platformId'), json_extract(content, '$.channelType') FROM messages_out WHERE kind='task' LIMIT 5;"
# Expected: non-null for every row. If any return NULL, the seeder is on the pre-fix contract.
```

- [ ] **Step 5: Preserve as fork-private if v2 doesn't map cleanly**

If v2 has no direct cron equivalent, keep `scheduled_tasks` as a fork-private table + keep our `src/task-scheduler.ts` driver. The fork-private path also sidesteps the routing-JSON contract.

### Task 3.6: Env allowlist patch

- [ ] Apply the patch staged in Task 0.6 to v2's env-safe list.

### Task 3.7: `outbound_messages` regression check

- [ ] Grep v2 for any equivalent of our durable outbound queue fix (2026-04-14 commit `56702cf`). If none, preserve our table as fork-private and keep our queue drain logic.

### Task 3.8: Phase 3 gate

---

## Phase 4: Shadow Run on Test Groups (Weeks 11-12, was 10-11)

**Goal:** Run v2 against `test-taskflow` + `e2e-taskflow` with separate Baileys auth (dedicated test phone number). 5-day shadow. This is the ONLY pre-cutover shadow validation.

**Success criteria:**
- Kipp audit on test groups produces `taskMutationFound` counts within ±5% of baseline + `actor_first_name_heuristic_hits` > 0.
- Zero lost messages (compare `messages_in` counts).
- Auditor liveness check: `journalctl --user -u nanoclaw-v2 | grep -i 'SIGKILL\|panic\|restart'` returns nothing in the shadow window.
- Ollama env propagation verified (semantic audit non-zero output).
- Ops-runbook test: simulate 1 failure per category (disk full, container crash, systemd restart, auditor timeout) and verify diagnosis procedure works.

### Task 4.1: Spin up shadow infrastructure

- [ ] Provision a second Proxmox VM slice (or use existing lab VM). Target: 2 CPU, 4GB RAM, 20GB disk. Do NOT share storage with prod.
- [ ] Clone `feat/v2-migration` branch to the shadow VM.
- [ ] Pair test Baileys number on shadow VM (separate auth dir).
- [ ] Start service.

### Task 4.2: Shadow data (5 days)

- [ ] Daily comparison script:

```bash
#!/usr/bin/env bash
# compare-v1-v2-daily.sh — run from ops machine
SHADOW_DB=/tmp/shadow-snapshot/messages.db
PROD_DB=/tmp/prod-snapshot-latest/messages.db

for db in "$SHADOW_DB" "$PROD_DB"; do
  sqlite3 "$db" "SELECT DATE(timestamp), COUNT(*) FROM messages WHERE timestamp >= datetime('now', '-1 day') GROUP BY 1"
done

# Alert if mismatch > 5%
```

- [ ] Auditor liveness check (journalctl grep) daily.
- [ ] Any non-zero mismatch → stop shadow, investigate, reset 5-day clock.

### Task 4.3: Failure-mode runbook drill

For each scenario in `docs/runbooks/v2-on-call.md`:
- Inject the failure.
- Follow the runbook.
- Measure time-to-recovery.
- Record results.

### Task 4.4: Phase 4 gate

- [ ] 5-day clean run.
- [ ] Runbook drill time-to-recovery <15 min per scenario.
- [ ] User sign-off for fleet cutover.

---

## Phase 5: Fleet Cutover (Weeks 13-15, was 12-14)

**Goal:** Migrate all 28 prod groups to v2 in a single scheduled window with tested 15-minute rollback.

**Strategy (replaces v1 plan's per-group 24h shadow):** Fleet cutover. All 28 groups transition together. The ONLY "shadow" is the Phase 4 test-group run. Per-group shadow is not possible (Baileys auth is shared state).

**Success criteria:**
- Cutover window <2h.
- <5 minute service gap (brief systemctl stop + start + WhatsApp reconnect).
- Zero TaskFlow data loss.
- Kipp audit (next 04:00 run) on full fleet shows pairing rate ≥90%.
- Rollback rehearsed ≤15 min (measured in Phase -1 Task -1.4 + re-verified here).

### Task 5.1: Cutover day T-72h

- [ ] Send PT-BR notification to all 28 groups (template from Phase -1 Task -1.5).
- [ ] Confirm escalation contacts.
- [ ] Fresh prod snapshot + immutable lock.
- [ ] Verify `rollback-to-v1.sh` still works against the new snapshot (dry run).
- [ ] Verify `nanoclaw-agent:v1-rollback` tag still present on prod.

### Task 5.2: Cutover window (recommend Sunday 03:00-05:00 local)

- [ ] **T-0**: `systemctl --user stop nanoclaw` on prod.
- [ ] **T+5min**: run `migrate-v2.sh /home/nanoclaw/nanoclaw/` on prod.
- [ ] **T+15min**: run `scripts/migrate-taskflow-groups.ts`.
- [ ] **T+20min**: run `scheduled_tasks` seeder.
- [ ] **T+25min**: deploy v2 code (`./scripts/deploy.sh` variant for v2).
- [ ] **T+35min**: rebuild container (v2 Dockerfile).
- [ ] **T+45min**: `systemctl --user start nanoclaw`.
- [ ] **T+50min**: verify WhatsApp reconnect; tail logs.
- [ ] **T+60min**: send first test message to each of 3 test groups from our admin phone; verify response.
- [ ] **T+75min**: if any group unreachable → abort, run rollback.
- [ ] **T+90min**: declare success OR declare rollback.

### Task 5.3: Post-cutover monitoring (72 hours)

- [ ] Watch `journalctl --user -u nanoclaw -f` for errors.
- [ ] Daily Kipp audit output check.
- [ ] User-feedback channel monitoring (WhatsApp DMs to admin).
- [ ] Any critical regression → rollback within 15 min.

### Task 5.4: Phase 5 gate

- [ ] 72h clean prod operation.
- [ ] User sign-off for cleanup phase.

---

## Phase 6: Cleanup (Weeks 16-18, was 15-16)

**Phase 6 includes deferred Tier 2 / Tier 3 features from v2.2 evaluation:**
- Composed CLAUDE.md decomposition for `add-taskflow` (or land pre-v2 if completed earlier)
- Cross-board a2a-lite (visible-text MVP per Codex; reuses existing `subtask_requests` + `taskflow_admin({ action: 'handle_subtask_approval' })`)
- Optional: pilot `add-gmail-tool` / `add-dashboard` upstream skills on one board (delta #20)
- Mount allowlist work if Gmail/Calendar adopted (delta #19)
- Retire fork-private `task-scheduler.ts` if Phase 2.5 Task 2.5.6 confirmed v2 primitives suffice

**Goal:** Remove v1 remnants, tag release, update docs.

### Task 6.1: Decommission v1 artifacts

- [ ] Archive v1 code + DBs + image tar to long-term storage.
- [ ] Remove `nanoclaw-agent:v1-rollback` tag 30 days post-cutover (not immediately — rollback insurance).

### Task 6.2: Merge `feat/v2-migration` → `main`

- [ ] Squash + merge. Tag `v2.0.0-nanoclaw-fork`.

### Task 6.3: Update docs + skills + memory

- [ ] `CLAUDE.md`, `docs/REQUIREMENTS.md`, all skill `SKILL.md`.
- [ ] Memory: archive `project_onecli_decision.md` → `_superseded.md`; mark v2-migration project SHIPPED.

### Task 6.4: Final gate

- [ ] Post-mortem: what went right, what should change for the next major migration.

---

## Rollback Procedures

| Phase | Mechanism | Time |
|-------|-----------|------|
| -1, 0 | `rm -rf ../nanoclaw-v2 /tmp/migration-dryrun` | minutes |
| 1 | `git checkout main`; drop feat branch | minutes |
| 2, 3 | Same as Phase 1 | minutes |
| 4 | Stop shadow VM; no prod impact | minutes |
| 5 | `scripts/rollback-to-v1.sh`; MUST be <15 min (rehearsed Phase -1 + Phase 5 Task 5.1) | ≤15 min |
| 6 | Not possible after v1 artifacts archived | N/A |

---

## Out-of-scope / deferred

- Adopting v2's two-DB session split (`inbound.db`/`outbound.db`). Our file-based IPC still works; migrate later.
- Rewriting `src/ipc-plugins/*.ts` (9 files) as `messages_out` system-action MCP tools. Orthogonal to Bun port.
- OneCLI adoption. Native-credential-proxy escape preserves the 1.x decision.
- Consolidating `normalizeForCompare` between auditor + semantic-audit (follow-up from commit `ed52fa7`).
- Second WhatsApp number for production shadow validation. Follow-up project if confidence in Phase 4 test shadow is insufficient.
- Long-term-context skill changes. No evidence of breakage; defer unless shadow run surfaces issues.

---

## Self-review (v2.2)

- **Spec coverage:** Every finding from prior reviews is addressed. v2.2 folds in 9 missed feature areas surfaced by Codex gpt-5.5/high feature evaluation (deltas #12-20) and adds Phase 2.5 (TaskFlow Permissions Adoption) as Codex's #1 recommendation. Three deferred items now live explicitly in Phase 6 (composed CLAUDE.md, a2a-lite, optional new upstream skills).
- **Placeholder scan:** None new. Phase 2.5 has 7 concrete tasks with verifiable gates. PT-BR copy task (2.5.5) flags an open question (fork-private patch vs. CLAUDE.md fragment) — should be resolved at Phase 2.5 entry, not pre-emptively.
- **Timeline realism:** Phase 2.5 adds ~1-2 weeks (Weeks 5-6, partially overlapping Phase 2's tail). Net total: 14-18 weeks full-time. Part-time stretches to 7+ months.
- **Risk ledger:**
  - Highest residual risk: `use-native-credential-proxy` skill v2.0.21-compat UNVERIFIED until Phase 0 Task 0.3. If the skill needs repair (Codex flagged merge-tree conflicts), 1-2 week timeline impact.
  - Second: fleet cutover has a ~2h service window. Cannot be zero. User must accept.
  - Third: scheduled_tasks porting (Phase 3) may discover v2's primitives don't fully cover holiday/weekday-contradiction handling. If Task 2.5.6 spike confirms gap, fork-private `task-scheduler.ts` stays.
  - Fourth: Phase 2.5 user/role seeding depends on TaskFlow's source-of-truth tables having clean data. If `board_people` / `board_admins` have stale rows or duplicate JIDs, the seeder needs a deduplication pass — could add 2-3 days.
  - Fifth: drift continues at ~25 commits/day. Pin baseline at Phase -1 entry.
- **Gate discipline:** Phase -1 (infra), -1.5 (security back-port), 0 (recon), 2.5 (permissions adoption), 4 (shadow), 5 (cutover) each have explicit go/no-go. Phases 1-3 are internal engineering with no prod impact. Phase 6 is reversible only via the 30-day rollback tag retention.
- **Codex priority alignment:** Phase 2.5 lands the #1 recommendation; composed CLAUDE.md is positioned as Phase 6 OR pre-migration v1 stepping stone (separate decision); a2a-lite is Phase 6 with explicit MVP scope (visible-text + existing `handle_subtask_approval`, NOT full structured payload).
- **Out-of-scope discipline:** Deferred items are listed with explicit rationale. No scope-creep during execution.
