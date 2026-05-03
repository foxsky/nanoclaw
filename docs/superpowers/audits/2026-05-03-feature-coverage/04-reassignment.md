# Coverage Matrix — Section G: Task Reassignment & Delegation

> **Date:** 2026-05-03
> **Scope:** validate v2 plan covers all 5 reassignment features (G.1–G.5) + auto-relink behavior + cross-board guard (P.6 cross-listed).
> **Inputs:**
> - Inventory: `docs/superpowers/audits/2026-05-03-add-taskflow-feature-inventory.md` §G + §P.6 + §V.3
> - Mapping: `docs/superpowers/audits/2026-05-03-add-taskflow-v1v2-mapping.md` §G + §P.6 + §V
> - Plan: `docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` §A.3.7 Step 7.1
> - Spec: `docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` §"MCP tool inventory"
> - Discovery 19: `docs/superpowers/research/2026-05-03-v2-discovery/19-production-usage.md` §11
> - Engine: `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts` lines 2815–3060
> - Production DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`

---

## Production validation (refreshed 2026-05-03)

| Metric | Value | Source |
|---|---:|---|
| `task_history.action='reassigned'` total | 210 | `SELECT COUNT(*) FROM task_history WHERE action='reassigned'` |
| ≤60 days | 206 | (most reassign activity is recent) |
| ≤30 days | 82 | continued steady volume |
| board-seci-taskflow share | 159 / 206 = **77 %** | confirms Discovery 19 "75 % on seci" |
| `was_linked=true` (touched cross-board link) | 32 / 206 = **15.5 %** | engine writes this when source task was `child_exec_enabled=1` |
| └─ `relinked_to=<board>` (target had child board → relinked) | 18 | auto-relink fires |
| └─ `relinked_to=null` (target had no child board → unlinked) | 14 | auto-relink unlinks |
| Bulk reassign batches (`trigger_turn_id` mutating ≥2 tasks) | 0 | of 9 rows with non-null trigger_turn_id, none cluster |
| Same-second batches by `(board_id, by, sec)` ≥2 | 4 batches × 2 tasks each | 8 / 206 = 3.9 % may be bulk; the rest is single-task |
| Boards using reassign in 60 d | 5 / 28 (seci, sec, setec-secti, laizys, thiago) | concentrated in active hubs |

**Reassign details shape (verified):** `{"from_assignee":"…","to_assignee":"…"}` (basic) or `{"from_assignee":…,"to_assignee":…,"was_linked":true,"relinked_to":"<boardId>"|null}` (when source task was cross-board linked).

> Discovery 19 said "~30 % had auto-relink" based on a sample of seci reassigns. Population-level, the rate is **15.5 %** of all reassigns over 60 d. Both numbers are right (the seci sub-sample is enriched; population is diluted by the 47 reassigns on other boards).

> Discovery 19 said "no bulk-reassign use observed." Confirmed: the ≥2-task same-second clusters are 4 incidents of 2 tasks each — likely two consecutive single-task calls within the same agent turn, not the bulk API. **No production user has invoked `taskflow_reassign(source_person=…)` against ≥3 active tasks.**

---

## Coverage matrix

| ID | Feature | v1 location | v2 plan location | Status | GAP? | Notes |
|---|---|---|---|---|---|---|
| **G.1** | Single-task reassign — `taskflow_reassign(task_id, target_person, sender_name, confirmed)` | `taskflow-engine.ts:2818` `reassign()` single-task branch (lines 2833–2857) | Spec §"MCP tool inventory" lists `bulk_reassign` only; plan §A.3.7 Step 7.1 Kanban row lists `bulk_reassign` only | **PARTIAL — name mismatch + single-task path implicit** | **GAP-G1** | Spec/plan only name `bulk_reassign`. v1 unifies single + bulk under one tool (`taskflow_reassign`) with `task_id` XOR `source_person`. v2 plan must either (a) keep the unified tool and rename, or (b) split into `reassign_task` + `bulk_reassign` and explicitly enumerate single. Currently single-task is unspecified. |
| **G.2** | Bulk reassign all active tasks A→B in one call | `taskflow-engine.ts:2858–2890` bulk branch | Spec §"MCP tool inventory" line 258 + plan §A.3.7 Step 7.1 | **COVERED (by name)** | none | Plan acceptance test ("WIP exceeded" error path) maps to engine line 2917–2931. Production usage: ~0 in 60 d (confirmed). |
| **G.3** | Cross-board reassignment guard (reject target not on this board) | Implemented via `resolvePerson(target)` returning null when target not in `board_people` for this board → `buildOfferRegisterError` (engine:2828); also cross-listed as **P.6** | Not enumerated; spec/plan rely on engine port-forward | **COVERED IMPLICITLY** | **GAP-G3** | The guard is automatic (resolvePerson scopes by `board_id`) but neither spec nor plan calls it out. Plan §A.3.7 Step 7.1 error-path table for Kanban lists "WIP exceeded" + "non-business-day rejected"; should add "target not on board → offer_register" as a Kanban error path. |
| **G.4** | Dry-run summary (`confirmed=false` returns `requires_confirmation` text + `tasks_affected`) | `taskflow-engine.ts:2933–2952` | Not enumerated; spec §"Pattern 1" line 127 cites `ask_user_question('Confirm bulk reassign')` as v2-style confirmation | **PARTIAL — design drift** | **GAP-G4** | Spec proposes replacing the engine's dry-run/confirm protocol with `ask_user_question` (300 s window). This is a behavior change: v1's protocol is two MCP calls (confirmed=false → confirmed=true) with no human-in-the-loop UI; v2 spec wraps it in an admin DM card. Decision needed: (a) keep engine protocol (port-forward, no design change) — recommended given low bulk usage and that single-task already auto-skips confirmation per commit `c1b89f00`; or (b) adopt `ask_user_question` for bulk only and document the LOC delta + timeout semantics. **Note:** commit `c1b89f00` "skip reassign confirmation for single-task assignments" means single-task already executes without confirmation — only bulk needs the dry-run. |
| **G.5** | Confirmed=true execute path (mutation + history + notification) | `taskflow-engine.ts:2954–3060` | Not enumerated as a distinct flow; covered by general "happy path" in plan §A.3.7 | **COVERED** | none | Engine writes (a) UPDATE tasks, (b) `task_history` row with `action='reassigned'`, (c) per-task notification via `buildReassignNotification` (line 1534). Plan happy-path test will exercise this. |
| **G.aux** | Auto-relink on reassign (cross-board child_exec re-binding) | `taskflow-engine.ts:2989–3007` | Not mentioned in spec or plan | **COVERED IMPLICITLY (port-forward)** | **GAP-Gaux** | This is the load-bearing logic that handles 32 / 206 = 15.5 % of production reassigns. The engine: (1) pre-fetches `child_board_registrations` for the new assignee on the source board, (2) sets `child_exec_enabled/board_id/person_id` based on whether target has a child board, (3) special-cases `type='recurring'` to never link, (4) records `was_linked` + `relinked_to` in history details. Plan must explicitly test: (a) link → relink (target has child board); (b) link → unlink (target has no child board); (c) recurring task stays unlinked; (d) `regBoardId` correctness for delegated tasks (engine line 2898–2901). |

**Cross-cutting:**

| ID | Feature | Plan coverage |
|---|---|---|
| **P.6** | Cross-board reassignment guard | Same as **G.3** — should be added to error-path test list. |
| **V.3** | `taskflow_reassign` MCP tool | Mapping §V.1–V.9 marks this FORK-KEEP and locates it at `add-taskflow/add/container/agent-runner/src/mcp-tools/taskflow.ts`. Plan §A.3.7 Step 7.1 Kanban row exercises it. |
| **X.1** | 234+ engine tests (incl. reassign) | Plan §A.3.7 inherits the test suite via port-forward; explicit verification gate is "every tool has at least 2 tests." |

---

## Status counts

| Status | Count | IDs |
|---|---:|---|
| COVERED | 2 | G.2, G.5 |
| COVERED IMPLICITLY | 2 | G.3, G.aux |
| PARTIAL | 2 | G.1, G.4 |
| MISSING | 0 | — |

GAPs: **3** (G1, G3, Gaux design-decision; G4 design-decision pending).

---

## Recommended plan amendments

1. **Spec amendment (1 line):** §"MCP tool inventory" Kanban table — replace `bulk_reassign` with `taskflow_reassign` (single + bulk) **OR** add a separate `reassign_task` row. The unified-tool design has shipped to 5 production boards with 210 events; splitting now is a behavior change that requires a v1→v2 migration of agent-prompt verbiage. Recommend: keep unified, rename to `taskflow_reassign` for consistency with v1. (**GAP-G1**)
2. **Spec decision needed (1 paragraph):** §"Cross-board approval flow" Pattern 1 references `ask_user_question` for bulk reassign confirmation. Decide:
   - **(a) Port-forward unchanged** (recommended): keep engine's `confirmed=false` → `confirmed=true` two-call protocol; production usage is 0 bulk reassigns in 60 d so the UX delta is theoretical. The single-task auto-skip (commit `c1b89f00`) is already the right behavior for the 99 % case.
   - **(b) Adopt `ask_user_question`**: document the 300 s timeout, the WhatsApp single-pending-question contention (per Codex review #6 B1), and the agent-prompt update. (**GAP-G4**)
3. **Plan amendment (Phase A.3.7 Step 7.1 Kanban error-path column):** add three error rows for `taskflow_reassign`:
   - "Target person not on this board → `offer_register` error" (G.3 / P.6)
   - "Reassign completed task → error" (engine:2839)
   - "Same source/target person → error" (engine:2853, 2866)
   Currently only "WIP exceeded" + "non-business-day rejected" are listed. (**GAP-G3**)
4. **Plan amendment (Phase A.3.7 Step 7.1 Kanban happy-path column):** explicitly add an auto-relink test variant for `taskflow_reassign` covering the 4 cases (link→relink, link→unlink, recurring stays unlinked, delegated-task `regBoardId` resolution). 15.5 % of production reassigns exercise this branch — it is not a corner case. (**GAP-Gaux**)

---

## Production source code references

- **Single-task path:** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:2833-2857`
- **Bulk path:** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:2858-2891`
- **Permission gate (assignee-or-manager):** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:2843-2850`, `2870-2877`
- **Cross-board guard (P.6):** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:2828` (`resolvePerson` → `buildOfferRegisterError`)
- **Pre-fetch target child-board registration (delegated task fix):** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:2893-2901`
- **WIP gate:** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:2917-2931`
- **Dry-run summary:** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:2933-2952`
- **Execute + auto-relink:** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:2954-3060`
- **History row builder:** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:3031-3046`
- **Notification builder:** `data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts:1534` (`buildReassignNotification`)

## Recent reassign-related engine commits

- `028a7974` — feat: implement `taskflow_reassign` with auto-relink (initial implementation)
- `8ba89aa5` — fix: null assignee in reassign notification + offer_register passthrough
- `c1b89f00` — fix: skip reassign confirmation for single-task assignments
- `8ab93fdc` — fix: add reassignment procedure and anti-pattern to TaskFlow template
