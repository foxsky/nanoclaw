# v2 user_roles permissions API — Discovery

**Date:** 2026-05-03
**Branch surveyed:** `remotes/upstream/v2` (and `remotes/upstream/migrate/v1-to-v2` for the seed migrator)
**Scope:** the permissions module — `src/modules/permissions/**`
**Purpose:** map v1 `board_admins` (28 manager+primary, 1 manager non-primary, 1 delegate = 30 grants) onto v2 scoped `user_roles`. Honor invariant: never `role='owner' AND agent_group_id IS NOT NULL`; all board admins → scoped `admin`.

---

## 1. `user_roles` schema

**File:** `src/db/migrations/001-initial.ts:48-58`, mirror of `src/db/schema.ts:65-78`.

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,                       -- 'owner' | 'admin'
  agent_group_id TEXT REFERENCES agent_groups(id),    -- NULL = global
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
```

### Constraints & invariants

- **Composite PK** `(user_id, role, agent_group_id)`. SQLite's NULL-PK semantics: a NULL in `agent_group_id` is part of the key, so `(u, 'admin', NULL)` and `(u, 'admin', 'ag-1')` coexist. A user can hold scoped admin on many boards plus global admin simultaneously.
- **Owner-must-be-global is NOT enforced by schema** — it lives in `grantRole()` (`db/user-roles.ts:8-15`) so callers get a clean error path. A direct SQL insert would bypass it; the seed migrator and skill code MUST go through `grantRole()`.
- **No FK CASCADE.** Deleting a user/agent_group leaves dangling rows. Migration cleanup must delete `user_roles` first.
- **Single index** on `(agent_group_id, role)` — optimised for `getAdminsOfAgentGroup()` lookups, not for "list all roles for user X" (which scans). User-scoped queries hit the PK prefix instead.

### Type definition

`src/types.ts:48-63`:
```ts
export type UserRoleKind = 'owner' | 'admin';

export interface UserRole {
  user_id: string;
  role: UserRoleKind;
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}
```

The doc-comment is explicit: "Owner is always global. Admin is either global (`agent_group_id = null`) or scoped to a specific agent group. Admin @ A implicitly makes the user a member of A — we do not require a separate `agent_group_members` row for admins."

---

## 2. `grantRole(...)` API

**File:** `src/modules/permissions/db/user-roles.ts:8-19`

```ts
export function grantRole(row: UserRole): void {
  if (row.role === 'owner' && row.agent_group_id !== null) {
    throw new Error('owner role must be global (agent_group_id = null)');
  }
  getDb().prepare(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
     VALUES (@user_id, @role, @agent_group_id, @granted_by, @granted_at)`,
  ).run(row);
}
```

### Signature semantics

- Plain `INSERT` — no `OR IGNORE`, no `ON CONFLICT`. **Re-granting the same role for the same scope throws** (PK violation). Migration scripts that may re-run must check first (the v1→v2 seeder uses `if (!isOwner(...))` before `grantRole(...)` for that reason).
- The owner-scope guard is the **single point of enforcement** of the documented invariant. There is no schema-level CHECK. Callers MUST funnel through this function — direct INSERTs into the table are permitted by the DB but break the invariant.
- `granted_by` is optional (`null` = system-granted, e.g. seed/migration). The seeder passes `null` for owner and the owner's user_id for allowlist-derived members.
- `granted_at` is caller-provided ISO 8601 string; not auto-defaulted.

### Companion: `revokeRole(userId, role, agentGroupId | null)`

Splits on null because SQLite needs `IS NULL` (not `=`) for null comparisons (`db/user-roles.ts:21-31`).

---

## 3. `isOwner(user_id)` — scope of check

**File:** `src/modules/permissions/db/user-roles.ts:36-41`

```ts
export function isOwner(userId: string): boolean {
  const row = getDb().prepare(
    'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1',
  ).get(userId, 'owner');
  return !!row;
}
```

**Global only.** The `agent_group_id IS NULL` predicate makes scoped-owner rows invisible to this check. Combined with `grantRole()`'s guard, this means there is exactly one definition of "owner" in the system: the platform operator.

A row like `(user_id='u1', role='owner', agent_group_id='ag-1')` cannot be inserted via `grantRole`, and would not satisfy `isOwner('u1')` even if it leaked in via direct SQL. Verification SQL for our own seed:
```sql
SELECT COUNT(*) FROM user_roles WHERE role='owner' AND agent_group_id IS NOT NULL;
-- MUST be 0
```

There is no parallel single-arg `isAdmin(userId)` — that would be ambiguous (global vs. any-scope). Callers go through `isGlobalAdmin(userId)` or `isAdminOfAgentGroup(userId, agentGroupId)`.

---

## 4. `hasAdminPrivilege(user_id, agent_group_id)` — implementation

**File:** `src/modules/permissions/db/user-roles.ts:58-60`

```ts
export function hasAdminPrivilege(userId: string, agentGroupId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId);
}
```

Three sequential indexed point-lookups (`SELECT 1 ... LIMIT 1`), short-circuiting on success. **No caching layer.** With the `(user_id, role, agent_group_id)` PK and the `idx_user_roles_scope` index, all three are `O(log N)` reads. For our scale (≤ 100 users × ≤ 30 boards) the worst case is three sub-millisecond reads per privilege check.

The richer `canAccessAgentGroup(userId, agentGroupId)` in `src/modules/permissions/access.ts:21-28` extends the same chain with a fallback to membership and returns a discriminated union:

```ts
export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'global_admin' | 'admin_of_group' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'not_member' };
```

`isMember()` itself (`db/agent-group-members.ts:22-32`) folds in the role check too — owner / global admin / scoped admin all return `true` without needing an `agent_group_members` row. This is the documented "admin @ A is implicit member of A" invariant.

### Call sites in v2 trunk

`hasAdminPrivilege` is used in exactly two places in upstream v2 (both in `permissions/index.ts`):
- Sender-approval click authorization (line 210): "is the clicker the designated approver OR an admin of this agent group?"
- Channel-approval click authorization (line 292): same pattern.

`canAccessAgentGroup` is the access gate in `setAccessGate` (line 158).

There is **no per-MCP-tool admin check in trunk yet** — v2 trunk does not register MCP/IPC tools (those are skill-side). The pattern v2 establishes is: high-impact actions go through the `approvals` module (admin gets a DM card). See section 8.

---

## 5. `users` table & identity model

### Schema

`migrations/001-initial.ts:39-44`:
```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,    -- "<kind>:<handle>"
  kind         TEXT NOT NULL,       -- 'phone' | 'email' | 'discord' | 'telegram' | 'matrix' | ...
  display_name TEXT,
  created_at   TEXT NOT NULL
);
```

`src/types.ts:36-47`:
> User = a messaging-platform identifier. Namespaced so distinct channels with numeric IDs don't collide: "phone:+1555...", "tg:123", "discord:456", "email:a@x.com". A single human with a phone AND a telegram handle has two separate users — no cross-channel linking (yet).

### CRUD helpers (`db/users.ts`)

- `createUser(user)` — plain INSERT, throws on duplicate.
- `upsertUser(user)` — INSERT … ON CONFLICT(id) DO UPDATE SET `display_name = COALESCE(excluded.display_name, users.display_name)`. **Display name is sticky once set** — passing `display_name: null` on upsert won't clear an existing name. `kind` and `created_at` are NOT updated on conflict (would be silently incorrect to change them).
- `getUser(id)` — `WHERE id = ?` exact match. **No canonicalization on read** — caller must hand in the exact namespaced string.

### Identity for WhatsApp users (canonical form)

The seeder (`setup/migrate/jid.ts:54-64`) gives the canonical answer:

```ts
export function userIdFromJid(jid: string): string {
  if (jid.endsWith('@s.whatsapp.net')) {
    const phone = jid.split('@')[0];
    const normalised = phone.startsWith('+') ? phone : `+${phone}`;
    return `phone:${normalised}`;
  }
  ...
}
```

Two consequences for our migration:

1. **`kind = 'phone'`, NOT `'whatsapp'`.** v2 namespaces by E.164 phone (`phone:+5585...`) because the same human reachable on WhatsApp + iMessage + SMS shares one identifier. Channel routing happens via `user_dms`, not via the user_id prefix.
2. **JID `5585999991111@s.whatsapp.net` → `phone:+5585999991111`.** The `+` is mandatory; `phone:5585...` (without `+`) and `phone:+5585...` are *different* primary keys. This is the canonicalize-at-write-time rule (matches the `feedback_canonicalize_at_write.md` discipline).

The `+`-or-no-`+` choice is enforced *only* by the seeder. There is no DB-level CHECK — a buggy migration script can split the population. **Verification SQL:**
```sql
SELECT id FROM users WHERE id LIKE 'phone:%' AND id NOT LIKE 'phone:+%';
-- MUST be empty post-migration
```

### Upsert flow at runtime

In `permissions/index.ts:39-78`, `extractAndUpsertUser(event)` namespaces the raw handle once on first sight: `userId = rawHandle.includes(':') ? rawHandle : '${event.channelType}:${rawHandle}'`. **At runtime, native WhatsApp adapters that emit raw phones get prefixed `whatsapp:...`, not `phone:...`.** The seeder uses `phone:`. If we mix runtime-created and seed-created rows, we get split identities.

This is an upstream divergence we must reconcile in our skill: either (a) seed everything as `whatsapp:<jid>` to match runtime, or (b) ensure the WhatsApp adapter emits `senderId` already prefixed `phone:+E164`. Option (b) is what the seeder already implies (`kind='phone'`) and matches v2's "kind is the platform-neutral identity class" intent. **Decision for our migration: use `phone:+E164` and patch the WhatsApp adapter (in our skill) to canonicalize at the inbound boundary.**

---

## 6. `agent_group_members` ↔ `user_roles` relationship

### Schema

`migrations/001-initial.ts:62-68`:
```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

### Are members automatically admins?

**No — opposite direction.** Admins are implicitly members; members are NOT admins.

The invariant is encoded in the helper, not the data:

```ts
// db/agent-group-members.ts:25-33
export function isMember(userId: string, agentGroupId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  const row = getDb().prepare(
    'SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1',
  ).get(userId, agentGroupId);
  return !!row;
}
```

`hasMembershipRow()` is the row-only variant for cases where you specifically need to check "did someone get explicitly added" (e.g. revoke flows).

### Migration implication

For our 30 board admins, we do NOT need to also insert `agent_group_members` rows — the scoped-admin grant covers membership via this helper. The seed migrator omits member rows for owners/admins for exactly this reason.

(The seeder DOES insert member rows for the v1 sender-allowlist users — those are non-admin known senders. Our `board_admins` table is the admin layer; if we have a separate "known senders" concept it would feed into `agent_group_members` instead.)

---

## 7. Migration strategy: v1 `board_admins` → v2 `user_roles`

### Inventory of v1 data

`board_admins` is a v1 fork-private table (TaskFlow). 30 grants total: 28 with `is_primary_manager=1`, 1 manager `is_primary_manager=0`, 1 delegate. Each row carries:
- `phone_jid` (v1 format: `5585...@s.whatsapp.net`)
- `agent_group_folder` (or board id — needs to resolve to the v2 `agent_groups.id`)
- `is_primary_manager` (boolean)
- `role` (likely `'manager' | 'delegate'` — **v2 has no role taxonomy beyond `'admin'`**)

### Mapping decisions

| v1 column | v2 destination | Notes |
|---|---|---|
| `phone_jid` | `users.id = 'phone:+E164'` | Canonicalize via `userIdFromJid()` logic. Strip `@s.whatsapp.net`, prepend `+`. |
| `phone_jid` (raw) | `users.kind = 'phone'` | Not `'whatsapp'`. |
| board folder | resolved to `user_roles.agent_group_id` via `agent_groups.folder` lookup | Seed already populates `agent_groups`; we lookup. |
| both `manager` and `delegate` | `user_roles.role = 'admin'` | v2 collapses both into "admin". |
| `is_primary_manager` | **NOT representable in `user_roles`** | See extension table below. |

### The `is_primary_manager` problem

v2 has no concept of "primary manager among a group's admins" — it's a TaskFlow-specific notion (e.g. for the digest credit-attribution rule, "Laizys entregou"). Three options:

1. **Drop it.** If the only consumer is the digest, and the digest can pick *any* admin's display_name, we lose nothing structural.
2. **Encode as a second `user_roles` row with a custom role kind.** v2's `UserRoleKind = 'owner' | 'admin'` is a TS union — we cannot extend it without forking types.ts. **Reject — violates the no-codebase-changes rule.**
3. **Extension table in our skill's TaskFlow DB.** A `taskflow_board_admin_meta(user_id, agent_group_id, is_primary_manager, role_label)` table joined to `user_roles` at read time. Lives in the per-board taskflow DB, not central. Doesn't pollute v2 schema.

**Recommend #3.** It preserves the v1 distinction without bending v2, and the join is per-board so it's already partition-isolated. The `role_label` column also captures `'manager' | 'delegate'` if the digest or audit needs to render it.

### Migration SQL (pseudo-code)

Done as a TaskFlow-skill seed step that runs AFTER the upstream `seed-v2.ts` has populated `users` / `agent_groups` from the global `registered_groups` and `owner.json`.

```ts
// .claude/skills/add-taskflow/scripts/seed-board-admins.ts (sketch)
import { upsertUser } from '@nanoclaw/v2/permissions/db/users';
import { grantRole, isAdminOfAgentGroup }
  from '@nanoclaw/v2/permissions/db/user-roles';
import { userIdFromJid } from '@nanoclaw/v2/migrate/jid'; // or inline the same logic
import { getAgentGroupByFolder } from '@nanoclaw/v2/db/agent-groups';

for (const row of v1BoardAdmins) {
  // 1. canonicalize identity
  const userId = userIdFromJid(row.phone_jid);    // 'phone:+5585...'
  const { kind } = splitUserId(userId);            // 'phone'

  // 2. ensure user exists (idempotent — display_name can be filled later)
  upsertUser({
    id: userId,
    kind,
    display_name: row.display_name ?? null,
    created_at: new Date().toISOString(),
  });

  // 3. resolve board folder → agent_group_id
  const ag = getAgentGroupByFolder(row.board_folder);
  if (!ag) {
    log.error('Skipping admin grant — agent_group not found', { folder: row.board_folder });
    continue;
  }

  // 4. grant scoped admin (skip if already granted — grantRole throws on PK conflict)
  if (!isAdminOfAgentGroup(userId, ag.id)) {
    grantRole({
      user_id: userId,
      role: 'admin',
      agent_group_id: ag.id,         // SCOPED — never null for board admins
      granted_by: null,              // system-granted by migration
      granted_at: row.granted_at ?? new Date().toISOString(),
    });
  }

  // 5. preserve is_primary_manager + role label in skill-private extension
  upsertTaskflowAdminMeta({
    user_id: userId,
    agent_group_id: ag.id,
    is_primary_manager: row.is_primary_manager === 1 ? 1 : 0,
    role_label: row.role,           // 'manager' | 'delegate'
  });
}
```

### Extension table DDL (skill-private)

```sql
-- taskflow.db (per-board) — joined to v2 user_roles at read time
CREATE TABLE IF NOT EXISTS taskflow_board_admin_meta (
  user_id            TEXT NOT NULL,
  agent_group_id     TEXT NOT NULL,
  is_primary_manager INTEGER NOT NULL DEFAULT 0,
  role_label         TEXT NOT NULL,        -- 'manager' | 'delegate'
  PRIMARY KEY (user_id, agent_group_id)
);
```

No FK to v2's central DB (cross-DB FKs aren't a thing in SQLite). Integrity is maintained by the migration script — if `user_roles` doesn't have the matching scoped admin row, the meta row is dead weight but harmless.

### Verification queries

After migration, three invariant checks:

```sql
-- A. owner is global only (the v2 invariant)
SELECT COUNT(*) FROM user_roles WHERE role='owner' AND agent_group_id IS NOT NULL;
-- expected: 0

-- B. every board admin in extension table has matching v2 row
SELECT m.user_id, m.agent_group_id
  FROM taskflow_board_admin_meta m
  LEFT JOIN user_roles r
    ON r.user_id = m.user_id
   AND r.role = 'admin'
   AND r.agent_group_id = m.agent_group_id
  WHERE r.user_id IS NULL;
-- expected: empty

-- C. every users row from board_admins is canonicalized
SELECT id FROM users WHERE id LIKE 'phone:%' AND id NOT LIKE 'phone:+%';
-- expected: empty

-- D. count matches v1 input (30 grants)
SELECT COUNT(*) FROM user_roles WHERE role='admin' AND agent_group_id IS NOT NULL;
-- expected: 30 (or whatever the v1 count was, ± seed-time owner exclusions)
```

---

## 8. Per-action permission check pattern (MCP tools)

### What v2 provides today

v2 trunk has no MCP/IPC tool layer. The permission helpers (`canAccessAgentGroup`, `hasAdminPrivilege`) are called from:

- `setAccessGate` — runs on every inbound message (router-level gate).
- `setSenderScopeGate` — per-wiring stricter gate.
- Approval response handlers (sender-approval, channel-approval, self-mod).

### v2's pattern for high-impact actions

The `approvals` module (`src/modules/approvals/primitive.ts`) is v2's answer to "tool wants to do something an admin must authorize". Three observations:

1. **Approver picking** (`pickApprover(agentGroupId)`, lines 70-93): walks scoped admins → global admins → owners and returns the first reachable user_id list. Already encodes the "scoped admin > global admin > owner" preference our migration needs.
2. **Delivery via DM** (`pickApprovalDelivery`, lines 100-119): uses `ensureUserDm` to find the right `messaging_groups` row to deliver an approval card to.
3. **Handler registry** (`registerApprovalHandler(action, handler)`, lines 60-66): modules register at import time; the response handler dispatches by `action` string when an admin clicks Approve.

This is the **idiomatic v2 pattern for per-action authorization**: don't gate the tool at call time on "is the caller admin"; instead, call the tool, send an approval card to an admin, and only commit the side effect when the approval handler fires.

### When direct admin checks DO apply

For TaskFlow MCP tools where the *caller* must already be admin (e.g. `add_task` on a board the caller manages), the helper is `hasAdminPrivilege(userId, agentGroupId)`. The tool invocation needs:
- The caller's `user_id` (passed in from the IPC frame — already namespaced post-resolver).
- The target board's `agent_group_id` (lives on the IPC envelope or is derived from session).

Reference helper for our skill (sketch):

```ts
// .claude/skills/add-taskflow/src/permission-helpers.ts
import { hasAdminPrivilege } from '@nanoclaw/v2/permissions/db/user-roles';
import { canAccessAgentGroup } from '@nanoclaw/v2/permissions/access';

/** Throw with a typed reason if caller is not admin of the target board. */
export function requireBoardAdmin(userId: string | null, agentGroupId: string): void {
  if (!userId) throw new ToolError('not_authenticated', 'No caller identity');
  if (!hasAdminPrivilege(userId, agentGroupId)) {
    throw new ToolError('not_admin', `User ${userId} is not an admin of ${agentGroupId}`);
  }
}

/** Looser gate: any known interactor — admin OR group member. */
export function requireBoardAccess(userId: string | null, agentGroupId: string): void {
  if (!userId) throw new ToolError('not_authenticated', 'No caller identity');
  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (!decision.allowed) {
    throw new ToolError('access_denied', `User ${userId}: ${decision.reason}`);
  }
}
```

These wrappers are skill-private — they do NOT touch `src/`. They sit on top of v2's exported helpers and turn the boolean/AccessDecision result into a ToolError that the MCP framing layer renders back to the agent.

### Caching note

For our scale (30 admins, ~100-turn conversations) the unindexed cost of three SQLite point-lookups per tool call is well under 1 ms. **Do not cache.** The single source of truth is always the DB. Caching here would re-introduce the canonicalization-at-read drift problem we already learned to avoid.

---

## File path index

| Path (in `remotes/upstream/v2`) | Role |
|---|---|
| `src/types.ts:36-72` | `User`, `UserRoleKind`, `UserRole`, `AgentGroupMember`, `UserDm` types |
| `src/db/migrations/001-initial.ts:39-80` | Initial schema for `users`, `user_roles`, `agent_group_members`, `user_dms` |
| `src/db/schema.ts:58-104` | Same schema annotated for documentation |
| `src/modules/permissions/db/users.ts` | CRUD: `createUser`, `upsertUser`, `getUser`, `updateDisplayName`, `deleteUser` |
| `src/modules/permissions/db/user-roles.ts` | `grantRole`, `revokeRole`, `getUserRoles`, `isOwner`, `isGlobalAdmin`, `isAdminOfAgentGroup`, `hasAdminPrivilege`, `getOwners`, `hasAnyOwner`, `getGlobalAdmins`, `getAdminsOfAgentGroup` |
| `src/modules/permissions/db/agent-group-members.ts` | `addMember`, `removeMember`, `getMembers`, `isMember` (admin-implies-member), `hasMembershipRow` (raw) |
| `src/modules/permissions/db/user-dms.ts` | `upsertUserDm`, `getUserDm`, `getUserDmsForUser`, `deleteUserDm` |
| `src/modules/permissions/access.ts:21-28` | `canAccessAgentGroup` — discriminated AccessDecision |
| `src/modules/permissions/index.ts` | Module wiring: `setSenderResolver`, `setAccessGate`, sender-approval & channel-approval response handlers |
| `src/modules/permissions/user-dm.ts` | `ensureUserDm(userId)` — primitive for cold DMs |
| `src/modules/approvals/primitive.ts:70-119` | `pickApprover`, `pickApprovalDelivery` — admin-DM routing for high-impact actions |
| `setup/migrate/seed-v2.ts` (branch: `migrate/v1-to-v2`) | Reference seed-from-v1 — owner+roles+members |
| `setup/migrate/jid.ts` (branch: `migrate/v1-to-v2`) | `userIdFromJid` — canonical `phone:+E164` form |
