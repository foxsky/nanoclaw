# Coverage Matrix — Section G: Task Reassignment & Delegation

> **Date:** 2026-05-03
> **Scope:** validate v2 plan covers all 5 reassignment features (G.1–G.5) + auto-relink behavior + cross-board guard (P.6 cross-listed).
>
> **Inputs (cited by caller):**
> - Plan: `docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`
> - Spec: `docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` (§"MCP tool inventory" line 258, §"Cross-board approval flow" Pattern 1 line 127)
> - Discovery 19 (prod stats): `docs/superpowers/research/2026-05-03-v2-discovery/19-production-usage.md` §11
> - Sibling audits: `docs/superpowers/audits/2026-05-03-feature-coverage/{02-task-lifecycle,03-cross-board}.md`
> - Engine (verified, current): `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
> - Production DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`
>
> **Caveat — missing inventory/mapping inputs.** The `*-add-taskflow-feature-inventory.md` and `*-add-taskflow-v1v2-mapping.md` files referenced in earlier sibling audits (§G IDs) do not exist on disk in `/root/nanoclaw/docs/superpowers/audits/`. The G.1–G.aux IDs below are inherited from sibling audits 02 and 03's stable numbering convention and grounded in the production engine source + live DB queries.
>
> **Source of truth (verified at audit time):**
> - Engine: `taskflow-engine.ts` 9598 lines.
> - `reassign()` entrypoint: `:4080–4344` (single + bulk unified).
> - Single-task branch: `:4095–4119`.
> - Bulk branch: `:4120–4153`.
> - Permission gate (assignee/source-or-manager): `:4106–4112` (single), `:4133–4139` (bulk).
> - Cross-board guard (P.6): `:4090` (`resolvePerson` → `buildOfferRegisterError`).
> - Pre-fetch target child-board reg (delegated-task fix): `:4155–4163` (regBoardId selects task's owning board for single-task delegated path).
> - WIP gate: `:4179–4193`.
> - Dry-run summary: `:4195–4214`.
> - Execute + auto-relink: `:4216–4339`.
> - History row builder: `:4304–4319` (writes `from_assignee` / `to_assignee` / `was_linked` / `relinked_to`).
> - Notification builder: `:2746` (`buildReassignNotification`).
> - Type contracts: `ReassignParams` `:139–146`, `ReassignResult` `:148–158`, `tasks_to_reassign` `:280`.

---

## Production validation (refreshed 2026-05-03)

All queries against `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`. Note: `task_history` uses `at` (TEXT), not `created_at`.

| Metric | Value | Source |
|---|---:|---|
| `task_history.action='reassigned'` total (lifetime) | 210 | `SELECT COUNT(*) FROM task_history WHERE action='reassigned'` |
| ≤60 days | **206** | matches Discovery 19 §11 ("206 in last-60d") |
| ≤30 days | **82** | continued steady volume |
| `board-seci-taskflow` share (60 d) | 159 / 206 = **77 %** | confirms Discovery 19 "75 % on seci" (matches caller's "75 % on board-seci-taskflow") |
| `was_linked=true` (touched cross-board link) | 32 / 206 = **15.5 %** | matches caller's "15.5 % had auto-relink" — engine writes this when source task was `child_exec_enabled=1` |
| └─ `relinked_to=<board>` (target had child board → auto-relinked) | 18 | auto-relink fires |
| └─ `relinked_to=null` (target had no child board → unlinked) | 14 | auto-relink unlinks |
| Bulk batches via `trigger_turn_id` (>1 task in one turn) | **0** | `trigger_turn_id` populated only for newer rows; none cluster |
| Same-second batches by `(board_id, by, sec)` ≥2 | **4 batches × 2 tasks each** | 8 / 206 = 3.9 % may be bulk-API or two consecutive single-task calls within one turn |
| Boards using reassign in 60 d | 5 / 28 (`seci`, `sec`, `setec-secti`, `laizys`, `thiago`) | concentrated in active hubs |

**Reassign details shape (verified by sampling 6 rows):**

| board / task | by | at (UTC) | details |
|---|---|---|---|
| `board-seci-taskflow` / P2.15 | giovanni | 2026-04-30 12:35:59 | `{"from_assignee":"mauro","to_assignee":"ana-beatriz","was_linked":true,"relinked_to":"board-asse-seci-taskflow-2"}` (link → relink) |
| `board-sec-taskflow` / T96 | laizys | 2026-04-30 11:41:25 | `{"from_assignee":"laizys","to_assignee":"maura-rodrigues-da-silva","was_linked":true,"relinked_to":null}` (link → unlink) |
| `board-seci-taskflow` / P22.1 | mariany | 2026-04-23 13:21:23 | `{"from_assignee":"rodrigo-lima","to_assignee":"mariany","was_linked":true,"relinked_to":null}` (link → unlink, self-pull) |
| `board-laizys-taskflow` / T48 | laizys | 2026-04-30 09:32:23 | `{"from_assignee":"laizys","to_assignee":"mario-jose-da-silva-junior"}` (vanilla in-board) |
| `board-laizys-taskflow` / T47 | laizys | 2026-04-30 09:30:20 | `{"from_assignee":"laizys","to_assignee":"maura-rodrigues-da-silva"}` (vanilla in-board) |
| `board-thiago-taskflow` / T19 | thiago | 2026-04-23 22:27:40 | `{"from_assignee":"thiago","to_assignee":"guilherme"}` (vanilla in-board) |

Schema observation: when the source task was `child_exec_enabled=1`, `details` always contains both `was_linked:true` and `relinked_to:<boardId|null>` — the keys are paired and never partial. When the source was unlinked, `details` is the bare `{from_assignee, to_assignee}` two-key object. This pairing is asserted at engine `:4309–4312`.

> Discovery 19 originally reported "~30 % had auto-relink" based on a `seci`-only sub-sample. Population-level the rate is **15.5 %** of all reassigns over 60 d. Both numbers are right (the seci sub-sample is enriched; population is diluted by the ~47 reassigns on other boards).

> Discovery 19 stated "no bulk-reassign use observed." Re-confirmed: the same-second clusters are **4 incidents of 2 tasks each** — likely two consecutive single-task calls within the same agent turn, not the bulk-transfer API (`source_person`). **No production user has invoked `taskflow_reassign(source_person=…)` against ≥3 active tasks in the last 60 days.**

---

## Coverage matrix

| ID | Feature | v1 location | v2 plan location | Status | GAP? | Notes |
|---|---|---|---|---|---|---|
| **G.1** | Single-task reassign — `taskflow_reassign(task_id, target_person, sender_name, confirmed)` | engine `:4095–4119` (single branch inside unified `reassign()`) | Spec §"MCP tool inventory" line 258 lists `bulk_reassign` only; plan does not enumerate single-task | **PARTIAL — name mismatch + single-task path implicit** | **GAP-G1** | v1 unifies single + bulk under one tool (`taskflow_reassign`) with `task_id` XOR `source_person` (engine `:4083–4086` validates exactly one is provided). Spec/plan only name `bulk_reassign`. v2 plan must either (a) keep the unified tool and rename, or (b) split into `reassign_task` + `bulk_reassign` and explicitly enumerate the single-task path. Currently single-task is unspecified despite being **>96 % of production usage**. |
| **G.2** | Bulk reassign all active tasks A→B in one call (`source_person=…`) | engine `:4120–4153` (bulk branch) | Spec §"MCP tool inventory" line 258 (`bulk_reassign`) | **COVERED (by name)** | none | Engine `:4142–4148` selects `WHERE board_id = ? AND assignee = ? AND column != 'done'`. Spec mentions confirmation via `ask_user_question` (line 127). Production usage: **0 invocations in 60 d** confirmed. |
| **G.3** | Cross-board reassignment guard (reject target not on this board) | engine `:4090` — `resolvePerson(target)` returns null when target not in `board_people` for this board → `buildOfferRegisterError`. Cross-listed as **P.6**. | Not enumerated in spec/plan; relies on engine port-forward | **COVERED IMPLICITLY** | **GAP-G3** | The guard is automatic (`resolvePerson` scopes by `board_id` per engine `:4090`) but neither spec nor plan calls it out. Plan's error-path table for Kanban tools (currently lists "WIP exceeded" + "non-business-day rejected" per the inferred Step 7.1 contract) should add **"target not on board → offer_register"** + **"reassign completed task → error"** (`:4101–4103`) + **"same source/target person → error"** (`:4115–4117`, `:4128–4130`). |
| **G.4** | Dry-run summary (`confirmed=false` returns `requires_confirmation` text + `tasks_affected`) | engine `:4195–4214` | Spec §"Pattern 1" line 127 cites `ask_user_question('Confirm bulk reassign')` — replaces the engine's two-call protocol | **PARTIAL — design drift** | **GAP-G4** | Spec proposes wrapping bulk reassign confirmation in an `ask_user_question` (60–300 s window, transient `pending_questions` row). Behaviour change vs v1's two-call MCP protocol (`confirmed=false` returns text → caller re-invokes with `confirmed=true`). Decision needed: **(a) keep engine protocol** (port-forward, no change) — recommended given **0 bulk reassigns in 60 d**; commit `c1b89f00` already auto-skips confirmation for the >96 % single-task path so the dry-run only ever fires for bulk; **(b) adopt `ask_user_question`** for bulk only and document timeout semantics + WhatsApp single-pending-question contention (per Codex review #6 B1) + agent-prompt verbiage update. |
| **G.5** | Confirmed=true execute path (mutation + history + notification) | engine `:4216–4339` | Not enumerated as a distinct flow; covered by general "happy path" in plan §A.3.7 | **COVERED** | none | Engine writes (a) UPDATE `tasks` (`:4279–4302`) — assignee, column (`inbox→next_action` auto-promote `:4276`), `child_exec_*`, optional rollup-field clear; (b) `task_history` row with `action='reassigned'` (`:4313–4319`); (c) per-task notification via `buildReassignNotification` (`:4322–4329`, builder at `:2746`). Undo snapshot embedded in `_last_mutation` (`:4238–4249`). Plan happy-path test will exercise this. |
| **G.aux** | Auto-relink on reassign (cross-board child-exec re-binding) | engine `:4155–4163` (pre-fetch) + `:4251–4269` (apply) + `:4304–4319` (history) | Not mentioned in spec or plan | **COVERED IMPLICITLY (port-forward)** | **GAP-Gaux** | This is the load-bearing logic that handles **32 / 206 = 15.5 %** of production reassigns. Three branches (engine `:4256–4269`): (1) `task.type === 'recurring'` → never link (set all `child_exec_*` to NULL/0); (2) `targetChildReg` exists → relink to target's child board; (3) was-linked + no target reg → unlink. Plus rollup-field clear (`:4271–4273`) when child board changes or delegation removed. **`regBoardId` correctness for delegated tasks** (`:4160–4162`): when `task.board_id != this.boardId` (single-task path on a delegated task), look up registrations on the task's owning board, not the current board, or auto-relink silently misses. Plan must explicitly test 4 cases: (a) link → relink (target has child board); (b) link → unlink (target has no child board); (c) recurring task stays unlinked; (d) delegated-task `regBoardId` resolution. |

**Cross-cutting:**

| ID | Feature | Plan coverage |
|---|---|---|
| **P.6** | Cross-board reassignment guard | Same as **G.3** — should be added to error-path test list. |
| **V.3** | `taskflow_reassign` MCP tool | Sibling mapping (when produced) should mark this FORK-KEEP and locate it at `add-taskflow/add/container/agent-runner/src/mcp-tools/taskflow.ts`. Plan §A.3.7 Step 7.1 Kanban row exercises it. |
| **X.1** | 234+ engine tests (incl. reassign) | Plan inherits the test suite via port-forward; explicit verification gate is "every tool has at least 2 tests." Engine's reassign tests should cover all 4 auto-relink branches. |

---

## Status counts

| Status | Count | IDs |
|---|---:|---|
| COVERED | 2 | G.2, G.5 |
| COVERED IMPLICITLY | 2 | G.3, G.aux |
| PARTIAL | 2 | G.1, G.4 |
| MISSING | 0 | — |

GAPs: **4** open (G1 spec-rename, G3 error-path enumeration, G4 design-decision pending, Gaux test enumeration).

---

## Recommended plan amendments

1. **Spec amendment (1 line):** §"MCP tool inventory" Kanban table — replace `bulk_reassign` with `taskflow_reassign` (single + bulk) **OR** add a separate `reassign_task` row. The unified-tool design has shipped to 5 production boards with 210 events; splitting now is a behavior change that requires a v1→v2 migration of agent-prompt verbiage. Recommend: keep unified, rename to `taskflow_reassign` for consistency with v1. (**GAP-G1**)
2. **Spec decision needed (1 paragraph):** §"Cross-board approval flow" Pattern 1 line 127 references `ask_user_question` for bulk reassign confirmation. Decide:
   - **(a) Port-forward unchanged** (recommended): keep engine's `confirmed=false` → `confirmed=true` two-call protocol; production usage is **0 bulk reassigns in 60 d** so the UX delta is theoretical. Commit `c1b89f00` already auto-skips confirmation for the 96 %+ single-task case — the dry-run prompt only fires for the never-used bulk path.
   - **(b) Adopt `ask_user_question`**: document the 60–300 s timeout, the WhatsApp single-pending-question contention (Codex review #6 finding B1), and the agent-prompt update. (**GAP-G4**)
3. **Plan amendment (Phase A.3.7 Step 7.1 Kanban error-path column):** add three error rows for `taskflow_reassign`:
   - "Target person not on this board → `offer_register` error" (G.3 / P.6, engine `:4090`)
   - "Reassign completed task → error" (engine `:4101–4103`)
   - "Same source/target person → error" (engine `:4115–4117` single, `:4128–4130` bulk)
   Currently only "WIP exceeded" + "non-business-day rejected" appear in the inferred Kanban row. (**GAP-G3**)
4. **Plan amendment (Phase A.3.7 Step 7.1 Kanban happy-path column):** explicitly add an auto-relink test variant for `taskflow_reassign` covering the 4 cases (link→relink, link→unlink, recurring stays unlinked, delegated-task `regBoardId` resolution). **15.5 %** of production reassigns exercise this branch — it is not a corner case. (**GAP-Gaux**)

---

## Production source code references (current paths)

- **Unified `reassign()` entrypoint:** `container/agent-runner/src/taskflow-engine.ts:4080`
- **Single-task path:** `:4095–4119`
- **Bulk path:** `:4120–4153`
- **Permission gate (single — assignee or manager):** `:4106–4112`
- **Permission gate (bulk — source-self or manager):** `:4133–4139`
- **Cross-board guard (P.6):** `:4090` (`resolvePerson` → `buildOfferRegisterError`)
- **Pre-fetch target child-board registration (delegated-task fix):** `:4155–4163` — note the `regBoardId` selection at `:4160–4162`
- **WIP gate:** `:4179–4193`
- **Dry-run summary:** `:4195–4214`
- **Execute + auto-relink:** `:4216–4339`
- **Auto-relink branch logic (recurring | target-has-reg | was-linked):** `:4251–4269`
- **Rollup-field clear on child-board change:** `:4271–4273`
- **Inbox→next_action auto-promote:** `:4276`
- **History row builder:** `:4304–4319`
- **Notification builder:** `:2746` (`buildReassignNotification`)
- **Type contracts:** `ReassignParams` `:139–146`, `ReassignResult` `:148–158`, `tasks_to_reassign` `:280`

## Why these GAPs matter (production scale)

- **GAP-G1 (single-task name)** — Single-task reassign is **>96 %** of the 206 reassigns in the last 60 d (only 8 same-second pairs at most could be bulk; the rest are unambiguously single). Spec naming the bulk tool only and not the single-task path means the most-used reassign API has no v2 plan row.
- **GAP-G3 (cross-board guard)** — `resolvePerson` returning null + `buildOfferRegisterError` is the same primitive that gates `taskflow_assign`, `taskflow_meeting` (add_participant), and other person-targeting tools. Adding the error-path row for reassign costs nothing and removes ambiguity for the test author.
- **GAP-G4 (dry-run vs ask_user_question)** — Production has **0** bulk reassigns in 60 d, so the cost of getting this wrong is theoretical for now. But adopting `ask_user_question` introduces a new failure mode (timeout, single-pending-question contention with `subtask_requests` re-asks per spec line 151) that the current two-call protocol does not have. The safe recommendation is (a) port-forward unchanged.
- **GAP-Gaux (auto-relink)** — 32 of 206 reassigns (15.5 %) cross the auto-relink path. The 4 sub-cases are not corner cases:
  - **link → relink** (target has child board): 18 events. The default healthy-flow case for SECTI (giovanni reassigning across `seci ↔ asse-seci-*`).
  - **link → unlink** (target has no child board): 14 events. Common when reassigning back to a manager-level person who works directly on the parent board.
  - **recurring stays unlinked** (`task.type === 'recurring'`): production has only 2 recurring tasks, but the branch is asserted at engine `:4256–4260` and any port-forward must preserve it or risk creating phantom child-board entries on monthly relatórios.
  - **delegated-task `regBoardId` resolution**: when single-task path runs on a delegated task (`task.board_id != this.boardId`), looking up `child_board_registrations` on the wrong board silently misses the registration and unlinks. Engine `:4160–4162` is the fix; tests must cover this regression.

## Recent reassign-related engine commits

- `028a7974` — feat: implement `taskflow_reassign` with auto-relink (initial implementation)
- `8ba89aa5` — fix: null assignee in reassign notification + offer_register passthrough
- `c1b89f00` — fix: skip reassign confirmation for single-task assignments
- `8ab93fdc` — fix: add reassignment procedure and anti-pattern to TaskFlow template
