# NanoClaw v2 Migration Plan (v2 — post-review rewrite)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. At every phase gate, pause for user sign-off before proceeding.

**Revision history:**
- v1 (2026-04-23 first draft) — superseded. Three-agent review + Codex gpt-5.5/xhigh validation found ~30 concrete bugs and multiple strategy errors. See git history for v1.
- v2 (2026-04-23 rewrite) — corrects file counts, command syntax, adds Phase -1 infra prep, rewrites Phase 5 cutover model (Baileys auth prohibits per-group shadow), extends timeline to 12-16 weeks, adds strategic decision section.
- v2.1 (2026-04-30 delta re-review) — folds in `v2.0.10 → v2.0.21` upstream changes (576 commits, 72 files, no new BREAKING). Adds Phase -1.5 security back-port, expands Phase 0 (circuit breaker + native-proxy re-merge), Phase 2 (channel-approval surface grew ~600 lines), Phase 3 (schedule_task content JSON routing, `namespacedPlatformId()` rule, register field-name regression). See "v2.0.21 delta" section below.

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

## v2.0.21 delta re-review (2026-04-30)

Fold-in of upstream changes since `v2.0.10` baseline (576 commits, 72 files changed, ~3939 insertions / ~580 deletions). **No new `[BREAKING]` items in CHANGELOG since 2.0.0** — architecture is stable, deltas are patches + features.

| # | Delta | Affects | Phase |
|---|-------|---------|-------|
| 1 | OneCLI mandate tightened: `src/container-runner.ts:459` now `throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials')`. Was caught at L437-451 with "spawn continues with no credentials." | Native-credential-proxy escape skill must be re-merged against v2.0.21 head; merge surface bigger but escape still works. | Phase 0 Task 0.3 |
| 2 | `schedule_task` MCP tool now writes routing into **content JSON** (`platformId`, `channelType`, `threadId`) — not just row columns. Without it, host-sweep falls through to the "Routing recovery" retry prompt. (Commit `8dd004ca`, 2026-04-30.) | Our Kipp/digest/standup `scheduled_tasks` custom seeder must populate these three fields in content JSON. | Phase 3 Task 3.5 |
| 3 | New `src/platform-id.ts` exports `namespacedPlatformId(channel, raw)`: skips `channel:` prefix when raw contains `@` (WhatsApp/iMessage), starts with `+` (Signal DM), or starts with `group:` (Signal group). Chat-SDK adapters (Telegram/Discord/Slack/Teams) get prefix. | Our 31 boards are WhatsApp `@g.us` JIDs → skip prefix. The TaskFlow-groups seeder must route every JID through this rule. | Phase 3 Task 3.4 |
| 4 | `setup/register.ts` regression fix (`fc375ca7`): upstream itself just fixed `createMessagingGroupAgent` being called with **legacy field names**. | Our seeder copy-pasted from earlier upstream samples may inherit the broken fields. Diff against current upstream before running. | Phase 3 Task 3.4 |
| 5 | Channel-approval flow expanded ~600 lines (`modules/permissions/channel-approval.ts` +217, `permissions/index.ts` +300) — agent selection + free-text naming. | WhatsApp re-port wire-up surface bigger than v2 plan estimated. Bump Phase 2 estimate from 1-2 weeks to 2-3 weeks. | Phase 2 Task 2.2 |
| 6 | Startup circuit breaker shipped (`2bf296b0` + `336e01d2` hardening). On by default. | Could block boots if any of our 31 boards trip init-time errors. Smoke-test on a single board before fleet cutover. | Phase -1 Task -1.6 (NEW) |
| 7 | `fix(claude-provider): respect operator-set CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`98898489`). | Our `=165000` setting is honored without patches. Strike the env-semantics worry from the SDK 0.2.111 audit. | Phase 3 Task 3.1 |
| 8 | **Security:** path traversal fixes in attachment handling — `7e37b13a` (channel-inbound), `6e5e568d` + `2a3be9ec` (agent-sent file names). New `src/attachment-safety.ts` module. | Same bug class may exist in v1.2.53. Back-port the sanitizer to our v1 fork **now**, independent of v2 migration. | Phase -1.5 (NEW) |
| 9 | `add-signal-v2` skill folded back into `add-signal` (`b6be3b9b`). | Pattern signal: channel ports likely won't need separate v2-suffix branches. Lowers Phase 2 complexity slightly. | Phase 2 |
| 10 | New `nc` CLI scaffold (`3a3d2ee6`) with `list-groups` command. | Operational only; no migration impact. Optional adoption post-cutover. | Out-of-scope |

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

**Success criteria:**
- Our v1 attachment-handling code path matches v2's mimeType-derived extension + safe-extension allowlist behavior.
- A failing test exists for the path-traversal vector (e.g., `..` in suggested filename).
- The fix lands on `main`, ships through `deploy.sh` to prod, soaks for 48h before Phase 0 begins.

### Task -1.5.1: Identify our v1 attachment code path

- [ ] **Step 1:** Grep our `src/` and `container/agent-runner/src/` for filename derivation in inbound + agent-sent attachment handlers.
- [ ] **Step 2:** Compare against `upstream/main:src/attachment-safety.ts` and the patched call-sites in `upstream/main:src/session-manager.ts`. Identify the equivalent locations in our code.

### Task -1.5.2: Write failing test

- [ ] **Step 1:** Reproduce the path traversal: an inbound attachment with filename `../../etc/passwd` or similar, asserting that the handler must reject or sanitize.
- [ ] **Step 2:** Run; expect FAIL on v1.2.53 if the bug is present. If the test PASSES on v1, document why (e.g., we sanitize elsewhere) and skip Task -1.5.3.

### Task -1.5.3: Port the sanitizer

- [ ] **Step 1:** Adapt `attachment-safety.ts` to our codebase (no Bun deps; works under Node). Keep the same mimeType-derived extension + extension allowlist.
- [ ] **Step 2:** Wire it into the call-sites identified in Task -1.5.1.
- [ ] **Step 3:** Run the test from Task -1.5.2; verify PASS.
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

## Phase 3: isMain Rewrite + Schema Migration + Env Patch (Weeks 6-9)

**Goal:** Rewrite ~103 isMain sites across 18 files. Create TaskFlow sidecar tables. Port scheduled_tasks. Patch v2 env allowlist.

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

## Phase 4: Shadow Run on Test Groups (Weeks 10-11)

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

## Phase 5: Fleet Cutover (Weeks 12-14)

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

## Phase 6: Cleanup (Weeks 15-16)

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

## Self-review (v2.1)

- **Spec coverage:** Every finding from the 3-agent review + Codex gpt-5.5/xhigh validation is addressed. v2.1 folds in the v2.0.10→v2.0.21 delta (10 items) without restructuring phases. Corrections reflected in file counts (17 container, 16 src, 103 isMain sites, 579 SQL sites), command syntax, strategic model, env allowlist, scheduled_tasks (now with content-JSON routing per delta #2), `namespacedPlatformId()` rule (delta #3), register field-name regression (delta #4), permissions surface growth (delta #5), startup circuit breaker (delta #6), security back-port to v1 (delta #8).
- **Placeholder scan:** None new. Phase -1.5 (security back-port) and Task -1.6 (circuit breaker smoke) have concrete steps; Task 0.3 has a concrete grep gate; Task 3.4 imports `namespacedPlatformId` from a real upstream module; Task 3.5 has a verifiable SQL gate.
- **Timeline realism:** Phase 2 widens by ~1 week (channel-approval surface). Phase -1.5 adds ~3 days for the security back-port + 48h soak. Net: 13-17 weeks full-time. Part-time still ~6+ months.
- **Risk ledger:**
  - Highest residual risk: `use-native-credential-proxy` skill v2.0.21-compat UNVERIFIED until Phase 0 Task 0.3. If the skill needs an update for the new hard-throw at L459, migration timeline blows out 1-2 weeks (OneCLI adoption or skill patch).
  - Second: fleet cutover has a ~2h service window. Cannot be zero. User must accept.
  - Third: scheduled_tasks porting may discover v2 has no cron equivalent for our Kipp cron. If so, add another fork-private table + keep our scheduler. Either way, the post-`8dd004ca` content-JSON routing contract must be honored.
  - Fourth (new): drift continues at ~25 commits/day. If migration baseline isn't pinned at Phase -1 entry, every phase chases a moving target.
- **Gate discipline:** Phase -1 (infra), -1.5 (security back-port), 0 (recon), 4 (shadow), 5 (cutover) each have explicit go/no-go. Phases 1-3 are internal engineering with no prod impact. Phase 6 is reversible only via the 30-day rollback tag retention.
- **Out-of-scope discipline:** Deferred items are listed with explicit rationale. No scope-creep during execution.
