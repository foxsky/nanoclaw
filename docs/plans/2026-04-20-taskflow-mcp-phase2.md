# TaskFlow MCP Phase 2 — API Adapter Surface: Read Routes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status note:** this filename is historical. Per [2026-04-20-taskflow-api-channel-design.md](/root/nanoclaw/docs/plans/2026-04-20-taskflow-api-channel-design.md), the routes in this document belong to the low-risk board-local read slice that follows the infrastructure/bootstrap prerequisites. This plan does not waive that ordering.

**Current status:** the intended Phase 5 read slice is implemented in corrected engine-backed form. This document should not be used to justify any mutation migration. The next architecture phase is explicit actor resolution per [2026-04-20-taskflow-api-phase3-actor-resolution.md](/root/nanoclaw/docs/plans/2026-04-20-taskflow-api-phase3-actor-resolution.md), not `create`/`update`/`delete` adapter work.

**Goal:** Implement the three low-risk read adapter tools (`api_board_activity`, `api_filter_board_tasks`, `api_linked_tasks`) as engine-backed adapter methods exposed through the Node MCP server, and delegate the corresponding FastAPI routes to call them without reviving a duplicate Python SQL implementation.

**Architecture:** The MCP server is a transport shim. API-specific read semantics live in `TaskflowEngine` adapter methods that own serialization, priority/assignee translation, local-date filtering, and linked-task shaping. The migrated FastAPI routes are MCP-required: they validate auth/board access locally, call MCP, and return `503` when the subprocess path is unavailable or invalid. No actor resolution is required because all three routes are read-only.

**Tech Stack:** TypeScript + `TaskflowEngine` + better-sqlite3 (Node adapter methods), Python + asyncio (route delegation), pytest + FakeMCPClient (unit tests), vitest + temp SQLite (engine + MCP integration tests)

**Rewrite note:** some detailed code snippets later in this historical plan still show the earlier direct-SQL draft. Those snippets are superseded. The authoritative implementation rule is: do not add route-specific SQL to `taskflow-mcp-server.ts`; put the behavior in engine-owned adapter methods and keep MCP transport-thin.

---

## Context

- **Server:** root@192.168.2.160
- **Node project:** `/root/nanoclaw/container/agent-runner/`
- **Python project:** `/root/tf-mcontrol/taskflow-api/`
- **Shared DB:** `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` (also set via `TASKFLOW_DB_PATH`)
- **MCP server binary:** `/root/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js`
- **Python test runner:** `.venv/bin/python -m pytest` (from `/root/tf-mcontrol/taskflow-api/`)
- **Node test runner:** `npx vitest run` (from `/root/nanoclaw/container/agent-runner/`)

### Current Python behavior (must be preserved exactly)

The MCP path is a transport optimization only. It must not weaken any Python route guarantees. In particular:

- FastAPI still authenticates the caller before any MCP call
- FastAPI still preserves `check_board_org_access()` behavior, including `404 Board not found` and JWT org scoping, before delegating to MCP
- if MCP is unavailable, raises, or returns an unexpected payload, the migrated route fails closed with `503` rather than reviving Python SQL

The Node MCP layer must not become a second SQL-heavy behavior surface. If API semantics are not expressible through the existing engine query contract, add explicit adapter methods in `TaskflowEngine` (or the dedicated Node adapter layer) and keep the MCP server thin.

**`board_activity`** (`GET /boards/{board_id}/activity`):
- Modes: `changes_today` (SQL: `date("at", 'localtime') = date('now', 'localtime')`) or `changes_since` (SQL: `at >= ?`)
- Returns list of `{id, board_id, task_id, action, by, at, details}` where `details` is JSON-decoded (or raw string on parse failure)
- Ordered by `id DESC`

**`filter_board_tasks`** (`GET /boards/{board_id}/tasks/filter`):
- Accepts `query` or `type` param: `overdue`, `due_today`, `due_this_week`, `urgent`, `high_priority`, `by_label`
- Loads ALL board tasks with JOIN on boards, filters in code
- Priority values in DB are Portuguese: `urgent` filter → `priority == 'urgente'`, `high_priority` → `priority == 'alta'`
- No `parent_task_title` subquery (unlike linked-tasks)
- Sorted: due_date nulls last, then chronologically

**`linked_tasks`** (`GET /boards/{board_id}/linked-tasks`):
- SQL: tasks with `child_exec_board_id IS NOT NULL`, includes `parent_task_title` scalar subquery
- Ordered by `COALESCE(updated_at, created_at) DESC, id ASC`

### Task serializer shape (must match Python `serialize_task()` exactly)

```typescript
{
  id: string,
  board_id: string,
  board_code: string | null,       // from boards JOIN
  title: string,
  assignee: string | null,
  column: string,                  // default 'inbox'
  priority: string | null,         // Portuguese values as-is
  due_date: string | null,
  type: string,                    // default 'simple'
  labels: unknown[],               // parsed from JSON string, default []
  description: string | null,
  notes: Record<string, unknown>[], // parsed from JSON string, default []
  parent_task_id: string | null,
  parent_task_title: string | null, // from subquery (linked_tasks only)
  scheduled_at: string | null,
  created_at: string,
  updated_at: string,
  child_exec_board_id: string | null,
  child_exec_person_id: string | null,
  child_exec_rollup_status: string | null,
}
```

### Date/filter parity requirements

- `due_today` and `due_this_week` must use local-date semantics equivalent to Python `date.today()`, not UTC `toISOString().slice(0, 10)`
- `changes_today` must compare activity timestamps in local time, not raw UTC date fragments
- `urgent` maps to `priority == 'urgente'`
- `high_priority` maps to `priority == 'alta'`
- `by_label` remains case-insensitive
- sorting remains `due_date` nulls last, then ascending

---

## Task 1: TypeScript `serializeTask()` helper + test DB factory

**Files:**
- Modify: `container/agent-runner/src/taskflow-mcp-server.ts`
- Modify: `container/agent-runner/src/taskflow-mcp-server.test.ts`

### Step 1: Write the failing test

Add to `taskflow-mcp-server.test.ts` (below existing imports, a new describe block):

```typescript
import Database from 'better-sqlite3'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// ── test DB factory ──────────────────────────────────────────────────────────

export function createTestDb(): string {
  const path = `${tmpdir()}/taskflow-test-${randomBytes(4).toString('hex')}.db`
  const db = new Database(path)
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, short_code TEXT, name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL,
      title TEXT NOT NULL, "column" TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'simple',
      assignee TEXT, priority TEXT, due_date TEXT, labels TEXT,
      description TEXT, parent_task_id TEXT, scheduled_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      child_exec_board_id TEXT, child_exec_person_id TEXT,
      child_exec_rollup_status TEXT
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL, task_id TEXT NOT NULL,
      action TEXT NOT NULL, "by" TEXT,
      "at" TEXT NOT NULL, details TEXT
    );
    INSERT INTO boards VALUES ('b1', 'TF', 'Test Board', '2024-01-01T00:00:00Z');
    INSERT INTO tasks VALUES
      ('t1','b1','Urgent Task','todo','simple','alice','urgente','2099-01-01','["bug"]',NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t2','b1','Overdue Task','todo','simple',NULL,NULL,'2020-01-01',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t3','b1','Linked Task','todo','simple',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z','child-board-1',NULL,NULL),
      ('t4','b1','Done Task','done','simple',NULL,NULL,'2020-01-01',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL);
    INSERT INTO task_history (board_id, task_id, action, "by", "at", details)
      VALUES ('b1','t1','create','alice', datetime('now','localtime'), NULL);
  `)
  db.close()
  return path
}

export async function removeTestDb(path: string) {
  await rm(path, { force: true })
}
```

This factory is NOT a test itself. Add a simple smoke test to confirm it runs:

```typescript
describe('test DB factory', () => {
  it('creates a usable SQLite file with seed data', async () => {
    const dbPath = createTestDb()
    const db = new Database(dbPath)
    const rows = db.prepare('SELECT id FROM tasks WHERE board_id = ?').all('b1')
    db.close()
    await removeTestDb(dbPath)
    expect(rows).toHaveLength(4)
  })
})
```

### Step 2: Run to verify it fails

```bash
cd /root/nanoclaw/container/agent-runner && npm run build 2>&1 | tail -5 && npx vitest run --reporter=verbose src/taskflow-mcp-server.test.ts 2>&1 | grep -E 'test DB|FAIL|PASS|Error' | head -10
```

Expected: FAIL — `createTestDb is not defined`.

### Step 3: Add `serializeTask()` and `safeParseJsonArray()` to the server file

Add these module-level functions to `taskflow-mcp-server.ts` (after the imports, before `parseArgs`):

```typescript
function safeParseJsonArray(val: unknown): unknown[] {
  if (!val || typeof val !== 'string') return []
  try { return JSON.parse(val) as unknown[] } catch { return [] }
}

function serializeTask(row: Record<string, unknown>) {
  return {
    id: row['id'],
    board_id: row['board_id'],
    board_code: row['board_code'] ?? null,
    title: row['title'],
    assignee: row['assignee'] ?? null,
    column: (row['column'] as string) || 'inbox',
    priority: row['priority'] ?? null,
    due_date: row['due_date'] ?? null,
    type: (row['type'] as string) || 'simple',
    labels: safeParseJsonArray(row['labels']),
    description: row['description'] ?? null,
    notes: safeParseJsonNotes(row['notes']),
    parent_task_id: row['parent_task_id'] ?? null,
    parent_task_title: row['parent_task_title'] ?? null,
    scheduled_at: row['scheduled_at'] ?? null,
    created_at: row['created_at'],
    updated_at: row['updated_at'],
    child_exec_board_id: row['child_exec_board_id'] ?? null,
    child_exec_person_id: row['child_exec_person_id'] ?? null,
    child_exec_rollup_status: row['child_exec_rollup_status'] ?? null,
  }
}
```

### Step 4: Build and run test

```bash
cd /root/nanoclaw/container/agent-runner && npm run build && npx vitest run --reporter=verbose src/taskflow-mcp-server.test.ts 2>&1 | tail -15
```

Expected: PASS — all prior tests + new test DB smoke test.

### Step 5: Commit (Node repo)

```bash
cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts container/agent-runner/src/taskflow-mcp-server.test.ts && git commit -m "feat: serializeTask helper and test DB factory"
```

---

## Task 2: `api_board_activity` — engine-backed adapter implementation

**Files:**
- Modify: `container/agent-runner/src/taskflow-mcp-server.ts` (inside `registerTools`)
- Modify: `container/agent-runner/src/taskflow-mcp-server.test.ts`

### Step 1: Write the failing test

Add to the `taskflow-mcp-server` describe block:

```typescript
it('api_board_activity returns history rows for changes_today', async () => {
  const dbPath = createTestDb()
  proc = spawn('node', [SERVER_BIN, '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: any[] = []
  createInterface({ input: proc.stdout! }).on('line', l => { try { lines.push(JSON.parse(l)) } catch {} })

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: proc!.stderr! })
    let settled = false
    const t = setTimeout(() => { if (!settled) { settled = true; rl.close(); reject(new Error('timeout')) } }, 5000)
    rl.on('line', l => { if (l.includes('MCP server ready') && !settled) { settled = true; clearTimeout(t); rl.close(); resolve() } })
  })

  const send = (msg: object) => proc!.stdin!.write(JSON.stringify(msg) + '\n')
  const waitFor = (id: number) => new Promise<any>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timeout id=${id}`)), 5000)
    const iv = setInterval(() => {
      const m = lines.find(x => x.id === id)
      if (m) { clearInterval(iv); clearTimeout(deadline); resolve(m) }
    }, 50)
  })

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } } })
  await waitFor(1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_board_activity', arguments: { board_id: 'b1', mode: 'changes_today' } } })
  const resp = await waitFor(2)

  const text = resp.result.content[0].text
  const data = JSON.parse(text)
  expect(Array.isArray(data.rows)).toBe(true)
  // seed data has 1 history row with today's date
  expect(data.rows.length).toBeGreaterThanOrEqual(1)
  const row = data.rows[0]
  expect(row).toHaveProperty('id')
  expect(row).toHaveProperty('board_id', 'b1')
  expect(row).toHaveProperty('task_id')
  expect(row).toHaveProperty('action')
  expect(row).toHaveProperty('by')
  expect(row).toHaveProperty('at')
  expect(row).toHaveProperty('details')

  await removeTestDb(dbPath)
})
```

### Step 2: Run to verify it fails

```bash
cd /root/nanoclaw/container/agent-runner && npm run build && npx vitest run --reporter=verbose src/taskflow-mcp-server.test.ts 2>&1 | grep -E 'api_board_activity|FAIL|PASS' | head -5
```

Expected: FAIL — tool returns `{error: 'not_implemented'}`.

### Step 3: Implement `api_board_activity` via `TaskflowEngine`

Add a canonical adapter method to `TaskflowEngine` for the API contract, then have the MCP tool call that method from a readonly engine instance:

```typescript
server.tool(
  'api_board_activity',
  'Board activity log',
  {
    board_id: z.string(),
    mode: z.enum(['changes_today', 'changes_since']).optional(),
    since: z.string().optional(),
  },
  async (args) => {
    const mode = args.mode ?? 'changes_today'
    let rows: unknown[]
    if (mode === 'changes_today') {
      rows = db.prepare(`
        SELECT id, board_id, task_id, action, "by", "at", details
        FROM task_history
        WHERE board_id = ? AND date("at", 'localtime') = date('now', 'localtime')
        ORDER BY id DESC
      `).all(args.board_id)
    } else {
      if (!args.since) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'since is required for changes_since' }) }] }
      }
      rows = db.prepare(`
        SELECT id, board_id, task_id, action, "by", "at", details
        FROM task_history
        WHERE board_id = ? AND "at" >= ?
        ORDER BY id DESC
      `).all(args.board_id, args.since)
    }
    const serialized = (rows as Record<string, unknown>[]).map(row => {
      const item = { ...row }
      const rawDetails = item['details']
      if (rawDetails == null) {
        item['details'] = null
      } else {
        try { item['details'] = JSON.parse(rawDetails as string) } catch { /* keep as string */ }
      }
      return item
    })
    return { content: [{ type: 'text' as const, text: JSON.stringify({ rows: serialized }) }] }
  }
)
```

### Step 4: Build and run tests

```bash
cd /root/nanoclaw/container/agent-runner && npm run build && npx vitest run --reporter=verbose src/taskflow-mcp-server.test.ts 2>&1 | tail -15
```

Expected: PASS — all tests including the new activity test.

### Step 5: Commit

```bash
cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts container/agent-runner/src/taskflow-mcp-server.test.ts && git commit -m "feat: api_board_activity tool with real SQL"
```

---

## Task 3: `api_filter_board_tasks` — engine-backed adapter implementation

**Files:**
- Modify: `container/agent-runner/src/taskflow-mcp-server.ts`
- Modify: `container/agent-runner/src/taskflow-mcp-server.test.ts`

### Step 1: Write the failing test

Add to the describe block:

```typescript
it('api_filter_board_tasks returns urgent tasks', async () => {
  const dbPath = createTestDb()
  proc = spawn('node', [SERVER_BIN, '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: any[] = []
  createInterface({ input: proc!.stdout! }).on('line', l => { try { lines.push(JSON.parse(l)) } catch {} })

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: proc!.stderr! })
    let settled = false
    const t = setTimeout(() => { if (!settled) { settled = true; rl.close(); reject(new Error('timeout')) } }, 5000)
    rl.on('line', l => { if (l.includes('MCP server ready') && !settled) { settled = true; clearTimeout(t); rl.close(); resolve() } })
  })

  const send = (msg: object) => proc!.stdin!.write(JSON.stringify(msg) + '\n')
  const waitFor = (id: number) => new Promise<any>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timeout id=${id}`)), 5000)
    const iv = setInterval(() => {
      const m = lines.find(x => x.id === id)
      if (m) { clearInterval(iv); clearTimeout(deadline); resolve(m) }
    }, 50)
  })

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } } })
  await waitFor(1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_filter_board_tasks', arguments: { board_id: 'b1', filter: 'urgent' } } })
  const resp = await waitFor(2)

  const data = JSON.parse(resp.result.content[0].text)
  expect(Array.isArray(data.rows)).toBe(true)
  // seed data: t1 has priority='urgente'
  expect(data.rows).toHaveLength(1)
  expect(data.rows[0].id).toBe('t1')
  expect(data.rows[0].priority).toBe('urgente')
  expect(data.rows[0].board_code).toBe('TF')  // from boards JOIN
  expect(Array.isArray(data.rows[0].labels)).toBe(true)  // parsed JSON

  await removeTestDb(dbPath)
})
```

### Step 2: Run to verify it fails

```bash
cd /root/nanoclaw/container/agent-runner && npm run build && npx vitest run --reporter=verbose src/taskflow-mcp-server.test.ts 2>&1 | grep -E 'api_filter|FAIL|PASS' | head -5
```

Expected: FAIL — returns `{error: 'not_implemented'}`.

### Step 3: Implement `api_filter_board_tasks` via `TaskflowEngine`

Add a canonical adapter method to `TaskflowEngine` that owns the API serializer, priority translation, and local-date filter semantics. The MCP tool should only validate input shape and return the engine result.

```typescript
server.tool(
  'api_filter_board_tasks',
  'Board task filter',
  {
    board_id: z.string(),
    filter: z.string(),
    label: z.string().optional(),
  },
  async (args) => {
    const filterType = args.filter.trim().toLowerCase()
    const validFilters = new Set(['overdue', 'due_today', 'due_this_week', 'urgent', 'high_priority', 'by_label'])
    if (!validFilters.has(filterType)) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid filter type' }) }] }
    }
    if (filterType === 'by_label' && !args.label?.trim()) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'label is required for by_label filter' }) }] }
    }

    const rawRows = db.prepare(`
      SELECT t.id, t.board_id, b.short_code AS board_code,
             t.title, t.assignee, t."column", t.priority, t.due_date,
             t.type, t.labels, t.description, t.notes, t.parent_task_id,
             t.scheduled_at, t.created_at, t.updated_at,
             t.child_exec_board_id, t.child_exec_person_id, t.child_exec_rollup_status
      FROM tasks t
      JOIN boards b ON b.id = t.board_id
      WHERE t.board_id = ?
    `).all(args.board_id) as Record<string, unknown>[]

    const tasks = rawRows.map(r => serializeTask(r))

    const today = new Date()
    const todayStr = localDateString(today)
    const weekEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    weekEnd.setDate(weekEnd.getDate() + 6)
    const weekEndStr = localDateString(weekEnd)
    const targetLabel = (args.label ?? '').trim().toLowerCase()

    let filtered: ReturnType<typeof serializeTask>[]
    if (filterType === 'overdue') {
      filtered = tasks.filter(t =>
        t.due_date && t.column !== 'done' && (t.due_date as string) < todayStr
      )
    } else if (filterType === 'due_today') {
      filtered = tasks.filter(t => t.due_date === todayStr)
    } else if (filterType === 'due_this_week') {
      filtered = tasks.filter(t =>
        t.due_date && (t.due_date as string) >= todayStr && (t.due_date as string) <= weekEndStr
      )
    } else if (filterType === 'urgent') {
      filtered = tasks.filter(t => (t.priority ?? '') === 'urgente')
    } else if (filterType === 'high_priority') {
      filtered = tasks.filter(t => (t.priority ?? '') === 'alta')
    } else {
      // by_label — case-insensitive
      filtered = tasks.filter(t =>
        (t.labels as string[]).some(tag => (tag ?? '').toLowerCase() === targetLabel)
      )
    }

    // Sort: due_date nulls last, then chronologically
    filtered.sort((a, b) => {
      const aN = a.due_date == null
      const bN = b.due_date == null
      if (aN && bN) return 0
      if (aN) return 1
      if (bN) return -1
      return (a.due_date as string) < (b.due_date as string) ? -1 : 1
    })

    return { content: [{ type: 'text' as const, text: JSON.stringify({ rows: filtered }) }] }
  }
)
```

### Step 4: Build and run tests

```bash
cd /root/nanoclaw/container/agent-runner && npm run build && npx vitest run --reporter=verbose src/taskflow-mcp-server.test.ts 2>&1 | tail -15
```

Expected: PASS.

### Step 5: Commit

```bash
cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts container/agent-runner/src/taskflow-mcp-server.test.ts && git commit -m "feat: api_filter_board_tasks tool with SQL and filter logic"
```

---

## Task 4: `api_linked_tasks` — engine-backed adapter implementation

**Files:**
- Modify: `container/agent-runner/src/taskflow-mcp-server.ts`
- Modify: `container/agent-runner/src/taskflow-mcp-server.test.ts`

### Step 1: Write the failing test

Add to the describe block:

```typescript
it('api_linked_tasks returns only tasks with child_exec_board_id', async () => {
  const dbPath = createTestDb()
  proc = spawn('node', [SERVER_BIN, '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: any[] = []
  createInterface({ input: proc!.stdout! }).on('line', l => { try { lines.push(JSON.parse(l)) } catch {} })

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: proc!.stderr! })
    let settled = false
    const t = setTimeout(() => { if (!settled) { settled = true; rl.close(); reject(new Error('timeout')) } }, 5000)
    rl.on('line', l => { if (l.includes('MCP server ready') && !settled) { settled = true; clearTimeout(t); rl.close(); resolve() } })
  })

  const send = (msg: object) => proc!.stdin!.write(JSON.stringify(msg) + '\n')
  const waitFor = (id: number) => new Promise<any>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timeout id=${id}`)), 5000)
    const iv = setInterval(() => {
      const m = lines.find(x => x.id === id)
      if (m) { clearInterval(iv); clearTimeout(deadline); resolve(m) }
    }, 50)
  })

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } } })
  await waitFor(1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_linked_tasks', arguments: { board_id: 'b1' } } })
  const resp = await waitFor(2)

  const data = JSON.parse(resp.result.content[0].text)
  expect(Array.isArray(data.rows)).toBe(true)
  // seed data: only t3 has child_exec_board_id
  expect(data.rows).toHaveLength(1)
  expect(data.rows[0].id).toBe('t3')
  expect(data.rows[0].child_exec_board_id).toBe('child-board-1')
  // parent_task_title field must be present (null for t3 which has no parent)
  expect(data.rows[0]).toHaveProperty('parent_task_title', null)

  await removeTestDb(dbPath)
})
```

### Step 2: Run to verify it fails

```bash
cd /root/nanoclaw/container/agent-runner && npm run build && npx vitest run --reporter=verbose src/taskflow-mcp-server.test.ts 2>&1 | grep -E 'api_linked|FAIL|PASS' | head -5
```

Expected: FAIL — returns `{error: 'not_implemented'}`.

### Step 3: Implement `api_linked_tasks` via `TaskflowEngine`

Replace the placeholder:

```typescript
server.tool(
  'api_linked_tasks',
  'Board linked tasks',
  { board_id: z.string() },
  async (args) => {
    const rows = db.prepare(`
      SELECT t.id, t.board_id, b.short_code AS board_code,
             t.title, t.assignee, t."column", t.priority, t.due_date,
             t.type, t.labels, t.description, t.parent_task_id,
             (SELECT pt.title FROM tasks pt WHERE pt.id = t.parent_task_id LIMIT 1) AS parent_task_title,
             t.scheduled_at, t.created_at, t.updated_at,
             t.child_exec_board_id, t.child_exec_person_id, t.child_exec_rollup_status
      FROM tasks t
      JOIN boards b ON b.id = t.board_id
      WHERE t.board_id = ? AND t.child_exec_board_id IS NOT NULL
      ORDER BY COALESCE(t.updated_at, t.created_at) DESC, t.id ASC
    `).all(args.board_id) as Record<string, unknown>[]

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ rows: rows.map(r => serializeTask(r)) })
      }]
    }
  }
)
```

### Step 4: Build and run all Node tests

```bash
cd /root/nanoclaw/container/agent-runner && npm run build && npx vitest run --reporter=verbose src/taskflow-mcp-server.test.ts 2>&1 | tail -20
```

Expected: PASS — all tests including the 3 new tool tests and the existing 3 handshake tests + DB smoke test.

### Step 5: Commit

```bash
cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts container/agent-runner/src/taskflow-mcp-server.test.ts && git commit -m "feat: api_linked_tasks tool with SQL"
```

---

## Task 5: Python — `board_activity` route delegates to MCP

**Files:**
- Modify: `taskflow-api/app/main.py` (the `board_activity` handler, ~line 2598)
- Create: `taskflow-api/tests/test_mcp_routes.py`

### Step 1: Write the failing test

Create `/root/tf-mcontrol/taskflow-api/tests/test_mcp_routes.py`:

```python
"""Tests for routes that delegate to MCP when a client is available."""
import json
import pytest
from fastapi.testclient import TestClient

import app.main as m
from app.engine.fake_client import FakeMCPClient


FAKE_ACTIVITY_ROWS = [
    {"id": 1, "board_id": "b1", "task_id": "t1", "action": "create",
     "by": "alice", "at": "2024-01-01T00:00:00Z", "details": None},
]
FAKE_TASK_ROWS = [
    {"id": "t1", "board_id": "b1", "board_code": "TF", "title": "Test",
     "assignee": None, "column": "todo", "priority": "urgente", "due_date": None,
     "type": "simple", "labels": [], "description": None, "notes": None,
     "parent_task_id": None, "parent_task_title": None, "scheduled_at": None,
     "created_at": "2024-01-01T00:00:00Z", "updated_at": "2024-01-01T00:00:00Z",
     "child_exec_board_id": None, "child_exec_person_id": None,
     "child_exec_rollup_status": None},
]


@pytest.fixture
def client_with_mcp():
    """FastAPI test client with a FakeMCPClient injected."""
    application = m.create_app()
    fake = FakeMCPClient()
    fake.set_response('api_board_activity', {'rows': FAKE_ACTIVITY_ROWS})
    fake.set_response('api_filter_board_tasks', {'rows': FAKE_TASK_ROWS})
    fake.set_response('api_linked_tasks', {'rows': FAKE_TASK_ROWS})
    application.state.mcp_client = fake
    # Also need a valid auth token for BoardAccessClaims
    # Check how existing tests authenticate — look at how test_api.py gets a token
    return TestClient(application)


def test_activity_route_delegates_to_mcp(client_with_mcp):
    """When MCP client is alive, board_activity returns MCP rows."""
    # This test will fail until the route is updated to check mcp_client
    resp = client_with_mcp.get(
        '/api/v1/boards/b1/activity',
        headers={'Authorization': 'Bearer test-token'},  # update after checking conftest
    )
    # Just verify the route hits the MCP path (will initially return 401 or existing behavior)
    # We'll refine assertions after seeing what auth the tests use
    assert resp.status_code in (200, 401, 403)
```

**Note:** Before implementing, check how existing API tests authenticate:
```bash
ssh root@192.168.2.160 "grep -n 'Authorization\|Bearer\|token\|headers\|auth' /root/tf-mcontrol/taskflow-api/tests/test_api.py | head -20"
ssh root@192.168.2.160 "grep -n 'TASKFLOW_API_TOKEN\|API_TOKEN\|test.*token\|fixture.*token\|def.*auth' /root/tf-mcontrol/taskflow-api/tests/conftest.py"
```

Then update the test with the correct auth token and assertions:

```python
# Correct test after seeing auth pattern:
def test_activity_route_uses_mcp_when_available(client_with_mcp, auth_headers):
    resp = client_with_mcp.get(
        '/api/v1/boards/BOARD_ID/activity',
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]['action'] == 'create'
    assert data[0]['by'] == 'alice'
```

### Step 2: Check auth pattern, then run test to see failure

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 .venv/bin/python -m pytest tests/test_mcp_routes.py -v 2>&1"
```

Expected: Test runs (even if failing due to auth or assertion) — no import errors.

### Step 3: Update the `board_activity` handler in `main.py`

Find the `board_activity` function (~line 2598). Change `def` to `async def` and add the MCP delegation block immediately after validation:

```python
@app.get("/boards/{board_id}/activity")
@app.get("/api/v1/boards/{board_id}/activity")
async def board_activity(
    request: Request,
    board_id: str,
    mode: str = Query(default="changes_today"),
    since: str | None = Query(default=None),
    access: BoardAccessClaims = Depends(require_board_access),
) -> List[Dict[str, Any]]:
    normalized_mode = mode.strip().lower()
    if normalized_mode not in ("changes_today", "changes_since"):
        raise HTTPException(status_code=400, detail="mode must be changes_today or changes_since")
    if normalized_mode == "changes_since":
        if not since:
            raise HTTPException(status_code=400, detail="since is required for changes_since")
        try:
            datetime.fromisoformat(since)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="since must be ISO8601 timestamp") from exc

    # MCP delegation — preserve board existence / org scoping before calling Node
    mcp_client = getattr(request.app.state, 'mcp_client', None)
    if mcp_client and mcp_client.is_alive():
        ensure_board_access_prechecked(board_id, access)
        try:
            result = await mcp_client.call('api_board_activity', {
                'board_id': board_id, 'mode': normalized_mode, 'since': since
            })
            if 'rows' in result:
                return result['rows']
        except Exception:
            pass  # fall through to Python SQL

    # Python SQL fallback (existing implementation)
    if normalized_mode == "changes_today":
        predicate = 'date("at", \'localtime\') = date(\'now\', \'localtime\')'
        args: tuple = (board_id,)
    else:
        predicate = '"at" >= ?'
        args = (board_id, since)

    try:
        with db_connection() as conn:
            check_board_org_access(conn, board_id, access)
            rows = conn.execute(
                f'SELECT id, board_id, task_id, action, "by", "at", details FROM task_history WHERE board_id = ? AND {predicate} ORDER BY id DESC',
                args,
            ).fetchall()
            history: List[Dict[str, Any]] = []
            for row in rows:
                item = dict(row)
                raw_details = item.get("details")
                if raw_details is None:
                    item["details"] = None
                else:
                    try:
                        item["details"] = json.loads(raw_details)
                    except json.JSONDecodeError:
                        item["details"] = raw_details
                history.append(item)
            return history
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Database error") from exc
```

**Required invariant:** `require_board_access()` alone is not sufficient for these routes because board existence and JWT org checks live in `check_board_org_access()`. The MCP fast path must preserve those semantics before calling Node. The Node server does not perform authorization.

### Step 4: Write the full test with correct auth

After checking the auth pattern, write the complete test. The test should:
1. Inject `FakeMCPClient` with `set_response('api_board_activity', {'rows': FAKE_ACTIVITY_ROWS})`
2. Verify the route returns `FAKE_ACTIVITY_ROWS` (meaning MCP path was taken)
3. Write a second test: set `mcp_client = None` on app state, verify route still works (Python fallback)

### Step 5: Run all Python tests

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 .venv/bin/python -m pytest tests/ -v 2>&1 | tail -15"
```

Expected: 122+ tests pass.

### Step 6: Commit (no git on Python side — note changes only)

`/root/tf-mcontrol` is not a git repo. Note what files were changed for the final summary.

---

## Task 6: Python — `filter_board_tasks` route delegates to MCP

**Files:**
- Modify: `taskflow-api/app/main.py` (the `filter_board_tasks` handler, ~line 2517)
- Modify: `taskflow-api/tests/test_mcp_routes.py`

### Step 1: Write the failing test

Add to `test_mcp_routes.py`:

```python
def test_filter_route_uses_mcp_when_available(client_with_mcp, auth_headers):
    resp = client_with_mcp.get(
        '/api/v1/boards/BOARD_ID/tasks/filter?query=urgent',
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]['priority'] == 'urgente'
```

### Step 2: Update the `filter_board_tasks` handler in `main.py`

Change to `async def` and add the MCP delegation block after validation:

```python
@app.get("/boards/{board_id}/tasks/filter")
@app.get("/api/v1/boards/{board_id}/tasks/filter")
async def filter_board_tasks(
    request: Request,
    board_id: str,
    query: str | None = Query(default=None, min_length=1),
    filter_type_param: str | None = Query(default=None, alias="type", min_length=1),
    label: str | None = Query(default=None),
    access: BoardAccessClaims = Depends(require_board_access),
) -> List[Dict[str, Any]]:
    filter_input = query if query is not None else filter_type_param
    if not filter_input:
        raise HTTPException(status_code=400, detail="query is required")
    filter_type = filter_input.strip().lower()
    if filter_type not in {"overdue", "due_today", "due_this_week", "urgent", "high_priority", "by_label"}:
        raise HTTPException(status_code=400, detail="Invalid query type")
    if filter_type == "by_label" and (not label or not label.strip()):
        raise HTTPException(status_code=400, detail="label is required for by_label query")

    # MCP delegation
    mcp_client = getattr(request.app.state, 'mcp_client', None)
    if mcp_client and mcp_client.is_alive():
        try:
            args_dict: Dict[str, Any] = {'board_id': board_id, 'filter': filter_type}
            if label:
                args_dict['label'] = label.strip()
            result = await mcp_client.call('api_filter_board_tasks', args_dict)
            if 'rows' in result:
                return result['rows']
        except Exception:
            pass

    # Python SQL fallback (existing implementation)
    today = date.today()
    week_end = today + timedelta(days=6)
    target_label = (label or "").strip().lower()
    try:
        with db_connection() as conn:
            check_board_org_access(conn, board_id, access)
            rows = conn.execute(
                'SELECT t.*, b.short_code AS board_code FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.board_id = ?',
                (board_id,),
            ).fetchall()
            tasks = [serialize_task(row) for row in rows]
            if filter_type == "overdue":
                filtered = [t for t in tasks if t.get("due_date") and t.get("column") != "done" and date.fromisoformat(t["due_date"]) < today]
            elif filter_type == "due_today":
                filtered = [t for t in tasks if t.get("due_date") and date.fromisoformat(t["due_date"]) == today]
            elif filter_type == "due_this_week":
                filtered = [t for t in tasks if t.get("due_date") and today <= date.fromisoformat(t["due_date"]) <= week_end]
            elif filter_type == "urgent":
                filtered = [t for t in tasks if (t.get("priority") or "") == "urgente"]
            elif filter_type == "high_priority":
                filtered = [t for t in tasks if (t.get("priority") or "") == "alta"]
            else:
                filtered = [t for t in tasks if any((tag or "").lower() == target_label for tag in parse_json_list(t.get("labels")))]
            return sorted(filtered, key=lambda task: (task.get("due_date") is None, task.get("due_date") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date filter value: {exc}") from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Database error") from exc
```

### Step 3: Run all Python tests

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 .venv/bin/python -m pytest tests/ -v 2>&1 | tail -15"
```

Expected: All pass.

---

## Task 7: Python — `linked_tasks` route delegates to MCP

**Files:**
- Modify: `taskflow-api/app/main.py` (the `linked_tasks` handler, ~line 2652)
- Modify: `taskflow-api/tests/test_mcp_routes.py`

### Step 1: Write the failing test

Add to `test_mcp_routes.py`:

```python
def test_linked_tasks_route_uses_mcp_when_available(client_with_mcp, auth_headers):
    resp = client_with_mcp.get(
        '/api/v1/boards/BOARD_ID/linked-tasks',
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]['id'] == 't1'
```

### Step 2: Update the `linked_tasks` handler in `main.py`

Change to `async def` and add MCP delegation:

```python
@app.get("/boards/{board_id}/linked-tasks")
@app.get("/api/v1/boards/{board_id}/linked-tasks")
async def linked_tasks(
    request: Request,
    board_id: str,
    access: BoardAccessClaims = Depends(require_board_access),
) -> List[Dict[str, Any]]:
    # MCP delegation
    mcp_client = getattr(request.app.state, 'mcp_client', None)
    if mcp_client and mcp_client.is_alive():
        try:
            result = await mcp_client.call('api_linked_tasks', {'board_id': board_id})
            if 'rows' in result:
                return result['rows']
        except Exception:
            pass

    # Python SQL fallback
    try:
        with db_connection() as conn:
            check_board_org_access(conn, board_id, access)
            return fetch_tasks(conn, board_id, linked_only=True)
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Database error") from exc
```

### Step 3: Run all Python tests

```bash
ssh root@192.168.2.160 "cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 .venv/bin/python -m pytest tests/ -v 2>&1 | tail -15"
```

Expected: All pass. Verify count is at least 122.

---

## Acceptance Criteria

Before declaring this low-risk read slice complete, verify all of the following:

- [ ] The design-doc prerequisites for low-risk board-local reads are already complete; this plan does not waive them
- [ ] `taskflow-mcp-server.ts` is a thin transport layer; API read behavior is not re-implemented there with direct SQL
- [ ] `npm run build` in `container/agent-runner` compiles without errors
- [ ] `npm test -- taskflow-mcp-server` in `container/agent-runner` passes the handshake tests, tool tests, and DB smoke test
- [ ] Engine-level tests cover the canonical adapter methods directly, not only through MCP
- [ ] `api_board_activity` returns `{rows: [...]}` with correct shape for both `changes_today` and `changes_since`
- [ ] `api_filter_board_tasks` returns correctly filtered rows for all 6 filter types
- [ ] `api_filter_board_tasks` uses local-date semantics for `due_today` and `due_this_week`
- [ ] `api_linked_tasks` returns only tasks with `child_exec_board_id IS NOT NULL`
- [ ] Task DTO parity is preserved for `labels` and `notes` parsing (`[]` default, not `null`)
- [ ] MCP-enabled route tests prove `404 Board not found` still occurs before delegation for all three routes
- [ ] `FakeMCPClient` injection causes `board_activity`, `filter_board_tasks`, and `linked_tasks` routes to return MCP-provided rows
- [ ] Setting `mcp_client = None`, disabling lifespan startup, or returning a non-`rows` payload causes migrated routes to fail closed with `503`
- [ ] Python targeted tests cover the real subprocess client and the MCP route shims without relying on module-scope imports that bypass fixture DB setup
- [ ] The duplicated Python SQL read path for these migrated routes is removed
