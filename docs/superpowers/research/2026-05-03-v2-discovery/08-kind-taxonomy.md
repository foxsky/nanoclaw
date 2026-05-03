# v2 Message Kind Taxonomy & Host-Side Delivery Flow

**Date:** 2026-05-03
**Scope:** Catalogue every `kind` value used in v2's `messages_in` and `messages_out`, the writer (MCP tool) and reader (host action) for each, and the exact processing flow. Goal is to determine where TaskFlow's `taskflow_send_message_with_audit` wrapper can safely insert into `send_message_log` without violating v2's separation between system actions and channel delivery.

All file references are blob paths in `remotes/upstream/v2`.

---

## 1. Complete enum of `kind` values

Two tables, two namespaces.

### `messages_in` (host-owned `inbound.db`, schema in `src/db/schema.ts:159-176`)

| `kind`        | Source (writer)                                                           | Lifecycle                                                                                                                                                                                |
|---------------|---------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `'chat'`      | `src/router.ts` (every inbound from a channel adapter; `writeSessionMessage`) | Container reads via `messages_in`; status flows pending → completed via `processing_ack` mirror in `outbound.db`.                                                                        |
| `'chat-sdk'`  | `src/router.ts` for chat-sdk-bridge channels                              | Same as `chat`. `kind='chat-sdk'` carries the chat-sdk JSON envelope; container's poll-loop coalesces both kinds (`poll-loop.ts:94, 210, 263`).                                          |
| `'task'`      | `src/modules/scheduling/db.ts::insertTask` (host, never container)        | Pending row scheduled with `process_after`; recurrence fanout in `recurrence.ts` clones forward; container reads it on wake exactly like a chat row but with `script` pre-agent hooks.   |

### `messages_out` (container-owned `outbound.db`, schema in `src/db/schema.ts:215-227`)

| `kind`        | Source (writer MCP)                                                                                                                                                                                                                          | Reader (host)                                                       | Hits the wire? |
|---------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------|---------------:|
| `'chat'`      | `mcp-tools/core.ts::sendMessage`, `sendFile`, `editMessage`, `addReaction` (lines 122, 168, 209, 250). Also `modules/agent-to-agent/agent-route.ts:50` for cross-agent fan-out, and `modules/scheduling/actions.ts:95` for `update_task` no-match notifications. | `delivery.ts::deliverMessage` falls past `kind === 'system'` branch and hands content to `deliveryAdapter.deliver()` which calls `getChannelAdapter(channelType).deliver(...)`. | **Yes** — channel adapter sends to platform. |
| `'chat-sdk'`  | `mcp-tools/interactive.ts::askUserQuestion` (line 95) and `sendCard` (line 157). Also `modules/approvals/primitive.ts::requestApproval` (line 203) when an admin needs an approve/reject card.                                              | Same path as `chat`. Adapter bridge dispatches to chat-sdk's structured-card renderer. `delivery.ts` additionally writes a `pending_questions` row for `ask_question` envelopes (line 316). | **Yes** — same channel-adapter dispatch as `chat`. |
| `'system'`    | `mcp-tools/scheduling.ts` (5 places: schedule/cancel/pause/resume/update task). `mcp-tools/agents.ts:52` (`create_agent`). `mcp-tools/self-mod.ts:67, 105` (`install_packages`, `add_mcp_server`).                                          | `delivery.ts::handleSystemAction` short-circuits: looks up `actionHandlers.get(content.action)` and runs the handler. **Never reaches a channel adapter.** | **No** — pure host-internal; row is "delivered" the moment its handler returns. |

There is no fourth kind on the outbound side. `'task'` does not appear in `messages_out` — it only exists as the host-side projection that `handleScheduleTask` writes into `messages_in`.

---

## 2. Trace: `kind='task'`

Six hops, host-mediated:

1. **Agent invokes `schedule_task` MCP tool** → `mcp-tools/scheduling.ts::scheduleTask` (line 35).
2. **MCP writes outbound row** with `kind='system'`, content `{action:'schedule_task', taskId, prompt, script, processAfter, recurrence}` → `writeMessageOut(...)` into the container's `outbound.db`.
3. **Host delivery poll** (`delivery.ts::pollActive` 1 s, `pollSweep` 60 s) reads the row via `getDueOutboundMessages`. Detects `msg.kind === 'system'` (line 254) and calls `handleSystemAction`.
4. **Action registry dispatch** (`delivery.ts:387-422`): `actionHandlers.get('schedule_task')` returns `handleScheduleTask` (registered in `modules/scheduling/index.ts:30`).
5. **Handler writes `messages_in` row** (`scheduling/actions.ts:30` → `db.ts::insertTask` line 17): `INSERT INTO messages_in (... kind='task' ..., status='pending', process_after=..., recurrence=..., series_id=id)` against host-owned `inbound.db`.
6. **Cron eval & fire**:
   - `host-sweep.ts:175` — `countDueMessages(inDb)` returns >0 when `process_after <= now()`. `wakeContainer(session)` is called.
   - The container poll-loop reads pending `kind='task'` rows from `messages_in` like any other inbound, runs the `script` pre-agent hook (if any), and feeds `prompt` to the agent.
   - On completion, `processing_ack` flips to `completed`; `host-sweep.ts:183` → `handleRecurrence(inDb, session)` finds completed-with-recurrence rows, computes the next firing via `cron-parser` (timezone-aware), inserts a fresh pending row sharing `series_id`, and clears the original's `recurrence` (`recurrence.ts:30-39`).

The outbound `kind='system'` row is marked delivered (`markDelivered` line 193) immediately after the handler returns. No channel adapter is touched.

---

## 3. Trace: `kind='system'`

This is the umbrella for **every host-mutation action the container needs to request**. Container can't write to `inbound.db` (single-writer mount invariant from doc 03-session-dbs.md), so the workaround is:

> Write a row to `outbound.db` with `kind='system'` and an `action` discriminator, let the host's delivery loop see it, dispatch via registry, apply the change to host-owned state.

**Registry shape** (`delivery.ts:387-400`):

```ts
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<void>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) log.warn('Delivery action handler overwritten', { action });
  actionHandlers.set(action, handler);
}
```

Handlers receive (parsed-JSON content, the originating Session, the open inbound DB). They return `Promise<void>`. Errors throw → falls into the retry path → eventually `markDeliveryFailed` after 3 attempts.

**Currently registered actions** (eight total, three modules):

| Action              | Handler                                                | Module                                  |
|---------------------|--------------------------------------------------------|-----------------------------------------|
| `schedule_task`     | `handleScheduleTask`                                   | `modules/scheduling/index.ts:30`        |
| `cancel_task`       | `handleCancelTask`                                     | `modules/scheduling/index.ts:31`        |
| `pause_task`        | `handlePauseTask`                                      | `modules/scheduling/index.ts:32`        |
| `resume_task`       | `handleResumeTask`                                     | `modules/scheduling/index.ts:33`        |
| `update_task`       | `handleUpdateTask`                                     | `modules/scheduling/index.ts:34`        |
| `create_agent`      | `handleCreateAgent`                                    | `modules/agent-to-agent/index.ts:22`    |
| `install_packages`  | `handleInstallPackages` (queues approval)              | `modules/self-mod/index.ts:26`          |
| `add_mcp_server`    | `handleAddMcpServer` (queues approval)                 | `modules/self-mod/index.ts:27`          |

**Default**: unregistered actions log `"Unknown system action"` (line 421) and the row is silently marked delivered.

**Side-effect channel** (used by handlers): handlers can call `writeSessionMessage(...)` to inject a `kind='chat'` row into `messages_in` carrying a system-authored notification (see `scheduling/actions.ts:93-105`, `approvals/primitive.ts::notifyAgent`), then `wakeContainer(session)` so the agent sees the result.

---

## 4. Trace: `kind='chat'` (and `'chat-sdk'`)

The path that does hit the wire:

1. **Agent invokes `send_message`** → `mcp-tools/core.ts:112-131`. Resolves destination via `resolveRouting` (defaults to session's reply tuple). Writes `messages_out` row with `kind='chat'`.
2. **Delivery poll picks it up** via `getDueOutboundMessages`. Filters out already-delivered IDs (`getDeliveredIds` from `delivered` table in inbound.db).
3. **`deliverMessage`** (`delivery.ts:234-372`):
   - Skips `kind === 'system'` branch.
   - For `channel_type === 'agent'`: dynamic-import `modules/agent-to-agent/agent-route.ts`, route to target session, return.
   - **Permission check**: `session.messaging_group_id` must equal the resolved messaging group, OR an `agent_destinations` ACL row must exist (lines 286-310). Failure throws → retries → eventually `markDeliveryFailed`.
   - **Pending question persistence**: if `content.type === 'ask_question'` and `pending_questions` table exists, `createPendingQuestion(...)` so the response handler can later resolve the card.
   - **Read attachments** from outbox dir if `content.files` is set (`readOutboxFiles`).
   - **Call `deliveryAdapter.deliver(channelType, platformId, threadId, kind, content, files)`**. The adapter wraps `getChannelAdapter(channelType).deliver(...)` (`src/index.ts:130-145`). Returns a `platformMsgId`.
4. **`markDelivered`** writes `(message_out_id, platform_message_id, status='delivered', delivered_at)` into `delivered` table. `clearOutbox` deletes the file scratch dir.
5. **Pause typing indicator** (`pauseTypingRefreshAfterDelivery`) — only when `kind !== 'system'` and `channel_type !== 'agent'` (line 202).

`chat-sdk` is **the same path**. The only branch that distinguishes them is `pending_questions` persistence and the chat-sdk-bridge adapter renders structured cards instead of plain text. From `delivery.ts`'s perspective they're indistinguishable until the adapter's `.deliver(...)` is called with `message.kind` forwarded.

---

## 5. `system` vs `chat`: confirmation

**Codex was correct.** `delivery.ts:254`:

```ts
if (msg.kind === 'system') {
  await handleSystemAction(content, session, inDb);
  return;
}
```

The `return` on line 257 short-circuits before any of:
- Permission check
- `pending_questions` write
- File attachment read
- `deliveryAdapter.deliver()` call
- `clearOutbox`

A `kind='system'` row is **never handed to a channel adapter**. It exists exclusively to ferry mutations from container → host. After `handleSystemAction` returns, control falls back to `deliverSessionMessages` which calls `markDelivered` on line 193 — so the row is "delivered" in the bookkeeping sense, but the wire has not been touched.

This means: **TaskFlow's `send_message_log` should NOT log `kind='system'` rows.** Those aren't messages to a user; they're internal RPC.

---

## 6. Where to insert `taskflow_send_message_with_audit`

The TaskFlow wrapper MCP needs to fire `send_message` AND record an audit row. Three candidate insertion points:

### Option A — Pre-queue (synchronous in MCP handler)
Insert into `send_message_log` **inside the wrapper MCP**, before/after `writeMessageOut(...)`:

```ts
// inside taskflow_send_message_with_audit handler (container-side)
const seq = writeMessageOut({ id, kind: 'chat', ... });
recordSendLog({ seq, audited_for: ... });   // log row in TaskFlow DB
```

**Pros:** Atomic w.r.t. the agent's intent (one tool call → one log row). No host-side coupling.
**Cons:** Logs the *attempt*, not the *outcome*. If delivery fails permanently (`markDeliveryFailed` after 3 retries), the log row claims a send that never reached the wire. Also, `send_message_log` would have to live in a container-writable DB — TaskFlow's per-board SQLite, not `inbound.db`.

### Option B — Post-queue, pre-delivery (host-side, kind='chat' branch)
Hook into `delivery.ts::deliverMessage` between the permission check and the adapter call. Would require either (a) editing `delivery.ts` (forbidden — fork-private logic in core), or (b) a new `registerChatDeliveryHook` API in core. **The current core has no such hook.** `registerDeliveryAction` is `kind='system'`-only.

### Option C — Post-delivery (host-side, after `markDelivered`)
Similar to B. Would need a new core hook fired after `markDelivered(inDb, msg.id, platformMsgId)` (line 193). Doesn't exist either.

### Recommendation

Use **Option A**, but pair it with a **second log update** on the post-delivery side via a roundabout route that v2 already supports:

1. **Pre-queue**: TaskFlow wrapper writes the `send_message_log` row with `status='queued'`, capturing `seq` from `writeMessageOut` and the agent's audit context. Lives in the per-board TaskFlow SQLite DB (container-writable, no host coupling needed).
2. **Post-delivery confirmation**: TaskFlow can read the `delivered` table from `inbound.db` (read-only is sufficient — it's host-written but readable by container) on the next agent turn or via a periodic reconciliation tool, and update `status='delivered'` / `'failed'` based on `delivered.message_out_id` matching `seq`'s row id.

This keeps TaskFlow code container-side (skill-scoped, no `delivery.ts` edits), satisfies the firm "no NanoClaw codebase changes" rule from MEMORY.md, and the eventual-consistency window between queue and confirmation is acceptable for an audit log.

If we ever need a synchronous post-delivery hook, the cleanest upstream-friendly addition would be a new `registerChatDeliveryHook(handler)` analog to `registerDeliveryAction`, fired after `markDelivered` on lines 193-204. That's a v2-core PR, not a fork patch. Out of scope here.

---

## 7. `registerDeliveryAction` API summary

| Aspect                        | Value                                                                                                                            |
|-------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| Defined at                    | `src/delivery.ts:387-400`                                                                                                        |
| Signature                     | `(action: string, handler: (content, session, inDb) => Promise<void>) => void`                                                  |
| Handler context               | Parsed JSON `content`, originating `Session`, open `inbound.db` Database handle.                                                 |
| Registration timing           | Module import time (e.g. `modules/scheduling/index.ts:30-34` runs as side-effects on import).                                    |
| Handles which `kind`          | **`kind='system'` only.** No analogous registry exists for `chat` / `chat-sdk`.                                                  |
| Conflict policy               | Last writer wins; warning logged on overwrite.                                                                                   |
| Default for unknown action    | Logs `"Unknown system action"`; row marked delivered with no side-effect (line 421).                                             |
| Error semantics               | Handler throw → falls into `deliverMessage`'s retry loop → `markDeliveryFailed` after 3 attempts.                                |
| Companion API                 | `registerApprovalHandler(action, handler)` in `modules/approvals/primitive.ts:59` — same shape, but fires on admin approve/reject of a `pending_approvals` row created by a `requestApproval()` call. |

There is **no public hook for `kind='chat'` post-delivery**. If TaskFlow ever needs one, it must come from a v2-core PR adding `onDeliveryComplete` (or equivalent) called from `delivery.ts` after `markDelivered`.

---

## 8. Files referenced

All paths are blob paths under `remotes/upstream/v2`:

- `src/delivery.ts` — host delivery loop, `registerDeliveryAction`, `handleSystemAction`.
- `src/db/schema.ts` — INBOUND_SCHEMA / OUTBOUND_SCHEMA.
- `src/db/session-db.ts` — `insertMessage`, `getDueOutboundMessages`, `markDelivered`, `migrateDeliveredTable`.
- `src/host-sweep.ts` — calls `countDueMessages`, `handleRecurrence`.
- `src/index.ts` — wires `setDeliveryAdapter` (lines 128-150).
- `src/channels/adapter.ts` — `ChannelAdapter.deliver(platformId, threadId, OutboundMessage)`.
- `container/agent-runner/src/mcp-tools/core.ts` — `send_message` / `send_file` / `edit_message` / `add_reaction` (all `kind='chat'`).
- `container/agent-runner/src/mcp-tools/scheduling.ts` — `schedule_task` etc. (`kind='system'`, action discriminator).
- `container/agent-runner/src/mcp-tools/interactive.ts` — `ask_user_question` / `send_card` (`kind='chat-sdk'`).
- `container/agent-runner/src/mcp-tools/agents.ts` — `create_agent` (`kind='system'`).
- `container/agent-runner/src/mcp-tools/self-mod.ts` — `install_packages`, `add_mcp_server` (`kind='system'`).
- `src/modules/scheduling/actions.ts` — five `system` action handlers.
- `src/modules/scheduling/db.ts` — `insertTask` (writes `kind='task'` to `messages_in`).
- `src/modules/scheduling/recurrence.ts` — sweep-time recurrence fanout.
- `src/modules/scheduling/index.ts` — registers five delivery actions.
- `src/modules/agent-to-agent/index.ts` — registers `create_agent`.
- `src/modules/self-mod/index.ts` — registers `install_packages`, `add_mcp_server` and matching approval handlers.
- `src/modules/approvals/primitive.ts` — `registerApprovalHandler`, `requestApproval` (writes `kind='chat-sdk'` for the card).
- `src/modules/approvals/response-handler.ts` — dispatches admin's approve/reject to the right handler.
