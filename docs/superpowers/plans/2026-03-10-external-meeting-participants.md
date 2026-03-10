# External Meeting Participants Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Fully implemented. All 18 tasks (91 checkboxes) are complete.

**Goal:** Allow external (non-board) contacts to be invited to TaskFlow meetings and interact via WhatsApp DM with meeting-scoped access.

**Architecture:** Two-layer implementation. Phase 0 extends the core runtime (`src/index.ts`, `src/ipc.ts`) to support DM send/receive for known external contacts. Phases 1–6 add the data model, engine logic, invite flow, and prompt/UX to the `add-taskflow` skill package. External contacts are stored cross-board in `taskflow.db`. Inbound DMs are routed to the meeting's board group container by looking up active grants. If more than one active grant exists, the orchestrator must disambiguate before routing. Cold-start DM delivery must use an explicit trigger-bypass path in the orchestrator, not synthetic group messages that rely on normal trigger detection.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest, Zod schemas, WhatsApp Baileys (existing channel layer)

**Spec:** `docs/plans/2026-03-10-taskflow-external-meeting-participants-design.md`

---

## File Structure

### Core runtime (Phase 0)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/dm-routing.ts` | Create | External-contact DM routing: lookup `taskflow.db` for `external_contacts` + `meeting_external_participants`, resolve DM JID to board group container |
| `src/dm-routing.test.ts` | Create | Tests for DM routing logic |
| `src/index.ts` | Modify | Wire DM routing into `onMessage` callback and message loop |
| `src/ipc.ts` | Modify | Authorize DM-targeted IPC messages from TaskFlow containers |

### Skill layer (Phases 1–6)

| File | Action | Responsibility |
|------|--------|----------------|
| `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` | Modify | New tables, external participant CRUD, note authorship, notification recipients, occurrence key cascade |
| `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts` | Modify | Relax `@g.us` JID validation, extend `dispatchNotifications` for DM targets, add `sender_external_id` to tool params |
| `.claude/skills/add-taskflow/templates/CLAUDE.md.template` | Modify | Document external participant commands, DM interaction guide |
| `.claude/skills/add-taskflow/tests/taskflow.test.ts` | Modify | Tests for external participant engine logic |

---

## Chunk 1: Phase 0 — DM Transport (Core Runtime)

### Task 1: DM Routing Module

**Files:**
- Create: `src/dm-routing.ts`
- Create: `src/dm-routing.test.ts`

This module provides a function that takes a DM JID and returns the board group JID to route to (or null). It uses a cached `taskflow.db` handle to query `external_contacts` and `meeting_external_participants`. Because the plan uses lazy expiry and `direct_chat_jid` backfill, this DB handle must be writable; a true read-only connection would not support the proposed updates.

- [x] **Step 1: Write the failing test for `resolveExternalDm`**

In `src/dm-routing.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolveExternalDm, type DmRouteResult } from './dm-routing.js';

function seedDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_contacts (
      external_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      direct_chat_jid TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meeting_external_participants (
      board_id TEXT NOT NULL,
      meeting_task_id TEXT NOT NULL,
      occurrence_scheduled_at TEXT NOT NULL,
      external_id TEXT NOT NULL,
      invite_status TEXT NOT NULL,
      invited_at TEXT,
      accepted_at TEXT,
      revoked_at TEXT,
      access_expires_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (board_id, meeting_task_id, occurrence_scheduled_at, external_id)
    );
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      group_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      board_role TEXT DEFAULT 'standard',
      hierarchy_level INTEGER,
      max_depth INTEGER,
      parent_board_id TEXT,
      short_code TEXT
    );
  `);
  db.exec(`
    INSERT INTO external_contacts VALUES ('ext-1', 'Maria', '5585999991234', '5585999991234@s.whatsapp.net', 'active', '2026-01-01', '2026-01-01', NULL);
    INSERT INTO boards VALUES ('board-1', '120363408855255405@g.us', 'team-alpha', 'standard', NULL, NULL, NULL);
    INSERT INTO meeting_external_participants VALUES ('board-1', 'M1', '2026-03-12T14:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, '2026-03-19T14:00:00Z', 'person-1', '2026-03-10', '2026-03-10');
  `);
}

describe('resolveExternalDm', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resolves a known DM JID to the board group', () => {
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.groupJid).toBe('120363408855255405@g.us');
    expect(result!.groupFolder).toBe('team-alpha');
    expect(result!.externalId).toBe('ext-1');
    expect(result!.grants).toHaveLength(1);
    expect(result!.grants[0].meetingTaskId).toBe('M1');
  });

  it('returns null for unknown DM JID', () => {
    const result = resolveExternalDm(db, '5585000000000@s.whatsapp.net');
    expect(result).toBeNull();
  });

  it('returns null for expired grants', () => {
    db.exec(`UPDATE meeting_external_participants SET invite_status = 'expired'`);
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).toBeNull();
  });

  it('returns null for revoked grants', () => {
    db.exec(`UPDATE meeting_external_participants SET invite_status = 'revoked'`);
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).toBeNull();
  });

  it('returns multiple grants when contact is in multiple meetings', () => {
    db.exec(`INSERT INTO meeting_external_participants VALUES ('board-1', 'M2', '2026-03-15T10:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, '2026-03-22T10:00:00Z', 'person-1', '2026-03-10', '2026-03-10')`);
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.grants).toHaveLength(2);
  });

  it('performs lazy expiry when access_expires_at is past', () => {
    db.exec(`UPDATE meeting_external_participants SET access_expires_at = '2020-01-01T00:00:00Z', invite_status = 'accepted'`);
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).toBeNull();
    // Verify status was updated to expired
    const row = db.prepare(`SELECT invite_status FROM meeting_external_participants`).get() as any;
    expect(row.invite_status).toBe('expired');
  });

  it('flags needsDisambiguation when more than one active grant exists', () => {
    db.exec(`INSERT INTO boards VALUES ('board-2', '999999999@g.us', 'team-beta', 'standard', NULL, NULL, NULL, NULL)`);
    db.exec(`INSERT INTO meeting_external_participants VALUES ('board-2', 'M5', '2026-03-20T10:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, '2026-03-27T10:00:00Z', 'person-2', '2026-03-10', '2026-03-10')`);
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.needsDisambiguation).toBe(true);
  });

  it('also flags needsDisambiguation for multiple meetings on the same board', () => {
    db.exec(`INSERT INTO meeting_external_participants VALUES ('board-1', 'M2', '2026-03-15T10:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, '2026-03-22T10:00:00Z', 'person-1', '2026-03-10', '2026-03-10')`);
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.needsDisambiguation).toBe(true);
  });

  it('resolves by phone fallback when direct_chat_jid is null', () => {
    db.exec(`UPDATE external_contacts SET direct_chat_jid = NULL`);
    // Phone-based lookup: strip @s.whatsapp.net and match
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.externalId).toBe('ext-1');
    // Verify direct_chat_jid was backfilled
    const row = db.prepare(`SELECT direct_chat_jid FROM external_contacts WHERE external_id = 'ext-1'`).get() as any;
    expect(row.direct_chat_jid).toBe('5585999991234@s.whatsapp.net');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dm-routing.test.ts`
Expected: FAIL — module `./dm-routing.js` does not exist

- [x] **Step 3: Write minimal implementation**

In `src/dm-routing.ts`:

```typescript
import type Database from 'better-sqlite3';

export interface DmGrant {
  boardId: string;
  meetingTaskId: string;
  occurrenceScheduledAt: string;
  inviteStatus: string;
  accessExpiresAt: string | null;
}

export interface DmRouteResult {
  externalId: string;
  displayName: string;
  groupJid: string;
  groupFolder: string;
  grants: DmGrant[];
  /** True when grants span multiple boards — orchestrator must send disambiguation prompt, not route. */
  needsDisambiguation: boolean;
}

/**
 * Resolve an inbound DM JID to a board group for routing.
 * Returns null if the sender has no active external-contact grants.
 * Performs lazy expiry: if access_expires_at is past, updates status to 'expired'.
 */
export function resolveExternalDm(
  db: Database.Database,
  dmJid: string,
): DmRouteResult | null {
  // 1. Resolve external contact by direct_chat_jid
  let contact = db
    .prepare(
      `SELECT external_id, display_name, phone FROM external_contacts
       WHERE direct_chat_jid = ? AND status = 'active'`,
    )
    .get(dmJid) as
    | { external_id: string; display_name: string; phone: string }
    | undefined;

  // 2. Fallback: extract phone from JID and match
  if (!contact) {
    const phone = dmJid.replace(/@s\.whatsapp\.net$/, '');
    contact = db
      .prepare(
        `SELECT external_id, display_name, phone FROM external_contacts
         WHERE phone = ? AND status = 'active'`,
      )
      .get(phone) as
      | { external_id: string; display_name: string; phone: string }
      | undefined;

    // Backfill direct_chat_jid for future fast lookups
    if (contact) {
      db.prepare(
        `UPDATE external_contacts SET direct_chat_jid = ?, updated_at = ?
         WHERE external_id = ?`,
      ).run(dmJid, new Date().toISOString(), contact.external_id);
    }
  }

  if (!contact) return null;

  // 3. Find active grants
  const now = new Date().toISOString();
  const grants = db
    .prepare(
      `SELECT mep.board_id, mep.meeting_task_id, mep.occurrence_scheduled_at,
              mep.invite_status, mep.access_expires_at,
              b.group_jid, b.group_folder
       FROM meeting_external_participants mep
       JOIN boards b ON b.id = mep.board_id
       WHERE mep.external_id = ?
         AND mep.invite_status IN ('accepted', 'invited', 'pending')`,
    )
    .all(contact.external_id) as Array<{
    board_id: string;
    meeting_task_id: string;
    occurrence_scheduled_at: string;
    invite_status: string;
    access_expires_at: string | null;
    group_jid: string;
    group_folder: string;
  }>;

  // 4. Lazy expiry check
  const active: typeof grants = [];
  for (const g of grants) {
    if (g.access_expires_at && g.access_expires_at < now) {
      db.prepare(
        `UPDATE meeting_external_participants
         SET invite_status = 'expired', updated_at = ?
         WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ? AND external_id = ?`,
      ).run(now, g.board_id, g.meeting_task_id, g.occurrence_scheduled_at, contact.external_id);
    } else {
      active.push(g);
    }
  }

  if (active.length === 0) return null;

  // 5. Any contact with more than one active grant must disambiguate before routing.
  const primary = active[0];
  return {
    externalId: contact.external_id,
    displayName: contact.display_name,
    groupJid: primary.group_jid,
    groupFolder: primary.group_folder,
    grants: active.map((g) => ({
      boardId: g.board_id,
      meetingTaskId: g.meeting_task_id,
      occurrenceScheduledAt: g.occurrence_scheduled_at,
      inviteStatus: g.invite_status,
      accessExpiresAt: g.access_expires_at,
    })),
    needsDisambiguation: active.length > 1,
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dm-routing.test.ts`
Expected: All tests PASS

- [x] **Step 5: Commit**

```bash
git add src/dm-routing.ts src/dm-routing.test.ts
git commit -m "feat: add DM routing module for external meeting participants"
```

---

### Task 2: IPC DM Authorization

**Files:**
- Modify: `src/ipc.ts:411-437`
- Create: `src/ipc-dm-auth.test.ts` (or extend existing test)

Extend the IPC message authorization block to allow TaskFlow containers to send to DM JIDs (`@s.whatsapp.net`) that belong to known external contacts with active grants.

- [x] **Step 1: Extract authorization into testable function and write failing test**

First, extract the IPC message authorization decision into a pure function in `src/ipc.ts`:

```typescript
/** Determine if an IPC message from sourceGroup is authorized to target chatJid. */
export function isIpcMessageAuthorized(opts: {
  chatJid: string;
  sourceGroup: string;
  isMain: boolean;
  isTaskflow: boolean;
  isKnownExternalDm: boolean;
  registeredGroups: Record<string, RegisteredGroup>;
}): 'group' | 'dm' | false {
  const targetGroup = opts.registeredGroups[opts.chatJid];
  if (
    targetGroup &&
    (opts.isMain ||
      targetGroup.folder === opts.sourceGroup ||
      (opts.isTaskflow && targetGroup.taskflowManaged))
  ) {
    return 'group';
  }
  const isDmTarget = !targetGroup && opts.chatJid.endsWith('@s.whatsapp.net');
  if (
    isDmTarget &&
    opts.isKnownExternalDm &&
    (opts.isMain || opts.isTaskflow)
  ) {
    return 'dm';
  }
  return false;
}
```

Then write the test in `src/ipc-dm-auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isIpcMessageAuthorized } from './ipc.js';
import type { RegisteredGroup } from './types.js';

const groups: Record<string, RegisteredGroup> = {
  '120363408855255405@g.us': {
    name: 'Team', folder: 'team-alpha', trigger: '@Case',
    added_at: '2026-01-01', taskflowManaged: true,
  },
};

describe('isIpcMessageAuthorized', () => {
  it('allows TaskFlow container to send to DM JID', () => {
    expect(isIpcMessageAuthorized({
      chatJid: '5585999991234@s.whatsapp.net',
      sourceGroup: 'team-alpha',
      isMain: false, isTaskflow: true,
      isKnownExternalDm: true,
      registeredGroups: groups,
    })).toBe('dm');
  });

  it('blocks non-TaskFlow container from sending to DM JID', () => {
    expect(isIpcMessageAuthorized({
      chatJid: '5585999991234@s.whatsapp.net',
      sourceGroup: 'team-alpha',
      isMain: false, isTaskflow: false,
      isKnownExternalDm: true,
      registeredGroups: groups,
    })).toBe(false);
  });

  it('allows main group to send to DM JID', () => {
    expect(isIpcMessageAuthorized({
      chatJid: '5585999991234@s.whatsapp.net',
      sourceGroup: 'main',
      isMain: true, isTaskflow: false,
      isKnownExternalDm: true,
      registeredGroups: groups,
    })).toBe('dm');
  });

  it('blocks unknown DM target even for TaskFlow container', () => {
    expect(isIpcMessageAuthorized({
      chatJid: '5585000000000@s.whatsapp.net',
      sourceGroup: 'team-alpha',
      isMain: false, isTaskflow: true,
      isKnownExternalDm: false,
      registeredGroups: groups,
    })).toBe(false);
  });

  it('allows group-to-group for TaskFlow', () => {
    expect(isIpcMessageAuthorized({
      chatJid: '120363408855255405@g.us',
      sourceGroup: 'other-group',
      isMain: false, isTaskflow: true,
      isKnownExternalDm: false,
      registeredGroups: groups,
    })).toBe('group');
  });

  it('blocks non-registered group target', () => {
    expect(isIpcMessageAuthorized({
      chatJid: '999999@g.us',
      sourceGroup: 'team-alpha',
      isMain: false, isTaskflow: true,
      isKnownExternalDm: false,
      registeredGroups: groups,
    })).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ipc-dm-auth.test.ts`
Expected: FAIL — `isIpcMessageAuthorized` not found

- [x] **Step 3: Implement `isIpcMessageAuthorized` and refactor IPC message authorization**

Add the `isIpcMessageAuthorized` function to `src/ipc.ts` (exported).

Then in the IPC message processing block (around line 416-437), replace the inline authorization with a call to the extracted function:

```typescript
const authResult = isIpcMessageAuthorized({
  chatJid: data.chatJid,
  sourceGroup,
  isMain,
  isTaskflow,
  isKnownExternalDm: typeof data.chatJid === 'string' &&
    data.chatJid.endsWith('@s.whatsapp.net') &&
    /* companion lookup against taskflow.db / dm-routing helper */
    isKnownExternalDm(data.chatJid),
  registeredGroups,
});

if (authResult === 'group') {
  const targetGroup = registeredGroups[data.chatJid];
  const sender =
    typeof data.sender === 'string'
      ? data.sender
      : getGroupSenderName(targetGroup.trigger);
  await deps.sendMessage(data.chatJid, data.text, sender);
  logger.info(
    { chatJid: data.chatJid, sourceGroup },
    'IPC message sent',
  );
} else if (authResult === 'dm') {
  const sender =
    typeof data.sender === 'string' ? data.sender : undefined;
  await deps.sendMessage(data.chatJid, data.text, sender);
  logger.info(
    { chatJid: data.chatJid, sourceGroup },
    'IPC DM message sent to external contact',
  );
} else {
  logger.warn(
    { chatJid: data.chatJid, sourceGroup },
    'Unauthorized IPC message attempt blocked',
  );
}
```

- [x] **Step 4: Run existing IPC tests + new test**

Run: `npx vitest run src/ipc`
Expected: All PASS

- [x] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc-dm-auth.test.ts
git commit -m "feat: authorize DM-targeted IPC messages from TaskFlow containers"
```

---

### Task 3: Inbound DM Processing in Orchestrator

**Files:**
- Modify: `src/index.ts:545-561` (onMessage callback)
- Modify: `src/index.ts:408-433` (message loop)
- Uses: `src/dm-routing.ts`

Wire the DM routing module into the orchestrator so inbound DMs from external contacts are stored, and the message loop routes them to the correct board group container.

- [x] **Step 1: Keep `onMessage` DM ingestion unchanged, but make the intent explicit**

In `src/index.ts`, the current `onMessage` callback already stores messages for unregistered JIDs; the sender allowlist is only applied when `registeredGroups[chatJid]` exists. That means raw DM ingestion already works and does **not** need a new external-contact gate in `onMessage`.

```typescript
onMessage: (chatJid: string, msg: NewMessage) => {
  if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
    // group-only allowlist check
  }
  storeMessage(msg);
},
```

Required clarification:
- keep the allowlist scoped to registered groups only
- do **not** add DM allowlist checks in `onMessage`
- perform external-contact authorization later in the DM routing path via `resolveExternalDm`

- [x] **Step 2: Add `getDmMessages` to `src/db.ts` and `openTaskflowDb` to `src/dm-routing.ts`**

In `src/db.ts`, add:

```typescript
export function getDmMessages(
  lastTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  const sql = `
    SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content, m.timestamp
    FROM messages m
    JOIN chats c ON c.jid = m.chat_jid
    WHERE m.timestamp > ? AND c.is_group = 0
      AND m.is_bot_message = 0 AND m.is_from_me = 0
      AND m.content NOT LIKE ?
      AND m.content != '' AND m.content IS NOT NULL
    ORDER BY m.timestamp
  `;
  return db.prepare(sql).all(lastTimestamp, `${botPrefix}:%`) as NewMessage[];
}
```

Note: `is_from_me = 0` filter prevents the bot's own DM replies from being re-ingested.

In `src/dm-routing.ts`, add a cached DB opener:

```typescript
import Database from 'better-sqlite3';
import path from 'path';

let _taskflowDb: Database.Database | null = null;

/** Lazily open taskflow.db and cache the handle. Writable access is required for lazy expiry/backfill. */
export function getTaskflowDb(dataDir: string): Database.Database | null {
  if (_taskflowDb) return _taskflowDb;
  const dbPath = path.join(dataDir, 'taskflow', 'taskflow.db');
  try {
    _taskflowDb = new Database(dbPath);
    return _taskflowDb;
  } catch {
    return null;
  }
}
```

- [x] **Step 3: Modify message loop to process external DMs**

In `src/index.ts`, after the existing group message processing loop (around line 489), add DM processing. The `getNewMessages` call at line 411 only queries registered group JIDs, so DMs won't appear there.

Add a `lastDmTimestamp` state variable alongside the existing `lastTimestamp` (around line 86):

```typescript
let lastDmTimestamp = '';
```

Persist and restore it alongside `lastTimestamp` in `saveState`/`loadState`.

Then add a DM polling path after the group message loop (around line 489), before the `catch` block:

```typescript
// Check for DM messages from external contacts
const dmMessages = getDmMessages(lastDmTimestamp, ASSISTANT_NAME);
if (dmMessages.length > 0) {
  const taskflowDb = getTaskflowDb(DATA_DIR);
  if (taskflowDb) {
    for (const msg of dmMessages) {
      const route = resolveExternalDm(taskflowDb, msg.chat_jid);
      if (!route) continue;

      if (route.needsDisambiguation) {
        // More than one active grant: send disambiguation prompt via DM
        const meetingList = route.grants.map(g => g.meetingTaskId).join(', ');
        const channel = findChannel(channels, msg.chat_jid);
        if (channel) {
          channel.sendMessage(
            msg.chat_jid,
            `Você participa de várias reuniões (${meetingList}). Inclua o ID da reunião no comando, ex: "pauta M1".`,
          );
        }
        continue;
      }

      const groupJid = route.groupJid;
      const group = registeredGroups[groupJid];
      if (!group) {
        logger.warn({ dmJid: msg.chat_jid, groupJid }, 'DM route target group not registered');
        continue;
      }

      // Format as external participant message with metadata
      const formatted = formatMessages([msg]);
      const externalContext = `[External participant: ${route.displayName} (${route.externalId}), active grants: ${route.grants.map(g => g.meetingTaskId).join(', ')}]\n${formatted}`;

      // Try piping to active container first.
      // If none is active, stage the prompt in a pending-external-DM queue and
      // enqueue the group for a trigger-bypassed processing pass.
      if (!queue.sendMessage(groupJid, externalContext)) {
        const staged = pendingExternalDmPrompts.get(groupJid) ?? [];
        staged.push({ timestamp: msg.timestamp, prompt: externalContext });
        pendingExternalDmPrompts.set(groupJid, staged);
        queue.enqueueMessageCheck(groupJid);
        logger.info({ dmJid: msg.chat_jid, groupJid }, 'DM staged for trigger-bypassed processing and enqueued');
      } else {
        logger.info({ dmJid: msg.chat_jid, groupJid }, 'DM piped to active container');
      }
    }
  }
  // Advance DM cursor
  lastDmTimestamp = dmMessages[dmMessages.length - 1].timestamp;
  saveState();
}
```

Replace the cold-start section with an explicit trigger-bypass path. Do **not** store a synthetic group message and rely on normal trigger detection, because TaskFlow groups still require triggers in the current runtime.

Implementation shape:

- add module-level `pendingExternalDmPrompts = new Map<string, Array<{ timestamp: string; prompt: string }>>()`
- when `queue.sendMessage(groupJid, externalContext)` succeeds, keep the active-container path unchanged
- when there is no active container, append `{ timestamp, prompt }` to `pendingExternalDmPrompts.get(groupJid)` and call `queue.enqueueMessageCheck(groupJid)`
- in `processGroupMessages(chatJid)`, check `pendingExternalDmPrompts` **before** the normal trigger gate
- if pending external DM prompts exist, build the agent prompt from them, bypass `hasTriggerMessage`, and on success clear only the processed DM prompts
- on agent failure, retain the pending external DM prompts for retry instead of losing them or polluting the group message history

Key design decisions:
- **Separate `lastDmTimestamp`** prevents DM cursor from cross-contaminating with group cursor
- **`is_from_me = 0`** in `getDmMessages` prevents bot reply re-ingestion loops
- **Cold-start path:** Use an explicit pending-external-DM queue plus a trigger bypass in `processGroupMessages`; do not rely on synthetic stored group messages
- **Multi-board disambiguation** is handled at the orchestrator level (not deferred to container) per the spec
- **Multi-grant disambiguation** is handled at the orchestrator level whenever more than one active grant exists, even if the grants are on the same board
- **Cached `taskflowDb`** opened once lazily, not per-message

- [x] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: All existing tests PASS, no regressions

- [x] **Step 4: Commit**

```bash
git add src/index.ts src/db.ts
git commit -m "feat: wire inbound DM routing for external meeting participants"
```

---

### Task 4: Relax `@g.us` JID Validation in `send_message` Tool

**Files:**
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts:84-94`

- [x] **Step 1: Write the expectation**

The current code at lines 84-94 rejects any `target_chat_jid` that doesn't end in `@g.us`. Change to accept both `@g.us` and `@s.whatsapp.net`.

- [x] **Step 2: Modify the validation**

Replace lines 84-94:

```typescript
if (args.target_chat_jid && !args.target_chat_jid.endsWith('@g.us')) {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'target_chat_jid must be a WhatsApp group JID ending in "@g.us".',
      },
    ],
    isError: true,
  };
}
```

With:

```typescript
if (
  args.target_chat_jid &&
  !args.target_chat_jid.endsWith('@g.us') &&
  !args.target_chat_jid.endsWith('@s.whatsapp.net')
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'target_chat_jid must be a WhatsApp JID ending in "@g.us" or "@s.whatsapp.net".',
      },
    ],
    isError: true,
  };
}
```

- [x] **Step 3: Update the tool description**

At line 68, change the `target_chat_jid` description from:

```typescript
target_chat_jid: z.string().optional().describe('(Main and TaskFlow groups only) Send to a different group by JID. Use for cross-group notifications. The target group must be registered.'),
```

To:

```typescript
target_chat_jid: z.string().optional().describe('(Main and TaskFlow groups only) Send to a different group or DM by JID. Use for cross-group notifications or external participant DMs. Groups must be registered; DMs must be known external contacts.'),
```

- [x] **Step 4: Run build to verify no type errors**

Run: `cd .claude/skills/add-taskflow && npx tsc --noEmit` (or equivalent)
Expected: No errors

- [x] **Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: allow DM JIDs in send_message tool for external participants"
```

---

### Task 5: Extend `dispatchNotifications` for DM Targets

**Files:**
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts:512-536`

The current `dispatchNotifications` only dispatches to `notification_group_jid`. Extend it to also handle the new `target_kind: 'dm'` + `target_chat_jid` shape.

- [x] **Step 1: Modify `dispatchNotifications`**

Replace the current function (lines 512-536):

```typescript
function dispatchNotifications(result: Record<string, unknown>): void {
  if (Array.isArray(result.notifications)) {
    for (const notif of result.notifications as Array<{ notification_group_jid: string | null; message: string }>) {
      if (notif.notification_group_jid) {
        writeIpcFile(MESSAGES_DIR, {
          type: 'message',
          chatJid: notif.notification_group_jid,
          text: notif.message,
          groupFolder,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
  // ... parent_notification handling stays the same
```

With:

```typescript
function dispatchNotifications(result: Record<string, unknown>): void {
  if (Array.isArray(result.notifications)) {
    for (const notif of result.notifications as Array<{
      target_kind?: 'group' | 'dm';
      notification_group_jid?: string | null;
      target_chat_jid?: string | null;
      message: string;
    }>) {
      // Determine target JID: new DM-aware shape or legacy group-only shape
      const targetJid =
        notif.target_kind === 'dm'
          ? notif.target_chat_jid
          : notif.notification_group_jid;
      if (targetJid) {
        writeIpcFile(MESSAGES_DIR, {
          type: 'message',
          chatJid: targetJid,
          text: notif.message,
          groupFolder,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
  const pn = result.parent_notification as { parent_group_jid?: string; message?: string } | undefined;
  if (pn?.parent_group_jid && pn.message) {
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      chatJid: pn.parent_group_jid,
      text: pn.message,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
  }
}
```

This is backward-compatible: existing notifications use `notification_group_jid` without `target_kind` and still work.

- [x] **Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: extend dispatchNotifications for DM target kind"
```

---

### Task 5b: Phase 0 End-to-End Validation

After Tasks 1–5 are complete, validate the round-trip before proceeding.

- [x] **Step 1: Manual validation checklist**

1. Seed `taskflow.db` with a test external contact and active grant
2. Send a DM from the test phone number to the WhatsApp bot
3. Verify the orchestrator logs show "DM piped to active container" or "DM stored as synthetic group message"
4. Verify the container receives the message with external participant metadata
5. Have the container call `send_message` with a `@s.whatsapp.net` target JID
6. Verify the DM reply is delivered back to the test phone

If any step fails, diagnose and fix before proceeding to Phase 1.

- [x] **Step 2: Commit any fixes**

```bash
git add -A && git commit -m "fix: Phase 0 end-to-end validation fixes"
```

---

## Chunk 2: Phase 1 — Data Model (Skill Layer)

### Task 6: Add External Contact and Grant Tables to Engine Schema

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (schema init)
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [x] **Step 1: Write the failing test**

In `.claude/skills/add-taskflow/tests/taskflow.test.ts`, add:

```typescript
describe('external contacts schema', () => {
  it('creates external_contacts table', () => {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='external_contacts'`
    ).get();
    expect(row).toBeTruthy();
  });

  it('creates meeting_external_participants table', () => {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='meeting_external_participants'`
    ).get();
    expect(row).toBeTruthy();
  });

  it('enforces phone uniqueness on external_contacts', () => {
    db.exec(`INSERT INTO external_contacts VALUES ('ext-1', 'Maria', '5585999991234', NULL, 'active', '2026-01-01', '2026-01-01', NULL)`);
    expect(() => {
      db.exec(`INSERT INTO external_contacts VALUES ('ext-2', 'Maria Copy', '5585999991234', NULL, 'active', '2026-01-01', '2026-01-01', NULL)`);
    }).toThrow();
  });

  it('enforces composite PK on meeting_external_participants', () => {
    db.exec(`INSERT INTO external_contacts VALUES ('ext-1', 'Maria', '5585999991234', NULL, 'active', '2026-01-01', '2026-01-01', NULL)`);
    db.exec(`INSERT INTO meeting_external_participants VALUES ('board-1', 'M1', '2026-03-12T14:00:00Z', 'ext-1', 'pending', NULL, NULL, NULL, NULL, 'person-1', '2026-01-01', '2026-01-01')`);
    expect(() => {
      db.exec(`INSERT INTO meeting_external_participants VALUES ('board-1', 'M1', '2026-03-12T14:00:00Z', 'ext-1', 'invited', NULL, NULL, NULL, NULL, 'person-1', '2026-01-01', '2026-01-01')`);
    }).toThrow();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: FAIL — tables don't exist

- [x] **Step 3: Add CREATE TABLE statements to the engine's schema initialization**

In `taskflow-engine.ts`, find the schema initialization section (the constructor or `initSchema` method that runs CREATE TABLE statements). Add after existing table creation:

```sql
CREATE TABLE IF NOT EXISTS external_contacts (
  external_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  direct_chat_jid TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS meeting_external_participants (
  board_id TEXT NOT NULL,
  meeting_task_id TEXT NOT NULL,
  occurrence_scheduled_at TEXT NOT NULL,
  external_id TEXT NOT NULL,
  invite_status TEXT NOT NULL DEFAULT 'pending',
  invited_at TEXT,
  accepted_at TEXT,
  revoked_at TEXT,
  access_expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (board_id, meeting_task_id, occurrence_scheduled_at, external_id)
);
```

Note: These tables are created in `taskflow.db` which is the same database the engine uses. The schema SQL should be added to the existing `TASKFLOW_SCHEMA` constant (in `taskflow-db.ts` if that's where it lives) or to the engine's constructor init block.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: add external_contacts and meeting_external_participants tables"
```

---

### Task 7: Phone Normalization Utility

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
describe('normalizePhone', () => {
  it('strips non-digit characters', () => {
    expect(normalizePhone('+55 (85) 99999-1234')).toBe('5585999991234');
  });

  it('passes through already-clean phone', () => {
    expect(normalizePhone('5585999991234')).toBe('5585999991234');
  });

  it('strips leading +', () => {
    expect(normalizePhone('+5585999991234')).toBe('5585999991234');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: FAIL — `normalizePhone` not found

- [x] **Step 3: Implement**

In `taskflow-engine.ts`, add as a module-level utility:

```typescript
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: add phone normalization utility"
```

---

### Task 8: Stable Author Identity on Meeting Notes

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (add_note block)
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

Extend the `add_note` code path to include `author_actor_type`, `author_actor_id`, and `author_display_name` in the note JSON.

- [x] **Step 1: Write the failing test**

```typescript
describe('meeting note stable author identity', () => {
  it('includes author_actor_type and author_actor_id for board person notes', () => {
    // Create a meeting, add a note, verify the note JSON shape
    const createResult = engine.create({
      board_id: 'board-1',
      type: 'meeting',
      title: 'Test Meeting',
      participants: ['Alice'],
      scheduled_at: '2026-03-12T14:00:00Z',
      sender_name: 'alice', // resolves to person-alice
    });
    expect(createResult.success).toBe(true);

    const updateResult = engine.update({
      board_id: 'board-1',
      task_id: createResult.task_id!,
      sender_name: 'alice',
      updates: { add_note: 'Test agenda item' },
    });
    expect(updateResult.success).toBe(true);

    // Read the task and check note shape
    const task = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(createResult.task_id!) as any;
    const notes = JSON.parse(task.notes);
    expect(notes[0].author_actor_type).toBe('board_person');
    expect(notes[0].author_actor_id).toBe('person-alice');
    expect(notes[0].author_display_name).toBe('Alice');
    expect(notes[0].by).toBe('alice'); // legacy field preserved
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: FAIL — `author_actor_type` is undefined

- [x] **Step 3: Modify the add_note code path**

In `taskflow-engine.ts`, in the `add_note` handling block (around line 2792), after:

```typescript
const noteEntry: any = { id: noteId, text: updates.add_note, at: now, by: params.sender_name };
```

Add stable author identity:

```typescript
// Stable author identity for permission checks
if (senderPersonId) {
  noteEntry.author_actor_type = 'board_person';
  noteEntry.author_actor_id = senderPersonId;
  noteEntry.author_display_name = sender?.name ?? params.sender_name;
}
```

The `senderPersonId` and `senderPerson` variables should already be available in scope (from the top of the `update()` method). If `senderPersonId` is null (external contact path, added later), the `author_actor_type` will be set differently in Task 12.

- [x] **Step 4: Modify edit_note and remove_note permission checks**

In the `edit_note` block (around line 2826), change:

```typescript
if (task.type === 'meeting' && !isMgr && !isAssignee && note.by !== params.sender_name) {
```

To:

```typescript
if (task.type === 'meeting' && !isMgr && !isAssignee) {
  const isNoteAuthor =
    !!note.author_actor_id && note.author_actor_id === senderPersonId;
  if (!isNoteAuthor) {
    return { success: false, error: `Permission denied: only the note author, organizer, or manager can edit note #${updates.edit_note.id}.` };
  }
}
```

Apply the same pattern to `remove_note` (around line 2848). In the `remove_note` block, change:

```typescript
if (task.type === 'meeting' && !isMgr && !isAssignee && notes[idx].by !== params.sender_name) {
```

To:

```typescript
if (task.type === 'meeting' && !isMgr && !isAssignee) {
  const isNoteAuthor =
    !!notes[idx].author_actor_id &&
    notes[idx].author_actor_id === senderPersonId;
  if (!isNoteAuthor) {
    return { success: false, error: `Permission denied: only the note author, organizer, or manager can remove note #${updates.remove_note}.` };
  }
}
```

**Legacy note policy (per spec):** For notes without `author_actor_id`, only organizer/manager may edit or remove them. Preserve the legacy `by` field for display only; do not grant authorship from display-name matching alone.

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: add stable author identity to meeting notes"
```

---

## Chunk 3: Phase 2 — Meeting Engine Support (Skill Layer)

### Task 9: Add External Participant to Meeting (`add_external_participant`)

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (UpdateParams + update method)
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts` (taskflow_update Zod schema)
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
describe('add_external_participant', () => {
  it('creates external contact and grant', () => {
    // Create a scheduled meeting first
    const meeting = engine.create({
      board_id: 'board-1',
      type: 'meeting',
      title: 'Client Review',
      scheduled_at: '2026-03-12T14:00:00Z',
      sender_name: 'manager-name', // must be manager or organizer
    });
    expect(meeting.success).toBe(true);

    const result = engine.update({
      board_id: 'board-1',
      task_id: meeting.task_id!,
      sender_name: 'manager-name',
      updates: {
        add_external_participant: { name: 'Maria Cliente', phone: '+55 85 99999-1234' },
      },
    });
    expect(result.success).toBe(true);

    // Verify external_contacts row created
    const contact = db.prepare(`SELECT * FROM external_contacts WHERE phone = '5585999991234'`).get() as any;
    expect(contact).toBeTruthy();
    expect(contact.display_name).toBe('Maria Cliente');

    // Verify meeting_external_participants grant created
    const grant = db.prepare(`SELECT * FROM meeting_external_participants WHERE external_id = ?`).get(contact.external_id) as any;
    expect(grant).toBeTruthy();
    expect(grant.meeting_task_id).toBe(meeting.task_id);
    expect(grant.occurrence_scheduled_at).toBe('2026-03-12T14:00:00Z');
    expect(grant.invite_status).toBe('pending');
  });

  it('rejects if meeting has no scheduled_at', () => {
    const meeting = engine.create({
      board_id: 'board-1',
      type: 'meeting',
      title: 'Draft Meeting',
      sender_name: 'manager-name',
    });
    const result = engine.update({
      board_id: 'board-1',
      task_id: meeting.task_id!,
      sender_name: 'manager-name',
      updates: {
        add_external_participant: { name: 'Maria', phone: '5585999991234' },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('scheduled_at');
  });

  it('rejects if sender is not manager or organizer', () => {
    const meeting = engine.create({
      board_id: 'board-1',
      type: 'meeting',
      title: 'Meeting',
      scheduled_at: '2026-03-12T14:00:00Z',
      sender_name: 'manager-name',
    });
    const result = engine.update({
      board_id: 'board-1',
      task_id: meeting.task_id!,
      sender_name: 'non-privileged-user',
      updates: {
        add_external_participant: { name: 'Maria', phone: '5585999991234' },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission');
  });

  it('emits DM invite notification', () => {
    const meeting = engine.create({
      board_id: 'board-1',
      type: 'meeting',
      title: 'Client Review',
      scheduled_at: '2026-03-12T14:00:00Z',
      sender_name: 'manager-name',
    });
    const result = engine.update({
      board_id: 'board-1',
      task_id: meeting.task_id!,
      sender_name: 'manager-name',
      updates: {
        add_external_participant: { name: 'Maria', phone: '5585999991234' },
      },
    });
    expect(result.success).toBe(true);
    expect(result.notifications).toBeDefined();
    const dmNotif = result.notifications!.find((n: any) => n.target_kind === 'dm');
    expect(dmNotif).toBeTruthy();
    expect(dmNotif!.message).toContain('Client Review');
    expect(dmNotif!.message).toContain('aceitar convite');
  });

  it('upserts existing external contact by phone', () => {
    // Add same phone twice — should reuse external_contacts row
    const meeting = engine.create({
      board_id: 'board-1',
      type: 'meeting',
      title: 'Meeting 1',
      scheduled_at: '2026-03-12T14:00:00Z',
      sender_name: 'manager-name',
    });
    engine.update({
      board_id: 'board-1',
      task_id: meeting.task_id!,
      sender_name: 'manager-name',
      updates: { add_external_participant: { name: 'Maria', phone: '5585999991234' } },
    });

    const meeting2 = engine.create({
      board_id: 'board-1',
      type: 'meeting',
      title: 'Meeting 2',
      scheduled_at: '2026-03-15T14:00:00Z',
      sender_name: 'manager-name',
    });
    const result = engine.update({
      board_id: 'board-1',
      task_id: meeting2.task_id!,
      sender_name: 'manager-name',
      updates: { add_external_participant: { name: 'Maria', phone: '5585999991234' } },
    });
    expect(result.success).toBe(true);

    const contacts = db.prepare(`SELECT * FROM external_contacts WHERE phone = '5585999991234'`).all();
    expect(contacts).toHaveLength(1);

    const grants = db.prepare(`SELECT * FROM meeting_external_participants WHERE external_id = ?`).all((contacts[0] as any).external_id);
    expect(grants).toHaveLength(2);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: FAIL — `add_external_participant` not handled

- [x] **Step 3: Add `add_external_participant` to `UpdateParams`**

In `taskflow-engine.ts`, in the `UpdateParams.updates` interface (around line 114), add:

```typescript
add_external_participant?: { name: string; phone: string };
remove_external_participant?: { external_id?: string; phone?: string; name?: string };
reinvite_external_participant?: { external_id?: string; phone?: string };
```

- [x] **Step 4: Implement `add_external_participant` in the `update()` method**

In `taskflow-engine.ts`, in the `update()` method, after the existing `remove_participant` handler (around line 2949), add:

```typescript
if (updates.add_external_participant !== undefined) {
  if (task.type !== 'meeting') {
    return { success: false, error: 'External participants can only be added to meeting tasks.' };
  }
  // Note: add_external_participant must also be listed in hasPrivilegedUpdate
  // (alongside remove_external_participant and reinvite_external_participant)
  // so the main permission gate at line 2623 blocks non-manager/non-assignee senders.
  if (!isMgr && !isAssignee) {
    return { success: false, error: 'Permission denied: only the organizer or a manager can add external participants.' };
  }
  if (!task.scheduled_at) {
    return { success: false, error: 'Meeting must have scheduled_at set before inviting an external participant.' };
  }

  const phone = normalizePhone(updates.add_external_participant.phone);
  const displayName = updates.add_external_participant.name;

  // Upsert external contact
  let externalId: string;
  const existing = this.db.prepare(
    `SELECT external_id FROM external_contacts WHERE phone = ?`
  ).get(phone) as { external_id: string } | undefined;

  if (existing) {
    externalId = existing.external_id;
    this.db.prepare(
      `UPDATE external_contacts SET display_name = ?, updated_at = ? WHERE external_id = ?`
    ).run(displayName, now, externalId);
  } else {
    externalId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.db.prepare(
      `INSERT INTO external_contacts (external_id, display_name, phone, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`
    ).run(externalId, displayName, phone, now, now);
  }

  // Create grant (upsert)
  const occurrenceScheduledAt = task.scheduled_at;
  const existingGrant = this.db.prepare(
    `SELECT invite_status FROM meeting_external_participants
     WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ? AND external_id = ?`
  ).get(this.boardId, task.id, occurrenceScheduledAt, externalId) as { invite_status: string } | undefined;

  if (existingGrant) {
    if (existingGrant.invite_status === 'revoked' || existingGrant.invite_status === 'expired') {
      this.db.prepare(
        `UPDATE meeting_external_participants
         SET invite_status = 'pending', revoked_at = NULL, updated_at = ?
         WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ? AND external_id = ?`
      ).run(now, this.boardId, task.id, occurrenceScheduledAt, externalId);
    }
    // else already invited/accepted — no-op
  } else {
    // Calculate access_expires_at: scheduled_at + 7 days
    const expiresAt = new Date(new Date(occurrenceScheduledAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(
      `INSERT INTO meeting_external_participants
       (board_id, meeting_task_id, occurrence_scheduled_at, external_id, invite_status,
        invited_at, access_expires_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'invited', ?, ?, ?, ?, ?)`
    ).run(this.boardId, task.id, occurrenceScheduledAt, externalId, now, expiresAt, senderPersonId ?? params.sender_name, now, now);
  }

  // Build DM invite notification
  const dmJid = this.db.prepare(
    `SELECT direct_chat_jid FROM external_contacts WHERE external_id = ?`
  ).get(externalId) as { direct_chat_jid: string | null } | undefined;
  const targetJid = dmJid?.direct_chat_jid ?? `${phone}@s.whatsapp.net`;

  const organizerName = sender?.name ?? params.sender_name;
  const inviteMessage =
    `📅 *Convite para reunião*\n\n` +
    `Você foi convidado para *${task.id} — ${task.title}*\n` +
    `*Quando:* ${task.scheduled_at}\n` +
    `*Organizador:* ${organizerName}\n\n` +
    `Responda nesta conversa para participar da pauta e da ata.\n` +
    `Para confirmar, diga: aceitar convite ${task.id}`;

  notifications.push({
    target_kind: 'dm',
    target_external_id: externalId,
    target_chat_jid: targetJid,
    message: inviteMessage,
  } as any);

  // Audit trail
  this.db.prepare(
    `INSERT INTO task_history (board_id, task_id, action, by, at, details)
     VALUES (?, ?, 'add_external_participant', ?, ?, ?)`
  ).run(this.boardId, task.id, senderPersonId ?? params.sender_name, now,
    `External participant ${displayName} (${phone}) invited`);

  changes.push(`External participant ${displayName} invited`);
}
```

- [x] **Step 5: Add the Zod schema in `ipc-mcp-stdio.ts`**

In the `taskflow_update` tool definition (around line 646), add to the `updates` z.object:

```typescript
add_external_participant: z.object({
  name: z.string(),
  phone: z.string(),
}).optional().describe('Add an external participant (name + phone) to a meeting'),
remove_external_participant: z.object({
  external_id: z.string().optional(),
  phone: z.string().optional(),
  name: z.string().optional(),
}).optional().describe('Remove an external participant from a meeting'),
reinvite_external_participant: z.object({
  external_id: z.string().optional(),
  phone: z.string().optional(),
}).optional().describe('Resend invite to an external participant'),
```

- [x] **Step 6: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 7: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: add external participant to meeting with DM invite"
```

---

### Task 10: Remove External Participant and Reinvite

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [x] **Step 1: Write failing tests**

```typescript
describe('remove_external_participant', () => {
  it('revokes grant for external participant', () => {
    // Setup: create meeting, add external, then remove
    // ... (use helper to create meeting + add external from Task 9)
    const result = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'manager-name',
      updates: { remove_external_participant: { phone: '5585999991234' } },
    });
    expect(result.success).toBe(true);
    const grant = db.prepare(
      `SELECT invite_status FROM meeting_external_participants WHERE meeting_task_id = ?`
    ).get(meetingId) as any;
    expect(grant.invite_status).toBe('revoked');
  });

  it('rejects if sender is not manager or organizer', () => {
    const result = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'non-privileged-user',
      updates: { remove_external_participant: { phone: '5585999991234' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('reinvite_external_participant', () => {
  it('resets revoked grant to pending and sends new invite', () => {
    // Setup: add, revoke, then reinvite
    const result = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'manager-name',
      updates: { reinvite_external_participant: { phone: '5585999991234' } },
    });
    expect(result.success).toBe(true);
    expect(result.notifications).toBeDefined();
    const grant = db.prepare(
      `SELECT invite_status FROM meeting_external_participants WHERE meeting_task_id = ?`
    ).get(meetingId) as any;
    expect(grant.invite_status).toBe('invited');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: FAIL

- [x] **Step 3: Implement `remove_external_participant` in engine**

In the `update()` method, add after `add_external_participant`:

```typescript
if (updates.remove_external_participant !== undefined) {
  if (task.type !== 'meeting') {
    return { success: false, error: 'External participants can only be removed from meeting tasks.' };
  }
  if (!isMgr && !isAssignee) {
    return { success: false, error: 'Permission denied: only the organizer or a manager can remove external participants.' };
  }

  const { external_id, phone, name } = updates.remove_external_participant;
  let externalId = external_id;
  if (!externalId && phone) {
    const row = this.db.prepare(`SELECT external_id FROM external_contacts WHERE phone = ?`).get(normalizePhone(phone)) as { external_id: string } | undefined;
    externalId = row?.external_id;
  }
  if (!externalId && name) {
    const row = this.db.prepare(`SELECT external_id FROM external_contacts WHERE LOWER(display_name) = LOWER(?)`).get(name) as { external_id: string } | undefined;
    externalId = row?.external_id;
  }
  if (!externalId) {
    return { success: false, error: 'External participant not found.' };
  }

  this.db.prepare(
    `UPDATE meeting_external_participants
     SET invite_status = 'revoked', revoked_at = ?, updated_at = ?
     WHERE board_id = ? AND meeting_task_id = ? AND external_id = ?
       AND invite_status IN ('pending', 'invited', 'accepted')`
  ).run(now, now, this.boardId, task.id, externalId);

  this.db.prepare(
    `INSERT INTO task_history (board_id, task_id, action, by, at, details)
     VALUES (?, ?, 'remove_external_participant', ?, ?, ?)`
  ).run(this.boardId, task.id, senderPersonId ?? params.sender_name, now, `External participant ${externalId} revoked`);

  changes.push(`External participant removed`);
}
```

- [x] **Step 4: Implement `reinvite_external_participant`**

Similar to add but resets an existing revoked/expired grant and re-sends the invite DM.

```typescript
if (updates.reinvite_external_participant !== undefined) {
  if (task.type !== 'meeting') {
    return { success: false, error: 'External participants can only be reinvited on meeting tasks.' };
  }
  if (!isMgr && !isAssignee) {
    return { success: false, error: 'Permission denied: only the organizer or a manager can reinvite external participants.' };
  }
  if (!task.scheduled_at) {
    return { success: false, error: 'Meeting must have scheduled_at set.' };
  }

  const { external_id, phone } = updates.reinvite_external_participant;
  let externalId = external_id;
  if (!externalId && phone) {
    const row = this.db.prepare(`SELECT external_id FROM external_contacts WHERE phone = ?`).get(normalizePhone(phone)) as { external_id: string } | undefined;
    externalId = row?.external_id;
  }
  if (!externalId) {
    return { success: false, error: 'External contact not found.' };
  }

  this.db.prepare(
    `UPDATE meeting_external_participants
     SET invite_status = 'invited', revoked_at = NULL, invited_at = ?, updated_at = ?
     WHERE board_id = ? AND meeting_task_id = ? AND external_id = ?`
  ).run(now, now, this.boardId, task.id, externalId);

  // Build invite DM (same as add_external_participant)
  const contact = this.db.prepare(`SELECT display_name, phone, direct_chat_jid FROM external_contacts WHERE external_id = ?`).get(externalId) as any;
  const targetJid = contact.direct_chat_jid ?? `${contact.phone}@s.whatsapp.net`;
  const organizerName = sender?.name ?? params.sender_name;
  notifications.push({
    target_kind: 'dm',
    target_external_id: externalId,
    target_chat_jid: targetJid,
    message: `📅 *Convite para reunião*\n\nVocê foi convidado para *${task.id} — ${task.title}*\n*Quando:* ${task.scheduled_at}\n*Organizador:* ${organizerName}\n\nResponda nesta conversa para participar da pauta e da ata.\nPara confirmar, diga: aceitar convite ${task.id}`,
  } as any);

  changes.push(`External participant ${contact.display_name} reinvited`);
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: remove and reinvite external meeting participants"
```

---

### Task 11: Extend Meeting Participants Query

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (meeting_participants query)
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
describe('meeting_participants query with externals', () => {
  it('includes external_participants in response', () => {
    // Setup: create meeting, add external participant
    const result = engine.query({ query: 'meeting_participants', task_id: meetingId });
    expect(result.success).toBe(true);
    expect(result.data.external_participants).toBeDefined();
    expect(result.data.external_participants).toHaveLength(1);
    expect(result.data.external_participants[0].display_name).toBe('Maria Cliente');
    expect(result.data.external_participants[0].invite_status).toBe('invited');
    // Phone should NOT be included (privacy)
    expect(result.data.external_participants[0].phone).toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL — `external_participants` is undefined

- [x] **Step 3: Modify `meeting_participants` query**

In `taskflow-engine.ts`, in the `meeting_participants` case (around line 4255-4282), after the existing participants lookup, add:

```typescript
// External participants
const externalParticipants = this.db.prepare(
  `SELECT ec.external_id, ec.display_name, mep.invite_status
   FROM meeting_external_participants mep
   JOIN external_contacts ec ON ec.external_id = mep.external_id
   WHERE mep.board_id = ? AND mep.meeting_task_id = ?
     AND mep.invite_status NOT IN ('revoked', 'expired')`
).all(this.boardId, task.id) as Array<{
  external_id: string;
  display_name: string;
  invite_status: string;
}>;

return {
  success: true,
  data: {
    organizer: organizerRow ?? { person_id: task.assignee, name: task.assignee },
    participants: people,
    external_participants: externalParticipants,
  },
};
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: include external participants in meeting_participants query"
```

---

### Task 12: Extend Notification Recipients for External Participants

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (meetingNotificationRecipients)
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
describe('meetingNotificationRecipients includes externals', () => {
  it('returns DM notification targets for accepted external participants', () => {
    // Setup: meeting with external participant accepted
    // Trigger a notification-producing action (e.g., meeting start)
    const notifs = engine.getMeetingStartingNotifications('2026-03-12T14:00:00Z', 5);
    const dmNotif = notifs.find((n: any) => n.target_kind === 'dm');
    expect(dmNotif).toBeTruthy();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL — no DM notification produced

- [x] **Step 3: Extend `meetingNotificationRecipients()`**

In `taskflow-engine.ts`, modify `meetingNotificationRecipients` (around line 1233) to also return external participants:

```typescript
private meetingNotificationRecipients(task: any): Array<{
  target_kind: 'group' | 'dm';
  target_person_id?: string;
  target_external_id?: string;
  notification_group_jid?: string | null;
  target_chat_jid?: string | null;
}> {
  // Existing internal participant logic (unchanged)
  const participantIds: string[] = (() => {
    try { return JSON.parse(task.participants ?? '[]'); } catch { return []; }
  })();
  const allRecipients = [...new Set(
    task.assignee && !participantIds.includes(task.assignee)
      ? [...participantIds, task.assignee]
      : [...participantIds],
  )];

  const results: Array<any> = [];

  if (allRecipients.length > 0) {
    const placeholders = allRecipients.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT person_id, notification_group_jid FROM board_people WHERE board_id = ? AND person_id IN (${placeholders})`,
    ).all(this.boardId, ...allRecipients) as Array<{ person_id: string; notification_group_jid: string | null }>;
    const jidMap = new Map(rows.map((r) => [r.person_id, r.notification_group_jid ?? null]));
    for (const personId of allRecipients) {
      results.push({
        target_kind: 'group',
        target_person_id: personId,
        notification_group_jid: jidMap.get(personId) ?? null,
      });
    }
  }

  // External participants with accepted grants
  const externals = this.db.prepare(
    `SELECT ec.external_id, ec.display_name, ec.direct_chat_jid, ec.phone
     FROM meeting_external_participants mep
     JOIN external_contacts ec ON ec.external_id = mep.external_id
     WHERE mep.board_id = ? AND mep.meeting_task_id = ?
       AND mep.invite_status = 'accepted'`
  ).all(this.boardId, task.id) as Array<{
    external_id: string; display_name: string; direct_chat_jid: string | null; phone: string;
  }>;

  for (const ext of externals) {
    results.push({
      target_kind: 'dm',
      target_external_id: ext.external_id,
      target_chat_jid: ext.direct_chat_jid ?? `${ext.phone}@s.whatsapp.net`,
    });
  }

  return results;
}
```

Then update all callers of `meetingNotificationRecipients` to handle the new shape. The main callers are `getMeetingReminderNotifications` and `getMeetingStartingNotifications`. These spread `...recipient` into the notification object, so the new fields will pass through.

**Critical: Update TypeScript interfaces.** The `UpdateResult.notifications` type (line 146) and similar result interfaces must include the new DM fields. Change:

```typescript
notifications?: Array<{ target_person_id: string; notification_group_jid: string | null; message: string }>;
```

To:

```typescript
notifications?: Array<{
  target_kind?: 'group' | 'dm';
  target_person_id?: string;
  target_external_id?: string;
  notification_group_jid?: string | null;
  target_chat_jid?: string | null;
  message: string;
}>;
```

Apply the same update to `CreateResult.notifications`, `MoveResult.notifications`, and the return types of `getMeetingReminderNotifications` and `getMeetingStartingNotifications`. All fields except `message` are optional to maintain backward compatibility with existing group-only callers.

Also add the three new update fields to `hasPrivilegedUpdate` (around line 2603):

```typescript
updates.add_external_participant !== undefined ||
updates.remove_external_participant !== undefined ||
updates.reinvite_external_participant !== undefined;
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: include external participants in meeting notifications"
```

---

### Task 13: Occurrence Key Cascade on Reschedule

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (scheduled_at update)
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
describe('occurrence key cascade on reschedule', () => {
  it('updates occurrence_scheduled_at when meeting is rescheduled', () => {
    // Setup: create meeting with external participant
    engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'manager-name',
      updates: { scheduled_at: '2026-03-15T14:00:00Z' },
    });

    const grant = db.prepare(
      `SELECT occurrence_scheduled_at FROM meeting_external_participants WHERE meeting_task_id = ?`
    ).get(meetingId) as any;
    expect(grant.occurrence_scheduled_at).toBe('2026-03-15T14:00:00Z');
  });

  it('does not update expired or revoked grants', () => {
    // Revoke grant, then reschedule — occurrence should stay original
    db.exec(`UPDATE meeting_external_participants SET invite_status = 'revoked'`);
    engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'manager-name',
      updates: { scheduled_at: '2026-03-20T14:00:00Z' },
    });

    const grant = db.prepare(
      `SELECT occurrence_scheduled_at FROM meeting_external_participants WHERE meeting_task_id = ?`
    ).get(meetingId) as any;
    // Should NOT be updated since grant is revoked
    expect(grant.occurrence_scheduled_at).not.toBe('2026-03-20T14:00:00Z');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL — occurrence_scheduled_at not updated

- [x] **Step 3: Modify `scheduled_at` update handler**

In `taskflow-engine.ts`, in the `scheduled_at` update block (around line 2952-2970), add after the existing reschedule logic:

```typescript
// Cascade to active external participant grants
const oldScheduledAt = task.scheduled_at;
if (oldScheduledAt) {
  this.db.prepare(
    `UPDATE meeting_external_participants
     SET occurrence_scheduled_at = ?, updated_at = ?
     WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ?
       AND invite_status IN ('pending', 'invited', 'accepted')`
  ).run(updates.scheduled_at, now, this.boardId, task.id, oldScheduledAt);
}

// Recalculate access_expires_at for active grants
const newExpiry = new Date(new Date(updates.scheduled_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
this.db.prepare(
  `UPDATE meeting_external_participants
   SET access_expires_at = ?, updated_at = ?
   WHERE board_id = ? AND meeting_task_id = ?
     AND invite_status IN ('pending', 'invited', 'accepted')`
).run(newExpiry, now, this.boardId, task.id);
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: cascade occurrence key and expiry on meeting reschedule"
```

---

## Chunk 4: Phase 3 — DM Command Routing + Phase 4 — Invite Flow (Skill Layer)

### Task 14: External Contact Acceptance Flow

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (new admin action)
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

Add an `accept_external_invite` admin action that the agent calls when an external contact DMs "aceitar convite M1".

- [x] **Step 1: Write the failing test**

```typescript
describe('accept_external_invite', () => {
  it('marks grant as accepted', () => {
    // Setup: meeting with invited external participant
    const result = engine.admin({
      board_id: 'board-1',
      action: 'accept_external_invite',
      task_id: meetingId,
      sender_name: 'ext-1', // external contact ID
      sender_external_id: 'ext-1',
    });
    expect(result.success).toBe(true);

    const grant = db.prepare(
      `SELECT invite_status, accepted_at FROM meeting_external_participants WHERE external_id = 'ext-1'`
    ).get() as any;
    expect(grant.invite_status).toBe('accepted');
    expect(grant.accepted_at).toBeTruthy();
  });

  it('rejects if no pending/invited grant exists', () => {
    const result = engine.admin({
      board_id: 'board-1',
      action: 'accept_external_invite',
      task_id: meetingId,
      sender_name: 'unknown',
      sender_external_id: 'ext-nonexistent',
    });
    expect(result.success).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL

- [x] **Step 3: Implement `accept_external_invite` admin action and exempt it from the manager-only admin gate**

In `taskflow-engine.ts`, the current `admin()` method rejects every non-manager before entering the action switch except `process_inbox`. That gate must be updated first so `accept_external_invite` is reachable by an external contact.

Adjust the permission preamble to:

```typescript
const isExternalInviteAccept = params.action === 'accept_external_invite';
if (params.action === 'process_inbox') {
  if (!this.isManagerOrDelegate(params.sender_name)) {
    return {
      success: false,
      error: `Permission denied: "${params.sender_name}" is not a manager or delegate.`,
    };
  }
} else if (isExternalInviteAccept) {
  if (!params.sender_external_id) {
    return { success: false, error: 'Missing sender_external_id' };
  }
  // No manager check here; action-specific grant validation happens in the case body.
} else if (!this.isManager(params.sender_name)) {
  return {
    success: false,
    error: `Permission denied: "${params.sender_name}" is not a manager.`,
  };
}
```

Then in the `admin()` method's action switch, add:

```typescript
case 'accept_external_invite': {
  if (!params.task_id) return { success: false, error: 'Missing task_id' };
  if (!params.sender_external_id) return { success: false, error: 'Missing sender_external_id' };

  const task = this.requireTask(params.task_id);
  if (task.type !== 'meeting') return { success: false, error: 'Not a meeting task.' };

  const grant = this.db.prepare(
    `SELECT rowid, invite_status FROM meeting_external_participants
     WHERE board_id = ? AND meeting_task_id = ? AND external_id = ?
       AND invite_status IN ('pending', 'invited')
     ORDER BY occurrence_scheduled_at DESC LIMIT 1`
  ).get(this.boardId, task.id, params.sender_external_id) as any;

  if (!grant) return { success: false, error: 'No pending invite found for this meeting.' };

  const now = new Date().toISOString();
  this.db.prepare(
    `UPDATE meeting_external_participants
     SET invite_status = 'accepted', accepted_at = ?, updated_at = ?
     WHERE rowid = ?`
  ).run(now, now, grant.rowid);

  this.db.prepare(
    `INSERT INTO task_history (board_id, task_id, action, by, at, details)
     VALUES (?, ?, 'external_invite_accepted', ?, ?, ?)`
  ).run(this.boardId, task.id, params.sender_external_id, now, 'External participant accepted invite');

  return { success: true, message: `Convite aceito para ${task.id} — ${task.title}` };
}
```

Add `sender_external_id` to `AdminParams`:

```typescript
export interface AdminParams {
  // ... existing fields
  sender_external_id?: string;
}
```

- [x] **Step 4: Add Zod schema for `sender_external_id` in `taskflow_admin` tool**

In `ipc-mcp-stdio.ts`, in the `taskflow_admin` tool definition, add to the schema:

```typescript
sender_external_id: z.string().optional().describe('External contact ID when the caller is an external participant'),
```

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: add accept_external_invite admin action"
```

---

### Task 15: External Participant Note Authorization

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` (note permission checks)
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

Extend the meeting note `add_note`, `edit_note`, `remove_note`, `set_note_status` permission checks to also allow external participants with accepted grants.

- [x] **Step 1: Write the failing test**

```typescript
describe('external participant note operations', () => {
  it('allows accepted external participant to add a note', () => {
    // Setup: meeting with accepted external participant
    const result = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'ext-1', // external ID passed as sender
      sender_external_id: 'ext-1',
      updates: { add_note: 'Client feedback on deliverables' },
    });
    expect(result.success).toBe(true);

    // Verify note has external author identity
    const task = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(meetingId) as any;
    const notes = JSON.parse(task.notes);
    const note = notes.find((n: any) => n.text === 'Client feedback on deliverables');
    expect(note.author_actor_type).toBe('external_contact');
    expect(note.author_actor_id).toBe('ext-1');
  });

  it('blocks external participant from non-meeting operations', () => {
    const result = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'ext-1',
      sender_external_id: 'ext-1',
      updates: { title: 'Hijacked Title' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL

- [x] **Step 3: Add `sender_external_id` to `UpdateParams`**

```typescript
export interface UpdateParams {
  board_id: string;
  task_id: string;
  sender_name: string;
  sender_external_id?: string;  // NEW
  updates: { ... };
}
```

- [x] **Step 4: Modify note permission checks in `update()` to check external grants**

At the top of the `update()` method, after resolving `senderPersonId`, add external contact resolution:

```typescript
const isExternalSender = !!params.sender_external_id;
let hasExternalGrant = false;
if (isExternalSender) {
  const now = new Date().toISOString();
  const grant = this.db.prepare(
    `SELECT invite_status, access_expires_at FROM meeting_external_participants
     WHERE board_id = ? AND meeting_task_id = ? AND external_id = ?
       AND invite_status = 'accepted'`
  ).get(this.boardId, task.id, params.sender_external_id) as any;
  if (grant) {
    // Lazy expiry check (per spec: check-at-query-time)
    if (grant.access_expires_at && grant.access_expires_at < now) {
      this.db.prepare(
        `UPDATE meeting_external_participants SET invite_status = 'expired', updated_at = ?
         WHERE board_id = ? AND meeting_task_id = ? AND external_id = ? AND invite_status = 'accepted'`
      ).run(now, this.boardId, task.id, params.sender_external_id);
      // hasExternalGrant stays false — expired
    } else {
      hasExternalGrant = true;
    }
  }
}
```

Then in the `add_note` permission check, change:

```typescript
if (task.type === 'meeting' && !isMgr && !isAssignee) {
  const participants: string[] = JSON.parse(task.participants ?? '[]');
  if (!participants.includes(senderPersonId ?? '') && !hasExternalGrant) {
    return { success: false, error: `Permission denied: "${params.sender_name}" is not a participant of this meeting.` };
  }
}
```

And in the note entry creation, add external author identity:

```typescript
if (isExternalSender && params.sender_external_id) {
  noteEntry.author_actor_type = 'external_contact';
  noteEntry.author_actor_id = params.sender_external_id;
  const ext = this.db.prepare(`SELECT display_name FROM external_contacts WHERE external_id = ?`).get(params.sender_external_id) as any;
  noteEntry.author_display_name = ext?.display_name ?? params.sender_name;
}
```

Apply the same `hasExternalGrant` check to `set_note_status`.

For `edit_note` and `remove_note`, extend the author check:

```typescript
const isNoteAuthor = note.author_actor_id
  ? (note.author_actor_id === senderPersonId || note.author_actor_id === params.sender_external_id)
  : note.by === params.sender_name;
```

Block non-note operations for external senders:

```typescript
if (isExternalSender) {
  const allowedOps = ['add_note', 'edit_note', 'remove_note', 'set_note_status', 'parent_note_id'];
  const attemptedOps = Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined);
  const disallowed = attemptedOps.filter(op => !allowedOps.includes(op));
  if (disallowed.length > 0) {
    return { success: false, error: `Permission denied: external participants can only interact with meeting notes.` };
  }
}
```

- [x] **Step 5: Add `sender_external_id` to the `taskflow_update` Zod schema**

In `ipc-mcp-stdio.ts`, in the `taskflow_update` tool:

```typescript
sender_external_id: z.string().optional().describe('External contact ID when the caller is an external participant'),
```

- [x] **Step 6: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: PASS

- [x] **Step 7: Commit**

```bash
git add .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
git add .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "feat: allow external participants to add/edit meeting notes"
```

---

## Chunk 5: Phase 5 — Prompt/UX + Phase 6 — Hardening

### Task 16: Update CLAUDE.md Template

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`

- [x] **Step 1: Add external participant commands to the meeting section**

After the existing "Meeting Participants" section (around line 261), add:

```markdown
### External Meeting Participants

External participants are people outside the board invited to a specific meeting. They interact via WhatsApp DM.

| User says | Tool call |
|-----------|-----------|
| "adicionar participante externo M1: Maria, telefone 5585999991234" | `taskflow_update({ task_id: 'M1', updates: { add_external_participant: { name: 'Maria', phone: '5585999991234' } }, sender_name: SENDER })` |
| "convidar cliente para M1: Maria, 5585999991234" | `taskflow_update({ task_id: 'M1', updates: { add_external_participant: { name: 'Maria', phone: '5585999991234' } }, sender_name: SENDER })` |
| "remover participante externo M1: Maria" | `taskflow_update({ task_id: 'M1', updates: { remove_external_participant: { name: 'Maria' } }, sender_name: SENDER })` |
| "reenviar convite M1: Maria" | `taskflow_update({ task_id: 'M1', updates: { reinvite_external_participant: { name: 'Maria' } }, sender_name: SENDER })` |

**Rules:**
- Only organizer (assignee) or manager can add/remove external participants.
- Meeting must have `scheduled_at` set before inviting an external participant.
- External participants receive a DM invite and can accept by replying in DM.
- External participants can only use meeting-scoped commands: pauta, ata, note status, participantes.
- External participants do NOT have access to board queries, task management, or admin actions.
```

- [x] **Step 2: Add DM interaction guidance**

After the external participant commands, add:

```markdown
### DM Context (External Participants)

When processing a message from an external participant (indicated by `sender_external_id` in the message context):

1. **Accept invite:** If the message matches "aceitar convite {ID}", call `taskflow_admin({ action: 'accept_external_invite', task_id: '{ID}', sender_name: SENDER, sender_external_id: EXT_ID })`.
2. **Meeting commands:** Allow pauta, ata, note operations, participantes — always pass `sender_external_id` in tool calls.
3. **Reject other commands:** Reply with: "Seu acesso está restrito às reuniões para as quais você foi convidado. Use um comando como 'pauta M1' ou 'ata M1'."
4. **Never expose board data** to external participants — no quadro, inbox, tasks, statistics, etc.
```

- [x] **Step 3: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "feat: document external participant commands in CLAUDE.md template"
```

---

### Task 17: Integration Test — Full External Participant Flow

**Files:**
- Modify: `.claude/skills/add-taskflow/tests/taskflow.test.ts`

- [x] **Step 1: Write end-to-end integration test**

```typescript
describe('external participant full flow', () => {
  let meetingId: string;

  beforeEach(() => {
    // Create a meeting
    const result = engine.create({
      board_id: 'board-1',
      type: 'meeting',
      title: 'Client Alignment',
      scheduled_at: '2026-03-12T14:00:00Z',
      participants: ['Alice'],
      sender_name: 'manager-name',
    });
    meetingId = result.task_id!;
  });

  it('complete invite → accept → interact → expire flow', () => {
    // 1. Add external participant
    const addResult = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'manager-name',
      updates: { add_external_participant: { name: 'Maria', phone: '5585999991234' } },
    });
    expect(addResult.success).toBe(true);
    expect(addResult.notifications!.some((n: any) => n.target_kind === 'dm')).toBe(true);

    const extId = db.prepare(`SELECT external_id FROM external_contacts WHERE phone = '5585999991234'`).get() as any;

    // 2. Accept invite
    const acceptResult = engine.admin({
      board_id: 'board-1',
      action: 'accept_external_invite',
      task_id: meetingId,
      sender_name: extId.external_id,
      sender_external_id: extId.external_id,
    });
    expect(acceptResult.success).toBe(true);

    // 3. Add a note as external participant
    const noteResult = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: extId.external_id,
      sender_external_id: extId.external_id,
      updates: { add_note: 'Need to discuss contract terms' },
    });
    expect(noteResult.success).toBe(true);

    // 4. Query participants — should include external
    const queryResult = engine.query({ query: 'meeting_participants', task_id: meetingId });
    expect(queryResult.data.external_participants).toHaveLength(1);
    expect(queryResult.data.external_participants[0].invite_status).toBe('accepted');

    // 5. Verify external can't do non-meeting operations
    const hijackResult = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: extId.external_id,
      sender_external_id: extId.external_id,
      updates: { title: 'Hijacked!' },
    });
    expect(hijackResult.success).toBe(false);

    // 6. Revoke
    const revokeResult = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'manager-name',
      updates: { remove_external_participant: { phone: '5585999991234' } },
    });
    expect(revokeResult.success).toBe(true);

    // 7. Verify revoked external can't add notes
    const blockedResult = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: extId.external_id,
      sender_external_id: extId.external_id,
      updates: { add_note: 'Should be blocked' },
    });
    expect(blockedResult.success).toBe(false);

    // 8. Reinvite after revoke
    const reinviteResult = engine.update({
      board_id: 'board-1',
      task_id: meetingId,
      sender_name: 'manager-name',
      updates: { reinvite_external_participant: { phone: '5585999991234' } },
    });
    expect(reinviteResult.success).toBe(true);
    expect(reinviteResult.notifications!.some((n: any) => n.target_kind === 'dm')).toBe(true);
  });

  it('external participant can edit own note and set note status', () => {
    // Setup: add external, accept, add note
    engine.update({
      board_id: 'board-1', task_id: meetingId, sender_name: 'manager-name',
      updates: { add_external_participant: { name: 'Maria', phone: '5585999991234' } },
    });
    const extId = (db.prepare(`SELECT external_id FROM external_contacts WHERE phone = '5585999991234'`).get() as any).external_id;
    engine.admin({
      board_id: 'board-1', action: 'accept_external_invite',
      task_id: meetingId, sender_name: extId, sender_external_id: extId,
    });
    engine.update({
      board_id: 'board-1', task_id: meetingId, sender_name: extId, sender_external_id: extId,
      updates: { add_note: 'Original note' },
    });

    // Get note ID
    const task = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(meetingId) as any;
    const noteId = JSON.parse(task.notes)[0].id;

    // Edit own note
    const editResult = engine.update({
      board_id: 'board-1', task_id: meetingId, sender_name: extId, sender_external_id: extId,
      updates: { edit_note: { id: noteId, text: 'Edited note' } },
    });
    expect(editResult.success).toBe(true);

    // Set note status
    const statusResult = engine.update({
      board_id: 'board-1', task_id: meetingId, sender_name: extId, sender_external_id: extId,
      updates: { set_note_status: { id: noteId, status: 'checked' } },
    });
    expect(statusResult.success).toBe(true);

    // Remove own note
    const removeResult = engine.update({
      board_id: 'board-1', task_id: meetingId, sender_name: extId, sender_external_id: extId,
      updates: { remove_note: noteId },
    });
    expect(removeResult.success).toBe(true);
  });

  it('blocks expired external participant', () => {
    engine.update({
      board_id: 'board-1', task_id: meetingId, sender_name: 'manager-name',
      updates: { add_external_participant: { name: 'Maria', phone: '5585999991234' } },
    });
    const extId = (db.prepare(`SELECT external_id FROM external_contacts WHERE phone = '5585999991234'`).get() as any).external_id;
    engine.admin({
      board_id: 'board-1', action: 'accept_external_invite',
      task_id: meetingId, sender_name: extId, sender_external_id: extId,
    });

    // Manually expire the grant
    db.exec(`UPDATE meeting_external_participants SET access_expires_at = '2020-01-01T00:00:00Z'`);

    const result = engine.update({
      board_id: 'board-1', task_id: meetingId, sender_name: extId, sender_external_id: extId,
      updates: { add_note: 'Should fail — expired' },
    });
    expect(result.success).toBe(false);

    // Verify lazy expiry updated the status
    const grant = db.prepare(`SELECT invite_status FROM meeting_external_participants WHERE external_id = ?`).get(extId) as any;
    expect(grant.invite_status).toBe('expired');
  });
});
```

- [x] **Step 2: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-taskflow/tests/taskflow.test.ts`
Expected: All PASS

- [x] **Step 3: Commit**

```bash
git add .claude/skills/add-taskflow/tests/taskflow.test.ts
git commit -m "test: end-to-end external participant flow integration test"
```

---

### Task 18: Run Full Test Suite and Final Sync

- [x] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS, no regressions

- [x] **Step 2: Build**

Run: `npm run build`
Expected: No type errors

- [x] **Step 3: Final commit if any remaining changes**

```bash
git add -A
git status
# Only commit if there are changes
git commit -m "chore: sync after external meeting participants implementation"
```

---

## Dependency Graph

```
Task 1 (dm-routing) ──┐
Task 2 (ipc auth) ────┤
Task 3 (orchestrator) ─┤── Phase 0 (core runtime, sequential)
Task 4 (JID relax) ────┤
Task 5 (dispatch DM) ──┤
Task 5b (e2e validate) ┘
                        │
Task 6 (schema) ────────┤
Task 7 (phone util) ────┤── Phase 1 (data model, can parallel 6+7)
Task 8 (note author) ───┘
                        │
Task 9 (add external) ──┤
Task 10 (remove/reinvite)┤── Phase 2 (engine, sequential)
Task 11 (query) ────────┤
Task 12 (notif recip) ──┤
Task 13 (occurrence key)┘
                        │
Task 14 (accept flow) ──┤── Phase 3+4 (routing + invite)
Task 15 (note auth) ────┘
                        │
Task 16 (prompt) ───────┤── Phase 5 (UX)
Task 17 (integration) ──┤── Phase 6 (hardening)
Task 18 (final) ────────┘
```

Tasks within the same phase are mostly sequential (each builds on the previous), except:
- Tasks 6 and 7 can run in parallel
- Tasks 4 and 5 can run in parallel
- Task 16 can run in parallel with Tasks 14-15

---

## Implementation Summary

All 18 tasks across 6 phases were implemented and validated. A 40-agent bug hunt was conducted after the initial implementation, uncovering approximately 25 bugs which were subsequently fixed. The full implementation and bug fix history is captured in the following key commits:

| Commit | Description |
|--------|-------------|
| `2486a93` | **Add external participant taskflow schema support** — initial schema and engine implementation |
| `3f1105a` | **fix: refine DM cursor tracking and strip device suffix from JIDs** — corrects DM message cursor advancement and JID normalization for device-suffixed WhatsApp JIDs |
| `bc47799` | **fix: address /simplify review findings for external DM routing and engine** — fixes identified during code review of external DM routing paths and engine logic |
| `0bd11f9` | **fix: sync runtime engine with skill copy for external participants** — ensures runtime and skill copies of the engine stay in sync |
| `069ae56` | **fix: bot message detection for custom triggers and external DM safety** — isBotMessage checks all registered group trigger prefixes; resolveExternalDm guards against missing external_contacts table |
