# 16 — Database Schema Domain: Feature-Coverage Audit

**Date:** 2026-05-03
**Scope:** TaskFlow's *fork-private SQLite schema* — 16 schema features (15 tables + WAL mode) covering board metadata, hierarchy, configuration, runtime cron state, roster, permissions, tasks, history/undo, archive, cross-board approval queue, external participants, attachment audit, cross-group delivery log.
**Anchor plan:** `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` (Step 2.3.d schema migrations, 2.3.e seed-board-admins, 2.3.m drop send_message_log)
**Anchor spec:** `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`
**Discovery 04 (table placement):** `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/04-taskflow-table-placement.md`
**Discovery 02 (central data/v2.db):** `.../research/2026-05-03-v2-discovery/02-central-db.md`
**Engine source (CREATE TABLEs):** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:1170-1290`
**Host source (CREATE TABLEs):** `/root/nanoclaw/src/taskflow-db.ts:18-220`, `/root/nanoclaw/src/db.ts:83-110` (send_message_log)

---

## 0. Production validation (queries run 2026-05-03 against `nanoclaw@192.168.2.63`)

### Authoritative table list — `data/taskflow/taskflow.db`

`.schema` returned **27 tables** (vs the 15-table inventory in the audit prompt):

| # | table | rows | in inventory? | classification |
|---|---|--:|---|---|
| 1 | `boards` | 37 | yes | TaskFlow domain |
| 2 | `board_groups` | 2 | yes | TaskFlow wiring (drop) |
| 3 | `board_config` | 28 | yes | TaskFlow domain |
| 4 | `board_runtime_config` | 28 | yes | TaskFlow runtime (33 columns) |
| 5 | `board_people` | 59 | yes | TaskFlow roster |
| 6 | `board_admins` | 30 | yes | TaskFlow permissions (drop) |
| 7 | `tasks` | 356 | yes | TaskFlow domain (38 columns) |
| 8 | `task_history` | 2 532 | yes | TaskFlow audit/undo |
| 9 | `archive` | 188 | yes | TaskFlow soft-delete |
| 10 | `child_board_registrations` | 26 | yes | TaskFlow hierarchy |
| 11 | `subtask_requests` | 0 | yes | TaskFlow approval queue (DEAD) |
| 12 | `external_contacts` | 3 | yes | TaskFlow external roster |
| 13 | `meeting_external_participants` | 3 | yes | TaskFlow meeting access |
| 14 | `attachment_audit_log` | 0 | yes | TaskFlow attachment audit |
| 15 | `board_holidays` | 252 | NO (Discovery 04 surfaced) | TaskFlow recurrence |
| 16 | `board_id_counters` | 87 | NO (Discovery 04 surfaced) | TaskFlow counter |
| 17 | `board_chat` | 224 | **NO — not in any inventory** | TaskFlow web-UI chat |
| 18 | `people` | 0 | **NO — not in any inventory** | dead/stub |
| 19 | `users` | 32 | **NO — not in any inventory** | TaskFlow web-UI auth |
| 20 | `organizations` | 2 | **NO — not in any inventory** | TaskFlow web-UI auth |
| 21 | `org_members` | 5 | **NO — not in any inventory** | TaskFlow web-UI auth |
| 22 | `org_invites` | 2 | **NO — not in any inventory** | TaskFlow web-UI auth |
| 23 | `otp_requests` | 0 | **NO — not in any inventory** | TaskFlow web-UI auth |
| 24 | `sessions` | 216 | **NO — not in any inventory** | TaskFlow web-UI auth |
| 25 | `revoked_tokens` | 0 | **NO — not in any inventory** | TaskFlow web-UI auth |
| 26 | `agent_heartbeats` | 0 | **NO — not in any inventory** | TaskFlow web-UI agent monitor |
| 27 | `sqlite_sequence` | n/a | n/a | sqlite internal |

`send_message_log` lives in `store/messages.db` (NOT `taskflow.db`): **1488 rows**, time range `2026-04-13 → 2026-05-02`. (Discovery 04 #15 dropped this; plan §2.3.m commits.)

### Other relevant production state

- `journal_mode` = `wal` for both `data/taskflow/taskflow.db` and `store/messages.db`.
- `registered_groups` (in `store/messages.db`) — 28 with `taskflow_managed=1`, 1 with `=0`. Columns `taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth` present. Source for the new `taskflow_group_settings` sidecar.
- `board_admins.is_primary_manager` distribution: 28 rows `=1`, 2 rows `=0` → matches Discovery 04 finding "always 1 for manager, 0 for delegate". Drop tolerance is real.
- `board_runtime_config` has 33 columns, including 24 zombie ones (`runner_dst_guard_task_id`, `runner_*_secondary_task_id`, `dst_*`, `*_cron_utc`) all 0/28 populated per audit 01.
- `tasks` has 38 columns (matches engine's 9 ALTER additions on top of 29 base columns; Discovery 04 stated "40+", actual is 38).
- `boards` has 14 columns (engine added `org_id`, `name`, `description`, `owner_user_id`, `created_at`, `updated_at` — 6 web-UI columns not mentioned by Discovery 04).
- `external_contacts` 3 prod rows: 1 has `direct_chat_jid` populated (Edmilson, status `active`), 2 are phone-only stubs (Katia, Ismael). All `status='active'` (none `pending` despite Discovery 04 claim of "2 in pending status").
- `meeting_external_participants` 3 prod rows on 2 boards (`board-thiago-taskflow`, `board-sec-taskflow`); 1 `revoked`, 2 `invited`, 0 `accepted`.
- `child_board_registrations` 26 rows across 5 distinct parent boards.
- `board_groups` only 2 rows — very low coverage, suggests the table is partially populated.
- `subtask_requests` 0 rows confirms Discovery 19 §6 "DEAD CODE in prod".

### Surface tables NOT in any plan / discovery / spec

The 9 web-UI / auth tables (`users`, `organizations`, `org_members`, `org_invites`, `otp_requests`, `sessions`, `revoked_tokens`, `agent_heartbeats`, `board_chat`) plus stub `people` were NOT enumerated by Discovery 04. They appear to belong to a TaskFlow web-UI surface that overlaps fork-private TaskFlow but is not part of the `add-taskflow` skill as scoped by the v2-native redesign spec. **GAP — not addressed anywhere.**

---

## Coverage matrix (16 features)

Status legend: **ADDRESSED** = plan/discovery places it correctly with migration spec. **GAP** = not addressed or under-specified. **DEPRECATED-CORRECTLY** = removal intentional and correct. **DEPRECATED-WRONG** = removal proposed but breaks something. **PROD-MISMATCH** = production reality diverges from plan/discovery assumption.

| ID | Feature | Plan / Discovery placement | Migration covered? | FKs | Status |
|---|---|---|---|---|---|
| S1 | `boards` | Discovery 04 #1 → fork-private `taskflow.db` | 2.3.d initializer; 6.3 dry-run COPY | `parent_board_id REFERENCES boards(id)` self-FK preserved; **`org_id REFERENCES organizations(id)` NEW (not in inventory)** | **ADDRESSED** with caveat: 6 web-UI columns (`org_id`, `name`, `description`, `owner_user_id`, `created_at`, `updated_at`) not mentioned by Discovery 04 / plan |
| S2 | `board_groups` | Discovery 04 #2 → DROP; replaced by v2 `messaging_group_agents` | Plan 2.3.d implies drop; no explicit migration step | n/a — table goes away | **DEPRECATED-CORRECTLY** but **GAP** in coverage of partial-population (only 2 prod rows); a per-board sweep is needed to confirm `messaging_group_agents` covers ALL 37 boards' wiring before drop |
| S3 | `board_config` | Discovery 04 #3 → fork-private `taskflow.db` | 2.3.d initializer; 6.3 COPY | none | **ADDRESSED** |
| S4 | `board_runtime_config` | Discovery 04 #4 → fork-private; runner_*_task_id columns rebind to v2 schedule IDs | 2.3.d initializer + 2.3.f migrate-scheduled-tasks does the rebind | `board_id REFERENCES boards(id)` preserved | **GAP** — plan does not enumerate the 24 zombie columns identified in audit 01 (`runner_dst_guard_task_id`, `runner_*_secondary_task_id`, `dst_*`, `*_cron_utc`); they must be dropped or carried forward as dead-but-stable. Discovery 04 §80 says "stays" without mentioning the zombies |
| S5 | `board_people` | Discovery 04 #5 → fork-private + parallel write to v2 `users` + `agent_group_members` (Q4) | 2.3.d initializer; spec §111 hints at live-add path; **plan does NOT enumerate the two-table-write invariant** for ongoing `taskflow_add_person` calls | `board_id REFERENCES boards(id)` preserved | **GAP** — Q4 from Discovery 04 + Q8 (cross-DB transactional integrity) flagged but not committed in plan. Crash-recovery sweep not specified |
| S6 | `board_admins` | Discovery 04 #6 → DROP; replaced by `user_roles(role='admin', agent_group_id=X)` + extension `taskflow_board_admin_meta(is_primary_manager, is_delegate)` | Plan 2.3.e seed-board-admins.ts; spec §194 calls it Phase A.3 deliverable | `is_primary_manager` ports into extension table; `admin_role` ports into `role='admin'` (delegate distinction lost or ported into `is_delegate`) | **ADDRESSED**. Prod has 28×`is_primary_manager=1` + 2×`=0` → drop tolerance fine if the 2 delegates are migrated correctly via extension table |
| S7 | `tasks` | Discovery 04 #7 → fork-private; "40+ columns" (actual: 38) | 2.3.d initializer; 6.3 COPY | `board_id REFERENCES boards(id)` preserved; **soft-FK** `parent_task_id`, `linked_parent_board_id`, `linked_parent_task_id`, `child_exec_board_id`, `child_exec_person_id` all uneforced (engine-level joins) | **ADDRESSED**. Indexes `idx_tasks_parent`, `idx_tasks_linked_parent`, `idx_tasks_meeting_id`, `idx_tasks_updated_at` all present in prod, all preserved by 2.3.d |
| S8 | `task_history` | Discovery 04 #8 → fork-private; spec §25 STAYS | 2.3.d initializer + 2.3.n action-name canonicalization (8 doublets) + new `idx_task_history_undo` index per Discovery 04 phase-1 step 1.1.iv | none (board_id, task_id are not declared FK) | **ADDRESSED**. 2532 rows in prod justify the new undo index |
| S9 | `archive` | Discovery 04 #9 → fork-private | 2.3.d initializer; 6.3 COPY | none | **ADDRESSED**. 188 rows in prod; indexes `idx_archive_board_assignee`, `idx_archive_board_archived_at`, `idx_archive_linked_parent` preserved |
| S10 | `child_board_registrations` | Discovery 04 #10 → fork-private | 2.3.d initializer; 6.3 COPY | `parent_board_id REFERENCES boards(id)` + `child_board_id REFERENCES boards(id)` preserved | **ADDRESSED**. 26 prod rows across 5 parent boards |
| S11 | `subtask_requests` | Discovery 04 #11 → fork-private (engine-defined, not host); spec §143 STAYS for poll loop | 2.3.d initializer; spec §156 confirms keep | none | **ADDRESSED**. 0 prod rows = DEAD CODE (Discovery 19); table preserved for future/redesigned poll-loop usage |
| S12 | `external_contacts` | Discovery 04 #12 → fork-private + new `user_id` column post-cutover (FK to `data/v2.db.users`) | 2.3.d initializer; spec §178 says "keep small `meeting_externals` shape"; `user_id` backfill spec'd as NULL-tolerant | `phone UNIQUE` preserved; new cross-DB `user_id` column has no SQL FK (cross-DB SQLite limitation) | **ADDRESSED** with caveat: prod has 3 rows all `status='active'` (Discovery 04 said "2 in pending"; **PROD-MISMATCH** in detail, doesn't change strategy) |
| S13 | `meeting_external_participants` | Discovery 04 #13 → fork-private; spec §180 says trim columns | 2.3.d initializer; column-trim left to plan refactor | composite PK `(board_id, meeting_task_id, occurrence_scheduled_at, external_id)` preserved | **GAP** — plan does not enumerate which columns to drop. Discovery 04 says "drop columns that today track delivery state" but doesn't list them. Prod has 12 columns; column-level migration is an unplanned sub-task |
| S14 | `attachment_audit_log` | Discovery 04 #14 → fork-private | 2.3.d initializer; 6.3 COPY | `board_id REFERENCES boards(id)` preserved | **ADDRESSED** (DEAD: 0 prod rows; intake protocol DOC-ONLY per audit 14) |
| S15 | `send_message_log` | Discovery 04 #15 → DROP; replaced by v2 session DBs (`outbound.db.messages_out` ⨝ `inbound.db.delivered`) | Plan 2.3.m + 2.3.l reconciliation sweep + 2.3.c `taskflow_send_message_with_audit` wrapper writes a NEW `taskflow_send_message_log` (this is a DIFFERENT table, central) | n/a | **PROD-MISMATCH + GAP**. Plan introduces `taskflow_send_message_log` (new central, pre-queue insert per Discovery 08/09) WHILE dropping v1's `send_message_log` (per Discovery 04). The plan-side coverage is two-tracks: (a) drop v1 table (auditor rewrite, ~200 LOC) + (b) introduce new central audit table. Naming overlap creates confusion. **User review needed** per spec line 144 |
| S16 | WAL mode | Discovery 04 §184 — "WAL + synchronous=NORMAL on taskflow.db" | Plan does NOT explicitly set WAL on the new central taskflow.db; relies on `journal_mode = wal` defaulting from existing prod file | n/a | **GAP** — plan should explicitly set WAL post-init (Phase 1 step 4 of Discovery 04 calls this out; phase A.3.2 plan does not lift it forward) |

### Bonus: surfaced-but-not-in-inventory tables

| ID | Table | Discovery 04? | Plan? | Status |
|---|---|---|---|---|
| S17 | `board_holidays` | yes (#17) | 2.3.d initializer (implied via "14 fork-private tables") | **ADDRESSED** (252 prod rows; 27 ALTER-introduced via engine init) |
| S18 | `board_id_counters` | yes (Q9, #16/14 list) | 2.3.d initializer | **ADDRESSED** (87 prod rows) |
| S19 | `board_chat` (web-UI) | **NO** | **NO** | **GAP — not addressed**. 224 prod rows. Origin appears to be a TaskFlow web-UI surface that drifted into the same DB file. Need owner decision: keep, move to a separate web-UI DB, or drop |
| S20 | `users`/`organizations`/`org_members`/`org_invites`/`otp_requests`/`sessions`/`revoked_tokens` (web-UI auth, 7 tables) | **NO** | **NO** | **GAP — not addressed**. 32 + 2 + 5 + 2 + 0 + 216 + 0 prod rows. These are TaskFlow web-UI's own auth/session tables and **collide by name with v2's `data/v2.db.users` and `data/v2.db.sessions`**. Critical to resolve before centralizing taskflow.db (cross-DB query ambiguity, two `users` tables in two DBs, neither cross-references the other) |
| S21 | `agent_heartbeats` | **NO** | **NO** | **GAP — not addressed**. 0 prod rows. Probably the orchestrator-side agent watchdog. Quiet/dead surface, but exists |
| S22 | `people` | **NO** | **NO** | **GAP — not addressed**. 0 prod rows. Stub table. Likely safe to drop |

These 9 tables (S19-S22 group) account for **9/27 prod tables = 33% of the prod schema** that the migration plan currently doesn't see.

---

## Status counts

- **ADDRESSED:** 11 (S1, S3, S6, S7, S8, S9, S10, S11, S12, S14, S17, S18 — counting bonus correctly: 12)
- **GAP:** 8 (S4, S5, S13, S16, S19, S20, S21, S22) plus 1 partial in S2
- **DEPRECATED-CORRECTLY:** 2 (S2, S15-as-drop-of-v1-table)
- **DEPRECATED-WRONG:** 0
- **PROD-MISMATCH:** 1 (S15: plan introduces a NEW `taskflow_send_message_log` central table while dropping v1's; naming reuse + central vs fork-private split needs explicit reconciliation)

(Total >16 because bonus tables S17-S22 are counted; plan-prompt's 16 features map cleanly onto S1-S16.)

---

## Per-table justifications

### S1 — `boards` (37 prod rows)

Plan correctly puts this in fork-private `taskflow.db`. Prod schema includes 6 columns Discovery 04 didn't enumerate (`org_id`, `name`, `description`, `owner_user_id`, `created_at`, `updated_at`) — these came in via TaskFlow web-UI migrations that drifted into this same DB. The `org_id REFERENCES organizations(id)` FK creates a hard tie to a web-UI table that is itself unaccounted for (S20). The migration must either (a) preserve `organizations` as a peer fork-private table or (b) NULL out `org_id` and drop the FK. Plan doesn't say which.

Index coverage is good: PK on `id`, sqlite auto-index. `parent_board_id` self-FK preserved across the centralization (already there in prod).

### S2 — `board_groups` (2 prod rows; planned drop)

Discovery 04 §74 says replaced by v2's `messaging_group_agents`. The drop is structurally correct: that table provides the same join semantics. **But:** prod has only 2 rows. With 37 boards, that means either (a) most boards' wiring was migrated out long ago into `registered_groups` table in `store/messages.db`, or (b) the table was never populated densely. Either way, the plan needs a confirmation sweep: for each `boards.id`, assert a corresponding row in v2's `messaging_group_agents` (after seed-v2.ts runs) exists. Otherwise migration succeeds while orphaning 35 boards' wiring.

### S3 — `board_config` (28 prod rows)

Trivial. WIP limit + counter columns. Clean fork-private placement. Legacy columns (`next_task_number`, `next_project_number`, `next_recurring_number`) coexist with the newer `board_id_counters` table; Discovery 04 phase 4 says drop them once migration confirmed. Plan does not enumerate this drop step.

### S4 — `board_runtime_config` (28 prod rows; 33 columns)

The most complex single table. 33 columns split:
- 4 active runner_*_task_id columns (standup, digest, review, dst_guard) — but only 3 are used (`runner_dst_guard_task_id` is 0/28 populated per audit 01)
- 6 cron columns (`*_cron_local`, `*_cron_utc`) — only 1 board diverges from default per audit 01
- 6 dst_* columns — all dead per audit 01
- 4 attachment_* columns — active and used per audit 14
- 3 standup/digest/review_target columns — active
- 3 secondary_task_id columns — all 0/28 dead
- 3 locale columns (country/state/city) — populated for some boards
- `cross_board_subtask_mode` — added late, all 28 default to `'open'`

Plan §2.3.d says "1 fork-private DB initializer with 14 tables" but doesn't specify whether the initializer matches prod's 33-column shape or trims dead columns. Audit 01 already flagged the dead-column problem. Discovery 16 §4 (DST non-issue) supports a column-trim. Recommend: explicit migration step that drops `runner_dst_guard_task_id`, `runner_*_secondary_task_id`, `dst_*`, `*_cron_utc` (12 columns total) at cutover, AFTER the 24 zombie scheduled_tasks rows are decommissioned per audit 01 §R7.

### S5 — `board_people` (59 prod rows)

5 fields beyond v2's `agent_group_members` shape (Discovery 04 §83-91): `notification_group_jid`, `wip_limit`, `role` enum, `phone`, `name`. Plan keeps the table but doesn't commit to the two-table-write invariant for live-add (Q4). At 59 prod rows, ~30 of which correspond to actual `board_admins`, the seed path (Phase A.3.6 dry-run) is well-covered. The live-add path (every future `taskflow_add_person` MCP call) is underspecified. Q8 (cross-DB transactional integrity) flagged in Discovery 04 — plan should pick option (a) crash-recovery sweep or (b) move `board_people` into `data/v2.db` for transactional safety. Currently neither is committed.

### S6 — `board_admins` (30 prod rows; planned drop)

Replaced by `user_roles` per `project_v2_user_roles_invariant.md`. Plan §2.3.e implements `seed-board-admins.ts` correctly. Owner-invariant verification (`COUNT(*)=0` for `role='owner' AND agent_group_id IS NOT NULL`) explicitly called out. 

`is_primary_manager` ports into `taskflow_board_admin_meta` extension table per plan §2.3.e. Prod distribution validates Discovery 04's tolerance: 28×1 + 2×0 (the 2 zeros are delegates).

### S7 — `tasks` (356 prod rows; 38 columns)

The heart of TaskFlow. Pure fork-private placement is correct. PK `(board_id, id)`. Soft-FKs to other tasks (`parent_task_id`, `linked_parent_*`) and to people/boards (`assignee`, `child_exec_*`) are all unenforced — engine handles join validity. Indexes preserved from engine init (`idx_tasks_parent`, `idx_tasks_linked_parent`, `idx_tasks_meeting_id`, `idx_tasks_updated_at`).

356 rows × 38 columns × 2532 task_history rows × 188 archive rows × 252 holiday rows = a coherent, well-exercised domain. No real risk for the migration if 2.3.d initializer faithfully ports the column list including the 9 ALTERed columns from engine init.

### S8 — `task_history` (2532 prod rows)

`/undo` 60s window + audit trail. STAYS fork-private per spec §25. Prod has indexes `idx_task_history_board_task` + `idx_task_history_board_at`. Discovery 04 phase-1 step 1.1.iv adds NEW `idx_task_history_undo` on `(board_id, task_id, at)` — plan §2.3.d implies this. Action-name canonicalization (8 doublets per Discovery 19) is plan §2.3.n; an UPDATE migration is committed.

### S9 — `archive` (188 prod rows)

Soft-delete. `task_snapshot` JSON + `history` JSON for forensic restore. PK `(board_id, task_id)`. Indexes `idx_archive_board_assignee`, `idx_archive_board_archived_at`, `idx_archive_linked_parent` all in prod and preserved.

### S10 — `child_board_registrations` (26 prod rows; 5 distinct parents)

Hierarchy edge with person dimension. PK `(parent_board_id, person_id)`. Both FKs to `boards(id)` preserved. Read by `provision-child-board.ts` and the auditor.

### S11 — `subtask_requests` (0 prod rows; DEAD)

Discovery 19 confirms 0 rows = never used in production. Plan §2.3.h port-forwards the `/aprovar` text protocol unchanged (Discovery 10 rejected the `pending_approvals` refactor for 3 reasons). Spec §143 says the table will get re-used as state for a future `schedule_task` poll loop — keeping it costs nothing and unblocks a future feature. Acceptable.

### S12 — `external_contacts` (3 prod rows)

All 3 active (not 2-pending as Discovery 04 said). Phone-only stubs for non-platform users. Plan §2.3.g preserves `dm-routing.ts` with regression test for missing-table NPE. Spec §178 says future `meeting_externals` table can shrink to `(meeting_task_id, external_user_id, status, expires_at)` — that's a forward-looking simplification, not in plan §2.3.

`user_id` column add (cross-DB FK to v2.db.users) is in Discovery 04 but the column ALTER is not enumerated in plan §2.3.d. Either add explicitly or document that NULL is the steady-state until first DM.

### S13 — `meeting_external_participants` (3 prod rows; 12 columns)

Composite PK `(board_id, meeting_task_id, occurrence_scheduled_at, external_id)` is sound. Discovery 04 §144 says "drop columns that today track delivery state (now handled by v2 messages_out/delivered)" but doesn't enumerate which. Looking at prod columns: `invite_status`, `invited_at`, `accepted_at`, `revoked_at` are domain (keep); `access_expires_at` is policy (keep); `created_by`, `created_at`, `updated_at` are bookkeeping (keep). There are no dedicated delivery-state columns to drop — the column-trim claim in Discovery 04 may have been speculative. **Recommend: keep all 12 columns; reject Discovery 04's column-trim suggestion as non-applicable.**

### S14 — `attachment_audit_log` (0 prod rows; DEAD per audit 14)

Schema is fine. Intake protocol is DOC-ONLY (CLAUDE.md) per audit 14. Table is preserved by 2.3.d initializer; no rows to migrate. Acceptable.

### S15 — `send_message_log` (1488 prod rows; in `store/messages.db`, NOT taskflow.db)

Discovery 04 §152 + plan §2.3.m drop the v1 table and rewrite ~200 LOC of Kipp auditor heredoc to query v2 session DBs (`outbound.db.messages_out` ⨝ `inbound.db.delivered`). Plan §2.3.c also introduces a NEW `taskflow_send_message_log` central audit table populated by the `taskflow_send_message_with_audit` wrapper (Discovery 08, 09 — pre-queue insert, reconciled by sweep). The naming overlap is confusing: v1's table is dropped, but plan §2.3.c calls the new one `taskflow_send_message_log` (different schema, different DB, different writer surface). **User review needed before commit** per spec line 144.

The 1488 rows over 19 days = ~78 sends/day = significant cross-board signal. Pre-cutover archive to `data/v1-archive/send_message_log.csv` per Discovery 04 phase-2 step 4 is committed.

### S16 — WAL mode

Prod `journal_mode = wal` for `data/taskflow/taskflow.db`. Discovery 04 phase-1 step 4 says "Apply WAL mode + synchronous=NORMAL on taskflow.db". Plan §2.3.d is silent. The initializer must explicitly `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;` after CREATE TABLE statements. Otherwise a fresh init defaults to DELETE mode and the host-only-writer assumption is unverified.

---

## Top GAPs by ID

- **S4 — `board_runtime_config` zombie columns**: 24 of 33 prod columns are 0/28 populated (DST, secondary, UTC cron). Plan must either drop them in 2.3.d migration or document them as carried-forward dead. Audit 01 §R7/R8 said "DEPRECATED-CORRECTLY but not yet executed".
- **S5 — `board_people` two-table-write invariant**: Q4 + Q8 from Discovery 04 not committed in plan. Live-add path (every `taskflow_add_person` MCP call) needs atomic write to `taskflow.db.board_people` + `data/v2.db.users` + `data/v2.db.agent_group_members`. Crash-recovery sweep on host startup not specified.
- **S13 — `meeting_external_participants` column trim**: Discovery 04 says "drop delivery-state columns" but doesn't list them. Plan does not enumerate.
- **S16 — WAL mode**: not explicitly set by plan post-initializer; relies on inheriting prod file's existing mode.
- **S19-S22 — 9 web-UI tables (`board_chat`, `users`, `organizations`, `org_members`, `org_invites`, `otp_requests`, `sessions`, `revoked_tokens`, `agent_heartbeats`, `people`)**: present in prod `data/taskflow/taskflow.db`, NOT in any inventory. Critical: prod has TWO tables named `users` (one in this DB, one in v2 central `data/v2.db`), TWO named `sessions`. Cross-DB ambiguity under v2 layout. Owner decision required: keep, sidecar to a web-UI DB, or drop.
- **S2 — `board_groups`**: only 2 prod rows out of 28+ expected wiring entries. Drop is correct only if `messaging_group_agents` covers all boards. Sweep not in plan.

---

## Key plan-vs-prod mismatches

1. **Production already centralized**: `data/taskflow/taskflow.db` exists at the destination path the plan describes (Discovery 04 phase 1 says "create"; prod has it at 2.2 MB + 4.0 MB WAL since 2026-04-24). Phase 2 "data migration from v1 per-folder" assumes per-folder taskflow.db files — prod does not have those (the per-folder `data/taskflow/` only contains 0-byte placeholder `sec-secti.db` and `secti-taskflow.db`). **The migration plan's Phase 2 COPY-from-per-folder step is largely a no-op in current prod** — already centralized. Worth confirming in Phase A.3.6 dry-run.
2. **Boards = 37 not 28**: Discovery 04, plan, and spec all reference 28 boards. Prod `boards` row count is 37. The 28 figure is `taskflow_managed=1` boards from `registered_groups`, not `boards`. Migration `seed-board-admins.ts` operates on `board_admins` (30 rows) but the underlying board-set is 37. Plan should disambiguate.
3. **`tasks` 38 columns, not "40+"**: minor, just documentation accuracy.
4. **`external_contacts` all 3 status=active** (not 2-pending as Discovery 04 claimed). Doesn't change strategy.
5. **Plan's "14 fork-private tables" count needs a +9 web-UI footnote** (or explicit exclusion).

---

---

## Cross-cutting risks

1. **Two-DB `users` collision (S20).** Prod has `data/taskflow/taskflow.db.users` (32 rows, web-UI auth) AND v2 ships `data/v2.db.users`. After centralization both live in different files with same name. Cross-DB query ambiguity if anything ever ATTACHes both. Plan does not address.
2. **Cross-DB transactional integrity (Q8).** `board_people` insert needs to write to two DBs atomically. SQLite has no cross-DB transaction. Crash window leaves orphan state. Discovery 04 recommends host-startup reconciliation sweep — plan does not commit.
3. **Migration plan assumes per-folder taskflow.db; prod is already centralized.** Discovery 04 phase-2 COPY step is largely a no-op. Phase A.3.6 dry-run must use a true v1 fixture (not the current centralized prod state) to validate the migration path actually works on a fresh v1 install.
4. **`board_groups` only 2 rows (S2).** Drop-in-favor-of `messaging_group_agents` is correct only if migrate-v2 driver populates `messaging_group_agents` for all 37 boards. If the driver only ports rows that have a matching `board_groups` entry, 35 boards get orphaned wiring.
5. **`taskflow_group_settings` migration ordering.** Sidecar table in `data/v2.db` references `agent_groups(id)`. Migration must run AFTER seed-v2.ts (which creates `agent_groups` rows). Discovery 04 phase-2 step 5 calls this out; plan §2.3.d should enumerate migration ordering explicitly.
6. **Dead-column drift in `board_runtime_config`.** 12 of 33 columns are 0/28 populated and supported by no current feature. Carrying them forward is harmless but accumulates schema cruft. Discovery 04 + audit 01 both flag — plan §2.3.d should commit to drop or carry.
7. **Web-UI surface in prod taskflow.db (S19-S22).** 9 tables, 481 total rows. Belongs to a separate concern from the `add-taskflow` skill. Either (a) extract to `data/taskflow-webui/db.db` sidecar, (b) keep co-located and document them as out-of-skill, or (c) drop if dead. Plan does not surface this.

---

## Open questions for plan-author

- **OQ1 (S15):** What is the final name and DB-location of the new audit table? Plan §2.3.c calls it `taskflow_send_message_log` (host central?); Discovery 04 dropped v1's `send_message_log` (no replacement table, rewrites auditor). The two-track plan needs a single-source-of-truth definition.
- **OQ2 (S5/Q8):** Cross-DB write atomicity for `board_people` ↔ v2 `users` — sweep on startup vs move table into `data/v2.db`?
- **OQ3 (S19-S22):** What happens to the 9 web-UI tables (`board_chat`, `users`, `organizations`, etc.)? Owner decision required.
- **OQ4 (S4):** Drop the 12 zombie columns in `board_runtime_config` at cutover, or carry forward?
- **OQ5 (S2):** Pre-drop sweep verifying `messaging_group_agents` covers all 37 boards.
- **OQ6 (S1):** `boards.org_id REFERENCES organizations(id)` — preserve or NULL out at cutover?

---

## Output

File: `/root/nanoclaw/docs/superpowers/audits/2026-05-03-feature-coverage/16-schema.md`
