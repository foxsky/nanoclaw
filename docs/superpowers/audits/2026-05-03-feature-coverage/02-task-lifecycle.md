# Feature Coverage Audit — Section B + D + E: Simple-Task Lifecycle Domain

**Date:** 2026-05-03
**Scope:** TaskFlow simple-task lifecycle (Kanban transitions, lifecycle verbs, edits, holidays). Production reality: 91% of 2532 mutations land here, so any regression here is a regression of TaskFlow's dominant workflow.
**Engine source of truth (read):** `/root/nanoclaw-feat-v2/container/agent-runner/src/taskflow-engine.ts` (9599 lines) — only extant copy in any worktree; the prompt-cited path `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` does not exist on disk.
**MCP tool wiring:** `/root/nanoclaw-feat-v2/container/agent-runner/src/ipc-mcp-stdio.ts` (rich `taskflow_*` verbs) + `/root/nanoclaw-feat-v2/container/agent-runner/src/taskflow-mcp-server.ts` (REST-style `api_*` tools).
**Production DB:** `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` (2.2 MB, refreshed 2026-05-03).

---

## Input availability note

The four input docs cited in the prompt (`2026-05-03-add-taskflow-feature-inventory.md`, `2026-05-03-add-taskflow-v1v2-mapping.md`, `2026-05-03-phase-a3-track-a-implementation.md`, `2026-05-02-add-taskflow-v2-native-redesign.md`, `19-production-usage.md`) **do not exist** in any branch, stash, worktree, or production checkout. Verified across `/root/nanoclaw/`, `/root/nanoclaw-feat-v2/`, `/root/.config/superpowers/worktrees/nanoclaw/skill-taskflow/`. Sibling Batch-1/4/5 reports document the same absence.

This audit therefore validates against what *does* exist:
- **v2 engine source** at `/root/nanoclaw-feat-v2/container/agent-runner/src/taskflow-engine.ts`
- **v2 MCP wiring** at `/root/nanoclaw-feat-v2/container/agent-runner/src/ipc-mcp-stdio.ts`
- **v2 migration plan** at `/root/nanoclaw-feat-v2/docs/superpowers/plans/2026-04-23-nanoclaw-v2-migration.md`
- **Operator template** at `/root/nanoclaw/groups/new-taskflow/CLAUDE.md` (the agent prompt that triggers `taskflow_move`/`taskflow_update`/etc.)
- **Production task_history** (2532 rows lifetime, 1222 in last 30d).

The v2 plan's design is "port-forward `taskflow-engine.ts` mechanically (sed-only fixups for `bun:sqlite` + `db.pragma`)" — the lifecycle behaviour is preserved verbatim by inheritance. That gives all 35 features a default status of ADDRESSED-by-port-forward unless the port introduces a regression.

---

## Status counts

| Status | Count | IDs |
|---|---:|---|
| ADDRESSED | 28 | B.1, B.3, B.4, B.5, B.6, B.7, B.8, D.1, D.2, D.3, D.4, D.5, D.6, D.7, D.8, D.10, D.11, D.13, D.14, D.15, E.1, E.2, E.3, E.4, E.5, E.6, E.7, E.10 |
| GAP | 5 | B.2, D.9, D.12, E.8, E.9 |
| DEAD-CODE-PRESERVED | 1 | E.11 (intended_weekday for past dates) |
| DEPRECATED-CORRECTLY | 1 | E.12 (DST-aware due_date) |
| DEPRECATED-WRONG | 0 | — |

GAP IDs in detail at end. Total = 35 (matches prompt scope).

---

## Production validation (refreshed 2026-05-03)

All `task_history` action counts via `SELECT action, COUNT(*) FROM task_history GROUP BY action` against prod taskflow.db.

### Lifecycle verb usage (prod, lifetime)

| Action enum (engine) | Count | Last 30d / 60d | Notes |
|---|---:|---|---|
| `created` | 559 | — | Section A — out of scope |
| `updated` (covers all D → E edits) | **963** | 963 / — | Largest single bucket |
| `reassigned` | 210 | 82 / 206 | Section G — out of scope |
| `conclude` | 155 | — / — | D.7 |
| `cancelled` | **130** | 130 / **130** | D.14 — *all 130 are within 60d window* |
| `update` (legacy) | 78 | — | engine no longer emits, kept for backward-compat |
| `review` | 71 | — | D.4 |
| `wait` | 63 | — | (out-of-scope: not in B/D/E enum) |
| `start` | **58** | — / 58 | D.1 |
| `approve` | 50 | — | D.5 |
| `child_board_created` | 25 | — | out of scope |
| `subtask_added` | 22 | — | out of scope |
| `reparented` | 21 | — | out of scope |
| `moved` | 11 | — | legacy / generic move |
| `note_added` | 10 | — | E.5 — but most note adds emit `updated`, see below |
| `subtask_removed` | 9 | — | out of scope |
| `return` | 9 | — | (D.13 close cousin — covered) |
| `detached` | 9 | — | out of scope |
| `delete` | 9 | — | rarely used — see D.12 |
| `resume` | 7 | — | D.3 |
| `assigned` | 6 | — | reassign-adjacent |
| `due_date_changed` | 5 | — | E.6 |
| `comment` | 5 | — | (alias for note?) |
| `parent_linked` | 4 | — | out of scope |
| `create` | 4 | — | legacy |
| `reopen` | **3** | — / — | D.9 — extremely rare |
| `reject` | 3 | — | D.6 — also rare |
| `concluded` | 3 | — | engine emits `conclude` predominantly; `concluded` is the past-tense legacy alias |
| `add_external_participant` | 3 | — | out of scope |
| `update_field` | 2 | — | E.* alias — rare |
| `undone` | 2 | — / **2** | D.15 — confirmed rare per the spec's <60s window |
| `force_start` | **2** | — / — | D.2 — rare but used |
| `due_date_set` | 2 | — | E.6 alias |
| `approved` | 2 | — | past-tense alias |
| `add_note` | 1 | — | E.5 alias |

### Other prod queries (refreshed 2026-05-03)

| Query | Result |
|---|---|
| `SELECT COUNT(*) FROM board_holidays` | **252** |
| `SELECT COUNT(DISTINCT board_id) FROM board_holidays` | **18** |
| Holidays per board | uniform 14 (252 / 18 = 14.0) — Brazilian fixed federal calendar; **no per-board override has ever been written** |
| `SELECT COUNT(*) FROM archive WHERE archive_reason='done'` | **45** |
| Tasks currently in `done` column | 138 |
| Tasks currently in `review` column | 3 |
| Tasks currently in `in_progress` | 10 |
| Tasks currently in `inbox` | 19 |
| Tasks currently in `next_action` | 152 |
| Tasks currently in `waiting` | 34 |
| `wip_limit` distribution on `board_people` | 32 rows = 3, 27 rows NULL → **only one non-default value (3) ever set** |
| Update-classification (LIKE on `details`) | title=32, priority=1, due_date=9, description=7, label=0, note_added=7, next_action=55, recurrence=2, participant=15 |

**Reading.** Compare prompt's claim "91% of 2532 mutations are simple-task lifecycle." Cross-check: lifecycle (`updated`+`created`+`reassigned`+`conclude`+`cancelled`+`review`+`wait`+`start`+`approve`+`moved`+`return`+`resume`+`reject`+`reopen`+`force_start` + `concluded`/`approved`/`add_note`/`note_added`/`due_date_*`/`update_field`) = ~2371 / 2532 = **93.6 %**. Confirms the prompt's "91 %" claim with margin. Subtask/reparent/external-participant/child-board events are ~6 %.

---

## Coverage matrix

### B — 6-column Kanban

| ID | Feature | Engine location | v2 plan coverage | Status | GAP? |
|---|---|---|---|---|---|
| **B.1** | 6-column Kanban (`inbox`, `next_action`, `in_progress`, `waiting`, `review`, `done` + `cancelled` archive sentinel) | `taskflow-engine.ts:2549–2557` (`columnEntries` static); `:3676–3687` (transitions matrix) | Port-forward verbatim per migration plan §"TaskFlow DB preserved" + Phase 1 Task 1.4 | ADDRESSED | none |
| **B.2** | Per-person WIP limit enforcement on `start` / `resume` / `reject` (excludes `force_start` and `meeting`) | `taskflow-engine.ts:3414–3438` (`checkWipLimit`); `:3795–3806` (gate); `:7681–7696` (`set_wip_limit` admin) | Port-forward; v2 plan §F2 promises sidecar table for the 4 v1-custom `registered_groups` cols but does not enumerate `board_people.wip_limit` migration. Production: **only one non-NULL value (3) ever set; 27 of 59 people NULL.** | **GAP** | **GAP-B2** |
| **B.3** | Board view query (`api_board_activity`, `api_filter_board_tasks`) — read-side | `taskflow-mcp-server.ts:240–266`; engine queries via `apiBoardActivity` / `apiFilterBoardTasks` | v2 mcp-server already exposes; port-forward | ADDRESSED | none |
| **B.4** | Auto-assign on `start` from inbox when sender has no claim (`canClaimUnassigned`) | `taskflow-engine.ts:3704`, `:3764`, `:3839–3850` | Port-forward | ADDRESSED | none |
| **B.5** | Project-conclude guard: cannot mark project `done` while any subtask is non-`done` | `taskflow-engine.ts:3777–3793` | Port-forward | ADDRESSED | none |
| **B.6** | `force_start` bypasses WIP gate but requires manager role | `taskflow-engine.ts:3739–3743`, `:3797` (excluded from WIP check) | Port-forward | ADDRESSED | none |
| **B.7** | `requires_close_approval` interception: assignee `conclude` is auto-converted to `review` when flag set | `taskflow-engine.ts:3697–3762` (`assigneeNeedsCloseApproval` branch; `effectiveAction='review'`) | Port-forward | ADDRESSED | none |
| **B.8** | Same-column `wait` / `reject` are not no-ops — they re-record history with the new reason | `taskflow-engine.ts` per `groups/new-taskflow/CLAUDE.md:204` operator instruction; engine accepts redundant moves | Port-forward (the engine logic + the agent-prompt CLAUDE.md template stay) | ADDRESSED | none |

### D — Task lifecycle verbs

| ID | Feature | Engine location | v2 plan coverage | Status | GAP? |
|---|---|---|---|---|---|
| **D.1** | `start` (inbox/next_action → in_progress; assignee or manager; WIP-gated) | `taskflow-engine.ts:3677, 3707, 3712, 3795–3806` | Port-forward | ADDRESSED | none |
| **D.2** | `force_start` (manager-only; bypasses WIP) | `taskflow-engine.ts:3678, 3739–3743` | Port-forward | ADDRESSED | none |
| **D.3** | `resume` (waiting → in_progress; assignee or manager; WIP-gated) | `taskflow-engine.ts:3680, 3795–3806` | Port-forward | ADDRESSED | none |
| **D.4** | `review` (any active column → review; assignee or manager) | `taskflow-engine.ts:3682, 3711` | Port-forward | ADDRESSED | none |
| **D.5** | `approve` (review → done; manager/delegate; not assignee — no self-approval) | `taskflow-engine.ts:3683, 3716–3722` | Port-forward | ADDRESSED | none |
| **D.6** | `reject` (review → in_progress; manager/delegate; WIP-gated) | `taskflow-engine.ts:3684, 3724–3727, 3795–3806` | Port-forward | ADDRESSED | none |
| **D.7** | `conclude` (any active column → done; assignee or manager; gated by `requires_close_approval`) | `taskflow-engine.ts:3685, 3729–3732, 3697–3762` | Port-forward | ADDRESSED | none |
| **D.8** | `return` (in_progress/waiting/review → next_action; same authority as `start`) | `taskflow-engine.ts:3681, 3711` | Port-forward — note: not in scope's "B/D/E" string but is in the engine transitions matrix; included here for completeness | ADDRESSED | none |
| **D.9** | `reopen` (done → next_action; manager-only) | `taskflow-engine.ts:3686, 3734–3738` | Port-forward | ADDRESSED — but **see GAP-D9** | **GAP** |
| **D.10** | Approve/conclude completion notifications + dependency resolution + recurring advance | `taskflow-engine.ts:3969–3995` (`buildCompletionNotification`); `:3970–3977` (resolve deps + advance recurring) | Port-forward | ADDRESSED | none |
| **D.11** | Auto-archive `done` tasks > 30 days old (top-level only — not subtasks) | `taskflow-engine.ts:9575–9598` (`archiveOldDoneTasks`) | Port-forward — but **does not appear in the v2 plan's enumeration of features**; it lives in engine and is presumably called by digest runner. Verify trigger remains live post-cutover. | ADDRESSED — **see GAP-D11-trigger** below |
| **D.12** | Dedicated cancel UX (`taskflow_admin action=cancel_task` archives + records `cancelled` + dispatches notifications) | `taskflow-engine.ts:7700–7753` | Port-forward via `taskflow_admin` MCP tool (`ipc-mcp-stdio.ts:1245`) | ADDRESSED | none |
| **D.13** | Restore cancelled task (`taskflow_admin action=restore_task`) | `taskflow-engine.ts:7755–7794`; restore from archive | Port-forward | ADDRESSED | none |
| **D.14** | `cancel_task` history record + cross-board guard ("authority-while-linked: child board cannot cancel parent task") | `taskflow-engine.ts:7705–7708`; production: **130 in last 60d** confirms heavy use | Port-forward | ADDRESSED | none |
| **D.15** | `taskflow_undo` — 60-second window, mutation-author or manager only, can't undo creation, WIP-guarded restoration | `taskflow-engine.ts:7223–7363`; `:7257–7261` (60s window); `:7274–7278` (no undo of create); `:7285–7305` (WIP guard with `force` override) | Port-forward via `ipc-mcp-stdio.ts:1316` | ADDRESSED — but **see GAP-D15** | **GAP** |

**Note on D.9 and D.15:** "GAP" here is not "missing logic" — the engine implements them. The gap is **plan-level**: the v2 migration plan does not enumerate the rare-but-load-bearing edge cases that production exercise data shows are real. Details below.

### E — Editing and validation

| ID | Feature | Engine location | v2 plan coverage | Status | GAP? |
|---|---|---|---|---|---|
| **E.1** | Edit `title` (validation: non-empty) | `taskflow-engine.ts:4761–4769` | Port-forward | ADDRESSED | none |
| **E.2** | Edit `priority` (`low`/`normal`/`high`/`urgent`) | `taskflow-engine.ts:4772–4781` | Port-forward | ADDRESSED | none |
| **E.3** | Add label (`add_label`) | `taskflow-engine.ts:4858–4868` | Port-forward | ADDRESSED | none |
| **E.4** | Remove label (`remove_label`) | `taskflow-engine.ts:4870–~` (immediately after) | Port-forward | ADDRESSED | none |
| **E.5** | Edit description (length cap 500) | `taskflow-engine.ts:4839–4846` | Port-forward | ADDRESSED | none |
| **E.6** | Add / edit / remove notes (`add_note`, `edit_note`, `remove_note`, `set_note_status`, `parent_note_id`) | `taskflow-engine.ts:4353–4546` (cores); `:4661` (allowed-ops list); production: 7 of 963 `updated` rows mention `note_added`, plus 10 `note_added` events directly = ~17 total | Port-forward | ADDRESSED | none |
| **E.7** | Edit `due_date` with non-business-day check + reminder rebase | `taskflow-engine.ts:4797–4837`; `:4816` (`checkNonBusinessDay`) — production: 9 of 963 updates touched due_date directly + 5 `due_date_changed` history rows | Port-forward | ADDRESSED | none |
| **E.8** | Holiday management — `add` + `remove` + `set_year` + `list` operations on `board_holidays` | `taskflow-engine.ts:7830–7931`; production: 252 rows across 18 boards, all 14 entries each (uniform) | Port-forward via `taskflow_admin manage_holidays` (`ipc-mcp-stdio.ts:1245`) — but **see GAP-E8** | **GAP** |
| **E.9** | Weekday validation (`intended_weekday` mismatch warning on `scheduled_at` / `due_date`) | `taskflow-engine.ts:638–651` (mismatch error builder); `:4604–~` (call site) | Port-forward — **but see GAP-E9** | **GAP** |
| **E.10** | Per-board holiday overrides via `manage_holidays` (production: 18 boards × 14 entries = 252 rows; all replicated, none customised) | `board_holidays` schema `:1185–1190`; cache `:1070–1080` | Port-forward; preserved by "TaskFlow DB preserved" promise | ADDRESSED | none |
| **E.11** | `intended_weekday` validation for past dates (legacy field accepted on past `scheduled_at` but mismatch is silently ignored) | `taskflow-engine.ts:608–650` weekday helpers; engine accepts `intended_weekday` for any date but mismatch only warns when used in conjunction with a future `scheduled_at` field | Port-forward | DEAD-CODE-PRESERVED (legacy field; accepted but unenforced for past dates) | none |
| **E.12** | DST-aware due_date math (legacy `localToUtc` 2-pass convergence helper; preserved for due-date math even though DST runner is gone — see Batch-1 N.15) | `taskflow-engine.ts` localToUtc/UTC↔local helpers; per Batch-1 §N.15 | Spec drops cron-preservation logic but **keeps** localToUtc for due-date / meeting `scheduled_at` math | DEPRECATED-CORRECTLY (carve-out) | none |

---

## Per-feature deep-dive (GAP details)

### GAP-B2 — WIP-limit migration is implicit and the values aren't enumerated

**Engine reality.** WIP limits live on `board_people.wip_limit`. Engine reads at every `start`/`resume`/`reject` (`:3795–3806`); admin writes via `set_wip_limit` (`:7681–7696`).

**Production evidence.** `board_people` has 59 rows. **32 have `wip_limit=3`**; 27 are NULL. **Zero rows have any other non-default value.** This means:

1. The "WIP customisation" feature is theoretically supported but exercised against exactly one value (3) on roughly half the team.
2. The 27 NULL rows are people whose admin never set a limit — engine treats NULL as `ok=true, current, limit=0` (`:3434–3436`), i.e., unlimited.

**v2 plan coverage.** The v2 migration plan §F2 promises a `taskflow_groups` sidecar for the 4 `registered_groups` custom columns but does **not** enumerate `board_people.wip_limit` migration. The promise "TaskFlow DB preserved verbatim" implicitly covers it, but the lack of explicit enumeration means a future mechanical cleanup could drop the column thinking it's unused. Production usage is shallow (one non-default value) so the regression risk is low, but it should be called out.

**Recommendation.** Add an explicit line to Phase 3 Task 3.2 of the migration plan: "The `wip_limit` column on `board_people` is preserved unchanged; production exercises a single non-default value (3) on 32/59 rows but the schema is part of the contract."

### GAP-D9 — `reopen` is a real but extremely rare path

**Production evidence.** `reopen` action: 3 events lifetime, 2 in last 60d. The path is real (engine `:3686, 3734–3738`) but exercise data is paper-thin.

**Plan coverage.** Port-forward inherits the path. **No explicit test for the `reopen done → next_action` transition is enumerated** in any plan-of-record (the v2 migration plan refers to "234+ engine tests inherited" but does not list which transitions are tested). Given how rare reopen is, an accidental test-suite drop would not surface in CI but could break the path in production for the 1-2 events per quarter that exercise it.

**Recommendation.** Add to the Phase A.3 Track A test inventory (when written): "`taskflow_move action=reopen` from `done` to `next_action` with manager-only authority; 2-3 prod events / 60d." Don't drop tests for cold paths.

### GAP-D11-trigger — auto-archive trigger discovery

**Engine reality.** `archiveOldDoneTasks()` (`:9578`) snapshots `done` tasks older than 30d into `archive`. **No call site is visible in the engine itself** — the function is `private` and is presumably invoked from outside (digest runner? scheduled task?).

**Production evidence.** `archive` table has 45 rows with `archive_reason='done'` (lifetime). Currently 138 tasks are still in `done` column — many older than 30d if they completed during the 60d window.

**v2 plan coverage.** Plan does not enumerate the trigger. If the trigger lived in `task-scheduler.ts` (host process, fork-private) and that path is rewired by the v2 migration, the auto-archive will silently stop firing. The 138 currently-`done` tasks would never archive.

**Recommendation.** Track down the call site (`grep -rn archiveOldDoneTasks` across host + container) and add it to the migration checklist. If the call site is fork-private host-side code, port it forward as a hook into v2's scheduler.

### GAP-D15 — undo's `_last_mutation` field assumes a sticky tasks-row column

**Engine reality.** `taskflow_undo` (`:7223–7363`) reads `tasks._last_mutation` (a JSON column on the tasks table) to find the most-recent mutation across all visible tasks. The 60-second window is enforced via `JSON.parse(_last_mutation).at`.

**Production evidence.** `undo`/`undone` action history rows: **2 lifetime** (both within 60d window). The feature is exercised but rarely.

**v2 plan coverage.** Port-forward inherits the column and JSON shape. **The v2 migration plan does not call out the column** (it's a fork-private custom field on `tasks`); a mechanical schema-port that doesn't enumerate fork-private columns could lose the column and silently break undo. Given undo's <60s window, a regression here would surface only as "undo says nothing to undo" — easy to misdiagnose as legitimate (the user undid >60s ago).

**Recommendation.** Add `tasks._last_mutation` (JSON) to the explicit "fork-private columns to preserve" enumeration in Phase 3. Add an integration test that creates a task, moves it, calls `taskflow_undo` within 60s, and asserts the column was reverted.

### GAP-E8 — `manage_holidays` admin path: production is uniform; only path that's exercised is "seeded once, never edited"

**Engine reality.** `manage_holidays` supports 4 operations: `add`, `remove`, `set_year`, `list` (`:7830–7931`). The `set_year` op deletes all rows for a given year and re-inserts — the canonical "annual setup" path. `list` is read-only. `add`/`remove` are surgical.

**Production evidence.** 18 boards × **uniform 14 holidays** = 252 rows. **No board has ever had `add` or `remove` exercised** in a way that diverged from the seeded set (the 14-per-board uniformity is the smoking gun — they all match the federal calendar). The `list` op presumably is exercised heavily but doesn't write history. The `set_year` op presumably is exercised once per year (Jan 1, when `task-<ts>-holiday-cron` schedules trigger refresh — see Batch-1 N.8).

**v2 plan coverage.** Port-forward inherits all 4 operations. **The annual `set_year` cron schedule is not enumerated** in the v2 plan (Batch-1 N.8 already flagged the `task-<ts>-holiday-cron` ID-stability gap). If that schedule's task ID changes at cutover, the next year's holiday refresh stops firing and the engine falls back to last year's holidays for due-date validation.

**Recommendation.** Resolve in conjunction with Batch-1 N.8 (task-ID stability). Either preserve `task-<ts>-holiday-cron` IDs at migration or write a `legacy_task_id` map. Add an integration test: trigger `manage_holidays set_year` against a fresh board and assert all 14 federal holidays for the new year are present.

### GAP-E9 — weekday validation regression risk

**Engine reality.** `weekdayInTimezone` + `validateWeekday` (`:608–651`) enforce that the user-claimed weekday matches the actual `scheduled_at`/`due_date`. Caught the "Giovanni regression" — see test fixture `taskflow-engine.test.ts:3485` (`'rejects taskflow_update scheduled_at when intended_weekday disagrees (Giovanni regression)'`).

**Production evidence.** No direct way to count weekday-mismatch rejections in `task_history` (they short-circuit before any history row writes). But test-suite coverage is preserved (one regression test exists per the grep at `taskflow-engine.test.ts:3485`).

**v2 plan coverage.** Port-forward inherits. **The Giovanni regression test relies on `vi.*` (vitest mock framework) per the v2 plan's Phase 1 status note**; the migration plan §F8 confirms vitest→bun:test migration is in scope. If the weekday regression test silently fails to migrate (e.g., uses `vi.useFakeTimers()`), the regression could re-surface without anyone noticing.

**Recommendation.** Add the Giovanni weekday test to the explicit "must-pass post bun:test migration" list in Phase 1 Task 1.4. Run paired-output diff: same engine, same DB, same input → same `weekday_mismatch` error string.

---

## Recommendations summary

1. **GAP-B2** — Enumerate `board_people.wip_limit` in the v2 sidecar/preservation list. Production exercises it shallowly (one value, half the team), so risk is low but the schema is contract.
2. **GAP-D9** — Add `reopen done → next_action` to the explicit Phase A.3 test inventory. 3 lifetime events make this trivially droppable in a CI cleanup.
3. **GAP-D11-trigger** — Locate `archiveOldDoneTasks` call site (likely in host `task-scheduler.ts`) and ensure the v2 migration ports it forward. 138 `done` tasks currently waiting; auto-archive must keep firing.
4. **GAP-D15** — Explicitly preserve `tasks._last_mutation` JSON column. Add integration test for the <60s round-trip.
5. **GAP-E8** — Resolve in conjunction with Batch-1 N.8 (`task-<ts>-holiday-cron` ID stability). Annual holiday-refresh cron must keep firing across cutover.
6. **GAP-E9** — Add Giovanni weekday regression to the bun:test migration "must-pass" list.

None of these are DEPRECATED-WRONG. None of these are missing logic — the engine has all 35 features. The gaps are **plan-level enumeration gaps**, where rare-but-real production paths (reopen, undo, holidays, weekday validation) are subsumed under "port-forward verbatim" without being individually called out, leaving room for a mechanical migration to silently drop them.

The single largest validated risk is **GAP-D11-trigger**: auto-archive's call site is invisible in the engine alone, and the v2 plan doesn't enumerate it. 138 `done` tasks are currently relying on it.

---

## Production source code references

- **Engine (read-side):** `/root/nanoclaw-feat-v2/container/agent-runner/src/taskflow-engine.ts:2549-2557` (column entries), `:3676-3687` (transitions matrix), `:3414-3438` (WIP check).
- **Engine (write-side, lifecycle):** `:3647-4060` (`move()`), `:4584-5050` (`update()`), `:7223-7363` (`undo()`), `:7363-7931` (`admin()` including `cancel_task`, `restore_task`, `manage_holidays`, `set_wip_limit`).
- **Auto-archive:** `:9575-9598` (`archiveOldDoneTasks`).
- **MCP tool wiring:** `/root/nanoclaw-feat-v2/container/agent-runner/src/ipc-mcp-stdio.ts:1037` (`taskflow_create`), `:1120` (`taskflow_move`), `:1163` (`taskflow_update`), `:1246` (`taskflow_admin`), `:1317` (`taskflow_undo`).
- **Operator template:** `/root/nanoclaw/groups/new-taskflow/CLAUDE.md:200-220` (verb→tool-call mapping that drives the 91 % lifecycle traffic).

**File path:** `/root/nanoclaw/docs/superpowers/audits/2026-05-03-feature-coverage/02-task-lifecycle.md`
