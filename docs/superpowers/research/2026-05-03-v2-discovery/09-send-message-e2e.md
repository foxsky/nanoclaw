# 09 — `send_message` MCP end-to-end

**Audience:** TaskFlow Phase 3+ skill author who needs to design `taskflow_send_message_with_audit` (the v2 replacement for v1's central `send_message_log` write path). The shape we ship downstream is constrained by where in v2's pipeline an audit row can be written without falsifying the audit (i.e. without recording a "delivered" before delivery actually happened, or a "failed" before retries are exhausted).

**Sources** (`git show remotes/upstream/v2:<path>`):

- `container/agent-runner/src/mcp-tools/core.ts` — MCP `send_message` tool definition and handler
- `container/agent-runner/src/destinations.ts` — `findByName`, `getAllDestinations`
- `container/agent-runner/src/db/messages-out.ts` — `writeMessageOut`, `getMessageIdBySeq`, `getRoutingBySeq`, `getUndeliveredMessages`
- `container/agent-runner/src/db/session-routing.ts` — `getSessionRouting` (default `to`)
- `container/agent-runner/src/db/connection.ts` — container DB pragmas, single-writer invariant
- `src/delivery.ts` — host poll loops, `drainSession`, `deliverMessage`, action registry
- `src/db/session-db.ts` — `getDueOutboundMessages`, `getDeliveredIds`, `markDelivered`, `markDeliveryFailed`, `migrateDeliveredTable`
- `src/db/schema.ts` — `INBOUND_SCHEMA` (`destinations`, `delivered`, `session_routing`), `OUTBOUND_SCHEMA` (`messages_out`)
- `src/channels/adapter.ts` — `ChannelAdapter`, `OutboundMessage`, `OutboundFile`
- `src/index.ts` — `setDeliveryAdapter` wiring, `getChannelAdapter` dispatch
- Companion docs: `03-session-dbs.md` (kind taxonomy + audit-projection rec), `04-taskflow-table-placement.md` (drop `send_message_log` for v2-native projection), `05-session-lifecycle.md`

---

## TL;DR — five-sentence trace

1. Agent calls MCP `send_message({ to?, text })`; container resolves `to` via `inbound.db.destinations` (or `session_routing` if omitted) and `INSERT`s a row into `outbound.db.messages_out` with an odd `seq`, `kind='chat'`, `content=JSON.stringify({text})`. (`core.ts:117-141`, `messages-out.ts:42-79`)
2. The MCP handler returns `ok` to the agent the moment that row is committed — **no delivery has happened yet**, no platform call, no platform message id. (`core.ts:140`, `messages-out.ts:79`)
3. The host's active poll runs every 1s for running sessions (sweep poll every 60s for all active sessions), opens `outbound.db` read-only and `inbound.db` read-write, diffs `messages_out` against `inbound.db.delivered`, and for each undelivered row calls `deliverMessage(msg, session, inDb)`. (`delivery.ts:108-200`)
4. `deliverMessage` enforces ACL via `agent_destinations`, then invokes the channel adapter via the `setDeliveryAdapter` shim — which dispatches by `channel_type` to `getChannelAdapter(channelType).deliver(platformId, threadId, {kind, content, files})` and awaits the platform call inline; on success the host writes one row to `inbound.db.delivered (message_out_id, platform_message_id, status='delivered', delivered_at)`, on failure it increments an in-memory attempt counter and retries up to 3 times before writing `status='failed'`. (`delivery.ts:200-282`, `index.ts:setDeliveryAdapter`, `session-db.ts:245-255`)
5. The `delivered` write is the single host-side success edge — every `kind='chat'` outbound either has a row there or eventually a `failed` row, with no other terminal states.

**Optimal audit insert point:** add `registerPostDeliveryHook(handler)` to `src/delivery.ts` next to the existing `registerDeliveryAction` registry; fire `(msg, session, platformMsgId, inDb)` immediately after the `markDelivered(...)` call inside `drainSession` (`delivery.ts:163-171`). TaskFlow registers its handler from the skill on import; nothing else in core changes. **Do not** wrap the MCP entry — the audit must reflect actual delivery, not queue-insertion.

---

## Sequence diagram

```
agent (in container)        container DB              host poll (1s)             channel adapter           inbound.db
─────────────────────       ──────────────────         ──────────────────          ───────────────           ──────────

send_message({to, text})
   │
   ▼
core.ts:handler ─────────► writeMessageOut
   │                        ├── max(seq) over BOTH dbs
   │                        ├── INSERT messages_out (id, seq=odd, kind='chat',
   │                        │       channel_type, platform_id, thread_id,
   │                        │       content=JSON({text}))
   │                        └── return seq
   │
   ◄── ok("Message sent (id: <seq>)")
                                                pollActive (every 1s)
                                                ├── getRunningSessions()
                                                ├── for each session:
                                                │     drainSession()
                                                │       ├── openOutboundDb (RO)
                                                │       ├── openInboundDb (RW)
                                                │       ├── allDue = getDueOutboundMessages()
                                                │       ├── delivered = getDeliveredIds()
                                                │       ├── undelivered = allDue \ delivered
                                                │       └── for each msg:
                                                │             deliverMessage()
                                                │               ├── ACL check
                                                │               │   (agent_destinations)
                                                │               ├── pending_questions
                                                │               │   side-effect (if ask_question)
                                                │               ├── readOutboxFiles (if files)
                                                │               └── deliveryAdapter.deliver() ───────►  adapter.deliver
                                                │                                                         (platformId, threadId,
                                                │                                                          {kind, content, files})
                                                │                                                            │
                                                │                                                            ▼
                                                │                                                          (platform API call)
                                                │                                                            │
                                                │                                                            ▼
                                                │                                                          returns platformMsgId
                                                │                                            ◄─────────────  │
                                                │             ┌── on success ──► markDelivered(inDb,
                                                │             │                     msg.id,
                                                │             │                     platformMsgId)  ───────────► INSERT OR IGNORE
                                                │             │                                                  delivered (..., 'delivered',
                                                │             │                                                              datetime('now'))
                                                │             │              ★ AUDIT HOOK FIRES HERE
                                                │             │                  registerPostDeliveryHook
                                                │             │
                                                │             └── on throw    ─► attempts++
                                                │                                if attempts >= 3:
                                                │                                  markDeliveryFailed(inDb, msg.id) ──────► INSERT OR IGNORE
                                                │                                                                            delivered (..., 'failed', ...)
                                                ▼
                                              setTimeout(pollActive, 1000)
```

---

## 1. MCP signature & validation (`core.ts:104-141`)

```ts
export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object',
      properties: {
        to:   { type: 'string', description: 'Destination name (e.g., "family", "worker-1"). Optional if you have only one destination.' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['text'],   // `to` is NOT required
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text) return err('text is required');
    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);
    const id = generateId();
    const seq = writeMessageOut({ id, kind: 'chat', /* …routing… */, content: JSON.stringify({ text }) });
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};
```

**Parameters:** only `to` and `text`. **No** `reply_to`, **no** `thread_id`, **no** `kind` override, **no** files (those are in `send_file`). **No structured validation** beyond JSON-schema `required` and the empty-string check on `text`. The `to` arg, if present, is matched verbatim against `destinations.name` (case-sensitive — see `findByName` SQL).

**Returned id is the `seq`, not the internal `id`.** That number is what `edit_message`/`add_reaction` accept later. Disjoint odd/even namespacing keeps `seq` unique across `messages_in` (host-owned, even) and `messages_out` (container-owned, odd) — load-bearing per `messages-out.ts:30-37` because edit/reaction lookups search both tables.

---

## 2. `to` resolution (`core.ts:43-99`, `destinations.ts:42-69`, `session-routing.ts:18-31`)

`resolveRouting(to)` flow:

| Case | Resolution |
|------|-----------|
| `to` omitted, `session_routing` populated | Use session's own `(channel_type, platform_id, thread_id)` — "reply in place" |
| `to` omitted, `session_routing` empty, exactly one destination | Fall through to single destination |
| `to` omitted, multiple destinations | **Error** — `"You have multiple destinations — specify \"to\". Options: …"` |
| `to` omitted, zero destinations | **Error** — `"No destinations configured."` |
| `to` set, found, `type='channel'` | `(dest.channelType, dest.platformId, threadId-if-same-channel-as-session-else-null)` |
| `to` set, found, `type='agent'` | `(channel_type='agent', platform_id=agentGroupId, thread_id=null)` |
| `to` set, **not found** | **Error** — `"Unknown destination \"X\". Known: …"` (no silent fail) |

**Source of truth.** The `destinations` table lives in **`inbound.db`**, not central. The host writes it on every container wake (`writeDestinations()`, only when the agent-to-agent module is installed) and the container reads it live every call (`destinations.ts:42-46`). Stale-window risk is mitigated by the host re-validating ACL on the delivery side (see §5).

**Thread preservation.** When `to` resolves to the same channel the session is bound to, the session's `thread_id` is preserved — so `send_message({ to: "self" })` from a thread replies in that thread. Cross-channel sends always start fresh (`thread_id=null`).

**Missing destination = explicit error** to the agent; **no silent drop**.

---

## 3. Queue insertion (`messages-out.ts:42-79`)

Once routing resolves, `writeMessageOut` (a) computes the next odd `seq` by reading `MAX(seq)` from **both** `messages_in` and `messages_out` (cross-DB read), then (b) `INSERT`s into `outbound.db.messages_out`:

```sql
INSERT INTO messages_out
  (id, seq, in_reply_to, timestamp,         deliver_after, recurrence,
   kind, platform_id, channel_type, thread_id, content)
VALUES
  ($id, $seq, NULL,      datetime('now'),   NULL,          NULL,
   'chat', $platform_id, $channel_type, $thread_id, $content);
```

**At MCP-return time:**
- `id`: `msg-<ts>-<rand>` (string)
- `seq`: next odd integer, globally unique across both DBs
- `in_reply_to`: **always NULL** (`send_message` does not set it; only `editMessage`/`addReaction` populate `operation` in `content`, never `in_reply_to`)
- `timestamp`: SQLite `datetime('now')` (UTC)
- `deliver_after`, `recurrence`: NULL
- `kind`: `'chat'`
- `platform_id` / `channel_type` / `thread_id`: from `resolveRouting`
- `content`: `JSON.stringify({text: <agent-supplied>})`

**No platform call has happened.** No `delivered` row exists yet. The MCP handler returns the moment this `INSERT` commits.

---

## 4. Host poll cadence & state machine (`delivery.ts`)

**Two timers**, both started by `src/index.ts` after `setDeliveryAdapter`:

| Timer | Cadence | Source set | Function |
|-------|---------|------------|----------|
| `pollActive` | 1000 ms | `getRunningSessions()` (containers currently spawned) | `delivery.ts:113-127` |
| `pollSweep`  | 60_000 ms | `getActiveSessions()` (all not-archived sessions) | `delivery.ts:129-142` |

Both call `deliverSessionMessages(session)` which is guarded by an in-memory `inflightDeliveries: Set<sessionId>` to prevent re-entry races between the two timer chains (`delivery.ts:38-49`). `markDelivered` uses `INSERT OR IGNORE` on the PK `message_out_id` so even a race past the in-memory guard cannot double-write the audit row.

**State machine for one outbound row:**

```
              writeMessageOut
                    │
                    ▼
         (no row in `delivered`)  ◄──── reading: undelivered
                    │
        deliverMessage attempt #N
           ┌────────┴────────┐
       success            throw
           │                │
           ▼                ▼
   markDelivered    deliveryAttempts.set(id, N+1)
   ('delivered',         │
    platform_msg_id) ┌───┴────────────┐
           │      N+1 < 3        N+1 == 3
           │         │               │
           │     log warn      markDeliveryFailed
           │     retry next       ('failed', NULL)
           │     poll tick           │
           ▼                         ▼
       terminal                  terminal
```

`deliveryAttempts` is an in-process `Map`. **Resets on host restart** — comment at `delivery.ts:32-33` flags this as deliberate ("gives failed messages a fresh chance"). So a `failed` row written before a host restart stays terminal (re-entry blocked by `getDeliveredIds` filter), but a row that hit attempts=2 then the host restarted gets attempts reset to 0 on next poll.

**No exponential backoff at this layer.** Retries fire on every poll tick (~1s) until attempts hit 3.

---

## 5. Channel adapter call (`delivery.ts:200-282`, `adapter.ts:120-132`, `index.ts setDeliveryAdapter`)

`deliverMessage` (called sequentially per message — `for (const msg of undelivered)` — never parallel within a session):

1. **Kind dispatch** (`delivery.ts:204-227`):
   - `kind='system'` → `handleSystemAction(content, session, inDb)` (registry-dispatched action, e.g. `schedule_task`); return without touching the channel adapter
   - `channel_type='agent'` → `routeAgentMessage(msg, session)` (dynamic-import from `modules/agent-to-agent`); writes a fresh `messages_in` row into the **target** session and wakes its container
   - else → channel delivery
2. **ACL check** (`delivery.ts:230-282`): unless `session.messaging_group_id === mg.id` (origin chat), require an `agent_destinations` row `(agent_group_id, target_type='channel', target_id=mg.id)`. Failure throws → falls into retry path. **Pre-existing bug fixed in v2: failures throw, never silently mark delivered.**
3. **`pending_questions`** side-effect for `ask_question` content type (interactive module).
4. **File read** from `outbox/<message_id>/` if `content.files` is non-empty (`session-manager.ts:readOutboxFiles`).
5. **Adapter dispatch** through the host's `deliveryAdapter` shim (set by `setDeliveryAdapter` in `src/index.ts`):
   ```ts
   async deliver(channelType, platformId, threadId, kind, content, files) {
     const adapter = getChannelAdapter(channelType);
     if (!adapter) { log.warn(...); return; }
     return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
   }
   ```
   This is `await`ed inline — synchronous to `drainSession` (the loop blocks on each message in turn). **No timeout** is imposed at this layer; the adapter's own `deliver()` is responsible for upstream timeouts. A hung adapter `await` blocks the entire session's drain loop until it resolves or rejects.
6. **`platformMsgId`** returned by the adapter (string) is what gets written to `delivered.platform_message_id`. Adapters that don't know the platform id may return `undefined` — column stays NULL.
7. **`clearOutbox`** removes the on-disk file directory after successful delivery.

**Adapter resolution.** `getChannelAdapter(channelType)` returns the `ChannelAdapter` instance registered by the channel skill at startup (`channel-registry.ts`). Each channel ships its own adapter (whatsapp, telegram, slack, discord, gmail). The `ChannelAdapter.deliver` contract is `(platformId, threadId, OutboundMessage) => Promise<string | undefined>` (`adapter.ts:130`).

---

## 6. `delivered` table — when written, by whom, with what (`session-db.ts:237-269`, `schema.ts INBOUND_SCHEMA`)

Schema:

```sql
CREATE TABLE delivered (
  message_out_id      TEXT PRIMARY KEY,    -- = messages_out.id (NOT seq)
  platform_message_id TEXT,                -- nullable; NULL on failure or unknown
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);
```

**Lives in `inbound.db`** (host-owned). Writing to outbound.db from the host is forbidden by the single-writer invariant (`connection.ts:1-22`); recording delivery state on the inbound side respects that boundary.

**Three writers, all in `src/db/session-db.ts`:**

| Function | Writes | When |
|----------|--------|------|
| `markDelivered(inDb, id, platformMsgId)` | `(id, platformMsgId, 'delivered', now)` | After successful adapter return |
| `markDeliveryFailed(inDb, id)` | `(id, NULL, 'failed', now)` | After 3 consecutive throws |
| `migrateDeliveredTable(inDb)` | `ALTER TABLE` to add `platform_message_id` and `status` columns to pre-existing schema | Runs once per drainSession before the first mark |

`INSERT OR IGNORE` semantics on the PK make the writes idempotent — safe under the rare cross-poll race that escapes the `inflightDeliveries` guard.

**Querying delivery from inside the container.** `getMessageIdBySeq(seq)` (`messages-out.ts:81-104`) does the v1→platform-id lookup that `edit_message`/`add_reaction` need: search `messages_in` first (inbound's `id` already IS the platform id), fall back to `messages_out` then join `delivered.platform_message_id`. If host hasn't yet delivered, the agent gets the internal `msg-xxx` id and edits/reactions silently fail at the platform layer.

---

## 7. Reply-to / threading

**`send_message` does not support `reply_to`.** No such parameter in the input schema; `in_reply_to` is always written NULL.

**Thread preservation is the only "reply" mechanism.** When `to` resolves to the same channel the session is bound to, `session_routing.thread_id` is preserved on the outbound row. Cross-channel sends drop the thread.

**`in_reply_to` is populated only by:**
- `editMessage` / `addReaction` indirectly via the `operation` field in content (the platform message id is in content, not the column)
- The router's `messages_in` writes for inbound platform replies (out of scope here)

**For TaskFlow:** if you need to reply to a specific inbound message id (for digest threading or audit linkage), you'd have to fork-extend the MCP tool or write the row directly via `writeMessageOut({ in_reply_to: <seq-of-inbound> })`. The latter is not exposed to the agent today.

---

## 8. Cross-board sends — agent A → agent B (`delivery.ts:215-227`, `agent-to-agent` module)

Agents reach other agents through `destinations.type='agent'`. When `findByName('peer-agent')` returns `type='agent'`, the routing tuple becomes `(channel_type='agent', platform_id=<target-agent-group-id>, thread_id=null)`. `writeMessageOut` writes that `messages_out` row exactly as for chat sends.

**Host-side dispatch** (`delivery.ts:215-227`):
1. `deliverMessage` sees `msg.channel_type === 'agent'`
2. Guard: `hasTable(getDb(), 'agent_destinations')` — without the agent-to-agent module installed, this throws (and falls into retry → fail path).
3. Dynamic-imports `routeAgentMessage(msg, session)` from `src/modules/agent-to-agent/agent-route.js`.
4. `routeAgentMessage` writes a fresh `messages_in` row into the **target** session's `inbound.db` (with namespaced id to avoid PK collisions on fan-out) and wakes the target container.

**ACL.** `agent_destinations` is the cross-agent ACL — same table that channel-target sends use. Source agent must have a row `(source_agent_group_id, target_type='agent', target_id=target_agent_group_id)`. `createMessagingGroupAgent` (and the operator wiring tools) auto-insert these.

**Implications for TaskFlow audit.** Cross-board sends produce **two** audit-relevant events: source-side `markDelivered` (target = `agent`) and target-side `messages_in` insert. Recommend logging only the source-side delivery hook — the target board's own audit log records its inbound side independently. (Spec line in `03-session-dbs.md:246` reaches the same conclusion.)

---

## 9. Optimal audit insert point for `taskflow_send_message_log`

**Constraint analysis:**

| Hook location | Verifies "delivered"? | Captures `platform_message_id`? | Visible to all sessions for cross-board? | Recommended? |
|---|---|---|---|---|
| MCP entry (`core.ts:117`, before `writeMessageOut`) | No — only that the agent decided to send | No | Per-session container only | **No.** Records intent, not delivery. Falsifies audit on permission-denied / adapter-down. |
| Right after `writeMessageOut` returns (still container-side) | No | No | Per-session container only | No. Same problem; a queued `messages_out` row may sit undelivered for arbitrary time. |
| Host's `drainSession` immediately after `markDelivered` (`delivery.ts:163-171`) | **Yes** | **Yes** (passed to hook) | Yes (host runs on central scope) | **YES.** This is the single success edge. |
| Host's `drainSession` immediately after `markDeliveryFailed` | Yes (terminal failure) | NULL | Yes | Yes — fire same hook with `status='failed'`, NULL `platform_message_id`. |
| Patch `markDelivered` directly | Yes | Yes | Yes | Acceptable but mixes concerns; prefer registry hook. |

**Recommendation:** add `registerPostDeliveryHook` next to the existing `registerDeliveryAction` registry (`delivery.ts:386-394`). One signature handles both terminal states by passing the `status`:

```ts
// src/delivery.ts (host-side, ~10 LOC addition)
export type PostDeliveryHook = (params: {
  msg:       OutboundMessage & { id: string };
  session:   Session;
  status:    'delivered' | 'failed';
  platformMsgId: string | null;
  inDb:      Database.Database;
}) => void | Promise<void>;

const postDeliveryHooks: PostDeliveryHook[] = [];
export function registerPostDeliveryHook(h: PostDeliveryHook): void { postDeliveryHooks.push(h); }

// inside drainSession, immediately after each markDelivered/markDeliveryFailed:
for (const h of postDeliveryHooks) {
  try { await h({ msg, session, status, platformMsgId, inDb }); }
  catch (err) { log.error('postDeliveryHook threw', { err }); }
}
```

**Why this beats the alternatives:**
- **No falsification** — fires only after the host has committed `delivered`. The audit row mirrors reality.
- **Trigger linkage available cheaply** — both `inDb` and `outDb` are open; `messages_out.in_reply_to → messages_in.id` join is local. (The `in_reply_to` is NULL for `send_message` outbound but available for ack/digest replies if TaskFlow ever wires them.)
- **Module-pattern consistent** — matches how `agent-to-agent`, `scheduling`, and `interactive` extend core today (`registerDeliveryAction`, `registerResponseHandler`, etc.).
- **Skill-only writer** — TaskFlow registers the hook from its skill on import; the central table (`taskflow_send_message_log`) ships in a skill-owned migration `src/db/migrations/module-taskflow-send-log.ts`. Core gets ~10 LOC of registry, no business logic.
- **Cross-board correct** — host runs in the central scope; it sees `session.agent_group_id`, so the audit table can be a single central table keyed by board with one row per delivery.

**Wrapper MCP tool note.** The brief mentions `taskflow_send_message_with_audit`. **Do not** implement this as an MCP wrapper around `send_message`; that would record at queue-insertion time, not delivery time, and would also force the agent to remember which tool to call. The right shape is: agents continue to call native `send_message`; TaskFlow's `registerPostDeliveryHook` filters by `session.agent_group_id` against the boards table and writes the audit row when a TaskFlow-board send completes. Zero agent-facing change. The "wrapper" is host-side and silent.

**Concrete projection columns** (from `03-session-dbs.md:170-191`):

```sql
CREATE TABLE taskflow_send_message_log (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_out_id              TEXT NOT NULL,
  agent_group_id              TEXT NOT NULL,        -- = v1 source_group_folder
  session_id                  TEXT NOT NULL,
  channel_type                TEXT,
  platform_id                 TEXT,                 -- = v1 target_chat_jid
  thread_id                   TEXT,
  platform_message_id         TEXT,
  kind                        TEXT NOT NULL,
  trigger_message_id          TEXT,                 -- = messages_out.in_reply_to
  trigger_chat_jid            TEXT,
  trigger_sender              TEXT,
  trigger_sender_name         TEXT,
  trigger_message_timestamp   TEXT,
  trigger_turn_id             TEXT,
  delivered_at                TEXT NOT NULL,
  status                      TEXT NOT NULL         -- delivered | failed
);
```

Trigger linkage: pull `messages_out.in_reply_to` (currently always NULL for `send_message` but populated for digest/recurring follow-ups), join to `messages_in.id` on the session's `inbound.db` for sender/timestamp.

---

## 10. Error propagation back to the agent

**At MCP entry / queue insertion (synchronous):**
- `text` empty → `Error: text is required`
- Routing failures → `Error: Unknown destination "X". Known: …` / `Error: No destinations configured.` / `Error: You have multiple destinations — specify "to". Options: …`

These come back as `{ content: [...], isError: true }` from the MCP handler — visible to the agent in its tool-result block, surfaceable as "tool errored" in the SDK.

**At delivery time (asynchronous, after MCP already returned):**
- ACL violations → throw → retry up to 3x → `markDeliveryFailed(... 'failed' ...)`
- Adapter throws (network / auth / platform) → same retry path
- `getChannelAdapter` returns null (channel skill not registered) → `log.warn`, **return without throwing** → the message sits as undelivered forever (no `delivered` row, no `failed` row). Spec gap; would benefit from explicit `markDeliveryFailed` here.
- Missing `messaging_group` for the `(channel_type, platform_id)` pair → throw → retry → fail
- `agent-to-agent` module not installed when `channel_type='agent'` → throw → retry → fail

**The agent does not learn about delivery failures** unless it (a) calls `edit_message`/`add_reaction` later and the seq lookup fails, or (b) the operator sets up an out-of-band mechanism. For a host-side audit consumer this is fine — the `delivered` table is the truth — but it's a real limitation for any agent-side retry/cancel logic. (TaskFlow's existing audit-via-Kipp pattern accepts this asymmetry.)

---

## Anchored references for downstream skill code

- MCP tool def: `container/agent-runner/src/mcp-tools/core.ts:104-141`
- Routing default & destination lookup: `container/agent-runner/src/mcp-tools/core.ts:43-99`, `container/agent-runner/src/destinations.ts:42-69`
- Outbound write: `container/agent-runner/src/db/messages-out.ts:42-79`
- Container DB connection / pragmas: `container/agent-runner/src/db/connection.ts:24-50`
- Schemas (canonical): `src/db/schema.ts INBOUND_SCHEMA` (`destinations`, `delivered`, `session_routing`), `OUTBOUND_SCHEMA` (`messages_out`)
- Active poll & sweep: `src/delivery.ts:108-142`
- `drainSession` & success edge (★ hook insertion point): `src/delivery.ts:155-185`
- `deliverMessage` ACL + dispatch: `src/delivery.ts:200-282`
- `delivered` writers: `src/db/session-db.ts:245-255`
- Adapter shim & dispatch: `src/index.ts setDeliveryAdapter` block, `src/channels/channel-registry.ts getChannelAdapter`
- ChannelAdapter interface: `src/channels/adapter.ts:120-160`
- Existing module registries (pattern reference): `src/delivery.ts:386-394` (`registerDeliveryAction`)

---

## Open question for follow-up

The `getChannelAdapter` returns null silent-skip path (`delivery.ts:deliveryAdapter` shim) leaves messages undelivered with no `delivered` row of any status. If a TaskFlow board has its channel skill uninstalled, audit gaps will show as silent missing rows rather than `failed` rows. Recommend the skill's audit consumer also walk `messages_out` and report rows older than N seconds with no `delivered` entry; or fix upstream by `markDeliveryFailed` in that branch. Capture in Phase 3 followups.
