# Feature Coverage Synthesis (consolidates 15 audits)

> **Date:** 2026-05-03
> **Scope:** master GAP rollup + plan revision recommendations across the 15 feature-coverage audits in this directory (audits 01–15).
> **Note on scope:** caller's prompt referenced "19 prior coverage-audit docs"; only **15 audits exist on disk** (01-runners through 15-templates-runtime). The synthesis covers all 15. The four absent audit slots (16-19) appear to have been re-numbered or absorbed into the 15 produced.
> **Inputs:** all 15 audit docs; `plans/2026-05-03-phase-a3-track-a-implementation.md`; `specs/2026-05-02-add-taskflow-v2-native-redesign.md`; `research/2026-05-03-v2-discovery/00-synthesis.md`.

---

## Executive headline

Across 15 audits covering ~155 distinct TaskFlow features, **engine code is correctly preserved** (it travels with `skill/taskflow-v2` per spec line 299), but the **plan and spec under-enumerate the contracts the engine enforces** — yielding **~115 GAPs** (mostly silent regression risk, a handful of true blockers). The biggest cross-cutting findings: (a) **v2's `agent_destinations` ACL design covers cross-board *send* but the spec is silent on cross-board *read* (`visibleTaskScope`)**, which would invisibly hide 243 linked tasks from 5 parent boards on day one; (b) **Plan 2.3.m's "~200 LOC auditor rewrite" is structurally underestimated** — it must split into 4 sub-tasks and accept that the `auditTrailDivergence` bug class disappears under v2; (c) **Plan 2.3.i's one-line "CLAUDE.md.template ports" is critically thin** — the 1316-line template references `target_chat_jid` (11 sites) and `board_admins` (4 sites), neither of which survives v2 verbatim; (d) **the 28% cross-board-send finding from Discovery 19** dominates risk surface — 422 sends/60d through `send_message`, of which `trigger_message_id` (K.4) and 5-second notification consolidation (K.5) are silently dropped by the current plan.

---

## Severity scorecard

### Counts

| Bucket | Count |
|---|---:|
| **Total features inventoried across 15 audits** | ~155 |
| **ADDRESSED / COVERED** | ~63 |
| **GAPs (all severities)** | **~115** |
| └─ **BLOCKER** (active prod feature, plan does not address; cutover would break user flow) | **9** |
| └─ **HIGH** (partial coverage; subtle-regression risk) | **34** |
| └─ **MEDIUM** (dead/near-dead but plan inconsistent) | **42** |
| └─ **LOW** (doc/naming/contract clarification only) | **30** |
| **DEAD-CODE-PRESERVED (correctly)** | 11 |
| **DEPRECATED-CORRECTLY** (recommend drop, plan currently doesn't execute) | 7 |
| **DEPRECATED-WRONG** (plan drops a live feature) | 1 (attachment-intake — should formally deprecate) |

GAP totals are larger than feature count because audits 03, 10, 11, 12, 13, 14, 15 each enumerate multiple sub-GAPs per feature.

### Coverage scorecard by audit

| Audit # | Domain | Features | ADDR | GAPs | BLOCKERs | DEAD-PRES | Top finding |
|---|---|---:|---:|---:|---:|---:|---|
| 01 | Runners + rendering | 21 | 12 | 6 | 0 | 0 | Kipp `context_mode='isolated'` has no v2 equivalent |
| 02 | Task lifecycle | 36 | 27 | 8 | 0 | 1 | Spec under-enumerates: `restore_task`, `manage_holidays`, `allow_non_business_day` |
| 03 | Cross-board (I/J/K) | 20 | 12 | 7 | 4 | 7 | **J.* rollup engine is silent in spec — 243 tasks affected** |
| 04 | Reassignment | 6 | 4 | 4 | 0 | 0 | Spec names `bulk_reassign` only; >96% of usage is single-task |
| 05 | Meetings | 17 | 2 | 10 | 1 | 0 | dm-routing prod incident (10,863 errors) — plan 2.3.g insufficient |
| 06 | Quick capture | 5 | 0 | 8 | 0 | 0 | `process_inbox` (74/60d) missing from spec |
| 07 | Recurring tasks | 4 | 0 | 6 | 0 | 0 | `recurrence` column un-canonicalized; web-api bypass |
| 08 | Projects + subtasks | 12 | 3 | 8 | 1 | 1 | Subtask numeric ORDER BY; spec lists `remove_subtask` engine doesn't have |
| 09 | Search + semantic | 6 | 4 | 6 | 0 | 0 | Phone-mask security primitive not enumerated |
| 10 | Admin actions | 8 | 1 | 15 | 0 | 4 | Spec/plan conflict on `/aprovar` (Discovery 10 vs spec L266) |
| 11 | Permissions | 9 | 0 | 14 | 1 | 1 | Plan does not lock 3-tier gate shape; collapses manager↔delegate |
| 12 | Person management | 10 | 1 | 10 | 1 | 0 | `register_person` MCP tool not in spec; v2 phone canonicalization undocumented |
| 13 | Audit + history | 17 | 6 | 10 | 1 | 1 | Plan 2.3.m undersized; magnetism guard hidden Track A blocker |
| 14 | Attachments | 11 | 0 | 5 | 0 | 0 | Whole protocol DEAD (0 prod uses); recommend deprecate |
| 15 | Templates + runtime | 9 | 0 | 18 | 0 | 0 | 1316-line template; 5 HIGH v2-breaking GAPs in 1-line plan task |

(Counts rolled up per audit; “GAPs” may include sub-GAPs grouped by feature.)

---

## Top 10 BLOCKERs (highest priority)

These are features actively used in production that the current plan does not address; cutover would break user flow.

### B1 — J.2: `visibleTaskScope` cross-board *read* primitive silent in spec (audit 03)

**What.** The SQL fragment `(board_id = ? OR (child_exec_board_id = ? AND child_exec_enabled = 1))` is the foundational cross-board read primitive used by every digest, standup, board view, and task-detail render. Production: 243 tasks have `child_exec_enabled=1` across 23 child boards under 5 parent boards.

**Plan coverage.** Discovery 14 (`agent_destinations`) governs *send*, not *read*. Spec/plan are silent on the read primitive entirely. v2's per-session inbound.db isolation makes this primitive hard to preserve without explicit work.

**Fix.** Add **2.3.o (NEW)** "Cross-board rollup engine port": port `visibleTaskScope`, `computeAndApplyRollup`, `refreshLinkedParentRollup`, `getLinkedTasks`, the 🔗 marker renderer rule, and the four write-path guards (cancel/restore/reparent/merge). ~600 LOC engine + ~200 LOC tests.

### B2 — Plan 2.3.i "CLAUDE.md.template ports" critically under-specified (audit 15)

**What.** Plan A.3.2 step 2.3.i is **one line**. Production template is **1316 lines** (spec wrongly estimates 400 → 300). It references `target_chat_jid` 11 times (v2 uses named-ACL `send_message(to:'audit-board')`) and `board_admins` 4 times (v2 has no such table). 28 boards are on 4 different size cohorts (1316/1176/1134/1131) — no retro-render mechanism exists.

**Fix.** Expand 2.3.i into 4 sub-tasks: (1) mechanical port + 22-variable parity; (2) MCP-tool routing rewrite (`target_chat_jid` → destinations; `board_admins` → user_roles+meta); (3) sensitive-path block-list refresh (add `data/v2.db`, `data/v2-sessions/`); (4) per-board variation generation, explicitly select option (a) provision-time, document each substitution. Add A.3.6 invariant: every board's CLAUDE.md re-rendered at cutover.

### B3 — Plan does not lock 3-tier permission gate shape (audit 11)

**What.** v1's `admin()` dispatcher has a 3-tier gate: manager-only (14 actions), manager-or-delegate (`process_inbox`, `approve`, `reject`), no-gate (`accept_external_invite`). v2's `hasAdminPrivilege` is binary. Plan §2.3.e seeds extension `taskflow_board_admin_meta(role_label)` but does NOT specify that runtime `requireBoardAdmin` reads `role_label` to preserve the carve-out. Without this, the 1 production delegate (sanunciel) silently gains manager-equivalent power, AND `process_inbox` (74 uses/60d) loses its delegate-eligible path.

**Fix.** Spec §"Permissions seeding" must add the runtime invariant: every `INSERT INTO user_roles` triggered by TaskFlow MCP tool MUST be paired with `taskflow_board_admin_meta` insert in the same transaction. Gate is `hasAdminPrivilege(userId, ag) AND (action ∈ {process_inbox, approve, reject} OR role_label='manager')`. Plan §2.3.a regression test must include "delegate cannot do `cancel_task`" and "manager-also-assignee cannot self-approve".

### B4 — Magnetism guard reads `agent_turn_messages` from `messages.db` which v2 deletes (audit 13)

**What.** Magnetism guard (engine:850-1001) is a runtime ambiguous-mutation block. Reads `agent_turn_messages` table from `store/messages.db`. v2 deletes `messages.db`. Even if Plan 2.3.m succeeds, the guard breaks separately and is **unenumerated as a Track A blocker**. Production volume is currently 0 (likely fails-open due to 89% null `trigger_turn_id`), so the ambient regression is silent.

**Fix.** Add **2.3.q (NEW)** "Magnetism guard re-implementation against v2 session DBs OR explicit drop decision". If kept, ~80-120 LOC re-implementation reading from `messages_in` lookups. If dropped, document in spec under "Cut from scope" with rationale (zero observed firings).

### B5 — `process_inbox` MCP tool entirely missing from spec (audit 06)

**What.** `processar inbox` is invoked **74 times in 60 days** (~1.2/day across 9 boards), concentrated on the same 5 active boards that hold inbox occupancy. Spec's MCP tool inventory (lines 248-285) does not enumerate it. Plan §2.3.a "IPC plugins → MCP tools (single file)" is generic. The tool carries (a) a manager-OR-delegate permission gate distinct from `list_tasks`; (b) a return shape including count for triage UX; (c) auto-move-on-reassign logic that is the IN-PLACE promotion contract (`feedback_update_in_place.md`).

**Fix.** Spec must add `process_inbox` as a Kanban tool. Plan §2.3.a must include an integration test: list → reassign-with-auto-move → update-metadata → optional start.

### B6 — `register_person` MCP tool not enumerated (audit 12)

**What.** Spec §"Board-management tools" line 245 lists only `add_board_admin` / `remove_board_admin`. **All 59 production `board_people` rows** entered through v1's `register_person` MCP. Spec's 2-tool decomposition assumes person rows pre-exist; in v1 they are *created by* `register_person`. The naming gap is structural, not cosmetic.

**Fix.** Spec must add a "Person tools" subsection: `register_person`, `remove_person`, `add_manager` (with `is_primary` flag), `add_delegate`, `remove_admin`, `set_wip_limit`, `find_person_in_organization`. Cover the 4-field hierarchy-board guard, slugify contract, write-boundary phone canonicalization, `auto_provision_request` response, and observer (phoneless) handling.

### B7 — Cross-board send K.4 (`trigger_message_id`) silently dropped (audit 03)

**What.** Every `send_message_log` row in v1 carries `trigger_message_id` / `trigger_chat_jid` / `trigger_sender` / `trigger_turn_id` so Kipp's `isCrossBoardForward` heuristic can correlate cross-board responses to the inbound that prompted them. v2's `messages_out`/`delivered` schema lacks these. **Plan 2.3.c wrapper signature does not mention them.** Without K.4, the daily auditor loses cross-board forward detection — the heuristic that drives the 502 → 6/day deviation reduction (Discovery 19).

**Fix.** Extend 2.3.c to capture `trigger_message_id` + `trigger_turn_id` + `trigger_chat_jid` + `trigger_sender` from MCP context. Verify v2 schema carries them or add columns to the wrapper's audit table.

### B8 — dm-routing prod incident (10,863 errors live) — plan §2.3.g insufficient (audit 05)

**What.** Production log has 10,863 `resolveExternalDm` errors (live today). Plan §2.3.g adds a table-existence regression test, which catches the **surface symptom** but not the four anti-drift root causes from `project_dm_routing_silent_bug.md`: (1) single source of truth for `taskflow.db` path with multi-candidate fail-fast; (2) `db.pragma('user_version')` recheck on cached handle reuse; (3) `_taskflowDb` cache invalidation on schema bump; (4) deploy-pipeline fingerprint check covering `src/` delta. Without these, v2 silently inherits the same drift class.

**Fix.** Expand 2.3.g acceptance into 4 sub-bullets covering the anti-drift hardening. Production incident is dormant (no active grants) so out-of-scope for v1 hotfix; in-scope for v2 to not reproduce.

### B9 — Spec/plan contradict on `/aprovar` text protocol (audits 03, 10)

**What.** Spec line 266 says approval cards delivered via `ask_user_question`. Plan §2.3.h says `/aprovar` text protocol preserved per Discovery 10 (3 reasons reject `pending_approvals` refactor). One is wrong. Discovery 10 is authoritative (parent-group visibility, hardcoded approve/reject options, free-text reject reason). **Spec L266 is stale.**

**Fix.** Rewrite spec L266 to match plan + Discovery 10. Drop `ask_user_question` from cross-board approval flow. (NB: the approval flow has 0 production rows ever — the contradiction is dormant in production but blocking for the test phase.)

### B10 — `recurrence` column un-canonicalized (audit 07)

**What.** Production has both `monthly` and `{"pattern":"monthly"}` literals stored in `tasks.recurrence`. `advanceRecurringTask` switches on `'daily'|'weekly'|'monthly'|'yearly'` only; non-matching values fall through silently — cycle counter increments without advancing the date. R19 will trigger this on next conclude. Web-api path bypasses `move()` → `advanceRecurringTask` is not called.

**Fix.** Spec §"Kanban tools" must add write-side canonicalization: reject non-canonical `recurrence` values; one-shot fix-migration for R19. Forbid `update_task(column='done')` on recurring; require `move_task(action='conclude')` (single-path cycle-advance guard).

---

## Cross-cutting findings

### CC.1 — Plan A.3.2 has 12-14 sub-tasks; should be 19+

Across the 15 audits, **5 new sub-tasks** are independently recommended:

- **2.3.o** Cross-board rollup engine port (B1 above; audit 03 + audit 01)
- **2.3.p** Notification consolidation (5-second merge — K.5; audit 03)
- **2.3.q** Magnetism guard re-implementation OR drop decision (B4 above; audit 13)
- **2.3.r** DST decommission cleanup — drop 6 columns + filter 24 zombie crons + remove `[TF-DST-GUARD]` prompt (audit 01)
- **2.3.s** Kipp dedicated audit session — provision `whatsapp_main_audit` so `auditor-daily` doesn't contaminate group context (audit 01)

Plus expansions to existing sub-tasks listed in the plan-revision section.

### CC.2 — Spec internal contradictions surfaced across multiple audits

| Conflict | Audits | Recommendation |
|---|---|---|
| `/aprovar` text protocol: drop (spec) vs keep (plan/Discovery 10) | 03, 10 | Honor plan; rewrite spec L266 |
| Template size: 400 lines (spec) vs 1316 actual (audit) | 15 | Correct spec L48 + L335 |
| `restore_task` / `remove_subtask` / `merge_project` named in spec but absent from engine | 02, 08, 10 | Either add to engine or rewrite spec |
| `bulk_reassign` only (spec) vs unified `taskflow_reassign(single+bulk)` (engine) | 04 | Rename; >96% of prod is single-task |
| `add_board_admin` only (spec) vs 6 person-mgmt tools (engine) | 12 | Add Person Tools subsection |

### CC.3 — Production data points that contradict plan assumptions

1. **Cross-board sends are 28% of all bot outbound (422/60d).** Discovery 19 §7 confirmed; multiple audits (03, 09, 13) re-validate. Plan acknowledges this in risk register but K.4 (`trigger_message_id`) and K.5 (5-s merge) are silently dropped.
2. **`subtask_requests`, recurring meetings, external participants, `merge_project`, `remove_child_board`, `cross_board_subtask_mode != 'open'` are all 0 production usage.** Plan correctly preserves engine code for some (port-forward dead code) but spec doesn't document the rationale. Recommendation: keep all four because the column/table is alive and the implementation embodies invariants (UPDATE-in-place pattern; CAS race; offer_register on assignee resolve) that v2 must not regress.
3. **Recurring tasks total = 3 across 2 boards** (Discovery 19 §15 said dead; audit 07 confirms). Web-api bypass for cycle advance is a divergence the v2 cutover can fix by single-pathing.
4. **Inbox is concentrated on 5 boards** (sec, seci, setec-secti, ci-seci, +tec test). Default-assignee-to-sender is a **production invariant** (zero counter-examples in 113 historical typed-inbox rows). Spec must restate this engine-level guarantee.
5. **`processar inbox` is alive** (74/60d). `process_inbox` MCP tool MUST be in spec.
6. **Phone canonicalization holds** (100% of 58 phone-bearing rows are canonical Brazilian E.164). v2 introduces `users.id = 'phone:+E164'` (with `+`); fork-private `board_people.phone` keeps digits-only. Two write-side canonicalizations live side-by-side; spec must state both.
7. **`is_primary_manager` is 28/29 = 97% in production.** Drives digest-credit attribution. Plan §2.3.e seeds extension column but spec inventory doesn't expose `is_primary` flag on `add_board_admin`.
8. **Magnetism guard fires 0 times in 60 days.** Reads from `agent_turn_messages` (deleted in v2). Plan should explicitly decide: drop (recommended) or re-implement.
9. **Attachment-intake protocol has 0 production uses across 28 boards in 60 days.** Capability skills (image-vision, pdf-reader) are applied. Audit 14 recommends formally deprecating the documented protocol; replace with a 1-line CLAUDE.md instruction. `attachment_audit_log` table can stay (zero-row tables are cheap).
10. **DST guard wrote 24 zombie cron rows.** 0/28 boards have DST guard runner; 0/28 enabled; but 24 zombie rows still active. Plan does not explicitly decommission.

---

## Recommended plan revisions (structured by phase)

### Phase A.3.0.5 — `add-whatsapp` resumption

No changes from audits.

### Phase A.3.1 — `skill/whatsapp-fixes-v2`

Add to step list (audit 15 G-15.8.1):

- **1.7 (NEW)** Port `normalizePhone()` (host-side parity) + `phone.test.ts` — currently NOT in plan A.3.1 scope.

### Phase A.3.2 — `skill/taskflow-v2` master skill

#### New sub-tasks

| New | Title | Source | Est LOC |
|---|---|---|---:|
| **2.3.o** | Cross-board rollup engine port (`visibleTaskScope`, `computeAndApplyRollup`, `refreshLinkedParentRollup`, `getLinkedTasks`, 🔗 renderer, 4 write guards) | audit 03 | ~600 + 200 tests |
| **2.3.p** | Notification consolidation (5-s merge for `pendingNotifications`) | audit 03 K.5 | ~50 |
| **2.3.q** | Magnetism guard re-implementation OR drop decision | audit 13 | 0 (drop) or ~120 (port) |
| **2.3.r** | DST decommission: drop 6 columns + filter 24 zombie crons + remove `[TF-DST-GUARD]` prompt | audit 01 | ~30 |
| **2.3.s** | Kipp dedicated audit session (`whatsapp_main_audit`) | audit 01 | ~30 |

#### Existing sub-tasks needing expansion

| Existing | Expansion | Source |
|---|---|---|
| **2.3.a** (IPC → MCP) | Enumerate every body-key on `update_task` (`add_subtask`, `rename_subtask`, `reopen_subtask` (no manager gate, distinct from L.11), `assign_subtask`, `unassign_subtask`); enumerate `process_inbox`, `register_person` family (6 person-mgmt tools); enumerate `manage_holidays` (4 ops); enumerate `detach_task`, `reparent_task`, `merge_project`. Lock 3-tier permission gate shape. | 02, 06, 08, 10, 12 |
| **2.3.c** (`taskflow_send_message_with_audit`) | Capture `trigger_message_id` + `trigger_chat_jid` + `trigger_sender` + `trigger_turn_id` (K.4). | 03 |
| **2.3.e** (seed-board-admins) | Lock dual-write contract: every runtime `INSERT user_roles` paired with `taskflow_board_admin_meta` in same transaction. Add `is_primary` flag handling. | 11, 12 |
| **2.3.g** (dm-routing) | Add 4 anti-drift acceptance sub-bullets (single-path resolution, user_version recheck, cache invalidation, fingerprint check). | 05 |
| **2.3.h** (cross-board approval port) | Resolve spec/plan contradiction: drop spec L266 `ask_user_question`; preserve `/aprovar` text protocol per Discovery 10. Enumerate 5 invariants (CAS on pending, target-board manager check, offer_register on unregistered assignee, source-board notification, subtask rollback on race). | 03, 10 |
| **2.3.i** (CLAUDE.md.template) | **Expand into 4 sub-tasks** (B2 above): mechanical port; MCP-tool routing rewrite; sensitive-path refresh; per-board variation generation. Correct line-count estimates (1316 actual). | 15 |
| **2.3.m** (drop send_message_log + auditor rewrite) | **Split into 4 sub-tasks** (audit 13): 2.3.m.1 script rewrite (~150 LOC); 2.3.m.2 prompt + per-board DB row UPDATE (~50 LOC + N rows); 2.3.m.3 `auditTrailDivergence` decision (drop or redefine — bug class disappears under v2); 2.3.m.4 magnetism guard (rolled into 2.3.q). Enumerate preservation: `selfCorrections`, 8 signal bits, `delivery_health.broken_groups`, dryrun NDJSON path. | 01, 13 |
| **2.3.n** (action-name canonicalization) | Restate: also rewrite engine's IN-clause at line 2675 (loud-variant flow string) AND the auditor heredoc/prompt. Coupled to L.18 + L.36. | 02, 13 |

### Phase A.3.5 — `skill/embeddings-v2`

Expand 1-line scope (audit 09):

- Enumerate the 6 features by name + their constants (`0.3` semantic, `0.2` preamble, `0.85` soft, `0.95` hard).
- Phase 7.2 expand to 6 sub-cases: semantic search, hard-block, soft-warning + force_create override, preamble injection presence + content shape, find_person 1-PID vs 2-PID, **phone-mask invariant**.

### Phase A.3.6 — Migration dry-run

Add invariants (multi-audit):

- `SELECT COUNT(*) FROM board_runtime_config WHERE runner_dst_guard_task_id IS NOT NULL` = **0** (audit 01)
- `SELECT COUNT(*) FROM messages_in WHERE kind='task' AND recurrence LIKE '3 %% * * 1-5'` = **0** (zombie DST clones; audit 01)
- `SELECT COUNT(*) FROM child_board_registrations` = **26** (audit 03/10)
- `SELECT COUNT(*) FROM board_runtime_config WHERE cross_board_subtask_mode='open'` = **28** (audit 10)
- `SELECT COUNT(DISTINCT recurrence) FROM messages_in WHERE kind='task'` ≥ **4** (3 default crons + 1 lunchtime override; audit 01)
- `SELECT COUNT(*) FROM users WHERE id LIKE 'phone:+%'` matches `(SELECT COUNT(DISTINCT phone) FROM v1.board_people)` (audit 12)
- Every board's CLAUDE.md re-rendered at cutover; verify diff is purely substitution (audit 15)
- Per-board canonicalization: every recurring task `recurrence` in `{'daily','weekly','monthly','yearly'}` (audit 07)

### Phase A.3.7 — Bundle integration tests

Add to step 7.1 per-tool coverage (multi-audit):

- **Kanban (10 tools, expand to 12+):** add `restore_task`, `process_inbox`, `manage_holidays` (4 sub-ops), `set_due_date(allow_non_business_day=true)`, `reparent_task`, `detach_task`, `merge_project` (1 integration test even at 0 prod usage)
- **Person tools (NEW category, 6+ tests):** `register_person` (4 variants — leaf w/o phone, leaf w/ phone, hierarchy w/ all 3 fields, hierarchy missing field rejects), `remove_person`, `add_manager` (incl. `is_primary` toggle), `add_delegate`, `remove_admin` (last-manager guard), `set_wip_limit`, `find_person_in_organization` (phone-mask invariant + `is_owner` + LIKE-escape)
- **Permission tests:** manager-also-assignee cannot self-approve; delegate can do `process_inbox` but not `cancel_task`; non-manager + non-assignee rejected on `move_task`; child-board cannot cancel parent-owned task (engine:7705); `force_start` by non-manager rejected, by manager succeeds
- **Cross-board:** rollup auto-firing test (provision parent + child; create `child_exec_enabled` task; mutate on child; assert `child_rollup_updated` event + parent's column updates + 🔗 marker renders); cross-board cancel/restore/reparent rejected with "pertence ao quadro superior"
- **Recurring:** `add_task(type='recurring', recurrence='monthly')` happy path; conclude advances cycle + writes `meeting_occurrence_archived` for recurring meeting; `update_task(max_cycles=3)` mutually clears `recurrence_end_date`; recurring conclude produces quiet notification (no 🎉, contains ✅ + Entregue por:)
- **Subtask invariants:** P11.2 < P11.10 in render order (numeric ORDER BY); reparent does NOT rename; `add_subtask` inherits assignee from project
- **Attachment:** prompt-injection guard test (hostile content in PDF text → no secret disclosure)

---

## Per-audit GAP rollup

| # | Audit | Features | GAPs | BLOCKERs | HIGH | MEDIUM | LOW | Top recommendation |
|---:|---|---:|---:|---:|---:|---:|---:|---|
| 01 | runners-and-rendering | 21 | 6 | 0 | 4 | 2 | 0 | Add 2.3.o/p/q (R5/R7 cleanup, Kipp isolated session) |
| 02 | task-lifecycle | 36 | 8 | 0 | 5 | 1 | 2 | Spec PR — enumerate 8 missing tools/contracts |
| 03 | cross-board (I/J/K) | 20 | 7 | 4 | 2 | 0 | 1 | **2.3.o cross-board rollup port** + extend 2.3.c trigger fields |
| 04 | reassignment | 6 | 4 | 0 | 1 | 2 | 1 | Rename `bulk_reassign` → unified `taskflow_reassign`; resolve dry-run vs ask_user_question |
| 05 | meetings | 17 | 10 | 1 | 5 | 4 | 0 | dm-routing 4-bullet hardening; `reinvite_meeting_participant_external` tool |
| 06 | quick-capture | 5 | 8 | 0 | 4 | 2 | 2 | **`process_inbox` MCP tool** (74/60d) |
| 07 | recurring-tasks | 4 | 6 | 0 | 2 | 3 | 1 | `recurrence` write-canonicalization; single-path cycle-advance guard |
| 08 | projects-subtasks | 12 | 8 | 1 | 4 | 2 | 1 | Spec PR — dotted ID format contract; numeric ORDER BY contract; replace `remove_subtask` |
| 09 | search-semantic | 6 | 6 | 0 | 3 | 2 | 1 | Phone-mask invariant test; enumerate 4 thresholds (0.3/0.2/0.85/0.95) |
| 10 | admin-actions | 8 | 15 | 0 | 4 | 7 | 4 | 4 admin MCP tools missing; resolve spec/plan `/aprovar` conflict |
| 11 | permissions | 9 | 14 | 1 | 6 | 5 | 2 | Lock dual-write `taskflow_board_admin_meta` + 3-tier gate |
| 12 | person-management | 10 | 10 | 1 | 4 | 4 | 1 | Add Person Tools subsection (6 missing MCP tools) |
| 13 | audit-history | 17 | 10 | 1 | 4 | 5 | 1 | **Split 2.3.m into 4 sub-tasks**; magnetism guard 2.3.q decision |
| 14 | attachments | 11 | 5 | 0 | 0 | 2 | 3 | Formally **deprecate** documented protocol; keep capability skills |
| 15 | templates-runtime | 9 | 18 | 0 | 5 | 4 | 9 | **Expand 2.3.i into 4 sub-tasks**; correct spec L48 + L335 line counts |

(Multi-audit BLOCKER cross-overlap: B3 spans 11+12; B4 spans 13; B7 spans 03; B8 spans 05; B9 spans 03+10; B10 spans 07.)

---

## Deprecation candidates (features prod doesn't use)

### Recommend formally deprecate (drop or no-op preserve)

| Feature | Audit | Prod usage | Recommendation | Rationale |
|---|---|---|---|---|
| Attachment-intake protocol (CONFIRM_IMPORT, dry-run preview, rejected_mutations) | 14 | **0 in 60d** across 28 boards | **Drop the documented protocol; keep capability skills** | Multiple unresolvable internal contradictions (engine MCP tool that "writes audit row automatically" doesn't exist; `rejected_mutations` table doesn't exist; OCR contract promises behavior codebase doesn't deliver). Replace with 1-line CLAUDE.md instruction. |
| DST guard runner + 6 columns + 24 zombie crons + `[TF-DST-GUARD]` prompt | 01 | 0/28 enabled; 24 zombie cron rows | **Decommission via 2.3.r** | Memory `feedback_use_v2_natives_dont_duplicate.md` says drop. Fortaleza no DST since 2019. |
| `*_cron_utc` dual-cron columns | 01 | 28/28 divergent but redundant | **Drop in 2.3.o** | v2 always passes `{ tz: TIMEZONE }` to cron-parser. |
| `_secondary_task_id` runner columns (manager-vs-team dual delivery) | 01 | 0/28 populated | **Drop in 2.3.o** | Never shipped. |
| `prompt-marker` runner discovery | 01 | Used by all 28 | **Simplify** | v2's `schedule_task` returns `taskId` directly. ~20 LOC saved. |
| Magnetism guard (shadow + enforce modes) | 13 | 0 fires in 60d | **Drop (recommended) via 2.3.q** | Reads `agent_turn_messages` (v2 deletes). Effectively fails-open already (89% null `trigger_turn_id`). |
| Catch-up on missed runs | 01 | Empirically irrelevant for last 30d | **Explicitly decide "no catch-up wrapper"** | Saves ~50 LOC fork-private; closes plan open question Q1. |
| `merge_project` engine path | 08, 10 | 0 invocations ever | **Keep** (port-forward) | Pattern-load-bearing (UPDATE-in-place per `feedback_update_in_place.md`); informs cross-board approval port. ~180 LOC. |
| `subtask_requests` + `handle_subtask_approval` (Phase 2) | 03, 10 | 0 rows ever | **Keep** (port-forward) | `cross_board_subtask_mode` column engine reads on every cross-board `add_subtask`; could be flipped any day. CAS race + assignee-validation are correctness-load-bearing. |
| `remove_child_board` raw-SQL recipe | 10 | 0 invocations / 26 active regs | **Drop or merge into `archive_taskflow_board`** | Recipe explicitly skips notifications + history; if kept, must add the contract. |
| `cross_board_subtask_mode` raw-SQL recipe | 10 | 0 history rows; all 28 on default | **Keep recipe; do not drop column** | Engine reads column on every cross-board `add_subtask`. |
| Web-deletion path (`reason='deleted_via_web'`) | 02 | 9 archive rows | **DEAD-CODE-PRESERVED** (table contract) | Path is outside engine; archive layout must remain. |
| `capturar:` quick-capture trigger | 06 | 0 in 60d (vs 89 `inbox:` + 6 `anotar:`) | **Keep template line; acknowledge zero usage in CHANGELOG** | Prompt-only; no engine code; cheap to keep. |

### Already deprecated correctly (plan handles)

| Feature | Disposition |
|---|---|
| `taskflow.db.scheduled_tasks` central table | Plan 2.3.f migrates per-session |
| `board_groups` table | → `messaging_group_agents` |
| `board_admins` table | → `user_roles` + `taskflow_board_admin_meta` |
| `send_message_log` table (v1 central) | Plan 2.3.m drops + auditor rewrite (BUT see B7+B8 caveats) |
| Host-side `canUseCreateGroup` | v2 operator-creates-group flow eliminates programmatic create |
| Pattern C marketplace plugin | Deleted in v2 |
| `add-travel-assistant` | Excluded per user |

### Deprecated wrong (current plan/spec drops a live feature)

None unequivocally. The closest is **plan 2.3.h "preserve text protocol"** vs **spec L266 "use ask_user_question"** — but since 0 prod rows ever, the only impact is test-phase blocking, not user-flow breakage. Resolved per recommendation in B9.

---

## Master GAP register (consolidated, by audit)

GAP IDs are quoted from each source audit. Severity assigned per the rubric in this synthesis. Plan section identifies the existing or new sub-task that should address the GAP.

### Audit 01 — Runners + rendering

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| R5 | `runner_*_task_id` column persistence | MEDIUM | NEW 2.3.o | Keep 3 runner ids; drop 4 unused; populate from `schedule_task` return value |
| R6 | Per-board `*_cron_local` customization | LOW | 2.3.f addendum | Self-resolves via cron migrate; assert in A.3.6 |
| R7 (cleanup) | DST guard runner + 6 columns + 24 zombie crons | MEDIUM | NEW 2.3.r | Drop columns; filter zombies in migrate; remove `[TF-DST-GUARD]` prompt |
| R8 (cleanup) | Local+UTC dual cron columns | MEDIUM | rolled into 2.3.o | Drop `*_cron_utc` |
| R10 | Catch-up on missed runs | LOW | NEW open-question close | Decide "no catch-up wrapper" explicitly |
| R12 | Auditor `auditTrailDivergence` + `delivery_health.broken_groups` | HIGH | 2.3.m addendum | Enumerate as preservation requirement |
| R14 | `selfCorrections` 60-min doublet | HIGH | 2.3.m addendum | Enumerate as preservation requirement |
| R15 | Kipp `context_mode='isolated'` (no v2 equivalent) | HIGH | NEW 2.3.s | Provision dedicated `whatsapp_main_audit` session |

### Audit 02 — Task lifecycle

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| L.16 | `restore_task` not in spec inventory | LOW | spec PR | Add row under `cancel_task` |
| L.18 | 3-variant completion notification (quiet/cheerful/loud) | HIGH | spec PR + 2.3.n | Restate variants + 7-day threshold; couple with action-name canonicalization |
| L.19 | Auto-archive >30d done (standup hook) | MEDIUM | spec PR | Add 30-day cutoff + regression test |
| L.29-32 | `manage_holidays` 4 ops not enumerated | MEDIUM | spec PR | Add admin tool family |
| L.34 | `allow_non_business_day` parameter | LOW | spec PR | Promote to `set_due_date` schema |
| L.3 + L.13 | force_start vs WIP-limit interaction | HIGH | 2.3.a regression test | Add 3-case test (WIP+self, force_start by non-mgr, by mgr) |
| L.8 | `requires_close_approval` routes through review | HIGH | 2.3.a regression test | Add gate test |
| L.33 | Weekday-name validation guard | HIGH | 2.3.a regression test | Add mismatch test |

### Audit 03 — Cross-board (I/J/K) — **highest BLOCKER density**

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| I.4 | spec/plan contradiction on `/aprovar` text protocol | BLOCKER | 2.3.h + spec L266 | Honor plan; rewrite spec |
| J.1 | Rollup signals (`computeAndApplyRollup`) | BLOCKER | NEW 2.3.o | Port engine code verbatim |
| J.2 | `visibleTaskScope` cross-board read primitive | BLOCKER | NEW 2.3.o | Port; load-bearing for 243 tasks |
| J.3 | 🔗 marker rendering | BLOCKER | NEW 2.3.o | Port renderer rule |
| J.5 | Cross-board write-path guards (cancel/restore/reparent/merge) | HIGH | NEW 2.3.o | Port 4 guards |
| K.4 | `trigger_message_id` propagation | BLOCKER | extend 2.3.c | Capture trigger fields in wrapper |
| K.5 | 5-second notification consolidation | HIGH | NEW 2.3.p | Port `pendingNotifications` map logic |

### Audit 04 — Reassignment

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| G-1 | Single-task reassign (`bulk_reassign` only in spec) | HIGH | spec PR | Rename to unified `taskflow_reassign` (single + bulk) |
| G-3 | Cross-board reassign guard not enumerated | MEDIUM | A.3.7 step 7.1 | Add 3 error rows (cross-board, completed, same person) |
| G-4 | Dry-run vs `ask_user_question` design drift | MEDIUM | spec decision | Recommend port-forward unchanged (0 bulk reassigns/60d) |
| G-aux | Auto-relink on reassign (15.5% of prod) | LOW | A.3.7 step 7.1 | Add 4-case auto-relink test |

### Audit 05 — Meetings

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| K.1 | `add_task(type='meeting')` invariants | HIGH | spec PR | Restate 4 invariants (no due_date; recurring needs scheduled_at; etc.) |
| K.3.design | Push-vs-pull invitation flow conflict | HIGH | spec PR | Adopt Discovery 12 option (c) — TaskFlow seeds `agent_group_members` |
| K.3.window | 7-day `access_expires_at` not in spec | LOW | spec PR | Document constant |
| K.4 | `remove_meeting_participant` polymorphic? | MEDIUM | spec PR | Clarify single tool vs two |
| K.5 | `reinvite_meeting_participant_external` MISSING | MEDIUM | spec PR + 2.3.a | Add tool with current-occurrence semantics |
| K.6.scope | dm-routing trim vs delete conflict | HIGH | spec PR | Trim and reposition (per Discovery 12) |
| K.6.bug | dm-routing prod incident — 4 anti-drift rules | BLOCKER | expand 2.3.g | 4 acceptance sub-bullets |
| K.7 | `process_minutes` collapsed in spec | HIGH | spec PR | Either add `triage_meeting_note` tool or document `add_task(parent_note_id)` idiom |
| K.8-15 | 8 meeting query views not enumerated | MEDIUM | spec PR + 7.1 | Enumerate by name + filter shape |
| K.16 | Cross-board meeting visibility | HIGH | spec PR + 7.1 test | Restate `visibleTaskScope` rule for meetings |
| K.17.weekday | `scheduled_at` non-business-day gate | MEDIUM | spec PR | Document recurring auto-shift asymmetry |
| K.17.phone-mask | "phone-mask display" inventory item | LOW | inventory clarify | Spec author decides v2-want vs v1-real |

### Audit 06 — Quick capture

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| L.1.discriminator | `add_task(type='inbox')` permission carve-out | HIGH | spec PR | Lock invariant + test unregistered-sender capture |
| L.1.phrasings | `anotar`/`capturar`/`inbox:` triggers in template | LOW | spec PR | Mark `capturar` zero-usage |
| L.2.invariant | Default-assignee-to-sender engine guarantee | HIGH | 2.3.a regression test | Add test "call without assignee → returns sender" |
| L.2.bypass | "para o inbox" bypass is column-only | LOW | spec PR | Clarify |
| L.3.transitions | `move_task` accepts `inbox` as `from` | HIGH | 2.3.a regression test | Add test "start inbox task directly" |
| L.3.claim | `canClaimUnassigned` invariant | HIGH | 2.3.a regression test | Add separate auto-claim test |
| L.4.tool | `process_inbox` MCP tool MISSING | BLOCKER | spec PR + 2.3.a | Add tool; 74 uses/60d |
| L.4.in_place | "Promote IN-PLACE" invariant | HIGH | spec PR | Restate auto-move-on-reassign mechanism |
| L.4.delegate | `process_inbox` permission gate | HIGH | 2.3.a + 2.3.e | Lock manager-OR-delegate gate |

### Audit 07 — Recurring tasks

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| R.1.scope | 5 `type` values on `add_task` | MEDIUM | spec PR | Enumerate `simple/project/recurring/meeting/inbox` |
| R.1.canonicalize | `recurrence` free-form column | BLOCKER | spec PR + R19 fix | Write-side canonicalize; one-shot fix R19 row |
| R.2.contract | `move_task(conclude)` recurring side effects | HIGH | spec PR + 7.1 | Document 3 side effects + 3 cycle-advance tests |
| R.2.web-divergence | Web-api bypass for cycle advance | HIGH | spec + engine guard | Forbid `update_task(column='done')` on recurring |
| R.3.bounds | `max_cycles`/`recurrence_end_date` mutual exclusion | MEDIUM | spec PR + 7.1 | Document tombstone-in-done + mutual-clear |
| R.4 | Quiet completion notification (cross-ref L.18) | HIGH | spec PR + 2.3.n | Couple with L.18 + L.36 |

### Audit 08 — Projects + subtasks

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| S.2 | Dotted ID format `{parent}.{N}` (no zero-padding) | BLOCKER | spec PR | Lock format contract |
| S.4 | Spec names `remove_subtask` engine doesn't have | HIGH | spec PR | Replace with `detach_subtask` or implement wrapper |
| S.6 | `reopen_subtask` (no manager gate) | MEDIUM | spec PR | Distinguish from L.11 lifecycle reopen |
| S.7 | `assign_subtask` body-key | LOW | spec PR | Bundle with S.6 footnote |
| S.8 | `unassign_subtask` body-key | LOW | spec PR | Bundle with S.6 footnote |
| S.9 | `detach_task` not in tool inventory | HIGH | spec PR | Add row |
| S.10 | `reparent_task` not in tool inventory | HIGH | spec PR | Add row + "preserves original ID" note |
| S.12 | Numeric ORDER BY (P11.2 < P11.10) | HIGH | spec PR + 7.1 | Lock contract; regression test |

### Audit 09 — Search + semantic

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| F.1 | Semantic search ranking | HIGH | A.3.5 expand | Enumerate by name + 0.3 threshold |
| F.2 | Duplicate detection (0.85/0.95) | HIGH | 7.2 + A.3.5 | Add hard-block + soft-warning + force_create override tests |
| F.3 | Context preamble injection (3-way gate) | HIGH | A.3.5 | Document gate as invariant; measure prod usage |
| F.4 | `find_person_in_organization` phone-mask | HIGH | 7.1 invariant | Add "never returns raw phone" test |
| F.5 | Homonym disambiguation (template-driven) | MEDIUM | 2.3.i | Add template L443-L453 to "ports verbatim" list |
| F.6 | Contact reuse before re-asking phone | MEDIUM | 2.3.i | Same as F.5 |

### Audit 10 — Admin actions

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| 10.1.tool | `manage_holidays` 4 ops | MEDIUM | spec PR | Add admin MCP tool family |
| 10.1.cache | `_holidayCache` invalidation contract | MEDIUM | spec PR | Restate |
| 10.1.year-prefix | `set_year` validation | LOW | 7.1 | Error-path test |
| 10.2.contract | `add_manager` idempotency + phone canonicalization | HIGH | 2.3.e expand | Document dual-write |
| 10.2.merge-meta | Runtime dual-write `user_roles` + extension | HIGH | 2.3.e expand | Lock invariant |
| 10.3.tool | `add_delegate` separate vs param | MEDIUM | spec PR | Decide |
| 10.3.permission-matrix | Delegate-only carve-out | HIGH | spec PR | Restate 3-tier gate |
| 10.4.linked-guard | Authority-while-linked | HIGH | 7.1 test | Add error-path test |
| 10.4.notifications | Cancel notification recipient set | MEDIUM | spec PR | Restate per-type (meeting/recurring/simple) |
| 10.4.undo | `restore_task` separate action | LOW | spec PR | Mention in cancel undo |
| 10.5.surface | Remove child board (raw-SQL recipe) | MEDIUM | spec decision | Drop or merge into `archive_taskflow_board` |
| 10.6.surface | Set `cross_board_subtask_mode` (raw-SQL) | MEDIUM | spec decision | Keep raw recipe + 1 integration test |
| 10.7.surface | `merge_project` not in tool inventory | MEDIUM | spec PR | Port-forward (pattern reference) |
| 10.7.invariants | 5 merge invariants | HIGH | spec PR | Restate (UPDATE-in-place; blocked_by rekey across all tasks; etc.) |
| 10.8.spec-plan-conflict | Spec L266 vs plan 2.3.h | BLOCKER | spec PR | Honor plan |

### Audit 11 — Permissions

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| 11.1.gate-shape | 3-tier gate not specified for v2 | BLOCKER | 2.3.e + 2.3.a | Lock dual-write + role_label gate |
| 11.1.sender-id | sender_name → user_id bridge | HIGH | 2.3.a | Document IPC envelope or resolver |
| 11.2.self-approval | Manager-also-assignee blocked | HIGH | 2.3.a regression test | Add explicit test |
| 11.3.delegate-gate | `process_inbox` + approve/reject delegate-eligible | HIGH | 2.3.e + 2.3.a | Lock |
| 11.3.process-inbox | Tool missing from spec | HIGH | spec PR | Add (cross-ref B5) |
| 11.4.gate | Subtask approval handler manager-only (not delegate) | HIGH | 2.3.h | Restate inner gate |
| 11.5.matrix | move_task per-action permission matrix | HIGH | spec PR | Enumerate (start/wait/resume/return/review/conclude/approve/reject/reopen/force_start) |
| 11.5.canClaim | Unassigned-inbox claim rule | HIGH | 2.3.a regression test | "Any board member can claim" |
| 11.6.parent-link-guard | Cross-board mutation requires owning-board admin | HIGH | 2.3.a regression test | Add test |
| 11.7.local-resolve | Board-local target-person resolution | HIGH | spec PR | Restate as v2 `agent_group_members` lookup |
| 11.7.offer-register | `offer_register` response shape | MEDIUM | spec PR | Document payload |
| 11.8.engine-rule | `register_person` 4-field hierarchy guard | HIGH | spec PR + 7.1 | Restate as TaskFlow domain |
| 11.8.auto-provision | `auto_provision_request` MCP→host wiring | MEDIUM | spec PR | Document |
| 11.9.template-hint | Proactive self-approval detection in template | HIGH | 2.3.i | Port verbatim |

### Audit 12 — Person management

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| P.1.spec | `register_person` MCP tool | BLOCKER | spec PR | Add to tool inventory |
| P.2.contract | Slug derivation algorithm | MEDIUM | spec PR | Document 4-stage algorithm |
| P.3.contract | Phone canonicalization at write | HIGH | spec PR | Restate two write-side canonicalizations (board_people digits-only; users.id `phone:+E164`) |
| P.4.contract | Phone validation policy | LOW | spec PR | Document Brazilian-only assumption |
| P.5.policy | Person ID collision policy (no auto-suffix) | MEDIUM | spec PR | Lock policy |
| P.6.contract | `boards.owner_person_id` semantics | MEDIUM | 2.3.d | Schema-init test |
| P.7.tool | `is_primary_manager` flag on `add_board_admin` | HIGH | spec PR | Add `is_primary` parameter |
| P.8.permission | Delegate restriction in v2 | HIGH | 2.3.e + 2.3.a | Decide preserve (recommended) vs drop |
| P.9.history | `remove_person` audit-trail row | MEDIUM | engine + 7.1 | ~5 LOC engine fix |
| P.10.contract | Observer / phoneless person mapping | MEDIUM | spec PR | Decide option (a) no users row |

### Audit 13 — Audit + history

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| AH.3 | `trigger_turn_id` 89% null + lazy-ALTER | MEDIUM | 2.3.d enumerate | Document sparsity as known limit |
| AH.4 / AH.5 | Magnetism guard reads deleted v2 table | BLOCKER | NEW 2.3.q | Drop OR re-implement (~120 LOC) |
| AH.7 | `archive_reason` taxonomy | MEDIUM | spec PR | Document 4 reasons; remove `merged` from claims |
| AH.8 | `auditTrailDivergence` bug class disappears | HIGH | 2.3.m.3 (split) | Drop or redefine |
| AH.9 | `selfCorrections` 60-min + LIKE patterns | HIGH | 2.3.m enumerate | Listed preservation requirement |
| AH.10 | Dryrun NDJSON `/workspace/audit/` mount | HIGH | 2.3 mount allowlist | Add to allowlist |
| AH.11 | `send_message_log` DROP decision | HIGH | 2.3.c + 2.3.m | Already partly addressed; coupling needs explicit accounting |
| AH.13 | 8 interaction-record signals (3 read send_message_log) | HIGH | 2.3.m enumerate | Per-signal preservation list |
| AH.16 | `auditor-prompt.txt` 5× references send_message_log | HIGH | NEW 2.3.m.2 | Prompt rewrite + per-board DB row UPDATE |

### Audit 14 — Attachments

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| 14.1.spec | Pre-flight check for media-support skill | LOW | DEPRECATE | Drop documented protocol; replace with 1-line CLAUDE.md |
| 14.3.contract-mismatch | OCR promise vs codebase | MEDIUM | DEPRECATE | Same as above; vision-block path is what works |
| 14.4.engine-tool | "Engine writes audit row automatically" — tool is vapor | MEDIUM | DEPRECATE | Honest CLAUDE.md rewrite |
| 14.6.rejected-table | `rejected_mutations` table doesn't exist | MEDIUM | DEPRECATE | Remove from test plan |
| 14.11.specific-clause | Attachment-specific prompt-injection | LOW | spec PR | Add clause if revival; otherwise DEPRECATE |

### Audit 15 — Templates + runtime

| GAP ID | Feature | Severity | Plan section | Recommended fix |
|---|---|---|---|---|
| G-15.1.1 | Spec wrong on size (1316 actual vs ~400) | HIGH | spec L48 + L335 | Correct estimates |
| G-15.1.2 | No retro-render mechanism | HIGH | A.3.6 invariant | Re-render at cutover |
| G-15.1.3 | Per-board variation strategy unselected | MEDIUM | 2.3.i sub-task 4 | Lock option (a) provision-time |
| G-15.2.1 | Rollback template `.v1` doesn't exist | LOW | scope drop | Or snapshot at cutover with env-var switch |
| G-15.3.1 | Scope guard prompt-only | MEDIUM | 7.1 test | Add hostile content test |
| G-15.4.1 | Prompt-injection guardrails 0 prod exercise | HIGH | 7.1 test | Hostile content in task description |
| G-15.4.2 | v2 sensitive paths missing from block list | HIGH | 2.3.i sub-task 3 | Augment template L23 |
| G-15.5.1 | `target_chat_jid` 11 sites; v2 uses named-ACL | HIGH | 2.3.i sub-task 2 | Rewrite all 11 sites |
| G-15.6.1 | `board_admins` 4 sites; v2 has no such table | HIGH | 2.3.i sub-task 2 | Rewrite to user_roles + meta |
| G-15.7.1 | `<context>` header has 3 attrs; spec mentions only timezone | MEDIUM | 2.3.i sub-task 2 | Reproduce all 3 (timezone/today/weekday) |
| G-15.7.2 | `<context>` header lives on host | LOW | architecture decision | Document where v2 ownership lands |
| G-15.8.1 | `normalizePhone` host-side ownership unclear | HIGH | 1.7 (NEW) | Add to A.3.1 step list |
| G-15.8.2 | `maskPhoneForDisplay` not in port list | LOW | 2.3.a | Enumerate as sibling export |
| G-15.9.1 | `intended_weekday` engine-optional | LOW | engine | Tighten to `weekday_inference_required` |
| G-15.9.2 | No en-US display map | LOW | spec | 28/28 prod boards on pt-BR; defer |

---

## Plan revision summary table

| Phase | Change type | Detail | Estimated effort |
|---|---|---|---:|
| **A.3.1** | Step list expand | Add 1.7 — port `normalizePhone` host-side parity + tests | ~2h |
| **A.3.2** | NEW sub-task 2.3.o | Cross-board rollup engine port (B1) | ~3 days |
| **A.3.2** | NEW sub-task 2.3.p | Notification consolidation 5-s merge (K.5) | ~4h |
| **A.3.2** | NEW sub-task 2.3.q | Magnetism guard re-implementation OR drop | ~1 day (drop) or 2 days (port) |
| **A.3.2** | NEW sub-task 2.3.r | DST decommission cleanup | ~4h |
| **A.3.2** | NEW sub-task 2.3.s | Kipp dedicated audit session | ~6h |
| **A.3.2** | Expand 2.3.a | Enumerate 12+ missing MCP tools (process_inbox, manage_holidays, register_person family, detach_task, reparent_task, merge_project, body-keys) | ~2 days |
| **A.3.2** | Expand 2.3.c | Capture trigger_message_id/turn_id/chat_jid/sender (B7) | ~6h |
| **A.3.2** | Expand 2.3.e | Lock dual-write `taskflow_board_admin_meta` invariant + 3-tier gate | ~1 day |
| **A.3.2** | Expand 2.3.g | Add 4 anti-drift acceptance sub-bullets (B8) | ~1 day |
| **A.3.2** | Expand 2.3.h | Resolve spec/plan `/aprovar` conflict (B9) | ~2h |
| **A.3.2** | Split 2.3.i | 4 sub-tasks (B2): port + MCP-routing + sensitive-paths + variation generation | ~3 days |
| **A.3.2** | Split 2.3.m | 4 sub-tasks: script + prompt + divergence-decision + magnetism | ~4 days |
| **A.3.2** | Expand 2.3.n | Couple action-name canon with engine IN-clause + auditor heredoc | ~1 day |
| **A.3.5** | Expand A.3.5 | 6 named features + 4 thresholds + 6 test sub-cases | ~1 day |
| **A.3.6** | Add 7+ invariants | DST=0; ACL=784; recurrence canonical; CLAUDE.md re-rendered; users phone canon; etc. | ~6h |
| **A.3.7** | Add Person Tools category | 6 person-mgmt tools + variants | ~2 days |
| **A.3.7** | Expand Kanban | 12+ tools; restore_task, process_inbox, manage_holidays sub-ops, etc. | ~1 day |
| **A.3.7** | Add cross-board test | Rollup auto-firing + 🔗 marker render + 4 write-guard rejections | ~6h |
| **Spec** | Multiple PRs | Person Tools subsection; correct line counts; resolve L266; tool inventory expansion | ~2 days |

**Net plan delta:** ~+10 days of TDD work + 2 days of spec PRs = roughly **+2 weeks** on the 7-8 week Track A estimate. The plan currently estimates 7-8 weeks; with these revisions, **9-10 weeks** is a more honest estimate.

---

## Key file paths

- All 15 audit docs: `/root/nanoclaw/docs/superpowers/audits/2026-05-03-feature-coverage/{01..15}-*.md`
- Plan: `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`
- Spec: `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`
- Discovery synthesis: `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/00-synthesis.md`
- Engine source: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (9598 LOC)
- Auditor: `/root/nanoclaw/container/agent-runner/src/auditor-script.sh` + `auditor-prompt.txt`
- CLAUDE.md template: `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template` (1316 LOC)
- Production DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`

---

**Document generated:** 2026-05-03
**Synthesis scope:** 15 audits × ~155 features × ~115 GAPs × 9 BLOCKERs
**Net recommendation:** the plan is structurally sound (Path A skill-branch model + Discovery-grounded sub-tasks) but **A.3.2 needs to grow from 12-14 to 19+ sub-tasks** before TDD-RED can begin. The 9 BLOCKERs are individually small (each a few hundred LOC or a spec-PR) but several are coupled (rollup + ACL; magnetism + auditor; permissions + person tools). The plan must (a) name them, (b) order them, and (c) lock acceptance criteria — currently it does (a) for ~6 of 9, (b) for 0 of 9, and (c) for 2 of 9.
