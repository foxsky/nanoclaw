# Cross-board Agent-to-Agent Routing — Design Spec (Stub)

> **Status:** Stub. Open for brainstorming. Lands at v2 migration Phase 6 (Weeks 16-18) per plan v2.2. **Codex downscoped MVP:** visible-text a2a transport reusing existing `subtask_requests` table + `taskflow_admin({ action: 'handle_subtask_approval' })` — NOT full structured payload with `taskflow_get_forward` MCP read tool. Skip the read tool unless proven needed. See `docs/superpowers/plans/2026-04-23-nanoclaw-v2-migration.md` Phase 6.
>
> **Predecessors:**
> - `docs/superpowers/specs/2026-04-09-cross-board-subtask-approval-design.md` (cross-board subtask Phase 1+2 — `cross_board_subtask_mode` engine flag)
> - `docs/superpowers/specs/2026-04-27-cross-board-mutation-forwarding-design.md` (Phase 1 send_message-based forward, deployed 2026-04-30)
>
> **Author:** Claude (initial draft, 2026-04-30; Codex-corrected, same day). To be refined with user via brainstorming skill before plan-write.

---

## Problem

Cross-board mutations (a child board user asks to add a subtask on a parent board's project) currently flow through a **text-based forward**:

1. Child agent attempts `taskflow_update({ task_id: 'P11', updates: { add_subtask: ... } })`
2. Engine returns `task not found` (project lives on parent board, not exposed to child)
3. Child agent runs the cross-board forward rule: looks up parent via SQL, composes a `📨 X pediu adicionar...` message, sends via `send_message` to parent group's WhatsApp JID
4. **Parent agent's group sees an incoming WhatsApp message from the bot**
5. Parent admin (a human) reads it, manually types `adicionar etapa P11: Y` into the parent group
6. Parent agent acts on the manual command, replies confirming
7. Original asker on child board gets nothing back automatically — they wait for the parent admin to follow up by hand

Pain points:
- **Two-hop human in the middle.** Parent admin re-types the request. Latency, transcription error risk, no atomic "decline" path.
- **Auditor heuristic.** The auditor recognizes the forward by string-pattern (`encaminhad` reply + `send_message_log` row to parent JID) — fragile.
- **No structured payload.** The subtask intent (parent task ID, subtask title, asker identity) is reconstructed from PT-BR prose on the parent side. Multi-action requests (add subtask + set due date) lose structure.
- **No reply path.** Parent admin's decision (added / declined / clarified) doesn't flow back to the child agent automatically.

V2 ships **agent-to-agent routing** (`upstream/main:src/modules/agent-to-agent/agent-route.ts`) — outbound messages with `channel_type='agent'` deliver `content` + attachments into another agent group's `inbound.db`. Permission via `agent_destinations` table. Wired by default in v2.0.21 (verified by Codex: `src/modules/index.ts:19-23`, `src/db/migrations/index.ts:22-27`, `src/delivery.ts:259-269`). Self-messages bypass the destinations ACL (`agent-route.ts:111-118`).

**Important constraint (Codex correction):** the transport preserves arbitrary fields on `content`, but the receiving agent's formatter only renders `content.text` + `attachments` for `kind='chat'` (`container/agent-runner/src/formatter.ts:158-179, 223-235`). **Arbitrary structured fields like `intent`, `task_id`, `requested_actions` are stored in the inbound row but invisible in the parent agent's prompt** unless we either (a) encode them into `content.text`, (b) add a typed formatter path, or (c) expose them via a dedicated MCP read tool on the parent side. This shapes the design below.

This is still the right primitive to replace the text-based forward, but "structured payload" is more aspirational than literal — the parent agent will see whatever we encode into `text`, plus auxiliary fields it can pull on demand.

## Goal

Replace the current cross-board send_message forward with structured agent-to-agent routing:

1. Child agent calls a new MCP tool `taskflow_forward_to_parent_agent({ task_id, subtask_title, asker, requested_actions })` instead of composing a forward message
2. Tool dispatches an a2a route to the parent agent group with structured intent
3. Parent agent receives the request as a typed inbound message, decides (add / decline / clarify), executes the mutation, and routes a structured reply back to the child agent
4. Child agent sees the parent's decision via its own inbound stream and confirms to the original asker
5. Auditor recognizes the a2a route as fulfilling the cross-board mutation, replacing the heuristic

## Non-goals

- Replacing the engine's `cross_board_subtask_mode` flag. Modes (`open`/`blocked`/`approval`) still govern when forwarding even applies.
- Changing user-facing UX in the child group beyond the confirmation phrasing.
- Generalizing to all cross-board mutations in this spec. Phase 1 = `add_subtask` only, matching the current Phase 1 forward scope. `move`, `reassign`, `update` follow in later phases.
- Removing the existing send_message forward immediately. Both flows coexist during migration; a2a is preferred when both source and target boards are on v2.

## Architecture sketch

### Components

1. **`agent_destinations` rows** declared at provision time. Each child board declares its parent agent group as a destination with type `agent`. Optionally: each child declares siblings if delegation visibility is desired. Schema lives in the module migration (`src/db/migrations/module-agent-to-agent-destinations.ts:21-35`), not the static `SCHEMA` string. A per-session projected `destinations` table in `inbound.db` (`src/modules/agent-to-agent/write-destinations.ts:19-58`) is refreshed by `writeDestinations()` on each container wake — Phase 1 must call it after seeding central `agent_destinations` rows so running sessions pick up the wiring without a restart.
2. **MCP tool `taskflow_forward_to_parent_agent`** in `taskflow-mcp-server.ts`:
   - Args: `{ task_id, subtask_title, asker_user_id, asker_display_name, requested_actions: [...] }`
   - Looks up parent agent group from board hierarchy
   - Validates `agent_destinations` row exists
   - Writes a `cross_board_forwards` row (status=pending) for audit
   - Routes an a2a message to parent's `inbound.db` with `content` shaped as:
     ```json
     {
       "kind": "chat",
       "text": "[FORWARD] Caio (UX-SETD-SECTI) → P11: revisar mockup\nForward ID: <ulid>",
       "x_taskflow_intent": "cross_board_forward",
       "x_taskflow_forward_id": "<ulid>",
       "x_taskflow_payload": {...}
     }
     ```
     The `text` field is human-readable and carries the forward ID inline so the parent agent can recover it from the prompt. The `x_taskflow_*` fields are auxiliary (visible to the parent agent ONLY if it pulls them via a dedicated MCP read tool — see component 5).
3. **Parent-side rule** in the parent agent's CLAUDE.md (composed per Spec A — composed CLAUDE.md): "When you see `[FORWARD] <asker> (<group>) → <task_id>: <intent>` in chat, treat it as a structured forward request. Read the full payload via `taskflow_get_forward(<forward_id>)`. Surface to the manager with approval prompt."
4. **MCP tool `taskflow_get_forward`** on parent agents — reads the full payload from the auxiliary `x_taskflow_*` fields (or from our `cross_board_forwards` table by `forward_id`) and returns it in a structured shape the parent agent can act on. **This is the bridge that makes "structured payload" actually visible to the parent agent.**
5. **Approval UI** — parent agent surfaces to the parent group's chat (`📨 Caio (UX-SETD-SECTI) pediu adicionar em P11: 'revisar mockup'. Responda /aprovar abc123 ou /recusar abc123`). Manager replies; parent agent executes and routes a reply a2a back.
6. **Child-side reply handler** — receives `cross_board_forward_reply` (also encoded into `content.text` for visibility), replies in the child group's chat to the original asker.

### Schema additions

```sql
-- Already exists in v2: agent_destinations (central DB)
-- Our additions, fork-private:

CREATE TABLE cross_board_forwards (
  id              TEXT PRIMARY KEY,        -- ULID
  source_board_id TEXT NOT NULL,
  target_board_id TEXT NOT NULL,
  task_id         TEXT NOT NULL,           -- parent task ID (e.g. 'P11')
  intent          TEXT NOT NULL,           -- 'add_subtask' for Phase 1
  payload         TEXT NOT NULL,           -- JSON of structured request
  asker_user_id   TEXT NOT NULL,
  status          TEXT NOT NULL,           -- 'pending'|'approved'|'declined'|'expired'
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  resolution      TEXT                     -- JSON of structured response
);
CREATE INDEX idx_cbf_target_status ON cross_board_forwards(target_board_id, status);
CREATE INDEX idx_cbf_source ON cross_board_forwards(source_board_id);
```

### Flow

```
Child board (Caio asks):
  user: "adiciona etapa em P11: revisar mockup"
  → child agent calls taskflow_update(P11, add_subtask=...)
  → engine returns task_not_found (P11 lives on parent)
  → child agent calls taskflow_forward_to_parent_agent({
      task_id: 'P11',
      subtask_title: 'revisar mockup',
      asker: 'Caio',
      requested_actions: [{add_subtask: 'revisar mockup'}]
    })
  → MCP tool inserts cross_board_forwards row (status=pending)
  → MCP tool routes a2a payload to parent agent group's inbound.db

Parent board (manager sees):
  inbound: structured cross_board_forward message
  → parent agent recognizes intent, replies in parent group:
    "📨 Caio (de UX-SETD-SECTI) pediu adicionar em P11: 'revisar mockup'.
     Aprovar? Responda: /aprovar abc123 ou /recusar abc123"
  → manager types /aprovar abc123
  → parent agent calls taskflow_update(P11, add_subtask='revisar mockup')
  → engine adds subtask successfully
  → parent agent updates cross_board_forwards.status='approved'
  → parent agent routes cross_board_forward_reply a2a back to child

Child board (Caio sees):
  inbound: cross_board_forward_reply (status=approved)
  → child agent replies in child group:
    "✅ @Caio Sua etapa foi aprovada e adicionada em P11."
```

### Auditor changes

- Recognize `agent_route` system action (target=`agent`) as fulfilling `unfulfilledWrite` for cross-board mutation requests
- New audit findings: `crossBoardForwardPending` (still in `pending` after >24h), `crossBoardForwardOrphan` (no reply received), `crossBoardForwardDeclined` (counts toward fulfilled but flagged for review)

## Open questions (for brainstorming)

0. **(NEW, Codex flag) Reuse v2's `pending_questions` / `pending_approvals` instead of building our own approval UI?** Codex confirmed v2 has `pending_questions`, `pending_approvals`, and `messages_out.in_reply_to`, but no generic A2A request/reply correlation primitive. The `create_agent` tool even accepts a `requestId` parameter that's explicitly unused. Could we layer the cross-board approval on top of `ask_user_question` (parent agent asks the manager via the existing question primitive) and skip the `/aprovar abc123` text protocol entirely? Tradeoff: gains v2-native UI; loses control over the prompt and forward-ID coupling.

1. **Approval UX.** Reply commands (`/aprovar abc123` / `/recusar abc123`) require parent admin to type IDs. Alternatives: enumerate pending requests numerically (`1`, `2`, ...), use `ask_user_question` (per Q0 above), or use WhatsApp button-style affordances if Baileys exposes them. Tradeoff: typing ID-strings is unambiguous but tedious.
2. **Async vs synchronous from child user's POV.** Caio asks; how long until he sees an answer? If parent admin is offline for hours, do we send a "request pending approval" interim reply? Today (send_message flow) Caio gets nothing — silent.
3. **Auto-approval threshold.** For trusted child boards (e.g. parent's own delegate), should the parent agent auto-approve without human in loop? Governed by `cross_board_subtask_mode='open'` already, but a2a opens new auto-approval paths.
4. **Multi-hop.** If grandchild → child → parent, does the child agent forward up the chain? Phase 1 spec is one-level only. v2 a2a primitive supports arbitrary depth; we just don't.
5. **Identity disclosure.** Today's send_message flow names the asker by display name. a2a payload could carry user_id (more precise, less human-readable). Likely keep both: asker_user_id + asker_display_name in payload (encoded into `text` for visibility plus auxiliary fields per Codex constraint).
6. **Reply attribution.** When child agent confirms back to Caio, does it credit the parent admin who approved? Today the child agent has no way to know — a2a reply can include `approved_by_user_id` if we want this.
7. **Failure modes.** What if parent agent group is down / hasn't woken in N hours / declines without reply? Need timeout + fallback (e.g. fall back to send_message forward after 1h).
8. **Rollback path.** If parent approves but later wants to revoke, does `cross_board_forward_reply` support an `unapprove` action? Or just a new forward in reverse (`taskflow_forward_to_child` to remove the subtask)?
9. **Auditor heuristic deprecation.** Keep both detection paths (text-pattern `encaminhad` + a2a route) during transition, or hard-cut to a2a once all 31 boards support it?

## Phase fit (revised v2.2)

- **Pre-v2 (now):** Phase 1 send_message forward is shipped (2026-04-30). Baseline; no immediate replacement.
- **v2 migration Phase 2.5 (Weeks 5-6):** `agent_destinations` rows seeded for cross-board flow as part of TaskFlow Permissions Adoption (delta #14 — Codex finding that destinations are the outbound ACL for ALL sends, not a2a-specific). This task is in the migration plan, not deferred.
- **v2 migration Phase 6 cleanup (Weeks 16-18):** **MVP** lands per Codex downscoping. Minimum viable scope:
  1. Source agent calls `taskflow_forward_to_parent_agent` MCP tool (in our taskflow-mcp-server.ts)
  2. Tool routes a2a message via existing `routeAgentMessage()` in `src/modules/agent-to-agent/agent-route.ts`
  3. Payload encoded **into `content.text` only** (`[TF-FORWARD request_id=<ulid>] Caio (UX) → P11: revisar mockup`)
  4. Parent agent recognizes the `[TF-FORWARD ...]` text pattern via CLAUDE.md fragment, reads request from existing `subtask_requests` table by `request_id`
  5. Approval/decline handled by **existing** `taskflow_admin({ action: 'handle_subtask_approval' })` (Phase 2 already shipped this)
  6. Reply via a2a back to child, again with text payload only
  - **Skipped initially:** the `taskflow_get_forward` read MCP tool, structured `x_taskflow_*` auxiliary fields, formatter changes
- **Post-Phase-6 (deferred):** Generalize to `move`, `reassign`, `update` cross-board mutations. Same pattern, different intents. Add `taskflow_get_forward` read tool only if visible-text MVP turns out insufficient.

## Risks

- **Formatter visibility.** (Codex finding.) Parent agent will only see what we encode into `content.text`. Auxiliary `x_taskflow_*` fields require a fork-private MCP read tool (`taskflow_get_forward`) to be visible. If we forget the read tool, the parent agent flies blind on subtask details. Test path: write an a2a message with auxiliary fields, run a parent-side prompt, assert it can recover the payload.
- **Two-flow coexistence.** During v2 migration cutover window, some boards on v1 (send_message), some on v2 (a2a). Need a feature flag at the source agent that picks the right path based on target board's runtime version.
- **Inbound flood.** A parent board for many children could see a queue of pending forwards. Need rate limiting + dedup (don't accept duplicate pending forwards for the same `task_id` + `subtask_title`).
- **Permission leak.** `agent_destinations` declared too broadly (e.g. every board sees every other board) leaks information. Provision strictly: child sees only its parent.
- **Audit trail.** `cross_board_forwards` table is the source of truth; if a2a delivery fails silently, the row stays `pending` forever. Add a sweeper that expires `pending > 7d` to `expired`.
- **Backward-incompatible auditor.** Auditor changes must be timed with rollout — if auditor recognizes a2a but no boards are sending a2a yet, no impact. If boards send a2a but auditor doesn't recognize it, false `unfulfilledWrite` findings.

## Out-of-scope (deferred)

- Generalizing cross-board mutations beyond `add_subtask` in this Phase 1 spec.
- Replacing the engine's `cross_board_subtask_mode='approval'` flow with a2a. The engine flag is governance; a2a is transport. They compose: `approval` mode + a2a transport = clean structured approval flow. Keep both.
- Cross-fleet a2a (between two separate NanoClaw instances). v2's a2a is single-fleet only. Multi-fleet is a much larger design.

---

**Next steps:** Brainstorm with user to resolve open questions 1-9, then write the implementation plan via writing-plans skill once v2 migration is past Phase 5.
