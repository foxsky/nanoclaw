# Meeting Notes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add meeting management to TaskFlow — scheduled meetings with M-prefix IDs, participants, phase-tagged notes, structured minutes output, atomic outcome conversion, and recurring meeting support.

**Architecture:** New `meeting` task type layered onto the packaged TaskFlow skill runtime snapshots, not the live runtime. Schema extends `tasks` with `participants TEXT` and `scheduled_at TEXT` columns. Notes gain meeting-only metadata fields (`phase`, `parent_note_id`, `status`, `processed_at`, `processed_by`, `created_task_id`). Engine methods (`create`, `update`, `move`, `query`, `admin`, `report`, `formatBoardView`, `advanceRecurringTask`) get meeting-specific branches. MCP schema and CLAUDE.md template updated last.

**Implementation boundary:** This plan is skill-package-only. All code changes must stay under `.claude/skills/add-taskflow/**`:

- bundled engine snapshot: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- bundled engine snapshot tests: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts`
- bundled MCP schema snapshot: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- bundled DB snapshot: `.claude/skills/add-taskflow/add/src/taskflow-db.ts`
- active template: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- included skill regression suite: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

Do not modify `container/agent-runner/src/**`, `src/**`, generated group files, builds, or deployment targets as part of this plan.

**Testing note:** the repo's Vitest include globs currently discover `.claude/skills/**/tests/**/*.test.ts`, not the mirrored snapshot tests under `add/container/...`. You may still update the mirrored snapshot test file for completeness, but every implemented feature must also be pinned from `.claude/skills/add-taskflow/tests/taskflow.test.ts`, and the runnable verification command for this plan is the included skill suite.

**Important design constraint:** recurring meeting history cannot rely on the single-row `archive` table keyed by `(board_id, task_id)`, because the approved design requires multiple past occurrences of the same recurring meeting to remain queryable. Use `task_history` entries (for example, a `meeting_occurrence_archived` action with a structured `details` payload) or a dedicated occurrence-history structure, but do not model recurring occurrences as repeated `archive` rows for the same task ID.

**Tech Stack:** TypeScript, better-sqlite3 (sync), Vitest, Zod (MCP schema validation)

**Design doc:** `docs/plans/2026-03-08-meeting-notes-design.md` (451 lines, approved)

---

## Task 1: Schema Migration — `participants` and `scheduled_at` columns

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:505-535` (ensureSchema method in bundled snapshot)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts:8-20` (SCHEMA constant in bundled snapshot test)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts` (included skill regression suite; mirror focused cases in the bundled snapshot test if desired)

**Step 1: Write the failing test**

Add a new describe block at the end of the test file:

```typescript
describe('meeting notes', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, BOARD_ID);
    engine = new TaskflowEngine(db, BOARD_ID);
  });

  afterEach(() => {
    db.close();
  });

  it('schema has participants and scheduled_at columns on tasks', () => {
    const cols = db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('participants');
    expect(colNames).toContain('scheduled_at');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "schema has participants"`
Expected: FAIL — columns don't exist yet

**Step 3: Implement schema migration**

In `taskflow-engine.ts`, inside `ensureSchema()` (around line 530), add two migration statements alongside the existing ones:

```typescript
ignoreDuplicateColumnError(() =>
  this.db.exec(`ALTER TABLE tasks ADD COLUMN participants TEXT`),
);
ignoreDuplicateColumnError(() =>
  this.db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_at TEXT`),
);
```

Also update the SCHEMA constant in the test file to include both columns in the `CREATE TABLE tasks` statement (add them after `recurrence_end_date`):

```sql
participants TEXT, scheduled_at TEXT,
```

**Step 4: Run test to verify it passes**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "schema has participants"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.test.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): add participants and scheduled_at schema columns"
```

---

## Task 2: `create()` — accept `type: 'meeting'`, M-prefix, participants, scheduled_at

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:33-48` (CreateParams interface in bundled snapshot)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:1314-1424` (create method body in bundled snapshot)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing tests**

Add inside the `meeting notes` describe block:

```typescript
describe('create meeting', () => {
  it('creates a meeting with M prefix and next_action column', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Alinhamento semanal',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    expect(result.task_id).toMatch(/^M\d+$/);
    expect(result.column).toBe('next_action');
  });

  it('auto-sets organizer (assignee) to sender', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Kickoff',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT assignee FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, result.task_id) as { assignee: string };
    expect(task.assignee).toBe('person-1');
  });

  it('stores participants as JSON array', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Sprint review',
      participants: ['Giovanni'],
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, result.task_id) as { participants: string };
    const parts = JSON.parse(task.participants);
    expect(parts).toContain('person-2');
  });

  it('stores scheduled_at in UTC', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Planning',
      scheduled_at: '2026-03-15T17:00:00Z',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, result.task_id) as { scheduled_at: string };
    expect(task.scheduled_at).toBe('2026-03-15T17:00:00Z');
  });

  it('creates meeting without scheduled_at (unscheduled draft)', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'TBD meeting',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, result.task_id) as { scheduled_at: string | null };
    expect(task.scheduled_at).toBeNull();
  });

  it('defaults recurrence_anchor to scheduled_at for recurring meetings', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Weekly sync',
      scheduled_at: '2026-03-15T17:00:00Z',
      recurrence: 'weekly',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT recurrence, scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, result.task_id) as { recurrence: string; scheduled_at: string };
    expect(task.recurrence).toBe('weekly');
    expect(task.scheduled_at).toBe('2026-03-15T17:00:00Z');
  });

  it('rejects recurring meeting without scheduled_at', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Broken recurring meeting',
      recurrence: 'weekly',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('scheduled_at');
  });

  it('resolves participant names to person_ids', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Cross-team',
      participants: ['Giovanni', 'Alexandre'],
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, result.task_id) as { participants: string };
    const parts = JSON.parse(task.participants);
    expect(parts).toContain('person-1');
    expect(parts).toContain('person-2');
  });

  it('returns error for unresolved participant', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Bad meeting',
      participants: ['Unknown Person'],
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(false);
  });

  it('notifies all participants on creation', () => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Notif test',
      participants: ['Giovanni'],
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    expect(result.notifications).toBeDefined();
    expect(result.notifications!.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "create meeting"`
Expected: FAIL — `meeting` is not an accepted type

**Step 3: Implement create() meeting support**

In `taskflow-engine.ts`:

1. **Update `CreateParams` interface** (line 35):
```typescript
type: 'simple' | 'project' | 'recurring' | 'inbox' | 'meeting';
```

2. **Add meeting fields to CreateParams** (after `recurrence_end_date`, line 46):
```typescript
participants?: string[];
scheduled_at?: string;
```

3. **Update prefix mapping** (line 1315-1320):
```typescript
const prefix =
  params.type === 'project'
    ? 'P'
    : params.type === 'recurring'
      ? 'R'
      : params.type === 'meeting'
        ? 'M'
        : 'T';
```

4. **Update column placement** (line 1325) — meetings always go to `next_action` with auto-organizer:
```typescript
/* --- Auto-set organizer for meetings --- */
if (params.type === 'meeting' && !assigneePersonId) {
  const senderPerson = this.resolvePerson(params.sender_name);
  if (senderPerson) assigneePersonId = senderPerson.person_id;
}

/* --- Column placement --- */
const column = params.type === 'inbox' || (!assigneePersonId && params.type !== 'meeting')
  ? 'inbox'
  : 'next_action';
```

5. **Resolve participants** (after column placement):
```typescript
/* --- Participant resolution (meetings only) --- */
let participantIds: string[] | null = null;
if (params.type === 'meeting' && params.participants) {
  participantIds = [];
  for (const pName of params.participants) {
    const person = this.resolvePerson(pName);
    if (!person) return this.buildOfferRegisterError(pName);
    participantIds.push(person.person_id);
  }
}
```

6. **Handle recurrence for meetings** — update the recurrence block (line 1348) to accept meeting type:
```typescript
if ((params.type === 'recurring' || params.type === 'project' || params.type === 'meeting') && params.recurrence) {
```

7. **Default recurrence_anchor for meetings** (after recurrence block):
```typescript
/* --- Default recurrence_anchor for recurring meetings --- */
if (params.type === 'meeting' && params.recurrence && params.scheduled_at && !params.recurrence_anchor) {
  params = { ...params, recurrence_anchor: params.scheduled_at };
}
```

Also add explicit validation before recurrence handling:

```typescript
if (params.type === 'meeting' && params.recurrence && !params.scheduled_at) {
  return { success: false, error: 'Recurring meetings require scheduled_at for the first occurrence.' };
}
```

And keep `scheduled_at` as the canonical schedule for meetings:

```typescript
if (params.type !== 'meeting' && (params.type === 'recurring' || params.type === 'project') && params.recurrence && !dueDate) {
  dueDate = advanceDateByRecurrence(baseDateForRecurrence, params.recurrence);
}
```

Meeting recurrence should never auto-populate `due_date`; for meetings, `due_date` remains `NULL` by default and recurrence advances `scheduled_at`.

8. **Update INSERT** (line 1394-1424) — add `participants` and `scheduled_at` columns:
```typescript
this.db
  .prepare(
    `INSERT INTO tasks (
      id, board_id, type, title, assignee, column,
      priority, due_date, labels, recurrence,
      max_cycles, recurrence_end_date,
      child_exec_enabled, child_exec_board_id, child_exec_person_id,
      participants, scheduled_at,
      _last_mutation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    participantIds ? JSON.stringify(participantIds) : null,
    params.scheduled_at ?? null,
    lastMutation,
    now,
    now,
  );
```

9. **Type mapping** (line 1328) — meetings store as `meeting`, not `simple`:
```typescript
const storedType = params.type === 'inbox' ? 'simple' : params.type;
```

10. **Participant notifications on create** (after existing notifications block):
```typescript
/* Notify participants (meetings) */
if (participantIds && participantIds.length > 0) {
  for (const pid of participantIds) {
    if (pid === senderPersonId) continue; // don't notify organizer
    if (pid === assigneePersonId) continue; // already notified as assignee
    const notif = this.buildCreateNotification(
      { id: taskId, title: params.title, assignee: pid, due_date: dueDate, priority: params.priority, column },
      senderPersonId,
    );
    if (notif) notifications.push(notif);
  }
}
```

11. **History details** — add meeting fields:
```typescript
if (participantIds) detailsSummary.participants = participantIds;
if (params.scheduled_at) detailsSummary.scheduled_at = params.scheduled_at;
```

**Step 4: Run tests to verify they pass**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "create meeting"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): create() accepts meeting type with M-prefix, participants, scheduled_at"
```

---

## Task 3: `update()` — meeting note metadata, participants, scheduled_at, set_note_status

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:106-131` (UpdateParams interface in bundled snapshot)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:2397-2434` (note handling in bundled update path)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing tests**

```typescript
describe('update meeting', () => {
  let meetingId: string;

  beforeEach(() => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Test meeting',
      scheduled_at: '2026-03-15T17:00:00Z',
      participants: ['Giovanni'],
      sender_name: 'Alexandre',
    });
    meetingId = result.task_id!;
  });

  it('add_note auto-tags phase=pre when meeting is in next_action', () => {
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Revisar orçamento Q2' },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, meetingId) as { notes: string };
    const notes = JSON.parse(task.notes);
    expect(notes[0].phase).toBe('pre');
    expect(notes[0].status).toBe('open');
  });

  it('add_note with parent_note_id links to parent', () => {
    // Add agenda item first
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Agenda item 1' },
    });
    // Add reply
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Giovanni',
      updates: { add_note: 'Reply to agenda 1', parent_note_id: 1 },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, meetingId) as { notes: string };
    const notes = JSON.parse(task.notes);
    expect(notes[1].parent_note_id).toBe(1);
  });

  it('add_note auto-tags phase=meeting when in_progress', () => {
    engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'start', sender_name: 'Alexandre' });
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Discussion point' },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, meetingId) as { notes: string };
    const notes = JSON.parse(task.notes);
    const lastNote = notes[notes.length - 1];
    expect(lastNote.phase).toBe('meeting');
  });

  it('add_note auto-tags phase=post when in review', () => {
    engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'start', sender_name: 'Alexandre' });
    engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'review', sender_name: 'Alexandre' });
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Post-meeting reflection' },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, meetingId) as { notes: string };
    const notes = JSON.parse(task.notes);
    const lastNote = notes[notes.length - 1];
    expect(lastNote.phase).toBe('post');
  });

  it('set_note_status changes status from open to checked', () => {
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Item to check' },
    });
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { set_note_status: { id: 1, status: 'checked' } },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, meetingId) as { notes: string };
    const notes = JSON.parse(task.notes);
    expect(notes[0].status).toBe('checked');
    expect(notes[0].processed_at).toBeDefined();
    expect(notes[0].processed_by).toBe('Alexandre');
  });

  it('set_note_status can reopen a checked note', () => {
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Reopen test' },
    });
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { set_note_status: { id: 1, status: 'checked' } },
    });
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { set_note_status: { id: 1, status: 'open' } },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, meetingId) as { notes: string };
    const notes = JSON.parse(task.notes);
    expect(notes[0].status).toBe('open');
  });

  it('set_note_status dismissed', () => {
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Dismiss me' },
    });
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { set_note_status: { id: 1, status: 'dismissed' } },
    });
    expect(result.success).toBe(true);
  });

  it('add_participant adds a person', () => {
    // Create meeting without Giovanni
    const r = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Add participant test',
      sender_name: 'Alexandre',
    });
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: r.task_id!,
      sender_name: 'Alexandre',
      updates: { add_participant: 'Giovanni' },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, r.task_id!) as { participants: string };
    const parts = JSON.parse(task.participants);
    expect(parts).toContain('person-2');
  });

  it('remove_participant removes a person', () => {
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { remove_participant: 'Giovanni' },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, meetingId) as { participants: string };
    const parts = JSON.parse(task.participants);
    expect(parts).not.toContain('person-2');
  });

  it('scheduled_at update reschedules meeting', () => {
    const result = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { scheduled_at: '2026-03-20T14:00:00Z' },
    });
    expect(result.success).toBe(true);
    const task = db
      .prepare(`SELECT scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, meetingId) as { scheduled_at: string };
    expect(task.scheduled_at).toBe('2026-03-20T14:00:00Z');
  });

  it('non-meeting note has no phase or status', () => {
    const r = engine.update({
      board_id: BOARD_ID,
      task_id: 'T-002',
      sender_name: 'Alexandre',
      updates: { add_note: 'Regular note' },
    });
    expect(r.success).toBe(true);
    const task = db
      .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
      .get(BOARD_ID, 'T-002') as { notes: string };
    const notes = JSON.parse(task.notes);
    expect(notes[0].phase).toBeUndefined();
    expect(notes[0].status).toBeUndefined();
  });

  it('participant can add note but not edit another participant note', () => {
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Manager note' },
    });
    // Giovanni (participant) adds a note — should succeed
    const addResult = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Giovanni',
      updates: { add_note: 'Participant note' },
    });
    expect(addResult.success).toBe(true);
    // Giovanni tries to edit manager's note — should fail
    const editResult = engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Giovanni',
      updates: { edit_note: { id: 1, text: 'Tampered note' } },
    });
    expect(editResult.success).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "update meeting"`
Expected: FAIL

**Step 3: Implement update() meeting support**

1. **Extend `UpdateParams.updates`** (after line 129):
```typescript
parent_note_id?: number;
scheduled_at?: string;
add_participant?: string;
remove_participant?: string;
set_note_status?: { id: number; status: 'open' | 'checked' | 'task_created' | 'inbox_created' | 'dismissed' };
```

2. **Phase determination helper** (add as a private method):
```typescript
private getMeetingNotePhase(task: any): 'pre' | 'meeting' | 'post' | undefined {
  if (task.type !== 'meeting') return undefined;
  switch (task.column) {
    case 'next_action': return 'pre';
    case 'in_progress':
    case 'waiting': return 'meeting';
    case 'review':
    case 'done': return 'post';
    default: return undefined;
  }
}
```

3. **Move authorization context to the top of `update()`**:
```typescript
const senderPersonId = this.resolvePersonId(params.sender_name);
const isMgr = senderPersonId ? this.isManager(senderPersonId) : false;
const isAssignee = !!task.assignee && senderPersonId === task.assignee;

const isMeetingNoteOperation =
  task.type === 'meeting' &&
  (updates.add_note !== undefined ||
    updates.edit_note !== undefined ||
    updates.remove_note !== undefined ||
    updates.set_note_status !== undefined);

if (!isMeetingNoteOperation && !isMgr && !isAssignee) {
  return { success: false, error: `Permission denied: "${params.sender_name}" is not the assignee or a manager.` };
}
```

This is required because meeting participants who are neither organizer nor manager must still be able to add and triage meeting notes.

4. **Update `add_note` handler** (line 2398) — add meeting metadata:
```typescript
/* Add note */
if (updates.add_note !== undefined) {
  // Meeting note authorization: participants can add notes
  if (task.type === 'meeting' && !isMgr && !isAssignee) {
    const participants: string[] = JSON.parse(task.participants ?? '[]');
    if (!participants.includes(senderPersonId ?? '')) {
      return { success: false, error: `Permission denied: "${params.sender_name}" is not a participant of this meeting.` };
    }
  }

  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const noteId = task.next_note_id ?? 1;
  const noteEntry: any = { id: noteId, text: updates.add_note, at: now, by: params.sender_name };

  // Meeting-only metadata
  const phase = this.getMeetingNotePhase(task);
  if (phase) {
    noteEntry.phase = phase;
    noteEntry.status = 'open';
  }
  if (updates.parent_note_id !== undefined) {
    // Validate parent exists
    const parentExists = notes.some((n: any) => n.id === updates.parent_note_id);
    if (!parentExists) {
      return { success: false, error: `Parent note #${updates.parent_note_id} not found.` };
    }
    noteEntry.parent_note_id = updates.parent_note_id;
  }

  notes.push(noteEntry);
  this.db
    .prepare(`UPDATE tasks SET notes = ?, next_note_id = ? WHERE board_id = ? AND id = ?`)
    .run(JSON.stringify(notes), noteId + 1, taskBoardId, task.id);
  changes.push(`Note #${noteId} added`);
}
```

5. **Update `edit_note` handler** — add meeting authorization:
```typescript
if (updates.edit_note !== undefined) {
  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const note = notes.find((n: any) => n.id === updates.edit_note!.id);
  if (!note) {
    return { success: false, error: `Note #${updates.edit_note.id} not found.` };
  }
  // Meeting note authorization: only author/organizer/manager can edit
  if (task.type === 'meeting' && !isMgr && !isAssignee && note.by !== params.sender_name) {
    return { success: false, error: `Permission denied: only the note author, organizer, or manager can edit note #${updates.edit_note.id}.` };
  }
  note.text = updates.edit_note.text;
  this.db
    .prepare(`UPDATE tasks SET notes = ? WHERE board_id = ? AND id = ?`)
    .run(JSON.stringify(notes), taskBoardId, task.id);
  changes.push(`Note #${updates.edit_note.id} edited`);
}
```

6. **Add `set_note_status` handler** (after remove_note):
```typescript
/* Set note status (meeting notes) */
if (updates.set_note_status !== undefined) {
  if (task.type !== 'meeting') {
    return { success: false, error: 'Note status can only be set on meeting tasks.' };
  }
  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const note = notes.find((n: any) => n.id === updates.set_note_status!.id);
  if (!note) {
    return { success: false, error: `Note #${updates.set_note_status.id} not found.` };
  }
  note.status = updates.set_note_status.status;
  if (updates.set_note_status.status === 'open') {
    delete note.processed_at;
    delete note.processed_by;
  } else {
    note.processed_at = now;
    note.processed_by = params.sender_name;
  }
  this.db
    .prepare(`UPDATE tasks SET notes = ? WHERE board_id = ? AND id = ?`)
    .run(JSON.stringify(notes), taskBoardId, task.id);
  changes.push(`Note #${updates.set_note_status.id} status set to ${updates.set_note_status.status}`);
}
```

6. **Add `add_participant` handler** (after set_note_status):
```typescript
/* Add participant (meeting only) */
if (updates.add_participant !== undefined) {
  if (task.type !== 'meeting') {
    return { success: false, error: 'Participants can only be added to meeting tasks.' };
  }
  const person = this.resolvePerson(updates.add_participant);
  if (!person) return this.buildOfferRegisterError(updates.add_participant);
  const participants: string[] = JSON.parse(task.participants ?? '[]');
  if (!participants.includes(person.person_id)) {
    participants.push(person.person_id);
    this.db
      .prepare(`UPDATE tasks SET participants = ? WHERE board_id = ? AND id = ?`)
      .run(JSON.stringify(participants), taskBoardId, task.id);
    changes.push(`Participant ${person.name} added`);
  }
}
```

7. **Add `remove_participant` handler**:
```typescript
/* Remove participant (meeting only) */
if (updates.remove_participant !== undefined) {
  if (task.type !== 'meeting') {
    return { success: false, error: 'Participants can only be removed from meeting tasks.' };
  }
  const person = this.resolvePerson(updates.remove_participant);
  if (!person) return this.buildOfferRegisterError(updates.remove_participant);
  const participants: string[] = JSON.parse(task.participants ?? '[]');
  const idx = participants.indexOf(person.person_id);
  if (idx >= 0) {
    participants.splice(idx, 1);
    this.db
      .prepare(`UPDATE tasks SET participants = ? WHERE board_id = ? AND id = ?`)
      .run(JSON.stringify(participants), taskBoardId, task.id);
    changes.push(`Participant ${person.name} removed`);
  }
}
```

8. **Add `scheduled_at` update handler**:
```typescript
/* Update scheduled_at (meeting only) */
if (updates.scheduled_at !== undefined) {
  if (task.type !== 'meeting') {
    return { success: false, error: 'scheduled_at can only be set on meeting tasks.' };
  }
  this.db
    .prepare(`UPDATE tasks SET scheduled_at = ? WHERE board_id = ? AND id = ?`)
    .run(updates.scheduled_at, taskBoardId, task.id);
  changes.push(`Meeting rescheduled to ${updates.scheduled_at}`);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "update meeting"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): update() with phase-tagged notes, participants, scheduled_at, set_note_status"
```

---

## Task 4: `move()` — WIP exclusion, open-minutes warning, cancel notification

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:1501-1524` (WIP check in bundled snapshot)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:1687-1698` (transitions — `cancel` added to move)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:73-83` (MoveResult interface)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing tests**

```typescript
describe('move meeting', () => {
  let meetingId: string;

  beforeEach(() => {
    const result = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Move test meeting',
      scheduled_at: '2026-03-15T17:00:00Z',
      participants: ['Giovanni'],
      sender_name: 'Alexandre',
    });
    meetingId = result.task_id!;
  });

  it('meetings do not count against WIP limits', () => {
    // person-1 (Alexandre) has WIP limit 3, and has T-001 in_progress
    // Start meeting — should succeed even if at WIP limit
    // First fill up WIP
    const t1 = engine.create({ board_id: BOARD_ID, type: 'simple', title: 'Filler 1', assignee: 'Alexandre', sender_name: 'Alexandre' });
    engine.move({ board_id: BOARD_ID, task_id: t1.task_id!, action: 'start', sender_name: 'Alexandre' });
    const t2 = engine.create({ board_id: BOARD_ID, type: 'simple', title: 'Filler 2', assignee: 'Alexandre', sender_name: 'Alexandre' });
    engine.move({ board_id: BOARD_ID, task_id: t2.task_id!, action: 'start', sender_name: 'Alexandre' });
    // Now at WIP limit (3: T-001 + Filler1 + Filler2)
    // Starting a meeting should not be blocked
    const result = engine.move({
      board_id: BOARD_ID,
      task_id: meetingId,
      action: 'start',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
  });

  it('done on meeting with open notes returns unprocessed_minutes_warning', () => {
    // Add agenda note
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Open agenda item' },
    });
    // Move to done
    const result = engine.move({
      board_id: BOARD_ID,
      task_id: meetingId,
      action: 'conclude',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    expect((result as any).unprocessed_minutes_warning).toBe(true);
  });

  it('done on meeting with all checked notes does NOT return warning', () => {
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Checked item' },
    });
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { set_note_status: { id: 1, status: 'checked' } },
    });
    const result = engine.move({
      board_id: BOARD_ID,
      task_id: meetingId,
      action: 'conclude',
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    expect((result as any).unprocessed_minutes_warning).toBeUndefined();
  });

  it('cancel meeting notifies participants', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'cancel_task',
      task_id: meetingId,
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    expect(result.notifications).toBeDefined();
    // Should notify Giovanni
    expect(result.notifications!.some((n: any) => n.target_person_id === 'person-2')).toBe(true);
  });

  it('meeting moves through full lifecycle', () => {
    // next_action → in_progress → review → done
    let r = engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'start', sender_name: 'Alexandre' });
    expect(r.success).toBe(true);
    expect(r.to_column).toBe('in_progress');
    r = engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'review', sender_name: 'Alexandre' });
    expect(r.success).toBe(true);
    expect(r.to_column).toBe('review');
    r = engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'conclude', sender_name: 'Alexandre' });
    expect(r.success).toBe(true);
    expect(r.to_column).toBe('done');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "move meeting"`
Expected: FAIL — WIP check doesn't exclude meetings, no warning on done

**Step 3: Implement move() meeting support**

1. **Add `notifications` to `AdminResult` before using meeting cancel notifications**:
```typescript
export interface AdminResult extends TaskflowResult {
  // ... existing fields ...
  notifications?: Array<{ target_person_id: string; notification_group_jid: string | null; message: string }>;
}
```

2. **Add `unprocessed_minutes_warning` to `MoveResult`** (line 78):
```typescript
unprocessed_minutes_warning?: boolean;
```

3. **Exclude meetings from WIP count** (line 1512-1517) — update the WIP count query:
```typescript
const countRow = this.db
  .prepare(
    `SELECT COUNT(*) as cnt FROM tasks
     WHERE ${this.visibleTaskScope()} AND assignee = ? AND column = 'in_progress' AND type != 'meeting'`,
  )
  .get(...this.visibleTaskParams(), personId) as { cnt: number };
```

4. **Skip WIP check for meeting starts** (line 1779):
```typescript
if (['start', 'resume', 'reject'].includes(params.action) && task.assignee && task.type !== 'meeting') {
```

5. **Add open-minutes warning on conclude** (after the column update, before return) — check for open meeting notes when moving to done:
```typescript
/* --- Meeting open-minutes soft warning --- */
let unprocessedMinutesWarning: boolean | undefined;
if (toColumn === 'done' && task.type === 'meeting') {
  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const hasOpenNotes = notes.some((n: any) => n.status === 'open');
  if (hasOpenNotes) unprocessedMinutesWarning = true;
}
```

And include it in the return:
```typescript
...(unprocessedMinutesWarning ? { unprocessed_minutes_warning: true } : {}),
```

6. **Cancel notification for meetings** — in admin() `cancel_task` case (line 3949), after archiving:
```typescript
/* Notify participants on meeting cancellation */
const notifications: AdminResult['notifications'] = [];
if (task.type === 'meeting' && task.participants) {
  const participants: string[] = JSON.parse(task.participants ?? '[]');
  for (const pid of participants) {
    const personRow = this.db.prepare(
      `SELECT notification_group_jid FROM board_people WHERE board_id = ? AND person_id = ?`
    ).get(this.boardId, pid) as { notification_group_jid: string | null } | undefined;
    notifications.push({
      target_person_id: pid,
      notification_group_jid: personRow?.notification_group_jid ?? null,
      message: `📅 Reunião ${task.id} "${task.title}" foi cancelada.`,
    });
  }
}
// Also notify assignee if not in participants
if (task.assignee) {
  const participants: string[] = JSON.parse(task.participants ?? '[]');
  if (!participants.includes(task.assignee)) {
    const assigneeRow = this.db.prepare(
      `SELECT notification_group_jid FROM board_people WHERE board_id = ? AND person_id = ?`
    ).get(this.boardId, task.assignee) as { notification_group_jid: string | null } | undefined;
    notifications.push({
      target_person_id: task.assignee,
      notification_group_jid: assigneeRow?.notification_group_jid ?? null,
      message: `📅 Reunião ${task.id} "${task.title}" foi cancelada.`,
    });
  }
}

return {
  success: true,
  data: { cancelled: task.id, title: task.title },
  ...(notifications.length > 0 ? { notifications } : {}),
};
```

**Step 4: Run tests to verify they pass**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "move meeting"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): WIP exclusion, open-minutes warning on conclude, cancel notifications"
```

---

## Task 5: `query()` — 8 meeting query types

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:15-23` (QueryParams interface in bundled snapshot)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:3020-3175` (query dispatcher in bundled snapshot)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing tests**

```typescript
describe('query meetings', () => {
  let meetingId: string;

  beforeEach(() => {
    const r = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Weekly sync',
      scheduled_at: '2026-03-15T17:00:00Z',
      participants: ['Giovanni'],
      sender_name: 'Alexandre',
    });
    meetingId = r.task_id!;
    // Add agenda notes
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Review budget' },
    });
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { add_note: 'Define timeline' },
    });
  });

  it('meetings query returns all active meetings', () => {
    const result = engine.query({ query: 'meetings' });
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    expect(result.data[0].type).toBe('meeting');
  });

  it('meeting_agenda returns pre-phase notes', () => {
    const result = engine.query({ query: 'meeting_agenda', task_id: meetingId });
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(2);
    expect(result.data[0].phase).toBe('pre');
  });

  it('meeting_minutes returns all notes with threading', () => {
    const result = engine.query({ query: 'meeting_minutes', task_id: meetingId });
    expect(result.success).toBe(true);
    expect(result.data.notes.length).toBe(2);
    expect(result.formatted).toBeDefined();
  });

  it('upcoming_meetings returns meetings sorted by scheduled_at', () => {
    // Create another meeting earlier
    engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Earlier meeting',
      scheduled_at: '2026-03-10T10:00:00Z',
      sender_name: 'Alexandre',
    });
    const result = engine.query({ query: 'upcoming_meetings' });
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThanOrEqual(2);
    // Sorted ascending by scheduled_at
    expect(result.data[0].scheduled_at <= result.data[1].scheduled_at).toBe(true);
  });

  it('meeting_participants returns participant list', () => {
    const result = engine.query({ query: 'meeting_participants', task_id: meetingId });
    expect(result.success).toBe(true);
    expect(result.data.organizer).toBeDefined();
    expect(result.data.participants.length).toBeGreaterThan(0);
  });

  it('meeting_open_items returns only open notes', () => {
    // Check one item
    engine.update({
      board_id: BOARD_ID,
      task_id: meetingId,
      sender_name: 'Alexandre',
      updates: { set_note_status: { id: 1, status: 'checked' } },
    });
    const result = engine.query({ query: 'meeting_open_items', task_id: meetingId });
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(1); // Only note #2 is still open
    expect(result.data[0].id).toBe(2);
  });

  it('meeting_history returns task history', () => {
    const result = engine.query({ query: 'meeting_history', task_id: meetingId });
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('meeting_minutes_at returns archived occurrence by date', () => {
    // This test needs archived meeting data — test structure only
    const result = engine.query({ query: 'meeting_minutes_at', task_id: meetingId, at: '2026-03-15' });
    // For non-archived meetings, falls back to current data if date matches
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "query meetings"`
Expected: FAIL — query types not recognized

**Step 3: Implement query() meeting support**

1. **Add `at` to QueryParams** (line 22):
```typescript
at?: string; // for meeting_minutes_at (YYYY-MM-DD)
```

2. **Add 8 meeting query cases** in the query dispatcher (inside the switch, before `default`):

```typescript
/* ---------- Meeting queries ---------- */

case 'meetings': {
  const tasks = this.db
    .prepare(
      `SELECT * FROM tasks
       WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
       ORDER BY scheduled_at, id`,
    )
    .all(...this.visibleTaskParams());
  return { success: true, data: tasks };
}

case 'meeting_agenda': {
  if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
  const task = this.requireTask(params.task_id);
  if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const agenda = notes.filter((n: any) => n.phase === 'pre');
  return { success: true, data: agenda };
}

case 'meeting_minutes': {
  if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
  const task = this.requireTask(params.task_id);
  if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const formatted = this.formatMeetingMinutes(task, notes);
  return { success: true, data: { task, notes }, formatted };
}

case 'upcoming_meetings': {
  const tasks = this.db
    .prepare(
      `SELECT * FROM tasks
       WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
         AND scheduled_at IS NOT NULL
       ORDER BY scheduled_at ASC`,
    )
    .all(...this.visibleTaskParams());
  return { success: true, data: tasks };
}

case 'meeting_participants': {
  if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
  const task = this.requireTask(params.task_id);
  if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
  const participantIds: string[] = JSON.parse(task.participants ?? '[]');
  const organizerRow = task.assignee
    ? this.db.prepare(`SELECT person_id, name, role FROM board_people WHERE board_id = ? AND person_id = ?`).get(this.boardId, task.assignee) as any
    : null;
  if (participantIds.length === 0) {
    return {
      success: true,
      data: {
        organizer: organizerRow ?? { person_id: task.assignee, name: task.assignee },
        participants: [],
      },
    };
  }
  const people = this.db
    .prepare(`SELECT person_id, name, role FROM board_people WHERE board_id = ? AND person_id IN (${participantIds.map(() => '?').join(',')})`)
    .all(this.boardId, ...participantIds) as Array<{ person_id: string; name: string; role: string }>;
  return {
    success: true,
    data: {
      organizer: organizerRow ?? { person_id: task.assignee, name: task.assignee },
      participants: people,
    },
  };
}

case 'meeting_open_items': {
  if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
  const task = this.requireTask(params.task_id);
  if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const openItems = notes.filter((n: any) => n.status === 'open');
  return { success: true, data: openItems };
}

case 'meeting_history': {
  if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
  const task = this.getTask(params.task_id);
  const history = this.getHistory(params.task_id);
  const occurrenceSnapshots = history
    .filter((h: any) => h.action === 'meeting_occurrence_archived')
    .map((h: any) => JSON.parse(h.details ?? '{}'));
  return { success: true, data: { current: task, history, archived_occurrences: occurrenceSnapshots } };
}

case 'meeting_minutes_at': {
  if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
  if (!params.at) return { success: false, error: 'Missing required parameter: at (YYYY-MM-DD)' };
  // Search recurring occurrence snapshots stored in history/details
  const occurrences = this.getHistory(params.task_id)
    .filter((h: any) => h.action === 'meeting_occurrence_archived');

  for (const row of occurrences) {
    try {
      const details = JSON.parse(row.details ?? '{}');
      const snapshot = details.snapshot;
      const snapshotDate = (snapshot?.scheduled_at ?? '').slice(0, 10);
      if (snapshotDate === params.at) {
        return { success: true, data: snapshot, formatted: this.formatMeetingMinutes(snapshot, JSON.parse(snapshot.notes ?? '[]')) };
      }
    } catch { /* skip malformed */ }
  }

  // Fallback: check current task if date matches
  const task = this.getTask(params.task_id);
  if (task && task.scheduled_at?.startsWith(params.at)) {
    const notes = JSON.parse(task.notes ?? '[]');
    return { success: true, data: task, formatted: this.formatMeetingMinutes(task, notes) };
  }

  return { success: false, error: `No meeting occurrence found for ${params.task_id} on ${params.at}` };
}
```

3. **Add `formatMeetingMinutes` helper** (private method):

```typescript
/**
 * Format meeting minutes in the structured output format from the design doc.
 * Threading is one level deep for display.
 */
private formatMeetingMinutes(task: any, notes: Array<any>): string {
  const lines: string[] = [];
  const scheduledStr = task.scheduled_at
    ? (() => { const d = task.scheduled_at; return `${d.slice(8,10)}/${d.slice(5,7)}/${d.slice(0,4)} ${d.slice(11,16)}`; })()
    : 'sem data';
  lines.push(`📅 *${task.id} — ${task.title}* (${scheduledStr})`);
  lines.push('');

  // Separate top-level notes (no parent) and replies
  const topLevel = notes.filter((n: any) => !n.parent_note_id);
  const replies = new Map<number, any[]>();
  for (const n of notes.filter((n: any) => n.parent_note_id)) {
    const arr = replies.get(n.parent_note_id) ?? [];
    arr.push(n);
    replies.set(n.parent_note_id, arr);
  }

  const statusMarker = (n: any): string => {
    switch (n.status) {
      case 'checked': return '✓';
      case 'task_created': return `⤷ ${n.created_task_id ?? ''}`;
      case 'inbox_created': return `📥 ${n.created_task_id ?? ''}`;
      case 'dismissed': return '—';
      default: return '';
    }
  };

  // Group by phase
  const preNotes = topLevel.filter((n: any) => n.phase === 'pre');
  const meetingNotes = topLevel.filter((n: any) => n.phase === 'meeting');
  const postNotes = topLevel.filter((n: any) => n.phase === 'post');
  const otherNotes = topLevel.filter((n: any) => !n.phase);

  if (preNotes.length > 0) {
    lines.push('*Pauta:*');
    for (let i = 0; i < preNotes.length; i++) {
      const n = preNotes[i];
      const marker = statusMarker(n);
      lines.push(`${i + 1}. ${marker ? marker + ' ' : ''}${n.text}`);
      for (const r of replies.get(n.id) ?? []) {
        const rMarker = statusMarker(r);
        const postTag = r.phase === 'post' ? ' _(pós-reunião)_' : '';
        lines.push(`   → ${rMarker ? rMarker + ' ' : ''}${r.text}${postTag}`);
      }
    }
  }

  if (meetingNotes.length > 0) {
    lines.push('');
    for (const n of meetingNotes) {
      const marker = statusMarker(n);
      lines.push(`*${marker ? marker + ' ' : ''}[Novo] ${n.text}*`);
      for (const r of replies.get(n.id) ?? []) {
        const rMarker = statusMarker(r);
        const postTag = r.phase === 'post' ? ' _(pós-reunião)_' : '';
        lines.push(`   → ${rMarker ? rMarker + ' ' : ''}${r.text}${postTag}`);
      }
    }
  }

  if (postNotes.length > 0) {
    lines.push('');
    lines.push('*[Pós-reunião]*');
    for (const n of postNotes) {
      const marker = statusMarker(n);
      lines.push(`   → ${marker ? marker + ' ' : ''}${n.text}`);
      for (const r of replies.get(n.id) ?? []) {
        const rMarker = statusMarker(r);
        lines.push(`   → ${rMarker ? rMarker + ' ' : ''}${r.text}`);
      }
    }
  }

  if (otherNotes.length > 0) {
    for (const n of otherNotes) {
      lines.push(`• ${n.text}`);
    }
  }

  return lines.join('\n');
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "query meetings"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): 8 meeting query types with structured minutes output"
```

---

## Task 6: `admin()` — process_minutes and process_minutes_decision

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:165-182` (AdminParams interface in bundled snapshot)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:4150-4160` (admin switch, before default)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing tests**

```typescript
describe('admin meeting triage', () => {
  let meetingId: string;

  beforeEach(() => {
    const r = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Triage meeting',
      scheduled_at: '2026-03-15T17:00:00Z',
      participants: ['Giovanni'],
      sender_name: 'Alexandre',
    });
    meetingId = r.task_id!;
    // Add notes
    engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { add_note: 'Budget review' } });
    engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { add_note: 'Timeline definition' } });
    engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { add_note: 'Server issue' } });
    // Check one
    engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { set_note_status: { id: 1, status: 'checked' } } });
  });

  it('process_minutes returns only open notes', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'process_minutes',
      task_id: meetingId,
      sender_name: 'Alexandre',
    });
    expect(result.success).toBe(true);
    expect(result.data.open_items.length).toBe(2); // notes #2 and #3
    expect(result.data.open_items.every((n: any) => n.status === 'open')).toBe(true);
  });

  it('process_minutes_decision creates task atomically', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'process_minutes_decision',
      task_id: meetingId,
      sender_name: 'Alexandre',
      note_id: 2,
      decision: 'create_task',
      create: {
        type: 'simple',
        title: 'Timeline follow-up',
        assignee: 'Giovanni',
        labels: ['ata:' + meetingId],
      },
    });
    expect(result.success).toBe(true);
    expect(result.data.created_task_id).toBeDefined();

    // Verify note status updated
    const task = db.prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, meetingId) as any;
    const notes = JSON.parse(task.notes);
    const note = notes.find((n: any) => n.id === 2);
    expect(note.status).toBe('task_created');
    expect(note.created_task_id).toBe(result.data.created_task_id);

    // Verify task was created
    const createdTask = db.prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, result.data.created_task_id) as any;
    expect(createdTask).toBeDefined();
    expect(createdTask.title).toBe('Timeline follow-up');
  });

  it('process_minutes_decision creates inbox atomically', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'process_minutes_decision',
      task_id: meetingId,
      sender_name: 'Alexandre',
      note_id: 3,
      decision: 'create_inbox',
      create: {
        type: 'inbox',
        title: 'Investigate server issue',
        labels: ['ata:' + meetingId],
      },
    });
    expect(result.success).toBe(true);
    expect(result.data.created_task_id).toBeDefined();

    // Verify note status updated
    const task = db.prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, meetingId) as any;
    const notes = JSON.parse(task.notes);
    const note = notes.find((n: any) => n.id === 3);
    expect(note.status).toBe('inbox_created');
  });

  it('process_minutes_decision rejects invalid note_id', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'process_minutes_decision',
      task_id: meetingId,
      sender_name: 'Alexandre',
      note_id: 999,
      decision: 'create_task',
      create: { type: 'simple', title: 'No note', assignee: 'Giovanni' },
    });
    expect(result.success).toBe(false);
  });

  it('process_minutes_decision rejects already-processed note', () => {
    const result = engine.admin({
      board_id: BOARD_ID,
      action: 'process_minutes_decision',
      task_id: meetingId,
      sender_name: 'Alexandre',
      note_id: 1, // already checked
      decision: 'create_task',
      create: { type: 'simple', title: 'Already done', assignee: 'Giovanni' },
    });
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "admin meeting triage"`
Expected: FAIL

**Step 3: Implement admin() meeting support**

1. **Extend `AdminParams`** (line 167):
```typescript
action: 'register_person' | 'remove_person' | 'add_manager' | 'add_delegate' | 'remove_admin' | 'set_wip_limit' | 'cancel_task' | 'restore_task' | 'process_inbox' | 'manage_holidays' | 'process_minutes' | 'process_minutes_decision';
```

Also add to AdminParams:
```typescript
note_id?: number;
decision?: 'create_task' | 'create_inbox';
create?: {
  type: string;
  title: string;
  assignee?: string;
  labels?: string[];
};
```

2. **Add process_minutes case** (before `default` in admin switch):

```typescript
/* ---- process_minutes ---- */
case 'process_minutes': {
  const task = this.requireTask(params.task_id);
  if (task.type !== 'meeting') {
    return { success: false, error: `Task ${params.task_id} is not a meeting.` };
  }
  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const openItems = notes.filter((n: any) => n.status === 'open');

  // Group by top-level note (agenda item or standalone)
  const grouped: Array<{ item: any; replies: any[] }> = [];
  const topLevel = openItems.filter((n: any) => !n.parent_note_id);
  for (const item of topLevel) {
    const replies = openItems.filter((n: any) => n.parent_note_id === item.id);
    grouped.push({ item, replies });
  }
  // Add orphan replies (parent is not open)
  const coveredIds = new Set(grouped.flatMap((g) => [g.item.id, ...g.replies.map((r) => r.id)]));
  const orphans = openItems.filter((n: any) => !coveredIds.has(n.id));
  for (const o of orphans) grouped.push({ item: o, replies: [] });

  return {
    success: true,
    data: { open_items: openItems, grouped },
  };
}
```

3. **Add process_minutes_decision case**:

```typescript
/* ---- process_minutes_decision ---- */
case 'process_minutes_decision': {
  const task = this.requireTask(params.task_id);
  if (task.type !== 'meeting') {
    return { success: false, error: `Task ${params.task_id} is not a meeting.` };
  }
  if (params.note_id == null) {
    return { success: false, error: 'Missing required parameter: note_id' };
  }
  if (!params.decision) {
    return { success: false, error: 'Missing required parameter: decision' };
  }
  if (!params.create) {
    return { success: false, error: 'Missing required parameter: create' };
  }

  const notes: Array<any> = JSON.parse(task.notes ?? '[]');
  const note = notes.find((n: any) => n.id === params.note_id);
  if (!note) {
    return { success: false, error: `Note #${params.note_id} not found.` };
  }
  if (note.status !== 'open') {
    return { success: false, error: `Note #${params.note_id} is already processed (status: ${note.status}).` };
  }

  const now = new Date().toISOString();

  let createResult: any;
  this.db.transaction(() => {
    createResult = this.createTaskInternal({
      board_id: this.boardId,
      type: params.create.type,
      title: params.create.title,
      assignee: params.create.assignee,
      labels: params.create.labels,
      sender_name: params.sender_name,
    });

    if (!createResult.success) {
      throw new Error(`Failed to create task: ${createResult.error}`);
    }

    note.status = params.decision === 'create_task' ? 'task_created' : 'inbox_created';
    note.processed_at = now;
    note.processed_by = params.sender_name;
    note.created_task_id = createResult.task_id;

    this.db
      .prepare(`UPDATE tasks SET notes = ? WHERE board_id = ? AND id = ?`)
      .run(JSON.stringify(notes), this.taskBoardId(task), task.id);
  })();

  return {
    success: true,
    data: { created_task_id: createResult.task_id, note_id: params.note_id },
  };
}
```

Implementation note: do not call the public transactional `create()` from inside `process_minutes_decision`. Extract the shared creation logic into a reusable non-transactional helper such as `createTaskInternal()` so `process_minutes_decision` owns the single outer transaction and preserves the all-or-nothing guarantee.

4. **Add minutes-processed notifications**:
When `process_minutes_decision` creates a follow-up task or inbox item, attach notifications for the affected assignee when that person differs from the actor. This closes the design requirement that processed action items can notify the people who now own the outcome.

**Step 4: Run tests to verify they pass**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "admin meeting triage"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): process_minutes and process_minutes_decision admin actions"
```

---

## Task 7: `advanceRecurringTask()` — meeting-specific cycle advance

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:1606-1657` (advanceRecurringTask in bundled snapshot)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing tests**

```typescript
describe('recurring meeting advance', () => {
  it('archives meeting notes with metadata before cycle reset', () => {
    const r = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Weekly standup',
      scheduled_at: '2026-03-10T14:00:00Z',
      recurrence: 'weekly',
      participants: ['Giovanni'],
      sender_name: 'Alexandre',
    });
    const meetingId = r.task_id!;

    // Add notes
    engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { add_note: 'Agenda item' } });
    engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { set_note_status: { id: 1, status: 'checked' } } });

    // Move to done (triggers advance)
    engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'start', sender_name: 'Alexandre' });
    const doneResult = engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'conclude', sender_name: 'Alexandre' });
    expect(doneResult.success).toBe(true);
    expect(doneResult.recurring_cycle).toBeDefined();
    expect(doneResult.recurring_cycle!.expired).toBe(false);

    // Verify notes were reset
    const task = db.prepare(`SELECT notes, scheduled_at, participants FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, meetingId) as any;
    expect(JSON.parse(task.notes)).toEqual([]);

    // Verify participants preserved
    const parts = JSON.parse(task.participants);
    expect(parts).toContain('person-2');

    // Verify scheduled_at advanced
    expect(task.scheduled_at).not.toBe('2026-03-10T14:00:00Z');

    // Verify archived occurrence preserves notes and metadata
    const occurrences = db.prepare(
      `SELECT * FROM task_history WHERE board_id = ? AND task_id = ? AND action = 'meeting_occurrence_archived'`
    ).all(BOARD_ID, meetingId);
    expect(occurrences.length).toBe(1);
    const details = JSON.parse((occurrences[0] as any).details);
    expect(details.snapshot.notes).toBeDefined();
    expect(details.snapshot.scheduled_at).toBe('2026-03-10T14:00:00Z');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "recurring meeting advance"`
Expected: FAIL — scheduled_at not advanced, notes metadata not archived

**Step 3: Implement advanceRecurringTask() meeting support**

Modify `advanceRecurringTask()` (line 1606):

1. **Archive meeting occurrence before reset** (add before the UPDATE that resets notes):

```typescript
/* --- Persist recurring meeting occurrence snapshot before cycle reset --- */
if (task.type === 'meeting') {
  const meetingSnapshot = {
    ...task,
    current_cycle: currentCycle,
    occurrence_scheduled_at: task.scheduled_at,
  };
  this.recordHistory(
    task.id,
    'meeting_occurrence_archived',
    'system',
    JSON.stringify({
      cycle_number: currentCycle,
      occurrence_scheduled_at: task.scheduled_at,
      snapshot: meetingSnapshot,
    }),
    this.taskBoardId(task),
  );
}
```

2. **Advance `scheduled_at` for meetings** — after the normal cycle advance UPDATE, add:

```typescript
/* --- Advance scheduled_at for recurring meetings --- */
if (task.type === 'meeting' && task.scheduled_at) {
  const anchor = new Date(task.scheduled_at);
  const nextScheduled = advanceDateByRecurrence(anchor, recurrence);
  // scheduled_at includes time, so preserve time component
  const timePart = task.scheduled_at.slice(10); // e.g. T14:00:00Z
  const nextScheduledWithTime = nextScheduled.slice(0, 10) + timePart;
  this.db
    .prepare(`UPDATE tasks SET scheduled_at = ? WHERE board_id = ? AND id = ?`)
    .run(nextScheduledWithTime, this.taskBoardId(task), task.id);
}
```

3. **Preserve participants** — the existing reset UPDATE does not touch `participants`, so they are naturally preserved. Verify this.

**Step 4: Run test to verify it passes**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "recurring meeting advance"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): advanceRecurringTask archives meeting notes and advances scheduled_at"
```

---

## Task 8: `formatBoardView()` — meeting display with emoji, time, participant count

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:2869-2884` (pfx/dueSfx helpers in bundled snapshot)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:2975-3004` (task line rendering)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing test**

```typescript
describe('board view meetings', () => {
  it('shows meeting emoji, scheduled_at time, and participant count', () => {
    engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Alinhamento semanal',
      scheduled_at: '2026-03-15T17:00:00Z',
      participants: ['Giovanni'],
      sender_name: 'Alexandre',
    });
    const result = engine.query({ query: 'board' });
    expect(result.success).toBe(true);
    const board = result.data.formatted_board as string;
    expect(board).toContain('📅');
    expect(board).toContain('Alinhamento semanal');
    expect(board).toContain('participante');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "shows meeting emoji"`
Expected: FAIL — no 📅 prefix for meetings

**Step 3: Implement formatBoardView() meeting display**

1. **Update `pfx()` helper** (line 2869) — add meeting emoji:
```typescript
const pfx = (t: any): string => {
  if (t.type === 'meeting') return '📅 ';
  if (t.due_date && daysDiff(t.due_date) <= 2) return '⚠️ ';
  if (t.child_exec_enabled === 1) return '🔗 ';
  if (t.type === 'project') return '📁 ';
  if (t.type === 'recurring') return '🔄 ';
  return '';
};
```

2. **Add meeting suffix helper** (after `notesSfx`):
```typescript
const meetingSfx = (t: any): string => {
  if (t.type !== 'meeting') return '';
  const parts: string[] = [];
  if (t.scheduled_at) {
    const d = t.scheduled_at;
    parts.push(`${d.slice(8,10)}/${d.slice(5,7)} ${d.slice(11,16)}`);
  }
  if (t.participants) {
    try {
      const p = JSON.parse(t.participants);
      if (Array.isArray(p) && p.length > 0) {
        parts.push(`${p.length + 1} participante${p.length > 0 ? 's' : ''}`);
      }
    } catch {}
  }
  return parts.length > 0 ? ` (${parts.join(' — ')})` : '';
};
```

3. **Update task line rendering** (line 2977) — add meeting suffix:
```typescript
let line = `${pfx(t)}${tid}: ${t.title}${meetingSfx(t)}${dueSfx(t)}${notesSfx(t)}`;
```

Note: meetings use `scheduled_at` as their canonical schedule display. Do not rely on `due_date` for normal meeting rendering; the approved design keeps `due_date` `NULL` by default for meeting tasks.

**Step 4: Run test to verify it passes**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "shows meeting emoji"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): formatBoardView shows meeting emoji, time, and participant count"
```

---

## Task 9: `report()` — meeting-specific entries and warnings

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:4166-4350` (report method in bundled snapshot)
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts:204-230` (ReportResult interface)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing test**

```typescript
describe('report meetings', () => {
  it('standup includes upcoming meetings and open-minutes warnings', () => {
    // Create a past meeting with open notes (simulate overdue minutes)
    const r = engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Past meeting',
      scheduled_at: '2026-03-01T10:00:00Z',
      sender_name: 'Alexandre',
    });
    engine.update({ board_id: BOARD_ID, task_id: r.task_id!, sender_name: 'Alexandre', updates: { add_note: 'Unresolved item' } });

    // Create upcoming meeting
    engine.create({
      board_id: BOARD_ID,
      type: 'meeting',
      title: 'Tomorrow meeting',
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      sender_name: 'Alexandre',
    });

    const report = engine.report({ board_id: BOARD_ID, type: 'standup' });
    expect(report.success).toBe(true);
    expect(report.data!.upcoming_meetings).toBeDefined();
    expect(report.data!.meetings_with_open_minutes).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "standup includes upcoming meetings"`
Expected: FAIL — `upcoming_meetings` field doesn't exist in report data

**Step 3: Implement report() meeting support**

1. **Extend `ReportResult.data`** (line 206):
```typescript
upcoming_meetings?: Array<{ id: string; title: string; scheduled_at: string; participant_count: number }>;
meetings_with_open_minutes?: Array<{ id: string; title: string; scheduled_at: string; open_count: number }>;
```

2. **Add meeting queries to report()** (after the `waiting` query block):

```typescript
/* --- Upcoming meetings (next 7 days) --- */
const upcomingMeetings = this.db
  .prepare(
    `SELECT id, title, scheduled_at, participants FROM tasks
     WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
       AND scheduled_at IS NOT NULL AND scheduled_at <= ?
     ORDER BY scheduled_at`,
  )
  .all(...this.visibleTaskParams(), sevenDaysFromNow() + 'T23:59:59Z') as Array<{
    id: string; title: string; scheduled_at: string; participants: string | null;
  }>;

const upcomingMeetingsFormatted = upcomingMeetings.map((m) => ({
  id: m.id,
  title: m.title,
  scheduled_at: m.scheduled_at,
  participant_count: m.participants ? JSON.parse(m.participants).length + 1 : 1,
}));

/* --- Meetings with open minutes (past scheduled_at, has open notes) --- */
const pastMeetings = this.db
  .prepare(
    `SELECT id, title, scheduled_at, notes FROM tasks
     WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
       AND scheduled_at IS NOT NULL AND scheduled_at < ?
     ORDER BY scheduled_at`,
  )
  .all(...this.visibleTaskParams(), new Date().toISOString()) as Array<{
    id: string; title: string; scheduled_at: string; notes: string;
  }>;

const meetingsWithOpenMinutes = pastMeetings
  .filter((m) => {
    try {
      const notes = JSON.parse(m.notes ?? '[]');
      return notes.some((n: any) => n.status === 'open');
    } catch { return false; }
  })
  .map((m) => {
    const notes = JSON.parse(m.notes ?? '[]');
    return {
      id: m.id,
      title: m.title,
      scheduled_at: m.scheduled_at,
      open_count: notes.filter((n: any) => n.status === 'open').length,
    };
  });
```

3. **Include in return data**:
```typescript
upcoming_meetings: upcomingMeetingsFormatted,
meetings_with_open_minutes: meetingsWithOpenMinutes,
```

**Step 4: Run test to verify it passes**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "standup includes upcoming meetings"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): report includes upcoming meetings and open-minutes warnings"
```

---

## Task 9A: Scheduled meeting notifications

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- Modify: `.claude/skills/add-taskflow/add/src/taskflow-db.ts` if reminder helpers need schedule-aware indexes or queries
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing tests**

Add coverage for:
- day-based reminders for meetings keyed to `scheduled_at`
- exact-time `meeting starting` notifications keyed to `scheduled_at`
- minutes-processed notifications when a follow-up item is assigned to another participant

**Step 2: Extend notification handling**

1. Reuse the existing reminder infrastructure, but teach meeting reminders to evaluate from `scheduled_at` instead of `due_date`.
2. Keep `reminder_days` day-based for v1; do not introduce arbitrary hour/minute reminder offsets through the generic reminder API.
3. Add a distinct exact-time `meeting starting` notification keyed directly to `scheduled_at`.
4. Reuse TaskFlow notification target resolution so reminders and starting notifications go to participants or their configured notification groups without duplicating the current chat.
5. Ensure `process_minutes_decision` can emit notifications for newly assigned outcome owners when they differ from the actor.

**Step 3: Run tests**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "meeting notifications"`
Expected: PASS

**Step 4: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/add/src/taskflow-db.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): add scheduled meeting notifications"
```

---

## Task 10: MCP Schema Updates — ipc-mcp-stdio.ts

**Files:**
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts:511-528` (taskflow_query schema snapshot)
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts:538-564` (taskflow_create schema snapshot)
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts:605-638` (taskflow_update schema snapshot)
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts:660-675` (taskflow_admin schema snapshot)
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing test**

Add to the skill package test file (`.claude/skills/add-taskflow/tests/taskflow.test.ts`) since MCP schema is checked there:

```typescript
it('MCP schema includes meeting type in taskflow_create', () => {
  const content = fs.readFileSync(
    path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
    'utf-8',
  );
  expect(content).toContain("'meeting'");
  expect(content).toContain('scheduled_at');
  expect(content).toContain('participants');
});

it('MCP schema includes meeting queries in taskflow_query', () => {
  const content = fs.readFileSync(
    path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
    'utf-8',
  );
  expect(content).toContain('meetings');
  expect(content).toContain('meeting_agenda');
  expect(content).toContain('meeting_minutes');
  expect(content).toContain('upcoming_meetings');
  expect(content).toContain('meeting_participants');
  expect(content).toContain('meeting_open_items');
  expect(content).toContain('meeting_history');
  expect(content).toContain('meeting_minutes_at');
});

it('MCP schema includes process_minutes in taskflow_admin', () => {
  const content = fs.readFileSync(
    path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
    'utf-8',
  );
  expect(content).toContain('process_minutes');
  expect(content).toContain('process_minutes_decision');
});
```

**Step 2: Run test to verify it fails**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "MCP schema includes meeting"`
Expected: FAIL

**Step 3: Implement MCP schema changes**

1. **`taskflow_query`** (line 515) — add meeting query types to the z.enum:
```typescript
z.enum([..., 'meetings', 'meeting_agenda', 'meeting_minutes', 'upcoming_meetings',
  'meeting_participants', 'meeting_open_items', 'meeting_history', 'meeting_minutes_at'])
```

Add `at` parameter:
```typescript
at: z.string().optional().describe('Date (YYYY-MM-DD) for meeting_minutes_at query'),
```

2. **`taskflow_create`** (line 542) — add `meeting` to type enum:
```typescript
type: z.enum(['simple', 'project', 'recurring', 'inbox', 'meeting']).describe('Task type'),
```

Add new fields:
```typescript
scheduled_at: z.string().optional().describe('Scheduled datetime (ISO-8601 UTC) for meetings'),
participants: z.array(z.string()).optional().describe('Participant names for meetings'),
```

3. **`taskflow_update`** (line 611) — add to updates object:
```typescript
parent_note_id: z.number().optional().describe('Parent note ID for threaded meeting notes'),
scheduled_at: z.string().optional().describe('Reschedule meeting (ISO-8601 UTC)'),
add_participant: z.string().optional().describe('Add a participant to a meeting'),
remove_participant: z.string().optional().describe('Remove a participant from a meeting'),
set_note_status: z.object({
  id: z.number(),
  status: z.enum(['open', 'checked', 'task_created', 'inbox_created', 'dismissed']),
}).optional().describe('Set meeting note status'),
```

4. **`taskflow_admin`** (line 664) — add actions and fields:
```typescript
action: z.enum([..., 'process_minutes', 'process_minutes_decision']).describe('Admin action'),
```

Add new params:
```typescript
note_id: z.number().optional().describe('Note ID for process_minutes_decision'),
decision: z.enum(['create_task', 'create_inbox']).optional().describe('Decision for process_minutes_decision'),
create: z.object({
  type: z.string(),
  title: z.string(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
}).optional().describe('Task creation params for process_minutes_decision'),
```

5. **Implement the schema changes directly in the packaged snapshot**:
Update `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts` in place. Do not copy from the live runtime.

**Step 4: Run tests to verify they pass**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "MCP schema includes meeting"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): MCP schema updates for meeting type, queries, and admin actions"
```

---

## Task 11: CLAUDE.md Template — meeting commands, display, triage

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Write failing tests**

```typescript
it('CLAUDE.md.template has meeting commands', () => {
  const content = fs.readFileSync(
    path.join(skillDir, 'templates', 'CLAUDE.md.template'),
    'utf-8',
  );
  // Meeting creation commands
  expect(content).toContain("type: 'meeting'");
  expect(content).toContain('reunião');
  expect(content).toContain('scheduled_at');

  // Meeting note commands
  expect(content).toContain('pauta M');
  expect(content).toContain('ata M');
  expect(content).toContain('parent_note_id');

  // Phase auto-tagging rule
  expect(content).toContain('phase');
  expect(content).toContain('auto-tagged');

  // Disambiguation rule
  expect(content).toContain('pauta M1"');
  expect(content).toContain('query');

  // Triage
  expect(content).toContain('processar ata');
  expect(content).toContain('process_minutes');

  // Display
  expect(content).toContain('📅');
  expect(content).toContain('participante');

  // Schema reference
  expect(content).toContain('participants');
  expect(content).toContain('scheduled_at');
});
```

**Step 2: Run test to verify it fails**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "CLAUDE.md.template has meeting commands"`
Expected: FAIL

**Step 3: Add meeting sections to CLAUDE.md.template**

Add the following sections to the template:

1. **In Command -> Tool Mapping** (after existing creation commands):

```markdown
### Meeting Management

| User says | Tool call |
|-----------|-----------|
| "reunião: X em DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', sender_name: SENDER })` |
| "reunião: X" | `taskflow_create({ type: 'meeting', title: 'X', sender_name: SENDER })` |
| "reunião com Y, Z: X em DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', participants: ['Y', 'Z'], sender_name: SENDER })` |
| "reunião semanal: X começando DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', recurrence: 'weekly', sender_name: SENDER })` |

Parse `scheduled_at` in the board timezone ({{TIMEZONE}}) from the user's date/time expression, then store in UTC.
Organizer (assignee) is auto-set to sender. Meetings always start in `next_action`.

### Meeting Notes (Agenda / Minutes / Post-Meeting)

Phase is auto-tagged from column state:
- `next_action` → phase `pre` (agenda/pauta)
- `in_progress` / `waiting` → phase `meeting` (ata/minutes)
- `review` / `done` → phase `post` (pós-reunião)

| User says | Tool call |
|-----------|-----------|
| "pauta M1: texto" | `taskflow_update({ task_id: 'M1', updates: { add_note: 'texto' }, sender_name: SENDER })` |
| "ata M1 #N: texto" | `taskflow_update({ task_id: 'M1', updates: { add_note: 'texto', parent_note_id: N }, sender_name: SENDER })` |
| "ata M1: texto" | `taskflow_update({ task_id: 'M1', updates: { add_note: 'texto' }, sender_name: SENDER })` |
| "editar nota M1 #N: texto" | `taskflow_update({ task_id: 'M1', updates: { edit_note: { id: N, text: 'texto' } }, sender_name: SENDER })` |
| "remover nota M1 #N" | `taskflow_update({ task_id: 'M1', updates: { remove_note: N }, sender_name: SENDER })` |
| "marcar item M1 #N como resolvido" | `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'checked' } }, sender_name: SENDER })` |
| "reabrir item M1 #N" | `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'open' } }, sender_name: SENDER })` |
| "descartar item M1 #N" | `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'dismissed' } }, sender_name: SENDER })` |

**Disambiguation:** `"pauta M1"` (no colon) → query agenda. `"pauta M1: texto"` (colon + text) → add note.

### Meeting Scheduling

| User says | Tool call |
|-----------|-----------|
| "reagendar M1 para DD/MM às HH:MM" | `taskflow_update({ task_id: 'M1', updates: { scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ' }, sender_name: SENDER })` |

### Meeting Participants

| User says | Tool call |
|-----------|-----------|
| "adicionar participante M1: Y" | `taskflow_update({ task_id: 'M1', updates: { add_participant: 'Y' }, sender_name: SENDER })` |
| "remover participante M1: Y" | `taskflow_update({ task_id: 'M1', updates: { remove_participant: 'Y' }, sender_name: SENDER })` |
| "participantes M1" | `taskflow_query({ query: 'meeting_participants', task_id: 'M1' })` |

### Meeting Movement

| User says | Tool call |
|-----------|-----------|
| "iniciando M1" | `taskflow_move({ task_id: 'M1', action: 'start', sender_name: SENDER })` |
| "M1 aguardando Y" | `taskflow_move({ task_id: 'M1', action: 'wait', reason: 'Y', sender_name: SENDER })` |
| "M1 retomada" | `taskflow_move({ task_id: 'M1', action: 'resume', sender_name: SENDER })` |
| "M1 pronta para revisao" | `taskflow_move({ task_id: 'M1', action: 'review', sender_name: SENDER })` |
| "M1 concluida" | `taskflow_move({ task_id: 'M1', action: 'conclude', sender_name: SENDER })` |
| "cancelar M1" | `taskflow_admin({ action: 'cancel_task', task_id: 'M1', sender_name: SENDER })` |

When moving a meeting to `done`, if open notes remain, include the soft warning in your response:
`⚠️ Reunião concluída com itens de ata ainda abertos. Use "processar ata M1" para triagem.`

### Meeting Triage (Action-Item Extraction)

| User says | Tool call |
|-----------|-----------|
| "processar ata M1" | `taskflow_admin({ action: 'process_minutes', task_id: 'M1', sender_name: SENDER })` |

For each open item returned by `process_minutes`, ask the user to choose:
- **Criar tarefa:** `taskflow_admin({ action: 'process_minutes_decision', task_id: 'M1', note_id: N, decision: 'create_task', create: { type: 'simple', title: '...', assignee: '...', labels: ['ata:M1'] }, sender_name: SENDER })`
- **Criar item inbox:** `taskflow_admin({ action: 'process_minutes_decision', task_id: 'M1', note_id: N, decision: 'create_inbox', create: { type: 'inbox', title: '...', labels: ['ata:M1'] }, sender_name: SENDER })`
- **Marcar resolvido:** `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'checked' } }, sender_name: SENDER })`
- **Descartar:** `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'dismissed' } }, sender_name: SENDER })`

### Meeting Queries

| User says | Tool call |
|-----------|-----------|
| "reunioes" | `taskflow_query({ query: 'meetings' })` |
| "pauta M1" | `taskflow_query({ query: 'meeting_agenda', task_id: 'M1' })` |
| "ata M1" | `taskflow_query({ query: 'meeting_minutes', task_id: 'M1' })` |
| "proximas reunioes" | `taskflow_query({ query: 'upcoming_meetings' })` |
| "itens abertos M1" | `taskflow_query({ query: 'meeting_open_items', task_id: 'M1' })` |
| "historico reuniao M1" | `taskflow_query({ query: 'meeting_history', task_id: 'M1' })` |
| "ata M1 de DD/MM/YYYY" | `taskflow_query({ query: 'meeting_minutes_at', task_id: 'M1', at: 'YYYY-MM-DD' })` |
```

2. **In Board View Format** — add meeting display rule:

```markdown
### Meeting Display

Meetings appear with the 📅 prefix:
```text
📅 M1 (12/03 14:00): Alinhamento semanal — 3 participantes
```

Meetings do NOT count against WIP limits.
```

3. **In Schema Reference** — add `participants TEXT` and `scheduled_at TEXT` to the tasks table, and describe the extended note structure for meetings.

4. **In Standup/Digest/Weekly** sections — add upcoming meeting and open-minutes warning references.

**Step 4: Run test to verify it passes**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts -t "CLAUDE.md.template has meeting commands"`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat(meeting): CLAUDE.md template with meeting commands, display, triage, and schema"
```

---

## Task 12: Skill Package Snapshots & Full Test Run

**Files:**
- Update: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- Update: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- Update: `.claude/skills/add-taskflow/CHANGELOG.md`
- Test: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

**Step 1: Final skill-package consistency pass**

Review the packaged engine snapshot, MCP schema snapshot, template, and tests together. Implement all remaining meeting changes directly in `.claude/skills/add-taskflow/**`; do not copy from live runtime files.

**Step 2: Run skill package tests**

Run: `cd /root/nanoclaw && npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: ALL PASS (existing tests should not break; new meeting tests pass)

**Step 3: Update CHANGELOG**

Add a new entry to `.claude/skills/add-taskflow/CHANGELOG.md` at the top, documenting:
- Meeting type with M-prefix
- Participants and scheduled_at schema
- Phase-tagged notes
- 8 meeting query types
- process_minutes / process_minutes_decision
- WIP exclusion
- Board view + report integration
- MCP schema updates
- CLAUDE.md template meeting sections

**Step 4: Commit**

```bash
git add .claude/skills/add-taskflow/
git commit -m "feat(meeting): sync skill package snapshots and add CHANGELOG entry"
```

---

Deployment to the live runtime is intentionally out of scope for this implementation plan. If rollout is needed later, create a separate deployment plan after the skill package implementation is complete and the packaged tests are green.
