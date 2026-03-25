# Compact Board Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full Kanban board in digest/weekly reports with a compact column-count summary, eliminating repetition and cutting message length by ~50%.

**Architecture:** Add a `formatCompactBoard()` method to `TaskflowEngine` that reuses the same data-fetching logic as `formatBoardView()` but renders one line per column (emoji + count) instead of listing every task. `formatDigestOrWeeklyReport()` calls this instead of `formatBoardView('board')`. Standup and on-demand board queries are unaffected.

**Tech Stack:** TypeScript, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-03-22-compact-board-digest-design.md`

**File convention:** Edit the source files under `container/agent-runner/src/`. The vitest config only picks up `.claude/skills/**/*.test.ts`, so after each edit, sync the test file to the skill copy before running vitest:
```bash
cp container/agent-runner/src/taskflow-engine.test.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts
```

---

### Task 1: Write failing test for compact board in digest report

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.test.ts:3645-3695`

- [ ] **Step 1: Add test for compact header in digest**

In the existing `report` describe block, add a new test after the existing digest test:

```typescript
it('digest uses compact board header instead of full board', () => {
  const now = new Date().toISOString();
  // Complete T-001 today
  db.exec(`UPDATE tasks SET column = 'done' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`);
  db.exec(
    `INSERT INTO task_history (board_id, task_id, action, by, at, details)
     VALUES ('${BOARD_ID}', 'T-001', 'conclude', 'person-1', '${now}', '${JSON.stringify({ from: 'in_progress', to: 'done' })}')`,
  );

  const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
  expect(r.success).toBe(true);
  const report = r.data!.formatted_report!;

  // Should have compact header with TASKFLOW BOARD title
  expect(report).toContain('📋 *TASKFLOW BOARD*');
  // Should have stats line
  expect(report).toContain('tarefas');
  // Should have column counts (not individual task listings)
  expect(report).toMatch(/📥 \d+ inbox/);
  // Should NOT have individual task lines in the board section (before first separator after header)
  // The full board would have person groupings like "👤 *Alexandre:*"
  // In the compact view, person groupings should NOT appear in the header area
  const headerEnd = report.indexOf('🎉');
  const headerSection = headerEnd > 0 ? report.slice(0, headerEnd) : report.slice(0, 200);
  expect(headerSection).not.toContain('👤');
  // Should have completed count
  expect(report).toContain('concluída(s) hoje');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts -t 'digest uses compact board header' --no-coverage`

Expected: FAIL — the current digest includes the full board with `👤` person groupings in the header section.

---

### Task 2: Write failing test for compact board in weekly report

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Add test for compact header in weekly**

```typescript
it('weekly uses compact board header instead of full board', () => {
  const now = new Date().toISOString();
  db.exec(`UPDATE tasks SET column = 'done' WHERE board_id = '${BOARD_ID}' AND id = 'T-001'`);
  db.exec(
    `INSERT INTO task_history (board_id, task_id, action, by, at, details)
     VALUES ('${BOARD_ID}', 'T-001', 'conclude', 'person-1', '${now}', '${JSON.stringify({ from: 'in_progress', to: 'done' })}')`,
  );

  const r = engine.report({ board_id: BOARD_ID, type: 'weekly' });
  expect(r.success).toBe(true);
  const report = r.data!.formatted_report!;

  // Should have compact header
  expect(report).toContain('📋 *TASKFLOW BOARD*');
  // Should have column counts, not task listings in header
  const headerEnd = report.indexOf('🏆');
  const headerSection = headerEnd > 0 ? report.slice(0, headerEnd) : report.slice(0, 200);
  expect(headerSection).not.toContain('👤');
  // Should have completed count for weekly
  expect(report).toContain('concluída(s) na semana');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts -t 'weekly uses compact board header' --no-coverage`

Expected: FAIL

---

### Task 3: Write failing test for standup still using full board

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Add regression test**

```typescript
it('standup still uses full board view with person groupings', () => {
  const r = engine.report({ board_id: BOARD_ID, type: 'standup' });
  expect(r.success).toBe(true);
  const board = r.data!.formatted_board!;

  // Standup should still have the full board with person groupings
  expect(board).toContain('👤');
  // And individual task IDs
  expect(board).toContain('T-001');
  expect(board).toContain('T-002');
});
```

- [ ] **Step 2: Add test for zero-completion digest (no ✅ line)**

```typescript
it('digest compact header omits completed line when zero completions', () => {
  const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
  expect(r.success).toBe(true);
  const report = r.data!.formatted_report!;

  expect(report).toContain('📋 *TASKFLOW BOARD*');
  // No completions today — should NOT have the completed line
  expect(report).not.toContain('concluída(s) hoje');
});
```

- [ ] **Step 3: Add test for empty board compact header**

```typescript
it('digest compact header on empty board shows zero counts', () => {
  db.exec(`DELETE FROM tasks WHERE board_id = '${BOARD_ID}'`);

  const r = engine.report({ board_id: BOARD_ID, type: 'digest' });
  expect(r.success).toBe(true);
  const report = r.data!.formatted_report!;

  expect(report).toContain('📋 *TASKFLOW BOARD*');
  expect(report).toContain('0 tarefas');
  // No column lines — all empty
  expect(report).not.toContain('📥');
  expect(report).not.toContain('⏭️');
  expect(report).not.toContain('🔄');
});
```

- [ ] **Step 4: Add on-demand board regression test**

```typescript
it('on-demand board query still uses full board view', () => {
  const r = engine.query({ board_id: BOARD_ID, query: 'board' });
  expect(r.success).toBe(true);
  const board = (r as any).data.formatted_board;

  // Full board should have person groupings and individual task IDs
  expect(board).toContain('👤');
  expect(board).toContain('T-001');
});
```

- [ ] **Step 5: Run standup and on-demand regression tests to verify they pass now**

Run: `npx vitest run .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts -t 'standup still uses full board|on-demand board query' --no-coverage`

Expected: PASS (regression guards — should pass now and keep passing after changes).

- [ ] **Step 6: Commit tests**

```bash
git add container/agent-runner/src/taskflow-engine.test.ts
git commit -m "test: add failing tests for compact board header in digest/weekly"
```

---

### Task 4: Implement `formatCompactBoard()`

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:4356` (add new method before `formatBoardView`)

- [ ] **Step 1: Add the `formatCompactBoard` method**

Add this method right before `formatBoardView`:

```typescript
private formatCompactBoard(completedCount: number, completedLabel: 'hoje' | 'na semana'): string {
  const todayStr = today();
  const [y, m, d] = todayStr.split('-');
  const SEP = '━━━━━━━━━━━━━━';

  // --- Reuse same data-fetching logic as formatBoardView (lines 4380-4413) ---
  const allTasks: any[] = this.db
    .prepare(
      `SELECT * FROM tasks WHERE ${this.visibleTaskScope()} AND column != 'done' ORDER BY id`,
    )
    .all(...this.visibleTaskParams());

  const topLevel = allTasks.filter((t: any) => !t.parent_task_id);

  // Orphan subtask promotion (same as formatBoardView lines 4395-4408)
  const subtaskMap = new Map<string, any[]>();
  for (const t of allTasks.filter((t: any) => t.parent_task_id)) {
    const arr = subtaskMap.get(t.parent_task_id);
    if (arr) arr.push(t);
    else subtaskMap.set(t.parent_task_id, [t]);
  }
  const topLevelIds = new Set(topLevel.map((t: any) => t.id));
  for (const [parentId, subs] of subtaskMap.entries()) {
    if (!topLevelIds.has(parentId)) {
      const parentBoardId = subs[0].owning_board_id ?? subs[0].board_id;
      const parent = this.db
        .prepare(TaskflowEngine.TASK_BY_BOARD_SQL)
        .get(parentBoardId, parentId) as any;
      if (parent) {
        topLevel.push(parent);
        topLevelIds.add(parent.id);
      }
    }
  }

  // Stats (same as formatBoardView lines 4410-4413)
  const projectCount = topLevel.filter((t: any) => t.type === 'project').length;
  const subtaskCount = allTasks.filter((t: any) => t.parent_task_id).length;
  const taskCount = topLevel.length;

  // Column counts
  const byColumn = new Map<string, number>();
  for (const t of topLevel) {
    byColumn.set(t.column, (byColumn.get(t.column) ?? 0) + 1);
  }

  // Render
  const lines: string[] = [];
  lines.push(`📋 *TASKFLOW BOARD* — ${d}/${m}/${y}`);
  lines.push(`📊 ${taskCount} tarefas • ${projectCount} projetos • ${subtaskCount} subtarefas`);
  lines.push(SEP);

  const compactCols: Array<[string, string, string]> = [
    ['inbox', '📥', 'inbox'],
    ['next_action', '⏭️', 'próximas'],
    ['in_progress', '🔄', 'andamento'],
    ['waiting', '⏳', 'aguardando'],
    ['review', '🔍', 'revisão'],
  ];
  for (const [col, emoji, label] of compactCols) {
    const count = byColumn.get(col) ?? 0;
    if (count > 0) lines.push(`  ${emoji} ${count} ${label}`);
  }
  if (completedCount > 0) {
    lines.push(`  ✅ ${completedCount} concluída(s) ${completedLabel}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 5: Wire `formatCompactBoard` into digest/weekly reports

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts` — the `formatDigestOrWeeklyReport` method

- [ ] **Step 1: Change the first line of `formatDigestOrWeeklyReport`**

Find (currently around line 4616):
```typescript
const lines: string[] = [this.formatBoardView('board')];
```

Replace with:
```typescript
const completedCount = type === 'digest'
  ? data.completed_today.length
  : (data.completed_week?.length ?? 0);
const completedLabel = type === 'digest' ? 'hoje' as const : 'na semana' as const;
const lines: string[] = [this.formatCompactBoard(completedCount, completedLabel)];
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run the new tests**

Run: `npx vitest run .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts -t 'compact board header' --no-coverage`

Expected: Both digest and weekly compact board tests PASS.

- [ ] **Step 4: Run the standup regression test**

Run: `npx vitest run .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts -t 'standup still uses full board' --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat: compact board header for digest/weekly reports"
```

---

### Task 6: Update existing tests that expect full board in digest/weekly

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Update linked task test**

The test "digest and weekly formatted reports preserve prefixed linked task ids" (around line 3754) expects `SEC-T9` to appear in `formatted_report`. With the compact header, linked tasks in normal columns are only represented by a count. Update the test to check the structured data instead:

```typescript
it('digest and weekly formatted reports preserve prefixed linked task ids', () => {
  seedLinkedTask(db, BOARD_ID, {
    ownerBoardId: 'board-parent-sec',
    taskId: 'T9',
    assignee: 'person-2',
    column: 'next_action',
    title: 'Linked parent task',
  });
  db.exec(`UPDATE boards SET short_code = 'SEC' WHERE id = 'board-parent-sec'`);

  const digest = engine.report({ board_id: BOARD_ID, type: 'digest' });
  const weekly = engine.report({ board_id: BOARD_ID, type: 'weekly' });

  // Compact header doesn't list individual tasks — check that the board query still shows them
  const board = engine.query({ board_id: BOARD_ID, query: 'board' });
  expect(board.success).toBe(true);
  expect((board as any).data.formatted_board).toContain('SEC-T9');

  // Digest/weekly compact header shows column counts, not individual task IDs
  expect(digest.data!.formatted_report).toContain('próximas');
  expect(weekly.data!.formatted_report).toContain('próximas');
});
```

- [ ] **Step 2: Run all report tests**

Run: `npx vitest run .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts --no-coverage`

Expected: All report-related tests pass. Pre-existing failures (17) remain unchanged.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.test.ts
git commit -m "test: update linked task test for compact board header"
```

---

### Task 7: Build, sync skill copies, and final verification

**Files:**
- Sync: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- Sync: `.claude/skills/add-taskflow/modify/container/agent-runner/src/taskflow-engine.ts`
- Sync: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts`

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 2: Sync skill copies**

```bash
cp container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
cp container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/modify/container/agent-runner/src/taskflow-engine.ts
cp container/agent-runner/src/taskflow-engine.test.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts
```

- [ ] **Step 3: Run full test suite on skill copy**

Run: `npx vitest run .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts --no-coverage`

Expected: Same pass/fail ratio as baseline (17 pre-existing failures, all report tests pass).

- [ ] **Step 4: Run skill template tests**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts --no-coverage`

Expected: Same pass/fail ratio as baseline (24 pre-existing failures).

- [ ] **Step 5: Commit sync**

```bash
git add .claude/skills/add-taskflow/add/ .claude/skills/add-taskflow/modify/
git commit -m "chore: sync skill copies after compact board header"
```
