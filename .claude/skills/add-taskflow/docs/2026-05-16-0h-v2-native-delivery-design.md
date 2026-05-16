# 0h-v2 — native outbound delivery for the FastAPI MCP path (design memo)

**Status:** design / decision-required. **Author:** nanoclaw side, 2026-05-16.
**Audience:** owner + tf-mcontrol. **Scope:** the *only* remaining nanoclaw
deliverable before Phase 3 (`POST /chat → api_send_chat`, then 0j-b).

This is a decision memo: verified constraints, options with trade-offs, a
recommendation, the proposed helper signature, and the open decisions. It is
**not** an implementation.

---

## 1. Problem

When a TaskFlow mutation originated by **tf-mcontrol's FastAPI** needs to emit
an outbound WhatsApp/channel message — `api_send_chat` (board chat) and the
FastAPI-originated `api_task_add_comment` assignee push — there is no delivery
path. The in-container WhatsApp agent path works (the agent sees
`notification_events` in the MCP result and itself calls `send_message`); the
FastAPI path has no agent and no session.

## 2. Verified constraints (file:line)

- **`writeMessageOut` is session-bound.** `container/agent-runner/src/db/messages-out.ts` writes `messages_out` into `/workspace/outbound.db` and reads `/workspace/inbound.db` for odd-seq numbering. It presumes a mounted session DB pair.
- **The FastAPI MCP subprocess has no session DBs.** `taskflow-server-entry.ts:79-84` calls only `initTaskflowDb(dbPath)` — the taskflow DB and nothing else. tf-mcontrol's `engine/client.py` spawns it as `bun taskflow-server-entry.ts --db <taskflow.db>` — no session/outbound context.
- **`src/delivery.ts` only drains registered sessions.** `pollActive()` → `getRunningSessions()`; `pollSweep()` (60s) → `getActiveSessions()`; both → `deliverSessionMessages` → `drainSession` (`delivery.ts:121-164`). A `messages_out` row is delivered **only** if it sits in a *registered, running/active* session's `outbound.db`.
- **Delivery needs concrete routing.** `deliverMessage` requires `channel_type` + `platform_id` (`delivery.ts:343`); a row missing them is logged-and-skipped then **marked delivered** (silent loss). Engine `NotificationEntry` carries `target_person_id` / `notification_group_jid` / `target_chat_jid` / `destination_name` — **not** `channel_type` / `platform_id` / `thread_id`.
- **`system`-kind delivery-action path exists and is the precedent.** `drainSession` → `deliverMessage`: `if (msg.kind === 'system') handleSystemAction(content, session, inDb)` (`delivery.ts:255`). `handleSystemAction` (`:410`) consults a registry populated by `registerDeliveryAction(action, handler)` (`:398`). **`src/modules/send-otp/`** is a working template: `registerDeliveryAction('send_otp', handleSendOtp)`; the host handler resolves phone→JID and calls `getChannelAdapter('whatsapp').deliver(...)` **out of any agent turn**. The channel adapter + central DB live host-side, not in the subprocess.
- **Routing must be resolved host-side.** The subprocess has only `taskflow.db`; `messaging_groups` / channel adapters are host-side. Board→channel resolution (`boards.group_jid` / `board_groups` / `board_people.notification_group_jid` → `messaging_groups` → `channel_type,platform_id`) can only happen on the host.
- **tf-mcontrol already ignores `notification_events`** post-0j-a — the engine must own delivery for FastAPI-originated outbound.

**Core fact:** the FastAPI subprocess cannot deliver directly (no adapter, no
session), and `delivery.ts` won't drain anything outside a registered session.
Any solution must bridge subprocess → a host-drained surface, and resolve
board→channel routing host-side.

## 3. Options

### Option A — Dedicated TaskFlow "service session" + `taskflow_notify` delivery-action  ★ recommended

One well-known, always-`active` session (synthetic agent-group + `sessions`
row + folder + empty `inbound.db`/`outbound.db` at a stable on-host path).
The engine's outbound helper writes a **`system`-kind** `messages_out` row
(`action: 'taskflow_notify'`, content `{ board_id, target, text }`) into that
service session's `outbound.db`. `pollSweep` (active sessions) drains it;
`handleSystemAction` dispatches to a `registerDeliveryAction('taskflow_notify', …)`
host handler (the **send_otp pattern**) that resolves `board_id` + target →
`messaging_group` → `(channel_type, platform_id, chat target)` and delivers via
the channel adapter.

- **Reuse:** the entire `delivery.ts` loop, `handleSystemAction`, the
  delivery-action registry, the channel adapter, and the `send_otp` module as
  a literal template. New code is small: a service-session bootstrap, the
  `enqueueOutboundMessage` engine helper, and the `taskflow_notify` host
  module (board→channel resolution).
- **Subprocess needs:** only the service session's `outbound.db` path
  (stable, on-host, passed via env/config) + its `inbound.db` for odd-seq.
- **Cons:** must bootstrap + keep one synthetic session "active" for
  `pollSweep`; the subprocess writes another session's `outbound.db` (same FS
  on `.61`; identical shape to a container writing its own).

### Option B — New host poller over a `taskflow.db` outbound-queue table

Engine writes intents to a new table in `taskflow.db` (which the subprocess
has). A new host poller (sibling to `delivery.ts`) drains it, resolves
board→channel, delivers.

- **Pros:** subprocess touches only `taskflow.db`; no synthetic session, no
  seq-parity concern.
- **Cons:** net-new host poller + table that **duplicates `delivery.ts`** —
  the handoff explicitly asks to reuse, not reinvent. Larger surface, second
  delivery path to keep correct.

### Option C — Deliver synchronously inside the engine tool call — REJECTED

The bun MCP subprocess has no channel adapter / WhatsApp socket (host-only).
Impossible without an out-of-process hop anyway.

## 4. Recommendation

**Option A.** It maximizes reuse (the handoff's stated preference), the
`send_otp` module is a proven working template for exactly "out-of-turn,
host-side, adapter-delivered, no agent," and it keeps a **single** delivery
pipeline (`delivery.ts`) rather than a second one. The only genuinely new
concept is one persistent service session.

## 5. Proposed engine helper

```ts
// container/agent-runner/src/db/... (engine-side, callable from MCP tool handlers)
enqueueOutboundMessage(params: {
  board_id: string;            // logical origin; host resolves → channel
  target:                      // logical target; host resolves → chat address
    | { kind: 'person'; person_id: string }
    | { kind: 'group'; group_jid: string };
  text: string;
  metadata?: Record<string, unknown>;  // e.g. { source: 'api_send_chat' | 'task_comment', task_id }
}): void;
```

It writes a `system`-kind `messages_out` row into the TaskFlow service
session's `outbound.db` with `content = { action: 'taskflow_notify', board_id,
target, text, metadata }`. **No** `channel_type`/`platform_id` at write time —
those are resolved host-side by the `taskflow_notify` delivery action (engine
has no `messaging_groups`). Returns void (fire-and-forget, mirrors `send_otp`).

Host side: `registerDeliveryAction('taskflow_notify', handleTaskflowNotify)` in
a new `src/modules/taskflow-notify/` (clone of `src/modules/send-otp/`):
resolve `board_id`+`target` → `messaging_groups` → adapter `deliver(...)`.

## 6. Acceptance (per the handoff)

A smoke test: call `api_send_chat` over stdio against the standalone MCP
subprocess → a `messages_out` row appears in the service session's
`outbound.db` → `src/delivery.ts` drains it → `handleTaskflowNotify` delivers
through the WhatsApp adapter. Plus the FastAPI-originated `api_task_add_comment`
assignee push exercised end-to-end.

## 7. Open decisions (for owner + tf-mcontrol)

1. **Option A vs B.** Recommendation A; tf-mcontrol may counter-vote.
2. **Uniform vs dual path.** Should the *in-container* WhatsApp agent path
   also route through `enqueueOutboundMessage` (true single-engine delivery),
   or keep today's `notification_events`→agent→`send_message` path
   (zero parity risk, byte-oracle untouched)? Recommendation: **keep the
   in-container path as-is for now** (it works; changing it is scope creep +
   byte-oracle risk); `enqueueOutboundMessage` is the FastAPI-path mechanism.
   Revisit unification later.
3. **Service-session bootstrap ownership.** Host startup (`src/index.ts`)
   ensures the service session row+folder exist and stays `active`? Confirm
   `getActiveSessions()` will include a never-messaged synthetic session
   (may need an explicit "service" session kind / always-active flag).
4. **Scope of Phase 3 cutover.** `api_send_chat` (target = board group) first;
   the FastAPI comment-assignee push second (it currently no-ops on the
   FastAPI path — acceptable until this lands; the DB write already works).

## 8. What this unblocks

Once decided + implemented: tf-mcontrol wires `POST /chat → api_send_chat`,
executes **0j-b** (delete `notify_task_commented` + `write_notification_ipc`),
re-baselines `send_chat.json`. That closes the last migration gap.
