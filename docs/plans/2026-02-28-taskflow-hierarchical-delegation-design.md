# TaskFlow — Bounded-Recursive Hierarchy Design (SQLite)

**Date**: 2026-02-28
**Status**: Implemented (active SQLite storage/model baseline; hierarchy semantics included)

## Transition Note

This document defines the active SQLite-backed TaskFlow storage and board model. The same shared SQLite structures are the persistence baseline for all TaskFlow topologies; hierarchy mode adds bounded-recursive child-board registration and rollup rules on top of that shared model.

## Summary

This document defines the shared SQLite TaskFlow board model and the bounded-recursive hierarchy rules used when hierarchy is enabled:

- one root board (level 1)
- one persistent board per person at each subsequent level
- rollup is adjacent only: each level reads only its direct children
- the depth limit is a configuration variable (`max_depth`), not a code change

All board data lives in a shared SQLite database accessed through `mcp-server-sqlite-npx` (Node.js port of the official MCP SQLite reference server). This eliminates the cross-board read problem entirely — any board can query any other board's data via SQL. Authorization is prompt-enforced, consistent with how TaskFlow enforces all other rules. Standard boards use the same storage model without child-board rollup.

The assistant is modeled as a direct root-level role by default, not as a separate tier.

The shared SQLite model preserves the existing TaskFlow v2 feature set for all boards: manager/delegate authorization, per-person WIP overrides, attachment intake policy + audit trail, reminders, dependencies, statistics, changelog/history views, and the existing standup/digest/review (+ optional DST guard) runner model. Hierarchy commands are additive on boards that enable child-board delegation.

Hierarchy mode depends on a small set of already-implemented NanoClaw runtime support changes (registered-group metadata, IPC authorization, and container context plumbing). Beyond that support layer, the TaskFlow board behavior remains template-driven. The SQLite MCP server is an existing package configured during setup.

The core rule: **each person governs their own board, rollup crosses only one level at a time, and the depth limit is a configuration variable.**

## Why SQLite

| Concern | JSON files | SQLite + MCP |
|---------|-----------|--------------|
| Cross-board reads | Only main group can read other groups' files | Any agent queries any board via SQL |
| Rollup computation | Parse JSON, filter in-prompt | SQL query |
| Concurrent access | File locking | SQLite WAL mode |
| Statistics (F14) | Parse TASKS.json + ARCHIVE.json in-prompt | `SELECT COUNT(*) ... GROUP BY` |
| Data integrity | Agent edits JSON directly (can corrupt) | Structured writes via SQL |
| Hierarchy complexity | Root-mediated cascading refresh | Each board refreshes independently |
| Source code changes | None | Small support layer already in place; no additional hierarchy logic in `src/` after that |

## Primary Operating Model

### Generic Level Structure

At any level in the hierarchy:

- the board owner assigns deliverables to people registered in `child_boards`
- each assignee with a child board can coordinate their own subordinates
- rollup flows upward one level at a time — each board queries its child board's data directly
- the board owner controls final approval for commitments at that level

### Example: 4-Level Organization

| Level | Role | Board ID |
|-------|------|----------|
| 1 | CEO | `ceo-board` |
| 2 | VP Operations | `vp-ops-board` |
| 2 | VP Engineering | `vp-eng-board` |
| 3 | Manager Marina (under VP Eng) | `mgr-marina-board` |
| 3 | Manager Lucas (under VP Eng) | `mgr-lucas-board` |
| 4 | Team Lead Carlos (under Marina) | `lead-carlos-board` |

Setting `max_depth: 3` caps the hierarchy at 3 levels. Setting `max_depth: 4` extends it. No template or `taskflow.db` schema changes are required, but existing hierarchy groups must have their `registered_groups.taskflow_max_depth` metadata updated to the new limit.

## Assistant Model

The assistant is a direct root-level role.

Default behavior:

- the assistant is registered on the root board as a normal assignee
- the assistant may receive root-level tasks directly
- the assistant does not introduce a structural layer

Optional later expansion:

- if the assistant accumulates enough operational load, they may receive a dedicated board at level 2
- that is an operational variation, not a structural change

## Core Invariants

- Every task at each level has one accountable owner.
- Each board has its own local managers, delegates, people, WIP, and tasks.
- Rollup is adjacent only: level N reads only level N+1.
- No level may silently mutate non-adjacent boards.
- Final business approval stays at the level where the commitment was made.
- `hierarchy_level` must never exceed `max_depth`.
- The same data model, commands, and rollup logic apply at every level.
- All data lives in one shared SQLite database.
- Authorization is prompt-enforced (same pattern as all other TaskFlow rules).

## Goals

- Support arbitrary bounded organizational depth through configuration
- Give each person a real board for their own layer
- Keep higher boards focused on commitments, not operational noise from below
- Keep cross-board rollup compact, predictable, and adjacent-only
- Preserve strict separation of authority by level
- Reuse the existing TaskFlow board model
- Make adding or removing a layer a configuration change, not a redesign
- Minimal NanoClaw source changes (infrastructure only — routing, mounts, IPC plugins already done)

## Non-Goals

- No unbounded recursion (depth is always capped by `max_depth`)
- No automatic or implicit board creation (boards are created only via explicit operator-assisted provisioning commands)
- No mirrored child task lists across levels
- No automatic shared admin rights across levels
- No skipping levels in normal workflow
- No custom MCP server — use `mcp-server-sqlite-npx` (existing Node.js package)

## Architecture

### Storage: Shared SQLite Database

All boards share a single SQLite database at `data/taskflow/taskflow.db`. The database is mounted into each agent container. The `mcp-server-sqlite-npx` package provides `read_query`, `write_query`, `create_table`, `list_tables`, and `describe_table` tools to the agent. NanoClaw already uses `better-sqlite3` on the host side — the setup wizard reuses it to create and seed `data/taskflow/taskflow.db`.

Every agent can read any board's data. Authorization is prompt-enforced: the CLAUDE.md.template instructs each board's agent which boards it may query (its own board + registered child boards for rollup).

This is the same authorization model TaskFlow already uses for permissions, WIP limits, and column rules — all prompt-enforced, not code-enforced.

### Board Topology

Example for a 4-level org:

- `ceo-board` (level 1, root)
- `vp-ops-board` (level 2, child of root)
- `vp-eng-board` (level 2, child of root)
- `mgr-marina-board` (level 3, child of vp-eng)
- `mgr-lucas-board` (level 3, child of vp-eng)
- `lead-carlos-board` (level 4, child of mgr-marina)

Each board has its own:

- `groups/<folder>/CLAUDE.md` (generated from template with board-specific context)
- Standup/digest/review runners (+ optional DST guard), with scheduled task IDs and cron config stored in SQLite
- Data in the shared `taskflow.db`

### Provisioning Model

Boards are provisioned through the existing TaskFlow setup/operator workflow, even in hierarchy mode:

1. **Root board**: created during initial setup (operator runs `/add-taskflow` with hierarchy mode). This creates the database, configures the MCP server, generates the root board's `CLAUDE.md`, registers the group, and schedules the runners.
2. **Child-board request**: a board owner may request `criar quadro para [pessoa]` from their own board, but this is a provisioning request, not an unrestricted cross-group mutation.
3. **Operator/main-context completion**: the actual child-board provisioning is completed by the setup/operator flow (or equivalent main-context automation). Group creation uses the `create_group` IPC plugin (no service stop required) or the direct Baileys approach. Group registration, CLAUDE generation, and scheduler writes use the approved TaskFlow setup path.
4. **Deeper levels**: the same request + operator completion pattern repeats at each level down to `max_depth`.

This preserves the original TaskFlow operational constraints while still allowing hierarchy growth on demand.

#### Board creation flow

1. The board owner requests `criar quadro para [pessoa]` from their own board (or the operator chooses to provision directly).
2. The setup/operator flow creates the subordinate's WhatsApp group via the `create_group` IPC plugin (recommended — no service stop) or direct Baileys API, then performs the required group registration using the same setup-time permissions as standard TaskFlow.
3. The setup/operator flow writes the new group's `registered_groups` row with explicit TaskFlow metadata using the same direct SQLite setup pattern as standard TaskFlow: `taskflow_managed = true`, `taskflow_hierarchy_level = parent_runtime_level + 1`, and `taskflow_max_depth = max_depth`. Equivalent approved operator automation may wrap this write, but the persisted row is the source of truth. Runtime authorization is stricter than a simple `level < max_depth` check: child creation is allowed only when creating one more level would still stay inside the configured tree (`current runtime level + 1 < taskflow_max_depth`). Missing or invalid depth metadata must fail provisioning, not fall back to unlimited depth.
4. The setup/operator flow INSERTs into `boards`, `child_board_registrations`, `board_config`, `board_runtime_config`, `board_admins`, and `board_people`. The child board owner must always have a `board_people` row on their own board even if they will only act as a manager there, because sender identification and admin authorization read from the active people store as well as the admin store.
5. The setup/operator flow generates the `CLAUDE.md` for the new group from the hierarchy template.
6. The setup/operator flow schedules standup/digest/review runners (and optional DST guard), then stores their scheduled task IDs in `board_runtime_config`.

The child board becomes operational only after registration, template generation, and runner scheduling are complete.
Legacy TaskFlow groups that were only detected from old board files must be backfilled by updating their existing `registered_groups` row with explicit `taskflow_hierarchy_level` and `taskflow_max_depth` metadata before they may create further descendants.

### Cross-Board Reads

Any board can query any other board's data via SQL. The template instructs:

- a board may query its own data freely
- a board may query registered child boards for rollup
- a board must not query sibling boards, grandchild boards, or parent board task lists

This is softer than filesystem-level isolation but matches the existing TaskFlow authorization model.

## Database Schema

```sql
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  group_jid TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  board_role TEXT DEFAULT 'standard',
  hierarchy_level INTEGER,
  max_depth INTEGER,
  parent_board_id TEXT REFERENCES boards(id)
);

CREATE TABLE board_people (
  board_id TEXT REFERENCES boards(id),
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT DEFAULT 'member',
  wip_limit INTEGER,
  PRIMARY KEY (board_id, person_id)
);

CREATE TABLE board_admins (
  board_id TEXT REFERENCES boards(id),
  person_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  admin_role TEXT NOT NULL,
  is_primary_manager INTEGER DEFAULT 0,
  PRIMARY KEY (board_id, person_id, admin_role)
);

CREATE TABLE child_board_registrations (
  parent_board_id TEXT REFERENCES boards(id),
  person_id TEXT NOT NULL,
  child_board_id TEXT REFERENCES boards(id),
  PRIMARY KEY (parent_board_id, person_id)
);

CREATE TABLE tasks (
  id TEXT NOT NULL,
  board_id TEXT NOT NULL REFERENCES boards(id),
  type TEXT NOT NULL DEFAULT 'simple',
  title TEXT NOT NULL,
  assignee TEXT,
  next_action TEXT,
  waiting_for TEXT,
  column TEXT DEFAULT 'inbox',
  priority TEXT,
  due_date TEXT,
  description TEXT,
  labels TEXT DEFAULT '[]',
  blocked_by TEXT DEFAULT '[]',
  reminders TEXT DEFAULT '[]',
  next_note_id INTEGER DEFAULT 1,
  notes TEXT DEFAULT '[]',
  _last_mutation TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- hierarchy: child execution
  child_exec_enabled INTEGER DEFAULT 0,
  child_exec_board_id TEXT,
  child_exec_person_id TEXT,
  child_exec_rollup_status TEXT,
  child_exec_last_rollup_at TEXT,
  child_exec_last_rollup_summary TEXT,
  -- hierarchy: parent reference
  linked_parent_board_id TEXT,
  linked_parent_task_id TEXT,
  -- project fields
  subtasks TEXT,
  -- recurring fields
  recurrence TEXT,
  current_cycle TEXT,
  PRIMARY KEY (board_id, id)
);

CREATE TABLE task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  by TEXT,
  at TEXT NOT NULL,
  details TEXT
);

CREATE TABLE archive (
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  assignee TEXT,
  archive_reason TEXT NOT NULL,
  linked_parent_board_id TEXT,
  linked_parent_task_id TEXT,
  archived_at TEXT NOT NULL,
  task_snapshot TEXT NOT NULL,
  history TEXT,
  PRIMARY KEY (board_id, task_id)
);

CREATE TABLE board_runtime_config (
  board_id TEXT PRIMARY KEY REFERENCES boards(id),
  language TEXT NOT NULL DEFAULT 'pt-BR',
  timezone TEXT NOT NULL DEFAULT 'America/Fortaleza',
  runner_standup_task_id TEXT,
  runner_digest_task_id TEXT,
  runner_review_task_id TEXT,
  runner_dst_guard_task_id TEXT,
  standup_cron_local TEXT,
  digest_cron_local TEXT,
  review_cron_local TEXT,
  standup_cron_utc TEXT,
  digest_cron_utc TEXT,
  review_cron_utc TEXT,
  dst_sync_enabled INTEGER DEFAULT 0,
  dst_last_offset_minutes INTEGER,
  dst_last_synced_at TEXT,
  dst_resync_count_24h INTEGER DEFAULT 0,
  dst_resync_window_started_at TEXT,
  attachment_enabled INTEGER DEFAULT 1,
  attachment_disabled_reason TEXT DEFAULT '',
  attachment_allowed_formats TEXT DEFAULT '["pdf","jpg","png"]',
  attachment_max_size_bytes INTEGER DEFAULT 10485760
);

CREATE TABLE attachment_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id),
  source TEXT NOT NULL,
  filename TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_person_id TEXT,
  affected_task_refs TEXT DEFAULT '[]'
);

CREATE TABLE board_config (
  board_id TEXT PRIMARY KEY REFERENCES boards(id),
  columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]',
  wip_limit INTEGER DEFAULT 5,
  next_task_number INTEGER DEFAULT 1,
  next_project_number INTEGER DEFAULT 1,
  next_recurring_number INTEGER DEFAULT 1,
  next_note_id INTEGER DEFAULT 1
);
```

### Key Design Choices

- `labels`, `blocked_by`, `reminders`, `notes`, `subtasks`, `recurrence`, `current_cycle`, `board_runtime_config.attachment_allowed_formats`, `attachment_audit_log.affected_task_refs`, and `archive.task_snapshot` are stored as JSON text columns. SQLite has native JSON functions for querying these.
- `_last_mutation` stores a JSON snapshot of the task before the last mutation (for undo).
- `next_action`, `waiting_for`, `next_note_id`, and `updated_at` remain first-class task fields so hierarchy boards preserve the current TaskFlow command surface.
- `board_people.wip_limit` preserves the existing per-person WIP override model. `board_config.wip_limit` remains the board default fallback.
- `board_admins` preserves the existing manager/delegate authorization model in SQL form; `is_primary_manager = 1` is the hierarchy equivalent of the legacy single-manager fallback.
- The primary full-manager row in `board_admins` must always have a matching `board_people` row, even if that person should not receive routine assignments. During migration from legacy JSON boards, synthesize that `board_people` row from `meta.manager` / `meta.managers[]` when it is missing from `people[]`.
- `child_exec_*` columns on the tasks table hold the hierarchy linkage. No separate table needed because each task has at most one child execution link.
- `linked_parent_board_id` + `linked_parent_task_id` is the fully qualified upward reference.
- `archive.task_snapshot` stores the archived task payload (including parent linkage, but excluding the separately retained history slice), while `archive.history` stores only the latest 20 history entries and `archive_reason` distinguishes cancelled work from other archive reasons.
- `board_runtime_config` preserves language, timezone, runner IDs, cron schedules, DST guard state, and attachment policy so hierarchy boards keep the same runner + attachment behavior as standard TaskFlow boards.
- `attachment_audit_log` preserves the existing attachment audit trail for confirmed imports on hierarchy boards.
- Board-local task IDs (T-001, P-001, R-001) are scoped by `board_id` in the primary key.

## Rollup Model

### Adjacent-Only Reads

Each board queries only its direct children. A VP board queries manager boards. The CEO board queries VP boards. No grandchild queries.

### Rollup Query

When board X refreshes rollup for task T-004 linked to child board Y:

```sql
SELECT
  COUNT(*) AS total_count,
  SUM(CASE WHEN "column" != 'done' THEN 1 ELSE 0 END) AS open_count,
  SUM(CASE WHEN "column" = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
  SUM(CASE
        WHEN due_date IS NOT NULL
         AND due_date < :now
         AND "column" != 'done'
        THEN 1 ELSE 0
      END) AS overdue_count,
  MAX(updated_at) AS latest_child_update_at
FROM tasks
WHERE board_id = :child_board_id
  AND linked_parent_board_id = :parent_board_id
  AND linked_parent_task_id = :parent_task_id;
```

And, separately, detect newly cancelled tagged work since the last refresh:

```sql
SELECT COUNT(*) AS cancelled_count
FROM archive
WHERE board_id = :child_board_id
  AND linked_parent_board_id = :parent_board_id
  AND linked_parent_task_id = :parent_task_id
  AND archive_reason = 'cancelled'
  AND archived_at > COALESCE(:last_rollup_at, '1970-01-01T00:00:00.000Z');
```

The agent interprets the results using the mapping rules and updates the parent task:

```sql
UPDATE tasks
SET child_exec_rollup_status = :status,
    child_exec_last_rollup_at = :now,
    child_exec_last_rollup_summary = :summary,
    "column" = :new_column,
    updated_at = :now
WHERE board_id = :parent_board_id AND id = :parent_task_id;
```

### Rollup Mapping Rules

One set of rules applies at every parent-child boundary:

| Child-board condition | Parent task effect |
|-----------------------|--------------------|
| Linked but no tagged work yet (`total_count = 0`, `cancelled_count = 0`) | Parent stays in `next_action`, summary: `Quadro vinculado; aguardando planejamento inicial` |
| Active linked work (`open_count > 0`, no stronger condition below) | Parent moves to `in_progress` |
| Linked work blocked (`waiting_count > 0`) | Parent moves to `waiting` with summarized blocker |
| At-risk linked work (`overdue_count > 0`) | Parent stays `in_progress`, `rollup_status = "at_risk"` |
| Linked work complete (`total_count > 0`, `open_count = 0`, `cancelled_count = 0`) | Parent moves to `review`, `rollup_status = "ready_for_review"` |
| Linked work reopened (previously `ready_for_review`, now `open_count > 0`) | Parent returns to `in_progress` |
| Linked work cancelled (`cancelled_count > 0`, `open_count = 0`) | Parent stays open with `cancelled_needs_decision` |

The mapping table should be treated as mutually exclusive. `cancelled_needs_decision` outranks `ready_for_review`, so the review-ready branch must require `cancelled_count = 0`.

### What Rolls Up

Each parent receives from its direct children:

- current execution state
- blocker summary
- risk summary
- latest summary text

Recommended summary format: `4 itens ativos, 1 bloqueado por fornecedor, previsao quinta-feira`

### What Does Not Roll Up

A parent board does not automatically receive:

- full child-board task lists
- subordinate notes or identities
- all local history events
- grandchild-level detail

### Independent Refresh

Because any board can query any other board's data, each board refreshes independently. No root mediation needed. No cascading refresh needed. A VP refreshes from managers. The CEO refreshes from VPs. Each is an independent SQL query.

If the CEO wants fresh data all the way down, they simply ask each VP to refresh first, then refresh themselves. This is an operational workflow, not a system mechanism.

## Allowed `rollup_status`

- `no_work_yet`
- `active`
- `blocked`
- `at_risk`
- `ready_for_review`
- `completed`
- `cancelled_needs_decision`

## Permission Model

The permission model is the same at every level, parameterized by position in the hierarchy. Authorization is prompt-enforced.

### Board Owner (at any level)

May:

- assign deliverables to people with registered child boards
- change due dates and priorities
- link/unlink tasks to child boards
- refresh child rollup (query child board data)
- approve final delivery at that level
- cancel tasks at that level

May not directly manage boards more than one level below unless explicitly added there.

### Assignee with a Child Board (on a parent board)

On the parent board, may:

- update notes and summaries on their assigned tasks
- request rollup refresh
- manually move their own task only before `child_exec_enabled`

May not:

- alter the parent board's admin model
- close the parent-level task without parent-level approval
- manually move the parent-level task while `child_exec_enabled`

### Assignee on Their Own Board

Inside their own board, the assignee is the full manager and may:

- create tasks and projects
- assign work to subordinates
- link/unlink tasks to their own child boards (if not at leaf level)
- refresh child rollup
- process Inbox and run local review

### Leaf-Level Subordinates

Work only on their manager's board. No implicit authority on higher-level boards.

## Field Authority While Linked

When `child_exec_enabled = 1` on a task:

Rollup-managed fields:

- `column`
- `child_exec_rollup_status`
- `child_exec_last_rollup_at`
- `child_exec_last_rollup_summary`

Board-owner-managed fields:

- `title`
- `due_date`
- notes
- labels/priority
- final approve/reject decision

Rule:

- normal board users must not manually move the task across work columns while `child_exec_enabled`
- the normal source of `column` changes is rollup refresh
- if the board owner wants full manual control back, they must explicitly unlink first

## Commands

### Board Provisioning Commands (work at any non-leaf level)

#### Create a Child Board

- `criar quadro para [pessoa]`
- `registrar quadro para [pessoa]`

Effect:

- refuse if `hierarchy_level == max_depth` (leaf board cannot have children)
- refuse if the person already has a registered child board
- collect the target person + subordinate group details needed for provisioning
- generate an operator-facing provisioning request that must be completed via the approved setup/main-context workflow
- the setup/operator flow then writes the `registered_groups` row with `taskflow_managed = true`, `taskflow_hierarchy_level = parent_runtime_level + 1`, and `taskflow_max_depth = max_depth` (using the same direct SQLite setup pattern as standard TaskFlow, or equivalent approved operator automation). This request must still satisfy the runtime depth gate (`current runtime level + 1 < taskflow_max_depth`). The setup flow then INSERTs into `boards`, `child_board_registrations`, `board_config`, `board_runtime_config`, `board_admins`, and `board_people`, generates the group's `CLAUDE.md`, schedules the board runners, and records `child_board_created`

Permission: board owner only.

#### Remove a Child Board

- `remover quadro do [pessoa]`

Effect:

- refuse if the person has active linked tasks (must unlink first)
- DELETE from `child_board_registrations`
- do not change `board_role` or storage backend; the child board remains SQLite-backed
- treat the result as a detached hierarchy board that must be explicitly re-parented or decommissioned by a separate operator workflow before any new upward linkage is used
- record `child_board_removed` history action

Permission: board owner only.

### Task Hierarchy Commands (work at any non-leaf level)

#### Link a Task to a Child Board

- `vincular T-XXX ao quadro do [pessoa]`
- `usar equipe de [pessoa] para T-XXX`

Effect:

- resolve the person's child board from `child_board_registrations`
- set `child_exec_enabled = 1` and populate `child_exec_*` fields
- record `child_board_linked` history action

#### Refresh Rollup

- `atualizar status T-XXX`
- `sincronizar T-XXX`

Effect:

- query the child board's tasks tagged to this parent task
- recompute rollup fields
- record `child_rollup_updated` (and status-specific action if status changed)

#### View Rollup

- `resumo de execucao T-XXX`

Effect:

- show summarized rollup for that task

Disambiguation: `"resumo"` alone triggers the v2 ad-hoc digest. `"resumo de execucao T-XXX"` triggers the rollup view. The task ID suffix disambiguates.

#### Unlink Child Execution

- `desvincular T-XXX`

Effect:

- set `child_exec_enabled = 0` (preserve fields for audit trail)
- keep the task's current `column`
- record `child_board_unlinked` history action with the last known `rollup_status`
- re-enable normal assignee column moves

### Generic Upward Tagging (work at any non-root level)

#### Tag Local Work to Parent Task

- `ligar tarefa ao pai T-XXX`

Effect:

- set `linked_parent_board_id` and `linked_parent_task_id` on the local task
- the command accepts only the parent task ID because the board already knows `parent_board_id`; the stored reference is always fully qualified
- requires the parent board context from the board's `parent_board_id`
- rejected on root boards (no parent)

### Leaf-Level Commands

Leaf boards use standard TaskFlow commands plus upward tagging (`ligar tarefa ao pai T-XXX`) because they still have a parent board. They do not expose downward link/unlink/refresh/view commands because they have no child boards.

## Auto-Link on Assignment

When a task is assigned to a person who has a registered child board:

- The board should offer to link automatically: `[pessoa] tem um quadro registrado. Vincular T-XXX automaticamente? (sim/nao)`
- Default: link automatically unless the board owner declines
- The board owner can always unlink later

If the person has no registered child board, the task remains a normal board-local task.

## Task Type Restrictions

- **Simple tasks (T-XXX)**: Can be linked to child boards. Primary use case.
- **Projects (P-XXX)**: Can be linked to child boards. The project's subtasks remain on the parent board. The child board creates its own independent breakdown.
- **Recurring tasks (R-XXX)**: Cannot be linked. Cycle resets would break the linkage contract.

## Board Display and Runner Interactions

### Board View (`quadro`)

Linked tasks show a `🔗` marker and rollup status:
- `🔗 T-004 Entregar infraestrutura (Alexandre) [active]`

### Task Details (`detalhes T-XXX`)

Include rollup section: child board, rollup status, last refresh time, summary.

### Morning Standup

Linked tasks show rollup summary:
- `T-004 — 🔗 Alexandre: 4 itens ativos, 1 em risco (atualizado 16:00)`

### Evening Digest

Include linked tasks with rollup status. Flag stale rollup (>24h):
- `T-004 — 🔗 active (⚠️ rollup desatualizado — ultimo refresh ha 36h)`

### Weekly Review

List all hierarchy-linked tasks with rollup status. Suggest refreshing stale ones.

## Depth Enforcement

### `max_depth` Rules

- `max_depth` is stored on every board in the `boards` table
- A board at `hierarchy_level == max_depth` is a leaf board
- Leaf boards cannot have entries in `child_board_registrations`
- The `criar quadro` command must refuse to create child boards on leaf boards
- The runtime must refuse downward link commands on leaf boards
- Minimum `max_depth` is 2 (depth 1 is just a standard board)

### Changing `max_depth`

To add a new level:

1. `UPDATE boards SET max_depth = :new_depth WHERE board_role = 'hierarchy'`
2. Provision new boards at the new depth
3. INSERT registrations in `child_board_registrations`

To reduce depth:

1. Unlink all tasks at the removed level
2. DELETE registrations for removed boards
3. UPDATE `max_depth` on all remaining boards

Both are operator-time operations.

## Interaction with TaskFlow v2 Features

- **Existing command surface**: Quick capture, inbox processing, notes, reminders, dependencies, archive browse/search, changelog, statistics, attachment intake, and the standard Kanban move commands all remain available on hierarchy boards. The hierarchy commands are additive.
- **Managers / delegates**: Sender identification and authorization continue to work via the existing manager/delegate model, now backed by `board_admins`.
- **Per-person WIP**: WIP enforcement still checks the assignee's `board_people.wip_limit` first, then falls back to `board_config.wip_limit`.
- **`_last_mutation` / Undo**: Rollup-driven column changes are not captured in `_last_mutation` and cannot be undone via `desfazer`. To reverse, unlink first.
- **`blocked_by` / Dependencies**: Board-local only. Cross-board blocking is expressed through `rollup_status = "blocked"`.
- **`reminders`**: Operate normally — `due_date` remains board-owner-managed.
- **`description`**: Board-local. Does not roll up.
- **Statistics (F14)**: Benefit from SQL — `SELECT` queries replace in-prompt JSON parsing.
- **Attachments**: Hierarchy boards continue to enforce attachment policy (`enabled`, disabled reason, allowed formats, max size) and record confirmed imports in `attachment_audit_log`.
- **Runners / DST guard**: Hierarchy boards continue using `send_message`, `schedule_task`, `cancel_task`, and `list_tasks` for standup/digest/review, optional DST guard, and due-date reminders. Only task/board state storage moves from JSON files to SQLite.
- **History retention**: `task_history` keeps the full event stream, but user-facing history views should still cap active-task displays to the latest 50 entries. When archiving, store only the latest 20 history entries in `archive.history`, matching the original TaskFlow retention behavior.

## Failure and Edge Cases

### 1. Person Has No Board Yet

Task remains valid. Linkage cannot be enabled. The agent suggests: `[pessoa] nao tem um quadro registrado. Use "criar quadro para [pessoa]" para provisionar.`

### 2. Task Reassigned to Another Person

Old linkage must be removed. New linkage created explicitly. No silent transfer.

### 3. Child Board Shows Mixed Work

Rollup query filters by `linked_parent_task_id`. Only tagged work counts.

### 4. Multiple Parent Tasks Linked to Same Child Board

Each parent task's rollup filters by its own `linked_parent_task_id`. Independent results.

### 5. Child Complete, Parent Rejected

Parent task moves back to `in_progress`. Child reopens or adds work.

### 6. Linked Work Blocked

Parent shows summarized blocker. Parent does not directly operate the child board.

## Security and Governance

### Board Separation

Authorization is prompt-enforced:

- each board's agent is instructed to query only its own board + registered child boards
- the agent must not query sibling boards, grandchild boards, or parent board task lists
- this matches how all other TaskFlow rules (permissions, WIP limits, column moves) are enforced

### Audit Trail

History actions (generic, apply at every level):

- `child_board_created`
- `child_board_removed`
- `child_board_linked`
- `child_board_unlinked`
- `child_rollup_updated` — every rollup refresh
- `child_rollup_blocked` — `rollup_status` transitions to `blocked`
- `child_rollup_at_risk` — `rollup_status` transitions to `at_risk` because tagged child work is overdue
- `child_rollup_completed` — transitions to `ready_for_review` or `completed`
- `child_rollup_cancelled` — one or more tagged child tasks were archived with `archive_reason = 'cancelled'`

### Database Access

The SQLite database is shared across all agents. The MCP server provides read/write access. There is no code-level access control per board — this is a deliberate design choice that matches the existing TaskFlow model.

If stronger isolation is needed later, a custom MCP server with per-board access control can replace the generic one without changing the template or schema.

## Constraints

- One persistent board per person at each level
- No per-task board creation
- No skipping levels in rollup
- Depth bounded by `max_depth`
- Same generic model at every level
- All data in shared SQLite database
- Existing TaskFlow v2 features (authorization, runners, attachments, reminders, statistics) must continue to work on hierarchy boards
- Authorization is prompt-enforced

## Future Expansion

To add a new level:

1. Update `max_depth` in the database
2. Provision new boards
3. Register them in `child_board_registrations`

No template changes, no new field names, no new commands.

To add code-level access control:

1. Replace the generic SQLite MCP server with a custom one that checks board registrations before allowing queries
2. No template changes needed — the queries stay the same

## Recommended Decision

Implement this as a **bounded-recursive TaskFlow hierarchy** with:

- shared SQLite database accessed through an off-the-shelf MCP server
- one generic data model at every level
- `max_depth` controlling the depth limit
- adjacent-only rollup via SQL queries
- one set of commands at any level
- minimal NanoClaw source changes (SQLite MCP server config, conditional container mount, schema initialization module)

## Implementation Notes

The following refinements were made during implementation:

- **Database path**: `data/taskflow/taskflow.db` (directory mount, not file mount) so WAL journal files persist.
- **Conditional mount**: Only hierarchy groups (with `taskflowHierarchyLevel` metadata) get the SQLite mount. Standard TaskFlow groups continue with JSON.
- **Source changes required**: Despite the original "zero source code changes" goal, a small support layer was needed: `src/taskflow-db.ts` (schema initialization), `mcp-server-sqlite-npx` in `container/agent-runner/package.json`, `mcp__sqlite__*` in `allowedTools`, and conditional directory mount in `container-runner.ts`. The hierarchy logic itself remains template-only.
- **`admin_role = 'manager'`**: Both standard (JSON) and hierarchy (SQLite) modes use the same `'manager'` / `'delegate'` vocabulary for consistency.

See `docs/plans/2026-02-28-taskflow-hierarchical-delegation-implementation.md` for full implementation details.
