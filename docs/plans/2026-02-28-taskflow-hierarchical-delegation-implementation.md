# TaskFlow — Bounded-Recursive Hierarchy Implementation Plan (SQLite)

**Date**: 2026-02-28
**Status**: Implemented (active SQLite storage/provisioning baseline; hierarchy rules included; production hardening follow-up required)

## Transition Note

This implementation plan is the active storage and provisioning reference for TaskFlow. The shared SQLite schema is the current baseline for all TaskFlow topologies; hierarchy mode adds bounded-recursive child-board registration and rollup rules on top of that same storage model. Any remaining JSON references in this file are legacy migration notes only.

## Goal

Implement the shared SQLite TaskFlow model described in `docs/plans/2026-02-28-taskflow-hierarchical-delegation-design.md`, including the bounded-recursive hierarchy behavior when enabled:

- one root board with `max_depth` controlling the hierarchy depth
- one persistent board per person at each level
- one generic data model at every level (same SQL schema, same commands, same rollup)
- adjacent-only rollup via SQL queries against a shared SQLite database
- one set of commands that works identically at any level

All board data lives in a shared SQLite database accessed through an off-the-shelf SQLite MCP server. Any board can query any other board's data. Authorization is prompt-enforced. This same runtime/storage model is the intended end state for all TaskFlow topologies once the JSON-backed boards are migrated.

The assistant remains a direct root-level role by default.

**Infrastructure source changes** (routing, container awareness, IPC plugins) are already in place. The hierarchy logic itself remains template-only — board commands, rollup rules, and authorization are all prompt-enforced via CLAUDE.md.

## 2026-03-06 Production Hardening Addendum

Investigation of the live `P16.2` failure exposed a real deployment/data-drift issue:

- some live boards still carried legacy project `subtasks` JSON
- runtime prompts already assumed subtasks were first-class task rows
- delegated subtasks were expected to be executable from the assignee child board

The immediate runtime fix added startup schema backfill plus legacy subtask migration, but three follow-up requirements must be treated as part of the active implementation plan.

### A. Restore Must Recreate Migrated Project Subtasks

Once legacy project subtasks are migrated into real task rows, `cancel_task` archives the parent and deletes all `parent_task_id` children. `restore_task` must therefore restore the full project tree, not only the parent row.

Required behavior:

- archiving a project must preserve the child task rows needed for restore
- restoring a project must recreate all archived `parent_task_id` rows with their original assignee, column, child-board link state, and history context
- restore must work for both:
  - projects created natively with real subtask rows
  - projects that were backfilled from legacy `subtasks` JSON

Implementation options:

1. archive child rows explicitly in `archive.history` / `task_snapshot` alongside the parent snapshot
2. or archive project children as separate archive records and restore them transactionally with the parent

Constraint:

- do not rely on `tasks.subtasks` JSON as the restore source after migration, because successful migration clears that field

### B. Child-Board Undo Must Work For Delegated Subtasks

Delegated subtasks are now actionable from the child board through `child_exec_board_id`, but `undo` still searches only local `board_id`.

Required behavior:

- if Rafael concludes delegated subtask `P16.2` from his board, `undo` from Rafael's board must find and revert that mutation
- undo authorization must still follow the current rule:
  - mutation author or manager
- undo must target the owning row (`tasks.board_id`) while remaining discoverable from the visible child-board scope

Implementation note:

- `undo` should resolve the latest mutation over the same visible task scope used by `getTask`, then write the restore against the owning board row

### C. Legacy Migration Must Reconcile, Not Only Detect Existence

The current migration bridge is not complete if it only checks "row exists". A partially migrated board may already contain `P16.2`, but with broken linkage or missing `parent_task_id`.

Required behavior:

- migration must validate existing candidate subtask rows for:
  - `parent_task_id`
  - assignee
  - column/state
  - `child_exec_enabled`
  - `child_exec_board_id`
  - `child_exec_person_id`
- if the row exists but does not match the canonical migrated shape, migration must repair it
- clear legacy `tasks.subtasks` only after every referenced subtask row both exists and matches the reconciled target state

This is required in both:

- runtime startup migration in `container/agent-runner/src/taskflow-engine.ts`
- host DB init/migration in `src/taskflow-db.ts`

### D. Mandatory Regression Coverage

Add and keep regression tests for:

1. `cancel_task` + `restore_task` on a project with real subtask rows
2. `cancel_task` + `restore_task` on a project backfilled from legacy JSON subtasks
3. `undo` from a child board after moving a delegated subtask
4. migration reconciliation when a dotted subtask row already exists but is missing:
   - `parent_task_id`
   - child-board linkage
   - or correct assignee/column state

### E. Rollout Rule

The runtime migration bridge is temporary compatibility logic, not the target model.

Target model remains:

- a subtask is a normal task row
- it may have its own assignee independent of the parent project
- its only structural distinction is `parent_task_id`
- child-board execution must be driven by the subtask row's own delegation/link state

## Infrastructure Already In Place

The following source-level changes have already been implemented:

| Component | File(s) | What's Done |
|-----------|---------|-------------|
| **RegisteredGroup type** | `src/types.ts` | `taskflowManaged`, `taskflowHierarchyLevel`, `taskflowMaxDepth` fields |
| **DB schema** | `src/db.ts` | Three columns in `registered_groups` with migration code |
| **Container input** | `src/container-runner.ts` | `ContainerInput` passes TaskFlow fields via stdin |
| **Container env vars** | `container/agent-runner/src/ipc-mcp-stdio.ts` | `NANOCLAW_IS_TASKFLOW_MANAGED`, `NANOCLAW_TASKFLOW_HIERARCHY_LEVEL`, `NANOCLAW_TASKFLOW_MAX_DEPTH` |
| **IPC plugin mechanism** | `src/ipc.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts` | Handler registry + plugin loader (host + container) |
| **`create_group` plugin** | `src/ipc-plugins/create-group.ts`, `container/agent-runner/src/mcp-plugins/create-group.ts` | Hierarchy-depth-aware auth (`level + 1 < maxDepth`) |
| **`register_group` MCP tool** | `container/agent-runner/src/ipc-mcp-stdio.ts` | Accepts `taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth` when exposed to an authorized provisioning context |
| **Host-side group registration** | `src/ipc.ts` | `handleRegisterGroup` persists TaskFlow metadata with validation |
| **Host-side `better-sqlite3`** | `package.json`, `src/db.ts` | Already used for `store/messages.db` — reuse for `data/taskflow/taskflow.db` setup |

## Success Criteria

The feature is complete when all of the following are true:

- All board data is stored in a shared SQLite database (`data/taskflow/taskflow.db`).
- A SQLite MCP server provides `read_query` and `write_query` tools to agents.
- Any non-leaf board can register child boards in `child_board_registrations`.
- Tasks at any non-leaf level can link to registered child boards via `child_exec_*` columns.
- While linked, the receiving board can still move the task directly unless it is explicitly pulling rollup from its own immediate child board.
- Rollup runs only across adjacent levels via SQL queries (each board refreshes independently).
- Leaf boards (`hierarchy_level == max_depth`) cannot have child boards or downward link commands.
- The same commands, data model, and rollup engine work at every level.
- Adding a level requires only changing `max_depth` and provisioning boards, not template changes.
- All boards preserve the existing TaskFlow v2 feature set: manager/delegate authorization, per-person WIP overrides, attachment intake policy + audit trail, reminders, dependencies, statistics, changelog/history views, and the existing standup/digest/review (+ optional DST guard) runner model.
- The runtime prompt, templates, tests, and documentation all describe the same bounded-recursive SQLite-based model.

## Non-Goals

- No unbounded recursion (depth is always capped by `max_depth`)
- No non-adjacent rollup (no grandchild reads)
- No dedicated assistant board in the base rollout
- No mirrored task trees across levels (child boards see parent tasks via `child_exec_board_id` reference, not copies)
- No custom MCP server — use `mcp-server-sqlite-npx` (Node.js port of the official reference server)
- No code-level access control per board (authorization is prompt-enforced)

## Architecture Decision

### Storage

All boards share a single SQLite database at `data/taskflow/taskflow.db`. The database is mounted into each agent container. The `mcp-server-sqlite-npx` package (Node.js port of the official MCP SQLite reference server) provides `read_query`, `write_query`, `create_table`, `list_tables`, and `describe_table` tools.

NanoClaw already uses `better-sqlite3` on the host side (`src/db.ts` → `store/messages.db`). The setup wizard reuses `better-sqlite3` to create and seed `data/taskflow/taskflow.db` during provisioning. Agents in containers access it through the MCP server at runtime.

### Cross-Board Reads

Any board can query any other board's data via SQL. The template instructs:

- a board may query its own data freely
- a board may query registered child boards for rollup
- a board must not query sibling boards, grandchild boards, or parent board task lists

This is softer than filesystem-level isolation but matches the existing TaskFlow authorization model — all rules are prompt-enforced.

### Board Role and Depth

Use a single role discriminator:

- `board_role = 'hierarchy'` — board participates in the bounded hierarchy
- `board_role = 'standard'` — normal single-board TaskFlow (default)

Depth is tracked by:

- `hierarchy_level`: integer >= 1, this board's depth when hierarchy is enabled
- `max_depth`: integer >= 1, where `1` is the single-board case and `>= 2` enables child-board delegation

Missing or unknown `board_role` must be treated as `'standard'`.

## Phase 1: Database Schema

### 1.1 SQLite MCP Server Setup

Configure `mcp-server-sqlite-npx` as an MCP server in the agent container. This Node.js package (already pre-installed in the container image) provides SQL tool access to the mounted SQLite database — no new database engine is installed.

**Package:** `mcp-server-sqlite-npx@0.8.0`

**Tools provided:**

| Tool | Description |
|------|-------------|
| `read_query` | Execute a SELECT query |
| `write_query` | Execute INSERT, UPDATE, or DELETE |
| `create_table` | Execute a CREATE TABLE statement |
| `list_tables` | List all tables |
| `describe_table` | Get schema for a specific table |

**Container setup:**
1. Add `mcp-server-sqlite-npx` to `container/agent-runner/package.json`
2. Configure as an MCP server in the agent runner's MCP config, pointing at `/workspace/taskflow/taskflow.db`
3. Mount `data/taskflow/` into the container at `/workspace/taskflow/` (read-write, WAL mode — directory mount so `-wal`/`-shm` files persist)

**Host setup:**
- The setup wizard uses the existing `better-sqlite3` dependency (already in `package.json`) to create and seed `data/taskflow/taskflow.db`
- No additional host-side dependencies needed

The database file is at `data/taskflow/taskflow.db`, mounted into each agent container at `/workspace/taskflow/taskflow.db`.

### 1.2 Database Tables

Create the schema as specified in the design doc:

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

### 1.3 Key Schema Notes

- `labels`, `blocked_by`, `reminders`, `notes`, `subtasks`, `recurrence`, `current_cycle`, `board_runtime_config.attachment_allowed_formats`, `attachment_audit_log.affected_task_refs`, and `archive.task_snapshot` are stored as JSON text columns. SQLite has native JSON functions for querying these.
- `_last_mutation` stores a JSON snapshot of the task before the last mutation (for undo).
- `next_action`, `waiting_for`, `next_note_id`, and `updated_at` remain first-class task fields so hierarchy boards preserve the current TaskFlow v2 command surface.
- `board_people.wip_limit` preserves the existing per-person WIP override model. `board_config.wip_limit` remains the board default fallback.
- `board_admins` preserves the existing manager/delegate authorization model in SQL form; `is_primary_manager = 1` is the hierarchy equivalent of the legacy single-manager fallback.
- The primary full-manager row in `board_admins` must always have a matching `board_people` row, even if that person should not receive routine assignments. During migration from legacy JSON boards, synthesize that `board_people` row from `meta.manager` / `meta.managers[]` when it is missing from `people[]`.
- `child_exec_*` columns on the tasks table hold the hierarchy linkage. No separate table needed because each task has at most one child execution link.
- `linked_parent_board_id` + `linked_parent_task_id` is the fully qualified upward reference.
- `archive.task_snapshot` stores the archived task payload (including parent linkage, but excluding the separately retained history slice), while `archive.history` stores only the latest 20 history entries and `archive_reason` distinguishes cancelled work from other archive reasons.
- `board_runtime_config` preserves language, timezone, runner IDs, cron schedules, DST guard state, and attachment policy so hierarchy boards keep the same runner + attachment behavior as standard TaskFlow boards.
- `attachment_audit_log` preserves the existing attachment audit trail for confirmed imports on hierarchy boards.
- `task_history` must continue to store the existing TaskFlow v2 history action set; the hierarchy actions below are additive, not a replacement.
- Board-local task IDs (T1, P1, R1) are scoped by `board_id` in the composite primary key.

### 1.4 History Actions

Add hierarchy-specific history actions (recorded in `task_history`) in addition to the existing TaskFlow v2 actions:

- `child_board_created`
- `child_board_removed`
- `child_board_linked`
- `child_board_unlinked`
- `child_rollup_updated` — every rollup refresh, regardless of status change
- `child_rollup_blocked` — `rollup_status` transitions to `blocked`
- `child_rollup_at_risk` — `rollup_status` transitions to `at_risk` because tagged child work is overdue
- `child_rollup_completed` — `rollup_status` transitions to `ready_for_review` or `completed`
- `child_rollup_cancelled` — one or more tagged child tasks were archived with `archive_reason = 'cancelled'`

These must be recorded as INSERT into `task_history` when the corresponding event occurs. The same action names apply at every level.

### 1.5 Allowed `rollup_status` Values

This is a closed set. No other values are valid:

- `active`
- `blocked`
- `at_risk`
- `ready_for_review`
- `completed`
- `cancelled_needs_decision`

### 1.6 Template Files

Update:

- `.claude/skills/add-taskflow/templates/CLAUDE.md.template` — add hierarchy sections
Requirements:

- `.claude/skills/add-taskflow/templates/CLAUDE.md.template` — add hierarchy sections for SQLite-based boards
- All boards use the shared SQLite schema for data storage
- Legacy `TASKS.json.template` and `ARCHIVE.json.template` references are migration-only artifacts, not the active provisioning path. Keep them only until the SQLite migration and verification pass, then remove them.
- Missing or unknown `board_role` must be treated as `standard`
- Hierarchy mode must preserve the existing TaskFlow v2 command families (capture, movement, queries, attachments, reminders, dependencies, archive, changelog, statistics) and IPC tool usage (`send_message`, `schedule_task`, `cancel_task`, `list_tasks`)
- No migration should break current single-board TaskFlow users
- Standard boards and hierarchy boards share the same storage/runtime baseline; hierarchy adds only the extra delegation and rollup rules

## Phase 2: Setup and Provisioning

### 2.1 Initial Setup (Root Board)

Extend `.claude/skills/add-taskflow/SKILL.md` so the initial setup provisions the root board with the full existing TaskFlow runtime configuration:

- Create the SQLite database (`data/taskflow/taskflow.db`) with the schema from Phase 1 using `better-sqlite3` (already in host `package.json`)
- Configure the `mcp-server-sqlite-npx` MCP server in the agent's MCP config
- Create the WhatsApp group via the `create_group` IPC plugin (no service stop) or find an existing group
- Register the group by direct `INSERT INTO registered_groups` (same setup-time pattern as standard TaskFlow) with `taskflow_managed = true`, `taskflow_hierarchy_level = 0`, `taskflow_max_depth = <desired>`; equivalent approved operator automation may wrap this write
- INSERT the root board with `hierarchy_level = 1` and the desired `max_depth`
- INSERT `board_config` with defaults
- INSERT `board_runtime_config` with language, timezone, runner cron values, DST guard state, and attachment policy
- INSERT `board_admins` for the root board's managers/delegates
- INSERT `board_people` for the root board's members (including per-person WIP overrides, the assistant, and the primary root-board owner even if that owner should not receive normal day-to-day assignments)
- Generate the root group's CLAUDE.md from the hierarchy template
- Schedule standup/digest/review runners (and optional DST guard), then persist their scheduled task IDs in `board_runtime_config`
- Mount `data/taskflow/taskflow.db` into the container (add to `container-runner.ts` mount list)

The setup flow should ask for:

- The root board owner's name
- The desired `max_depth`
- Language and timezone
- Runner schedule preferences (or accept defaults)
- Attachment policy defaults (same as standard TaskFlow)
- Whether the assistant should be a direct root-board assignee (default: yes)

No org tree is needed upfront. Child boards are provisioned later on demand using `create_group` plus direct writes to `registered_groups` (or equivalent approved operator automation).

### 2.2 Authorized Child Board Provisioning

After the root board is set up, each board owner may request `criar quadro para [pessoa]` from their own WhatsApp group. The provisioning flow uses the `create_group` IPC plugin (group creation without service stop), then completes group registration by writing the `registered_groups` row with TaskFlow metadata. When an authorized provisioning context exposes the `register_group` MCP tool, it is only a wrapper around that same write. The runtime depth gate is already operational — `create_group` allows child creation only when one more level would still fit in the configured tree (`current runtime level + 1 < maxDepth`).

#### Flow

1. Board owner requests `criar quadro para [pessoa]` from their own board (or another authorized provisioning context chooses to provision directly).
2. The authorized provisioning flow creates the subordinate's WhatsApp group via the `create_group` IPC plugin (recommended — no service stop) or direct Baileys API, then performs group registration using the same setup-time permissions as standard TaskFlow. The child board owner must be inserted into `board_people` on the child board even if they will only operate there as a manager, because sender identification and admin authorization still depend on the active people store.
3. The authorized provisioning flow executes:

```sql
-- In NanoClaw's router DB (store/messages.db):
-- Register the WhatsApp group with explicit TaskFlow hierarchy metadata
INSERT INTO registered_groups (
  jid, name, folder, trigger_pattern, added_at,
  taskflow_managed, taskflow_hierarchy_level, taskflow_max_depth
) VALUES (
  :group_jid, :group_name, :group_folder, :trigger, :now,
  1, :parent_runtime_level + 1, :max_depth
);

-- In TaskFlow's hierarchy DB (data/taskflow/taskflow.db):
-- Create the child board
INSERT INTO boards VALUES (
  :child_board_id, :group_jid, :group_folder,
  'hierarchy', :parent_board_level + 1, :max_depth, :parent_board_id
);

-- Register child board on the parent
INSERT INTO child_board_registrations VALUES (
  :parent_board_id, :person_id, :child_board_id
);

-- Create board config with defaults
INSERT INTO board_config (board_id) VALUES (:child_board_id);

-- Create board runtime config with inherited defaults
INSERT INTO board_runtime_config (
  board_id, language, timezone,
  standup_cron_local, digest_cron_local, review_cron_local,
  standup_cron_utc, digest_cron_utc, review_cron_utc,
  dst_sync_enabled, attachment_enabled, attachment_disabled_reason,
  attachment_allowed_formats, attachment_max_size_bytes
) VALUES (
  :child_board_id, :language, :timezone,
  :standup_cron_local, :digest_cron_local, :review_cron_local,
  :standup_cron_utc, :digest_cron_utc, :review_cron_utc,
  :dst_sync_enabled, :attachment_enabled, :attachment_disabled_reason,
  :attachment_allowed_formats, :attachment_max_size_bytes
);

-- Add board admins
INSERT INTO board_admins VALUES (
  :child_board_id, :person_id, :phone, 'manager', 1
);

-- Add the person as manager on their own board
INSERT INTO board_people VALUES (
  :child_board_id, :person_id, :person_name, :phone, 'manager', :wip_limit, NULL
);

-- Update the parent board's board_people row for cross-group notifications
UPDATE board_people SET notification_group_jid = :child_group_jid
WHERE board_id = :parent_board_id AND person_id = :person_id;
```

4. The authorized provisioning flow generates the child group's CLAUDE.md from the hierarchy template.
5. The authorized provisioning flow schedules standup/digest/review runners (and optional DST guard), then persists the resulting scheduled task IDs in `board_runtime_config`.
6. The child board becomes operational only after registration, template generation, and runner scheduling are complete.

#### Example: Building a 3-Level Hierarchy

```
Step 1: Operator runs /add-taskflow on CEO's group → root board created (board level 1 / runtime level 0, max_depth 3)

Step 2: CEO says "criar quadro para Alexandre" from CEO's group
        → vp-alexandre-board created (board level 2 / runtime level 1), registered under ceo-board

Step 3: CEO says "criar quadro para Patricia" from CEO's group
        → vp-patricia-board created (board level 2 / runtime level 1), registered under ceo-board

Step 4: Alexandre says "criar quadro para Marina" from Alexandre's group
        → mgr-marina-board created (board level 3 / runtime level 2, leaf), registered under vp-alexandre-board

Step 5: Alexandre says "criar quadro para Lucas" from Alexandre's group
        → mgr-lucas-board created (board level 3 / runtime level 2, leaf), registered under vp-alexandre-board
```

Each person can request boards for their direct reports on demand. The provisioning uses `create_group` (IPC plugin, no service stop) plus a direct write to `registered_groups` with TaskFlow metadata (or equivalent approved operator automation that performs the same write). The `create_group` plugin already enforces `current runtime level + 1 < maxDepth`, so leaf boards cannot create children once their metadata is registered.

### 2.3 Board Removal

Board owners can remove a child board registration with `remover quadro do [pessoa]`:

- Refuse if the person has active linked tasks (must unlink first)
- DELETE from `child_board_registrations`
- Do not change `board_role` or storage backend; the child board remains SQLite-backed
- Treat the result as a detached hierarchy board that must be explicitly re-parented or decommissioned by a separate operator workflow before any new upward linkage is used
- Record `child_board_removed` history action

### 2.4 MCP Server Configuration

Uses the Claude Code native `.mcp.json` mechanism — no agent runner code changes for MCP config.

**Container setup (one-time):**

1. Add `mcp-server-sqlite-npx` to `container/agent-runner/package.json`:
   ```json
   "mcp-server-sqlite-npx": "^0.8.0"
   ```

2. Add `mcp__sqlite__*` to `allowedTools` in `container/agent-runner/src/index.ts`

3. Add directory mount in `src/container-runner.ts` (only for hierarchy TaskFlow groups).
   Mount the directory (not the file) so SQLite WAL journal files (`-wal`, `-shm`) persist.
   Requires hierarchy metadata (not just `taskflowManaged`) to avoid mounting for legacy JSON-based TaskFlow groups:
   ```typescript
   if (group.taskflowManaged && group.taskflowHierarchyLevel !== undefined) {
     const taskflowDir = path.join(DATA_DIR, 'taskflow');
     fs.mkdirSync(taskflowDir, { recursive: true });
     mounts.push({
       hostPath: taskflowDir,
       containerPath: '/workspace/taskflow',
       readonly: false, // agents need write access for task mutations
     });
   }
   ```

4. Rebuild the container image (`./container/build.sh`)

**Per-group setup (during provisioning):**

The setup wizard writes `.mcp.json` to the group's directory. The container's working directory is `/workspace/group` (from `WORKDIR` in Dockerfile), which is where Claude Code looks for project-scoped `.mcp.json`:

```json
// groups/{folder}/.mcp.json
{
  "mcpServers": {
    "sqlite": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-sqlite-npx", "/workspace/taskflow/taskflow.db"]
    }
  }
}
```

This is the Claude Code native way — the agent picks up the SQLite MCP server automatically at startup. No programmatic `mcpServers` configuration needed in the agent runner.

**Database initialization:**

Enable WAL mode on database creation:
```sql
PRAGMA journal_mode=WAL;
```

### 2.5 Compatibility

This feature must remain opt-in.

Standalone single-board TaskFlow installs and non-hierarchical boards must continue to behave exactly as they do now using JSON files. The hierarchy feature only activates when `board_role = 'hierarchy'` and a SQLite database is provisioned.

## Phase 3: Hierarchy Runtime Behavior

### 3.1 Prompt Changes

Extend `.claude/skills/add-taskflow/templates/CLAUDE.md.template` so hierarchy boards understand:

- `{{MANAGER_NAME}}` identifies the board owner — the person the assistant serves on that board. For child boards, this is the person who owns the board (e.g., "Giovanni"), not the parent manager. The assistant addresses this person by name.

- How to detect `board_role = 'hierarchy'` (from the board's configuration in `taskflow.db`)
- How to treat missing or unknown `board_role` as `standard` and preserve current single-board behavior
- How to determine the board's position from `hierarchy_level` and `max_depth`:
  - root: `hierarchy_level == 1`
  - leaf: `hierarchy_level == max_depth`
  - mid-level: neither root nor leaf
- How to distinguish the two depth models:
  - `boards.hierarchy_level` is the board model depth and is 1-based
  - `registered_groups.taskflow_hierarchy_level` and `NANOCLAW_TASKFLOW_HIERARCHY_LEVEL` are runtime authorization metadata and are 0-based
- How to query `child_board_registrations` for registered child boards
- How to use the SQLite MCP tools (`read_query`, `write_query`) for all data operations
- How to continue using the existing NanoClaw IPC tools (`send_message`, `schedule_task`, `cancel_task`, `list_tasks`) for runners, reminders, and attachment-related workflow
- How to use `create_group` for the group-creation step and emit an authorized provisioning request for the registration step; when `register_group` is exposed to that authorized context, it is only a wrapper around the same `registered_groups` write
- How to identify managers/delegates from `board_admins` and people from `board_people`
- When a linked task's `column` is rollup-managed
- Which commands are valid based on level (no downward link commands on leaf, no parent tagging on root)

**Already available in the container environment:**
- `NANOCLAW_IS_TASKFLOW_MANAGED` — whether this group is TaskFlow-managed
- `NANOCLAW_TASKFLOW_HIERARCHY_LEVEL` — this group's 0-based runtime depth metadata
- `NANOCLAW_TASKFLOW_MAX_DEPTH` — maximum hierarchy depth allowed

### 3.2 Hierarchy Commands

#### Board provisioning commands (any non-leaf level, board owner only):

- `criar quadro para [pessoa]` — create a child board for this person by using `create_group`, then handing off the registration write to an authorized provisioning context (hierarchy-depth-aware, no service stop)
- `registrar quadro para [pessoa]` — alternative syntax
- `remover quadro do [pessoa]` — unregister a child board (must unlink tasks first)

#### Task hierarchy commands (any non-leaf level):

- `vincular TXXX ao quadro do [pessoa]` — link task to child board
- `usar equipe de [pessoa] para TXXX` — alternative link syntax
- `atualizar status TXXX` — refresh rollup from immediate child board
- `sincronizar TXXX` — alternative refresh syntax
- `resumo de execucao TXXX` — view rollup summary
- `desvincular TXXX` — unlink child execution

#### Upward tagging command (any board with a parent, including leaf boards):

- `ligar tarefa ao pai TXXX` — tag local task to parent deliverable

### 3.3 Command Semantics

#### Board provisioning:

- **Create child board**: Refuse if `hierarchy_level == max_depth` (leaf). Refuse if the person already has a registered child board. The agent calls the `provision_child_board` MCP tool which writes an IPC file. The host-side `provision-child-board.ts` plugin handles the full lifecycle asynchronously: creates the WhatsApp group via `deps.createGroup()`, registers it via `deps.registerGroup()` with TaskFlow metadata (`taskflow_managed = true`, `taskflow_hierarchy_level = parent_runtime_level + 1`, `taskflow_max_depth = max_depth`), seeds `taskflow.db` (boards, child_board_registrations, board_config, board_runtime_config, board_admins, board_people), generates `CLAUDE.md` from template, schedules runners, fixes ownership, and sends confirmation. Missing or invalid depth metadata must fail provisioning; it must never be treated as unlimited depth.
- **Auto-provisioning on `cadastrar`**: When a person is registered via `cadastrar` on a non-leaf hierarchy board, the agent automatically calls `provision_child_board` after inserting into `board_people`. The provisioning is fire-and-forget from the container's perspective — the host processes it asynchronously.
- **Remove child board**: Refuse if the person has active linked tasks (must unlink first). DELETE from `child_board_registrations`. Do not change `board_role` or storage backend. Treat the child board as a detached hierarchy board that must be explicitly re-parented or decommissioned by a separate operator workflow before any new upward linkage is used. Record `child_board_removed` history action.
- **No board yet**: When a link command targets a person without a registered child board, suggest: `[pessoa] nao tem um quadro registrado. Use "criar quadro para [pessoa]" para provisionar.`

#### Task hierarchy:

- **Auto-link**: When a task is assigned to a person with a registered child board, the board automatically links it (if the sender is a full manager and the task is not a recurring task). The `vincular` UPDATE is performed immediately after assignment. The manager is informed: `TXXX vinculada automaticamente ao quadro de [pessoa].` The board owner can always unlink later.
- **Link validation**: Linking succeeds only if the task assignee matches a person in `child_board_registrations` and that person has a registered entry.
- **Link effect**: Sets `child_exec_enabled = 1` and populates `child_exec_board_id`, `child_exec_person_id` on the task. The task remains on the parent board — the child board sees it via the `child_exec_board_id` reference (no copy is created).
- **Leaf restriction**: Linking must be refused if `hierarchy_level == max_depth` (leaf board).
- **Task type restriction**: Linking is allowed on simple tasks (TXXX) and projects (PXXX). Recurring tasks (RXXX) cannot be linked because cycle resets would break the linkage contract. Error: `Tarefas recorrentes nao podem ser vinculadas a quadros. Crie uma tarefa simples para cada ciclo.`
- **Multiple parents**: Multiple parent tasks may be linked to the same child board simultaneously. Each parent task's rollup considers only child-board tasks tagged to that specific parent task (matched by `linked_parent_task_id`).
- **Receiving-board authority**: Once linked, the receiving board may move the task directly through the normal GTD phases. The `🔗` marker indicates cross-board routing only; it does not make the task read-only there.
- **Refresh**: Queries the child board's tasks via SQL and recomputes rollup fields. This is for parent boards that have delegated the same deliverable further down, not for ordinary direct execution on the current board.
- **View**: Shows only summarized status, not the full child-board task list.
- **Unlink**: Sets `child_exec_enabled = 0` (preserves `child_exec_*` fields for audit), keeps the task's current `column`, records `child_board_unlinked` with the last known `rollup_status`, and re-enables normal assignee column moves. The child board will no longer see this task.
- **Upward tagging**: Sets `linked_parent_board_id` and `linked_parent_task_id` on the local task. The command accepts the parent task ID only because the board already knows its `parent_board_id`; the stored reference is always fully qualified.
- **Root restriction**: Upward tagging must be refused on root boards (`parent_board_id IS NULL`).
- **Disambiguation**: `"resumo"` alone triggers the v2 ad-hoc digest. `"resumo de execucao TXXX"` triggers the rollup view. The task ID suffix disambiguates.
- **Reassignment**: When a task is reassigned, the engine auto-links to the new assignee's child board (if registered) regardless of whether the task was previously linked. If the new assignee has no child board and the task was linked, the link is removed. This ensures tasks are always visible on the correct child board without manual re-linking.
- **Rejection**: When the board owner rejects a linked task in `review` (with `rollup_status = 'ready_for_review'`), the task moves back to `in_progress` and `rollup_status` resets to `active`. The child board should be notified to reopen or add work.

### 3.4 Authority While Linked

When `child_exec_enabled = 1`:

- On the receiving board, `column` stays directly actionable through the normal GTD commands
- Normal assignee movement on that task remains allowed on the receiving board
- The board owner still controls due date, priority, labels, and final approval
- If this board later delegates the same deliverable to an immediate child board, `atualizar status TXXX` / `sincronizar TXXX` pulls that child progress back into the current task
- If the board owner wants to remove cross-board visibility entirely, they must unlink first

This rule must be explicit in the prompt so the runtime distinguishes ordinary direct execution on the current board from explicit rollup pulls from an immediate child board.

### 3.5 Reference-Based Task Visibility

Tasks exist as a single row on the parent board. Child boards see delegated tasks via a reference, not copies.

Each board loads its tasks with:

```sql
SELECT * FROM tasks
WHERE board_id = :my_board_id
   OR (child_exec_board_id = :my_board_id AND child_exec_enabled = 1)
ORDER BY created_at
```

This returns own tasks (`board_id` match) plus tasks delegated from parent boards (`child_exec_board_id` match). The single-row design ensures:
- No sync issues between parent and child views
- Updates from either board apply to the same row
- Clean delegation semantics for direct execution plus standup/digest/review
- Unlinking (`child_exec_enabled = 0`) immediately removes visibility from the child board

### 3.6 Interaction with TaskFlow v2 Features

The prompt must enforce these interaction rules when a task has `child_exec_enabled = 1`:

- Rollup-driven column changes caused by `atualizar status TXXX` / `sincronizar TXXX` must not be captured in `_last_mutation` and cannot be undone via `desfazer`. Ordinary direct moves on the current board still follow the normal mutation/undo rules.
- `blocked_by` references must be validated as board-local only. Cross-board task IDs are not valid dependency targets. Cross-board blocking is expressed through `rollup_status = 'blocked'`.
- `reminders` continue to fire on the board-owner-managed `due_date` regardless of linkage state.
- `description` does not roll up. Parent and child descriptions are independent.
- Statistics (F14) benefit from SQL — `SELECT` queries replace in-prompt JSON parsing. No special hierarchy handling is needed.
- Per-person WIP limits continue to check `board_people.wip_limit` first, then fall back to `board_config.wip_limit`.
- Attachment import remains available on hierarchy boards. The prompt must enforce `board_runtime_config.attachment_*` policy fields and record confirmed imports in `attachment_audit_log`.
- Sender identification and authorization continue to use the existing manager/delegate model, now backed by `board_admins`.
- `task_history` retains the full event stream, but user-facing history views should still cap active-task displays to the latest 50 entries. During archival, store only the latest 20 history entries in `archive.history` to match the original TaskFlow retention behavior.

### 3.6 No Non-Adjacent Mutation

At any level, boards must not:

- Query boards more than one level away
- Claim to refresh grandchild rollup
- Mutate non-adjacent state as a side effect of local changes

This must remain a hard boundary in the prompt.

### 3.7 Board Display and Runner Interactions

The prompt must specify how hierarchy-linked tasks appear in standard TaskFlow views:

**Board view (`quadro`)**: Show a `🔗` marker and rollup status on linked tasks:
- `🔗 T004 Entregar infraestrutura (Alexandre) [active]`

**Task details (`detalhes TXXX`)**: Include rollup section showing child board, rollup status, last refresh time, and summary.

**Morning standup**: Show linked tasks with rollup summary instead of column-only status:
- `T004 — 🔗 Alexandre: 4 itens ativos, 1 em risco (atualizado 16:00)`

**Evening digest**: Include linked tasks with current rollup status. Flag stale rollup (last refreshed > 24h):
- `T004 — 🔗 active (⚠️ rollup desatualizado — ultimo refresh ha 36h)`

**Weekly review**: List all hierarchy-linked tasks with rollup status. Suggest refreshing stale ones before the review proceeds.

### 3.8 Task Type Restrictions

- Simple tasks (TXXX) and projects (PXXX): Can be linked to child boards.
- Recurring tasks (RXXX): Cannot be linked. Cycle resets would break the linkage contract. Error: `Tarefas recorrentes nao podem ser vinculadas a quadros. Crie uma tarefa simples para cada ciclo.`

## Phase 4: Rollup Engine

### 4.1 Independent Refresh via SQL

Each board refreshes independently by querying the shared SQLite database. No root mediation needed. No cascading refresh needed.

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

And separately, detect newly cancelled tagged work since the last refresh:

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

### 4.2 Rollup Mapping

One set of mapping rules applies at every parent-child boundary:

| Child-board condition | Parent task effect |
|-----------------------|--------------------|
| Linked but no tagged work yet (`total_count = 0`, `cancelled_count = 0`) | Parent stays in `next_action`, summary: `Quadro vinculado; aguardando planejamento inicial` |
| Active linked work (`open_count > 0`, no stronger condition below) | Parent moves to `in_progress` |
| Linked work blocked (`waiting_count > 0`) | Parent moves to `waiting` with summarized blocker |
| At-risk linked work (`overdue_count > 0`) | Parent stays `in_progress`, `rollup_status = 'at_risk'` |
| Linked work complete (`total_count > 0`, `open_count = 0`, `cancelled_count = 0`) | Parent moves to `review`, `rollup_status = 'ready_for_review'` |
| Linked work reopened (previously `ready_for_review`, now `open_count > 0`) | Parent returns to `in_progress` |
| Linked work cancelled (`cancelled_count > 0`, `open_count = 0`) | Parent stays open with `cancelled_needs_decision` |

Keep the mapping table mutually exclusive in the prompt/template. `cancelled_needs_decision` outranks `ready_for_review`, so the review-ready branch must explicitly require `cancelled_count = 0`.

### 4.3 What Rolls Up

Each parent receives from its direct children:

- Current execution state (`rollup_status`)
- Blocker summary
- Risk summary
- Latest summary text

Recommended summary format: `4 itens ativos, 1 bloqueado por fornecedor, previsao quinta-feira`

### 4.4 What Does Not Roll Up

A parent board does not automatically receive:

- Full child-board task lists
- Subordinate notes or identities
- All local history events
- Grandchild-level detail

### 4.5 Rollup Computation

The rollup queries inspect only work linked to the target parent task (via `linked_parent_board_id` + `linked_parent_task_id`) and compute:

- `child_exec_rollup_status`
- `child_exec_last_rollup_at`
- `child_exec_last_rollup_summary`
- The parent-level `column`

### 4.6 Staleness

Each board displays staleness warnings independently. If `child_exec_last_rollup_at` is older than 24 hours, the board flags it in digest/review views.

Since every board can refresh at any time (no root mediation), staleness is always resolvable by the board that owns the linked task.

### 4.7 Failure Handling

Fail safely:

- If the SQLite query fails, keep the current parent-level column and report refresh failure.
- If the child board registration entry is missing, refuse link and explain the missing mapping.
- If the linked task assignee does not match the chosen child board, refuse the link.
- If the child board has been deleted or deprovisioned, report the error and suggest unlinking.

## Phase 5: Permissions

### 5.1 Board Owner (any level)

- Controls assignment, linking, unlinking, refresh, due dates, priorities, and final approval at that level.

### 5.2 Assignee with Child Board (on parent board)

- May update notes and summaries on their own assigned tasks.
- May request rollup refresh.
- May manually move their own task only before `child_exec_enabled = 1`.
- May not manually move while linked.

### 5.3 Assignee on Own Board

- Full manager on their own board.
- May link tasks to their own child boards (if not leaf).

### 5.4 Leaf-Level Subordinates

- Follow ordinary TaskFlow execution rules.
- No implicit authority on higher-level boards.

### 5.5 Registry and Link Safety

Only the board owner should be able to:

- Request or remove child boards (`criar quadro`, `remover quadro`)
- Link or unlink tasks to child boards

This avoids accidental provisioning or relinking across teams.

### 5.6 Prompt-Enforced Authorization

All authorization is prompt-enforced. The CLAUDE.md.template instructs each board's agent:

- Which board it manages (its own `board_id`)
- Which child boards it may query (from `child_board_registrations`)
- That it must not query sibling boards, grandchild boards, or parent board task lists

This matches how all other TaskFlow rules (permissions, WIP limits, column moves) are enforced.

## Phase 6: Depth Enforcement

### 6.1 Provisioning-Time Enforcement

- `criar quadro para [pessoa]` must refuse if `hierarchy_level == max_depth` (leaf board)
- The authorized provisioning flow behind `criar quadro` must set `registered_groups.taskflow_hierarchy_level = parent_runtime_level + 1`, set `boards.hierarchy_level = parent_board_level + 1`, and copy `max_depth` from parent

### 6.2 Runtime Enforcement

The prompt must check before executing hierarchy commands:

- Downward child-board link commands: refuse if `hierarchy_level == max_depth` ("This is a leaf board. Cannot link to child boards.")
- Upward tagging: refuse if `parent_board_id IS NULL` ("This is the root board. No parent to tag.")
- Child board registration: refuse to add entries if `hierarchy_level == max_depth`

### 6.3 Changing `max_depth`

To add a level:

1. `UPDATE boards SET max_depth = :new_depth WHERE board_role = 'hierarchy'`
2. Former leaf boards can now request `criar quadro para [pessoa]` to provision the new level through the approved authorized provisioning flow

To remove a level:

1. Unlink all tasks at the removed level
2. Use `remover quadro do [pessoa]` to unregister boards at the removed level
3. UPDATE `max_depth` on all remaining boards

Adding a level becomes available on demand after the `max_depth` update, but the actual board provisioning still runs through the approved authorized provisioning flow. Removing a level requires an operator to coordinate unlinking across boards.

## Phase 7: Testing

Extend `.claude/skills/add-taskflow/tests/taskflow.test.ts` with coverage for:

- `board_role` value `'hierarchy'` and `'standard'` fallback
- `hierarchy_level` and `max_depth` metadata fields
- 0-based `registered_groups.taskflow_hierarchy_level` / `NANOCLAW_TASKFLOW_HIERARCHY_LEVEL` metadata versus 1-based `boards.hierarchy_level`
- `board_people.wip_limit` per-person overrides plus `board_config.wip_limit` fallback
- `board_admins` manager/delegate rows and primary-manager fallback
- `board_runtime_config` language, timezone, runner IDs, cron schedules, DST guard state, and attachment policy
- `attachment_audit_log` rows for confirmed attachment imports
- `child_board_registrations` table usage
- `child_exec_*` columns with all `rollup_status` values
- Fully qualified `linked_parent_board_id` + `linked_parent_task_id` references
- Generic hierarchy commands (same commands at every level)
- Generic upward tagging command (including on leaf boards)
- Leaf-board restrictions (no downward link commands, no child board registrations)
- Root-board restrictions (no upward tagging)
- Adjacent-only rollup rules
- Depth enforcement via `max_depth`
- Assistant-as-root-level-role wording
- v2 interaction rules: `_last_mutation` excluded from rollup, `blocked_by` board-local only, `reminders` unaffected, `description` does not roll up
- Existing TaskFlow v2 command families still available on hierarchy boards (attachments, reminders, dependencies, archive, changelog, statistics, runner-driven reports)
- All 9 history actions documented and recorded when expected
- Initial rollup state for "linked but no tagged work yet"
- Rollup distinguishes "no tagged work yet" from "all tagged work done"
- Automatic auto-link when assigning to a person with a registered child board
- Recurring tasks (RXXX) cannot be linked to child boards
- Multiple parent tasks can link to the same child board with independent rollup
- Board display shows `🔗` marker on linked tasks
- Standup/digest include rollup summary for linked tasks
- Stale rollup warning when last refresh > 24h
- SQL-based rollup queries (independent refresh, no root mediation)
- Prompt-enforced authorization rules (query own board + registered children only)
- SQLite MCP server tool usage (`read_query`, `write_query`)
- Existing IPC tool usage (`send_message`, `schedule_task`, `cancel_task`, `list_tasks`) still documented for runners/reminders
- Authorized provisioning request: `criar quadro para [pessoa]` emits a request, and the approved provisioning flow completes the provisioning
- Board creation refused on leaf boards
- Board creation refused if person already has a registered child board
- Board removal refused if person has active linked tasks
- `child_board_created` and `child_board_removed` history actions
- "No board yet" suggestion when linking to unregistered person

Add negative assertions to prevent regressions such as:

- Allowing non-adjacent rollup (grandchild reads)
- Allowing cross-board references to be stored without `linked_parent_board_id`
- Allowing downward child-board link commands on leaf boards
- Allowing upward tagging on root boards
- Per-level-named fields (`director_execution`, `manager_execution`) instead of generic `child_exec_*`
- Allowing recurring tasks (RXXX) to be linked to child boards
- Root-mediated refresh patterns (each board refreshes independently)
- File-based data storage for hierarchy boards (must use SQLite)
- JSON file path resolution for cross-board reads
- Dropping runner scheduling metadata, attachment policy, or manager/delegate authorization on hierarchy boards

## Phase 8: Documentation

After the templates and tests are aligned, update:

- `docs/taskflow-user-manual.md`
- `docs/taskflow-operator-guide.md`
- `.claude/skills/add-taskflow/SKILL.md`

The user manual should explain:

- Bounded hierarchy with `max_depth` levels
- Authorized provisioning requests: how board owners request child boards from their own group and how the approved provisioning context completes the provisioning
- One set of commands at every level
- Summarized adjacent rollup only
- Assistant as a direct root-level role
- Leaf boards operate as normal TaskFlow boards

The operator guide should explain:

- Initial setup: running `/add-taskflow` with hierarchy mode for the root board
- Authorized provisioning flow for child boards, including group registration, template generation, runner scheduling, and runtime config persistence
- How to add/remove levels by changing `max_depth`
- SQLite WAL mode and concurrent access
- Database backup recommendations

## Phase 9: Rollout Sequence

Recommended build order:

1. **SQLite setup**: Create database schema, configure MCP server.
2. **Data model**: Add hierarchy columns and tables, update template to use SQL operations.
3. **Root setup**: Extend `/add-taskflow` SKILL.md for initial root board provisioning.
4. **Board provisioning commands**: Add `criar quadro para [pessoa]` and `remover quadro do [pessoa]`.
5. **Task hierarchy commands**: Add link/unlink/refresh/view commands to the template.
6. **Rollup engine**: Implement SQL-based rollup queries and mapping rules.
7. **Upward tagging**: Add parent-task tagging support.
8. **Depth enforcement**: Add leaf/root restrictions.
9. **Display/runners**: Add `🔗` markers, standup/digest/review formatting.
10. **Documentation**: Update manuals and operator docs.

This order establishes the data layer first, then provisioning, then commands, then constraints.

## Acceptance Checklist

Before shipping, verify:

- [x] SQLite database is created with the full schema
- [x] SQLite MCP server is configured and accessible to agents
- [x] Tasks at any non-leaf level can link only to the assigned person's registered child board
- [x] Linked tasks stop accepting ordinary assignee column moves
- [x] Rollup refresh queries the child board via SQL and updates parent fields
- [x] Each board refreshes independently (no root mediation)
- [x] The same commands work at level 1, level 2, level 3, etc.
- [x] Hierarchy boards preserve manager/delegate authorization, per-person WIP overrides, attachment policy + audit trail, and runner scheduling metadata
- [x] Leaf boards keep upward tagging when they have a parent, but do not offer downward link commands
- [x] Root boards have no upward tagging
- [x] No level performs non-adjacent rollup
- [x] Assistant tasks work directly on the root board without forcing a separate tier
- [x] Adding a new level requires only `max_depth` change and provisioning, not template changes
- [x] Board owners can request child boards from their own group via `criar quadro para [pessoa]`; the `provision_child_board` IPC plugin handles the full lifecycle
- [x] Auto-provisioning on `cadastrar`: registering a person on a non-leaf board automatically provisions their child board
- [x] Board creation is refused on leaf boards
- [x] Child boards see delegated tasks via `child_exec_board_id` reference (no task copies)
- [x] Standard (non-hierarchy) boards continue working with JSON files unchanged
- [x] Docs, templates, and tests agree on the same bounded-recursive SQLite-based model

## Implementation Notes

Key decisions made during implementation:

1. **Directory mount instead of file mount**: The original plan mounted `data/taskflow.db` as a single file. Changed to mounting the directory `data/taskflow/` → `/workspace/taskflow/` so SQLite WAL journal files (`-wal`, `-shm`) persist across container restarts.

2. **Conditional mount guard**: The mount condition uses `group.taskflowManaged && group.taskflowHierarchyLevel !== undefined` (not just `taskflowManaged`). Legacy standard TaskFlow groups have `taskflowManaged: true` from backfill but no hierarchy metadata — they must not get the SQLite mount.

3. **`labels TEXT DEFAULT '[]'`**: The design doc originally had `labels TEXT,` with no default. Changed to `DEFAULT '[]'` in both plan docs and implementation to match JSON initialization rules (empty array, not null).

4. **`admin_role` uses `manager` / `delegate`**: Both standard (JSON) and hierarchy (SQLite) modes use the same vocabulary. The primary board owner is inserted as `'manager'` with `is_primary_manager = 1`; any secondary admins use `'delegate'`.

5. **`no_work_yet` remains a display condition, not a persisted `rollup_status`**: The empty-child-work case is handled by the rollup query/result interpretation before the first tagged task exists. The stored `rollup_status` field still uses the closed set defined in Phase 1.5.

6. **Missing history actions in template**: The template originally had `child_board_created`, `child_board_removed`, and `child_board_unlinked` but was missing `child_board_linked` and the 4 rollup-specific actions (`child_rollup_blocked`, `child_rollup_at_risk`, `child_rollup_completed`, `child_rollup_cancelled`). Added all to match the design doc's 9 history actions.

7. **`ANTHROPIC_AUTH_TOKEN` in secret env vars**: Linter flagged this missing from both `container-runner.ts` and `container/agent-runner/src/index.ts`. Added to `SECRET_ENV_VARS` / `readSecrets` in both files.

8. **Cross-group notifications for hierarchy**: Added `notification_group_jid TEXT` column to `board_people` to store the WhatsApp group JID where a person receives notifications. Added `target_chat_jid` optional parameter to the `send_message` MCP tool. Updated IPC authorization in `src/ipc.ts` to allow TaskFlow-managed groups to send to other TaskFlow-managed groups. During child board provisioning, the parent board's `board_people.notification_group_jid` is updated with the child group's JID. With the v2 MCP tools, notification target resolution is handled by the engine's `resolveNotifTarget()` method — it queries only `notification_group_jid` from `board_people` and returns `{ target_person_id, notification_group_jid }`. The engine's notification builders (`buildMoveNotification`, `buildReassignNotification`, etc.) produce rich pt-BR messages; the agent dispatches them via `send_message` with the provided `target_chat_jid`.

9. **Auto-provisioning via IPC plugin**: Added `src/ipc-plugins/provision-child-board.ts` (host-side) and `provision_child_board` MCP tool in `ipc-mcp-stdio.ts` (container-side). When a person is registered via `cadastrar` on a non-leaf hierarchy board, the agent calls `provision_child_board` which writes an IPC file. The host plugin handles the full lifecycle: WhatsApp group creation, DB registration, taskflow.db seeding, CLAUDE.md generation from template, runner scheduling, ownership fix, and confirmation message. Fire-and-forget from the container's perspective. Added to `ALLOWED_IPC_PLUGIN_FILES` in `src/ipc.ts`.

10. **Reference-based task visibility (no copies)**: The original plan left child-board task visibility implicit. An initial implementation used task copies (INSERT on child board when linking), but this was replaced with a reference-based design: tasks exist once on the parent board, and child boards see them via `child_exec_board_id`. The task query uses `WHERE board_id = :id OR (child_exec_board_id = :id AND child_exec_enabled = 1)`. This eliminates sync issues and maintains a single source of truth. The `vincular` command is a single UPDATE (no INSERT copy), and `desvincular` is a single UPDATE (no DELETE copy).

11. **Per-group sender name (dual response fix)**: Groups with custom trigger patterns (e.g., `@Case`) were producing dual responses — one via `send_message` MCP tool ("Case: ...") and one via the host's streaming output callback ("Case: ..."). Root cause: the CLAUDE.md instructed the agent to "always pass `sender: 'Case'` on every `send_message` call", while the streaming callback defaulted to the global `ASSISTANT_NAME` ("Case"). Three changes:
    - `src/index.ts`: `processGroupMessages()` now derives the sender from `group.trigger` (stripping `@` prefix) and passes it to `channel.sendMessage()`. `runAgent()` passes the group-specific name as `assistantName` to the container.
    - CLAUDE.md template + all 4 group files: `send_message` section updated — agents must NOT use it for regular responses (output is auto-sent by host). Only use for cross-group notifications (`target_chat_jid`) and scheduled task output.
    - Session transcripts cleared so agents pick up new instructions immediately.

12. **`getGroupSenderName` utility**: Extracted the repeated `trigger?.replace(/^@/, '') || ASSISTANT_NAME` pattern into `getGroupSenderName(trigger?)` in `src/config.ts`. Applied in `src/index.ts` (streaming callback + container assistantName), `src/task-scheduler.ts` (bug fix — was using global `ASSISTANT_NAME` for scheduled tasks), and `src/ipc-plugins/provision-child-board.ts`.

13. **`stripInternalTags` reuse in streaming path**: The inline `<internal>` regex in `src/index.ts` was replaced with the shared `stripInternalTags()` from `src/router.ts`, which also handles unclosed `<internal>` tags (model hallucinating wrong closing tags).

14. **`computeNextRun` deduplication**: Removed the local `computeNextRun` from `src/ipc-plugins/provision-child-board.ts` (along with its `cron-parser` and `TIMEZONE` imports). Now delegates to the shared `computeNextRun` exported from `src/task-scheduler.ts` via a thin `nextCronRun()` wrapper.

15. **Unknown person → offer registration**: Updated error handling in CLAUDE.md template + all 4 group files. When a task is assigned to an unknown person, instead of a dead-end error, the agent now offers to register them (requesting phone and role). On non-leaf hierarchy boards, this triggers auto-provisioning of a child board. After registration, the original assignment is retried.

## Deferred Work

Explicitly out of scope for v1:

- A dedicated assistant board by default
- Automatic scheduled rollup as the only mode
- Linking one parent-level task to multiple child boards simultaneously
- Per-level-specific command variants (hierarchy uses one generic set)
- Unbounded recursion (depth is always capped by `max_depth`)
- Code-level access control per board (replaceable later with a custom MCP server)
- Migration tool from JSON files to SQLite for existing boards
