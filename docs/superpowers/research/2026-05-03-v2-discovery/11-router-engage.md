# v2 router engage logic — engage_mode, engage_pattern, sender_scope, ignored_message_policy

Date: 2026-05-03. Source: `remotes/upstream/v2` (`src/router.ts`, `src/db/migrations/010-engage-modes.ts`, `src/types.ts`, `src/modules/permissions/*`); `remotes/upstream/feat/migrate-from-v1` (`setup/migrate-v2/db.ts`, `setup/migrate-v2/shared.ts`). Scope: how v2 decides whether each inbound message engages the agent, how the four orthogonal columns interact, and what the migration driver wires by default.

---

## TL;DR — engage decision pipeline

For every inbound message, v2 walks four gates in order, **per wired agent** (fan-out):

1. **Structural gates** (in `routeInbound`, before per-agent loop) — drop or auto-create `messaging_groups` row, enforce `denied_at`, escalate via `channelRequestGate` for unwired-but-mentioned channels.
2. **Per-agent `evaluateEngage`** — `engage_mode` × `engage_pattern` × `isMention` × thread-session-existence.
3. **`accessGate`** — `unknown_sender_policy` (`strict` | `request_approval` | `public`) × `users` row × `canAccessAgentGroup` (owner / global_admin / scoped admin / member).
4. **`senderScopeGate`** — per-wiring stricter check: `sender_scope='known'` requires `canAccessAgentGroup` to pass even on `public` MGs.

If all four pass → `deliverToAgent(wake=true)` (write `messages_in.trigger=1`, start typing, wake container).
If `evaluateEngage`/access/scope rejects but `ignored_message_policy='accumulate'` → `deliverToAgent(wake=false)` (write with `trigger=0`, no wake — message sits in session for context).
Otherwise → drop. If no agent engaged AND no agent accumulated, write `dropped_messages` row with `reason='no_agent_engaged'`.

**Cite:** `src/router.ts:259-307` (per-agent loop), `src/router.ts:320-356` (evaluateEngage), `src/modules/permissions/index.ts:144-183` (accessGate + senderScopeGate).

---

## 1. `engage_mode` — full enum

Three values, defined in `src/types.ts`:

```ts
export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';
```

Decision logic (`src/router.ts:340-356`):

| `engage_mode` | Trigger | Interaction with `engage_pattern` |
|---|---|---|
| `pattern` | Regex `engage_pattern` matches `text` | **Required.** Null/missing → defaults to `'.'` (always match). `'.'` is the explicit "always engage" sentinel — short-circuited (no regex compile). Bad regex → fail open (engages, "so admin sees the agent responding + can fix"). |
| `mention` | `event.message.isMention === true` | **Ignored.** The adapter (Telegram/WhatsApp/Slack/Discord/etc.) resolves mentions at SDK level and forwards via `isMention`. Bot's NanoClaw display name is irrelevant — users address by platform handle. |
| `mention-sticky` | `isMention === true` **OR** an existing per-thread session for `(agent_group_id, mg_id, thread_id)` already exists | **Ignored.** DMs (`mg.is_group === 0`) never use sticky — falls through to `false`. After first engagement, `findSessionForAgent()` returns truthy and follow-ups in that thread engage without re-mention. The first engaging mention-sticky wiring also calls `adapter.subscribe()` (idempotent, fire-and-forget) for platforms that need explicit thread subscription. |

`mention` is the strictest non-trivial mode; `pattern` with `'.'` is the loosest; `mention-sticky` is mention-loose-after-first-touch (threaded only).

**Note:** the agent's `agent_group.name` (display name) is **never** used for mention matching. The adapter side already resolved "who was @-mentioned" at the platform level. To disambiguate between multiple wired agents in one chat, use `engage_mode='pattern'` with a regex disambiguator.

---

## 2. `engage_pattern` semantics

```ts
engage_pattern: string | null;
```

- **Type**: source string passed to `new RegExp(pat)` — regex syntax (JS), no flags. Caller wraps anchoring/case sensitivity into the source: `'^@Tars\\b'`, `'(?i)hello'` won't work (no JS inline flags), use `'[Hh]ello'`.
- **Anchored?** No — `RegExp.prototype.test` is **substring** match. `'tars'` engages on `'hey tars look'`.
- **Case-sensitive?** Yes by default; users must encode `[Tt]ars` or `(?:tars|TARS)` themselves.
- **`'.'` sentinel**: short-circuit `return true` before regex compile — avoids the per-message overhead and serves as the canonical "always" pattern.
- **Empty / null**: when `engage_pattern` is null/undefined and `engage_mode='pattern'`, code falls back to `'.'` (always). Empty string `''` would also evaluate to truthy in regex (matches everything), but the explicit `'.'` is the documented sentinel.
- **Bad regex**: `try/catch` around `new RegExp(pat)` — on `SyntaxError`, returns `true` (fail-open) so the admin notices.
- **Codex#5 note**: an `engage_pattern='@<trigger>'` would `RegExp.test(text)` substring-match `@Tars` literally; messages without that string drop. Production traffic without explicit `@Tars` mention drops on the floor → confirmed footgun.

**Cite:** `src/router.ts:341-352`.

---

## 3. `sender_scope` — full enum

```ts
export type SenderScope = 'all' | 'known';
```

Enforced by the **separate** `senderScopeGate` hook (`src/modules/permissions/index.ts:170-183`), independent of `accessGate`:

| Value | Behavior |
|---|---|
| `all` | No-op. Any sender passes (modulo the broader `accessGate` for `unknown_sender_policy ∈ {strict, request_approval}`). |
| `known` | `userId` must resolve to an entry that `canAccessAgentGroup(userId, agent_group_id)` accepts: `owner`, `isGlobalAdmin`, `isAdminOfAgentGroup`, OR `isMember(user_id, agent_group_id)`. Implicit: admins of the group are members; owner/global_admin always pass. |

"Known" is checked against:
- `users` table (existence) — populated by `senderResolver` upserting on first sight.
- `user_roles` (owner / global admin / scoped admin) — `src/modules/permissions/db/user-roles.ts`.
- `agent_group_members` (explicit membership rows) — `src/modules/permissions/db/agent-group-members.ts:30-37`.

**Critical interaction:** `sender_scope` is **stricter than** `unknown_sender_policy`. A wiring on a `public` MG with `sender_scope='known'` rejects unknown senders even though the MG-level gate would have allowed them. This is exactly TaskFlow's case (board members are "known"; random group joiners are not).

**Cite:** `src/modules/permissions/access.ts:21-29`, `src/modules/permissions/db/agent-group-members.ts:25-37`.

---

## 4. `ignored_message_policy` — full enum

```ts
export type IgnoredMessagePolicy = 'drop' | 'accumulate';
```

Applied on the `else` branch (engages-or-allowed = false) of the per-agent loop (`src/router.ts:294-307`):

| Value | Effect on non-engaging message |
|---|---|
| `drop` | `log.debug(...)`, no DB write to that agent's session, no container wake. Message is ignored from that agent's perspective. |
| `accumulate` | `deliverToAgent(... wake=false)`: row written to `messages_in` with `trigger=0`, no typing indicator, no container wake. Message sits in the session DB so when the agent **does** engage on a future message, the prior context is visible. |

Non-engagement still increments the counter (for the no-agent-engaged drop check). Net effect:
- `accumulate` → silent context buildup. Useful for chat-context-aware agents that should "see" the conversation but only respond when addressed.
- `drop` → strict ignore. Useful for low-signal channels where storage is wasteful.

**Cite:** `src/router.ts:294-307`.

---

## 5. Interaction matrix — `pattern + '.' + known + accumulate`

This is the TaskFlow-leaning recipe. Decision table for inbound message on a board with members `{Alice, Bob}` and an unknown sender `Charlie`:

| Sender | `users` row? | `engages` (`evaluateEngage`) | `accessGate` | `senderScopeGate` | Outcome |
|---|---|---|---|---|---|
| Alice (member) | yes | true (`'.'`) | allow (member) | allow (known) | **engage** → wake container |
| Bob (admin) | yes | true | allow (admin_of_group) | allow (known) | **engage** |
| Owner DMing the board | yes | true | allow (owner) | allow (known) | **engage** |
| Charlie (unknown) — MG `public` | upsert→yes | true | allow (`public` short-circuits) | **deny** (`sender_scope_not_member`) | **accumulate** (trigger=0) |
| Charlie (unknown) — MG `request_approval` | upsert→yes | true | **deny** → fires `requestSenderApproval` card | n/a (gate already rejected) | **accumulate** (trigger=0) — but the message ALSO triggered an approval card |
| Charlie (unknown) — MG `strict` | upsert→yes | true | **deny** silently | n/a | **accumulate** (trigger=0) |
| `senderResolver` returns null (no senderId in payload) | n/a | true | **deny** (`unknown_user`) | **deny** (`unknown_user_scope`) | **accumulate** (trigger=0) |
| Bot's own outbound echo (if it routed) | n/a | true | depends | depends | usually drops at adapter level before routing |

**Key observations:**
1. `accumulate` means EVERY message in the chat lands in the session DB regardless of who sent it (subject only to `evaluateEngage`). With `'.'`, that's 100% of messages.
2. Approval cards (`request_approval`) and accumulation are **independent** — a Charlie message simultaneously triggers approval AND accumulates in session DB. Approval result later mutates `agent_group_members`; future Charlie messages then engage the wake path.
3. Inbound from `users` who aren't `agent_group_members` AND not admins/owner → fail `senderScopeGate`. Even if MG is `public`, scope='known' overrides.
4. There's no "tap the bot when not addressed" — without explicit mention or trigger pattern match, messages sit silent (or accumulate).

**Cite:** `src/router.ts:268-307`, `src/modules/permissions/index.ts:144-183`, `src/modules/permissions/access.ts`.

---

## 6. Production scaling estimate

Codex#9 raised the engage volume concern. Numbers:

- 28 boards × ~10 members average × ~45 msg/day each = **~12,600 inbound messages/day** in the steady state.
- With `engage_pattern='.'`: every message passes step 2 (engage).
- With `sender_scope='known'`: messages from members pass step 4; non-member messages are accumulated only.
- Realistic split: ~80% from members, ~20% from non-members / system events / admins from elsewhere → **~10,000 wake-container events/day** if untuned.

**Per-board cadence**: ~360 wake events/day, ~15/hour, ~1 every 4 minutes during active hours.

**Cost vectors hit by every wake event**:
- Container wake (`wakeContainer` in `deliverToAgent`).
- Typing-indicator refresh loop (`startTypingRefresh`).
- Session re-attach (read CLAUDE.md, recall preamble, etc.).
- LLM token usage if the agent decides to actually respond.

**Mitigation options if this is too much**:
- `engage_mode='mention'` for sub-set of boards where chatter is heavy → only `@Case` messages wake.
- `engage_mode='mention-sticky'` for thread-aware platforms (not WhatsApp/Telegram in our case — neither supports threads cleanly).
- `engage_pattern='^(@Case|/[a-z])'` — engage only on explicit address or slash command.
- Add a pre-engage trigger like `'(@Case|tarefa|task)'` — engages on TaskFlow-relevant chatter only.

**Inside the agent loop**, the SDK's `claude-context-recap` and command-gate also short-circuit some wakes (filtered slash commands return early in `deliverToAgent` before `wakeContainer`). But base-line wake load is still the concern.

**Recommendation**: TaskFlow boards should default to `engage_mode='pattern'` with a trigger-aware regex (e.g. `'(@Case|@Tars|^/)'`), NOT `'.'`. The `'.'` everywhere is what Codex#9 flagged.

---

## 7. Migrate-v2 driver default

`setup/migrate-v2/db.ts:174-186` (`feat/migrate-from-v1` branch) wires every v1 group as:

```ts
createMessagingGroupAgent({
  id: generateId('mga'),
  messaging_group_id: mg.id,
  agent_group_id: ag.id,
  engage_mode: engage.engage_mode,        // ← from triggerToEngage()
  engage_pattern: engage.engage_pattern,  // ← from triggerToEngage()
  sender_scope: 'all',                     // ← HARDCODED
  ignored_message_policy: 'drop',          // ← HARDCODED
  session_mode: 'shared',
  priority: 0,
  created_at: createdAt,
});
```

And `triggerToEngage()` in `setup/migrate-v2/shared.ts:96-115`:

```ts
if (pattern === '.' || pattern === '.*') return { engage_mode: 'pattern', engage_pattern: '.' };
if (!requiresTrigger)                  return { engage_mode: 'pattern', engage_pattern: '.' };
if (pattern)                           return { engage_mode: 'pattern', engage_pattern: pattern };
return { engage_mode: 'mention', engage_pattern: null };
```

**Default for v1 groups with `requires_trigger=1` and `trigger_pattern='@Case'`**: `engage_mode='pattern'`, `engage_pattern='@Case'`, `sender_scope='all'`, `ignored_message_policy='drop'`.

**Default for v1 groups with `requires_trigger=0`**: `engage_mode='pattern'`, `engage_pattern='.'`, `sender_scope='all'`, `ignored_message_policy='drop'`. (This is the "respond to everything" v1 flag.)

**For TaskFlow's preferred `known + accumulate`**: the migration script does NOT set those values. Our migration must override post-seed:

```sql
UPDATE messaging_group_agents
   SET sender_scope = 'known',
       ignored_message_policy = 'accumulate'
 WHERE agent_group_id IN (SELECT id FROM agent_groups WHERE folder LIKE '%-taskflow');
```

Plus seed `agent_group_members` rows from v1's per-board roster (currently held in `taskflow_team` rows, or wherever). Without those rows, `sender_scope='known'` will reject every member after migration.

Also: `unknown_sender_policy` is set to `'public'` by `setup/migrate-v2/db.ts:158` for newly-created MGs. With `sender_scope='known'`, that's fine — the per-wiring scope tightens regardless. But it does mean the MG-level approval-card flow is bypassed; tightening to `'request_approval'` post-migration may be desirable for boards where unknown senders should be approved-in.

---

## 8. Edge cases

### 8a. Board member's DM → bot

DM is `mg.is_group === 0`. In `routeInbound`, if no `messaging_groups` row exists, auto-create only on `isMention=true` (most platforms set `isMention=true` for DMs to the bot — Telegram and Discord do; WhatsApp DM is `isMention=true` per the bug-fix branch `fix/whatsapp-dm-isMention`). For `mention-sticky`, `mg.is_group === 0` short-circuits to `return false` (no sticky) — DMs use `mention` semantics or `pattern`. For `pattern + '.'`, every DM message engages.

`agent_group_members` is by `agent_group_id`, not by MG — a member of board X who DMs the bot uses the same membership row. So the user is "known" in any MG wired to that AG.

### 8b. Unknown sender post (non-member)

Three policies, three behaviors:
- `unknown_sender_policy='strict'`: silent drop (`recordDroppedMessage` reason `unknown_sender_strict`).
- `unknown_sender_policy='request_approval'`: drop the inbound + fire approval card to designated approver via `requestSenderApproval`. The card sits in `pending_sender_approvals`. If approved → `addMember` + `routeInbound(stored event)` replays.
- `unknown_sender_policy='public'`: bypasses the entire `accessGate` (returns `{allowed:true}` early). But `senderScopeGate` still applies — `sender_scope='known'` rejects.

### 8c. Replies to bot messages (quoted/reply)

Routing doesn't special-case replies in `evaluateEngage`. The reply text is just the message text; `isMention` depends on whether the platform considers a reply-to-bot as a mention (Telegram: yes; WhatsApp: no by default; Slack: yes via `<@U…>`). Adapters normalize this in `event.message.isMention`.

For `mention-sticky`, an existing thread session re-engages without checking `isMention`; for `pattern + '.'`, replies always engage; for `mention`, depends on the adapter's `isMention` resolution for that reply event.

### 8d. The bot's own message routed back

Adapters typically filter their own outbound on the inbound path (Baileys: `key.fromMe=true` filter; Telegram: `from.is_bot && from.id === bot.id` filter). If they don't, `senderResolver` upserts the bot's user_id; whether it engages depends on whether that user is a member or not. A `'.'`-pattern + `sender_scope='all'` chat would engage on every echo → infinite loop risk. **Defensive**: never set `sender_scope='all'` for `'.'`-pattern wirings unless you trust adapter filtering.

### 8e. Channel without any wired agents (`agentCount === 0`)

Special-cased early in `routeInbound` (`src/router.ts:194-218`). If `isMention=false`, silent ignore (no DB write at all). If `isMention=true` AND `denied_at` is set, silent drop. If `isMention=true` AND `channelRequestGate` is registered, fires the gate (escalates to owner via approval card). Otherwise: log warning + drop.

### 8f. `senderResolver` returns null

Happens when payload has no `senderId` / `sender` / `author.userId` — e.g. system events, or chat-sdk-bridge formats we don't recognize. `userId=null` flows into the gates; `accessGate` rejects with `unknown_user`; `senderScopeGate` rejects with `unknown_user_scope`. Net: same as unknown sender — accumulate or drop.

### 8g. Multiple wired agents (fan-out)

Each wired agent in the MG runs through `evaluateEngage` + gates independently. Multiple agents can engage on the same message (each gets its own session, its own wake). `messageIdForAgent` namespaces `messages_in.id` by agent_group_id (`${baseId}:${agentGroupId}`) to avoid PK collision across session DBs.

---

## Recommended TaskFlow defaults

Based on this research, our migration should set per TaskFlow board:

```ts
{
  engage_mode: 'pattern',
  engage_pattern: '(@Case|@Tars|^/[a-z])',  // trigger-explicit, NOT '.'
  sender_scope: 'known',
  ignored_message_policy: 'accumulate',
}
```

Plus:
- `unknown_sender_policy='public'` on the MG (current migration default) → fine when paired with `sender_scope='known'`.
- Seed `agent_group_members` rows from existing TaskFlow board rosters BEFORE the engage-pattern tightens.
- Seed `user_roles` for one global owner (per `project_v2_user_roles_invariant`) and per-board scoped admins.

Migration override SQL:

```sql
UPDATE messaging_group_agents
   SET engage_pattern = '(@Case|@Tars|^/[a-z])',
       sender_scope = 'known',
       ignored_message_policy = 'accumulate'
 WHERE agent_group_id IN (
   SELECT id FROM agent_groups WHERE folder LIKE '%-taskflow'
 );
```

This trims wake events from ~10k/day to an estimated ~2-3k/day (only explicit triggers), keeps full chat in session DBs for context recall, and rejects random non-members at the wiring level even on `public` MGs.

---

## File path

`/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/11-router-engage.md`
