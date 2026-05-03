# 10 — Admin Actions Domain: Feature-Coverage Audit

**Date:** 2026-05-03
**Scope:** TaskFlow's *admin actions* domain — the 8 features routed through `taskflow_admin` (and adjacent CLAUDE.md raw-SQL recipes) per inventory: holidays (4 ops), `add_manager`, `add_delegate`, `cancel_task` (admin path), `remove_child_board`, `set cross_board_subtask_mode`, `merge_project`, `handle_subtask_approval`.
**Anchor plan:** `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`
**Anchor spec:** `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`
**Discovery synthesis:** `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/00-synthesis.md`, `…/19-production-usage.md`, `…/13-user-roles.md`
**Engine source:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` — `admin()` dispatcher at `:7365-:8454` (1089 LOC, 17 cases)
**CLAUDE.md template (raw-SQL paths):** `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template:413` (cross-board mode), `:1041` (remove child board)

---

## 0. Production validation (queries run 2026-05-03)

### Engine `admin()` action enum (engine:247)

`register_person | remove_person | add_manager | add_delegate | remove_admin | set_wip_limit | cancel_task | restore_task | process_inbox | manage_holidays | process_minutes | process_minutes_decision | accept_external_invite | reparent_task | detach_task | merge_project | handle_subtask_approval` — **17 distinct actions**.

The 8 inventory features map to **6 engine actions** (`manage_holidays`, `add_manager`, `add_delegate`, `cancel_task`, `merge_project`, `handle_subtask_approval`) plus **2 raw-SQL CLAUDE.md recipes** (set cross-board mode, remove child board) — neither of the latter is an engine action.

### `task_history` action counts (production `data/taskflow/taskflow.db`, full history)

| action | rows | maps to feature |
|---|--:|---|
| `cancelled` | **130** | `cancel_task` (and undo path) |
| `subtask_added` | 22 | `reparent_task` side-effect |
| `reparented` | 21 | `reparent_task` (other section) |
| `subtask_removed` | 9 | `detach_task` side-effect |
| `detached` | 9 | `detach_task` (other section) |
| `merged` | **0** | `merge_project` — **never invoked** |
| `external_invite_accepted` | 0 | `accept_external_invite` |
| `child_board_removed` | **0** | raw-SQL recipe — **never invoked** |
| `config_changed` (cross_board_subtask_mode) | **0** | raw-SQL recipe — **never invoked** |
| `restored` | 0 | `restore_task` |

Of the 8 inventory features in scope, **only `cancel_task` shows production traffic** (130 rows over ~60 days, ≈2/day).

### Per-feature state tables

| feature | DB row count | notes |
|---|--:|---|
| `manage_holidays` | **252 rows** in `board_holidays`, 18 distinct boards, 14 distinct labels, dates 2026-01-01 → 2026-12-25 | `set_year` (BR-CE 2026) is the dominant pattern |
| `add_manager` | **29** `board_admins` rows with `admin_role='manager'` | spread across 28 boards |
| `add_delegate` | **1** `board_admins` row with `admin_role='delegate'` | feature exists but only one production grant |
| `cancel_task` | 130 `cancelled` history rows | only admin action with non-trivial volume |
| `remove_child_board` (raw SQL) | 26 live `child_board_registrations`; 0 history rows | net-add only — **never removed** |
| `cross_board_subtask_mode` | **`open`: 28 / 28** | mode flag NEVER moved off default in production |
| `merge_project` | 0 `merged` history; archive has 0 rows with merge snapshot | **never invoked** |
| `handle_subtask_approval` | 0 `subtask_requests` rows ever | **never invoked** (Discovery 19 §"`subtask_requests` approval queue") |

### Inbound message text-search (`store/messages.db`)

| keyword | hits | feature mapping |
|---|--:|---|
| `cancelar` | 83 | `cancel_task` (Portuguese verb) |
| `add_manager` | 0 | (tool calls don't appear in chat content) |
| `add_delegate` | 0 | |
| `manage_holidays` | 0 | |
| `merge_project` | 0 | |
| `cross_board_subtask_mode` | 0 | |
| `remover quadro` | 0 | |
| `handle_subtask_approval` | 0 | |

> Verdict: only `cancel_task` is exercised by user-issued chat; the other admin actions are bot-internal (or never invoked). The keyword-search-against-messages methodology only catches Portuguese verb forms — it would miss `aprovar <id>`/`rejeitar <id>` which fire `handle_subtask_approval` *if any approval queue row existed*, but none do, so the conclusion holds.

---

## Coverage matrix

### 10.1 — Manage board holidays (add / remove / list / set_year)

| | |
|---|---|
| v1 source | `taskflow-engine.ts:7829-7930` (one `case 'manage_holidays'` with sub-switch over `holiday_operation: 'add' \| 'remove' \| 'set_year' \| 'list'`); schema at `taskflow-db.ts` (`board_holidays(board_id, holiday_date, label)` UNIQUE on (board_id, date)). |
| v1 behavior | Manager-only (top-level gate at engine:7382). All 4 ops mutate `board_holidays`. `add` uses `INSERT OR REPLACE` (idempotent); `remove` deletes by `(board_id, date)`; `set_year` does `DELETE WHERE date LIKE 'YYYY-%'` then bulk-INSERT (year-replace pattern); `list` returns rows optionally filtered by year. Each op invalidates `_holidayCache`. Strict `YYYY-MM-DD` regex validation; `set_year` enforces every date matches the supplied year. |
| v2 plan/spec | Spec §"Kanban tools" mentions `set_due_date "(skip-non-business-days option)"` but does NOT enumerate a `manage_holidays`/`holidays.{add,remove,list,set_year}` MCP tool. Plan §A.3.6 has `SELECT COUNT(*) FROM board_holidays … matches v1` as a migration invariant only. Spec §"Board-management tools" lists 4 admin tools — none is a holiday tool. |
| Production | 252 `board_holidays` rows / 18 boards / 14 labels. BR-CE 2026 is the dominant pattern; `set_year` is the realized op (not single `add`/`remove`). |
| **Status** | **MISSING (tool surface)** + COVERED (data migration) |
| **GAP-10.1.tool** | Spec must add an admin MCP tool family — `add_holiday` / `remove_holiday` / `list_holidays` / `set_holiday_year`, OR a polymorphic `manage_holidays(operation, …)` mirroring v1. The 252 production rows are static, but `set_year` will be re-run every December for the next year — feature is alive, not historical. |
| **GAP-10.1.cache** | Spec must restate the `_holidayCache` invalidation contract — any mutation invalidates the in-memory cache used by `isNonBusinessDay` (engine:1084). Without this, weekday-validation reads stale data after a holiday change. |
| **GAP-10.1.year-prefix** | Spec must restate the `set_year` validation contract: every date in the payload starts with `${year}-`. Engine returns precise error per offending date. Plan §7.1 should add a "set_year mismatched-year rejects" error-path test. |

### 10.2 — `add_manager`

| | |
|---|---|
| v1 source | engine:7556-7593 |
| v1 behavior | Manager-only. Resolves person via `requirePerson` (offer_register on miss). Idempotency check (`board_admins WHERE admin_role='manager'`) → "already a manager" error. Phone is read from `board_people.phone` (canonical), `normalizePhone` again at write-time, fallback to `params.phone`. `INSERT INTO board_admins (board_id, person_id, phone, 'manager')`. |
| v2 plan/spec | Spec §"Board-management tools" line 245: `add_board_admin → INSERT user_roles(role='admin', agent_group_id=<board>)`. Plan §2.3.e seeds `taskflow_board_admin_meta` extension table with `is_primary_manager`/`is_delegate` columns. Discovery 13 explicitly maps `board_admins → user_roles + extension`. |
| Production | 29 `manager` grants across 28 boards (one board has 2 managers). |
| **Status** | **PARTIAL — design redesigned, contract not restated** |
| **GAP-10.2.contract** | Spec must restate: (a) idempotency (already-admin → error, not silent no-op); (b) phone canonicalization at write boundary survives the v2 redesign — `user_roles` doesn't carry phone, but `taskflow_board_admin_meta` extension must carry it OR the write boundary normalizes via `users.phone_jid`; (c) `is_primary_manager` from extension distinguishes the v1 distinct semantics ("primary" = receives auto-provision DM ack); Discovery 13 §"`is_primary_manager`" promised this — Plan §2.3.e mentions it but the spec doesn't enumerate the MCP tool input shape. |
| **GAP-10.2.merge-meta** | Plan §2.3.e seeds the extension during one-shot migration but does NOT specify how runtime `add_board_admin` writes both `user_roles` AND `taskflow_board_admin_meta` atomically. Spec must lock in the dual-write contract or the meta column drifts after migration. |

### 10.3 — `add_delegate`

| | |
|---|---|
| v1 source | engine:7595-7633 |
| v1 behavior | Manager-only. Same shape as `add_manager` but `admin_role='delegate'`. Idempotency check + phone canonicalization. Delegates get `process_inbox` (engine:7370-7376) but NOT other admin actions; gate is `isManagerOrDelegate` at engine:3440. |
| v2 plan/spec | Spec lists `add_board_admin` only (one tool). Plan §2.3.e extension table has `is_delegate` column. No spec language enumerates how delegates differ from managers in the v2 MCP surface. |
| Production | **1** delegate grant across 28 boards. Almost dormant feature. |
| **Status** | **PARTIAL — feature is dormant but live** |
| **GAP-10.3.tool** | Spec must clarify: is delegate a separate tool (`add_board_delegate`) or a parameter on `add_board_admin({role: 'manager' \| 'delegate'})`? Currently neither is enumerated. |
| **GAP-10.3.permission-matrix** | Spec must restate the v1 permission matrix: `process_inbox` allows manager OR delegate; ALL other admin actions require manager. v2's `hasAdminRole()` (Discovery 13) is binary — needs the delegate carve-out preserved via `taskflow_board_admin_meta.is_delegate` check OR a separate `'delegate'` role value. |
| **GAP-10.3.dead-code-flag** | Inventory note: with only 1 grant, this may be a port-forward dead-code candidate. Recommend: keep the surface (cheap to maintain) but mark in spec "low-utilization feature; do not invest in UX polish." |

### 10.4 — `cancel_task` (admin path)

| | |
|---|---|
| v1 source | engine:7699-7752 |
| v1 behavior | Manager-only. `requireTask` → archives via `archiveTask(task, 'cancelled')` → `recordHistory(action='cancelled')` → `refreshLinkedParentRollup` → builds `notifications` for meeting participants (excl. sender) or task assignee (excl. sender). **Authority-while-linked guard at engine:7705**: child board cannot cancel parent-owned task — returns "Tarefa pertence ao quadro superior." Subtasks are archived recursively via `archiveTask`. |
| v2 plan/spec | Spec §"Kanban tools" line 255: `cancel_task → Soft-delete (60s undo via task_history)`. Plan §A.3.7 budgets 10 Kanban tools incl. cancel. |
| Production | **130** `cancelled` history rows (60d). Inventory's "admin path" — top-volume admin action. |
| **Status** | **COVERED (named)** |
| **GAP-10.4.linked-guard** | Spec must restate the authority-while-linked guard (engine:7705): child board cannot cancel a delegated parent-owned task. Plan §A.3.7 step 7.1 "Cross-board" tests must include this error path. |
| **GAP-10.4.notifications** | Spec must restate: meeting cancel notifies all `meetingNotificationRecipients` excl. sender; non-meeting cancel notifies assignee excl. sender; cancel labels vary by `type` (`Projeto cancelado` / `Tarefa recorrente cancelada` / `Tarefa cancelada`). Production corpus has all three. |
| **GAP-10.4.undo** | "60s undo" in spec is one-line; v1's undo for cancel routes through `restore_task` (engine:7754-7817), which is a separate admin action. Spec must mention `restore_task` exists or document undo as a `cancel_task` flag. |

### 10.5 — Remove child board from hierarchy (raw SQL)

| | |
|---|---|
| v1 source | NOT an engine action. Lives as a CLAUDE.md raw-SQL recipe at `templates/CLAUDE.md.template:1041`: SELECT linked tasks → refuse if any → confirm → `DELETE FROM child_board_registrations` + `INSERT INTO task_history (action='child_board_removed')`. The recipe explicitly notes: "Raw SQL path — NO undo window, NO notifications, NO engine validation." |
| v1 behavior | Operator/manager via natural-language intent ("remover quadro do [pessoa]"). Bypasses the engine entirely → no transaction, no rollup refresh, no DM to the affected child group. |
| v2 plan/spec | Spec §"Board-management tools" line 244: `archive_taskflow_board → cancel_task for all board schedules`. Discovery 19 §"Hierarchy" shows 26 live registrations / 0 ever removed. Spec does NOT enumerate a `remove_child_board_registration` or "detach hierarchy edge" tool. |
| Production | 26 active registrations, 0 history rows for `child_board_removed` — **the recipe has never been executed.** |
| **Status** | **MISSING (port-forward dead code)** |
| **GAP-10.5.surface** | Spec must decide: (a) port the raw-SQL recipe forward into CLAUDE.md inside the v2 skill (preserve the operator escape hatch); (b) promote it to an `archive_child_board_link` MCP tool with proper transactionality + notifications; or (c) drop it entirely. Production usage is zero, but `archive_taskflow_board` (the spec's nearest neighbor) targets the *board itself*, not the parent-child edge. These are different operations. |
| **GAP-10.5.dead-code-flag** | This is the strongest port-forward dead-code candidate in the admin domain. Recommendation: option (c), drop the recipe, and document in the v2 CLAUDE.md "to detach a hierarchy edge, archive the child board with `archive_taskflow_board` then re-create without parent." If kept, must add notification + history-record contract that the v1 recipe explicitly skips. |

### 10.6 — Set `cross_board_subtask_mode` (raw SQL)

| | |
|---|---|
| v1 source | NOT an engine action. Raw-SQL recipe at `templates/CLAUDE.md.template:413`: `UPDATE board_runtime_config SET cross_board_subtask_mode = 'open' \| 'approval' \| 'blocked'` + `INSERT task_history (action='config_changed', details='{"key":"cross_board_subtask_mode",…}')`. Engine reads at `:5291`; defaults to `'open'` via `ALTER TABLE` at `:1198`. |
| v1 behavior | Manager-only enforcement is at the chat layer (CLAUDE.md template instructs). No engine validation. The mode is read at child-board `add_subtask` time on a delegated parent task (engine:5287-5293) — `'open'` allows direct, `'approval'` queues into `subtask_requests`, `'blocked'` rejects. |
| v2 plan/spec | Spec does NOT enumerate `set_cross_board_subtask_mode` as an MCP tool. Plan §2.3.h preserves the `subtask_requests` table + `/aprovar` text protocol but does not address the *mode-setting* operation. |
| Production | All 28 boards: `cross_board_subtask_mode='open'`. **0 history rows for `config_changed` mentioning the mode.** The flag has never been moved off default. |
| **Status** | **MISSING (port-forward dead code)** |
| **GAP-10.6.surface** | Spec must decide: (a) port the raw-SQL recipe forward to CLAUDE.md (zero-tool overhead, preserves the operator path); (b) elevate to an MCP tool `set_board_config({key, value})` with whitelist of safe keys (mode, language, timezone); (c) drop and hardcode mode='open'. |
| **GAP-10.6.dead-code-flag** | Production has *never* exercised this flag. Discovery 19 §"`subtask_requests` approval queue" classifies this as dead code. **However:** the engine reads the column on every cross-board `add_subtask` (engine:5293), so the column must survive. Recommendation: keep the column (Plan §2.3.h does), keep the raw-SQL recipe in CLAUDE.md, but add an integration test that flipping to `approval` activates `handle_subtask_approval` end-to-end (port-forward correctness, not production-validated). |
| **GAP-10.6.history-shape** | The recipe's `INSERT task_history (… 'config_changed', details=json_object('key','cross_board_subtask_mode','value','open'))` uses a synthetic `task_id='BOARD'` row. Spec must clarify whether v2 keeps board-scoped history pseudo-rows or migrates to a separate `board_audit_log` table. |

### 10.7 — `merge_project`

| | |
|---|---|
| v1 source | engine:8153-8325 (172 LOC, the largest admin case) |
| v1 behavior | Manager-only (re-checked at :8162 even though top gate already runs). Source must be **local** to caller's board (delegated source rejected; Codex review note at :8170-:8174). Both source and target must be `type='project'`. Builds `idMap` (source.subtask_id → target.id+next), then **UPDATE-in-place** (per memory `feedback_update_in_place.md`): `UPDATE tasks SET board_id=?, id=?, parent_task_id=?` + recompute `child_exec_*` for target board + append migration note + rekey `task_history.task_id`. Then rekeys `blocked_by` JSON across ALL tasks (not just merged ones). Adds farewell note on source, archives source as `'merged'`. Returns `merged: {oldId→newId, …}`. |
| v2 plan/spec | Spec lists `add_subtask` / `remove_subtask` but NOT `merge_project`. Plan §A.3.7 step 7.1 "Kanban (10 tools)" doesn't enumerate it. |
| Production | **0 invocations.** No `merged` history rows; no archive snapshots tagged `merged`. Pure dead code in production. |
| **Status** | **MISSING (tool not enumerated)** |
| **GAP-10.7.surface** | Spec must decide: (a) port-forward the tool (172 LOC behavior preserved as `merge_projects`); (b) drop it. Recommendation: **(a) port-forward**. The feature is the canonical UPDATE-in-place pattern (memory feedback) and exists for a reason — production has 22 `subtask_added` rows showing project consolidation is real intent, just routed through manual reparent currently. |
| **GAP-10.7.invariants** | Spec must restate the 5 invariants the engine enforces: (1) source local; (2) both `type='project'`; (3) UPDATE not INSERT+copy (zombie-free); (4) `blocked_by` rekey across **all** tasks (not just merged); (5) source archived as `'merged'` not deleted. |
| **GAP-10.7.dead-code-flag** | Zero production invocations in 60 days. **Port-forward dead-code candidate** — but the implementation is correctness-load-bearing (the UPDATE-in-place pattern). Drop loses the lesson; keep is cheap. Recommend keep + 1 integration test. |

### 10.8 — `handle_subtask_approval`

| | |
|---|---|
| v1 source | engine:8327-8445 (118 LOC) |
| v1 behavior | Manager of TARGET board only (re-checked at :8335). `subtask_requests` row read by `request_id` + `target_board_id`. Status must be `'pending'` (idempotency). Two paths: (a) `'reject'` — UPDATE status='rejected' with **compare-and-swap** on `status='pending'` (Codex finding H, race-safe); returns notification to source group. (b) `'approve'` — validate every proposed assignee is registered on parent board (Codex finding C — would otherwise dangle); create subtasks via `insertSubtaskRow`; UPDATE status='approved' with CAS. If CAS races, rollback created subtasks. Notifications sent back to source-board's `group_jid`. |
| v2 plan/spec | Plan §2.3.h: "`aprovar <id>` text protocol fires `handle_subtask_approval`; NO `ask_user_question` involvement. Per Discovery 10: `subtask_requests` + `/aprovar` text protocol kept (3 reasons reject `pending_approvals` refactor)." Spec §"Cross-board tools" line 266: `forward_to_parent_with_approval` uses `subtask_requests + schedule_task + ask_user_question`. **Spec and plan disagree** on whether the resolution path is `ask_user_question` (spec) or `/aprovar` text protocol (plan/Discovery 10). |
| Production | **0 `subtask_requests` rows ever.** Pure dead code. |
| **Status** | **PARTIAL — spec/plan disagree** |
| **GAP-10.8.spec-plan-conflict** | Spec line 266 says approval cards are delivered via `ask_user_question`; Plan §2.3.h says the `/aprovar` text protocol is preserved per Discovery 10. **One of these is wrong.** Discovery 10 §"3 reasons" rejected `ask_user_question` for this flow (parent-group visibility, hardcoded approve/reject options, free-text reject reason). Recommendation: **plan is correct, spec is stale** — rewrite spec line 266. |
| **GAP-10.8.invariants** | Spec must restate the engine invariants: (a) target-board manager check (not source); (b) CAS on `status='pending'` for both branches; (c) approve-path subtask rollback if CAS races; (d) all proposed assignees must be registered on parent board (offer_register error path); (e) source-board `group_jid` lookup for the notification-back. Five invariants, each load-bearing. |
| **GAP-10.8.dead-code-flag** | Like 10.6+10.7, this is a **port-forward dead-code candidate**. Plan §2.3.h commits to preservation; this is correct given the approval mode column survives and could be flipped any day. The 5 race/correctness invariants make this code more valuable than 10.7's `merge_project` even at zero usage. |

---

## Cross-cutting concerns the v2 spec must address

1. **Permission gate semantics** (engine:7368-7387): top-level `admin()` permission check has 3 tiers — `process_inbox`/`accept_external_invite` carve-outs, all other actions require `isManager`. v2's binary `hasAdminRole()` (Discovery 13) loses the carve-out. Spec must commit to either: (a) `hasAdminRole()` + per-action delegate-check overlay; (b) a 3-valued role enum.
2. **Phone canonicalization at write boundary** (engine:7460, 7578, 7618): `register_person`, `add_manager`, `add_delegate` all canonicalize phones at write time per memory `feedback_canonicalize_at_write.md`. Spec must restate that the v2 contract preserves write-boundary canonicalization (whether storage moves to `users.phone_jid` or stays in `taskflow_board_admin_meta.phone`).
3. **Transaction scoping** (engine:7367): the entire `admin()` dispatcher runs in `this.db.transaction(() => { … })()`. Spec must restate that admin actions are atomic — failures inside `merge_project` etc. roll back partial mutations.
4. **History action-name canonicalization** (Discovery 19 §"action-name drift"): `cancelled` is one form, but `merged`/`reparented`/`detached` use `-ed` past participle while `subtask_added`/`subtask_removed` use composite verb-noun. v2 should canonicalize to a stable taxonomy as part of the port. **GAP-10.x.action-names**.
5. **Raw-SQL recipes (10.5, 10.6)** bypass the engine transaction + notification + rollup machinery. Spec must decide whether to absorb these into MCP tools (gain consistency, lose operator agility) or formalize the "raw SQL escape hatch" as a documented tier (per `feedback_use_v2_natives_dont_duplicate.md` ↔ `feedback_no_nanoclaw_codebase_changes.md` tension).

---

## Status counts

| Status | Count | Feature IDs |
|---|--:|---|
| COVERED | 1 | 10.4 (named, no contract) |
| PARTIAL | 4 | 10.2, 10.3, 10.4 (gaps), 10.8 (spec/plan conflict) |
| MISSING | 3 | 10.1 (tool surface), 10.5 (port decision), 10.6 (port decision), 10.7 (tool not enumerated) |
| GAP totals | **15 distinct GAPs** | 10.1.tool, 10.1.cache, 10.1.year-prefix, 10.2.contract, 10.2.merge-meta, 10.3.tool, 10.3.permission-matrix, 10.3.dead-code-flag, 10.4.linked-guard, 10.4.notifications, 10.4.undo, 10.5.surface, 10.5.dead-code-flag, 10.6.surface, 10.6.dead-code-flag, 10.6.history-shape, 10.7.surface, 10.7.invariants, 10.7.dead-code-flag, 10.8.spec-plan-conflict, 10.8.invariants, 10.8.dead-code-flag, action-names |

### Port-forward dead-code candidates (zero production invocations)

| ID | Feature | Production | Recommendation |
|---|---|---|---|
| 10.5 | Remove child board (raw SQL) | 0 / 26 active | Drop or document as escape-hatch; consolidate with `archive_taskflow_board` |
| 10.6 | Set cross_board_subtask_mode | 0 / 28 boards on default | **Keep** (engine reads it on every delegated subtask) — port-forward as raw-SQL recipe |
| 10.7 | `merge_project` | 0 invocations | **Keep** — pattern-load-bearing (UPDATE-in-place); 1 integration test |
| 10.8 | `handle_subtask_approval` | 0 `subtask_requests` rows ever | **Keep** — Plan §2.3.h commits; race-correctness load-bearing |

Three of four "dead" features stay in scope because the supporting columns/tables are alive and the implementation embodies invariants the v2 port must not regress.

---

## Recommended plan/spec amendments

1. **Spec §"Board-management tools" expansion** — add 4 missing admin MCP tools or document as raw-SQL recipes: `manage_holidays` (10.1), `set_board_config` (10.6), `merge_project` (10.7), `archive_child_board_link` (10.5 if kept). Resolves 10.1.tool, 10.5.surface, 10.6.surface, 10.7.surface.
2. **Spec line 266 correction** — replace `ask_user_question` with `/aprovar` text protocol per Discovery 10 + Plan §2.3.h. Resolves 10.8.spec-plan-conflict.
3. **Spec §"Permission matrix" addendum** — restate the 3-tier gate (manager-only / manager-or-delegate / external-grant) and how `taskflow_board_admin_meta` extension carries `is_delegate`. Resolves 10.3.permission-matrix, 10.2.merge-meta.
4. **Spec §"Cross-cutting" admin invariants** — list the 5 cross-cutting concerns above (transactions, canonicalization, action-name canonicalization, raw-SQL escape hatch, dead-code preservation rationale).
5. **Plan §A.3.7 step 7.1 "Admin (10 tools)"** — explicit category absent today. Add: `add_board_admin` (manager + delegate variants), `cancel_task` (admin path with linked-guard), `restore_task`, `manage_holidays` (4 ops), `merge_project`, `handle_subtask_approval` (approve + reject + CAS-race). At least 12 tests for parity.
6. **Plan §A.3.6 invariants** — keep the existing `board_holidays` row-count check (already there); add `child_board_registrations` row-count check (26); add `cross_board_subtask_mode = 'open'` distribution check (28/28).

---

## Production source code references

- **Engine `admin()` dispatcher (17 cases):** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:7365-:8454`
- **`manage_holidays`:** `:7829-:7930`
- **`add_manager`:** `:7556-:7593`
- **`add_delegate`:** `:7595-:7633`
- **`cancel_task`:** `:7699-:7752` (authority-while-linked guard at :7705)
- **`merge_project`:** `:8153-:8325`
- **`handle_subtask_approval`:** `:8327-:8445` (CAS at :8361, :8425; assignee-validation at :8390)
- **`isManager` / `isManagerOrDelegate`:** `:2342`, `:3440`
- **Cross-board mode read site:** `:5287-:5293`
- **`board_holidays` cache:** `_holidayCache` at `isNonBusinessDay` (`:1084-:1130`)
- **Raw-SQL recipe (cross-board mode):** `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template:413`
- **Raw-SQL recipe (remove child board):** `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template:1041`
- **Production DB:** `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`
- **Production messages DB:** `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/store/messages.db`

## Anchor references

- Plan §A.3.2 step 2.3.e (seed-board-admins.ts): `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md:136`
- Plan §A.3.2 step 2.3.h (cross-board approval port-forward): `:139`
- Plan §A.3.6 invariant `board_holidays`: `:227`
- Plan §A.3.7 step 7.1 (per-tool coverage): `:238`
- Spec §"Board-management tools": `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md:239-246`
- Spec §"Cross-board tools" (10.8 conflict): `:261-:266`
- Spec §"Kanban tools" `cancel_task`: `:255`
- Discovery 13 (user_roles + extension): `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/13-user-roles.md`
- Discovery 19 §"`subtask_requests` approval queue": `…/19-production-usage.md:435`
- Discovery 19 §"action-name drift": `…/19-production-usage.md:345`
- Discovery 00 §"Permissions" (board_admins → user_roles): `…/00-synthesis.md:33`
- Memory `feedback_update_in_place.md` (informs 10.7 invariants)
- Memory `feedback_canonicalize_at_write.md` (informs cross-cutting #2)
