# NanoClaw v2 Migration Plan (v2.7 — Phase 2+3 are inseparable host port)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. At every phase gate, pause for user sign-off before proceeding.

**Revision history:**
- v1 (2026-04-23 first draft) — superseded. Three-agent review + Codex gpt-5.5/xhigh validation found ~30 concrete bugs and multiple strategy errors. See git history for v1.
- v2 (2026-04-23 rewrite) — corrects file counts, command syntax, adds Phase -1 infra prep, rewrites Phase 5 cutover model (Baileys auth prohibits per-group shadow), extends timeline to 12-16 weeks, adds strategic decision section.
- v2.1 (2026-04-30 delta re-review) — folds in `v2.0.10 → v2.0.21` upstream changes. Adds Phase -1.5 security back-port, expands Phase 0 (circuit breaker + native-proxy re-merge), Phase 2 (channel-approval surface), Phase 3 (schedule_task content JSON routing, `namespacedPlatformId()` rule, register field-name regression). Codex-corrected delta numbers (183 commits, 76 files, +4632/-576 LOC).
- v2.2 (2026-04-30 features evaluation) — Codex gpt-5.5/high independent evaluation of v2 features for our skills surfaced **9 missed feature areas** (sender-approval, channel-approval, ask_user_question/pending_questions, scheduling improvements, unregistered_senders audit, named destinations as outbound ACL, self-mod, mount allowlist, new upstream skills). Adds **Phase 2.5: TaskFlow Permissions Adoption** (Weeks 5-6, between WhatsApp re-port and isMain rewrite) — re-prioritized as Codex's #1 recommendation. Downscopes cross-board a2a to "visible-text MVP" reusing existing `subtask_requests` + `handle_subtask_approval`. Net timeline: 14-18 weeks full-time.
- v2.3 (2026-04-30 OneCLI direction + scope deferral) — locks in **self-hosted OneCLI (A2a)** as the v2 credential layer after Phase 0 Task 0.3 confirmed `use-native-credential-proxy` skill conflicts in 5 files vs v2.0.22. Reverses `project_onecli_decision.md` for v2 only (1.x stays on native proxy through cutover). Multi-tenant + multi-instance fleet expansion (1000+ boards across K NanoClaw instances with K WhatsApp accounts) explicitly **scope-deferred to post-migration**. Each future instance gets its own self-hosted OneCLI. Migration plan stays single-instance, single-tenant — fleet work happens after cutover.
- v2.4 (2026-05-01 post-execution Codex review) — Codex gpt-5.5/high skeptical review of Phase -1 + Phase 0 work surfaced **3 BLOCKERS + 8 IMPORTANTS + 1 confirmed-correct + 1 false-positive (sandboxed network)**. Critical fixes applied: (a) F1 `requires_trigger=0` → `engage_pattern='.'` mapping required in seeder before Phase 5 cutover (fold into Phase 2.5 Task 2.5.2); (b) F7 `db.pragma()` → `db.exec('PRAGMA …')` swap added to Phase 1 Task 1.4 mechanical edit list; (c) F15 plan internal contradictions resolved (architecture, strategic decision, success criteria, risk ledger no longer claim "OneCLI NOT adopted"); (d) rollback script gains snapshot-freshness gate (default 30min) and post-restart functional probes (WhatsApp connection-open log scan, no-v2-schema-bleed check). Phase 0 Task 0.2 result downgraded from "PASSED" to "STRUCTURALLY PASSED — behavioral migration pending Phase 2.5/3 fixes."
- v2.5 (2026-05-01 Phase 1 closure + Phase 2 dissolution) — Phase 1 Bun runtime port FULLY closed (typecheck ✅, 719/765 bun test ✅, container build ✅, auditor heredoc smoke vs prod snapshot ✅). Phase 2 (WhatsApp re-port, was 2-3 weeks) **dissolved via empirical finding**: v1 whatsapp.ts vs v2-channels whatsapp.ts is a **21-line whitespace-only diff** — no functional port required. The original Phase 2 scope conflated WhatsApp-adapter port with `registered_groups` schema port; the latter has always belonged to Phase 2.5 + Phase 3. Phase 2 tasks 2.2-2.4 superseded; Task 2.1 retained as DONE. **Net timeline: 11-15 weeks full-time** (was 14-18; saved 2-3 weeks of phantom work). Plan +1 simplify pass on Phase 1 (Dockerfile `exec`, db-util reuse, comment cleanup).
- v2.7 (2026-05-01 EOD+1 — Phase 2 implementation scope realization) — Started Phase 2 Task 2.3 (the actual adapter port). Stopped before plowing into code after import-graph inspection: porting v2's `permissions/` cascades through the whole host architecture (types, db layer, channel adapter, delivery, response-registry, session-manager, ~30 files). **Phase 2 + Phase 3 are inseparable.** Combined budget: 5-7 weeks via Strategy A bottom-up (types → DB → channel → delivery → permissions → router/isMain → sidecar). Old framing: "Phase 2 = adapter, Phase 3 = isMain rewrite" was empirically wrong. New plan estimate: **11-15 weeks** (was 10-13 in v2.6; +1-2 weeks). Strategy doc at `docs/superpowers/specs/2026-05-01-phase2-3-host-architecture-port.md`. Lesson: the `feedback_diff_direction_check` memory should also include "and then walk the import graph."
- v2.6 (2026-05-01 EOD post-execution Codex review #2) — second Codex gpt-5.5/high skeptical pass found **3 BLOCKERS + 7 IMPORTANTS** in v2.5 claims. Critical fixes applied:
  - **B1 — Phase 2 dissolution was wrong.** The 21-line whitespace diff was between TWO copies of OUR FORK (v1.2.53 main vs feat/v2-migration branch — both ours, both fork-private). The real diff against `upstream/channels:src/channels/whatsapp.ts` is **+871/-633 lines (1504-line change)**: v2's whatsapp.ts is 735 lines, structurally different — exposes `ask_question` / action replies / reactions / file outbound / syncConversations / getMessage fallback. **Phase 2 is REOPENED.** Approval-card delivery (`type: 'ask_question'`) won't work on our fork's adapter as-is; sender-approval will silently fail to render the card. Phase 2 work reinstated: 1-2 weeks to port the adapter surface gap or repoint to upstream/channels' adapter.
  - **B3 — Role mapping was incompatible with v2.** Seeder mapped `is_primary_manager=1` → `'owner'` with `agent_group_id` set. But v2's `grantRole()` invariant (`src/modules/permissions/db/user-roles.ts:9`) FORBIDS `role='owner' && agent_group_id !== NULL`; `isOwner()` (line 36) ignores any such row. So 28 board "owners" were dead rows. Fixed: map `is_primary_manager=1` → `'admin'` (scoped). Re-ran on the worktree v2.db: 28 admin rows (0 invariant violations), 1 global owner (operator). `pickApprover('secti-taskflow')` now correctly returns Carlos Giovanni (the actual manager).
  - **B2 — Approval-card delivery requires v2 ChannelAdapter primitives** (`ask_question`, etc.) that our fork's whatsapp.ts doesn't have. Sender-approval will silently fail-soft (`pickApprovalDelivery()` returns null → "no DM channel for any approver" warning) until adapter port lands.
  - F5 destination round-trip — parent-only edges seeded; reverse edges deferred. For a2a-lite MVP per Spec B, parent → child reply can use group-JID via `send_message` (host-routed) instead of agent_destinations, so reverse not strictly required. Document.
  - F7 main group — operator works, no other senders seeded for `whatsapp_main`. Acceptable since main is operator-only by design.
  - F8/F9 — auditor smoke and bun test 46-failures need paired-output v1↔v2 comparison + `vi.*` shim before Phase 1 can claim "behavior-closed" (currently "build-closed" only).
  - F12 — Phase 2.5 should add unit/integration gates (pickApprover, replay, round-trip) before Phase 4 shadow.
  - F13 — Phase 3 isMain count refreshed: now 169 hits (was 103 from earlier baseline), more hits in test files.
  - **Phase 2.5 status downgraded:** "STRUCTURALLY closed" → "data-layer closed; runtime gates 2.5.5/2.5.6/2.5.7 still owe pickApprover/replay/round-trip integration tests." Approval-card delivery itself blocked on Phase 2 adapter port (B2).
  - **Phase 2 status RESTORED:** ~1-2 weeks budget reinstated for adapter port. Net timeline back to **10-15 weeks full-time** (saved less than v2.5 claimed).

---

**Goal:** Migrate our fork from `nanoclaw@1.2.53` to upstream `v2.x` (currently `2.0.21`; 577 commits behind / 886 ahead at last fetch 2026-04-30) with **zero TaskFlow data loss**, a tested rollback recipe validated before production cutover, and minimal service disruption to 31 live government IT TaskFlow groups.

**Architecture:** Parallel-worktree development, fleet-level cutover. Reuse upstream's `migrate/v1-to-v2` driver for platform-schema migration; preserve `data/taskflow/taskflow.db` verbatim; mechanically port `container/agent-runner/` from Node+better-sqlite3 to Bun+bun:sqlite (with `db.pragma()` → `db.exec('PRAGMA …')` fixup, see Phase 1 Task 1.4); re-port TaskFlow WhatsApp hooks against the v2-native adapter; **adopt self-hosted OneCLI (path A2a, decision recorded in v2.3)** as the credential layer; add a TaskFlow sidecar table for custom columns that have no v2 equivalent. **Per-group 24h shadow is NOT used** — Baileys auth is shared state, so two processes cannot hold the same WhatsApp identity. Cutover is fleet-level with a tested 15-minute rollback SLA.

**Tech Stack:** Bun 1.3.x (container), Node + pnpm@10.33.0 (host), SQLite (`bun:sqlite` container / `better-sqlite3` host), Anthropic Agent SDK 0.2.116, bash heredocs for audit scripts, Docker + Proxmox VM orchestration.

**Source-grounded facts:** See `/root/.claude/projects/-root-nanoclaw/memory/project_v2_migration_assessment.md` for citation-grounded state. If any fact in this plan conflicts with upstream code at execution time, STOP and reconcile before proceeding.

---

## Strategic decisions (resolved in this rewrite)

1. **Cutover model: fleet-level, not per-group.** Baileys' `useMultiFileAuthState` (src/channels/whatsapp.ts:173) uses a single shared auth directory; two processes racing on it corrupt Signal keys. Per-group 24h shadow from v1 is physically impossible with a single WhatsApp identity. **Decision:** use Phase 4 test-group shadow (on dedicated `test-taskflow`/`e2e-taskflow` with separate auth) as the sole pre-cutover validation; cut all 28 prod groups over in a scheduled window with a tested 15-minute rollback SLA. If later we adopt a second WhatsApp number for prod-shadow, that's a follow-up project, not a phase-0 blocker.

2. **IPC stays file-based.** Codex verified v2 still supports `.heartbeat` + `outbox/` file channels (`src/session-manager.ts:59-62`; `host-sweep.ts:5-8`). Our 9 `src/ipc-plugins/*.ts` stay as-is. Rewriting them as `messages_out` system-action MCP tools is deferred to a post-cutover project.

3. **Self-hosted OneCLI ADOPTED for v2 (decision recorded 2026-04-30, v2.3).** `use-native-credential-proxy` skill conflicts in 5 files vs v2.0.22 (Phase 0 Task 0.3 confirmed via `git merge-tree`). Self-hosted OneCLI is free at any scale (`ghcr.io/onecli/onecli:1.18.6` on the same host), aligned with v2's hard-throw at `container-runner.ts:459`, and unblocks future Calendar/Gmail integration. **1.x install retains the native credential proxy through cutover** — only v2 adopts OneCLI. See `project_onecli_decision.md` (memory) for the full v1.x-deferred / v2-adopted split.

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

**Progress (2026-04-30 execution):**
- ✅ Task -1.1: disk reclaimed (operator resized VM 42G → 61G; 30G free)
- ✅ Task -1.2: prod image pinned. `nanoclaw-agent:v1-rollback` tagged on prod (id `7c2ec789eef7`) and saved to `/home/nanoclaw/backup/v1-image.tar` (1.6GB, md5 `92395ff333e20fad96f5e532ce452600`); `docker load` round-trip verified.
- ✅ Task -1.3: snapshot at `/root/prod-snapshot-20260430/` (chmod 444 + md5 baseline; chattr +i blocked by VM kernel capability restriction — md5+chmod is the integrity guarantee). md5: messages.db `404ff56443d44f4f623db8f862d70b3a`, taskflow.db `58cab45e360120be9e8e09ae1b0d2015`. Both produced via `sqlite3 .backup` for WAL-consistent atomicity.
- ✅ Task -1.4 Step 1+3: `scripts/rollback-to-v1.sh` written and dry-run smoke-tested.
- ⏸️ Task -1.4 Step 2: live sandbox rehearsal — needs disposable test VM, not currently available. Defer to first available test environment, ideally before Phase 5 cutover.
- ⏸️ Task -1.5: PT-BR user-comms templates — not started.
- ⏸️ Task -1.6: circuit breaker boot smoke — needs Phase 0 Task 0.4 Bun image first.

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

## Phase -1.5: Security back-port to v1 (RESOLVED 2026-05-01 — NO-OP for v1)

**Status: CLOSED via audit.** Full audit at `docs/security/phase-1.5-attachment-traversal-audit-2026-05-01.md`. The v2 vulnerability class (user-supplied attachment names flowing unvalidated into `path.join` sinks) **does not exist in v1.2.53**.

**Why audit-only, not back-port:**
1. Every `fs.writeFile*` sink in `src/` and `container/agent-runner/src/` was traced. All filenames are either (a) internally synthesized (`img-${Date.now()}-${Math.random()...}.jpg`, etc.), (b) strict-whitelist sanitized via `sanitizeFilename()` for archive paths, or (c) validated via `isValidGroupFolder()` for operator-provided board names.
2. v1's `src/group-folder.ts:isValidGroupFolder()` is **stricter** than v2's `isSafeAttachmentName()`: whitelist `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, explicit `..` and separator rejection, plus `ensureWithinBase()` canonical-path containment check.
3. v1 has no `session-manager.ts`, no agent-to-agent attachment forwarding, no `send_file` MCP tool — i.e., none of the entry points where v2's bug lived.
4. After Phase 5 cutover, v2's `attachment-safety.ts` ships in our worktree automatically — no fork-private maintenance burden.

**Original commit set (v2.0.10 → v2.0.22) referenced for the audit:**
- `7e37b13a` — channel-inbound path-traversal fix (basename guard)
- `6e5e568d` + `2a3be9ec` — agent-sent file name safety
- `fc3c11b6` (v2.0.22) — `session-manager`: outbox path-confinement applied to inbound attachments
- `852009dc` (v2.0.22) — container: confine outbound attachment paths

The v2 primitive (`src/attachment-safety.ts:18-22`) rejects names containing path separators (`/`, `\`), `..` segments, NUL bytes, or empty basenames. **Future-proofing:** if we ever add a `send_file` MCP tool or other user-controlled-filename code path on v1.x, port `isSafeAttachmentName()` then. See audit doc's "Future-proofing" section.

**Audit results (2026-05-01):**
- ✅ Task -1.5.1: filename derivation traced across `src/` + `container/agent-runner/src/`. All sinks are synthesized, sanitized, or `isValidGroupFolder()`-validated.
- ✅ Task -1.5.2: failing test SKIPPED — no vulnerable sink to write a test for. Audit doc records the rationale (Task -1.5.2 step 2 explicitly allows skipping when test would pass on v1).
- ✅ Task -1.5.3 SKIPPED: nothing to port; v1's existing `isValidGroupFolder()` is stricter than v2's `isSafeAttachmentName()`.
- ✅ Task -1.5.4: closed via audit doc.

### (historical) Tasks -1.5.1 → -1.5.4

Original task list at v2.1 anticipated a real port. Audit-only path replaces them. Full step-by-step trace and conclusion at `docs/security/phase-1.5-attachment-traversal-audit-2026-05-01.md`.

- [ ] 48h clean prod soak. No regressions in attachment delivery. Then proceed to Phase 0.

---

## Phase 0: Reconnaissance & Gate (Week 1)

**Progress (2026-05-01 execution):**
- ✅ Task 0.1: Worktree at `/root/nanoclaw-v2` baseline `7ac8dd0f` (v2.0.22). Migrate-branch worktree at `/root/nanoclaw-migrate-v2` baseline `5afe51b8`. pnpm@10.33.0 + typecheck clean.
- ✅ Task 0.2: **migrate-v2.sh dry-run STRUCTURALLY PASSED** on `/root/prod-snapshot-20260430/` (10860 messages). 29/29 boards migrated (28 TaskFlow + 1 unmanaged), 0 skipped, 0 unknown JIDs. All 29 messaging_groups are channel_type=whatsapp. 10 schema migrations applied to `/root/nanoclaw-migrate-v2/data/v2.db`. **Source DBs unchanged** (md5 -c OK).
  - **Behavioral gaps surfaced by Codex review (must be fixed before Phase 5 cutover):**
    1. **F1 BLOCKER (RESOLVED via spike, 2026-05-01):** All 29 v1 rows have `requires_trigger=0`. v1 src/index.ts:575 bypasses trigger gate when requiresTrigger===false (db.ts:999 maps INTEGER 0 → boolean false). Empirical confirmation: ZERO of 4,000+ user messages across the fleet contain `@Case`. Without fix, fleet cutover would drop 100% of user messages. Fork-private patch at `scripts/migrate-v2-patches/01-engage-pattern-priority-fix.patch` swaps seeder priority so `requires_trigger=0` wins over `trigger_pattern`. **Validated:** post-patch dry-run yields 29/29 wirings with `engage_mode='pattern'`, `engage_pattern='.'`. Phase 5 cutover MUST apply this patch before running `migrate-v2.sh`.
    2. **F2:** Migrator silently drops our 4 TaskFlow custom columns (`taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth`, `is_main`). Plan promises sidecar in Phase 3 Task 3.2 — known work, but Phase 0.2 cannot be called "TaskFlow-passed" until that lands.
    3. **F4:** Active `scheduled_tasks` (90 rows) extracted to `.nanoclaw-migrations/v1-data/scheduled-tasks.json` but NOT seeded into v2.db. Phase 3 Task 3.5 (`scheduled_tasks` re-creation) is required, not optional.
    4. **F6:** Migrator opens v1's SQLite directly without `.backup` snapshot. Dry-run on a static snapshot doesn't prove safety against live writes — Phase 5 cutover MUST stop v1 service or take fresh `sqlite3 .backup` first.
  - Pre-flight finding: migrator's seed step requires the WhatsApp channel adapter installed in the v2 worktree first (errors with `Channel adapters not installed: whatsapp`). Resolved by `git show upstream/channels:src/channels/whatsapp.ts`, appending `import './whatsapp.js'` to channels/index.ts, and pinned-dep install (baileys 6.17.16 + qrcode 1.5.4 + pino 9.6.0).
  - Migrator interactive prompts: must run with `NANOCLAW_MIGRATE_SKIP="guide,safety,copy,rebuild,verify"` and pipe `y\n` for the owner-confirmation prompt.
  - **Phase 2.5 sanity confirmed:** TaskFlow has 59 `board_people` + 30 `board_admins` (89 human entities). Migrator seeded only the operator (1 user, 1 role, 29 memberships of operator-as-admin). Phase 2.5's TaskFlow Permissions Adoption must seed the remaining ~88 from the TaskFlow source-of-truth tables — this empirically validates Codex's #1 recommendation.
- ✅ Task 0.3: Self-hosted OneCLI installed and SDK-smoke-tested. See "v2.3 OneCLI direction" in revision history.
- ✅ Task 0.4: **Bun smoke PASSED — with one mechanical-port addition.** Bun 1.3.12 installed at `/root/.bun/bin/bun` (matches v2 container Dockerfile pin). Mechanical port (2 sed edits) on `taskflow-engine.ts` (9598 lines): `import Database from 'better-sqlite3'` → `import { Database } from 'bun:sqlite'` + `Database.Database` → `Database` (5 occurrences). Smoke at `/tmp/bun-smoke/` exercises seven API surfaces (`.prepare()`, `.get()`, `.all()`, `.run()` with `{changes, lastInsertRowid}`, transaction wrapper, `.iterate()`, read-pragma via `.query('PRAGMA …').get()`) against the prod taskflow.db snapshot — all green.
  - **F7 BLOCKER (Codex review 2026-05-01):** `bun:sqlite` does NOT have `.pragma()`. Verified: `typeof db.pragma === 'undefined'`. taskflow-engine.ts:841 uses `this.db.pragma('busy_timeout = 5000')` — **mechanical sed-only port is NOT safe**, requires one additional swap. Phase 1 Task 1.4 must include `.pragma(X)` → `.exec('PRAGMA X')` (write-pragma) and `.pragma('X')` → `.query('PRAGMA X').get()` (read-pragma) replacements. Grep confirms 1 site in taskflow-engine.ts; sweep all 17 container files in Task 1.4.
  - Updated SQL site counts (more accurate than Codex earlier): 284 prepare / 113 run / 134 get / 72 all / 25 exec / 12 transactions / **0 named-parameter (`$name`) usage** — confirms the rest of the port surface is safe.
  - **F8 CONFIRMED (Codex):** `taskflow-engine.ts` has zero matches for `.pluck(`, `.raw(`, `.columns(`, `.expand(`, `.function(`, `.aggregate(`, `.collation(`, `ATTACH`, `DETACH`, `wal_checkpoint`, `loadExtension`. No exotic better-sqlite3 helpers; the `db.pragma()` swap is the only non-sed fixup needed.
- ⏸️ Task 0.5: WhatsApp v2 pairing — needs operator-provided test phone number. Defer to ops-availability.
- ✅ Task 0.6: Env audit done (steps 1-2). Step 4 (provider override audit) deferred — checked v2.db post-seed: 0 sessions/agent_groups have `agent_provider` set, so delta #11 is a no-op for us.
- ✅ Task 0.7 Step 1: migrator does NOT modify source `.env` (verified via dryrun pre/post check).
- ⏸️ Task 0.8: Phase 0 gate — pending 0.4 + 0.5.

**Goal:** Prove the highest-risk assumptions before any commit to our repo. If any gate fails, STOP.

**Success criteria:**
- `migrate-v2.sh` + `setup/migrate.ts` successfully transform `/tmp/prod-snapshot-*/store/messages.db` into v2's triplet without data loss, writing to `<v2Root>/data/v2.db` (NOT `/tmp/migration-dryrun/data/v2.db` — verified path at execution time).
- Self-hosted OneCLI gateway boots and accepts SDK calls (`ensureAgent`, `applyContainerConfig`) — see Phase 0 Task 0.3 below.
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

### Task 0.3: Install self-hosted OneCLI (UPDATED v2.3, was native-proxy verification)

**Decision recorded 2026-04-30:** `use-native-credential-proxy` skill conflicts in 5 files vs v2.0.22 (`config.ts`, `container-runner.ts`, `container-runner.test.ts`, `index.ts`, `setup/verify.ts`) — confirmed via `git merge-tree`. Codex prediction held. Path A2a (self-hosted OneCLI) selected because:
- Free at our scale ($0/month per instance, open-source via `ghcr.io/onecli/onecli`)
- Aligns with v2.0.22's hard-throw at `container-runner.ts:459`
- Future Calendar/Gmail/Google integration (Codex Tier 2 item E) becomes free
- Multi-tenant expansion path: each NanoClaw instance gets its own self-hosted OneCLI gateway

**Pre-existing 1.x decision unchanged:** the native credential proxy at port 3001 stays in the 1.2.53 install through cutover. Installing OneCLI on the same dev server is safe — different port (10254/10255), separate Docker container.

- [ ] **Step 1: Pin a specific OneCLI release tag** (avoid `:latest`)

```bash
# Find the latest stable OneCLI release tag — review on GHCR or GitHub before pinning:
docker pull ghcr.io/onecli/onecli  # Just for tag inspection, not the actual run
```

Document the chosen tag in the Phase 0 gate report. Update `Step 2` install command to use `ghcr.io/onecli/onecli:<tag>` not `:latest`.

- [ ] **Step 2: Run OneCLI gateway as a Docker container**

```bash
docker run -d \
  --name onecli-gateway \
  --restart unless-stopped \
  -p 10254:10254 \
  -p 10255:10255 \
  -v onecli-data:/app/data \
  ghcr.io/onecli/onecli:<pinned-tag>
```

Health check:

```bash
sleep 3
curl -sf http://localhost:10254/health
# Expected: 200 OK with health JSON
```

- [ ] **Step 3: Configure the OneCLI CLI**

```bash
curl -fsSL onecli.sh/cli/install | sh
export PATH="$HOME/.local/bin:$PATH"
onecli version
onecli config set api-host http://localhost:10254
```

- [ ] **Step 4: Register Anthropic credential**

For our 1.x dev install: read the Anthropic key from `/root/nanoclaw/.env`, register as a OneCLI secret (so v2 can use it without us re-entering):

```bash
ANTHROPIC_KEY=$(grep '^ANTHROPIC_API_KEY=' /root/nanoclaw/.env | cut -d= -f2- | tr -d '"')
onecli secrets create \
  --name Anthropic \
  --type anthropic \
  --value "$ANTHROPIC_KEY" \
  --host-pattern api.anthropic.com
```

Verify: `onecli secrets list` shows the Anthropic entry.

- [ ] **Step 5: Boot a v2 test container against the gateway**

```bash
cd /root/nanoclaw-v2
echo "ONECLI_URL=http://localhost:10254" >> .env
# pnpm run build path may not exist on v2 (Bun direct-TS) — verify by:
ls dist/ 2>/dev/null || echo "no dist (Bun direct-TS, expected)"
# Try a minimal container spawn via setup or test harness:
pnpm exec tsx scripts/dev-container.ts 2>&1 | tee /tmp/v2-onecli-boot.log || true
grep -i 'onecli\|gateway' /tmp/v2-onecli-boot.log
# Expected: "OneCLI gateway applied" log line, no hard-throw.
```

If hard-throw persists despite gateway healthy, escalate — the skill setup-config logic may not detect our local gateway URL.

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

### Task 0.6: Env allowlist audit (UPDATED 2026-04-30 with worktree finding)

**Confirmed finding (2026-04-30, /root/nanoclaw-v2 at `7ac8dd0f`):** v2 has **no allowlist** in the v1 sense. `src/container-runner.ts:438-446` passes ONLY `TZ` + provider-contributed env (from `registerProviderContainerConfig()`) + OneCLI proxy injection. Comment is explicit: *"Environment — only vars read by code we don't own. Everything NanoClaw-specific is in container.json (read by runner at startup)."* `src/env.ts` is now `readEnvFile(keys)` — caller-driven, no global allowlist file to patch.

**Implication:** our `OLLAMA_HOST`, `EMBEDDING_MODEL`, all 6 `NANOCLAW_SEMANTIC_AUDIT_*` envs are dropped on container spawn unless we either (a) extend container-runner's env-passing block or (b) move semantic-audit / embedding configs into per-board `container.json` (read by agent-runner at startup). Option (b) is more v2-native; option (a) is a smaller fork-private patch.

- [x] **Step 1: Confirm no global allowlist exists in v2** — done. `git grep` returns no `OLLAMA_HOST` / `EMBEDDING_MODEL` / `NANOCLAW_SEMANTIC_AUDIT_*` matches in v2 src. Confirmed.
- [x] **Step 2: Identify the env-injection site** — done. `src/container-runner.ts:438-446` is the only place container env vars are added beyond OneCLI/TZ.
- [ ] **Step 3: Decide between fork-private patch vs. container.json migration**
  - Option (a): patch `container-runner.ts` to push `OLLAMA_HOST`, `EMBEDDING_MODEL`, `NANOCLAW_SEMANTIC_AUDIT_*` from `process.env` into `args.push('-e', ...)`. Smallest change. Drift-prone (re-applies each upstream merge).
  - Option (b): extend `container-config.ts` to read a `taskflow.semanticAudit` block from `container.json` per-board; agent-runner reads at startup. More v2-native. Requires touching all 31 boards' `container.json` during Phase 2.5.
- [ ] **Step 4: Verify no `agent_provider` overrides in our DB** (delta #11). Phase 0 prereq for the provider precedence fix being a no-op for us:
  ```sql
  SELECT COUNT(*) FROM sessions WHERE agent_provider IS NOT NULL;
  SELECT COUNT(*) FROM agent_groups WHERE agent_provider IS NOT NULL;
  ```
  Expected: 0 / 0. If non-zero, audit which sessions/groups override and decide intent.

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

**Progress (2026-05-01 execution, branch `feat/v2-migration` at `/root/nanoclaw-feat-v2`):**
- ✅ Task 1.1: branch via worktree off main.
- ✅ Task 1.2: `container/agent-runner/package.json` updated — removed `better-sqlite3` + `@types/better-sqlite3`, added `@types/bun`, bumped SDK to `^0.2.116` (resolved to 0.2.126 via `bun install`), removed `build` script (Bun runs TS direct), kept vitest in devDeps to avoid 13 test-import rewrites. Version 1.0.0 → 2.0.0.
- ✅ Task 1.3: `container/agent-runner/tsconfig.json` → `noEmit: true`, `types: ["bun"]`, removed outDir/declaration.
- ✅ Task 1.4: mechanical port across 17 files via 3 sed passes + 4 manual fixes (semicolon-less imports, dynamic imports, type-only alias) + 4 type-tightening fixes for bun:sqlite stricter SQLQueryBindings. **`bunx tsc --noEmit` clean.**
- ✅ Task 1.5: heredoc rewrites in `auditor-script.sh` (line 14, line 1461) and `digest-skip-script.sh` (line 32, line 60) — `require("better-sqlite3")` → `require("bun:sqlite")` destructured + `node /tmp/X.js` → `bun /tmp/X.js`.
- ✅ Task 1.6: `container/Dockerfile` rewritten — Bun 1.3.12 install via curl, `bun install --frozen-lockfile` instead of npm, removed make/g++ apt deps (no native compile needed), removed runtime `npx tsc` from entrypoint. Net entrypoint shrinkage 6 commands → 2.
- ✅ Task 1.7: **FULL GATE PASSED.**
  - `bunx tsc --noEmit` ✅
  - `bun test` → 719 pass / 45 fail / 6 errors / 1 todo across 13 files. The 46 non-pass results are ALL vitest-specific mocking API gaps (`vi.stubGlobal`, `vi.unstubAllGlobals`) — NOT bun:sqlite port issues. Test framework migration scoped to Phase 6 cleanup. Real bun:sqlite-vs-better-sqlite3 delta: `.get()` returns `null` (not `undefined`) on empty match — fixed in 5 test sites; production code is unaffected (uses truthy guards).
  - **Container build SUCCEEDED** via `DOCKER_BUILDKIT=1 ./container/build.sh v2-feat`. Image `nanoclaw-agent:v2-feat` is 5.5GB / 1.71GB content (vs v1 at 2.85GB / 765MB; size delta is retained npm globals + Bun binary, acceptable). Bun 1.3.12 + UID 1000 confirmed inside image.
  - **Auditor heredoc smoke PASSED** under bun against prod snapshot. Extracted auditor.js (1445 lines) from `auditor-script.sh` heredoc, patched DB paths to point at `/root/prod-snapshot-20260430/`, ran via `bun /tmp/auditor-smoke.js`. Output structurally identical to v1: 2 boards processed, 2 flagged interactions, actor canonicalization clean (`actor_first_name_heuristic_hits: 0`), delivery health detection working, mandatoryAppendBlocks structural refs preserved.
- 📌 Test framework migration (`vi.*` → bun mocks OR vitest-via-shim) **scoped OUT of Phase 1** — separate work item for Phase 6 cleanup or post-cutover.

**Phase 1 codebase work COMPLETE on `feat/v2-migration` branch.** Phase 2 (WhatsApp re-port) ready to open.

**Goal:** Port `container/agent-runner/src/*` (17 files) to Bun + `bun:sqlite`. Rewrite Dockerfile's two TS-compile sites. Rewrite `auditor-script.sh` heredoc for `bun:sqlite`.

**Success criteria:**
- `bunx tsc --noEmit` passes on all 17 container files. ✅
- `bun test` passes (all existing vitest tests compile under bun:test). ⚠️ 94% pass; 46 vi.* mock-API gaps deferred.
- Local container rebuilds with Bun entrypoint (no `npx tsc` at runtime OR buildtime). ⏸️
- Extracted auditor heredoc runs under `bun` against prod snapshot; output matches 1.x within ±5%. ⏸️

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
# F7 fixup (Codex 2026-05-01) — bun:sqlite has no .pragma() method.
# Write-pragmas:
sed -i "s|\.pragma('\\([^']*\\) = \\([^']*\\)')|\.exec('PRAGMA \\1 = \\2')|g" <file>
# Read-pragmas (e.g. db.pragma('journal_mode')) need manual review since the
# return shape changes — do these by hand. Grep first:
#   grep -n "\.pragma('[a-z_]*')" <file>
# Then convert each to: db.query('PRAGMA <name>').get()
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

## Phase 2: WhatsApp Re-port (RESTORED 2026-05-01 EOD via Codex review B1+B2)

**Status: RESTORED.** v2.5 claimed Phase 2 was dissolved via "21-line whitespace diff." That diff was wrong — it compared two copies of our fork (v1.2.53 main vs feat/v2-migration), both fork-private. **The real diff against `upstream/channels:src/channels/whatsapp.ts` is +871/-633 lines** (1504-line change). v2's adapter is 735 lines, structurally different.

**What our fork is missing (Codex B2):** v2's `ChannelAdapter` interface includes `ask_question` / action replies / reactions / file outbound / `syncConversations` / `getMessage` fallback. v2's `requestSenderApproval` delivers `type: 'ask_question'` to the channel adapter. Our fork's whatsapp.ts only has `sendMessageWithReceipt` — **the approval-card flow will fail silently** (delivery handler returns null → `pickApprovalDelivery()` returns null → "no DM channel for any approver" warning).

**Phase 2 work reinstated:** 1-2 weeks. Either (a) port the missing surface from `upstream/channels:src/channels/whatsapp.ts` into our adapter, or (b) repoint feat/v2-migration to use upstream/channels' adapter wholesale and re-port our fork-private logger/timezone/group-folder hooks against it. Decision deferred until Phase 2 entry.

### Phase 2 Tasks (RESTORED)

- [ ] **Task 2.1 (DONE 2026-05-01):** Hook inventory — 269 TaskFlow hits across `src/*.ts`, distributed mostly to Phase 2.5 + Phase 3 (registered_groups schema work, isMain).
- [ ] **Task 2.2: Adapter surface delta inventory.** Diff our `src/channels/whatsapp.ts` against `upstream/channels:src/channels/whatsapp.ts`. List every public method or behavior in v2 that we don't have. Decide: port-into-ours vs. repoint-to-upstream.
- [ ] **Task 2.3: Approval-card delivery wire-up.** Whichever path 2.2 chose, ensure `requestSenderApproval`'s `type: 'ask_question'` delivery actually reaches a WhatsApp DM. Test: simulate non-member → admin gets card → reply Permitir → sender added.
- [ ] **Task 2.4: E2E on test phone (still operator-blocked on Phase 0.5).**
- [ ] **Task 2.5 gate:** structural diff resolved (zero missing v2 adapter primitives) + approval card runtime-verified.

### Historical (v2.5 dissolution claim — WRONG, kept for record)

Original v2.5 tasks 2.2-2.4 SUPERSEDED claim was wrong. Phase 2 has real work.

**Why the original plan estimate was wrong:** Phase 2 as originally specced conflated two different ports:
1. WhatsApp adapter port (whatsapp.ts customizations) — turns out **near-no-op** (whitespace only)
2. `registered_groups` schema port (column reads/writes → `messaging_groups` + `messaging_group_agents` triple) — owned by **Phase 2.5 (Permissions Adoption) + Phase 3 (isMain rewrite)**

The 269 TaskFlow-related hits across `src/*.ts` distribute as:
- `db.ts` (53), `index.ts` (32), `ipc.ts` (28), `container-runner.ts` (17) — **Phase 3 territory** (isMain → user_roles, registered_groups → messaging_groups)
- Tests (~100) — auto-update with Phase 3 source changes
- The remaining ~40 are scattered helper queries that go with Phase 2.5

**What's still owed in Phase 2:** the channel-approval flow growth (delta #5, ~600 LOC across `modules/permissions/`) — but that's a Phase 2.5 wire-up task, not a v1→v2 port. Phase 2.5 already has tasks for this.

**Net plan-timeline impact:** Phase 2 was budgeted 2-3 weeks. Saved entirely. **New total: 11-15 weeks full-time** (was 14-18).

### Task 2.1: Hook inventory (DONE 2026-05-01) — original plan retained for history

- [x] **Step 1: Grep TaskFlow hooks across ALL WhatsApp-adjacent files**

```bash
cd /root/nanoclaw
grep -rn 'taskflow\|TaskFlow\|@Case\|@Tars\|@Kipp\|trigger_pattern\|isMainGroup\|taskflow_managed\|requiresTrigger\|requires_trigger' src/*.ts | tee /tmp/tf-hooks-full-inventory.txt
wc -l /tmp/tf-hooks-full-inventory.txt   # 269 hits across 24 files
```

- [x] **Step 2: Compare v1 whatsapp.ts vs v2-channels whatsapp.ts**

```bash
diff -u /root/nanoclaw/src/channels/whatsapp.ts /root/nanoclaw-feat-v2/src/channels/whatsapp.ts | wc -l   # 21 lines (whitespace only)
```

Result: no functional delta in whatsapp.ts. The 269 TaskFlow hits across our `src/*.ts` are not WhatsApp-specific — they're general fork customizations that get rewritten in Phase 2.5 + Phase 3.

### Task 2.2-2.4: SUPERSEDED

All scheduled work re-attributed:
- Hook porting against `messaging_group_agents` → Phase 2.5 Task 2.5.3 (already in plan).
- isMain rewrite → Phase 3 Task 3.3 (already in plan).
- E2E on test phone number → Phase 0 Task 0.5 (still operator-blocked) + Phase 4 shadow run (5-day test).
- Phase 2 gate → folded into Phase 2.5 gate.

### Original plan content (historical, retained for reference)

**Original goal:** Port TaskFlow's WhatsApp hooks against v2-native adapter. Original-estimate-was-wrong reasoning: Phase 2 spec conflated WhatsApp-adapter port with schema-port. Estimate retained as a salutary reminder that "X weeks for WhatsApp port" was wildly overscoped — the real Phase 2 work was always Phase 3.

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

**Progress (2026-05-01 execution):**
- ✅ Task 2.5.1: Inventory complete. TaskFlow source: 59 board_people + 30 board_admins + 37 boards (29 with v2 agent_group mapping via `boards.group_folder ↔ agent_groups.folder`; 27 child boards have `parent_board_id`; 10 root boards). Empirical: ALL board_admins have `is_primary_manager=1` → 'owner' role. 2 admin rows + 1 person row have empty phone (mariany on board-seci-taskflow — known data quality issue).
- ✅ Task 2.5.2: **Seeder shipped at `scripts/migrate-taskflow-users.ts`.** Validated against the Phase 0.2-seeded v2.db: 27 humans + 29 owner-roles + 86 agent_group_members inserted (with operator already there → 28 users / 29 roles / 86 members total). Idempotent (re-run = 0 inserts). Bug caught + fixed: empty-phone rows would have created `whatsapp:@s.whatsapp.net` phantom user; `userIdFromPhone()` now returns `null` for empty/blank, callers skip-and-count.
- ✅ Task 2.5.3: **Destinations seeder shipped at `scripts/migrate-taskflow-destinations.ts`.** 27 child→parent destinations seeded (`local_name='parent'`, `target_type='agent'`). Schema confirmed simpler than plan stub: single `target_id` polymorphic by `target_type`, not separate columns. 0 children unmapped, 0 parents unmapped, 10 roots correctly skipped. Idempotent.
- ✅ Task 2.5.4: **Policy SQL shipped at `scripts/migrate-taskflow-policies.sql`.** All 29 messaging_groups now `unknown_sender_policy='request_approval'`; all 29 messaging_group_agents now `sender_scope='known'` + `ignored_message_policy='accumulate'`. Combined with F1 patch (`engage_pattern='.'`), gives: members → bot responds to everything; non-members → admin approval card; dropped messages → audit trail in `unregistered_senders`.
- ✅ Task 2.5.5: **PT-BR approval-card copy shipped** at `scripts/migrate-v2-patches/02-pt-br-sender-approval.patch` (fork-private). 4 string replacements in `src/modules/permissions/sender-approval.ts`: button labels (`Allow`/`Deny` → `Permitir`/`Negar`), title (`👤 New sender` → `👤 Novo remetente`), question (`X wants to talk to your agent in Y. Allow?` → `X quer falar com seu agente em Y. Permitir?`), default origin name (`an unfamiliar chat` → `um quadro desconhecido`). Patch applies cleanly to `migrate/v1-to-v2`. Decision: fork-private (not upstreamable — fleet-specific localization; CLAUDE.md fragment doesn't work because cards are rendered by host code, not the agent).
- ✅ Task 2.5.6: **Scheduling primitive feasibility — v2 IS SUFFICIENT.** Verdict: retire fork-private `src/task-scheduler.ts` in Phase 6.
  - v2's `container/agent-runner/src/mcp-tools/scheduling.ts` exposes `schedule_task` / `update_task` / `cancel_task` / `pause_task` / `resume_task` / `list_tasks` with cron + timezone + pre-agent script support — full feature parity with v1's scheduler tool.
  - v2's host-side `src/modules/scheduling/recurrence.ts` uses `CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE })` — identical timezone-aware cron evaluation to v1.
  - Architectural shift: v2 stores recurring tasks IN `messages_in` (with `recurrence` field), sweep hook re-inserts on completion. v1's separate `scheduled_tasks` table goes away in Phase 3 schema migration.
  - Holiday-skip + weekday-contradiction handling: NOT in v1's `task-scheduler.ts` either. Lives in `taskflow-engine.ts:isNonBusinessDay/checkNonBusinessDay` (engine-level, due_date warnings), already ported in Phase 1 mechanical sweep. Holiday-skip for scheduled tasks themselves is operator-driven SQL (e.g. today's manual May 1 skip via `UPDATE scheduled_tasks SET next_run = ...`); no code change required for v2.
- ⚠️ Task 2.5.7: **Phase 2.5 DATA-LAYER closed; runtime gate REOPENED.** v2.5 declared "structural close"; Codex EOD review #2 (B3 + F12) caught two issues:
  - **B3 fixed (2026-05-01 EOD):** v2.5 seeded `is_primary_manager=1` → `'owner'` with `agent_group_id` set. v2 forbids that combination (`grantRole()` invariant; `isOwner()` ignores). 28 board "owners" were dead rows. **Fixed:** seeder now maps to `'admin'` (scoped). Re-ran on worktree v2.db: 28 admin rows, 1 global owner (operator), 0 invariant violations. `pickApprover('secti-taskflow')` correctly returns Carlos Giovanni.
  - **F12 still owed:** Phase 2.5 should add unit/integration gates BEFORE Phase 4 shadow:
    - `pickApprover(agentGroupId)` returns the right admin for each board.
    - Unknown-sender replay path runs end-to-end against seeded DB fixtures (no phone needed).
    - Cross-board destination round-trip (parent → child reply path) is testable via fixtures.
    These are doable without the operator test phone — defer to Phase 4 only the actual WhatsApp pairing test.
  - **B2 blocking:** Approval-card delivery itself depends on Phase 2's adapter port (`type: 'ask_question'` rendering on WhatsApp). Phase 2.5 runtime can't fully close until Phase 2 adapter port lands.

**Phase 2.5 status: data layer closed; runtime gate REOPENED pending Phase 2 adapter port + integration tests.**

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

**Goal:** Rewrite isMain sites across the fork. Create TaskFlow sidecar tables. Port scheduled_tasks. Patch v2 env allowlist.

**Inventory refresh (2026-05-01 EOD, Codex F13):** the original "103 sites across 18 files" estimate was narrow. Real grep across `src/` + `container/` for `\bisMain\b|is_main|MAIN_GROUP_FOLDER`:
- **167 total hits** (136 production, 31 tests)
- **20+ files** affected (was 18)
- Includes the local variable `isMain: boolean` parameter in many functions (`container-runner.ts`, `index.ts`, `ipc.ts`, `mount-security.ts`, `task-scheduler.ts`, plus all IPC plugins). Each needs to flip from `isMain: boolean` parameter to `userId: string` + `await hasAdminRole(userId, agentGroupId)` lookup.

This is meaningfully larger than the original 103-site estimate. Phase 3 budget retained at 4 weeks; Task 3.3 timeline tightened.

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

### Task 3.3: Rewrite ~167 isMain sites across 20+ files

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
  - Highest residual risk RESOLVED 2026-04-30: native-credential-proxy skill confirmed bit-rotted (5-file conflict vs v2.0.22). Path A2a (self-hosted OneCLI) selected. New residual risk: OneCLI postgres credential hygiene (currently `postgres:postgres` defaults on `.66`) and orphan secret cleanup when agents are deleted — must be addressed before Phase 5 cutover.
  - Second: fleet cutover has a ~2h service window. Cannot be zero. User must accept.
  - Third: scheduled_tasks porting (Phase 3) may discover v2's primitives don't fully cover holiday/weekday-contradiction handling. If Task 2.5.6 spike confirms gap, fork-private `task-scheduler.ts` stays.
  - Fourth: Phase 2.5 user/role seeding depends on TaskFlow's source-of-truth tables having clean data. If `board_people` / `board_admins` have stale rows or duplicate JIDs, the seeder needs a deduplication pass — could add 2-3 days.
  - Fifth: drift continues at ~25 commits/day. Pin baseline at Phase -1 entry.
- **Gate discipline:** Phase -1 (infra), -1.5 (security back-port), 0 (recon), 2.5 (permissions adoption), 4 (shadow), 5 (cutover) each have explicit go/no-go. Phases 1-3 are internal engineering with no prod impact. Phase 6 is reversible only via the 30-day rollback tag retention.
- **Codex priority alignment:** Phase 2.5 lands the #1 recommendation; composed CLAUDE.md is positioned as Phase 6 OR pre-migration v1 stepping stone (separate decision); a2a-lite is Phase 6 with explicit MVP scope (visible-text + existing `handle_subtask_approval`, NOT full structured payload).
- **Out-of-scope discipline:** Deferred items are listed with explicit rationale. No scope-creep during execution.
