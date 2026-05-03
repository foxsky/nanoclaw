# 12 — Sender-Approval First-Contact Flow (v2)

**Date:** 2026-05-03
**Source:** `git show remotes/upstream/v2:<path>` for v2; `/root/nanoclaw/src/dm-routing.ts` and `src/index.ts` for TaskFlow.
**Scope:** Codex#7 said v2's sender-approval is "first-contact membership gating: admin card on first DM from unknown sender, on approve inserts `agent_group_members`, then no further admin asks." This research validates that, traces the full flow, and analyzes how TaskFlow's `dm-routing.ts` integrates and how the 3 production `external_contacts` rows must migrate.

---

## 1. Trigger — when does it fire?

The sender-approval flow is gated on `messaging_groups.unknown_sender_policy`. Three values, set per messaging group:

- `'public'` — access gate skips entirely (`src/modules/permissions/index.ts:147-149`); anyone can talk to the agent
- `'strict'` — unknown sender silently dropped; `dropped_messages` row written; **no card** (`index.ts:103-110`)
- `'request_approval'` — drop the message **and** fire the approval card (`index.ts:112-130`)

**Default for new auto-created groups:** `'request_approval'`. The router's auto-create branch (when an unwired channel sees a mention/DM for the first time) hardcodes `unknown_sender_policy: 'request_approval'` (`src/router.ts:165-176`). The migration `001-initial.ts` declares the column DEFAULT as `'strict'`, but every callsite passes the value explicitly — see migration 011's docstring acknowledging the cosmetic default-flip was reverted.

**Where the gate fires in the route:**

```
routeInbound(event)
  → 0. apply adapter thread policy
  → 1. lookup messaging_group + agentCount
  → 1b. if agentCount=0 + isMention → channelRequestGate (a different flow, channel-approval)
  → 2. senderResolver(event) — upserts users row, returns userId
  → 3. fetch wired agents
  → 4. fan-out: for each agent
       → evaluateEngage()
       → accessGate(event, userId, mg, agentGroupId)  ← THIS IS THE SENDER GATE
       → senderScopeGate(event, userId, mg, agent)    ← stricter per-wiring filter
       → if all pass: deliverToAgent()
       → if not + ignored_message_policy='accumulate': store but don't wake
       → else: silent drop
```

So the **sender** gate fires post-agent-resolution, per-agent, on every inbound. The unknown-sender card path is `accessGate → handleUnknownSender → requestSenderApproval` (`src/modules/permissions/index.ts:148-181`).

---

## 2. Admin card delivery

Approval cards do **not** go through `requestApproval()` (the approvals primitive). `requestApproval()` is for in-session admin-confirmation (e.g. self-mod, sensitive tool calls) — it writes to `pending_approvals` keyed by session.

The unknown-sender flow has its own mini-primitive in `src/modules/permissions/sender-approval.ts:48-156`:

1. **Dedup check** — `hasInFlightSenderApproval(messagingGroupId, senderIdentity)` — guarded by UNIQUE on `pending_sender_approvals(messaging_group_id, sender_identity)`. Second message from the same stranger while the card is pending is silently dropped with `log.debug`.
2. **Pick approver** — `pickApprover(agentGroupId)` from `modules/approvals/primitive.ts:73-92`. Order: admins-of-this-group → global admins → owners. Dedup by user_id.
3. **Pick delivery target** — `pickApprovalDelivery(approvers, originChannelType)`. Walks approvers; first prefers same-channel-as-origin (`channelTypeOf(userId) === originChannelType`), then any reachable. Resolution uses `ensureUserDm(userId)` (`modules/permissions/user-dm.ts`) which either looks up the cached `user_dms` row, creates one directly if the channel is direct-addressable (Telegram/WhatsApp/iMessage), or calls `adapter.openDM()` for resolution-required channels (Slack/Discord/Teams).
4. **Insert pending row** — `createPendingSenderApproval({...})` BEFORE delivery. If delivery later fails, the row stays in place (admin can act on it manually) and dedup suppresses retries until cleared.
5. **Deliver via `getDeliveryAdapter().deliver(...)`** — the global delivery adapter (set up by the host process). The payload kind is `'chat-sdk'` and the content is JSON:

```json
{
  "type": "ask_question",
  "questionId": "nsa-<ts>-<rand>",
  "title": "👤 New sender",
  "question": "<senderName> wants to talk to your agent in <chatName>. Allow?",
  "options": [
    { "label": "Allow", "selectedLabel": "✅ Allowed", "value": "approve" },
    { "label": "Deny",  "selectedLabel": "❌ Denied",  "value": "reject" }
  ]
}
```

The `'ask_question'` kind goes through the channel's interactive-prompt rendering (see research note 10). On WhatsApp, that becomes a poll/list message; on Slack it's a Block Kit card; on Telegram, an inline keyboard.

**No `agent` session** is involved. The card is delivered **directly** to the admin's DM messaging_group via the channel adapter, bypassing the agent runtime entirely. The card is sent on the **admin's** preferred channel (matching origin if possible), not on the channel where the unknown sender wrote.

---

## 3. `pending_sender_approvals` schema + lifecycle

Migration `011-pending-sender-approvals.ts:25-42` (single CREATE TABLE):

```sql
CREATE TABLE IF NOT EXISTS pending_sender_approvals (
  id                   TEXT PRIMARY KEY,        -- 'nsa-<ts>-<rand>'
  messaging_group_id   TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity      TEXT NOT NULL,           -- namespaced: 'whatsapp:5586...'
  sender_name          TEXT,
  original_message     TEXT NOT NULL,           -- JSON.stringify(InboundEvent)
  approver_user_id     TEXT NOT NULL,           -- which admin we delivered to
  created_at           TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);
CREATE INDEX idx_pending_sender_approvals_mg ON pending_sender_approvals(messaging_group_id);
```

Notes:

- **No expiration column.** No TTL. A row sits forever until the admin clicks Allow/Deny or someone deletes it manually.
- **No status column.** Existence ⇔ in-flight; no separate "approved/denied/expired" terminal states. On click the row is **deleted**.
- **Dedup is on the table, not a counter.** A retry by the same sender hits the UNIQUE and is dropped at `hasInFlightSenderApproval()` before any insert is attempted.
- The migration docstring explains why the cosmetic DEFAULT-flip on `messaging_groups.unknown_sender_policy` was removed — SQLite FK integrity check at DROP-TIME on the table-rebuild blocked migration on live DBs with sessions/user_dms FK references. Result: `messaging_groups` keeps `'strict'` as schema default, but every callsite passes explicitly.

**Writer:** `requestSenderApproval()` in `sender-approval.ts:103-112`.
**Reader/deleter:** `handleSenderApprovalResponse()` in `permissions/index.ts:222-279` (for both approve and deny paths).
**Dedup reader:** `hasInFlightSenderApproval()` in `db/pending-sender-approvals.ts:46-51`.

---

## 4. On approve — what happens?

`handleSenderApprovalResponse(payload)` in `src/modules/permissions/index.ts:222-279`:

1. Look up the row by `payload.questionId`. If not found → return `false` so other registered response handlers (channel-approval, approvals-primitive) get a shot. **Claim rule** is "I created this id".
2. **Authorize the clicker** — `clickerId = ${channelType}:${payload.userId}`. Must equal `row.approver_user_id` OR `hasAdminPrivilege(clickerId, row.agent_group_id)`. Stops random users from self-admitting via stolen card forwarding. If unauthorized: `return true` (claim it but no-op so it's not unclaimed-logged).
3. **If approved** (`payload.value === 'approve'`):
   - `addMember({ user_id: row.sender_identity, agent_group_id: row.agent_group_id, added_by: approverId, added_at: now })` — inserts an `agent_group_members(user_id, agent_group_id, added_by, added_at)` row via `INSERT OR IGNORE`. Idempotent — re-clicking does nothing harmful.
   - `deletePendingSenderApproval(row.id)` — clear the dedup row **before** replay so the second routing attempt's gate doesn't see in-flight state.
   - `await routeInbound(JSON.parse(row.original_message) as InboundEvent)` — replay the original message. The second pass through `accessGate` finds the user is now a member of `agent_group_id` (via `canAccessAgentGroup → isMember`); access decision is `{ allowed: true, reason: 'member' }`; the message gets delivered to the agent normally.
4. Return `true`.

**Net effect:** one row is added to `agent_group_members(user_id, agent_group_id)`. From now on, **no further admin asks** for this `(sender, agent group)` pair — `isMember` short-circuits the gate.

`agent_group_members` schema (`db/migrations/001-initial.ts:62-69`):

```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

Implicit-membership invariant: `isMember()` (`db/agent-group-members.ts:24-33`) returns true if user is owner / global admin / scoped admin of this agent group, *without* needing a row. Only "member" tier needs the explicit row. So inviting an admin via approve also writes a (redundant) row, which is harmless under INSERT OR IGNORE.

---

## 5. On reject / timeout

**Reject path** (`permissions/index.ts:272-279`):

```ts
log.info('Unknown sender denied', { ... });
deletePendingSenderApproval(row.id);
return true;
```

That's it. **No deny-list.** The docstring at line 218-220 explicitly says:

> Deny: delete the row (no "deny list" — a future message re-triggers a fresh card per ACTION-ITEMS item 5 "no denial persistence").

Implication: a denied stranger can keep trying. Each retry triggers a fresh card to the admin. There's no per-sender block, no per-(group, sender) block, and no rate-limit. The dedup is only for **in-flight** state, not denied state.

**Timeout path** — there is no timeout. Rows sit forever. If the admin never clicks, the row keeps existing and the dedup gate keeps suppressing further cards. This is a footgun: a single unanswered card from a half-active admin permanently shadow-bans a sender.

**Failure modes** that **don't** insert the row (and so allow retry-cards on the next message):

- No eligible approver (`pickApprover` returned empty)
- No reachable DM (`pickApprovalDelivery` returned null)
- Delivery adapter missing entirely

These all log + return without creating a row, so the dedup gate lets the next message try again.

---

## 6. Per-board vs global

**Per agent group**, not per messaging group, not global.

The `agent_group_members.agent_group_id` is the scoping axis. A user approved for `agent-group-A` is a member of A only — if they later DM into a wired chat for `agent-group-B`, that's a fresh unknown-sender card. The card itself is per-(messaging_group, sender) for dedup, but the **grant** that approval creates is per-(user, agent_group).

For multi-agent fan-out: when a chat has multiple wired agent groups, each agent independently runs its own `accessGate(event, userId, mg, agent.agent_group_id)`. So if a user is a member of agent-group-A but not agent-group-B, both wired into the same chat: agent A engages, agent B silently drops or fires an approval card to its own admins.

---

## 7. TaskFlow `dm-routing.ts` — where it layers

TaskFlow's `dm-routing.ts` is **not** part of v2's permissions module flow. It runs in v1's `index.ts` polling loop and **bypasses** the access gate entirely.

**v1 architecture** (`/root/nanoclaw/src/index.ts:952-1043`):

```
poll loop
  → for each registered group: getMessages(chatJid, lastTs, ASSISTANT_NAME)
  → if hasTriggerMessage: process
  → ALSO: if taskflowDb exists:
       → getDmMessages(lastDmTimestamp, ASSISTANT_NAME)  // catches DMs to bot
       → for each DM:
          route = resolveExternalDm(taskflowDb, msg.chat_jid)
          if !route: continue (no grant → skip the DM, don't process)
          if route.needsDisambiguation: send disambiguation prompt, continue
          else: stage prompt with [External participant: <name> (<id>), grants: M1,M3] context
                enqueueMessageCheck(groupJid)
```

`resolveExternalDm` (`/root/nanoclaw/src/dm-routing.ts:43-153`):

1. Try `external_contacts.direct_chat_jid` exact match (status='active').
2. Fallback: extract phone from JID (`5586...@s.whatsapp.net` → `5586...`) and match `external_contacts.phone`. Backfill `direct_chat_jid` on hit.
3. Find active `meeting_external_participants` rows JOIN `boards` for grants in (`accepted`, `invited`, `pending`).
4. Lazy-expire grants where `access_expires_at < now` → set `invite_status='expired'`.
5. If no active grants left → null (no route).
6. Compute `needsDisambiguation` = active grants span multiple `group_jid`s. (Multiple grants on one board don't disambiguate — agent resolves from message content via `grants[]` in the context tag.)

So TaskFlow's flow is:

> **Claim:** "I know this DM sender — they have a meeting grant. Process the message in the host board's session, prepended with an `[External participant: …]` context tag listing all active grants."

The grant model (`meeting_external_participants`) is a richer, time-bounded, per-meeting-occurrence membership than v2's `agent_group_members`. Grants have:

- `invite_status` — pending/invited/accepted/revoked/expired
- `access_expires_at` — TTL (e.g. 7 days post-meeting)
- per-occurrence scoping (`board_id, meeting_task_id, occurrence_scheduled_at`) — invitation to **one specific meeting**, not a permanent grant

**On v2:** the equivalent layer would be either:

- (a) a **TaskFlow plugin** that hooks the access gate (`setAccessGate` overwrite or wrapper), running before the default and admitting senders with active grants — auto-creating `agent_group_members` on first contact + tagging the inbound with `external_grant_ids` for the agent
- (b) a **TaskFlow channel-request gate variant** that creates a per-meeting auto-approval and adds the user as a temporary member with metadata
- (c) a **wrapping module** that auto-fires `addMember()` from a TaskFlow-side trigger when invitations are sent (so by the time the contact DMs in, they're already a known member; v2's stock flow then engages normally)

Option (c) is closest to v2's design and the cleanest path: TaskFlow's existing "send invitation" flow already records `meeting_external_participants(invite_status='invited')`; v2-port can additionally call `addMember()` to seed `agent_group_members`. The DM-context-tag injection (`[External participant: …]`) becomes a session-message preamble in the TaskFlow agent rather than a router-level stage. v2's first-contact flow then never fires for these senders — their invitation **is** their membership grant.

The `needsDisambiguation` and lazy-expiry are TaskFlow-specific business logic (which meeting? grant still valid?) and stay in TaskFlow code regardless.

---

## 8. Cutover migration for the 3 production `external_contacts`

Production state (`192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`, 2026-05-03):

```
external_contacts (3 rows):
  ext-1773399641649-7yiq  Edmilson  5586988027426  5586988027426@s.whatsapp.net  active
  ext-1773848056955-tpeh  Katia     5586994323040  (null)                        active
  ext-1773848060116-pvnm  Ismael    5586998526312  (null)                        active

meeting_external_participants (3 rows):
  board-thiago-taskflow  M7  2026-03-17T11:00:00Z  ext-1773399641649-7yiq  revoked  exp 2026-03-24
  board-sec-taskflow     M5  2026-03-26T11:00:00Z  ext-1773848056955-tpeh  invited  exp 2026-04-02
  board-sec-taskflow     M5  2026-03-26T11:00:00Z  ext-1773848060116-pvnm  invited  exp 2026-04-02
```

Today is 2026-05-03. **All three rows have already passed their `access_expires_at`.** `dm-routing.ts:113-122` would lazy-expire them all on first poll: Edmilson is already `revoked`; Katia and Ismael would flip from `invited` → `expired`.

**Cutover strategies:**

1. **Do nothing.** All three are expired or about to be lazy-expired. On v2 cutover, these senders are unknown senders with no v2-side grants. If they DM the bot, they hit `request_approval` and the operator gets a card. Safe but loses TaskFlow context (the agent receives a generic "unknown DM, allow?" instead of "this is Katia from M5").

2. **Pre-seed `agent_group_members`.** During the cutover migration, scan `meeting_external_participants` for rows where `invite_status IN ('accepted','invited','pending') AND access_expires_at > now`. For each, derive the v2 `user_id` (`whatsapp:<phone>`), upsert `users`, and insert `agent_group_members(user_id, agent_group_id=<board's agent_group_id>, added_by='migration', added_at=now)`. **For the 3 rows on prod today:** zero matches (all expired). For a future cutover with active grants: this migrates them losslessly.

3. **Pre-seed + carry the meeting context.** Same as (2), plus replay TaskFlow's preamble injection. On v2, this becomes: keep `dm-routing.ts` as a TaskFlow-side hook that, on inbound DM, looks up the active grant and prepends the `[External participant: …]` context tag to the routed message — but `addMember()` for the v2 access gate runs at **invitation send time**, not at first DM. Two-layer model:
   - v2 access gate: "is this user a known member of this board's agent group?" → yes (because invitation pre-seeded the membership)
   - TaskFlow context layer: "which meeting did they DM about?" → look up grants, inject context tag

   This is the design recommended above (option c). It cleanly separates auth (v2 native) from business context (TaskFlow native).

4. **Wholesale re-invite.** Drop the 3 rows on cutover; let TaskFlow re-issue invitations under the v2 model. For today's prod state (all expired), this is operationally identical to (1).

**Recommendation for prod cutover:** Strategy (1) for the 3 currently-expired rows (no migration needed — they already wouldn't route under v1 either). Strategy (3) as the **architectural** answer for any future `external_contacts` additions on v2: invitation-send-time `addMember()` + DM-time context-tag injection. The `dm-routing.ts:resolveExternalDm()` function survives intact in v2 as the context-tag layer; it just no longer needs to drop messages for non-grant DMs (v2's request_approval gate handles that).

**Migration script sketch** (for non-zero active-grant cases on a future cutover):

```sql
-- Run BEFORE switching gateway. Idempotent.
INSERT OR IGNORE INTO main.users (id, kind, display_name, created_at)
SELECT
  'whatsapp:' || ec.phone,
  'whatsapp',
  ec.display_name,
  ec.created_at
FROM taskflow.external_contacts ec
JOIN taskflow.meeting_external_participants mep ON mep.external_id = ec.external_id
WHERE mep.invite_status IN ('accepted','invited','pending')
  AND (mep.access_expires_at IS NULL OR mep.access_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND ec.status = 'active';

INSERT OR IGNORE INTO main.agent_group_members (user_id, agent_group_id, added_by, added_at)
SELECT DISTINCT
  'whatsapp:' || ec.phone,
  b.agent_group_id,                 -- assumes board→agent_group mapping exists
  'migration:taskflow-cutover',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM taskflow.external_contacts ec
JOIN taskflow.meeting_external_participants mep ON mep.external_id = ec.external_id
JOIN taskflow.boards b ON b.id = mep.board_id
WHERE mep.invite_status IN ('accepted','invited','pending')
  AND (mep.access_expires_at IS NULL OR mep.access_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND ec.status = 'active';
```

(Two open questions for that script: (a) what's the v2 `agent_group_id` for `board-sec-taskflow` — boards map 1:1 to agent groups in v2-port? (b) Katia and Ismael have no `direct_chat_jid` — the phone is the canonical id, so it works.)

---

## 9. Observations + edge cases

- **The card carries no `accept-on-this-channel` info.** If admin clicks Allow on Telegram, the sender is admitted to the agent group regardless of which channel they originally wrote on. Cross-channel implications: admitting a "telegram:stranger" via approval doesn't admit "whatsapp:5586..."; identities are channel-scoped because user IDs are namespaced.

- **`approver_user_id` is who we delivered to, not necessarily who approves.** Authorization (`isAuthorized` check at `permissions/index.ts:241-252`) accepts the original target OR any admin/owner of the agent group. So if the card is forwarded to a co-admin, they can approve too.

- **Re-routing replay reuses the original event byte-for-byte.** `JSON.parse(row.original_message) as InboundEvent`. Timestamp is **not** updated. This means the replayed message still has its original `event.message.timestamp`; if the agent uses timestamps for scheduling, they'll be a few seconds (or minutes) stale. Minor but worth knowing.

- **`pending_sender_approvals` has no FK to `users(sender_identity)`.** The sender_identity is a free-text namespaced id. The user row gets upserted by `extractAndUpsertUser` BEFORE the gate fires (sender resolver runs first), so the user exists by the time we insert. But if the user is somehow deleted between insert and approve, `addMember(user_id=row.sender_identity, ...)` will fail the FK on `agent_group_members.user_id REFERENCES users(id)`. Practically a non-issue since no flow deletes users.

- **Channel-approval flow is a sibling, not the same.** Migration 012 + `permissions/channel-approval.ts` handles "an unknown channel writes mention/DM" — first-time wiring approval. That one creates a `messaging_group_agents` row + auto-admits the triggering sender as a member (so the replay doesn't bounce into sender-approval). Two-layer protection: channel-level + sender-level.

- **Contains no rate-limit and no batching.** Ten different unknown senders within a minute = ten cards delivered to the admin. (Same sender = one card via dedup.)

---

## 10. File map

| Path | Role |
|------|------|
| `src/router.ts` (v2) | Lines 165-176: auto-create with `unknown_sender_policy='request_approval'` default. Lines 100-108: `setAccessGate` registration. Lines 252-302: fan-out invokes `accessGate(event, userId, mg, agent.agent_group_id)` per-agent. |
| `src/modules/permissions/index.ts` (v2) | Lines 39-77: `extractAndUpsertUser` (sender resolver). Lines 81-130: `handleUnknownSender` policy switch. Lines 134-156: gate registrations. Lines 222-279: `handleSenderApprovalResponse` (approve→addMember+replay; deny→delete). |
| `src/modules/permissions/sender-approval.ts` (v2) | Lines 48-156: `requestSenderApproval` (dedup → pickApprover → pickDelivery → insert pending → deliver chat-sdk ask_question card). |
| `src/modules/permissions/db/agent-group-members.ts` (v2) | `addMember` (INSERT OR IGNORE), `isMember` (with implicit-admin-membership). |
| `src/modules/permissions/db/pending-sender-approvals.ts` (v2) | CRUD + `hasInFlightSenderApproval` dedup check. |
| `src/modules/permissions/access.ts` (v2) | `canAccessAgentGroup` — owner/global-admin/admin/member tiers. |
| `src/modules/approvals/primitive.ts` (v2) | `pickApprover`, `pickApprovalDelivery` — approver-walk + DM resolution. |
| `src/modules/permissions/user-dm.ts` (v2) | `ensureUserDm` — direct-addressable vs openDM resolution + `user_dms` cache. |
| `src/db/migrations/001-initial.ts` (v2) | Schema for `messaging_groups.unknown_sender_policy`, `agent_group_members`, `user_dms`, `users`, `user_roles`. |
| `src/db/migrations/010-engage-modes.ts` (v2) | Adds `sender_scope` ('all'|'known') for stricter per-wiring filter. |
| `src/db/migrations/011-pending-sender-approvals.ts` (v2) | Sender-approval table; documents the reverted DEFAULT-flip. |
| `src/db/migrations/012-channel-registration.ts` (v2) | Sibling channel-approval flow + `messaging_groups.denied_at`. |
| `/root/nanoclaw/src/dm-routing.ts` (v1+TaskFlow) | `resolveExternalDm`: phone→external_contact→active grants; lazy-expire; disambiguation flag. |
| `/root/nanoclaw/src/index.ts:952-1043` (v1+TaskFlow) | DM polling + `resolveExternalDm` + context-tag staging into board session. |
| Production: `192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` | 3 `external_contacts` (Edmilson/Katia/Ismael), 3 `meeting_external_participants` (1 revoked + 2 expired-by-date). |
