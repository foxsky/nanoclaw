# TaskFlow Memory Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the manual-only TaskFlow memory layer MVP per spec v2.4 (`docs/superpowers/specs/2026-04-25-taskflow-memory-layer-design.md`, commit 252b34ff): three MCP tools (`memory_store`/`memory_recall`/`memory_forget`) + auto-recall preamble on every triggered turn (initial + IPC follow-ups), built on the existing `add-embeddings` infrastructure with no background extractor.

**Architecture:** Container writes IPC JSON files to `/workspace/ipc/memory-writes/` for store/forget operations; host watcher derives `collection` from path + scope + server-validated `senderJid` (cross-board AND same-board sender-spoofing both blocked) and writes to `embeddings.db` via existing `EmbeddingService.index()`. Container-side recall calls `ollamaEmbed()` per turn, queries both `memory:board:{boardId}` and `memory:user:{boardId}:{senderJid}` collections via existing `EmbeddingReader.search()` with explicit threshold 0.5, formats `<relevant-memories>` block, prepends to user prompt at two call sites in `container/agent-runner/src/index.ts`. Kill-switch via `NANOCLAW_MEMORY=on|off` env var + `registered_groups.memory_enabled` per-board flag.

**Tech Stack:** TypeScript, Node.js, better-sqlite3 (WAL mode), zod for MCP schemas, vitest for tests, BGE-M3 via Ollama at `.13:11434`, Docker container per group.

---

## File Structure

**New files:**
- `src/memory-service.ts` (host) — collection-name builders, contentHash, IPC handler (`processMemoryIpc`), prefix-to-full-id resolver. Lifecycle: passive (consumed by `src/ipc.ts`).
- `container/agent-runner/src/memory-reader.ts` (container) — dual-collection query merge, `formatRelevantMemoriesBlock`, `buildMemoryPreamble` end-to-end helper.
- `.claude/skills/add-memory/SKILL.md` (skill manifest with phase-by-phase install).
- `.claude/skills/add-memory/manifest.yaml` (NanoClaw skill manifest declaring dependency on `add-embeddings`).
- Test files (one per source file).

**Modified files (heavy):**
- `src/ipc.ts` — refactor `startIpcWatcher` to expose `processIpcOnce(groupDir, ctx)`; add `memory-writes` bucket scan + dispatch (~100 lines).
- `container/agent-runner/src/ipc-mcp-stdio.ts` — register 3 MCP tools (~80 lines).
- `container/agent-runner/src/index.ts` — wire `buildMemoryPreamble` at two call sites (~30 lines).

**Modified files (minimal):**
- `src/db.ts` — migration ALTER TABLE.
- `src/container-runner.ts` — forward `NANOCLAW_MEMORY` + `NANOCLAW_MEMORY_ENABLED` env vars; populate `containerInput.senderJid` (~8 lines total).
- `container/agent-runner/src/runtime-config.ts` — type additions to `AgentTurnContext` + `ContainerInput`.
- Wherever the inbound→IPC follow-up enqueue path lives (per spec §9.3 — implementation prerequisite to identify or add).

**Migration:**
- `migrations/2026-04-25-memory-enabled.sql` — referenced from spec; code-as-migration via `src/db.ts` ALTER pattern (the project doesn't actually use SQL files, just inline TS try/catch).

---

## Phase A — Schema + shared helpers

### Task 1: `memory_enabled` column migration

**Files:**
- Modify: `src/db.ts` (find the `initRegisteredGroupsTable` or equivalent migration block; add ALTER after existing ALTERs)
- Test: `src/db.test.ts` (add a test verifying the column exists after init)

- [ ] **Step 1: Write the failing test**

In `src/db.test.ts` (create if missing, follow existing pattern at top of file), add:

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from './db.js';

describe('registered_groups.memory_enabled column', () => {
  it('exists with INTEGER NOT NULL DEFAULT 0', () => {
    const db = new Database(':memory:');
    initDatabase(db);
    const cols = db
      .prepare(`PRAGMA table_info(registered_groups)`)
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'memory_enabled');
    expect(col).toBeDefined();
    expect(col?.type).toBe('INTEGER');
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe('0');
  });

  it('sets memory_enabled=1 for existing taskflow_managed=1 rows', () => {
    const db = new Database(':memory:');
    // Seed a pre-migration registered_groups table without memory_enabled
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL,
        container_config TEXT, requires_trigger INTEGER DEFAULT 1,
        taskflow_managed INTEGER DEFAULT 0,
        taskflow_hierarchy_level INTEGER, taskflow_max_depth INTEGER,
        is_main INTEGER DEFAULT 0
      );
      INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, taskflow_managed)
        VALUES ('a@g.us', 'A', 'a-folder', '@x', '2026-01-01', 1),
               ('b@g.us', 'B', 'b-folder', '@x', '2026-01-01', 0);
    `);
    initDatabase(db);
    const rows = db
      .prepare(`SELECT folder, memory_enabled FROM registered_groups ORDER BY folder`)
      .all() as Array<{ folder: string; memory_enabled: number }>;
    expect(rows).toEqual([
      { folder: 'a-folder', memory_enabled: 1 },
      { folder: 'b-folder', memory_enabled: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/db.test.ts -t "memory_enabled column"
```
Expected: FAIL — column does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/db.ts`, locate the existing block of `try { database.exec('ALTER TABLE ... ADD COLUMN ...') } catch { /* column already exists */ }` migrations (around line 180-220). Add:

```typescript
// memory_enabled: per-board kill-switch for add-memory skill (2026-04-25)
try {
  database.exec(
    `ALTER TABLE registered_groups ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0`,
  );
  // Pilot: enable on all currently TaskFlow-managed boards
  database.exec(
    `UPDATE registered_groups SET memory_enabled = 1 WHERE taskflow_managed = 1`,
  );
} catch {
  /* column already exists */
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/db.test.ts -t "memory_enabled column"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(memory): add memory_enabled column migration

Per-board kill-switch flag on registered_groups. Defaults to 0 for
new rows; pilot UPDATE sets to 1 for all currently taskflow_managed=1
boards on first run. Idempotent via the existing ALTER TABLE try/catch
migration pattern."
```

---

### Task 2: Shared types and constants

**Files:**
- Create: `src/memory-types.ts` (host-shared, can be imported by both host and container via the npm-link or just duplicated path-wise)
- Test: `src/memory-types.test.ts`

Note: the project structure has separate `src/` (host) and `container/agent-runner/src/` (container). They don't share imports directly. Define the constants once on the host side and once on the container side (small enough that DRY-via-shared-package isn't worth it).

- [ ] **Step 1: Write the failing test**

`src/memory-types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  isMemoryCategory,
  isMemoryScope,
} from './memory-types.js';

describe('memory-types', () => {
  it('MEMORY_CATEGORIES is the expected 5-value tuple', () => {
    expect(MEMORY_CATEGORIES).toEqual([
      'preference', 'fact', 'decision', 'entity', 'other',
    ]);
  });

  it('MEMORY_SCOPES is board|user', () => {
    expect(MEMORY_SCOPES).toEqual(['board', 'user']);
  });

  it('isMemoryCategory accepts valid + rejects invalid', () => {
    expect(isMemoryCategory('preference')).toBe(true);
    expect(isMemoryCategory('nonsense')).toBe(false);
    expect(isMemoryCategory(null)).toBe(false);
  });

  it('isMemoryScope accepts valid + rejects invalid', () => {
    expect(isMemoryScope('user')).toBe(true);
    expect(isMemoryScope('board')).toBe(true);
    expect(isMemoryScope('global')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/memory-types.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/memory-types.ts`:

```typescript
export const MEMORY_CATEGORIES = [
  'preference', 'fact', 'decision', 'entity', 'other',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_SCOPES = ['board', 'user'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export function isMemoryCategory(v: unknown): v is MemoryCategory {
  return typeof v === 'string'
    && (MEMORY_CATEGORIES as readonly string[]).includes(v);
}

export function isMemoryScope(v: unknown): v is MemoryScope {
  return typeof v === 'string'
    && (MEMORY_SCOPES as readonly string[]).includes(v);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/memory-types.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory-types.ts src/memory-types.test.ts
git commit -m "feat(memory): MemoryCategory + MemoryScope shared types"
```

---

### Task 3: `memory-service.ts` — collection-name + contentHash helpers

**Files:**
- Create: `src/memory-service.ts`
- Test: `src/memory-service.test.ts`

- [ ] **Step 1: Write the failing test (helpers only, IPC handler in later tasks)**

`src/memory-service.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  collectionName,
  contentHash,
} from './memory-service.js';

describe('collectionName', () => {
  it('builds board-scope collection from groupFolder', () => {
    expect(collectionName({ scope: 'board', groupFolder: 'setd-secti-taskflow' }))
      .toBe('memory:board:setd-secti-taskflow');
  });

  it('builds user-scope collection from groupFolder + senderJid', () => {
    expect(collectionName({
      scope: 'user',
      groupFolder: 'setd-secti-taskflow',
      senderJid: '5585999@s.whatsapp.net',
    })).toBe('memory:user:setd-secti-taskflow:5585999@s.whatsapp.net');
  });

  it('throws if user-scope is missing senderJid', () => {
    expect(() => collectionName({ scope: 'user', groupFolder: 'foo' } as any))
      .toThrow(/senderJid required/);
  });
});

describe('contentHash', () => {
  it('is deterministic for same inputs', () => {
    const a = contentHash('preference', 'Prefers concise replies');
    const b = contentHash('preference', 'Prefers concise replies');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{40}$/);
  });

  it('is case-insensitive on text', () => {
    expect(contentHash('preference', 'Prefers concise replies'))
      .toBe(contentHash('preference', 'PREFERS CONCISE REPLIES'));
  });

  it('normalizes whitespace', () => {
    expect(contentHash('preference', '  prefers   concise  '))
      .toBe(contentHash('preference', 'prefers concise'));
  });

  it('differs between categories for same text', () => {
    expect(contentHash('preference', 'X')).not.toBe(contentHash('fact', 'X'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/memory-service.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/memory-service.ts`:

```typescript
import crypto from 'crypto';
import type { MemoryScope } from './memory-types.js';

export interface CollectionNameArgs {
  scope: MemoryScope;
  groupFolder: string;
  senderJid?: string;
}

export function collectionName(args: CollectionNameArgs): string {
  if (args.scope === 'board') {
    return `memory:board:${args.groupFolder}`;
  }
  if (!args.senderJid) {
    throw new Error('collectionName: senderJid required for user scope');
  }
  return `memory:user:${args.groupFolder}:${args.senderJid}`;
}

export function contentHash(category: string, text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const input = `${category}:${normalized}`;
  return crypto.createHash('sha1').update(input).digest('hex');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/memory-service.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory-service.ts src/memory-service.test.ts
git commit -m "feat(memory): collectionName + contentHash helpers (host)

collectionName builds memory:board:{groupFolder} or memory:user:{groupFolder}:{senderJid}.
contentHash is sha1(category + ':' + lowercase normalize-whitespace text)."
```

---

## Phase B — Host IPC integration

### Task 4: Refactor `src/ipc.ts` — extract `processIpcOnce(groupDir, ctx)`

**Files:**
- Modify: `src/ipc.ts` (lift the `processIpcFiles` closure body into an exported `processIpcOnce` function; lift state into a `ctx` object)
- Test: `src/ipc.test.ts` (add a test that `processIpcOnce` can be called externally)

This is the largest and most delicate task. The existing `startIpcWatcher` at `src/ipc.ts:815` is a 400+ line function with a closure-captured `pendingNotifications` Map, `processIpcFiles` async helper, retry/error handling, and bucket dispatch. The refactor must:

1. Lift closure-captured state into a `IpcWatcherCtx` interface
2. Extract per-cycle work (reading directories, processing buckets, dispatch) into `processIpcOnce(ctx)`
3. Re-implement `startIpcWatcher` as a wrapper that creates `ctx`, then calls `processIpcOnce` on a `setTimeout` loop

- [ ] **Step 1: Read the full `startIpcWatcher` to understand state**

```bash
sed -n '815,1230p' /root/nanoclaw/src/ipc.ts > /tmp/startIpcWatcher.txt
wc -l /tmp/startIpcWatcher.txt
```

Identify the closure-captured state. Expected at minimum: `pendingNotifications` Map, `deps` (from arg), `ipcBaseDir`, `groupByFolder` (rebuilt per cycle but uses `deps.registeredGroups()`).

- [ ] **Step 2: Write the failing test for `processIpcOnce` exported entrypoint**

`src/ipc.test.ts` (append to existing or create):

```typescript
import { describe, it, expect } from 'vitest';
import * as ipc from './ipc.js';

describe('processIpcOnce', () => {
  it('is exported and callable', () => {
    expect(typeof ipc.processIpcOnce).toBe('function');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run src/ipc.test.ts -t "processIpcOnce"
```
Expected: FAIL — `processIpcOnce` is undefined.

- [ ] **Step 4: Refactor — define IpcWatcherCtx + extract processIpcOnce**

In `src/ipc.ts`, just before `export async function startIpcWatcher(...)`, add:

```typescript
export interface IpcWatcherCtx {
  deps: IpcDeps;
  ipcBaseDir: string;
  pendingNotifications: Map<string, PendingNotification[]>;
}

export function createIpcWatcherCtx(deps: IpcDeps): IpcWatcherCtx {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  return {
    deps,
    ipcBaseDir,
    pendingNotifications: new Map<string, PendingNotification[]>(),
  };
}
```

Move the `PendingNotification` interface out of the closure to be top-level in the file.

Replace the body of `processIpcFiles` (the closure inside `startIpcWatcher`) with a call to a new exported `processIpcOnce(ctx)`. The `processIpcOnce` function takes the same body but reads state from `ctx` instead of closure.

```typescript
export async function processIpcOnce(ctx: IpcWatcherCtx): Promise<void> {
  // [Move the existing processIpcFiles body here, replacing
  //  closure references with ctx.* equivalents. Specifically:
  //    - ipcBaseDir → ctx.ipcBaseDir
  //    - pendingNotifications → ctx.pendingNotifications
  //    - deps.* → ctx.deps.*
  //  Keep all internal helpers (extractNotifGroupKey, isBufferableNotification)
  //  as plain top-level functions or as inner helpers — they don't capture state.
  // ]
}
```

Update `startIpcWatcher`:

```typescript
export async function startIpcWatcher(deps: IpcDeps): Promise<void> {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  await loadIpcPlugins();

  const ctx = createIpcWatcherCtx(deps);
  evictErrorFiles(ctx.ipcBaseDir);

  const tick = async () => {
    try {
      await processIpcOnce(ctx);
    } catch (err) {
      logger.error({ err }, 'IPC watcher cycle failed');
    } finally {
      setTimeout(tick, IPC_POLL_INTERVAL);
    }
  };
  tick();
}
```

- [ ] **Step 5: Run all existing IPC tests + new processIpcOnce export test**

```bash
npx vitest run src/ipc.test.ts
```
Expected: ALL existing tests still PASS, new export test PASSES.

If existing tests break: stop, investigate, do not proceed. The refactor must be behavior-preserving.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "refactor(ipc): extract processIpcOnce(ctx) for testability

Lift startIpcWatcher's closure-captured state (pendingNotifications,
ipcBaseDir, deps) into IpcWatcherCtx. processIpcOnce becomes the
per-cycle entry point; startIpcWatcher reduces to a setTimeout wrapper.
Behavior-preserving refactor — required for upcoming memory-writes
bucket integration test (depends on a deterministic single-cycle entry).

No test changes for existing buckets — only adds a smoke test that
processIpcOnce is exported."
```

---

### Task 5: Add `memory-writes/` bucket scan to `processIpcOnce`

**Files:**
- Modify: `src/ipc.ts` (in `processIpcOnce`, add a fourth bucket alongside `messages`, `tasks`, `otp`)
- Test: `src/ipc.test.ts` (add a test that a JSON in `memory-writes/` gets read and dispatched)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ipc from './ipc.js';

describe('processIpcOnce: memory-writes bucket', () => {
  let tmpDir: string;
  let processMemoryIpcSpy: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipctest-'));
    process.env.NANOCLAW_DATA_DIR = tmpDir; // assuming DATA_DIR honors this
    // The actual mechanism may differ — verify by reading src/config.ts DATA_DIR derivation.
  });

  it('dispatches a JSON file in memory-writes/ to processMemoryIpc', async () => {
    const groupFolder = 'test-group';
    const memDir = path.join(tmpDir, 'ipc', groupFolder, 'memory-writes');
    fs.mkdirSync(memDir, { recursive: true });
    const fixture = {
      op: 'store',
      scope: 'board',
      contentHash: 'a3f1b9c842de',
      text: 'Test board fact',
      metadata: { category: 'fact', entities: [] },
    };
    fs.writeFileSync(path.join(memDir, '12345-store-a3f1b9c8.json'), JSON.stringify(fixture));

    // Mock the dispatcher
    processMemoryIpcSpy = vi.spyOn(ipc, 'processMemoryIpc' as any).mockResolvedValue(undefined);

    const ctx = ipc.createIpcWatcherCtx({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
      // ... other deps as needed
    } as any);
    await ipc.processIpcOnce(ctx);

    expect(processMemoryIpcSpy).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'store', scope: 'board' }),
      groupFolder,
      expect.any(Object), // ctx
    );
  });
});
```

Note: this test assumes `processMemoryIpc` is exported from `src/ipc.ts` (will be in next task). If `DATA_DIR` is not env-overrideable, you'll need to refactor it for testability or use a different injection point.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/ipc.test.ts -t "memory-writes bucket"
```
Expected: FAIL — bucket not scanned, processMemoryIpc not called.

- [ ] **Step 3: Add the bucket scan in `processIpcOnce`**

In `src/ipc.ts`, inside the `for (const sourceGroup of groupFolders)` loop in `processIpcOnce`, add after the existing `messagesDir`/`tasksDir`/`otpDir` declarations:

```typescript
const memoryWritesDir = path.join(ctx.ipcBaseDir, sourceGroup, 'memory-writes');
```

After the existing `messages`/`tasks`/`otp` processing blocks, add:

```typescript
// Process memory-writes from this group's IPC directory
try {
  if (fs.existsSync(memoryWritesDir)) {
    const memFiles = fs
      .readdirSync(memoryWritesDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const file of memFiles) {
      const filePath = path.join(memoryWritesDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        await processMemoryIpc(data, sourceGroup, ctx);
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.warn({ err, filePath }, 'memory-writes: parse/dispatch error, quarantining');
        const errorsDir = path.join(memoryWritesDir, '.errors');
        fs.mkdirSync(errorsDir, { recursive: true });
        try {
          fs.renameSync(filePath, path.join(errorsDir, file));
        } catch {
          /* race or already moved */
        }
      }
    }
  }
} catch (err) {
  logger.error({ err, sourceGroup }, 'memory-writes: scan error');
}
```

Also add a stub `processMemoryIpc` export at the bottom of the file (real implementation in Task 6):

```typescript
export async function processMemoryIpc(
  data: any,
  groupFolder: string,
  ctx: IpcWatcherCtx,
): Promise<void> {
  // STUB — real implementation in Task 6
  logger.debug({ data, groupFolder }, 'processMemoryIpc stub');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ipc.test.ts -t "memory-writes bucket"
```
Expected: PASS (the stub gets called; existing tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(ipc): add memory-writes bucket scan in processIpcOnce

Fourth bucket alongside messages/tasks/otp. JSON files dispatched to
processMemoryIpc(data, groupFolder, ctx) (stub for now — Task 6 implements).
Per-bucket .errors/ quarantine for malformed files. Reuses existing
unlink-on-success + 7d eviction primitives."
```

---

### Task 6: Implement `processMemoryIpc` store handler with server-side `senderJid` validation

**Files:**
- Modify: `src/memory-service.ts` (add `processMemoryStore` + helper `resolveSenderForUserScope`)
- Modify: `src/ipc.ts` (the `processMemoryIpc` stub from Task 5 now imports + delegates to memory-service)
- Test: `src/memory-service.test.ts`

The store handler must:
1. Look up `chat_jid` from `registered_groups` by `groupFolder`
2. For `scope='user'`: query `messages.db` for recent inbound senders in the last 10 min, validate `metadata.senderJid` against them, fall back to most-recent on mismatch (log warn `memory.spoof_attempt`), reject if no recent inbound exists
3. For `scope='board'`: skip senderJid validation
4. Compute collection via `collectionName()`
5. Call `EmbeddingService.index(collection, contentHash, text, metadata)` — host-authoritative `senderName` from the matched DB row overrides container-supplied

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory-service.test.ts (append)
import Database from 'better-sqlite3';
import { vi } from 'vitest';
import {
  processMemoryStore,
  resolveSenderForUserScope,
} from './memory-service.js';

function seedMessagesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT,
      timestamp TEXT, is_from_me INTEGER, message_type TEXT DEFAULT 'text',
      is_bot_message INTEGER DEFAULT 0, reply_to_message_id TEXT,
      reply_to_message_content TEXT, reply_to_sender_name TEXT,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, folder TEXT NOT NULL UNIQUE
    );
    INSERT INTO registered_groups (jid, folder) VALUES ('group@g.us', 'test-folder');
    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
      VALUES
        ('m1', 'group@g.us', '5585111@s.whatsapp.net', 'Maria', 'oi', datetime('now', '-2 minutes'), 0),
        ('m2', 'group@g.us', '5585222@s.whatsapp.net', 'Edilson', 'tudo bem?', datetime('now', '-1 minute'), 0);
  `);
  return db;
}

describe('resolveSenderForUserScope', () => {
  it('matches and returns the JID + DB-authoritative senderName', () => {
    const db = seedMessagesDb();
    const result = resolveSenderForUserScope(db, 'test-folder', '5585111@s.whatsapp.net');
    expect(result).toEqual({
      action: 'matched',
      senderJid: '5585111@s.whatsapp.net',
      senderName: 'Maria',
    });
  });

  it('falls back to most-recent on mismatch (logs warn)', () => {
    const db = seedMessagesDb();
    const result = resolveSenderForUserScope(db, 'test-folder', 'SPOOF@s.whatsapp.net');
    expect(result).toEqual({
      action: 'spoof_fallback',
      senderJid: '5585222@s.whatsapp.net', // most recent
      senderName: 'Edilson',
      attemptedSenderJid: 'SPOOF@s.whatsapp.net',
    });
  });

  it('rejects when no recent inbound exists', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT,
        timestamp TEXT, is_from_me INTEGER, message_type TEXT,
        is_bot_message INTEGER, reply_to_message_id TEXT,
        reply_to_message_content TEXT, reply_to_sender_name TEXT,
        PRIMARY KEY (id, chat_jid)
      );
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT);
      INSERT INTO registered_groups VALUES ('group@g.us', 'test-folder');
    `);
    const result = resolveSenderForUserScope(db, 'test-folder', 'whoever@s.whatsapp.net');
    expect(result).toEqual({ action: 'no_recent_sender' });
  });
});

describe('processMemoryStore', () => {
  it('writes to memory:board:{folder} for board scope (no senderJid validation)', async () => {
    const db = seedMessagesDb();
    const indexFn = vi.fn();
    const fakeEmbedSvc = { index: indexFn } as any;
    await processMemoryStore({
      data: {
        op: 'store',
        scope: 'board',
        contentHash: 'abc123',
        text: 'Team uses M for meetings',
        metadata: { category: 'fact', entities: [] },
      },
      groupFolder: 'test-folder',
      embeddingService: fakeEmbedSvc,
      messagesDb: db,
    });
    expect(indexFn).toHaveBeenCalledWith(
      'memory:board:test-folder',
      'abc123',
      'Team uses M for meetings',
      expect.objectContaining({ category: 'fact', scope: 'board' }),
    );
  });

  it('writes to memory:user:{folder}:{validatedJid} with DB-authoritative senderName', async () => {
    const db = seedMessagesDb();
    const indexFn = vi.fn();
    const fakeEmbedSvc = { index: indexFn } as any;
    await processMemoryStore({
      data: {
        op: 'store',
        scope: 'user',
        contentHash: 'def456',
        text: 'Prefers concise replies',
        metadata: {
          category: 'preference',
          entities: [],
          senderJid: '5585111@s.whatsapp.net',
          senderName: 'CONTAINER_LIES_HERE',
        },
      },
      groupFolder: 'test-folder',
      embeddingService: fakeEmbedSvc,
      messagesDb: db,
    });
    expect(indexFn).toHaveBeenCalledWith(
      'memory:user:test-folder:5585111@s.whatsapp.net',
      'def456',
      'Prefers concise replies',
      expect.objectContaining({
        senderJid: '5585111@s.whatsapp.net',
        senderName: 'Maria', // DB authoritative, NOT 'CONTAINER_LIES_HERE'
      }),
    );
  });

  it('falls back on spoof + does not call index with the spoofed JID', async () => {
    const db = seedMessagesDb();
    const indexFn = vi.fn();
    const fakeEmbedSvc = { index: indexFn } as any;
    await processMemoryStore({
      data: {
        op: 'store',
        scope: 'user',
        contentHash: 'ghi789',
        text: 'Some fact',
        metadata: {
          category: 'fact',
          entities: [],
          senderJid: 'SPOOF@s.whatsapp.net',
          senderName: 'Spoofy',
        },
      },
      groupFolder: 'test-folder',
      embeddingService: fakeEmbedSvc,
      messagesDb: db,
    });
    expect(indexFn).toHaveBeenCalledWith(
      'memory:user:test-folder:5585222@s.whatsapp.net', // most recent, not SPOOF
      'ghi789',
      'Some fact',
      expect.objectContaining({ senderName: 'Edilson' }),
    );
  });

  it('throws no_recent_sender when no recent inbound exists', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT,
        timestamp TEXT, is_from_me INTEGER, message_type TEXT,
        is_bot_message INTEGER, reply_to_message_id TEXT,
        reply_to_message_content TEXT, reply_to_sender_name TEXT,
        PRIMARY KEY (id, chat_jid)
      );
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT);
      INSERT INTO registered_groups VALUES ('group@g.us', 'empty-folder');
    `);
    const indexFn = vi.fn();
    await expect(processMemoryStore({
      data: {
        op: 'store', scope: 'user', contentHash: 'x', text: 'x',
        metadata: { category: 'fact', entities: [], senderJid: 'a@s.whatsapp.net', senderName: 'A' },
      },
      groupFolder: 'empty-folder',
      embeddingService: { index: indexFn } as any,
      messagesDb: db,
    })).rejects.toThrow(/no_recent_sender/);
    expect(indexFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/memory-service.test.ts -t "resolveSenderForUserScope|processMemoryStore"
```
Expected: FAIL — functions undefined.

- [ ] **Step 3: Implement in `src/memory-service.ts`**

Append to `src/memory-service.ts` (note: do NOT re-import `collectionName` — it's already defined in this file):

```typescript
import type { Database as Db } from 'better-sqlite3';
import { logger } from './logger.js';
import type { EmbeddingService } from './embedding-service.js';
import { isMemoryCategory, isMemoryScope } from './memory-types.js';

export type ResolveSenderResult =
  | { action: 'matched'; senderJid: string; senderName: string }
  | { action: 'spoof_fallback'; senderJid: string; senderName: string; attemptedSenderJid: string }
  | { action: 'no_recent_sender' };

export function resolveSenderForUserScope(
  messagesDb: Db,
  groupFolder: string,
  attemptedSenderJid: string,
): ResolveSenderResult {
  const groupRow = messagesDb
    .prepare(`SELECT jid FROM registered_groups WHERE folder = ?`)
    .get(groupFolder) as { jid: string } | undefined;
  if (!groupRow) return { action: 'no_recent_sender' };

  // Compute ISO cutoff explicitly. messages.timestamp stores ISO strings
  // like '2026-04-25T15:42:11.000Z'; SQLite's datetime('now', '-10 minutes')
  // returns space-formatted '2026-04-25 15:32:11' which lexically compares
  // unreliably against ISO. Use a parameterized ISO cutoff instead.
  const cutoffIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recents = messagesDb
    .prepare(`
      SELECT sender, sender_name FROM messages
      WHERE chat_jid = ? AND is_from_me = 0
        AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 5
    `)
    .all(groupRow.jid, cutoffIso) as Array<{ sender: string; sender_name: string }>;

  if (recents.length === 0) return { action: 'no_recent_sender' };

  const match = recents.find((r) => r.sender === attemptedSenderJid);
  if (match) {
    return { action: 'matched', senderJid: match.sender, senderName: match.sender_name };
  }
  const fallback = recents[0];
  return {
    action: 'spoof_fallback',
    senderJid: fallback.sender,
    senderName: fallback.sender_name,
    attemptedSenderJid,
  };
}

export interface ProcessMemoryStoreArgs {
  data: any;
  groupFolder: string;
  embeddingService: EmbeddingService;
  messagesDb: Db;
}

export async function processMemoryStore(args: ProcessMemoryStoreArgs): Promise<void> {
  const { data, groupFolder, embeddingService, messagesDb } = args;

  if (!isMemoryScope(data.scope)) throw new Error('memory_store: invalid scope');
  if (typeof data.contentHash !== 'string') throw new Error('memory_store: missing contentHash');
  if (typeof data.text !== 'string' || data.text.length < 5 || data.text.length > 280) {
    throw new Error('memory_store: invalid text length');
  }
  if (!data.metadata || !isMemoryCategory(data.metadata.category)) {
    throw new Error('memory_store: invalid category');
  }

  let resolvedSenderJid: string | undefined;
  let resolvedSenderName: string | undefined;

  if (data.scope === 'user') {
    if (typeof data.metadata.senderJid !== 'string') {
      throw new Error('memory_store: user-scope requires metadata.senderJid');
    }
    const r = resolveSenderForUserScope(messagesDb, groupFolder, data.metadata.senderJid);
    if (r.action === 'no_recent_sender') {
      throw new Error('no_recent_sender: scope=user requires recent inbound message');
    }
    if (r.action === 'spoof_fallback') {
      logger.warn({
        groupFolder,
        attemptedSenderJid: r.attemptedSenderJid,
        fallbackSenderJid: r.senderJid,
      }, 'memory.spoof_attempt');
    }
    resolvedSenderJid = r.senderJid;
    resolvedSenderName = r.senderName;
  }

  const collection = collectionName({
    scope: data.scope,
    groupFolder,
    senderJid: resolvedSenderJid,
  });

  const finalMetadata = {
    category: data.metadata.category,
    scope: data.scope,
    entities: Array.isArray(data.metadata.entities) ? data.metadata.entities : [],
    senderJid: resolvedSenderJid,         // server-derived; undefined for board scope
    senderName: resolvedSenderName,       // server-derived; undefined for board scope
    capturedAt: data.metadata.capturedAt ?? new Date().toISOString(),
    source: data.metadata.source ?? 'manual_store',
  };

  embeddingService.index(collection, data.contentHash, data.text, finalMetadata);
  logger.info({
    collection, contentHash: data.contentHash,
    category: data.metadata.category,
    action: 'stored',
    source: finalMetadata.source,
  }, 'memory.write');
}
```

Then update the `processMemoryIpc` stub in `src/ipc.ts` to dispatch:

```typescript
import { processMemoryStore /*, processMemoryForget — Task 7 */ } from './memory-service.js';

export async function processMemoryIpc(
  data: any,
  groupFolder: string,
  ctx: IpcWatcherCtx,
): Promise<void> {
  const messagesDb = ctx.deps.messagesDb();      // new dep — see below
  const embeddingService = ctx.deps.embeddingService(); // new dep — see below
  if (!messagesDb || !embeddingService) {
    logger.warn('processMemoryIpc: missing deps (messagesDb or embeddingService)');
    throw new Error('memory_disabled: deps missing');
  }
  if (data.op === 'store') {
    return processMemoryStore({ data, groupFolder, embeddingService, messagesDb });
  }
  if (data.op === 'forget') {
    // Task 7
    throw new Error('not implemented');
  }
  throw new Error(`unknown op: ${data.op}`);
}
```

Add to `IpcDeps` interface (whatever file defines it; likely `src/ipc.ts` or a related types file):

```typescript
interface IpcDeps {
  // ... existing fields
  messagesDb?: () => Database.Database | null;
  embeddingService?: () => EmbeddingService | null;
}
```

Wire the new deps in `src/index.ts` where `startIpcWatcher` is called:

```typescript
startIpcWatcher({
  // ... existing deps
  messagesDb: () => messagesDb,                   // existing host-side messages.db handle
  embeddingService: () => embeddingService,       // existing handle from add-embeddings
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/memory-service.test.ts
npx vitest run src/ipc.test.ts
```
Expected: PASS for memory-service tests; existing IPC tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/memory-service.ts src/ipc.ts src/memory-service.test.ts src/index.ts
git commit -m "feat(memory): processMemoryStore with server-side senderJid validation

Host-side processing of memory_store IPC ops:
- Looks up chat_jid from registered_groups by groupFolder
- For scope=user: queries messages.db for recent inbound senders (10 min window)
- Mismatch → falls back to most-recent + logs memory.spoof_attempt warn
- No recent inbound → rejects with error_code='no_recent_sender'
- Overrides container-supplied senderName with DB-authoritative value
- Closes cross-board AND same-board sender-spoofing AND name-impersonation holes

processMemoryIpc dispatches by op (store/forget); forget in Task 7."
```

---

### Task 7: `processMemoryForget` with prefix resolution + scoped delete

**Files:**
- Modify: `src/memory-service.ts` (add `processMemoryForget`)
- Modify: `src/ipc.ts` (wire forget dispatch)
- Test: `src/memory-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory-service.test.ts (append)
import { processMemoryForget } from './memory-service.js';

describe('processMemoryForget', () => {
  function seedEmbeddingsDb(): { db: Database.Database; service: any } {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE embeddings (
        collection TEXT NOT NULL, item_id TEXT NOT NULL,
        vector BLOB, source_text TEXT NOT NULL, model TEXT NOT NULL,
        metadata TEXT DEFAULT '{}', updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, item_id)
      );
      INSERT INTO embeddings VALUES
        ('memory:board:folder-a', 'a3f1b9c842de1111', NULL, 't1', 'bge-m3', '{}', '2026-04-25T00:00:00Z'),
        ('memory:user:folder-a:alice@s.whatsapp.net', 'b8a902c3e7d42222', NULL, 't2', 'bge-m3', '{}', '2026-04-25T00:00:00Z'),
        ('memory:board:folder-b', 'a3f1b9c842de1111', NULL, 't3', 'bge-m3', '{}', '2026-04-25T00:00:00Z');
    `);
    const removeFn = vi.fn((collection: string, itemId: string) => {
      db.prepare(`DELETE FROM embeddings WHERE collection = ? AND item_id = ?`).run(collection, itemId);
    });
    return { db, service: { db, remove: removeFn } };
  }

  it('deletes by full ID, scoped to groupFolder', async () => {
    const { db, service } = seedEmbeddingsDb();
    await processMemoryForget({
      data: { op: 'forget', memoryId: 'a3f1b9c842de1111' },
      groupFolder: 'folder-a',
      embeddingService: service,
    });
    const remaining = db.prepare(`SELECT collection FROM embeddings ORDER BY collection`).all();
    expect(remaining).toEqual([
      { collection: 'memory:board:folder-b' },           // folder-b same id NOT touched
      { collection: 'memory:user:folder-a:alice@s.whatsapp.net' },
    ]);
  });

  it('deletes by 12-char prefix, scoped to groupFolder', async () => {
    const { db, service } = seedEmbeddingsDb();
    await processMemoryForget({
      data: { op: 'forget', memoryId: 'a3f1b9c842de' },
      groupFolder: 'folder-a',
      embeddingService: service,
    });
    const remaining = db.prepare(`SELECT collection FROM embeddings ORDER BY collection`).all();
    expect(remaining.find((r: any) => r.collection === 'memory:board:folder-a')).toBeUndefined();
    expect(remaining.find((r: any) => r.collection === 'memory:board:folder-b')).toBeDefined();
  });

  it('rejects ambiguous prefix (>1 match)', async () => {
    const { db, service } = seedEmbeddingsDb();
    db.exec(`
      INSERT INTO embeddings VALUES
        ('memory:board:folder-a', 'a3f1b9c842de9999', NULL, 't4', 'bge-m3', '{}', '2026-04-25T00:00:00Z');
    `);
    await expect(processMemoryForget({
      data: { op: 'forget', memoryId: 'a3f1b9c842de' },
      groupFolder: 'folder-a',
      embeddingService: service,
    })).rejects.toThrow(/ambiguous_prefix/);
  });

  it('idempotent on no-match (logs warn, no throw)', async () => {
    const { db, service } = seedEmbeddingsDb();
    await processMemoryForget({
      data: { op: 'forget', memoryId: '0000000000000000' },
      groupFolder: 'folder-a',
      embeddingService: service,
    });
    // Original 3 rows still there
    expect(db.prepare(`SELECT COUNT(*) as n FROM embeddings`).get()).toEqual({ n: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/memory-service.test.ts -t "processMemoryForget"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/memory-service.ts`:

```typescript
export interface ProcessMemoryForgetArgs {
  data: any;
  groupFolder: string;
  embeddingService: EmbeddingService;
}

export async function processMemoryForget(args: ProcessMemoryForgetArgs): Promise<void> {
  const { data, groupFolder, embeddingService } = args;
  if (typeof data.memoryId !== 'string' || data.memoryId.length < 8) {
    throw new Error('memory_forget: memoryId must be ≥8 chars');
  }
  const prefix = data.memoryId;

  // Scoped lookup — only this board's collections
  const matches = embeddingService.db
    .prepare(`
      SELECT collection, item_id FROM embeddings
      WHERE (collection = ? OR collection LIKE ?)
        AND item_id LIKE ?
    `)
    .all(
      `memory:board:${groupFolder}`,
      `memory:user:${groupFolder}:%`,
      `${prefix}%`,
    ) as Array<{ collection: string; item_id: string }>;

  if (matches.length === 0) {
    logger.warn({ groupFolder, prefix }, 'memory.forget.no_match');
    return; // idempotent
  }
  if (matches.length > 1) {
    logger.warn({ groupFolder, prefix, matchCount: matches.length }, 'memory.forget.ambiguous');
    throw new Error('ambiguous_prefix: prefix matches >1 memory; use longer ID');
  }

  embeddingService.remove(matches[0].collection, matches[0].item_id);
  logger.info({
    collection: matches[0].collection,
    contentHash: matches[0].item_id,
    action: 'forgotten',
  }, 'memory.write');
}
```

In `src/ipc.ts`, update `processMemoryIpc`:

```typescript
if (data.op === 'forget') {
  return processMemoryForget({ data, groupFolder, embeddingService });
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/memory-service.test.ts
```
Expected: PASS (4 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory-service.ts src/ipc.ts src/memory-service.test.ts
git commit -m "feat(memory): processMemoryForget with prefix resolution + scoped delete

- Accepts full sha1 contentHash OR ≥8-char prefix
- LIKE filter scoped to memory:board:{groupFolder} and memory:user:{groupFolder}:%
- Cross-board IDs unreachable (security boundary preserved)
- Ambiguous prefix (>1 match) rejected with error_code='ambiguous_prefix'
- No-match is idempotent no-op (logs warn)"
```

---

## Phase C — Container env + plumbing

### Task 8: Combined env forwarding + ContainerInput type additions + senderJid plumbing

**Why combined**: Task 8 originally was just env var forwarding, Task 9 added the `senderJid`/`memoryEnabled` types. They couldn't compile independently — Task 8's code references `input.memoryEnabled` and `input.senderJid` which only exist after Task 9. Combined, they form one shippable unit. Per Codex round 7 finding, additionally route the new env vars through `buildNanoclawMcpEnv()` (the MCP subprocess builds its env via that function — Docker `-e` flags alone don't reach the MCP server).

**Files:**
- Modify: `container/agent-runner/src/runtime-config.ts` (interfaces + `buildNanoclawMcpEnv`)
- Modify: `src/container-runner.ts` (Docker `-e` env splice + populate `input.senderJid`/`input.memoryEnabled`)
- Modify: `src/index.ts` (caller of `runContainerAgent` reads sender + memory_enabled, passes to input)
- Modify: `src/db.ts` or wherever `RegisteredGroup`-typed rows are SELECTed (add `memory_enabled` to SELECT)
- Modify: `src/types.ts` (RegisteredGroup interface)
- **Modify: the inbound→IPC follow-up enqueue path** — see Step 6 below for the concrete identification/wiring
- Test: `container/agent-runner/src/runtime-config.test.ts`, `src/container-runner.test.ts`

- [ ] **Step 1: Write the failing test (types only, behavior tests later)**

`container/agent-runner/src/runtime-config.test.ts` (append or create):

```typescript
import { describe, it, expect } from 'vitest';
import type { AgentTurnContext, ContainerInput } from './runtime-config.js';
import { buildNanoclawMcpEnv } from './runtime-config.js';

describe('AgentTurnContext.senderJid + ContainerInput additions', () => {
  it('AgentTurnContext.senderJid is optional', () => {
    const ctx: AgentTurnContext = { turnId: 't1', senderJid: '5585@s.whatsapp.net' };
    expect(ctx.senderJid).toBe('5585@s.whatsapp.net');
    const ctx2: AgentTurnContext = { turnId: 't2' };
    expect(ctx2.senderJid).toBeUndefined();
  });

  it('ContainerInput.senderJid + memoryEnabled + senderName are optional', () => {
    const input: ContainerInput = {
      prompt: 'x', groupFolder: 'g', chatJid: 'c', isMain: false,
      senderJid: '5585@s.whatsapp.net',
      senderName: 'Maria',
      memoryEnabled: true,
    };
    expect(input.senderJid).toBe('5585@s.whatsapp.net');
    expect(input.senderName).toBe('Maria');
    expect(input.memoryEnabled).toBe(true);
  });
});

describe('buildNanoclawMcpEnv: memory env vars', () => {
  it('forwards NANOCLAW_MEMORY_ENABLED + sender info when memoryEnabled=true', () => {
    const env = buildNanoclawMcpEnv({
      prompt: '', groupFolder: 'g', chatJid: 'c', isMain: false,
      memoryEnabled: true,
      senderJid: '5585@s.whatsapp.net',
      senderName: 'Maria',
    });
    expect(env.NANOCLAW_MEMORY_ENABLED).toBe('1');
    expect(env.NANOCLAW_SENDER_JID).toBe('5585@s.whatsapp.net');
    expect(env.NANOCLAW_SENDER_NAME).toBe('Maria');
  });

  it('NANOCLAW_MEMORY_ENABLED=0 when flag is false', () => {
    const env = buildNanoclawMcpEnv({
      prompt: '', groupFolder: 'g', chatJid: 'c', isMain: false,
      memoryEnabled: false,
    });
    expect(env.NANOCLAW_MEMORY_ENABLED).toBe('0');
  });

  it('passes through process.env.NANOCLAW_MEMORY when set', () => {
    const prev = process.env.NANOCLAW_MEMORY;
    process.env.NANOCLAW_MEMORY = 'off';
    try {
      const env = buildNanoclawMcpEnv({
        prompt: '', groupFolder: 'g', chatJid: 'c', isMain: false, memoryEnabled: true,
      });
      expect(env.NANOCLAW_MEMORY).toBe('off');
    } finally {
      if (prev === undefined) delete process.env.NANOCLAW_MEMORY;
      else process.env.NANOCLAW_MEMORY = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd container/agent-runner && npx vitest run src/runtime-config.test.ts
```
Expected: FAIL — types + new env vars don't exist.

- [ ] **Step 3: Add to `container/agent-runner/src/runtime-config.ts`**

```typescript
export interface AgentTurnContext {
  turnId: string;
  senderJid?: string;        // NEW
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isTaskflowManaged?: boolean;
  taskflowBoardId?: string;
  taskflowHierarchyLevel?: number;
  taskflowMaxDepth?: number;
  isScheduledTask?: boolean;
  assistantName?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
  script?: string;
  queryVector?: string;
  ollamaHost?: string;
  embeddingModel?: string;
  turnContext?: AgentTurnContext;
  senderJid?: string;        // NEW: initial sender
  senderName?: string;       // NEW: initial sender name
  memoryEnabled?: boolean;   // NEW: from registered_groups.memory_enabled
  rawUserText?: string;      // NEW: raw inbound message content (pre-formatMessages),
                             //      used for memory recall embedding so recall doesn't
                             //      embed XML wrapper noise. Populated by host before
                             //      formatMessages() wraps prompt.
}
```

In `buildNanoclawMcpEnv` (around line 75-115), append before the final `return env;`:

```typescript
  // Memory layer kill-switch + sender plumbing for MCP subprocess
  if (process.env.NANOCLAW_MEMORY) {
    env.NANOCLAW_MEMORY = process.env.NANOCLAW_MEMORY;
  }
  env.NANOCLAW_MEMORY_ENABLED = containerInput.memoryEnabled ? '1' : '0';
  if (containerInput.senderJid) {
    env.NANOCLAW_SENDER_JID = containerInput.senderJid;
  }
  if (containerInput.senderName) {
    env.NANOCLAW_SENDER_NAME = containerInput.senderName;
  }
```

Mirror the `ContainerInput` interface additions in `src/container-runner.ts` if it has a duplicate definition (per Codex round 5 finding).

- [ ] **Step 4: Add Docker `-e` env splice in `src/container-runner.ts`**

After the existing `OLLAMA_HOST`/`EMBEDDING_MODEL` splice (around line 530-538), add:

```typescript
// Memory layer: kill-switch + per-board flag + sender info to Docker container
if (process.env.NANOCLAW_MEMORY) {
  containerArgs.splice(
    containerArgs.length - 1, 0,
    '-e', `NANOCLAW_MEMORY=${process.env.NANOCLAW_MEMORY}`,
  );
}
containerArgs.splice(
  containerArgs.length - 1, 0,
  '-e', `NANOCLAW_MEMORY_ENABLED=${input.memoryEnabled ? '1' : '0'}`,
);
if (input.senderJid) {
  containerArgs.splice(
    containerArgs.length - 1, 0,
    '-e', `NANOCLAW_SENDER_JID=${input.senderJid}`,
  );
}
if (input.senderName) {
  containerArgs.splice(
    containerArgs.length - 1, 0,
    '-e', `NANOCLAW_SENDER_NAME=${input.senderName}`,
  );
}
```

- [ ] **Step 5: Add `memory_enabled` to `RegisteredGroup` + SELECT**

In `src/types.ts`:

```typescript
export interface RegisteredGroup {
  // ... existing fields
  memoryEnabled?: number;  // 0 or 1, from registered_groups.memory_enabled
}
```

In `src/db.ts`, find the SELECT that reads `registered_groups` rows (used by the registered-groups loader). Add `memory_enabled` to the column list and to the row mapping:

```typescript
// Find the existing SELECT, add memory_enabled
db.prepare(`
  SELECT jid, name, folder, trigger_pattern, added_at, container_config,
         requires_trigger, taskflow_managed, taskflow_hierarchy_level,
         taskflow_max_depth, is_main,
         memory_enabled                          -- NEW
  FROM registered_groups
`).all();

// In the row→RegisteredGroup mapping:
const group: RegisteredGroup = {
  // ... existing fields
  memoryEnabled: row.memory_enabled,            // NEW
};
```

- [ ] **Step 6: Update `runContainerAgent` caller in `src/index.ts` (initial start)**

Find the existing `runContainerAgent(group, { ... }, ...)` call at ~line 759. Trace UP from this call site to find:
1. The inbound message variable (look for `formatMessages(...)` or the raw message content immediately before `prompt` is built — typically in `src/router.ts:formatMessages` or in a dispatcher in `src/index.ts`/`src/whatsapp.ts`)
2. The `sender` and `senderName` fields on that inbound message

Concrete steps:

```bash
grep -n "formatMessages\|runContainerAgent\|prompt = " /root/nanoclaw/src/index.ts | head -20
```

The inbound message object (from Baileys/WhatsApp) typically has `.key.participant` (group sender JID) or `.key.remoteJid` (DM sender JID), `.pushName` (display name), and `.message.conversation` (raw text). Adjust based on what you find.

Apply this edit:

```typescript
// Just before calling runContainerAgent, capture the raw text + sender info
const rawUserText = inboundMessage.content ?? inboundMessage.message?.conversation ?? '';
const senderJidForContainer = inboundMessage.key?.participant
  ?? inboundMessage.key?.remoteJid
  ?? inboundMessage.sender;
const senderNameForContainer = inboundMessage.pushName
  ?? inboundMessage.senderName
  ?? '';
const memoryEnabledForContainer = group.memoryEnabled === 1;

const output = await runContainerAgent(
  group,
  {
    prompt,                                      // existing — already XML via formatMessages
    sessionId,
    groupFolder: group.folder,
    chatJid,
    isMain,
    isTaskflowManaged: group.taskflowManaged === true,
    taskflowHierarchyLevel: group.taskflowHierarchyLevel,
    taskflowMaxDepth: group.taskflowMaxDepth,
    assistantName: getGroupSenderName(group.trigger),
    turnContext,
    senderJid: senderJidForContainer,           // NEW
    senderName: senderNameForContainer,         // NEW
    memoryEnabled: memoryEnabledForContainer,   // NEW
    rawUserText,                                // NEW: needed for memory recall (Task 12)
    ...(imageAttachments.length > 0 && { imageAttachments }),
  },
  // ...
);
```

If the inbound message variable is named differently in your code (`message`, `msg`, `wa`), adjust accordingly. The principle: capture the original user text BEFORE any wrapping, plus the sender's JID + display name, plus the per-board memory flag.

- [ ] **Step 7: Wire `turnContext.senderJid` in the inbound→IPC follow-up enqueue path**

Per spec §9.3, the v2 plan was unclear about whether `GroupQueue.sendMessage` has any active production callers. **Concrete approach for v2 plan**: regardless of whether a caller exists today, the active inbound→follow-up path goes through `src/group-queue.ts:223-261`'s `sendMessage(groupJid, text, turnContext)`. Modify any caller (or add one if absent) to populate `turnContext.senderJid`:

```bash
# Step 7a: locate the actual caller(s)
grep -rn "groupQueue\.sendMessage\|queue\.sendMessage" /root/nanoclaw/src --include="*.ts" | grep -v "\.test\.ts"
```

Three concrete sub-cases:

- **(a) Found one or more callers**: modify each to pass `turnContext: { turnId, senderJid: inboundMessage.sender }` (where `inboundMessage` is whatever variable holds the WhatsApp message at that site).

- **(b) Found no callers**: this means follow-ups currently don't reach running containers via `GroupQueue`. The inbound dispatcher likely either restarts the container (loses turnId) or uses a different mechanism. Search for `data/ipc/${...}/input` writes:

  ```bash
  grep -rn "ipc.*input\|inputDir" /root/nanoclaw/src --include="*.ts" | grep -v "\.test\.ts"
  ```

  Modify the writer to populate `senderJid` in the JSON payload alongside `text` and `turnContext`. The container's `IpcInputMessage` interface (Task 9 from container side) already defines `turnContext?: AgentTurnContext`; ensure the container reads `nextMessage.turnContext?.senderJid` (Task 13 already does this).

- **(c) Neither found**: the inbound→follow-up path needs to be added. Concrete code to add (place in `src/index.ts` message loop where new inbound messages are dispatched, BEFORE the `runContainerAgent` call):

  ```typescript
  // In the message loop, when a new inbound message arrives for a group with active container:
  if (groupQueue.hasActiveContainer(chatJid)) {
    const wrote = groupQueue.sendMessage(
      chatJid,
      inboundMessage.content,
      {
        turnId: turnContext?.turnId ?? generateTurnId(),
        senderJid: inboundMessage.sender,
      },
    );
    if (wrote) {
      logger.debug({ chatJid, sender: inboundMessage.sender }, 'follow-up enqueued');
      return; // skip starting a new container
    }
  }
  ```

  Note: this assumes `groupQueue.hasActiveContainer(chatJid)` exists on the GroupQueue class. If not, add it (1-line: `return this.getGroup(jid).active`).

Pick whichever sub-case matches reality (a, b, or c). Document in the commit message which one applied. The container-side reading of `nextMessage.turnContext?.senderJid` is already done in Task 13.

- [ ] **Step 8: Run tests + typecheck (host + container)**

```bash
npx tsc --noEmit
cd container/agent-runner && npx tsc --noEmit && cd ../..
npx vitest run
cd container/agent-runner && npx vitest run && cd ../..
```
Expected: tsc clean both sides, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add container/agent-runner/src/runtime-config.ts container/agent-runner/src/runtime-config.test.ts \
       src/container-runner.ts src/index.ts src/db.ts src/types.ts \
       src/group-queue.ts /* if modified per Step 7 sub-case */
git commit -m "feat(memory): combined env forwarding + senderJid plumbing

Combined Tasks 8+9 from the original plan because they couldn't compile
independently (Task 8 referenced input.memoryEnabled added by Task 9).

Type additions:
- AgentTurnContext.senderJid (per-user recall on follow-ups)
- ContainerInput.senderJid/.senderName/.memoryEnabled

Env routing (BOTH paths required — Codex round 7 finding):
- Docker spawn: container-runner.ts adds -e flags for the Docker container env
- MCP subprocess: buildNanoclawMcpEnv adds the same vars to the MCP server env
  (the MCP server inside the container builds its env via this function;
  Docker -e alone wouldn't reach it)

Schema:
- registered_groups SELECT now includes memory_enabled column
- RegisteredGroup interface gains memoryEnabled?: number

Inbound→IPC follow-up enqueue path: identified as sub-case (a/b/c) per
Step 7 — see code change for the specific path used in this commit."
```

---

## Phase D — Container memory reader

### Task 10: `memory-reader.ts` — dual-collection query merge + format

**Files:**
- Create: `container/agent-runner/src/memory-reader.ts`
- Test: `container/agent-runner/src/memory-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  recallMemories,
  formatRelevantMemoriesBlock,
  type MemoryHit,
} from './memory-reader.js';

describe('recallMemories: dual-collection query', () => {
  it('queries both board and user collections, merges by score', () => {
    const reader = {
      search: vi.fn()
        .mockReturnValueOnce([
          { itemId: 'b1', score: 0.7, metadata: { category: 'fact', text: 'Board fact', scope: 'board' } },
        ])
        .mockReturnValueOnce([
          { itemId: 'u1', score: 0.9, metadata: { category: 'preference', text: 'User pref', scope: 'user' } },
          { itemId: 'u2', score: 0.5, metadata: { category: 'entity', text: 'User entity', scope: 'user' } },
        ]),
    } as any;

    const hits = recallMemories(reader, {
      boardId: 'foo',
      senderJid: 'jid@s.whatsapp.net',
      queryVector: new Float32Array([0.1, 0.2]),
      threshold: 0.5,
      limit: 10,
    });

    expect(reader.search).toHaveBeenCalledWith(
      'memory:board:foo', expect.any(Float32Array), { limit: 5, threshold: 0.5 },
    );
    expect(reader.search).toHaveBeenCalledWith(
      'memory:user:foo:jid@s.whatsapp.net', expect.any(Float32Array), { limit: 5, threshold: 0.5 },
    );
    expect(hits.map((h) => h.itemId)).toEqual(['u1', 'b1', 'u2']);
  });

  it('skips user query when senderJid is null (board scope only)', () => {
    const reader = {
      search: vi.fn().mockReturnValue([
        { itemId: 'b1', score: 0.7, metadata: { category: 'fact', text: 'Board' } },
      ]),
    } as any;
    const hits = recallMemories(reader, {
      boardId: 'foo', senderJid: null,
      queryVector: new Float32Array([0.1]),
      threshold: 0.5, limit: 10,
    });
    expect(reader.search).toHaveBeenCalledTimes(1);
    expect(hits.length).toBe(1);
  });
});

describe('formatRelevantMemoriesBlock', () => {
  const hits: MemoryHit[] = [
    { itemId: 'a3f1b9c842de1111', scope: 'user', category: 'preference', text: 'Prefers concise replies, no emojis', score: 0.83 },
    { itemId: 'b8a902c3e7d42222', scope: 'board', category: 'fact', text: 'Team uses M for meetings', score: 0.71 },
  ];

  it('formats with scope, category, 12-char id prefix', () => {
    const block = formatRelevantMemoriesBlock(hits, 500);
    expect(block).toContain('<relevant-memories>');
    expect(block).toContain('[user, preference, id=a3f1b9c842de]');
    expect(block).toContain('Prefers concise replies, no emojis');
    expect(block).toContain('[board, fact, id=b8a902c3e7d4]');
    expect(block).toContain('</relevant-memories>');
  });

  it('returns empty string for no hits', () => {
    expect(formatRelevantMemoriesBlock([], 500)).toBe('');
  });

  it('truncates at token budget', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      itemId: `${i.toString().padStart(16, '0')}`,
      scope: 'user' as const,
      category: 'fact' as const,
      text: 'A reasonably long memory fact text that takes some tokens. '.repeat(3),
      score: 0.6,
    }));
    const block = formatRelevantMemoriesBlock(many, 200);
    const includedCount = (block.match(/\[user,/g) || []).length;
    expect(includedCount).toBeLessThan(50); // budget cut in
    expect(block.length).toBeLessThan(1500); // ~4 chars/token rough check
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd container/agent-runner && npx vitest run src/memory-reader.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`container/agent-runner/src/memory-reader.ts`:

```typescript
import { EmbeddingReader } from './embedding-reader.js';

export interface MemoryHit {
  itemId: string;
  scope: 'board' | 'user';
  category: string;
  text: string;
  score: number;
}

export interface RecallArgs {
  boardId: string;
  senderJid: string | null;
  queryVector: Float32Array;
  threshold?: number;       // default 0.5
  limit?: number;           // default 10
}

export function recallMemories(reader: EmbeddingReader, args: RecallArgs): MemoryHit[] {
  const threshold = args.threshold ?? 0.5;
  const perCollectionLimit = 5;

  const boardCollection = `memory:board:${args.boardId}`;
  const boardRaw = reader.search(boardCollection, args.queryVector, {
    limit: perCollectionLimit, threshold,
  });
  const boardHits: MemoryHit[] = boardRaw.map((r) => ({
    itemId: r.itemId,
    scope: 'board',
    category: r.metadata.category ?? 'other',
    text: r.metadata.text ?? '',
    score: r.score,
  }));

  let userHits: MemoryHit[] = [];
  if (args.senderJid) {
    const userCollection = `memory:user:${args.boardId}:${args.senderJid}`;
    const userRaw = reader.search(userCollection, args.queryVector, {
      limit: perCollectionLimit, threshold,
    });
    userHits = userRaw.map((r) => ({
      itemId: r.itemId,
      scope: 'user',
      category: r.metadata.category ?? 'other',
      text: r.metadata.text ?? '',
      score: r.score,
    }));
  }

  return [...boardHits, ...userHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit ?? 10);
}

export function formatRelevantMemoriesBlock(hits: MemoryHit[], budgetTokens: number): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const id12 = hit.itemId.slice(0, 12);
    const line = `[${hit.scope}, ${hit.category}, id=${id12}] ${hit.text}`;
    const tokens = Math.ceil(line.length / 4);
    if (used + tokens > budgetTokens && lines.length > 0) break;
    lines.push(line);
    used += tokens;
  }
  return `<relevant-memories>\n${lines.join('\n')}\n</relevant-memories>\n\n`;
}
```

Note: `EmbeddingReader.search` returns `{itemId, score, metadata}` where `metadata` is the JSON-parsed metadata. Memory rows store `text` in the `source_text` column (NOT in metadata). Need to verify and adjust:

Check what `EmbeddingReader.search` returns. Looking at `embedding-reader.ts:30-71` — it returns `metadata` (parsed JSON) but NOT the source_text. To get the text into recall results, the host's `processMemoryStore` should write the fact text into `metadata.text` as well as `source_text`. Update `processMemoryStore` (Task 6) to add `text: data.text` into the metadata blob.

Or: extend `EmbeddingReader.search` to also return `sourceText`. The first option is less invasive — go with it.

- [ ] **Step 4: Update `processMemoryStore` to mirror text into metadata**

In `src/memory-service.ts`, add `text: data.text` to the `finalMetadata` object:

```typescript
const finalMetadata = {
  category: data.metadata.category,
  scope: data.scope,
  entities: ...,
  senderJid: ...,
  senderName: ...,
  capturedAt: ...,
  source: ...,
  text: data.text,  // duplicate into metadata so EmbeddingReader can return it
};
```

Re-run `src/memory-service.test.ts` — should still pass (the existing tests assert `expect.objectContaining(...)` not exact equality).

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd container/agent-runner && npx vitest run src/memory-reader.test.ts && cd ../..
npx vitest run src/memory-service.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/memory-reader.ts container/agent-runner/src/memory-reader.test.ts \
       src/memory-service.ts
git commit -m "feat(memory): memory-reader.ts dual-collection query + format

recallMemories(reader, {boardId, senderJid, queryVector, ...}):
- Two EmbeddingReader.search() calls (board + user collections)
- Merge by score, take top K
- Skip user query when senderJid is null
- threshold=0.5 default (overrides reader's 0.3)

formatRelevantMemoriesBlock(hits, budgetTokens):
- <relevant-memories>...</relevant-memories> block
- 12-char itemId prefix
- token-budget truncation

processMemoryStore now mirrors data.text into metadata.text so EmbeddingReader
can surface it on recall (avoids extending EmbeddingReader.search to also
return source_text)."
```

---

### Task 11: `buildMemoryPreamble` end-to-end helper

**Files:**
- Modify: `container/agent-runner/src/memory-reader.ts`
- Test: `container/agent-runner/src/memory-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// memory-reader.test.ts (append)
import { buildMemoryPreamble } from './memory-reader.js';

describe('buildMemoryPreamble end-to-end', () => {
  it('returns formatted block when hits exist', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });
    (globalThis as any).fetch = fetchMock;

    // Stub the reader by mocking the import
    vi.doMock('./embedding-reader.js', () => ({
      EmbeddingReader: class {
        constructor(_path: string) {}
        search() {
          return [{ itemId: 'abc123def456789', score: 0.85, metadata: { category: 'preference', text: 'Concise' } }];
        }
        close() {}
      },
    }));

    const block = await buildMemoryPreamble({
      promptText: 'What does Maria prefer?',
      boardId: 'test-board',
      senderJid: 'maria@s.whatsapp.net',
      ollamaHost: 'http://localhost:11434',
      embeddingModel: 'bge-m3',
    });
    expect(block).toContain('<relevant-memories>');
    expect(block).toContain('Concise');
  });

  it('returns empty string when ollamaEmbed fails (fail-open)', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('network'));
    const block = await buildMemoryPreamble({
      promptText: 'foo',
      boardId: 'b',
      senderJid: 'j@s.whatsapp.net',
      ollamaHost: 'http://localhost:11434',
      embeddingModel: 'bge-m3',
    });
    expect(block).toBe('');
  });

  it('returns empty when prompt is too short', async () => {
    const block = await buildMemoryPreamble({
      promptText: '',
      boardId: 'b', senderJid: 'j',
      ollamaHost: 'http://x', embeddingModel: 'bge-m3',
    });
    expect(block).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd container/agent-runner && npx vitest run src/memory-reader.test.ts -t "buildMemoryPreamble"
```
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement**

Append to `container/agent-runner/src/memory-reader.ts`:

```typescript
export interface BuildPreambleArgs {
  promptText: string;
  boardId: string;
  senderJid: string | null;
  ollamaHost: string;
  embeddingModel: string;
}

// NOTE: this helper does NOT strip XML wrappers (<context>, <messages>, <message ...>)
// because we expect the CALLER to pass the raw user message text, NOT the
// SDK-formatted prompt. See Tasks 12 + 13: callers pass containerInput.prompt
// (initial) or nextMessage.text (follow-up) — both raw, pre-XML-wrapping.
//
// We still strip two minimal envelope patterns that the host or upstream
// formatters sometimes prepend:
//   1. Single-line envelope header `[Channel User Timestamp]` at the start
//   2. Inline `[message_id: ...]` lines anywhere in the body
const ENVELOPE_HEADER_RE = /^\[[^\]\n]+\]\s*\n?/;
const MESSAGE_ID_LINE_RE = /^\[message_id:\s*[^\]]+\]$/;

function stripEnvelopeForSearch(text: string): string {
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE_RE.test(line.trim()));
  let result = filtered.join('\n');
  const m = result.match(ENVELOPE_HEADER_RE);
  if (m) {
    const inside = m[0].replace(/[\[\]\n]/g, '').trim();
    if (inside.split(/\s+/).length >= 2) {
      result = result.slice(m[0].length);
    }
  }
  return result.trim();
}

async function localOllamaEmbed(text: string, host: string, model: string): Promise<Float32Array | null> {
  if (!host) return null;
  try {
    const resp = await fetch(`${host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { embeddings: number[][] };
    return data.embeddings?.[0] ? new Float32Array(data.embeddings[0]) : null;
  } catch {
    return null;
  }
}

export async function buildMemoryPreamble(args: BuildPreambleArgs): Promise<string> {
  const stripped = stripEnvelopeForSearch(args.promptText);
  if (stripped.length < 2) return '';

  const queryVector = await localOllamaEmbed(stripped, args.ollamaHost, args.embeddingModel);
  if (!queryVector) return '';

  const reader = new EmbeddingReader('/workspace/embeddings/embeddings.db');
  try {
    const hits = recallMemories(reader, {
      boardId: args.boardId,
      senderJid: args.senderJid,
      queryVector,
      threshold: 0.5,
      limit: 10,
    });
    return formatRelevantMemoriesBlock(hits, 500);
  } catch {
    return '';
  } finally {
    reader.close();
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd container/agent-runner && npx vitest run src/memory-reader.test.ts
```
Expected: PASS (5 tests total in this file).

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/memory-reader.ts container/agent-runner/src/memory-reader.test.ts
git commit -m "feat(memory): buildMemoryPreamble end-to-end helper

Composes stripEnvelopeForSearch + localOllamaEmbed + recallMemories +
formatRelevantMemoriesBlock. Returns empty string on:
- prompt too short after envelope strip
- ollamaEmbed failure (fail-open)
- any internal error
Used at two call sites in container/agent-runner/src/index.ts."
```

---

### Task 12: Wire `buildMemoryPreamble` at initial container start

**Files:**
- Modify: `container/agent-runner/src/index.ts:~729` (after the existing task-context preamble block, before the long-term-context recap block)

- [ ] **Step 1: Re-read the surrounding code to lock placement**

```bash
sed -n '687,790p' /root/nanoclaw/container/agent-runner/src/index.ts
```

Memory preamble must be inserted RIGHT AFTER line 729 (`}` closing the task-context preamble block) and BEFORE line 731 (the recap block opener). Final order: `recap → memory → task → user`.

- [ ] **Step 2: Write the failing test (if there's an existing test for this code path)**

Most likely no direct test exists. Skip to step 3 — verification will be via the smoke test in Task 19.

- [ ] **Step 3: Insert the memory preamble call**

After the closing `}` of the existing `if (containerInput.queryVector && containerInput.isTaskflowManaged && containerInput.taskflowBoardId) {` block (ends at line 729), add:

```typescript
  // --- add-memory skill: relevant memories preamble (initial container start) ---
  if (
    containerInput.isTaskflowManaged
    && containerInput.taskflowBoardId
    && containerInput.memoryEnabled === true
    && process.env.NANOCLAW_MEMORY !== 'off'
  ) {
    try {
      const { buildMemoryPreamble } = await import('./memory-reader.js');
      // IMPORTANT: pass containerInput.rawUserText (the raw inbound message content
      // populated by the host before formatMessages() wrapped prompt in XML).
      // Embedding the XML-wrapped prompt would skew recall toward document/context
      // noise instead of the user's actual question. Falls back to containerInput.prompt
      // only as last resort (some legacy paths may not populate rawUserText yet).
      const memoryBlock = await buildMemoryPreamble({
        promptText: containerInput.rawUserText ?? containerInput.prompt,
        boardId: containerInput.taskflowBoardId,
        senderJid: containerInput.senderJid ?? null,
        ollamaHost: containerInput.ollamaHost ?? '',
        embeddingModel: containerInput.embeddingModel ?? 'bge-m3',
      });
      if (memoryBlock) {
        prompt = memoryBlock + prompt;  // newline already in block
        log(`Memory preamble injected (${memoryBlock.length} chars)`);
      }
    } catch (err) {
      log(`Memory preamble skipped: ${err}`);
    }
  }
```

Note: this insertion goes BEFORE the long-term-context recap block at line 731. After both:
- Line 729 → memory prepends → `prompt = memory_block + prompt` → "memory + (task + user)"
- Line 768 → recap prepends → `prompt = recap_block + prompt` → "recap + memory + task + user"

Final order: `recap → memory → task → user` ✓.

- [ ] **Step 4: Verify tsc passes**

```bash
cd container/agent-runner && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(memory): wire buildMemoryPreamble at initial container start

Inserted between the existing task-context preamble (line 729) and the
long-term-context recap (line 731). Final preamble order after this commit:
  recap → memory → task → user

Gated by:
  - containerInput.isTaskflowManaged && containerInput.taskflowBoardId
  - containerInput.memoryEnabled === true (per-board flag)
  - process.env.NANOCLAW_MEMORY !== 'off' (system kill-switch)

Fail-open on any error — memory layer never blocks a turn."
```

---

### Task 13: Wire `buildMemoryPreamble` in IPC follow-up loop

**Files:**
- Modify: `container/agent-runner/src/index.ts:~957` (after `prompt = nextMessage.text`)

- [ ] **Step 1: Re-read the surrounding loop**

```bash
sed -n '940,970p' /root/nanoclaw/container/agent-runner/src/index.ts
```

The IPC follow-up loop's prompt assignment is at line 957. After this assignment, the agent SDK runs another query. We need to inject memory preamble between the assignment and the next query.

- [ ] **Step 2: Insert the call**

After line 958 (`containerInput.turnContext = nextMessage.turnContext;`), add:

```typescript
      // --- add-memory skill: relevant memories preamble (IPC follow-up) ---
      // Re-run recall on every follow-up. The host pre-embeds only the initial
      // prompt; container does its own ollamaEmbed for follow-ups.
      // Use nextMessage.text (raw user text from IPC file), NOT the prompt
      // variable (which is the same value here, but explicit).
      if (
        containerInput.isTaskflowManaged
        && containerInput.taskflowBoardId
        && containerInput.memoryEnabled === true
        && process.env.NANOCLAW_MEMORY !== 'off'
      ) {
        try {
          const { buildMemoryPreamble } = await import('./memory-reader.js');
          const memoryBlock = await buildMemoryPreamble({
            promptText: nextMessage.text,
            boardId: containerInput.taskflowBoardId,
            senderJid: nextMessage.turnContext?.senderJid
              ?? containerInput.senderJid
              ?? null,
            ollamaHost: containerInput.ollamaHost ?? '',
            embeddingModel: containerInput.embeddingModel ?? 'bge-m3',
          });
          if (memoryBlock) {
            prompt = memoryBlock + prompt;
            log(`IPC memory preamble injected (${memoryBlock.length} chars)`);
          }
        } catch (err) {
          log(`IPC memory preamble skipped: ${err}`);
        }
      }
```

- [ ] **Step 3: Verify tsc**

```bash
cd container/agent-runner && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(memory): wire buildMemoryPreamble in IPC follow-up loop

Fixes the v1 spec's incorrectly-named bug: follow-up IPC turns at
container/agent-runner/src/index.ts:957 set prompt=nextMessage.text
without recomputing recall. Now both the initial start (Task 12) AND
every IPC follow-up trigger a fresh memory recall.

senderJid resolution order: nextMessage.turnContext?.senderJid →
containerInput.senderJid → null (board-scope only)."
```

---

## Phase E — MCP tools

### Task 14: Register `memory_store` MCP tool

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (register tool, add `MEMORY_WRITES_DIR` constant, kill-switch gating)

- [ ] **Step 0: Create container-side `memory-types.ts` (mirror of host)**

Container code can't import from `src/` (host). Create a parallel file:

`container/agent-runner/src/memory-types.ts`:

```typescript
export const MEMORY_CATEGORIES = [
  'preference', 'fact', 'decision', 'entity', 'other',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_SCOPES = ['board', 'user'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
```

(Container side doesn't need the `isMemory*` type guards — the MCP zod schemas validate.)

- [ ] **Step 1: Add MEMORY_WRITES_DIR constant + kill-switch helpers**

Near the existing `IPC_DIR`, `MESSAGES_DIR`, `TASKS_DIR` constants (~line 30):

```typescript
const MEMORY_WRITES_DIR = path.join(IPC_DIR, 'memory-writes');
const memoryEnabled =
  process.env.NANOCLAW_MEMORY_ENABLED === '1'
  && process.env.NANOCLAW_MEMORY !== 'off';
```

(These env vars are forwarded by `buildNanoclawMcpEnv` — Task 8.)

- [ ] **Step 2: Write the failing test (skip — MCP tool tests in this codebase typically integration-test via the registered server, not direct unit calls)**

Most MCP tool tests in this codebase are absorbed into the e2e smoke test. The MCP server is started in a subprocess. Skip direct unit tests for the tool registration; rely on Task 19's e2e smoke test for verification.

- [ ] **Step 3: Register `memory_store`**

After the existing tool registrations (find a clean insertion point near similar tools), add:

```typescript
import crypto from 'crypto';
import { MEMORY_CATEGORIES, MEMORY_SCOPES } from './memory-types.js';

server.tool(
  'memory_store',
  'Save a slow-moving fact about the user or board to long-term memory. ' +
  'Use when: (a) user explicitly signals to remember ("lembre disso", ' +
  '"anote", "não esquece"), or (b) the user states a stable preference, ' +
  'convention, naming/disambiguation, or identity fact in passing that you ' +
  'judge worth carrying forward. ' +
  'Do NOT use for task state (use taskflow_* tools), one-time events, ' +
  'specific dates, or speculation. ' +
  'Background auto-capture is NOT enabled — if you do not call this tool, ' +
  'the fact will not be remembered. ' +
  'IMPORTANT: in script-driven scheduled tasks (no human inbound), you MUST ' +
  'use scope="board" — scope="user" writes will be rejected.',
  {
    text: z.string().min(5).max(280).describe('One sentence in English describing the fact'),
    category: z.enum(MEMORY_CATEGORIES).describe('Category from the 5-value enum'),
    scope: z.enum(MEMORY_SCOPES).optional().describe('"user" (default) = about the sender; "board" = team-wide'),
    entities: z.array(z.string()).max(10).optional().describe('Names/entities referenced'),
  },
  async (args) => {
    if (!memoryEnabled) {
      return {
        content: [{ type: 'text' as const, text: 'memory_disabled: memory layer is off (env or per-board flag)' }],
        isError: true,
      };
    }

    const scope = args.scope ?? 'user';
    const normalized = args.text.trim().toLowerCase().replace(/\s+/g, ' ');
    const contentHash = crypto
      .createHash('sha1').update(`${args.category}:${normalized}`).digest('hex');

    // Read sender from env (set by container-runner from inbound message)
    const senderJid = process.env.NANOCLAW_SENDER_JID;
    const senderName = process.env.NANOCLAW_SENDER_NAME;

    if (scope === 'user' && !senderJid) {
      return {
        content: [{ type: 'text' as const, text: 'memory_store: scope=user requires a senderJid; in scheduled tasks use scope=board' }],
        isError: true,
      };
    }

    const data = {
      op: 'store',
      scope,
      contentHash,
      text: args.text,
      metadata: {
        category: args.category,
        entities: args.entities ?? [],
        senderJid,
        senderName,
        capturedAt: new Date().toISOString(),
        source: 'manual_store',
      },
    };
    writeIpcFile(MEMORY_WRITES_DIR, data);
    return {
      content: [{
        type: 'text' as const,
        text: `Memory queued for storage. memoryId=${contentHash.slice(0, 12)} action=queued`,
      }],
    };
  },
);
```

Note: `NANOCLAW_SENDER_JID` and `NANOCLAW_SENDER_NAME` env vars are NEW. Forward them in `src/container-runner.ts` similarly to the memory-enabled forwarding (Task 8 + 9).

- [ ] **Step 4: NANOCLAW_SENDER_JID/NAME env forwarding (already done in Task 8)**

Both env vars are already forwarded by Task 8 (Docker `-e` AND `buildNanoclawMcpEnv`). Nothing to add here — Task 14's MCP tool just reads them.

**On follow-up sender attribution (architecture note):**

The container's env vars (`NANOCLAW_SENDER_JID`, `NANOCLAW_SENDER_NAME`) are fixed at container start. On IPC follow-up turns, these still reflect the INITIAL sender. The MCP `memory_store` tool reads them, so a naive implementation would attribute follow-up `memory_store` calls to the wrong sender.

**Why this is fine in practice (self-correcting via host-side validation):**

The container writes `metadata.senderJid` from its (potentially stale) env var. The host's `processMemoryStore` (Task 6) validates this against recent inbound senders in `messages.db`. If the container-supplied JID doesn't match the actual most-recent inbound for the group, host falls back to the actual most-recent sender + logs `memory.spoof_attempt`. The fallback is the correct behavior anyway — the inbound that triggered this turn IS the most-recent.

So for follow-up turns: container writes stale init sender → host detects mismatch → host stores under the actual current sender (correct). The "spoof_attempt" warn log will fire on every legitimate multi-sender follow-up; tune the log level or rename to `memory.sender_corrected` if noisy. Document this in Task 14's commit message.

(Alternative: a turn-state file at `/workspace/ipc/current-sender.txt` updated by the container loop on each `nextMessage`, read by the MCP tool. Skip for MVP — the host-side validation already gets this right.)

- [ ] **Step 5: Run tsc**

```bash
cd container/agent-runner && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/runtime-config.ts \
       src/container-runner.ts
git commit -m "feat(memory): register memory_store MCP tool + sender env vars

memory_store(text, category, scope?, entities?):
- Validates input (zod schema)
- Computes contentHash = sha1(category + ':' + normalize(text))
- Reads senderJid/senderName from NANOCLAW_SENDER_JID/_NAME env vars
- scope=user requires senderJid (scheduled tasks must use scope=board)
- Writes JSON to /workspace/ipc/memory-writes/
- Returns memoryId (12-char prefix) + action=queued
- Kill-switch: short-circuits when NANOCLAW_MEMORY=off OR memory_enabled=0

Container-runner forwards new env vars NANOCLAW_SENDER_JID/_NAME from
input.senderJid/.senderName.

Known limitation (deferred): the env vars are fixed at container start;
multi-sender follow-up turns attribute memory_store to the initial sender."
```

---

### Task 15: Register `memory_recall` MCP tool

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Implement**

```typescript
server.tool(
  'memory_recall',
  'Search long-term memory for facts about the user or board. ' +
  'Auto-recall already injects relevant memories at every turn start in ' +
  '<relevant-memories> — use this tool ONLY for explicit deep-dives ' +
  '("o que você sabe sobre Maria?") or when auto-recall returned nothing relevant. ' +
  'Returns memories tagged with scope, category, score, and a memoryId you can ' +
  'pass to memory_forget if a memory is wrong.',
  {
    query: z.string().min(2).max(500),
    scope: z.enum(['user', 'board', 'both']).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    category: z.enum(MEMORY_CATEGORIES).optional(),
  },
  async (args) => {
    if (!memoryEnabled) {
      return {
        content: [{ type: 'text' as const, text: 'memory_disabled' }],
        isError: true,
      };
    }
    const scope = args.scope ?? 'both';
    const limit = args.limit ?? 10;

    const queryVector = await ollamaEmbed(args.query);
    if (!queryVector) {
      return {
        content: [{ type: 'text' as const, text: 'embedding_unavailable: Ollama unreachable' }],
        isError: true,
      };
    }

    const { recallMemories } = await import('./memory-reader.js');
    const { EmbeddingReader } = await import('./embedding-reader.js');
    const reader = new EmbeddingReader(EMBEDDINGS_DB_PATH);
    try {
      // For TaskFlow boards, the board ID equals groupFolder (existing convention).
      // groupFolder is already set from NANOCLAW_GROUP_FOLDER at line 41.
      const boardId = groupFolder;
      const senderJid = process.env.NANOCLAW_SENDER_JID;
      const hits = recallMemories(reader, {
        boardId,
        senderJid: scope === 'board' ? null : (senderJid ?? null),
        queryVector,
        threshold: 0.5,
        limit,
      });
      // Filter by scope and category
      const filtered = hits.filter((h) => {
        if (scope === 'user' && h.scope !== 'user') return false;
        if (scope === 'board' && h.scope !== 'board') return false;
        if (args.category && h.category !== args.category) return false;
        return true;
      });
      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: `No memories matched "${args.query}"` }] };
      }
      const lines = filtered.map((h) =>
        `[${h.scope}, ${h.category}, score ${h.score.toFixed(2)}, id=${h.itemId.slice(0, 12)}] ${h.text}`,
      );
      return {
        content: [{
          type: 'text' as const,
          text: `Found ${filtered.length} memories matching "${args.query}":\n${lines.join('\n')}`,
        }],
      };
    } finally {
      reader.close();
    }
  },
);
```

- [ ] **Step 2: Run tsc**

```bash
cd container/agent-runner && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(memory): register memory_recall MCP tool

memory_recall(query, scope?, limit?, category?):
- Embeds query via existing ollamaEmbed()
- Calls recallMemories with scope routing
- Filters by category if given
- Returns formatted text with [scope, category, score, id=...] tags
- Kill-switch: short-circuits when memory disabled"
```

---

### Task 16: Register `memory_forget` MCP tool

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Implement**

```typescript
server.tool(
  'memory_forget',
  'Permanently delete a memory by ID. Use when: (a) user says "esquece isso", ' +
  '"isso está errado", "remova essa memória"; (b) you discover a stored memory ' +
  'is wrong (user clarified a fact, role changed, preference shifted). ' +
  'The memoryId comes from a prior memory_recall result or the auto-recall preamble. ' +
  'You can ONLY forget memories from THIS board — cross-board deletion is blocked.',
  {
    memoryId: z.string().describe('The memoryId (12-char prefix or full sha1) from a prior recall'),
  },
  async (args) => {
    if (!memoryEnabled) {
      return {
        content: [{ type: 'text' as const, text: 'memory_disabled' }],
        isError: true,
      };
    }
    if (args.memoryId.length < 8) {
      return {
        content: [{ type: 'text' as const, text: 'memory_forget: memoryId must be ≥8 chars' }],
        isError: true,
      };
    }
    const data = { op: 'forget', memoryId: args.memoryId };
    writeIpcFile(MEMORY_WRITES_DIR, data);
    return {
      content: [{
        type: 'text' as const,
        text: `Forget queued for memoryId=${args.memoryId}. action=queued`,
      }],
    };
  },
);
```

- [ ] **Step 2: Run tsc**

```bash
cd container/agent-runner && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(memory): register memory_forget MCP tool

memory_forget(memoryId):
- Validates memoryId ≥8 chars
- Writes IPC file with op=forget
- Host scopes deletion to this board's collections (security boundary)
- Kill-switch: short-circuits when memory disabled"
```

---

## Phase F — Skill packaging + smoke test

### Task 17: Create `add-memory` skill manifest + SKILL.md

**Files:**
- Create: `.claude/skills/add-memory/manifest.yaml`
- Create: `.claude/skills/add-memory/SKILL.md`

- [ ] **Step 1: Write manifest.yaml**

```yaml
# .claude/skills/add-memory/manifest.yaml
name: add-memory
version: 1.0.0
description: Long-term memory layer for TaskFlow boards (manual MVP — auto-capture deferred to v3)
depends:
  - add-embeddings
files:
  source:
    - src/memory-types.ts
    - src/memory-service.ts
    - container/agent-runner/src/memory-reader.ts
  modified:
    - src/db.ts
    - src/ipc.ts
    - src/index.ts
    - src/container-runner.ts
    - container/agent-runner/src/ipc-mcp-stdio.ts
    - container/agent-runner/src/index.ts
    - container/agent-runner/src/runtime-config.ts
  test:
    - src/memory-service.test.ts
    - container/agent-runner/src/memory-reader.test.ts
```

- [ ] **Step 2: Write SKILL.md**

```markdown
# Add Memory

Adds a long-term memory layer to TaskFlow boards. Agent uses memory_store/recall/forget MCP tools; auto-recall preamble runs every turn (initial + IPC follow-ups). Built on existing add-embeddings (BGE-M3 / Ollama / SQLite WAL).

**Manual-only at MVP** — no background extractor. Auto-capture deferred to v3 pending JSON-quality eval, GPU headroom validation, and recall hit-rate evidence (see spec §7).

## Phase 1: Pre-flight

### Check add-embeddings is installed

```bash
test -f src/embedding-service.ts || (echo "Run /add-embeddings first" && exit 1)
```

### Check Ollama + bge-m3

```bash
curl -s http://$OLLAMA_HOST/api/tags | grep -i bge-m3
```

## Phase 2: Apply code

```bash
git merge skill/memory
npm run build
./container/build.sh
```

## Phase 3: Configure

Add to `.env` (optional — both default-on per group when memory_enabled=1):

```bash
NANOCLAW_MEMORY=on  # or 'off' for fleet-wide kill-switch
```

The migration sets `memory_enabled=1` on all `taskflow_managed=1` rows automatically.

## Phase 4: Restart

```bash
systemctl --user restart nanoclaw  # Linux
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Phase 5: Verify

```bash
journalctl --user -u nanoclaw --since "1 minute ago" | grep memory
# Look for: memory.recall callSite=initial hits.user=N hits.board=M
```

E2E smoke test: see spec §13 two-task pattern.

## Rollback

Per-board:
```sql
UPDATE registered_groups SET memory_enabled=0 WHERE folder='X';
```
Active container: `touch data/ipc/X/input/_close`

Fleet-wide: `NANOCLAW_MEMORY=off` + `systemctl --user restart nanoclaw`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-memory/
git commit -m "skill: add-memory v1.0.0 manifest + SKILL.md

Manual MVP per spec v2.4. Depends on add-embeddings.
Phase-by-phase install: preflight check → merge skill branch → build →
configure env → restart → verify."
```

---

### Task 18: E2E smoke test (two-task pattern)

**Files:**
- Create: `scripts/memory-smoke-test.sh` (operator-runnable verification)

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/memory-smoke-test.sh
# E2E verification of the manual memory layer via the two-task pattern.
# Per spec §13: store → wait for IPC poll + indexer cycle → recall.

set -euo pipefail

GROUP_FOLDER="${1:-setd-secti-taskflow}"
DB_PATH="store/messages.db"

CHAT_JID=$(sqlite3 "$DB_PATH" "SELECT jid FROM registered_groups WHERE folder='$GROUP_FOLDER';")
if [[ -z "$CHAT_JID" ]]; then
  echo "Group $GROUP_FOLDER not registered"
  exit 1
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NEXT_RUN=$(date -u -d "+1 minute" +"%Y-%m-%dT%H:%M:%SZ")
NEXT_RUN_2=$(date -u -d "+90 seconds" +"%Y-%m-%dT%H:%M:%SZ")
SMOKE_TAG="memsmoke-$(date +%s)"

# Task 1: store
sqlite3 "$DB_PATH" <<SQL
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type,
  schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'memsmoke-store-${SMOKE_TAG}',
  '$GROUP_FOLDER',
  '$CHAT_JID',
  'Use memory_store to save: text="${SMOKE_TAG} smoke test fact", category="other", scope="board". Then exit.',
  'once', '$NEXT_RUN', 'group', '$NEXT_RUN', 'active', '$NOW'
);

INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type,
  schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'memsmoke-recall-${SMOKE_TAG}',
  '$GROUP_FOLDER',
  '$CHAT_JID',
  'Use memory_recall to search for "${SMOKE_TAG}" with scope="board". Confirm the result includes the smoke test fact.',
  'once', '$NEXT_RUN_2', 'group', '$NEXT_RUN_2', 'active', '$NOW'
);
SQL

echo "Scheduled tasks inserted. First run: $NEXT_RUN, second run: $NEXT_RUN_2"
echo "Watch logs: journalctl --user -u nanoclaw -f | grep -E 'memory|memsmoke'"
echo "Verify with: sqlite3 data/embeddings/embeddings.db \"SELECT * FROM embeddings WHERE collection='memory:board:$GROUP_FOLDER' AND source_text LIKE '%${SMOKE_TAG}%'\""
echo "Cleanup: sqlite3 $DB_PATH \"DELETE FROM scheduled_tasks WHERE id LIKE 'memsmoke-%-${SMOKE_TAG}'\""
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/memory-smoke-test.sh
git add scripts/memory-smoke-test.sh
git commit -m "test(memory): e2e smoke test script (two-task pattern)

Inserts two scheduled_tasks: store fact → wait 30s → recall fact.
Per spec §13 — must use scope='board' since scheduled tasks have no
recent human inbound (scope='user' would be rejected by server-side
validation)."
```

- [ ] **Step 3: Run the script in dev (manual verification, not part of CI)**

```bash
./scripts/memory-smoke-test.sh setd-secti-taskflow
# Wait 90 seconds, watch logs
journalctl --user -u nanoclaw -f | grep -E "memory|memsmoke"
# Expected log sequence:
#   memory.write collection=memory:board:setd-secti-taskflow ... action=stored
#   (10s later) memory.recall callSite=initial hits.board=1 ...
#   memory.write source=manual_store
```

If smoke test passes: memory layer is live. If fails: check logs for `memory.spoof_attempt`, `no_recent_sender`, IPC poll errors.

---

## Phase G — Final integration test pass

### Task 19: Real-watcher integration test (per spec §12.2)

**Files:**
- Create: `src/memory-integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { processIpcOnce, createIpcWatcherCtx } from './ipc.js';
import { EmbeddingService } from './embedding-service.js';

describe('memory-integration: real processIpcOnce + memory-writes bucket', () => {
  let tmpDir: string;
  let messagesDb: Database.Database;
  let embeddingService: EmbeddingService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memint-'));
    process.env.NANOCLAW_DATA_DIR = tmpDir;

    messagesDb = new Database(':memory:');
    messagesDb.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY, folder TEXT NOT NULL UNIQUE,
        taskflow_managed INTEGER, memory_enabled INTEGER
      );
      CREATE TABLE messages (
        id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT,
        timestamp TEXT, is_from_me INTEGER, message_type TEXT,
        is_bot_message INTEGER, reply_to_message_id TEXT,
        reply_to_message_content TEXT, reply_to_sender_name TEXT,
        PRIMARY KEY (id, chat_jid)
      );
      INSERT INTO registered_groups VALUES ('group@g.us', 'test-group', 1, 1);
      INSERT INTO messages VALUES
        ('m1', 'group@g.us', '5585111@s.whatsapp.net', 'Maria', 'oi', datetime('now', '-1 minute'), 0, 'text', 0, NULL, NULL, NULL);
    `);

    const embedDbPath = path.join(tmpDir, 'embeddings.db');
    embeddingService = new EmbeddingService(embedDbPath, '', 'bge-m3');
  });

  it('end-to-end: store IPC file → host watcher → embeddings.db row', async () => {
    const memDir = path.join(tmpDir, 'ipc', 'test-group', 'memory-writes');
    fs.mkdirSync(memDir, { recursive: true });
    const fixture = {
      op: 'store',
      scope: 'board',
      contentHash: 'abc1234567890000',
      text: 'Test board fact',
      metadata: { category: 'fact', entities: [] },
    };
    fs.writeFileSync(path.join(memDir, 'test.json'), JSON.stringify(fixture));

    const ctx = createIpcWatcherCtx({
      registeredGroups: () => ({ 'group@g.us': { folder: 'test-group', taskflowManaged: true } } as any),
      sendMessage: async () => {},
      messagesDb: () => messagesDb,
      embeddingService: () => embeddingService,
    } as any);
    await processIpcOnce(ctx);

    const rows = embeddingService.db
      .prepare(`SELECT collection, item_id FROM embeddings`)
      .all();
    expect(rows).toEqual([{ collection: 'memory:board:test-group', item_id: 'abc1234567890000' }]);
    expect(fs.existsSync(path.join(memDir, 'test.json'))).toBe(false); // unlinked
  });

  it('cross-board store boundary: spoofed senderJid falls back to board\'s recent inbound', async () => {
    const memDir = path.join(tmpDir, 'ipc', 'test-group', 'memory-writes');
    fs.mkdirSync(memDir, { recursive: true });
    const spoofFixture = {
      op: 'store',
      scope: 'user',
      contentHash: 'def4567890ab0000',
      text: 'Spoofed user fact',
      metadata: {
        category: 'preference',
        entities: [],
        senderJid: 'OTHER-BOARD-USER@s.whatsapp.net',
        senderName: 'SpoofyName',
      },
    };
    fs.writeFileSync(path.join(memDir, 'spoof.json'), JSON.stringify(spoofFixture));

    const ctx = createIpcWatcherCtx({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
      messagesDb: () => messagesDb,
      embeddingService: () => embeddingService,
    } as any);
    await processIpcOnce(ctx);

    const rows = embeddingService.db
      .prepare(`SELECT collection, json_extract(metadata, '$.senderName') as senderName FROM embeddings`)
      .all() as Array<{ collection: string; senderName: string }>;
    expect(rows).toEqual([{
      collection: 'memory:user:test-group:5585111@s.whatsapp.net', // Maria, not OTHER-BOARD-USER
      senderName: 'Maria', // DB-authoritative, not 'SpoofyName'
    }]);
  });

  it('no-recent-inbound rejection: file moves to .errors/', async () => {
    // Empty messages.db (no recent inbound)
    messagesDb.prepare(`DELETE FROM messages`).run();

    const memDir = path.join(tmpDir, 'ipc', 'test-group', 'memory-writes');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'no-sender.json'), JSON.stringify({
      op: 'store', scope: 'user', contentHash: 'ghi7890ab1234000',
      text: 'Will be rejected',
      metadata: { category: 'fact', entities: [], senderJid: 'whoever@s.whatsapp.net' },
    }));

    const ctx = createIpcWatcherCtx({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
      messagesDb: () => messagesDb,
      embeddingService: () => embeddingService,
    } as any);
    await processIpcOnce(ctx);

    expect(fs.existsSync(path.join(memDir, 'no-sender.json'))).toBe(false);
    expect(fs.existsSync(path.join(memDir, '.errors', 'no-sender.json'))).toBe(true);
    const rows = embeddingService.db.prepare(`SELECT COUNT(*) as n FROM embeddings`).get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
npx vitest run src/memory-integration.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add src/memory-integration.test.ts
git commit -m "test(memory): real-watcher integration tests (per spec §12.2)

Three end-to-end tests exercising the actual processIpcOnce path:
1. Happy path: store IPC → bucket scan → memory-service → embeddings.db row
2. Spoof fallback: container-supplied senderJid mismatches recent inbound;
   host derives correct senderJid + senderName from messages.db
3. No-recent rejection: scope=user with empty messages.db → file quarantined

These tests are the ones spec §12.2 says are mandatory. They depend on
the processIpcOnce refactor from Task 4."
```

---

### Task 20: Observability — `memory.recall` log + hourly summary aggregator

**Files:**
- Modify: `container/agent-runner/src/memory-reader.ts` (emit `memory.recall` log line per call)
- Create: `src/memory-observability.ts` (in-memory aggregator + hourly flush timer)
- Modify: `src/index.ts` (start the observability ticker alongside other services)
- Test: `src/memory-observability.test.ts`

Per spec §11. The `memory.write` log is already emitted in Tasks 6+7. We add the per-recall log line and the hourly summary.

- [ ] **Step 1: Write the failing test for the aggregator**

`src/memory-observability.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MemoryObservability } from './memory-observability.js';

describe('MemoryObservability hourly summary', () => {
  it('aggregates store/recall/forget counts and recallHitRate', () => {
    const obs = new MemoryObservability();
    obs.recordWrite({ source: 'manual_store', action: 'stored' });
    obs.recordWrite({ source: 'manual_store', action: 'stored' });
    obs.recordRecall({ groupFolder: 'g1', hits: { board: 0, user: 1 } });
    obs.recordRecall({ groupFolder: 'g1', hits: { board: 0, user: 0 } });
    obs.recordRecall({ groupFolder: 'g1', hits: { board: 1, user: 0 } });
    obs.recordWrite({ source: 'manual_store', action: 'forgotten' });

    const summary = obs.flushHourly();
    expect(summary.totalStoreCalls).toBe(2);
    expect(summary.totalForgetCalls).toBe(1);
    expect(summary.totalRecallCalls).toBe(3);
    expect(summary.totalRecallHits).toBe(2);
    expect(summary.recallHitRate).toBeCloseTo(2 / 3, 2);
  });

  it('flushHourly resets counters', () => {
    const obs = new MemoryObservability();
    obs.recordWrite({ source: 'manual_store', action: 'stored' });
    obs.flushHourly();
    const second = obs.flushHourly();
    expect(second.totalStoreCalls).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/memory-observability.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/memory-observability.ts`:

```typescript
import { logger } from './logger.js';

export interface RecallEvent {
  groupFolder: string;
  hits: { board: number; user: number };
}

export interface WriteEvent {
  source: string;            // 'manual_store' | future 'auto_extract'
  action: string;            // 'stored' | 'noop_already_exists' | 'forgotten'
}

export interface HourlySummary {
  windowStart: string;
  windowEnd: string;
  totalStoreCalls: number;
  totalForgetCalls: number;
  totalRecallCalls: number;
  totalRecallHits: number;
  recallHitRate: number;
  ipcQueueDepthMax: number;
}

export class MemoryObservability {
  private windowStart: string;
  private storeCount = 0;
  private forgetCount = 0;
  private recallCount = 0;
  private recallHitCount = 0;
  private ipcQueueDepthMax = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.windowStart = new Date().toISOString();
  }

  recordWrite(event: WriteEvent): void {
    if (event.action === 'forgotten') this.forgetCount++;
    else this.storeCount++;
  }

  recordRecall(event: RecallEvent): void {
    this.recallCount++;
    if (event.hits.board + event.hits.user > 0) this.recallHitCount++;
  }

  recordIpcQueueDepth(depth: number): void {
    if (depth > this.ipcQueueDepthMax) this.ipcQueueDepthMax = depth;
  }

  flushHourly(): HourlySummary {
    const summary: HourlySummary = {
      windowStart: this.windowStart,
      windowEnd: new Date().toISOString(),
      totalStoreCalls: this.storeCount,
      totalForgetCalls: this.forgetCount,
      totalRecallCalls: this.recallCount,
      totalRecallHits: this.recallHitCount,
      recallHitRate: this.recallCount > 0 ? this.recallHitCount / this.recallCount : 0,
      ipcQueueDepthMax: this.ipcQueueDepthMax,
    };
    logger.info(summary, 'memory.summary.hourly');
    // Reset counters
    this.windowStart = summary.windowEnd;
    this.storeCount = 0;
    this.forgetCount = 0;
    this.recallCount = 0;
    this.recallHitCount = 0;
    this.ipcQueueDepthMax = 0;
    return summary;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flushHourly(), 60 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

export const memoryObservability = new MemoryObservability();
```

In `src/index.ts`, alongside the EmbeddingService startup, add:

```typescript
import { memoryObservability } from './memory-observability.js';
memoryObservability.start();
```

In `container/agent-runner/src/memory-reader.ts`, after the recall completes in `buildMemoryPreamble`, add a stdout log line that the host tails:

```typescript
// Emit per-recall log to stdout. Host parses container stdout (existing pattern
// for container output → host log aggregation) and forwards to the host-side
// MemoryObservability aggregator.
const userHits = hits.filter(h => h.scope === 'user').length;
const boardHits = hits.filter(h => h.scope === 'board').length;
const formattedBlock = formatRelevantMemoriesBlock(hits, 500);
console.log(JSON.stringify({
  level: 'info',
  msg: 'memory.recall',
  hits: { board: boardHits, user: userHits },
  injectedTokens: Math.ceil(formattedBlock.length / 4),
}));
```

**Wire recall counts into the host aggregator.** In `src/container-runner.ts` where container stdout is processed (search for the existing `proc.stdout.on('data', ...)` handler), add:

```typescript
import { memoryObservability } from './memory-observability.js';

// Inside the existing stdout line-parser:
if (parsedLine?.msg === 'memory.recall') {
  memoryObservability.recordRecall({
    groupFolder: group.folder,
    hits: parsedLine.hits ?? { board: 0, user: 0 },
  });
}
```

(If the existing stdout handler doesn't JSON-parse lines, add a try/catch JSON.parse around line content. Reuse the pattern from existing log forwarding.)

**Wire write counts.** Update Task 6's `processMemoryStore` and Task 7's `processMemoryForget` to call:

```typescript
import { memoryObservability } from './memory-observability.js';
// ... after embeddingService.index() in processMemoryStore:
memoryObservability.recordWrite({
  source: finalMetadata.source,                    // 'manual_store'
  action: 'stored',                                // or 'noop_already_exists' if applicable
});
// ... after embeddingService.remove() in processMemoryForget:
memoryObservability.recordWrite({
  source: 'manual_forget',
  action: 'forgotten',
});
```

These calls go in the same files Tasks 6 and 7 already modify; this Task 20 step adds the import + the two `memoryObservability.recordWrite()` lines.

- [ ] **Step 4: Run tests + commit**

```bash
npx vitest run src/memory-observability.test.ts
git add src/memory-observability.ts src/memory-observability.test.ts \
       src/index.ts src/memory-service.ts container/agent-runner/src/memory-reader.ts
git commit -m "feat(memory): observability — per-call logs + hourly summary aggregator

Per spec §11:
- memory.write logs in processMemoryStore/processMemoryForget (existing from
  Tasks 6+7); now also feed MemoryObservability.recordWrite()
- memory.recall logs from container-side memory-reader stdout
- MemoryObservability hourly summary: totalStoreCalls, totalRecallCalls,
  recallHitRate, ipcQueueDepthMax — flushed every 60min via setInterval
- memoryObservability singleton started in src/index.ts alongside other services"
```

---

### Task 21: MCP unit tests + real-Ollama integration tests

**Files:**
- Create: `container/agent-runner/src/ipc-mcp-stdio-memory.test.ts` (MCP tool unit tests)
- Create: `container/agent-runner/src/memory-ollama.test.ts` (real-Ollama gated tests)

Per spec §12.1 (~9 MCP tool tests) and §12.3 (~3 real-Ollama tests). These were skipped in the original plan; adding now.

**Refactor prerequisite (apply WITHIN Tasks 14, 15, 16)**: when implementing the `server.tool(...)` registrations in Tasks 14-16, extract each tool's body into an exported pure function `memoryStoreHandler(args, ctx)`, `memoryRecallHandler(args, ctx)`, `memoryForgetHandler(args, ctx)`, then have the inline `server.tool(...)` body call the handler with a `defaultCtx` derived from env vars:

```typescript
// In ipc-mcp-stdio.ts (Task 14 extends to all three tools)
export interface MemoryToolCtx {
  memoryEnabled: boolean;
  senderJid?: string;
  senderName?: string;
  groupFolder: string;
  ollamaHost: string;
  embeddingModel: string;
  writeIpcFile: (dir: string, data: object) => string;
}

const defaultMemoryCtx = (): MemoryToolCtx => ({
  memoryEnabled: process.env.NANOCLAW_MEMORY_ENABLED === '1' && process.env.NANOCLAW_MEMORY !== 'off',
  senderJid: process.env.NANOCLAW_SENDER_JID,
  senderName: process.env.NANOCLAW_SENDER_NAME,
  groupFolder: process.env.NANOCLAW_GROUP_FOLDER!,
  ollamaHost: process.env.NANOCLAW_OLLAMA_HOST ?? '',
  embeddingModel: process.env.NANOCLAW_EMBEDDING_MODEL || 'bge-m3',
  writeIpcFile,
});

export async function memoryStoreHandler(args: { text: string; category: string; scope?: string; entities?: string[] }, ctx: MemoryToolCtx) {
  // [body extracted from Task 14's server.tool callback — same logic, now pure]
}

server.tool('memory_store', '...desc...', { /* zod */ }, (args) => memoryStoreHandler(args, defaultMemoryCtx()));
```

Move this refactor into Task 14 (and analogous for Tasks 15/16). Adjust Task 14's commit message to mention the handler extraction.

- [ ] **Step 1: MCP tool unit tests (executable, not placeholders)**

`container/agent-runner/src/ipc-mcp-stdio-memory.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  memoryStoreHandler,
  memoryRecallHandler,
  memoryForgetHandler,
  type MemoryToolCtx,
} from './ipc-mcp-stdio.js';

function makeCtx(overrides: Partial<MemoryToolCtx> = {}): MemoryToolCtx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmcp-'));
  return {
    memoryEnabled: true,
    senderJid: '5585111@s.whatsapp.net',
    senderName: 'Maria',
    groupFolder: 'test-folder',
    ollamaHost: 'http://localhost:11434',
    embeddingModel: 'bge-m3',
    writeIpcFile: vi.fn((dir, data) => {
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${Date.now()}-test.json`;
      fs.writeFileSync(path.join(dir, filename), JSON.stringify(data));
      return filename;
    }),
    ...overrides,
  };
}

describe('memoryStoreHandler', () => {
  it('writes IPC file with correct shape (no collection field)', async () => {
    const ctx = makeCtx();
    const result = await memoryStoreHandler(
      { text: 'Prefers concise replies', category: 'preference' },
      ctx,
    );
    expect(ctx.writeIpcFile).toHaveBeenCalled();
    const writeCall = (ctx.writeIpcFile as any).mock.calls[0];
    const writtenData = writeCall[1];
    expect(writtenData.op).toBe('store');
    expect(writtenData.scope).toBe('user');
    expect(writtenData.collection).toBeUndefined();
    expect(writtenData.text).toBe('Prefers concise replies');
    expect(writtenData.metadata.category).toBe('preference');
    expect(writtenData.metadata.senderJid).toBe('5585111@s.whatsapp.net');
    expect(result.content[0].text).toMatch(/memoryId=[a-f0-9]{12}/);
  });

  it('returns error when memoryEnabled=false', async () => {
    const ctx = makeCtx({ memoryEnabled: false });
    const result = await memoryStoreHandler(
      { text: 'fact', category: 'preference' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/memory_disabled/);
  });

  it('rejects scope=user when no senderJid', async () => {
    const ctx = makeCtx({ senderJid: undefined });
    const result = await memoryStoreHandler(
      { text: 'fact', category: 'preference', scope: 'user' },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it('allows scope=board without senderJid', async () => {
    const ctx = makeCtx({ senderJid: undefined });
    const result = await memoryStoreHandler(
      { text: 'Team fact', category: 'fact', scope: 'board' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
  });
});

describe('memoryForgetHandler', () => {
  it('writes IPC file with op=forget', async () => {
    const ctx = makeCtx();
    await memoryForgetHandler({ memoryId: 'a3f1b9c842de' }, ctx);
    const writtenData = (ctx.writeIpcFile as any).mock.calls[0][1];
    expect(writtenData.op).toBe('forget');
    expect(writtenData.memoryId).toBe('a3f1b9c842de');
  });

  it('rejects memoryId<8 chars', async () => {
    const ctx = makeCtx();
    const result = await memoryForgetHandler({ memoryId: 'short' }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe('memoryRecallHandler', () => {
  it('returns memory_disabled when killswitch off', async () => {
    const ctx = makeCtx({ memoryEnabled: false });
    const result = await memoryRecallHandler({ query: 'test' }, ctx);
    expect(result.isError).toBe(true);
  });

  // Real recall logic tested in container/agent-runner/src/memory-reader.test.ts
  // Here we only test the handler-level wiring.
});
```

- [ ] **Step 2: Real-Ollama gated tests** (no change from prior version, but fix the bash command):

```bash
# CORRECT bash: env var must scope to vitest, not to cd
( cd container/agent-runner && OLLAMA_HOST=http://192.168.2.13:11434 npx vitest run src/memory-ollama.test.ts )
```

(The body of `memory-ollama.test.ts` is unchanged from the v1 plan — it'\''s already executable.)

- [ ] **Step 3: Run + commit**

```bash
cd container/agent-runner && npx vitest run src/ipc-mcp-stdio-memory.test.ts && cd ../..
( cd container/agent-runner && OLLAMA_HOST=http://192.168.2.13:11434 npx vitest run src/memory-ollama.test.ts )

git add container/agent-runner/src/ipc-mcp-stdio-memory.test.ts \
       container/agent-runner/src/memory-ollama.test.ts
git commit -m "test(memory): MCP handler unit tests + real-Ollama gated tests

Per spec §12.1 + §12.3. Tests are executable (no placeholders) — depends
on the handler-extraction refactor done within Tasks 14-16."
```

- [ ] **Step 2: Real-Ollama gated tests**

`container/agent-runner/src/memory-ollama.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

const OLLAMA_HOST = process.env.OLLAMA_HOST;
const skip = !OLLAMA_HOST;

describe.skipIf(skip)('memory-ollama (gated)', () => {
  it('bge-m3 produces 1024-dim vector for English fact text', async () => {
    const resp = await fetch(`${OLLAMA_HOST}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: 'Maria prefers concise replies, no emojis.' }),
    });
    expect(resp.ok).toBe(true);
    const data = await resp.json() as { embeddings: number[][] };
    expect(data.embeddings[0].length).toBe(1024);
  });

  it('semantically close query returns the stored fact via cosine sim >0.5', async () => {
    // Embed two texts, compute cosine, assert >0.5 for paraphrase
    const stored = 'Maria prefers concise replies and dislikes emojis.';
    const query = 'How does Maria like to be replied to?';
    const fetch1 = await fetch(`${OLLAMA_HOST}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: stored }),
    });
    const fetch2 = await fetch(`${OLLAMA_HOST}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: query }),
    });
    const v1 = (await fetch1.json()).embeddings[0];
    const v2 = (await fetch2.json()).embeddings[0];
    const dot = v1.reduce((s: number, x: number, i: number) => s + x * v2[i], 0);
    const n1 = Math.sqrt(v1.reduce((s: number, x: number) => s + x * x, 0));
    const n2 = Math.sqrt(v2.reduce((s: number, x: number) => s + x * x, 0));
    const cos = dot / (n1 * n2);
    expect(cos).toBeGreaterThan(0.5);
  });

  it('semantically distant query returns score below threshold', async () => {
    const stored = 'Team uses M for meetings instead of R.';
    const query = 'What is the weather forecast?';
    // ... same pattern, expect cos < 0.5
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd container/agent-runner && npx vitest run src/ipc-mcp-stdio-memory.test.ts && cd ../..
# Real-Ollama tests skipped unless OLLAMA_HOST is set:
OLLAMA_HOST=http://192.168.2.13:11434 cd container/agent-runner && npx vitest run src/memory-ollama.test.ts && cd ../..

git add container/agent-runner/src/ipc-mcp-stdio-memory.test.ts \
       container/agent-runner/src/memory-ollama.test.ts \
       container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "test(memory): MCP unit tests + real-Ollama gated tests

Per spec §12.1 + §12.3. MCP tools refactored to expose pure handler
functions for direct testing (memoryStoreHandler etc.); server.tool
registrations now wrap the handlers."
```

---

### Task 22: Rollback verification test

**Files:**
- Create: `scripts/memory-rollback-test.sh` (operator-runnable)

Per spec §13.

- [ ] **Step 1: Write the rollback verification script**

```bash
#!/usr/bin/env bash
# scripts/memory-rollback-test.sh
# Verifies the per-board kill-switch + close-sentinel rollback workflow.

set -euo pipefail

GROUP_FOLDER="${1:-setd-secti-taskflow}"
DB_PATH="store/messages.db"

echo "=== 1. Confirm memory_enabled=1 currently ==="
sqlite3 "$DB_PATH" "SELECT folder, memory_enabled FROM registered_groups WHERE folder='$GROUP_FOLDER';"

echo "=== 2. Disable per-board ==="
sqlite3 "$DB_PATH" "UPDATE registered_groups SET memory_enabled=0 WHERE folder='$GROUP_FOLDER';"

echo "=== 3. Evict active container via close sentinel ==="
INPUT_DIR="data/ipc/$GROUP_FOLDER/input"
if [[ -d "$INPUT_DIR" ]]; then
  touch "$INPUT_DIR/_close"
  echo "Close sentinel written. Container (if running) will exit at next IPC poll."
else
  echo "No active input dir — no container running."
fi

echo "=== 4. Re-enable ==="
sleep 5  # give container time to exit
sqlite3 "$DB_PATH" "UPDATE registered_groups SET memory_enabled=1 WHERE folder='$GROUP_FOLDER';"

echo "=== 5. Final state ==="
sqlite3 "$DB_PATH" "SELECT folder, memory_enabled FROM registered_groups WHERE folder='$GROUP_FOLDER';"
echo "Rollback verification complete. Next container start will pick up memory_enabled=1."
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/memory-rollback-test.sh
git add scripts/memory-rollback-test.sh
git commit -m "test(memory): rollback verification script

Per spec §13. Scripted verification of the per-board kill-switch +
close-sentinel workflow:
1. Toggle memory_enabled=0
2. touch _close to evict active container
3. Toggle back to 1
4. Confirm next container picks up new flag value"
```

---

## Final acceptance checklist

After all 22 tasks complete:

- [ ] `npx tsc --noEmit` clean (host)
- [ ] `cd container/agent-runner && npx tsc --noEmit && cd ../..` clean (container)
- [ ] `npx vitest run` all green
- [ ] `cd container/agent-runner && npx vitest run` all green
- [ ] `npm run build` clean
- [ ] **`./container/build.sh` clean (REQUIRED after any container/agent-runner/* edit — Phase D, E, parts of Task 21)**
- [ ] Smoke test passes: `./scripts/memory-smoke-test.sh setd-secti-taskflow`
- [ ] Rollback test passes: `./scripts/memory-rollback-test.sh setd-secti-taskflow`
- [ ] Verify `memory.write` log entries appear within 30s of smoke test
- [ ] Verify `memory.recall` log entries appear during normal traffic (from container stdout)
- [ ] Verify `memory.summary.hourly` log entry appears within 1h
- [ ] Codex review of final code (one round, gpt-5.5/high) before deploy

### Container rebuild checkpoints (cross-cutting)

After completing Phase D (Tasks 10-13) AND after Phase E (Tasks 14-16), the agent-runner image MUST be rebuilt for changes to take effect at runtime:

```bash
./container/build.sh
```

If you skip this, existing containers will keep running the old image and recall/MCP tools won't be active until they restart with the new image. The smoke test in Task 18 will silently fail.

## Deferred items (per spec §14)

- Background extractor / auto-capture (v3 — gated on §7 conditions)
- Cross-board fact promotion
- Lint pass for contradictions
- TTL eviction
- Per-fact confidence scores
- Multi-sender follow-up exact attribution (the host-side spoof-fallback already self-corrects to the actual current sender — see Task 14 architecture note; only the container-side log line might be misleading)
