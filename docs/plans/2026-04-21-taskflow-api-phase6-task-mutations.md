# Phase 6: Task Mutation Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move POST /tasks and PATCH /tasks/:id off direct Python SQL and onto the TaskFlow engine via MCP, while preserving the existing REST contract for the dashboard.

**Architecture:** Each mutation route calls `call_mcp_mutation` (already implemented in Phase 4) which dispatches to a new MCP tool in the Node subprocess. The Node adapter executes direct SQL rather than wrapping `engine.create()`/`engine.update()` to avoid column-default, manager-check, and notes-replacement incompatibilities. Actor resolution (Phase 3), error codes, notification routing, and event invalidation (Phase 4) are all in place.

**Tech Stack:** Python/FastAPI, TypeScript/Node.js, SQLite, JSON-RPC over stdio (MCP protocol), pytest, vitest

---

### Task 0: Add apiCreateSimpleTask to TaskflowEngine

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
- Create: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts` (or modify if exists)

**Context:** `engine.createTaskInternal()` hardcodes the column based on task type and cannot accept a `column` parameter. The REST API defaults new tasks to `'inbox'` regardless. We write a separate adapter method using direct SQL so the column is always set correctly and there is no manager-check or assignee auto-assignment.

The adapter return shape is:
- Success: `{ success: true, data: serializeApiTask(...), notification_events: [{kind, board_id, target_person_id, message}] }`
- Error: `{ success: false, error_code: 'not_found'|'validation_error'|'conflict', error: string }`

**Step 1: Create the test helper and write failing tests**

Create `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskflowEngine } from './taskflow-engine.js';

function createMutationTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY,
      board_code TEXT NOT NULL DEFAULT '',
      name TEXT,
      org_id TEXT,
      owner TEXT,
      config TEXT
    );
    CREATE TABLE board_people (
      board_id TEXT,
      person_id TEXT,
      name TEXT,
      role TEXT,
      phone TEXT
    );
    CREATE TABLE board_id_counters (
      board_id TEXT PRIMARY KEY,
      next_id INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT,
      column_name TEXT,
      title TEXT,
      description TEXT,
      assignee TEXT,
      priority TEXT,
      due_date TEXT,
      notes TEXT,
      tags TEXT,
      parent_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      requires_close_approval INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      action TEXT,
      by TEXT,
      details TEXT,
      created_at TEXT
    );
    INSERT INTO boards (id, board_code, name, org_id, owner)
      VALUES ('board-001', 'B001', 'Test Board', 'org-1', 'person-1');
    INSERT INTO board_people (board_id, person_id, name, role)
      VALUES ('board-001', 'person-1', 'Alice', 'Gestor'),
             ('board-001', 'person-2', 'Bob', 'Tecnico');
    INSERT INTO board_id_counters (board_id, next_id) VALUES ('board-001', 1);
  `);
  return db;
}

describe('apiCreateSimpleTask', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = createMutationTestDb();
    engine = new TaskflowEngine(db);
  });

  afterEach(() => { db.close(); });

  it('creates a task with default column and priority', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001',
      title: 'Test task',
      sender_name: 'Alice',
    });
    expect(result.success).toBe(true);
    expect((result as any).data.title).toBe('Test task');
    expect((result as any).data.column).toBe('inbox');
    expect((result as any).data.priority).toBe('normal');
    expect((result as any).notification_events).toEqual([]);
  });

  it('allocates a T-number task id', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001',
      title: 'My task',
      sender_name: 'Alice',
    });
    expect((result as any).data.id).toMatch(/^T\d+$/);
  });

  it('records a created history entry', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001',
      title: 'Hist task',
      sender_name: 'Alice',
    });
    const taskId = (result as any).data.id;
    const hist = db.prepare(
      "SELECT * FROM task_history WHERE task_id = ? AND action = 'created'"
    ).get(taskId);
    expect(hist).toBeTruthy();
  });

  it('assigns to named person and emits deferred notification', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001',
      title: 'Assigned task',
      sender_name: 'Alice',
      assignee: 'Bob',
    });
    expect((result as any).data.assignee).toBe('Bob');
    expect((result as any).notification_events).toHaveLength(1);
    const ev = (result as any).notification_events[0];
    expect(ev.kind).toBe('deferred_notification');
    expect(ev.target_person_id).toBe('person-2');
  });

  it('does not emit notification when sender assigns to self', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001',
      title: 'Self-assigned',
      sender_name: 'Alice',
      assignee: 'Alice',
    });
    expect((result as any).notification_events).toHaveLength(0);
  });

  it('returns validation_error for unknown assignee', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001',
      title: 'Bad assignee',
      sender_name: 'Alice',
      assignee: 'nobody',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('validation_error');
  });

  it('normalizes English priority to Portuguese', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001',
      title: 'Urgent task',
      sender_name: 'Alice',
      priority: 'urgent',
    });
    expect((result as any).data.priority).toBe('urgente');
  });

  it('returns not_found when board has no counter row', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-999',
      title: 'No board',
      sender_name: 'Alice',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('not_found');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -30"
```

Expected: tests fail with `engine.apiCreateSimpleTask is not a function`.

**Step 3: Add apiCreateSimpleTask to TaskflowEngine**

In `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`, add after the `apiLinkedTasks` method:

```typescript
async apiCreateSimpleTask(params: {
  board_id: string;
  title: string;
  sender_name: string;
  column?: string;
  description?: string | null;
  assignee?: string | null;
  priority?: string;
  due_date?: string | null;
  tags?: string | null;
}): Promise<
  | { success: true; data: any; notification_events: Array<{ kind: string; board_id: string; target_person_id: string; message: string }> }
  | { success: false; error_code: string; error: string }
> {
  const { board_id, title, sender_name } = params;

  let assigneeDisplayName: string | null = null;
  let assigneePersonId: string | null = null;
  if (params.assignee) {
    const person = this.db.prepare(
      'SELECT person_id, name FROM board_people WHERE board_id = ? AND (name = ? OR person_id = ?)'
    ).get(board_id, params.assignee, params.assignee) as { person_id: string; name: string } | undefined;
    if (!person) {
      return { success: false, error_code: 'validation_error', error: `Assignee not found: ${params.assignee}` };
    }
    assigneeDisplayName = person.name;
    assigneePersonId = person.person_id;
  }

  const counterRow = this.db.prepare(
    'UPDATE board_id_counters SET next_id = next_id + 1 WHERE board_id = ? RETURNING next_id - 1 AS allocated'
  ).get(board_id) as { allocated: number } | undefined;
  if (!counterRow) {
    return { success: false, error_code: 'not_found', error: `Board not found: ${board_id}` };
  }
  const taskId = `T${counterRow.allocated}`;
  const now = new Date().toISOString();

  const priorityMap: Record<string, string> = {
    urgent: 'urgente', high: 'alta', normal: 'normal', low: 'baixa',
    urgente: 'urgente', alta: 'alta', baixa: 'baixa',
  };
  const priority = priorityMap[params.priority ?? 'normal'] ?? 'normal';
  const column = params.column ?? 'inbox';

  this.db.prepare(`
    INSERT INTO tasks (id, board_id, column_name, title, description, assignee, priority, due_date, notes, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
  `).run(taskId, board_id, column, title, params.description ?? null, assigneeDisplayName, priority, params.due_date ?? null, params.tags ?? null, now, now);

  this.recordHistory(taskId, 'created', 'web-api');

  const taskRow = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  const data = this.serializeApiTask(taskRow, board_id);

  const notification_events: Array<{ kind: string; board_id: string; target_person_id: string; message: string }> = [];
  if (assigneePersonId) {
    const senderRow = this.db.prepare(
      'SELECT person_id FROM board_people WHERE board_id = ? AND name = ?'
    ).get(board_id, sender_name) as { person_id: string } | undefined;
    if (!senderRow || senderRow.person_id !== assigneePersonId) {
      notification_events.push({
        kind: 'deferred_notification',
        board_id,
        target_person_id: assigneePersonId,
        message: `${sender_name} assigned you: ${title}`,
      });
    }
  }

  return { success: true, data, notification_events };
}
```

**Step 4: Run tests to verify they pass**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -30"
```

Expected: all `apiCreateSimpleTask` tests pass.

**Step 5: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts && git commit -m 'feat: add apiCreateSimpleTask adapter to TaskflowEngine'"
```

---

### Task 1: Register api_create_simple_task MCP Tool

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.ts`

**Context:** Phase 5 tools use `contentFromResult` for read tools. Mutation tools return JSON directly: `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`. The Python `call_mcp_mutation` helper parses `content[0].text` as JSON and then calls `parse_mcp_mutation_result`.

**Step 1: Write the failing TypeScript test**

Add to `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.test.ts` (create if it does not exist, otherwise append):

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TaskflowEngine } from './taskflow-engine.js';
import { createServer } from './taskflow-mcp-server.js';

// Re-use createMutationTestDb from taskflow-engine.test.ts or inline it here
function createMutationTestDb(): Database.Database {
  // ... same as in Task 0 ...
}

async function callTool(engine: TaskflowEngine, toolName: string, args: Record<string, unknown>) {
  const server = createServer(engine);
  // Access the registered tool handler directly for unit testing
  const handler = (server as any)._registeredTools?.get(toolName);
  if (!handler) throw new Error(`Tool not registered: ${toolName}`);
  return handler.callback(args);
}

describe('api_create_simple_task MCP tool', () => {
  it('returns JSON content with success shape', async () => {
    const db = createMutationTestDb();
    const engine = new TaskflowEngine(db);
    const result = await callTool(engine, 'api_create_simple_task', {
      board_id: 'board-001',
      title: 'Integration task',
      sender_name: 'Alice',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.title).toBe('Integration task');
    expect(parsed.data.column).toBe('inbox');
    expect(Array.isArray(parsed.notification_events)).toBe(true);
    db.close();
  });

  it('propagates validation_error from engine', async () => {
    const db = createMutationTestDb();
    const engine = new TaskflowEngine(db);
    const result = await callTool(engine, 'api_create_simple_task', {
      board_id: 'board-001',
      title: 'Bad',
      sender_name: 'Alice',
      assignee: 'nobody',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('validation_error');
    db.close();
  });
});
```

**Step 2: Verify test fails**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -20"
```

Expected: `Tool not registered: api_create_simple_task`.

**Step 3: Register the tool in taskflow-mcp-server.ts**

After the `api_linked_tasks` tool registration, add:

```typescript
server.tool(
  'api_create_simple_task',
  {
    board_id: z.string(),
    title: z.string(),
    sender_name: z.string(),
    column: z.string().optional(),
    description: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    priority: z.string().optional(),
    due_date: z.string().nullable().optional(),
    tags: z.string().nullable().optional(),
  },
  async (params) => {
    const result = await engine.apiCreateSimpleTask(params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }
);
```

**Step 4: Run tests to verify they pass**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -20"
```

**Step 5: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts && git commit -m 'feat: register api_create_simple_task MCP tool'"
```

---

### Task 2: Migrate Python POST /tasks to call_mcp_mutation

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py`
- Modify: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`

**Context:** The current `create_task` route uses direct SQL + `notify_task_created`. Replace the body with `call_mcp_mutation`. All tests run against `FakeMCPClient` by default (conftest sets `TASKFLOW_DISABLE_MCP_SUBPROCESS=1`). Integration tests use `monkeypatch.delenv` and a real subprocess.

`call_mcp_mutation` returns `result["data"]` on success or raises `HTTPException` on error. Route returns 201.

`ensure_board_access_prechecked` handles board existence + org access in one call. `resolve_board_actor` returns `ResolvedApiServiceActor` (has `.service_name`) for agent tokens or `ResolvedTaskflowActor` (has `.display_name`) for JWT users.

**Step 1: Write the FakeMCPClient unit tests**

First add a `fake_mcp_app` fixture to `tests/conftest.py` (or at the top of `test_api.py` if it does not conflict):

```python
@pytest.fixture
def fake_mcp_app():
    from app.engine.fake_client import FakeMCPClient
    application = main_module.create_app()
    application.state.mcp_client = FakeMCPClient()
    return TestClient(application, raise_server_exceptions=False)
```

Then add to `tests/test_api.py`:

```python
def test_create_task_returns_201_on_mcp_success(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_create_simple_task", {
        "success": True,
        "data": {
            "id": "T1", "title": "My task", "column": "inbox",
            "description": None, "assignee": None, "priority": "normal",
            "due_date": None, "tags": None, "parent_id": None,
            "created_at": "2026-01-01T00:00:00", "updated_at": "2026-01-01T00:00:00",
        },
        "notification_events": [],
    })
    resp = fake_mcp_app.post(
        "/tasks",
        json={"title": "My task", "board_id": "board-001"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    assert resp.json()["id"] == "T1"
    assert resp.json()["title"] == "My task"


def test_create_task_returns_409_on_conflict(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_create_simple_task", {
        "success": False, "error_code": "conflict", "error": "Duplicate task",
    })
    resp = fake_mcp_app.post(
        "/tasks",
        json={"title": "Dup", "board_id": "board-001"},
        headers=auth_headers,
    )
    assert resp.status_code == 409


def test_create_task_returns_422_on_validation_error(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_create_simple_task", {
        "success": False, "error_code": "validation_error", "error": "Bad assignee",
    })
    resp = fake_mcp_app.post(
        "/tasks",
        json={"title": "Bad", "board_id": "board-001", "assignee": "nobody"},
        headers=auth_headers,
    )
    assert resp.status_code == 422


def test_create_task_requires_board_id(fake_mcp_app):
    resp = fake_mcp_app.post(
        "/tasks",
        json={"title": "No board"},
        headers=auth_headers,
    )
    assert resp.status_code == 422
```

**Step 2: Verify these 4 tests fail**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py::test_create_task_returns_201_on_mcp_success tests/test_api.py::test_create_task_returns_409_on_conflict -v 2>&1 | tail -20"
```

Expected: FAIL — route uses direct SQL not call_mcp_mutation.

**Step 3: Migrate the create_task route**

In `app/main.py`, replace the body of the `create_task` endpoint (search for `@router.post("/tasks"` or the equivalent decorator):

```python
@router.post("/tasks", status_code=201)
async def create_task(request: Request, raw_body: dict = Body(...)):
    board_id = raw_body.get("board_id")
    if not board_id:
        raise HTTPException(status_code=422, detail="board_id required")

    await ensure_board_access_prechecked(request, board_id)
    actor = await resolve_board_actor(request, board_id)
    sender_name = (
        actor.display_name if hasattr(actor, "display_name") else actor.service_name
    )

    mcp_args: dict = {"board_id": board_id, "sender_name": sender_name}
    for field in ("title", "column", "description", "assignee", "priority", "due_date", "tags"):
        if field in raw_body:
            mcp_args[field] = raw_body[field]

    result = await call_mcp_mutation(request, "api_create_simple_task", mcp_args)
    return result["data"]
```

**Step 4: Run the 4 new tests plus any existing create-task tests**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py -k 'create_task' -v 2>&1 | tail -30"
```

Expected: all pass.

**Step 5: Run full suite to check for regressions**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/ -x --ignore=tests/test_api.py -q && python -m pytest tests/test_api.py -q 2>&1 | tail -20"
```

**Step 6: Commit**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && git add app/main.py tests/test_api.py tests/conftest.py && git commit -m 'feat: migrate POST /tasks to call_mcp_mutation'"
```

---

### Task 3: Add apiUpdateSimpleTask to TaskflowEngine

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts`

**Context:** `engine.updateTask()` does not handle column moves, notes wholesale-replace, or the partial-update semantics the REST API needs. The `'field' in params` TypeScript check works here because Zod `.optional()` leaves absent keys out of the parsed object entirely (they are not present as `undefined`).

Move rules to enforce:
- Moving to `done` when `requires_close_approval = 1` → `conflict` error

Notes: the REST API's `PATCH /tasks/:id` can replace the `notes` JSON blob wholesale; that is fine because the Python layer was already doing this with direct SQL, so we preserve the same behavior.

**Step 1: Write failing tests**

Append to `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts`:

```typescript
describe('apiUpdateSimpleTask', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;
  let taskId: string;

  beforeEach(async () => {
    db = createMutationTestDb();
    engine = new TaskflowEngine(db);
    const created = await engine.apiCreateSimpleTask({
      board_id: 'board-001',
      title: 'Original title',
      sender_name: 'Alice',
    });
    taskId = (created as any).data.id;
  });

  afterEach(() => { db.close(); });

  it('updates a present field', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      title: 'Updated title',
    });
    expect(result.success).toBe(true);
    expect((result as any).data.title).toBe('Updated title');
  });

  it('does not alter absent fields', async () => {
    await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      title: 'New title',
    });
    const row = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(taskId) as any;
    expect(row.priority).toBe('normal');
  });

  it('sets field to null when null is explicitly passed', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      description: null,
    });
    expect((result as any).data.description).toBeNull();
  });

  it('records an updated history entry', async () => {
    await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      title: 'Changed',
    });
    const hist = db.prepare(
      "SELECT * FROM task_history WHERE task_id = ? AND action = 'updated'"
    ).get(taskId);
    expect(hist).toBeTruthy();
  });

  it('returns not_found for unknown task_id', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: 'T999',
      sender_name: 'Alice',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('not_found');
  });

  it('returns conflict when moving to done with close_approval required', async () => {
    db.prepare('UPDATE tasks SET requires_close_approval = 1 WHERE id = ?').run(taskId);
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      column: 'done',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('conflict');
  });

  it('allows moving to done when close_approval is not required', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      column: 'done',
    });
    expect(result.success).toBe(true);
    expect((result as any).data.column).toBe('done');
  });

  it('emits deferred notification when assignee changes to someone else', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      assignee: 'Bob',
    });
    expect((result as any).notification_events).toHaveLength(1);
    expect((result as any).notification_events[0].target_person_id).toBe('person-2');
  });

  it('returns validation_error for unknown assignee', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      assignee: 'nobody',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('validation_error');
  });

  it('clears assignee when null is passed', async () => {
    await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      assignee: 'Bob',
    });
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      assignee: null,
    });
    expect((result as any).data.assignee).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -30"
```

Expected: `apiUpdateSimpleTask` tests fail.

**Step 3: Add apiUpdateSimpleTask to TaskflowEngine**

In `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`, add after `apiCreateSimpleTask`:

```typescript
async apiUpdateSimpleTask(params: {
  board_id: string;
  task_id: string;
  sender_name: string;
  column?: string;
  title?: string;
  description?: string | null;
  assignee?: string | null;
  priority?: string;
  due_date?: string | null;
  notes?: string | null;
  tags?: string | null;
}): Promise<
  | { success: true; data: any; notification_events: Array<{ kind: string; board_id: string; target_person_id: string; message: string }> }
  | { success: false; error_code: string; error: string }
> {
  const { board_id, task_id, sender_name } = params;

  const existing = this.db.prepare(
    'SELECT * FROM tasks WHERE id = ? AND board_id = ?'
  ).get(task_id, board_id) as any;
  if (!existing) {
    return { success: false, error_code: 'not_found', error: `Task not found: ${task_id}` };
  }

  if ('column' in params && params.column === 'done' && existing.requires_close_approval) {
    return { success: false, error_code: 'conflict', error: 'Task requires close approval before moving to done' };
  }

  let assigneeDisplayName: string | null | undefined = undefined;
  let newAssigneePersonId: string | null = null;
  if ('assignee' in params) {
    if (params.assignee === null) {
      assigneeDisplayName = null;
    } else {
      const person = this.db.prepare(
        'SELECT person_id, name FROM board_people WHERE board_id = ? AND (name = ? OR person_id = ?)'
      ).get(board_id, params.assignee, params.assignee) as { person_id: string; name: string } | undefined;
      if (!person) {
        return { success: false, error_code: 'validation_error', error: `Assignee not found: ${params.assignee}` };
      }
      assigneeDisplayName = person.name;
      newAssigneePersonId = person.person_id;
    }
  }

  const setClauses: string[] = ['updated_at = ?'];
  const setValues: any[] = [new Date().toISOString()];

  if ('column' in params) { setClauses.push('column_name = ?'); setValues.push(params.column); }
  if ('title' in params) { setClauses.push('title = ?'); setValues.push(params.title); }
  if ('description' in params) { setClauses.push('description = ?'); setValues.push(params.description); }
  if ('assignee' in params) { setClauses.push('assignee = ?'); setValues.push(assigneeDisplayName); }
  if ('priority' in params) {
    const priorityMap: Record<string, string> = {
      urgent: 'urgente', high: 'alta', normal: 'normal', low: 'baixa',
      urgente: 'urgente', alta: 'alta', baixa: 'baixa',
    };
    setClauses.push('priority = ?');
    setValues.push(priorityMap[params.priority!] ?? params.priority);
  }
  if ('due_date' in params) { setClauses.push('due_date = ?'); setValues.push(params.due_date); }
  if ('notes' in params) { setClauses.push('notes = ?'); setValues.push(params.notes); }
  if ('tags' in params) { setClauses.push('tags = ?'); setValues.push(params.tags); }

  this.db.prepare(
    `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
  ).run(...setValues, task_id);

  this.recordHistory(task_id, 'updated', 'web-api');

  const taskRow = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id) as any;
  const data = this.serializeApiTask(taskRow, board_id);

  const notification_events: Array<{ kind: string; board_id: string; target_person_id: string; message: string }> = [];
  if (newAssigneePersonId) {
    const senderRow = this.db.prepare(
      'SELECT person_id FROM board_people WHERE board_id = ? AND name = ?'
    ).get(board_id, sender_name) as { person_id: string } | undefined;
    if (!senderRow || senderRow.person_id !== newAssigneePersonId) {
      notification_events.push({
        kind: 'deferred_notification',
        board_id,
        target_person_id: newAssigneePersonId,
        message: `${sender_name} assigned you: ${taskRow.title}`,
      });
    }
  }

  return { success: true, data, notification_events };
}
```

**Step 4: Run tests to verify they pass**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -30"
```

**Step 5: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts && git commit -m 'feat: add apiUpdateSimpleTask adapter to TaskflowEngine'"
```

---

### Task 4: Register api_update_simple_task MCP Tool

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.ts`
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.test.ts`

**Step 1: Write failing test**

Append to `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.test.ts`:

```typescript
describe('api_update_simple_task MCP tool', () => {
  it('updates task and returns serialized shape', async () => {
    const db = createMutationTestDb();
    const engine = new TaskflowEngine(db);
    const created = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Old title', sender_name: 'Alice',
    });
    const taskId = (created as any).data.id;

    const result = await callTool(engine, 'api_update_simple_task', {
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      title: 'New title',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.title).toBe('New title');
    db.close();
  });

  it('propagates conflict error from engine', async () => {
    const db = createMutationTestDb();
    const engine = new TaskflowEngine(db);
    const created = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Locked', sender_name: 'Alice',
    });
    const taskId = (created as any).data.id;
    db.prepare('UPDATE tasks SET requires_close_approval = 1 WHERE id = ?').run(taskId);

    const result = await callTool(engine, 'api_update_simple_task', {
      board_id: 'board-001',
      task_id: taskId,
      sender_name: 'Alice',
      column: 'done',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('conflict');
    db.close();
  });
});
```

**Step 2: Verify test fails**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -20"
```

**Step 3: Register the tool in taskflow-mcp-server.ts**

After `api_create_simple_task` registration, add:

```typescript
server.tool(
  'api_update_simple_task',
  {
    board_id: z.string(),
    task_id: z.string(),
    sender_name: z.string(),
    column: z.string().optional(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    priority: z.string().optional(),
    due_date: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    tags: z.string().nullable().optional(),
  },
  async (params) => {
    const result = await engine.apiUpdateSimpleTask(params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }
);
```

**Step 4: Run tests to verify they pass**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -20"
```

**Step 5: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts && git commit -m 'feat: register api_update_simple_task MCP tool'"
```

---

### Task 5: Migrate Python PATCH /tasks/:id to call_mcp_mutation

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py`
- Modify: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`

**Context:** The `update_task` route currently calls `enforce_move_or_delete_rules`, `notify_task_moved`, `notify_task_reassigned` directly. These move rules are now enforced inside the Node adapter — the Python route just calls `call_mcp_mutation` and returns the data.

Three existing tests tested behavior that was Python-implemented. Rewrite them to use the `fake_mcp_app` fixture (introduced in Task 2) with canned error responses:
- `test_patch_rejects_recurring_task_moves`
- `test_patch_rejects_done_without_close_approval`
- `test_patch_updates_present_fields_and_clears_explicit_nulls`

Note: the route needs the task's `board_id` when it is not in the request body (for `PATCH /tasks/:id`, board_id is usually not in the body). Look up the task's board_id from the DB using `get_db()`.

**Step 1: Write the FakeMCPClient unit tests for PATCH**

Add to `tests/test_api.py`:

```python
def test_patch_task_returns_200_on_mcp_success(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": True,
        "data": {
            "id": "T1", "title": "Updated", "column": "in_progress",
            "description": None, "assignee": None, "priority": "normal",
            "due_date": None, "tags": None, "parent_id": None,
            "created_at": "2026-01-01T00:00:00", "updated_at": "2026-01-01T01:00:00",
        },
        "notification_events": [],
    })
    resp = fake_mcp_app.patch(
        "/tasks/T1",
        json={"title": "Updated"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "Updated"


def test_patch_task_returns_404_on_not_found(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": False, "error_code": "not_found", "error": "Task not found: T999",
    })
    resp = fake_mcp_app.patch(
        "/tasks/T999",
        json={"title": "X"},
        headers=auth_headers,
    )
    assert resp.status_code == 404
```

**Step 2: Rewrite three existing tests to use FakeMCPClient**

Replace `test_patch_rejects_recurring_task_moves`:

```python
def test_patch_rejects_recurring_task_moves(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": False, "error_code": "conflict",
        "error": "Cannot move recurring task",
    })
    resp = fake_mcp_app.patch(
        "/tasks/T1",
        json={"column": "done"},
        headers=auth_headers,
    )
    assert resp.status_code == 409
```

Replace `test_patch_rejects_done_without_close_approval`:

```python
def test_patch_rejects_done_without_close_approval(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": False, "error_code": "conflict",
        "error": "Task requires close approval before moving to done",
    })
    resp = fake_mcp_app.patch(
        "/tasks/T1",
        json={"column": "done"},
        headers=auth_headers,
    )
    assert resp.status_code == 409
```

Replace `test_patch_updates_present_fields_and_clears_explicit_nulls`:

```python
def test_patch_updates_present_fields_and_clears_explicit_nulls(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": True,
        "data": {
            "id": "T1", "title": "New title", "column": "inbox",
            "description": None, "assignee": "Alice", "priority": "alta",
            "due_date": None, "tags": None, "parent_id": None,
            "created_at": "2026-01-01T00:00:00", "updated_at": "2026-01-01T01:00:00",
        },
        "notification_events": [],
    })
    resp = fake_mcp_app.patch(
        "/tasks/T1",
        json={"title": "New title", "description": None},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "New title"
    assert resp.json()["description"] is None
```

**Step 3: Verify these tests fail**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py -k 'patch_task or patch_rejects or patch_updates' -v 2>&1 | tail -30"
```

Expected: FAIL — route still uses direct SQL.

**Step 4: Migrate the update_task route**

In `app/main.py`, replace the body of the `update_task` endpoint (search for `@router.patch("/tasks/{task_id}"` or equivalent):

```python
@router.patch("/tasks/{task_id}", status_code=200)
async def update_task(task_id: str, request: Request, raw_body: dict = Body(...)):
    board_id = raw_body.get("board_id")
    if not board_id:
        with get_db() as db:
            row = db.execute(
                "SELECT board_id FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Task not found")
        board_id = row["board_id"]

    await ensure_board_access_prechecked(request, board_id)
    actor = await resolve_board_actor(request, board_id)
    sender_name = (
        actor.display_name if hasattr(actor, "display_name") else actor.service_name
    )

    mcp_args: dict = {
        "board_id": board_id,
        "task_id": task_id,
        "sender_name": sender_name,
    }
    for field in ("column", "title", "description", "assignee", "priority", "due_date", "notes", "tags"):
        if field in raw_body:
            mcp_args[field] = raw_body[field]

    result = await call_mcp_mutation(request, "api_update_simple_task", mcp_args)
    return result["data"]
```

**Step 5: Run all PATCH-related tests**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py -k 'patch' -v 2>&1 | tail -30"
```

Expected: all pass.

**Step 6: Run full Python test suite**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/ -q 2>&1 | tail -20"
```

Expected: all pass (no regressions).

**Step 7: Commit**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && git add app/main.py tests/test_api.py && git commit -m 'feat: migrate PATCH /tasks/:id to call_mcp_mutation'"
```

---

### Task 6: Full Suite Verification and Redesign Doc Update

**Files:**
- Read/Modify: `/root/nanoclaw/docs/plans/2026-04-20-taskflow-api-channel-redesign.md`

**Step 1: Run complete Python test suite**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/ -v 2>&1 | tail -30"
```

Expected: all non-integration tests pass; count should exceed the 143 baseline from before Phase 4.

**Step 2: Run TypeScript test suite**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run 2>&1 | tail -20"
```

Expected: all tests pass including the new `apiCreateSimpleTask` and `apiUpdateSimpleTask` suites.

**Step 3: Update the redesign doc**

In `/root/nanoclaw/docs/plans/2026-04-20-taskflow-api-channel-redesign.md`:

1. In "What is still not done": remove Phase 6 (now complete). What remains is only Phase 7 (comments and chat).

2. Update "Immediate Next Step" prerequisites checklist — all 6 items checked:

```
- [x] Actor resolution is deterministic
- [x] Error codes are structured and stable
- [x] Notification routing is unified
- [x] Event invalidation is explicit
- [x] call_mcp_mutation helper handles full pipeline
- [x] API compatibility tests green against adapter path
```

3. Add a Phase 6 completion note (beside the Phase 5 note) recording what was done:
   - `apiCreateSimpleTask` and `apiUpdateSimpleTask` in TaskflowEngine
   - `api_create_simple_task` and `api_update_simple_task` MCP tools registered
   - POST /tasks and PATCH /tasks/:id now delegate to MCP
   - Direct Python SQL and `notify_task_created` / `notify_task_moved` / `notify_task_reassigned` removed from those routes

4. Update "Immediate Next Step" to: Phase 7 — decide whether comments and board chat stay API-owned or are promoted to explicit adapter surfaces. The redesign doc's Phase 7 guidance remains valid.

**Step 4: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add docs/plans/2026-04-20-taskflow-api-channel-redesign.md && git commit -m 'docs: mark Phase 6 complete, update prerequisites and next step to Phase 7'"
```
