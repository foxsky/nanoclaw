# TaskFlow Operator Guide

Operator guide for provisioning, configuring, and maintaining TaskFlow boards in NanoClaw.

This document is for the system operator or team admin. End users should use [taskflow-user-manual.md](taskflow-user-manual.md).

## Scope

TaskFlow is a config-driven skill package. It does not add new core runtime code. It uses existing NanoClaw capabilities:

- Group-local `CLAUDE.md` prompts
- Shared SQLite database (`data/taskflow/taskflow.db`) for all board data
- Per-group `.mcp.json` for SQLite MCP server configuration
- Per-group `settings.json`
- SQLite-backed `registered_groups` and `scheduled_tasks`
- Existing MCP/IPC tools such as `send_message`, `schedule_task`, `cancel_task`, and `list_tasks`

Each TaskFlow group operates on a board stored in `data/taskflow/taskflow.db`. Multiple groups can share the same board (see Control Group) or have independent boards. There is no automatic cross-board sync.

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
- Board rows in `data/taskflow/taskflow.db` (boards, board_config, board_runtime_config, board_people, board_admins)
- One row in `registered_groups` (with `taskflow_managed = 1`)
- Three scheduled runners in `scheduled_tasks`
- Optional fourth scheduled runner for DST guard

Core runners:

- Morning standup
- Manager digest
- Weekly review

Optional runner:

- DST guard

When a control group is enabled, the operator also provisions a second group folder, registration row, and additional runners based on routing configuration.

## Topology Choices

TaskFlow supports three operator-facing deployment models:

1. **Shared group**: one WhatsApp group, one board. Optionally with a private control group for management (see Control Group below).
2. **Separate groups**: multiple independent boards, each with its own SQLite rows, files, and runners.
3. **Hierarchy (Delegation)**: bounded-recursive boards sharing one SQLite database. One root board at level 1, with optional child boards per person at deeper levels up to `max_depth`.

All topologies use `data/taskflow/taskflow.db` as the task, history, archive, and runtime-config store. Do not create `TASKS.json` or `ARCHIVE.json` for new boards.

## Control Group

When using a shared group topology, the manager can optionally create a **private control group** — a WhatsApp group with only the manager and the bot. Both groups share the same board (same `board_id`, same tasks, people, and history). This keeps management noise out of the team's view.

### How It Works

- The team group and control group are registered as separate entries in `registered_groups`, each with its own folder and `CLAUDE.md`
- Both groups' `.mcp.json` point to the same SQLite database and `board_id`
- Authorization is phone-based (`board_admins` table), so commands work identically in both groups
- `send_message` always goes to the current group's JID — no cross-group messaging

### Runner Routing

Each automation can be routed to the team group, the control group, or both:

| Automation | Default target | Options |
|-----------|---------------|---------|
| Standup | Team group | Control group / Both |
| Digest | Control group | Team group / Both |
| Review | Both | Team group / Control group |

When the target is `'both'`, two runners are created — one per group. The primary runner ID is stored in `runner_*_task_id` and the secondary in `runner_*_secondary_task_id` (both in `board_runtime_config`).

### Database Support

The `board_groups` table maps groups to boards:

```sql
SELECT * FROM board_groups WHERE board_id = 'my-board';
-- Returns two rows: one with group_role='team', one with group_role='control'
```

Routing targets are stored in `board_runtime_config`:

```sql
SELECT standup_target, digest_target, review_target,
       runner_standup_secondary_task_id,
       runner_digest_secondary_task_id,
       runner_review_secondary_task_id
FROM board_runtime_config WHERE board_id = 'my-board';
```

### Provisioning a Control Group

The wizard handles this automatically when the manager selects the control group option. The extra steps beyond a standard board:

1. Create a second WhatsApp group (manager only + bot)
2. Create `groups/<control-folder>/CLAUDE.md` with the `CONTROL_GROUP_HINT` filled in
3. Create `groups/<control-folder>/.mcp.json` (same content as team group)
4. Create `data/sessions/<control-folder>/.claude/settings.json`
5. INSERT a second row in `registered_groups` (with `taskflow_managed = 1`)
6. INSERT a second row in `board_groups` with `group_role = 'control'`
7. UPDATE `board_runtime_config` with routing targets
8. Create additional runners for `'both'` targets, store secondary IDs

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
- Whether to enable a control group (shared group topology only)
- Runner routing preferences (if control group enabled)

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

All TaskFlow boards share a single database at `data/taskflow/taskflow.db`. Created by `src/taskflow-db.ts` via `node dist/taskflow-db.js`.

**WAL mode**: The database runs in WAL (Write-Ahead Logging) mode for concurrent access. The container mount is a directory mount (`data/taskflow/` → `/workspace/taskflow/`) so that the `-wal` and `-shm` journal files persist across container restarts.

**Concurrent access**: Multiple agent containers can read the database simultaneously. SQLite WAL mode handles concurrent reads and serialized writes.

**Backup**: Back up the entire `data/taskflow/` directory (including `taskflow.db`, `taskflow.db-wal`, `taskflow.db-shm`). For a consistent backup, use `sqlite3 data/taskflow/taskflow.db ".backup backup.db"`.

**Container mount**: All TaskFlow groups (those with `taskflow_managed = 1` in `registered_groups`) get the taskflow directory mounted at `/workspace/taskflow/`.

Important data implications:

- Due dates are stored in `tasks.due_date`.
- Tasks track `next_note_id` plus structured note objects in `tasks.notes` (JSON array). Legacy string notes from older boards may still exist and remain readable, but only structured note objects can be edited or removed.
- Tasks track per-task reminders in `tasks.reminders` (JSON array), with one-time scheduler jobs stored as reminder entries on the task itself.
- Runner IDs are stored in `board_runtime_config` columns: `runner_standup_task_id`, `runner_digest_task_id`, `runner_review_task_id`, `runner_dst_guard_task_id`. When a control group is configured, secondary runner IDs use `runner_*_secondary_task_id` columns.
- Cron schedules (local and UTC) are stored in `board_runtime_config`: `standup_cron_local`, `standup_cron_utc`, etc.
- DST guard state is in `board_runtime_config`: `dst_sync_enabled`, `dst_last_offset_minutes`, `dst_last_synced_at`, etc.

#### Legacy JSON Migration

Older boards created before the SQLite-only migration may still have `TASKS.json` and `ARCHIVE.json` files. The CLAUDE.md template includes a legacy JSON migration reference section that agents use to normalize `1.0` schema boards into `2.0` before mutation. New boards should never use JSON files — always use SQLite.

### `CLAUDE.md`

The generated prompt enforces:

- Scope guard for off-topic requests
- Task-specific authorization rules
- Attachment import confirmation rules
- Group-only messaging
- File-write restrictions
- Control group context hint (when applicable)

This file is operator-managed. End users should not modify it.

### `.mcp.json`

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

### `settings.json`

Per-group settings live at:

`data/sessions/<folder>/.claude/settings.json`

This file is pre-created so the selected model is present before the first group session starts.

If you change it later and need to guarantee the new model is picked up, restart the service.

## Registration

Register a TaskFlow board by inserting into `registered_groups`:

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, taskflow_managed) VALUES ('{{GROUP_JID}}', '{{GROUP_NAME}}', '{{GROUP_FOLDER}}', '@{{ASSISTANT_NAME}}', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', NULL, 1, 1);"
```

For hierarchy boards, add the hierarchy columns:

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, taskflow_managed, taskflow_hierarchy_level, taskflow_max_depth) VALUES ('{{GROUP_JID}}', '{{GROUP_NAME}}', '{{GROUP_FOLDER}}', '@{{ASSISTANT_NAME}}', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', NULL, 1, 1, 1, {{MAX_DEPTH}});"
```

Notes:

- `registered_groups` is loaded into memory on process startup.
- After registration changes, restart NanoClaw once to reload the group cache.
- Keep folder names lowercase with hyphens for this skill.
- `taskflow_managed = 1` ensures the container runner mounts the SQLite directory.
- When a control group is enabled, register both groups with `taskflow_managed = 1`.

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

- Reads the current board from SQLite
- Posts the board to the group
- Includes per-person sections inline
- Performs housekeeping such as archival/history cap
- Skips sending if the board has no active tasks

### Digest

- Summarizes overdue, near-due, waiting, stale, and completed-today items
- Skips sending if the board has no active tasks

### Weekly Review

- Summarizes weekly board state
- Includes inbox, waiting, overdue, stale, and next-week preview
- Skips sending if the board has no active tasks, even if there was archive activity that week

### DST Guard

If enabled:

- Checks for timezone offset changes
- Recomputes UTC cron values from stored local schedules in `board_runtime_config`
- Cancels and recreates the core runners if the offset changed
- When a control group is configured, also cancels and recreates secondary runners based on `*_target` columns and `board_groups`
- Updates DST state in `board_runtime_config`

## Task Semantics

Operator-relevant task rules:

- Projects use parent IDs like `P-001`.
- Project subtasks use dotted child IDs like `P-001.1`, `P-001.2`.
- Recurring tasks create the next cycle immediately when a cycle is completed.
- `cancel_task` is for scheduled runner jobs, not normal board task cancellation.
- Normal task cancellation is a board mutation in the SQLite `tasks` → `archive` tables.

### Important Distinction: Two Kinds of "Task"

TaskFlow uses two separate layers:

- Board tasks: user-facing items in the `tasks` SQLite table such as `T-001`, `P-001`, and `R-001`
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

Authorization is phone-based (`board_admins` table), so it works identically regardless of which group the command is sent from (team or control group).

## Runtime Isolation

For non-main groups, the container runtime mounts:

- Writable `/workspace/group/`
- Writable `/workspace/taskflow/` (for TaskFlow-managed groups)
- Read-only `/workspace/global/` if the global folder exists

Non-main groups do not get:

- Project-root access
- Other groups' files
- Cross-group registration/scheduling privileges

## Day-2 Operations

### Add or Update Team Members

Update team members through TaskFlow commands (`cadastrar`, `remover`) or by operator-controlled SQL edits to `board_people` and `board_admins` if recovering from prompt failure.

### Change the Model

1. Edit `data/sessions/<folder>/.claude/settings.json`
2. Ensure ownership is correct
3. Restart NanoClaw to guarantee the change is used

### Change the Schedule

1. Update cron values in `board_runtime_config` (`standup_cron_local`, `standup_cron_utc`, etc.)
2. Cancel the existing runner rows in `scheduled_tasks`
3. Create replacement rows in `scheduled_tasks`
4. Persist new runner IDs in `board_runtime_config` (`runner_standup_task_id`, etc.)
5. If a control group is configured, also update secondary runners and `runner_*_secondary_task_id`

### Pause or Remove Runners

Use task-level operations on the runner IDs stored in `board_runtime_config`:

```sql
SELECT runner_standup_task_id, runner_digest_task_id, runner_review_task_id,
       runner_dst_guard_task_id,
       runner_standup_secondary_task_id, runner_digest_secondary_task_id,
       runner_review_secondary_task_id
FROM board_runtime_config WHERE board_id = 'my-board';
```

Do not confuse runner tasks with normal board tasks.

## Verification Checklist

After provisioning a board:

1. Send `@<assistant> quadro` in the target group.
2. Confirm the group responds with TaskFlow behavior.
3. Create a quick capture item.
4. Verify the task appears in SQLite: `SELECT * FROM tasks WHERE board_id = 'my-board';`
5. Verify runner IDs are stored: `SELECT runner_standup_task_id, runner_digest_task_id, runner_review_task_id FROM board_runtime_config WHERE board_id = 'my-board';`
6. If attachment import is enabled, verify the proposal flow requires the exact `CONFIRM_IMPORT` token.
7. If DST guard is enabled, test in staging before relying on it in production.
8. If a control group is enabled, send `@<assistant> quadro` from the control group and verify it shows the same board state.

## Troubleshooting

### Group Does Not Respond

- Confirm the group is present in `registered_groups`.
- Confirm `taskflow_managed = 1` for TaskFlow groups.
- Restart NanoClaw after registration changes.
- Verify the trigger pattern matches the assistant name.

### Runner Exists But Never Fires

- Check `scheduled_tasks.next_run`
- Verify cron is expressed in server timezone
- Confirm the scheduler loop is running
- Confirm the task `status` is still `active`

### Wrong Model Is Still Used

- Verify the group's `settings.json` exists in the correct folder
- Verify ownership under `data/sessions/`
- Restart NanoClaw

### Attachment Import Fails

- Confirm media support is actually installed and enabled
- Confirm the file is PDF/JPG/PNG and within size limits
- Confirm the user sent the exact `CONFIRM_IMPORT {import_action_id}` command

### Control Group Not Showing Board

- Verify both groups are registered in `registered_groups` with `taskflow_managed = 1`
- Verify both groups have entries in `board_groups` for the same `board_id`
- Verify both groups have `.mcp.json` pointing to the same database
- Restart NanoClaw to reload group cache

## Database Schema

The SQLite database contains 11 tables. Created by `src/taskflow-db.ts` via `node dist/taskflow-db.js`:

| Table | Purpose |
|-------|---------|
| `boards` | Board identity, primary group JID/folder, hierarchy level, max_depth, parent_board_id |
| `board_people` | Team members per board, with per-person WIP limits |
| `board_admins` | Manager/delegate authorization (`admin_role`: `'manager'` or `'delegate'`) |
| `child_board_registrations` | Links parent board to child board via person_id |
| `tasks` | Active tasks with hierarchy columns (`child_exec_*`, `linked_parent_*`) |
| `task_history` | Full event stream per task (cap at 50 active) |
| `archive` | Completed/cancelled tasks with snapshot and history slice (20 entries) |
| `board_runtime_config` | Language, timezone, runner IDs, cron schedules, DST guard, attachment policy, control group routing |
| `attachment_audit_log` | Confirmed attachment imports per board |
| `board_groups` | Maps multiple WhatsApp groups to a single board (used by control group feature) |
| `board_config` | Columns, WIP limit, ID counters (next_task_number, etc.) |

### `board_runtime_config` Columns

Core columns: `language`, `timezone`, `runner_standup_task_id`, `runner_digest_task_id`, `runner_review_task_id`, `runner_dst_guard_task_id`, cron schedules (`*_cron_local`, `*_cron_utc`), DST state (`dst_sync_enabled`, `dst_last_offset_minutes`, `dst_last_synced_at`, `dst_resync_count_24h`, `dst_resync_window_started_at`), attachment policy (`attachment_enabled`, `attachment_disabled_reason`, `attachment_allowed_formats`, `attachment_max_size_bytes`).

Control group routing columns (defaults are overridden by the wizard when control group is enabled):
- `standup_target` — `'team'`, `'control'`, or `'both'` (default: `'team'`)
- `digest_target` — same values (default: `'team'`)
- `review_target` — same values (default: `'team'`)
- `runner_standup_secondary_task_id` — secondary runner ID when target is `'both'`
- `runner_digest_secondary_task_id` — secondary runner ID when target is `'both'`
- `runner_review_secondary_task_id` — secondary runner ID when target is `'both'`

### `board_groups` Table

Maps WhatsApp groups to boards for the control group feature:

```sql
CREATE TABLE board_groups (
  board_id TEXT NOT NULL REFERENCES boards(id),
  group_jid TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  group_role TEXT NOT NULL DEFAULT 'team',  -- 'team' or 'control'
  PRIMARY KEY (board_id, group_jid)
);
```

For single-group boards, `board_groups` may have one row or none (the canonical group is always in `boards.group_jid`). For control group setups, it has two rows.

Key hierarchy columns on `tasks`:
- `child_exec_enabled` — 1 when task is linked to a child board
- `child_exec_board_id` — which child board handles execution
- `child_exec_rollup_status` — current rollup status (`active`, `blocked`, `at_risk`, `ready_for_review`, `no_work_yet`, `cancelled_needs_decision`)
- `linked_parent_board_id` + `linked_parent_task_id` — upward reference to parent deliverable

### Files Summary

For each TaskFlow board/group, the operator provisions:

| File | Purpose |
|------|---------|
| `groups/<folder>/CLAUDE.md` | Generated prompt with TaskFlow commands |
| `groups/<folder>/.mcp.json` | SQLite MCP server configuration |
| `data/sessions/<folder>/.claude/settings.json` | Per-group AI model |
| `data/taskflow/taskflow.db` | Shared SQLite database (all boards) |

When a control group is enabled, the control group folder gets its own `CLAUDE.md`, `.mcp.json`, and `settings.json` — all pointing to the same `board_id` and database.

## Hierarchy Mode

### Initial Setup

To provision a hierarchy board, run `/add-taskflow` and select the "Hierarchy (Delegation)" topology. During setup, also specify:

- **Hierarchy depth (`max_depth`)**: minimum 2, default 2. Depth 1 is just a standard board.

The wizard:

1. Creates the SQLite database at `data/taskflow/taskflow.db` via `node dist/taskflow-db.js` (11 tables, WAL mode, foreign keys).
2. Writes `.mcp.json` to the group folder to configure the `mcp-server-sqlite-npx` MCP server.
3. Seeds the root board data into `boards`, `board_config`, `board_runtime_config`, and `board_admins`.
4. Stores runner scheduled task IDs in `board_runtime_config` (columns: `runner_standup_task_id`, `runner_digest_task_id`, `runner_review_task_id`, `runner_dst_guard_task_id`).
5. Registers the group in `registered_groups` with TaskFlow metadata.

### Child Board Provisioning

Child boards are provisioned through the SKILL.md Phase 6 workflow. The process starts when a board owner requests `criar quadro para [pessoa]` — the agent emits a provisioning request, and the operator completes it:

1. **Pre-flight**: Verify parent level < max_depth. Verify person doesn't already have a board in `child_board_registrations`.
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

### Hierarchy Troubleshooting

**Board owner cannot create child boards**
- Check `hierarchy_level < max_depth` in the `boards` table
- Leaf boards (`hierarchy_level == max_depth`) cannot create children

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
