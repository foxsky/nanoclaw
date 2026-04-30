# Cross-board Agent-to-Agent Routing — Design Spec (Stub)

> **Status:** Stub. Open for brainstorming. Lands at v2 migration Phase 6 (cleanup) or post-cutover follow-up — see `docs/superpowers/plans/2026-04-23-nanoclaw-v2-migration.md`.
>
> **Predecessors:**
> - `docs/superpowers/specs/2026-04-09-cross-board-subtask-approval-design.md` (cross-board subtask Phase 1+2 — `cross_board_subtask_mode` engine flag)
> - `docs/superpowers/specs/2026-04-27-cross-board-mutation-forwarding-design.md` (Phase 1 send_message-based forward, deployed 2026-04-30)
>
> **Author:** Claude (initial draft, 2026-04-30). To be refined with user via brainstorming skill before plan-write.

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

V2 ships **agent-to-agent routing** (`upstream/main:src/modules/agent-to-agent/agent-route.ts`) — outbound messages with `channel_type='agent'` deliver structured payloads + attachments directly into another agent group's `inbound.db`. Permission via `agent_destinations` table. Self-messages allowed (for follow-up prompt injection).

This is the right primitive to replace the text-based forward.

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

1. **`agent_destinations` rows** declared at provision time. Each child board declares its parent agent group as a destination with type `agent`. Optionally: each child declares siblings if delegation visibility is desired.
2. **MCP tool `taskflow_forward_to_parent_agent`** in `taskflow-mcp-server.ts`:
   - Args: `{ task_id, subtask_title, asker_user_id, asker_display_name, requested_actions: [...] }`
   - Looks up parent agent group from board hierarchy
   - Validates `agent_destinations` row exists
   - Writes structured payload to parent's `inbound.db` via the a2a route helper
3. **Parent-side intent handler** — new MCP tool or system rule on parent agents that recognizes a `cross_board_forward` intent in incoming a2a messages and:
   - Surfaces the request to the parent group's chat (`Caio do quadro X pediu...`) with approval/decline buttons (or text triggers `/aprovar P11-S1`, `/recusar P11-S1`)
   - On approval: executes the mutation (`taskflow_update({ ... add_subtask })`)
   - On approval or decline: routes a `cross_board_forward_reply` a2a message back to the child agent with the outcome
4. **Child-side reply handler** — receives `cross_board_forward_reply`, replies in the child group's chat to the original asker (`✅ Aprovado e adicionado.` or `❌ Recusado: <reason>`).

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

1. **Approval UX.** Reply commands (`/aprovar abc123` / `/recusar abc123`) require parent admin to type IDs. Alternatives: enumerate pending requests numerically (`1`, `2`, ...), or use WhatsApp button-style affordances if Baileys exposes them. Tradeoff: typing ID-strings is unambiguous but tedious.
2. **Async vs synchronous from child user's POV.** Caio asks; how long until he sees an answer? If parent admin is offline for hours, do we send a "request pending approval" interim reply? Today (send_message flow) Caio gets nothing — silent.
3. **Auto-approval threshold.** For trusted child boards (e.g. parent's own delegate), should the parent agent auto-approve without human in loop? Governed by `cross_board_subtask_mode='open'` already, but a2a opens new auto-approval paths.
4. **Multi-hop.** If grandchild → child → parent, does the child agent forward up the chain? Phase 1 spec is one-level only. v2 a2a primitive supports arbitrary depth; we just don't.
5. **Identity disclosure.** Today's send_message flow names the asker by display name. a2a payload could carry user_id (more precise, less human-readable). Likely keep both: asker_user_id + asker_display_name in payload.
6. **Reply attribution.** When child agent confirms back to Caio, does it credit the parent admin who approved? Today the child agent has no way to know — a2a reply can include `approved_by_user_id` if we want this.
7. **Failure modes.** What if parent agent group is down / hasn't woken in N hours / declines without reply? Need timeout + fallback (e.g. fall back to send_message forward after 1h).
8. **Rollback path.** If parent approves but later wants to revoke, does `cross_board_forward_reply` support an `unapprove` action? Or just a new forward in reverse (`taskflow_forward_to_child` to remove the subtask)?
9. **Auditor heuristic deprecation.** Keep both detection paths (text-pattern `encaminhad` + a2a route) during transition, or hard-cut to a2a once all 31 boards support it?

## Phase fit

- **Pre-v2 (now):** Phase 1 send_message forward is shipped (2026-04-30). It works as a baseline; no immediate replacement needed.
- **v2 migration Phase 6 cleanup, OR post-cutover follow-up:** This spec lands. Both source and target boards must be on v2 to use a2a; until full fleet is on v2, fall back to send_message.
- **Phase 2 of THIS spec:** Generalize to `move`, `reassign`, `update` cross-board mutations. Same pattern, different intents.

## Risks

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
