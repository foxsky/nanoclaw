# 01 — Runners + Rendering: Feature-Coverage Audit

**Date:** 2026-05-03
**Scope:** TaskFlow's *scheduled runners domain* — morning standup, evening digest, weekly review, Kipp daily auditor — plus the supporting `board_runtime_config` machinery (per-board cron, DST guard, runner_task_id columns, silent-exit policy).
**Anchor plan:** `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`
**Anchor spec:** `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`
**Engine source:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (lines 8456-9100 cover `report()` runner backend; lines 5901+ cover digest/weekly rendering)
**Auditor source:** `/root/nanoclaw/container/agent-runner/src/auditor-script.sh` (1459 LOC heredoc) + `auditor-prompt.txt` (74 LOC)
**Skill source:** `/root/nanoclaw/.claude/skills/add-taskflow/SKILL.md` (lines 469-1150 — runner registration, DST_GUARD prompt, schema)

---

## 0. Production validation (queries run 2026-05-03)

### Cron distribution (`store/messages.db`, `status='active'`)

| schedule_value | rows | label |
|---|--:|---|
| `0 14 * * 5` | 28 | weekly review (Friday 14:00) |
| `0 8 * * 1-5` | 16 | morning standup (08:00) |
| `0 18 * * 1-5` | 14 | evening digest (18:00) |
| `3 8 * * 1-5` | 6 | **DST anti-loop standup clone** |
| `6 8 * * 1-5` | 6 | **DST anti-loop standup clone** |
| `3 18 * * 1-5` | 6 | **DST anti-loop digest clone** |
| `6 18 * * 1-5` | 6 | **DST anti-loop digest clone** |
| `0 4 * * *` | 1 | Kipp daily auditor |
| `0 17 * * 1-5` | 1 | one-off weekday |
| `0 12 * * 1-5` | 1 | one-off lunchtime digest variant |
| `0 8 * * 1` | 1 | one-off Monday |
| `0 9 15 12 *` | 1 | one-off annual |
| **Total active cron** | **87** | |

### Tagged-runner counts (prefix match on `prompt`)

| Tag | active rows |
|---|--:|
| `[TF-STANDUP]` | 27 |
| `[TF-DIGEST]` | 27 |
| `[TF-REVIEW]` | 28 |
| `[TF-DST-GUARD]` | **0** |
| Kipp prompt | 1 (`auditor-daily`) |

### `board_runtime_config` runner-id population (28 boards)

| Column | populated | notes |
|---|--:|---|
| `runner_standup_task_id` | 28/28 | 100% |
| `runner_digest_task_id` | 28/28 | 100% |
| `runner_review_task_id` | 28/28 | 100% |
| `runner_dst_guard_task_id` | **0/28** | dead column |
| `runner_standup_secondary_task_id` | **0/28** | dead column |
| `runner_digest_secondary_task_id` | **0/28** | dead column |
| `runner_review_secondary_task_id` | **0/28** | dead column |
| `dst_sync_enabled = 1` | **0/28** | dead flag |
| `*_cron_local <> *_cron_utc` divergence | 28/28 | dual-cron design used: local `0 8 * * 1-5`, utc `0 11 * * 1-5` |

### Cron customization actually exercised

- `standup_cron_local`: 1 distinct value (`0 8 * * 1-5`, all 28 boards)
- `digest_cron_local`: 2 distinct values (`0 18 * * 1-5` × 27, `0 12 * * 1-5` × 1)
- `review_cron_local`: 1 distinct value (`0 11 * * 5`, all 28)

→ **Per-board customization is wired but exercised once.** 1/84 cron-column values is non-default.

### Kipp auditor health (`task_run_logs` last 30d)

| status | count |
|---|--:|
| success | 35 |
| error | 1 (2026-05-03 OAuth/credential-proxy fault — known incident) |

`scheduled_tasks` row `auditor-daily`: `status=active`, `next_run=2026-05-04T07:00:00Z`, `script` column populated (len=106 — invokes `./auditor-script.sh`), `context_mode='isolated'`. Last delivery into `whatsapp_main` containing "uditor": **2026-04-28** (4 deliveries that day: full audit + 3 check-ins). Subsequent days: NDJSON output only — no WhatsApp delivery (matches operator's expected mode flip on 2026-04-30 per `project_kipp_report_hallucination`).

### Context mode usage

| context_mode | active rows |
|---|--:|
| `group` | 85 |
| `isolated` | 4 (incl. `auditor-daily`) |

→ **`context_mode='isolated'` is load-bearing for Kipp.** Discovery 16 §1 flagged this as having no v2 equivalent — open question.

---

## 1. Coverage matrix

| ID | Feature | Prod usage | Plan coverage | Status |
|---|---|---|---|---|
| R1 | Morning standup runner (`[TF-STANDUP]`) — Kanban view + per-person sections + housekeeping | 27 active cron rows; `report({type:'standup'})` engine.ts:8460+ | Plan 2.3.i (CLAUDE.md.template ports) + 2.3.f (migrate-scheduled-tasks) | **ADDRESSED** |
| R2 | Evening digest runner (`[TF-DIGEST]`) — exec summary; `formatDigestOrWeeklyReport` engine.ts:6260+ | 27 active cron rows; cross-board send observed (digest is the load-bearing cross-board sender — Discovery 19 §7) | Plan 2.3.i + 2.3.f | **ADDRESSED** |
| R3 | Weekly review runner (`[TF-REVIEW]`) — Friday 14:00 wrap | 28 active cron rows | Plan 2.3.i + 2.3.f | **ADDRESSED** |
| R4 | Kipp daily auditor — pre-agent script + LLM prompt + cross-board detection | `auditor-daily` row, `0 4 * * *`, 35/36 success last 30d | Plan 2.3.m (auditor rewrite, ~200 LOC; drop `send_message_log`; query v2 session DBs) — **explicitly flagged NEW** | **ADDRESSED** with caveat: rewrite is a major scope item (open question #2) |
| R5 | `board_runtime_config.runner_*_task_id` persistence (28 × 3 = 84 IDs cross-referenced from `scheduled_tasks`) | 84/84 populated | Plan does NOT mention these columns; spec §211-225 implicitly drops them by switching to v2's per-session `messages_in` storage. No bridge layer. | **GAP** |
| R6 | Per-board cron customization (`*_cron_local` columns) | 1/84 non-default (`0 12 * * 1-5` digest on 1 board) | Spec §211-225 silently drops `*_cron_local`. No assertion the 1 outlier survives. | **GAP** (small but real) |
| R7 | DST guard runner (`runner_dst_guard_task_id` + `dst_sync_enabled` + `[TF-DST-GUARD]` prompt) | 0/28 boards have DST guard runner; 0/28 enabled; 0 `[TF-DST-GUARD]` rows in `scheduled_tasks`. **However:** 24 zombie DST anti-loop crons (`3 …`, `6 …`) ARE active. | Plan does not mention DST. Memory `feedback_use_v2_natives_dont_duplicate.md` + Discovery 16 §4 say "drop both layers" | **DEPRECATED-CORRECTLY** but **not yet executed** (24 zombie rows + 6 cols still need decommission) |
| R8 | Local+UTC cron preservation (dual-column `*_cron_local` + `*_cron_utc`) | 28/28 boards have divergent local/utc values | Spec + Discovery 16 say drop `*_cron_utc` (cron-parser handles tz natively in v2). Plan does not call this out. | **DEPRECATED-CORRECTLY** by Discovery, **GAP in plan** (no explicit drop) |
| R9 | Silent-exit when no tasks ("If no tasks exist, do NOT send any message — exit silently") | Behavior baked into `STANDUP_PROMPT`/`DIGEST_PROMPT`/`REVIEW_PROMPT` (SKILL.md:709-713). No engine code enforces this — prompt-only. | Plan 2.3.i (CLAUDE.md.template ports) carries the prompts forward | **ADDRESSED** (implicit in template port) |
| R10 | Catch-up on missed runs (multi-day downtime fires once when host returns) | v1 has explicit catch-up (`task-scheduler.ts:152-170`); v2 does not (Discovery 16 §5) | **Open question Q1 in plan + spec §347.** Plan does not commit to fork-private catch-up wrapper. | **GAP** (decision deferred to user, not in scope of A.3.2) |
| R11 | Kipp pre-agent script (`scheduled_tasks.script`) | `auditor-daily.script` is 106 chars (invokes `auditor-script.sh`) | Discovery 16 §8: v2 supports pre-agent script via `messages_in.content.script` (functionally equivalent). Migration in 2.3.f puts script in content JSON. Plan 2.3.m rewrites the heredoc itself. | **ADDRESSED** |
| R12 | Auditor `auditTrailDivergence` + `delivery_health.broken_groups` reports | Both render in Kipp output (auditor-script.sh:1043-1102; auditor-prompt.txt:32, 44-49) | Plan 2.3.m says "rewrite to query v2 session DBs directly" but does NOT enumerate that these two heuristics survive | **GAP** — rewrite scope risk |
| R13 | Auditor 8-bit signal classification (`isWrite`, `isTaskWrite`, `isDmSend`, `isRead`, `isIntent`, `taskMutationFound`, `crossGroupSendLogged`, `isCrossBoardForward`) | auditor-script.sh:843-998. Reads `send_message_log` (which 2.3.m drops) | Plan 2.3.m says "query outbound.db ⨝ inbound.db.delivered" — equivalent join. Plan does not enumerate every signal preserved. | **ADDRESSED** with regression risk |
| R14 | Auditor `selfCorrections` (60min reagendar/prazo doublet detection) | auditor-prompt.txt:34-40; auditor-script.sh data path | Plan 2.3.m does not enumerate. Same risk as R12. | **GAP** — preservation not enumerated |
| R15 | Kipp `context_mode='isolated'` — runs the audit in a *task-only session* not contaminated by group conversation | 4 active tasks use this; auditor-daily is one (CLAUDE.md `project_audit_actor_canonicalization`) | Discovery 16 §9 + open question: "no v2 equivalent. v2 always runs the task in the group's session." Plan does not address. | **GAP** — material behavioral regression risk |
| R16 | Runner task-id discovery via `[TF-STANDUP]` markers | SKILL.md:777 + provision-shared.ts:249-251 use prompt-marker discovery because `INSERT INTO scheduled_tasks` doesn't return id directly | Plan 2.3.b (`provision_taskflow_board` MCP) reuses prompt-marker mechanism implicitly. v2's `schedule_task` returns `taskId` directly so the marker discovery is unnecessary. | **DEPRECATED-CORRECTLY** (v2 returns task id) but plan does not call out this simplification |
| R17 | Per-runner `_secondary_task_id` columns (manager-vs-team dual delivery) | 0/28 populated (dead) | Plan does not mention; spec drops via column omission | **DEPRECATED-CORRECTLY** (column drop implicit in spec rewrite) |
| R18 | Auto-archive old done tasks (>30d) — engine.ts:8930-8933 (only on `type='standup'`) | Runs every weekday morning across 27 standup runners | Plan 2.3.a (engine port) carries this | **ADDRESSED** (engine code travels with skill) |
| R19 | `formatBoardView('standup')` Kanban rendering — engine.ts:5942+ | Embedded in standup runner output | Plan 2.3.a | **ADDRESSED** |
| R20 | `formatDigestOrWeeklyReport` rendering — engine.ts:6260+ | Embedded in digest/weekly output | Plan 2.3.a | **ADDRESSED** |
| R21 | Cross-board digest delivery (digest from child board → parent board's WhatsApp group) | 422 cross-board sends in 60d (28% of outbound; Discovery 19 §7) | Plan 2.3.j (ACL refresh, ~784 `agent_destinations` rows seeded) + A.3.7 cross-cutting test | **ADDRESSED** (load-bearing) |

### Status counts

- **ADDRESSED:** 12 (R1, R2, R3, R4, R9, R11, R13, R18, R19, R20, R21, partial R16)
- **GAP:** 6 (R5, R6, R10, R12, R14, R15)
- **DEPRECATED-CORRECTLY:** 4 (R7, R8, R16, R17) — but R7 + R8 need explicit cleanup steps the plan currently lacks
- **DEPRECATED-WRONG:** 0
- **DEAD-CODE-PRESERVED:** 0

---

## 2. Per-GAP deep dives

### R5 — runner_*_task_id column persistence

**What:** v1 stores 3-4 task IDs per board in `data/taskflow/taskflow.db.board_runtime_config`. Used by:
- `provision-shared.ts:249-251` to UPDATE the row after creating runners
- DST guard prompt (SKILL.md:777) for cancel-and-recreate (R7 deprecates this)
- Operator queries when something looks wrong with a board

**v2 reality (Discovery 16):** scheduled tasks live in per-session `data/v2-sessions/{ag}/{sid}/inbound.db` keyed by their auto-generated id. There's no central registry.

**Impact:** if v2 keeps the columns, they need to be populated during `provision_taskflow_board` after `schedule_task` returns the new id. If v2 drops them, operator queries that scan `board_runtime_config` for "is this board's standup runner alive?" stop working.

**Recommended A.3.2 sub-task:** **2.3.o (NEW)** — decide retention:
1. *Drop* the 7 runner-id columns when porting `taskflow-engine.ts` schema. Update Discovery 04's "3 dropped tables" list. Or
2. *Keep* `runner_standup_task_id`, `runner_digest_task_id`, `runner_review_task_id` and have `provision_taskflow_board` populate from `schedule_task` return value. Drop the 4 unused (`runner_dst_guard_task_id` + 3 `_secondary_task_id`).

**Default:** option 2 (keep 3, drop 4) — preserves operator query patterns; aligns with prod usage (28/28 populated).

### R6 — per-board cron customization

**What:** SKILL.md inserts runners with hardcoded crons at provisioning, but `*_cron_local` columns let admins change them later.

**Prod usage:** 1 of 28 boards has a non-default `digest_cron_local` (`0 12 * * 1-5` — laizys SEAF lunchtime digest). The other 83 cron columns match defaults exactly.

**Impact if dropped:** that 1 board reverts to 18:00 default after migration unless preserved.

**Recommended A.3.2 sub-task:** **2.3.f addendum** — `migrate-scheduled-tasks.ts` already migrates the cron value from `scheduled_tasks.schedule_value` (where the live `0 12 * * 1-5` lives) to `messages_in.recurrence`, so it travels for free. **GAP self-resolves** but should be explicitly asserted in A.3.6 step 6.4: `SELECT COUNT(DISTINCT recurrence) FROM messages_in WHERE kind='task'` ≥ 4 (3 default crons + 1 lunchtime override).

### R10 — catch-up on missed runs

**What:** v1's `task-scheduler.ts:152-170` finds rows where `next_run <= now` AND last_run was N days ago, fires once. v2 fires once at first wake then advances from "now" (Discovery 16 §5). Practical behavior is identical when the host is down >1 day.

**Open question Q1 in plan/spec:** is missed-run catch-up required for Kipp/digest/standup? Currently deferred without commitment.

**Production evidence:** the 2026-04-13 silent-board incident (CLAUDE.md `project_20260414_audit_silent_boards`) was caused by 3 host SIGKILLs interleaved with the standup window; recovery was manual via `_close` writes, not catch-up. Kipp ran 35/36 last 30d — 1 failure was OAuth, not downtime. **Empirically, catch-up has been irrelevant for the last 30 days.**

**Recommendation:** close Q1 explicitly: **decide "no catch-up wrapper"** in A.3.2. Document operationally: if a board misses a window, manager does the standup manually or next day's run picks up the slack. Saves ~50 LOC of fork-private code Discovery 18 warned about (auto-merge bot was deleted because of fragile fork bridges).

### R12 — auditor `auditTrailDivergence` + `delivery_health.broken_groups`

**What:** Two compound heuristics rendered as warning sections in Kipp's output:
1. `auditTrailDivergence`: `deliveriesToGroup ≥ 5 AND botRowsInGroup < deliveries × 0.5` — the 2026-04-13 silent-board pattern. Currently joins `send_message_log` × `messages.db`.
2. `delivery_health.broken_groups`: classify groups as `never_sent` (registered but bot never delivered) or `silent_with_recent_human_activity` (bot kicked out).

**Impact of plan 2.3.m rewrite:** new auditor queries `outbound.db.messages_out` ⨝ `inbound.db.delivered`, but the plan does not enumerate that these two sections must survive the rewrite. Risk: rewriter ports cross-group send detection, forgets the warning sections, and the operator loses the early-warning signal that caught the 2026-04-13 incident.

**Recommended A.3.2 sub-task:** **2.3.m addendum** — add as acceptance criteria for the auditor rewrite:
- preserve `auditTrailDivergence` board-level warning (recompute as `deliveriesFromMessagesOut ≥ 5 AND deliveredCount/queuedCount < 0.5`)
- preserve `delivery_health.broken_groups` (`never_sent` and `silent_with_recent_human_activity`)
- preserve `selfCorrections` (R14)
- preserve all 8 signal bits (R13)

### R14 — `selfCorrections` 60-minute doublet detection

**What:** Detects user re-editing a `due_date`/`scheduled_at` within 60 min after the bot resolved the first instance. Classified as 🔴 (bot error) or ⚪ (legit iteration) per auditor-prompt.txt:34-40.

**Impact:** same as R12 — easily lost in rewrite.

**Recommended sub-task:** part of **2.3.m addendum** above.

### R15 — `context_mode='isolated'` for Kipp

**What:** v1's `scheduled_tasks.context_mode` lets a task run in an *isolated* session, not the group's main conversation. Kipp uses this so its prompt + script output don't pollute the operator's WhatsApp group context.

**v2 reality (Discovery 16 §1, §9):** v2 always runs `task` messages in the group's session. **There is no "task-only session" flag.**

**Production usage:** 4 active tasks use `isolated` (auditor-daily + 3 others). Kipp's audit relies on this for actor canonicalization (CLAUDE.md `project_audit_actor_canonicalization`).

**Impact:** Kipp's audit context will mix with the `whatsapp_main` group's chat history. Could degrade audit quality (Kipp may "remember" yesterday's user messages and skew classification).

**Mitigation options:**
1. **Dedicated per-board "audit" session.** Provision a second `(agent_group_id, session_id)` pair specifically for Kipp; route auditor-daily there. ~30 LOC fork-private routing.
2. **Accept regression.** Most audits are stateless heredoc → JSON → LLM render; the LLM doesn't read prior context aggressively. Empirical risk: medium.
3. **Upstream proposal.** Add `task_session_isolation` flag to v2's `schedule_task`. Out of scope for A.3.

**Recommended A.3.2 sub-task:** **2.3.p (NEW)** — provision a dedicated `whatsapp_main_audit` session for Kipp; route `auditor-daily` to it via `migrate-scheduled-tasks.ts`. Acceptance: `SELECT session_id FROM messages_in WHERE id LIKE 'migrated-auditor-daily%'` differs from any user-conversation session on `whatsapp_main`.

---

## 3. DEPRECATED-CORRECTLY items needing explicit cleanup

### R7 — DST guard runner

Discovery 16 §4 + memory `feedback_use_v2_natives_dont_duplicate.md` say drop. Production confirms 0/28 enabled. But:

- `[TF-DST-GUARD]` prompt still in SKILL.md:777 (~1500 chars)
- 6 DST columns still in `board_runtime_config` (`runner_dst_guard_task_id`, `dst_sync_enabled`, `dst_last_offset_minutes`, `dst_last_synced_at`, `dst_resync_count_24h`, `dst_resync_window_started_at`)
- **24 zombie rows in `scheduled_tasks`** (`3 8 * * 1-5`, `6 8 * * 1-5`, `3 18 * * 1-5`, `6 18 * * 1-5`, 6 each — DST anti-loop clones)

**Recommended A.3.2 sub-task:** **2.3.q (NEW)** — DST decommission:
- Drop the 6 DST columns from `board_runtime_config` schema in skill init
- Skip the 24 zombie clone crons in `migrate-scheduled-tasks.ts` (filter `schedule_value LIKE '3 % * * 1-5' OR LIKE '6 % * * 1-5'`)
- Remove `[TF-DST-GUARD]` prompt from SKILL.md
- Remove DST text in CLAUDE.md.template

### R8 — local+UTC dual cron columns

`*_cron_utc` exists from early v1 era when host cron-parser was passed `tz: undefined`. v2 always passes `{ tz: TIMEZONE }` per Discovery 16 §3. Drop `*_cron_utc`; keep `*_cron_local` if R5 keeps the runner_id columns.

**Recommended A.3.2 sub-task:** rolled into **2.3.o** (R5 decision).

### R16 — runner discovery via prompt markers

v1 needed it because `INSERT INTO scheduled_tasks` doesn't return id directly via the SKILL.md flow. v2's `schedule_task` MCP returns `taskId` in the result. Provisioning code can write the id directly.

**Recommended:** add to plan 2.3.b acceptance criteria. ~20 LOC saved.

### R17 — `_secondary_task_id` columns

0/28 populated. Manager-vs-team dual-delivery never shipped. Drop with R5 cleanup.

---

## 4. Recommended plan revisions (sub-tasks to add to A.3.2)

| New sub-task | Action | Risk if skipped |
|---|---|---|
| **2.3.o** | Decide retention policy for `runner_*_task_id` and `*_cron_*` columns. Recommended: keep 3 runner ids + 3 `*_cron_local`; drop 4 unused runner ids + 6 DST columns + 3 `*_cron_utc`. Document in `init-db.ts`. | Operator queries break; ambiguous source of truth between v2 inbound.db and legacy columns |
| **2.3.p** | Provision dedicated `whatsapp_main_audit` session for Kipp; route `auditor-daily` via migrate script. | Kipp context contamination — degrades audit quality silently with no production observability |
| **2.3.q** | DST decommission: drop 6 columns; filter 24 zombie cron clones in migrate script; remove `[TF-DST-GUARD]` prompt + template references. | Migration creates 24 zombie tasks in v2; future operator confusion |
| **2.3.m addendum** | Enumerate auditor-rewrite preservation: `auditTrailDivergence`, `delivery_health.broken_groups`, `selfCorrections`, all 8 classification signal bits. Acceptance: paired-output diff of v1 NDJSON vs v2 NDJSON on a 7-day prod fixture. | Silent regression of Kipp's most-valuable warning sections; the 2026-04-13 silent-board pattern goes undetected next time |
| **2.3.r (NEW)** | Close open question Q1 (catch-up): explicitly decide *no catch-up wrapper*. Document in spec §229 + §347. | Indefinite open question becomes implementation drift |

---

## 5. Open question for plan author

The audit found the runner-state inventory (`board_runtime_config` runner_id + cron columns) is **not** explicitly named anywhere in plan A.3.2. Spec §211-225 implies it via "drop fork-private scheduler," but that's only true for the central `scheduled_tasks` table — `board_runtime_config` is a *separate* fork-private table that survives the migration. Recommend adding to A.3.6 step 6.4 invariants:

```
- SELECT COUNT(*) FROM board_runtime_config WHERE runner_standup_task_id IS NOT NULL = 28 (post-migration; bridge populated by provision/migrate script)
- SELECT COUNT(*) FROM board_runtime_config WHERE runner_dst_guard_task_id IS NOT NULL = 0 (decommissioned)
- SELECT COUNT(*) FROM messages_in WHERE kind='task' AND recurrence LIKE '3 %% * * 1-5' = 0 (zombie DST clones filtered)
```

---

**Document generated:** 2026-05-03 (against 87-cron / 28-board production state at `nanoclaw@192.168.2.63`)
