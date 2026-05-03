# TaskFlow Table Placement on v2

Decide which v2 SQLite database each TaskFlow private table lands in, based on the v2 architecture published in `docs/db.md`, `docs/db-central.md`, `docs/db-session.md` (upstream `remotes/upstream/v2`) and the v1 schemas in `container/agent-runner/src/taskflow-engine.ts` + `src/taskflow-db.ts`.

## Glossary of v2 destinations

- **`data/v2.db`** — central host-owned admin plane.
  - Identity (`users`, `user_roles`, `agent_group_members`, `user_dms`).
  - Wiring (`agent_groups`, `messaging_groups`, `messaging_group_agents`, `agent_destinations`).
  - Routing/control (`sessions`, `pending_questions`, `pending_approvals`, `pending_sender_approvals`, `unregistered_senders`).
  - Chat SDK state (`chat_sdk_*`).
  - Numbered migrations live at `src/db/migrations/NNN-*.ts`; the schema reference is `src/db/schema.ts`.
  - Single writer: the host's `src/db/*.ts` access layer.
- **`data/v2-sessions/<agent_group_id>/<session_id>/inbound.db`** — host-writes / container-reads.
  - Tables: `messages_in`, `delivered`, `destinations`, `session_routing`.
  - Single writer: host. Container opens read-only.
  - Schema is `INBOUND_SCHEMA` in `src/db/schema.ts`; lazy `IF NOT EXISTS` migrations.
- **`data/v2-sessions/<agent_group_id>/<session_id>/outbound.db`** — container-writes / host-reads.
  - Tables: `messages_out`, `processing_ack`, `session_state`, `container_state`.
  - Single writer: container. Host opens read-only.
  - Schema is `OUTBOUND_SCHEMA` in `src/db/schema.ts`.
- **`data/taskflow/taskflow.db`** (proposed fork-private DB) — host-owned, single SQLite file shared across all TaskFlow boards.
  - Same physical layout as v1 today, just rehomed under `data/taskflow/` instead of per-folder `groups/<folder>/taskflow.db`.
  - Owned end-to-end by the `add-taskflow` skill (skill ships create-table migrations and CRUD MCP tools).
  - Container reads happen via a read-only mount per session, identical to how v1 mounts taskflow.db today.
  - Single writer: the host's TaskFlow MCP service.

The v2 docs explicitly bound the central DB to "identity, permissions, routing, wiring, and group-level config" (db-central.md §3) and the session DBs to "workload/message state" (db.md §3 heuristic) — this matches Codex's finding. TaskFlow domain state (Kanban columns, WIP, undo, archive, holidays, external participants) is neither identity/wiring nor message-workload; it is fork-private app state, which v2 has no opinion on. The right home is a third file under `add-taskflow`'s ownership: `data/taskflow/taskflow.db`. Two tables that ARE wiring/identity-flavored (board↔group mapping, board admin permissions) get reshaped to live in v2 native tables instead. One new table (`taskflow_group_settings`) is genuinely group-level config and lands in `data/v2.db` as a fork-private sidecar.

---

## Per-table decision matrix (17 tables)

| # | Table | Decision | Notes |
|---|-------|----------|-------|
| 1 | `boards` | fork-private `taskflow.db` | Pure TaskFlow domain entity. v2 has `agent_groups` but a board is more granular (one agent_group can host one board today, but the entity is TaskFlow's). |
| 2 | `board_groups` | **Drop — replaced by v2 `messaging_group_agents`** | This is wiring (board ↔ WhatsApp group). v2's `messaging_group_agents` already maps messaging_groups ↔ agent_groups; if board_id ≡ agent_group_id, this table becomes redundant. Keep a fork-private VIEW for backward-compat reads if the engine needs the same shape. |
| 3 | `board_config` | fork-private `taskflow.db` | Per-board WIP limit, columns array, per-prefix counters. Pure domain config. |
| 4 | `board_runtime_config` | fork-private `taskflow.db` | Timezone, cron schedules, runner task IDs (point at v2 `schedule_task` ids), DST state, attachment policy, locale. **Note**: `runner_*_task_id` columns now reference v2 schedule IDs, not v1 `scheduled_tasks.id`. |
| 5 | `board_people` | fork-private `taskflow.db` | TaskFlow team roster (name, phone, role, wip_limit, notification_group_jid). NOT v2 users — these are TaskFlow-domain roster entries; phone here is identity-shaped, but membership in v2 (`agent_group_members`) is granted separately via the seed-board-admins.ts step in the spec. |
| 6 | `board_admins` | **Drop — replaced by v2 `user_roles`** | Per memory `project_v2_user_roles_invariant.md` and the redesign spec (line 24): managers/delegates become `user_roles(user_id, role='admin', agent_group_id=<board>)`. Owner is global only. Migration: extract v1 `board_admins` rows → seed-board-admins.ts INSERTs scoped admin rows. The `is_primary_manager` flag has no v2 analogue and gets dropped. |
| 7 | `tasks` | fork-private `taskflow.db` | 40+ columns, the heart of TaskFlow. Pure domain. |
| 8 | `task_history` | fork-private `taskflow.db` | 60s undo + audit trail. Spec line 25: STAYS fork-private. v2 has no equivalent. |
| 9 | `archive` | fork-private `taskflow.db` | Soft-deleted tasks. Pure domain. |
| 10 | `child_board_registrations` | fork-private `taskflow.db` | Board hierarchy edge table. Relates board_id↔board_id; not wiring in the v2 sense. |
| 11 | `subtask_requests` | fork-private `taskflow.db` | Multi-day cross-board approval queue. Spec line 21+143: STAYS fork-private (v2's `pending_questions` is in-session/transient). DEAD CODE in prod today, but the redesign re-uses it as state table for the `schedule_task` poll loop. |
| 12 | `external_contacts` | fork-private `taskflow.db` | Cross-board external participant directory (3 prod rows). NOT v2 users — these aren't platform-authenticated identities; they are pre-approval phone-only stubs. After the redesign, on first DM the bot uses v2's `unknown_sender_policy='request_approval'` flow which DOES create a v2 user; `external_contacts` becomes a TaskFlow-side projection/cache pointing at the v2 user_id. |
| 13 | `meeting_external_participants` | fork-private `taskflow.db` | Per-meeting access grants (3 prod rows). Joins external_contacts to a specific meeting occurrence. Pure TaskFlow domain. |
| 14 | `attachment_audit_log` | fork-private `taskflow.db` | Per-board attachment import history. Pure domain. |
| 15 | `send_message_log` | **Drop — replaced by v2 session `delivered` + `messages_out`** | v1's send_message_log is read by Kipp auditor to verify delivery. v2 already records every outbound delivery in per-session `outbound.db.messages_out` + `inbound.db.delivered`. The auditor adapts to read those. Cross-session aggregation done by walking session folders or via a fork-private materialized view in `taskflow.db` if join performance demands it. **User review needed** — see open question Q1. |
| 16 | `taskflow_group_settings` (NEW) | central `data/v2.db` via extension table | The 3 fork-private columns from v1 `registered_groups` (`taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth`). These ARE wiring/group-level config and gate v2's `create_agent` MCP tool. Either (a) extend `agent_groups` with these columns via a fork-private migration in `add-taskflow/add/migrations/NNN-taskflow-group-settings.sql`, or (b) sidecar table `taskflow_group_settings(agent_group_id PRIMARY KEY, …)` in `data/v2.db`. **Pick (b)** — keeps v2 core schema untouched, lets the skill own its migration. **User review needed** — confirms spec line 42 and Q4. |
| 17 | `board_holidays` | fork-private `taskflow.db` | Per-board holiday calendar, read by the recurrence engine. Pure domain. |

### Summary by destination

- **fork-private `taskflow.db`**: 12 tables (boards, board_config, board_runtime_config, board_people, tasks, task_history, archive, child_board_registrations, subtask_requests, external_contacts, meeting_external_participants, attachment_audit_log, board_holidays = 13 incl. board_holidays).
- **central `data/v2.db` via fork-private migration (sidecar)**: 1 table (`taskflow_group_settings`).
- **dropped — replaced by v2 native**: 3 tables (`board_groups`, `board_admins`, `send_message_log`).
- **per-session inbound.db**: 0 tables.
- **per-session outbound.db**: 0 tables.

Zero TaskFlow tables go in either session DB. This is by design: TaskFlow is per-board state, not per-conversation/per-message state, and putting any of it in `inbound.db`/`outbound.db` would either explode storage (replicating tasks per session) or violate the single-writer rule (one board has many sessions; only one container can write).

---

## Per-table justifications

For each table the row format below cites: (a) the v1 origin (file:line), (b) the v2 docs convention that motivates the choice, (c) any column-level changes, and (d) the writer surface (host MCP, container engine, or migration only).

### `boards` (1) — fork-private `taskflow.db`
v1 row from `src/taskflow-db.ts:18` carries `id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code, owner_person_id`. After v2, `group_jid`/`group_folder` become FK references to `messaging_groups.id`/`agent_groups.folder` (lookup at read time, not stored — but kept on the row during cutover for migration safety, then dropped in Phase 4). `parent_board_id` self-FK stays. `owner_person_id` references a row in `board_people`, not v2 `users`. Cited convention: db-central.md §3 — "central DB is identity/permissions/wiring"; a board entity is none of those, it's TaskFlow domain. Writer: host MCP only (board create/destroy via slash command).

### `board_groups` (2) — drop
v1 origin: `src/taskflow-db.ts:57`. Maps `(board_id, group_jid, group_folder, group_role)`. v2's `messaging_group_agents` (db-central.md §1.3) provides the same join. v1 row becomes a query: `SELECT mg.platform_id AS group_jid, ag.folder AS group_folder, mga.priority FROM messaging_group_agents mga JOIN messaging_groups mg ON mga.messaging_group_id=mg.id JOIN agent_groups ag ON mga.agent_group_id=ag.id WHERE ag.id = ?`. The `group_role` column ('team' vs 'control') is encoded in v2 by `messaging_groups.is_group` + `messaging_group_agents.engage_mode`/`priority`. Keep a fork-private VIEW `taskflow_board_groups` (in `taskflow.db` via `ATTACH`, or a CTE wrapper in the engine) if the engine query shape needs preservation during cutover. db-central.md explicitly notes "creating a wiring must also populate `agent_destinations`" — meaning v2 already enforces the (board ↔ messaging_group) relationship as a first-class wiring concern, leaving no role for a parallel TaskFlow table.

### `board_config` (3) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:184`. WIP limits (`wip_limit`), custom column ordering (`columns` JSON array), counter state (`next_task_number`, `next_project_number`, `next_recurring_number`, `next_note_id`). None of this is v2 identity/wiring; central DB rejects it on principle (db-central.md §3 heuristic). Stays in `taskflow.db` keyed by `board_id`. Note: legacy `next_*_number` columns are migrated into `board_id_counters` (engine.ts:1269-1289) on engine init; the new universal counter table handles arbitrary prefixes (T/P/R/M/etc.). Both tables coexist during cutover; the legacy columns can be dropped once 28 boards are confirmed migrated. Writer: host MCP only (counter increments via `taskflow_create_task` etc.); never written from container. The single-writer invariant from db.md §1 holds because all writes flow through one host process.

### `board_runtime_config` (4) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:132`, ~30 columns. **Critical column-level migration**: `runner_standup_task_id`, `runner_digest_task_id`, `runner_review_task_id`, `runner_dst_guard_task_id` currently point at v1 `scheduled_tasks.id` (TEXT, fork-private host table). After v2 cutover they point at v2 schedule IDs — specifically the `messages_in.id` of the recurring schedule row inserted by `schedule_task` MCP (db-session.md §2.1, with `recurrence` column populated). The COLUMN type/name doesn't change but the referenced ID-namespace shifts. Also: `cross_board_subtask_mode` (added by ALTER at engine init, line 1198) stays as a TaskFlow domain enum. `attachment_*` columns stay (TaskFlow attachment policy, no v2 equivalent). `dst_*` columns stay (TaskFlow's DST guard runs as a v2 schedule but observability lives here). Locale columns (country/state/city, language, timezone) stay. Pure per-board domain config; secondary index on `(board_id)` already covered by PK. Writer: host MCP (`taskflow_update_runtime_config` tool) on user request, plus host migration code on board create.

### `board_people` (5) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:30`. TaskFlow's roster is richer than v2's `agent_group_members`:

- `notification_group_jid` — per-person notification target (e.g. send-this-person-a-DM-when-X).
- `wip_limit` — per-person WIP override (overrides board_config.wip_limit).
- `role` enum (`team` / `manager` / `delegate`).
- `phone` — canonicalized phone (used by the bot to match incoming WhatsApp `from`).
- `name` — display name (separate from any v2 `users.display_name`).

v2 `agent_group_members` is just `(user_id, agent_group_id, added_by, added_at)` — no domain attributes. Keep `board_people` as the TaskFlow domain roster. On each insert/update, also upsert the corresponding v2 `users` (kind='phone', id=`phone:+...`) + `agent_group_members(user_id, agent_group_id)` so v2's permission gate accepts inbound messages from this person. **Two-table-write invariant** — every `taskflow_add_person` MCP call touches three tables (taskflow.db.board_people + v2.db.users + v2.db.agent_group_members) in one transaction-equivalent flow (SQLite cross-DB requires sequential commits + idempotent retry; document it in the engine).

### `board_admins` (6) — drop, use v2 `user_roles`
v1 origin: `src/taskflow-db.ts:41`. Schema: `(board_id, person_id, phone, admin_role, is_primary_manager)`. Per `project_v2_user_roles_invariant.md` and the redesign spec line 24:

- Every v1 manager + delegate becomes `user_roles(user_id, role='admin', agent_group_id=<board>)`.
- Owner is GLOBAL only — `agent_group_id IS NULL`. NEVER scope an owner row to a board (would violate the invariant verified by `grantRole()` throwing per memory).
- The seed step (Phase 2 step 2) translates v1 rows to v2 rows. Delegate vs. manager distinction lost (both become `role='admin'`); if needed, re-introduce as a `taskflow_admin_meta` sidecar (see Q6).
- The `is_primary_manager` boolean has no v2 home; in practice it was always 1 for the manager and 0 for delegates, so we drop it. The redesign accepts that "primary manager" is whoever holds the admin role first inserted (or, more usefully, whoever the spec's display tooling labels as primary based on `board_runtime_config` metadata if needed).
- v2 cited convention: db-central.md §1.5 — "admin @ A implies membership in A; no `agent_group_members` row required." This means dropping `board_admins` does NOT also require a `agent_group_members` insert for the same person; the role grant carries implicit membership.

### `tasks` (7) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:65`, plus ~9 columns added by ALTER in `taskflow-engine.ts:1170-1176`. Total 40+ columns spanning state machine (`column`, `priority`, `requires_close_approval`), Kanban (`labels`, `blocked_by`, `reminders`), notes/audit (`notes`, `_last_mutation`), recurrence (`recurrence`, `recurrence_anchor`, `current_cycle`, `max_cycles`, `recurrence_end_date`), hierarchy (`parent_task_id`, `subtasks`, `linked_parent_board_id`, `linked_parent_task_id`), child-board execution (`child_exec_*`), and meeting metadata (`participants`, `scheduled_at`). PK `(board_id, id)`. Trying to fit this into v2 central or session DBs would be a category error: it's neither identity/wiring nor message-workload. Stays in `taskflow.db`. Index `idx_tasks_parent` and `idx_tasks_linked_parent` both stay (engine.ts:1178, 1181). Writer: host MCP (every task-mutation tool); reads are heavy and benefit from the local SQLite mount.

### `task_history` (8) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:106`. Backs the 60-second `/undo` window AND the long-term audit trail (`trigger_turn_id` column links audit entries to agent turns for forensics). v2 has no audit-log primitive. Spec line 25 confirms STAYS fork-private. Heavy write volume (every mutation) — fits the local-to-engine SQLite model. Index by `(board_id, task_id, at)` recommended for the undo lookup; current schema doesn't have it, can be added in the migration. Writer: host MCP (every mutation tool emits a history row in the same transaction). Read paths: `/undo` MCP tool (60s window query), Kipp auditor (timestamped reads), digest renderer.

### `archive` (9) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:117`. Soft-delete pattern: same shape as `tasks` plus `archive_reason` (completed/cancelled/duplicate/etc.) + `task_snapshot` (full JSON of task at archive time) + `history` (JSON of all task_history rows for forensic restore). PK `(board_id, task_id)`. Index `idx_archive_linked_parent` (engine.ts:1182) supports cross-board lookup. Pure domain. Writer: host MCP only (archive tool moves a row from `tasks` to `archive` in a single transaction, then deletes from tasks; engine retains capability to "unarchive" by reverse path).

### `child_board_registrations` (10) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:50`. Hierarchy: `(parent_board_id, person_id, child_board_id)` — meaning "this person on the parent board owns this child board". Hierarchy is a TaskFlow concept, not v2 wiring (v2 wiring is messaging_group ↔ agent_group, not board ↔ board). Stays in `taskflow.db`. Read by `provision-child-board.ts` and the auditor. Note `boards.parent_board_id` self-FK already encodes the parent→child edge; this table adds the `person_id` dimension (which manager owns it). Writer: host MCP (`provision-child-board` tool).

### `subtask_requests` (11) — fork-private `taskflow.db`
v1 origin: `container/agent-runner/src/taskflow-engine.ts:1246`. Schema: `(request_id PK, source_board_id, target_board_id, parent_task_id, subtasks_json, requested_by, requested_by_person_id, status, resolved_by, resolved_at, reason, created_at, created_subtask_ids)`. Multi-day cross-board approval. Spec line 143: WORKFLOW driven via v2 `schedule_task` + `ask_user_question`, but the TABLE stays fork-private because:

- v2's `pending_questions` is transient (per-session, deleted on answer per db-central.md §1.9).
- `subtask_requests` survives container restarts AND outlives sessions.
- It carries TaskFlow-specific metadata (which task forwarded, which mutation it represents) that wouldn't fit in v2's generic `pending_questions`.
- The `schedule_task` poll loop (re-asks via `ask_user_question` until answered) reads/writes to this table on every cycle.

Pure TaskFlow workflow state. DEAD CODE in prod today (no rows), but the redesign re-uses the table as the state store for the new poll-based approval flow. Writer: host MCP (`taskflow_request_subtask_approval` and `taskflow_handle_subtask_approval` tools).

### `external_contacts` (12) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:201`. Schema: `(external_id PK, display_name, phone UNIQUE, direct_chat_jid, status, created_at, updated_at, last_seen_at)`. Pre-approval external phone directory.

- v2's `users` table requires a namespaced identity (`phone:+...`); upon first DM, v2's `unknown_sender_policy='request_approval'` flow creates the v2 user.
- `external_contacts` keeps the TaskFlow-specific fields (display_name set during board operator's planning before any v2 user existed; status enum `active`/`pending`/`revoked`; `last_seen_at` for stale-contact pruning; `direct_chat_jid` cache to avoid re-resolving the JID on every meeting invite).
- After redesign: add `external_contacts.user_id` column pointing at v2 `users.id` once the approval lands. NULL means "we have a phone but no v2 identity yet."
- Cross-board scope: NO `board_id` column — same external participant can be in meetings across multiple boards.

**Migration risk**: 3 prod rows; 2 of which never had a real DM sent (still in `pending` status). Acceptable to backfill `user_id=NULL` and let it populate naturally on first delivery. Writer: host MCP (`taskflow_invite_external` tool); v2's `request_approval` admin-card flow runs orthogonally and writes to v2.db.users + v2.db.user_dms.

### `meeting_external_participants` (13) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:212`. Per-meeting per-occurrence access grant. PK is `(board_id, meeting_task_id, occurrence_scheduled_at, external_id)` — TaskFlow domain shape, no v2 analogue.

- Tracks invite_status (`pending`/`accepted`/`revoked`/`expired`).
- Tracks access_expires_at for time-bounded participation (e.g. only allow participation during the 1-hour meeting window).
- 3 prod rows.

After redesign (spec line 180), the column shape simplifies because v2 owns the message routing:

- Drop columns that today track delivery state (now handled by v2 messages_out/delivered).
- Keep just `(meeting_task_id, external_user_id, status, expires_at)` plus board scope.

Pure TaskFlow domain. Writer: host MCP (`taskflow_invite_to_meeting` tool); read by the meeting digest renderer + the dm-routing replacement that decides whether to forward an external participant's DM into this board's session.

### `attachment_audit_log` (14) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:167`. Records every attachment import with `(board_id, source, filename, at, actor_person_id, affected_task_refs)`. v2's per-session `inbox/<message_id>/` directory holds the raw attachment bytes (db-session.md §1) but does NOT track domain-level "this attachment was imported into board X by person Y and updated tasks T1, T2". That bookkeeping is TaskFlow-specific. Stays in `taskflow.db`. Writer: host MCP (`taskflow_import_attachment` tool); reads by daily digest renderer.

### `send_message_log` (15) — drop, use v2 session DBs
v1 origin: `src/db.ts:83`. The Kipp auditor's reason-for-existence: "did the manager actually receive the DM?" In v2 this is provable from `outbound.db.messages_out` (agent decided to send; container is sole writer per db-session.md §4.1) + `inbound.db.delivered` (host confirmed delivery, `markDelivered()` per db-session.md §2.2). Auditor heredoc reads those instead. **Cross-cutting risk**: the auditor today queries `send_message_log` keyed by `source_group_folder` + time window; in v2 it has to walk multiple session folders to aggregate across boards. Either (a) auditor walks each board's `outbound.db` directly (one open per session id under `data/v2-sessions/<agent_group_id>/<session_id>/outbound.db`), or (b) we add a fork-private materialized cache in `taskflow.db.audit_send_log` populated by host sweep on each `markDelivered()`. **Pick (a)** for simplicity unless join cost proves prohibitive. The trigger_* columns (trigger_message_id/trigger_chat_jid/trigger_sender) that link an outbound to its triggering inbound are recoverable in v2 via `messages_out.in_reply_to` → `messages_in.id`. **User review needed** — see Q1.

### `taskflow_group_settings` (16) — central `data/v2.db`, sidecar table
The 3 fork-private columns from v1 `registered_groups` (`taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth`) gate v2's `create_agent` MCP tool — they are GROUP-LEVEL CONFIG that v2's wiring code reads at request time. Per Codex finding "central DB holds group-level config", they live in `data/v2.db`. **Sidecar table** instead of altering `agent_groups` to keep upstream's schema clean and keep the columns owned by the skill's migration:

```sql
CREATE TABLE taskflow_group_settings (
  agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
  taskflow_managed INTEGER NOT NULL DEFAULT 0,
  taskflow_hierarchy_level INTEGER,
  taskflow_max_depth INTEGER
);
```

Skill ships migration `add-taskflow/add/migrations/NNN-taskflow-group-settings.sql` that runs after upstream migrations. The `canUseCreateGroup` permission check JOINs against this table.

### `board_holidays` (17) — fork-private `taskflow.db`
v1 origin: `src/taskflow-db.ts:177` (also re-created with same shape in engine.ts:1185 — the engine init duplicates the host migration; both are idempotent `CREATE TABLE IF NOT EXISTS`). Per-board holiday calendar `(board_id, holiday_date, label)`, queried by the recurrence engine on every "next occurrence" calculation (engine.ts:1076). Pure domain. Stays in `taskflow.db`. Writer: host MCP (`taskflow_set_holidays` tool, plus a one-time seed during board provisioning that pulls federal+state Brazilian holidays based on `board_runtime_config.country/state/city`).

---

## Migration strategy

### Phase 1 — Schema setup on a clean v2 install (skill apply)

1. Skill's `add/migrations/001-create-taskflow-db.sql` creates `data/taskflow/taskflow.db` with all 14 fork-private tables (the list in the summary table). Indexes:
   - `idx_tasks_parent` on `tasks(board_id, parent_task_id) WHERE parent_task_id IS NOT NULL`.
   - `idx_tasks_linked_parent` on `tasks(board_id, linked_parent_board_id, linked_parent_task_id) WHERE linked_parent_board_id IS NOT NULL`.
   - `idx_archive_linked_parent` on `archive(board_id, linked_parent_board_id, linked_parent_task_id)`.
   - `idx_task_history_undo` on `task_history(board_id, task_id, at)` (NEW; supports the 60s undo lookup; not in v1).
2. Skill's `add/migrations/002-taskflow-group-settings.sql` runs against `data/v2.db` to create the sidecar table. Marker row in v2's `schema_version` to make the migration idempotent and visible to operators (using a high version number that doesn't collide with upstream — e.g. `200` since upstream is at 9).
3. Container runner mounts `data/taskflow/taskflow.db` as a per-session read-only mount (matches v1 today). Writes go through host-side TaskFlow MCP tools, NOT direct container writes.
4. Apply WAL mode + `synchronous=NORMAL` on `taskflow.db` for write performance (host is sole writer, container is read-only, so WAL is safe per db.md §4 reasoning).

### Phase 2 — Data migration from v1 (28 prod boards)

For each v1 group folder:

1. Copy v1 `groups/<folder>/taskflow.db` rows into the new central `data/taskflow/taskflow.db` (renaming nothing; FKs already match). Tables copied verbatim: `boards`, `board_config`, `board_runtime_config`, `board_people`, `tasks`, `task_history`, `archive`, `child_board_registrations`, `subtask_requests`, `external_contacts`, `meeting_external_participants`, `attachment_audit_log`, `board_holidays`, `board_id_counters`. Each row already keyed by `board_id`, so 28 boards merge into one DB without conflict.
2. For `board_admins`: read v1 rows → INSERT v2 `users` (kind='phone', namespaced id `phone:+...`) + `user_roles(role='admin', agent_group_id=<board>)` per `project_v2_user_roles_invariant.md`. NEVER `role='owner'` for board admins. Emit warning if `is_primary_manager=1` for more than one row per board (v1 invariant violation).
3. For `board_groups`: no-op for the table itself (dropped); v2's `messaging_group_agents` is populated by `setup/migrate/seed-v2.ts` (already exists upstream — verified at `setup/migrate/seed-v2.ts:1`). The TaskFlow seed step verifies that for each v1 board there's a matching `messaging_group_agents` row and warns if missing.
4. For `send_message_log`: discarded. Auditor adapts to read v2 session DBs from cutover date forward. Pre-cutover audit history archived to `data/v1-archive/send_message_log.csv` for read-only forensics.
5. For `taskflow_group_settings`: read v1 `registered_groups.taskflow_managed/hierarchy_level/max_depth` → INSERT into `data/v2.db.taskflow_group_settings` keyed by the agent_group_id created in seed-v2.ts. Migration order matters: must run AFTER seed-v2.ts, BEFORE any TaskFlow MCP tool starts gating on the columns.

### Phase 3 — Cutover

- Engine `taskflow-engine.ts` updates SQL paths from `${groupDir}/taskflow.db` to `${dataDir}/taskflow/taskflow.db`. Single shared DB; rows already keyed by `board_id` so no schema change.
- Single-writer concern resolved: only the host's TaskFlow MCP service writes; container reads through MCP, not direct SQLite. (v1 had each container writing to its OWN per-folder taskflow.db; centralizing in `data/taskflow/taskflow.db` requires moving ALL writes to the host. This is the bigger Q3 risk.)
- Auditor heredoc updated to query v2 session DBs instead of `send_message_log`. The query shape changes from `SELECT … FROM send_message_log WHERE source_group_folder=?` to a directory walk: `for each $session in data/v2-sessions/<board>/*/outbound.db: SELECT … FROM messages_out`.
- Operator-facing CLI commands (`taskflow-cli.ts` if any) updated to point at the new paths.

### Phase 4 — Drop v1 cruft

- Drop `data/groups/<folder>/taskflow.db` files (now empty after Phase 2).
- Drop v1 `send_message_log` table (queries adapted in Phase 3).
- Drop v1 `board_groups` table (replaced by `messaging_group_agents` queries).
- Drop v1 `board_admins` table (replaced by `user_roles` queries).
- Drop legacy counter columns from `board_config` once `board_id_counters` is the only counter source (engine init at line 1269+ already does the migration; just delete the column reads).
- Drop the 3 fork-private columns from v1's `registered_groups` (`taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth`) — moved to `taskflow_group_settings`.
- Update `add-taskflow/SKILL.md` to reflect new paths and remove v1-only INSERT examples.

---

## Cross-cutting risks

1. **Container writer count**. v1 had each board's container writing directly to its OWN `taskflow.db` (per-folder). Moving to a SHARED `data/taskflow/taskflow.db` requires ALL writes to go through host MCP. Direct container writes break the single-writer invariant. The redesign spec already moves this direction (host-side MCP tools, line 28+). Verify in the executable plan that NO engine code path writes SQL directly from the container.
2. **Cross-mount visibility**. Per db.md §4, `journal_mode = DELETE` and open-write-close on the host. `data/taskflow/taskflow.db` MUST follow the same rules: either WAL with the host as sole writer (no cross-mount visibility issue because container only reads), OR DELETE mode if any container ever opens it for write. With host-only writes via MCP, WAL is fine.
3. **Auditor cross-session aggregation cost**. Walking N session folders' outbound.db files for a daily audit could be slow at 28 boards × M sessions/day. If profiling shows >2s, materialize into `taskflow.db.audit_send_log_cache` from a host sweep job.
4. **`taskflow_group_settings` migration coupling**. The sidecar table's `agent_group_id` PK references `agent_groups(id)`, but the seed-v2.ts inserts agent_groups before our skill's migration runs. Migration ordering must put taskflow_group_settings AFTER seed-v2 backfill of agent_groups, OR we tolerate a missing FK row at first read (NULL → behave as `taskflow_managed=0`).
5. **`external_contacts.user_id` backfill**. After redesign the column references v2 `users.id` post-approval. The 3 prod rows may sit with NULL user_id until first DM lands. Document NULL semantics in the engine code.

---

## Open questions

**Q1 — Auditor read path for `send_message_log` replacement.** Walk per-session `outbound.db` files OR materialize into a host-maintained cache in `taskflow.db`? Decision affects ~200 LOC of auditor heredoc and the host sweep. Recommend (a) walk-on-read; revisit if profile shows >2s.

**Q2 — `taskflow_group_settings` location: sidecar in `data/v2.db` vs ALTER `agent_groups`.** Recommend SIDECAR (skill owns its migration; upstream schema untouched). Need user confirmation per spec §Q4 (line 353).

**Q3 — Container write path for `taskflow.db`**. Today multiple containers write to per-folder taskflow.db via direct SQLite. The redesign assumes host-only writes through MCP. Confirms the spec (lines 28+, "thin layer of TaskFlow domain code on top of v2 primitives") but the executable plan needs to enumerate every direct-SQL-write call site in `container/agent-runner/src/taskflow-engine.ts` and convert it to an MCP tool call. ~30 call sites estimated.

**Q4 — `board_people` ↔ v2 `users` sync invariant**. When TaskFlow inserts a board_people row, does it also insert v2 `users` + `agent_group_members`? Recommend YES (atomic two-table write in the same MCP call), otherwise unprivileged messages from that person get rejected by v2's sender policy. Spec line 111 hints at this but doesn't enumerate the live-add path (only the cutover seed path).

**Q5 — `subtask_requests` location: same `taskflow.db` or its own DB?** It's the only non-board-keyed fork-private table (rows have source_board_id + target_board_id but the PK is request_id). Putting it in the same `taskflow.db` is fine (the engine already does cross-board reads). No reason to split.

**Q6 — `is_primary_manager` drop tolerance**. v1 has this boolean on `board_admins`. v2 mapping has no place for it. Confirm with user that "primary manager == whoever holds the admin role first inserted" is acceptable, OR add a fork-private `taskflow_admin_meta(user_id, agent_group_id, is_primary)` table. Recommend DROP unless any feature depends on it (none found in code search).

**Q7 — `board_holidays` is a per-board calendar, but most Brazilian boards share the same federal/state holidays.** Worth deduping into a (country, state, city) → holidays-list lookup separately? Out of scope for this placement decision; keep current per-board shape.

**Q8 — Cross-DB transactional integrity for the two-table-write invariants (board_people↔users+members, board_admins-equiv↔user_roles).** SQLite has no cross-DB transaction. The atomic-write pattern is: BEGIN on taskflow.db, INSERT, COMMIT, then BEGIN on v2.db, INSERT, COMMIT. A crash between the two commits leaves orphaned state. Mitigation:

- (a) Crash-recovery sweep on host startup that reconciles the two DBs (e.g. for every board_people row, ensure v2 users row exists; for every v2 admin role row, ensure board_admins-equiv exists if we keep one).
- (b) Same-DB design: move `board_people` into `data/v2.db` as a fork-private sidecar so the user+person+member insert is one transaction.
- Recommend (a) for now; (b) is bigger surgery and the sweep is cheap.

**Q9 — `board_id_counters` not in the request list but exists in the v1 schema.** It's the per-prefix universal counter introduced by engine.ts:1202 to replace the legacy per-column counters in `board_config`. Decision: ALSO fork-private `taskflow.db` (same reasoning as `board_config`). Mention here for completeness — total fork-private tables is then 14, not 13.

---

## Summary table — final placements

| Destination | Count | Tables |
|-------------|-------|--------|
| `data/taskflow/taskflow.db` | 14 | boards, board_config, board_runtime_config, board_people, tasks, task_history, archive, child_board_registrations, subtask_requests, external_contacts, meeting_external_participants, attachment_audit_log, board_holidays, board_id_counters |
| `data/v2.db` (fork-private sidecar via skill migration) | 1 | taskflow_group_settings |
| Dropped — replaced by v2 native | 3 | board_groups (→ messaging_group_agents), board_admins (→ user_roles), send_message_log (→ outbound.db.messages_out + inbound.db.delivered) |
| Per-session `inbound.db` | 0 | — |
| Per-session `outbound.db` | 0 | — |

**Decisions worth user review (high-impact):**

1. **`send_message_log` drop** — auditor rewrite touches ~200 LOC. Confirm no off-engine consumers.
2. **`taskflow_group_settings` sidecar in `data/v2.db`** — alternative is altering `agent_groups` directly (cleaner but invades upstream's schema namespace).
3. **`is_primary_manager` drop** — v1 has it; v2 has no place. Confirm no operator workflow depends on it.
4. **Container write path elimination** — every direct SQL write from container to taskflow.db must become an MCP tool call. ~30 call sites; sizable refactor in `taskflow-engine.ts`.
5. **`external_contacts` migration of 3 prod rows** — leave NULL user_id and backfill on first DM, vs. proactively run the v2 request_approval flow for each.

---

## References

- Upstream v2 docs: `git show remotes/upstream/v2:docs/db.md`, `db-central.md`, `db-session.md`.
- Upstream v2 schema: `git show remotes/upstream/v2:src/db/schema.ts`.
- v1 fork host schema: `/root/nanoclaw/src/db.ts`, `/root/nanoclaw/src/taskflow-db.ts`.
- v1 fork engine schema: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:1100-1300`.
- v2 seed-from-v1 logic: `git show remotes/upstream/migrate/v1-to-v2:setup/migrate/seed-v2.ts`.
- Redesign spec: `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`.
- Memory: `project_v2_user_roles_invariant.md`, `feedback_use_v2_natives_dont_duplicate.md`, `feedback_no_nanoclaw_codebase_changes.md`.
