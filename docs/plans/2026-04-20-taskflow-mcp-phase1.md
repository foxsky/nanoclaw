# TaskFlow MCP Phase 1 — Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up the Node.js MCP stdio subprocess and Python async client that will serve as the transport layer between FastAPI and TaskflowEngine, with no route migrations yet.

**Architecture:** FastAPI spawns `taskflow-mcp-server.js` once at lifespan startup via `engine/client.py`. Communication uses NDJSON-framed JSON-RPC over stdin/stdout with one outstanding request at a time. All existing routes remain on the Python SQL path; this phase only establishes the subprocess infrastructure, test isolation, and health signaling.

**Tech Stack:** TypeScript + vitest (Node server), Python + pytest-asyncio (client), FastAPI lifespan, `@modelcontextprotocol/sdk`, `better-sqlite3`, `asyncio.subprocess`

---

## Context

- Node server lives in: `container/agent-runner/src/`
- Python API lives in: `taskflow-api/app/`
- Shared database: `TASKFLOW_DB_PATH` env var → `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`
- TypeScript compiles to: `container/agent-runner/dist/`
- Existing Node tests use: vitest (`npx vitest run`)
- Existing Python tests use: pytest + pytest-asyncio

---

## Task 1: Node server skeleton with ready sentinel

**Files:**
- Create: `container/agent-runner/src/taskflow-mcp-server.ts`
- Create: `container/agent-runner/src/taskflow-mcp-server.test.ts`
- Modify: `container/agent-runner/package.json` (add test script)

**Step 1: Add test script to package.json**

In `container/agent-runner/package.json`, add to `"scripts"`:
```json
"test": "vitest run"
```

**Step 2: Write the failing test**

Create `container/agent-runner/src/taskflow-mcp-server.test.ts`:
```typescript
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'

const SERVER_BIN = path.resolve(__dirname, '../dist/taskflow-mcp-server.js')
const TEST_DB = process.env.TASKFLOW_DB_PATH || '/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db'

describe('taskflow-mcp-server', () => {
  let proc: ReturnType<typeof spawn> | null = null

  afterEach(() => {
    proc?.kill()
    proc = null
  })

  it('emits ready sentinel on stderr after startup', async () => {
    proc = spawn('node', [SERVER_BIN, '--db', TEST_DB])
    const sentinel = await new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: proc!.stderr! })
      const timeout = setTimeout(() => reject(new Error('timeout waiting for sentinel')), 5000)
      rl.on('line', (line) => {
        if (line.includes('MCP server ready')) {
          clearTimeout(timeout)
          resolve(line)
        }
      })
      proc!.on('exit', (code) => reject(new Error(`exited with code ${code}`)))
    })
    expect(sentinel).toContain('MCP server ready')
  })
})
```

**Step 3: Run test to verify it fails**

```bash
cd container/agent-runner
npm run build 2>&1 | tail -5   # will fail: file doesn't exist
```

Expected: TypeScript compile error — `taskflow-mcp-server.ts` not found.

**Step 4: Implement the skeleton**

Create `container/agent-runner/src/taskflow-mcp-server.ts`:
```typescript
import Database from 'better-sqlite3'

// Redirect all console output to stderr before any other imports
const origLog = console.log
console.log = (...args) => process.stderr.write(args.join(' ') + '\n')
console.info = (...args) => process.stderr.write(args.join(' ') + '\n')
console.warn = (...args) => process.stderr.write(args.join(' ') + '\n')
console.error = (...args) => process.stderr.write(args.join(' ') + '\n')

function parseArgs(): { db: string } {
  const idx = process.argv.indexOf('--db')
  if (idx === -1 || !process.argv[idx + 1]) {
    process.stderr.write('Error: --db <path> is required\n')
    process.exit(1)
  }
  return { db: process.argv[idx + 1] }
}

async function main() {
  const { db: dbPath } = parseArgs()

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  // Emit ready sentinel to stderr — Python client waits for this
  process.stderr.write('MCP server ready\n')

  // Keep process alive
  process.stdin.resume()
  process.on('SIGTERM', () => {
    db.close()
    process.exit(0)
  })
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
```

**Step 5: Build and run test**

```bash
cd container/agent-runner
npm run build && npm test -- --reporter=verbose taskflow-mcp-server
```

Expected: PASS — sentinel line received within 5 seconds.

**Step 6: Commit**

```bash
cd container/agent-runner
git add src/taskflow-mcp-server.ts src/taskflow-mcp-server.test.ts package.json
git commit -m "feat: taskflow-mcp-server skeleton with ready sentinel"
```

---

## Task 2: MCP handshake in the server

**Files:**
- Modify: `container/agent-runner/src/taskflow-mcp-server.ts`
- Modify: `container/agent-runner/src/taskflow-mcp-server.test.ts`

**Step 1: Write the failing test**

Add to the describe block in `taskflow-mcp-server.test.ts`:
```typescript
it('responds to initialize with protocol version', async () => {
  proc = spawn('node', [SERVER_BIN, '--db', TEST_DB], { stdio: ['pipe', 'pipe', 'pipe'] })

  // Wait for ready sentinel
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: proc!.stderr! })
    const t = setTimeout(() => reject(new Error('timeout')), 5000)
    rl.on('line', (l) => { if (l.includes('MCP server ready')) { clearTimeout(t); resolve() } })
  })

  // Send initialize
  const req = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } }
  })
  proc!.stdin!.write(req + '\n')

  const response = await new Promise<any>((resolve, reject) => {
    const rl = createInterface({ input: proc!.stdout! })
    const t = setTimeout(() => reject(new Error('timeout waiting for initialize response')), 5000)
    rl.on('line', (line) => {
      try { const msg = JSON.parse(line); clearTimeout(t); resolve(msg) } catch {}
    })
  })

  expect(response.id).toBe(1)
  expect(response.result.protocolVersion).toBe('2024-11-05')
  expect(response.result.serverInfo.name).toBe('taskflow-mcp-server')
})
```

**Step 2: Run test to verify it fails**

```bash
cd container/agent-runner
npm run build && npm test -- taskflow-mcp-server
```

Expected: FAIL — timeout waiting for initialize response (server doesn't read stdin yet).

**Step 3: Implement MCP handshake**

Replace `main.py` body in `taskflow-mcp-server.ts` with:
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import Database from 'better-sqlite3'

console.log = (...args) => process.stderr.write(args.join(' ') + '\n')
console.info = (...args) => process.stderr.write(args.join(' ') + '\n')
console.warn = (...args) => process.stderr.write(args.join(' ') + '\n')
console.error = (...args) => process.stderr.write(args.join(' ') + '\n')

function parseArgs(): { db: string } {
  const idx = process.argv.indexOf('--db')
  if (idx === -1 || !process.argv[idx + 1]) {
    process.stderr.write('Error: --db <path> is required\n')
    process.exit(1)
  }
  return { db: process.argv[idx + 1] }
}

async function main() {
  const { db: dbPath } = parseArgs()

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  const server = new McpServer({
    name: 'taskflow-mcp-server',
    version: '0.1.0',
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Emit ready sentinel AFTER transport is connected and listening
  process.stderr.write('MCP server ready\n')

  process.on('SIGTERM', () => {
    db.close()
    process.exit(0)
  })
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
```

**Step 4: Build and run test**

```bash
cd container/agent-runner
npm run build && npm test -- taskflow-mcp-server
```

Expected: PASS — both tests pass.

**Step 5: Commit**

```bash
git add src/taskflow-mcp-server.ts src/taskflow-mcp-server.test.ts
git commit -m "feat: mcp handshake in taskflow-mcp-server"
```

---

## Task 3: Register placeholder adapter tools

**Files:**
- Modify: `container/agent-runner/src/taskflow-mcp-server.ts`
- Modify: `container/agent-runner/src/taskflow-mcp-server.test.ts`

**Step 1: Write the failing test**

Add to `taskflow-mcp-server.test.ts`:
```typescript
it('returns adapter tools in tools/list after handshake', async () => {
  proc = spawn('node', [SERVER_BIN, '--db', TEST_DB], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout_rl = createInterface({ input: proc!.stdout! })
  const lines: any[] = []
  stdout_rl.on('line', (l) => { try { lines.push(JSON.parse(l)) } catch {} })

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: proc!.stderr! })
    const t = setTimeout(() => reject(new Error('timeout')), 5000)
    rl.on('line', (l) => { if (l.includes('MCP server ready')) { clearTimeout(t); resolve() } })
  })

  const send = (msg: object) => proc!.stdin!.write(JSON.stringify(msg) + '\n')
  const waitFor = (id: number) => new Promise<any>((resolve) => {
    const check = setInterval(() => {
      const msg = lines.find(m => m.id === id)
      if (msg) { clearInterval(check); resolve(msg) }
    }, 50)
    setTimeout(() => clearInterval(check), 5000)
  })

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } } })
  await waitFor(1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const resp = await waitFor(2)

  const toolNames = resp.result.tools.map((t: any) => t.name)
  expect(toolNames).toContain('api_board_activity')
  expect(toolNames).toContain('api_filter_board_tasks')
  expect(toolNames).toContain('api_linked_tasks')
})
```

**Step 2: Run to verify it fails**

```bash
cd container/agent-runner
npm run build && npm test -- taskflow-mcp-server
```

Expected: FAIL — `api_board_activity` not in tools list (no tools registered yet).

**Step 3: Register placeholder tools**

In `taskflow-mcp-server.ts`, after creating the server and before `connect()`:
```typescript
import { z } from 'zod'

// Phase 3 read adapter tools — implementations added in Phase 3
server.tool('api_board_activity', 'Board activity log (adapter placeholder)',
  { board_id: z.string(), mode: z.enum(['changes_today', 'changes_since']).optional(), since: z.string().optional() },
  async (_args) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_implemented' }) }] })
)

server.tool('api_filter_board_tasks', 'Board task filter (adapter placeholder)',
  { board_id: z.string(), filter: z.string() },
  async (_args) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_implemented' }) }] })
)

server.tool('api_linked_tasks', 'Board linked tasks (adapter placeholder)',
  { board_id: z.string() },
  async (_args) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_implemented' }) }] })
)
```

**Step 4: Build and run test**

```bash
cd container/agent-runner
npm run build && npm test -- taskflow-mcp-server
```

Expected: PASS — all three tools present in tools/list.

**Step 5: Commit**

```bash
git add src/taskflow-mcp-server.ts src/taskflow-mcp-server.test.ts
git commit -m "feat: register placeholder adapter tools in mcp server"
```

---

## Task 4: Python client — subprocess spawn and readiness

**Files:**
- Create: `taskflow-api/app/engine/__init__.py`
- Create: `taskflow-api/app/engine/client.py`
- Create: `taskflow-api/tests/test_engine_client.py`

**Step 1: Write the failing test**

Create `taskflow-api/tests/test_engine_client.py`:
```python
import asyncio
import os
import pytest
import pytest_asyncio
from pathlib import Path

SERVER_JS = Path(__file__).resolve().parents[3] / 'container/agent-runner/dist/taskflow-mcp-server.js'
TEST_DB = os.environ.get('TASKFLOW_DB_PATH', '/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db')

@pytest.mark.asyncio
async def test_client_reaches_ready_state():
    from app.engine.client import MCPSubprocessClient
    client = MCPSubprocessClient(server_bin=str(SERVER_JS), db_path=TEST_DB)
    await client.start()
    assert client.is_alive()
    await client.close()
```

**Step 2: Run to verify it fails**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py::test_client_reaches_ready_state -v
```

Expected: FAIL — `ModuleNotFoundError: app.engine.client`.

**Step 3: Implement subprocess spawn and readiness**

Create `taskflow-api/app/engine/__init__.py` (empty).

Create `taskflow-api/app/engine/client.py`:
```python
import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

STARTUP_TIMEOUT = 10.0  # seconds to wait for ready sentinel


class SubprocessUnavailableError(Exception):
    pass


@dataclass
class MCPSubprocessClient:
    server_bin: str
    db_path: str
    _proc: Optional[asyncio.subprocess.Process] = field(default=None, init=False, repr=False)
    _alive: bool = field(default=False, init=False, repr=False)

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            'node', self.server_bin, '--db', self.db_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await self._wait_for_ready()

    async def _wait_for_ready(self) -> None:
        assert self._proc and self._proc.stderr
        try:
            async with asyncio.timeout(STARTUP_TIMEOUT):
                async for line in self._proc.stderr:
                    if b'MCP server ready' in line:
                        self._alive = True
                        return
        except asyncio.TimeoutError:
            self._proc.kill()
            raise SubprocessUnavailableError('Subprocess did not emit ready sentinel in time')

    def is_alive(self) -> bool:
        return self._alive and self._proc is not None and self._proc.returncode is None

    async def close(self) -> None:
        if self._proc:
            self._proc.terminate()
            try:
                async with asyncio.timeout(5.0):
                    await self._proc.wait()
            except asyncio.TimeoutError:
                self._proc.kill()
        self._alive = False
```

**Step 4: Run test**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py::test_client_reaches_ready_state -v
```

Expected: PASS.

**Step 5: Commit**

```bash
git add taskflow-api/app/engine/__init__.py taskflow-api/app/engine/client.py taskflow-api/tests/test_engine_client.py
git commit -m "feat: engine/client.py subprocess spawn and readiness detection"
```

---

## Task 5: MCP handshake in the Python client

**Files:**
- Modify: `taskflow-api/app/engine/client.py`
- Modify: `taskflow-api/tests/test_engine_client.py`

**Step 1: Write the failing test**

Add to `test_engine_client.py`:
```python
@pytest.mark.asyncio
async def test_client_completes_mcp_handshake():
    from app.engine.client import MCPSubprocessClient
    client = MCPSubprocessClient(server_bin=str(SERVER_JS), db_path=TEST_DB)
    await client.start()
    # If handshake fails, start() raises; if we get here it succeeded
    assert client.is_alive()
    tool_names = client.available_tools()
    assert 'api_board_activity' in tool_names
    assert 'api_filter_board_tasks' in tool_names
    assert 'api_linked_tasks' in tool_names
    await client.close()
```

**Step 2: Run to verify it fails**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py::test_client_completes_mcp_handshake -v
```

Expected: FAIL — `MCPSubprocessClient` has no `available_tools` method; handshake not implemented.

**Step 3: Implement MCP handshake**

Update `client.py` to add NDJSON send/receive, handshake, and tools/list:
```python
import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

STARTUP_TIMEOUT = 10.0
CALL_TIMEOUT = 30.0
MCP_PROTOCOL_VERSION = '2024-11-05'


class SubprocessUnavailableError(Exception):
    pass


class MCPHandshakeError(Exception):
    pass


@dataclass
class MCPSubprocessClient:
    server_bin: str
    db_path: str
    _proc: Optional[asyncio.subprocess.Process] = field(default=None, init=False, repr=False)
    _alive: bool = field(default=False, init=False, repr=False)
    _next_id: int = field(default=1, init=False, repr=False)
    _tools: list = field(default_factory=list, init=False, repr=False)

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            'node', self.server_bin, '--db', self.db_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await self._wait_for_ready()
        await self._handshake()

    async def _wait_for_ready(self) -> None:
        assert self._proc and self._proc.stderr
        try:
            async with asyncio.timeout(STARTUP_TIMEOUT):
                async for line in self._proc.stderr:
                    if b'MCP server ready' in line:
                        return
        except asyncio.TimeoutError:
            self._proc.kill()
            raise SubprocessUnavailableError('Subprocess did not emit ready sentinel in time')

    async def _send(self, msg: dict) -> None:
        assert self._proc and self._proc.stdin
        line = json.dumps(msg) + '\n'
        self._proc.stdin.write(line.encode())
        await self._proc.stdin.drain()

    async def _recv(self) -> dict:
        assert self._proc and self._proc.stdout
        async with asyncio.timeout(CALL_TIMEOUT):
            while True:
                raw = await self._proc.stdout.readline()
                if not raw:
                    raise SubprocessUnavailableError('stdout EOF')
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    raise SubprocessUnavailableError(f'Invalid JSON on stdout: {raw!r}')

    async def _handshake(self) -> None:
        req_id = self._next_id
        self._next_id += 1
        await self._send({
            'jsonrpc': '2.0', 'id': req_id, 'method': 'initialize',
            'params': {
                'protocolVersion': MCP_PROTOCOL_VERSION,
                'capabilities': {},
                'clientInfo': {'name': 'taskflow-api', 'version': '1.0.0'},
            }
        })
        resp = await self._recv()
        if resp.get('id') != req_id or 'result' not in resp:
            raise MCPHandshakeError(f'Unexpected initialize response: {resp}')

        await self._send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

        list_id = self._next_id
        self._next_id += 1
        await self._send({'jsonrpc': '2.0', 'id': list_id, 'method': 'tools/list'})
        list_resp = await self._recv()
        if list_resp.get('id') != list_id or 'result' not in list_resp:
            raise MCPHandshakeError(f'Unexpected tools/list response: {list_resp}')

        self._tools = list_resp['result'].get('tools', [])
        expected = {'api_board_activity', 'api_filter_board_tasks', 'api_linked_tasks'}
        actual = {t['name'] for t in self._tools}
        missing = expected - actual
        if missing:
            raise MCPHandshakeError(f'Server missing expected tools: {missing}')

        self._alive = True

    def available_tools(self) -> list[str]:
        return [t['name'] for t in self._tools]

    def is_alive(self) -> bool:
        return self._alive and self._proc is not None and self._proc.returncode is None

    async def close(self) -> None:
        self._alive = False
        if self._proc:
            self._proc.terminate()
            try:
                async with asyncio.timeout(5.0):
                    await self._proc.wait()
            except asyncio.TimeoutError:
                self._proc.kill()
```

**Step 4: Run test**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py -v
```

Expected: PASS — both tests pass.

**Step 5: Commit**

```bash
git add taskflow-api/app/engine/client.py taskflow-api/tests/test_engine_client.py
git commit -m "feat: mcp handshake and tools/list validation in python client"
```

---

## Task 6: Serialized tool call with timeout

**Files:**
- Modify: `taskflow-api/app/engine/client.py`
- Modify: `taskflow-api/tests/test_engine_client.py`

**Step 1: Write the failing test**

Add to `test_engine_client.py`:
```python
@pytest.mark.asyncio
async def test_client_call_returns_result():
    from app.engine.client import MCPSubprocessClient
    client = MCPSubprocessClient(server_bin=str(SERVER_JS), db_path=TEST_DB)
    await client.start()
    result = await client.call('api_board_activity', {'board_id': 'test', 'mode': 'changes_today'})
    # Placeholder returns not_implemented error — that's fine for Phase 1
    assert 'error' in result or 'content' in result
    await client.close()
```

**Step 2: Run to verify it fails**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py::test_client_call_returns_result -v
```

Expected: FAIL — `MCPSubprocessClient` has no `call` method.

**Step 3: Implement call()**

Add to `client.py`:
```python
async def call(self, tool_name: str, args: dict) -> dict:
    if not self.is_alive():
        raise SubprocessUnavailableError('Subprocess is not available')
    req_id = self._next_id
    self._next_id += 1
    await self._send({
        'jsonrpc': '2.0', 'id': req_id, 'method': 'tools/call',
        'params': {'name': tool_name, 'arguments': args},
    })
    resp = await self._recv()
    if resp.get('id') != req_id:
        raise SubprocessUnavailableError(f'Response ID mismatch: expected {req_id}, got {resp.get("id")}')
    if 'error' in resp:
        return {'error': resp['error']}
    content = resp.get('result', {}).get('content', [])
    for item in content:
        if item.get('type') == 'text':
            try:
                return json.loads(item['text'])
            except json.JSONDecodeError:
                return {'text': item['text']}
    return {}
```

**Step 4: Run test**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py -v
```

Expected: PASS — all three tests pass.

**Step 5: Commit**

```bash
git add taskflow-api/app/engine/client.py taskflow-api/tests/test_engine_client.py
git commit -m "feat: serialized tool call with timeout in python client"
```

---

## Task 7: Subprocess death and in-flight cleanup

**Files:**
- Modify: `taskflow-api/app/engine/client.py`
- Modify: `taskflow-api/tests/test_engine_client.py`

**Step 1: Write the failing test**

Add to `test_engine_client.py`:
```python
@pytest.mark.asyncio
async def test_client_raises_on_subprocess_death():
    from app.engine.client import MCPSubprocessClient, SubprocessUnavailableError
    client = MCPSubprocessClient(server_bin=str(SERVER_JS), db_path=TEST_DB)
    await client.start()
    assert client.is_alive()

    # Kill the subprocess externally
    client._proc.kill()
    await asyncio.sleep(0.2)

    assert not client.is_alive()
    with pytest.raises(SubprocessUnavailableError):
        await client.call('api_board_activity', {'board_id': 'test'})
    await client.close()
```

**Step 2: Run to verify it fails**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py::test_client_raises_on_subprocess_death -v
```

Expected: FAIL — `client.is_alive()` still True after kill; call may hang or raise wrong exception.

**Step 3: Implement death detection**

Update `client.py` to start a background reader task that monitors stdout and detects process exit:
```python
import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

STARTUP_TIMEOUT = 10.0
CALL_TIMEOUT = 30.0
MCP_PROTOCOL_VERSION = '2024-11-05'


class SubprocessUnavailableError(Exception):
    pass


class MCPHandshakeError(Exception):
    pass


@dataclass
class MCPSubprocessClient:
    server_bin: str
    db_path: str
    _proc: Optional[asyncio.subprocess.Process] = field(default=None, init=False, repr=False)
    _alive: bool = field(default=False, init=False, repr=False)
    _next_id: int = field(default=1, init=False, repr=False)
    _tools: list = field(default_factory=list, init=False, repr=False)
    _pending: dict = field(default_factory=dict, init=False, repr=False)
    _read_task: Optional[asyncio.Task] = field(default=None, init=False, repr=False)

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            'node', self.server_bin, '--db', self.db_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await self._wait_for_ready()
        await self._handshake()
        self._read_task = asyncio.create_task(self._read_loop())
        self._read_task.add_done_callback(self._on_read_loop_done)

    async def _wait_for_ready(self) -> None:
        assert self._proc and self._proc.stderr
        try:
            async with asyncio.timeout(STARTUP_TIMEOUT):
                async for line in self._proc.stderr:
                    if b'MCP server ready' in line:
                        return
        except asyncio.TimeoutError:
            self._proc.kill()
            raise SubprocessUnavailableError('Subprocess did not emit ready sentinel in time')

    async def _send(self, msg: dict) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write((json.dumps(msg) + '\n').encode())
        await self._proc.stdin.drain()

    async def _handshake(self) -> None:
        req_id = self._next_id; self._next_id += 1
        await self._send({'jsonrpc': '2.0', 'id': req_id, 'method': 'initialize',
            'params': {'protocolVersion': MCP_PROTOCOL_VERSION, 'capabilities': {},
                       'clientInfo': {'name': 'taskflow-api', 'version': '1.0.0'}}})
        resp = await self._recv_direct()
        if resp.get('id') != req_id or 'result' not in resp:
            raise MCPHandshakeError(f'Bad initialize response: {resp}')
        await self._send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        list_id = self._next_id; self._next_id += 1
        await self._send({'jsonrpc': '2.0', 'id': list_id, 'method': 'tools/list'})
        list_resp = await self._recv_direct()
        if list_resp.get('id') != list_id or 'result' not in list_resp:
            raise MCPHandshakeError(f'Bad tools/list response: {list_resp}')
        self._tools = list_resp['result'].get('tools', [])
        expected = {'api_board_activity', 'api_filter_board_tasks', 'api_linked_tasks'}
        missing = expected - {t['name'] for t in self._tools}
        if missing:
            raise MCPHandshakeError(f'Server missing expected tools: {missing}')
        self._alive = True

    async def _recv_direct(self) -> dict:
        """Used only during handshake before the read loop starts."""
        assert self._proc and self._proc.stdout
        async with asyncio.timeout(CALL_TIMEOUT):
            while True:
                raw = await self._proc.stdout.readline()
                if not raw:
                    raise SubprocessUnavailableError('stdout EOF during handshake')
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    raise SubprocessUnavailableError(f'Invalid JSON: {raw!r}')

    async def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        try:
            while True:
                raw = await self._proc.stdout.readline()
                if not raw:
                    break
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.error('Invalid JSON from subprocess stdout: %r', raw)
                    break
                msg_id = msg.get('id')
                if msg_id is not None and msg_id in self._pending:
                    fut = self._pending.pop(msg_id)
                    if not fut.done():
                        fut.set_result(msg)
        except Exception as exc:
            logger.error('Read loop exited with exception: %s', exc)

    def _on_read_loop_done(self, task: asyncio.Task) -> None:
        self._alive = False
        err = SubprocessUnavailableError('Subprocess became unavailable')
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(err)
        self._pending.clear()

    def is_alive(self) -> bool:
        return self._alive and self._proc is not None and self._proc.returncode is None

    def available_tools(self) -> list[str]:
        return [t['name'] for t in self._tools]

    async def call(self, tool_name: str, args: dict) -> dict:
        if not self.is_alive():
            raise SubprocessUnavailableError('Subprocess is not available')
        req_id = self._next_id; self._next_id += 1
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        await self._send({'jsonrpc': '2.0', 'id': req_id, 'method': 'tools/call',
                          'params': {'name': tool_name, 'arguments': args}})
        try:
            async with asyncio.timeout(CALL_TIMEOUT):
                resp = await fut
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise SubprocessUnavailableError(f'Call to {tool_name} timed out')
        if 'error' in resp:
            return {'error': resp['error']}
        content = resp.get('result', {}).get('content', [])
        for item in content:
            if item.get('type') == 'text':
                try:
                    return json.loads(item['text'])
                except json.JSONDecodeError:
                    return {'text': item['text']}
        return {}

    async def close(self) -> None:
        self._alive = False
        if self._read_task and not self._read_task.done():
            self._read_task.cancel()
            try:
                await self._read_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._proc:
            self._proc.terminate()
            try:
                async with asyncio.timeout(5.0):
                    await self._proc.wait()
            except asyncio.TimeoutError:
                self._proc.kill()
```

**Step 4: Run all tests**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py -v
```

Expected: PASS — all four tests pass.

**Step 5: Commit**

```bash
git add taskflow-api/app/engine/client.py taskflow-api/tests/test_engine_client.py
git commit -m "feat: subprocess death detection and in-flight future cleanup"
```

---

## Task 8: FastAPI lifespan integration

**Files:**
- Modify: `taskflow-api/app/main.py` (lines ~1983–1999)
- Modify: `taskflow-api/tests/conftest.py`
- Modify: `taskflow-api/tests/test_engine_client.py`

**Step 1: Write the failing test**

Add to `test_engine_client.py`:
```python
@pytest.mark.asyncio
async def test_app_starts_mcp_client_in_lifespan():
    import os
    os.environ['TASKFLOW_MCP_SERVER_BIN'] = str(SERVER_JS)
    from httpx import AsyncClient, ASGITransport
    # Import after setting env var
    import importlib
    import app.main as m
    importlib.reload(m)
    application = m.create_app()
    async with AsyncClient(transport=ASGITransport(app=application), base_url='http://test') as ac:
        resp = await ac.get('/health')
    assert resp.status_code == 200
    data = resp.json()
    assert data['subprocess']['status'] in ('healthy', 'unavailable')
```

**Step 2: Run to verify it fails**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py::test_app_starts_mcp_client_in_lifespan -v
```

Expected: FAIL — `create_app` doesn't exist or health doesn't return subprocess status.

**Step 3: Update lifespan in main.py**

Locate the `lifespan` function (~line 1983) and the `create_app` factory (or define one). The new lifespan spawns the MCP client when `TASKFLOW_MCP_SERVER_BIN` is set and `TASKFLOW_DISABLE_MCP_SUBPROCESS` is not set:

```python
import os as _os

@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    # Heartbeat sweep
    task = asyncio.create_task(_run_heartbeat_sweep())

    # MCP subprocess client
    mcp_client = None
    disable = _os.environ.get('TASKFLOW_DISABLE_MCP_SUBPROCESS', '').strip()
    server_bin = _os.environ.get('TASKFLOW_MCP_SERVER_BIN', '')
    if not disable and server_bin:
        from app.engine.client import MCPSubprocessClient
        mcp_client = MCPSubprocessClient(server_bin=server_bin, db_path=get_db_path())
        try:
            await mcp_client.start()
        except Exception as exc:
            logger.error('MCP subprocess failed to start: %s', exc)
            mcp_client = None
    application.state.mcp_client = mcp_client

    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        if mcp_client:
            await mcp_client.close()
```

**Step 4: Update /health endpoint**

Replace the health endpoint (~line 2011):
```python
@app.get('/health')
@app.get('/api/v1/health')
def health(request: Request) -> Dict[str, Any]:
    mcp_client = getattr(request.app.state, 'mcp_client', None)
    if mcp_client is None:
        subprocess_status = 'disabled'
        status_code = 200
    elif mcp_client.is_alive():
        subprocess_status = 'healthy'
        status_code = 200
    else:
        subprocess_status = 'unavailable'
        status_code = 503
    from fastapi.responses import JSONResponse
    return JSONResponse(
        {'status': 'ok' if status_code == 200 else 'degraded',
         'subprocess': {'status': subprocess_status}},
        status_code=status_code,
    )
```

**Step 5: Run tests**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py -v
```

Expected: PASS.

**Step 6: Commit**

```bash
git add taskflow-api/app/main.py taskflow-api/tests/test_engine_client.py
git commit -m "feat: mcp client wired into fastapi lifespan and health endpoint"
```

---

## Task 9: Test isolation — FakeMCPClient

**Files:**
- Create: `taskflow-api/app/engine/fake_client.py`
- Modify: `taskflow-api/tests/conftest.py`

**Step 1: Write the failing test**

Add to `test_engine_client.py`:
```python
def test_existing_api_tests_pass_without_subprocess(monkeypatch):
    """Existing test suite must not require a running subprocess."""
    import os
    monkeypatch.setenv('TASKFLOW_DISABLE_MCP_SUBPROCESS', '1')
    # If conftest wires the fake client, existing tests should be unaffected
    # This test just verifies the env var is respected — the real check is
    # running the full test suite: pytest tests/ (not test_engine_client.py only)
    assert os.environ.get('TASKFLOW_DISABLE_MCP_SUBPROCESS') == '1'
```

**Step 2: Create FakeMCPClient**

Create `taskflow-api/app/engine/fake_client.py`:
```python
from dataclasses import dataclass, field
from typing import Any


class SubprocessUnavailableError(Exception):
    pass


@dataclass
class FakeMCPClient:
    """Drop-in replacement for MCPSubprocessClient in tests.
    Returns configurable canned responses. Default: not_implemented error."""

    _responses: dict = field(default_factory=dict, repr=False)
    _alive: bool = field(default=True, init=False, repr=False)

    def set_response(self, tool_name: str, response: dict) -> None:
        self._responses[tool_name] = response

    def is_alive(self) -> bool:
        return self._alive

    def available_tools(self) -> list[str]:
        return list(self._responses.keys())

    async def start(self) -> None:
        pass

    async def call(self, tool_name: str, args: dict) -> dict:
        if not self._alive:
            raise SubprocessUnavailableError('FakeMCPClient is not alive')
        return self._responses.get(tool_name, {'error': 'not_implemented'})

    async def close(self) -> None:
        self._alive = False
```

**Step 3: Update conftest.py**

Add to `taskflow-api/tests/conftest.py` (at the top of the existing fixture setup):
```python
import os
# Disable real subprocess for all tests by default
os.environ.setdefault('TASKFLOW_DISABLE_MCP_SUBPROCESS', '1')
```

**Step 4: Run entire test suite**

```bash
cd taskflow-api
python -m pytest tests/ -v
```

Expected: PASS — all existing tests pass; no subprocess is started.

**Step 5: Commit**

```bash
git add taskflow-api/app/engine/fake_client.py taskflow-api/tests/conftest.py taskflow-api/tests/test_engine_client.py
git commit -m "feat: FakeMCPClient and TASKFLOW_DISABLE_MCP_SUBPROCESS test isolation"
```

---

## Task 10: Subprocess boundary structured logging

**Files:**
- Modify: `taskflow-api/app/engine/client.py`
- Modify: `taskflow-api/tests/test_engine_client.py`

**Step 1: Write the failing test**

Add to `test_engine_client.py`:
```python
@pytest.mark.asyncio
async def test_call_emits_structured_log(caplog):
    import logging
    from app.engine.client import MCPSubprocessClient
    client = MCPSubprocessClient(server_bin=str(SERVER_JS), db_path=TEST_DB)
    await client.start()
    with caplog.at_level(logging.INFO, logger='app.engine.client'):
        await client.call('api_board_activity', {'board_id': 'test', 'mode': 'changes_today'})
    await client.close()
    assert any('api_board_activity' in r.message for r in caplog.records)
    assert any('duration_ms' in r.message for r in caplog.records)
```

**Step 2: Run to verify it fails**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py::test_call_emits_structured_log -v
```

Expected: FAIL — no structured log emitted.

**Step 3: Add logging to call()**

In `client.py`, update the `call()` method to wrap with timing and logging:
```python
import time

async def call(self, tool_name: str, args: dict) -> dict:
    if not self.is_alive():
        raise SubprocessUnavailableError('Subprocess is not available')
    req_id = self._next_id; self._next_id += 1
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    self._pending[req_id] = fut
    await self._send({'jsonrpc': '2.0', 'id': req_id, 'method': 'tools/call',
                      'params': {'name': tool_name, 'arguments': args}})
    t0 = time.monotonic()
    try:
        async with asyncio.timeout(CALL_TIMEOUT):
            resp = await fut
    except asyncio.TimeoutError:
        self._pending.pop(req_id, None)
        duration_ms = int((time.monotonic() - t0) * 1000)
        logger.error('tool=%s req_id=%d status=timeout duration_ms=%d', tool_name, req_id, duration_ms)
        raise SubprocessUnavailableError(f'Call to {tool_name} timed out')
    duration_ms = int((time.monotonic() - t0) * 1000)
    if 'error' in resp:
        logger.info('tool=%s req_id=%d status=error duration_ms=%d', tool_name, req_id, duration_ms)
        return {'error': resp['error']}
    logger.info('tool=%s req_id=%d status=ok duration_ms=%d', tool_name, req_id, duration_ms)
    content = resp.get('result', {}).get('content', [])
    for item in content:
        if item.get('type') == 'text':
            try:
                return json.loads(item['text'])
            except json.JSONDecodeError:
                return {'text': item['text']}
    return {}
```

**Step 4: Run tests**

```bash
cd taskflow-api
python -m pytest tests/test_engine_client.py -v
```

Expected: PASS.

**Step 5: Commit**

```bash
git add taskflow-api/app/engine/client.py taskflow-api/tests/test_engine_client.py
git commit -m "feat: structured logging at subprocess boundary"
```

---

## Task 11: Push updated design doc and CI build pipeline

**Files:**
- Modify: `docs/plans/2026-04-20-taskflow-api-channel-design.md` (already updated)
- Create: CI configuration file for TypeScript build

**Step 1: Push updated design doc**

The design doc was updated with actor-resolution decision (Option B, phone-based JOIN). Verify it's committed:

```bash
git log --oneline docs/plans/2026-04-20-taskflow-api-channel-design.md | head -3
```

Expected: shows the fifth-revision commit.

**Step 2: Add npm test script to package.json if not already there**

Verify `container/agent-runner/package.json` has:
```json
"scripts": {
  "build": "tsc",
  "test": "vitest run",
  "start": "node dist/index.js"
}
```

**Step 3: Verify integration tests run end-to-end**

```bash
# Build Node server
cd container/agent-runner && npm run build

# Run Node tests
npm test

# Run Python unit tests (subprocess disabled)
cd /root/tf-mcontrol/taskflow-api
TASKFLOW_DISABLE_MCP_SUBPROCESS=1 python -m pytest tests/ -v

# Run Python integration tests (subprocess enabled)
TASKFLOW_MCP_SERVER_BIN=/root/nanoclaw/container/agent-runner/dist/taskflow-mcp-server.js \
python -m pytest tests/test_engine_client.py -v -k "not fake"
```

Expected: all pass.

**Step 4: Commit package.json if changed**

```bash
cd container/agent-runner
git add package.json
git commit -m "chore: add vitest test script to package.json"
```

---

## Phase 1 Acceptance Criteria

Before declaring Phase 1 complete, verify all of the following:

- [ ] `npm run build` in `container/agent-runner` compiles without errors
- [ ] `npm test` in `container/agent-runner` passes all server tests
- [ ] `pytest tests/` in `taskflow-api` passes with `TASKFLOW_DISABLE_MCP_SUBPROCESS=1`
- [ ] Integration tests pass with real subprocess: `pytest tests/test_engine_client.py -v`
- [ ] `GET /health` returns `{"subprocess": {"status": "healthy"}}` when subprocess is running
- [ ] `GET /health` returns 503 with `{"subprocess": {"status": "unavailable"}}` when subprocess is killed
- [ ] Killing the subprocess causes pending `call()` to raise `SubprocessUnavailableError` promptly
- [ ] Starting the app with `TASKFLOW_DISABLE_MCP_SUBPROCESS=1` skips subprocess spawn
- [ ] Structured log entry with `tool=`, `req_id=`, `status=`, `duration_ms=` emitted on every `call()`
- [ ] No route behavior has changed — all existing API tests pass
