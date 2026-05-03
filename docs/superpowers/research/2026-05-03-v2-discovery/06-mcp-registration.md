# v2 MCP Tool Registration — Deep Research

**Date:** 2026-05-03
**Branch context:** Migrating v1 TaskFlow (~30 MCP tools) onto `skill/taskflow-v2`.
**Source endpoint:** `git show remotes/upstream/v2:<path>` — all citations below resolve against that ref.

---

## TL;DR

- **Registration is import-side-effect.** Each tool file calls `registerTools([...])` at module scope. There is **no central exported list** — a private `allTools: McpToolDefinition[]` and `toolMap: Map<string, McpToolDefinition>` live inside `mcp-tools/server.ts`.
- **Discovery is via the barrel.** `mcp-tools/index.ts` imports each tool file (`./core.js`, `./scheduling.js`, …) purely for side effects, then calls `startMcpServer()`. To add a tool group: create a new file, add a single `import './<file>.js';` line in `index.ts`. That is the only wiring change.
- **Schema is JSON Schema, not Zod.** Each `McpToolDefinition` has `tool: { name, description, inputSchema }` where `inputSchema` is a hand-written JSON-Schema object (no Zod, no codegen). `zod` IS in `package.json` but is unused inside `mcp-tools/`.
- **Tests do NOT enumerate tools** in v2. The directory has zero `*.test.ts` files. The only test that exercises tool plumbing is `integration.test.ts` end-to-end, and it goes through `MockProvider`, not the MCP server. No accessor pattern, no spin-up-server-in-tests pattern. **Anything we want to test goes through DB-state assertions** (the canonical v2 pattern: a tool writes to `messages_out`, the test asserts the row).
- **TaskFlow tools should live at `container/agent-runner/src/mcp-tools/taskflow.ts`** (single file, mirroring `scheduling.ts`'s ~300-line scope) — registered by adding `import './taskflow.js';` to `index.ts`. Engine code goes alongside in `container/agent-runner/src/taskflow/` and is **direct-imported** by the tool file (no DI; the engine opens its own DB via the same `bun:sqlite` connection helpers as `scheduling.ts`).

---

## 1 — The Registration Pattern

### 1.1 Server bootstrap (`container/agent-runner/src/mcp-tools/server.ts`)

The whole pattern fits in 54 lines.

```ts
// server.ts:21-22 — module-private state, NOT exported
const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

// server.ts:24-33 — the only registration entry-point
export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

// server.ts:35-54 — boots the MCP server using whatever has accumulated in allTools/toolMap
export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools.map((t) => t.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    return tool.handler(args ?? {});
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
```

Codex was right: `allTools` and `toolMap` are **private** to the module. There is no exported getter, no introspection API. The only way to know what tools are registered is to import the barrel and rely on `startMcpServer()`'s log line.

**Implication for tests:** you cannot enumerate tools without booting the server (or duplicating the import dance and reaching into module internals — neither pattern is used in v2).

### 1.2 The barrel (`mcp-tools/index.ts`)

```ts
// index.ts (full file, 22 lines)
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import { startMcpServer } from './server.js';

startMcpServer().catch((err) => { /* ... */ process.exit(1); });
```

Five side-effect imports, one server start. Adding a 6th tool group is:

```ts
import './taskflow.js';   // ← single line
```

There is no manifest, no config, no allowlist. The barrel IS the registry.

### 1.3 Tool definition shape (`mcp-tools/types.ts`)

The entire types file is six lines:

```ts
// types.ts:1-6
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpToolDefinition {
  tool: Tool;                                                              // .name, .description, .inputSchema
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}
```

`Tool` and `CallToolResult` come straight from the MCP SDK. `inputSchema` is JSON-Schema (hand-written object literals). `args` is `Record<string, unknown>` — handlers cast/validate manually (see `core.ts:113` `args.text as string` followed by `if (!text) return err('text is required')`).

### 1.4 Anatomy of a single tool file (`mcp-tools/core.ts`)

```ts
// core.ts:15  — registration helper imported
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

// core.ts:98-132 — example tool definition (send_message)
export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination. ...',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to:   { type: 'string', description: '...' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text) return err('text is required');
    // ... business logic ...
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

// core.ts:262 — THIS LINE is what makes it real
registerTools([sendMessage, sendFile, editMessage, addReaction]);
```

Each file follows the same shape:

1. Import `registerTools` and `McpToolDefinition`.
2. Export N `const xyz: McpToolDefinition = { tool: {...}, handler: async (args) => {...} }`.
3. Call `registerTools([...])` once at the bottom with all the tools in the file.

The `export const` is **not load-bearing for registration** — it's only there for type-checking and (occasionally) cross-file reuse. The `registerTools([...])` call at module bottom IS the registration.

Helper functions repeat across every file and are inlined per-module (not centralized):

```ts
// every tool file ships its own copy:
function log(msg: string): void { console.error(`[mcp-tools] ${msg}`); }
function ok(text: string)  { return { content: [{ type: 'text' as const, text }] }; }
function err(text: string) { return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true }; }
function generateId(): string { return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
```

This is intentional — v2 prefers per-file duplication over a `mcp-tools/util.ts` (no shared util module exists). Three lines each, low risk of drift. Mirror that pattern for `taskflow.ts`.

### 1.5 Why side-effect-on-import (and not a registry array)

The doc-comment at `server.ts:1-10` is explicit:

> Each tool module calls `registerTools([...])` at import time. The barrel (`index.ts`) imports every tool module for side effects, then calls `startMcpServer()` which uses whatever was registered. Default when only `core.ts` is imported: the core `send_message` / `send_file` / `edit_message` / `add_reaction` tools are available.

The "default when only `core.ts` is imported" sentence is the design intent: **modules are independently importable**. A skill that wants only the core tools can import `'./core.js'` then `startMcpServer()` and get a 4-tool server. That's why no central array — that would force every tool to be linked even if a config disables it.

In practice we never use that affordance (the barrel always imports all of them), but the architecture is "module = unit of registration" rather than "tool = unit of registration."

---

## 2 — How the MCP Server is Launched

The MCP server runs as a **child process** of the agent-runner, spawned by the Claude SDK via stdio.

```ts
// container/agent-runner/src/index.ts:71-83 — agent-runner main entry
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
  nanoclaw: {
    command: 'bun',
    args: ['run', mcpServerPath],
    env: {},
  },
};

for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
  mcpServers[name] = serverConfig;
  log(`Additional MCP server: ${name} (${serverConfig.command})`);
}
```

Then `mcpServers` is passed to the Claude SDK via `providers/claude.ts:282`:

```ts
sdkQuery({ prompt: stream, options: { /* ... */ mcpServers: this.mcpServers, /* ... */ } });
```

Tools therefore appear to the agent as `mcp__nanoclaw__send_message`, `mcp__nanoclaw__schedule_task`, etc. The allowlist at `providers/claude.ts:46` is `'mcp__nanoclaw__*'` — wildcard — so **adding new tools to the `nanoclaw` MCP server is automatically allowed without touching the allowlist**.

Two practical consequences:

1. **`bun run mcp-tools/index.ts`** is the launch command — bun runs TypeScript directly inside the image, no compile step. Tool files MUST be valid Bun-compatible TS (which they already are; everything in `agent-runner/src/` is bun-runnable).
2. **No re-export, no MCP-server-list config.** The barrel imports it all. New tool files are picked up by editing `index.ts`.

---

## 3 — Concrete TaskFlow Layout

### 3.1 Where the tool files go

**Recommendation: single file `container/agent-runner/src/mcp-tools/taskflow.ts`**, with engine code at `container/agent-runner/src/taskflow/{db,engine,migrations}.ts`.

Justifying single-file:

- `scheduling.ts` is 299 lines for 6 tools (~50 lines/tool). At 30 TaskFlow tools we're looking at ~1,500 lines if we follow the same density. That's chunky but still readable in one file. v2 has no precedent for splitting a tool group; matching that convention reduces friction.
- The barrel only knows about file names. A `mcp-tools/taskflow/` subdirectory would either need a barrel-of-barrels (unprecedented in v2) or 30 individual `import './taskflow/<tool>.js'` lines in `index.ts` (noisy and fragile to skill-merge tooling).
- If `taskflow.ts` blows past ~1,200 lines, **then** split — but split engine-side, not tool-file-side. The tool file should remain the thin handlers + JSON-Schema layer; the engine functions live elsewhere.

### 3.2 Suggested file layout for `skill/taskflow-v2`

```
container/agent-runner/src/
├── mcp-tools/
│   ├── index.ts                    # ADD: import './taskflow.js';
│   ├── taskflow.ts                 # NEW — ~30 McpToolDefinition exports + one registerTools([...]) call
│   └── taskflow.instructions.md    # NEW — agent-facing docs (auto-mounted via claude-md-compose.ts:79-91)
└── taskflow/                       # NEW — engine subdirectory
    ├── db.ts                       # opens taskflow.db via bun:sqlite
    ├── schema.ts                   # CREATE TABLE …, migrations
    ├── tasks.ts                    # createTask, getTask, moveTask, …
    ├── boards.ts                   # provisionBoard, listBoards, …
    └── projects.ts                 # createProject, mergeProject, …
```

### 3.3 Engine call pattern — direct import, NOT DI

`scheduling.ts:8-9` shows the engine-call convention:

```ts
import { getInboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
```

The tool file directly imports module-level functions. The DB connection is opened lazily via the singleton in `db/connection.ts:31-37` (`let _inbound: Database | null = null; … if (!_inbound) _inbound = new Database(...);`). No DB handle is passed in by the tool registrar.

For TaskFlow, mirror that:

```ts
// container/agent-runner/src/taskflow/db.ts
import { Database } from 'bun:sqlite';

let _taskflowDb: Database | null = null;

export function getTaskflowDb(): Database {
  if (!_taskflowDb) {
    _taskflowDb = new Database('/workspace/taskflow.db');
    _taskflowDb.exec('PRAGMA journal_mode = WAL');
    // …schema/migration bootstrap…
  }
  return _taskflowDb;
}
```

Then in `taskflow.ts`:

```ts
import { getTaskflowDb } from '../taskflow/db.js';
import { createTask } from '../taskflow/tasks.js';

export const addTask: McpToolDefinition = {
  tool: { name: 'add_task', /* ... */ },
  async handler(args) {
    const id = createTask(getTaskflowDb(), { title: args.title as string, /* ... */ });
    return ok(`Task #${id} created`);
  },
};
```

**Important — DB location.** v1 stored TaskFlow rows in `store/messages.db` (host-owned, container had no DB access). In v2 the container has its own session DB (`/workspace/outbound.db`) but TaskFlow data is **per-board persistent state**, not session-ephemeral. Two viable paths:

- **(A) Per-group taskflow.db at `/workspace/taskflow.db`** mounted from `groups/<folder>/taskflow.db` host-side. Engine writes directly. Simple, isolated, but each board has its own DB.
- **(B) Continue centralizing in `store/messages.db`** (or a v2-equivalent central path). Container would need to be granted write access via a host-side mount + the v2 cross-mount caveats from `db/connection.ts:11-18` (journal_mode=DELETE for cross-mount safety).

Path (A) is more aligned with v2's "session-scoped DB" philosophy and avoids the mount-coherency landmine. But it forecloses cross-board queries (one of v1 TaskFlow's features). **This decision is out of scope for this doc — see research note `04-taskflow-table-placement.md`.**

### 3.4 The `taskflow.instructions.md` fragment is automatic

`src/claude-md-compose.ts:79-91` shows that any `<name>.instructions.md` sibling to a tool file is auto-imported into the composed CLAUDE.md:

```ts
// claude-md-compose.ts:79-91
const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
if (fs.existsSync(mcpToolsHostDir)) {
  for (const entry of fs.readdirSync(mcpToolsHostDir)) {
    const match = entry.match(/^(.+)\.instructions\.md$/);
    if (!match) continue;
    const moduleName = match[1];
    desired.set(`module-${moduleName}.md`, {
      type: 'symlink',
      content: `${SHARED_MCP_TOOLS_CONTAINER_BASE}/${entry}`,
    });
  }
}
```

So shipping `taskflow.instructions.md` next to `taskflow.ts` is the only step needed — no registration, no config. The file is symlinked into every group's `CLAUDE.md` automatically at spawn.

---

## 4 — Test Enumeration

### 4.1 The honest answer: there is no test enumeration in v2

`container/agent-runner/` test inventory:

```
formatter.test.ts
integration.test.ts
poll-loop.test.ts
providers/factory.test.ts
timezone.test.ts
```

**Zero files under `mcp-tools/`** — no `core.test.ts`, no `scheduling.test.ts`. The MCP layer is tested **only** through `integration.test.ts`, and even that test does NOT exercise MCP at all — it uses `MockProvider` which short-circuits the SDK and writes `<message to="...">` strings directly:

```ts
// integration.test.ts:34-38
const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');
const controller = new AbortController();
const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);
await waitFor(() => getUndeliveredMessages().length > 0, 2000);
```

This validates the poll-loop + DB plumbing, not the MCP server.

### 4.2 What this means for `skill/taskflow-v2`

There are **two viable test strategies**, neither of them v2-canonical:

**Strategy 1: handler-direct unit tests.** Skip the MCP layer entirely. Import `addTask` from `taskflow.ts` and call `addTask.handler({ title: 'foo' })` directly. Assert on the returned `CallToolResult` and on the resulting DB row. This is what v1 effectively did via `taskflow.test.ts` (calling engine functions directly).

```ts
// .claude/skills/add-taskflow/tests/taskflow-tools.test.ts (NEW)
import { describe, it, expect, beforeEach } from 'bun:test';
import { addTask, listTasks } from '../../../container/agent-runner/src/mcp-tools/taskflow.ts';

describe('taskflow MCP tools', () => {
  beforeEach(() => { /* init test taskflow.db */ });

  it('add_task creates a row', async () => {
    const result = await addTask.handler({ title: 'Buy milk', column: 'inbox' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Task #\d+ created/);
  });
});
```

Pro: fast, no server boot, no SDK stubs. Con: bypasses `registerTools` entirely — a tool that's defined but not registered would still pass.

**Strategy 2: registration check via barrel import.** Import the barrel (`mcp-tools/index.ts`), then assert behavior. But the barrel calls `startMcpServer()` at top-level which connects to stdio — **importing it in a test would hang on `await server.connect(transport)`**. So this requires either:

- Stubbing stdio (gnarly).
- Adding a test-only export to `server.ts` that lets tests read `allTools`. **But** this means modifying `server.ts`, which our skill rules forbid (no NanoClaw codebase changes — see `feedback_no_nanoclaw_codebase_changes.md`).

**Recommendation: Strategy 1 for behavior tests, plus a one-line "registration smoke" check that imports `taskflow.ts` standalone and confirms the side-effect doesn't throw.** No tool enumeration, no `allTools` introspection. This matches v2's "test through DB state" pattern (the same one `integration.test.ts` uses).

If you absolutely must enumerate, the cleanest path is to **export the tool array from `taskflow.ts`** for our own internal use:

```ts
// taskflow.ts (end of file)
export const ALL_TASKFLOW_TOOLS = [addTask, listTasks, /* ... */];
registerTools(ALL_TASKFLOW_TOOLS);
```

Then tests do `import { ALL_TASKFLOW_TOOLS } from '...';` and iterate. This is **a v2-deviation but a small one** — the array is a per-module export, not a global registry. Defensible inside the skill boundary.

---

## 5 — Gotchas & Sharp Edges

### 5.1 Duplicate tool names silently lose

`server.ts:26-29`:

```ts
if (toolMap.has(t.tool.name)) {
  log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
  continue;
}
```

It logs to stderr and continues — **the duplicate is dropped, no exception**. If our `taskflow.ts` ships `add_reaction` (collision with `core.ts`), the second registration is silently lost and the first wins. Use unambiguous names (`taskflow_add_reaction`, not `add_reaction`).

### 5.2 The `agents.ts` "admin-only" comment is misleading

`agents.ts:10` says:

> create_agent is admin-only. Non-admin containers never see this tool (see mcp-tools/index.ts).

But `index.ts` does NOT do per-container filtering — it imports every tool unconditionally. The actual permission check happens **host-side** in delivery (after the agent has already called the tool and it has emitted a `messages_out` row). That means:

- Every container sees `create_agent` in its tool list.
- Calling it always writes to `messages_out`.
- The host validates and may reject.

**For TaskFlow:** if a tool like `provision_taskflow_board` requires admin, follow the same pattern — register unconditionally, validate at the host on receipt. Don't try to filter at registration time; v2 doesn't support it.

### 5.3 No Zod despite `zod` being in `package.json`

`container/agent-runner/package.json` lists `zod: ^4.0.0` but `git grep -l "zod" remotes/upstream/v2 -- 'container/agent-runner/src/mcp-tools/*'` returns nothing. Zod is used elsewhere (likely providers); MCP tools use raw JSON Schema. Don't introduce Zod just to "match types" — keep tool schemas as JSON-Schema literals.

### 5.4 Handler signature: `Record<string, unknown>`, not generics

`types.ts:5` types `handler` as `(args: Record<string, unknown>) => Promise<CallToolResult>`. There's no per-tool typed args. Each handler casts (`args.title as string`), checks (`if (!title) return err(...)`), and proceeds. No tooling validates that the cast matches `inputSchema`. **Lint pattern:** every required field in `inputSchema` should have a matching `if (!field) return err(...)` line at handler top.

### 5.5 Bun-native MCP server, not Node

The MCP server is launched as `bun run mcp-tools/index.ts` (`agent-runner/src/index.ts:79`). It runs in **the bun runtime**, which has its own quirks:

- `bun:sqlite` is the DB driver inside MCP tools (NOT `better-sqlite3`).
- `.get()` returns `null` not `undefined` for missing rows — see memory feedback `feedback_get_returns_null_in_bun_sqlite.md`.
- Regex `.source` escapes non-ASCII as `\uXXXX` — see `feedback_bun_regex_source_escapes_unicode.md`.

Our v1 TaskFlow engine uses `better-sqlite3` (`Database` from `'better-sqlite3'`). For v2, the engine MUST switch to `bun:sqlite`'s `Database`. The API surface is similar but the import line and the `null` vs `undefined` semantics differ.

### 5.6 The MCP server cannot write to `inbound.db`

`scheduling.ts:1-7` is explicit:

> With the two-DB split, the container cannot write to inbound.db (host-owned). Scheduling operations are sent as system actions via messages_out — the host reads them during delivery and applies the changes to inbound.db.

This means TaskFlow **mutations that need to be visible to the host** (e.g. anything touching the central `messages_in`/scheduled-task tables) must go via `writeMessageOut({ kind: 'system', content: JSON.stringify({ action: 'taskflow_…', /* ... */ }) })` — the same pattern `cancelTask` / `pauseTask` / `resumeTask` use. The host then needs a delivery-side handler that interprets `action: 'taskflow_*'` and applies the mutation host-side.

**For a per-board taskflow.db owned by the container alone**, this isn't needed — the container is the only writer and reads happen container-side. But ANY cross-database join (e.g. "list all tasks across boards") requires the host to be involved.

### 5.7 No tool versioning or capability negotiation

`server.ts:36` hard-codes `version: '2.0.0'`. There's no per-tool versioning, no capability flag, no feature detection. If the agent calls a tool the server doesn't have, it gets `Unknown tool: <name>` (`server.ts:46`). For TaskFlow this is fine — the agent only knows about tools that appear in `ListTools`.

### 5.8 The barrel runs `startMcpServer()` at import time

If anything in our `taskflow.ts` throws synchronously at module evaluation (bad import, missing module), the barrel import propagates the error and the MCP server never starts. The agent then has zero `mcp__nanoclaw__*` tools and fails opaquely. **Defensive practice:** put DB-init / migration logic inside `getTaskflowDb()` (lazy), NOT at module top-level. Mirrors `db/connection.ts`'s lazy-init pattern.

---

## 6 — Implementation Checklist for `skill/taskflow-v2`

In skill-only terms (everything goes under `.claude/skills/add-taskflow/`):

- [ ] `add/container/agent-runner/src/mcp-tools/taskflow.ts` — N `McpToolDefinition` exports + one `registerTools([...])` at file bottom.
- [ ] `add/container/agent-runner/src/mcp-tools/taskflow.instructions.md` — agent-facing docs; auto-mounted by `claude-md-compose.ts`.
- [ ] `modify/container/agent-runner/src/mcp-tools/index.ts.intent.md` — describe the single-line addition: `import './taskflow.js';` after the existing five.
- [ ] `add/container/agent-runner/src/taskflow/db.ts` — `getTaskflowDb()` lazy singleton via `bun:sqlite`.
- [ ] `add/container/agent-runner/src/taskflow/schema.ts` — `CREATE TABLE` statements + migrations (port from `src/taskflow-db.ts`'s `TASKFLOW_SCHEMA` const at line 17).
- [ ] `add/container/agent-runner/src/taskflow/{tasks,boards,projects}.ts` — engine functions; ports of v1's `src/taskflow-db.ts` exports.
- [ ] `tests/taskflow-tools.test.ts` — handler-direct unit tests + DB-state assertions. NO MCP server boot.
- [ ] **Do NOT touch** `mcp-tools/server.ts`, `mcp-tools/types.ts` — purely upstream-owned.

---

## 7 — Source Citations (one-line summary)

| File | Lines | What it tells you |
|---|---|---|
| `container/agent-runner/src/mcp-tools/server.ts` | 1-54 | The full registration pattern. `allTools`/`toolMap` private; `registerTools()` exported; `startMcpServer()` boots stdio MCP. |
| `container/agent-runner/src/mcp-tools/index.ts` | 1-22 | Side-effect barrel. To add tools: append one `import './x.js';` line. |
| `container/agent-runner/src/mcp-tools/types.ts` | 1-6 | `McpToolDefinition = { tool: Tool, handler: (args) => Promise<CallToolResult> }`. JSON Schema, not Zod. |
| `container/agent-runner/src/mcp-tools/core.ts` | 98-132, 262 | Canonical tool definition shape + the `registerTools([...])` call at file bottom. |
| `container/agent-runner/src/mcp-tools/scheduling.ts` | 1-7, 35-98, 299 | Pattern for tools that must reach the host (write to `messages_out` with `kind: 'system'`). |
| `container/agent-runner/src/mcp-tools/agents.ts` | 10 | Misleading "admin-only" comment — actual filter is host-side, not registration-side. |
| `container/agent-runner/src/index.ts` | 71-91 | MCP server launched as `bun run mcp-tools/index.ts` child process; passed to SDK as `mcpServers.nanoclaw`. |
| `container/agent-runner/src/providers/claude.ts` | 46, 282 | Allowlist `'mcp__nanoclaw__*'` is wildcard — new tools auto-allowed. |
| `container/agent-runner/src/db/connection.ts` | 11-18, 31-37 | DB-singleton lazy-init pattern to mirror in `taskflow/db.ts`; cross-mount `journal_mode=DELETE` caveat. |
| `src/claude-md-compose.ts` | 79-91 | `<name>.instructions.md` next to a tool file is auto-symlinked into composed CLAUDE.md — zero registration needed. |
| `container/agent-runner/package.json` | — | Confirms `@modelcontextprotocol/sdk ^1.12.1` + `bun test` runner; `zod` declared but unused in `mcp-tools/`. |
| `container/agent-runner/src/integration.test.ts` | 1-50 | The closest thing to MCP testing in v2 — it tests poll-loop + DB plumbing via `MockProvider`, not the MCP server. Pattern to follow: assert DB state, not protocol messages. |
