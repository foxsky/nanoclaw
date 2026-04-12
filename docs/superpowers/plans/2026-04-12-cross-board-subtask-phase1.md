# Cross-Board Subtask Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable child boards to create subtasks on delegated projects (flag-gated) and merge duplicate local/delegated projects into one.

**Architecture:** A per-board `cross_board_subtask_mode` flag in `board_runtime_config` gates the `add_subtask` path for delegated tasks (3 modes: `open`/`approval`/`blocked`). A new `merge_project` admin action uses UPDATE-in-place to rekey subtask rows from a source project into a target project, with migration notes on every affected task.

**Tech Stack:** TypeScript, better-sqlite3, Zod (MCP schema), Vitest, Mustache templates

**Spec:** `docs/superpowers/specs/2026-04-09-cross-board-subtask-approval-design.md`

---

### Task 1: Schema Migration — `cross_board_subtask_mode` Column

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:764-766` (ALTER TABLE block)
- Test: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Write failing test — column exists after engine init**

```typescript
it('board_runtime_config has cross_board_subtask_mode column after engine init', () => {
  const row = db
    .prepare(`SELECT cross_board_subtask_mode FROM board_runtime_config WHERE board_id = ?`)
    .get(BOARD_ID) as { cross_board_subtask_mode: string } | undefined;
  expect(row).toBeTruthy();
  expect(row!.cross_board_subtask_mode).toBe('open');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts -t "cross_board_subtask_mode"`
Expected: FAIL with "no such column: cross_board_subtask_mode"

- [ ] **Step 3: Add the ALTER TABLE migration**

In `container/agent-runner/src/taskflow-engine.ts`, after the existing `city` migration at ~L766, add:

```typescript
try { this.db.exec(`ALTER TABLE board_runtime_config ADD COLUMN cross_board_subtask_mode TEXT NOT NULL DEFAULT 'open'`); } catch {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts -t "cross_board_subtask_mode"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "feat(taskflow): add cross_board_subtask_mode column to board_runtime_config"
```

---

### Task 2: Engine Mode Check in `add_subtask` Path

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:3957-3976` (add_subtask branch inside update())
- Test: `container/agent-runner/src/taskflow-engine.test.ts`

This task needs a cross-board test fixture: a parent board with a project delegated to a child board via `child_exec`. The child board engine instance then calls `add_subtask` on the delegated project.

- [ ] **Step 1: Write failing tests — three modes**

Add a new `describe('cross-board subtask mode')` block. The fixture creates:
- A parent board (`board-parent`) with a project (`P1`) assigned to `person-dev`
- A child board (`board-child`) registered via `child_board_registrations`
- `P1` has `child_exec_enabled=1, child_exec_board_id='board-child'` so the child board can see it

```typescript
describe('cross-board subtask mode', () => {
  const PARENT_BOARD = 'board-parent';
  const CHILD_BOARD = 'board-child';
  let db: Database.Database;
  let childEngine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);

    // Parent board (level 0, max_depth 2)
    db.exec(`INSERT INTO boards VALUES ('${PARENT_BOARD}', 'parent@g.us', 'parent', 'standard', 0, 2, NULL, 'PAR')`);
    db.exec(`INSERT INTO board_config VALUES ('${PARENT_BOARD}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 1, 2, 1, 1)`);
    db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${PARENT_BOARD}')`);
    db.exec(`INSERT INTO board_people VALUES ('${PARENT_BOARD}', 'person-dev', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`);
    db.exec(`INSERT INTO board_admins VALUES ('${PARENT_BOARD}', 'person-mgr', '5585999990001', 'manager', 1)`);
    db.exec(`INSERT INTO board_people VALUES ('${PARENT_BOARD}', 'person-mgr', 'Miguel', '5585999990001', 'Gestor', 3, NULL)`);

    // Child board (level 1, max_depth 2)
    db.exec(`INSERT INTO boards VALUES ('${CHILD_BOARD}', 'child@g.us', 'child', 'standard', 1, 2, '${PARENT_BOARD}', 'CHI')`);
    db.exec(`INSERT INTO board_config VALUES ('${CHILD_BOARD}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${CHILD_BOARD}')`);
    db.exec(`INSERT INTO board_people VALUES ('${CHILD_BOARD}', 'person-dev', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`);
    db.exec(`INSERT INTO board_admins VALUES ('${CHILD_BOARD}', 'person-dev', '5585999990002', 'manager', 1)`);

    // Link child board registration
    db.exec(`INSERT INTO child_board_registrations VALUES ('${PARENT_BOARD}', 'person-dev', '${CHILD_BOARD}')`);

    const now = new Date().toISOString();

    // P1 — project on parent board, delegated to child board via child_exec
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
             VALUES ('P1', '${PARENT_BOARD}', 'project', 'Website Redesign', 'person-dev', 'in_progress', 1, '${CHILD_BOARD}', 'person-dev', '${now}', '${now}')`);

    // P1.1 — existing subtask, also delegated
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
             VALUES ('P1.1', '${PARENT_BOARD}', 'simple', 'Design mockups', 'person-dev', 'next_action', 'P1', 1, '${CHILD_BOARD}', 'person-dev', '${now}', '${now}')`);

    // Child board engine instance
    childEngine = new TaskflowEngine(db, CHILD_BOARD);
  });

  afterEach(() => { db.close(); });

  it('mode=open (default): child board can add subtask to delegated project', () => {
    const r = childEngine.update({
      board_id: CHILD_BOARD,
      task_id: 'P1',
      sender_name: 'Giovanni',
      updates: { add_subtask: 'Implement login page' },
    });
    expect(r.success).toBe(true);
    // Subtask created on PARENT board with ID P1.2
    const subtask = db.prepare(`SELECT * FROM tasks WHERE id = 'P1.2' AND board_id = ?`).get(PARENT_BOARD);
    expect(subtask).toBeTruthy();
  });

  it('mode=blocked: child board cannot add subtask to delegated project', () => {
    // Set parent board to blocked
    db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'blocked' WHERE board_id = '${PARENT_BOARD}'`);

    const r = childEngine.update({
      board_id: CHILD_BOARD,
      task_id: 'P1',
      sender_name: 'Giovanni',
      updates: { add_subtask: 'Implement login page' },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('não permite');
    // No subtask created
    const subtask = db.prepare(`SELECT * FROM tasks WHERE id = 'P1.2'`).get();
    expect(subtask).toBeUndefined();
  });

  it('mode=approval: child board gets pending response', () => {
    // Set parent board to approval
    db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'approval' WHERE board_id = '${PARENT_BOARD}'`);

    const r = childEngine.update({
      board_id: CHILD_BOARD,
      task_id: 'P1',
      sender_name: 'Giovanni',
      updates: { add_subtask: 'Implement login page' },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('aprovação');
    // No subtask created
    const subtask = db.prepare(`SELECT * FROM tasks WHERE id = 'P1.2'`).get();
    expect(subtask).toBeUndefined();
  });

  it('mode check only fires for cross-board — same-board add_subtask always allowed', () => {
    // Set parent board to blocked, but create a parent engine and call add_subtask locally
    db.exec(`UPDATE board_runtime_config SET cross_board_subtask_mode = 'blocked' WHERE board_id = '${PARENT_BOARD}'`);
    const parentEngine = new TaskflowEngine(db, PARENT_BOARD);

    const r = parentEngine.update({
      board_id: PARENT_BOARD,
      task_id: 'P1',
      sender_name: 'Miguel',
      updates: { add_subtask: 'Implement login page' },
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts -t "cross-board subtask mode"`
Expected: `mode=open` PASSES (existing code already handles it), `mode=blocked` FAILS (no mode check), `mode=approval` FAILS

- [ ] **Step 3: Implement the mode check**

In `container/agent-runner/src/taskflow-engine.ts`, inside the `update()` method's `add_subtask` branch, right after the project-type check at ~L3959 and BEFORE the subtask ID generation at ~L3961, add:

```typescript
// Cross-board subtask mode gate: when a child board tries to add a subtask
// to a delegated task, check the PARENT board's cross_board_subtask_mode.
if (task.board_id !== this.boardId) {
  const owningBoardId = this.taskBoardId(task);
  const modeRow = this.db.prepare(
    `SELECT cross_board_subtask_mode FROM board_runtime_config WHERE board_id = ?`,
  ).get(owningBoardId) as { cross_board_subtask_mode: string } | undefined;
  const mode = modeRow?.cross_board_subtask_mode ?? 'open';

  if (mode === 'blocked') {
    return {
      success: false,
      error: 'O quadro pai não permite criação de subtarefas por quadros filhos. Peça ao gestor do quadro pai para adicionar a subtarefa.',
    };
  }
  if (mode === 'approval') {
    return {
      success: false,
      error: 'Criação de subtarefas em projetos delegados requer aprovação do quadro pai. Funcionalidade de aprovação ainda não implementada — peça ao gestor do quadro pai para adicionar a subtarefa diretamente.',
    };
  }
  // mode === 'open' → fall through to existing logic
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts -t "cross-board subtask mode"`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "feat(taskflow): cross_board_subtask_mode gate on add_subtask for delegated tasks"
```

---

### Task 3: Engine `merge_project` Admin Action

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:198` (action union), `~L5914` (admin switch)
- Test: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Add `merge_project` to the action type union**

At `container/agent-runner/src/taskflow-engine.ts:198`, add `'merge_project'` to the union:

```typescript
action: 'register_person' | 'remove_person' | 'add_manager' | 'add_delegate' | 'remove_admin' | 'set_wip_limit' | 'cancel_task' | 'restore_task' | 'process_inbox' | 'manage_holidays' | 'process_minutes' | 'process_minutes_decision' | 'accept_external_invite' | 'reparent_task' | 'detach_task' | 'merge_project';
```

Also add the new params to `AdminParams`:

```typescript
source_project_id?: string;
target_project_id?: string;
```

Find the existing optional params block (around L200-220) and add these two fields there.

- [ ] **Step 2: Write failing tests — merge happy path + edge cases**

Add a new `describe('merge_project')` block with its own fixture:

```typescript
describe('merge_project', () => {
  const MERGE_BOARD = 'board-merge';
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);

    db.exec(`INSERT INTO boards VALUES ('${MERGE_BOARD}', 'merge@g.us', 'merge', 'standard', 0, 1, NULL, NULL)`);
    db.exec(`INSERT INTO board_config VALUES ('${MERGE_BOARD}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 10, 5, 1, 1)`);
    db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${MERGE_BOARD}')`);
    db.exec(`INSERT INTO board_admins VALUES ('${MERGE_BOARD}', 'person-mgr', '5585999990001', 'manager', 1)`);
    db.exec(`INSERT INTO board_people VALUES ('${MERGE_BOARD}', 'person-mgr', 'Manager', '5585999990001', 'Gestor', 3, NULL)`);
    db.exec(`INSERT INTO board_people VALUES ('${MERGE_BOARD}', 'person-dev', 'Developer', '5585999990002', 'Dev', 3, NULL)`);

    const now = new Date().toISOString();

    // Target project P1 with one existing subtask P1.1
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
             VALUES ('P1', '${MERGE_BOARD}', 'project', 'Target Project', 'person-mgr', 'in_progress', '${now}', '${now}')`);
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, created_at, updated_at)
             VALUES ('P1.1', '${MERGE_BOARD}', 'simple', 'Existing subtask', 'person-dev', 'next_action', 'P1', '${now}', '${now}')`);

    // Source project P2 with two subtasks P2.1, P2.2
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, priority, created_at, updated_at)
             VALUES ('P2', '${MERGE_BOARD}', 'project', 'Source Project', 'person-dev', 'in_progress', 'high', '${now}', '${now}')`);
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, due_date, notes, next_note_id, created_at, updated_at)
             VALUES ('P2.1', '${MERGE_BOARD}', 'simple', 'Migrate subtask A', 'person-dev', 'in_progress', 'P2', '2026-04-20', '[]', 1, '${now}', '${now}')`);
    db.exec(`INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, blocked_by, notes, next_note_id, created_at, updated_at)
             VALUES ('P2.2', '${MERGE_BOARD}', 'simple', 'Migrate subtask B', 'person-mgr', 'next_action', 'P2', '["P2.1"]', '[{"id":1,"text":"existing note","at":"${now}","by":"Manager"}]', 2, '${now}', '${now}')`);

    // History for subtasks
    db.exec(`INSERT INTO task_history (board_id, task_id, action, by, at, details)
             VALUES ('${MERGE_BOARD}', 'P2.1', 'created', 'Manager', '${now}', '{}')`);
    db.exec(`INSERT INTO task_history (board_id, task_id, action, by, at, details)
             VALUES ('${MERGE_BOARD}', 'P2.2', 'created', 'Manager', '${now}', '{}')`);

    // Source project also has notes
    db.exec(`UPDATE tasks SET notes = '[{"id":1,"text":"project-level note","at":"${now}","by":"Manager"}]', next_note_id = 2
             WHERE board_id = '${MERGE_BOARD}' AND id = 'P2'`);

    engine = new TaskflowEngine(db, MERGE_BOARD);
  });

  afterEach(() => { db.close(); });

  it('merges source subtasks into target project with new IDs', () => {
    const r = engine.admin({
      board_id: MERGE_BOARD,
      action: 'merge_project',
      source_project_id: 'P2',
      target_project_id: 'P1',
      sender_name: 'Manager',
    });
    expect(r.success).toBe(true);
    expect(r.merged).toEqual({ 'P2.1': 'P1.2', 'P2.2': 'P1.3' });
    expect(r.source_archived).toBe('P2');

    // P1.2 exists on same board with P2.1's title and metadata
    const p12 = db.prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = 'P1.2'`).get(MERGE_BOARD) as any;
    expect(p12).toBeTruthy();
    expect(p12.title).toBe('Migrate subtask A');
    expect(p12.parent_task_id).toBe('P1');
    expect(p12.due_date).toBe('2026-04-20');

    // P1.3 exists with P2.2's existing notes + migration note appended
    const p13 = db.prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = 'P1.3'`).get(MERGE_BOARD) as any;
    expect(p13).toBeTruthy();
    expect(p13.title).toBe('Migrate subtask B');
    const notes = JSON.parse(p13.notes);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.some((n: any) => n.text.includes('Migrada de P2.2'))).toBe(true);

    // Old IDs no longer exist
    expect(db.prepare(`SELECT 1 FROM tasks WHERE id = 'P2.1'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM tasks WHERE id = 'P2.2'`).get()).toBeUndefined();

    // History rekeyed
    const hist = db.prepare(`SELECT * FROM task_history WHERE task_id = 'P1.2'`).all();
    expect(hist.length).toBeGreaterThanOrEqual(1);

    // Source project archived
    const archived = db.prepare(`SELECT * FROM archive WHERE task_id = 'P2'`).get() as any;
    expect(archived).toBeTruthy();
    expect(archived.archive_reason).toBe('merged');
  });

  it('rekeys blocked_by references from old subtask IDs to new ones', () => {
    engine.admin({
      board_id: MERGE_BOARD,
      action: 'merge_project',
      source_project_id: 'P2',
      target_project_id: 'P1',
      sender_name: 'Manager',
    });

    // P2.2 had blocked_by: ["P2.1"]. After merge, P1.3 should have blocked_by: ["P1.2"]
    const p13 = db.prepare(`SELECT blocked_by FROM tasks WHERE board_id = ? AND id = 'P1.3'`).get(MERGE_BOARD) as any;
    const blockedBy = JSON.parse(p13.blocked_by);
    expect(blockedBy).toContain('P1.2');
    expect(blockedBy).not.toContain('P2.1');
  });

  it('adds migration notes on target project', () => {
    engine.admin({
      board_id: MERGE_BOARD,
      action: 'merge_project',
      source_project_id: 'P2',
      target_project_id: 'P1',
      sender_name: 'Manager',
    });

    const p1 = db.prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = 'P1'`).get(MERGE_BOARD) as any;
    const notes = JSON.parse(p1.notes);
    // Should have a merge summary note + the migrated project-level note from P2
    expect(notes.some((n: any) => n.text.includes('mesclado') || n.text.includes('Migrada'))).toBe(true);
    expect(notes.some((n: any) => n.text.includes('project-level note') || n.text.includes('[de P2]'))).toBe(true);
  });

  it('rejects when source is not a project', () => {
    // T-001 is a simple task in seedTestDb — use a standalone task
    db.exec(`INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at)
             VALUES ('T5', '${MERGE_BOARD}', 'simple', 'Not a project', 'inbox', '${new Date().toISOString()}', '${new Date().toISOString()}')`);

    const r = engine.admin({
      board_id: MERGE_BOARD,
      action: 'merge_project',
      source_project_id: 'T5',
      target_project_id: 'P1',
      sender_name: 'Manager',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('project');
  });

  it('rejects when source equals target', () => {
    const r = engine.admin({
      board_id: MERGE_BOARD,
      action: 'merge_project',
      source_project_id: 'P1',
      target_project_id: 'P1',
      sender_name: 'Manager',
    });
    expect(r.success).toBe(false);
  });

  it('rejects for non-managers', () => {
    const r = engine.admin({
      board_id: MERGE_BOARD,
      action: 'merge_project',
      source_project_id: 'P2',
      target_project_id: 'P1',
      sender_name: 'Developer',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('manager');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts -t "merge_project"`
Expected: All FAIL with "Unknown admin action: merge_project" or similar

- [ ] **Step 4: Implement `merge_project` engine case**

In `container/agent-runner/src/taskflow-engine.ts`, inside the `admin()` method's switch statement (after the `detach_task` case), add the new case. The implementation must:

1. Validate both projects exist and are type='project'
2. Validate source !== target
3. Validate sender is a manager
4. Run inside `db.transaction()`
5. Compute new subtask IDs
6. UPDATE each subtask row (board_id, id, parent_task_id, child_exec fields)
7. Rekey task_history
8. Rekey blocked_by JSON references
9. Add migration notes on each subtask, on the target project, and on the source project
10. Merge project-level notes from source to target
11. Archive the empty source project with reason='merged'
12. Return the ID mapping

```typescript
case 'merge_project': {
  if (!params.source_project_id || !params.target_project_id) {
    return { success: false, error: 'Missing required parameters: source_project_id and target_project_id' };
  }
  if (params.source_project_id === params.target_project_id) {
    return { success: false, error: 'source_project_id and target_project_id must be different.' };
  }

  // Manager-only
  const senderPerson = this.resolvePerson(params.sender_name);
  const senderPersonId = senderPerson?.person_id ?? params.sender_name;
  const isManager = this.db
    .prepare(`SELECT 1 FROM board_admins WHERE board_id = ? AND person_id = ? AND admin_role = 'manager'`)
    .get(this.boardId, senderPersonId);
  if (!isManager) {
    return { success: false, error: 'Only managers can merge projects.' };
  }

  const source = this.getTask(params.source_project_id);
  if (!source) return { success: false, error: `Source project ${params.source_project_id} not found.` };
  if (source.type !== 'project') return { success: false, error: `${params.source_project_id} is not a project (type=${source.type}).` };

  const target = this.getTask(params.target_project_id);
  if (!target) return { success: false, error: `Target project ${params.target_project_id} not found.` };
  if (target.type !== 'project') return { success: false, error: `${params.target_project_id} is not a project (type=${target.type}).` };

  const sourceBoardId = this.taskBoardId(source);
  const targetBoardId = this.taskBoardId(target);
  const now = new Date().toISOString();

  const merged: Record<string, string> = {};
  let notesAdded = 0;

  this.db.transaction(() => {
    // Get source subtasks
    const sourceSubtasks = this.getSubtaskRows(source.id, sourceBoardId);
    if (sourceSubtasks.length === 0) {
      throw new Error(`Source project ${source.id} has no subtasks to merge.`);
    }

    // Get target's current max subtask number
    const targetSubtasks = this.getSubtaskRows(target.id, targetBoardId);
    let nextNum = targetSubtasks.reduce((max: number, s: any) => {
      const parts = s.id.split('.');
      const num = parseInt(parts[parts.length - 1], 10);
      return Number.isNaN(num) ? max : Math.max(max, num);
    }, 0) + 1;

    // Build old→new ID mapping first (needed for blocked_by rekey)
    const idMap: Record<string, string> = {};
    for (const sub of sourceSubtasks) {
      const newId = `${target.id}.${nextNum}`;
      idMap[sub.id] = newId;
      nextNum++;
    }

    // For each source subtask: UPDATE in place
    for (const sub of sourceSubtasks) {
      const newId = idMap[sub.id];
      merged[sub.id] = newId;

      // Compute child_exec wiring for the target board
      const childLink = this.linkedChildBoardFor(targetBoardId, sub.assignee);

      // Add migration note to the subtask's existing notes
      const notes: Array<any> = JSON.parse(sub.notes ?? '[]');
      const noteId = sub.next_note_id ?? 1;
      notes.push({
        id: noteId,
        text: `Migrada de ${sub.id} (projeto ${source.id} mesclado em ${target.id})`,
        at: now,
        by: params.sender_name,
      });
      notesAdded++;

      // Pre-existence check
      const exists = this.db
        .prepare(`SELECT 1 FROM tasks WHERE board_id = ? AND id = ?`)
        .get(targetBoardId, newId);
      if (exists) {
        throw new Error(`Target ID ${newId} already exists on board ${targetBoardId}. Subtask ID collision.`);
      }

      // UPDATE the subtask row in place
      this.db.prepare(`
        UPDATE tasks SET
          board_id = ?,
          id = ?,
          parent_task_id = ?,
          child_exec_enabled = ?,
          child_exec_board_id = ?,
          child_exec_person_id = ?,
          notes = ?,
          next_note_id = ?,
          updated_at = ?
        WHERE board_id = ? AND id = ?
      `).run(
        targetBoardId, newId, target.id,
        childLink.child_exec_enabled,
        childLink.child_exec_board_id,
        childLink.child_exec_person_id,
        JSON.stringify(notes), noteId + 1, now,
        sourceBoardId, sub.id,
      );

      // Rekey task_history
      this.db.prepare(`
        UPDATE task_history SET board_id = ?, task_id = ?
        WHERE board_id = ? AND task_id = ?
      `).run(targetBoardId, newId, sourceBoardId, sub.id);
    }

    // Rekey blocked_by references across ALL tasks on the board(s)
    for (const [oldId, newId] of Object.entries(idMap)) {
      const rows = this.db.prepare(
        `SELECT board_id, id, blocked_by FROM tasks WHERE blocked_by LIKE ?`,
      ).all(`%"${oldId}"%`) as Array<{ board_id: string; id: string; blocked_by: string }>;

      for (const row of rows) {
        const blockedBy: string[] = JSON.parse(row.blocked_by);
        const updated = blockedBy.map((dep) => dep === oldId ? newId : dep);
        this.db.prepare(`UPDATE tasks SET blocked_by = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(updated), row.board_id, row.id);
      }
    }

    // Add merge summary note on the target project
    const targetNotes: Array<any> = JSON.parse(target.notes ?? '[]');
    let targetNoteId = target.next_note_id ?? 1;

    // Copy source project-level notes with prefix
    const sourceNotes: Array<any> = JSON.parse(source.notes ?? '[]');
    for (const sn of sourceNotes) {
      targetNotes.push({
        id: targetNoteId,
        text: `[de ${source.id}] ${sn.text}`,
        at: sn.at,
        by: sn.by,
      });
      targetNoteId++;
      notesAdded++;
    }

    // Merge summary
    const mapping = Object.entries(merged).map(([o, n]) => `${o}→${n}`).join(', ');
    targetNotes.push({
      id: targetNoteId,
      text: `Projeto ${source.id} mesclado — subtarefas migradas: ${mapping}`,
      at: now,
      by: params.sender_name,
    });
    targetNoteId++;
    notesAdded++;

    this.db.prepare(`UPDATE tasks SET notes = ?, next_note_id = ?, updated_at = ? WHERE board_id = ? AND id = ?`)
      .run(JSON.stringify(targetNotes), targetNoteId, now, targetBoardId, target.id);

    // Add farewell note on source project before archiving
    const srcNotes: Array<any> = JSON.parse(source.notes ?? '[]');
    const srcNoteId = source.next_note_id ?? 1;
    srcNotes.push({
      id: srcNoteId,
      text: `Projeto mesclado em ${target.id} — todas as subtarefas migradas`,
      at: now,
      by: params.sender_name,
    });
    this.db.prepare(`UPDATE tasks SET notes = ?, next_note_id = ?, updated_at = ? WHERE board_id = ? AND id = ?`)
      .run(JSON.stringify(srcNotes), srcNoteId + 1, now, sourceBoardId, source.id);
    notesAdded++;

    // Archive the empty source project
    this.archiveTask(
      { ...source, notes: JSON.stringify(srcNotes), board_id: sourceBoardId },
      'merged',
    );

    // Delete the source project row. NOTE: verify during implementation whether
    // archiveTask() already does the DELETE (check the cancel_task case for the
    // pattern). If archiveTask handles deletion, remove this line to avoid a
    // double-delete no-op.
    this.db.prepare(`DELETE FROM tasks WHERE board_id = ? AND id = ?`).run(sourceBoardId, source.id);
  })();

  return {
    success: true,
    merged,
    source_archived: params.source_project_id,
    notes_added: notesAdded,
    data: { message: `Projeto ${params.source_project_id} mesclado em ${params.target_project_id}. ${Object.keys(merged).length} subtarefa(s) migrada(s).` },
  };
}
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts -t "merge_project"`
Expected: All 6 tests PASS

- [ ] **Step 6: Run full engine test suite**

Run: `cd container/agent-runner && npx vitest run src/taskflow-engine.test.ts`
Expected: All tests PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "feat(taskflow): merge_project admin action — UPDATE-in-place with migration notes"
```

---

### Task 4: IPC Zod Schema Updates

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:920` (Zod enum + params)

- [ ] **Step 1: Update the Zod enum to include `merge_project`**

At `container/agent-runner/src/ipc-mcp-stdio.ts:920`, add `'merge_project'` to the action enum:

```typescript
action: z.enum([
  'register_person', 'remove_person', 'add_manager', 'add_delegate',
  'remove_admin', 'set_wip_limit', 'cancel_task', 'restore_task',
  'process_inbox', 'manage_holidays', 'process_minutes',
  'process_minutes_decision', 'accept_external_invite',
  'reparent_task', 'detach_task', 'merge_project',
]).describe('Admin action'),
```

- [ ] **Step 2: Add the new optional params**

After the existing `group_folder` param (around L931), add:

```typescript
source_project_id: z.string().optional().describe('Source project ID to merge FROM (for merge_project, e.g., "P5")'),
target_project_id: z.string().optional().describe('Target project ID to merge INTO (for merge_project, e.g., "P24")'),
```

- [ ] **Step 3: Type-check**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run the MCP schema test if it exists**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "MCP schema"`
Expected: Tests that check for admin actions should now include `merge_project`

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(taskflow): add merge_project to IPC Zod schema"
```

---

### Task 5: Template Updates

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`

- [ ] **Step 1: Add mode-aware guidance after the delegated tasks block (~L231)**

After the existing "Delegated tasks (from parent board) are fully operable..." paragraph, add:

```markdown
**Cross-board subtask mode.** The parent board controls whether child boards can create subtasks on delegated projects via `cross_board_subtask_mode` in `board_runtime_config`. When you call `add_subtask` on a delegated task and the engine returns an error:
- If the error mentions "não permite criação de subtarefas" (mode=`blocked`): tell the user the parent board does not allow subtask creation from child boards and suggest asking the parent board manager directly.
- If the error mentions "requer aprovação" (mode=`approval`): tell the user the request needs the parent board manager's approval. (Approval flow not yet implemented — suggest contacting the parent board manager directly for now.)
- If `add_subtask` succeeds (mode=`open`, the default): the subtask was created directly. Confirm to the user normally.
```

- [ ] **Step 2: Add the mode-change and merge command rows to the Admin table**

After the `"definir feriados..."` row (the last Admin table row), add the mode-change command (uses direct SQL per spec — no `set_config` action exists in the engine):

```markdown
| "modo subtarefa cross-board: aberto" | Manager-only. `mcp__sqlite__write_query("UPDATE board_runtime_config SET cross_board_subtask_mode = 'open' WHERE board_id = '{{BOARD_ID}}'")`. Record in history: `INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES ('{{BOARD_ID}}', 'BOARD', 'config_changed', SENDER, datetime('now'), '{"key":"cross_board_subtask_mode","value":"open"}')`. Valid values: `open`, `approval`, `blocked` — refuse anything else. |
| "modo subtarefa cross-board: aprovação" | Same as above with `value = 'approval'`. |
| "modo subtarefa cross-board: bloqueado" | Same as above with `value = 'blocked'`. |
```

Then add the merge command row:

```markdown
| "mesclar P5 em P24" / "juntar P5 com P24" | `taskflow_admin({ action: 'merge_project', source_project_id: 'P5', target_project_id: 'P24', sender_name: SENDER })` — merges all subtasks from P5 into P24 (new IDs assigned), copies notes, archives P5. Show the ID mapping to the user. Manager-only. |
```

- [ ] **Step 3: Add `cross_board_subtask_mode` to the Schema Reference**

In the `board_runtime_config` row of the Schema Reference (around L849), append to the column list:

```
, `cross_board_subtask_mode TEXT DEFAULT 'open'` (controls child-board subtask creation on delegated projects: `open`/`approval`/`blocked` — set by parent board manager)
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "docs(taskflow): template guidance for cross-board subtask mode + merge command"
```

---

### Task 6: Skill Tests, Regen, Changelogs

**Files:**
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`
- Modify: `CHANGELOG.md`, `.claude/skills/add-taskflow/CHANGELOG.md`
- Regenerate: all `groups/*/CLAUDE.md`

- [ ] **Step 1: Add drift-guard tests for new template content**

In `.claude/skills/add-taskflow/tests/taskflow.test.ts`, add:

```typescript
it('CLAUDE.md.template documents cross-board subtask mode', () => {
  const content = fs.readFileSync(
    path.join(skillDir, 'templates', 'CLAUDE.md.template'),
    'utf-8',
  );
  expect(content).toContain('cross_board_subtask_mode');
  expect(content).toContain('merge_project');
  expect(content).toContain("action: 'merge_project'");
  expect(content).toContain('mesclar');
});

it('MCP schema includes merge_project in taskflow_admin', () => {
  const ipcSrc = fs.readFileSync(
    path.resolve(skillDir, '..', '..', '..', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
    'utf-8',
  );
  expect(ipcSrc).toContain("'merge_project'");
  expect(ipcSrc).toContain('source_project_id');
  expect(ipcSrc).toContain('target_project_id');
});
```

- [ ] **Step 2: Regenerate group CLAUDE.md files**

Run: `node scripts/generate-claude-md.mjs`

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --config vitest.config.ts`
Expected: Only the pre-existing group-queue.test.ts failure. All other tests pass.

- [ ] **Step 4: Update changelogs**

Add entries to both `CHANGELOG.md` and `.claude/skills/add-taskflow/CHANGELOG.md` covering:
- `cross_board_subtask_mode` flag (schema + engine check)
- `merge_project` admin action
- Template guidance + merge command row

- [ ] **Step 5: Commit everything**

```bash
git add -u groups/
git add .claude/skills/add-taskflow/tests/taskflow.test.ts CHANGELOG.md .claude/skills/add-taskflow/CHANGELOG.md
git commit -m "feat(taskflow): cross-board subtask Phase 1 — mode flag, merge action, template guidance"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `cd container/agent-runner && npx vitest run` — all container tests pass
- [ ] `npx vitest run --config vitest.config.ts` — only pre-existing group-queue failure
- [ ] `cd container/agent-runner && npx tsc --noEmit` — no type errors
- [ ] `npm run build` — host-side compiles
- [ ] Spot-check `groups/secti-taskflow/CLAUDE.md` contains `cross_board_subtask_mode` and `merge_project`
- [ ] Spot-check `groups/ci-seci-taskflow/CLAUDE.md` (leaf board) also contains the guidance
