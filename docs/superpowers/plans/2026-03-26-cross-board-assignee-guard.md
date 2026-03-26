# Cross-Board Assignee Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent child board agents from changing parent board task assignees to people unknown to the parent board.

**Architecture:** Add a cross-board validation guard in `reassign()`, `update()` (assign_subtask, add_participant) that checks the target person exists on the task's owning board when the task belongs to a different board than `this.boardId`. Fix notification and WIP lookups for cross-board tasks. Clean up production data.

**Tech Stack:** TypeScript, better-sqlite3, vitest

---

### Task 1: Add cross-board guard to reassign() — single task path

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:2837-2861`
- Test: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add after the existing `'reassign delegated task from child board → relinks using parent board registrations'` test (around line 1926):

```typescript
    it('reassign delegated task to person not on parent board → error', () => {
      // Seed a parent board with a task delegated to this (child) board
      const { ownerBoardId, taskId } = seedLinkedTask(db, BOARD_ID, {
        taskId: 'T-920',
        assignee: 'person-1', // Alexandre on child board
      });

      // Add a person only on the child board (not on the parent board)
      db.exec(
        `INSERT INTO board_people VALUES ('${BOARD_ID}', 'person-ext', 'Reginaldo', '5585999990099', 'Analista', 3, NULL)`,
      );

      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: taskId,
        target_person: 'Reginaldo',
        sender_name: 'Alexandre',
        confirmed: true,
      });

      expect(r.success).toBe(false);
      expect(r.error).toContain('quadro superior');

      // Verify task was NOT modified
      const task = db
        .prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = ?`)
        .get(ownerBoardId, taskId) as any;
      expect(task.assignee).toBe('person-1');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "reassign delegated task to person not on parent board"`
Expected: FAIL — the reassignment currently succeeds

- [ ] **Step 3: Write minimal implementation**

In `container/agent-runner/src/taskflow-engine.ts`, in the `reassign()` method, add a cross-board guard after the task is fetched and validated (after line 2861 `tasksToReassign = [task];`). Insert before that line:

```typescript
        /* --- Cross-board guard: prevent assigning to person unknown to the task's board --- */
        const owningBoard = this.taskBoardId(task);
        if (owningBoard !== this.boardId) {
          const targetOnOwningBoard = this.resolvePerson(targetPerson.person_id, owningBoard);
          if (!targetOnOwningBoard) {
            return {
              success: false,
              error: `"${targetPerson.name}" não está cadastrado(a) no quadro superior. A tarefa pertence ao quadro ${owningBoard} e só pode ser atribuída a membros desse quadro.`,
            };
          }
        }

```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "reassign delegated task to person not on parent board"`
Expected: PASS

- [ ] **Step 5: Fix existing test that the guard breaks**

The existing test `'reassign delegated task from child board → relinks using parent board registrations'` (around line 1892) will now fail because Giovanni (person-2) is not in the parent board's `board_people`. Add Giovanni to the parent board's `board_people` in that test.

Find in the test (after `seedLinkedTask` and before the `engine.reassign` call):
```typescript
      // Also register person-2 on the parent board so resolvePerson works
      // (person-2 already exists on BOARD_ID from seedTestDb)
```

Replace with:
```typescript
      // Register person-2 on the parent board so cross-board guard passes
      db.exec(
        `INSERT INTO board_people VALUES ('${ownerBoardId}', 'person-2', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`,
      );
```

- [ ] **Step 6: Run all reassign tests to verify no regressions**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "reassign"`
Expected: All reassign tests pass

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "fix(taskflow): block cross-board reassign to person not on parent board"
```

---

### Task 2 (skipped): Bulk transfer path — NOT affected

The bulk transfer path in `reassign()` queries `WHERE board_id = ? AND assignee = ?` using `this.boardId` (line 2886-2890). It does NOT use `visibleTaskScope()`, so parent-board tasks are never included. No code change needed.

---

### Task 3: Add cross-board guard to update() assign_subtask

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:3931-3961`
- Test: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add in the `update` describe block (find the existing `assign_subtask` tests):

```typescript
    it('assign_subtask on delegated project to person not on parent board → error', () => {
      const now = new Date().toISOString();
      // Seed a parent board
      const parentBoardId = 'board-parent-sub';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'parent@g.us', 'parent-group', 'standard', 0, 1, NULL, NULL)`,
      );
      // Seed a project on the parent board, delegated to child board
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
         VALUES ('P-100', '${parentBoardId}', 'project', 'Parent project', 'person-1', 'in_progress', 1, 1, '${BOARD_ID}', 'person-1', '${now}', '${now}')`,
      );
      // Seed a subtask on the parent board
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, created_at, updated_at)
         VALUES ('P-100.1', '${parentBoardId}', 'simple', 'Sub task', 'person-1', 'next_action', 'P-100', 0, '${now}', '${now}')`,
      );
      // Add person only on child board
      db.exec(
        `INSERT INTO board_people VALUES ('${BOARD_ID}', 'person-ext', 'Reginaldo', '5585999990099', 'Analista', 3, NULL)`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'P-100',
        sender_name: 'Alexandre',
        updates: {
          assign_subtask: { id: 'P-100.1', assignee: 'Reginaldo' },
        },
      });

      expect(r.success).toBe(false);
      expect(r.error).toContain('quadro superior');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "assign_subtask on delegated project to person not on parent board"`
Expected: FAIL — currently allows the assignment

- [ ] **Step 3: Write minimal implementation**

In `container/agent-runner/src/taskflow-engine.ts`, in the `assign_subtask` handler (around line 3935), add a guard after `resolvePerson`:

Find:
```typescript
        const subPerson = this.resolvePerson(updates.assign_subtask.assignee);
        if (!subPerson) return this.buildOfferRegisterError(updates.assign_subtask.assignee);
```

Add after those lines:
```typescript
        /* Cross-board guard */
        if (taskBoardId !== this.boardId) {
          const personOnOwningBoard = this.resolvePerson(subPerson.person_id, taskBoardId);
          if (!personOnOwningBoard) {
            return {
              success: false,
              error: `"${subPerson.name}" não está cadastrado(a) no quadro superior (${taskBoardId}). Subtarefas de projetos do quadro superior só podem ser atribuídas a membros desse quadro.`,
            };
          }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "assign_subtask on delegated project to person not on parent board"`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "assign_subtask"`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "fix(taskflow): block cross-board assign_subtask to person not on parent board"
```

---

### Task 4: Add cross-board guard to update() add_participant

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:3527-3553`
- Test: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add in the `update` describe block:

```typescript
    it('add_participant on delegated meeting to person not on parent board → error', () => {
      const now = new Date().toISOString();
      const parentBoardId = 'board-parent-mtg';
      db.exec(
        `INSERT INTO boards VALUES ('${parentBoardId}', 'parent@g.us', 'parent-group-mtg', 'standard', 0, 1, NULL, NULL)`,
      );
      // Meeting on parent board, delegated to child board
      db.exec(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, child_exec_enabled, child_exec_board_id, child_exec_person_id, participants, created_at, updated_at)
         VALUES ('M-100', '${parentBoardId}', 'meeting', 'Team sync', 'person-1', 'next_action', 1, 1, '${BOARD_ID}', 'person-1', '[]', '${now}', '${now}')`,
      );
      // Person only on child board
      db.exec(
        `INSERT OR IGNORE INTO board_people VALUES ('${BOARD_ID}', 'person-ext', 'Reginaldo', '5585999990099', 'Analista', 3, NULL)`,
      );

      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'M-100',
        sender_name: 'Alexandre',
        updates: {
          add_participant: 'Reginaldo',
        },
      });

      expect(r.success).toBe(false);
      expect(r.error).toContain('quadro superior');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "add_participant on delegated meeting to person not on parent board"`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

In `container/agent-runner/src/taskflow-engine.ts`, in the `add_participant` handler (around line 3531), add a guard after `resolvePerson`:

Find:
```typescript
        const person = this.resolvePerson(updates.add_participant);
        if (!person) return this.buildOfferRegisterError(updates.add_participant);
```

Add after those lines:
```typescript
        /* Cross-board guard */
        if (taskBoardId !== this.boardId) {
          const personOnOwningBoard = this.resolvePerson(person.person_id, taskBoardId);
          if (!personOnOwningBoard) {
            return {
              success: false,
              error: `"${person.name}" não está cadastrado(a) no quadro superior (${taskBoardId}). Participantes de reuniões do quadro superior devem ser membros desse quadro.`,
            };
          }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "add_participant on delegated meeting to person not on parent board"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "fix(taskflow): block cross-board add_participant to person not on parent board"
```

---

### Task 5: Verify cross-board reassign still works when target IS on parent board

**Files:**
- Test: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Write the positive test**

This ensures the existing `'reassign delegated task from child board → relinks'` still works and that the guard does NOT block legitimate cross-board reassignments where the target person is on both boards:

```typescript
    it('reassign delegated task to person on both child and parent board → succeeds', () => {
      const { ownerBoardId, taskId } = seedLinkedTask(db, BOARD_ID, {
        taskId: 'T-940',
        assignee: 'person-1',
      });

      // person-2 (Giovanni) is on the child board (from seedTestDb)
      // Also add person-2 on the parent board
      db.exec(
        `INSERT INTO board_people VALUES ('${ownerBoardId}', 'person-2', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`,
      );

      const r = engine.reassign({
        board_id: BOARD_ID,
        task_id: taskId,
        target_person: 'Giovanni',
        sender_name: 'Alexandre',
        confirmed: true,
      });

      expect(r.success).toBe(true);
      const task = db
        .prepare(`SELECT assignee FROM tasks WHERE board_id = ? AND id = ?`)
        .get(ownerBoardId, taskId) as any;
      expect(task.assignee).toBe('person-2');
    });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts -t "reassign delegated task to person on both child and parent board"`
Expected: PASS

- [ ] **Step 3: Run ALL tests to verify no regressions**

Run: `cd container/agent-runner && npx vitest run --reporter=verbose src/taskflow-engine.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.test.ts
git commit -m "test(taskflow): positive test for legitimate cross-board reassignment"
```

---

### Task 6: Production data cleanup

**Files:**
- No code files — SQL commands on production database

- [ ] **Step 1: Verify current broken state on production**

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db \"
  SELECT 'board_people:' AS label, person_id, name FROM board_people WHERE board_id = 'board-sec-taskflow' AND person_id IN ('mauro', 'reginaldo-graca');
  SELECT 'tasks:' AS label, id, assignee FROM tasks WHERE board_id = 'board-sec-taskflow' AND assignee IN ('mauro', 'reginaldo-graca');
\""
```

- [ ] **Step 2: Revert task assignees to original owners**

Based on task_history, T79 was originally rafael's and P24/P24.1/P24.2 were giovanni's:

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db \"
  UPDATE tasks SET assignee = 'rafael', updated_at = datetime('now') WHERE board_id = 'board-sec-taskflow' AND id = 'T79' AND assignee = 'reginaldo-graca';
  UPDATE tasks SET assignee = 'giovanni', updated_at = datetime('now') WHERE board_id = 'board-sec-taskflow' AND id IN ('P24', 'P24.1', 'P24.2') AND assignee = 'mauro';
\""
```

- [ ] **Step 3: Remove external people from SEC board_people**

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db \"
  DELETE FROM board_people WHERE board_id = 'board-sec-taskflow' AND person_id IN ('mauro', 'reginaldo-graca');
\""
```

- [ ] **Step 4: Also remove lucas from SEC board_people if external**

Check if lucas is supposed to be on SEC:

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db \"
  SELECT board_id, person_id, name FROM board_people WHERE person_id = 'lucas' ORDER BY board_id;
\""
```

If lucas is only relevant on a child board, remove from SEC too. Otherwise leave.

- [ ] **Step 5: Verify cleanup**

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db \"
  SELECT person_id, name FROM board_people WHERE board_id = 'board-sec-taskflow' ORDER BY name;
  SELECT id, assignee FROM tasks WHERE board_id = 'board-sec-taskflow' AND id IN ('T79', 'P24', 'P24.1', 'P24.2');
\""
```

Expected: No mauro/reginaldo-graca in board_people. Tasks assigned back to rafael/giovanni.

---

### Task 7: Build and deploy

**Files:**
- No code changes — build and deploy steps

- [ ] **Step 1: Build the container**

```bash
cd /root/nanoclaw && ./container/build.sh
```

- [ ] **Step 2: Sync to production**

```bash
rsync -avz --delete /root/nanoclaw/dist/ nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/dist/
```

- [ ] **Step 3: Restart production service**

```bash
ssh nanoclaw@192.168.2.63 "systemctl --user restart nanoclaw"
```

- [ ] **Step 4: Verify service is running**

```bash
ssh nanoclaw@192.168.2.63 "systemctl --user status nanoclaw | head -5"
```
