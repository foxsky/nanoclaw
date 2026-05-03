# Coverage Matrix — Sections I + J: Cross-Board Subtask Approval & Cross-Board Rollup

> **Date:** 2026-05-03
> **Scope:** validate v2 plan covers all 15 cross-board features — I.1–I.10 (subtask flow: open/approval/blocked modes, request routing, approval/rejection, idempotency, auto-link, manual link) + J.1–J.5 (rollup signals, child-board read, 🔗 marker, atualizar status, write-path guards).
>
> **Inputs (cited by caller):**
> - `docs/superpowers/audits/2026-05-03-add-taskflow-feature-inventory.md` §I, §J
> - `docs/superpowers/audits/2026-05-03-add-taskflow-v1v2-mapping.md` §I, §J
> - `docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`
> - `docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` (Pattern 2)
> - `docs/superpowers/research/2026-05-03-v2-discovery/14-destinations-acl.md`
> - `docs/superpowers/research/2026-05-03-v2-discovery/19-production-usage.md`
> - `docs/superpowers/research/2026-05-03-v2-discovery/20-fork-divergence.md`
>
> **Caveat — missing inputs.** As of audit time, none of the seven cited input documents exist on disk (`/root/nanoclaw/docs/superpowers/audits/2026-05-03-feature-coverage/` contains only sibling audits 01, 04, 05; `audits/`, `plans/`, `research/2026-05-03-v2-discovery/` directories were not present locally or on the prod fork at `/home/nanoclaw/nanoclaw/docs/superpowers/`). The closest pre-existing artefact is `/root/nanoclaw-feat-v2/docs/superpowers/specs/2026-04-09-cross-board-subtask-approval-design.md` (the original I.* design) and `/root/nanoclaw-feat-v2/docs/superpowers/plans/2026-04-12-cross-board-subtask-phase1.md` + `2026-03-28-cross-board-rollup.md`. **This audit is therefore grounded in (a) the production engine source, (b) live DB queries on `192.168.2.63`, and (c) the surviving Phase-1/Phase-2 design docs.** When the v2 plan/spec materialise, the GAP rows below should be re-checked verbatim — every status assertion in this document maps to a specific engine line range or DB query so it is straightforward to reverify.
>
> **Source of truth (verified):**
> - Engine (prod): `/home/nanoclaw/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (9598 lines).
> - Subtask-approval branch: `:5287–5375` (mode gate + `subtask_requests` INSERT) and `:8327–8460` (`handle_subtask_approval`).
> - Rollup engine: `:9082–9230` (link/unlink/refresh_rollup), `:9234+` (tag_parent), `:9450–9530` (`computeAndApplyRollup`), `:9540–9590` (`refreshLinkedParentRollup`).
> - Visibility helpers: `:1010–1030` (`visibleTaskScope` + `excludeActiveRollup`), `:1595–1625` (`getTask` cross-board fallback), `:1820–1830` (`getLinkedTasks`).
> - Schema: `subtask_requests` table created at `:1242–1265`; `cross_board_subtask_mode` column at `:1198`.
> - Tests: `taskflow-engine.test.ts:6244–6438` (handle_subtask_approval suite — approve/reject/idempotency/non-pending/unknown-id/unregistered-assignee/non-manager).
> - MCP tool surface: `ipc-mcp-stdio.ts:1249–1266` (admin action enum + `decision`/`request_id`/`reason` params).

---

## Production validation (refreshed 2026-05-03)

All queries against `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` (central authoritative DB; per-group `/home/nanoclaw/nanoclaw/groups/<board>/taskflow.db` files exist as empty stubs only).

### I.* — cross-board subtask approval (DEAD CODE)

| Metric | Value | Query |
|---|---:|---|
| `board_runtime_config.cross_board_subtask_mode` distribution | **`open` × 28** | `SELECT mode, COUNT(*) FROM board_runtime_config GROUP BY 1` |
| Total `board_runtime_config` rows | 28 | (all 28 active boards default) |
| Total `boards` rows | 37 | 9 boards have no runtime_config (probably archived/unused) |
| `subtask_requests` rows ever | **0** | `SELECT COUNT(*) FROM subtask_requests` |
| Inbound text "aprovar req-…" / "rejeitar req-…" in `messages.content` | **0** | `messages.db` LIKE `aprovar req-%` OR `rejeitar req-%` |
| Outbound "🔔 Solicitação de subtarefa" in `send_message_log.content_preview` | **0** | LIKE `%Solicita__o de subtarefa%` |

**Conclusion:** zero boards on `approval` or `blocked`. Zero requests created. Zero approvals/rejections sent. The Phase-2 path has never been exercised in production. Phase 1 (`open` mode + auto-link) is what actually runs.

### J.* — cross-board rollup (HEAVILY USED)

| Metric | Value | Query |
|---|---:|---|
| Tasks with `child_exec_enabled=1` | **243** | `WHERE child_exec_enabled=1` |
| Boards owning rollup-linked tasks (parents) | **5** (seci, sec, setec-secti, laizys, thiago) | `SELECT board_id, COUNT(*) GROUP BY 1` |
| Boards receiving delegations (children) | **23** distinct | `SELECT child_exec_board_id, COUNT(*) GROUP BY 1` |
| `child_board_registrations` rows | **26** | per-person child-board links |
| Tasks with `child_exec_rollup_status` set | 9 (1 active, 1 blocked, 2 no_work_yet, 5 ready_for_review) | the rest are linked but never rolled up |
| Tasks with `child_exec_last_rollup_at` set | 9 | confirms 9 rollups have actually fired |
| Tasks with `linked_parent_*` set (auto-rollup hop) | 3 | minor path |
| `task_history` action=`child_board_created` | 25 | initial provisioning |
| `task_history` action=`child_board_linked` | 1 | manual `taskflow_hierarchy(action='link')` |
| `task_history` action=`child_rollup_updated` | 5 | refresh_rollup invocations producing real diff |
| `task_history` action=`child_rollup_at_risk` | 1 | status-change record |
| `task_history` action=`child_rollup_blocked` | 1 | status-change record |
| Outbound digests / standups containing 🔗 marker | **101** of 1488 | `send_message_log.content_preview LIKE '%🔗%'` |
| Inbound "atualizar status TXX" / "sincronizar TXX" (real refresh_rollup invocations from a user) | **1** | `messages` table; lone hit is `_atualizar status P11.19_` |

**Conclusion:** rollup state is referenced by 243 tasks across 5 parent boards into 23 child boards, and the 🔗 marker is rendered in 101 outbound messages — but the **refresh is almost entirely auto-fired from `refreshLinkedParentRollup` on child-side mutations** (engine `:9540`), not user-typed `atualizar status`. The user-typed refresh is essentially zero-volume; the auto-rollup pathway is what carries the feature.

> **Rollup invocation mechanism (verified by inspecting engine flow):**
> 1. User on child board calls `taskflow_update`/`taskflow_admin` to mutate a delegated subtask.
> 2. Engine writes the row, then calls `refreshLinkedParentRollup(task)` (`:9540`).
> 3. That walks `linked_parent_board_id`/`linked_parent_task_id` (or `parent_task_id` → project's link) up to the parent board.
> 4. `computeAndApplyRollup` (`:9450`) re-aggregates child-board tasks where `child_exec_board_id = parent.child_exec_board_id`, sets `rollup_status` ∈ {`active`, `at_risk`, `blocked`, `ready_for_review`, `no_work_yet`, `cancelled_needs_decision`}, updates parent's `column` accordingly, writes `child_rollup_updated` + status-specific history.
> The user-facing "atualizar status TXX" command in `groups/thiago-taskflow/CLAUDE.md:1037` **maps to `taskflow_hierarchy(action='refresh_rollup')`** — but production usage shows the auto-path drives the 5 `child_rollup_updated` events (5 distinct days, 4 distinct actors), not the manual command.

---

## I.* — Cross-Board Subtask Coverage Matrix

| ID | Feature | v1 location | v2 plan location | Status | GAP? | Notes |
|---|---|---|---|---|---|---|
| **I.1** | `cross_board_subtask_mode='open'` (default) — child board adds subtask directly to delegated project; `linkedChildBoardFor` auto-delegates back | engine `:5287–5293` (mode lookup) + `:5374` (fall-through) + `:3070–3097` (`linkedChildBoardFor`) | TBD — v2 spec/plan files absent | **ACTIVE** | check v2 plan covers `add_subtask` cross-board path + auto-link | This is what 100 % of production uses. Any v2 redesign that drops the `add_subtask` cross-board path or `linkedChildBoardFor` auto-delegation breaks 22 of 23 rollup parent-child linkages. |
| **I.2** | `cross_board_subtask_mode='approval'` mode gate | engine `:5302–5371` | TBD | **DEAD-CODE-PRESERVED** | flag for **DEPRECATED-CORRECTLY** | 0/28 boards on `approval`. 0 `subtask_requests` rows ever. Phase 2 design (spec `2026-04-09`) was completed and tested but never adopted. Recommendation: **keep behind the flag in v2** (no migration cost — same column default) but do NOT consider it part of v2's "happy path"; mark as opt-in legacy. |
| **I.3** | Outbound approval-request message ("🔔 Solicitação de subtarefa" with `request_id` + aprovar/rejeitar lines) routed to parent-board chat | engine `:5340–5360` (message construction) + `pending_approval` return shape | TBD | **DEAD-CODE-PRESERVED** | (same as I.2) | 0 sends in 1488-row send_message_log. Outbound shape `{success:false, pending_approval:{request_id, target_chat_jid, message, parent_board_id}}` requires the host's `dispatchApprovalCard` (per Codex#2 BLOCKER B2) — which is itself blocked on v2 Phase 2 dissolution-restored. If v2 Phase 2 ships, this routing must follow. |
| **I.4** | Inbound text protocol — manager types `aprovar req-XXX` / `rejeitar req-XXX [motivo]` → agent calls `taskflow_admin(action='handle_subtask_approval', decision, request_id, reason)` | text protocol convention (no engine code; CLAUDE.md template instruction) + engine handler `:8327–8455` + MCP tool param shape `ipc-mcp-stdio.ts:1264–1266` | TBD | **DEAD-CODE-PRESERVED** | (same as I.2) | 0 inbound `aprovar req-` or `rejeitar req-` strings in `messages.content`. The text-protocol is convention-only — there is no parser; the agent infers the call. v2 spec Pattern 2 likely replaces this with `ask_user_question` / approval-card; if so, the text-protocol path can be **DEPRECATED-CORRECTLY** in v2. |
| **I.5** | `handle_subtask_approval` decision='approve' — creates subtasks on parent board, validates assignees registered, returns `created_subtask_ids` + notification to source board | engine `:8385–8443` | TBD | **DEAD-CODE-PRESERVED** | (same) | Tested at `taskflow-engine.test.ts:6244` (suite of 6 tests). 0 prod invocations. Codex finding C (assignee-not-registered → `offer_register`) preserved at `:8392–8402`. |
| **I.6** | `handle_subtask_approval` decision='reject' — marks rejected with `reason`, notifies source board | engine `:8358–8382` | TBD | **DEAD-CODE-PRESERVED** | (same) | Tested at `taskflow-engine.test.ts:6283`. Codex finding H (CAS on `status='pending'`) preserved at `:8362–8366` and `:8426–8430` for both branches. |
| **I.7** | Idempotency — second approve/reject on same `request_id` returns "already resolved" with original resolver/timestamp | engine `:8344–8347` (read-side check) + `:8362/:8426` (CAS guard) + rollback of created subtasks on race | TBD | **DEAD-CODE-PRESERVED** | (same) | Two-layer protection (SELECT-time + UPDATE-time CAS) per Codex review 2026-04-12 finding H. Tested at `taskflow-engine.test.ts:6315–6346`. 0 prod opportunities to exercise. |
| **I.8** | `cross_board_subtask_mode='blocked'` — refusal message to child board, no request created | engine `:5294–5300` | TBD | **DEAD-CODE-PRESERVED** | (same) | 0/28 boards. Three-mode design but only `open` is used. |
| **I.9** | Auto-link new subtask to child board (when parent has `child_exec_*`, the new subtask inherits `child_exec_enabled/board_id/person_id` so the child board can act on it) | engine `:3025–3032` (`insertSubtaskRow` calling `linkedChildBoardFor`) | TBD | **ACTIVE** | check v2 plan covers `linkedChildBoardFor` | Load-bearing: this is what makes the 243 linked tasks materialise without manual `taskflow_hierarchy(action='link')` per subtask. Recurring tasks are explicitly excluded (engine `:9132`). |
| **I.10** | Manual link/unlink — `taskflow_hierarchy(action='link', task_id, person_name)` and `action='unlink'` | engine `:9118–9175` (link) + `:9176–9203` (unlink) | TBD | **ACTIVE (rare)** | check v2 plan covers manual link/unlink | 1 `child_board_linked` event in 60 d (laizys). Mostly used to force-link tasks that pre-date child-board provisioning. |

### I.* status summary

| Status | Count | IDs |
|---|---:|---|
| ACTIVE | 3 | I.1, I.9, I.10 |
| DEAD-CODE-PRESERVED | 7 | I.2, I.3, I.4, I.5, I.6, I.7, I.8 |
| **Recommend → DEPRECATED-CORRECTLY (in v2)** | 7 | same set, *if* v2 spec Pattern 2 supersedes via `ask_user_question` / approval-card |

**Critical observation.** The 7 dead-code Phase-2 features are **internally consistent** (CAS, race rollback, registered-assignee guard, three-mode flag) and **fully tested** (~190 LOC of test coverage), but they are also the path the user said v2 spec Pattern 2 supersedes. The right call in v2 is one of:
1. **Strip out** the entire Phase-2 surface — drop `subtask_requests` table, `handle_subtask_approval` admin action, `pending_approval` return shape, the `'approval'`/`'blocked'` mode values — and let v2's `ask_user_question` + approval-card stack handle governance. Lowers v2 LOC by ~250 + ~80 lines of test. **Recommended given 0 prod usage.**
2. **Port-forward unchanged** as an opt-in legacy path. Costs ~330 LOC of engine + tests but preserves the option for any future board that flips `cross_board_subtask_mode='approval'`. No prod board has done so in the 6 weeks since the feature shipped.

If v2 plan goes with (1), all 7 IDs become **DEPRECATED-CORRECTLY**. If (2), they remain **DEAD-CODE-PRESERVED**. **Either is defensible; uncertainty is whether v2 spec Pattern 2 Was Designed Without Knowing Phase 2 Was Already Built.** Given the spec date (2026-05-02) post-dates Phase 2 ship (2026-04-12), the spec authors likely knew — recommend confirming the spec is explicit about superseding (so the codebase can drop the dead Phase-2 surface).

---

## J.* — Cross-Board Rollup Coverage Matrix

| ID | Feature | v1 location | v2 plan location | Status | GAP? | Notes |
|---|---|---|---|---|---|---|
| **J.1** | Rollup signals — `child_exec_rollup_status ∈ {active, at_risk, blocked, ready_for_review, no_work_yet, cancelled_needs_decision}` aggregated from child-board task counts (open/waiting/overdue/cancelled/done) → mapped to parent's `column` | engine `:9450–9540` (`computeAndApplyRollup`) | TBD | **ACTIVE — load-bearing** | confirm v2 plan ports `computeAndApplyRollup` byte-for-byte | 5 `child_rollup_updated` history events, 1 each of `child_rollup_at_risk` and `child_rollup_blocked`. The 5 → 6 status enum values + the 6 → 5 column mapping is hard-coded and well-tested. |
| **J.2** | Child-board read — visibility query joins child board's tasks via `child_exec_board_id = caller.boardId` so parent task surface includes delegated work | engine `:1010–1015` (`visibleTaskScope`), `:1820–1830` (`getLinkedTasks`), `:1595–1625` (`getTask` cross-board fallback) | TBD | **ACTIVE — load-bearing** | confirm v2 plan preserves `visibleTaskScope` semantics | This is the foundational cross-board read primitive: every query, board view, digest, and standup uses it. v2's destinations-ACL design (Discovery 14) MUST preserve the `(board_id = ?) OR (child_exec_board_id = ? AND child_exec_enabled = 1)` invariant or every linked task disappears from the parent. |
| **J.3** | 🔗 marker rendering on linked tasks across all views (board, standup, digest, weekly, task_details) | report formatters (not engine — formatter code in `taskflow-engine.ts` report() / digest() flows; CLAUDE.md template at `groups/thiago-taskflow/CLAUDE.md:1117` says "prefix linked tasks with 🔗") | TBD | **ACTIVE** | confirm v2 plan keeps marker | 101 outbound messages contain 🔗. Without it, users can't visually distinguish own-board tasks from cross-board delegations. v2 spec must keep the marker rule explicit in renderer specs. |
| **J.4** | "atualizar status TXX" / "sincronizar TXX" → `taskflow_hierarchy(action='refresh_rollup')` | engine `:9203–9230` + CLAUDE.md template grammar | TBD | **NEAR-DEAD** (1 prod invocation in 60 d) | flag for **DEPRECATED?** | 1 inbound "atualizar status P11.19" in messages table. The auto-rollup path (`refreshLinkedParentRollup` at `:9540`) drives the 5 `child_rollup_updated` events. **Question for v2:** keep the manual-refresh tool action? Recommendation: **KEEP** — refresh_rollup is also called internally by the 5 auto-rollup events, so the engine action must exist; only the user-facing CLAUDE.md grammar mention is rarely-used. Cost of keeping: zero (already in MCP surface). |
| **J.5** | Cross-board write-path guards — `cancel_task`, `restore_task`, `reparent_task`, `merge_project` on tasks where `task.board_id !== this.boardId` reject with "pertence ao quadro superior" unless caller is on parent board | engine `:7705–7707` (cancel), `:8173+` (merge guard), `:5288` (add_subtask gate already in I.2), reparent has its own guard | TBD | **ACTIVE — load-bearing** | confirm v2 plan ports each guard | These are the inverse of I.1: child board CAN add subtasks (open mode) but CANNOT cancel/restore/reparent/merge cross-board. Dropping any guard creates a permission-escalation bug. v2 destinations-ACL design must implement equivalent. The cancel guard at `:7705` is the only one with a tested error string in production. |

### J.* status summary

| Status | Count | IDs |
|---|---:|---|
| ACTIVE — load-bearing | 4 | J.1, J.2, J.3, J.5 |
| NEAR-DEAD (auto-path used; manual rarely invoked) | 1 | J.4 |
| DEAD-CODE | 0 | — |

**No GAPs in J.* on the engine side.** Every J.* is exercised in production data either heavily (J.1/J.2/J.3) or via the auto-path (J.4) or as silent guard rails (J.5). All require port-forward to v2 with no design changes.

---

## Aggregate status counts (15 features)

| Status | Count | IDs |
|---|---:|---|
| ACTIVE — load-bearing | 7 | I.1, I.9, I.10, J.1, J.2, J.3, J.5 |
| NEAR-DEAD (auto-path covers the engine action) | 1 | J.4 |
| DEAD-CODE-PRESERVED | 7 | I.2, I.3, I.4, I.5, I.6, I.7, I.8 |
| GAPs (require v2 spec/plan re-check when files materialise) | 0 confirmed; 7 *pending* | I.2–I.8 status flips to DEPRECATED-CORRECTLY *if* v2 spec Pattern 2 explicitly supersedes Phase 2 |
| DEPRECATED-WRONG | 0 | — |

---

## Recommended plan amendments

1. **Spec (v2-native-redesign §"Pattern 2 — cross-board approval"): make the supersession explicit.** State that v2 Pattern 2 (admin-DM approval-card via `ask_user_question` or v2 destinations-ACL) replaces the v1 Phase-2 path (`subtask_requests` table + `handle_subtask_approval` admin action + `pending_approval` return shape + `'approval'`/`'blocked'` mode values). Without this declaration, the v2 codebase carries ~330 LOC of unreachable Phase-2 surface forever. Add a one-line note: "v1 `subtask_requests` rows do not migrate (0 rows in production)."

2. **Plan (Phase A.3 Track A): add a "Phase 2 sunset" task.** Drop `subtask_requests` schema, the `handle_subtask_approval` admin action, the I.2/I.4/I.8 mode branches in `add_subtask`, and the matching tests. Net delete: ~230 LOC engine + ~190 LOC tests. **Save the dropping for the same PR that ships v2 Pattern 2 to prevent a window where neither path works.**

3. **Plan: explicit port-forward checklist for J.* load-bearing primitives.** Every J.1–J.3 + J.5 must have at least one v2 test that exercises the cross-board read/write path. The `visibleTaskScope` SQL fragment is the single most important primitive — if it regresses, 243 tasks across 5 boards become invisible. Recommend a v2 acceptance test: "linked task on board A (delegated to board B) appears in board B's `taskflow_query` output AND board B's mutation triggers `refreshLinkedParentRollup` on board A."

4. **No action needed on J.4 manual-refresh user grammar.** The auto-path (`refreshLinkedParentRollup` on every child-side mutation) carries the feature; the user-typed "atualizar status TXX" trigger appears in CLAUDE.md template prose only and costs nothing to keep. The MCP `taskflow_hierarchy(action='refresh_rollup')` action MUST be ported because it's also the entry point for the auto-path.

5. **Verify v2 destinations-ACL (Discovery 14) preserves the cross-board read primitive.** The single SQL fragment `(board_id = ? OR (child_exec_board_id = ? AND child_exec_enabled = 1))` is the foundation. Discovery 14 should answer the question "what's the v2 equivalent?" — when that file exists, re-check J.2 against it.

---

## Files modified to verify these claims

- Engine flow read at: `/home/nanoclaw/nanoclaw/container/agent-runner/src/taskflow-engine.ts:1010,1198,1242,1595,1820,3025,5287,7705,8327,9118,9203,9450,9540`.
- Tests inspected at: `/home/nanoclaw/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts:6244–6438`.
- MCP surface at: `/home/nanoclaw/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts:1249,1264–1266`.
- Phase-2 design context: `/root/nanoclaw-feat-v2/docs/superpowers/specs/2026-04-09-cross-board-subtask-approval-design.md`.
- Phase-1 plan context: `/root/nanoclaw-feat-v2/docs/superpowers/plans/2026-04-12-cross-board-subtask-phase1.md`, `2026-03-28-cross-board-rollup.md`.
- DB queried: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`, `/home/nanoclaw/nanoclaw/store/messages.db`.
