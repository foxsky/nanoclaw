# TaskFlow MCP Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move TaskFlow procedural logic from CLAUDE.md (~1200 lines) into TypeScript MCP tools, reducing the template to ~400 lines while improving reliability.

**Architecture:** 9 MCP tools implemented in `container/agent-runner/src/taskflow-engine.ts`, registered conditionally in `ipc-mcp-stdio.ts` when `NANOCLAW_IS_TASKFLOW_MANAGED=1`. Board ID derived from folder name (`board-${folder}`). Tools access `taskflow.db` directly via `better-sqlite3` for synchronous responses. The agent becomes a natural language router that parses intent, calls tools, and formats results. Mutation tools return `notifications` arrays that the agent dispatches via `send_message`.

**Tech Stack:** TypeScript, better-sqlite3, zod (validation), vitest (tests), MCP SDK

**Design doc:** `docs/plans/2026-03-04-taskflow-mcp-tools-design.md`

---

## Phase 0: Schema Alignment

### Task 0: Sync `taskflow-db.ts` schema with live database

The live database has tables and columns not present in the canonical schema at `src/taskflow-db.ts`. The engine tests will use this schema, so it must match reality.

**Files:**
- Modify: `src/taskflow-db.ts`
- Modify: `src/taskflow-db.test.ts` (if schema-dependent assertions exist)

**Step 1: Add `board_groups` table to `TASKFLOW_SCHEMA`**

Add after the `child_board_registrations` CREATE TABLE:
```sql
CREATE TABLE IF NOT EXISTS board_groups (
  board_id TEXT REFERENCES boards(id),
  group_jid TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  group_role TEXT DEFAULT 'team',
  PRIMARY KEY (board_id, group_jid)
);
```

**Step 2: Add missing columns to `board_runtime_config`**

Add these columns to the existing `board_runtime_config` CREATE TABLE:
```sql
  welcome_sent INTEGER DEFAULT 0,
  standup_target TEXT DEFAULT 'team',
  digest_target TEXT DEFAULT 'team',
  review_target TEXT DEFAULT 'team',
  runner_standup_secondary_task_id TEXT,
  runner_digest_secondary_task_id TEXT,
  runner_review_secondary_task_id TEXT,
```

**Step 3: Remove the `ALTER TABLE` migration for `notification_group_jid`**

This column is already in the CREATE TABLE statement, so the try/catch ALTER TABLE block (lines 170-174) is no longer needed for fresh databases. Keep it for backward compatibility with existing DBs that were created before it was added to the schema, OR remove it if all live DBs already have the column.

**Step 4: Run existing tests**

```bash
cd /root/nanoclaw && npm test
```

Expected: All existing tests pass with the updated schema.

**Step 5: Commit**

```bash
git add src/taskflow-db.ts
git commit -m "fix: sync taskflow-db.ts schema with live database"
```

---

## Phase 1: Foundation

### Task 1: Add better-sqlite3 and vitest dependencies

**Files:**
- Modify: `container/agent-runner/package.json`
- Modify: `container/Dockerfile` (if native module needs build tools)

**Step 1: Add dependencies**

```bash
cd container/agent-runner && npm install better-sqlite3 && npm install -D @types/better-sqlite3 vitest
```

Note: Use `better-sqlite3@^11.8.1` to match the host's existing version in the root `package.json`.

**Step 2: Verify container builds**

```bash
cd /root/nanoclaw && ./container/build.sh
```

Expected: Build succeeds. `better-sqlite3` is a native C++ addon that requires `python3`, `make`, and `g++` for `node-gyp`. If the build fails with compilation errors:

```dockerfile
# Add to Dockerfile before RUN npm install:
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
```

The `node:22-slim` image may already include these — verify during this step.

**Step 3: Commit**

```bash
git add container/agent-runner/package.json container/agent-runner/package-lock.json
git commit -m "chore: add better-sqlite3 and vitest to agent-runner"
```

---

### Task 2: Create taskflow-engine module with DB connection + taskflow_query

This is the foundation module. Start with the query tool since it's read-only and easy to test.

**Files:**
- Create: `container/agent-runner/src/taskflow-engine.ts`
- Create: `container/agent-runner/src/taskflow-engine.test.ts`

**Step 1: Write the failing test for DB connection and board query**

```typescript
// taskflow-engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskflowEngine } from './taskflow-engine.js';

/**
 * Creates all TaskFlow tables in an in-memory DB.
 * IMPORTANT: This schema MUST match the canonical TASKFLOW_SCHEMA in src/taskflow-db.ts.
 * If you add columns/tables to taskflow-db.ts, update this seed too.
 * TODO: Consider extracting schema to a shared constant to prevent drift.
 */
function seedTestDb(db: Database.Database, boardId: string) {
  db.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, board_role TEXT DEFAULT 'standard', hierarchy_level INTEGER, max_depth INTEGER, parent_board_id TEXT);
    CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, role TEXT DEFAULT 'member', wip_limit INTEGER, notification_group_jid TEXT, PRIMARY KEY (board_id, person_id));
    CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
    CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
    CREATE TABLE tasks (id TEXT NOT NULL, board_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'simple', title TEXT NOT NULL, assignee TEXT, next_action TEXT, waiting_for TEXT, column TEXT DEFAULT 'inbox', priority TEXT, due_date TEXT, description TEXT, labels TEXT DEFAULT '[]', blocked_by TEXT DEFAULT '[]', reminders TEXT DEFAULT '[]', next_note_id INTEGER DEFAULT 1, notes TEXT DEFAULT '[]', _last_mutation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, child_exec_enabled INTEGER DEFAULT 0, child_exec_board_id TEXT, child_exec_person_id TEXT, child_exec_rollup_status TEXT, child_exec_last_rollup_at TEXT, child_exec_last_rollup_summary TEXT, linked_parent_board_id TEXT, linked_parent_task_id TEXT, subtasks TEXT, recurrence TEXT, current_cycle TEXT, PRIMARY KEY (board_id, id));
    CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
    CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
    CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza', runner_standup_task_id TEXT, runner_digest_task_id TEXT, runner_review_task_id TEXT, runner_dst_guard_task_id TEXT, standup_cron_local TEXT, digest_cron_local TEXT, review_cron_local TEXT, standup_cron_utc TEXT, digest_cron_utc TEXT, review_cron_utc TEXT, dst_sync_enabled INTEGER DEFAULT 0, dst_last_offset_minutes INTEGER, dst_last_synced_at TEXT, dst_resync_count_24h INTEGER DEFAULT 0, dst_resync_window_started_at TEXT, attachment_enabled INTEGER DEFAULT 1, attachment_disabled_reason TEXT DEFAULT '', attachment_allowed_formats TEXT DEFAULT '["pdf","jpg","png"]', attachment_max_size_bytes INTEGER DEFAULT 10485760, welcome_sent INTEGER DEFAULT 0, standup_target TEXT DEFAULT 'team', digest_target TEXT DEFAULT 'team', review_target TEXT DEFAULT 'team', runner_standup_secondary_task_id TEXT, runner_digest_secondary_task_id TEXT, runner_review_secondary_task_id TEXT);
    CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
    CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
    CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
  `);
  db.exec(`INSERT INTO boards VALUES ('${boardId}', 'test@g.us', 'test', 'standard', 0, 1, NULL)`);
  db.exec(`INSERT INTO board_config VALUES ('${boardId}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 4)`);
  db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${boardId}')`);
  db.exec(`INSERT INTO board_admins VALUES ('${boardId}', 'person-1', '5585999990001', 'manager', 1)`);
  db.exec(`INSERT INTO board_people VALUES ('${boardId}', 'person-1', 'Alexandre', '5585999990001', 'Gestor', 3, NULL)`);
  db.exec(`INSERT INTO board_people VALUES ('${boardId}', 'person-2', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`);
  // Seed some tasks
  const now = new Date().toISOString();
  db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at) VALUES ('T-001', '${boardId}', 'simple', 'Fix login bug', 'person-1', 'in_progress', '${now}', '${now}')`);
  db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at) VALUES ('T-002', '${boardId}', 'simple', 'Update docs', 'person-2', 'next_action', '${now}', '${now}')`);
  db.exec(`INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at) VALUES ('T-003', '${boardId}', 'simple', 'Review PR', 'inbox', '${now}', '${now}')`);
}

describe('TaskflowEngine', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;
  const boardId = 'board-test';

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, boardId);
    engine = new TaskflowEngine(db, boardId);
  });

  afterEach(() => {
    db.close();
  });

  describe('query', () => {
    it('returns full board view', async () => {
      const result = await engine.query({ query: 'board' });
      expect(result.success).toBe(true);
      expect(result.data.in_progress).toHaveLength(1);
      expect(result.data.next_action).toHaveLength(1);
      expect(result.data.inbox).toHaveLength(1);
    });

    it('returns person tasks', async () => {
      const result = await engine.query({ query: 'person_tasks', person_name: 'Alexandre' });
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('T-001');
    });

    it('returns task details', async () => {
      const result = await engine.query({ query: 'task_details', task_id: 'T-001' });
      expect(result.success).toBe(true);
      expect(result.data.title).toBe('Fix login bug');
    });

    it('returns error for unknown task', async () => {
      const result = await engine.query({ query: 'task_details', task_id: 'T-999' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('T-999');
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts
```

Expected: FAIL — `TaskflowEngine` not found.

**Step 3: Implement TaskflowEngine class with query method**

```typescript
// taskflow-engine.ts
import Database from 'better-sqlite3';

export interface QueryParams {
  query: string;
  sender_name?: string;
  person_name?: string;
  task_id?: string;
  search_text?: string;
  label?: string;
  since?: string;
}

export interface TaskflowResult {
  success: boolean;
  data?: any;
  formatted?: string;
  error?: string;
  // mutation-specific fields added by other methods
  [key: string]: any;
}

export class TaskflowEngine {
  constructor(
    private db: Database.Database,
    private boardId: string,
  ) {
    // Prevent SQLITE_BUSY when multiple containers access the same DB
    this.db.pragma('busy_timeout = 5000');
  }

  private resolvePerson(name: string): { person_id: string; name: string } | null {
    const row = this.db.prepare(
      `SELECT person_id, name FROM board_people WHERE board_id = ? AND LOWER(name) = LOWER(?)`,
    ).get(this.boardId, name) as any;
    return row || null;
  }

  private getTask(taskId: string): any {
    return this.db.prepare(
      `SELECT * FROM tasks WHERE board_id = ? AND id = ?`,
    ).get(this.boardId, taskId);
  }

  private getAllActiveTasks(): any[] {
    return this.db.prepare(
      `SELECT * FROM tasks WHERE board_id = ? OR (child_exec_board_id = ? AND child_exec_enabled = 1) ORDER BY created_at`,
    ).all(this.boardId, this.boardId) as any[];
  }

  async query(params: QueryParams): Promise<TaskflowResult> {
    const { query } = params;

    switch (query) {
      case 'board': {
        const tasks = this.getAllActiveTasks();
        const grouped: Record<string, any[]> = {
          inbox: [], next_action: [], in_progress: [], waiting: [], review: [], done: [],
        };
        for (const t of tasks) {
          if (grouped[t.column]) grouped[t.column].push(t);
        }
        return { success: true, data: grouped };
      }

      case 'task_details': {
        const task = this.getTask(params.task_id!);
        if (!task) return { success: false, error: `Task ${params.task_id} not found.` };
        const history = this.db.prepare(
          `SELECT * FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY at DESC LIMIT 5`,
        ).all(this.boardId, params.task_id);
        return { success: true, data: { ...task, recent_history: history } };
      }

      case 'person_tasks': {
        const person = this.resolvePerson(params.person_name!);
        if (!person) return { success: false, error: `Person '${params.person_name}' not found.` };
        const tasks = this.db.prepare(
          `SELECT * FROM tasks WHERE board_id = ? AND assignee = ? ORDER BY created_at`,
        ).all(this.boardId, person.person_id);
        return { success: true, data: tasks };
      }

      // ... remaining query types follow the same pattern
      // Each is a SELECT query that returns structured data

      default:
        return { success: false, error: `Unknown query type: ${query}` };
    }
  }
}
```

**Step 4: Run tests**

```bash
cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts
```

Expected: PASS

**Step 5: Add remaining query types**

Implement all query variants: `inbox`, `review`, `in_progress`, `next_action`, `waiting`, `my_tasks`, `overdue`, `due_today`, `due_tomorrow`, `due_this_week`, `next_7_days`, `search`, `urgent`, `high_priority`, `by_label`, `completed_today`, `completed_this_week`, `completed_this_month`, `person_waiting`, `person_completed`, `person_review`, `task_history`, `archive`, `archive_search`, `agenda`, `agenda_week`, `changes_today`, `changes_since`, `changes_this_week`, `statistics`, `person_statistics`, `month_statistics`, `summary`.

Add tests for each. Group related queries to keep the test file manageable.

**Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "feat: add TaskflowEngine with query tool"
```

---

### Task 3: Register tools in ipc-mcp-stdio.ts

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Step 1: Write test for conditional tool registration**

Add to the existing test file or create a new one verifying that TaskFlow tools only appear when `NANOCLAW_IS_TASKFLOW_MANAGED=1`.

**Step 2: Import TaskflowEngine and register tools conditionally**

At the end of `ipc-mcp-stdio.ts`, after existing tool registrations:

```typescript
import Database from 'better-sqlite3';
import { TaskflowEngine } from './taskflow-engine.js';

// Register TaskFlow tools only for TaskFlow-managed groups
if (process.env.NANOCLAW_IS_TASKFLOW_MANAGED === '1') {
  const dbPath = '/workspace/taskflow/taskflow.db';
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;  // 'board-{folder}'

  if (boardId) {
    const tfDb = new Database(dbPath);
    const engine = new TaskflowEngine(tfDb, boardId);

    server.tool(
      'taskflow_query',
      'Query the TaskFlow board. Returns structured data for board views, task details, search, statistics, etc.',
      {
        query: z.enum(['board', 'inbox', 'review', 'in_progress', 'next_action', 'waiting',
          'my_tasks', 'overdue', 'due_today', 'due_tomorrow', 'due_this_week', 'next_7_days',
          'search', 'urgent', 'high_priority', 'by_label', 'completed_today', 'completed_this_week',
          'completed_this_month', 'person_tasks', 'person_waiting', 'person_completed', 'person_review',
          'task_details', 'task_history', 'archive', 'archive_search', 'agenda', 'agenda_week',
          'changes_today', 'changes_since', 'changes_this_week', 'statistics', 'person_statistics',
          'month_statistics', 'summary']).describe('Query type'),
        sender_name: z.string().optional().describe('Sender name for my_tasks'),
        person_name: z.string().optional().describe('Person name for person_* queries'),
        task_id: z.string().optional().describe('Task ID for task_details/history'),
        search_text: z.string().optional().describe('Search text'),
        label: z.string().optional().describe('Label filter'),
        since: z.string().optional().describe('ISO date for changes_since'),
      },
      async (args) => {
        const result = await engine.query(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      },
    );

    // ... register other 8 tools with the same pattern
  }
}
```

**Step 3: Pass board_id as environment variable and update file sync**

Modify `container/agent-runner/src/runtime-config.ts` — add to `buildNanoclawMcpEnv()`:
```typescript
// Derive board ID from folder name (convention: 'board-{folder}')
if (containerInput.isTaskflowManaged) {
  env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-' + containerInput.groupFolder;
}
```

No changes needed to `ContainerInput` or `RegisteredGroup` — the board ID is derived from the existing `groupFolder` field using the established `board-${folder}` convention (see `provision-child-board.ts:239`, `migrate-to-sqlite.ts:419`).

Modify `src/container-runner.ts` — add `taskflow-engine.ts` to `CORE_AGENT_RUNNER_FILES`:
```typescript
const CORE_AGENT_RUNNER_FILES = [
  'index.ts',
  'ipc-mcp-stdio.ts',
  'ipc-tooling.ts',
  'runtime-config.ts',
  'taskflow-engine.ts',           // ← NEW: TaskFlow MCP tool engine
  path.join('mcp-plugins', 'create-group.ts'),
] as const;
```

**This is critical** — without it, `taskflow-engine.ts` won't be synced to per-group agent-runner-src directories, and the container will fail to compile `ipc-mcp-stdio.ts`.

**Step 4: Rebuild container and test**

```bash
./container/build.sh
```

**Step 5: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/runtime-config.ts src/container-runner.ts
git commit -m "feat: register TaskFlow query tool, pass board_id env, sync engine to groups"
```

---

## Phase 2: Mutation Tools

### Task 4: Implement taskflow_create

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

**Key logic to implement:**
- ID generation (read `next_task_number` from `board_config`, format as `T-NNN`/`P-NNN`/`R-NNN`, increment)
- Assignee resolution (name → person_id, offer_register if unknown)
- Column placement (inbox for captures, next_action for assigned tasks)
- Project subtask initialization
- Recurring task setup (due_date calculation)
- Auto-link to child board on assignment (hierarchy mode)
- History recording
- Snapshot for undo (`_last_mutation`)

**Tests to write:**
- Create inbox capture → goes to inbox, no assignee
- Create assigned task → goes to next_action
- Create task with unknown assignee → returns offer_register
- Create project with subtasks → subtasks[] populated
- Create recurring → recurrence and due_date set
- Create task for person with child board → auto-links
- Permission check: non-manager can't create assigned tasks

**TDD cycle:** Write each test, verify it fails, implement the handler, verify it passes.

**Commit after all tests pass.**

---

### Task 5: Implement taskflow_move

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

**Key logic — the state machine:**

```
inbox → next_action (via process_inbox)
next_action → in_progress (start, checks WIP)
in_progress → waiting (wait, records reason)
waiting → in_progress (resume, checks WIP)
in_progress → next_action (return, frees WIP)
in_progress → review (review)
review → done (approve, manager/delegate only, not self-approve)
review → in_progress (reject, checks WIP, records reason)
any → done (conclude, shortcut)
done → next_action (reopen)
force_start: ignores WIP (manager only)
```

**Side effects per transition:**
- WIP check on start/resume/reject (count in_progress tasks for assignee)
- Dependency resolution on completion (unblock dependents)
- Project subtask completion (advance next_action)
- Recurring cycle advancement on conclusion
- Archive trigger (mark for archival)
- `_last_mutation` snapshot before every mutation
- `task_history` recording

**Tests to write (one per transition + edge cases):**
- start: next_action → in_progress (happy path)
- start: WIP exceeded → error with wip_warning
- force_start: WIP exceeded → succeeds (manager only)
- wait: in_progress → waiting with reason
- resume: waiting → in_progress
- return: in_progress → next_action
- review: in_progress → review
- approve: review → done (manager/delegate, not self)
- reject: review → in_progress with reason
- conclude: any → done (assignee or manager)
- reopen: done → next_action
- approve triggers dependency resolution
- conclude recurring → creates new cycle
- project subtask completion → advances next_action
- permission denied for non-owner operations
- notification: move by non-assignee → returns notification for assignee
- notification: self-move → no notification
- notification: task without assignee → no notification
- notification: assignee has notification_group_jid → notification uses it

**Commit after all tests pass.**

---

### Task 6: Implement taskflow_reassign

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

**Key logic:**
1. Permission: sender is assignee OR manager
2. Target person exists? If not → offer_register
3. If not confirmed → return requires_confirmation with summary
4. UPDATE assignee
5. If child_exec_enabled=1: unlink old board, relink to new board (if exists), else set child_exec_enabled=0
6. Record history
7. Snapshot for undo

**Tests:**
- Reassign happy path (confirmed)
- Reassign dry run (confirmed=false → returns summary)
- Reassign to unknown person → offer_register
- Reassign linked task → auto-relinks to new child board
- Reassign linked task to person without child board → unlinks
- Bulk transfer: all tasks from person A to person B
- Bulk transfer: no active tasks → error
- Bulk transfer: same person → error
- Permission: assignee can reassign own task
- Permission: manager can reassign any task
- Permission: non-owner/non-manager → denied
- NO WIP check on reassignment

**Commit after all tests pass.**

---

### Task 7: Implement taskflow_update

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

**Supported updates:** title, priority, due_date (set/remove), description, next_action, add_label, remove_label, add_note, edit_note, remove_note, add_subtask, rename_subtask, reopen_subtask, recurrence change.

**Tests:**
- Update title
- Update priority (valid values)
- Invalid priority → error
- Set due_date
- Remove due_date (null)
- Add label (idempotent)
- Remove label
- Add note (auto-increment ID)
- Edit note by ID
- Remove note by ID
- Note not found → error
- Description max 500 chars → error if exceeded
- Add subtask to project
- Rename subtask
- Reopen completed subtask
- Subtask command on non-project → error
- Recurrence change on non-recurring → error
- Permission: assignee or manager only

**Commit after all tests pass.**

---

### Task 8: Implement taskflow_dependency

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

**Key logic:**
- Add dependency: check circular (transitive), check both tasks exist and active
- Remove dependency: check it exists
- Add reminder: check task has due_date, store in task's `reminders` JSON column, write IPC file to `/workspace/ipc/tasks/` with `schedule_type: 'once'` (same mechanism as `schedule_task` MCP tool — no new host-side handler needed)
- Remove reminder: remove from `reminders` JSON, write IPC cancel file

**Tests:**
- Add dependency happy path
- Circular dependency detection (A→B→A)
- Transitive circular detection (A→B→C→A)
- Self-dependency → error
- Duplicate dependency → error
- Remove dependency happy path
- Remove non-existent dependency → error
- Dependency on archived task → error
- Reminder without due_date → error
- Add reminder happy path (verify IPC file written)
- Remove reminder (verify IPC cancel written)

**Commit after all tests pass.**

---

### Task 9: Implement taskflow_admin

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

**Actions:** register_person, remove_person, add_manager, add_delegate, remove_admin, set_wip_limit, cancel_task, restore_task, process_inbox.

**Tests:**
- Register person
- Register person on non-leaf hierarchy board → auto-provision (via IPC)
- Remove person → lists tasks to reassign
- Remove person with force → reassigns tasks
- Remove last manager → error
- Add manager
- Add delegate
- Remove admin (not last manager)
- Set WIP limit
- Cancel task → moves to archive
- Cancel linked task → unlinks first
- Restore task from archive
- Restore non-existent archive → error
- Process inbox → returns inbox items for manager to assign
- All admin actions: manager-only permission check

**Commit after all tests pass.**

---

### Task 10: Implement taskflow_undo

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

**Key logic:**
- Find task with most recent `_last_mutation.at` within 60s
- Verify permission: mutation author or manager
- WIP guard: if restoring to in_progress, check limit
- Replace task with snapshot, record "undone" in history
- Clear `_last_mutation`

**Tests:**
- Undo happy path (within 60s)
- Undo expired (>60s) → error
- Undo batch operation → error
- Undo creation → error (suggest cancelar)
- Undo with WIP exceeded → error (suggest forcar)
- Force undo → bypasses WIP (manager only)
- Permission: only mutation author or manager

**Commit after all tests pass.**

---

### Task 11: Implement taskflow_report

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

**Report types:** standup, digest, weekly.

**Returns structured data** (not formatted text — the CLAUDE.md template handles formatting):
- Per-person task breakdown
- Overdue tasks
- Blocked tasks
- Recently completed
- Statistics (counts, avg cycle time)

**Tests:**
- Standup returns correct sections
- Digest includes overdue and blocked
- Weekly includes completion stats and trends
- Empty board → still returns valid structure

**Commit after all tests pass.**

---

### Task 12: Register all 9 tools in ipc-mcp-stdio.ts

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Step 1:** Add zod schemas and handlers for all 9 tools (taskflow_create, taskflow_move, taskflow_reassign, taskflow_update, taskflow_dependency, taskflow_admin, taskflow_undo, taskflow_query, taskflow_report).

**Step 2:** Each tool handler:
1. Parses and validates args with zod
2. Calls the corresponding `engine.method(args)`
3. Returns `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`

**Step 3:** Rebuild container, verify all tools show up.

```bash
./container/build.sh
```

**Step 4: Commit**

```bash
git commit -m "feat: register all 9 TaskFlow MCP tools"
```

---

## Phase 3: New CLAUDE.md Template

### Task 13: Write the ~400-line CLAUDE.md template

**Files:**
- Create: `container/agent-runner/src/taskflow-engine.ts` (already done)
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`

**Step 1:** Back up the current template

```bash
cp .claude/skills/add-taskflow/templates/CLAUDE.md.template .claude/skills/add-taskflow/templates/CLAUDE.md.template.v1
```

**Step 2:** Write the new ~400-line template

Structure (from design doc):
1. Identity & scope guard + welcome check (15 lines)
2. Security (20 lines)
3. WhatsApp formatting (10 lines)
4. Sender identification (15 lines)
5. Authorization matrix (25 lines)
6. Tool vs. direct SQL decision framework (20 lines)
7. Command → tool mapping table (80 lines)
8. Tool response handling (30 lines)
9. Report templates (40 lines)
10. Notification dispatch (15 lines) — tools return `notifications` array, agent sends each via `send_message`
11. Schema reference for ad-hoc SQL (30 lines) — full table/column reference so agent can write correct SQL when needed
12. Hierarchy overview — conditional (25 lines)
13. Batch operations (10 lines)
14. Error presentation (15 lines)
15. Configuration (15 lines)

**Key section — Command → Tool Mapping (excerpt):**

```markdown
## Command → Tool Mapping

When the user sends a command, call the matching MCP tool. The tool handles all validation, permission checks, and side effects.

### Quick Capture (everyone)
| User says | Tool call |
|-----------|-----------|
| "anotar: X" / "lembrar: X" / "registrar: X" | `taskflow_create({ type: 'inbox', title: 'X', sender_name: SENDER })` |

### Task Creation (manager)
| User says | Tool call |
|-----------|-----------|
| "tarefa para Y: X ate Z" | `taskflow_create({ type: 'simple', title: 'X', assignee: 'Y', due_date: 'Z', sender_name: SENDER })` |
| "projeto para Y: X. Etapas: 1. A, 2. B" | `taskflow_create({ type: 'project', title: 'X', assignee: 'Y', subtasks: ['A', 'B'], sender_name: SENDER })` |
| "diario/semanal/mensal para Y: X" | `taskflow_create({ type: 'recurring', ..., sender_name: SENDER })` |

### Column Transitions
| User says | Tool call |
|-----------|-----------|
| "comecando T-XXX" | `taskflow_move({ task_id: 'T-XXX', action: 'start', sender_name: SENDER })` |
| "T-XXX aguardando Y" | `taskflow_move({ task_id: 'T-XXX', action: 'wait', reason: 'Y', sender_name: SENDER })` |
| "T-XXX retomada" | `taskflow_move({ task_id: 'T-XXX', action: 'resume', sender_name: SENDER })` |
| ... | ... |

### Queries
| User says | Tool call |
|-----------|-----------|
| "quadro" | `taskflow_query({ query: 'board' })` |
| "minhas tarefas" | `taskflow_query({ query: 'my_tasks', sender_name: SENDER })` |
| "buscar X" | `taskflow_query({ query: 'search', search_text: 'X' })` |
| ... | ... |
```

**Key section — Tool vs. Direct SQL:**

```markdown
## Tool vs. Direct SQL

Tools are the preferred path for standard commands — they handle validation, side effects, history, and undo snapshots automatically.

For anything the tools don't cover (ad-hoc questions, compound operations, one-off bulk changes, or when a tool error doesn't match the situation), fall back to direct SQL via `mcp__sqlite__read_query` / `mcp__sqlite__write_query`.

When writing mutations via SQL, always:
1. Record the action in `task_history`
2. Update `updated_at` on affected tasks
3. Set `_last_mutation` snapshot for undo support
4. Respect the authorization matrix
5. If unsure, ask the user before executing

## Tool Response Handling

Every tool returns JSON with `success`, `data`, and optionally `error`.

- **`success: true`** → format `data` for WhatsApp and send
- **`success: false`** → present `error` in {{LANGUAGE}}. If the error doesn't match the user's situation (edge case or tool limitation), you may fall back to direct SQL — explain what you're doing and why.
- **`offer_register`** → "[name] não está cadastrado. Membros atuais: [list]. Quer cadastrar? Preciso do telefone e cargo."
- **`requires_confirmation`** → present the confirmation summary, wait for explicit "sim"
- **`wip_warning`** → "[person] já tem N tarefas em andamento (limite: M). Use 'forcar' para ultrapassar."
```

**Step 3: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "feat: new 400-line CLAUDE.md template using MCP tools"
```

---

### Task 14: Test with one board

**Files:**
- Modify: `groups/tec-taskflow/CLAUDE.md`

**Step 1:** Generate the new CLAUDE.md for tec-taskflow by substituting template variables.

**Step 2:** Rebuild container with the TaskFlow engine.

```bash
./container/build.sh
systemctl restart nanoclaw
```

**Step 3:** Test all command categories via WhatsApp:
- Quick capture: `@Case anotar: teste`
- Create task: `@Case tarefa para [pessoa]: teste ate sexta`
- Move: `@Case comecando T-XXX`
- Query: `@Case quadro`
- Reassign: `@Case reatribuir T-XXX para [pessoa]`
- Statistics: `@Case estatisticas`
- Undo: `@Case desfazer`

**Step 4:** If all tests pass, commit and proceed to rollout.

---

## Phase 4: Skill Restructuring & Rollout

### Task 15: Update manifest.yaml and skill structure

**Files:**
- Modify: `.claude/skills/add-taskflow/manifest.yaml`
- Create: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- Create: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts`
- Create: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- Create: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md`
- Create: `.claude/skills/add-taskflow/modify/container/agent-runner/src/runtime-config.ts`
- Create: `.claude/skills/add-taskflow/modify/container/agent-runner/src/runtime-config.ts.intent.md`
- Create: `.claude/skills/add-taskflow/modify/src/container-runner.ts`
- Create: `.claude/skills/add-taskflow/modify/src/container-runner.ts.intent.md`

**manifest.yaml:**

```yaml
skill: taskflow
version: 2.0.0
description: "Kanban+GTD task management with MCP tool engine"
core_version: 0.1.0
adds:
  - container/agent-runner/src/taskflow-engine.ts
  - container/agent-runner/src/taskflow-engine.test.ts
modifies:
  - container/agent-runner/src/ipc-mcp-stdio.ts
  - container/agent-runner/src/runtime-config.ts
  - src/container-runner.ts                       # CORE_AGENT_RUNNER_FILES + env var
structured:
  npm_dependencies:
    better-sqlite3: "^11.8.1"
  npm_dev_dependencies:
    "@types/better-sqlite3": "^7.6.0"
    vitest: "^3.0.0"
depends: []
post_apply:
  - "cd container/agent-runner && npm install"
  - "./container/build.sh"
test: "cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts"
```

**Commit after structure is complete.**

---

### Task 16: Update SKILL.md

**Files:**
- Modify: `.claude/skills/add-taskflow/SKILL.md`

Update the setup wizard to:
1. Run `npx tsx scripts/apply-skill.ts .claude/skills/add-taskflow` to install the engine
2. Pass `NANOCLAW_TASKFLOW_BOARD_ID` and `NANOCLAW_TASKFLOW_DB_PATH` to the container
3. Generate the new ~400-line CLAUDE.md template
4. Remove the SQLite MCP server from `.mcp.json` (no longer needed for mutations, only for ad-hoc queries — keep it for now)

**Commit.**

---

### Task 17: Rollout to all boards

**Files:**
- Modify: `groups/tec-taskflow/CLAUDE.md` (already done in Task 14)
- Modify: `groups/seci-taskflow/CLAUDE.md`
- Modify: `groups/secti-taskflow/CLAUDE.md`

**Step 1:** Generate new CLAUDE.md for each board by substituting template variables.

**Step 2:** Rebuild container and restart service.

```bash
./container/build.sh
systemctl restart nanoclaw
```

**Step 3:** Test each board via WhatsApp. Monitor logs for errors.

```bash
tail -f /root/nanoclaw/logs/nanoclaw.log
```

**Step 4:** Commit final CLAUDE.md files.

**Rollback procedure (if regressions occur):**
1. **Per-board:** Replace the board's `CLAUDE.md` with the v1 backup (`.template.v1`), substituting the board's variables. The MCP tools remain registered but are harmless — the v1 template uses raw SQL and never calls `taskflow_*` tools.
2. **Full rollback:** Restore all boards to v1 templates, revert `ipc-mcp-stdio.ts` to remove the tool registration block, rebuild container.
3. **Data compatibility:** Both old and new templates write to the same SQLite schema — no data migration needed for rollback.

---

## Estimated Size

| Component | Lines |
|-----------|-------|
| `taskflow-engine.ts` | ~2000-2500 |
| `taskflow-engine.test.ts` | ~1000-1500 |
| `ipc-mcp-stdio.ts` additions | ~200 |
| `CLAUDE.md.template` (new) | ~400 |
| **Total new code** | **~3600-4600** |
| **CLAUDE.md reduction** | **~800 lines removed** |

## Risk Mitigation

- **v1 template preserved** as `.template.v1` for quick rollback (see rollback procedure in Task 17)
- **Gradual rollout**: tec-taskflow first (lowest risk), then seci, then secti
- **SQLite MCP kept**: agent can still run ad-hoc SQL queries as fallback
- **Comprehensive tests**: every mutation path tested before deployment
- **Schema alignment**: Task 0 syncs canonical schema with live DB before engine development
- **Concurrent write safety**: `busy_timeout = 5000` pragma on all engine DB connections
- **Native module build**: Dockerfile verified to have build tools in Task 1
