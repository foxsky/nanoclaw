# v2 Session Lifecycle + Destination Projection

Deep-research note for the `add-taskflow` v2-native redesign. Goal: nail down whether
`provision_taskflow_board` can immediately do a cross-board send to the new board, and
if not, what the skill must do to bridge the gap.

All citations are against `upstream/v2` (commands of the form `git show upstream/v2:<path>`).

---

## Session creation

A v2 "session" is a row in central `sessions` plus a folder
`data/v2-sessions/<agent_group_id>/<session_id>/` with two SQLite files
(`inbound.db` host-owned, `outbound.db` container-owned), a `.heartbeat` file,
and `inbox/`+`outbox/` directories. Path helpers: `sessionDir()`,
`inboundDbPath()`, `outboundDbPath()`, `heartbeatPath()` in
`src/session-manager.ts:39-62`.

Sessions are created lazily by `resolveSession(agentGroupId, messagingGroupId,
threadId, sessionMode)` in `src/session-manager.ts:85-126`:

1. Look up an existing active session by `(agent_group_id, messaging_group_id,
   thread_id)` — scoped by `agent_group_id` so fanout to multiple agents in
   one chat can't deliver to the wrong agent (`findSessionForAgent` at
   `src/db/sessions.ts:36-53`).
2. If `sessionMode === 'agent-shared'`, ignore the messaging group and just look
   for any active session for the agent group (`findSessionByAgentGroup` at
   `src/db/sessions.ts:56-60`).
3. If none found, INSERT a new `sessions` row (`status='active'`,
   `container_status='stopped'`) and call `initSessionFolder()` which creates
   the directory and writes `INBOUND_SCHEMA` + `OUTBOUND_SCHEMA` via
   `ensureSchema()` (`src/session-manager.ts:128-136`).

Triggers that create a session:

- **Inbound user message** — `routeInbound` → `deliverToAgent` →
  `resolveSession` (`src/router.ts:390`).
- **Agent-to-agent send** — `routeAgentMessage` calls
  `resolveSession(targetAgentGroupId, null, null, 'agent-shared')`
  (`src/modules/agent-to-agent/agent-route.ts:47`). This is the path that auto-
  creates a session on the target side when one agent sends to another.
- **Scheduled task fanout** — `handleRecurrence` writes a fresh row for the
  next occurrence into the existing session's `inbound.db`; it does NOT
  create a new session.

A session's `container_status` starts as `'stopped'`. The container is
spawned only when something has reason to wake it (see next section).

---

## Sleep / wake / teardown lifecycle

There is no "session" concept that's distinct from "container running for that
session." A session is always alive in central state; the *container* is what
sleeps and wakes.

### Wake

Two host-side entry points call `wakeContainer(session)` in
`src/container-runner.ts:62-77`:

1. **`router.ts:447-454`** — after writing a `trigger=1` message into
   `inbound.db`, the router wakes the container so it sees the new pending
   message immediately.
2. **`host-sweep.ts:174-179`** — every 60s the sweep runs `countDueMessages`
   on every active session's `inbound.db`. If `count > 0` and the container
   isn't running, it wakes it. This is the *only* mechanism that picks up
   scheduled tasks whose `process_after` just elapsed — the host sweep is
   the cron driver.

Plus two same-process triggers:

3. **`create-agent.ts:33`** — after writing a `system` notification into the
   parent's session, the delivery handler wakes the parent so it sees the
   "agent created" confirmation.
4. **`agent-route.ts:62-63`** — after delivering an agent→agent message into
   the target's `inbound.db`, the router wakes the target's container.
5. **`scheduling/actions.ts:107-110`** — `handleUpdateTask` wakes the parent
   if `update_task` matched no live task (so the agent sees the failure
   notification).

`wakeContainer` is idempotent (`activeContainers.has(sessionId)` short-circuit
+ `wakePromises` map for in-flight de-dup at `container-runner.ts:62-77`).

`spawnContainer` (`container-runner.ts:79-158`) does the heavy lifting:

```
spawnContainer(session)
  ├── getAgentGroup(session.agent_group_id)
  ├── if hasTable('agent_destinations'):
  │     writeDestinations(agentGroup.id, session.id)   ← projects ACL
  ├── writeSessionRouting(agentGroup.id, session.id)   ← default reply addr
  ├── readContainerConfig + ensureRuntimeFields
  ├── buildMounts (session dir at /workspace, group dir at /workspace/agent)
  ├── buildContainerArgs (OneCLI gateway, host gateway, mounts)
  └── spawn(CONTAINER_RUNTIME_BIN, args, …) → markContainerRunning
```

Container starts the v2 agent-runner (`container/agent-runner/src/index.ts`)
which calls `loadConfig()`, then `buildSystemPromptAddendum(assistantName)`
(`destinations.ts:82`) — this is the agent's identity + destination list,
**rendered once at startup from the projected `destinations` table**, and
passed to `runPollLoop` as `systemContext.instructions`. The poll loop
threads the same `systemContext` into every `provider.query()` call
(`poll-loop.ts:152-156`). So *the system-prompt human-readable list of
destination names is frozen for the life of the container*. The
machine-resolvable destination map (used by `findByName`) IS live — see
"Destination projection mechanics" below.

### Sleep

There is no host-side idle timeout in v2 (explicitly noted at
`container-runner.ts:139-143`). A container exits when:

- The container process exits on its own (Bun process death, OOM, manual kill).
- `host-sweep.ts:206-239` decides the container is stuck (heartbeat older than
  `ABSOLUTE_CEILING_MS = 30 min` ignoring fresh containers, OR a `processing`
  claim has been silent past `CLAIM_STUCK_MS = 60 s` with no heartbeat tick
  since the claim) and calls `killContainer`.

There's no graceful "go to sleep" — the container polls forever
(`poll-loop.ts:54` infinite while loop). If you want the container to stop,
you kill it; there is no explicit teardown signal. The poll loop touches
`.heartbeat` after every provider event (`poll-loop.ts:281`) which the host
sweep uses for liveness.

### Teardown

When the container exits (`container-runner.ts:145-150`):

- `activeContainers.delete(sessionId)`
- `markContainerStopped(sessionId)` (sets `container_status='stopped'`)
- `stopTypingRefresh(sessionId)`
- Outbound DB stays on disk; processing rows in `outbound.db.processing_ack`
  with status='processing' will be reset by the next sweep
  (`host-sweep.ts:165-167` `resetStuckProcessingRows`).

`/clear` from a user clears the SDK continuation in `outbound.db.session_state`
(`poll-loop.ts:96-97`) but does NOT delete the session — the next message
just starts a fresh Claude session against the same DBs.

State preserved across teardown: `inbound.db` (everything), `outbound.db`
(everything except stale processing claims, which the sweep wipes), the
group folder under `groups/<folder>/`, and `data/v2-sessions/<aid>/<sid>/`.
State wiped: `wakePromises` map (in-process), `activeContainers` map
(in-process). A session never gets garbage-collected by v2 itself; admin or
test code has to call `deleteSession`.

---

## Destination projection mechanics

The system has TWO destination tables and TWO authorization checks. This is
load-bearing, easy to confuse, and explained directly in
`src/modules/agent-to-agent/db/agent-destinations.ts:11-34` (top-of-file
invariant) and `container/agent-runner/src/destinations.ts:1-12` (container
side).

### Central: `agent_destinations`

Source of truth. One row per (source agent group, local_name, target). Used
for:

- **Authoritative ACL**: `delivery.ts:298-309` re-checks
  `agent_destinations` via inline SQL on every outbound delivery, so even a
  stale per-session projection cannot be exploited — the host enforces
  centrally.
- **Agent-to-agent permission**: `agent-route.ts:36-43` calls `hasDestination`
  against the central table.
- **Wiring side effect**: `createMessagingGroupAgent` auto-inserts a
  `'channel'`-typed row so the agent can deliver to the wired chat
  (`db/messaging-groups.ts:148-191`).
- **`create_agent` side effect**: bidirectional rows (parent→child as
  `localName`, child→parent as `'parent'`) at `create-agent.ts:89-110`.

### Per-session: `inbound.db.destinations`

Projection of `agent_destinations` rows for a single session's agent group,
joined to `messaging_groups` / `agent_groups` to flatten target metadata
(channel_type, platform_id, agent_group_id). Used inside the container by
`destinations.ts:findByName/getAllDestinations` to resolve `<message
to="name">` blocks.

The container reads `destinations` LIVE from inbound.db on every
`findByName` call — it's a fresh `db.prepare(…).get()` each time
(`container/agent-runner/src/destinations.ts:49-52`). There is no in-memory
cache. Cross-mount visibility for SQLite-DELETE-mode is preserved by the
host's open-write-close discipline (`session-manager.ts:1-12`).

### When the projection gets written

Five call sites today (count this honest if you add more — the invariant
comment lists the existing ones):

1. **`spawnContainer` on every wake** (`container-runner.ts:89-92`) —
   guarded by `hasTable('agent_destinations')` so the projection is silently
   skipped when the agent-to-agent module isn't installed.
2. **`create_agent` delivery handler** (`create-agent.ts:116`) — after
   inserting the bidirectional rows centrally, calls
   `writeDestinations(session.agent_group_id, session.id)` so the parent's
   running container immediately sees the child as a destination.
3. **`session-manager.writeSessionRouting`** is called alongside
   `writeDestinations` on every wake (`container-runner.ts:93`) so the default
   reply address (channel_type, platform_id, thread_id) is also refreshed.

`createMessagingGroupAgent` itself does NOT call `writeDestinations` — it
only writes the central row, with a giant warning comment
(`db/messaging-groups.ts:155-167`) explaining that callers are expected to
either (a) be one-shot setup processes that don't share the host process
with a running container, or (b) call `writeDestinations` themselves
afterwards.

### Live vs. system-prompt drift

A subtle thing: `findByName` is live, but `buildSystemPromptAddendum` runs
once at container startup (`container/agent-runner/src/index.ts:54`). So if
you add a new destination to a running container's projection mid-run, the
container CAN resolve `<message to="new-name">` correctly, but its system
prompt won't *list* the new name in the "## Sending messages" section. The
agent has to be told the new name by some other means (e.g., a system
chat message into its inbound.db saying "you can now message X").

`create_agent.ts:119-122` does exactly this: after wiring destinations, it
notifies the parent agent via a chat message naming the new local_name, and
wakes it.

---

## The provisioning-gap problem

Codex's flag is real and matches what the v2 source documents.

**Scenario:** the operator (or a TaskFlow MCP tool) calls
`createMessagingGroupAgent` for board B (the new TaskFlow board) while
board A's container is currently running and processing the operator's
"/wire-as-taskflow-board" command.

1. Central: `messaging_group_agents` row inserted; `agent_destinations` row
   `(A, 'board-b', 'channel', mgB)` inserted as a side effect.
2. **A's `inbound.db.destinations` is unchanged.** The new row exists
   centrally but `writeDestinations(A.id, A.session.id)` was not called. A's
   container's `findByName('board-b')` returns `undefined`.
3. If A's agent now tries `<message to="board-b">hello</message>`, the
   poll loop logs `Unknown destination in <message to="board-b">,
   dropping block` (`poll-loop.ts:359-362`) and the message becomes a
   scratchpad entry. **It's silently dropped.**

The same gap exists for the symmetric direction: `createMessagingGroupAgent`
inserts the destination row for B→its own wired channel, but B doesn't have a
container running yet, so there's nothing to refresh. That's fine — when B
first wakes, `spawnContainer` runs `writeDestinations` and the projection is
correct from the first moment of B's life.

The one-direction gap is: **A is running, you mutate A's central destinations,
A's projection is now stale.**

### What about the central ACL?

The central ACL check (`delivery.ts:298-309`) IS authoritative on every send.
But it kicks in at the *outbound delivery* stage, after the container has
already written `messages_out`. The container drops the unknown-destination
block *inside* `dispatchResultText` BEFORE it ever writes to `messages_out`
— so the central ACL never gets to opine, because nothing was sent. The
provisioning gap is a *resolution* gap (name → target), not an *authorization*
gap.

---

## Concrete TaskFlow recommendation

### Question recap

> TaskFlow's `provision_taskflow_board` MCP creates a new board. Immediately
> after, an existing TaskFlow board (the parent / operator's session) sends a
> `taskflow_send_message_with_audit` to the new board. Will this work?

**As of unmodified v2, no, not reliably.** The provisioning flow runs in the
*delivery handler* path (it's a system action emitted by the parent's
container), so it happens in-process with the running parent container. The
parent's `agent_destinations` gets a new central row for the child, but the
parent's session `inbound.db.destinations` does NOT — `createMessagingGroupAgent`
is the central-only writer. If the parent then sends to `<message to="<child>">`
in the same turn or before its next wake, the block is dropped silently.

### Three workable approaches, ranked

**1. Recommended — call `writeDestinations` from the MCP tool itself.**

`provision_taskflow_board` is a custom tool implemented in the skill. After
it INSERTs the central rows, it should:

```ts
import { writeDestinations } from '<path>/modules/agent-to-agent/write-destinations.js';

// After createMessagingGroupAgent(parentBoard, newBoardMg) completes:
writeDestinations(parentBoard.agent_group_id, parentSession.id);
```

This is exactly what `create_agent.ts:116` does and what the top-of-file
invariant explicitly mandates for new call sites. No extra wake needed —
the parent is already running (it's the one that invoked the MCP tool), and
its next `findByName('<new-board-name>')` will resolve correctly because
the projection is now fresh.

For the *child* side: no action needed. The child has no running container
yet; when something eventually triggers its first wake (operator message,
scheduled task), `spawnContainer` will project its destinations from scratch.

**2. Acceptable fallback — don't send cross-board in the same turn.**

If the MCP tool can't import `writeDestinations` for some module-isolation
reason, the safe pattern is: the parent's MCP just provisions and reports
success. Any actual cross-board *send* from the parent has to happen in a
LATER turn (i.e., after the parent's container has been killed and re-woken
by the host sweep, OR after at least one inbound message from the child
side that triggered an agent-to-agent reply). In practice, this means
TaskFlow's "send the welcome message to the new board" step has to be
scheduled — not done inline. Reliability is fine but UX is jarring (the
parent reports "board created" but a separate scheduled task does the
welcome 60s later).

**3. Heavy-handed — kill+respawn the parent container.**

`killContainer(parentSession.id, 'destinations refresh')` from the MCP
followed by `wakeContainer(freshSession)`. Works but throws away the
parent's in-flight conversation state and SDK continuation. Don't do this.

### Which destination NAME to use

This is also non-trivial. `createMessagingGroupAgent` synthesizes a
`local_name` for the destination via `normalizeName(mg.name) || fallback`
with a `-2`/`-3` suffix on collision (`db/messaging-groups.ts:174-191`). The
TaskFlow MCP tool should READ that resolved name back via
`getDestinationByTarget(parentBoardId, 'channel', newMgId)` and surface it
to the parent agent in the success notification — otherwise the agent has
to guess the name, which it will get wrong if there's any collision.

### Wake-trigger primitives for skill code

Skill code running in the host process (delivery action handlers, MCP
tools that are dispatched as system actions) can:

- `wakeContainer(session)` from `src/container-runner.ts` — explicit wake.
  Idempotent.
- `writeSessionMessage(...)` to inject a synthetic chat/system message
  into a session's `inbound.db`. The next wake (or the active container's
  poll tick) will pick it up. Combined with `wakeContainer` afterwards,
  this is the standard "notify and wake" pattern (`create-agent.ts:21-35`,
  `scheduling/actions.ts:93-110`).
- `writeDestinations(agentGroupId, sessionId)` to refresh the per-session
  projection without waking. This is the missing piece for the
  provisioning gap.

Skill code running INSIDE the container (MCP tool handlers in
`container/agent-runner/src/mcp-tools/…`) cannot do any of these directly.
Container-side tools must write a `kind='system'` row to `messages_out`
with an `action` field; the host's delivery-action registry dispatches it
to a handler that runs in the host process (see
`scheduling/actions.ts` and `create-agent.ts` for the pattern). So
TaskFlow's `provision_taskflow_board` will be a container-side MCP tool
that emits a `system` message → host-side delivery-action handler that
does the actual provisioning + `writeDestinations` + notification.

### Summary recommendation

Implement `provision_taskflow_board` as the standard two-piece v2 pattern:

1. **Container-side MCP tool** in `add-taskflow/add/container/mcp-tools/…`
   that just writes a `kind='system'` message with
   `action='provision_taskflow_board'` and the new-board parameters. No DB
   work in the container.
2. **Host-side delivery-action handler** in `add-taskflow/add/host/…`
   registered via `registerDeliveryAction('provision_taskflow_board', …)`.
   The handler:
   1. Validates parameters and the parent's authority.
   2. Calls `createAgentGroup` + `createMessagingGroupAgent` +
      `createDestination` for each cross-board pair.
   3. Schedules the four daily/weekly tasks via `insertTask`.
   4. **Calls `writeDestinations(parentSession.agent_group_id,
      parentSession.id)`** to project the new destination into the
      parent's running container.
   5. Looks up the synthesized `local_name` via
      `getDestinationByTarget` and writes a chat-kind system message into
      the parent's session naming the new board.
   6. Calls `wakeContainer(parent)` (idempotent — usually a no-op since
      the parent is already running, but safe).

After this completes, an immediate same-turn `<message to="<new-name>">`
from the parent works. The new board's first wake (e.g., its first
scheduled task firing 60s later, or an inbound from its WhatsApp group)
will project its own destinations correctly.

The TaskFlow skill MUST NOT skip step 4 — that's the entire substance of
the provisioning gap.
