# TaskFlow MCP Tools — Design Document

## Problem

The TaskFlow CLAUDE.md template is ~1200 lines, with ~60% procedural logic (state transitions, validation, reassignment flows, error handling). The Claude model inconsistently follows these long instructions — as demonstrated by the reassignment-while-linked bug where the model kept refusing reassignment despite explicit rules saying otherwise.

## Solution

Move all mutation logic and common queries into **TypeScript IPC plugins** exposed as **MCP tools**. The CLAUDE.md shrinks from ~1200 to ~400 lines, becoming a natural language router: parse user intent → call the right tool → present the result.

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

Today the agent runs raw SQL queries guided by 1200 lines of instructions. After this change, the agent calls typed MCP tools that handle all validation, transitions, and side effects in TypeScript. The agent only needs to:
1. Parse user intent from natural language
2. Call the right tool with the right parameters
3. Format the response for WhatsApp

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
- Load data check (welcome_sent)

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
- When tool returns `error`: present in pt-BR
- When tool returns `offer_register`: ask manager for phone+role
- When tool returns `requires_confirmation`: ask "are you sure?"
- When tool returns `wip_warning`: explain WIP limit

## Report Templates                                                  [40 lines]
### Standup (Morning)
Format template using `taskflow_report` structured data

### Digest (Evening)
Format template using `taskflow_report` structured data

### Weekly Review (Friday)
Format template using `taskflow_report` structured data

## Notification Rules                                                [25 lines]
- When to send cross-group notifications
- Format for each notification type

## Schema Reference (read-only queries)                              [20 lines]
Key tables and columns for ad-hoc SELECT queries:
- tasks: id, title, column, assignee, due_date, priority, labels
- board_people: id, name, phone, role, wip_limit
- task_history: task_id, action, changed_by, changed_at

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

TOTAL: ~350 lines (with room for ~50 lines buffer)
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
│     - src/ipc-plugins/taskflow-engine.ts      # All 9 tool handlers
│     - src/ipc-plugins/taskflow-engine.test.ts  # Tests
│   modifies:
│     - container/agent-runner/src/ipc-mcp-stdio.ts  # Register 9 new tools
│     - src/ipc.ts                                    # Allowlist new plugin
├── SKILL.md                                    # Updated setup wizard
├── add/
│   ├── src/ipc-plugins/taskflow-engine.ts      # ~2000 lines TypeScript
│   └── src/ipc-plugins/taskflow-engine.test.ts
├── modify/
│   ├── container/agent-runner/src/ipc-mcp-stdio.ts
│   ├── container/agent-runner/src/ipc-mcp-stdio.ts.intent.md
│   ├── src/ipc.ts
│   └── src/ipc.ts.intent.md
├── templates/
│   └── CLAUDE.md.template   (~400 lines)
└── tests/
    └── taskflow.test.ts     (updated)
```

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

### Implementation location

All 9 tools implemented in a single module: `container/agent-runner/src/taskflow-engine.ts`

This module is:
- Imported by `ipc-mcp-stdio.ts` to register the tools
- Has direct access to the SQLite database (same connection)
- Runs inside the container (isolated per group)
- Fully testable in isolation

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
| Loss of agent flexibility for edge cases | Keep read-only SQL access for ad-hoc queries |
| Container rebuild required for tool changes | Acceptable — already rebuilding for agent-runner updates |
| Report formatting too rigid | Tools return structured data, agent formats per CLAUDE.md template |
