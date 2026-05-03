# v2 Per-Session DB Architecture

Research date: 2026-05-03. Sources are all on `remotes/upstream/v2`; cite as `<path>:<line>` or section.

v1 used a central `store/messages.db` plus a filesystem IPC layer (`data/ipc/{group}/{messages,outbox}/`). v2 deletes IPC entirely. The host↔container bridge is now **two SQLite files per session**, with strict single-writer-per-file: `inbound.db` (host writes, container reads RO) and `outbound.db` (container writes, host reads RO). The single-writer rule + `journal_mode=DELETE` + open-write-close are load-bearing because SQLite locking and WAL `-shm` mmap don't propagate across the bind mount (`docs/db.md §4`, `src/session-manager.ts:1-13`, `container/agent-runner/src/db/connection.ts:1-22`).

There is **no `send_message_log` analogue in v2**. v1's audit table doesn't exist anywhere upstream — confirmed by `git grep -l 'send_message_log' remotes/upstream/v2` returning empty. This is a deliberate deletion; v2 keeps no long-term per-message audit. Implications discussed in §3.

---

## inbound.db schema + lifecycle

Schema lives in `src/db/schema.ts` as the `INBOUND_SCHEMA` constant. Created by `ensureSchema(path, 'inbound')` in `src/db/session-db.ts:13` when the session folder is provisioned (`initSessionFolder`, `src/session-manager.ts:130-140`).

Tables (full list — there are no others):

1. **`messages_in`** — every message landing in the session.
   ```sql
   CREATE TABLE messages_in (
     id            TEXT PRIMARY KEY,
     seq           INTEGER UNIQUE,            -- EVEN only (host)
     kind          TEXT NOT NULL,
     timestamp     TEXT NOT NULL,
     status        TEXT DEFAULT 'pending',    -- pending|completed|failed|paused
     process_after TEXT,
     recurrence    TEXT,                      -- cron expr
     series_id     TEXT,                      -- groups recurring occurrences
     tries         INTEGER DEFAULT 0,
     trigger       INTEGER NOT NULL DEFAULT 1, -- 0=context-only, 1=wake
     platform_id   TEXT,
     channel_type  TEXT,
     thread_id     TEXT,
     content       TEXT NOT NULL              -- JSON, shape per kind
   );
   ```
   Writers: `insertMessage()` / `insertTask()` / `insertRecurrence()` — all in `src/db/session-db.ts` and `src/modules/scheduling/db.ts`. The host calls them via `writeSessionMessage()` (`src/session-manager.ts:170-220`) and via the scheduling module. Reader: `getPendingMessages()` in `container/agent-runner/src/db/messages-in.ts:48-67`.

2. **`delivered`** — host-tracked outbound delivery outcome, keyed by `messages_out.id`.
   ```sql
   CREATE TABLE delivered (
     message_out_id      TEXT PRIMARY KEY,
     platform_message_id TEXT,
     status              TEXT NOT NULL DEFAULT 'delivered',  -- delivered|failed
     delivered_at        TEXT NOT NULL
   );
   ```
   Writer: `markDelivered()` / `markDeliveryFailed()` in `src/db/session-db.ts`. Container reads `platform_message_id` to target edits and reactions (`getMessageIdBySeq()` in `container/agent-runner/src/db/messages-out.ts:90-115`). Lazy migration via `migrateDeliveredTable()` patches older session DBs.

3. **`destinations`** — projection of central `agent_destinations`. Container's local ACL/routing table.
   ```sql
   CREATE TABLE destinations (
     name           TEXT PRIMARY KEY,
     display_name   TEXT,
     type           TEXT NOT NULL,   -- 'channel' | 'agent'
     channel_type   TEXT,
     platform_id    TEXT,
     agent_group_id TEXT
   );
   ```
   Refresh semantics: rewritten wholesale (`DELETE + INSERT` in a transaction) by `replaceDestinations()` (`src/db/session-db.ts:54-66`), called from `writeDestinations()` (`src/modules/agent-to-agent/write-destinations.ts:18-58`). Triggered on **every container wake** (`src/container-runner.ts:88-93`) and **on demand** when wiring changes mid-session (e.g. `create_agent`). Container queries it live on every send_message lookup, so changes take effect without restart.

4. **`session_routing`** — single-row table (`id=1`) holding the default reply address.
   ```sql
   CREATE TABLE session_routing (
     id           INTEGER PRIMARY KEY CHECK (id = 1),
     channel_type TEXT,
     platform_id  TEXT,
     thread_id    TEXT
   );
   ```
   Writer: `writeSessionRouting()` (`src/session-manager.ts:142-166`), called on every container wake. Derived from `sessions.messaging_group_id` + `sessions.thread_id`.

Lifecycle: created at `initSessionFolder`, never deleted while the session lives. `messages_in` rows persist permanently with `status` rolling pending → processing-acked-via-outbound → completed/failed (host-side `syncProcessingAcks()` updates the row).

### `messages_in.kind` values

Enumerated by reading `formatter.ts:121-125`, router writes, and scheduling module:

| `kind` | Origin | Trigger flow |
|--------|--------|---------------|
| `chat` | router from inbound chat events (`src/router.ts:405,427`) | wake (trigger=1) unless `ignored_message_policy='accumulate'` for that wiring |
| `chat-sdk` | router from chat-sdk-bridge events | same as `chat` |
| `task` | scheduling module `insertTask()` (`src/modules/scheduling/db.ts:18-37`) | always wake when `process_after <= now`; recurring tasks fan out via `handleRecurrence` in `src/host-sweep.ts:181-184` |
| `webhook` | webhook channel adapters | wake; formatted as `formatWebhookMessage` |
| `system` | container internal sends (e.g. ask_user_question response) | filtered out by poll-loop (`container/agent-runner/src/poll-loop.ts:59`) — they're **MCP-tool responses**, not agent-facing prompts |

Per-kind processing flow inside the container (`container/agent-runner/src/formatter.ts:formatMessages`): chat+chat-sdk grouped together as a single `<messages>` block; task/webhook/system each get their own block. The poll-loop's accumulation gate (`poll-loop.ts:75-83`) skips a wake whenever every pending row has `trigger=0` — this is the v2 mechanism for "store as context, don't engage".

Scheduling: `kind='task'` rides on the same table. The scheduling module piggybacks rather than owning a separate table — see header comment of `src/modules/scheduling/db.ts:1-13`. `cancel_task` / `pause_task` / `resume_task` match by `id OR series_id` so the live next occurrence of a recurring task is updated, not the completed row the agent last saw (same file, lines 39-58). Recurrence fanout: `getCompletedRecurring()` lists rows with `status='completed' AND recurrence IS NOT NULL`; for each, `insertRecurrence()` writes a fresh `messages_in` row with the next cron tick and shared `series_id`, then `clearRecurrence()` removes the cron from the source row so it doesn't fire again.

### Sequence-numbering invariant

Host writes **even** seqs (2, 4, 6…) via `nextEvenSeq()` in `src/db/session-db.ts:75-78`. Container writes **odd** seqs (1, 3, 5…) by reading `MAX(seq)` across **both** tables (`container/agent-runner/src/db/messages-out.ts:54-58`). Disjoint parity is the agent-facing message-ID disambiguator: when the agent calls `edit_message(seq=5)` or `add_reaction(seq=6)`, parity routes the lookup (odd → `messages_out`, even → `messages_in`). Not enforced by a constraint — only by the two helpers. Add another writer to either table at your peril.

---

## outbound.db schema + lifecycle

Schema constant: `OUTBOUND_SCHEMA` in `src/db/schema.ts`. Container creates extra tables on demand (forward-compat for older session folders) via `getOutboundDb()` in `container/agent-runner/src/db/connection.ts:35-78`.

Tables:

1. **`messages_out`** — every message the agent produces.
   ```sql
   CREATE TABLE messages_out (
     id            TEXT PRIMARY KEY,
     seq           INTEGER UNIQUE,    -- ODD only (container)
     in_reply_to   TEXT,
     timestamp     TEXT NOT NULL,
     deliver_after TEXT,
     recurrence    TEXT,
     kind          TEXT NOT NULL,     -- chat | chat-sdk | system | …
     platform_id   TEXT,
     channel_type  TEXT,
     thread_id     TEXT,
     content       TEXT NOT NULL      -- JSON; operation lives inside
   );
   ```
   Writer: `writeMessageOut()` (`container/agent-runner/src/db/messages-out.ts:34-75`). Readers: `src/delivery.ts` poll loop (read-only handle), `getMessageIdBySeq()` / `getRoutingBySeq()` for edit/reaction targeting.

   Content shapes (`docs/api-details.md §Session DB Schema Details`): plain `{text}`, chat-sdk `{markdown}`, `{card, fallbackText}`, ask_question `{operation:'ask_question', questionId, options}`, `{operation:'edit', messageId, text}`, `{operation:'reaction', messageId, emoji}`, `{action: 'reset_session' | 'schedule_task' | 'cancel_task' | 'pause_task' | 'resume_task'}` for system actions.

2. **`processing_ack`** — container's status feed for the host. Replaces what would otherwise be writes to `inbound.db`.
   ```sql
   CREATE TABLE processing_ack (
     message_id     TEXT PRIMARY KEY,  -- references messages_in.id
     status         TEXT NOT NULL,     -- processing | completed | failed
     status_changed TEXT NOT NULL
   );
   ```
   Writer: `markProcessing` / `markCompleted` / `markFailed` in `container/agent-runner/src/db/messages-in.ts:69-99`. Reader: host-side `syncProcessingAcks()` (`src/db/session-db.ts:165-177`) called every 60s sweep tick (`src/host-sweep.ts:155-158`). On container startup, `clearStaleProcessingAcks()` (`container/agent-runner/src/db/connection.ts:127-129`) clears leftover `processing` rows so a crashed container's claims get re-tried.

3. **`session_state`** — persistent KV. Cleared by `/clear`.
   ```sql
   CREATE TABLE session_state (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   ```
   Sole current consumer: SDK session-id resume across container restarts (`container/agent-runner/src/db/session-state.ts:8-24`, key `sdk_session_id`). Cleared via `clearStoredSessionId()` when the agent receives `/clear`.

4. **`container_state`** — single-row tool-in-flight tracker (added post-initial-schema; lazy-created in `connection.ts:64-77`). Container writes on `PreToolUse`, clears on `PostToolUse`. Host's stuck-detection sweep widens its tolerance window when Bash is running with a long declared timeout (`src/host-sweep.ts:90-118`).

Outbound lifecycle: `messages_out` rows are **persistent**, never deleted. The host's only state for "delivered or not" is the presence of a row in `inbound.db.delivered` keyed by `message_out_id`. So the messages_out table grows without bound for the life of the session folder. Delivery polling: 1s active loop over running sessions + 60s sweep over all active sessions (`src/delivery.ts:19-21,116-145`); `inflightDeliveries` set guards against the two loops racing on the same session (`delivery.ts:32-44`).

---

## TaskFlow audit projection placement

v2 keeps **no** equivalent of v1's `send_message_log`. It deleted both the audit table and the IPC outbox. The Kipp auditor's data source — "every successful delivery for the day, joined to its trigger inbound" — does not exist as a turn-key central table.

**However, the data is still recoverable** by joining per-session `messages_out` ⨝ `inbound.delivered` ⨝ `messages_in` for each `(agent_group_id, session_id)` under `data/v2-sessions/`. The `in_reply_to` column on `messages_out` is the trigger-message link; `delivered.delivered_at` is the timestamp; `delivered.platform_message_id` is the platform receipt. This is enough to reconstruct v1's `send_message_log` rows on demand — but it requires walking N session folders rather than a single SELECT.

**Three placement options for TaskFlow's port**, ranked by alignment with v2's stated invariants (`docs/db.md §3`):

1. **Recommended: a TaskFlow-skill-owned central table, written from the host's delivery success path** — extend `src/delivery.ts` via the existing `registerDeliveryAction` registry pattern (`src/delivery.ts:386-394`) or a new "post-delivery hook" registry, called from inside the success branch of `drainSession` (`delivery.ts:163-171`). The skill ships its own migration (`src/db/migrations/module-taskflow-*.ts`) that creates `taskflow_send_message_log` in the central DB. This is the v2-native pattern — exactly how `agent_destinations` lives (`src/db/migrations/module-agent-to-agent-destinations.ts`). Pros: one SELECT for Kipp; survives session-folder rotation; admin-visible. Cons: writes to central DB on every delivery (mitigated by single-writer rule — host already writes there).

2. **Alternative: a per-session view materialized at audit time** — Kipp auditor walks `data/v2-sessions/*/inbound.db` + `outbound.db` and joins the three tables in a temporary attached-DB query. Zero schema changes. Cons: O(sessions) opens per audit run; performance-fragile; doesn't survive session GC if v2 ever adds it.

3. **Anti-pattern: writing audit rows directly into `messages_in` or `messages_out` as a new `kind`** — fits the seq invariant's "everything is a message" framing but bloats the active inbox/outbox with audit records that the agent never reads. Rejected.

**Recommendation: option 1.** Match the existing module pattern (agent-to-agent, scheduling, interactive) which all add a central table via numbered migration plus a delivery-side hook. Keep the schema and the writer in the TaskFlow skill, never in core.

### Recommended TaskFlow audit projection — concrete shape

```sql
-- src/db/migrations/module-taskflow-send-log.ts (skill-owned)
CREATE TABLE taskflow_send_message_log (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_out_id              TEXT NOT NULL,        -- references session messages_out.id
  agent_group_id              TEXT NOT NULL,        -- the board (= v1 source_group_folder)
  session_id                  TEXT NOT NULL,
  channel_type                TEXT,
  platform_id                 TEXT,                 -- target chat (= v1 target_chat_jid)
  thread_id                   TEXT,
  platform_message_id         TEXT,                 -- delivery receipt
  kind                        TEXT NOT NULL,        -- chat | chat-sdk | …
  trigger_message_id          TEXT,                 -- = messages_out.in_reply_to
  trigger_chat_jid            TEXT,                 -- = messages_in.platform_id of trigger
  trigger_sender              TEXT,                 -- parsed from messages_in.content
  trigger_sender_name         TEXT,
  trigger_message_timestamp   TEXT,
  trigger_turn_id             TEXT,                 -- session_state-derived if available
  delivered_at                TEXT NOT NULL,
  status                      TEXT NOT NULL         -- delivered | failed
);
CREATE INDEX idx_tflow_log_board_at  ON taskflow_send_message_log(agent_group_id, delivered_at);
CREATE INDEX idx_tflow_log_target_at ON taskflow_send_message_log(platform_id, delivered_at);
CREATE INDEX idx_tflow_log_trigger   ON taskflow_send_message_log(trigger_message_id);
```

**Writer hook.** Add a `registerPostDeliveryHook(handler)` next to the existing `registerDeliveryAction` registry (`src/delivery.ts:386-394`). Fire it from inside `drainSession` immediately after `markDelivered(...)` succeeds (`delivery.ts:163-171`), passing `(msg, session, platformMsgId, inDb)`. TaskFlow registers its handler only when the board's agent group is wired up — same dynamic-import + `hasTable` guard pattern as `agent-to-agent`. Nothing leaks into core except the registry surface (≈10 lines).

**Trigger linkage.** At hook time, pull the trigger inbound row by joining `messages_out.in_reply_to` → `messages_in.id` on the session's `inbound.db`. Both DBs are already open in `drainSession`. Parse `messages_in.content` for sender fields. `delivered.delivered_at` and `platform_message_id` are written one statement earlier, so the same value can be passed to the hook directly.

---

## Session lifecycle deep-dive

**Disk layout** (`docs/db-session.md §1`, `src/session-manager.ts:36-55`):
```
data/v2-sessions/<agent_group_id>/<session_id>/
  inbound.db
  outbound.db
  .heartbeat              # mtime touched by container (touchHeartbeat in connection.ts:113)
  inbox/<message_id>/     # decoded inbound attachments
  outbox/<message_id>/    # files the agent produced
```

**Create.** `resolveSession()` (`src/session-manager.ts:79-128`) finds-or-creates by `(agent_group_id, messaging_group_id, thread_id)` modulated by `session_mode` (`shared` ignores threadId, `per-thread` keys on it, `agent-shared` keys only on agent_group_id — one session shared across all wired channels). Triggers `createSession()` in central DB and `initSessionFolder()` (creates dir, runs `ensureSchema` for both DBs).

**Wake.** Router calls `wakeContainer(session)` after writing the inbound row (`src/router.ts:447-454`). `wakeContainer` (`src/container-runner.ts:60-82`) deduplicates concurrent wakes via `wakePromises` then calls `spawnContainer`. Pre-spawn, **two projections refresh into `inbound.db`**: `writeDestinations()` (only when agent-to-agent module is installed; guarded by `hasTable('agent_destinations')`) and `writeSessionRouting()` — both unconditional on every wake (`container-runner.ts:88-93`). Then the container process is `spawn(CONTAINER_RUNTIME_BIN, args)`, mounts include the session dir bind-mounted at `/workspace`. The container's poll-loop (`container/agent-runner/src/poll-loop.ts:46-...`) runs forever until host kills it.

**Sweep / teardown.** `src/host-sweep.ts` runs every 60s. Per session: sync acks → if container dead and rows still `processing`, retry-with-backoff → if container alive, run `decideStuckAction()` (`host-sweep.ts:64-105`) which kills on absolute heartbeat ceiling (30 min, extended by Bash's declared timeout) or per-message claim age > 60s with no heartbeat since. Wake-from-cold: if `countDueMessages > 0` and not running, `wakeContainer`. Recurrence fanout via `handleRecurrence` import.

**No idle timeout.** `src/container-runner.ts:138-140` explicitly states: "No host-side idle timeout. Stale/stuck detection is driven by the host sweep reading heartbeat mtime + processing_ack claim age + container_state". The container is killed only by the sweep's stuck rules or by an explicit `killContainer` call.

**Container exit handler** (`container-runner.ts:142-148`): `markContainerStopped`, removes from `activeContainers`, stops typing-refresh. Session folder + DBs **persist forever**; only the container process goes away.

**Two paths to send into a session from outside the agent loop:**

- `writeSessionMessage(agentGroupId, sessionId, {kind, content, trigger})` — writes to `inbound.db.messages_in`, optionally calls `wakeContainer` if `trigger=1`. This is what the router uses for inbound chat events.
- `writeOutboundDirect(agentGroupId, sessionId, {kind, content, ...})` (`src/router.ts:32`, used for command-gate denial responses at `router.ts:419-424`) — writes to `outbound.db.messages_out` directly from the host so the next delivery-poll tick will deliver it as if the agent had produced it. **Skips the container entirely** — useful for static notifications, gate responses, and TaskFlow's "your board is ready" follow-ups.

The router internally uses `messageIdForAgent(baseId, agentGroupId)` to namespace the row id (`src/router.ts:460-468`) — necessary because `messages_in.id` is PRIMARY KEY and a fan-out inbound would collide across sessions otherwise. Any code writing inbound from outside the router needs to do the same.

---

## Implications for TaskFlow migration

1. **No drop-in for `send_message_log`.** TaskFlow's audit projection has to be re-created. Recommended via option 1 above — own a central table, write from a delivery hook in the skill. v1's table semantics (`source_group_folder, target_chat_jid, trigger_message_id, …`) map cleanly onto the v2 fields available at delivery time: `session.agent_group_id`, `msg.platform_id`+`channel_type`, `msg.in_reply_to`, host's `delivered_at`.

2. **Per-board send-and-forget no longer routes through a central queue.** v1's outbound dispatcher served as a natural choke point for any cross-cutting concern (logging, throttling, ordering). v2 has no such choke point inside TaskFlow's reach — only the host's `drainSession` and the `setDeliveryAdapter` shim. TaskFlow code that lived in the v1 dispatcher should re-emerge either in a delivery-action handler (for `kind='system'` operations) or in a delivery-hook (for actual chat sends).

3. **Provisioning sends and session-wake.** When TaskFlow provisions a child board and sends a follow-up message, it must either (a) `resolveSession` for the new agent group and `writeSessionMessage`, then `wakeContainer`, or (b) write directly via `writeOutboundDirect` (`src/router.ts:32`) which skips the agent loop and pushes straight to delivery. Option (b) is preferred for purely informational sends (e.g. "your board is ready") because it avoids spinning up a container just to echo a static string. Container wakes always refresh `destinations` and `session_routing` from central state, so TaskFlow can write the `agent_destinations` row first and trust the wake to project it.

4. **`/clear` semantics changed.** v1 had no per-group SDK-session reset — restarting the host process was the only way. v2's `/clear` clears `session_state` rows (specifically `sdk_session_id`) so the next prompt starts fresh, but **leaves all `messages_in`, `messages_out`, `delivered`, and `destinations` intact**. TaskFlow's "reset board" semantics need to choose: clear the SDK chain only (touch `session_state`), or wipe history too (delete the session folder and recreate via `resolveSession`).

5. **Recurring-task migration is straightforward.** v1 `scheduled_tasks` ⇒ v2 `messages_in WHERE kind='task' AND recurrence IS NOT NULL`. Series identity via `series_id`. `cancel/pause/resume` semantics already match v2's `id OR series_id` matching (`scheduling/db.ts:39-58`). The Kipp prompt currently lives in `scheduled_tasks.prompt`; in v2 that lives in `messages_in.content` JSON for the `task` kind row.

6. **Audit-time scanning gets cheaper.** Even without option 1, walking session folders is bounded by N sessions, and each session has a small DB. v1's `send_message_log` had to be partitioned by `source_group_folder` anyway — v2's per-folder layout matches that natural grain.

7. **Cross-board mutation forwarding (the open phase 1a plan).** v1's pattern was "INSERT into central, then notify each affected board's IPC outbox". v2's analogue is "INSERT into central, then `writeOutboundDirect` (or `writeSessionMessage` if the board's agent should react) into each affected session's DB". Either path is one helper-call deep — no IPC layer to traverse. Note that `writeOutboundDirect` currently lives only as an internal export of `session-manager.ts` re-exported by `router.ts` — extending it to "write into another session's outbound from outside the router" needs no schema change, only a stable public-API boundary in the skill.

8. **Agent-to-agent routing is its own kind.** When the agent calls `send_message(to="otherAgentName")`, the container looks up `destinations.type='agent'` and writes a row to `messages_out` with `channel_type='agent'`. The host's `deliverMessage` (`src/delivery.ts:215-227`) detects `channel_type === 'agent'`, dynamic-imports `routeAgentMessage` from the agent-to-agent module, which writes a fresh `messages_in` row into the **target** session's `inbound.db` (with namespaced id) and wakes its container. So the audit projection (option 1 above) needs to record both ends if TaskFlow wants cross-board send visibility — once on the source-side `messages_out` write and once on the target-side `messages_in` resulting wake. The simpler path is to log only at the host's actual `markDelivered` step on the source side, accepting that the destination audit comes from the target board's own log entry.

9. **Cross-mount write semantics affect any TaskFlow code touching session DBs.** Three rules from `src/session-manager.ts:1-13` are non-negotiable: (a) session DBs MUST be `journal_mode=DELETE` (the host sets this in `ensureSchema`); (b) host opens-writes-CLOSES per operation — long-lived connections leave the container's mmap'd page cache stale; (c) one writer per file, period. TaskFlow code that opens `inbound.db` directly (rather than calling helpers in `src/db/session-db.ts`) must respect all three. The helpers already enforce this; prefer them.

10. **Pending questions stay central.** v2 keeps `pending_questions` in the central DB (`src/db/schema.ts`), not the session — because the **response** comes back through a different inbound path (user clicks the card) and the host needs to look up which session and questionId belongs to before routing. TaskFlow flows that use `ask_user_question` for approvals work the same way; no port-side adaptation needed beyond ensuring the interactive module is in the install set.
