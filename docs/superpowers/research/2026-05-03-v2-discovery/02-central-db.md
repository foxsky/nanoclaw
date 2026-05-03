# v2 Central data/v2.db Schema

Research target: `data/v2.db` — the host-owned admin-plane DB in v2. Sources are read via `git show remotes/upstream/v2:<path>`. v1 comparison is `/root/nanoclaw/src/db.ts`. Working branch: `main` (fork).

The migration **runner** (`src/db/migrations/index.ts:32-65`) is unique to v2 and is what enables fork-private and skill-installed table additions to land safely. Read that first if you only have time for one file.

---

## Complete table inventory (table → owner → read/write → purpose)

| Table | Owning module | Migration file | Writers (host code path) | Readers | Purpose |
|-------|---------------|----------------|--------------------------|---------|---------|
| `agent_groups` | core | `001-initial.ts:11-17` | `src/db/agent-groups.ts` | router, delivery, session-manager | Agent workspaces, 1:1 with `groups/<folder>/` |
| `messaging_groups` | core | `001-initial.ts:19-27` (+ `denied_at` from `012-channel-registration.ts`) | `src/db/messaging-groups.ts`, channel adapters | router, delivery, session-manager | One row per platform chat |
| `messaging_group_agents` | core | `001-initial.ts:29-39` (+ engage cols from `010-engage-modes.ts`) | `src/db/messaging-groups.ts::createMessagingGroupAgent` | router, delivery | Wiring: which agent handles which chat |
| `users` | permissions module | `001-initial.ts:41-46` | `src/modules/permissions/db/users.ts` (called from `permissions/index.ts::extractAndUpsertUser`) | access gate | Platform identities (`tg:123`, `phone:+1...`) |
| `user_roles` | permissions module | `001-initial.ts:48-58` | `src/modules/permissions/db/user-roles.ts::grantRole` | `src/modules/permissions/access.ts` | Owner/admin grants |
| `agent_group_members` | permissions module | `001-initial.ts:60-66` | `src/modules/permissions/db/agent-group-members.ts::addMember` | access gate | Explicit non-privileged membership |
| `user_dms` | permissions module | `001-initial.ts:68-73` | `src/modules/permissions/user-dm.ts::ensureUserDm` | approval/pairing delivery | DM channel cache |
| `sessions` | core | `001-initial.ts:75-86` | `src/db/sessions.ts`, `src/session-manager.ts` | delivery, sweep, container-runner | Session registry (id, status, container_status) |
| `pending_questions` | interactive module | `001-initial.ts:88-98` | `src/db/sessions.ts::createPendingQuestion` (via `ask_user_question` MCP) | container response matcher | Interactive question parking |
| `chat_sdk_kv` | chat-sdk bridge | `002-chat-sdk-state.ts` | `src/state-sqlite.ts` | Chat SDK adapter | Generic KV with TTL |
| `chat_sdk_subscriptions` | chat-sdk bridge | `002-chat-sdk-state.ts` | `src/state-sqlite.ts` | Chat SDK adapter | Thread subscriptions |
| `chat_sdk_locks` | chat-sdk bridge | `002-chat-sdk-state.ts` | `src/state-sqlite.ts` | Chat SDK adapter | Distributed locks |
| `chat_sdk_lists` | chat-sdk bridge | `002-chat-sdk-state.ts` | `src/state-sqlite.ts` | Chat SDK adapter | Ordered list state |
| `pending_approvals` | approvals module | `module-approvals-pending-approvals.ts` (v3) + `module-approvals-title-options.ts` (v7) | `src/db/sessions.ts::createPendingApproval`, `src/modules/approvals/onecli-approvals.ts` | admin-card delivery, sweep | Session-bound MCP + OneCLI credential approvals |
| `agent_destinations` | agent-to-agent module | `module-agent-to-agent-destinations.ts` (v4) | `src/modules/agent-to-agent/db/agent-destinations.ts`, `src/db/messaging-groups.ts::createMessagingGroupAgent` (auto-add side-effect) | `writeDestinations()`, delivery ACL | ACL **and** name resolution for outbound |
| `unregistered_senders` | core | `008-dropped-messages.ts` | `src/db/dropped-messages.ts::recordDroppedMessage` | ops tooling | Audit trail for dropped messages |
| (`pending_credentials` removed) | — | `009-drop-pending-credentials.ts` | — | — | DROP TABLE only |
| `pending_sender_approvals` | permissions module | `011-pending-sender-approvals.ts` | `src/modules/permissions/sender-approval.ts` | `src/modules/permissions/index.ts::handleSenderApprovalResponse` | Unknown-sender approval flow |
| `pending_channel_approvals` | permissions module | `012-channel-registration.ts` | `src/modules/permissions/channel-approval.ts` | `src/modules/permissions/index.ts::handleChannelApprovalResponse` | Unknown-channel registration |
| `schema_version` | migration runner | `src/db/migrations/index.ts:38` | runner | runner | Migration ledger keyed on `name` (NOT `version`) |

Connection setup: `src/db/connection.ts:15-22` — opens with `journal_mode=WAL`, `foreign_keys=ON`. Tests use `:memory:` via `initTestDb()`.

---

## Per-table deep-dive

### 1. `messaging_group_agents` (CRITICAL for TaskFlow)

This is where v1's per-group `trigger_pattern` lives in v2. **Migration `010-engage-modes.ts` replaced v1's opaque `trigger_rules` JSON + `response_scope` enum with four orthogonal columns.**

Final schema (`src/db/schema.ts:42-56`):

```sql
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
                         -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,    -- regex; required when engage_mode='pattern'
                                  -- '.' means "match every message"
  sender_scope           TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',   -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);
```

Where each is set:
- **`engage_pattern`**: by `setup/register.ts`, `scripts/init-first-agent.ts`, the `/manage-channels` skill, and the channel-approval response handler (`permissions/index.ts` set to `'.'` for DMs, `null` for groups).
- **`sender_scope`**: same callers; gate enforced at `permissions/index.ts::setSenderScopeGate`.
- **`ignored_message_policy`**: defaults to `drop` everywhere; channel-approval flow sets it to `accumulate` for newly-approved channels.

v1 mapping for TaskFlow:
- v1 `registered_groups.trigger_pattern` (string) → v2 `messaging_group_agents.engage_pattern` (regex, with `'.'` as the always-engage flavor) when `engage_mode='pattern'`. v1 has no equivalent of `mention-sticky`.

Writer: `createMessagingGroupAgent` (`src/db/messaging-groups.ts:104-156`). It auto-creates the matching `agent_destinations` row (cross-module side-effect — see below).

### 2. The `agent_groups` + `messaging_groups` + `messaging_group_agents` triangle

**Cardinality:** N:M via `messaging_group_agents` (UNIQUE on the pair). Same chat → multiple agent groups (fan-out); same agent group → multiple chats. v1 was effectively 1:1 via `registered_groups`.

**When rows are inserted, by whom:**
- `agent_groups`: `setup/register.ts`, `scripts/init-first-agent.ts`, the `create_agent` system action (agent-to-agent module's `handleCreateAgent`).
- `messaging_groups`: lazily by the router when an unknown chat fires (`src/router.ts:151` hardcodes `'request_approval'`); also by channel adapter setup flows.
- `messaging_group_agents`: only operator/admin paths — setup scripts, `/manage-channels` skill, and the channel-approval response handler in `permissions/index.ts`.

There is no host code that programmatically wires a chat outside these admin paths. **TaskFlow's v1 `createGroup` mechanism does not exist in v2** — feedback `feedback_use_v2_natives_dont_duplicate.md` says to adopt v2's create_agent + admin-approval pattern, not preserve v1's.

### 3. `users` + `user_roles` and the `isOwner()` invariant

`users` (`src/db/schema.ts:60-65`): id is namespaced (`tg:`, `discord:`, `phone:`, `email:`). Writer: `permissions/db/users.ts::upsertUser` from `permissions/index.ts::extractAndUpsertUser` (`src/modules/permissions/index.ts:42-67`).

`user_roles` (`src/db/schema.ts:67-77`):

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
```

**The `isOwner()` invariant (`src/modules/permissions/db/user-roles.ts`):**
- `grantRole()` throws if `role='owner' AND agent_group_id !== null` (lines 8-13). Owner is always global.
- `isOwner()` only matches rows where `agent_group_id IS NULL` (lines 35-40).
- Admin can be either global (NULL) or scoped to a single agent group; checked via `isAdminOfAgentGroup` and `isGlobalAdmin`.
- `hasAdminPrivilege(userId, agentGroupId)` = owner OR global-admin OR scoped-admin (line 56).

Schema-level enforcement is intentionally absent ("enforced here, not by schema, so callers get a clean error path" — comment at line 6). Verify post-seed: `SELECT COUNT(*) FROM user_roles WHERE role='owner' AND agent_group_id IS NOT NULL` MUST be 0 (memory: `project_v2_user_roles_invariant.md`).

### 4. `agent_destinations` (ACL + routing — the dual-purpose design)

`module-agent-to-agent-destinations.ts:25-32`:

```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id      TEXT NOT NULL,   -- messaging_group_id | agent_group_id
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
```

**ACL = row existence.** No separate permissions table. Permission check is `hasDestination(agent, type, target)`.

**Projection invariant (load-bearing).** Central table is source of truth; each running container reads a per-session **projection** in `inbound.db`. `spawnContainer` calls `writeDestinations(agentGroupId, sessionId)` on every wake. **Mutating `agent_destinations` while a container is running requires an explicit `writeDestinations()` call, or the container will reject sends with stale ACL.** Documented at the top of `src/modules/agent-to-agent/db/agent-destinations.ts:1-32`.

Known callers required to refresh:
- `src/delivery.ts::handleSystemAction` case `'create_agent'`
- `src/db/messaging-groups.ts::createMessagingGroupAgent` — currently does NOT refresh; the comment at line 117-134 explains why this is OK (only setup scripts call it, separate process).

When a wiring is created, `createMessagingGroupAgent` auto-inserts a destination row using the messaging group's `name` (normalized) as the `local_name`, with `-2`/`-3` collision suffixes within the agent's namespace. Mirrors backfill logic in migration 004.

### 5. `pending_approvals` (dual-workflow table)

`module-approvals-pending-approvals.ts` introduces it; `module-approvals-title-options.ts` retroactively adds `title` + `options_json` for installs that ran v3 before those columns were added.

```sql
CREATE TABLE pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),     -- nullable for OneCLI flow
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  agent_group_id      TEXT REFERENCES agent_groups(id),
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);
```

Two separate workflows share this table:
- **Session-bound MCP approvals** (`install_packages`, `add_mcp_server`): `session_id` is set.
- **OneCLI credential approvals** (from SDK `configureManualApproval` callback): `session_id` is NULL; routing via `agent_group_id` + `channel_type` + `platform_id`.

`platform_message_id` lets the host edit the admin card in place after approve/reject.

### 6. `pending_sender_approvals` and `pending_channel_approvals`

Both keyed for natural in-flight dedup:
- `pending_sender_approvals`: `UNIQUE(messaging_group_id, sender_identity)` — second message from same unknown sender while card pending is silently dropped.
- `pending_channel_approvals`: `PRIMARY KEY (messaging_group_id)` — second mention while card pending is silently dropped via `INSERT OR IGNORE`.

Approval response handlers in `permissions/index.ts::handleSenderApprovalResponse` and `handleChannelApprovalResponse` clear the row, optionally create wiring (`createMessagingGroupAgent` with MVP defaults `mention-sticky`/`pattern='.'`, `sender_scope='known'`, `ignored_message_policy='accumulate'`), then re-call `routeInbound(event)` with the stored event.

### 7. `sessions`

`src/db/schema.ts:108-118`. Lifecycle metadata only — no messages. Resolved by `resolveSession()` in `src/session-manager.ts`. Two indexes: `(agent_group_id)` and `(messaging_group_id, thread_id)`.

`messaging_group_id` is **nullable** — sessions exist for `agent-shared` mode where one container handles all channels for an agent (`session_mode='agent-shared'`).

`container_status` ∈ `'running'` | `'idle'` | `'stopped'`. Polled by host sweep.

### 8. `unregistered_senders` (`008-dropped-messages.ts`)

```sql
CREATE TABLE unregistered_senders (
  channel_type    TEXT NOT NULL,
  platform_id     TEXT NOT NULL,
  user_id         TEXT,
  sender_name     TEXT,
  reason          TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id  TEXT,
  message_count   INTEGER NOT NULL DEFAULT 1,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
```

`recordDroppedMessage` (`src/db/dropped-messages.ts:18-37`) uses ON CONFLICT to bump `message_count` + `last_seen`. **This is the only audit table in central DB.**

### 9. Chat-SDK bridge tables (`002-chat-sdk-state.ts`)

`chat_sdk_kv` (TTL-aware), `chat_sdk_subscriptions`, `chat_sdk_locks`, `chat_sdk_lists`. Owned by `src/state-sqlite.ts`. NanoClaw code rarely touches these; they back the `SqliteStateAdapter` used by the Chat SDK bridge for inbound channels using the SDK protocol.

### 10. `messaging_groups` — `denied_at` column (`012-channel-registration.ts`)

Added via guarded `ALTER TABLE` (FK-safe; comment in 011 explains why a table rebuild is unsafe inside the implicit migration transaction). Set when a channel-registration card is denied. Router check at `agentCount === 0` short-circuits future mentions on denied channels.

Setter: `setMessagingGroupDeniedAt(id, deniedAt | null)` in `src/db/messaging-groups.ts`.

### 11-13. Module-owned but undocumented in db-central.md

- `pending_questions` is owned by the interactive module logically; physically created in 001 because it's referenced from `sessions`.
- `agent_group_members`, `user_dms`, `users`, `user_roles` are listed in 001 but accessed only via files in `src/modules/permissions/db/` — core never reads them directly.

This is a **deliberate split**: DDL is centralized in 001 for FK ordering; access layer is module-scoped.

---

## Foreign-key relationships

```
agent_groups.id  ←  messaging_group_agents.agent_group_id
                 ←  sessions.agent_group_id
                 ←  agent_group_members.agent_group_id
                 ←  user_roles.agent_group_id (nullable; NULL = global)
                 ←  agent_destinations.agent_group_id
                 ←  pending_approvals.agent_group_id (nullable)
                 ←  pending_sender_approvals.agent_group_id
                 ←  pending_channel_approvals.agent_group_id

messaging_groups.id  ←  messaging_group_agents.messaging_group_id
                     ←  sessions.messaging_group_id (nullable; NULL for agent-shared)
                     ←  user_dms.messaging_group_id
                     ←  pending_sender_approvals.messaging_group_id
                     ←  pending_channel_approvals.messaging_group_id (PK)

users.id  ←  user_roles.user_id
          ←  user_roles.granted_by (nullable)
          ←  agent_group_members.user_id
          ←  agent_group_members.added_by (nullable)
          ←  user_dms.user_id

sessions.id  ←  pending_questions.session_id
             ←  pending_approvals.session_id (nullable for OneCLI)
```

`agent_destinations.target_id` is **not** a SQL FK — its referent depends on `target_type` (`'channel'` → messaging_groups, `'agent'` → agent_groups). Indexed via `idx_agent_dest_target ON (target_type, target_id)`.

`PRAGMA foreign_keys = ON` is set in `connection.ts:20`; FKs are enforced at runtime.

---

## Migration system

Runner: `src/db/migrations/index.ts:32-65`. Two non-obvious design choices:

1. **Uniqueness keyed on `name`, not `version`** (line 41 comment block). Module migrations added by install-skills can pick arbitrary version numbers without coordinating across modules. The `version` column is auto-assigned at insert time as an applied-order number.

2. **Module migrations use the `module-` filename prefix but retain their original short `name`** so existing DBs that recorded the migration under the old name don't re-run it. Example: `module-agent-to-agent-destinations.ts` exports `name: 'agent-destinations'`.

```ts
const applied = new Set<string>(
  (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
);
const pending = migrations.filter((m) => !applied.has(m.name));
```

Each migration runs inside `db.transaction(() => { m.up(db); ... })`. Failure rolls back including the schema_version insert.

Migration list (`migrations/index.ts:23-32`):

| Pos | Export | name | Adds |
|----|--------|------|------|
| 1 | `migration001` | `initial-v2-schema` | core 9 tables |
| 2 | `migration002` | `chat-sdk-state` | 4 chat_sdk_* tables |
| 3 | `moduleApprovalsPendingApprovals` | `pending-approvals` | `pending_approvals` |
| 4 | `moduleAgentToAgentDestinations` | `agent-destinations` | `agent_destinations` + backfill |
| 5 | `moduleApprovalsTitleOptions` | `pending-approvals-title-options` | retroactive ALTER for `title`, `options_json` |
| 6 | `migration008` | `dropped-messages` | `unregistered_senders` |
| 7 | `migration009` | `drop-pending-credentials` | DROP defunct table |
| 8 | `migration010` | `engage-modes` | 4 engage cols, drop legacy 2 |
| 9 | `migration011` | `pending-sender-approvals` | unknown-sender approval table |
| 10 | `migration012` | `channel-registration` | `denied_at` + `pending_channel_approvals` |

Numbers 005-006 are intentionally absent (renumbering during early dev; comment in `db-central.md`). The integer version number is a hint, not a constraint.

---

## Skill-branch modification convention

There is **no example** in the upstream v2 of a `.claude/skills/` skill adding tables to central `data/v2.db`. All currently-shipping table additions live in `src/db/migrations/` and are imported into the static `migrations[]` array in `src/db/migrations/index.ts:23-32`.

The pattern that **does** exist for module-scoped DDL:

1. Migration file lives in `src/db/migrations/` with a `module-<area>-<scope>.ts` filename.
2. Export uses an arbitrary `version` number (5/6 are gaps from earlier renumbering).
3. The `name` field on the `Migration` object is **stable** across renames (the module-prefix lives only on the export identifier and filename) so existing DBs don't re-run.
4. The migration is added to the `migrations[]` array in `migrations/index.ts`.
5. Access functions live in `src/modules/<module>/db/<table>.ts`.
6. Module barrel `src/modules/<module>/index.ts` self-registers any router/delivery hooks at import time.
7. Core code that reads module tables guards with `hasTable(getDb(), 'tablename')` (`connection.ts:43-49`) so an uninstalled module degrades silently.

**Implication for fork-private TaskFlow tables:** the upstream design does NOT have a "skill drops a migration into a directory at install time" mechanism. To add tables in a v2-aligned way, the skill must:
- Author migration files under `src/db/migrations/module-taskflow-*.ts`.
- Patch `src/db/migrations/index.ts` to import + append to the array.
- Use `hasTable()` guards anywhere core touches them.

Per `feedback_no_nanoclaw_codebase_changes.md` and `feedback_use_v2_natives_dont_duplicate.md`, all this lives in `.claude/skills/add-taskflow/add/` with intent files, not edits to `src/`.

---

## Implications for TaskFlow migration

### What v1 has that v2 has equivalents for

| v1 (`/root/nanoclaw/src/db.ts`) | v2 equivalent | Notes |
|---|---|---|
| `chats` | `messaging_groups` | platform identity moved into the `(channel_type, platform_id)` UNIQUE pair |
| `messages` | session `inbound.db::messages_in` + `outbound.db::messages_out` | NOT central; per-session split DBs |
| `registered_groups.trigger_pattern` | `messaging_group_agents.engage_pattern` (with `engage_mode='pattern'`) | per wiring, not per chat |
| `registered_groups` (assistant_name, group config) | `messaging_group_agents` + `messaging_groups.unknown_sender_policy` | identity moved to wiring |
| `sessions` | `sessions` | similar shape; v2 has `container_status` lifecycle |
| `scheduled_tasks` | `messages_in` rows with `kind='task'` (scheduling module piggybacks; no separate table) | `src/modules/scheduling/db.ts:1-12` |
| `task_run_logs`, `send_message_log`, `agent_turn_messages` | (no equivalent — v1-only telemetry) | TaskFlow uses these; v2 does not |
| `outbound_messages`, `router_state` | per-session `outbound.db::messages_out` + `processing_ack` | host owns inbound, container owns outbound |

### v1-only TaskFlow tables (must be added by skill)

These have no upstream equivalent and require new module migrations:
- `task_run_logs`, `send_message_log`, `agent_turn_messages` (telemetry)
- TaskFlow's own per-board task tables (kanban columns, WIP limits, standup state) — currently in `store/messages.db` per the codex flag, MUST move to `data/v2.db`

### v2 patterns the skill must respect

1. **Migration registration** — author `src/db/migrations/module-taskflow-*.ts` files; patch `migrations/index.ts` array. Don't write to `data/v2.db` from out-of-band scripts that bypass the runner.
2. **Trigger pattern lives per-wiring, not per-group.** v1's `registered_groups.trigger_pattern` maps to `messaging_group_agents.engage_pattern` + `engage_mode='pattern'`. Multiple agents on the same chat each get their own pattern.
3. **Auto-create the destination row** when wiring an agent to a chat (`createMessagingGroupAgent` already does this — but only for setup-script callers; if TaskFlow wires from inside the host process, it must explicitly call `writeDestinations()` to refresh the projection).
4. **`isOwner()` is global-only.** TaskFlow board-level admins map to scoped `'admin'` rows, never `'owner'` (memory: `project_v2_user_roles_invariant.md`).
5. **Trigger module-aware reads with `hasTable()` guards** so uninstalled-skill builds degrade silently.
6. **`pending_approvals` is the integration point for any TaskFlow approval-card flow.** Don't introduce a parallel approval table.

### v2 patterns my migration scripts (in store/messages.db) violate

- **Wrong DB.** v1 path `store/messages.db` is no longer central. v2 = `data/v2.db`. Routing/wiring tables (`messaging_group_agents`, `agent_destinations`, `pending_approvals`) live in `data/v2.db` only — anything written to `store/messages.db` does not participate in v2 routing.
- **Bypassing the migration runner.** Direct DDL writes don't appear in `schema_version` and re-run on every startup or fail when a future migration assumes the table state.
- **Trigger pattern in a fork-private table.** v1 reads `registered_groups.trigger_pattern` per-group; v2 reads `messaging_group_agents.engage_pattern` per-wiring. Preserving the v1 column is a duplication-of-logic violation per `feedback_use_v2_natives_dont_duplicate.md`.

### What still must be answered

- Is `messaging_group_agents.engage_pattern + engage_mode='pattern'` sufficient for TaskFlow's `@Case` per-board trigger, or does TaskFlow need an additional axis? (current evidence: yes, sufficient — `engage_mode='pattern'` with the per-board regex is exactly the v1 mechanism, just relocated.)
- Cross-board subtask forwarding (the `cross_board_subtask_mode` flag and `merge_project` flow): does this go in a module migration table, or can it ride on `agent_destinations` with a custom `target_type='taskflow_subtask'`? (`agent_destinations.target_type` is currently constrained in code to `'channel' | 'agent'` — adding a new value requires touching delivery; this is a design decision for Phase 2.)
- Per-board `cross_board_subtask_mode`, `assignee_phone_canonical`, etc. — these are TaskFlow-specific and have no upstream home; they need a new module table `taskflow_boards` keyed on `agent_group_id`.

---

## Files referenced

- `git show remotes/upstream/v2:docs/db.md`
- `git show remotes/upstream/v2:docs/db-central.md`
- `git show remotes/upstream/v2:src/db/schema.ts`
- `git show remotes/upstream/v2:src/db/migrations/index.ts`
- `git show remotes/upstream/v2:src/db/migrations/001-initial.ts`
- `git show remotes/upstream/v2:src/db/migrations/002-chat-sdk-state.ts`
- `git show remotes/upstream/v2:src/db/migrations/008-dropped-messages.ts`
- `git show remotes/upstream/v2:src/db/migrations/009-drop-pending-credentials.ts`
- `git show remotes/upstream/v2:src/db/migrations/010-engage-modes.ts`
- `git show remotes/upstream/v2:src/db/migrations/011-pending-sender-approvals.ts`
- `git show remotes/upstream/v2:src/db/migrations/012-channel-registration.ts`
- `git show remotes/upstream/v2:src/db/migrations/module-agent-to-agent-destinations.ts`
- `git show remotes/upstream/v2:src/db/migrations/module-approvals-pending-approvals.ts`
- `git show remotes/upstream/v2:src/db/migrations/module-approvals-title-options.ts`
- `git show remotes/upstream/v2:src/db/connection.ts`
- `git show remotes/upstream/v2:src/db/messaging-groups.ts`
- `git show remotes/upstream/v2:src/db/agent-groups.ts`
- `git show remotes/upstream/v2:src/db/sessions.ts`
- `git show remotes/upstream/v2:src/db/dropped-messages.ts`
- `git show remotes/upstream/v2:src/modules/index.ts`
- `git show remotes/upstream/v2:src/modules/permissions/db/users.ts`
- `git show remotes/upstream/v2:src/modules/permissions/db/user-roles.ts`
- `git show remotes/upstream/v2:src/modules/permissions/index.ts`
- `git show remotes/upstream/v2:src/modules/agent-to-agent/db/agent-destinations.ts`
- `git show remotes/upstream/v2:src/modules/agent-to-agent/index.ts`
- `git show remotes/upstream/v2:src/modules/scheduling/index.ts`
- `git show remotes/upstream/v2:src/modules/scheduling/db.ts`
- v1 comparison: `/root/nanoclaw/src/db.ts`
