# Cross-Board Project Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a child board converts a delegated task into a project with subtasks, the parent board's task automatically receives rollup updates as subtasks change status.

**Architecture:** Three changes: (1) Expand `refresh_rollup` counting to include subtasks of tagged projects, not just directly-tagged tasks. (2) Extract rollup into a reusable private helper. (3) Auto-trigger rollup from `move()`, `cancel_task`, and `restore_task` when a task or its parent project has `linked_parent_task_id`. The helper loads the parent task via direct SQL (not `requireTask()`) to avoid dependency on visibility rules.

**Known limitations:**
- Archive table has no `parent_task_id` column — cancelled subtask counts for tagged projects will be 0. `cancelled_needs_decision` won't trigger for indirectly-linked subtasks.
- `undo()` does not re-trigger rollup — manual `refresh_rollup` needed after undo (rare, 60s window).

**Tech Stack:** TypeScript, better-sqlite3, vitest

---

### Task 1: Add failing tests for cross-board project rollup

**Files:**
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [ ] **Step 1: Add describe block with test cases**

Add a new top-level `describe('cross-board project rollup', ...)` at the end of the test file. The setup creates two boards (parent + child), a delegated task on the parent, and a project with subtasks on the child linked back via `linked_parent_task_id`.

```typescript
describe('cross-board project rollup', () => {
  const PARENT_BOARD = 'board-parent-rollup';
  const CHILD_BOARD = 'board-child-rollup';

  function setupBoards() {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    // Parent board
    db.exec(`INSERT INTO boards VALUES ('${PARENT_BOARD}', 'parent@g.us', 'parent-test', 'standard', 0, 2, NULL, NULL)`);
    db.exec(`INSERT INTO board_config VALUES ('${PARENT_BOARD}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 4, 1, 1, 1)`);
    db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${PARENT_BOARD}')`);
    db.exec(`INSERT INTO board_people VALUES ('${PARENT_BOARD}', 'mgr1', 'Manager', '5585999990001', 'Gestor', 3, NULL)`);
    db.exec(`INSERT INTO board_admins VALUES ('${PARENT_BOARD}', 'mgr1', '5585999990001', 'manager', 1)`);
    // Child board
    db.exec(`INSERT INTO boards VALUES ('${CHILD_BOARD}', 'child@g.us', 'child-test', 'standard', 1, 2, '${PARENT_BOARD}', NULL)`);
    db.exec(`INSERT INTO board_config VALUES ('${CHILD_BOARD}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 4, 1, 1, 1)`);
    db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${CHILD_BOARD}')`);
    db.exec(`INSERT INTO board_people VALUES ('${CHILD_BOARD}', 'worker1', 'Worker', '5585999990002', 'Dev', 3, NULL)`);
    db.exec(`INSERT INTO board_admins VALUES ('${CHILD_BOARD}', 'worker1', '5585999990002', 'manager', 1)`);
    db.exec(`INSERT INTO child_board_registrations VALUES ('${PARENT_BOARD}', 'worker1', '${CHILD_BOARD}')`);
    db.exec(`INSERT INTO board_groups VALUES ('${CHILD_BOARD}', 'child@g.us', 'child-test', 'team')`);

    const now = new Date().toISOString();
    // T1 on parent: delegated task (child_exec_enabled)
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, child_exec_enabled, child_exec_board_id, child_exec_person_id, requires_close_approval, created_at, updated_at) VALUES ('T1', '${PARENT_BOARD}', 'simple', 'Delegated Task', 'worker1', 'in_progress', 1, '${CHILD_BOARD}', 'worker1', 0, '${now}', '${now}')`);
    // P1 on child: project linked to T1 on parent
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, linked_parent_board_id, linked_parent_task_id, requires_close_approval, created_at, updated_at) VALUES ('P1', '${CHILD_BOARD}', 'project', 'Local Project', 'worker1', 'in_progress', '${PARENT_BOARD}', 'T1', 0, '${now}', '${now}')`);
    // P1.1, P1.2, P1.3: subtasks of P1 on child
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, created_at, updated_at) VALUES ('P1.1', '${CHILD_BOARD}', 'simple', 'Sub A', 'worker1', 'next_action', 'P1', 0, '${now}', '${now}')`);
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, created_at, updated_at) VALUES ('P1.2', '${CHILD_BOARD}', 'simple', 'Sub B', 'worker1', 'next_action', 'P1', 0, '${now}', '${now}')`);
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, created_at, updated_at) VALUES ('P1.3', '${CHILD_BOARD}', 'simple', 'Sub C', 'worker1', 'next_action', 'P1', 0, '${now}', '${now}')`);
    return db;
  }

  it('refresh_rollup counts subtasks of tagged project', () => {
    const db = setupBoards();
    const parentEngine = new TaskflowEngine(db, PARENT_BOARD);
    // Move P1.1 to done on child board
    const childEngine = new TaskflowEngine(db, CHILD_BOARD);
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.1', action: 'conclude', sender_name: 'Worker' });
    // Refresh rollup on parent
    const result = parentEngine.hierarchy({ board_id: PARENT_BOARD, action: 'refresh_rollup', task_id: 'T1', sender_name: 'Manager' });
    expect(result.success).toBe(true);
    // Should see 3 total (P1.1 done + P1.2 open + P1.3 open), not 1 (just P1)
    expect(result.data.total).toBeGreaterThanOrEqual(3);
    expect(result.data.done).toBe(1);
    expect(result.data.open).toBe(2);
    db.close();
  });

  it('refresh_rollup marks ready_for_review when all subtasks done', () => {
    const db = setupBoards();
    const childEngine = new TaskflowEngine(db, CHILD_BOARD);
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.1', action: 'conclude', sender_name: 'Worker' });
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.2', action: 'conclude', sender_name: 'Worker' });
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.3', action: 'conclude', sender_name: 'Worker' });
    const parentEngine = new TaskflowEngine(db, PARENT_BOARD);
    const result = parentEngine.hierarchy({ board_id: PARENT_BOARD, action: 'refresh_rollup', task_id: 'T1', sender_name: 'Manager' });
    expect(result.success).toBe(true);
    expect(result.rollup_status).toBe('ready_for_review');
    const t1 = db.prepare(`SELECT column, child_exec_rollup_status FROM tasks WHERE id = 'T1' AND board_id = '${PARENT_BOARD}'`).get() as any;
    expect(t1.column).toBe('review');
    expect(t1.child_exec_rollup_status).toBe('ready_for_review');
    db.close();
  });

  it('move() auto-triggers rollup when subtask of tagged project completes', () => {
    const db = setupBoards();
    const childEngine = new TaskflowEngine(db, CHILD_BOARD);
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.1', action: 'conclude', sender_name: 'Worker' });
    // Parent T1 should have auto-updated rollup
    const t1 = db.prepare(`SELECT child_exec_rollup_status, child_exec_last_rollup_summary FROM tasks WHERE id = 'T1' AND board_id = '${PARENT_BOARD}'`).get() as any;
    expect(t1.child_exec_rollup_status).toBe('active');
    expect(t1.child_exec_last_rollup_summary).toContain('1 concluído');
    db.close();
  });

  it('move() auto-triggers rollup when all subtasks of tagged project complete', () => {
    const db = setupBoards();
    const childEngine = new TaskflowEngine(db, CHILD_BOARD);
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.1', action: 'conclude', sender_name: 'Worker' });
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.2', action: 'conclude', sender_name: 'Worker' });
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.3', action: 'conclude', sender_name: 'Worker' });
    const t1 = db.prepare(`SELECT column, child_exec_rollup_status FROM tasks WHERE id = 'T1' AND board_id = '${PARENT_BOARD}'`).get() as any;
    expect(t1.child_exec_rollup_status).toBe('ready_for_review');
    expect(t1.column).toBe('review');
    db.close();
  });

  it('move() auto-triggers rollup when subtask moves to waiting', () => {
    const db = setupBoards();
    const childEngine = new TaskflowEngine(db, CHILD_BOARD);
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.1', action: 'start', sender_name: 'Worker' });
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'P1.1', action: 'wait', reason: 'Blocked on vendor', sender_name: 'Worker' });
    const t1 = db.prepare(`SELECT child_exec_rollup_status FROM tasks WHERE id = 'T1' AND board_id = '${PARENT_BOARD}'`).get() as any;
    expect(t1.child_exec_rollup_status).toBe('blocked');
    db.close();
  });

  it('does not double-rollup for directly delegated tasks', () => {
    const db = setupBoards();
    // Create a directly delegated task (no project intermediary)
    const now = new Date().toISOString();
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, linked_parent_board_id, linked_parent_task_id, child_exec_enabled, child_exec_board_id, requires_close_approval, created_at, updated_at) VALUES ('T2', '${CHILD_BOARD}', 'simple', 'Direct Task', 'worker1', 'next_action', '${PARENT_BOARD}', 'T1', 0, NULL, 0, '${now}', '${now}')`);
    const childEngine = new TaskflowEngine(db, CHILD_BOARD);
    // This should not crash or produce inconsistent state
    childEngine.move({ board_id: CHILD_BOARD, task_id: 'T2', action: 'conclude', sender_name: 'Worker' });
    const t1 = db.prepare(`SELECT child_exec_rollup_status FROM tasks WHERE id = 'T1' AND board_id = '${PARENT_BOARD}'`).get() as any;
    expect(t1.child_exec_rollup_status).toBeTruthy();
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t 'cross-board project rollup'`
Expected: 6 failures — rollup counting doesn't include subtasks, auto-trigger doesn't exist

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "test: add failing tests for cross-board project rollup"
```

---

### Task 2: Expand refresh_rollup to count subtasks of tagged projects

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`

- [ ] **Step 1: Modify the SQL in the refresh_rollup case**

Find the `refresh_rollup` case (around line 7347). The current SQL counts only tasks WHERE `linked_parent_board_id = ? AND linked_parent_task_id = ?`. Change it to also include subtasks of those tagged tasks.

Replace the counting query (the `SELECT COUNT(*)...FROM tasks WHERE board_id = ? AND linked_parent_board_id = ? AND linked_parent_task_id = ?`) with:

```sql
SELECT
  COUNT(*) AS total_count,
  SUM(CASE WHEN "column" != 'done' THEN 1 ELSE 0 END) AS open_count,
  SUM(CASE WHEN "column" = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
  SUM(CASE
    WHEN due_date IS NOT NULL AND due_date < ? AND "column" != 'done'
    THEN 1 ELSE 0 END) AS overdue_count,
  MAX(updated_at) AS latest_child_update_at
FROM tasks
WHERE board_id = ?
  AND (
    (linked_parent_board_id = ? AND linked_parent_task_id = ?)
    OR parent_task_id IN (
      SELECT id FROM tasks
      WHERE board_id = ? AND linked_parent_board_id = ? AND linked_parent_task_id = ?
    )
  )
```

The parameters become: `now.slice(0, 10), childBoardId, taskBoardId, task.id, childBoardId, taskBoardId, task.id`

**Note:** The archive/cancelled counting query CANNOT be expanded the same way — the `archive` table has no `parent_task_id` column. Cancelled subtasks of tagged projects won't be counted. Accept as known limitation — a proper fix would require an `archive` schema migration.

- [ ] **Step 2: Run tests**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t 'refresh_rollup counts subtasks'`
Expected: First 2 tests pass

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "fix(taskflow): refresh_rollup counts subtasks of tagged projects"
```

---

### Task 3: Extract rollup logic into a private helper

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`

- [ ] **Step 1: Extract the rollup logic into a private method**

Create a new private method `refreshLinkedParentRollup(taskBoardId, taskId, senderName)` that:
1. Finds the `linked_parent_task_id` for the given task (or its parent project's `linked_parent_task_id`)
2. If found, loads the parent task from the parent board
3. Runs the same rollup counting+updating logic currently in `refresh_rollup`
4. Returns void (fire-and-forget for auto-triggers)

The method should:
- Check the task's own `linked_parent_board_id`/`linked_parent_task_id`
- If not set, check its `parent_task_id` (is it a subtask?) and then check the parent's `linked_parent_board_id`/`linked_parent_task_id`
- If neither has a linked parent, return silently (no rollup needed)
- Load the parent task via **direct SQL** (`this.db.prepare('SELECT ... FROM tasks WHERE board_id = ? AND id = ?').get(parentBoardId, parentTaskId)`), NOT via `requireTask()` — this avoids depending on board-scoped visibility rules for a purely internal operation
- Run the rollup count+update using the parent task's `child_exec_board_id`

- [ ] **Step 2: Call the helper from hierarchy('refresh_rollup')**

In the `refresh_rollup` case, call the new helper instead of inlining the logic. The case body becomes a thin wrapper that validates permissions and delegates.

- [ ] **Step 3: Run tests**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t 'refresh_rollup'`
Expected: All refresh_rollup tests still pass (refactor, no behavior change)

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "refactor(taskflow): extract rollup logic into reusable helper"
```

---

### Task 4: Auto-trigger rollup from move()

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`

- [ ] **Step 1: Remove the inline rollup in move() and replace with helper**

Remove the existing inline rollup at lines 2772-2779 that hardcodes `child_exec_rollup_status = 'ready_for_review'` for directly-delegated tasks moved to done. Replace with the helper call. This unifies the rollup path — both directly-delegated tasks and project subtasks now use the same counting logic.

After the `parentNotification` block (around line 2780), add:

```typescript
// Auto-refresh upward rollup for tasks linked to a parent board
// (either directly via linked_parent_task_id, or via parent project's link)
this.refreshLinkedParentRollup(task, taskBoardId, params.sender_name ?? 'system');
```

- [ ] **Step 2: Add auto-rollup to cancel_task and restore_task in admin()**

In the `cancel_task` case (around line 6154), after `this.archiveTask(task, 'cancelled')` and before the notification block, add:

```typescript
this.refreshLinkedParentRollup(task, taskBoardId, params.sender_name);
```

In the `restore_task` case, after the task is restored to the `tasks` table, add the same call.

This ensures cancelled/restored subtasks also trigger parent rollup updates.

- [ ] **Step 3: Run tests**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t 'cross-board project rollup'`
Expected: All 6 tests pass

- [ ] **Step 4: Run full test suite for regressions**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: All 360+ tests pass

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat(taskflow): auto-trigger cross-board rollup on move, cancel, restore"
```

---

### Task 5: Update template and changelog

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- Modify: `.claude/skills/add-taskflow/CHANGELOG.md`
- Regenerate: `groups/*/CLAUDE.md`

- [ ] **Step 1: Update template**

Find the template instruction about converting delegated tasks to projects (the `tag_parent` instruction added earlier). Add after it:

```markdown
The parent board task's rollup status updates automatically when child board subtasks change status (conclude, wait, cancel, reopen). No manual `refresh_rollup` call is needed for project subtasks.
```

- [ ] **Step 2: Update changelog**

Add under the `2026-03-27` section:

```markdown
### Cross-Board Project Rollup
- `refresh_rollup` now counts subtasks of tagged projects, not just directly-tagged tasks
- Auto-triggers rollup when any task with an upward link (direct or via parent project) changes status
- Parent board sees real-time progress of child board project subtasks
```

- [ ] **Step 3: Regenerate and verify**

```bash
node scripts/generate-claude-md.mjs
npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t 'generated'
```

- [ ] **Step 4: Run full test suite, build, commit**

```bash
npx vitest run
npm run build
git add container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/ groups/
git commit -m "feat(taskflow): cross-board project rollup with auto-trigger"
```
