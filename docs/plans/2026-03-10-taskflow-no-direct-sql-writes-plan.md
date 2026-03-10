# TaskFlow No Direct SQL Writes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all agent-authored SQL writes from TaskFlow-managed groups so mutations only flow through `taskflow_*` tools.

**Architecture:** Extend the existing `taskflow_admin` and `taskflow_hierarchy` tools with new actions (`ack_welcome`, `sync_display_name`, `remove_child_board`, `log_attachment`) to replace 5 prompt-authored SQL writes. Then remove SQL write instructions from the template. Finally add runtime enforcement: restricted allowed tools, Bash write guard, and fail-closed startup.

**Tech Stack:** TypeScript, better-sqlite3, @modelcontextprotocol/sdk, Zod 4, Vitest

**Spec:** `docs/plans/2026-03-10-taskflow-no-direct-sql-writes-design.md`

---

## File Structure

### Modified files

| File | Responsibility | Changes |
|------|---------------|---------|
| `container/agent-runner/src/taskflow-engine.ts` | TaskFlow engine (all board mutations) | Add 4 new actions to `admin()` and `hierarchy()` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tool registration | Extend `taskflow_admin` and `taskflow_hierarchy` Zod schemas, add fail-closed startup guard |
| `container/agent-runner/src/index.ts` | Agent session runner | Add Bash `taskflow.db` write guard, wire `NANOCLAW_ALLOWED_TOOLS_TASKFLOW` |
| `container/agent-runner/src/runtime-config.ts` | Allowed tools and env builder | Add `NANOCLAW_ALLOWED_TOOLS_TASKFLOW` export |
| `container/agent-runner/src/runtime-config.test.ts` | Runtime config tests | Add tests for TaskFlow tool restriction |
| `.claude/skills/add-taskflow/templates/CLAUDE.md.template` | Agent prompt template | Remove all SQL write instructions |
| `.claude/skills/add-taskflow/tests/taskflow.test.ts` | Skill package tests | Update assertions for removed SQL writes |

### Skill parity copies (mirror of runtime changes)

| Skill copy | Mirrors |
|-----------|---------|
| `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` | `container/agent-runner/src/taskflow-engine.ts` |
| `.claude/skills/add-taskflow/add/container/agent-runner/src/runtime-config.ts` | `container/agent-runner/src/runtime-config.ts` |
| `.claude/skills/add-taskflow/add/container/agent-runner/src/runtime-config.test.ts` | `container/agent-runner/src/runtime-config.test.ts` |
| `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts` | `container/agent-runner/src/ipc-mcp-stdio.ts` |
| `.claude/skills/add-taskflow/modify/container/agent-runner/src/index.ts` | `container/agent-runner/src/index.ts` |

---

**Phase ordering note:** The design spec lists Phase 1 (Prompt redesign) before Phase 2 (Metadata relocation). This plan intentionally inverts that: engine actions (Chunk 1) are implemented before template changes (Chunk 2) because the template replacements reference the new `taskflow_admin` and `taskflow_hierarchy` actions — they must exist first. Phase 3 (Enforcement) and Phase 4 (Validation) follow in order.

---

## Chunk 1: Engine Extensions

### Task 1: Add `ack_welcome` admin action

Replaces `UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?`.

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:174-176` (AdminParams action union)
- Modify: `container/agent-runner/src/taskflow-engine.ts` (admin() method body)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `.claude/skills/add-taskflow/tests/taskflow.test.ts` inside the main `describe('taskflow skill package')` block. Follow the existing test pattern — each `describe` block creates its own `db` and `engine` in `beforeEach`/`afterEach`:

```typescript
describe('admin ack_welcome', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, BOARD_ID);
    engine = new TaskflowEngine(db, BOARD_ID);
  });
  afterEach(() => { db.close(); });

  it('sets welcome_sent to 1', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'ack_welcome',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);

    const row = db.prepare(
      `SELECT welcome_sent FROM board_runtime_config WHERE board_id = ?`,
    ).get(BOARD_ID) as any;
    expect(row.welcome_sent).toBe(1);
  });

  it('is idempotent', () => {
    engine.admin({ board_id: BOARD_ID, action: 'ack_welcome', sender_name: 'Alexandre' });
    const result = engine.admin({ board_id: BOARD_ID, action: 'ack_welcome', sender_name: 'Alexandre' });
    expect(result.success).toBe(true);
  });
});
```

Note: `BOARD_ID` is the constant defined at the top of the test file (line 7). `seedTestDb` populates the in-memory DB with the full TaskFlow schema and test data including two people (Alexandre as person-1, Giovanni as person-2).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "admin ack_welcome"`
Expected: FAIL — `ack_welcome` not in AdminParams action union, engine doesn't handle it

- [ ] **Step 3: Extend AdminParams type**

In `container/agent-runner/src/taskflow-engine.ts:176`, add `'ack_welcome'` to the action union:

```typescript
  action: 'register_person' | 'remove_person' | 'add_manager' | 'add_delegate' | 'remove_admin' | 'set_wip_limit' | 'cancel_task' | 'restore_task' | 'process_inbox' | 'manage_holidays' | 'process_minutes' | 'process_minutes_decision' | 'ack_welcome';
```

- [ ] **Step 4: Implement the action in admin()**

Find the `admin()` method body (around line 4474). The method starts with a permission branch that checks manager/delegate roles. The `ack_welcome` action should be placed **before** the permission check since it is called by the agent on behalf of any sender (not a user-facing admin action). Add early return:

```typescript
    // ack_welcome is agent-internal — skip permission check
    if (params.action === 'ack_welcome') {
      this.db.prepare(
        `UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = ?`,
      ).run(params.board_id);
      return { success: true, message: 'Welcome acknowledged.' };
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "admin ack_welcome"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(taskflow): add ack_welcome admin action"
```

---

### Task 2: Add `sync_display_name` admin action

Replaces `UPDATE board_people SET name = ? WHERE board_id = ? AND person_id = ?`.

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:176` (AdminParams action union + new field)
- Modify: `container/agent-runner/src/taskflow-engine.ts` (admin() method body)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('admin sync_display_name', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, BOARD_ID);
    engine = new TaskflowEngine(db, BOARD_ID);
  });
  afterEach(() => { db.close(); });

  it('updates board_people.name for the matched person', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'sync_display_name',
      sender_name: 'Alexandre',
      person_name: 'person-1',
      display_name: 'Alexandre Silva',
    });
    expect(result.success).toBe(true);

    const row = db.prepare(
      `SELECT name FROM board_people WHERE board_id = ? AND person_id = ?`,
    ).get(BOARD_ID, 'person-1') as any;
    expect(row.name).toBe('Alexandre Silva');
  });

  it('fails if person_id does not exist on the board', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'sync_display_name',
      sender_name: 'Alexandre',
      person_name: 'nonexistent',
      display_name: 'Ghost',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "admin sync_display_name"`
Expected: FAIL

- [ ] **Step 3: Extend AdminParams**

Add `'sync_display_name'` to the action union and add `display_name?: string;` field:

```typescript
  action: '...' | 'ack_welcome' | 'sync_display_name';
  // ... existing fields ...
  display_name?: string;
```

- [ ] **Step 4: Implement the action**

```typescript
    if (params.action === 'sync_display_name') {
      if (!params.person_name || !params.display_name) {
        return { success: false, error: 'person_name and display_name are required.' };
      }
      const updated = this.db.prepare(
        `UPDATE board_people SET name = ? WHERE board_id = ? AND person_id = ?`,
      ).run(params.display_name, params.board_id, params.person_name);
      if (updated.changes === 0) {
        return { success: false, error: `Person '${params.person_name}' not found on this board.` };
      }
      return { success: true, message: `Display name updated to '${params.display_name}'.` };
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "admin sync_display_name"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(taskflow): add sync_display_name admin action"
```

---

### Task 3: Add `remove_child_board` hierarchy action

Replaces `DELETE FROM child_board_registrations` + `INSERT INTO task_history`.

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:254` (HierarchyParams action union)
- Modify: `container/agent-runner/src/taskflow-engine.ts` (hierarchy() method body)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('hierarchy remove_child_board', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, BOARD_ID);
    engine = new TaskflowEngine(db, BOARD_ID);
  });
  afterEach(() => { db.close(); });

  it('deletes the registration and records history', () => {
    // Seed a child board registration
    db.prepare(
      `INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, ?, ?)`,
    ).run(BOARD_ID, 'person-1', 'child-board-1');

    const result = engine.hierarchy({
      board_id: BOARD_ID,
      action: 'remove_child_board',
      task_id: 'BOARD', // convention: board-level operation, not a real task ID
      person_name: 'person-1',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);

    // Registration should be gone
    const reg = db.prepare(
      `SELECT * FROM child_board_registrations WHERE parent_board_id = ? AND person_id = ?`,
    ).get(BOARD_ID, 'person-1');
    expect(reg).toBeUndefined();

    // History should be recorded
    const history = db.prepare(
      `SELECT * FROM task_history WHERE board_id = ? AND action = 'child_board_removed'`,
    ).get(BOARD_ID) as any;
    expect(history).toBeDefined();
    expect(history.by).toBe('Alexandre');
  });

  it('refuses if person has linked tasks', () => {
    // Seed a child board registration
    db.prepare(
      `INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, ?, ?)`,
    ).run(BOARD_ID, 'person-1', 'child-board-1');
    // Seed a linked task
    db.prepare(
      `UPDATE tasks SET child_exec_enabled = 1, child_exec_person_id = 'person-1' WHERE board_id = ? AND id = (SELECT id FROM tasks WHERE board_id = ? LIMIT 1)`,
    ).run(BOARD_ID, BOARD_ID);

    const result = engine.hierarchy({
      board_id: BOARD_ID,
      action: 'remove_child_board',
      task_id: 'BOARD',
      person_name: 'person-1',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('linked tasks');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "hierarchy remove_child_board"`
Expected: FAIL

- [ ] **Step 3: Extend HierarchyParams**

In `container/agent-runner/src/taskflow-engine.ts:254`:

```typescript
  action: 'link' | 'unlink' | 'refresh_rollup' | 'tag_parent' | 'remove_child_board';
```

- [ ] **Step 4: Implement the action**

Add to the `hierarchy()` method:

```typescript
    if (params.action === 'remove_child_board') {
      if (!params.person_name) {
        return { success: false, error: 'person_name is required for remove_child_board.' };
      }

      // Check for linked tasks
      const linkedTasks = this.db.prepare(
        `SELECT id, title FROM tasks WHERE board_id = ? AND child_exec_enabled = 1 AND child_exec_person_id = ?`,
      ).all(params.board_id, params.person_name) as any[];

      if (linkedTasks.length > 0) {
        const ids = linkedTasks.map((t: any) => t.id).join(', ');
        return { success: false, error: `Cannot remove: person has linked tasks (${ids}). Unlink them first.` };
      }

      this.db.prepare(
        `DELETE FROM child_board_registrations WHERE parent_board_id = ? AND person_id = ?`,
      ).run(params.board_id, params.person_name);

      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES (?, 'BOARD', 'child_board_removed', ?, ?, json_object('person_id', ?))`,
      ).run(params.board_id, params.sender_name, now, params.person_name);

      return { success: true, message: `Child board for '${params.person_name}' removed.` };
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "hierarchy remove_child_board"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(taskflow): add remove_child_board hierarchy action"
```

---

### Task 4: Add `log_attachment` admin action

Replaces `INSERT INTO attachment_audit_log (...)`.

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:176` (AdminParams action union + new fields)
- Modify: `container/agent-runner/src/taskflow-engine.ts` (admin() method body)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('admin log_attachment', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, BOARD_ID);
    engine = new TaskflowEngine(db, BOARD_ID);
  });
  afterEach(() => { db.close(); });

  it('inserts an attachment audit log entry', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'log_attachment',
      sender_name: 'Alexandre',
      attachment_source: 'whatsapp',
      attachment_filename: 'report.pdf',
      affected_task_refs: ['T1', 'T3'],
    });
    expect(result.success).toBe(true);

    const row = db.prepare(
      `SELECT * FROM attachment_audit_log WHERE board_id = ?`,
    ).get(BOARD_ID) as any;
    expect(row).toBeDefined();
    expect(row.source).toBe('whatsapp');
    expect(row.filename).toBe('report.pdf');
    expect(JSON.parse(row.affected_task_refs)).toEqual(['T1', 'T3']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "admin log_attachment"`
Expected: FAIL

- [ ] **Step 3: Extend AdminParams**

Add `'log_attachment'` to the action union and add new optional fields:

```typescript
  action: '...' | 'log_attachment';
  // ... existing fields ...
  attachment_source?: string;
  attachment_filename?: string;
  affected_task_refs?: string[];
```

- [ ] **Step 4: Implement the action**

Like `ack_welcome`, place this **before** the permission check since it's agent-internal:

```typescript
    // log_attachment is agent-internal — skip permission check
    if (params.action === 'log_attachment') {
      if (!params.attachment_source || !params.attachment_filename) {
        return { success: false, error: 'attachment_source and attachment_filename are required.' };
      }
      const now = new Date().toISOString();
      // Resolve sender to person_id using the existing resolvePerson method
      const person = this.resolvePerson(params.sender_name);
      const actorId = person?.person_id ?? null;
      const refs = JSON.stringify(params.affected_task_refs ?? []);

      this.db.prepare(
        `INSERT INTO attachment_audit_log (board_id, source, filename, at, actor_person_id, affected_task_refs)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(params.board_id, params.attachment_source, params.attachment_filename, now, actorId, refs);

      return { success: true, message: 'Attachment logged.' };
    }
```

Note: `resolvePerson(name)` is at ~line 802 of the engine. It takes a single name argument and returns `{ person_id, name }` or undefined. If the method is private, use `params.sender_name` directly as `actorId` instead.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "admin log_attachment"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(taskflow): add log_attachment admin action"
```

---

### Task 5: Extend MCP tool schemas for new actions

The `taskflow_admin` and `taskflow_hierarchy` MCP tools need their Zod schemas updated to expose the new actions.

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:708` (taskflow_admin action enum)
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:731` (taskflow_admin params — add new fields)
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:787` (taskflow_hierarchy action enum)

- [ ] **Step 1: Update taskflow_admin action enum**

At line 708, add the new actions to the `z.enum()`:

```typescript
action: z.enum(['register_person', 'remove_person', 'add_manager', 'add_delegate', 'remove_admin', 'set_wip_limit', 'cancel_task', 'restore_task', 'process_inbox', 'manage_holidays', 'process_minutes', 'process_minutes_decision', 'ack_welcome', 'sync_display_name', 'log_attachment']).describe('Admin action'),
```

- [ ] **Step 2: Add new parameter fields to taskflow_admin schema**

Add after the existing fields (before the closing `},` of the schema object around line 731):

```typescript
        display_name: z.string().optional().describe('New display name (for sync_display_name)'),
        attachment_source: z.string().optional().describe('Attachment source (for log_attachment, e.g., "whatsapp")'),
        attachment_filename: z.string().optional().describe('Attachment filename (for log_attachment)'),
        affected_task_refs: z.array(z.string()).optional().describe('Task IDs affected by the attachment (for log_attachment)'),
```

- [ ] **Step 3: Update taskflow_hierarchy action enum**

At line 787, add `remove_child_board`:

```typescript
action: z.enum(['link', 'unlink', 'refresh_rollup', 'tag_parent', 'remove_child_board']).describe('Hierarchy action'),
```

- [ ] **Step 4: Build to verify types compile**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(taskflow): extend MCP schemas for new admin and hierarchy actions"
```

---

## Chunk 2: Template & Tests

### Task 6: Remove SQL write instructions from template

Replace all 5 agent-authored SQL writes with tool calls.

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`

- [ ] **Step 1: Replace welcome SQL (around line 15)**

Change from:
```
1. Query: `SELECT welcome_sent FROM board_runtime_config WHERE board_id = '{{BOARD_ID}}'`
2. If `welcome_sent = 0`: send a brief welcome, then `UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = '{{BOARD_ID}}'`
```

To:
```
1. Query: `SELECT welcome_sent FROM board_runtime_config WHERE board_id = '{{BOARD_ID}}'`
2. If `welcome_sent = 0`: send a brief welcome, then `taskflow_admin({ action: 'ack_welcome', sender_name: SENDER })`
```

- [ ] **Step 2: Replace display-name SQL (around line 54)**

Change from:
```
**Auto-update display name**: When matched via first-name or single-person fallback, UPDATE `board_people SET name = '<full sender display name>' WHERE board_id = '{{BOARD_ID}}' AND person_id = '<matched_person_id>'` so future messages match exactly.
```

To:
```
**Auto-update display name**: When matched via first-name or single-person fallback, call `taskflow_admin({ action: 'sync_display_name', sender_name: SENDER, person_name: '<matched_person_id>', display_name: '<full sender display name>' })` so future messages match exactly.
```

- [ ] **Step 3: Replace child board removal SQL (around line 656)**

Change the child board removal instruction from raw SQL to use the new hierarchy action. The linked-tasks check uses a read-only SQL query (reads remain allowed):
```
| "remover quadro do [pessoa]" | 1. Check linked tasks: `SELECT id, title FROM tasks WHERE board_id = '{{BOARD_ID}}' AND child_exec_enabled = 1 AND child_exec_person_id = ?` — refuse if any exist (must unlink first). 2. Ask explicit confirmation ("remover quadro é irreversível"). 3. `taskflow_hierarchy({ action: 'remove_child_board', task_id: 'BOARD', person_name: '[person_id]', sender_name: SENDER })`. Note: the child board remains operational but detached from this hierarchy. |
```

- [ ] **Step 4: Replace attachment audit SQL (around line 841)**

Change from:
```
- Record in `attachment_audit_log`: `INSERT INTO attachment_audit_log (board_id, source, filename, at, actor_person_id, affected_task_refs) VALUES (...)`
```

To:
```
- Record in audit log: `taskflow_admin({ action: 'log_attachment', sender_name: SENDER, attachment_source: '<source>', attachment_filename: '<filename>', affected_task_refs: ['T1', 'T3'] })`
```

- [ ] **Step 5: Remove the write_query fallback section (around lines 91-107)**

**IMPORTANT:** Preserve the board visibility filter paragraph (around lines 96-100) — it applies to read queries too.

Remove the SQL fallback guidance (lines ~91-94):
```
**SQL fallback:** Use `mcp__sqlite__read_query` for READ queries by default. Use `mcp__sqlite__write_query` only as a last resort...
```

Remove the compliance rules for SQL mutations (lines ~102-109):
```
**When writing mutations via SQL, always:**
1. Include the board visibility filter...
```

Replace both removed blocks (but **keep** the board visibility filter paragraph between them) with:
```
**SQL access:** Use `mcp__sqlite__read_query` for READ queries only. All mutations MUST go through `taskflow_*` tools — direct SQL writes are not available. If no `taskflow_*` tool exists for an operation, capture it to inbox or ask the user for guidance. Missing TaskFlow tools is a runtime error, not a reason to improvise SQL writes.
```

- [ ] **Step 6: Run template tests to verify no breakage**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: Some tests will fail (the ones asserting `mcp__sqlite__write_query` presence) — that's expected and will be fixed in Task 7.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "refactor(taskflow): remove SQL write instructions from template"
```

---

### Task 7: Update template test assertions

**Files:**
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [ ] **Step 1: Update mcp__sqlite__write_query assertions**

At line ~587, the test `CLAUDE.md.template MCP tool guidance uses mcp__sqlite__read_query and write_query`:
- Change `expect(content).toContain('mcp__sqlite__write_query');` to `expect(content).not.toContain('mcp__sqlite__write_query');`
- Verify it still asserts `expect(content).toContain('mcp__sqlite__read_query');`

At line ~1496, the test `CLAUDE.md.template hierarchy uses mcp__sqlite__ prefixed tools`:
- Change `expect(content).toContain('mcp__sqlite__write_query');` to `expect(content).not.toContain('mcp__sqlite__write_query');`

- [ ] **Step 2: Update write_query assertion**

At line ~449, the test `CLAUDE.md.template v2 uses Tool vs. Direct SQL section instead of Load Data First`:
- The test already has `expect(toolSection).toContain('read_query')` on line 448, so don't duplicate that
- Change `expect(toolSection).toContain('write_query');` to `expect(toolSection).not.toContain('write_query');`

- [ ] **Step 3: Add assertions for new tool calls in template**

Add new test:
```typescript
it('CLAUDE.md.template uses taskflow_admin for metadata writes instead of SQL', () => {
  expect(content).toContain("action: 'ack_welcome'");
  expect(content).toContain("action: 'sync_display_name'");
  expect(content).toContain("action: 'log_attachment'");
  expect(content).not.toContain('UPDATE board_runtime_config SET welcome_sent');
  expect(content).not.toContain('UPDATE board_people SET name');
  expect(content).not.toContain('INSERT INTO attachment_audit_log');
});

it('CLAUDE.md.template uses taskflow_hierarchy for child board removal instead of SQL', () => {
  expect(content).toContain("action: 'remove_child_board'");
  expect(content).not.toContain('DELETE FROM child_board_registrations');
});
```

- [ ] **Step 4: Run all template tests**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: All 195+ tests PASS

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "test(taskflow): update assertions for SQL write removal"
```

---

## Chunk 3: Runtime Enforcement

### Task 8: Add `NANOCLAW_ALLOWED_TOOLS_TASKFLOW` to runtime config

**Files:**
- Modify: `container/agent-runner/src/runtime-config.ts:17-38`
- Modify: `container/agent-runner/src/runtime-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `container/agent-runner/src/runtime-config.test.ts`:

```typescript
import {
  buildNanoclawMcpEnv,
  NANOCLAW_ALLOWED_TOOLS,
  NANOCLAW_ALLOWED_TOOLS_TASKFLOW,
} from './runtime-config.js';

// ... inside describe block:
it('restricts TaskFlow groups to read-only SQLite', () => {
  expect(NANOCLAW_ALLOWED_TOOLS_TASKFLOW).toContain('mcp__sqlite__read_query');
  expect(NANOCLAW_ALLOWED_TOOLS_TASKFLOW).toContain('mcp__sqlite__list_tables');
  expect(NANOCLAW_ALLOWED_TOOLS_TASKFLOW).toContain('mcp__sqlite__describe_table');
  expect(NANOCLAW_ALLOWED_TOOLS_TASKFLOW).not.toContain('mcp__sqlite__*');
  expect(NANOCLAW_ALLOWED_TOOLS_TASKFLOW).not.toContain('mcp__sqlite__write_query');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run container/agent-runner/src/runtime-config.test.ts -t "restricts TaskFlow"`
Expected: FAIL — `NANOCLAW_ALLOWED_TOOLS_TASKFLOW` not exported

- [ ] **Step 3: Implement in runtime-config.ts**

Refactor into a shared base and two exports. Replace lines 17-38:

```typescript
const BASE_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
] as const;

/** Non-TaskFlow groups: full SQLite access. */
export const NANOCLAW_ALLOWED_TOOLS = [
  ...BASE_ALLOWED_TOOLS,
  'mcp__sqlite__*',
] as const;

/** TaskFlow groups: read-only SQLite (writes go through taskflow_* tools). */
export const NANOCLAW_ALLOWED_TOOLS_TASKFLOW = [
  ...BASE_ALLOWED_TOOLS,
  'mcp__sqlite__read_query',
  'mcp__sqlite__list_tables',
  'mcp__sqlite__describe_table',
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run container/agent-runner/src/runtime-config.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/runtime-config.ts container/agent-runner/src/runtime-config.test.ts
git commit -m "feat(taskflow): add NANOCLAW_ALLOWED_TOOLS_TASKFLOW with read-only SQLite"
```

---

### Task 9: Add Bash `taskflow.db` write guard

**Files:**
- Modify: `container/agent-runner/src/index.ts:209-226` (createSanitizeBashHook)
- Modify: `container/agent-runner/src/index.ts` (hook registration call site)

- [ ] **Step 1: Extend createSanitizeBashHook with blockTaskflowWrites parameter**

Replace the function at lines 209-226:

```typescript
function createSanitizeBashHook(blockTaskflowWrites = false): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    if (blockTaskflowWrites) {
      const hasWriteKeyword = /\b(update|insert|delete|drop|alter|replace)\b/i.test(command);
      const targetsTaskflowDb = /taskflow\.db|\/workspace\/taskflow/i.test(command);
      if (hasWriteKeyword && targetsTaskflowDb) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: {
              ...(preInput.tool_input as Record<string, unknown>),
              command: 'echo "ERROR: Direct writes to taskflow.db are blocked. Use taskflow_create, taskflow_move, taskflow_update, or taskflow_reassign tools instead." >&2; exit 1',
            },
          },
        };
      }
    }

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}
```

- [ ] **Step 2: Pass isTaskflowManaged to the hook**

Find the hook registration line (around line 496):

```typescript
PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
```

Change to:

```typescript
PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook(containerInput.isTaskflowManaged ?? false)] }],
```

- [ ] **Step 3: Build to verify types compile**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Manual verification**

Test positive case (read-only commands should pass through):
```bash
# Simulate a read-only sqlite3 command — should NOT be blocked:
echo "sqlite3 /workspace/taskflow/taskflow.db 'SELECT * FROM tasks'" | grep -P '\b(update|insert|delete|drop|alter|replace)\b' && echo "BLOCKED" || echo "PASS"
```

Test negative case (write commands should be blocked):
```bash
# Simulate a write command — should be blocked:
echo "sqlite3 /workspace/taskflow/taskflow.db 'UPDATE tasks SET status = 1'" | grep -iP '\b(update|insert|delete|drop|alter|replace)\b' && echo "BLOCKED" || echo "PASS"
```

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(taskflow): add Bash taskflow.db write guard"
```

---

### Task 10: Add fail-closed startup guard

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:502-510`

- [ ] **Step 1: Add fail-closed guards for missing boardId and missing DB file**

Find the TaskFlow registration block (around line 502):

```typescript
if (process.env.NANOCLAW_IS_TASKFLOW_MANAGED === '1') {
  const dbPath = '/workspace/taskflow/taskflow.db';
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;

  if (boardId) {
```

Replace with inverted guards that exit early, then remove the `if (boardId)` wrapper (the code continues at the same nesting level since `boardId` is guaranteed truthy after the guard):

```typescript
if (process.env.NANOCLAW_IS_TASKFLOW_MANAGED === '1') {
  const dbPath = '/workspace/taskflow/taskflow.db';
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;

  if (!boardId) {
    console.error(
      '[ipc-mcp-stdio] FATAL: NANOCLAW_IS_TASKFLOW_MANAGED=1 but NANOCLAW_TASKFLOW_BOARD_ID is not set. ' +
      'TaskFlow tools cannot register without a board ID. Exiting.',
    );
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(
      `[ipc-mcp-stdio] FATAL: NANOCLAW_IS_TASKFLOW_MANAGED=1 but ${dbPath} does not exist. ` +
      'TaskFlow DB must be mounted. Exiting.',
    );
    process.exit(1);
  }
```

Add `import fs from 'node:fs';` at the top of the file if not already present.

Also remove the old `if (boardId) {` line and its corresponding closing `}` brace — the code inside now runs unconditionally after the guards.

Note: `fs` is already imported at line 9 of `ipc-mcp-stdio.ts` — no new import needed.

- [ ] **Step 2: Wrap tool registration in try/catch for fail-closed on registration errors**

After the guards, wrap the entire `server.tool(...)` registration block in a try/catch so that a registration failure (e.g., engine constructor throws, schema mismatch) also exits:

```typescript
  try {
    const engine = new TaskflowEngine(db, boardId);
    // ... existing server.tool() calls ...
  } catch (err) {
    console.error(
      '[ipc-mcp-stdio] FATAL: TaskFlow tool registration failed:',
      err,
    );
    process.exit(1);
  }
```

This satisfies the design requirement: "required `taskflow_*` tools fail to register → exit."

- [ ] **Step 3: Build to verify types compile**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(taskflow): fail-closed startup when TaskFlow board ID is missing"
```

---

### Task 11: Wire TaskFlow allowed tools into session config

**Files:**
- Modify: `container/agent-runner/src/index.ts:465` (allowedTools line)
- Modify: `container/agent-runner/src/index.ts` (imports)

- [ ] **Step 1: Update import**

Change:
```typescript
import {
  buildNanoclawMcpEnv,
  ContainerInput,
  NANOCLAW_ALLOWED_TOOLS,
} from './runtime-config.js';
```

To:
```typescript
import {
  buildNanoclawMcpEnv,
  ContainerInput,
  NANOCLAW_ALLOWED_TOOLS,
  NANOCLAW_ALLOWED_TOOLS_TASKFLOW,
} from './runtime-config.js';
```

- [ ] **Step 2: Wire conditional allowed tools**

Change line 465:
```typescript
allowedTools: [...NANOCLAW_ALLOWED_TOOLS],
```

To:
```typescript
allowedTools: [...(containerInput.isTaskflowManaged ? NANOCLAW_ALLOWED_TOOLS_TASKFLOW : NANOCLAW_ALLOWED_TOOLS)],
```

- [ ] **Step 3: Build to verify types compile**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(taskflow): restrict TaskFlow groups to read-only SQLite tools"
```

---

## Chunk 4: Sync & Deploy

> **Note:** Tasks 12 and 13 are operational/deployment steps. They fall outside the design spec's architectural scope but are necessary for the implementation to take effect.

### Task 12: Sync all skill parity copies

Every runtime file modified in Tasks 1-11 must be mirrored to its skill copy.

**Files:**
- Copy: `container/agent-runner/src/taskflow-engine.ts` → `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- Copy: `container/agent-runner/src/runtime-config.ts` → `.claude/skills/add-taskflow/add/container/agent-runner/src/runtime-config.ts`
- Copy: `container/agent-runner/src/runtime-config.test.ts` → `.claude/skills/add-taskflow/add/container/agent-runner/src/runtime-config.test.ts`
- Copy: `container/agent-runner/src/ipc-mcp-stdio.ts` → `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- Copy: `container/agent-runner/src/index.ts` → `.claude/skills/add-taskflow/modify/container/agent-runner/src/index.ts`

**Important:** The skill copy of `taskflow-engine.ts` may be ahead of the runtime copy (160 lines larger). Apply the same engine changes (new actions in `admin()` and `hierarchy()`, extended type unions) to the skill copy rather than blindly overwriting. Compare both files first.

- [ ] **Step 1: Diff runtime vs skill engine and apply changes**

```bash
diff container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts | head -80
```

The skill copy is ~160 lines larger (has additional features). **Do NOT overwrite it.** Instead, apply these specific changes to the skill copy:

1. **AdminParams action union**: Search for `'process_minutes_decision'` in the skill file's `AdminParams` interface. Append `| 'ack_welcome' | 'sync_display_name' | 'log_attachment'` to the action union.
2. **AdminParams new fields**: Add `display_name?: string;`, `attachment_source?: string;`, `attachment_filename?: string;`, `affected_task_refs?: string[];` to the interface.
3. **HierarchyParams action union**: Search for `'tag_parent'` in `HierarchyParams`. Append `| 'remove_child_board'`.
4. **admin() method body**: Search for the `admin(` method. Add the `ack_welcome`, `sync_display_name`, and `log_attachment` handlers before the permission check (same code as Tasks 1, 2, 4).
5. **hierarchy() method body**: Search for the `hierarchy(` method. Add the `remove_child_board` handler (same code as Task 3).

- [ ] **Step 2: Sync remaining files**

```bash
cp container/agent-runner/src/runtime-config.ts .claude/skills/add-taskflow/add/container/agent-runner/src/runtime-config.ts
cp container/agent-runner/src/runtime-config.test.ts .claude/skills/add-taskflow/add/container/agent-runner/src/runtime-config.test.ts
cp container/agent-runner/src/ipc-mcp-stdio.ts .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts
cp container/agent-runner/src/index.ts .claude/skills/add-taskflow/modify/container/agent-runner/src/index.ts
```

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts
npx vitest run container/agent-runner/src/runtime-config.test.ts
```

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/add-taskflow/
git commit -m "chore(taskflow): sync skill copies with runtime"
```

---

### Task 13: Build and deploy

- [ ] **Step 1: Build host project**

```bash
npm run build
```

Expected: Clean compilation

- [ ] **Step 2: Build container**

```bash
./container/build.sh
```

Expected: Successful Docker image build

- [ ] **Step 3: Transfer to remote**

```bash
docker save nanoclaw-agent | ssh nanoclaw@192.168.2.63 'docker load'
```

- [ ] **Step 4: Restart service on remote**

```bash
ssh nanoclaw@192.168.2.63 'systemctl --user restart nanoclaw'
```

- [ ] **Step 5: Verify container has new tools**

SSH into remote and check that a TaskFlow container registers the new actions:

```bash
ssh nanoclaw@192.168.2.63 'tail -100 ~/nanoclaw/logs/nanoclaw.log | grep -i taskflow'
```

- [ ] **Step 6: Verify new actions are registered**

```bash
ssh nanoclaw@192.168.2.63 'tail -200 ~/nanoclaw/logs/nanoclaw.log | grep -i "ack_welcome\|remove_child_board\|taskflow"'
```

Expected: Log entries showing TaskFlow tool registration for the new actions.

---

## Chunk 5: Validation (Design Phase 4)

The design spec (Phase 4: Validation) requires verifying that standard TaskFlow workflows still work and that enforcement is effective. These tasks cover the design's success criteria.

### Task 14: Workflow regression validation

Verify all standard TaskFlow workflows listed in the design still work after the changes.

- [ ] **Step 1: Verify welcome flow**

Trigger a welcome flow in a TaskFlow group. Confirm the agent calls `taskflow_admin({ action: 'ack_welcome' })` instead of raw SQL.

Check: `grep -r "ack_welcome" data/sessions/` after a test interaction, or inspect container logs.

- [ ] **Step 2: Verify sender identity fallback and display-name sync**

Send a message from a known sender using a first-name match. Confirm the agent calls `taskflow_admin({ action: 'sync_display_name' })`.

- [ ] **Step 3: Verify create/move/update/reassign**

Perform standard task operations in a TaskFlow group. Confirm `taskflow_create`, `taskflow_move`, `taskflow_update`, `taskflow_reassign` all work normally.

- [ ] **Step 4: Verify inbox fallback**

Attempt an operation that has no `taskflow_*` tool. Confirm the agent captures to inbox rather than improvising SQL writes.

- [ ] **Step 5: Verify child board removal (if applicable)**

If a test board has child board registrations, test the removal flow via `taskflow_hierarchy({ action: 'remove_child_board' })`.

- [ ] **Step 6: Verify attachment import auditing**

Send a file attachment in a TaskFlow group. Confirm the agent calls `taskflow_admin({ action: 'log_attachment' })`.

---

### Task 15: Enforcement negative testing

Verify TaskFlow groups cannot mutate `taskflow.db` via SQL tool or Bash.

- [ ] **Step 1: Verify SQL write tool is blocked**

In a TaskFlow container, attempt to use `mcp__sqlite__write_query`. It should not be in the allowed tools list and should fail:

```bash
ssh nanoclaw@192.168.2.63 "grep -r 'mcp__sqlite__write_query' ~/nanoclaw/logs/nanoclaw.log | tail -5"
```

Alternatively, check allowed tools in the session config output.

- [ ] **Step 2: Verify Bash write guard blocks SQL mutations**

In a TaskFlow container, attempt a Bash command that targets `taskflow.db` with a write verb. Confirm the guard intercepts and returns the error message.

Test commands to try via the agent:
- `sqlite3 /workspace/taskflow/taskflow.db "UPDATE tasks SET status = 'done'"`  → should be blocked
- `sqlite3 /workspace/taskflow/taskflow.db "INSERT INTO tasks VALUES (...)"` → should be blocked
- `sqlite3 /workspace/taskflow/taskflow.db "SELECT * FROM tasks"` → should pass (read-only)

- [ ] **Step 3: Verify read-only SQL still works**

In a TaskFlow group, confirm the agent can still use `mcp__sqlite__read_query` for inspection and ad-hoc read-only answers.

- [ ] **Step 4: Document results**

Record pass/fail for each test case. If any fail, file as a follow-up issue before marking this plan complete.
