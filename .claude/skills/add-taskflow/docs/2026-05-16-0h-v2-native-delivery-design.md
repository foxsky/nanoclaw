# 0h-v2 — native outbound delivery for the FastAPI MCP path (design memo)

**Status:** ✅ **DECIDED 2026-05-16 — Option A** (owner, via tf-mcontrol
Banner #9). This memo is now the build spec; §3–6 are retained as the
rationale record. **Author:** nanoclaw side. **Scope:** the *only* remaining
nanoclaw deliverable before Phase 3 (`POST /chat → api_send_chat`, then 0j-b).

---

## 0. Decision + folded-in refinements (2026-05-16)

**Chosen: Option A** — dedicated TaskFlow "service session" +
`taskflow_notify` delivery-action + `enqueueOutboundMessage(...)` engine
helper (reuses the `send_otp` out-of-turn pattern and the existing
`delivery.ts` drain loop).

**§7 decisions resolved (Banner #9):**
1. **Keep the in-container WhatsApp path as-is** — confirmed (both sides).
   Byte-oracle parity is the cheapest regression-gate; don't trade it for
   path-unification with no second consumer.
2. **Service-session bootstrap = nanoclaw's call.** tf-mcontrol only needs
   the FastAPI-originated `messages_out` rows to reach a *registered*
   session's `outbound.db` that `delivery.ts` drains.
3. **Phase-3 order:** (a) helper + service session live → (b) tf wires
   `POST /chat → api_send_chat` → (c) flip `notify_task_commented` from
   inline-IPC to MCP-tool-result-with-engine-enqueue → (d) 0j-b deletes the
   IPC writer.

**Codex review #2 (gpt-5.5/xhigh) — three REQUIRED build constraints
(verified at source; fold into implementation, not optional):**
- **Path-aware + race-safe enqueue.** Do **not** reuse `writeMessageOut`
  as-is: it is hardcoded to `/workspace/{inbound,outbound}.db`
  (`container/agent-runner/src/db/connection.ts:23`) and does
  read-max-seq-then-insert (`messages-out.ts:49,60`) with a `UNIQUE seq`
  (`src/db/schema.ts:223`) → a racing FastAPI enqueue can throw/drop.
  `enqueueOutboundMessage` must take the service session's DB paths
  explicitly and use an atomic/retry-safe insert. **Reuse the
  `writeOutboundDirect` pattern** (`src/session-manager.ts:377`) — the
  existing host-side direct-outbound primitive — rather than the
  seq-racing `writeMessageOut`.
- **Fail-closed routing.** `board_people.notification_group_jid` is
  nullable (`src/taskflow-db.ts:37`; root person seeded `null` in
  `provision-root-board.ts:171`) and `messaging_groups` is **not**
  FK-linked to boards (host lookup is platform-only,
  `src/db/messaging-groups.ts:43`). The `taskflow_notify` host handler
  MUST explicitly log+error (never silent-drop) when `board_id`+target
  cannot resolve to `(channel_type, platform_id, chat target)`.
- **Service-session bootstrap = confirmed feasible** (Codex Part 2 #2):
  `getActiveSessions()` filters only `status='active'`
  (`src/db/sessions.ts:66`); a never-messaged synthetic session IS drained
  by the 60s `pollSweep` provided it has an `agent_groups` row + an
  initialized session DB pair + `status='active'` (not `running`/`idle`).
  Not a hidden blocker.

**Open note (not blocking):** Codex flagged the in-container delivery of
TaskFlow `notification_events` is not source-enforced — migration text says
"do NOT relay" (`scripts/migrate-board-claudemd.ts:386`). Whether the
in-container path actually delivers comment/assignee notifications today is
a *separate* question; it does not affect Option A (which owns the FastAPI
path). Track separately.

---

## 0.1 Codex review #3 (gpt-5.5/xhigh, 2026-05-16) — cross-TaskFlow-DB BLOCKER + binding payload correction

**BLOCKER (verified at source).** The host owns ONE TaskFlow DB at
`<DATA_DIR>/taskflow/taskflow.db` (`src/taskflow-mount.ts:18`;
`/root/nanoclaw/data/taskflow/taskflow.db`). tf-mcontrol spawns the bun
subprocess with `--db self.db_path` (`tf .../engine/client.py:64`); on
`.61` that is `TASKFLOW_DB_PATH=/root/tf-mcontrol/taskflow-api/taskflow-dev-snapshot.db`
(`tf taskflow-api/.env:1`) — a **different physical file**. A Unit 3
handler resolving `board_id` → routing by reading nanoclaw's host
taskflow.db (as `provision-*` handlers do) would read a DIFFERENT DB than
the one FastAPI just mutated → routing fails or routes stale.
`DATA_DIR` is `process.cwd()`-derived (`src/config.ts:24`), so even the
"same path" assumption is not guaranteed across the two processes.

**Binding correction (supersedes §5's "host resolves board→channel").**
The `taskflow_notify` **host handler performs ZERO TaskFlow-DB reads.**
All TaskFlow-side resolution happens **inside the subprocess at enqueue
time** — that process holds the SAME taskflow.db FastAPI mutates, so it
is always correct regardless of which `--db` is passed. The engine
resolves person→`notification_group_jid` and board→`group_jid` (it
already computes `notification_group_jid` —
`apiAddTaskComment` returns `notifications[].notification_group_jid`) and
puts the **fully-resolved chat destination** in the `taskflow_notify`
payload. The host handler only does: resolved-JID → `messaging_groups`
(central `v2.db`, host-owned, single, not cross-repo) → channel adapter,
**fail-closed** (Codex#2 unchanged).

**Unit 1 payload-contract refinement (follow-on).** `EnqueueOutboundParams.target`
must carry the engine-resolved destination JID, NOT a bare `person_id`
the host would have to look up. `{kind:'group',group_jid}` already is a
JID; the `person` case must become the resolved `notification_group_jid`
at enqueue time. `enqueueOutboundMessage` itself is unchanged (it is
payload-shape-agnostic); the callers (`api_send_chat`, the comment push)
resolve before calling.

**Why not Codex's alt (force tf `--db` == host path + smoke check):**
the handoff history shows DB-path/identity drift is a *recurring* failure
class (the `normalizeAgentIds` BLOCKER saga); `.61` deliberately uses a
tf-local snapshot for validation. Coupling correctness to a deployment
config that has repeatedly drifted is fragile. Payload-self-contained is
substrate-independent and aligns with the engine's existing notification
model. (Owner/tf may counter-vote — relayed via handoff banner.)

**Effect:** Unit 3 is GATED on this contract being acknowledged (it
changes what Unit 3 reads and what the payload must carry). Unit 1's
fail-loud hardening (`ON CONFLICT(id) DO NOTHING` + throw-on-miss,
commit `c8013ca5`) landed independently.

---

## 0.2 V1-VERIFIED CORRECTION — `api_send_chat` is NOT WhatsApp (2026-05-16, owner: "Mirror V1 exactly")

**This supersedes the §1 premise that `api_send_chat` "emits an outbound
WhatsApp/channel message".** Verified against V1 source
(`backup/pre-update-75427427-20260509-131237:src/index.ts`,
`container/agent-runner/src/ipc-mcp-stdio.ts`,
`tf-mcontrol .../app/main.py:3376/3407`):

**V1 web chat is a dashboard-only two-way channel mediated by the
`board_chat` table in `taskflow.db` — explicitly NOT WhatsApp.** The V1
agent tool `send_board_chat` says so verbatim: *"visible in TaskFlow
dashboard, not WhatsApp."* The mechanism is **one agent, channel-
symmetric routing keyed on a `web:` sender tag**:

1. **Ingress:** a web `POST /chat` becomes a normal agent-loop message
   tagged `web:` (`isWebOriginMessage`: `sender`/`sender_name` starts
   `web:`). tf-mcontrol also INSERTs the user row into `board_chat`
   (transcript). `GET /chat` + WebSocket render `board_chat`.
2. **Trigger bypass:** `needsTrigger = !isMainGroup &&
   requiresTrigger !== false && !hasWebOrigin` — web-origin messages
   **bypass the `@trigger` requirement**, so a web chat ALWAYS wakes
   the agent (this is why "a chat with no answer" is impossible — it
   was the wrong mental model).
3. **Egress-back (the crux):**
   `routedToBoardChat = isWebOrigin && appendAgentOutputToBoardChat(...)`;
   `if (!routedToBoardChat) enqueueAgentOutput(...)`. The agent reply
   for a web-origin turn is written to **`board_chat`
   (`sender_type='agent'`)** and **NOT** sent to WhatsApp; otherwise
   normal WhatsApp delivery. The answer returns to the *same surface
   the message arrived on*.

**Corrected v2 design for `api_send_chat` (mirror V1):**
- Ingress: web `POST /chat` → engine writes the `board_chat` user row
  AND a `web:`-tagged inbound into the target session's `inbound.db`
  (`messages_in`), trigger-bypassed.
- Egress-back: when the agent reply is for a web-origin turn, the host
  routes it to `board_chat` (`sender_type='agent'`) instead of the
  WhatsApp channel adapter. tf-mcontrol `GET /chat` (exists in v2,
  `app/main.py:3376`) renders it.
- **No service session / `taskflow_notify` / WhatsApp adapter for web
  chat.** That whole rail (Units 1–4) is correct ONLY for the
  *comment-assignee WhatsApp push* (`notify_task_commented` parity),
  which genuinely targets WhatsApp.

**Status impact:** §0–§0.1 (service session, `enqueueOutboundMessage`,
`taskflow_notify`, `--service-outbound-db`) remain valid **for the
comment-assignee push only**. Units 1–4 are NOT wasted but are NOT the
`api_send_chat` path. The published memo + Codex#3 + the tf-mcontrol
handoff round-trip were all framed on the wrong "api_send_chat →
WhatsApp" premise and must be re-based before any `api_send_chat`
code lands. NEXT: design the v2 web-origin ingress + the host
web-origin reply-routing (mirror V1's `isWebOrigin` branch), then
re-relay the corrected split to tf-mcontrol.

---

## 0.3 Corrected v2 `api_send_chat` design (web chat = `board_chat` round-trip; mirror V1)

Relay status: V1-correction relayed to tf-mcontrol (`918eca8`).

**v2 substrate facts (verified at source):**
- `messages_in` (session `inbound.db`) has a `trigger INTEGER NOT NULL
  DEFAULT 1` column (`db/session-db.ts:320`); the router's gate is
  `isMention`/trigger-pattern (`router.ts:170,184`). Sender identity is
  inside `content` JSON (`safeParseContent` → `{text,sender,senderId}`,
  `router.ts:146`), there is **no** top-level sender column. ⇒ v2
  "web-origin" = a sentinel in `content.sender` (mirror V1 `web:` prefix)
  + the row written with `trigger=1` so it processes WITHOUT an
  `@mention` (this *is* V1's `!hasWebOrigin` trigger-bypass).
- The FastAPI MCP subprocess has taskflow.db but **NOT** any session
  `inbound.db` (same constraint as Codex#3, now on the *ingress* side):
  the engine can write `board_chat` but **cannot** write a session's
  `messages_in`.
- No v2 `send_board_chat` exists. V1's lived in the in-container MCP
  (`ipc-mcp-stdio.ts`); the v2 agent container DOES mount taskflow.db at
  `/workspace/taskflow/taskflow.db` (`taskflow-mount.ts`), so a v2
  in-container `send_board_chat` tool can write `board_chat` directly —
  a near-verbatim V1 port.

**REVISED design (Codex review #4, gpt-5.5/xhigh — adopted; supersedes
the poller/tool sketch). Same Unit 1–4 service-session bus, NEW
actions — no 2nd poller, no DB tailing, no agent-remembered tool.**

Codex #4 verdicts folded in: A1 V1 had **no** `board_chat`→agent
poller (V1 messages enter `store/messages.db` only via channel
`onMessage→storeMessage`, `backup:src/db.ts:577-612`; V1 `POST /chat`
only writes `board_chat`) — so a v2 poller is NOT "mirroring V1"; the
v2 ingress is a deliberate v2 contract, defined here + e2e-tested. A2
`messages_in.trigger` is NOT a router @mention-bypass; the bypass is
**writing the row directly into the target session** (skipping
`routeInbound`) with `trigger=1` to wake. A3/A4 confirmed.

1. **Ingress — engine enqueues a system action on the service bus
   (reuse Units 1–4; NO poller).** `api_send_chat` runs in the FastAPI
   subprocess (it has the *correct* `--db` by construction → no
   cross-DB drift, kills the poller's BLOCKER): it (a) INSERTs the
   `board_chat` user row, (b) `enqueueOutboundMessage(...)` a
   `system { action:'taskflow_web_chat_inbound', board_id,
   board_chat_id, sender_name, content, created_at }` into the service
   session's outbound.db (self-contained payload — Codex#3 philosophy).
2. **Host delivery-action `taskflow_web_chat_inbound`** (sibling of
   `taskflow_notify`; host has all session DBs): resolves
   board→messaging_group→session and writes a `messages_in` row
   **directly** into that session's inbound.db with `trigger=1` and
   **structured** web metadata in `content`:
   `{ origin:'taskflow_web', board_id, board_chat_id, sender_name,
   text }` (NOT a bare `web:` string — Codex IMPORTANT; keep a `web:`
   display marker only for formatter compat). Inbound id =
   `taskflow-web:${board_chat_id}` + `INSERT OR IGNORE` ⇒ idempotent,
   dedup by `board_chat.id` (never `created_at`).
3. **Agent turn.** Direct-written `trigger=1` row wakes the agent with
   no `@mention` (A2-correct trigger-bypass).
4. **Reply — IN-CONTAINER batch-web-origin decision → `taskflow_web_chat_reply`
   system action (CORRECTED 2026-05-17, source-verified; supersedes
   Codex#4's `in_reply_to`-keyed host router).** Verification result:
   v2 `routing.inReplyTo = messages[0].id` (`formatter.ts:113`,
   `extractRouting`) — every outbound stamps `in_reply_to` = the
   batch's **first** inbound id only. V1's real semantics are
   **batch-level**: `isWebOrigin = missedMessages.some(isWebOriginMessage)`
   (`backup:src/index.ts:570`) → if ANY batch message is web-origin the
   WHOLE reply goes to `board_chat`. A v2 session batches web-injected
   + WhatsApp messages together, so a host `in_reply_to` key
   mis-routes mixed batches (not V1-faithful). **Correct key = "did
   this turn's inbound batch contain ≥1 `origin:'taskflow_web'`
   message?" — computed in the container poll loop** (it has the
   batch; same structural point as V1's host decision). When true, the
   turn's agent text is emitted as a `system
   { action:'taskflow_web_chat_reply', board_id, board_chat_id?,
   text }` on the service bus instead of normal channel output; a host
   delivery-action INSERTs `board_chat (sender_type='agent',
   sender_name=ASSISTANT_NAME, created_at=ISO-Z)` and does NOT deliver
   to the channel adapter. Symmetric with the ingress action, exact V1
   batch semantics, zero `in_reply_to` fragility, no agent-remembered
   tool. (Poll-loop output paths to gate:
   `poll-loop.ts:1386/2050/2539/3139/3703` + the bare-final-text
   path.)

   **PINNED GATE (2026-05-17, source-verified — refines "gate the 5
   paths"):** all user-facing reply paths funnel through ONE writer,
   `writeMessageOut` (`db/messages-out.ts`); core.ts `send_message`/
   `send_file` (122/169/210/251), the poll-loop fast-paths, and the
   bare-final-text path ALL emit `kind:'chat'`. **`kind:'chat'` does
   NOT discriminate** the reply-to-the-triggering-conversation from an
   explicit `send_message(to:"other")` / a2a / multi-destination send
   (all `kind:'chat'`). The correct discriminator is **routing-match**:
   V1's `appendAgentOutputToBoardChat` replaced exactly
   `enqueueAgentOutput(chatJid,…)` — the reply to the *triggering*
   chat, NOT cross-destination sends. So the gate is:
   - Extend `current-batch.ts` (already threads `inReplyTo`) with
     `webOrigin: { board_id, board_chat_id } | null`, set at batch
     determination from `batch.some(c =>
     safeParseContent(c.content).origin === 'taskflow_web')`, cleared
     after the batch (exactly like `setCurrentInReplyTo`). Also
     capture the batch's triggering routing
     (`routing.platformId/channelType/threadId`).
   - In `writeMessageOut`: IF `getCurrentWebOrigin()` set AND row
     `kind==='chat'` AND row routing == the batch triggering routing
     (it's the reply to THIS conversation, not an explicit other
     destination / a2a) → rewrite the row to `kind:'system'`,
     `content = {action:'taskflow_web_chat_reply', board_id,
     board_chat_id, text:<original .text>}`. Else write unchanged.
   - **Edge cases to test (hot path — high blast radius):** (1)
     web-origin + reply via send_message → transformed; (2) web-origin
     + bare-final-text → transformed; (3) web-origin turn but agent
     `send_message(to:"otherDest")` → NOT transformed (routing differs
     → still delivered there); (4) non-web turn → never transformed;
     (5) a2a / system rows during a web turn → untouched; (6)
     web-origin fast-path replies (greeting/completion) → transformed.

   **RISK: this edits `writeMessageOut`, the single outbound writer
   every channel + a2a + scheduling depends on.** A wrong gate breaks
   replies on EVERY channel or misroutes a2a. Per the session's
   "Codex before risky closure" rule + the verify-before-build
   discipline (it has caught a real bug at every comparable point:
   Codex#3 ×2, V1 inversion, in_reply_to batch-first, group_jid gap),
   this gate design SHOULD get a Codex review BEFORE it lands in the
   hot path — it is categorically riskier than units 1–3 of this
   pipeline. Not a tail-end slam.
5. **Render.** tf-mcontrol `GET /chat` (`app/main.py:3376`) +
   dashboard **5-second poll** (`BoardDetail.tsx:232-290` — NOT a
   WebSocket broadcast; correct prior banners). Recommend tf-mcontrol
   `ORDER BY created_at, id`.

**Schema gap (Codex IMPORTANT):** nanoclaw's canonical
`src/taskflow-db.ts` does NOT create `board_chat`; tf-mcontrol only
indexes it if present. v2 must create/migrate `board_chat` in the
canonical TaskFlow schema before agents write it.

**RESOLVED 2026-05-17 (source-verified):** `messages_out.in_reply_to`
IS reliably set, but only to the batch's FIRST inbound id
(`formatter.ts:113`) — insufficient for V1's batch-level
`some(isWebOrigin)` parity on mixed batches. Conclusion folded into
step 4 above: the web-origin reply decision moves IN-CONTAINER
(poll-loop, batch-level), emitted as the `taskflow_web_chat_reply`
system action. No host `in_reply_to` correlation. Codex#4's BLOCKER-3
concern (don't rely on an agent-remembered tool; don't leak to
WhatsApp) is still honored — the routing is structural in the poll
loop, not an agent choice.

**Net:** Units 1–4 (service session, `enqueueOutboundMessage`,
`--service-outbound-db`, the `system`/delivery-action bus) are reused
for BOTH the comment-assignee WhatsApp push AND web-chat ingress
(new `taskflow_web_chat_inbound` action) — not WhatsApp delivery for
chat. tf-mcontrol `POST /chat`/`GET /chat` unchanged.

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
