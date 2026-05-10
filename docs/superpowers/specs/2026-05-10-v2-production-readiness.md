# v2 Production Readiness Checklist

**Authored:** 2026-05-10
**Branch:** `skill/taskflow-v2`
**Tip at authoring:** `75c9d25d` (Merge upstream/main v2.0.54)

## Goal

Before promoting `skill/taskflow-v2` to production, prove three things:

1. **Every v1 user-facing feature has a v2 equivalent** — no silent drop.
2. **v2's runtime behavior matches v1's** under realistic load — no regression.
3. **Migration + rollback paths work** against actual prod data — no foot-gun.

---

## What this session has already validated

| What | Result | Reference |
|---|---|---|
| Read-side replay (623 calls × 29 boards × 14d) | 100% v2 success, 100% same-shape | `project_v2_validation_pilot_results.md` |
| Cron/timezone parity (90 prod schedules) | 90/90 valid future fire times under TIMEZONE=America/Fortaleza | `project_v2_validation_pilot_results.md` |
| Mutation slice (10 calls × 4 types) | 100% no exceptions, 8/10 expected, 2/10 v2-stricter (no-op rejection) | `project_v2_validation_pilot_results.md` |
| Upstream merge to v2.0.54 | Clean (passes typecheck + 990 unit tests + container build) | Branch tip 75c9d25d |
| `ncl groups config update` model+effort overrides documented | Per-board model strategy spec'd in skill SKILL.md | `.claude/skills/taskflow-v2/SKILL.md` |

---

## Test plan — Tier A (MUST PASS before any cutover)

### A1: Feature parity inventory

**What:** Verify every v1 user-facing feature has a v2 equivalent and is reachable from the user-facing surface.

**How:**
- Diff every v1 MCP tool name + signature against v2 equivalent. List in a CSV: `v1_tool | v2_tool | matched | notes`.
- Diff every v1 SQL table the agent reads/writes against v2. Confirm schema compatibility (v2 must be able to read all rows v1 wrote).
- Walk every v1 CLAUDE.md instruction block. For each, identify the v2 code path that honors it.
- For each fork-private skill enabled in production (`add-taskflow-memory`, `add-taskflow`, `whatsapp-fixes`, `add-long-term-context`, `add-reactions`, etc.) confirm v2 install path exists.

**Pass criteria:** 100% v1 tools have v2 equivalents. Every CLAUDE.md instruction is honored by a documented v2 path. Every prod-enabled skill is reachable in v2.

**Effort:** 4-8h (mostly static audit).

### A2: Mutation parity (full corpus)

**What:** Extend the 10-mutation slice to the full **235 mutations** captured from past-14d session logs across all 29 boards.

**How:** Per-call DB fork pattern (proven in this session's slice):
1. Copy taskflow.db → scratch.db per call
2. Open via v2 engine, apply mutation with same input as v1
3. Diff post-state (tasks table, task_history table) against expected delta
4. Categorize failures: (a) v2-stricter (no-op rejection), (b) v2-incorrect (genuine bug), (c) data-drift (intervening mutation in snapshot)

**Pass criteria:**
- 100% v2 ran without exception.
- Per-type structural delta matches v1 except for documented v2-stricter cases.
- 0 unexpected exceptions / 0 cases of v2-incorrect.

**Effort:** 1-2 days.

### A3: Migration safety

**What:** Clone full prod state to sandbox. Run `bash migrate-v2.sh`. Verify migration completeness + correctness.

**How:**
1. SCP `/home/nanoclaw/nanoclaw/` from prod to a sandbox VM
2. Run `bash migrate-v2.sh` interactively, capture every prompt + answer
3. After migration, verify:
   - Every v1 `registered_groups` row → v2 `agent_groups` + `messaging_groups` rows
   - Every v1 `scheduled_tasks` row (status active/paused) → v2 `messages_in` row with kind='task' and same recurrence
   - Every v1 group `CLAUDE.md` → v2 `groups/<folder>/CLAUDE.local.md` (per-group fragment)
   - Every v1 board (`boards`, `tasks`, `board_people`, `task_history`) preserved byte-identical
   - Counts match: boards, tasks-per-board, people-per-board, runners-per-board

**Pass criteria:** 100% boards migrate without error. All counts match v1 source.

**Effort:** 2-3 days.

### A4: Rollback verified

**What:** After migration, force a rollback. Verify v1 still runnable, prod data intact.

**How:** Document exact rollback procedure (`bash migrate-v2.sh --rollback` or equivalent), execute it in sandbox, verify v1 service starts and all 28 boards accessible.

**Pass criteria:** v1 service starts cleanly, all 28 boards still accessible, no data corruption.

**Effort:** 1 day.

### A5: Per-board CLAUDE.md regeneration (DISCOVERED 2026-05-10)

**What:** v2 refactored the MCP tool surface — v1's `taskflow_query`, `taskflow_report`, `taskflow_move`, `taskflow_reassign`, `taskflow_update`, `taskflow_admin`, `taskflow_create`, `taskflow_dependency`, `taskflow_hierarchy` tool names don't exist as v2 MCP tools. v2's replacements are `api_board_activity`, `api_filter_board_tasks`, `api_linked_tasks`, `api_create_simple_task`, `api_update_simple_task` (covers update + move + reassign), `api_task_add_note`, `api_delete_simple_task`, etc.

Prod's per-board `groups/<board>/CLAUDE.md` references v1 tool names **219 times** in the sec-secti sample alone. Without regeneration to use v2 tool names, board agents will fail every interaction with "tool not found."

**How:**
1. Author a v2 CLAUDE.md template that uses v2's MCP tool names (per-tool capability sections rewritten)
2. Per-board: regenerate CLAUDE.md from the v2 template + per-board variables (board name, members, holiday calendar, custom rules)
3. Diff each regenerated CLAUDE.md against its v1 version to confirm: (a) all instructions preserved semantically, (b) all tool references updated, (c) no v1-only tool names remain

**Pass criteria:**
- 0 occurrences of v1 tool names (`taskflow_query`, `taskflow_report`, `taskflow_move`, `taskflow_reassign`, `taskflow_update`, `taskflow_admin`, `taskflow_create`, `taskflow_dependency`, `taskflow_hierarchy`) in any board's regenerated CLAUDE.md
- All v1 instructions semantically preserved (manual review per board)

**Effort:** 1-2 days for template + tooling + per-board diff review.

**Critical:** This is THE prerequisite for v2 board agents to function. Without it, A3 migration succeeds technically but every board breaks at first user message.

---

## Test plan — Tier B (SHOULD PASS before broad rollout)

### B1: LLM text empirical A/B

**What:** Verify v2 LLM-formatted text is semantically equivalent to v1.

**How:**
- 5-10 captured prod chats × 3 runs through each of v1 sandbox and v2 sandbox.
- Compute pairwise semantic similarity (LLM-as-judge or embeddings).
- Compare `dist(v1_i, v2_j)` to `dist(v1_i, v1_k)` — v2 variance should ≈ v1 variance (i.e., sampling noise).

**Pass criteria:** `dist(v1, v2)` ≤ `dist(v1, v1) + 1σ`. No semantic regression.

**Effort:** 4-6h + ~$5 API.

### B2: Cross-mount writer concurrency

**What:** Verify host (Node + better-sqlite3) and container (Bun + bun:sqlite) can read/write shared DB files without corruption.

**How:**
- Spawn host + container against shared scratch session DBs
- Drive synthetic high-frequency message inserts (100/min)
- Observe lock contention p50/p99, lost updates, corruption

**Pass criteria:** 0 lost messages, 0 corruption, lock contention p99 < 100ms.

**Effort:** 4-6h.

### B3: Outbound delivery e2e

**What:** Real WhatsApp delivery through v2 stack.

**How:**
- One real test WhatsApp group wired to a v2 sandbox agent
- Trigger standup, digest, review runners
- Verify message arrives, formatting correct (bold/italic markers, mentions resolve)

**Pass criteria:** 100% delivery, no formatting regression.

**Effort:** 2-3h.

### B4: Permission + approval flow

**What:** Validate `is_main_control`, `user_roles`, `pickApprover` flow.

**How:**
- Trigger an `install_packages` request from inside container
- Verify host routes to admin DM via `pickApprover`
- Test both approval and rejection paths
- Trigger a TaskFlow operation requiring main-control gate; verify reject from non-main chat

**Pass criteria:** Full flow including rejection path. 0 unauthorized accesses.

**Effort:** 4-6h.

### B5: Scheduling runtime fire

**What:** Validate cron-driven runners actually fire on time in v2.

**How:**
- Insert a runner task with `process_after = now+5s` and `recurrence` cron
- Wait. Verify host-sweep picks it up, container spawns, runner prompt fires, response written to outbound
- Test under TZ boundaries (e.g., 23:55 local with 1-day recurrence)

**Pass criteria:** Fires within 60s of process_after. Recurrence advances correctly across day boundaries.

**Effort:** 4-6h.

### B6: Container lifecycle (on-wake messages)

**What:** Verify v2.0.48's `on_wake` race-free message delivery during SIGTERM grace period.

**How:**
- Spawn container, send SIGTERM mid-poll, immediately enqueue an on-wake message
- Verify next container instance picks up the message; dying container does not steal it
- Repeat 100 cycles

**Pass criteria:** 0 message loss across 100 lifecycle cycles.

**Effort:** 2-3h.

---

## Test plan — Tier C (SHADOW RUN before full cutover)

### C1: Read-only shadow on real traffic

**What:** v2 host runs in parallel with v1 prod for 1 week, mirroring inbound.

**How:**
- v2 host reads same inbound stream as v1
- v2's outbound is captured to file (NO real delivery)
- Daily diff: v2's outbound vs v1's actual delivered text, per board
- Track delivery latency, container spawn rate, error rate

**Pass criteria:** % semantic match ≥ 90% after 1 week. 0 v2 crashes. Latency p99 ≤ v1's p99 + 20%.

**Effort:** 1 week wall-clock, ~10h setup + analysis.

### C2: Single-board cutover (canary)

**What:** Migrate one low-stakes board (e.g., `edilson-taskflow` or a test board) to v2 while other 28 stay on v1.

**How:**
- Migrate ONLY the canary board
- Watch for 1 week
- Board owner monitors standup/digest/review for regressions
- Compare v2 canary board behavior to its v1 history for the prior week

**Pass criteria:** Board owner reports no issues. No silent regressions in runner delivery.

**Effort:** 1 week wall-clock.

### C3: Gradual rollout

**What:** Migrate remaining 28 boards in batches of ~5, one batch per week.

**Pass criteria:** No batch regresses. Each batch monitored for 7 days before next.

**Effort:** 6-7 weeks calendar.

---

## Test plan — Tier D (operational + nice-to-have)

| # | Test | How | Effort |
|---|---|---|---|
| D1 | Load test (throughput) | 100 messages/min through v2 host. Measure latency p50/p99, container spawn rate, DB lock contention. | 4-6h |
| D2 | OneCLI credential injection | Verify credentialed actions inject correctly without leaking to container env | 2-3h |
| D3 | Cross-board subtask routing | Parent assigns task to child board. Rollup status propagates. Approval flow if `cross_board_subtask_mode='approval'`. | 4-6h |
| D4 | Meeting workflow | Schedule meeting with external participant. External DM invite sends. Cross-board visibility check. | 3-4h |
| D5 | Audit board (Kipp) integration | Ollama wiring (`glm-5.1:cloud`) for semantic auditor. Run one audit cycle. | 3-4h |
| D6 | Memory layer | redislabs/agent-memory-server connection, MCP tools (store/recall/list/forget), auto-recall preamble. | 2-3h |

---

## Recommended sequencing

| Week | Activity |
|---|---|
| 1 | Tier A (must-pass). STOP if anything fails. |
| 2 | Tier B (parallel) |
| 3 | Tier C1 (read-only shadow on real traffic). Daily diff analysis. |
| 4 | Tier C2 (single-board canary) |
| 5-10 | Tier C3 (gradual rollout, 28 boards in 5-6 batches) |
| Continuous | Tier D tests as part of CI on each PR |

---

## Pre-cutover product decision

**RETRACTED 2026-05-10:** The mutation slice initially appeared to show "v2 stricter than v1" on no-op mutations (move-to-current-column, reassign-to-current-assignee). On direct investigation against v1 prod's `container/agent-runner/src/taskflow-engine.ts`, **the guard blocks are byte-identical between v1 and v2** (9598 vs 9604 lines total; the relevant `same-person check` and `state-machine` guards diff cleanly).

The 2/10 mutation-slice "failures" were **data-drift artifacts**: between v1's original call and the snapshot we replayed against, an intermediate prod mutation moved the task into the target state, so the replay correctly hit the (identical) guard that v1 would also have hit in the same situation.

**No behavior change. No product decision required.** Skip this section.

---

## What CANNOT ship without

- **A1** (feature parity inventory) — silent feature loss is the highest risk
- **A3** (migration safety) — corrupted prod data has no recovery
- **A4** (rollback verified) — without working rollback, every cutover is gambling
- **A5** (per-board CLAUDE.md regeneration) — without v2-tool-name updates, every board breaks at first interaction (NEW 2026-05-10)
- **C2** (single-board canary) — proves the actual cutover machinery works

## What CAN ship without (with explicit risk acceptance)

- **B1** (LLM text empirical A/B) — architectural argument is defensible; live A/B is "nice to have"
- **D6** (memory layer) — feature is fork-private, opt-in per board
- **D5** (audit board) — separate ops surface from board agent

---

## Total estimated effort

- Tier A (must): **2-3 weeks dedicated**
- Tier B (should): **1 week dedicated**
- Tier C (shadow + canary): **8-10 weeks calendar** (mostly monitoring)
- Tier D (operational): **1 week**

**Realistic timeline to production: 10-13 weeks** from 2026-05-10, assuming dedicated focus and no major blockers from Tier A discoveries.
