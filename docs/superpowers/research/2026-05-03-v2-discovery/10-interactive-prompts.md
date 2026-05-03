# v2 interactive primitives — `ask_user_question` vs `pending_approvals`

Date: 2026-05-03. Source: `remotes/upstream/v2`, `remotes/upstream/channels`. Scope: definitive picture of when each primitive applies, durability, and TaskFlow port-forward implications.

## TL;DR — when each primitive applies

| Need | Use |
|---|---|
| Container agent needs a quick answer (≤5 min) from the **current** chat | `ask_user_question` (MCP tool, blocking) |
| Container agent needs a sensitive admin OK that may take **hours/days**, possibly from a **different** user/DM | `requestApproval()` + `pending_approvals` |
| Bulk synchronous bot operation ("aprovar todas as atividades de Mauro") executed in one user turn | Neither — pure engine call + `send_message` reply |

Both primitives ride the same wire format (`ask_question` card) and the same response dispatcher (`registerResponseHandler`). They differ entirely in **persistence + addressing + handler shape**.

---

## 1. `ask_user_question` semantics

**File:** `remotes/upstream/v2:container/agent-runner/src/mcp-tools/interactive.ts`

### Signature

```ts
ask_user_question({
  title: string,           // required — card header, e.g. "Confirm deletion"
  question: string,        // required — the prompt body
  options: (string | { label, selectedLabel?, value? })[],
  timeout?: number,        // seconds, default 300
})
```

Bare strings are normalized to `{ label, selectedLabel: label, value: label }` via `channels/ask-question.ts:normalizeOption()`. `selectedLabel` replaces the button text after click; `value` is what the agent receives back.

### Mechanics

1. Generate `questionId = msg-{ts}-{rand}`.
2. Resolve current routing via `getSessionRouting()` (the active session's platform/channel/thread).
3. Write a `messages_out` row with `content = JSON.stringify({ type: 'ask_question', questionId, title, question, options })`.
4. Poll `messages_in` every 1000 ms via `findQuestionResponse(questionId)` looking for an unprocessed `pending` row whose JSON content contains `"questionId":"<id>"`.
5. On hit, ack the response (`markCompleted`) and return `{ content: [{ type: 'text', text: parsed.selectedOption }] }` to the agent.

### Returns to the agent

- **(a) Success:** `parsed.selectedOption` — the `value` (or label fallback) of the clicked button. Plain text content, ready for the LLM.
- **(b) Timeout:** `{ isError: true, content: [{ type: 'text', text: 'Error: Question timed out after 300s' }] }`. The agent **gets back control** with an explicit timeout error, not silence.
- **(c) No response by deadline:** identical to (b) — the loop simply exits when `Date.now() >= deadline`.

### Host side (delivery)

`remotes/upstream/v2:src/delivery.ts` (line 316): when delivering an `ask_question` outbound row, the host writes a `pending_questions` row (gated by `hasTable('pending_questions')`):

```sql
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

(Migration 001-initial.) When the user clicks a button, `src/modules/interactive/index.ts` claims the response: looks up the `pending_questions` row, writes a `question_response` system message into the **same** session's inbound DB, deletes the row, wakes the container.

### Implication

`ask_user_question` is **session-pinned** — the response only ever goes back to the session that asked. There is no notion of "ask Bob in his DM and tell Alice's container the answer."

---

## 2. WhatsApp pending-question constraint

**File:** `remotes/upstream/channels:src/channels/whatsapp.ts` (lines 180–200, 540–570, 626–646)

### Storage shape

```ts
const pendingQuestions = new Map<
  string,    // chatJid (one entry per chat)
  { questionId: string; options: NormalizedOption[] }
>();
const PENDING_QUESTIONS_MAX = 64;
```

### Constraints

1. **One pending question per chat JID.** Re-asking in the same chat **silently overwrites** the previous entry. The previous question's button replies become unrecognized text (forwarded to the agent like any normal message). The old container's MCP `ask_user_question` poll keeps spinning until its 300s timeout — it never receives an answer.
2. **Process-local.** This Map lives in the WhatsApp adapter's closure. Adapter restart (host process restart) = all pending in-channel state is gone; replies arrive as plain text; agents poll until timeout.
3. **64-entry FIFO cap.** Once `pendingQuestions.size > 64`, the oldest entry is dropped (`pendingQuestions.delete(oldest)`). Same effect as overwrite — the displaced agent times out.
4. **Slash-command match.** A reply only counts if it `startsWith('/')` and matches `optionToCommand(label)` exactly. Anything else falls through to the inbound message handler.
5. **Late reply (after agent timeout).** The 300s container-side timer is independent of the channel-side `pendingQuestions` Map. A user replying at minute 7 with `/approve`:
   - The Map entry is still there (assuming nothing overwrote it).
   - The channel calls `setupConfig.onAction(questionId, value, sender)`, which dispatches to `src/modules/interactive/index.ts`.
   - That handler writes a `question_response` system message to the session inbound DB **and wakes the container**.
   - But the agent's `ask_user_question` call already returned a timeout error; the LLM has moved on. The system message just lands as out-of-band context in the next turn.

### Why this is unsafe for multi-day approvals

- Any other ask_user_question in the same chat between minute 0 and the user's late reply silently nukes the pending entry.
- A host restart wipes everything in the Map.
- 300s is the hard ceiling for "blocking call returns the answer." After that, you get late context, not a value.

This is the exact constraint Codex flagged. `ask_user_question` is fine for "press one of these three buttons in the next 5 minutes." It is the wrong tool for "wait for an admin who may not look at WhatsApp until tomorrow morning."

---

## 3. `pending_approvals` table

**Files:** `remotes/upstream/v2:src/db/migrations/module-approvals-pending-approvals.ts`, `remotes/upstream/v2:src/db/migrations/module-approvals-title-options.ts`, `remotes/upstream/v2:src/types.ts`, `remotes/upstream/v2:src/db/sessions.ts`.

### Schema

```sql
CREATE TABLE pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             TEXT NOT NULL,        -- JSON, opaque to the engine
  created_at          TEXT NOT NULL,
  agent_group_id      TEXT REFERENCES agent_groups(id),
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|expired
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_pending_approvals_action_status ON pending_approvals(action, status);
```

### Lifecycle

| Phase | Who writes | Who reads | What happens |
|---|---|---|---|
| Create | `requestApproval()` (`src/modules/approvals/primitive.ts`) | — | Inserts a row with `status='pending'`, sends an `ask_question` card to the chosen approver's DM. |
| Wait | — (durable) | — | Card sits in admin's DM until clicked or until any expiry sweep fires. Process restart is fine — the row outlives the host. |
| Resolve | `handleApprovalsResponse` (`src/modules/approvals/response-handler.ts`) | `getPendingApproval(approvalId)` | On approve: dispatches to `getApprovalHandler(action)` registered handler; deletes the row. On reject: notifies originating session via `notifyAgent`; deletes the row. |
| Expire (OneCLI only today) | `onecli-approvals.ts` `sweepStaleApprovals` at startup; per-request timer | — | Edits the card to "Expired" and deletes the row. Module-initiated approvals do **not** currently have an expiry sweeper — they sit forever until clicked. |

### Two consumer categories (`response-handler.ts`)

1. **Module-initiated** — `requestApproval(action, payload, ...)` paired with `registerApprovalHandler(action, handler)`. The handler is called on approve.
2. **OneCLI credential approvals** — `action='onecli_credential'`. Resolved via an in-memory Promise (`resolveOneCLIApproval`). The DB row is the durability fallback if the in-memory state is lost (process restart between request and admin click).

---

## 4. `requestApproval()` API

**File:** `remotes/upstream/v2:src/modules/approvals/primitive.ts`

### Signature

```ts
async function requestApproval(opts: {
  session: Session,                   // originating session (so we can notify it back)
  agentName: string,                  // for the card
  action: string,                     // the registry key — must match registerApprovalHandler
  payload: Record<string, unknown>,   // arbitrary JSON, handed back on approve
  title: string,                      // card title shown to admin
  question: string,                   // card body shown to admin
}): Promise<void>;
```

### Mechanics

1. **Pick an approver.** `pickApprover(session.agent_group_id)` walks `user_roles` in order: scoped admins of this agent group → global admins → owners. Dedup'd. Empty list → notify originating agent "no admin configured" and return.
2. **Pick a delivery channel.** `pickApprovalDelivery(approvers, originChannelType)` prefers approvers reachable on the same channel kind as the origin, falling back to anyone with a usable DM (resolved via `ensureUserDm`, which can trigger a platform `openDM` on cache miss).
3. **Persist.** Insert `pending_approvals` row with `status='pending'`, `title`, `options_json` (a normalized two-button Approve/Reject array — the only options the primitive supports today), `payload` JSON.
4. **Deliver the card.** `deliveryAdapter.deliver(channel_type, platform_id, null, 'chat-sdk', JSON.stringify({ type: 'ask_question', questionId: approvalId, title, question, options }))`. Same wire format as `ask_user_question`. **Hard-coded options** are `Approve` / `Reject`.
5. **Return.** Fire-and-forget — the calling module's request flow ends here. No promise to await. Notification back to the originating session happens later via `notifyAgent` (writes a system chat into the session inbox + wakes the container).

### Differences from `ask_user_question`

| Axis | `ask_user_question` | `requestApproval` |
|---|---|---|
| Who calls | Container agent (MCP tool) | Host module (TS function) |
| Persistence | `pending_questions` (host) — auto by delivery | `pending_approvals` (host) — explicit insert |
| Card target | Current session's chat | Picked admin's DM (often a different chat from the originator) |
| Options | Caller-defined, any number | Hard-coded `Approve` / `Reject` |
| Caller blocks? | Yes — synchronous (300s default) | No — fire-and-forget; result delivered later via `notifyAgent` |
| Survives host restart? | No (channel-side Map is in-memory, but DB row persists for late delivery) | Yes — DB row + handler registry are deterministic on boot |
| Expiry | Hard 300s timeout | None for module-initiated; sweep for OneCLI |
| Originator notification | Return value of MCP call | System message into originator's session inbox (`notifyAgent`) on approve/reject |

---

## 5. `registerApprovalHandler`

**File:** `remotes/upstream/v2:src/modules/approvals/primitive.ts`

```ts
type ApprovalHandler = (ctx: {
  session: Session,                   // originating session
  payload: Record<string, unknown>,   // the JSON we stored
  userId: string,                     // admin who approved
  notify: (text: string) => void,     // shorthand to system-chat the originating session
}) => Promise<void>;

function registerApprovalHandler(action: string, handler: ApprovalHandler): void;
```

Handlers are registered **at module import time** in a process-local `Map<string, ApprovalHandler>`. Match is exact-string on the `action` field stored in the row.

### Example: self-mod (`src/modules/self-mod/index.ts`)

```ts
registerDeliveryAction('install_packages', handleInstallPackages);  // container→host queue
registerApprovalHandler('install_packages', applyInstallPackages); // host approve→apply
```

When admin approves an `install_packages` row, the response handler:
1. Loads the session by `approval.session_id` (returns 0 if gone — drops row).
2. Parses `approval.payload` JSON.
3. Calls `applyInstallPackages({ session, payload, userId, notify })`.
4. On exception: `notify` reports the failure to the originator's session inbox, row is deleted anyway.

If no handler is registered for the action: warn, notify the originator with "approved but no handler installed", drop the row.

---

## 6. Multi-day durability

| Concern | Behavior |
|---|---|
| Container restart | DB row persists; on next user click, the response handler reloads `session_id` and resumes. ✓ |
| Host process restart | DB row persists; handler registry rebuilds at module import time. **Card is still in admin's DM** (it was sent via the channel before restart). ✓ — this is the key win over `ask_user_question`. |
| Host migration to a different machine | Carry `data/v2.db` and the row survives. ✓ |
| Card edit after expiry | Only OneCLI uses this today: `sweepStaleApprovals` edits `platform_message_id` to "Expired (host restarted)". Module-initiated approvals don't track `platform_message_id` (the field exists but `requestApproval` doesn't fill it) — no edit-on-expiry. The row just sits forever. |
| Module expires the row itself | No primitive support today. A consumer wanting "expire after 48h" would have to: write `expires_at` directly into the row after `requestApproval` returns, run its own sweep. |
| Originating session deleted | Approve still dispatches to `getApprovalHandler`; handler must tolerate `getSession(...)` returning undefined. The OOTB response-handler short-circuits to "drop the row" if `session_id` is null or session is gone. |
| Schema drift | Migration 003 (`module-approvals-pending-approvals`) created the table without `title`/`options_json`; 007 (`module-approvals-title-options`) ALTERs them in for old installs. Idempotent. ✓ |

**Bottom line:** `pending_approvals` is the only v2 primitive that survives host restart between request and resolution.

---

## 7. TaskFlow port-forward decision

**The current state (skill `add-taskflow`):**

- Engine has a `subtask_requests` table (created idempotently in engine init, per CHANGELOG) with `request_id`, `status='pending'`, child board id, parent board id, subtask payload.
- When child-board agent calls `add_subtask` on a delegated task and parent's `cross_board_subtask_mode='approval'`, the engine inserts a `subtask_requests` row + returns `{ success: false, pending_approval: { request_id, target_chat_jid, message, parent_board_id } }`.
- Child agent must `send_message({ target_chat_jid: parent_group_jid, text: message })` — relay verbatim — and confirm to user with the `request_id`.
- Parent group receives a plain text message starting `🔔 *Solicitação de subtarefa*` with `ID: \`req-XXX\``.
- Manager replies with `aprovar req-XXX` or `rejeitar req-XXX [motivo]`.
- Parent agent recognizes the slash-prefix-style command in plain chat and calls `taskflow_admin({ action: 'handle_subtask_approval', request_id: 'req-XXX', decision: 'approve'|'reject', ... })`.
- Engine creates the subtask (on approve) and returns a `notifications` array with the child board's `target_chat_jid` + outbound message — agent relays via `send_message`.

### Compare: TaskFlow's `subtask_requests` vs `pending_approvals`

| Property | TaskFlow `subtask_requests` (engine table) | v2 `pending_approvals` |
|---|---|---|
| Persistent across host restart | ✓ (engine SQLite per-board) | ✓ (central v2.db) |
| Approver routing | Hard-coded: parent board's `group_jid` (group chat, not admin DM) | `pickApprover` walks `user_roles` — admin's DM only |
| Approval UI | Plain-text message with `aprovar req-XXX` natural-language reply | `ask_question` card with Approve/Reject buttons |
| Approval matched by | Bot recognizing `aprovar req-XXX` token in plain chat → engine call | `questionId` ↔ `approval_id` exact match in response handler |
| Approver identity | Whoever in the parent group says "aprovar" — bot-side check that they are a manager | Engine knows `userId` of clicker; primitive picks from `user_roles` upstream |
| Response notification | Engine returns `notifications[]` with target jid + message; agent relays via `send_message` | `ApprovalHandlerContext.notify(text)` → originator's session inbox |
| Multi-tenancy / multi-board | Native — `subtask_requests` is per-board in the per-board engine DB | Central — all boards share one `pending_approvals` |
| Where the "decision" surface lives | Parent group chat (visible to the team) | Single admin's DM (private) |

### (a) Preserve `subtask_requests` + `/aprovar` text protocol

**Pros:**

- Decision visible in the group chat → audit trail + social pressure ("I see Miguel asking the boss to approve this"). Matches how Brazilian gov teams already work over WhatsApp.
- Manager identity is whoever-is-active-in-the-group — no need to map gov managers into v2's `user_roles` admin tier.
- Approval surface is plain text, so it works in any channel without depending on `ask_question` card support.
- Engine owns its own state — no cross-boundary trust between v2 host and TaskFlow engine.
- Already shipped, already tested, dead-code-but-only-because-no-board-has-flipped-the-flag — not actually wrong.

**Cons:**

- Reinvents persistence + lifecycle management that v2 already provides centrally.
- Heuristic parsing — "aprovar req-XXX" depends on the parent agent recognizing the natural-language pattern; if the agent paraphrases the request at relay time, the manager might reply with non-matching text.
- No expiry / no card edit — pending requests can pile up indefinitely.

### (b) Refactor onto `pending_approvals`

**Pros:**

- Single source of truth for approval state across the host.
- Free durability + handler dispatch + (eventually) sweep / expiry.
- Type-safe round-trip — `payload` is JSON, `action='taskflow_subtask_request'` registered via `registerApprovalHandler`, the handler calls `taskflow_admin({ action: 'handle_subtask_approval', ... })` directly. No agent-side natural-language parsing.

**Cons (decisive for TaskFlow):**

- v2's `pickApprover` walks `user_roles` (`admin` scoped to `agent_group_id`). TaskFlow's "manager of parent board" is not the same concept as v2's "admin of agent group" — and the v2 `user_roles` invariant explicitly disallows scoped owners (per `project_v2_user_roles_invariant`). Mapping every TaskFlow board manager into a `user_roles` admin row is a significant data-model graft.
- v2's `requestApproval` delivers to **one admin's DM**. TaskFlow's design delivers to the **parent group**, intentionally, so the team sees the request. This is a UX semantic, not an implementation detail.
- v2's options are hard-coded `Approve`/`Reject`. TaskFlow's `rejeitar req-XXX [motivo]` carries a free-text rejection reason — `ask_question` cards have no input field.
- Cross-board is fundamentally **board-to-board**, not **container-to-admin**. The originating session is the child agent's session; the approver acts in a different session (parent agent), not "in their DM."

### Recommendation

**Keep TaskFlow's `subtask_requests` + `aprovar`/`rejeitar` text protocol.** This is feedback-rule-2 territory ("Use v2 native features; don't duplicate"): `pending_approvals` looks superficially similar but is solving a different problem — single-admin sensitive container mutations like `install_packages`, with one-DM delivery, two-button UI, and a session-pinned originator. TaskFlow's cross-board approval is a **group-visible board-to-board negotiation** with a free-text rejection reason — different surface, different invariants.

**Improvements to layer on without refactoring onto `pending_approvals`:**

1. Add `expires_at` column + sweep job to `subtask_requests` (TaskFlow engine code in skill).
2. Replace agent-side "recognize `aprovar req-XXX`" heuristic with a deterministic engine matcher: when the parent agent receives a chat message in the parent group, pre-parse for `^(aprovar|rejeitar) req-[0-9a-z-]+` before invoking the LLM, route directly to `handle_subtask_approval`.
3. Mirror v2's discipline: `subtask_requests.status` should be `pending|approved|rejected|expired` (not just deletion-on-resolve), so audit can answer "did anyone reject this?" weeks later.

What we explicitly do **not** do: try to make `taskflow_subtask_request` an `action` in the global `pending_approvals` table.

---

## 8. TaskFlow review-column "aprovar todas as atividades de Mauro"

**This is neither primitive — it's pure engine + `send_message`.**

The user's message arrives at the parent agent's container. The agent recognizes `"aprovar todas as atividades de X"` and executes a SQL/MCP loop:

1. `SELECT * FROM tasks WHERE board_id = '{{BOARD_ID}}' AND assignee = 'mauro_id' AND state = 'review' AND requires_close_approval = 1`
2. For each row: `taskflow_admin({ action: 'approve_task', task_id: 'TXXX', sender_name: SENDER })` (or whatever the bulk admin call is).
3. Reply summary: "Aprovei T31, T34, T57. T62 não aprovei porque você é o responsável."

**Synchronous within one user turn.** No suspension, no card, no DM, no waiting on another human. The "approval" semantic here is *internal engine state* — flipping `requires_close_approval=1` review tasks to `done` — not "asking another person for permission."

`ask_user_question` would only fit here if the **bot itself** wanted to confirm before running ("Aprovar T31, T34, T57? [Sim/Não]"). For trusted manager senders that's bot friction, not safety — usually skipped. The engine can also enforce permission-to-approve checks (block self-approval, etc.) without an interactive prompt.

`pending_approvals` does not fit at all — the manager is the approver and the requester simultaneously, and the work completes within the turn.

---

## Decision matrix (final)

| Scenario | Primitive |
|---|---|
| Confirm a destructive action in the same chat, ≤5 min, OK to fail-open on timeout | `ask_user_question` |
| Pick from a small known set in the same chat, agent can do nothing useful without the answer | `ask_user_question` |
| Container needs admin OK to `install_packages` / `add_mcp_server` (multi-day OK) | `requestApproval` (`pending_approvals`) |
| OneCLI credential gate for an outbound API call | `pending_approvals` (action `onecli_credential`) — handled by infra, transparent to the agent |
| Cross-board subtask approval where the **parent board's group chat** is the decision surface | TaskFlow's `subtask_requests` + `aprovar`/`rejeitar` text protocol — keep |
| Bulk same-turn engine operation ("aprovar todas") | Pure engine + `send_message` reply — neither primitive |
| Manager privately approves something not visible to the parent group | `requestApproval` — but this is not how TaskFlow works today and would be a deliberate UX change |

## File index

- `remotes/upstream/v2:container/agent-runner/src/mcp-tools/interactive.ts` — `ask_user_question` MCP tool
- `remotes/upstream/v2:container/agent-runner/src/db/messages-in.ts` — `findQuestionResponse`, `markCompleted`
- `remotes/upstream/v2:container/agent-runner/src/db/messages-out.ts` — `writeMessageOut`
- `remotes/upstream/v2:src/channels/ask-question.ts` — `normalizeOption`, payload schema
- `remotes/upstream/v2:src/db/migrations/001-initial.ts` — `pending_questions` table
- `remotes/upstream/v2:src/db/migrations/module-approvals-pending-approvals.ts` — `pending_approvals` table (v3)
- `remotes/upstream/v2:src/db/migrations/module-approvals-title-options.ts` — adds title/options_json (v7)
- `remotes/upstream/v2:src/db/sessions.ts` — `createPendingQuestion`, `getPendingQuestion`, `createPendingApproval`, `getPendingApproval`, `updatePendingApprovalStatus`, `deletePendingApproval`, `getAskQuestionRender`
- `remotes/upstream/v2:src/types.ts` — `PendingQuestion` + `PendingApproval` types
- `remotes/upstream/v2:src/delivery.ts` — pending_questions persistence at delivery time (line 316)
- `remotes/upstream/v2:src/response-registry.ts` — `registerResponseHandler`, `ResponsePayload`
- `remotes/upstream/v2:src/index.ts` — `dispatchResponse`, channel `onAction` wiring
- `remotes/upstream/v2:src/modules/interactive/index.ts` — generic ask_user_question response handler
- `remotes/upstream/v2:src/modules/approvals/primitive.ts` — `requestApproval`, `registerApprovalHandler`, `pickApprover`
- `remotes/upstream/v2:src/modules/approvals/response-handler.ts` — `handleApprovalsResponse`
- `remotes/upstream/v2:src/modules/approvals/onecli-approvals.ts` — credential approval consumer (canonical example of expiry sweep)
- `remotes/upstream/v2:src/modules/self-mod/index.ts` + `request.ts` — module-initiated approval consumer
- `remotes/upstream/channels:src/channels/whatsapp.ts` — channel-side `pendingQuestions` Map (lines 180–200, 540–570, 626–646)
- `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template` (lines 274–333) — current TaskFlow cross-board approval flow
- `/root/nanoclaw/.claude/skills/add-taskflow/CHANGELOG.md` (entries on `subtask_requests`) — engine-side schema
