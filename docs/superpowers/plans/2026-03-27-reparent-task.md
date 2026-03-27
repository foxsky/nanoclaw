# Reparent Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow moving existing standalone tasks under a project as subtasks, preserving all history and metadata.

**Architecture:** Add a `reparent_task` action to `taskflow_admin`. It sets `parent_task_id` on the target task, making it a functional subtask of the specified project. The task keeps its original ID (no FK cascading risk). The engine already uses `parent_task_id` for all subtask behavior — board view, auto-advance, archive, undo — so no downstream changes are needed.

**Tech Stack:** TypeScript, better-sqlite3, vitest

---

### Task 1: Add failing tests for reparent_task

**Files:**
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [ ] **Step 1: Add describe block with test cases**

Add a new top-level `describe('reparent_task', ...)` block after the existing `undo WIP guard exempts meetings` block (around line 5330). Import `initTaskflowDb` if not already imported.

```typescript
describe('reparent_task', () => {
  function setupBoard() {
    const db = initTaskflowDb(':memory:');
    db.prepare(`INSERT INTO boards (id, group_jid, group_folder) VALUES (?, ?, ?)`).run('b1', 'jid1', 'test-board');
    db.prepare(`INSERT INTO board_people (board_id, person_id, display_name, phone) VALUES (?, ?, ?, ?)`).run('b1', 'mgr1', 'Manager', '+5500000000000');
    db.prepare(`INSERT INTO board_admins (board_id, person_id, admin_role) VALUES (?, ?, ?)`).run('b1', 'mgr1', 'manager');
    // standalone task
    db.prepare(`INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at) VALUES (?, ?, 'simple', ?, ?, 'next_action', ?, ?)`).run('T5', 'b1', 'Standalone Task', 'mgr1', new Date().toISOString(), new Date().toISOString());
    // project with one subtask
    db.prepare(`INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at) VALUES (?, ?, 'project', ?, ?, 'next_action', ?, ?)`).run('P1', 'b1', 'Test Project', 'mgr1', new Date().toISOString(), new Date().toISOString());
    db.prepare(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, created_at, updated_at) VALUES (?, ?, 'simple', ?, ?, 'next_action', ?, ?, ?)`).run('P1.1', 'b1', 'Existing Subtask', 'mgr1', 'P1', new Date().toISOString(), new Date().toISOString());
    // another standalone
    db.prepare(`INSERT INTO tasks (id, board_id, type, title, assignee, column, due_date, priority, created_at, updated_at) VALUES (?, ?, 'simple', ?, ?, 'in_progress', ?, ?, ?, ?)`).run('T10', 'b1', 'Task With Metadata', 'mgr1', '2026-04-15', 'high', new Date().toISOString(), new Date().toISOString());
    // non-project task
    db.prepare(`INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at) VALUES (?, ?, 'simple', ?, ?, 'next_action', ?, ?)`).run('T20', 'b1', 'Not A Project', 'mgr1', new Date().toISOString(), new Date().toISOString());
    return db;
  }

  it('moves standalone task under a project', () => {
    const db = setupBoard();
    const engine = new TaskflowEngine(db, 'b1');
    const result = engine.admin({
      board_id: 'b1',
      action: 'reparent_task',
      task_id: 'T5',
      target_parent_id: 'P1',
      sender_name: 'Manager',
    });
    expect(result.success).toBe(true);
    const task = db.prepare(`SELECT parent_task_id FROM tasks WHERE id = 'T5'`).get() as any;
    expect(task.parent_task_id).toBe('P1');
    db.close();
  });

  it('preserves due_date, priority, column, and notes after reparent', () => {
    const db = setupBoard();
    const engine = new TaskflowEngine(db, 'b1');
    const result = engine.admin({
      board_id: 'b1',
      action: 'reparent_task',
      task_id: 'T10',
      target_parent_id: 'P1',
      sender_name: 'Manager',
    });
    expect(result.success).toBe(true);
    const task = db.prepare(`SELECT parent_task_id, due_date, priority, column FROM tasks WHERE id = 'T10'`).get() as any;
    expect(task.parent_task_id).toBe('P1');
    expect(task.due_date).toBe('2026-04-15');
    expect(task.priority).toBe('high');
    expect(task.column).toBe('in_progress');
    db.close();
  });

  it('rejects reparent when target is not a project', () => {
    const db = setupBoard();
    const engine = new TaskflowEngine(db, 'b1');
    const result = engine.admin({
      board_id: 'b1',
      action: 'reparent_task',
      task_id: 'T5',
      target_parent_id: 'T20',
      sender_name: 'Manager',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('project');
    db.close();
  });

  it('rejects reparent when task is already a subtask', () => {
    const db = setupBoard();
    const engine = new TaskflowEngine(db, 'b1');
    const result = engine.admin({
      board_id: 'b1',
      action: 'reparent_task',
      task_id: 'P1.1',
      target_parent_id: 'P1',
      sender_name: 'Manager',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already');
    db.close();
  });

  it('rejects non-manager sender', () => {
    const db = setupBoard();
    db.prepare(`INSERT INTO board_people (board_id, person_id, display_name, phone) VALUES (?, ?, ?, ?)`).run('b1', 'user1', 'Regular User', '+5500000000001');
    const engine = new TaskflowEngine(db, 'b1');
    const result = engine.admin({
      board_id: 'b1',
      action: 'reparent_task',
      task_id: 'T5',
      target_parent_id: 'P1',
      sender_name: 'Regular User',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission');
    db.close();
  });

  it('records history on both task and project', () => {
    const db = setupBoard();
    const engine = new TaskflowEngine(db, 'b1');
    engine.admin({
      board_id: 'b1',
      action: 'reparent_task',
      task_id: 'T5',
      target_parent_id: 'P1',
      sender_name: 'Manager',
    });
    const taskHistory = db.prepare(`SELECT * FROM task_history WHERE task_id = 'T5' AND action = 'reparented'`).get() as any;
    expect(taskHistory).toBeTruthy();
    const projectHistory = db.prepare(`SELECT * FROM task_history WHERE task_id = 'P1' AND action = 'subtask_added'`).get() as any;
    expect(projectHistory).toBeTruthy();
    db.close();
  });

  it('is undoable within 60 seconds', () => {
    const db = setupBoard();
    const engine = new TaskflowEngine(db, 'b1');
    engine.admin({
      board_id: 'b1',
      action: 'reparent_task',
      task_id: 'T5',
      target_parent_id: 'P1',
      sender_name: 'Manager',
    });
    // Task is now a subtask
    expect((db.prepare(`SELECT parent_task_id FROM tasks WHERE id = 'T5'`).get() as any).parent_task_id).toBe('P1');
    // Undo
    const undoResult = engine.undo({ board_id: 'b1', sender_name: 'Manager' });
    expect(undoResult.success).toBe(true);
    // Task is standalone again
    expect((db.prepare(`SELECT parent_task_id FROM tasks WHERE id = 'T5'`).get() as any).parent_task_id).toBeNull();
    db.close();
  });

  it('reparented task appears in getSubtaskRows of the parent', () => {
    const db = setupBoard();
    const engine = new TaskflowEngine(db, 'b1');
    engine.admin({
      board_id: 'b1',
      action: 'reparent_task',
      task_id: 'T5',
      target_parent_id: 'P1',
      sender_name: 'Manager',
    });
    const subtasks = db.prepare(`SELECT id FROM tasks WHERE board_id = 'b1' AND parent_task_id = 'P1' ORDER BY id`).all() as any[];
    const ids = subtasks.map((s: any) => s.id);
    expect(ids).toContain('P1.1');
    expect(ids).toContain('T5');
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t 'reparent_task'`
Expected: 8 failures — `action: 'reparent_task'` not recognized / engine errors

- [ ] **Step 3: Commit failing tests**

```bash
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "test: add failing tests for reparent_task admin action"
```

---

### Task 2: Implement reparent_task in the engine

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`

- [ ] **Step 1: Add `reparent_task` to AdminParams action union**

Find the `AdminParams` interface (line 198) and add `'reparent_task'` to the action union. Also add the `target_parent_id` field:

```typescript
export interface AdminParams {
  board_id: string;
  action: 'register_person' | 'remove_person' | 'add_manager' | 'add_delegate' | 'remove_admin' | 'set_wip_limit' | 'cancel_task' | 'restore_task' | 'process_inbox' | 'manage_holidays' | 'process_minutes' | 'process_minutes_decision' | 'accept_external_invite' | 'reparent_task';
  // ... existing fields ...
  target_parent_id?: string;  // for reparent_task — project to move the task under
}
```

- [ ] **Step 2: Add the reparent_task case in the admin method**

Find the `default:` case in the `admin()` method's switch statement (around line 6400 area — search for `default:` after the last `case 'accept_external_invite'`). Add the new case BEFORE the default:

```typescript
        /* ---- reparent_task ---- */
        case 'reparent_task': {
          if (!isMgr) {
            return { success: false, error: `Permission denied: only managers can reparent tasks.` };
          }
          if (!params.task_id) {
            return { success: false, error: 'Missing required parameter: task_id' };
          }
          if (!params.target_parent_id) {
            return { success: false, error: 'Missing required parameter: target_parent_id' };
          }

          const task = this.requireTask(params.task_id);
          const taskBoardId = this.taskBoardId(task);
          const now = new Date().toISOString();

          // Guard: task must not already be a subtask
          if (task.parent_task_id) {
            return { success: false, error: `Task ${task.id} is already a subtask of ${task.parent_task_id}.` };
          }

          // Guard: target must be a project
          const parent = this.requireTask(params.target_parent_id);
          if (parent.type !== 'project') {
            return { success: false, error: `Target ${params.target_parent_id} is not a project (type: ${parent.type}).` };
          }

          // Guard: task and parent must be on the same board
          const parentBoardId = this.taskBoardId(parent);
          if (taskBoardId !== parentBoardId) {
            return { success: false, error: `Task ${task.id} and project ${parent.id} are on different boards.` };
          }

          // Save undo snapshot
          const reparentSnapshot = JSON.stringify({
            action: 'reparented',
            by: params.sender_name,
            at: now,
            snapshot: { parent_task_id: task.parent_task_id },
          });

          // Set parent_task_id
          this.db
            .prepare(`UPDATE tasks SET parent_task_id = ?, _last_mutation = ?, updated_at = ? WHERE board_id = ? AND id = ?`)
            .run(parent.id, reparentSnapshot, now, taskBoardId, task.id);

          // Record history on the task
          this.recordHistory(task.id, 'reparented', params.sender_name,
            JSON.stringify({ parent_task_id: parent.id, parent_title: parent.title }),
            taskBoardId);

          // Record history on the project
          this.recordHistory(parent.id, 'subtask_added', params.sender_name,
            JSON.stringify({ subtask_id: task.id, subtask_title: task.title }),
            parentBoardId);

          return {
            success: true,
            task_id: task.id,
            data: {
              parent_task_id: parent.id,
              parent_title: parent.title,
            },
          };
        }
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t 'reparent_task'`
Expected: All 8 tests pass

- [ ] **Step 4: Run the full test suite to check for regressions**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: All 338+ tests pass

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat(taskflow): add reparent_task admin action"
```

---

### Task 3: Expose reparent_task in MCP schema

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Add reparent_task to the action enum and target_parent_id parameter**

Find the `taskflow_admin` tool registration (search for `'taskflow_admin'`). Add `'reparent_task'` to the `z.enum()` array and add the `target_parent_id` parameter.

In the action enum (around line 908):
```typescript
action: z.enum([..., 'accept_external_invite', 'reparent_task']).describe('Admin action'),
```

Add after the existing `task_id` parameter:
```typescript
target_parent_id: z.string().optional().describe('Target project ID to move the task under (for reparent_task)'),
```

- [ ] **Step 2: Run build to verify types**

Run: `npm run build 2>&1 | grep 'error TS'`
Expected: No new errors (only the pre-existing whatsapp-auth.ts warning)

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(taskflow): expose reparent_task in MCP schema"
```

---

### Task 4: Document reparent_task in the CLAUDE.md template

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- Regenerate: `groups/*/CLAUDE.md` (via generator script)

- [ ] **Step 1: Add reparent_task row to the template**

Find the Updates section (around line 228-244) where task operations are documented. Add after the subtask deadline rows (that were added earlier today):

```markdown
| "mover TXXX para projeto PYYY" | `taskflow_admin({ action: 'reparent_task', task_id: 'TXXX', target_parent_id: 'PYYY', sender_name: SENDER })` |
```

- [ ] **Step 2: Regenerate group CLAUDE.md files**

Run: `node scripts/generate-claude-md.mjs`
Expected: 11 files written

- [ ] **Step 3: Run TaskFlow skill tests to verify template alignment**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t 'generated'`
Expected: All template alignment tests pass

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template groups/
git commit -m "docs(taskflow): document reparent_task in CLAUDE.md template"
```

---

### Task 5: Add MCP schema test for reparent_task

**Files:**
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [ ] **Step 1: Add schema test**

Find the existing MCP schema tests (around line 2543-2710, search for `MCP schema includes`). Add:

```typescript
  it('MCP schema includes reparent_task in taskflow_admin', () => {
    const content = fs.readFileSync(
      path.resolve(skillDir, '..', '..', '..', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
      'utf-8',
    );
    expect(content).toContain("'reparent_task'");
    expect(content).toContain('target_parent_id');
  });
```

- [ ] **Step 2: Add template test**

In the same area where template operation tests exist, add:

```typescript
  it('CLAUDE.md.template documents reparent_task for moving tasks to projects', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('reparent_task');
    expect(content).toContain('target_parent_id');
  });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: All tests pass (340+ now)

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "test(taskflow): add MCP schema and template tests for reparent_task"
```

---

### Task 6: Update changelog and final verification

**Files:**
- Modify: `.claude/skills/add-taskflow/CHANGELOG.md`

- [ ] **Step 1: Update TaskFlow changelog**

Add to the top of the changelog under the existing `2026-03-27` entry:

```markdown
### Reparent Task
- New `reparent_task` admin action: move standalone tasks under existing projects as subtasks
- Preserves all metadata (due_date, priority, notes, history, column)
- Task keeps its original ID (no broken references)
- Undoable within 60 seconds
- Manager-only operation with guards: target must be a project, task must not already be a subtask
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All 40 test files pass, 885+ tests pass

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Clean build (only pre-existing whatsapp-auth.ts warning)

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/add-taskflow/CHANGELOG.md
git commit -m "docs(taskflow): add reparent_task to changelog"
```
