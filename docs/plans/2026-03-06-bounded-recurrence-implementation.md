# Bounded Recurrence Implementation Plan

> Execute this plan task-by-task. Do not skip verification after each implementation step.

**Goal:** Add `max_cycles` and `recurrence_end_date` bounds to recurring tasks (including recurring projects) so they expire after a fixed period.

**Architecture:** Two nullable, mutually exclusive columns on `tasks` table. `advanceRecurringTask()` checks whichever bound is set before resetting. On expiry, task stays in `done` and the agent notifies the user with renew/extend/archive options. This applies to all tasks with `recurrence`, including recurring projects. This is a **skill feature** — all changes propagate to the relevant skill `add/` and `modify/` copies.

**Tech Stack:** TypeScript, better-sqlite3, Zod (MCP schemas), Vitest (tests)

**Key constraint:** Bounds are **mutually exclusive** (`max_cycles` XOR `recurrence_end_date`). Setting one clears the other. Reject creates or updates that try to set both at once.

---

### Task 1: Add columns to schema files

**Files:**
- Modify: `src/taskflow-db.ts:92-93` (after `current_cycle TEXT` in TASKFLOW_SCHEMA)
- Modify: `.claude/skills/add-taskflow/modify/src/taskflow-db.ts:92-93` (skill modify copy)
- Modify: `container/agent-runner/src/taskflow-engine.test.ts:14` (test CREATE TABLE)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts:14` (skill add copy)

**Step 1: Add columns to `src/taskflow-db.ts`**

In the tasks CREATE TABLE (TASKFLOW_SCHEMA), after `current_cycle TEXT,` add:

```typescript
  max_cycles INTEGER,
  recurrence_end_date TEXT,
```

**Step 2: Add idempotent migration in `initTaskflowDb()`**

In `src/taskflow-db.ts`, after the CREATE TABLE executions, add idempotent ALTER TABLE migrations for existing databases:

```typescript
// Migration: bounded recurrence columns
try { db.exec('ALTER TABLE tasks ADD COLUMN max_cycles INTEGER'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN recurrence_end_date TEXT'); } catch {}
```

**Step 3: Add columns to test schema**

In `container/agent-runner/src/taskflow-engine.test.ts` line 14, in the tasks CREATE TABLE string, after `current_cycle TEXT,` add `max_cycles INTEGER, recurrence_end_date TEXT,` (before `PRIMARY KEY`).

**Step 4: Sync skill copies**

- Copy the same schema change to `.claude/skills/add-taskflow/modify/src/taskflow-db.ts`
- Copy the same test schema change to `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts`

**Step 5: Build and verify**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean compile

**Step 6: Commit**

```bash
git add src/taskflow-db.ts .claude/skills/add-taskflow/modify/src/taskflow-db.ts container/agent-runner/src/taskflow-engine.test.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts
git commit -m "feat: add max_cycles and recurrence_end_date columns to tasks schema"
```

---

### Task 2: Extend engine types

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:33-45` (CreateParams)
- Modify: `container/agent-runner/src/taskflow-engine.ts:76` (MoveResult.recurring_cycle)
- Modify: `container/agent-runner/src/taskflow-engine.ts:103-125` (UpdateParams.updates)

**Step 1: Add fields to `CreateParams`**

After `recurrence_anchor?: string;` (line 43), add:

```typescript
max_cycles?: number;
recurrence_end_date?: string;
```

**Step 2: Extend `MoveResult.recurring_cycle`**

Change line 76 from:
```typescript
recurring_cycle?: { new_due_date: string; cycle_number: number };
```
to:
```typescript
recurring_cycle?: { cycle_number: number; expired: boolean; new_due_date?: string; reason?: 'max_cycles' | 'end_date' };
```

Note: `expired` is now a required boolean (always returned). `new_due_date` is optional (only present when not expired).

**Step 3: Add fields to `UpdateParams.updates`**

After `recurrence?: string;` (line 123), add:

```typescript
max_cycles?: number | null;            // null = remove bound
recurrence_end_date?: string | null;   // null = remove bound
```

**Step 4: Compile check**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean compile

**Step 5: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat: add bounded recurrence types to CreateParams, MoveResult, UpdateParams"
```

---

### Task 3: Store bounds on INSERT + validate exclusivity

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:852-879` (create handler INSERT)

**Step 1: Add bounded recurrence validation**

Before the undo snapshot (around line 845, before `const lastMutation`), add:

```typescript
/* --- Validate bounded recurrence params --- */
if (params.max_cycles != null && params.recurrence_end_date != null) {
  return { success: false, error: 'Cannot set both max_cycles and recurrence_end_date. Choose one bound.' };
}
if ((params.max_cycles != null || params.recurrence_end_date != null) && !recurrence) {
  return { success: false, error: 'Bounded recurrence requires a recurring task or recurring project.' };
}
if (params.max_cycles != null && (!Number.isInteger(params.max_cycles) || params.max_cycles <= 0)) {
  return { success: false, error: 'max_cycles must be a positive integer.' };
}
```

**Step 2: Add columns to INSERT statement**

Change the INSERT at line 852 to include `max_cycles` and `recurrence_end_date`:

```typescript
this.db
  .prepare(
    `INSERT INTO tasks (
      id, board_id, type, title, assignee, column,
      priority, due_date, labels, recurrence,
      max_cycles, recurrence_end_date,
      child_exec_enabled, child_exec_board_id, child_exec_person_id,
      _last_mutation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    taskId,
    this.boardId,
    storedType,
    params.title,
    assigneePersonId,
    column,
    params.priority ?? null,
    dueDate,
    params.labels ? JSON.stringify(params.labels) : '[]',
    recurrence,
    params.max_cycles ?? null,
    params.recurrence_end_date ?? null,
    childExecEnabled,
    childExecBoardId,
    childExecPersonId,
    lastMutation,
    now,
    now,
  );
```

**Step 3: Compile check**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean compile

**Step 4: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat: store max_cycles and recurrence_end_date on task creation with exclusivity validation"
```

---

### Task 4: Add expiry check to `advanceRecurringTask()`

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:1047-1075` (advanceRecurringTask)

**Step 1: Change return type and add expiry logic**

Replace the entire `advanceRecurringTask` method. Key changes: return type uses required `expired: boolean`, optional `new_due_date` and `reason`. Applies to both recurring tasks and recurring projects (any task with `recurrence` set).

```typescript
/** Advance a recurring task: calculate next due_date and increment cycle. */
private advanceRecurringTask(task: any): { cycle_number: number; expired: boolean; new_due_date?: string; reason?: 'max_cycles' | 'end_date' } {
  const recurrence = task.recurrence as 'daily' | 'weekly' | 'monthly' | 'yearly';
  const anchor = task.due_date ? new Date(task.due_date) : new Date();
  const currentCycle = parseInt(task.current_cycle ?? '0', 10);
  const nextCycle = currentCycle + 1;

  const newDueDate = advanceDateByRecurrence(anchor, recurrence);

  // Check expiry bounds (mutually exclusive, but check both defensively)
  let expiryReason: 'max_cycles' | 'end_date' | null = null;
  if (task.max_cycles != null && nextCycle >= task.max_cycles) {
    expiryReason = 'max_cycles';
  } else if (task.recurrence_end_date && newDueDate > task.recurrence_end_date) {
    expiryReason = 'end_date';
  }

  const now = new Date().toISOString();

  if (expiryReason) {
    // Leave task in 'done' — just update cycle number
    this.db
      .prepare(
        `UPDATE tasks SET current_cycle = ?, updated_at = ?
         WHERE board_id = ? AND id = ?`,
      )
      .run(String(nextCycle), now, this.taskBoardId(task), task.id);
    return { cycle_number: nextCycle, expired: true, reason: expiryReason };
  }

  // Normal advance: reset to next_action
  this.db
    .prepare(
      `UPDATE tasks SET column = 'next_action', due_date = ?, current_cycle = ?, reminders = '[]',
       notes = '[]', next_note_id = 1, blocked_by = '[]', next_action = NULL, waiting_for = NULL, updated_at = ?
       WHERE board_id = ? AND id = ?`,
    )
    .run(newDueDate, String(nextCycle), now, this.taskBoardId(task), task.id);

  /* Reset subtask rows for recurring projects */
  if (task.type === 'project') {
    this.db
      .prepare(
        `UPDATE tasks SET column = 'next_action', updated_at = ?
         WHERE board_id = ? AND parent_task_id = ? AND column = 'done'`,
      )
      .run(now, this.taskBoardId(task), task.id);
  }

  return { cycle_number: nextCycle, expired: false, new_due_date: newDueDate };
}
```

**Step 2: Compile check**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean compile

**Step 3: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat: add expiry check to advanceRecurringTask for bounded recurrence"
```

---

### Task 5: Handle expiry in move completion

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:1307-1317` (move method, done side-effects)

**Step 1: Verify type propagation**

At line 1308, `recurringCycle` is typed as `MoveResult['recurring_cycle']`, which we extended in Task 2. The existing code at lines 1314-1316:

```typescript
if (task.recurrence) {
  recurringCycle = this.advanceRecurringTask(task);
}
```

This already works — `advanceRecurringTask` now returns the new shape with `expired`, `reason`, and optional `new_due_date`. The return propagates through the MoveResult automatically.

**No code change needed** — verify with compile check only.

**Step 2: Compile check**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean compile

---

### Task 6: Add update handler for bounds with exclusivity enforcement

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:1906-1915` (update method, after recurrence handler)
- Modify: `container/agent-runner/src/taskflow-engine.ts:1669-1687` (update undo snapshot)

**Step 1: Add bounds to undo snapshot**

In the update undo snapshot (line 1674), add `max_cycles` and `recurrence_end_date` to the snapshot object:

```typescript
snapshot: {
  title: task.title,
  priority: task.priority,
  due_date: task.due_date,
  description: task.description,
  next_action: task.next_action,
  labels: task.labels,
  notes: task.notes,
  next_note_id: task.next_note_id,
  subtasks: task.subtasks,
  recurrence: task.recurrence,
  max_cycles: task.max_cycles,
  recurrence_end_date: task.recurrence_end_date,
  updated_at: task.updated_at,
},
```

**Step 2: Add exclusivity rejection**

Before the existing update field processing (around line 1689, after snapshot), add:

```typescript
/* Reject setting both bounds in one call */
if (updates.max_cycles !== undefined && updates.max_cycles !== null &&
    updates.recurrence_end_date !== undefined && updates.recurrence_end_date !== null) {
  return { success: false, error: 'Cannot set both max_cycles and recurrence_end_date. Choose one bound.' };
}
if (updates.max_cycles !== undefined && updates.max_cycles !== null &&
    (!Number.isInteger(updates.max_cycles) || updates.max_cycles <= 0)) {
  return { success: false, error: 'max_cycles must be a positive integer.' };
}
```

**Step 3: Fix existing recurrence type check (pre-existing bug)**

At line 1908, the current code blocks recurring projects from changing recurrence:

```typescript
// BEFORE (line 1908):
if (task.type !== 'recurring') {
// AFTER:
if (!task.recurrence) {
```

This is a pre-existing bug — recurring projects have `task.type === 'project'` with `task.recurrence` set, so the type-based check incorrectly rejects them.

**Step 4: Add bound update handlers**

After the recurrence update block (after line 1915), add:

```typescript
/* max_cycles (recurring only — setting clears recurrence_end_date) */
if (updates.max_cycles !== undefined) {
  if (!task.recurrence) {
    return { success: false, error: 'max_cycles can only be set on tasks with recurrence.' };
  }
  this.db
    .prepare(`UPDATE tasks SET max_cycles = ?, recurrence_end_date = NULL WHERE board_id = ? AND id = ?`)
    .run(updates.max_cycles, taskBoardId, task.id);
  changes.push(updates.max_cycles === null ? 'Removed max_cycles bound' : `max_cycles set to ${updates.max_cycles}`);
}

/* recurrence_end_date (recurring only — setting clears max_cycles) */
if (updates.recurrence_end_date !== undefined) {
  if (!task.recurrence) {
    return { success: false, error: 'recurrence_end_date can only be set on tasks with recurrence.' };
  }
  this.db
    .prepare(`UPDATE tasks SET recurrence_end_date = ?, max_cycles = NULL WHERE board_id = ? AND id = ?`)
    .run(updates.recurrence_end_date, taskBoardId, task.id);
  changes.push(updates.recurrence_end_date === null ? 'Removed recurrence_end_date bound' : `recurrence_end_date set to ${updates.recurrence_end_date}`);
}
```

Note: Setting `max_cycles` clears `recurrence_end_date` and vice versa, enforcing exclusivity. Setting either to `null` clears the bound without setting the other.

**Step 5: Compile check**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean compile

**Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat: add update handlers for max_cycles and recurrence_end_date with exclusivity"
```

---

### Task 7: Update `restore_task` column list

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:3091-3135` (restore_task INSERT in admin handler)

**Step 1: Add columns to restore INSERT**

In the `restore_task` case (line 3093), add `max_cycles` and `recurrence_end_date` to the INSERT column list and values:

After line 3101 (`subtasks, recurrence, current_cycle`), add:
```
                max_cycles, recurrence_end_date
```

After line 3134 (`snapshot.current_cycle ?? null,`), add:
```typescript
              snapshot.max_cycles ?? null,
              snapshot.recurrence_end_date ?? null,
```

Update the VALUES placeholder count to match (add 2 more `?`).

**Step 2: Compile check**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean compile

**Step 3: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat: include bounded recurrence fields in restore_task"
```

---

### Task 8: Update MCP tool schemas

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:539-563` (taskflow_create schema)
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:604-635` (taskflow_update schema)

**Step 1: Add params to `taskflow_create`**

After `recurrence_anchor` (line 553), add:

```typescript
max_cycles: z.number().int().positive().optional().describe('Maximum number of cycles before expiry (mutually exclusive with recurrence_end_date)'),
recurrence_end_date: z.string().optional().describe('ISO date after which recurrence stops (mutually exclusive with max_cycles)'),
```

**Step 2: Add params to `taskflow_update` updates object**

After `recurrence` (line 625), add:

```typescript
max_cycles: z.number().int().positive().nullable().optional().describe('Maximum cycles (null to remove; setting clears recurrence_end_date)'),
recurrence_end_date: z.string().nullable().optional().describe('End date for recurrence (null to remove; setting clears max_cycles)'),
```

**Step 3: Compile check**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Clean compile

**Step 4: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: add max_cycles and recurrence_end_date to MCP tool schemas"
```

---

### Task 9: Update CLAUDE.md templates

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template.v1` (keep rollback template aligned)

**Step 1: Add bounded recurrence creation commands**

At line 120 (after the recurring task creation command), add new rows:

```
| "semanal por 6 semanas para Y: X" | `taskflow_create({ type: 'recurring', title: 'X', assignee: 'Y', recurrence: 'weekly', max_cycles: 6, sender_name: SENDER })` |
| "mensal ate 30/06 para Y: X" | `taskflow_create({ type: 'recurring', title: 'X', assignee: 'Y', recurrence: 'monthly', recurrence_end_date: '2026-06-30', sender_name: SENDER })` |
| "projeto recorrente para Y: X. Etapas: 1. A, 2. B por 6 semanas" | `taskflow_create({ type: 'project', title: 'X', assignee: 'Y', subtasks: ['A', 'B'], recurrence: 'weekly', max_cycles: 6, sender_name: SENDER })` |
| "mensal por 3 meses ate 30/06 para Y: X" | Bounds are mutually exclusive. Ask user to choose: max_cycles OR recurrence_end_date |
```

**Step 2: Add bound update commands**

Near line 166 (after the recurrence change command), add:

```
| "estender RXXX/PXXX por mais N ciclos" | `taskflow_update({ task_id: TARGET_ID, updates: { max_cycles: CURRENT_CYCLE + N }, sender_name: SENDER })` -- agent reads current_cycle first |
| "estender RXXX/PXXX ate DD/MM" | `taskflow_update({ task_id: TARGET_ID, updates: { recurrence_end_date: 'YYYY-MM-DD' }, sender_name: SENDER })` |
| "remover limite de RXXX/PXXX" | `taskflow_update({ task_id: TARGET_ID, updates: { max_cycles: null }, sender_name: SENDER })` or `{ recurrence_end_date: null }` |
```

**Step 3: Add expiry handling to tool response section**

Near line 261 (where `recurring_cycle` handling is documented), update to:

```
- `recurring_cycle` -> Show cycle info. Check `expired` field:
  - `expired: false` -> normal cycle, show: "Ciclo N concluido. Proximo ciclo: DUE_DATE"
  - `expired: true` -> recurrence ended. Show:
    "✅ RXXX concluida (ciclo final: N)

    Recorrencia encerrada. Deseja:
    1. Renovar por mais N ciclos
    2. Estender ate uma nova data
    3. Arquivar"
```

Do not require `N/M` in the expiry message: `recurring_cycle` does not include `max_cycles`, so `ciclo final: N` is the safe default for both `max_cycles` and `end_date` expiry reasons.

**Step 4: Add exclusivity note near the recurrence command/update guidance**

Add a short note near the recurring create/update command mappings:

```
- `max_cycles` and `recurrence_end_date` are **mutually exclusive** -- only one can be set. Setting one via update clears the other automatically. If user asks for both, ask them to choose one.
```

**Step 5: Add schema fields to reference**

Near line 397, in the tasks schema reference, after `current_cycle (JSON)` add:

```
, max_cycles (INTEGER, nullable), recurrence_end_date (TEXT, nullable)
```

**Step 6: Apply same changes to `.claude/skills/add-taskflow/templates/CLAUDE.md.template.v1`**

Mirror all 5 changes above.

**Step 7: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template .claude/skills/add-taskflow/templates/CLAUDE.md.template.v1
git commit -m "feat: add bounded recurrence commands and expiry handling to CLAUDE.md templates"
```

---

### Task 10: Sync touched skill copies

**Files:**
- `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (from engine)
- `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts` (from MCP schemas)
- `.claude/skills/add-taskflow/add/container/agent-runner/src/ipc-mcp-stdio.ts` (from MCP schemas)
- `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts` (from engine tests, if changed)

There is no `.claude/skills/add-taskflow/modify/container/agent-runner/src/taskflow-engine.ts` in this repo, so do not add a sync step for a non-existent modify-engine copy.

**Step 1: Copy engine to skill add directory**

```bash
cp container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
```

**Step 2: Copy MCP schema to skill modify directory**

```bash
cp container/agent-runner/src/ipc-mcp-stdio.ts .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts
```

**Step 3: Copy MCP schema to skill add directory**

```bash
cp container/agent-runner/src/ipc-mcp-stdio.ts .claude/skills/add-taskflow/add/container/agent-runner/src/ipc-mcp-stdio.ts
```

**Step 4: Copy engine tests to skill add directory (if engine tests changed)**

```bash
cp container/agent-runner/src/taskflow-engine.test.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts
```

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/ .claude/skills/add-taskflow/modify/
git commit -m "chore: sync skill add/ and modify/ copies with bounded recurrence changes"
```

---

### Task 11: Add skill package test expectations

**Files:**
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Add test for bounded recurrence commands in template**

```typescript
it('CLAUDE.md.template has bounded recurrence commands', () => {
  const content = fs.readFileSync(
    path.join(skillDir, 'templates', 'CLAUDE.md.template'),
    'utf-8',
  );
  expect(content).toContain('max_cycles');
  expect(content).toContain('recurrence_end_date');
  expect(content).toContain('ciclo final');
  expect(content).toContain('Recorrencia encerrada');
});
```

**Step 2: Add test for exclusivity documentation**

```typescript
it('CLAUDE.md.template documents bounded recurrence exclusivity', () => {
  const content = fs.readFileSync(
    path.join(skillDir, 'templates', 'CLAUDE.md.template'),
    'utf-8',
  );
  expect(content).toContain('mutually exclusive');
});
```

**Step 3: Add test for schema columns in test fixture**

```typescript
it('test schema includes bounded recurrence columns', () => {
  const content = fs.readFileSync(
    path.join(skillDir, 'add', 'container', 'agent-runner', 'src', 'taskflow-engine.test.ts'),
    'utf-8',
  );
  expect(content).toContain('max_cycles INTEGER');
  expect(content).toContain('recurrence_end_date TEXT');
});
```

**Step 4: Run skill tests**

Run: `cd .claude/skills/add-taskflow && npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "test: add bounded recurrence skill package test expectations"
```

---

### Task 12: Add engine unit tests

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

Use the real test fixture in this file:
- Board constant is `BOARD_ID`, not `boardId`
- Seeded users are `Alexandre` (manager) and `Giovanni`
- Assigned task creation must be done by `Alexandre` because create enforces manager-only assignment
- Prefer verifying persisted DB state with `engine.getTask(taskId)` instead of calling a non-existent query shape

**Step 1: Add test for bounded recurrence creation with max_cycles**

```typescript
it('creates recurring task with max_cycles', () => {
  const result = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Weekly standup',
    assignee: 'Giovanni',
    recurrence: 'weekly',
    max_cycles: 6,
    sender_name: 'Alexandre',
  });
  expect(result.success).toBe(true);
  expect(result.task_id).toMatch(/^R/);
  const task = engine.getTask(result.task_id!);
  expect(task.max_cycles).toBe(6);
  expect(task.recurrence_end_date).toBeNull();
});
```

**Step 2: Add test for creation with recurrence_end_date**

```typescript
it('creates recurring task with recurrence_end_date', () => {
  const result = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Monthly review',
    assignee: 'Giovanni',
    recurrence: 'monthly',
    recurrence_end_date: '2026-12-31',
    sender_name: 'Alexandre',
  });
  expect(result.success).toBe(true);
  expect(result.task_id).toMatch(/^R/);
  const task = engine.getTask(result.task_id!);
  expect(task.max_cycles).toBeNull();
  expect(task.recurrence_end_date).toBe('2026-12-31');
});
```

**Step 3: Add test for exclusivity rejection on create**

```typescript
it('rejects creation with both max_cycles and recurrence_end_date', () => {
  const result = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Both bounds',
    assignee: 'Giovanni',
    recurrence: 'weekly',
    max_cycles: 6,
    recurrence_end_date: '2026-12-31',
    sender_name: 'Alexandre',
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Cannot set both');
});
```

**Step 4: Add test for rejecting bounds on non-recurring create**

```typescript
it('rejects bounded recurrence on non-recurring task creation', () => {
  const result = engine.create({
    board_id: BOARD_ID,
    type: 'simple',
    title: 'Not recurring',
    assignee: 'Giovanni',
    max_cycles: 3,
    sender_name: 'Alexandre',
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('requires a recurring task');
});
```

**Step 5: Add test for expiry on max_cycles**

```typescript
it('expires recurring task when max_cycles reached', () => {
  const createResult = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Bounded task',
    assignee: 'Giovanni',
    recurrence: 'daily',
    max_cycles: 1,
    sender_name: 'Alexandre',
  });
  expect(createResult.success).toBe(true);
  const taskId = createResult.task_id!;

  engine.move({ board_id: BOARD_ID, task_id: taskId, action: 'start', sender_name: 'Giovanni' });
  const result = engine.move({ board_id: BOARD_ID, task_id: taskId, action: 'conclude', sender_name: 'Giovanni' });
  expect(result.success).toBe(true);
  expect(result.recurring_cycle?.expired).toBe(true);
  expect(result.recurring_cycle?.reason).toBe('max_cycles');
  expect(result.recurring_cycle?.new_due_date).toBeUndefined();
  const task = engine.getTask(taskId);
  expect(task.column).toBe('done');
  expect(task.current_cycle).toBe('1');
});
```

**Step 6: Add test for expiry on end_date**

```typescript
it('expires recurring task when recurrence_end_date passed', () => {
  const createResult = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Bounded by date',
    assignee: 'Giovanni',
    recurrence: 'monthly',
    recurrence_end_date: '2020-01-01', // already in the past
    sender_name: 'Alexandre',
  });
  expect(createResult.success).toBe(true);
  const taskId = createResult.task_id!;

  engine.move({ board_id: BOARD_ID, task_id: taskId, action: 'start', sender_name: 'Giovanni' });
  const result = engine.move({ board_id: BOARD_ID, task_id: taskId, action: 'conclude', sender_name: 'Giovanni' });
  expect(result.success).toBe(true);
  expect(result.recurring_cycle?.expired).toBe(true);
  expect(result.recurring_cycle?.reason).toBe('end_date');
  const task = engine.getTask(taskId);
  expect(task.column).toBe('done');
});
```

**Step 7: Add test for normal advance (no bounds)**

```typescript
it('advances recurring task normally when no bounds set', () => {
  const createResult = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Unbounded',
    assignee: 'Giovanni',
    recurrence: 'daily',
    sender_name: 'Alexandre',
  });
  const taskId = createResult.task_id!;

  engine.move({ board_id: BOARD_ID, task_id: taskId, action: 'start', sender_name: 'Giovanni' });
  const result = engine.move({ board_id: BOARD_ID, task_id: taskId, action: 'conclude', sender_name: 'Giovanni' });
  expect(result.success).toBe(true);
  expect(result.recurring_cycle?.expired).toBe(false);
  expect(result.recurring_cycle?.new_due_date).toBeDefined();
});
```

**Step 8: Add test for updating max_cycles**

```typescript
it('updates max_cycles on recurring task', () => {
  const createResult = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Updatable',
    assignee: 'Giovanni',
    recurrence: 'weekly',
    sender_name: 'Alexandre',
  });
  const taskId = createResult.task_id!;

  const result = engine.update({
    board_id: BOARD_ID,
    task_id: taskId,
    sender_name: 'Giovanni',
    updates: { max_cycles: 12 },
  });
  expect(result.success).toBe(true);
  expect(result.changes).toContain('max_cycles set to 12');
  const task = engine.getTask(taskId);
  expect(task.max_cycles).toBe(12);
  expect(task.recurrence_end_date).toBeNull();
});
```

**Step 9: Add test for exclusivity on update (setting one clears the other)**

```typescript
it('setting recurrence_end_date clears max_cycles', () => {
  const createResult = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Swap bounds',
    assignee: 'Giovanni',
    recurrence: 'weekly',
    max_cycles: 10,
    sender_name: 'Alexandre',
  });
  const taskId = createResult.task_id!;

  const result = engine.update({
    board_id: BOARD_ID,
    task_id: taskId,
    sender_name: 'Giovanni',
    updates: { recurrence_end_date: '2026-12-31' },
  });
  expect(result.success).toBe(true);
  const task = engine.getTask(taskId);
  expect(task.max_cycles).toBeNull();
  expect(task.recurrence_end_date).toBe('2026-12-31');
});
```

**Step 10: Add test for rejection of both bounds in one update call**

```typescript
it('rejects update with both max_cycles and recurrence_end_date', () => {
  const createResult = engine.create({
    board_id: BOARD_ID,
    type: 'recurring',
    title: 'Both update',
    assignee: 'Giovanni',
    recurrence: 'weekly',
    sender_name: 'Alexandre',
  });
  const taskId = createResult.task_id!;

  const result = engine.update({
    board_id: BOARD_ID,
    task_id: taskId,
    sender_name: 'Giovanni',
    updates: { max_cycles: 5, recurrence_end_date: '2026-12-31' },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Cannot set both');
});
```

**Step 11: Add recurring project coverage**

Add at least one test that proves the feature applies to recurring projects too:
- updating recurrence on a recurring project is allowed after the `task.type !== 'recurring'` check is fixed
- bounded expiry works for a `type: 'project'` task with `recurrence` set

**Step 12: Add restore/undo compatibility tests**

Add at least:
- one `restore_task` test proving archived snapshots with `max_cycles` / `recurrence_end_date` restore those fields
- one `taskflow_undo` test proving a bound update rolls back correctly

**Step 13: Run tests**

Run: `cd container/agent-runner && npx vitest run`
Expected: All tests pass

**Step 14: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.test.ts
git commit -m "test: add bounded recurrence engine unit tests"
```

---

### Task 13: Build, migrate, deploy

**Step 1: Build host code**

```bash
npm run build
```

**Step 2: Run migration on live database**

```bash
node dist/taskflow-db.js
```

This adds `max_cycles` and `recurrence_end_date` columns to existing databases via idempotent ALTER TABLE.

**Step 3: Rebuild container and restart**

```bash
./container/build.sh
systemctl restart nanoclaw
```

Do not add `docker builder prune -f` or repo-wide `chown -R` to the default rollout plan. Those are environment-specific operational actions, not required for this feature rollout.

**Step 4: Verify service is running**

```bash
systemctl status nanoclaw
tail -20 /root/nanoclaw/logs/nanoclaw.log
```

---

### Task 14: End-to-end verification

Test via WhatsApp:

1. **Create bounded by cycles**: "semanal por 4 semanas para [person]: Relatorio" -- verify R-prefix, max_cycles=4
2. **Create bounded by date**: "mensal ate 30/06 para [person]: Revisao" -- verify recurrence_end_date stored
3. **Reject both bounds**: "semanal por 6 semanas ate 30/06 para [person]: X" -- agent asks to choose one
4. **Check task details**: "detalhes RXXX" -- verify bound shows
5. **Complete a cycle**: start + conclude -- verify `expired: false`, new_due_date returned
6. **Extend**: "estender RXXX por mais 3 ciclos" -- verify update succeeds
7. **Swap bound**: "estender RXXX ate 30/09" -- verify max_cycles cleared, recurrence_end_date set
8. **Remove bound**: "remover limite de RXXX" -- verify bound cleared
9. **Recurring project**: create a recurring project with a bound and verify it advances/expires using the same logic
10. **Expiry UX**: complete a bounded task on its final cycle and verify the agent uses `ciclo final: N` without depending on unavailable `N/M` data
