# 14 — `destinations` + `agent_destinations` ACL

**Audience:** TaskFlow Phase 1 / Phase 3 skill author wiring 28 boards on top of v2's central agent registry. v1 has no per-source send ACL ("any board can send anywhere"); v2's `agent_destinations` flips this to default-deny — every cross-board send needs an explicit row. This doc is the contract: which table is authoritative, when projection refreshes, how `provision_taskflow_board` must close the loop, and the migration shape for our 28-board fork.

**Sources** (`git show remotes/upstream/v2:<path>`):

- `src/db/migrations/module-agent-to-agent-destinations.ts:5-95` — central table schema + backfill from `messaging_group_agents`
- `src/modules/agent-to-agent/db/agent-destinations.ts:1-138` — CRUD + projection-invariant docstring (the canonical statement)
- `src/modules/agent-to-agent/write-destinations.ts:1-58` — `writeDestinations(agentGroupId, sessionId)` projection writer
- `src/modules/agent-to-agent/agent-route.ts:32-44` — agent→agent ACL throw on missing destination
- `src/modules/agent-to-agent/create-agent.ts:116-128` — bidirectional row creation + projection refresh after create
- `src/modules/agent-to-agent/index.ts:14-23` — module install: registers `create_agent` delivery action
- `src/db/messaging-groups.ts:117-189` — `createMessagingGroupAgent` auto-creates destination row (does NOT refresh projection)
- `src/db/schema.ts` — per-session `INBOUND_SCHEMA.destinations` (the projection)
- `src/db/session-db.ts:55-65` — `replaceDestinations` (transactional DELETE+INSERT)
- `container/agent-runner/src/destinations.ts:1-150` — container reads projection live every lookup; system-prompt addendum builder
- `container/agent-runner/src/db/connection.ts:172-179` — `destinations` table in inbound.db
- `container/agent-runner/src/mcp-tools/core.ts:78-130` — `resolveRouting()` consults projection only
- `src/container-runner.ts:62-95` — `wakeContainer` → `spawnContainer` → `writeDestinations` (every wake)
- `src/delivery.ts:230-310` — host-side ACL re-check (re-validates against central, projection is advisory only)

---

## TL;DR — five-sentence trace

1. **Central** `agent_destinations` (one row per `(source_agent_group_id, local_name)`) is the ACL **and** the routing alias map: "this source agent is allowed to send to this target, and addresses it locally as this name." A row exists iff the send is authorized; no row = unauthorized.
2. **Per-session** `destinations` table in `inbound.db` is a projection of those rows for one specific `(agent_group_id, session_id)` pair — same data, denormalized into `(channel_type, platform_id)` or `agent_group_id` so the container can route without reading central. `writeDestinations(agentGroupId, sessionId)` rebuilds it transactionally on every container wake (`replaceDestinations` = DELETE+INSERT).
3. The container's `core.ts::resolveRouting` consults **only** the projection — `findByName` against `inbound.db.destinations`. If the projection is stale (e.g. a row was inserted into central while the container was alive), the agent will get `Unknown destination "<name>"` from the MCP tool, **even though the send would actually be allowed by the host**.
4. Host-side `delivery.ts:298-307` runs an independent ACL check against central `agent_destinations` at deliver time. So even if the projection were tampered with to invent a destination, the host would still throw `unauthorized channel destination` and mark the message failed. The projection is for routing convenience; the central table is the security boundary.
5. **Therefore the post-provisioning bug:** writing a new central row (`createDestination`) only reaches running parents on their **next** `wakeContainer` call. Until then, the container's projection is stale and `send_message` to the new child fails with "Unknown destination". `create_agent` already calls `writeDestinations` after `createDestination` (`create-agent.ts:128`); `createMessagingGroupAgent` deliberately does **not** because it's invoked from out-of-process setup scripts. TaskFlow's `provision_taskflow_board` is in-process and **must** call `writeDestinations` for every active session of every parent it just granted access to.

---

## 1. Central `agent_destinations` — schema + semantics

```sql
CREATE TABLE agent_destinations (
  agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
  local_name      TEXT NOT NULL,
  target_type     TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id       TEXT NOT NULL,   -- messaging_groups(id) | agent_groups(id)
  created_at      TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
```

(`module-agent-to-agent-destinations.ts:25-32`)

Key invariants:

- **Per-source namespace:** the PK is `(agent_group_id, local_name)`, not `(local_name)`. Worker-1 may call the admin `parent` while admin calls the child `worker-1`. Names exist only inside one agent's namespace.
- **No global aliases.** There is no "global table of named groups." Every reference to a target is scoped to a single source agent.
- **Polymorphic target:** `target_type='channel'` → `messaging_groups(id)`; `target_type='agent'` → `agent_groups(id)`. No unified FK; the type column tells you which sister table to read.
- **Existence = authorization.** From `agent-destinations.ts:1-7`: "Each row means: agent `agent_group_id` is allowed to send messages to target `(target_type, target_id)`." There is no separate ACL — same row.

Backfill (`module-agent-to-agent-destinations.ts:35-77`): when the migration runs, every existing `messaging_group_agents` wiring becomes one destination row, with `local_name = normalizeName(mg.name)` (collisions get `-2`, `-3` suffixes within each agent's namespace). Pre-v2 wirings are preserved as ACL grants.

---

## 2. Per-session `destinations` — schema + semantics

The container does **not** see `agent_destinations`. Its inbound.db has its own `destinations` table:

```sql
CREATE TABLE destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type    TEXT,            -- when type='channel'
  platform_id     TEXT,            -- when type='channel'
  agent_group_id  TEXT             -- when type='agent'
);
```

(`db/schema.ts` INBOUND_SCHEMA + `connection.ts:172-179`)

Differences from the central table:

| Central `agent_destinations` | Per-session `destinations` |
| --- | --- |
| `agent_group_id` (source) is part of PK | implicit — one DB per session, source = session.agent_group_id |
| `local_name` PK component | `name` (PK) |
| `target_id` (FK to messaging_groups OR agent_groups) | denormalized into `(channel_type, platform_id)` for channel targets, or `agent_group_id` for agent targets |
| no `display_name` | `display_name` (resolved from messaging_groups.name / agent_groups.name) |
| pure ACL | routing convenience: container can dispatch outbound `messages_out` rows with the right `(channel_type, platform_id)` directly |

(`write-destinations.ts:23-50` does the join: for `target_type='channel'`, look up `getMessagingGroup(target_id)` and copy `channel_type`, `platform_id`, `name`; for `target_type='agent'`, look up `getAgentGroup(target_id)` and copy `agent_group_id`, `name`.)

**Container-side use:**

- `destinations.ts::getAllDestinations` — list all rows, used to build the system-prompt addendum (`buildDestinationsSection`, lines 80-150). Each turn, the agent's prompt lists the names it can address.
- `destinations.ts::findByName(name)` — name → routing tuple. Used by `core.ts::resolveRouting` (line 110) when the agent calls `send_message({to: 'worker-1', ...})`.
- `destinations.ts::findByRouting(channelType, platformId)` — reverse lookup, used by formatter to display the agent's local name for an inbound sender.

The container reads on every lookup (no in-memory cache, no module-load-time read), so projection changes take effect on the very next tool call — no container restart, no SDK reload (`destinations.ts:11`).

---

## 3. `writeDestinations(agentGroupId, sessionId)` — wholesale rewrite

```ts
// write-destinations.ts:21-57
export function writeDestinations(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const rows = getDestinations(agentGroupId);     // SELECT * FROM agent_destinations WHERE agent_group_id = ?
  const resolved: DestinationRow[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = getMessagingGroup(row.target_id);
      if (!mg) continue;                          // silently drop dangling refs
      resolved.push({ name: row.local_name, display_name: mg.name ?? row.local_name,
                      type: 'channel', channel_type: mg.channel_type,
                      platform_id: mg.platform_id, agent_group_id: null });
    } else if (row.target_type === 'agent') {
      const ag = getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({ name: row.local_name, display_name: ag.name,
                      type: 'agent', channel_type: null, platform_id: null,
                      agent_group_id: ag.id });
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try { replaceDestinations(db, resolved); } finally { db.close(); }
}
```

`replaceDestinations` (`session-db.ts:55-65`) is `DELETE FROM destinations` + bulk `INSERT`, both inside one transaction. **Wholesale rewrite, not incremental.** No filter by source — `writeDestinations` always writes the full `getDestinations(agentGroupId)` result for that one source agent into that one session's projection.

**Targets one (agent_group_id, session_id) pair.** If an agent group has 2 active sessions (e.g. an agent-shared session and a DM session), you must call `writeDestinations` twice, once per `session_id`. The session lookup is left to the caller — the agent-to-agent module does not iterate sessions on your behalf.

If `inboundDbPath` doesn't exist (the session was never spawned), the function silently no-ops. Safe to call eagerly.

---

## 4. `wakeContainer` — when triggered, what it calls

`container-runner.ts:62-148`:

```
wakeContainer(session)
  └── if not already running and no in-flight wake promise:
      └── spawnContainer(session)
            ├── if hasTable('agent_destinations'):
            │     dynamic import('./write-destinations.js')
            │     writeDestinations(agentGroup.id, session.id)   // line 86-89
            ├── writeSessionRouting(...)
            ├── readContainerConfig + ensureRuntimeFields
            ├── resolveProviderContribution
            ├── buildMounts + buildContainerArgs
            └── spawn(CONTAINER_RUNTIME_BIN, args, ...)
```

Triggers (call sites in v2 main):

- `delivery.ts::handleSystemAction case 'create_agent'` — after notifying parent, `wakeContainer(fresh)`
- `agent-route.ts:64` — after `writeSessionMessage` to target session, `await wakeContainer(fresh)`
- `delivery.ts` post-approval handler → notifyAgent → wakeContainer
- inbound message dispatch in `index.ts` (router → resolveSession → wakeContainer)
- scheduled task fire path
- host-sweep recovery from stale containers

Every entry is gated by `wakePromises` dedup + `activeContainers.has` check. **Does not** call `writeDestinations` if the container is already running — the dedup branch returns early at line 65.

So: **`writeDestinations` runs exactly once per container lifetime, at spawn.** Every projection refresh after spawn requires an explicit call to the module's `writeDestinations(agentGroupId, sessionId)`.

---

## 5. The stale-projection problem

Concrete sequence that fails:

```
T=0   Parent agent-A is active, container running, session-A1 alive.
       inbound.db.destinations has rows for [admin-channel, worker-1]
T=1   Operator runs script that calls createMessagingGroupAgent({mga: A → channel-X})
       This INSERTs into central agent_destinations:
         (A, 'channel-x', 'channel', mg_X, now)
       But createMessagingGroupAgent does NOT call writeDestinations
       (see comment at messaging-groups.ts:155-167 — deliberate, because
        callers are usually one-shot setup scripts in a separate process).
T=2   Agent-A's session-A1 is still running. inbound.db.destinations is unchanged.
       Agent emits send_message({to: 'channel-x', text: ...})
T=3   container/core.ts::resolveRouting → findByName('channel-x') → undefined
       MCP returns: "Unknown destination 'channel-x'. Known: admin-channel, worker-1"
T=4   Agent typically logs the error and gives up. The send never even
       reaches messages_out, let alone the host's ACL check.
```

The window is **container's full active lifetime**. A NanoClaw container that's busy can stay alive for tens of minutes. There is no host-side timer that periodically refreshes projections — the projection is stale until the next wake.

**Mitigation paths**:

| Option | Cost | When valid |
| --- | --- | --- |
| Call `writeDestinations(parentAgentGroupId, sessionId)` immediately after `createDestination` | one extra DB transaction per parent session | always preferred when the writer runs in-process |
| Kill+respawn parent container | drops in-flight work, breaks message ordering | never acceptable for our 28-board production fork |
| Wait for natural idle + next inbound | unbounded latency, depends on user activity | fine for cosmetic destinations; not for a feature TaskFlow is about to use |
| Rely on host-side ACL only and accept the MCP "Unknown destination" error | wrong — agent never emits the send | dead end |

`create-agent.ts:128` is the canonical reference: insert central row, then immediately project. Every TaskFlow code path that grants destinations to a running agent must mirror this.

---

## 6. TaskFlow `provision_taskflow_board` post-provisioning sequence

Required ordering inside the IPC handler (running in the host process, parent containers may be alive):

```ts
// (still in v1-shape variable names; rename to v2 schema during port)
async function handleProvisionTaskflowBoard(data, parentAgentGroupId) {
  const newAgentGroupId = `ag-${Date.now()}-${shortRandom()}`;
  const now = new Date().toISOString();

  // 1. Central rows for the new agent group (FS, group, members, owner-link).
  createAgentGroup({ id: newAgentGroupId, name, folder, ... });
  initGroupFilesystem(newAgentGroup);
  // ... messaging-group, role grants, etc. ...

  // 2. Bidirectional ACL grants between PARENT and the NEW child.
  //    Parent → child: parent calls child by `<localName>`
  createDestination({
    agent_group_id: parentAgentGroupId,
    local_name: normalizeName(localChildName),    // dedup against existing
    target_type: 'agent', target_id: newAgentGroupId, created_at: now,
  });
  //    Child → parent: child calls parent `parent` (or `parent-2` on collision)
  createDestination({
    agent_group_id: newAgentGroupId,
    local_name: 'parent',
    target_type: 'agent', target_id: parentAgentGroupId, created_at: now,
  });

  // 3. PROJECTION REFRESH FOR EVERY ACTIVE SESSION OF THE PARENT.
  //    Without this, the running parent container will continue to see the
  //    old destinations list and send_message({to: '<new-board>'}) will
  //    fail at MCP-resolve time, never reaching the host ACL.
  for (const s of getSessionsForAgentGroup(parentAgentGroupId)) {
    writeDestinations(parentAgentGroupId, s.id);
  }

  // 4. The new child has no running container yet — spawnContainer's own
  //    writeDestinations call will populate its projection on first wake.
  //    No proactive refresh needed for the child.

  // 5. Notify parent (via writeSessionMessage + wakeContainer-on-fresh)
  //    that the new board is now addressable.
  notifyParent(`Board "${name}" created — you can now send to "${localName}".`);
}
```

Notes:

- **Why iterate sessions, not just "the" session?** A parent agent group can have multiple sessions: the origin DM, an `agent-shared` session, queued runners. `writeDestinations` is per-(agent_group_id, session_id) — one call per session. `getSessionsForAgentGroup` is the central-DB query (`SELECT id FROM sessions WHERE agent_group_id = ?`).
- **Why not refresh peers?** TaskFlow Phase 1 only wires the new board into the **parent's** namespace. Sibling boards do not get a destination row (= cannot send to the new board) until/unless an explicit `agent_destinations` insert is added later. This matches v1's social model: cross-board sends originate from a manager; siblings don't talk to each other directly.
- **Why insert the child→parent row?** Without it, the child agent literally cannot reach the parent at all, including for status updates and standup digests. `create-agent.ts:117-128` does the same — bidirectional grants are the v2 default.

---

## 7. Cross-board send: v1 vs v2

**v1 model** (current production):

- No `agent_destinations` table. Any agent in any group can write to `outbound_messages` with any `(channel_type, platform_id)` and the dispatcher delivers it.
- 28 boards send freely to each other; e.g. `asse-seci-taskflow → seci-main` (98 sends in 60d per the production count). No table is consulted before the dispatch — `outbound-dispatcher.ts` reads the row and calls the WhatsApp adapter.

**v2 model** (post-cutover):

- Default-deny. `delivery.ts:298-307` reads `SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ?`; if no row, throws `unauthorized channel destination` and the message goes through retry → `status='failed'`.
- Origin chat is exempt: `if (session.messaging_group_id === mg.id) skipACL` (`delivery.ts:283-287`). The board can always reply to its own WhatsApp group without an ACL row.
- Every **other** target needs an explicit row.

**Migration shape for our 28 boards** — there is no wildcard primitive. The migration must enumerate `(source, target)` pairs and INSERT one row each:

```ts
// Inside the v2 cutover migration / install script
for (const sourceBoard of allTaskflowBoards) {            // 28 sources
  for (const targetMG of allMessagingGroupsBoardCanReach) {  // ~28 messaging groups
    if (targetMG.id === sourceBoard.messagingGroupId) continue;  // origin exempt
    createDestination({
      agent_group_id: sourceBoard.agentGroupId,
      local_name: normalizeName(targetMG.name),  // e.g. 'seci-main', 'asse-seci-taskflow'
      target_type: 'channel',
      target_id: targetMG.id,
      created_at: now,
    });
  }
}
```

Worst case 28×28 = 784 rows; collision-safe via `normalizeName + suffix` per source's namespace. The `idx_agent_dest_target` index keeps the host-side ACL check at O(1) per delivery.

**Production-realism check:** the validated top cross-board pair is `asse-seci-taskflow → seci-main` (98 sends in 60d). Under v2 ACL, this requires:

```sql
INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
VALUES ('<asse-seci-taskflow ag>', 'seci-main', 'channel', '<seci-main mg>', now);
```

Plus, since the asse-seci container is alive when the migration completes:

```ts
for (const s of getSessionsForAgentGroup(asseSeciAgentGroupId))
  writeDestinations(asseSeciAgentGroupId, s.id);
```

If we skip the projection refresh, the next 98 sends — every one of them — will fail at the container with "Unknown destination 'seci-main'". The host ACL row exists; the agent never sees it.

**No wildcard escape hatch in v2.** There is no `target_id='*'` semantic; `delivery.ts:301` does an `=` match on `target_id`, not a `LIKE` or `IN`. If we wanted "any board can send anywhere" preserved (= v1 behavior), we'd need either:

1. The full N×M enumeration above (recommended, explicit, auditable). 784 rows for our fork.
2. A patch to `delivery.ts` adding a wildcard target id check before the strict equality. This patches core, violates the skills-only rule, and removes the audit trail — **not acceptable**.
3. Ship a "permissive mode" config that bypasses the ACL when set. Same objection — modifying `delivery.ts`.

Option 1 is the only skill-compliant path. The N×M table also gives us, for free, the named-alias system that the agent prompt addendum needs: each board sees a list of human-readable destination names (`seci-main`, `setd-secti-taskflow`, …) instead of a soup of opaque IDs.

---

## 8. ACL bypass options (none are clean)

| Path | Mechanism | Verdict |
| --- | --- | --- |
| Origin reply | Hard-coded in `delivery.ts:283`, no row needed | Always exempt — works for "board replies to its own WhatsApp group" |
| Self-message | `agent-route.ts:36` — `targetAgentGroupId !== session.agent_group_id` skipped | Works for system-injected follow-ups, not cross-board |
| Module absent | `delivery.ts:298` — `if hasTable('agent_destinations')` guards the check | Skipping the agent-to-agent module entirely disables the ACL globally. **TaskFlow must keep the module installed** because it depends on `create_agent` for child boards. |
| Patch `delivery.ts` | Add wildcard / permissive flag | Violates skills-only rule. Not on the table. |
| Insert N×M rows | Explicit grant per pair | The path. ~784 rows for 28 boards. |

---

## 9. Refresh-call inventory in v2 main

Places that mutate central `agent_destinations` and the corresponding refresh discipline:

| Mutation site | In-process? | Refreshes projection? | Notes |
| --- | --- | --- | --- |
| `create-agent.ts:128` | yes (delivery action handler) | yes — `writeDestinations(session.agent_group_id, session.id)` | Canonical pattern |
| `messaging-groups.ts:184` (`createMessagingGroupAgent`) | usually out-of-process (`init-first-agent.ts`, `/manage-channels`) | **no** — comment at lines 155-167 explicitly waives | Only safe because callers are separate processes. TaskFlow callers ARE in-process and must add the refresh. |
| `agent-destinations.ts::deleteDestination` | depends on caller | **no** (responsibility on caller) | Same rule on delete |
| `agent-destinations.ts::deleteAllDestinationsTouching` | swap-request rollback | **no** + caller must use `getDestinationReferencers` first to find peers | Used by dev-agent teardown |

TaskFlow adds a fourth row: `provision_taskflow_board` mutates central rows for the parent (in-process IPC handler) and **must** include the projection refresh.

---

## 10. Open questions for Phase 1 implementation

- **`getSessionsForAgentGroup` helper** — does v2 expose a public function for "all sessions of an agent group" or do we need to add one? (`db/sessions.ts` — out of scope for this doc; check at port time.)
- **Concurrent provision storms** — if 5 boards are provisioned in 100ms, do we end up with 5 serial `replaceDestinations` transactions per parent? Yes; `replaceDestinations` is one transaction per call. Acceptable; SQLite transactions are sub-ms on this size.
- **Stale projection during the refresh window** — between the `INSERT` into central and `writeDestinations`, a delivery sweep could read central and a parallel container lookup could read the projection, with the projection still empty. The container will see a pre-grant view; this only matters if the parent tries to use the new destination in the few-ms window. Practically: the agent has to receive a chat turn, decide to use the destination, and have its tool call resolve, all faster than the IPC handler can finish. Not a real concern.
- **Migration ordering** — when porting our 28 boards, run the 784-row INSERT **before** starting the v2 service for the first time, so containers see the full ACL on their first wake. If a service has already started, follow each insert with `writeDestinations` for any session that's already alive.

---

## Bottom line for the cutover spec

1. Adopt v2's `agent_destinations` model verbatim — do **not** patch `delivery.ts` to weaken the ACL.
2. Migration script enumerates all required `(source, target)` pairs (~784 rows for 28 boards) and inserts them before the v2 service first starts.
3. `provision_taskflow_board` IPC handler follows `create-agent.ts:117-128` exactly: central rows first, then `writeDestinations` for every session of every parent that just received a grant.
4. Document the projection-invariant in our skill's TaskFlow contributor guide so future TaskFlow features that wire new boards don't drop the refresh and reproduce the "post-provisioning send fails" bug Codex#9 + Batch 1 surfaced.
