# Intent: container/agent-runner/src/ipc-mcp-stdio.ts

## What Changed
1. Import the new `memory-client.ts` module.
2. Read four memory-related env vars near the top of the file.
3. Lazy-initialize a singleton `MemoryAudit` SQLite sidecar at `/workspace/group/memory/memory.db`. The path matters: containers run with `--rm`, so any sidecar path NOT inside an existing host-mounted directory is wiped every turn. `/workspace/group` is the per-group host mount that already persists across restarts, so the audit DB lives in a `memory/` subdirectory under it.
4. Register four new MCP tools: `memory_store`, `memory_recall`, `memory_list`, `memory_forget`.

## Key Sections

### Imports (top of file, alongside other named imports)
```ts
import {
  MemoryAudit,
  buildMemoryNamespace,
  buildMemoryUserId,
  deleteMemoryById,
  generateMemoryId,
  searchMemory,
  storeMemory,
  type MemoryClientOptions,
} from './memory-client.js';
```

### Module-level config (after the embedding-config block already in the file)
```ts
const taskflowBoardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
const turnSenderJid = process.env.NANOCLAW_TURN_SENDER_JID ?? null;
const memoryEnabled = isTaskflowManaged && !!taskflowBoardId;
const memoryClientOptions: MemoryClientOptions = {
  serverUrl: process.env.NANOCLAW_MEMORY_SERVER_URL || undefined,
  authToken: process.env.NANOCLAW_MEMORY_SERVER_TOKEN || undefined,
};
const MAX_MEMORY_WRITES_PER_TURN = (() => {
  const raw = process.env.NANOCLAW_MEMORY_MAX_WRITES_PER_TURN;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5;
})();
// MUST be a path inside an existing host mount. /workspace/group is the
// per-group writable mount; /workspace/memory is NOT mounted and would
// be ephemeral under --rm.
const MEMORY_AUDIT_DB_PATH = '/workspace/group/memory/memory.db';
let memoryAuditInstance: MemoryAudit | null = null;
function getMemoryAudit(): MemoryAudit {
  if (!memoryAuditInstance) {
    memoryAuditInstance = new MemoryAudit(MEMORY_AUDIT_DB_PATH);
  }
  return memoryAuditInstance;
}
```

### Tool registrations
Insert all four `server.tool('memory_store', ...)`, `'memory_recall'`, `'memory_list'`, `'memory_forget'` blocks in a coherent group. Common pattern for ALL four:

1. Guard with `if (!memoryEnabled) return { isError: true, ... }` first.
2. Build `namespace = buildMemoryNamespace(taskflowBoardId!)` and `userId = buildMemoryUserId(taskflowBoardId!)` as needed.
3. Use the memory-client helpers (`storeMemory` / `searchMemory` / `deleteMemoryById`) — NEVER inline the HTTP shape.
4. On fail-soft (server unreachable, HTTP ≥400), return `isError: true` with explicit "fact NOT saved" / "no facts returned" wording so the model knows the operation didn't succeed.

#### memory_store
- Pre-flight write quota: `audit.countWritesInTurn(turnId)` against `MAX_MEMORY_WRITES_PER_TURN`.
- Generate id via `generateMemoryId()`.
- After server confirms success, call `audit.recordStore({memoryId, boardId, turnId, senderJid, text})`.

#### memory_recall
- Plain `searchMemory(query, boardId, limit ?? 5, options)`.
- Format response with "lower dist = closer match" hint.

#### memory_list
- Reads from the local audit DB only — `audit.listOwnedForBoard(taskflowBoardId!, limit ?? 20)`.
- DO NOT enumerate the shared backend (multi-tenant; would surface other tenants' data).

#### memory_forget
- Gate the DELETE on `audit.isOwned(memoryId, boardId)` BEFORE calling `deleteMemoryById`. This is the security boundary — v0.13.2's DELETE has no server-side scope filter.
- After successful DELETE, call `audit.removeOwned(memoryId)`.
- DO NOT use a GET-then-DELETE pattern (TOCTOU). The local sidecar is the source of truth for ownership.

## Invariants (must-keep)
- The existing tools (`send_message`, `schedule_task`, `list_tasks`, etc.) MUST be left untouched.
- All four memory tools MUST gate on `memoryEnabled` first — never reach the audit DB or HTTP layer for non-TaskFlow groups.
- Fail-soft network errors MUST set `isError: true` so the model distinguishes "stored" from "skipped".
- The `getMemoryAudit()` singleton must be lazy — non-TaskFlow groups should never instantiate it (no SQLite file creation on those workspaces).
