# Phase 6: Task Mutation Migration + Ownership Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move POST /tasks and PATCH /tasks/:id off direct Python SQL and onto the TaskFlow engine via MCP, and simultaneously close the ownership gap: add `created_by` to tasks, enforce per-task authorization (creator | assignee | Gestor), fix comment authorship, and gate action buttons in the frontend.

**Architecture:** Mutations route through `call_mcp_mutation` to two new Node adapter methods. Authorization is enforced inside the Node adapter (it has DB access and board context). Comment authorship is fixed in Python by using the resolved actor identity instead of the client-supplied field. Frontend derives a `canModify` flag from `user.name` vs `task.created_by` / `task.assignee` and the user's board role.

**Tech Stack:** Python/FastAPI, TypeScript/Node.js, SQLite, JSON-RPC over stdio (MCP), pytest, vitest, React/TypeScript (frontend)

---

### Task 0: DB Migration — add created_by to tasks

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py`

**Context:** The migrations block (around line 754) already uses the `try/except` + `ALTER TABLE ... ADD COLUMN` pattern. Add `created_by TEXT` to `tasks`. Existing rows will have `NULL` — the downstream policy treats `NULL` as "unowned" (any board member may modify), preserving backwards compatibility.

**Step 1: Write a failing test that checks created_by is present**

Add to `tests/test_api.py`:

```python
def test_tasks_table_has_created_by_column():
    with main_module.db_connection() as conn:
        cols = [row[1] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()]
        assert "created_by" in cols, "tasks table is missing created_by column"
```

**Step 2: Run it to verify it fails**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py::test_tasks_table_has_created_by_column -v 2>&1 | tail -10"
```

Expected: FAIL — column does not exist yet.

**Step 3: Add the migration**

In `app/main.py`, inside the migrations block, add after the last existing `ALTER TABLE tasks ADD COLUMN` statement:

```python
try:
    conn.execute("ALTER TABLE tasks ADD COLUMN created_by TEXT")
except sqlite3.OperationalError:
    pass
```

**Step 4: Run the test to verify it passes**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py::test_tasks_table_has_created_by_column -v 2>&1 | tail -10"
```

**Step 5: Update serialize_task to include created_by**

In `app/main.py`, in the `serialize_task` function (line 1530), add after `"updated_at"`:

```python
"created_by": raw.get("created_by"),
```

**Step 6: Run the full Python suite to confirm no regressions**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/ -q 2>&1 | tail -10"
```

**Step 7: Commit**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && git add app/main.py tests/test_api.py && git commit -m 'feat: add created_by column to tasks and expose in serialize_task'"
```

---

### Task 1: Add apiCreateSimpleTask to TaskflowEngine

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
- Create: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts`

**Context:** `engine.createTaskInternal()` hardcodes the column and cannot accept a `column` parameter. The REST API defaults to `'inbox'`. Write a separate adapter method with direct SQL. It sets `created_by = sender_name`, stores it in the DB, and returns it in the serialized shape.

`serializeApiTask` must also be updated to return `created_by`.

**Step 1: Create the test helper and write failing tests**

Create `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskflowEngine } from './taskflow-engine.js';

export function createMutationTestDb(): Database.Database {
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
      created_by TEXT,
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
      board_id: 'board-001', title: 'Test task', sender_name: 'Alice',
    });
    expect(result.success).toBe(true);
    expect((result as any).data.title).toBe('Test task');
    expect((result as any).data.column).toBe('inbox');
    expect((result as any).data.priority).toBe('normal');
    expect((result as any).notification_events).toEqual([]);
  });

  it('sets created_by to sender_name', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Owned', sender_name: 'Alice',
    });
    expect((result as any).data.created_by).toBe('Alice');
  });

  it('allocates a T-number task id', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'My task', sender_name: 'Alice',
    });
    expect((result as any).data.id).toMatch(/^T\d+$/);
  });

  it('records a created history entry', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Hist task', sender_name: 'Alice',
    });
    const taskId = (result as any).data.id;
    const hist = db.prepare(
      "SELECT * FROM task_history WHERE task_id = ? AND action = 'created'"
    ).get(taskId);
    expect(hist).toBeTruthy();
  });

  it('assigns to named person and emits deferred notification', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Assigned', sender_name: 'Alice', assignee: 'Bob',
    });
    expect((result as any).data.assignee).toBe('Bob');
    expect((result as any).notification_events).toHaveLength(1);
    const ev = (result as any).notification_events[0];
    expect(ev.kind).toBe('deferred_notification');
    expect(ev.target_person_id).toBe('person-2');
  });

  it('does not emit notification when sender self-assigns', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Self', sender_name: 'Alice', assignee: 'Alice',
    });
    expect((result as any).notification_events).toHaveLength(0);
  });

  it('returns validation_error for unknown assignee', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Bad', sender_name: 'Alice', assignee: 'nobody',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('validation_error');
  });

  it('normalizes English priority to Portuguese', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Urgent', sender_name: 'Alice', priority: 'urgent',
    });
    expect((result as any).data.priority).toBe('urgente');
  });

  it('returns not_found when board has no counter row', async () => {
    const result = await engine.apiCreateSimpleTask({
      board_id: 'board-999', title: 'No board', sender_name: 'Alice',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('not_found');
  });
});
```

**Step 2: Verify tests fail**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -20"
```

Expected: `engine.apiCreateSimpleTask is not a function`.

**Step 3: Update serializeApiTask to return created_by**

In `taskflow-engine.ts`, in the `serializeApiTask` method, add `created_by: row.created_by ?? null` to the returned object.

**Step 4: Add apiCreateSimpleTask to TaskflowEngine**

After the `apiLinkedTasks` method in `taskflow-engine.ts`:

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
    INSERT INTO tasks (id, board_id, column_name, title, description, assignee, priority, due_date,
                       notes, tags, created_at, updated_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
  `).run(
    taskId, board_id, column, title,
    params.description ?? null, assigneeDisplayName, priority, params.due_date ?? null,
    params.tags ?? null, now, now, sender_name,
  );

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

**Step 5: Run tests to verify they pass**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -20"
```

**Step 6: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts && git commit -m 'feat: add apiCreateSimpleTask with created_by to TaskflowEngine'"
```

---

### Task 2: Register api_create_simple_task MCP Tool

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.ts`
- Create/Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.test.ts`

**Context:** Mutation tools return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`. The Python `call_mcp_mutation` helper parses `content[0].text` as JSON.

**Step 1: Write failing tests**

Create `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TaskflowEngine } from './taskflow-engine.js';
import { createMutationTestDb } from './taskflow-engine.test.js';

// callTool reaches into the MCP SDK's registered handler for unit testing.
// Adjust this helper based on how the SDK exposes registered tools.
async function callTool(engine: TaskflowEngine, toolName: string, args: Record<string, unknown>) {
  // If the server exports a map of handlers, use that.
  // Otherwise create the server and call the handler from _registeredTools.
  const { createServer } = await import('./taskflow-mcp-server.js');
  const server = createServer(engine);
  const handler = (server as any)._registeredTools?.get(toolName);
  if (!handler) throw new Error(`Tool not registered: ${toolName}`);
  return handler.callback(args);
}

describe('api_create_simple_task MCP tool', () => {
  it('returns JSON content with success shape', async () => {
    const db = createMutationTestDb();
    const engine = new TaskflowEngine(db);
    const result = await callTool(engine, 'api_create_simple_task', {
      board_id: 'board-001', title: 'Integration task', sender_name: 'Alice',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.title).toBe('Integration task');
    expect(parsed.data.column).toBe('inbox');
    expect(parsed.data.created_by).toBe('Alice');
    expect(Array.isArray(parsed.notification_events)).toBe(true);
    db.close();
  });

  it('propagates validation_error', async () => {
    const db = createMutationTestDb();
    const engine = new TaskflowEngine(db);
    const result = await callTool(engine, 'api_create_simple_task', {
      board_id: 'board-001', title: 'Bad', sender_name: 'Alice', assignee: 'nobody',
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
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -15"
```

**Step 3: Ensure taskflow-mcp-server.ts exports a createServer factory**

If the server is currently constructed inline (not via a factory function), refactor: wrap the construction in `export function createServer(engine: TaskflowEngine)` that returns the server instance. The existing `main()` calls `createServer(engine)`.

**Step 4: Register api_create_simple_task**

After `api_linked_tasks` in `taskflow-mcp-server.ts`:

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

**Step 5: Run tests to verify they pass**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -15"
```

**Step 6: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts container/agent-runner/src/taskflow-mcp-server.test.ts && git commit -m 'feat: register api_create_simple_task MCP tool'"
```

---

### Task 3: Migrate Python POST /tasks to call_mcp_mutation

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py`
- Modify: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`

**Context:** The current `create_task` route (around line 2651 in main.py) uses direct SQL + `notify_task_created`. Replace with `call_mcp_mutation`. All tests run against `FakeMCPClient` by default. Add a `fake_mcp_app` fixture if it does not already exist.

**Step 1: Add the fake_mcp_app fixture to conftest.py**

In `tests/conftest.py`:

```python
@pytest.fixture
def fake_mcp_app():
    from app.engine.fake_client import FakeMCPClient
    import app.main as main_module
    from starlette.testclient import TestClient
    application = main_module.create_app()
    application.state.mcp_client = FakeMCPClient()
    return TestClient(application, raise_server_exceptions=False)
```

**Step 2: Write failing FakeMCPClient unit tests**

Add to `tests/test_api.py`:

```python
def test_create_task_returns_201_on_mcp_success(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_create_simple_task", {
        "success": True,
        "data": {
            "id": "T1", "title": "My task", "column": "inbox",
            "description": None, "assignee": None, "priority": "normal",
            "due_date": None, "tags": None, "parent_id": None,
            "created_by": "Alice",
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
    assert resp.json()["created_by"] == "Alice"


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

**Step 3: Verify these tests fail**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py::test_create_task_returns_201_on_mcp_success -v 2>&1 | tail -15"
```

**Step 4: Migrate the create_task route**

Replace the body of `create_task` in `app/main.py`:

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

**Step 5: Run all create-task tests**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py -k 'create_task' -v 2>&1 | tail -20"
```

**Step 6: Run full suite for regressions**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/ -q 2>&1 | tail -10"
```

**Step 7: Commit**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && git add app/main.py tests/test_api.py tests/conftest.py && git commit -m 'feat: migrate POST /tasks to call_mcp_mutation'"
```

---

### Task 4: Add apiUpdateSimpleTask to TaskflowEngine with Authorization

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts`

**Context:** Authorization policy: any board member may modify tasks whose `created_by IS NULL` (backfill compatibility). For tasks with `created_by` set: the sender must be the creator, the assignee, or have role `'Gestor'` on the board. Agent/service callers (`sender_is_service: true`) bypass the check.

Move rules: cannot move to `done` when `requires_close_approval = 1`.

The `'field' in params` check works because Zod `.optional()` leaves absent keys out of the parsed object.

**Step 1: Write failing tests**

Append to `taskflow-engine.test.ts`:

```typescript
describe('apiUpdateSimpleTask', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;
  let taskId: string;

  beforeEach(async () => {
    db = createMutationTestDb();
    engine = new TaskflowEngine(db);
    const created = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Original', sender_name: 'Alice',
    });
    taskId = (created as any).data.id;
  });

  afterEach(() => { db.close(); });

  it('updates a present field', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', title: 'Updated',
    });
    expect(result.success).toBe(true);
    expect((result as any).data.title).toBe('Updated');
  });

  it('does not alter absent fields', async () => {
    await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', title: 'New',
    });
    const row = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(taskId) as any;
    expect(row.priority).toBe('normal');
  });

  it('sets field to null when null is explicitly passed', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', description: null,
    });
    expect((result as any).data.description).toBeNull();
  });

  it('records an updated history entry', async () => {
    await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', title: 'Changed',
    });
    const hist = db.prepare(
      "SELECT * FROM task_history WHERE task_id = ? AND action = 'updated'"
    ).get(taskId);
    expect(hist).toBeTruthy();
  });

  it('returns not_found for unknown task_id', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: 'T999', sender_name: 'Alice',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('not_found');
  });

  it('returns conflict when moving to done with close_approval required', async () => {
    db.prepare('UPDATE tasks SET requires_close_approval = 1 WHERE id = ?').run(taskId);
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', column: 'done',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('conflict');
  });

  it('allows move to done without close_approval', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', column: 'done',
    });
    expect(result.success).toBe(true);
    expect((result as any).data.column).toBe('done');
  });

  it('allows assignee to modify', async () => {
    await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', assignee: 'Bob',
    });
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Bob', title: 'By Bob',
    });
    expect(result.success).toBe(true);
  });

  it('returns actor_type_not_allowed when non-creator non-assignee non-gestor modifies', async () => {
    // taskId was created by Alice, not assigned to Bob
    // Charlie is a Tecnico with no relation to the task
    db.prepare(
      "INSERT INTO board_people (board_id, person_id, name, role) VALUES ('board-001', 'person-3', 'Charlie', 'Tecnico')"
    ).run();
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Charlie', title: 'Hijack',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('actor_type_not_allowed');
  });

  it('Gestor can modify any task', async () => {
    db.prepare(
      "INSERT INTO board_people (board_id, person_id, name, role) VALUES ('board-001', 'person-4', 'Dave', 'Gestor')"
    ).run();
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Dave', title: 'Admin edit',
    });
    expect(result.success).toBe(true);
  });

  it('service account bypasses auth check', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'taskflow-api',
      sender_is_service: true, title: 'Service edit',
    });
    expect(result.success).toBe(true);
  });

  it('task with null created_by is open to any board member', async () => {
    db.prepare('UPDATE tasks SET created_by = NULL WHERE id = ?').run(taskId);
    db.prepare(
      "INSERT INTO board_people (board_id, person_id, name, role) VALUES ('board-001', 'person-3', 'Charlie', 'Tecnico')"
    ).run();
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Charlie', title: 'Open task',
    });
    expect(result.success).toBe(true);
  });

  it('emits deferred notification when assignee changes', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', assignee: 'Bob',
    });
    expect((result as any).notification_events).toHaveLength(1);
    expect((result as any).notification_events[0].target_person_id).toBe('person-2');
  });

  it('returns validation_error for unknown assignee', async () => {
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', assignee: 'nobody',
    });
    expect(result.success).toBe(false);
    expect((result as any).error_code).toBe('validation_error');
  });

  it('clears assignee when null is passed', async () => {
    await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', assignee: 'Bob',
    });
    const result = await engine.apiUpdateSimpleTask({
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', assignee: null,
    });
    expect((result as any).data.assignee).toBeNull();
  });
});
```

**Step 2: Verify tests fail**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -25"
```

**Step 3: Add apiUpdateSimpleTask to TaskflowEngine**

```typescript
async apiUpdateSimpleTask(params: {
  board_id: string;
  task_id: string;
  sender_name: string;
  sender_is_service?: boolean;
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

  // Authorization
  if (!params.sender_is_service) {
    const senderPerson = this.db.prepare(
      'SELECT person_id, name, role FROM board_people WHERE board_id = ? AND name = ?'
    ).get(board_id, sender_name) as { person_id: string; name: string; role: string } | undefined;

    if (senderPerson?.role !== 'Gestor') {
      const isCreator = existing.created_by === null || existing.created_by === sender_name;
      const isAssignee = existing.assignee !== null && existing.assignee === sender_name;
      if (!isCreator && !isAssignee) {
        return { success: false, error_code: 'actor_type_not_allowed', error: 'Not authorized to modify this task' };
      }
    }
  }

  // Move rules
  if ('column' in params && params.column === 'done' && existing.requires_close_approval) {
    return { success: false, error_code: 'conflict', error: 'Task requires close approval before moving to done' };
  }

  // Assignee resolution
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

  // Build SET clause for only present fields
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
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -25"
```

**Step 5: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts && git commit -m 'feat: add apiUpdateSimpleTask with ownership authorization to TaskflowEngine'"
```

---

### Task 5: Register api_update_simple_task MCP Tool

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.ts`
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.test.ts`

**Step 1: Write failing tests**

Append to `taskflow-mcp-server.test.ts`:

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
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', title: 'New title',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.title).toBe('New title');
    db.close();
  });

  it('propagates actor_type_not_allowed', async () => {
    const db = createMutationTestDb();
    const engine = new TaskflowEngine(db);
    db.prepare(
      "INSERT INTO board_people VALUES ('board-001', 'person-3', 'Charlie', 'Tecnico', null)"
    ).run();
    const created = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Protected', sender_name: 'Alice',
    });
    const taskId = (created as any).data.id;

    const result = await callTool(engine, 'api_update_simple_task', {
      board_id: 'board-001', task_id: taskId, sender_name: 'Charlie', title: 'Hijack',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('actor_type_not_allowed');
    db.close();
  });

  it('propagates conflict error', async () => {
    const db = createMutationTestDb();
    const engine = new TaskflowEngine(db);
    const created = await engine.apiCreateSimpleTask({
      board_id: 'board-001', title: 'Locked', sender_name: 'Alice',
    });
    const taskId = (created as any).data.id;
    db.prepare('UPDATE tasks SET requires_close_approval = 1 WHERE id = ?').run(taskId);

    const result = await callTool(engine, 'api_update_simple_task', {
      board_id: 'board-001', task_id: taskId, sender_name: 'Alice', column: 'done',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('conflict');
    db.close();
  });
});
```

**Step 2: Verify tests fail**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -15"
```

**Step 3: Register the tool**

After `api_create_simple_task` in `taskflow-mcp-server.ts`:

```typescript
server.tool(
  'api_update_simple_task',
  {
    board_id: z.string(),
    task_id: z.string(),
    sender_name: z.string(),
    sender_is_service: z.boolean().optional(),
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
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run --reporter=verbose 2>&1 | tail -15"
```

**Step 5: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts && git commit -m 'feat: register api_update_simple_task MCP tool'"
```

---

### Task 6: Migrate Python PATCH /tasks/:id to call_mcp_mutation

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py`
- Modify: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`

**Context:** Pass `sender_is_service: True` when the actor is a `ResolvedApiServiceActor`. The Node adapter uses this to bypass the authorization check for agent tokens.

Three existing tests tested Python-implemented rules. Rewrite them to use `fake_mcp_app` with canned error responses:
- `test_patch_rejects_recurring_task_moves`
- `test_patch_rejects_done_without_close_approval`
- `test_patch_updates_present_fields_and_clears_explicit_nulls`

**Step 1: Write failing FakeMCPClient tests for PATCH**

Add to `tests/test_api.py`:

```python
def test_patch_task_returns_200_on_mcp_success(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": True,
        "data": {
            "id": "T1", "title": "Updated", "column": "in_progress",
            "description": None, "assignee": None, "priority": "normal",
            "due_date": None, "tags": None, "parent_id": None, "created_by": "Alice",
            "created_at": "2026-01-01T00:00:00", "updated_at": "2026-01-01T01:00:00",
        },
        "notification_events": [],
    })
    resp = fake_mcp_app.patch(
        "/tasks/T1",
        json={"title": "Updated", "board_id": "board-001"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "Updated"


def test_patch_task_returns_403_on_unauthorized(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": False, "error_code": "actor_type_not_allowed",
        "error": "Not authorized to modify this task",
    })
    resp = fake_mcp_app.patch(
        "/tasks/T1",
        json={"title": "Hijack", "board_id": "board-001"},
        headers=auth_headers,
    )
    assert resp.status_code == 403


def test_patch_task_returns_404_on_not_found(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": False, "error_code": "not_found", "error": "Task not found: T999",
    })
    resp = fake_mcp_app.patch(
        "/tasks/T999",
        json={"title": "X", "board_id": "board-001"},
        headers=auth_headers,
    )
    assert resp.status_code == 404
```

**Step 2: Rewrite three existing tests to use FakeMCPClient**

Replace `test_patch_rejects_recurring_task_moves`:
```python
def test_patch_rejects_recurring_task_moves(fake_mcp_app):
    fake_mcp_app.app.state.mcp_client.set_response("api_update_simple_task", {
        "success": False, "error_code": "conflict", "error": "Cannot move recurring task",
    })
    resp = fake_mcp_app.patch(
        "/tasks/T1", json={"column": "done", "board_id": "board-001"}, headers=auth_headers,
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
        "/tasks/T1", json={"column": "done", "board_id": "board-001"}, headers=auth_headers,
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
            "due_date": None, "tags": None, "parent_id": None, "created_by": "Alice",
            "created_at": "2026-01-01T00:00:00", "updated_at": "2026-01-01T01:00:00",
        },
        "notification_events": [],
    })
    resp = fake_mcp_app.patch(
        "/tasks/T1",
        json={"title": "New title", "description": None, "board_id": "board-001"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "New title"
    assert resp.json()["description"] is None
```

**Step 3: Verify tests fail**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py -k 'patch' -v 2>&1 | tail -25"
```

**Step 4: Migrate the update_task route**

Replace the body of `update_task` in `app/main.py`:

```python
@router.patch("/tasks/{task_id}", status_code=200)
async def update_task(task_id: str, request: Request, raw_body: dict = Body(...)):
    board_id = raw_body.get("board_id")
    if not board_id:
        with db_connection() as conn:
            row = conn.execute(
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
    sender_is_service = not hasattr(actor, "display_name")

    mcp_args: dict = {
        "board_id": board_id,
        "task_id": task_id,
        "sender_name": sender_name,
        "sender_is_service": sender_is_service,
    }
    for field in ("column", "title", "description", "assignee", "priority", "due_date", "notes", "tags"):
        if field in raw_body:
            mcp_args[field] = raw_body[field]

    result = await call_mcp_mutation(request, "api_update_simple_task", mcp_args)
    return result["data"]
```

**Step 5: Run all PATCH tests**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py -k 'patch or update_task' -v 2>&1 | tail -25"
```

**Step 6: Run full suite**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/ -q 2>&1 | tail -10"
```

**Step 7: Commit**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && git add app/main.py tests/test_api.py && git commit -m 'feat: migrate PATCH /tasks/:id to call_mcp_mutation with authorization'"
```

---

### Task 7: Fix Comment Authorship in Python

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py`
- Modify: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`

**Context:** The `add_task_comment` endpoint trusts the client-provided `payload.author_id`. The correct behavior is to derive the author from the JWT actor — the same `resolve_board_actor` used in the mutation routes. The `CreateCommentPayload.author_id` field should be removed (clients will stop sending it; the backend no longer uses it).

**Step 1: Write failing test**

Add to `tests/test_api.py`:

```python
def test_add_comment_uses_jwt_identity_not_client_author_id():
    """Comment author comes from the JWT actor, not the request body."""
    with db_connection_rw() as conn:
        # Insert a task to comment on
        conn.execute(
            "INSERT INTO tasks (id, board_id, column_name, title, created_at, updated_at) "
            "VALUES ('T-comment-test', 'board-001', 'inbox', 'Comment test', datetime('now'), datetime('now'))"
        )

    resp = client.post(
        "/boards/board-001/tasks/T-comment-test/comments",
        json={"author_id": "malicious-user", "message": "Hello"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    # author_id in response must be the JWT actor name, not "malicious-user"
    assert resp.json()["author_id"] != "malicious-user"
    assert resp.json()["author_id"] != ""
```

**Step 2: Verify it fails**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py::test_add_comment_uses_jwt_identity_not_client_author_id -v 2>&1 | tail -15"
```

Expected: FAIL — currently stores `"malicious-user"` from the payload.

**Step 3: Fix add_task_comment in main.py**

In `add_task_comment`, add `actor = await resolve_board_actor(request, board_id)` after the `check_board_org_access` call (in the try block, using the existing `conn`), then replace every use of `payload.author_id` with the resolved actor name:

```python
actor = await resolve_board_actor(request, board_id)
author_name = (
    actor.display_name if hasattr(actor, "display_name") else actor.service_name
)
```

Replace `payload.author_id` with `author_name` in the INSERT, the UPDATE, `notify_task_commented`, and the response dict.

Also update `CreateCommentPayload`: remove `author_id` (or mark it optional with `author_id: str | None = None` and add a deprecation note — but since the backend ignores it, keeping it optional is safer for backwards compat).

**Step 4: Run the test to verify it passes**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/test_api.py::test_add_comment_uses_jwt_identity_not_client_author_id -v 2>&1 | tail -15"
```

**Step 5: Run full Python suite for regressions**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/ -q 2>&1 | tail -10"
```

**Step 6: Commit**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && git add app/main.py tests/test_api.py && git commit -m 'fix: derive comment author from JWT actor, not client-supplied author_id'"
```

---

### Task 8: Frontend — Fix comment authorship and conditional action buttons

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-dashboard/src/types/index.ts`
- Modify: `/root/tf-mcontrol/taskflow-dashboard/src/lib/api.ts`
- Modify: `/root/tf-mcontrol/taskflow-dashboard/src/components/TaskDetailPanel.tsx`

**Context:**
- `useAuth` is already imported and `user` is already destructured at line 73 of `TaskDetailPanel.tsx`.
- `people` prop is already passed to the panel and has type `Person[]` with `role: string`.
- `user.name` (from `AuthUser`) is the display name — same string stored in `tasks.created_by` and `tasks.assignee`.
- Tasks with `created_by === null` are legacy — treat as open to any board member (same as backend policy).
- Frontend sends `{ author_id: "user", message }` to the comment endpoint. Backend now ignores `author_id`. Frontend should send `{ author_id: user?.name ?? "", message }` so the field is accurate if the server is ever upgraded to validate it, and for display parity.

**Step 1: Add created_by to Task interface**

In `/root/tf-mcontrol/taskflow-dashboard/src/types/index.ts`, add to the `Task` interface after `updated_at`:

```typescript
created_by?: string | null;
```

**Step 2: Fix comment mutation in TaskDetailPanel.tsx**

At line 158, replace:

```typescript
return taskflowApi.addComment(boardId, task.id, { author_id: "user", message });
```

with:

```typescript
return taskflowApi.addComment(boardId, task.id, { author_id: user?.name ?? "", message });
```

**Step 3: Derive canModify flag**

In `TaskDetailPanel.tsx`, after the existing `const { user } = useAuth();` line (line 73), add:

```typescript
const currentPerson = people?.find((p) => p.name === user?.name);
const isGestor = currentPerson?.role === "Gestor";
const canModify =
  task === null ||
  isGestor ||
  task.created_by == null ||
  user?.name === task.created_by ||
  user?.name === task.assignee;
```

**Step 4: Gate action buttons**

Find each of the following buttons and add `disabled={!canModify}` (or wrap in a conditional render). Buttons to gate:

- **Done** / **Mark done** button (line ~685, 706) — `disabled={!canModify}`
- **Cancel task** button (line ~213) — `disabled={!canModify}`
- **Delete task** button (line ~220) — `disabled={!canModify}`
- **Add note** button (line ~454) — `disabled={!canModify}`
- Column change dropdown (line ~676+) — render conditionally or disable each option

Add `aria-disabled` and `cursor-not-allowed` styling via Tailwind for disabled states so the UI communicates the restriction clearly:

```tsx
<button
  disabled={!canModify}
  className={cn("...", !canModify && "opacity-50 cursor-not-allowed")}
  onClick={...}
>
```

The **Post comment** button should remain enabled — any org member may read and comment. Only mutations that change task state or delete the task are gated.

**Step 5: TypeScript type-check**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-dashboard && npx tsc --noEmit 2>&1 | tail -20"
```

Expected: no errors.

**Step 6: Commit**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-dashboard && git add src/types/index.ts src/lib/api.ts src/components/TaskDetailPanel.tsx && git commit -m 'feat: gate task action buttons on ownership; fix comment author_id'"
```

---

### Task 9: Full Suite Verification and Redesign Doc Update

**Files:**
- Read/Modify: `/root/nanoclaw/docs/plans/2026-04-20-taskflow-api-channel-redesign.md`

**Step 1: Run complete Python test suite**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && python -m pytest tests/ -v 2>&1 | tail -20"
```

Expected: all tests pass.

**Step 2: Run TypeScript test suite**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw/container/agent-runner && npx vitest run 2>&1 | tail -15"
```

Expected: all tests pass including `apiCreateSimpleTask` and `apiUpdateSimpleTask` suites.

**Step 3: Run frontend type-check**

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-dashboard && npx tsc --noEmit 2>&1 | tail -15"
```

Expected: clean.

**Step 4: Update the redesign doc**

In `/root/nanoclaw/docs/plans/2026-04-20-taskflow-api-channel-redesign.md`:

1. Remove Phase 6 from "What is still not done". Only Phase 7 (comments and chat) remains.

2. Add Phase 6 completion note alongside Phase 5:
   - `apiCreateSimpleTask` sets and returns `created_by`; `apiUpdateSimpleTask` enforces creator | assignee | Gestor authorization with `null`-as-open fallback for legacy rows
   - `api_create_simple_task` and `api_update_simple_task` MCP tools registered
   - POST /tasks and PATCH /tasks/:id delegate to MCP; direct Python SQL removed
   - Comment `author_id` now derived from JWT actor, not client-supplied field
   - Frontend action buttons (`Done`, `Cancel`, `Delete`, `Add note`) gated on `canModify`
   - `tasks.created_by` migration added; `serialize_task` returns it; `Task` interface updated

3. Mark all 6 Phase 6 prerequisites as checked:
   ```
   - [x] Actor resolution is deterministic
   - [x] Error codes are structured and stable
   - [x] Notification routing is unified
   - [x] Event invalidation is explicit
   - [x] call_mcp_mutation helper handles full pipeline
   - [x] API compatibility tests green against adapter path
   ```

4. Update "Immediate Next Step" to Phase 7: decide whether comments and board chat remain API-owned or are promoted to explicit adapter surfaces. The redesign doc's Phase 7 guidance stands.

**Step 5: Commit**

```bash
ssh root@192.168.2.160 "cd /root/nanoclaw && git add docs/plans/2026-04-20-taskflow-api-channel-redesign.md && git commit -m 'docs: mark Phase 6 complete with ownership model, update redesign status'"
```
