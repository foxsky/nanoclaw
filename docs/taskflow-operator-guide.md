# TaskFlow Operator Guide

Operator guide for provisioning, configuring, and maintaining TaskFlow boards in NanoClaw.

This document is for the system operator or team admin. End users should use [taskflow-user-manual.md](taskflow-user-manual.md).
For meeting-specific queries and options, see [taskflow-meetings-reference.md](taskflow-meetings-reference.md).

## Scope

TaskFlow is a config-driven skill package. It does not add new core runtime code. It uses existing NanoClaw capabilities:

- Group-local `CLAUDE.md` prompts
- Shared SQLite database at `data/taskflow/taskflow.db`
- Per-group `settings.json`
- SQLite-backed `registered_groups` and `scheduled_tasks`
- Existing MCP/IPC tools such as `send_message` (with optional `target_chat_jid` for cross-group), `schedule_task`, `cancel_task`, and `list_tasks`

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
- Manager phone (digits only — automatically resolved to the correct WhatsApp JID format via `onWhatsApp()` lookup)
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

Use the Baileys `groupCreate` flow described in the TaskFlow skill. Phone numbers are automatically resolved to the correct WhatsApp JID via `onWhatsApp()` before group creation — no need to manually adjust number formats (e.g. Brazilian 9th-digit prefix). Shared-team boards can be created with only the manager initially, then members can be added later.

### New Group (Manual Fallback)

If automatic creation is not practical:

1. Create the group manually in WhatsApp.
2. Add the bot.
3. Send a message in the group.
4. Clear the group sync cache and restart NanoClaw.
5. Query `chats` again to discover the new JID.

## Files and Data

### SQLite Database

All board data is stored in `data/taskflow/taskflow.db`. The database is created by `src/taskflow-db.ts` and contains 9 actively used tables (see the Database Schema section below).

Key data stored per board:

- Board metadata in `boards`, `board_config`, `board_runtime_config`
- Team members in `board_people`
- Admin/manager roles in `board_admins`
- Active tasks in `tasks`
- Task event history in `task_history`
- Completed/cancelled tasks in `archive`
- Runner IDs and cron schedules in `board_runtime_config`
- DST sync state in `board_runtime_config`

Note: the `attachment_audit_log` table exists in the schema but is not currently populated in production — attachment auditing is not an active feature. Operators should not rely on it for audit trails.

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

### Daily Auditor

A scheduled task runs at 04:00 BRT every day to review the previous day's WhatsApp interactions against `task_history` and `scheduled_tasks`. The script is defined at `container/agent-runner/src/auditor-script.sh`; tune it via the following hooks:

- **Cron schedule**: edit the `scheduled_tasks` row for the auditor runner in `data/store/messages.db`. Default is `0 4 * * *` (Fortaleza local time). Operators can also adjust the severity threshold for which interactions appear in the report.
- **Unfulfilled write-request detection**: the auditor flags user requests that should have produced a `task_history` mutation but did not. Tune the request-pattern lists in `auditor-script.sh` if coverage drifts.
- **Delayed-response threshold**: the 5-minute response threshold is currently hardcoded via the `RESPONSE_THRESHOLD_MS` constant (default 300000 ms / 5 minutes) in `auditor-script.sh`. Operators should be aware this is a compile-time value — changing it requires editing the script and rebuilding the container.
- **Refusal patterns**: the `REFUSAL_PATTERN` regex in the same file matches bot phrases that count as refusals. Tune if false positives appear on legitimate refusals (e.g. permission denials).
- **Severity classification**: the auditor rubric assigns one of 5 severity emoji to each flagged interaction so operators can triage audit reports:
  - 🔴 unfulfilled write request (highest priority)
  - 🟠 template/coverage gap
  - 🟡 delayed response (>5 min)
  - 🔵 missing feature / not implemented
  - ⚪ UX suggestion (lowest priority)

The daily auditor is distinct from the TaskFlow board runners (standup, digest, weekly review). It is a separate operator-owned scheduled task — manage it via the general scheduled-task workflow in "Day-2 Operations" below.

## Task Semantics

Operator-relevant task rules:

- Projects use parent IDs like `P1`.
- Project subtasks are stored as real task rows with `parent_task_id` pointing to the parent project. Subtask IDs use dotted notation: `P1.1`, `P1.2`.
- Subtasks can be assigned to different team members. Assigned subtasks count toward the assignee's WIP limit.
- Recurring tasks create the next cycle immediately when a cycle is completed.
- `cancel_task` is for scheduled runner jobs, not normal board task cancellation.
- Normal task cancellation is a board mutation in the `tasks` and `archive` tables.

### Important Distinction: Two Kinds of "Task"

TaskFlow uses two separate layers:

- Board tasks: user-facing items in the `tasks` table such as `T1`, `P1`, and `R1`
- Scheduler tasks: operator/runtime rows in `scheduled_tasks` used for standup, digest, review, and optional DST guard

These are not interchangeable:

- Users should interact with board tasks through TaskFlow commands in WhatsApp.
- Operators may manage scheduler tasks when maintaining automations.
- Never present scheduler task IDs as if they were normal board task IDs.

## Permissions Model

The generated prompt enforces:

- Full-manager-only creation of complete tasks (`tarefa`, `projeto`, `diario`, `semanal`, `mensal`, `anual`)
- Delegate-or-manager inbox processing and review approval/rejection
- Assignee-or-manager reassignment (no WIP check on reassign; auto-links to child board if target has one, regardless of prior link state)
- Full-manager-only admin actions (WIP overrides, people changes, manager/delegate changes, cancel, bulk reassign)
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

**Exception — TaskFlow cross-group messaging:** Groups with `taskflowManaged=1` can send messages to other TaskFlow-managed groups using the `target_chat_jid` parameter on `send_message`. This is used for cross-group notifications in hierarchy setups (e.g., notifying an assignee in their child group when a task is assigned on the parent board). The IPC authorization layer permits TaskFlow-to-TaskFlow messaging; non-TaskFlow groups remain restricted to their own group.

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

### Manage Board Holidays

Each hierarchy board has its own holiday calendar in the `board_holidays` table. Holidays affect due-date rollover — tasks that fall on a holiday are pushed forward to the next business day. Operators can pre-populate or bulk-replace the calendar via the `manage_holidays` admin action from inside the group (full-manager only):

- `manage_holidays add` — add a single date (with optional label) to the current board's calendar.
- `manage_holidays remove` — delete a single date from the calendar.
- `manage_holidays set_year` — replace the entire calendar for a given year in one atomic operation. Use this to seed a board from an annual holiday list or to wipe and reload after a policy change.

All three variants record an entry in `task_history` and are scoped to the board where the command runs. For audit purposes, the `board_holidays` table can also be inspected or edited directly via SQLite if the agent is unavailable, but prefer the admin action when possible so the history row is written.

### Scheduled Task Cron Management (General)

Beyond TaskFlow runners (standup, digest, weekly review, DST guard) and the daily auditor, operators may add, edit, or remove any `scheduled_tasks` row directly to wire up new automations or tune existing ones:

1. Insert the row with `context_mode='group'` and a valid non-null `next_run`, or the scheduler loop will never pick it up.
2. Express cron in the server timezone (resolve `process.env.TZ` or the host timezone — do not assume UTC).
3. After insertion, verify `status='active'` and that `next_run` is in the future.
4. To edit an existing row, update the cron expression and recompute `next_run` manually — the scheduler does not recompute on its own.
5. To pause or remove, flip `status` to `inactive` or delete the row outright.

This is the fallback path for any automation not covered by the board-runner helpers. Reserve it for operator-level maintenance; end users should continue interacting with TaskFlow via board commands rather than SQL edits.

## Board Display Format

The CLAUDE.md template prescribes a standard visual format for the `quadro` command:

```
📊 *Board — QUARTA, 04/03/2026*

⏭️ *Next Action (3):*
• 🔗 T001 (Alexandre): Title → _next action text_ ⏰ vence 10/03
• T005 (Rafael): Title → _next action text_ ⏰ vence 06/03 ⚠️

🔄 *In Progress (1):*
• 🔗 T004 (Giovanni): Title → _status update_ ⏰ vence 31/03

---

📋 *Alexandre:*
⏭️ T001: Title
⏭️ T002: Title ⚠️ vence sexta
_WIP: 0/3_

⚠️ *Atenção:* T002 vence em 2 dias (06/03 — sexta). Alexandre, alguma atualização?
```

Key elements: date header, column emojis (📥 ⏭️ 🔄 ⏳ 🔍), link markers (🔗), due date warnings (⚠️ near, 🔴 overdue), per-person WIP sections.

## Verification Checklist

After provisioning a board:

1. Send `@<assistant> quadro` in the target group.
2. Confirm the group responds with the standard board display format (date header, column emojis, link markers, per-person WIP).
3. Create a quick capture item.
4. Confirm the task appears in the `tasks` table.
5. Confirm runner IDs are stored in `board_runtime_config`.
6. If attachment import is enabled, verify the proposal flow requires the exact `CONFIRM_IMPORT` token.
7. If DST guard is enabled, test in staging before relying on it in production.

## Troubleshooting

### Group Does Not Respond

- Confirm the group is present in `registered_groups`.
- Restart NanoClaw after registration changes.
- Verify the trigger pattern matches the assistant name. Each group can have its own trigger via the `trigger_pattern` column in `registered_groups` — it does not have to match the global `ASSISTANT_NAME` in `.env`.

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

1. Creates the SQLite database at `data/taskflow/taskflow.db` via `node dist/taskflow-db.js` (9 actively used tables, WAL mode, foreign keys).
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

Child boards are provisioned **automatically** via the `provision_child_board` IPC plugin. Provisioning is triggered when:

- A person is registered via `cadastrar` on a non-leaf hierarchy board
- A manager assigns a task to an unknown person and confirms registration (the agent asks for phone and role, then runs the `cadastrar` flow)
- A board owner explicitly requests `criar quadro para [pessoa]`

The host-side plugin handles the full lifecycle asynchronously — no operator intervention required. Child boards are registered with `requires_trigger = 0` so the person can message without prefixing `@Case` (they are personal boards with a single user). The steps below document what the plugin does (and serve as a manual fallback for troubleshooting):

1. **Pre-flight**: Verify `registered_groups.taskflow_hierarchy_level + 1 < registered_groups.taskflow_max_depth` for the source group. Use the `boards` row only as a consistency check after registration data is confirmed. Verify the person doesn't already have a board in `child_board_registrations`.
2. **WhatsApp group**: Create via `create_group` IPC plugin (no service stop required) or manual fallback.
3. **Registration**: INSERT into `registered_groups` with `taskflow_hierarchy_level = parent_level + 1` and `taskflow_max_depth = max_depth`.
4. **Database seeding**: INSERT into 7 tables:
   - `boards` — with `board_role = 'hierarchy'`, `hierarchy_level`, `max_depth`, `parent_board_id`
   - `child_board_registrations` — links parent board to child board via `person_id`
   - `board_config` — columns, WIP limit, ID counters
   - `board_runtime_config` — language, timezone, cron schedules, runner task IDs, attachment policy
   - `board_admins` — person as `admin_role = 'manager'`, `is_primary_manager = 1`
   - `board_people` — person as member with WIP limit and `notification_group_jid`
   - `task_history` — `child_board_created` event on the parent board
   - **Parent board UPDATE**: set `notification_group_jid` on the parent's `board_people` row for the person to point to the child group's JID (enables cross-group notifications)
5. **CLAUDE.md generation**: From the hierarchy template with board-specific placeholders (`BOARD_ID`, `HIERARCHY_LEVEL`, `MAX_DEPTH`, `PARENT_BOARD_ID`, `BOARD_ROLE`).
6. **`.mcp.json`**: Same as root board, pointing to `/workspace/taskflow/taskflow.db`.
7. **Runner scheduling**: Standup, digest, review (and optional DST guard). Store task IDs in `board_runtime_config`.
8. **Service restart**: To pick up the new group registration.

The child board becomes operational after all 8 steps are complete. With auto-provisioning, these steps happen within seconds of the `cadastrar` command.

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

The SQLite database contains 9 actively used tables (plus an unused `attachment_audit_log` table in the schema that is not populated in production). Created by `src/taskflow-db.ts` via `node dist/taskflow-db.js`:

| Table | Purpose |
|-------|---------|
| `boards` | Board identity, hierarchy level, max_depth, parent_board_id |
| `board_people` | Team members per board, with per-person WIP limits and `notification_group_jid` for cross-group notifications |
| `board_admins` | Manager/delegate authorization (`admin_role`: `'manager'` or `'delegate'`) |
| `child_board_registrations` | Links parent board to child board via person_id |
| `tasks` | Active tasks with hierarchy columns (`child_exec_*`, `linked_parent_*`) and `parent_task_id` for project subtask rows |
| `task_history` | Full event stream per task (cap at 50 active) |
| `archive` | Completed/cancelled tasks with snapshot and history slice (20 entries) |
| `board_runtime_config` | Language, timezone, runner IDs, cron schedules, DST guard, attachment policy |
| `board_config` | Columns, WIP limit, ID counters (next_task_number, etc.) |

Key hierarchy columns on `tasks`:
- `child_exec_enabled` — 1 when task is linked to a child board
- `child_exec_board_id` — which child board handles execution
- `child_exec_rollup_status` — current rollup status (`active`, `blocked`, `at_risk`, `ready_for_review`, `no_work_yet`, `cancelled_needs_decision`)
- `linked_parent_board_id` + `linked_parent_task_id` — upward reference to parent deliverable
- `parent_task_id` — set on subtask rows to reference the parent project (e.g., `P4.1` has `parent_task_id = 'P4'`)

### Cross-Group Notifications

In hierarchy setups, notifications need to reach people in their working group, not just the board where the task lives. For example, if Giovanni is assigned a task on the SEC-SECTI parent board, but his working group is SECI-SECTI, the notification should go to SECI-SECTI.

**How it works:**

1. Each person in `board_people` has an optional `notification_group_jid` column. When set, notifications for that person are sent to the specified group JID instead of the current group.

2. The `send_message` MCP tool accepts an optional `target_chat_jid` parameter. When a TaskFlow MCP tool performs a mutation, the engine's internal `resolveNotifTarget` queries `notification_group_jid` from `board_people` and includes it in the returned `notifications` array. The agent then dispatches each notification via `send_message` with the given `target_chat_jid`.

3. The IPC authorization layer allows TaskFlow groups (`taskflowManaged=1`) to send to other TaskFlow groups. Non-TaskFlow groups remain restricted.

**Setting up cross-group notifications:**

During child board provisioning (Phase 3 Step 6 of SKILL.md), after creating the child WhatsApp group, the parent board's `board_people` row for that person is updated:

```sql
UPDATE board_people SET notification_group_jid = '{{CHILD_GROUP_JID}}'
WHERE board_id = '{{PARENT_BOARD_ID}}' AND person_id = '{{PERSON_ID}}';
```

For existing boards, populate manually:

```sql
-- Find person-to-group mappings
SELECT cbr.person_id, cbr.child_board_id, bp.name
FROM child_board_registrations cbr
JOIN board_people bp ON bp.board_id = cbr.parent_board_id AND bp.person_id = cbr.person_id;

-- Cross-reference with registered_groups to get JIDs
SELECT rg.jid, rg.folder FROM registered_groups WHERE folder = '{{CHILD_FOLDER}}';

-- Update
UPDATE board_people SET notification_group_jid = '{{CHILD_GROUP_JID}}'
WHERE board_id = '{{PARENT_BOARD_ID}}' AND person_id = '{{PERSON_ID}}';
```

**Authorization model:**

| Source | Target | Allowed |
|--------|--------|---------|
| Main | Any registered group | Yes |
| TaskFlow group | Another TaskFlow group | Yes |
| TaskFlow group | Non-TaskFlow group | No |
| Non-TaskFlow group | Any other group | No |
| Any group | Same group (self) | Yes |

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
- The agent refreshes rollup only when the user requests `atualizar status TXXX` on a board that has delegated the same deliverable further down
- Receiving boards can still move linked tasks directly through normal GTD phases; refresh is for pulling child-board progress, not for normal worker updates
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
