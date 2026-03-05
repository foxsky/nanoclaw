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
- No mirrored child task lists across levels (child boards see parent tasks via `child_exec_board_id` reference, not copies)
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

### Board Owner Identity (`MANAGER_NAME`)

The `{{MANAGER_NAME}}` template variable identifies the board owner — the person the assistant serves on that board. For child boards, this is the person who owns the board (e.g., "Giovanni"), not the parent manager who provisioned it. The assistant addresses this person by name and treats them as the primary authority on the board.

- Root board: `MANAGER_NAME` = the top-level manager (set during initial setup)
- Child boards: `MANAGER_NAME` = the person registered on the parent board who received the child board (set automatically by the `provision_child_board` plugin)

### Provisioning Model

Child boards are provisioned automatically when a person is registered on a non-leaf hierarchy board via `cadastrar`. The `provision_child_board` IPC plugin handles the full lifecycle without operator intervention.

1. **Root board**: created during initial setup (operator runs `/add-taskflow` with hierarchy mode). This creates the database, configures the MCP server, generates the root board's `CLAUDE.md`, registers the group, and schedules the runners.
2. **Auto-provisioning on `cadastrar`**: when a manager registers a person on a non-leaf board, the agent calls the `provision_child_board` MCP tool. This writes an IPC file that the host-side `provision-child-board.ts` plugin processes asynchronously — creating the WhatsApp group, registering it, seeding the database, generating CLAUDE.md, scheduling runners, and sending a confirmation message. No operator intervention required.
3. **Manual provisioning**: a board owner may also request `criar quadro para [pessoa]` explicitly. The same `provision_child_board` flow handles it.
4. **Deeper levels**: the same auto-provisioning pattern repeats at each level down to `max_depth`.

#### Auto-provisioning flow

```
Container Agent                    Host Process
─────────────────                  ─────────────────
cadastrar [nome]
  → INSERT board_people
  → calls provision_child_board
  → writes IPC file ──────────────→ IPC watcher picks up
    {type: provision_child_board}     → provision-child-board.ts handler
  → responds: "provisionado"           → deps.createGroup() → Baileys
                                        → deps.registerGroup() → DB + memory
                                        → seed taskflow.db
                                        → generate CLAUDE.md from template
                                        → write .mcp.json
                                        → create scheduled runners
                                        → fix ownership
                                        → send confirmation message
```

#### Board creation steps (host-side plugin)

1. Validate source group: `taskflowManaged === true` and `taskflowHierarchyLevel + 1 < taskflowMaxDepth`. Missing or invalid depth metadata fails provisioning.
2. Read parent board config from `taskflow.db`.
3. Check person not already registered in `child_board_registrations`.
4. Create WhatsApp group via `deps.createGroup()`.
5. Register group via `deps.registerGroup()` with TaskFlow metadata: `taskflow_managed = true`, `taskflow_hierarchy_level = parent_runtime_level + 1`, `taskflow_max_depth = max_depth`.
6. Seed child board in `taskflow.db` (single transaction): INSERT `boards`, `child_board_registrations`, `board_config`, `board_runtime_config`, `board_admins`, `board_people`. UPDATE parent `board_people.notification_group_jid`. INSERT `task_history` recording `child_board_created`.
7. Generate `CLAUDE.md` from template with inherited and computed values.
8. Schedule standup/digest/review runners, store task IDs in `board_runtime_config`.
9. Fix filesystem ownership (`chown -R nanoclaw:nanoclaw`).
10. Send confirmation to source group.

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
  notification_group_jid TEXT,
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
- `board_people.notification_group_jid` stores the WhatsApp group JID where notifications for this person should be sent. NULL means notify in the current group. With the v2 MCP tools, the engine's `resolveNotifTarget()` queries this field and includes it in the `notifications` array returned to the agent, which dispatches each notification via `send_message` with the provided `target_chat_jid`.
- `board_admins` preserves the existing manager/delegate authorization model in SQL form; `is_primary_manager = 1` is the hierarchy equivalent of the legacy single-manager fallback.
- The primary full-manager row in `board_admins` must always have a matching `board_people` row, even if that person should not receive routine assignments. During migration from legacy JSON boards, synthesize that `board_people` row from `meta.manager` / `meta.managers[]` when it is missing from `people[]`.
- `child_exec_*` columns on the tasks table hold the hierarchy linkage. No separate table needed because each task has at most one child execution link.
- `linked_parent_board_id` + `linked_parent_task_id` is the fully qualified upward reference.
- `archive.task_snapshot` stores the archived task payload (including parent linkage, but excluding the separately retained history slice), while `archive.history` stores only the latest 20 history entries and `archive_reason` distinguishes cancelled work from other archive reasons.
- `board_runtime_config` preserves language, timezone, runner IDs, cron schedules, DST guard state, and attachment policy so hierarchy boards keep the same runner + attachment behavior as standard TaskFlow boards.
- `attachment_audit_log` preserves the existing attachment audit trail for confirmed imports on hierarchy boards.
- Board-local task IDs (T1, P1, R1) are scoped by `board_id` in the primary key.

## Rollup Model

### Adjacent-Only Reads

Each board queries only its direct children. A VP board queries manager boards. The CEO board queries VP boards. No grandchild queries.

### Rollup Query

When board X refreshes rollup for task T004 linked to child board Y:

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

- on the receiving board, the assignee and board owner may move the linked task across normal GTD work columns while `child_exec_enabled`
- `atualizar status TXXX` / `sincronizar TXXX` is only for pulling progress from an immediate child board after this board delegates the same deliverable further down
- if the board owner wants to remove cross-board visibility entirely, they must explicitly unlink first

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

- `vincular TXXX ao quadro do [pessoa]`
- `usar equipe de [pessoa] para TXXX`

Effect:

- resolve the person's child board from `child_board_registrations`
- set `child_exec_enabled = 1` and populate `child_exec_board_id`, `child_exec_person_id`
- the task remains on the parent board — the child board sees it via `child_exec_board_id` reference (no copy)
- record `child_board_linked` history action

#### Refresh Rollup

- `atualizar status TXXX`
- `sincronizar TXXX`

Effect:

- query the child board's tasks tagged to this parent task
- recompute rollup fields
- record `child_rollup_updated` (and status-specific action if status changed)

#### View Rollup

- `resumo de execucao TXXX`

Effect:

- show summarized rollup for that task

Disambiguation: `"resumo"` alone triggers the v2 ad-hoc digest. `"resumo de execucao TXXX"` triggers the rollup view. The task ID suffix disambiguates.

#### Unlink Child Execution

- `desvincular TXXX`

Effect:

- set `child_exec_enabled = 0` (preserve fields for audit trail)
- keep the task's current `column`
- record `child_board_unlinked` history action with the last known `rollup_status`
- re-enable normal assignee column moves

### Generic Upward Tagging (work at any non-root level)

#### Tag Local Work to Parent Task

- `ligar tarefa ao pai TXXX`

Effect:

- set `linked_parent_board_id` and `linked_parent_task_id` on the local task
- the command accepts only the parent task ID because the board already knows `parent_board_id`; the stored reference is always fully qualified
- requires the parent board context from the board's `parent_board_id`
- rejected on root boards (no parent)

### Leaf-Level Commands

Leaf boards use standard TaskFlow commands plus upward tagging (`ligar tarefa ao pai TXXX`) because they still have a parent board. They do not expose downward link/unlink/refresh/view commands because they have no child boards.

## Auto-Link on Assignment

When a task is assigned to a person who has a registered child board, the board automatically links it (if the sender is a full manager and the task is not a recurring task). The `vincular` SQL update is performed immediately after assignment. The manager is informed:

> TXXX vinculada automaticamente ao quadro de [pessoa].

The board owner can always unlink later with `desvincular TXXX`.

If the person has no registered child board, the task remains a normal board-local task.

## Reference-Based Task Visibility

Tasks exist as a single row on the parent board. Child boards see delegated tasks via a reference — no copies are created.

### Query Pattern

Each board loads its tasks with:

```sql
SELECT * FROM tasks
WHERE board_id = :my_board_id
   OR (child_exec_board_id = :my_board_id AND child_exec_enabled = 1)
ORDER BY created_at
```

This returns:
- **Own tasks**: tasks created directly on this board (`board_id` match)
- **Delegated tasks**: tasks from a parent board that have been linked to this board via `vincular` (`child_exec_board_id` match)

### Design Rationale

- **Single source of truth**: each task has exactly one row. Updates from either board apply to the same row.
- **No sync issues**: no copies to keep in sync, no stale duplicates.
- **Clean delegation**: the parent board owns the task; the child board sees it as a delegated item for direct execution plus standup/digest/review.
- **Rollup integrity**: rollup queries work against `linked_parent_task_id` (upward tagging from child's own tasks), while task visibility works against `child_exec_board_id` (downward delegation from parent).

## Task Type Restrictions

- **Simple tasks (TXXX)**: Can be linked to child boards. Primary use case.
- **Projects (PXXX)**: Can be linked to child boards. The project's subtasks remain on the parent board. The child board creates its own independent breakdown.
- **Recurring tasks (RXXX)**: Cannot be linked. Cycle resets would break the linkage contract.

## Board Display and Runner Interactions

### Board View (`quadro`)

Linked tasks show a `🔗` marker and rollup status:
- `🔗 T004 Entregar infraestrutura (Alexandre) [active]`

### Task Details (`detalhes TXXX`)

Include rollup section: child board, rollup status, last refresh time, summary.

### Morning Standup

Linked tasks show rollup summary:
- `T004 — 🔗 Alexandre: 4 itens ativos, 1 em risco (atualizado 16:00)`

### Evening Digest

Include linked tasks with rollup status. Flag stale rollup (>24h):
- `T004 — 🔗 active (⚠️ rollup desatualizado — ultimo refresh ha 36h)`

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
- **Cross-group notifications**: The `send_message` MCP tool accepts an optional `target_chat_jid` parameter. TaskFlow-managed groups can send to other TaskFlow-managed groups (e.g., notifying an assignee in their child group when a task is assigned on the parent board). The IPC authorization layer permits TaskFlow-to-TaskFlow messaging. Each person's notification group JID is stored in `board_people.notification_group_jid` and populated during child board provisioning. **Important:** `send_message` must only be used for cross-group notifications and scheduled task output — regular responses are sent automatically via the host's streaming output callback with the correct per-group sender prefix.
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
- **Cross-group notifications**: Added `notification_group_jid` column to `board_people` and `target_chat_jid` parameter to `send_message` MCP tool. IPC authorization updated to allow TaskFlow-to-TaskFlow cross-group messaging. During child board provisioning, the parent board's `board_people.notification_group_jid` is set to the child group's JID so notifications reach people in their working group. With the v2 MCP tools, notification resolution is handled by `resolveNotifTarget()` inside the engine — it queries only `notification_group_jid` from `board_people` and returns `{ target_person_id, notification_group_jid }`. The engine's notification builders (`buildCreateNotification`, `buildMoveNotification`, `buildReassignNotification`, `buildUpdateNotification`) produce rich pt-BR formatted messages; the agent dispatches them via `send_message`.
- **Auto-provisioning**: Added `provision_child_board` IPC plugin (`src/ipc-plugins/provision-child-board.ts`) and matching MCP tool in `ipc-mcp-stdio.ts`. When a person is registered via `cadastrar` on a non-leaf hierarchy board, the agent fires the `provision_child_board` IPC call. The host-side plugin handles the full lifecycle (WhatsApp group creation, DB seeding, CLAUDE.md generation, runner scheduling) asynchronously. The original "no automatic board creation" non-goal was removed — auto-provisioning is now the default for hierarchy boards.
- **Reference-based task visibility**: Child boards see delegated tasks via `child_exec_board_id` reference instead of task copies. The task query uses `WHERE board_id = :id OR (child_exec_board_id = :id AND child_exec_enabled = 1)`. This eliminates sync issues and maintains a single source of truth per task.
- **Per-group sender name (dual response fix)**: Each group's `trigger_pattern` (e.g., `@Case`) is used to derive the outbound message sender name. The shared `getGroupSenderName(trigger?)` utility in `src/config.ts` centralizes the `trigger?.replace(/^@/, '') || ASSISTANT_NAME` pattern. Used in the streaming output callback, container `assistantName`, and scheduled task sender. The CLAUDE.md template instructs agents NOT to use `send_message` for regular responses (only for cross-group notifications and scheduled task output), preventing duplicate messages.
- **Unknown person → offer registration**: When a task is assigned to an unregistered person, the agent offers to register them (requesting phone and role) instead of a dead-end error. On non-leaf hierarchy boards, registration triggers auto-provisioning of a child board. The original assignment is retried after registration completes.

See `docs/plans/2026-02-28-taskflow-hierarchical-delegation-implementation.md` for full implementation details.
