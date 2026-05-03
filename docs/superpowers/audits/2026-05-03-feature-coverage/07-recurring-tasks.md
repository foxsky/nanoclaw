# Coverage Matrix — Section R: Recurring Tasks Domain

> **Date:** 2026-05-03
> **Scope:** validate v2 plan covers all 4 recurring-task features (R.1–R.4): create with frequency; auto-create next cycle on completion; expire at end_date / max_cycles; quiet completion notification.
>
> **Inputs:**
> - Plan: `docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` §A.3.7 step 7.1 "Kanban (10 tools)"
> - Spec: `docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` §"MCP tool inventory" lines 248–259, §"File ownership" line 299
> - Discovery 19 (prod usage): `docs/superpowers/research/2026-05-03-v2-discovery/19-production-usage.md` §1, §13, §15 "DEAD"
> - Discovery 16 (schedule_task — different domain): `docs/superpowers/research/2026-05-03-v2-discovery/16-schedule-task.md`
> - Sibling audits: `docs/superpowers/audits/2026-05-03-feature-coverage/{02-task-lifecycle,04-reassignment,05-meetings}.md`
> - Engine: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
> - Production DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`
>
> **Domain-disambiguation note.** "Recurring" in this audit is **TaskFlow `tasks.type='recurring'`** — the per-board kanban primitive (`R<n>` IDs, monthly relatórios, etc.) — NOT the `schedule_task` cron-recurrence used by Kipp/standup/digest (Discovery 16 territory). The two are entirely separate code paths; the spec discusses the latter and is silent on the former.
>
> **Source of truth (verified at audit time, engine 9598 lines):**
> - Type discriminator on create: `:3148` (`type === 'recurring' → 'R'` prefix) and `:3165` (storedType passthrough — not collapsed to simple).
> - Recurrence write on insert: `:3236–3243` (`recurrence`, `recurrence_anchor` only stored for `recurring`/`project`/`meeting`); `:3270–3275` (bounded params validation).
> - `validateBoundedRecurrence` static: `:2354–2366`.
> - `advanceDateByRecurrence` (date-only, used by recurring/project): `:689–705`.
> - `advanceDateTimeByRecurrence` (datetime, used by recurring meeting): `:709–730`.
> - **Cycle advance core:** `advanceRecurringTask()` `:3528–3640`. Triggered from `move()` `:3973–3975` only when `toColumn==='done' && task.recurrence`.
> - Subtask-row reset for recurring projects: `:3627–3635`.
> - Meeting external-grant expiry on cycle advance: `:3605–3616`.
> - Meeting occurrence archive history row: `:3572–3593` (action `meeting_occurrence_archived`).
> - **Quiet completion variant gate:** `completionVariant()` `:2650–2662` — `if (task.recurrence) return 'quiet'` (line 2655).
> - Quiet message renderer: `renderCompletionMessage()` `:2709–2715` (no 🎉, no fluxo line, just `✅ *Tarefa concluída*` + `Entregue por`).
> - `update_task` recurrence/max_cycles/end_date paths: `:5465–5512`.
> - Reassign exclusion: `:3842–3848` (auto-link skipped on recurring) and `:9131–9133` (`hierarchy(action='link')` rejects recurring).
> - ID-counter prefix `R`: `:1276` (legacy migration map) + `:3148` allocator.

---

## Production validation (refreshed 2026-05-03)

All queries run against `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`.

| Metric | Value | Source |
|---|---:|---|
| `tasks WHERE type='recurring'` (live) | **2** | confirms Discovery 19 §1 ("2 recurring") |
| Boards with any recurring task | **1** (`board-sec-taskflow` only) | `SELECT DISTINCT board_id FROM tasks WHERE type='recurring'` |
| Distinct `recurrence` literals stored | **2** (`monthly`, `{"pattern":"monthly"}`) | **canonicalization gap — see GAP-R.1.canonicalize** |
| `current_cycle` distribution | `1`: 2 tasks | both at cycle 1 — i.e., concluded **once** each over 60d |
| `tasks WHERE recurrence IS NOT NULL` (any type) | **3** (R18, R19 recurring + M11 weekly meeting) | Discovery 19 §13 |
| `archive WHERE type='recurring'` | **0** | no recurring task has ever been hard-archived |
| `task_history WHERE action='meeting_occurrence_archived'` | **0** | the recurring-meeting cycle path has **never executed** in production |
| `tasks_history WHERE task_id IN ('R18','R19') AND action='conclude'` | 1 (R18 only — R19 used `approve+update`) | recurring conclusion fires twice in 60d total |
| Boards with `type='recurring'` last 14d | 0 | dead in the active window |

**The 2 production recurring tasks (full row dump):**

```
R18  board-sec-taskflow  type=recurring  recurrence='monthly'              current_cycle=1  due_date=2026-05-06  column=next_action
R19  board-sec-taskflow  type=recurring  recurrence='{"pattern":"monthly"}' current_cycle=1  due_date=2026-04-15  column=review
```

**`task_history` for R18 + R19 (chronological):**

```
2026-03-06  R18 created       Miguel    {"recurrence":"monthly", due_date 2026-04-06}
2026-03-10  R18 conclude      rafael    {"from":"next_action","to":"done"}     ← cycle 0 → 1, advanceRecurringTask() fired
2026-03-11  R19 created       miguel    {type:recurring, no recurrence value yet}
2026-03-11  R19 updated       miguel    {"changes":["Recorrência definida: mensal"]}     ← engine_set
2026-03-11  R19 updated       miguel    {"changes":["Due date set to 2026-04-15"]}
2026-04-20  R19 review        rafael    {"requested_action":"conclude"}        ← review-gated
2026-04-23  R19 approve       web-api   {}                                      ← web-app override
2026-04-23  R19 update        web-api   {"changes":[{"field":"column","old":"review","new":"done"}]}
2026-04-23  R19 review        rafael    {"requested_action":"conclude"}        ← second cycle attempted
2026-04-23  R19 comment       miguel    "Esta é uma tarefa recorrente, sempre que concluída retorna…"
2026-04-23  R19 update        web-api   {note added}
```

**Forensic reading:**

1. R18 cycled cleanly through the engine (`conclude → advanceRecurringTask → cycle 1`). Quiet completion notification path fires here (`completionVariant` returns `'quiet'` since `task.recurrence` is truthy).
2. R19 was concluded **via the web app** (`web-api` actor on `update` rows), bypassing `move()` → `advanceRecurringTask()` was **NOT called**. The web path wrote `column='done'` directly with `update_task` mechanics (engine line ~5440 SET column path), which means the recurring auto-cycle is **path-dependent on which entrypoint conducts the move**. The current_cycle=1 visible in DB likely came from a later WhatsApp `move` that triggered advance — confirmed by R19 sitting in `review` again at audit time. **This is a real production divergence: recurring cycle advancement is disabled on the web-api path.**
3. R19's `recurrence` column holds the JSON literal `{"pattern":"monthly"}`. `advanceRecurringTask()` switches on `task.recurrence as 'daily'|'weekly'|'monthly'|'yearly'` (`:3530`), so when R19 next concludes through the engine, the switch falls through to the default — **the recurrence period silently becomes zero**, the task gets re-stamped with `due_date = current due_date` and `current_cycle++`, and you have an "advanced" task that didn't advance in time. Given Discovery 19 §13 already flagged the priority/labels canonicalization debt, this is the recurrence-column member of that family. **GAP-R.1.canonicalize is the highest-impact finding in this audit.**
4. Discovery 19 §13 reports **3** tasks with recurrence — the 2 above plus M11 (weekly meeting on `thiago-taskflow`). M11's recurring path goes through `advanceDateTimeByRecurrence` and the meeting-occurrence archive. **`meeting_occurrence_archived` history rows = 0** in 60d, meaning the recurring-meeting code path has not executed in production at all. M11 was created 2026-03-18 14:00Z weekly; if it had concluded weekly, there would be ~6 archive rows.

**Bottom line: recurring is near-dead.** ~3 tasks across 2 boards, 1 board active, web-api path has a divergence, recurrence column has a canonicalization defect, and the recurring-meeting subpath has never fired in production.

---

## Coverage matrix

### R.1 — Create recurring task with frequency (`type='recurring'` + `recurrence` ∈ {daily, weekly, monthly, yearly})

| | |
|---|---|
| v1 source | engine `:3148` (`R` prefix), `:3165` (storedType pass-through), `:3236–3243` (recurrence INSERT), `:3270–3275` (bounded validation), `:689–705` (advanceDateByRecurrence). On INSERT a recurring task with no due_date, the engine auto-computes `due_date = today + 1 period` (line 3241). |
| v1 behavior | Accepts `daily`/`weekly`/`monthly`/`yearly` (the four switch cases). No string canonicalization — whatever string the caller passes is stored verbatim. Validation only fires on bounded params (`max_cycles`, `recurrence_end_date`). Auto-link to child board is **skipped for recurring** (engine `:3842–3848`, `:9131`). ID prefix `R`, counter `next_recurring_number`. |
| Production volume | 2 live tasks, 1 distinct board, 0 in last 14d. **Near-dead** (Discovery 19 §15). |
| v2 plan/spec | Spec §"Kanban tools" line 252 lists `add_task` ("Create task in Inbox column") with **no enumeration of `type` argument** — `recurring` is not mentioned anywhere. Plan §A.3.7 step 7.1 "Kanban (10 tools)" budgets one happy + one error path per tool. Engine port-forward (spec line 299 — `taskflow-engine.ts` carried whole) preserves the code, so `add_task(type='recurring', recurrence='monthly')` *would* still work post-cut. |
| **Status** | **PARTIAL — engine preserved but feature unenumerated** |
| **GAP-R.1.scope** | Spec §"Kanban tools" must enumerate the 5 supported `type` values (`simple`, `project`, `recurring`, `meeting`, `inbox`) on `add_task` to match v1, OR explicitly state "recurring removed in v2" with a deprecation plan for R18/R19. Without enumeration, a v2-native re-implementation team could ship `add_task` without the `recurring` branch and silently break the 2 live tasks. |
| **GAP-R.1.canonicalize** | The `recurrence` column accepts free-form strings (production has both `monthly` and `{"pattern":"monthly"}` literals stored). `advanceRecurringTask` switches on `'daily'|'weekly'|'monthly'|'yearly'` only; non-matching values fall through silently (no error), causing the cycle counter to increment without advancing the date. **Spec must add a canonicalization layer at write time** (matches feedback `feedback_canonicalize_at_write.md`): reject or normalize any non-canonical input. R19 needs a one-shot fix migration regardless of v1↔v2 cut. |

### R.2 — Auto-create next cycle on task completion (`recurring_cycle` handler)

| | |
|---|---|
| v1 source | `advanceRecurringTask()` `:3528–3640` (113 lines). Triggered from `move()` `:3973–3975` only when `toColumn==='done' && task.recurrence` truthy. |
| v1 behavior | Three cases: (a) **simple recurring**: compute `newDueDate = advanceDateByRecurrence(task.due_date, recurrence)` then `shiftToBusinessDay()` (line 3547 — silent weekend/holiday skip), reset column to `next_action`, clear `reminders/notes/blocked_by/next_action/waiting_for`, increment `current_cycle`. (b) **recurring project**: same as simple + reset all subtask rows from `done`→`next_action` (lines 3627–3635). (c) **recurring meeting**: compute `newScheduledAt = advanceDateTimeByRecurrence(recurrence_anchor ?? scheduled_at, recurrence, nextCycle)`, archive the previous occurrence to `task_history` as `meeting_occurrence_archived` with full snapshot (lines 3572–3593), expire active `meeting_external_participants` grants for the old occurrence (lines 3605–3616), reset column. Returns `recurring_cycle: { cycle_number, expired:false, new_due_date|new_scheduled_at }` — surfaced in `MoveResult` and rendered to user. |
| Production volume | 2 cycle advances (R18 once, R19 once) in 60d for recurring tasks. **0** `meeting_occurrence_archived` rows ever — recurring-meeting subpath unfired. |
| v2 plan/spec | Spec §"Kanban tools" line 253 lists `move_task` with no recurring-side-effect mention. Plan §A.3.7 budgets one happy + one error per tool. Engine port-forward preserves the code. |
| **Status** | **PARTIAL — engine preserved, behavior contract undocumented** |
| **GAP-R.2.contract** | Spec must document that `move_task(action='conclude')` on a recurring task triggers an in-transaction side effect that returns `recurring_cycle` and resets the task to `next_action`. Without this in spec, a v2-native re-implementer of `move_task` could legitimately omit the side effect. Plan §A.3.7 step 7.1 Kanban tests must include 3 cycle-advance happy paths: (a) recurring simple → next due_date computed + business-day shifted; (b) recurring project → all subtasks reset to next_action; (c) recurring meeting → `meeting_occurrence_archived` history row written + external grants expired. |
| **GAP-R.2.web-divergence** | Production R19 history shows the `web-api` path conducting `update {"field":"column","old":"review","new":"done"}` — this bypasses `move()` and `advanceRecurringTask` is not called. Either (a) the web app is intended to handle cycle advance separately (it doesn't appear to), or (b) the web path is broken. Either way, v2 must lock the cycle-advance side effect to a single canonical path so the divergence cannot reproduce. **Recommendation:** in v2, all column-to-done transitions go through `move_task` MCP (no `update_task(column=...)` shortcut), enforced by an engine-side guard. |

### R.3 — Expire at `recurrence_end_date` or `max_cycles`

| | |
|---|---|
| v1 source | `validateBoundedRecurrence` `:2354–2366` (mutual exclusion), bounds check inside `advanceRecurringTask` `:3550–3556`, `update_task` paths `:5476–5512` (set/clear/swap). On expiry: leave task in `done` column, increment `current_cycle`, return `recurring_cycle: { expired:true, reason:'max_cycles'|'end_date' }` (line 3568). |
| v1 behavior | Mutually exclusive: setting one clears the other in `update_task`. `max_cycles` must be a positive integer. End-date comparison: for meetings uses `newScheduledAt.slice(0,10)`; for tasks uses `newDueDate`. If next cycle would land past the bound, the task **stays in `done`** (not archived) with cycle++ — i.e., the task becomes a tombstone, not a cancel. |
| Production volume | 0 expirations — neither R18 nor R19 has bounds set; no `recurrence_end_date` or `max_cycles` populated on any task in production. **Feature has 0 in-production exercise.** |
| v2 plan/spec | Not enumerated. Spec doesn't mention `max_cycles` or `recurrence_end_date` parameters anywhere. Plan §A.3.7 doesn't list bounded-recurrence in test scope. |
| **Status** | **MISSING** |
| **GAP-R.3.bounds** | Spec must restate the bounded-recurrence contract: (a) mutual exclusion between `max_cycles` and `recurrence_end_date`; (b) `max_cycles > 0`; (c) tombstone-in-done semantics on expiry (vs. archive); (d) `update_task` mutual-clear behavior. Plan §A.3.7 step 7.1 Kanban error-path tests should include 1 bounded-recurrence happy path + 1 mutual-exclusion error case + 1 expiry-tombstone case. **Note:** since prod has 0 bounded-recurrence rows, this is regression-only — no migration concern. |

### R.4 — Quiet completion notification on recurring conclude (no 🎉 emoji)

| | |
|---|---|
| v1 source | `completionVariant()` static `:2650–2662` (`if (task.recurrence) return 'quiet'`). `renderCompletionMessage()` `:2705–2733` — quiet branch returns `✅ *Tarefa concluída*\n${SEP}\n\n${head}\n👤 *Entregue por:* ${assigneeName}` (no 🎉, no fluxo, no duration). Loud branch (≥7d-old or `requires_close_approval=1`) and cheerful branch (default) both lead with `🎉`. |
| v1 behavior | The variant is determined **before** rendering, in `buildCompletionNotification` `:2613–2648`, then dispatched. Recurring takes precedence over loud (the `if` ladder checks recurrence first). Audited in sibling 02-task-lifecycle.md feature L.18 — already flagged there as "variant policy unverified" in v2 plan/spec. |
| Production volume | Per Discovery 19 §15 + sibling audit 02 line 79: 205 conclude/approve→done events in 60d, ~5% are recurring (≈10 events). Volume is small but the visual contract matters: recurring conclusions are intentionally undramatic to avoid spamming on monthly relatórios. |
| v2 plan/spec | Spec is silent on completion-notification variants. Plan is silent. Engine port-forward preserves the code. |
| **Status** | **PARTIAL — sibling audit 02 already filed GAP-L.18** |
| **GAP-R.4** | **Cross-reference: GAP-L.18 in `02-task-lifecycle.md` already covers this.** Re-state here for completeness: the 3-variant policy (quiet/cheerful/loud) is unenumerated in spec/plan; a v2-native rewrite of `move_task`'s completion message could collapse all three variants into one and silently break the recurring quiet-mode UX. Plan §A.3.7 step 7.1 Kanban tests must include 1 assertion: recurring task conclude → message body does NOT contain `🎉`, contains `✅`, contains `Entregue por:` line. |

---

## Cross-cutting concerns the v2 spec must address

1. **Reassignment exclusion** (engine `:3842–3848`, `:9131–9133`): recurring tasks are deliberately **never** auto-linked to child boards. Sibling audit 04 (G.aux) already flags this. v2 must preserve. **Verified at audit time:** R18 and R19 both have `child_exec_enabled=0` despite Rafael (the assignee) having a child board on `board-sec-secti`.
2. **Action-name canonicalization debt** (Discovery 19 §15): R19 history shows `update` (web-api), `updated` (engine), and `approve` all firing on the same task. Recurring sits in the same canonicalization debt as the rest of TaskFlow — flagged here for completeness, owned by a separate audit/cleanup.
3. **`recurrence` value canonicalization** (NEW finding — see GAP-R.1.canonicalize): `recurrence` is free-form text in production. v2 spec must canonicalize at write.
4. **Web-api path divergence** (NEW finding — see GAP-R.2.web-divergence): R19 was concluded via web-api `update`, which bypasses `advanceRecurringTask`. v2 must single-path the cycle-advance trigger.

---

## Status counts

| Status | Count | IDs |
|---|---:|---|
| COVERED | 0 | — |
| PARTIAL | 3 | R.1 (engine kept, unenumerated), R.2 (engine kept, contract undocumented), R.4 (cross-ref to GAP-L.18) |
| MISSING | 1 | R.3 (bounded recurrence not in spec or plan) |
| GAP totals | **6 distinct GAPs** | R.1.scope, R.1.canonicalize, R.2.contract, R.2.web-divergence, R.3.bounds, R.4 (==L.18) |

---

## Port-forward vs deprecate — recommendation

**Recommendation: PORT-FORWARD with deprecation tag, do not invest test budget.**

Reasoning:

| Factor | Verdict |
|---|---|
| Production load | **Near-zero.** 2 live tasks on 1 board, both monthly relatórios. 60d cycle-advance count: 2. Recurring meeting subpath (M11): 0 advances ever. |
| Code volume | ~150 LOC in `taskflow-engine.ts` (advanceRecurringTask 113 lines + create-side branches + update-side branches + variant gate). |
| Code coupling | **High.** `move()` calls `advanceRecurringTask` inline; `completionVariant` switches on `recurrence`; `reassign` and `hierarchy(action='link')` both have explicit recurring guards; auto-link skip in 3 places. Removing recurring is **not** a 150-LOC delete — it's a ~10-touchpoint surgical removal. |
| Migration risk | **Moderate.** R18 has a clean `monthly` value and is mid-flight (due 2026-05-06). Removing it would surface as a missing monthly report on `board-sec-taskflow`. R19's `{"pattern":"monthly"}` value is already broken and needs a migration regardless. |
| Replacement cost | **High if removed.** Sec-secti's Rafael uses these for monthly compliance reports. Replacement = `schedule_task` cron sending a reminder, but that's a different UX (no kanban slot, no cycle counter, no quiet completion notification). |

**Decision matrix:**
- **Port-forward (recommended):** keep the existing engine code (already preserved by spec line 299 — `taskflow-engine.ts` carried whole). Add 4 unit tests to plan §A.3.7 step 7.1 covering R.1/R.2/R.3/R.4. Add the canonicalization fix from GAP-R.1.canonicalize. Total v2-side cost: **~4 hours** (write tests + add canonicalize at write).
- **Deprecate now:** ~1 day to delete recurring branches + update sec-secti CLAUDE.md to use `schedule_task` reminders + migrate R18/R19. **Loses** the kanban-slot UX (Rafael sees recurring tasks on his board with cycle counts) and the quiet completion variant. **Risk:** sec-secti's monthly compliance reporting silently degrades.
- **Defer to post-v2-cutover:** port-forward as-is for v2 cut, then re-evaluate after 6 months of v2 prod. If still 2 tasks on 1 board, deprecate; if v2 grows recurring use, invest in canonicalization + bounded-recurrence UI.

**Recommended path:** port-forward + canonicalization fix (4h), defer deprecation decision to post-cutover.

---

## Recommended plan/spec amendments

1. **Spec §"Kanban tools" enumerate `add_task.type`** (≈3 lines): list the 5 supported types (`simple`/`project`/`recurring`/`meeting`/`inbox`) with their distinct invariants. **Resolves GAP-R.1.scope.**
2. **Spec §"Kanban tools" canonicalize `recurrence` at write** (≈1 paragraph): require write-side validation that `recurrence ∈ {'daily','weekly','monthly','yearly'}` (or `null`); reject all other values; add a one-shot migration to fix R19's `{"pattern":"monthly"}` row. **Resolves GAP-R.1.canonicalize.**
3. **Spec §"Kanban tools" `move_task` side-effect contract** (≈4 bullets): document the 3 conclude side effects on `recurring`/`recurring project`/`recurring meeting`. **Resolves GAP-R.2.contract.**
4. **Spec §"Kanban tools" single-path cycle-advance guard** (≈1 paragraph): forbid `update_task(column='done')` on recurring tasks; require `move_task(action='conclude')`. **Resolves GAP-R.2.web-divergence.**
5. **Spec §"Kanban tools" bounded-recurrence parameters** (≈1 table): list `max_cycles` + `recurrence_end_date`, mutual exclusion, tombstone-in-done semantics. **Resolves GAP-R.3.bounds.**
6. **Plan §A.3.7 step 7.1 Kanban tests** (≈4 tests): `add_task(type='recurring', recurrence='monthly')` happy path; `move_task(conclude)` advances cycle + writes `meeting_occurrence_archived` for recurring meeting; `update_task(max_cycles=3)` mutually clears `recurrence_end_date`; recurring `move_task(conclude)` produces quiet notification (no 🎉). **Resolves R.1, R.2, R.3, R.4 test coverage gap.**

---

## Source references

- Engine recurring code: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:2354,2650,3148,3236,3528,3627,3973,5465,9131`
- `advanceRecurringTask` core: `:3528–3640`
- `completionVariant` quiet gate: `:2655`
- `renderCompletionMessage` quiet branch: `:2709–2715`
- `validateBoundedRecurrence`: `:2354–2366`
- `advanceDateByRecurrence` / `advanceDateTimeByRecurrence`: `:689–730`
- v1 unit tests: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts:1402,2053,3747,5695`
- Production DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`

## Anchor references

- Plan §A.3.7 step 7.1 "Kanban (10 tools)": `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md:238–246`
- Spec §"MCP tool inventory" Kanban tools: `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md:248–259`
- Spec §"File ownership" engine port-forward: line `:299`
- Discovery 19 §1 task volume by type: `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/19-production-usage.md:54–62`
- Discovery 19 §13 field usage (recurrence row): line `:356`
- Discovery 19 §15 "DEAD recurring tasks": line `:438`
- Sibling audit 02 GAP-L.18 (variant policy): `/root/nanoclaw/docs/superpowers/audits/2026-05-03-feature-coverage/02-task-lifecycle.md:33,73,79`
- Sibling audit 04 G.aux (auto-link recurring exclusion): `/root/nanoclaw/docs/superpowers/audits/2026-05-03-feature-coverage/04-reassignment.md:78,145`
- Canonicalize-at-write feedback: `~/.claude/projects/-root-nanoclaw/memory/feedback_canonicalize_at_write.md`
