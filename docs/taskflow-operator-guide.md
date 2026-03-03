# TaskFlow Operator Guide

Operator guide for provisioning, configuring, and maintaining TaskFlow boards in NanoClaw.

This document is for the system operator or team admin. End users should use [taskflow-user-manual.md](taskflow-user-manual.md).

## Scope

TaskFlow is a config-driven skill package. It does not add new core runtime code. It uses existing NanoClaw capabilities:

- Group-local `CLAUDE.md` prompts
- Shared SQLite database at `data/taskflow/taskflow.db`
- Per-group `settings.json`
- SQLite-backed `registered_groups` and `scheduled_tasks`
- Existing MCP/IPC tools such as `send_message`, `schedule_task`, `cancel_task`, and `list_tasks`

Each TaskFlow group is its own board. If you provision multiple groups, they do not sync automatically.

## Prerequisites

Before provisioning a TaskFlow board:

- NanoClaw must already be installed and running.
- WhatsApp auth must already exist in `store/auth/`.
- The project dependencies in `package.json` must be installed, including `@whiskeysockets/baileys`, `better-sqlite3`, and `cron-parser`.
- Decide whether media support is available. If not, attachment import must stay disabled.

## What Gets Created

For each TaskFlow board/group, the operator provisions:

- `groups/<folder>/CLAUDE.md`
- `groups/<folder>/.mcp.json` (SQLite MCP server config)
- `data/sessions/<folder>/.claude/settings.json`
- Board data in `data/taskflow/taskflow.db` (tables: `boards`, `board_config`, `board_runtime_config`, `board_people`, `board_admins`)
- One row in `registered_groups` (with `taskflow_managed=1`)
- Three scheduled runners in `scheduled_tasks`
- Optional fourth scheduled runner for DST guard

Core runners:

- Morning standup
- Manager digest
- Weekly review

Optional runner:

- DST guard

## Topology Choices

TaskFlow supports three operator-facing deployment models:

1. **Shared group**: one WhatsApp group, one board.
2. **Separate groups**: multiple independent boards, each with its own runners.
3. **Hierarchy (Delegation)**: bounded-recursive boards. One root board at level 1, with optional child boards per person at deeper levels up to `max_depth`.

All topologies use the shared SQLite database at `data/taskflow/taskflow.db`. Standard/Separate boards get `board_role='standard'`, `max_depth=1`. Hierarchy boards get `board_role='hierarchy'` with `max_depth >= 2`.

There is no mirrored “shared board + private per-user view” mode, and there is no automatic cross-group sync for standard/separate boards.

## Installation Inputs

During setup, collect:

- Manager name
- Manager phone (digits only)
- Output language
- TaskFlow timezone
- Board topology
- Default WIP limit
- AI model for the group agent
- Standup, digest, and weekly review local times
- Whether DST guard should be enabled

Recommended defaults:

- Language: `pt-BR`
- Timezone: team-local IANA timezone
- WIP limit: `3`
- Model: `claude-sonnet-4-6`

## Group Provisioning

### Existing Group

If the WhatsApp group already exists, find its JID from SQLite:

```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE is_group = 1 AND name LIKE '%SEARCH%' ORDER BY last_message_time DESC;"
```

Fallback: check `data/ipc/main/available_groups.json`. Its shape is:

```json
{
  "groups": [],
  "lastSync": "..."
}
```

Read from the `groups` array.

### New Group (Automatic)

If creating a new WhatsApp group automatically, stop the service first. Only one Baileys socket can be active per account.

```bash
systemctl stop nanoclaw
```

Use the Baileys `groupCreate` flow described in the TaskFlow skill. Shared-team boards can be created with only the manager initially, then members can be added later.

### New Group (Manual Fallback)

If automatic creation is not practical:

1. Create the group manually in WhatsApp.
2. Add the bot.
3. Send a message in the group.
4. Clear the group sync cache and restart NanoClaw.
5. Query `chats` again to discover the new JID.

## Files and Data

### SQLite Database

All board data is stored in `data/taskflow/taskflow.db`. The database is created by `src/taskflow-db.ts` and contains 10 tables (see the Database Schema section below).

Key data stored per board:

- Board metadata in `boards`, `board_config`, `board_runtime_config`
- Team members in `board_people`
- Admin/manager roles in `board_admins`
- Active tasks in `tasks`
- Task event history in `task_history`
- Completed/cancelled tasks in `archive`
- Runner IDs and cron schedules in `board_runtime_config`
- DST sync state in `board_runtime_config`
- Attachment audit trail in `attachment_audit_log`

Important implications:

- Due dates are stored in the `tasks.due_date` column.
- Tasks track structured notes via `notes` column (JSON), with `next_note_id` in `board_config`.
- Tasks can track per-task reminders in the `reminders` column (JSON).
- If you update a due date, the authoritative state is the `due_date` column in the `tasks` table.

### Archive

The `archive` table stores:

- Completed tasks moved out of the active board
- Cancelled tasks

Done tasks are archived after aging out. Cancelled tasks move to archive immediately after confirmation.

### `CLAUDE.md`

The generated prompt enforces:

- Scope guard for off-topic requests
- Task-specific authorization rules
- Attachment import confirmation rules
- Group-only messaging
- File-write restrictions

This file is operator-managed. End users should not modify it.

### `settings.json`

Per-group settings live at:

`data/sessions/<folder>/.claude/settings.json`

This file is pre-created so the selected model is present before the first group session starts.

If you change it later and need to guarantee the new model is picked up, restart the service.

## Registration

Register the board by inserting into `registered_groups`:

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, taskflow_managed, taskflow_hierarchy_level, taskflow_max_depth) VALUES ('{{GROUP_JID}}', '{{GROUP_NAME}}', '{{GROUP_FOLDER}}', '@{{ASSISTANT_NAME}}', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', NULL, 1, 1, 0, 1);"
```

For root hierarchy boards, use `taskflow_hierarchy_level=0` and `taskflow_max_depth={{MAX_DEPTH}}`. Child boards increment the runtime level from their parent.

Notes:

- `registered_groups` is loaded into memory on process startup.
- After registration changes, restart NanoClaw once to reload the group cache.
- Keep folder names lowercase with hyphens for this skill.
- The `taskflow_managed=1` flag causes the container runner to mount `/workspace/taskflow/` for the group.

## Scheduling

TaskFlow runners are inserted directly into `scheduled_tasks`.

Operator boundary:

- End-user documentation should describe these as TaskFlow automations, not as standalone scheduler jobs.
- Do not instruct end users to manage NanoClaw scheduler rows directly for normal TaskFlow usage.
- Keep scheduler operations in operator-only procedures.

Important runtime rules:

- Cron expressions run in the server timezone.
- Resolve the scheduler timezone from the running service environment (`process.env.TZ` if set, otherwise the host system timezone). Do not assume UTC unless the service is actually configured that way.
- Store both local and UTC cron values in `board_runtime_config`.
- `once` timestamps may use any format the host parser accepts when using `schedule_task` (for example a local timestamp or a `Z`-suffixed ISO timestamp).
- Manually inserted TaskFlow runners must use `context_mode: 'group'`, not the schema default, so they execute with access to the target board files.
- Manually inserted TaskFlow runners must include a valid non-null `next_run`, or the scheduler will never pick them up.

Task IDs follow the normal NanoClaw pattern:

`task-<epoch-ms>-<6chars>`

## Runner Behavior

### Standup

- Reads the current board
- Posts the board to the group
- Includes per-person sections inline
- Performs housekeeping such as archival/history cap
- Skips sending if the `tasks` table is empty for the board

### Digest

- Summarizes overdue, near-due, waiting, stale, and completed-today items
- Skips sending if the `tasks` table is empty for the board

### Weekly Review

- Summarizes weekly board state
- Includes inbox, waiting, overdue, stale, and next-week preview
- Skips sending if the `tasks` table is empty for the board, even if there was archive activity that week

### DST Guard

If enabled:

- Checks for timezone offset changes
- Recomputes UTC cron values from stored local schedules
- Replaces the core runners if the offset changed
- Updates DST sync state in `board_runtime_config`

## Task Semantics

Operator-relevant task rules:

- Projects use parent IDs like `P-001`.
- Project subtasks use dotted child IDs like `P-001.1`, `P-001.2`.
- Recurring tasks create the next cycle immediately when a cycle is completed.
- `cancel_task` is for scheduled runner jobs, not normal board task cancellation.
- Normal task cancellation is a board mutation in the `tasks` and `archive` tables.

### Important Distinction: Two Kinds of "Task"

TaskFlow uses two separate layers:

- Board tasks: user-facing items in the `tasks` table such as `T-001`, `P-001`, and `R-001`
- Scheduler tasks: operator/runtime rows in `scheduled_tasks` used for standup, digest, review, and optional DST guard

These are not interchangeable:

- Users should interact with board tasks through TaskFlow commands in WhatsApp.
- Operators may manage scheduler tasks when maintaining automations.
- Never present scheduler task IDs as if they were normal board task IDs.

## Permissions Model

The generated prompt enforces:

- Full-manager-only creation of complete tasks (`tarefa`, `projeto`, `diario`, `semanal`, `mensal`, `anual`)
- Delegate-or-manager inbox processing and review approval/rejection
- Full-manager-only admin actions (reassign, WIP overrides, people changes, manager/delegate changes, cancel)
- Assignee-only movement into work states
- Assignee-or-manager updates of `next_action`, title, priority, labels, and task notes (including edit/remove of structured notes)
- Exact attachment confirmation command: `CONFIRM_IMPORT {import_action_id}`

If a recognized command is issued by the wrong sender, the prompt is expected to refuse and not mutate state.

## Runtime Isolation

For non-main groups, the container runtime mounts:

- Writable `/workspace/group/`
- Read-only `/workspace/global/` if the global folder exists

Non-main groups do not get:

- Project-root access
- Other groups’ files
- Cross-group registration/scheduling privileges

## Day-2 Operations

### Add or Update Team Members

Update `board_people` via SQLite through the TaskFlow commands or by operator-controlled SQL edits if recovering from prompt failure.

### Change the Model

1. Edit `data/sessions/<folder>/.claude/settings.json`
2. Ensure ownership is correct
3. Restart NanoClaw to guarantee the change is used

### Change the Schedule

1. Update local and UTC cron values in `board_runtime_config`
2. Cancel the existing runner rows
3. Create replacement rows in `scheduled_tasks`
4. Persist new runner IDs in `board_runtime_config` (`runner_standup_task_id`, `runner_digest_task_id`, `runner_review_task_id`, `runner_dst_guard_task_id`)

### Pause or Remove Runners

Use task-level operations on the runner IDs stored in `board_runtime_config`.

Do not confuse runner tasks with normal board tasks.

## Verification Checklist

After provisioning a board:

1. Send `@<assistant> quadro` in the target group.
2. Confirm the group responds with TaskFlow behavior.
3. Create a quick capture item.
4. Confirm the task appears in the `tasks` table.
5. Confirm runner IDs are stored in `board_runtime_config`.
6. If attachment import is enabled, verify the proposal flow requires the exact `CONFIRM_IMPORT` token.
7. If DST guard is enabled, test in staging before relying on it in production.

## Troubleshooting

### Group Does Not Respond

- Confirm the group is present in `registered_groups`.
- Restart NanoClaw after registration changes.
- Verify the trigger pattern matches the assistant name.

### Runner Exists But Never Fires

- Check `scheduled_tasks.next_run`
- Verify cron is expressed in server timezone
- Confirm the scheduler loop is running
- Confirm the task `status` is still `active`

### Wrong Model Is Still Used

- Verify the group’s `settings.json` exists in the correct folder
- Verify ownership under `data/sessions/`
- Restart NanoClaw

### Attachment Import Fails

- Confirm media support is actually installed and enabled
- Confirm the file is PDF/JPG/PNG and within size limits
- Confirm the user sent the exact `CONFIRM_IMPORT {import_action_id}` command

## Hierarchy Mode

### Initial Setup

To provision a hierarchy board, run `/add-taskflow` and select the "Hierarchy (Delegation)" topology. During setup, also specify:

- **Hierarchy depth (`max_depth`)**: minimum 2, default 2. Depth 1 is just a standard board.

The wizard:

1. Creates the SQLite database at `data/taskflow/taskflow.db` via `node dist/taskflow-db.js` (10 tables, WAL mode, foreign keys).
2. Writes `.mcp.json` to the group folder to configure the `mcp-server-sqlite-npx` MCP server.
3. Seeds the root board data into `boards`, `board_config`, `board_runtime_config`, and `board_admins`.
4. Stores runner scheduled task IDs in `board_runtime_config` (columns: `runner_standup_task_id`, `runner_digest_task_id`, `runner_review_task_id`, `runner_dst_guard_task_id`).
5. Registers the group in `registered_groups` with TaskFlow metadata.

**Hierarchy registration SQL** (same columns as standard, different values):

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, taskflow_managed, taskflow_hierarchy_level, taskflow_max_depth) VALUES ('{{GROUP_JID}}', '{{GROUP_NAME}}', '{{GROUP_FOLDER}}', '@{{ASSISTANT_NAME}}', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', NULL, 1, 1, 0, {{MAX_DEPTH}});"
```

All TaskFlow boards use the same three columns (`taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth`). `taskflow_hierarchy_level` is 0-based (root = 0). Standard boards use `(1, 0, 1)`. Hierarchy root boards use `(1, 0, <max_depth>)`. These control:
- Whether the container gets the SQLite directory mounted (`taskflow_managed=1`)
- Which hierarchy commands are available to the agent (`taskflow_hierarchy_level`)
- Depth enforcement for child board creation (`taskflow_max_depth`)

### Child Board Provisioning

Child boards are provisioned through the SKILL.md Phase 6 workflow. The process starts when a board owner requests `criar quadro para [pessoa]` — the agent emits a provisioning request, and the operator completes it:

1. **Pre-flight**: Verify `registered_groups.taskflow_hierarchy_level + 1 < registered_groups.taskflow_max_depth` for the source group. Use the `boards` row only as a consistency check after registration data is confirmed. Verify the person doesn't already have a board in `child_board_registrations`.
2. **WhatsApp group**: Create via `create_group` IPC plugin (no service stop required) or manual fallback.
3. **Registration**: INSERT into `registered_groups` with `taskflow_hierarchy_level = parent_level + 1` and `taskflow_max_depth = max_depth`.
4. **Database seeding**: INSERT into 7 tables:
   - `boards` — with `board_role = 'hierarchy'`, `hierarchy_level`, `max_depth`, `parent_board_id`
   - `child_board_registrations` — links parent board to child board via `person_id`
   - `board_config` — columns, WIP limit, ID counters
   - `board_runtime_config` — language, timezone, cron schedules, runner task IDs, attachment policy
   - `board_admins` — person as `admin_role = 'manager'`, `is_primary_manager = 1`
   - `board_people` — person as member with WIP limit
   - `task_history` — `child_board_created` event on the parent board
5. **CLAUDE.md generation**: From the hierarchy template with board-specific placeholders (`BOARD_ID`, `HIERARCHY_LEVEL`, `MAX_DEPTH`, `PARENT_BOARD_ID`, `BOARD_ROLE`).
6. **`.mcp.json`**: Same as root board, pointing to `/workspace/taskflow/taskflow.db`.
7. **Runner scheduling**: Standup, digest, review (and optional DST guard). Store task IDs in `board_runtime_config`.
8. **Service restart**: To pick up the new group registration.

The child board becomes operational only after all 8 steps are complete.

### Adding or Removing Levels

**To add a level:**

1. Update `max_depth` on all boards: `UPDATE boards SET max_depth = :new_depth WHERE board_role = 'hierarchy'`
2. Update `taskflow_max_depth` in `registered_groups` for all hierarchy groups.
3. Provision new boards at the new depth.

**To remove a level:**

1. Unlink all tasks at the removed level.
2. DELETE registrations for removed boards from `child_board_registrations`.
3. UPDATE `max_depth` on all remaining boards.

Both are operator-time operations. No template or schema changes are needed.

### Board Removal

To detach a child board:

1. Ensure no active linked tasks exist (unlink first).
2. DELETE from `child_board_registrations`.
3. The child board remains SQLite-backed but is no longer linked to any parent.
4. Decommission or re-parent via a separate operator workflow.

### SQLite Database

All hierarchy boards share a single database at `data/taskflow/taskflow.db`.

**WAL mode**: The database runs in WAL (Write-Ahead Logging) mode for concurrent access. The container mount is a directory mount (`data/taskflow/` → `/workspace/taskflow/`) so that the `-wal` and `-shm` journal files persist across container restarts.

**Concurrent access**: Multiple agent containers can read the database simultaneously. SQLite WAL mode handles concurrent reads and serialized writes.

**Backup**: Back up the entire `data/taskflow/` directory (including `taskflow.db`, `taskflow.db-wal`, `taskflow.db-shm`). For a consistent backup, use `sqlite3 data/taskflow/taskflow.db ".backup backup.db"`.

**Conditional mount**: All TaskFlow groups (those with `taskflowManaged=1`) get the taskflow directory mounted. The container runner mounts `data/taskflow/` → `/workspace/taskflow/` for any group with `taskflowManaged` set.

### MCP Server Configuration

Each TaskFlow group has a `.mcp.json` at `groups/<folder>/.mcp.json`:

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": ["-y", "mcp-server-sqlite-npx", "/workspace/taskflow/taskflow.db"]
    }
  }
}
```

This provides `read_query`, `write_query`, `list_tables`, `describe_table`, and `create_table` tools to the agent.

### Database Schema

The SQLite database contains 10 tables. Created by `src/taskflow-db.ts` via `node dist/taskflow-db.js`:

| Table | Purpose |
|-------|---------|
| `boards` | Board identity, hierarchy level, max_depth, parent_board_id |
| `board_people` | Team members per board, with per-person WIP limits |
| `board_admins` | Manager/delegate authorization (`admin_role`: `'manager'` or `'delegate'`) |
| `child_board_registrations` | Links parent board to child board via person_id |
| `tasks` | Active tasks with hierarchy columns (`child_exec_*`, `linked_parent_*`) |
| `task_history` | Full event stream per task (cap at 50 active) |
| `archive` | Completed/cancelled tasks with snapshot and history slice (20 entries) |
| `board_runtime_config` | Language, timezone, runner IDs, cron schedules, DST guard, attachment policy |
| `attachment_audit_log` | Confirmed attachment imports per board |
| `board_config` | Columns, WIP limit, ID counters (next_task_number, etc.) |

Key hierarchy columns on `tasks`:
- `child_exec_enabled` — 1 when task is linked to a child board
- `child_exec_board_id` — which child board handles execution
- `child_exec_rollup_status` — current rollup status (`active`, `blocked`, `at_risk`, `ready_for_review`, `no_work_yet`, `cancelled_needs_decision`)
- `linked_parent_board_id` + `linked_parent_task_id` — upward reference to parent deliverable

### Hierarchy Files Summary

For each hierarchy board/group, the operator provisions:

| File | Purpose |
|------|---------|
| `groups/<folder>/CLAUDE.md` | Generated prompt with hierarchy commands and rollup engine |
| `groups/<folder>/.mcp.json` | SQLite MCP server configuration |
| `data/sessions/<folder>/.claude/settings.json` | Per-group AI model |
| `data/taskflow/taskflow.db` | Shared SQLite database (all boards) |

All TaskFlow boards use SQLite exclusively — no JSON files.

### Hierarchy Troubleshooting

**Board owner cannot create child boards**
- Check `registered_groups.taskflow_hierarchy_level + 1 < taskflow_max_depth` for the source group
- Treat `boards.hierarchy_level` / `boards.max_depth` as a consistency check only; `registered_groups` is the runtime authorization source of truth
- Leaf boards (`taskflow_hierarchy_level + 1 >= taskflow_max_depth`) cannot create children

**Rollup shows stale data**
- The agent refreshes rollup only when the user requests `atualizar status T-XXX`
- There is no automatic background refresh
- The digest and weekly review flag stale rollup (>24h) with `⚠️`

**Child board not responding after provisioning**
- Verify all 8 provisioning steps were completed
- Check `registered_groups` has the correct `taskflow_hierarchy_level` and `taskflow_max_depth`
- Restart NanoClaw to reload group cache
- Verify `.mcp.json` exists in the group folder

## Change Control

For operator-managed changes:

- Prefer updating the TaskFlow skill/template first if the behavior is meant to persist across future boards.
- Prefer updating generated group files only for one-off repairs or recovery.
- Keep the user manual separate from this guide; the operator guide may include setup and runtime details that are not useful to end users.
- Keep native scheduler instructions out of the user manual; expose them only as TaskFlow automations in end-user docs.
