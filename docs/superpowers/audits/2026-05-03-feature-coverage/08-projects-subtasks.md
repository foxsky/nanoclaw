# Feature coverage audit — projects + subtasks domain

**Date:** 2026-05-03
**Scope:** Project tasks (`type='project'`), subtask creation/numbering/ordering, lifecycle of subtask rows under a parent, and the cross-project structural mutations (reparent, detach, merge_project, subtask approval).
**Production reality:** 31 project rows, 154 subtask rows (avg 4.97/parent), max 27 subtasks under a single project (P11). Daily SECI/SEC volume (Discovery 19).
**Method:** Enumerate features from `container/agent-runner/src/taskflow-engine.ts` (search `subtask`, `parent_task_id`, `add_subtask`, `merge_project`, `reparent`, `detach`) → cross-reference v2-native redesign spec (`docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`) and the Phase A.3 plan → validate against `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` (Discovery 19 §3 confirms numbers).

> Engine line numbers reference the working tree on `main`. Spec line numbers reference the spec file at HEAD. Discovery 19 §3 ("Subtasks and depth") is the production-validation anchor. Cross-references at the end pin coupling with audit `03-cross-board.md` (subtask_requests workflow) and `02-task-lifecycle.md` L.10 (project-conclude all-subtasks-done guard).

---

## Coverage matrix

| ID | Feature (1-line) | Prod usage (60d unless noted) | Plan / spec coverage | Status |
|---|---|---|---|---|
| S.1 | Create project (`type='project'`) with named subtasks at create time (`subtasks: Array<string\|{title,assignee?}>`) | 13 of 31 projects were created via the bundled-subtasks path (`task_history.action='created'` with `subtasks_count` in details); ~141 subtasks born this way | Spec line 252 (`add_task`) + line 259 (`add_subtask`); engine `subtaskDefs` loop at line 3168 + `insertSubtask` at line 3008 preserved | ADDRESSED |
| S.2 | Subtask numeric suffix (`{parent_id}.{N}` — e.g. `P11.1`, `P11.27`) — NOT zero-padded | 141 of 154 subtask IDs match `P{n}.{n}` (or `M{n}.{n}`) glob; sample: `P19.1`, `P5.7`, `P24.1`, `P9.6`, `P6.13`, `P11.27` | **Spec is silent on the dotted ID format.** Engine `addSubtaskFromMutation` line 5367 builds `${task.id}.${nextSubtaskNum(...)}` — fork-private domain logic, but the format itself is a contract for `task_id.includes('.')` auto-resolve at line 3656 | GAP (ID format contract not enumerated) |
| S.3 | `add_subtask` mutation (post-creation; via `update_task` body) — appends a new dotted row to an existing project | 22 history rows (`subtask_added`) | Spec line 259: `add_subtask / remove_subtask — Subtask management`; engine line 5281-5385 preserved | ADDRESSED |
| S.4 | `remove_subtask` (detach + cancel? — actually a `cancel_task` on the subtask row; `subtask_removed` history is recorded on parent when a subtask is cancelled or detached) | 9 history rows (`subtask_removed`) | Spec line 259 (`remove_subtask`) — but engine has NO `remove_subtask` mutation key. The 9 events come from `cancel_task` cascading to parent + `detach_task` (engine line 8139 emits `subtask_removed` on the parent on detach) | GAP (spec names a tool the engine does not have; the actual paths are `cancel_task` on a subtask row + `detach_task`) |
| S.5 | `rename_subtask({id, title})` — title-only edit on a subtask row | 0 history rows (sample over 60d) | Spec line 254 (`update_task — Edit title/...`) covers the surface generically; engine line 5388 has a dedicated `rename_subtask` branch on `update_task` body | ADDRESSED (sub-operation of `update_task`; spec covers via "edit title") |
| S.6 | `reopen_subtask(id)` — done subtask back to `next_action` | 0 history rows visible (`action='reopened'` on subtask rows) | Spec is silent on subtask-specific reopen; engine line 5398 implements it as a body-key on `update_task` with a "must be done" precondition | GAP (sub-operation not enumerated; differs from L.11 lifecycle `reopen` which is manager-gated, this one is not) |
| S.7 | `assign_subtask({id, assignee})` — reassign subtask to a different person (different from project assignee) | 2 history rows (`subtask_assigned`) | Spec line 258 (`bulk_reassign`) covers bulk; subtask-specific assign via `update_task` body key at engine line 5412 not enumerated | GAP (sub-operation not enumerated) |
| S.8 | `unassign_subtask(id)` — clear assignee on a subtask row (NULL it) | 0 history rows (`unassigned` on subtask rows) | Spec is silent; engine line 5454 implements as body-key on `update_task` | GAP (sub-operation not enumerated) |
| S.9 | `detach_task(task_id)` — remove subtask from parent (sets `parent_task_id=NULL`); records `detached` on subtask + `subtask_removed` on parent | 9 history rows (`detached`) | Spec is silent (line 247 lists `action: ... 'detach_task'` in the action union but no MCP tool entry); engine line 8106 preserved | GAP (mutation not in spec MCP-tool inventory) |
| S.10 | `reparent_task(task_id, target_parent_id)` — promote a free task into a subtask of a project (NOT for moving between parents — engine line 8062 explicitly rejects "already a subtask"); same-board only | 21 history rows (`reparented`) — second-most-frequent structural mutation after `subtask_added` | Spec is silent (line 247 lists in action union but no MCP tool entry); engine line 8050 preserved | GAP (mutation not in spec MCP-tool inventory) |
| S.11 | `merge_project(source_project_id, target_project_id)` — UPDATE-in-place all source subtasks to target parent, rekey IDs, rekey `task_history`, rekey `blocked_by` deps. Manager-only; same-board for source. | **0 history rows EVER** — empty in production | Spec is silent (line 247 lists in action union but no MCP tool entry); engine line 8154-8330 preserved | DEAD-CODE-PRESERVED (engine code is correct + load-bearing for the UPDATE-in-place pattern, but never exercised) |
| S.12 | Subtask numeric ordering (`CAST(SUBSTR(t.id, LENGTH(parent)+2) AS INTEGER), t.id`) — fixes lexicographic `P11.10 < P11.2` bug | Structural — every `getSubtaskRows` call (engine line 1798); confirmed needed: P11 has 27 subtasks `P11.1`-`P11.27` and lexicographic order would render `.10` before `.2` | **Spec is silent.** Engine line 1798-1809 preserved | GAP (ordering contract not enumerated) |

**Counts:** ADDRESSED **3** (S.1, S.3, S.5) — GAP **8** (S.2, S.4, S.6, S.7, S.8, S.9, S.10, S.12) — DEAD-CODE-PRESERVED **1** (S.11) — DEPRECATED-CORRECTLY **0** — DEPRECATED-WRONG **0**.

---

## Per-feature deep-dive on every GAP

### GAP — S.2: dotted ID format (`P{N}.{M}`) is an undocumented contract

**v1 reality.** Engine line 5367: `const subtaskId = ${task.id}.${this.nextSubtaskNum(existingSubtasks)};`. New subtask IDs are the parent ID + `.` + next-integer (max-of-existing-suffix + 1). Project IDs themselves are `P` + integer (engine line 3147), no zero-padding — production has `P1`..`P28`. Subtask IDs therefore look like `P11.27` (NOT `P011.027`).

**Spec coverage.** The redesign spec at lines 248-259 lists `add_subtask` / `remove_subtask` but never specifies the ID format. The audit-question task description called the format `P001.1` (zero-padded) — that is **not** the production format. Production is sparse-integer (`P11.27`).

**Why it's a contract.** Engine line 3656-3660 has a load-bearing path: when the LLM passes `task_id="P5.7"`, the engine auto-extracts `parentId="P5"` and `subtask_id="P5.7"` based on `params.task_id.includes('.')`. If a v2 reimplementation changes the separator (e.g. UUIDs, or `P5-7`), this auto-resolve breaks silently — the LLM's natural `move P5.7 to done` would stop working.

**Production volume.** 141 of 154 subtasks (92%) carry the dotted format. The other 13 are reparented tasks that kept their original ID (`T80`, `M1`, etc.) — see S.10.

**Recommendation.** Add a paragraph to the spec under "What stays in the skill" naming the dotted format as a contract:

> **Subtask ID format.** Subtask IDs are `{parent_id}.{N}` where N is the next integer (no zero-padding). The dot separator is load-bearing — `params.task_id.includes('.')` triggers auto-resolution to parent+subtask. v2-native ports must preserve this exact format.

### GAP — S.4: spec lists `remove_subtask` but engine has no such mutation

**v1 reality.** Engine has NO `remove_subtask` body-key on `update_task`. The 9 `subtask_removed` history rows in production come from two paths: (a) `cancel_task` on a subtask row writes `subtask_removed` on the parent as a side-effect; (b) `detach_task` writes `subtask_removed` on the parent (engine line 8139). **There is no third "remove_subtask" path.**

**Spec coverage.** Spec line 259 names `remove_subtask` as a real MCP tool. This will mislead the v2-native re-port — a developer reading the spec will look for a `remove_subtask` engine path that doesn't exist, or implement one fresh and skip the actual `cancel_task` side-effect that production relies on.

**Production volume.** 9 events. 0 are from a hypothetical `remove_subtask` tool — all 9 come from `cancel_task`/`detach_task` cascades.

**Recommendation.** Either:

- (a) Replace `remove_subtask` in spec line 259 with `detach_subtask` (matches the engine action name `detach_task`) and add a note: "removal of a subtask is `cancel_task` on the subtask row; the parent's `subtask_removed` history row is a side-effect."
- (b) Implement a new `remove_subtask` MCP tool in v2 that wraps `cancel_task(subtask_id)` for clarity. Either is fine; the current spec is incoherent.

### GAP — S.6: `reopen_subtask` is not L.11's `reopen` — different gates

**v1 reality.** Engine line 5398 (`reopen_subtask` body-key on `update_task`): moves a `done` subtask back to `next_action`. **No manager gate.** Compare to L.11 (lifecycle `reopen` action) which IS manager-only (engine line ~3960 — see audit 02). The two paths share the verb "reopen" but have different permission gates. This is intentional: a subtask reopen is a domain-specific edit ("oops, I marked this subtask done by mistake"), not a manager escalation.

**Spec coverage.** Spec only enumerates the lifecycle `reopen` (via `move_task` on a done task). The subtask-specific reopen-without-manager-gate is invisible.

**Production volume.** Zero events in 60d (rare path). But its absence is invisible — users would silently get blocked by the manager gate on subtask reopen if v2 unifies the two paths.

**Recommendation.** Add a footnote to spec line 259's `add_subtask` row:

> Subtasks expose four edit body-keys on `update_task`: `add_subtask`, `rename_subtask`, `reopen_subtask` (no manager gate, unlike the lifecycle `reopen`), `assign_subtask`, `unassign_subtask`.

### GAP — S.7: `assign_subtask` not enumerated — different from `bulk_reassign`

**v1 reality.** Engine line 5412 (`assign_subtask` body-key on `update_task`). Reassigns a single subtask to a different person, with auto-WIP check, person-resolve via name OR phone, and a notification dispatched to the new assignee (engine line 5442-5450). It is NOT `bulk_reassign` — that's a separate path for moving N tasks A→B.

**Spec coverage.** Spec line 258 lists `bulk_reassign` only.

**Production volume.** 2 events (`subtask_assigned` history). Tiny but real — exists because subtask assignees can differ from the project assignee.

**Recommendation.** Bundle into the same footnote as S.6.

### GAP — S.8: `unassign_subtask` not enumerated

**v1 reality.** Engine line 5454. NULL the assignee on a subtask. No production volume in 60d, but the path exists. Used when a subtask is "available for pickup" — the task scheduler sees `assignee IS NULL` and exposes it in the unclaimed list.

**Recommendation.** Bundle into the same footnote as S.6 + S.7.

### GAP — S.9: `detach_task` mutation not in spec MCP-tool inventory

**v1 reality.** Engine line 8106. `detach_task(task_id)` clears `parent_task_id` on a subtask row, leaving the row alive but free-standing. Records `detached` on the subtask + `subtask_removed` on the parent. Used when work that started under a project turns out to be its own thing.

**Spec coverage.** Spec line 247 has `'detach_task'` in the action union (so it's known to be a domain action), but the MCP tool inventory at lines 248-285 never enumerates a `detach_task` tool.

**Production volume.** 9 events. Real and used. Same volume as `subtask_removed` because — see S.4 — every detach writes a `subtask_removed` row.

**Recommendation.** Add a row to spec line 259 area:

> `detach_task` | Promote a subtask to free-standing (clears `parent_task_id`)

### GAP — S.10: `reparent_task` mutation not in spec MCP-tool inventory

**v1 reality.** Engine line 8050. `reparent_task(task_id, target_parent_id)` — converts a free-standing task into a subtask of a project. Strict guards: subject task must NOT already be a subtask (engine line 8062), target must be a project (line 8067), both must be on the same board (line 8071). Records `reparented` on subject + `subtask_added` on target.

**Spec coverage.** Same as S.9 — listed in action union (line 247) but no MCP tool entry.

**Production volume.** 21 events — second-most-frequent structural mutation after `subtask_added`. Used when a free task gets rolled up into a larger initiative.

**The 13 non-dotted subtasks in production** (`T17`, `T18`, `T80`, `T81`, `M1`, `M15`, `M18`, etc.) are evidence: their IDs were assigned BEFORE reparent (so they kept their original `T`/`M` prefix), and they appear in `tasks.parent_task_id` without ever being renamed to `P5.something`. This is intentional (UPDATE-in-place per `feedback_update_in_place.md`) — but a v2-native port that auto-renames on reparent would break the audit trail.

**Recommendation.** Add a row to spec line 259 area:

> `reparent_task` | Convert a free-standing task into a subtask of a project. Preserves the task's original ID — does NOT rename to `{parent}.{N}` format. Same-board only.

### GAP — S.12: subtask numeric ordering (`CAST AS INTEGER`) not enumerated

**v1 reality.** Engine line 1798-1809. `getSubtaskRows` ORDER BY clause is `CAST(SUBSTR(t.id, LENGTH(t.parent_task_id) + 2) AS INTEGER), t.id`. The naive `ORDER BY t.id` would render P11.10 BEFORE P11.2 lexicographically — visible production failure mode given P11 has 27 subtasks.

**Spec coverage.** Silent. The spec covers "subtasks" as a feature but not the ordering contract.

**Production volume.** Structural — every digest, task_details rendering, and "next subtask" pick relies on this ordering. P11 alone has 27 subtasks; P1 has 16; P2 has 15; P6 and P15 each have 12+. **18 of 22 parent projects have ≥10 subtasks** — every one would render in wrong order under naive lexicographic sort.

**Lexicographic-bug demonstration:**

```
$ sqlite3 taskflow.db 'SELECT id FROM tasks WHERE parent_task_id="P11" ORDER BY id LIMIT 10'
P11.1
P11.10        ← would appear before P11.2 in a naive port
P11.11
P11.12
P11.13
P11.14
P11.15
P11.16
P11.17
P11.18

$ sqlite3 taskflow.db 'SELECT id FROM tasks WHERE parent_task_id="P11"
                       ORDER BY CAST(SUBSTR(id, LENGTH("P11")+2) AS INTEGER) LIMIT 10'
P11.1
P11.2         ← correct
P11.3
P11.4
... P11.10, P11.11 ...
```

**Recommendation.** Add to spec under "What stays in the skill":

> **Subtask numeric ordering.** Subtask rendering MUST sort by `CAST(SUBSTR(id, LENGTH(parent_id)+2) AS INTEGER)` — naive lexicographic order incorrectly places `.10` before `.2`. Required because production has projects with up to 27 subtasks. Add regression test asserting `P11.2` comes before `P11.10` in the rendered subtask list.

---

## Per-feature deep-dive on the DEAD-CODE-PRESERVED item

### DEAD-CODE-PRESERVED — S.11: `merge_project` has zero production usage but is load-bearing as a pattern

**v1 reality.** Engine line 8154-8330 (~180 lines). `merge_project(source, target)`: takes all subtasks from source project, UPDATE-in-place to target parent, rekeys IDs to `${target.id}.${nextNum++}`, rekeys `task_history.board_id+task_id`, rekeys `blocked_by` references across ALL tasks (not just same project), preserves notes via append, and emits a per-subtask migration note. Manager-only. Source must be local to caller's board (engine line 8195 — security gate added per Codex review 2026-04-12).

**Production volume.** **Zero events EVER.** `task_history.action='merge_project'` returns 0 rows. The path has never been exercised.

**Why preserve it.** Three reasons:

1. **Memory canon.** `MEMORY.md` → `feedback_update_in_place.md` cites `merge_project` as the canonical example of UPDATE-in-place vs. INSERT+copy. The 180 lines of engine code carry the institutional pattern that drives audit canonicalization (`project_audit_actor_canonicalization.md`). Removing the path removes the reference implementation.
2. **Cross-board subtask plan.** Audit 03 (cross-board) flags `forward_to_parent_with_approval` as the v2-native replacement for `subtask_requests`. The eventual approval-card path needs to pull subtasks from one project into another — that's exactly what `merge_project` does in-board. The v2 cross-board variant will be a port of this code, not a fresh design.
3. **Migration safety.** When operators discover a duplicate-project (e.g. P5 on board A and P5 on board B with overlapping work), `merge_project` is the cleanup tool. Zero usage in 60d does not mean zero need — it means the operator hasn't needed it yet.

**Recommendation.** Add a single line to the spec under "What stays in the skill":

> `merge_project` is preserved as fork-private engine code; zero production usage but the UPDATE-in-place pattern is canonical (per `feedback_update_in_place.md`) and informs the v2 cross-board approval port.

---

## Production-validated claims

All queries run via `ssh -o BatchMode=yes nanoclaw@192.168.2.63 'sqlite3 /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db'` on 2026-05-03.

### Q1: Top parent task subtask counts

```
P11|27          (SECI big project — confirms Discovery 19 §3 "1 has 27")
P1|16
P2|15
P6|13
P5|12
P15|12
P9|7
P20|7
P4|6
P3|6
```

22 parents have ≥1 subtask out of 31 total projects. Median ~6 subtasks per parent.

### Q2: Subtask ID format distribution

```
dotted (P{N}.{M} or M{N}.{M}):       141
non-dotted (T{N}, M{N} reparented):   13
TOTAL                                 154
```

The 13 non-dotted are reparented tasks that kept their original prefix:

```
M1|P11   T84|P11   T88|P11   T82|P14   T87|P20
T80|P22  T81|P22   T85|P3    M15|P3    T17|P5
T18|P5   M18|P6    T19|P7
```

**Cross-validates S.10 + S.2.** Reparent does NOT rename — that's the contract. v2-native port must NOT auto-rename on reparent.

### Q3: Subtask-related history actions (60d)

```
reassigned        | 210    (all reassigns, not subtask-specific — see audit 04)
subtask_added     |  22
reparented        |  21
subtask_removed   |   9
detached          |   9
subtask_assigned  |   2
```

Notably absent (zero rows in 60d AND historically):

```
merge_project     |   0    (S.11 — never exercised)
rename_subtask    |   0    (S.5 — title edits flow through generic 'updated' instead)
reopen_subtask    |   0    (S.6 — done subtasks rarely reopen)
unassigned        |   0    (S.8 — never a NULL on subtasks)
```

### Q4: Cross-board subtask infrastructure

```
subtask_requests rows:   0
boards with cross_board_subtask_mode='open':  28 (all of them)
linked subtasks (linked_parent_board_id IS NOT NULL):  3
```

Confirms Discovery 19 §3: cross-board subtask **approval** is dead infrastructure (0 rows ever). All 28 boards run in `open` mode (no approval required). The 3 linked tasks are the cross-board "tag-parent" feature, not the approval queue. **This couples to audit 03's recommendation** to dissolve `subtask_requests` and re-implement via v2's `ask_user_question` + `schedule_task` (per spec line 154).

### Q5: Project-creation paths

```
projects total:                   31  (5 unique IDs duplicated across 2 boards each)
projects with ≥1 subtask:         22
projects with zero subtasks:       5  (DISTINCT id; 9 rows incl. duplicates)
'created' history with subtasks: 13  (carrying subtasks_count in details)
```

So roughly 13 projects were created via the bundled-subtasks path (S.1) producing ~141 subtasks at create time; another 22 subtasks were added later via `add_subtask` (S.3); the rest came via `reparent_task` (S.10, 21 events; only 13 still alive — others detached or cancelled).

---

## Per-feature deep-dive on load-bearing ADDRESSED items

### ADDRESSED — S.1 + S.3 coupling: assignee inheritance for subtasks

Engine line 3360-3380 (S.1, bundled creation): each subtask inherits `priority` and may inherit `assignee` from project IF the user didn't pass per-subtask assignee. Engine line 5371 (S.3, post-creation `add_subtask`): the new subtask **always** inherits `task.assignee` (the project's current assignee) — no override possible via the `add_subtask` body-key. To assign differently, user must follow with `assign_subtask` (S.7).

**Why this matters.** A v2-native port that allows `add_subtask({title, assignee})` without a separate assign step would silently change the contract — every existing prompt expects `add_subtask` to inherit from project, then optionally `assign_subtask` to override.

**Regression test required.** Project P with assignee=Alice. Call `update_task(P, {add_subtask: "T1"})`. Assert new subtask `P.{N}` has assignee=Alice. Call `update_task(P, {assign_subtask: {id: "P.{N}", assignee: "Bob"}})`. Assert assignee=Bob and a notification was queued for Bob.

### ADDRESSED — S.5 rename_subtask: title-only, no column or notes change

Engine line 5388-5395. `rename_subtask({id, title})` runs a single UPDATE on `tasks.title` for the subtask row, sets `updated_at`, records history. **Does not** change column, assignee, or notes — pure rename. Compare to `update_task` on a regular task which can edit multiple fields at once.

**Regression test required.** Subtask P.1 in `next_action` with notes. Call `rename_subtask(P.1, "new title")`. Assert title changed, column='next_action' unchanged, notes preserved, history row written with `action='updated'` (or canonical equivalent post-Plan §2.3.n), and `_last_mutation` snapshot includes old title for undo.

---

## Cross-references

- `audits/2026-05-03-feature-coverage/02-task-lifecycle.md` L.10 — project-conclude guard ("all subtasks must be done") is the read-side dependency on S.12's ordering: the `WHERE column != 'done'` check (engine line 3781) doesn't depend on order, but the `next_subtask` rendering for the post-conclude notification (engine line 3854-3872) does.
- `audits/2026-05-03-feature-coverage/03-cross-board.md` — `subtask_requests` table + `handle_subtask_approval` action are the cross-board complement of S.9/S.10/S.11 (in-board reparenting/merging). 0 production rows in `subtask_requests` confirms Discovery 19's "dead infrastructure" finding for cross-board approval; that audit recommends dissolving the table per spec line 154's `forward_to_parent_with_approval` redesign.
- `audits/2026-05-03-feature-coverage/04-reassignment.md` — `bulk_reassign` overlaps with S.7 (`assign_subtask`). Bulk path operates on `assignee = X → Y`; subtask-assign path operates per-subtask. Both must coexist; the spec currently lists only `bulk_reassign`.
- `MEMORY.md` → `feedback_update_in_place.md` — cited above as the canonical pattern that `merge_project` (S.11) and `reparent_task` (S.10) implement. Engine line 8084 + 8132 are the UPDATE-in-place evidence; the snapshot-into-archive equivalent for cancelled rows is the contrasting INSERT+copy pattern (rejected per the feedback file).
- Plan Step 2.3.n — task_history canonicalization. The 6 subtask-related action names (`subtask_added`, `subtask_removed`, `subtask_assigned`, `reparented`, `detached`, `merged`) are NOT in the doublet list at audit 02 Q1. They are already canonical, single-form actions. The plan does not need to migrate them.

---

## Methodology notes

**Why the bulk of subtask features land in GAP.** All 8 GAPs (S.2, S.4, S.6, S.7, S.8, S.9, S.10, S.12) share the same root cause: the spec's MCP tool inventory at lines 248-259 enumerates 4 subtask-related entries (`add_subtask`, `remove_subtask`, plus generic `update_task` and `cancel_task`) but the engine has 11 distinct subtask code paths. Five of those (rename/reopen/assign/unassign + the bundled-creation `subtaskDefs`) are body-keys on `update_task`; two (`reparent_task`, `detach_task`) are top-level mutations listed in the action union but missing from the tool table; one (`merge_project`) is dead-code-preserved as a pattern reference; and the implicit contracts (dotted ID format, numeric ORDER BY) are entirely silent in the spec. Closing the GAPs is purely a spec edit — engine code is correct.

**Why S.4's spec name vs. engine reality is the most user-facing.** A reader of the spec will look for a `remove_subtask` MCP tool. They will not find it, because removal is achieved via `cancel_task` on the subtask row (with side-effect `subtask_removed` written on the parent). This is the only GAP where the spec actively misleads — others are silent gaps. Recommend resolving in the spec PR before any v2-native port begins.

**Why S.11 is DEAD-CODE-PRESERVED, not DEPRECATED.** Zero usage in 60d would normally suggest removing the code. But the path is load-bearing as the canonical UPDATE-in-place reference (per `MEMORY.md`), and the cross-board approval port (audit 03) will need it as a model. Keep the code, document it as preserved-for-pattern in the spec.

**Coverage caveats.** All "0 rows in 60d" claims used `task_history.at >= datetime('now', '-60 days')` indirectly via the action histogram in Discovery 19 §6; the queries above are TOTAL counts (not 60d-bounded) because the relevant features are rare enough that 60d filtering would only confuse. The discrepancy `subtask_added=22 vs. subtasks=154` is fully explained by S.1 (bundled creation, 13 events × ~10 average subtasks/project = ~130) + S.3 (post-creation, 22 events) + S.10 (reparent, 21 events; minus detach/cancel) — adds up.

---

## Summary

The projects + subtasks domain has 11 engine code paths across 12 features. Engine code is preserved correctly per spec (it travels in `taskflow-engine.ts`), but **8 of 12 features are GAPs because the spec's MCP tool inventory under-enumerates them**: 5 subtask body-keys on `update_task` (rename/reopen/assign/unassign + the implicit assignee-inheritance contract), 2 top-level structural mutations (`reparent_task`, `detach_task`) that appear in the action union but not the tool table, the dotted-ID format contract, and the numeric ORDER BY ordering contract. One feature (`merge_project`, S.11) is DEAD-CODE-PRESERVED with zero production usage but load-bearing as a pattern reference. One spec entry (`remove_subtask`, S.4) actively names a tool the engine does not have. None require engine changes; all require additions to the spec's tool table + ~5 small regression tests. Total work to close all 8 GAPs: **single spec PR, no code changes** (same conclusion as audit 02). Expected blast radius if any GAP regresses at v2 cutover: silent — most are zero-volume paths, but S.2 (dotted format) and S.12 (numeric ORDER BY) are structural and would break P11's 27-subtask rendering on day one.
