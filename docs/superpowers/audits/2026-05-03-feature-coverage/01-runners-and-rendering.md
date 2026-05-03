# Feature coverage audit — scheduled-runners domain (sections N + L.5/.7/.13/.14)

**Date:** 2026-05-03
**Scope:** TaskFlow runners (standup, digest, weekly review, Kipp daily audit) + the read-side query support those runners depend on.
**Method:** cross-reference v1 source (`audit/taskflow-2026-04-11` branch) + v2-native redesign spec (`docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`, restored from `stash@{0}` since the working tree's `base/v2-fork-anchor` has no `docs/superpowers/specs/`) + v2-features evaluation (`docs/superpowers/audits/2026-05-02-v2-features-for-our-skills.md` from commit `97553379`) + production memory (`memory/project_v2_migration_production_validation.md`) + live SQL on prod (`nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/`).

> **Input availability note.** The task instructions cite `docs/superpowers/audits/2026-05-03-add-taskflow-feature-inventory.md`, `…-v1v2-mapping.md`, `docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`, and `docs/superpowers/research/2026-05-03-v2-discovery/{16,19}.md` as inputs. **None of those files exist in any branch, stash, or worktree** (`git log --all --diff-filter=A` returns 0 hits). The closest extant artefacts are the v2-native-redesign spec, the v2-features evaluation, and the production-validation memory file — used in their place. Where this report cites a feature ID like `N.1`, the ID is reconstructed from the spec's runner enumeration + the v2-features eval's R1 disposition; the inventory document that originally defined the IDs is missing.

---

## Coverage matrix

| ID | Feature (1-line) | Prod usage | Plan coverage | Status |
|---|---|---|---|---|
| N.1 | Morning standup runner 08:00 wkday | 27 active rows across 27 distinct boards; cron `0 8 * * 1-5` (15) + staggered `3 8` (6) + `6 8` (6); 468 runs in last 30d | Spec §"Scheduling migration" maps each v1 `scheduled_tasks` row to a v2 `schedule_task(recurrence=cron)` call; migrate-scheduled-tasks.ts converts 1:1 | ADDRESSED |
| N.2 | Evening digest runner 18:00 wkday | 28 active rows across 28 distinct boards; cron `0 18` (14) + staggered `3 18` (6) + `6 18` (6) + outliers `0 12`, `0 17`; 468 runs in last 30d; **18 of 28 attach `digest-skip-script.sh` as the `script` column** | Spec maps the prompt via `schedule_task(prompt, recurrence)`; the spec mentions v2's `script?` parameter in the v2-features eval (R1) but the redesign spec does **not** explicitly migrate the digest-skip script. See per-feature deep-dive. | GAP (script migration not in plan) |
| N.3 | Weekly review runner Friday 14:00 | 29 active rows; **28 use `0 14 * * 5`** + 1 outlier `0 8 * * 1`; 181 runs in last 60d | Spec includes `schedule_task(prompt='Weekly review ...', recurrence='0 16 * * 5')` (note: spec example uses `16`, prod uses `14` — cosmetic) | ADDRESSED |
| N.4 | Kipp daily audit runner 04:00 every day | 1 active row (`auditor-daily`, group `whatsapp_main`, `0 4 * * *`); 36 runs in last 30d; **uses `script` field with 483-line `auditor-script.sh` heredoc** | Spec §"Scheduling migration" handles the cron; the eval mentions `script` is a v2-supported pre-agent hook. **Auditor-script.sh content is NOT in the migration plan** — same gap as N.2. | GAP (Kipp audit script body migration not in plan) |
| N.5 | Per-board cron staggering (`0 8`, `3 8`, `6 8` — rate-limit avoidance) | 12/27 standup rows + 12/28 digest rows use staggered minute offsets | Spec migrates `task.cron` verbatim; staggered minutes are preserved as-is | ADDRESSED |
| N.6 | Customizable per-board (28 distinct group_folders, 14 distinct cron patterns active) | 29 distinct group_folders active; 14 distinct cron patterns | Spec's per-board provisioning generates `schedule_task` calls per board; preserves customization | ADDRESSED |
| N.7 | Per-board digest-skip-on-Friday (silent-exit pattern via `script` returning `wakeAgent:false`) | 18/28 digest rows have script attached; 109 of 728 digest runs in 60d emitted a "skip" marker (~15%, all Fridays) | v2's `schedule_task` accepts a `script` arg whose JSON output controls `wakeAgent`. Spec/eval reference the parameter but do **not enumerate which scripts migrate** or test the equivalent v2 behavior. See deep-dive. | GAP (silent-exit semantics not validated against v2's pre-agent script contract) |
| N.8 | Runner task IDs deterministic (`task-<ts>-*`, `auditor-daily`, `task-<ts>-holiday-cron`) | Stable IDs across all 89 active rows; FK from `task_run_logs.task_id`; `auditor-daily` is the only stable string ID | v2's `schedule_task` mints opaque IDs. Spec's `migrate-scheduled-tasks.ts` re-creates schedules but **the ID-stability question is not addressed**. Audit-history join on `task_run_logs.task_id` will break unless explicit. | GAP (task-ID stability across migration not specified) |
| N.9 | Trigger context capture on scheduled task firing (`trigger_message_id`, `trigger_chat_jid`, `trigger_sender`, `trigger_turn_id`) | Schema present; **0/89 active rows populate any trigger field** (memory says v1 captures trigger on user-created scheduled tasks, but our 89 production rows are all infrastructure-seeded, so all NULL) | Spec **Q6** explicitly raises: "v2's `schedule_task` doesn't have those fields. Do we lose attribution at cutover?" — flagged as open question, no resolution | GAP (Q6 unresolved; production data shows the column is empty in practice, so the gap is academic — but the spec doesn't say so) |
| N.10 | Runner failure surfacing (`⚠️ TaskFlow runner error: …` to group chat on agent error) | Hardcoded in `task-scheduler.ts:241` for `taskflowManaged===true`; 0 errors logged in last 60d (1878/1878 success per `task_run_logs`) | Not mentioned in spec — error-surface UX is fork-private behavior in `task-scheduler.ts` | GAP (runner-error visibility behavior is silently dropped) |
| N.11 | Pre-execution `next_run` advancement to prevent double-pickup on slow runs | `task-scheduler.ts:144-152` advances `next_run` BEFORE running | v2's `schedule_task` is post-recurrence-from-now, no double-pickup possible | ADDRESSED (architecturally subsumed) |
| N.12 | Cron-slot idempotency guard (skip if `last_run` already in current cron slot) | `task-scheduler.ts:67-86` `cronSlotAlreadyRan()` | v2 cron `next()` from "now" → naturally idempotent; missed slots SKIPPED instead of replayed | ADDRESSED (architecturally subsumed) |
| N.13 | Catch-up of missed schedules during host downtime | v1 `task-scheduler.ts` polls every interval and picks up any past-due rows | Spec §"Caveat (Codex #5 R1 finding)" + Q1: explicit open question. Spec offers a ~50-LOC fork-private wrapper if catch-up is required. | GAP (Q1 unresolved — decision deferred to plan that doesn't exist) |
| N.14 | DST automatic resync runner | 0 active rows in production (verified: no `prompt LIKE '%DST%'` or `'%resync%'` rows ever existed) | Spec §"DST handling (Q-N.1 RESOLVED 2026-05-03)" drops it explicitly; production confirms 100% round-hour cron | DEPRECATED-CORRECTLY |
| N.15 | Local+UTC cron preservation logic for DST boundary safety | Embedded in v1 `localToUtc` 2-pass convergence helper | Spec drops the cron-preservation logic; keeps `localToUtc` for due-date math + meeting `scheduled_at` | DEPRECATED-CORRECTLY (with carve-out for due-date math) |
| N.16 | DST anti-loop counter in scheduled-task wrapper | Not visible in v1 `task-scheduler.ts` shipped code (described in memory + spec as defensive insurance) | Spec keeps it: "cheap defensive insurance against any pathological cascade in TaskFlow's reminder pipeline" | ADDRESSED |
| L.5 | Due-soon / overdue task queries (runner read-side) | 135 tasks with due_date; 2 due in next 3 days; 45 overdue (live snapshot) | Domain logic stays in `taskflow-engine.ts` per spec ("Kanban state machine, WIP limits, task lifecycle … exposed as MCP tools") | ADDRESSED |
| L.7 | Idle-task detection (no `updated_at` change for N days) | 201/218 active tasks idle > 3 days (live snapshot) | Domain logic in engine; runners issue MCP query | ADDRESSED |
| L.13 | Stale-collapse rendering (collapse N idle tasks into one digest line) | Not directly verifiable in DB (rendering-side); referenced by digest prompt | Domain logic in engine + CLAUDE.md template | ADDRESSED |
| L.14 | Changes-since query (history-window for digest "what changed today/this week") | 1222 history rows in last 30d; 2532 total — `task_history.at` is the timestamp source | `task_history` STAYS fork-private per spec ("60s undo via task_history" — the same table backs the changes-since query) | ADDRESSED |

**Counts:**

- ADDRESSED: **13** (N.1, N.3, N.5, N.6, N.11, N.12, N.16, L.5, L.7, L.13, L.14, plus N.15-with-carve-out is correctly dropped, plus N.14 below)
- GAP: **6** (N.2, N.4, N.7, N.8, N.9, N.10, N.13)
- DEPRECATED-CORRECTLY: **2** (N.14, N.15)
- DEAD-CODE-PRESERVED: **0**
- DEPRECATED-WRONG: **0**

(Note: N.15 is counted under DEPRECATED-CORRECTLY because the spec explicitly preserves the helper for due-date math; only the cron-preservation _wrapper_ is dropped.)

---

## Per-feature deep-dive

### GAP — N.2 + N.4 + N.7: pre-agent `script` field migration is unspecified

**v1 reality.** The `scheduled_tasks.script` column carries an inline bash heredoc that runs *before* the agent fires. Production usage:

- **18 of 28 digest rows** attach `bash /app/src/digest-skip-script.sh` (59-line script, see `container/agent-runner/src/digest-skip-script.sh` on `audit/taskflow-2026-04-11`). On Fridays it queries `messages.db` for user activity in the last 4h; if zero, prints `{wakeAgent:false}` and the orchestrator skips the agent invocation entirely.
- **1 row** (`auditor-daily`) attaches a 483-line auditor heredoc (`auditor-script.sh`) that opens BOTH `messages.db` and `taskflow.db` read-only, builds a per-board interaction audit JSON, and emits it as the LAST line of stdout. The agent prompt then consumes that JSON to draft the daily Kipp report.

**v2 spec coverage.** The v2-features eval (`97553379`) cites `schedule_task(prompt, processAfter, recurrence?, script?)` and confirms `script` is "an optional pre-agent script." The redesign spec mentions it once (`script: task.script ?? null`) in the migration loop. **What is missing:**

1. No explicit test that v2's `script` semantics match v1's: does v2 honor the `wakeAgent:false` JSON contract that v1's container-runner reads? (`container/agent-runner/src/index.ts` parses the script's last stdout line.)
2. No mapping for the heredoc-to-file question — does the migration script copy the inlined heredoc bodies into v2's `script` column verbatim, or extract them to bundled files in `container/agent-runner/src/`?
3. No regression test for the digest-skip-on-Friday silent-exit path; this is the highest-volume runner-side optimisation in production (15% of digest invocations skipped).
4. The Kipp auditor heredoc reads `taskflow.db` — under v2, does the script have read access to the per-agent SQLite + the central `data/v2.db`? Mount-security (E7 in eval) defaults to deny.

**Recommendation.** Add an explicit task to the (yet-unwritten) Phase A.3 plan: "Validate that v2's `schedule_task.script` parameter (a) accepts heredoc bodies, (b) parses `{wakeAgent:false}` from last stdout line, (c) has read access to taskflow + messages DBs under default mount-security." Until validated, treat the silent-exit path as a regression risk.

### GAP — N.8: task-ID stability across cutover

**v1 reality.** All 89 active rows have stable, deterministic IDs:
- `auditor-daily` (single string ID — only one global Kipp)
- `task-<ms-timestamp>-<6-char-suffix>` (timestamp-based, persistent)
- `task-<ms-timestamp>-holiday-cron` (sec-secti's annual holiday seeker)

`task_run_logs.task_id` FK joins back to `scheduled_tasks.id`. The 1878 historical run-log rows reference these stable IDs.

**v2 spec coverage.** Spec's `migrate-scheduled-tasks.ts` calls `await scheduleTaskMcpTool({...})` per row. v2 mints its own internal IDs. The plan does NOT address:

1. Whether v2's `schedule_task` accepts a caller-supplied ID (so `auditor-daily` can keep its name).
2. Whether `task_run_logs` (currently stored under `messages.db` in v1) survives migration — it's not mentioned in the migration steps. If it doesn't, 60 days of run history becomes orphan rows.
3. The Kipp self-correction detector (per memory `project_audit_actor_canonicalization.md`) joins `auditor-daily` runs across days to compute drift. Breaking the ID breaks the audit-of-the-audit.

**Recommendation.** Add a migration step: copy `task_run_logs` (or transform to v2's equivalent if one exists) and either preserve `auditor-daily` as a caller-supplied ID, or write a `legacy_task_id` column on the new schedules.

### GAP — N.9: trigger-context attribution at cutover (Q6)

The spec explicitly raises this as open question Q6 and never answers it. Production data softens the urgency: **0 of 89 active rows have `trigger_*` fields populated** — the columns are infrastructure-seeded scheduled tasks (standup/digest/review/audit), not user-created reminders. So at cutover, no attribution data is at risk. **But the spec does not state this** — Q6 is left as a real open question. A reader of the plan would think trigger-context is load-bearing for the migration.

**Recommendation.** Resolve Q6 explicitly: "Production audit shows 0/89 active rows populate trigger_*; we lose nothing at cutover. Future user-created reminders post-cutover would need fork-private metadata if attribution becomes a TaskFlow product feature, but it is not one today."

### GAP — N.10: runner failure surfacing UX dropped silently

`task-scheduler.ts:241-243` posts `⚠️ TaskFlow runner error: <msg>` to the group chat when a TaskFlow-managed scheduled task errors. v1 has had **zero errors in 60 days** (1878/1878 success), so the path is empirically rare — but it's the operator's only signal that a board's morning standup or weekly review died. The spec does not mention error-surfacing for v2 schedules; v2's `schedule_task` MCP tool does not document an equivalent behavior.

**Recommendation.** Either (a) verify v2's `schedule_task` has equivalent error-surfacing, or (b) add a fork-private wrapper that posts the message on error. Don't drop silently.

### GAP — N.13: catch-up of missed schedules (Q1)

Spec's Q1: "Is missed-run catch-up required for Kipp/digest/standup?" — left open.

Production evidence: the 2026-04-14 silent-boards post-mortem (memory `project_20260414_audit_silent_boards.md`) showed Kipp audit silence on multiple boards because of 3 SIGKILL service restarts during host downtime. Writes survived via MCP→DB, but responses died. **If v2 silently skips missed schedules, similar restarts post-cutover will silently drop standup and digest runs**, not just response delivery.

**Recommendation.** Resolve Q1 with explicit policy: build the ~50-LOC catch-up wrapper for Kipp + standup/digest. Cost is small; the alternative is lost runs that operators won't notice until end-of-day.

---

## Production-validated claims

All queries run via `ssh -o BatchMode=yes nanoclaw@192.168.2.63 'sqlite3 ...'` against `/home/nanoclaw/nanoclaw/store/messages.db` and `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` on 2026-05-03.

### Q1: Active scheduled tasks by kind + cron pattern

```sql
SELECT schedule_value AS cron, <kind classifier>, COUNT(*), COUNT(DISTINCT group_folder)
FROM scheduled_tasks WHERE status='active' GROUP BY 1, 2;
```

Result (selected rows):

| cron | kind | n | distinct_groups |
|---|---|---|---|
| `0 8 * * 1-5` | standup | 15 | 15 |
| `3 8 * * 1-5` | standup | 6 | 6 |
| `6 8 * * 1-5` | standup | 6 | 6 |
| `0 18 * * 1-5` | digest | 14 | 14 |
| `3 18 * * 1-5` | digest | 6 | 6 |
| `6 18 * * 1-5` | digest | 6 | 6 |
| `0 14 * * 5` | weekly_review | 28 | 28 |
| `0 4 * * *` | other (Kipp) | 1 | 1 |
| `0 9 15 12 *` | other (annual holiday seeker) | 1 | 1 |

Total 89 active rows. 100% cron + round-hour (the staggered-minute boards are still hour-aligned). Confirms memory claim. Backs N.1, N.3, N.4, N.5, N.6.

### Q2: Runner activity in `task_run_logs`

```sql
SELECT 'kipp_runs_30d', COUNT(*) FROM task_run_logs WHERE task_id='auditor-daily' AND run_at >= datetime('now','-30 days')
UNION ALL SELECT 'standup_runs_30d', ... UNION ALL ...
```

Result: kipp_runs(30d)=36, standup_runs(30d)=468, digest_runs(30d)=468, weekly_runs(60d)=181, all_runs(60d)=1878, all_runs(7d)=248. Backs N.1, N.2, N.3, N.4 prod-usage claims.

### Q3: Trigger context capture in 89 active rows

```sql
SELECT SUM(CASE WHEN trigger_message_id IS NOT NULL THEN 1 ELSE 0 END), ... FROM scheduled_tasks WHERE status='active';
```

Result: with_trigger_msg=0, with_trigger_jid=0, with_trigger_sender=0, with_trigger_turn=0, **with_script=19**, context_mode=group=85, context_mode=isolated=4. **All trigger fields are NULL** in production despite the schema supporting them. Backs N.9 finding (Q6 risk is academic — production already lost no information at cutover).

### Q4: Digest silent-exit pattern via `script` column

```sql
SELECT COUNT(*) AS digest_runs_60d, SUM(CASE WHEN result LIKE '%skip%' THEN 1 ELSE 0 END) AS skip_marker, ...
FROM task_run_logs WHERE run_at >= datetime('now','-60 days') AND task_id IN (digest tasks);
```

Result: digest_runs_60d=728, skip_marker=109 (~15%, all Friday firings), null_result=79, success=711, error=0. Confirms the `digest-skip-script.sh` silent-exit path is exercised in production. Backs N.7 GAP claim.

### Q5: Hour-of-day distribution of `send_message_log` (last 30d)

| hour_utc | n |
|---|---|
| 11 (=08:00 local) | 475 |
| 12 | 84 |
| 14 | 68 |
| 15 | 83 |
| 17 | 81 |
| 21 (=18:00 local) | 436 |

Two strong peaks at standup-fire and digest-fire local hours. Confirms runners are the dominant outbound senders. Backs N.1 + N.2 prod-usage.

### Q6: TaskFlow read-side query support (taskflow.db)

| metric | n |
|---|---|
| tasks_total | 356 |
| tasks_active (column NOT IN done/cancelled/archive) | 218 |
| tasks_with_due | 135 |
| tasks_due_in_3d | 2 |
| tasks_overdue | 45 |
| tasks_idle_3d (active + updated_at < now-3d) | 201 |
| task_history (30d) | 1222 |
| task_history (total) | 2532 |

Confirms L.5 (due-soon/overdue), L.7 (idle), L.14 (changes-since via `task_history.at`) all have real production volume. The runners do exercise these queries (digest reads idle/overdue, standup reads due-soon, Kipp reads history-30d).

### Q7: DST runner non-existence

```sql
SELECT * FROM scheduled_tasks WHERE prompt LIKE '%DST%' OR prompt LIKE '%resync%' OR id LIKE '%dst%' OR id LIKE '%resync%';
```

Zero rows. Confirms N.14 deprecation is correct (Fortaleza dropped DST in 2019; no resync runners ever existed in this DB).

### Q8: Scripts-by-runner-kind

```sql
SELECT <kind>, COUNT(*), SUM(CASE WHEN script IS NOT NULL THEN 1 ELSE 0 END) FROM scheduled_tasks WHERE status='active' GROUP BY kind;
```

| kind | n | with_script |
|---|---|---|
| digest | 28 | **18** |
| weekly_review | 29 | 0 |
| standup | 27 | 0 |
| other (incl. Kipp) | 5 | 1 |

The 18-of-28 digest scripts all run `bash /app/src/digest-skip-script.sh`. The 1 "other" script is `auditor-daily` running the 483-line auditor heredoc. Backs N.2 + N.4 + N.7 GAP claims about script-migration scope.

---

## Recommendations

1. **Resolve Q1 (catch-up) as YES.** Production has already had a silent-boards post-mortem caused by missed runs during host downtime. v2's "skip missed windows" default is an operational regression for Kipp/standup/digest. Build the ~50-LOC fork-private catch-up wrapper. Cost is trivial; cost of NOT doing it is silent failure that operators don't notice until end-of-day.

2. **Add a Phase A.3 plan task: "validate `schedule_task.script` semantics against v1's heredoc/wakeAgent contract."** This covers N.2/N.4/N.7 (the digest-skip + Kipp auditor scripts). Until validated, ~15% of digest invocations and 100% of Kipp data-gathering are at risk.

3. **Specify task-ID preservation policy at migration.** Either preserve `auditor-daily` and `task-<ts>-*` IDs, or migrate `task_run_logs` to a new `legacy_task_id` mapping. Without this, the Kipp self-correction detector and 60d of run history break at cutover.

4. **Add error-surfacing to v2 runners (N.10).** Either verify v2's `schedule_task` has equivalent `⚠️ TaskFlow runner error` UX, or wrap with a fork-private error handler. Don't drop silently — this is the operator's only signal that a runner died.

5. **Resolve Q6 (trigger-context attribution) explicitly with the production-data finding.** 0/89 rows populate trigger_*; the migration loses nothing today. Document that future reminder-style scheduled tasks (if added as a TaskFlow product feature) would need fork-private metadata.

6. **N.14 / N.15 deprecation is correct as-specified.** No DST runners exist in 60 days of history; Fortaleza dropped DST in 2019. Drop confidently.

---

**File path:** `/root/nanoclaw/docs/superpowers/audits/2026-05-03-feature-coverage/01-runners-and-rendering.md`
