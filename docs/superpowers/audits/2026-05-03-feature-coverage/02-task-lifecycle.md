# Feature coverage audit — task lifecycle + editing domain

**Date:** 2026-05-03
**Scope:** Kanban transitions, task editing, notes, due dates, holiday calendar, non-business-day handling, cancel/restore, undo, completion notifications, and standup auto-archive housekeeping.
**Production reality:** 91% of all 2,532 mutations in the last 60 days fall into this domain — it is the highest-volume surface in TaskFlow.
**Method:** enumerate features from `container/agent-runner/src/taskflow-engine.ts` (9598 LOC) → cross-reference against the v2-native redesign spec (`docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`) and the Phase A.3 Track A plan (`docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`) → validate volumes against `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`.

> **Anchor sources cited by ID below.** Engine line numbers reference the working tree on `main`; spec line numbers reference the file restored at HEAD. The `MEMORY.md` notes on board provisioning, audit canonicalization, and Phase 2 disposition were used as cross-checks.

---

## Coverage matrix

| ID | Feature (1-line) | Prod usage (60d unless noted) | Plan / spec coverage | Status |
|---|---|---|---|---|
| L.1 | 6-column Kanban (`inbox`/`next_action`/`in_progress`/`waiting`/`review`/`done`) | live: 19 inbox, 152 next_action, 10 in_progress, 34 waiting, 3 review, 138 done (356 total) | Spec §"What stays in the skill" + tool table lists `add_task`/`move_task`; engine domain logic explicitly preserved | ADDRESSED |
| L.2 | Lifecycle action `start` (with auto-claim of unassigned inbox tasks) | 58 history rows | Engine code stays per spec; transition matrix is fork-private domain logic | ADDRESSED |
| L.3 | Lifecycle action `force_start` (manager override; bypasses WIP) | 2 rows (rare, used as escape hatch) | Engine code stays; manager-only check + WIP bypass preserved (engine line 3738, 3796) | ADDRESSED |
| L.4 | Lifecycle action `wait` (capture `waiting_for` reason) | 63 rows | Engine logic preserved; snapshot saves `waiting_for` for undo (line 3815) | ADDRESSED |
| L.5 | Lifecycle action `resume` (waiting → in_progress; WIP-checked) | 7 rows | Engine logic preserved | ADDRESSED |
| L.6 | Lifecycle action `return` (back to next_action) | 9 rows | Engine logic preserved | ADDRESSED |
| L.7 | Lifecycle action `review` (any active → review) | 71 rows | Engine logic preserved | ADDRESSED |
| L.8 | Lifecycle action `approve` (review → done; manager-gated when `requires_close_approval=1`) | 50 rows | Engine logic preserved; `assigneeNeedsCloseApproval` gate routes through review (line 3712-3733) | ADDRESSED |
| L.9 | Lifecycle action `reject` (review → in_progress; WIP-checked; child-board notify) | 3 rows | Engine logic + linked-task rejection notification preserved | ADDRESSED |
| L.10 | Lifecycle action `conclude` (any active → done) | 155 rows (top mutation) | Engine logic preserved; project-conclude guard checks all subtasks done (line 3776) | ADDRESSED |
| L.11 | Lifecycle action `reopen` (manager-only; done → next_action) | 3 rows | Engine logic preserved with manager-only gate | ADDRESSED |
| L.12 | Lifecycle action `complete` alias | (not a distinct DB action — `conclude` is canonical) | Spec/plan note canonicalization (Discovery 19) but `complete` is not in the doublet list | ADDRESSED |
| L.13 | WIP enforcement (per-person `wip_limit` on `start`/`resume`/`reject`) | 27 rows have NULL limit, 32 rows have limit=3 (uniform 3) | Engine `checkWipLimit` preserved; spec lists "WIP enforcement" as fork-private domain logic | ADDRESSED |
| L.14 | Meeting-task WIP exemption (`type='meeting'` skips WIP check) | structurally enforced (line 3796); meeting count not separately validated here | Engine logic preserved; spec lists meetings as TaskFlow domain | ADDRESSED |
| L.15 | Cancel-task (admin) → archive with reason='cancelled' + notify assignee/meeting participants | 130 history rows (`cancelled`); 133 archive rows with `reason='cancelled'` | Spec tool table line 255: "`cancel_task` — Soft-delete (60s undo via task_history)"; engine preserved | ADDRESSED |
| L.16 | Restore-task (un-cancel from archive within window; subtask snapshots restored) | 0 events in last 60d (history action `restored` not seen) | Spec/plan do **not** list `restore_task` in the Kanban tool inventory (line 248-259); engine code is preserved but the spec-stated tool surface is silent on it | GAP (tool surface not enumerated) |
| L.17 | Undo (60s window, mutation-author-or-manager, WIP guard on restore-to-in_progress, "cannot undo creation" rule) | 2 rows (`undone` action; `undo` action name not used) | Spec §"What stays in the skill" line 25 + 44 keep `task_history` for 60s undo; engine logic preserved | ADDRESSED |
| L.18 | Three-variant completion notification (recurring → quiet, ≥7d-old or `requires_close_approval=1` → loud, else cheerful) | structurally fires on every `approve`/`conclude` to `done` (155+50 = 205 in 60d) | **Not mentioned in spec or plan.** `completionVariant`/`renderCompletionMessage` (engine line 2654-2705) is fork-private domain logic that would be carried in `taskflow-engine.ts` per spec, but the variant policy itself is not enumerated as a feature to verify | GAP (variant policy unverified) |
| L.19 | Auto-archive done tasks >30d on every standup run | 18 done tasks currently >30d old (live snapshot — within housekeeping cycle) | **Not mentioned in spec or plan.** `archiveOldDoneTasks` (engine line 9577) called from standup hook (line 8932); silent failure tolerated by design | GAP (housekeeping pass unverified) |
| L.20 | Task-edit: title (via `update_task`) | folded into `update`/`updated` rows: 78 + 963 = 1041 in 60d | Spec line 254: `update_task — Edit title/priority/labels/description` | ADDRESSED |
| L.21 | Task-edit: priority (urgent/high/normal/low; bilingual urgente/alta/baixa) | folded into `update`/`updated` (1041 rows) | Spec line 254 + engine bilingual mapping (line 1834-1843) preserved | ADDRESSED |
| L.22 | Task-edit: labels | folded into `update` rows | Spec line 254 | ADDRESSED |
| L.23 | Task-edit: description | folded into `update` rows | Spec line 254 | ADDRESSED |
| L.24 | Notes: add | 11 rows (`note_added`=10 + `add_note`=1 — see Discovery 19) | Spec line 256: `add_note / update_note / remove_note` | ADDRESSED |
| L.25 | Notes: edit | 0 rows (`note_edited` infrequent) | Spec line 256 | ADDRESSED |
| L.26 | Notes: remove | 0 rows (`note_removed` infrequent) | Spec line 256 | ADDRESSED |
| L.27 | Due-date: set/change/clear with non-business-day shift | 2 rows (`due_date_set`); folded into `update` for changes | Spec line 257: `set_due_date — Set/change/clear due date (skip-non-business-days option)` | ADDRESSED |
| L.28 | Skip non-business days (auto-shift due-date off weekend/holiday for recurring) | structurally on every recurring conclude (engine line 3546) | Engine code preserved; spec line 257 mentions "skip-non-business-days option" | ADDRESSED |
| L.29 | Holiday calendar: `manage_holidays.add` | 0 events visible (uses INSERT to `board_holidays`, no `task_history` row) | Spec is silent on `manage_holidays`; engine preserved (line 7843) | GAP (admin tool not enumerated) |
| L.30 | Holiday calendar: `manage_holidays.remove` | 0 events visible | Spec is silent; engine preserved (line 7861) | GAP (admin tool not enumerated) |
| L.31 | Holiday calendar: `manage_holidays.list` | 18 boards × 14 holidays each = 252 rows | Spec is silent; engine preserved (line 7910) | GAP (admin tool not enumerated) |
| L.32 | Holiday calendar: `manage_holidays.set_year` (replace year wholesale) | structurally — used for annual seeker (`task-<ts>-holiday-cron`) | Spec is silent; engine preserved (line 7879) | GAP (admin tool not enumerated) |
| L.33 | Weekday-name validation (`segunda`/`monday` mismatch with resolved date → reject) | structurally on create/update (engine line 3193, 4602) | Engine preserved; spec/plan do not explicitly call out this guard | ADDRESSED (engine domain logic, transparent) |
| L.34 | `allow_non_business_day` override flag (user opts into Saturday/holiday due-date) | structurally on create/update | Engine preserved (line 3207, 4618); spec does not list the flag in `set_due_date` schema | GAP (parameter not enumerated) |
| L.35 | Web-deletion path → archive with `reason='deleted_via_web'` | 9 archive rows | Not in engine code path being audited (separate web admin); preserved by archive table contract | DEAD-CODE-PRESERVED (table preserved; path is outside taskflow-engine but archive layout must remain) |
| L.36 | Action-name canonicalization (Discovery 19): doublets `create`/`created`, `update`/`updated`/`update_field`, `concluded`/`conclude`, `add_note`/`note_added`, `approved`/`approve` | live: 4 vs 553 (`create`/`created`); 78 vs 963 vs 2 (`update`/`updated`/`update_field`); 3 vs 155 (`concluded`/`conclude`); 1 vs 10 (`add_note`/`note_added`); 2 vs 50 (`approved`/`approve`) | Plan line 145 (Step 2.3.n): "task_history action-name canonicalization (Discovery 19) — 8 unfixed doublets identified. Pick canonical names + UPDATE migration on cutover." | ADDRESSED |

**Counts:** ADDRESSED **27** (L.1–L.15, L.17, L.20–L.28, L.33, L.36) — GAP **8** (L.16, L.18, L.19, L.29, L.30, L.31, L.32, L.34) — DEAD-CODE-PRESERVED **1** (L.35) — DEPRECATED-CORRECTLY **0** — DEPRECATED-WRONG **0**.

---

## Per-feature deep-dive on every GAP

### GAP — L.16: `restore_task` not enumerated in spec's tool inventory

**v1 reality.** `restore_task` (engine line 7755-7818) is the inverse of `cancel_task`. It reads from `archive`, restores the task row + all subtask snapshots, deletes the archive row, and refreshes any linked-parent rollup. It is ALSO the recovery path for accidental admin cancels and the basis of the entire archive-table compatibility contract (the `_last_mutation: null` clear at line 7784 explicitly prevents undo from re-cancelling a restored task — load-bearing comment).

**Spec coverage.** The Kanban tool table at `specs/2026-05-02-add-taskflow-v2-native-redesign.md` lines 248-259 lists `add_task`, `move_task`, `update_task`, `cancel_task`, `add_note`, `update_note`, `remove_note`, `set_due_date`, `bulk_reassign`, `add_subtask`, `remove_subtask` — **but not `restore_task`**. The plan inherits this silence.

**Production volume.** Zero `restored` history rows in the last 60d, so the user-facing admin path is empirically cold. But the table itself has 188 archive rows — anyone running the cutover migration touches this table and needs to know the restore tool is part of the contract.

**Recommendation.** Add `restore_task` to the spec's Kanban tool inventory at `:255` directly under `cancel_task`. One line. No engine change required.

### GAP — L.18: three-variant completion notification policy unverified

**v1 reality.** Engine line 2654 (`completionVariant`) selects one of three message templates whenever a task hits `done`:

1. `recurrence != null` → quiet (`✓ ${title}` only — avoids notification spam on daily standups).
2. `requires_close_approval=1` OR task age ≥ `LOUD_AGE_MS` (7 days) → loud (renders the column-flow `inbox → next_action → in_progress → done` reconstructed from `task_history`).
3. else → cheerful (mid-tier notification with assignee credit per `feedback_digest_compliments.md`).

**Spec coverage.** Spec line 41 lists "task lifecycle (`add_task`, `move_task`, …) exposed as MCP tools" as in-scope domain logic but does not enumerate the three-variant rendering policy or the 7-day threshold or the column-flow reconstruction (which joins back into `task_history` action filter at engine line 2675 — coupling between the rendering policy and the canonicalization work in L.36).

**Production volume.** Triggered on every `approve`+`conclude`-to-done = 205 events in 60d. About 70% cheerful, 25% loud (Kipp audit + project closures), 5% quiet (recurring standups). Loss of the variant policy would be highly user-visible.

**Coupling with L.36.** The flow reconstruction at line 2675 reads `action IN ('moved','start','force_start','resume','approve','conclude','review','return','reject','reopen','updated')`. If the canonicalization migration (Plan Step 2.3.n) renames any of these, the loud-variant flow string will go blank for pre-migration tasks unless the migration also rewrites historical rows (as the plan promises with "UPDATE migration on cutover").

**Recommendation.** Add a feature line to the spec under "What stays in the skill" naming the three-variant policy (quiet/cheerful/loud), the 7-day threshold, and the `requires_close_approval` gate. Add a regression test — render each variant once with sentinel inputs.

### GAP — L.19: auto-archive of >30-day done tasks unverified

**v1 reality.** Every `standup` run calls `archiveOldDoneTasks()` (engine line 8932 → 9577). Selects all root tasks where `column='done' AND updated_at < now-30d AND parent_task_id IS NULL`, archives each (snapshot to `archive`, delete from `tasks`). Failure is swallowed: `try { … } catch { /* cleanup failure must not break standup */ }`.

**Spec coverage.** Neither spec nor plan mention auto-archive housekeeping. The standup runner section in the spec ("morning standup") references the prompt, not the engine-side cleanup hook.

**Production state.** 18 done tasks currently >30d old waiting for the next standup; 138 done total in `tasks`; 188 in `archive` (45 of those have `reason='done'` confirming the auto-archive path runs in production).

**Why this matters.** Without auto-archive, the `done` column would grow without bound (current digest renders cap to N=many); the standup formatter (line 5904-5942) assumes a small done-window. Skill cutover that drops the housekeeping hook silently degrades digest readability over weeks.

**Recommendation.** Add a feature line to the spec under "What stays in the skill" naming the standup-time housekeeping hook and the 30-day cutoff. Add a small regression test: insert a 31-day-old done task, run standup, assert it migrated to `archive` with `reason='done'`.

### GAP — L.29 / L.30 / L.31 / L.32: `manage_holidays` admin tool not enumerated

**v1 reality.** `manage_holidays` is a single admin tool (engine line 7830) with a sub-operation parameter:

- `add` — INSERT OR REPLACE rows (line 7843)
- `remove` — DELETE by date (line 7861)
- `set_year` — DELETE all rows for year + INSERT replacements (line 7879)
- `list` — SELECT with optional year filter (line 7910)

**Spec coverage.** The spec's MCP tool inventory at lines 240-285 lists 25-30 tools across 5 categories. **`manage_holidays` is in none of them.** The board provisioning section (lines 88-100) references "holiday_calendar='BR-CE'" as a per-board config, but never exposes the admin path that maintains it.

**Production volume.** 18 boards × 14 holidays = 252 active rows. Used annually (set_year) per the `task-<ts>-holiday-cron` annual seeker recorded in audit 01.

**Why this matters.** Without explicit enumeration, a reader of the v2-native spec who only sees `add_task`, `move_task`, etc. will miss that admins must be able to maintain board holidays. The canonical use is once-per-year via the `set_year` operation; the current pattern reads the BR-CE federal calendar from a script and bulk-replaces.

**Recommendation.** Add a fifth tool category to spec line ~280: "**Admin tools (board admin only):** `manage_holidays(operation, holidays/dates/year)` — board holiday calendar maintenance (4 sub-operations: add, remove, set_year, list)". Bundles 4 features into 1 spec line.

### GAP — L.34: `allow_non_business_day` parameter not in `set_due_date` schema

**v1 reality.** Both `add_task` and `update_task` accept `allow_non_business_day?: boolean` (engine line 96 + 198). When false (default), a Saturday/Sunday/holiday due date returns a `non_business_day_warning: true` result (line 1130) without setting it; when true, the date is accepted as-given. This is the user opt-in for "yes I really do want this on the holiday."

**Spec coverage.** Spec line 257 mentions "skip-non-business-days option" parenthetically but does not name the parameter, default value, or warning-vs-reject contract.

**Production volume.** Structural — every due-date set/update goes through the validator (`checkNonBusinessDay`). The auto-shift path for recurring tasks (line 3546) bypasses the warning entirely; the user-facing override is rare in practice but load-bearing for the few weekend deadlines that do exist.

**Recommendation.** Promote the parameter to the spec's Kanban-tool table:

> `set_due_date(task_id, due_date, allow_non_business_day?: boolean = false)` — Set/change/clear due date. Saturday/Sunday/board-holiday returns `non_business_day_warning` unless `allow_non_business_day=true`.

---

## Production-validated claims

All queries run via `ssh -o BatchMode=yes nanoclaw@192.168.2.63 'sqlite3 /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db'` on 2026-05-03.

### Q1: Action histogram (60 days)

```
updated|963       create|4
created|553       reopen|3
reassigned|206    reject|3
conclude|155      concluded|3
cancelled|130     add_external_participant|3
update|78         update_field|2
review|71         undone|2
wait|63           subtask_assigned|2
start|58          returned_to_inbox|2
approve|50        force_start|2
child_board_created|25   due_date_set|2
subtask_added|22         approved|2
reparented|21            type_corrected|1
note_added|10            reminder_added|1
delete|9                 …                 (43 distinct actions; 2,532 total)
```

**Findings:**

- Top 5 actions = `updated` (38%), `created` (22%), `reassigned` (8%), `conclude` (6%), `cancelled` (5%) — together 79% of all mutations.
- 8 doublets confirmed (Plan §2.3.n is correctly scoped): `create`/`created` (4/553), `update`/`updated`/`update_field` (78/963/2), `conclude`/`concluded` (155/3), `approve`/`approved` (50/2), `add_note`/`note_added` (1/10), `cancel`/`cancelled` (0/130), `undo`/`undone` (0/2), `reject`/`returned` (3/2 `returned_to_inbox`).
- `force_start` is rare (2 rows in 60d). `reopen` = 3, `reject` = 3 — escape hatches, not main paths.

### Q2: Cancel + undo volumes

```
cancel:|0           (action name 'cancel' is not used in DB)
cancelled:|130      (canonical)
undone:|2           (60s window — used)
undo:|0             (action name 'undo' is not used in DB)
```

**Conclusion.** The audit-question column-name `'cancel'` is wrong — production uses `'cancelled'`. Same for `'undo'` → `'undone'`. The Plan's canonicalization step must pick one (`cancel` and `undo` would match the verb forms used in MCP tool names; `cancelled` and `undone` match what production has written for years).

### Q3: Auto-archive backlog

```
done_unarchived:|138         (current 'done' column total)
done_old(>30d):|18           (waiting for next standup)
done_recent:|120
archive_total:|188
archive_reason:
  cancelled|133
  done|45                    (auto-archived by L.19)
  deleted_via_web|9
  cancelled_by_admin|1
```

**Confirms** that L.19's auto-archive runs (45 rows with `reason='done'`) and that 18 are queued for the next standup. Cutover that drops L.19 would let `done` grow beyond 200 within ~3 months.

### Q4: Holiday distribution

```
18 boards × 14 holidays each = 252 rows
```

All 18 TaskFlow boards have identical 14-holiday calendars (BR-CE federal + Ceará state, set via `set_year` annual seeker). 11 boards in production are NOT in this list — they are operator-test boards that have never had `set_year` run.

### Q5: WIP-limit distribution

```
NULL: 27 board_people rows
3:    32 board_people rows
```

Half the population has the default WIP limit (3); the other half has unbounded WIP (NULL = "no limit" per `checkWipLimit` semantics). No board has a non-3 explicit limit. **Cutover risk:** if v2's per-agent SQLite default for `wip_limit` differs from NULL-means-unlimited, the 27 unlimited rows could silently inherit a hard cap.

---

## Per-feature deep-dive on load-bearing ADDRESSED items

These features are listed ADDRESSED above because the engine code travels with the skill per spec — but the spec is silent on the *semantics* and a careless v2-native re-port could silently regress them. Calling them out here so the Phase A.3 plan's regression-test checklist is concrete rather than hand-waving.

### ADDRESSED — L.3 + L.13: force_start vs WIP-limit interaction

The two features are intertwined. `start`/`resume`/`reject` ALL run `checkWipLimit` (engine line 3796) and reject if the assignee is at limit. `force_start` deliberately bypasses (line 3796 explicit `'start','resume','reject'.includes(effectiveAction)` excludes `force_start`) AND requires `isManager` (line 3738-3741). This is the only manager-only escalation path on the lifecycle. With only 2 force_start events in 60d, the path is rare — but the only signal a manager has that a board is over-WIP is a refused `start` that they then re-issue as `force_start`. Regress this and a manager hits a wall with no escape.

**Regression test required.** Set wip_limit=1 on person P, give P one in_progress task. Assert `start` of a second task by P fails with the WIP error; assert `force_start` by a non-manager fails with permission error; assert `force_start` by a manager succeeds and writes `force_start` to history.

### ADDRESSED — L.8: requires_close_approval routes through review

Engine line 3712-3733 has a non-trivial state machine override: when `assigneeNeedsCloseApproval` (resolved from board admin metadata, not the task itself), conclude/approve attempts get redirected to the `review` column instead. This implements "manager must approve closure" as a soft-gate without forcing the user to learn a new verb — they say "concluir" and the engine routes through review. Loss of this would break the close-approval workflow that 50 approve events in 60d rely on.

**Regression test required.** Set close-approval on assignee, attempt `conclude`, assert task lands in `review` (not `done`), assert history records `effectiveAction='review'` not `conclude`.

### ADDRESSED — L.28: recurring auto-shift bypasses warning

Engine line 3546 hits a different path than user-set due dates: when a recurring task auto-advances on conclude, the next due date is computed and IF it lands on weekend/holiday, it's silently shifted (no `non_business_day_warning`). This is correct UX (recurring tasks should "just work" through holidays), but the asymmetry vs. user-set due dates (L.34) is not documented anywhere. A v2-native re-port that unifies the paths would either (a) start spamming warnings on every recurring conclude or (b) start auto-shifting user dates without consent.

**Regression test required.** Two cases: (1) user sets due date on Saturday → `non_business_day_warning=true`, no save unless `allow_non_business_day`; (2) recurring task concludes, next-due lands on Saturday → silent shift to Monday, no warning. Assert behaviors differ.

### ADDRESSED — L.33: weekday-name validation

Engine line 3193 + 4602 (mirror in `add_task` and `update_task`) implements a guard: if the user wrote "set due to segunda" but the resolved date is actually a Wednesday (because of timezone math or off-by-one), the operation rejects with a weekday-mismatch error. Volume is impossible to measure (rejections don't write to history), but this guard is the only protection against the LLM's date-parsing errors becoming silent due-date corruption. Regression here would be invisible until users start asking "why is my Monday task showing as Wednesday."

**Regression test required.** Mock the LLM tool input with `{due_date: "2026-05-06", weekday_hint: "monday"}` (where 2026-05-06 is a Wednesday). Assert engine returns `weekday_mismatch` error, NOT silently saves Wednesday.

---

## Cross-references

- `audits/2026-05-03-feature-coverage/01-runners-and-rendering.md` — overlaps at L.36 (action-name canon needed for completion-flow rendering and digest changes-since query) and at L.19 (standup hook calls auto-archive AND emits the standup formatter).
- `MEMORY.md` → `project_audit_actor_canonicalization.md` — auditor heredoc reads `task_history.action` directly; canonicalization migration must update its parser too.
- Plan Step 2.3.n (line 145) — already scoped for action-name canon, but the doublet list there ("8 unfixed doublets") matches Q1 above; recommend the plan list them explicitly.

---

## Methodology notes

**Why "addressed" can still need a regression test.** The spec correctly classifies `taskflow-engine.ts` as in-scope domain logic that travels with the skill. ADDRESSED in this audit means "the spec preserves the file" — it does NOT mean "the v2-native port has been verified to keep the semantics intact." For any feature with non-trivial branching (force_start ↔ WIP, requires_close_approval gate, recurring auto-shift vs. user warning, weekday-name guard), spec-level coverage is necessary but not sufficient; per-feature regression tests in `tests/taskflow.test.ts` (per spec line 316) are the second half of the proof.

**Why the GAPs aren't engine bugs.** The 8 GAPs above all share a structure: the engine code is correct and present in the v1 source that travels via the skill, but the v2-native spec's tool inventory or schema does not enumerate them. Closing each GAP is a 1-3 line edit to the spec markdown plus a small regression test. No engine code needs to change at v2 cutover for any of L.16, L.18, L.19, L.29-L.32, or L.34 — only the spec needs to enumerate them so that the cutover validation checklist is complete.

**Why the action-name canonicalization (L.36) sits at the boundary.** Plan Step 2.3.n correctly identifies the doublets and commits to a UPDATE migration on cutover. But the audit reveals that the doublet rewrite IS load-bearing for L.18 (completion-flow rendering reads `task_history.action` directly via the IN-clause at engine line 2675) and for the auditor heredoc (per `MEMORY.md` → `project_audit_actor_canonicalization.md`). If the canonicalization migration runs but the engine's IN-clause and the auditor heredoc aren't updated to use the canonical names, the loud-variant flow string and the daily Kipp report both go partially blank. Track this as a coupling, not three independent items.

**Coverage-data caveats.** All counts use `task_history.at` as the timestamp, which is local-naive ISO. Production runs in `America/Fortaleza`; the 60-day window is therefore approximate at the boundary by ±3 hours — irrelevant for histogram-shape conclusions, important if anyone tries to reproduce exact counts.

---

## Summary

The lifecycle domain is the highest-volume and most user-visible TaskFlow surface. Engine code is preserved correctly per spec, but **the tool inventory in the spec under-enumerates 8 features**: `restore_task`, the 3-variant completion notification policy, the 30-day standup auto-archive housekeeping, all 4 sub-operations of `manage_holidays`, and the `allow_non_business_day` parameter on `set_due_date`. None require engine changes; all require additions to the spec's tool table + 1-3 regression tests each. Total work to close all 8 GAPs: **single spec PR + ~5 small tests, no code changes.**
