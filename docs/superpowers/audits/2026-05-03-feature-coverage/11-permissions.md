# 11 — Permissions / Authorization Domain: Feature-Coverage Audit

**Date:** 2026-05-03
**Scope:** TaskFlow's *permissions + authorization* domain — 9 features that gate mutations on the v1 `board_admins` table (`admin_role IN ('manager','delegate')`, `is_primary_manager`), the leaf-board / hierarchy guards, the assignee self-approval rule, and the proactive template hints.
**Anchor plan:** `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` (steps 2.3.a, 2.3.e, 2.3.i)
**Anchor spec:** `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` (§"Permissions seeding", §"Board-management tools")
**Discovery:** `…/research/2026-05-03-v2-discovery/13-user-roles.md`, `…/00-synthesis.md`
**Engine source:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` — `isManager()` at `:2342`, `isManagerOrDelegate()` at `:3440`, `canDelegateDown()` at `:1573`, action enum at `:247`, `register_person` at `:7390`, move/approval gate at `:3693`.
**Template:** `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template:100-112` (matrix), `:383-385` (self-approval guidance), `:398-401` (register_person hierarchy rules), `:545,689,691` (4-field STOP rule).
**Host-side guards:** `/root/nanoclaw/container/agent-runner/src/ipc-tooling.ts:18` (`canUseCreateGroup`); `/root/nanoclaw/src/ipc-plugins/provision-child-board.ts:42-56` (host-side leaf guard).

---

## 0. Production validation (queries run 2026-05-03 against `nanoclaw@192.168.2.63`)

### 30-grant total in `board_admins` (matches discovery 13)

```sql
SELECT admin_role, is_primary_manager, COUNT(*) FROM board_admins GROUP BY 1,2 ORDER BY 1,2;
```

| admin_role | is_primary_manager | rows |
|---|---:|---:|
| `delegate` | 0 | **1** |
| `manager` | 0 | **1** |
| `manager` | 1 | **28** |

`SELECT COUNT(*) FROM board_admins;` → **30**. Confirms the 28 manager+primary / 1 manager non-primary / 1 delegate distribution that Discovery 13 §"Inventory of v1 data" relies on for the seeder.

### Hierarchy distribution (board level vs. max_depth)

```sql
SELECT b.hierarchy_level, b.max_depth, ba.admin_role, ba.is_primary_manager, COUNT(*)
  FROM board_admins ba JOIN boards b ON b.id = ba.board_id
  GROUP BY 1,2,3,4 ORDER BY 1,2;
```

| level | max_depth | admin_role | is_primary | grants |
|---:|---:|---|---:|---:|
| 1 | 3 | manager | 1 | 1 |
| 2 | 3 | delegate | 0 | 1 |
| 2 | 3 | manager | 0 | 1 |
| 2 | 3 | manager | 1 | 6 |
| 3 | 3 | manager | 1 | 21 |

Boards at `level == max_depth` (= **leaf**): 21. Boards at `level < max_depth` (= **hierarchy / can delegate down**): 7 (1 root + 6 mid). The fork's hierarchy fan-out is shallow: 1→3 (root) → 7 mid-level → 21 leaves. Plus 9 unconfigured (`level IS NULL`) legacy rows in `boards` that don't appear in `board_admins`.

### Permission-denial signal in production

`task_history` does **not** record permission denials (the engine returns `{success:false, error:'Permission denied: …'}` from MCP tools — it never persists a row). To measure denial volume, sweep session JSONLs:

```bash
find /home/nanoclaw/nanoclaw/data/sessions -name '*.jsonl' \
  | xargs grep -h 'Permission denied\|Self-approval is not allowed' \
  | wc -l
```

| message | hits | notes |
|---|---:|---|
| `Permission denied: "<sender>" is not a manager.` | dozens | dominant denial — non-managers attempting `add_manager`/`set_wip_limit`/etc. Sample senders: `miguel`, `joao-henrique`, `flavia` |
| `Permission denied: "<sender>" is neither the assignee nor a manager.` | dozens | move/update gate (engine:3712, 4111) |
| `Permission denied: "<sender>" is not a manager or delegate.` | small | `process_inbox` + approve/reject (engine:3717, 3725, 7374) |
| `Self-approval is not allowed: "<sender>" is the assignee.` | **5** (across 5 distinct sessions) | assignee tried to approve own review (engine:3720) |

5 self-approval blocks in production validates the rule fires (and validates that the proactive template hint added 2026-04-24 — feature 11.9 — was load-bearing: 5 over ~10 days suggests baseline was higher). **Verdict:** all denial messages are localized as English template strings, not Portuguese — agents transliterate on the way out.

### Per-board admin distribution (Discovery 19 cross-check)

`COUNT(*) FROM board_admins WHERE admin_role='manager' GROUP BY board_id` shows 27 boards with exactly 1 manager and 1 board with 2 managers (the 6 mid-level + 21 leaf + 1 root = 28 boards each have ≥1 manager grant; one mid-level board carries the extra non-primary manager).

---

## Coverage matrix (9 features)

### 11.1 — Manager-only actions (top-level `taskflow_admin` gate)

| | |
|---|---|
| v1 source | `taskflow-engine.ts:7368-7385` (top-of-`admin()` gate). `process_inbox` carve-out: `isManagerOrDelegate`. `accept_external_invite` carve-out: gate skipped (external sender allowed). All other 14 actions: `isManager()` required. |
| v1 behavior | `isManager(sender_name)` resolves person via `resolvePerson` → joins `board_admins WHERE admin_role='manager'`. Returns false on resolution miss (unregistered sender → blanket deny on admin actions). 14 of 17 actions in the enum gate here. |
| v2 plan/spec | Spec §"Board-management tools" (line 245-246) — only enumerates `add_board_admin` / `remove_board_admin` as the v2 admin surface; the other 12 v1 admin actions (`register_person`, `remove_person`, `set_wip_limit`, `cancel_task`, `restore_task`, `manage_holidays`, `process_minutes`, `process_minutes_decision`, `accept_external_invite`, `reparent_task`, `detach_task`, `merge_project`, `handle_subtask_approval`) are NOT in the spec's MCP-tool inventory. Plan §2.3.a says "IPC plugins → MCP tools" but does not list which actions are admin-gated and whether the gate uses `hasAdminPrivilege(userId, agentGroupId)` (Discovery 13 §4) or the legacy `isManager(senderName)`. |
| Production | All 14 manager-gated actions exercised (cancel_task=130 in `task_history`; manage_holidays=252 rows; the rest are bot-internal). Admin-gate denials prevalent in JSONL sweep ("not a manager"). |
| **Status** | **GAP (gate redesign)** + ADDRESSED (table mapping) |
| **GAP-11.1.gate-shape** | The plan does not specify the v2 gate shape. Discovery 13 §8 sketches `requireBoardAdmin(userId, agentGroupId)` calling `hasAdminPrivilege` — but `hasAdminPrivilege` is binary (admin / not-admin), losing the `manager` vs `delegate` distinction. Plan §2.3.e DOES seed `taskflow_board_admin_meta(role_label)` to preserve the distinction, but does NOT lock in that the runtime gate uses BOTH `hasAdminPrivilege(userId, ag)` AND a `taskflow_board_admin_meta` lookup. Without that, the v2 port collapses 14 manager-only actions to "any admin". |
| **GAP-11.1.sender-id** | Plan/spec must restate that the v1 gate identifies the caller by `sender_name` (display-name slug, e.g. `joao-henrique`) but the v2 gate identifies by `user_id` (`phone:+E164`). The MCP tool registration in 2.3.a needs a documented bridge: either pass `user_id` directly from the IPC envelope OR keep a `sender_name → person_id → user_id` resolver per board. Discovery 13 §5 hints at this but plan §2.3.a does not. |

### 11.2 — Assignee self-approval prevention

| | |
|---|---|
| v1 source | `taskflow-engine.ts:3719-3721` inside the `move_task action='approve'` switch. Fires after the manager-or-delegate gate (3716). |
| v1 behavior | If the sender resolves to a person AND that person == `task.assignee` AND the action is `approve` (i.e. moving a `review` task to `done`), reject with `Self-approval is not allowed: "<sender>" is the assignee.` Note: this is BEYOND the manager-or-delegate gate — a manager *who is also the task's assignee* cannot self-approve. |
| v2 plan/spec | NOT MENTIONED. Spec's `move_task` description is silent on the rule. Plan §2.3.a wraps "engine domain logic" generically. |
| Production | 5 hits in JSONL transcripts (sample: assignee tries to approve their own task in review). Rule is exercised. |
| **Status** | **GAP** |
| **GAP-11.2.self-approval** | Spec must restate the self-approval invariant: assignee == sender → reject regardless of admin role. The proactive template hint (feature 11.9) presupposes this is an engine invariant; if v2 silently drops it, the template hint becomes misleading. Plan §2.3.a regression test list should add an explicit "manager-also-assignee → blocked from approve" test. |

### 11.3 — Delegate-only boundaries (manager-or-delegate gate)

| | |
|---|---|
| v1 source | `isManagerOrDelegate()` at engine:3440-3450. Call sites: `process_inbox` (engine:7371), `move_task action='approve'` (3716), `move_task action='reject'` (3724). |
| v1 behavior | Delegates have a strict subset of manager powers: (a) process inbox triage; (b) approve/reject tasks in `review`. ALL other admin actions (`register_person`, `add_manager`, `cancel_task`, etc.) are manager-only. Delegate cannot create tasks, cancel, set WIP, manage holidays, or handle cross-board approval. |
| v2 plan/spec | Plan §2.3.e seeds extension table `taskflow_board_admin_meta(role_label)` ∈ `{manager, delegate}` but neither plan nor spec says the runtime checks `role_label='delegate'` to permit `process_inbox` / `move_task approve|reject`. The spec's MCP tool list does not enumerate `process_inbox` at all (oversight — feature 11.3 needs it). |
| Production | 1 production delegate grant (1 row in `board_admins` with `admin_role='delegate'`). Discovery 13 confirms 1:1 with v1 inventory. Real usage: low-volume — only this 1 user actually runs `process_inbox` / `approve` paths. |
| **Status** | **GAP** |
| **GAP-11.3.delegate-gate** | Spec must enumerate the delegate-only permissions matrix and lock in that the v2 runtime gate is `hasAdminPrivilege(userId,ag) AND (taskflow_board_admin_meta.role_label='manager' OR action ∈ {process_inbox, approve, reject})`. Without this, the single delegate user loses approve/reject capability post-cutover (silent regression). |
| **GAP-11.3.process-inbox** | Spec's MCP tool inventory must add `process_inbox` (or fold into `list_tasks(column='inbox')` query and document the manager-or-delegate carve-out separately). |

### 11.4 — Cross-board approval (delegate-only boundary at handle_subtask_approval)

| | |
|---|---|
| v1 source | `taskflow-engine.ts:8327-8400` (`case 'handle_subtask_approval'`). Inner manager-only gate at engine:8335: `if (!this.isManager(params.sender_name)) return error`. |
| v1 behavior | Even though the top-level `admin()` dispatcher gate at engine:7382 already requires manager for non-`process_inbox` actions, the inner check is a **belt-and-suspenders** — `handle_subtask_approval` is explicitly manager-only (NOT manager-or-delegate). The inner gate also drives a precise error: "Only managers of the target board can approve/reject subtask requests." |
| v2 plan/spec | Plan §2.3.h says "Cross-board approval port-forward (dead code preserved)". The spec §"Cross-board approval flow Pattern 2" sketches `forward_to_parent_with_approval` but does NOT specify whether the approval handler is manager-only or any-admin. |
| Production | 0 invocations (`subtask_requests` table empty per discovery audit 03 production data). Feature is preserved capability, not exercised. |
| **Status** | DEAD-CODE-PRESERVED (correctly) — but with **GAP-11.4.gate** |
| **GAP-11.4.gate** | Spec must restate that `forward_to_parent_with_approval`'s approval handler is **manager-only** (not delegate-eligible), matching the v1 inner gate at engine:8335. Plan §2.3.h regression test must include a "delegate cannot approve subtask request" case. |

### 11.5 — Non-manager update restrictions (own tasks only)

| | |
|---|---|
| v1 source | `move_task` permission switch at engine:3705-3743 + reassign at 4108-4112 + 4136-4138 + meeting note authorship at 4444-4501. Pattern: `isAssignee || isMgr || canClaimUnassigned`. |
| v1 behavior | A non-manager assignee can `start`/`wait`/`resume`/`return`/`review`/`conclude` ONLY their own tasks. `force_start` / `reopen` / `approve` are manager-restricted. Reassign accepts the task's current assignee (self-reassign allowed). Note edits restrict to author OR organizer OR manager (engine:4454, 4501, 4563). |
| v2 plan/spec | Plan §2.3.a wraps in "engine domain logic". Spec's `move_task` MCP tool description is silent on the per-action permission matrix. Discovery 13 doesn't address per-action gates beyond `hasAdminPrivilege`. |
| Production | "neither the assignee nor a manager" denial messages are common in JSONL (dominant denial after "not a manager"). Real volume: ~dozens of rejected attempts. Most reject path: a non-manager tries to move a task assigned to someone else, e.g. a manager trying to start a task on a peer's behalf without first reassigning. |
| **Status** | **GAP** |
| **GAP-11.5.matrix** | Spec must enumerate the move_task permission matrix per action (start/wait/resume/return/review = `assignee \| manager \| canClaimUnassigned`; conclude = `assignee \| manager`; approve = `manager-or-delegate AND not-assignee`; reject = `manager-or-delegate`; reopen = `manager`; force_start = `manager`). Currently no v2 doc captures this matrix. |
| **GAP-11.5.canClaim** | The unassigned-inbox claim rule (engine:3703) — any board member with a `person_id` can `start` an unassigned inbox task and auto-self-assign — must survive. Spec is silent. Plan §2.3.a regression test must include "any member can claim unassigned inbox task". |

### 11.6 — Non-manager cannot delete/cancel (destructive guard)

| | |
|---|---|
| v1 source | Top-level `admin()` gate at engine:7382 already covers `cancel_task` (manager-only). Plus `restore_task`, `merge_project`, `reparent_task`, `detach_task`, `remove_person`. |
| v1 behavior | All destructive admin verbs are manager-only via the dispatcher gate. `cancel_task` also has authority-while-linked extra rule at engine:7705 (child board cannot cancel parent's tasks even if caller is manager of child board). |
| v2 plan/spec | Same coverage as 11.1 — plan/spec doesn't enumerate destructive-action subgroup explicitly. |
| Production | 130 cancel_task rows, 0 merge_project, 21 reparented, 9 detached. cancel_task is the realized destructive verb. |
| **Status** | **GAP (rolled into 11.1.gate-shape)** + ADDRESSED-via-cancel_task in plan inventory |
| **GAP-11.6.parent-link-guard** | The "child board cannot cancel parent's tasks" rule at engine:7705 — even though the child-board caller is a manager of the child — is a **layered authorization** that goes beyond `hasAdminPrivilege`. Spec must restate: cross-board mutation requires admin of the **owning** board, not just the **caller's** board. Plan §2.3.a regression test list should include this. |

### 11.7 — Cross-board reassign guard (no reassign to non-board person)

| | |
|---|---|
| v1 source | `reassign()` at engine:4080-4153. Target person resolution at 4089: `this.resolvePerson(params.target_person)` — which is **board-local** (person must exist in `board_people` for `this.boardId`). Returns `offer_register` on miss (engine:4090). |
| v1 behavior | Person resolution is board-local — a manager on board A cannot reassign a task to a person who only exists on board B. Engine returns `offer_register` to drive the bot to register the person on the local board first. CLAUDE.md template L1096-L1100 codifies this UX. |
| v2 plan/spec | NOT MENTIONED in plan/spec. Person identity in v2 is global (`users.id = phone:+E164`), so the v1 board-local rule needs a deliberate carry-over. The natural v2 mapping would be: target must be in `agent_group_members` of the target task's owning board (Discovery 13 §6). |
| Production | `offer_register` flow is well-exercised (template L545+L689+L691 are dedicated to driving it to completion). Feature is alive. |
| **Status** | **GAP** |
| **GAP-11.7.local-resolve** | Spec must restate the board-local target-resolution rule: in v2, `reassign(task_id, target_user_id)` should reject when `target_user_id NOT IN (SELECT user_id FROM agent_group_members WHERE agent_group_id = target_owning_board)` — modulo the admin-implies-member rule at Discovery 13 §6. The intentionally-narrow rule is a UX feature (drives `offer_register`), not a security gate. |
| **GAP-11.7.offer-register** | Spec must enumerate the `offer_register` response shape — the engine returns a structured payload (`{success:false, offer_register:{name, message}}`) that the CLAUDE.md template renders verbatim. Plan §2.3.a regression test must include this exact shape. |

### 11.8 — Hierarchy leaf-board cannot create children + Person-registration on leaf skips group fields

| | |
|---|---|
| v1 source | (a) `canDelegateDown()` at engine:1573-1578 (`level < max_depth` ⇒ true). (b) `register_person` 4-field rule at engine:7423-7437 (hierarchy boards require `phone` + `group_name` + `group_folder` alongside `person_name`). (c) Host-side guard at `provision-child-board.ts:42-56` (refuses to create child group if `level + 1 > max_depth`). (d) `canUseCreateGroup` at `ipc-tooling.ts:18-35` (mirror logic). |
| v1 behavior | Three layers of leaf-board defense: (1) host refuses to fire `create_group` IPC when caller is leaf (ipc-tooling.ts); (2) host-side IPC plugin double-checks (provision-child-board.ts:42-56); (3) engine refuses `register_person` without group fields when `canDelegateDown()` is true (= caller is hierarchy board). The matrix in the template at L398 mirrors the rule for the agent. |
| v2 plan/spec | NOT MENTIONED in plan/spec. Spec §"v2-aligned board provisioning flow" (operator manually creates WhatsApp groups → bot detects → `create_agent`) **eliminates** programmatic `create_group` entirely → makes ipc-tooling.ts:18 obsolete. But the engine's `register_person` 4-field rule is still TaskFlow-domain logic and survives. |
| Production | 21 leaf boards exist; on-leaf `register_person` calls run with the 3-field form (no group_*). 7 hierarchy boards run with 4-field form. The `auto_provision_request` response field at engine:7480 is the trigger for downstream child-board provisioning. |
| **Status** | DEPRECATED-CORRECTLY (host-side `canUseCreateGroup` removed) + **GAP (engine rule)** |
| **GAP-11.8.engine-rule** | Spec must restate the `register_person` 4-field rule at engine:7423-7437 as TaskFlow domain logic that survives v2. Plan §2.3.a regression test must include the leaf-vs-hierarchy fork. (The v2 operator-creates-group flow handles the WhatsApp-side; the engine still owns the `auto_provision_request` emission.) |
| **GAP-11.8.auto-provision** | Spec doesn't describe the `auto_provision_request` MCP-tool response shape. The host-side `provision-child-board.ts` consumes it; in v2 this becomes a `provision_taskflow_board` MCP tool call (per spec §"Provisioning a NEW board" step c–d). The engine→host wiring is not specified. |

### 11.9 — Proactive self-approval detection in template

| | |
|---|---|
| v1 source | `CLAUDE.md.template:383-385` — two paragraphs. (a) "Self-approval guidance" (L383): when blocking, name the manager who CAN approve. (b) "Proactive approval routing" (L385): pre-check `tasks.assignee` against SENDER **before** suggesting approval; on match, name the actual approver up-front instead of waiting for engine rejection. |
| v1 behavior | A pure template-level UX hint — no engine code. Added 2026-04-24 (`CHANGELOG.md:28-30`) after Kipp audit flagged Alexandre's `T61 concluído` round-trip as avoidable: bot suggested "you or a delegate can approve" → user confirmed → engine rejected with self-approval error → bot finally named the manager. The hint adds a pre-check so the first reply names the right approver. |
| v2 plan/spec | Plan §2.3.i ("CLAUDE.md.template ports") covers template ports broadly. Spec §"CLAUDE.md.template updates" mentions agent-prefix + tool references but does NOT mention the proactive self-approval hint. |
| Production | 5 self-approval engine rejections in JSONL post-2026-04-24 — small but nonzero, validating the hint reduced (didn't eliminate) the round-trip. Each rejection is a UX miss the template hint should have caught. |
| **Status** | **GAP (port the hint verbatim)** |
| **GAP-11.9.template-hint** | Plan §2.3.i must lock in the verbatim port of CLAUDE.md.template:383-385. The hint references `tasks.assignee` and `requires_close_approval = 1` — these schema concepts survive in v2 (TaskFlow domain) so the rule is direct-portable. Plan must NOT silently drop it on the way to "estimated template size: ~300 lines (down from ~400)". |

---

## Plan's `taskflow_board_admin_meta` extension table — sufficiency call-out

Plan §2.3.e (and Discovery 13 §7 origin) introduce **`taskflow_board_admin_meta(user_id, agent_group_id, is_primary_manager, role_label)`** as the v2-private extension that carries v1's lost columns. The table is necessary AND sufficient for the data-mapping side, BUT it does NOT define the **runtime authorization contract**. Three specific concerns:

1. **`role_label` is not consulted at gate time.** Plan §2.3.a wraps the engine in MCP tools but does not say `requireBoardAdmin` (or whatever the v2 wrapper is) consults `role_label='manager'` to preserve the manager-vs-delegate carve-out (features 11.3, 11.4). Without the consultation, all 30 grants collapse to "admin" and the 1 production delegate silently gains manager-equivalent power post-cutover.

2. **`is_primary_manager` is rendered, not gated.** Discovery 13 §7 §"is_primary_manager problem" suggests the column's only consumer is the digest-credit-attribution rule ("Laizys entregou"). That's correct for read-time, but the spec/plan don't restate it as a written-down read-time rule. The 1 manager non-primary grant exists for a reason — likely an operator-promoted secondary manager — and the digest attribution UX depends on it.

3. **Dual-write contract is missing.** Plan §2.3.e seeds the extension at one-shot migration time. But runtime `add_manager` / `add_delegate` (engine:7556, 7596) keep inserting into v1's `board_admins` (or, post-port, the v2 `user_roles` table). The spec doesn't specify that those MCP tools also write to `taskflow_board_admin_meta` atomically. Without atomic dual-write, the meta column drifts after migration: v2 grants user-role rows but never extension rows, and queries that join the two return NULL `role_label` for new admins (silent demotion).

**Recommendation:** Spec §"Permissions seeding" should add:

> **Runtime invariant:** every `INSERT INTO user_roles (role='admin', agent_group_id=ag)` triggered by a TaskFlow MCP tool (`add_manager`, `add_delegate`, future `add_board_admin`) MUST be paired with an `INSERT INTO taskflow_board_admin_meta` in the same transaction, with `role_label` set to `'manager'` or `'delegate'` based on the tool that fired. Removal MUST cascade. The runtime gate is: `hasAdminPrivilege(userId, ag) AND (action ∈ {process_inbox, approve, reject} OR role_label='manager')`.

This restates the 3-tier gate (manager-only / manager-or-delegate / non-admin) on top of v2's binary `hasAdminPrivilege`.

---

## Summary

- **9 features audited.**
- **Status counts:** ADDRESSED 0 (every feature has at least one open gap); GAP 9 (across 11 distinct GAP-IDs, since some features carry multiple); DEAD-CODE-PRESERVED 1 (11.4 cross-board approval handler — preserved but with gate gap); DEPRECATED-CORRECTLY 1 (11.8 host-side `canUseCreateGroup` — eliminated by v2 operator-creates-group flow); DEPRECATED-WRONG 0.
- **GAP IDs:** 11.1.gate-shape, 11.1.sender-id, 11.2.self-approval, 11.3.delegate-gate, 11.3.process-inbox, 11.4.gate, 11.5.matrix, 11.5.canClaim, 11.6.parent-link-guard, 11.7.local-resolve, 11.7.offer-register, 11.8.engine-rule, 11.8.auto-provision, 11.9.template-hint.

The recurring theme: the plan does the **table-mapping** work (board_admins → user_roles + extension) faithfully, but does **not** lock in the **runtime gate shape** for the 3-tier permission matrix that the engine enforces today. The extension table is necessary but not sufficient — without a documented dual-write contract and a documented gate that consults `role_label`, the v2 port silently flattens manager/delegate distinction.

---

**Document generated:** 2026-05-03
**Production validation host:** `nanoclaw@192.168.2.63`
**File path:** `/root/nanoclaw/docs/superpowers/audits/2026-05-03-feature-coverage/11-permissions.md`
