# TaskFlow MCP Tools — Design Document

## Problem

The TaskFlow CLAUDE.md template is ~1200 lines, with ~60% procedural logic (state transitions, validation, reassignment flows, error handling). The Claude model inconsistently follows these long instructions — as demonstrated by the reassignment-while-linked bug where the model kept refusing reassignment despite explicit rules saying otherwise.

## Solution

Move all mutation logic and common queries into **TypeScript IPC plugins** exposed as **MCP tools**. The CLAUDE.md shrinks from ~1200 to ~400 lines, becoming a natural language router: parse user intent → call the right tool → present the result.

## Prerequisites

Before implementing the tools, the canonical schema in `src/taskflow-db.ts` must be synced with the live database. The live DB has two additions not in the schema file:

1. **`board_groups` table** — exists in the live DB (added via migration), missing from `TASKFLOW_SCHEMA`
2. **`welcome_sent` column** on `board_runtime_config` — exists in the live DB (column 28, added via ALTER TABLE), missing from `TASKFLOW_SCHEMA`
3. **Additional columns** on `board_runtime_config`: `standup_target`, `digest_target`, `review_target`, `runner_standup_secondary_task_id`, `runner_digest_secondary_task_id`, `runner_review_secondary_task_id` — all present in the live DB but not in the canonical schema

These must be added to `TASKFLOW_SCHEMA` in `src/taskflow-db.ts` so the test seed can import the schema rather than hardcoding it, preventing drift.

## Architecture

```
User message (WhatsApp)
    ↓
Container Agent reads CLAUDE.md (~400 lines)
    ↓
Agent parses intent, maps to tool call
    ↓
MCP tool (TypeScript, in container agent-runner)
    ↓
Direct SQLite access (taskflow.db)
    ↓
Returns structured JSON result
    ↓
Agent formats response per CLAUDE.md templates
    ↓
send_message → WhatsApp
```

### Key change

Today the agent runs raw SQL queries guided by 1200 lines of instructions. After this change, the agent calls typed MCP tools for standard operations while retaining full read-write SQLite access for edge cases. The agent:
1. Parses user intent from natural language
2. For standard commands: calls the matching MCP tool (handles validation + side effects)
3. For edge cases, compound operations, or ambiguous requests: uses direct SQL via the SQLite MCP server
4. Formats the response for WhatsApp

### Agent flexibility principle

Tools are the **preferred path**, not a cage. The agent keeps full SQLite read-write access (`mcp__sqlite__read_query` and `mcp__sqlite__write_query`) and can fall back to direct SQL when:
- The user's request doesn't map cleanly to a single tool call
- A tool returns an error but the agent knows a valid workaround
- The request involves combining data from multiple queries in a novel way
- The manager asks for a one-off bulk operation not covered by the tools
- The situation requires judgment that code can't anticipate

The CLAUDE.md gives the agent a **decision framework**: "Use tools for standard operations. Use SQL for anything the tools don't cover. Never invent business rules — if unsure, ask the user."

## MCP Tools

### 1. `taskflow_create`

Creates any task type: simple (T), project (P), recurring (R), or inbox capture.

```typescript
taskflow_create({
  board_id: string,
  type: 'simple' | 'project' | 'recurring' | 'inbox',
  title: string,
  assignee?: string,          // person name (resolved internally)
  due_date?: string,          // ISO-8601 or natural language date
  priority?: 'low' | 'normal' | 'high' | 'urgent',
  labels?: string[],
  subtasks?: string[],        // for projects: ordered list of subtask titles
  recurrence?: 'daily' | 'weekly' | 'monthly' | 'yearly',
  recurrence_anchor?: string, // "toda segunda", "todo dia 5"
  sender_name: string,        // for permission check
})
```

**Returns:**
```typescript
{
  success: boolean,
  task_id: string,           // e.g. "T-003", "P-001", "R-002"
  column: string,            // 'inbox' or 'next_action'
  error?: string,            // permission denied, invalid assignee, etc.
  offer_register?: {         // if assignee unknown
    name: string,
    message: string,         // "João not registered. Current team: ..."
  },
  notifications?: Array<{
    target_person_id: string,
    notification_group_jid: string | null,
    message: string,
  }>,
}
```

**Logic moved from CLAUDE.md:**
- ID generation (next_task_number)
- Task type determination
- Assignee resolution (name → person_id)
- Unknown person → offer to register flow
- Recurring setup (due_date calculation)
- Project subtask initialization
- Auto-link to child board on assignment (hierarchy mode)

---

### 2. `taskflow_move`

Handles all column transitions with validation.

```typescript
taskflow_move({
  board_id: string,
  task_id: string,
  action: 'start' | 'wait' | 'resume' | 'return' | 'review' | 'approve' | 'reject' | 'conclude' | 'reopen' | 'force_start',
  sender_name: string,
  reason?: string,           // for 'wait' and 'reject'
  subtask_id?: string,       // for project subtask completion (e.g. "P-001.2")
})
```

**Returns:**
```typescript
{
  success: boolean,
  task_id: string,
  from_column: string,
  to_column: string,
  error?: string,            // WIP exceeded, wrong column, permission denied
  wip_warning?: {            // when WIP would be exceeded
    person: string,
    current: number,
    limit: number,
  },
  project_update?: {         // for subtask completion
    completed_subtask: string,
    next_subtask?: string,
    all_complete: boolean,
  },
  recurring_cycle?: {        // for recurring task conclusion
    new_due_date: string,
    cycle_number: number,
  },
  archive_triggered?: boolean,
  notifications?: Array<{
    target_person_id: string,
    notification_group_jid: string | null,
    message: string,
  }>,
}
```

**Logic moved from CLAUDE.md:**
- All transition rules (state machine)
- WIP limit checks + force override
- Permission verification (assignee vs manager vs delegate)
- Project subtask completion + auto-advance
- Recurring task cycle advancement
- Archival trigger (done → archive after period)
- Dependency resolution on completion
- History recording
- Snapshot for undo (`_last_mutation`)

---

### 3. `taskflow_reassign`

Reassign tasks with auto-relink.

```typescript
taskflow_reassign({
  board_id: string,
  task_id: string,           // single task
  target_person: string,     // person name
  sender_name: string,
  confirmed: boolean,        // false = dry run (returns what would happen)
})
// OR bulk:
taskflow_reassign({
  board_id: string,
  source_person: string,     // transfer all from this person
  target_person: string,
  sender_name: string,
  confirmed: boolean,
})
```

**Returns:**
```typescript
{
  success: boolean,
  tasks_affected: Array<{
    task_id: string,
    title: string,
    was_linked: boolean,
    relinked_to?: string,    // new child board, or null if unlinked
  }>,
  error?: string,
  offer_register?: { name: string, message: string },
  requires_confirmation?: string,  // human-readable summary for confirm prompt
  notifications?: Array<{
    target_person_id: string,
    notification_group_jid: string | null,
    message: string,
  }>,
}
```

**Logic moved from CLAUDE.md:**
- Permission check (assignee or manager)
- Target person validation
- Auto-unlink from old child board
- Auto-relink to new child board (if exists)
- Bulk transfer logic
- History recording
- NO WIP check (by design)

---

### 4. `taskflow_update`

Update task fields.

```typescript
taskflow_update({
  board_id: string,
  task_id: string,
  sender_name: string,
  updates: {
    title?: string,
    priority?: 'low' | 'normal' | 'high' | 'urgent',
    due_date?: string | null,  // null = remove
    description?: string,
    next_action?: string,
    add_label?: string,
    remove_label?: string,
    add_note?: string,
    edit_note?: { id: number, text: string },
    remove_note?: number,
    add_subtask?: string,         // project only
    rename_subtask?: { id: string, title: string },
    reopen_subtask?: string,      // subtask ID
    recurrence?: string,          // change frequency
  },
})
```

**Returns:**
```typescript
{
  success: boolean,
  task_id: string,
  changes: string[],         // human-readable list of what changed
  error?: string,
  notifications?: Array<{
    target_person_id: string,
    notification_group_jid: string | null,
    message: string,
  }>,
}
```

---

### 5. `taskflow_dependency`

Manage dependencies and reminders.

```typescript
taskflow_dependency({
  board_id: string,
  action: 'add_dep' | 'remove_dep' | 'add_reminder' | 'remove_reminder',
  task_id: string,
  target_task_id?: string,   // for dependencies
  reminder_days?: number,    // for reminders
  sender_name: string,
})
```

**Returns:**
```typescript
{
  success: boolean,
  error?: string,            // circular dependency, no due_date, etc.
}
```

**Logic moved:** Circular dependency detection (transitive), reminder scheduling via IPC.

---

### 6. `taskflow_admin`

People and board administration.

```typescript
taskflow_admin({
  board_id: string,
  action: 'register_person' | 'remove_person' | 'add_manager' | 'add_delegate' | 'remove_admin' | 'set_wip_limit' | 'cancel_task' | 'restore_task' | 'process_inbox',
  sender_name: string,
  person_name?: string,
  phone?: string,
  role?: string,
  wip_limit?: number,
  task_id?: string,
  confirmed?: boolean,
  force?: boolean,
})
```

**Returns:**
```typescript
{
  success: boolean,
  error?: string,
  requires_confirmation?: string,
  tasks_to_reassign?: Array<{ task_id: string, title: string }>,  // when removing person
  child_board_provisioned?: boolean,
  inbox_items?: Array<{ task_id: string, title: string }>,        // for process_inbox
}
```

**Logic moved:** Person CRUD, auto-provisioning, cascade cleanup on person removal, inbox processing.

---

### 7. `taskflow_undo`

Undo last mutation.

```typescript
taskflow_undo({
  board_id: string,
  sender_name: string,
  force?: boolean,          // override WIP guard
})
```

**Returns:**
```typescript
{
  success: boolean,
  undone_action: string,    // what was undone
  task_id: string,
  error?: string,           // expired, batch op, WIP exceeded
}
```

---

### 8. `taskflow_query`

Pre-built queries returning structured data.

```typescript
taskflow_query({
  board_id: string,
  query: 'board' | 'inbox' | 'review' | 'in_progress' | 'next_action' | 'waiting' |
         'my_tasks' | 'overdue' | 'due_today' | 'due_tomorrow' | 'due_this_week' |
         'next_7_days' | 'search' | 'urgent' | 'high_priority' | 'by_label' |
         'completed_today' | 'completed_this_week' | 'completed_this_month' |
         'person_tasks' | 'person_waiting' | 'person_completed' | 'person_review' |
         'task_details' | 'task_history' | 'archive' | 'archive_search' |
         'agenda' | 'agenda_week' | 'changes_today' | 'changes_since' | 'changes_this_week' |
         'statistics' | 'person_statistics' | 'month_statistics' | 'summary',
  sender_name?: string,     // for 'my_tasks'
  person_name?: string,     // for person_* queries
  task_id?: string,         // for task_details, task_history
  search_text?: string,     // for search queries
  label?: string,           // for by_label, combined search
  since?: string,           // for changes_since
})
```

**Returns:**
```typescript
{
  success: boolean,
  query: string,
  data: any,               // structured data per query type
  formatted?: string,      // pre-formatted WhatsApp message (optional)
  error?: string,
}
```

The `formatted` field provides a ready-to-send WhatsApp message for standard queries. The agent can use it directly or format the raw `data` differently if needed (ad-hoc questions).

---

### 9. `taskflow_report`

Generate scheduled reports.

```typescript
taskflow_report({
  board_id: string,
  type: 'standup' | 'digest' | 'weekly',
})
```

**Returns:**
```typescript
{
  success: boolean,
  data: {
    // Structured data for agent to format
    date: string,
    overdue: Task[],
    in_progress: Task[],
    waiting: Task[],
    review: Task[],
    completed: Task[],
    stats: { total: number, done: number, avg_cycle_time?: number },
    per_person: Array<{ name: string, tasks: Task[], stats: PersonStats }>,
    // For weekly:
    weekly_summary?: { created: number, completed: number, trend: string },
  },
  // Pre-formatted message in the board's language
  formatted: string,
}
```

---

## CLAUDE.md Structure (~400 lines)

```markdown
# {{ASSISTANT_NAME}} — TaskFlow ({{GROUP_NAME}})                    [5 lines]

## Identity & Scope Guard                                            [15 lines]
- You are a task management assistant ONLY
- Reject off-topic messages
- Welcome check: query `welcome_sent` from `board_runtime_config` on every
  interaction. If 0, send welcome message then SET welcome_sent = 1.
  (Stays in CLAUDE.md — simple SQL, not worth a tool)

## Security                                                          [20 lines]
- Confirmation before destructive actions
- Refuse override patterns
- Never expose internal data

## WhatsApp Formatting                                               [10 lines]
- No ## headings, use *bold*, _italic_, bullets

## Sender Identification                                             [15 lines]
- Match sender against board_people
- Phone number matching rules

## Authorization Matrix                                              [25 lines]
- Everyone: queries, quick capture
- Assignee: move own tasks, update fields, reassign own tasks
- Delegate: process inbox, approve/reject review
- Manager: all operations

## Tool vs. Direct SQL Decision Framework                            [20 lines]
- Standard commands → use the matching MCP tool (preferred path)
- Ad-hoc questions, compound queries, novel combinations → use SQL
- Tool returned an error but you see a valid path → use SQL carefully
- One-off manager requests not covered by tools → use SQL
- When writing SQL: follow the schema reference, record history,
  respect authorization matrix. If unsure whether a mutation is safe,
  ask the user before executing.

## Command → Tool Mapping                                            [80 lines]
Table mapping user commands to tool calls:
| User says | Tool call |
|-----------|-----------|
| "anotar: X" | taskflow_create({ type: 'inbox', title: 'X' }) |
| "tarefa para Y: X ate Z" | taskflow_create({ type: 'simple', ... }) |
| "comecando T-001" | taskflow_move({ task_id: 'T-001', action: 'start' }) |
| "reatribuir T-001 para Y" | taskflow_reassign({ task_id: 'T-001', ... }) |
| "quadro" | taskflow_query({ query: 'board' }) |
| ... | ... |

## Tool Response Handling                                            [30 lines]
- `success: true` → format `data` for WhatsApp and send
- `success: false` → present `error` in configured language
- `offer_register` → ask manager for phone+role, then retry
- `requires_confirmation` → present summary, wait for "sim"
- `wip_warning` → explain WIP limit, suggest "forcar"
- If a tool error doesn't match the user's situation (tool bug or
  edge case), you may fall back to direct SQL. Explain what you're
  doing and why.

## Report Templates                                                  [40 lines]
### Standup (Morning)
Format template using `taskflow_report` structured data

### Digest (Evening)
Format template using `taskflow_report` structured data

### Weekly Review (Friday)
Format template using `taskflow_report` structured data

## Notification Dispatch                                              [15 lines]
- After any successful mutation with `notifications` in the result,
  send each notification via `send_message` with the given target_chat_jid
- Do NOT modify the notification text — the tool pre-formats it
- If send_message fails, log but do not retry

## Schema Reference (for ad-hoc SQL)                                 [30 lines]
Full table list with key columns and types.
Agent uses this for direct SQL queries when tools don't cover the need:
- tasks: id, board_id, type, title, assignee, column, priority,
  due_date, labels (JSON), blocked_by (JSON), notes (JSON),
  child_exec_enabled, child_exec_board_id, ...
- board_people: person_id, name, phone, role, wip_limit
- board_admins: person_id, admin_role, is_primary_manager
- task_history: task_id, action, by, at, details
- archive: task_id, archive_reason, task_snapshot (JSON)
- board_config: next_task_number, wip_limit
- child_board_registrations: person_id, child_board_id
When writing mutations via SQL, always:
  1. Record history in task_history
  2. Update task updated_at
  3. Set _last_mutation snapshot for undo support

## Hierarchy Overview (conditional)                                  [25 lines]
- Board identity and level
- Child board concept
- Linked task display markers (🔗)

## Batch Operations                                                  [10 lines]
- Comma-separated IDs for approve, reject, conclude, cancel

## Error Presentation                                                [15 lines]
- Present tool errors in configured language
- Common error patterns and their user-friendly messages

## Configuration                                                     [15 lines]
Board-specific variables

TOTAL: ~370 lines (with room for buffer to ~400)
```

## Skill Restructuring

### Current structure
```
.claude/skills/add-taskflow/
├── manifest.yaml            (empty/minimal)
├── SKILL.md                 (66KB setup wizard)
├── templates/
│   └── CLAUDE.md.template   (75KB, 1193 lines)
└── tests/
    └── taskflow.test.ts
```

### New structure
```
.claude/skills/add-taskflow/
├── manifest.yaml
│   adds:
│     - container/agent-runner/src/taskflow-engine.ts       # All 9 tool handlers
│     - container/agent-runner/src/taskflow-engine.test.ts  # Tests
│   modifies:
│     - container/agent-runner/src/ipc-mcp-stdio.ts  # Register 9 new tools
│     - src/container-runner.ts                       # Add to CORE_AGENT_RUNNER_FILES + env vars
│     - container/agent-runner/src/runtime-config.ts  # Add board_id to MCP env
├── SKILL.md                                    # Updated setup wizard
├── add/
│   ├── container/agent-runner/src/taskflow-engine.ts       # ~2000 lines TypeScript
│   └── container/agent-runner/src/taskflow-engine.test.ts
├── modify/
│   ├── container/agent-runner/src/ipc-mcp-stdio.ts
│   ├── container/agent-runner/src/ipc-mcp-stdio.ts.intent.md
│   ├── src/container-runner.ts
│   └── src/container-runner.ts.intent.md
├── templates/
│   └── CLAUDE.md.template   (~400 lines)
└── tests/
    └── taskflow.test.ts     (updated)
```

## Notification System

Notifications are cross-group messages sent after state-changing operations (~107 lines in the current CLAUDE.md). The MCP tools handle mutations but do NOT send notifications directly — they return a `notifications` array in the result, and the agent dispatches them.

**Why agent-side dispatch:** Notifications use `send_message` (an MCP tool the agent already has). Sending from inside the engine would require the engine to call back into the MCP server, creating a circular dependency. Instead:

1. Each mutation tool that can trigger notifications returns:
   ```typescript
   notifications?: Array<{
     target_person_id: string,
     notification_group_jid: string | null,  // from board_people
     message: string,                         // pre-formatted pt-BR
   }>
   ```
2. The CLAUDE.md instructs the agent: "After a successful mutation, if `notifications` is present, send each one via `send_message` with the given `target_chat_jid`."
3. The notification message templates are generated by the engine (it knows the old/new state), so the agent just dispatches them.

This keeps the engine pure (no side effects beyond SQLite) while eliminating the 107 lines of notification logic from the CLAUDE.md.

## Reminder Mechanism

The `taskflow_dependency` tool's `add_reminder` / `remove_reminder` actions work through the existing `schedule_task` IPC mechanism:

1. Reminders are stored in the task's `reminders` JSON column
2. When adding a reminder, the engine writes an IPC file to `/workspace/ipc/tasks/` with `schedule_type: 'once'` and the calculated reminder date
3. When removing a reminder, the engine writes an IPC cancel file
4. The host's task scheduler picks up these IPC files (same mechanism as `schedule_task` MCP tool)

No new host-side IPC handler is needed.

## Implementation: Where tools run

### Option A: Host-side IPC plugin (like provision-child-board.ts)
- Tool runs on the host process
- Direct access to taskflow.db
- Agent writes JSON to `/workspace/ipc/tasks/`, host picks it up
- **Con:** Async — agent can't get a synchronous response

### Option B: Container-side MCP tool (recommended)
- Tools run inside the container's agent-runner process
- Direct SQLite access via the same DB file (already mounted read-write)
- Synchronous — agent calls tool, gets immediate JSON response
- **Con:** Need to add tools to `ipc-mcp-stdio.ts`

**Decision: Option B** — Container-side MCP tools. The agent already has read-write SQLite access. The tools are TypeScript functions that validate inputs, run SQL, and return structured results. They run in the same process as the agent, so responses are synchronous.

### SQLite concurrency

Multiple containers may access `taskflow.db` simultaneously (e.g., two groups with active conversations). The database uses WAL mode, which handles concurrent readers well. For writers, the engine must set `busy_timeout` to avoid `SQLITE_BUSY` errors:

```typescript
const tfDb = new Database(dbPath);
tfDb.pragma('busy_timeout = 5000');  // wait up to 5s for write lock
```

### Native module build tools

`better-sqlite3` is a C++ native addon compiled via `node-gyp`. The Dockerfile's `node:22-slim` base image includes `python3` and `make` but may lack `g++`. If the container build fails at `npm install`, add to the Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y g++ && rm -rf /var/lib/apt/lists/*
```

This should be verified during Task 1 (dependency installation).

### Implementation location

All 9 tools implemented in a single module: `container/agent-runner/src/taskflow-engine.ts`

This module is:
- Imported by `ipc-mcp-stdio.ts` to register the tools
- Has direct access to the SQLite database (same connection)
- Runs inside the container (isolated per group)
- Fully testable in isolation

### Board ID derivation

The board ID follows the convention `board-${folder}` (e.g., folder `secti-taskflow` → `board-secti-taskflow`). This is confirmed in `provision-child-board.ts:239` and `migrate-to-sqlite.ts:419`.

The board ID is passed to the container via environment variable:
1. `container-runner.ts` derives it: `const boardId = 'board-' + group.folder`
2. Passes it in `ContainerInput` (no new field needed — derive at call site)
3. `buildNanoclawMcpEnv()` in `runtime-config.ts` adds `NANOCLAW_TASKFLOW_BOARD_ID` to the env
4. `ipc-mcp-stdio.ts` reads `process.env.NANOCLAW_TASKFLOW_BOARD_ID`

No changes to `RegisteredGroup` are needed — the board ID is derived from the existing `folder` field.

### File sync to per-group directories

The `CORE_AGENT_RUNNER_FILES` array in `container-runner.ts:69-75` controls which source files are synced to per-group agent-runner directories. `taskflow-engine.ts` MUST be added to this list, or the container will fail to compile when `ipc-mcp-stdio.ts` tries to import it:

```typescript
const CORE_AGENT_RUNNER_FILES = [
  'index.ts',
  'ipc-mcp-stdio.ts',
  'ipc-tooling.ts',
  'runtime-config.ts',
  'taskflow-engine.ts',           // ← ADD
  path.join('mcp-plugins', 'create-group.ts'),
] as const;
```

## Migration Plan

### Phase 1: Build the engine
1. Implement `taskflow-engine.ts` with all 9 tools
2. Write comprehensive tests
3. Register tools in `ipc-mcp-stdio.ts`
4. Rebuild container

### Phase 2: New CLAUDE.md template
1. Write the ~400-line template
2. Test with one board (e.g., tec-taskflow — least critical)
3. Verify all commands work via the new tools
4. Compare behavior with the old template

### Phase 3: Skill restructuring
1. Add manifest.yaml with adds/modifies
2. Create add/ and modify/ directories
3. Update SKILL.md for the new flow
4. Update existing board CLAUDE.md files

### Phase 4: Rollout
1. Update tec-taskflow CLAUDE.md (test board)
2. Update seci-taskflow CLAUDE.md
3. Update secti-taskflow CLAUDE.md (production board)
4. Monitor for regressions

## Risks

| Risk | Mitigation |
|------|------------|
| Tool bugs harder to fix than CLAUDE.md edits | Comprehensive test suite, gradual rollout |
| Agent misroutes commands to wrong tool | Command→tool mapping table with examples |
| Loss of agent flexibility for edge cases | Agent keeps full read-write SQLite access as fallback (see below) |
| Container rebuild required for tool changes | Acceptable — already rebuilding for agent-runner updates |
| Report formatting too rigid | Tools return structured data, agent formats per CLAUDE.md template |
| Agent over-relies on SQL fallback, bypassing tool guarantees | CLAUDE.md decision framework: "Use tools first. SQL is a fallback, not the default." |
| Schema drift between `taskflow-db.ts` and engine test seed | Prerequisite task syncs schema; add schema comparison test |
| Concurrent writes cause SQLITE_BUSY | `busy_timeout = 5000` pragma on engine DB connection |
| `node:22-slim` lacks build tools for native modules | Verify during Task 1; add `g++` to Dockerfile if needed |
| Rollback from new to old template | v1 template preserved; rollback procedure documented in Phase 4 |

## Agent Flexibility: Tools + SQL Fallback

The tools handle the **90% common case** with guaranteed correctness. For the remaining 10%, the agent retains full SQLite read-write access via `mcp__sqlite__read_query` and `mcp__sqlite__write_query`.

**When to use tools (preferred):**
- Any standard command that maps to the command→tool table
- All state transitions (move, reassign, create, update)
- Queries with known types (board, search, statistics, etc.)

**When to use direct SQL (fallback):**
- Ad-hoc questions: "quantas tarefas o Alexandre concluiu nos últimos 3 meses?"
- Compound operations: "mova todas as tarefas atrasadas do Alexandre para revisão"
- Data exploration: "qual tarefa ficou mais tempo em aguardando?"
- Tool returned an unexpected error for a valid operation
- Manager requests a one-off operation the tools don't cover
- Cross-referencing data across tables in ways tools can't

**When using SQL for mutations, the agent must:**
1. Record the action in `task_history`
2. Update `updated_at` on affected tasks
3. Set `_last_mutation` snapshot for undo support
4. Respect the authorization matrix (verify sender permissions)
5. If unsure whether a mutation is safe, ask the user first

This hybrid approach means the agent is never "stuck" — tools provide reliability for standard flows, and SQL provides escape hatches for everything else.

## Rollback Procedure

If the new ~400-line template causes regressions on a board:

1. **Per-board rollback:** Replace the board's `CLAUDE.md` with the v1 backup (`.template.v1`), substituting the board's variables. The MCP tools remain registered but are harmless — the old template simply won't call them.

2. **Full rollback:** Restore all boards to v1 templates and revert `ipc-mcp-stdio.ts` to remove the tool registration block. Rebuild container.

3. **Why the tools don't interfere:** Tool registration is passive — tools only execute when the agent calls them. The v1 CLAUDE.md uses raw SQL and never references `taskflow_*` tools, so they sit idle.

4. **Data compatibility:** Both old and new templates write to the same SQLite schema. No data migration is needed for rollback.
