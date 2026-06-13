# RC5-ext inbound — external-participant DM routing: design (Phase 1)

**Date:** 2026-06-13 · **Branch:** skill/taskflow-v2 · **Status:** DESIGN v3 (Codex round-2 hardened; pre-build) · **Author:** engine session

Completes the RC5-ext loop. **Outbound is shipped** (`2d49e750`): a TaskFlow notification to a never-contacted external is delivered via a host-side `onWhatsApp()` round-trip + cold-DM `messaging_group` provisioning. **This doc designs the INBOUND half**: when that external *replies*, route their DM into the board's agent session with an **authenticated, narrowly-scoped** identity, so the board agent sees/attributes it and can reply back — without ever letting an external act as a board member.

> **Codex round 1: GATE not-ready → v2 closed all 5 BLOCKERs + 5 IMPORTANTs.** The decisive correction: the trusted channel carries **only an authenticated `externalId`** (never grants-as-auth); board-person and external actors are **mutually exclusive** per turn; the **engine re-checks DB grants at mutation time, per-meeting** — host channel is authentication, never authorization.
> **Codex round 2: round-1 BLOCKERs confirmed closed → 2 deeper BLOCKERs (B6/B7) + 2 IMPORTANTs added below; v3 incorporates them → build-ready.** B6 is the load-bearing one: confining the *recipient* of a reply is not enough — an external turn entering the board session could prompt-inject the agent into **reading board-private state and replying it back** to the (legitimately-allowed) external. External turns need an **external-safe capability mode** (default-deny reads/tools/context except grant-scoped flows), not just mutation + reply gating.

## TL;DR — every consumer already exists; this wires them, safely

- **Engine auth envelope is built.** `addNoteCore` (`taskflow-engine.ts:5905-5975`) already lets an external with a grant add notes to *their meeting task* (`:5926-5931`), attributed `author_actor_type='external_contact'` (`:5949-5954`). Person-gated ops fail-closed (an external is not a board person). Chat call sites currently hardcode `isExternalSender:false, hasExternalGrant:false, senderExternalId:undefined` (`:3158, :3238, :3285`).
- **Resolver built + tested** (`src/dm-routing.ts`, `dm-routing.test.ts`): DM JID → `{externalId, displayName, groupJid, grants[], needsDisambiguation}`, BR-9th-digit fallback, `direct_chat_jid` backfill, lazy grant expiry.
- **Trusted-actor pattern built** (SEC#13 `turn-actor.ts`, `session_state.turn_actor`, poison/resolve) — the template for a parallel **external-actor** channel.
- **Reply model built**: `agent_destinations` type `'channel'` → a `messaging_group`; the external's cold-DM mg is a `messaging_group` ⇒ a board→external reply is a `'channel'` destination — no new type.

## Architecture (the loop)

```
External DMs the bot (WhatsApp 1:1)
   │
   ▼  src/router.ts routeInbound — DM, no wired agent
[HOST] unrouted-DM resolver (NEW) — runs BEFORE the !isMention early-return (IMPORTANT-1)
   │  → resolveExternalDm(taskflowDb, jid)  ── null → fall through to existing drop/gate
   │  → ALL active grants on ONE board → route there (conversational disambig ok)
   │  → grants span MULTIPLE boards (needsDisambiguation) → HOST-PARKED prompt, do NOT route (BLOCKER-3)
   │  → ensure reply dest: createDestinationIfAbsent(board_ag,'external-<id>','channel',coldDmMgId)
   │       — FAIL CLOSED if the name exists pointing at a DIFFERENT mg (IMPORTANT-4)
   │  → writeSessionMessage(board session) trigger:1, content = {
   │        text,
   │        externalActor: { externalId, displayName, sourceDmMgId },   // AUTH = externalId only (NICE-3)
   │        actorKind: 'external',                                       // marks the row external-only
   │        from: 'external-<id>'                                        // routing/reply (IMPORTANT-2/3)
   │     }   // NOTE: no content.sender — must not bind turn_actor as a board person (BLOCKER-1)
   │  → return true (consume)
   ▼
[CONTAINER] poll-loop:
   │  external row ⇒ turn_actor POISONED (BLOCKER-1); turn_external_actor pinned from content.externalActor
   │  deterministic mutation fast-paths DENY external-actor turns (BLOCKER-2) except the narrow
   │    {accept_invite, add meeting note} whitelist, which route through the actor-aware path
   ▼  chat surface: set sender_external_id from turn_external_actor ONLY (model arg stays stripped :225)
   │  force senderPersonId=null, isMgr=false, isAssignee=false for external turns (BLOCKER-1)
   ▼  engine: re-query meeting_external_participants for (board_id, meeting_task_id[, occurrence]) +
   │    status/expiry at mutation time → hasExternalGrant (BLOCKER-4); channel grants are NOT trusted
   ▼  agent replies: send_message(to='external-<id>') — broadcast gate allows ONLY the current resolved
        turn_external_actor.externalId → its exact cold-DM mg; every other external dest stays denied (BLOCKER-5)
```

## Components (hardened)

### C1 — Host: unrouted-DM resolver hook (router)
- **Where:** `src/router.ts`, BEFORE the `!isMention` early-returns (IMPORTANT-1 — WhatsApp DMs don't reliably set `isMention`). Cleanest: at the top of the no-wired-agent handling, gate on `mg.is_group === 0`, check the resolver before any `!isMention` return / `recordDroppedMessage`.
- **Hook:** dedicated `setUnroutedDmResolver(fn)` mirroring `channelRequestGate`'s set-once guard (`:139-143`); `fn(mg, event) => Promise<boolean>` (true = consumed). NOT `messageInterceptor` (single slot owned by permissions).
- **Registered by** the taskflow host module (trunk stays taskflow-agnostic). Body: `getTaskflowDb` (the sanctioned host taskflow reader) → `resolveExternalDm` → null = return false; resolved = C2/C3/C4 then return true.

### C2 — Host: disambiguation FIRST, then re-target (BLOCKER-3)
- **All active grants on one board** → route to that board (the board agent disambiguates *which meeting* conversationally — safe, same board).
- **Grants span multiple boards** → do NOT route into any board (that leaks one board's inbound to another's agent). Host-park a disambiguation prompt and consume. Parked state (IMPORTANT, round 2): **TTL-bound**, **keyed to the exact DM mg**, validated ONLY against the external's grant-visible boards/meetings, and the disambiguation **selection itself is consumed host-side** (never forwarded into a board). A follow-up reply that resolves to one board then routes normally.
- Re-target via: `getMessagingGroupByPlatform('whatsapp', groupJid)` → `getMessagingGroupAgents` → `resolveSession(agent_group_id, boardMg.id, null, mode)` → `writeSessionMessage(...)`.

### C3 — Container: trusted external-actor channel (mirror SEC#13), mutually exclusive with board-person
- New `mcp-tools/turn-external-actor.ts`: `set/add/get/clearTurnExternalActor` over `session_state` key `turn_external_actor`, shape **`{ externalId, displayName, sourceDmMgId, poison, system }`** — **authentication carries only `externalId`** (displayName/sourceDmMgId are context/reply-scope, never auth). Resolved iff `!poison && exactly one externalId`.
- Poll-loop: a `actorKind:'external'` trigger=1 row ⇒ **poison `turn_actor`** (never bind a board person) AND pin `turn_external_actor` from `content.externalActor`. A turn mixing a board-person sender and an external row ⇒ both poisoned (BLOCKER-1; no dual identity).
- **Deterministic fast-paths (BLOCKER-2):** the poll-loop TaskFlow handlers that call the engine directly with `senderName(messages)` must **deny external-actor turns** outright, except a narrow whitelist (`accept_invite`, add-meeting-note) which is rewired through the actor-aware chat path. Default-deny: an external turn that hits any other deterministic mutation handler is refused.
- Chat surface (`taskflow-helpers.ts:210-226`): set `sender_external_id` from `turn_external_actor` ONLY; keep stripping model-supplied `sender_external_id` (`:225`). For external turns, force `senderPersonId=null, isMgr=false, isAssignee=false` so no board-person authority is ever inferred.

### C4 — Engine: authorization is DB-authoritative, per-meeting (BLOCKER-4, D2)
- The engine must NOT trust `externalActor.grants` (stale between host route and engine mutation). At each mutation it re-queries `meeting_external_participants` for the **exact `(board_id, meeting_task_id[, occurrence_scheduled_at])`** + `invite_status`/`access_expires_at`, deriving `hasExternalGrant` per-meeting. A grant on meeting A must never authorize meeting B (per-board would; per-meeting won't).
- **Status semantics (IMPORTANT-5):** `pending`/`invited` external turns are limited to invite **accept/clarify**; meeting-note mutation requires `accepted` (matches the existing note-grant check). `resolveExternalDm` returning `pending`/`invited` only gets the external *routed*, not *authorized to mutate notes*.

### C5 — Reply path (reuse destination model, narrowly gated) (BLOCKER-5)
- Ensure `agent_destinations(board_ag,'external-<external_id>','channel', coldDmMgId)` via `createDestinationIfAbsent`, which must **fail closed if the local name already points at a different mg** (IMPORTANT-4).
- Cold-DM mg via a **shared** `ensureColdDmForExternal` (refactor out of `taskflow-notify.ts` so outbound + inbound share one provisioner / one onWhatsApp round-trip).
- **Broadcast-gate exception is current-actor-scoped (BLOCKER-5):** a board agent's `send_message(to='external-<id>')` is allowed ONLY when `id === the current resolved turn_external_actor.externalId` and the destination resolves to that external's exact cold-DM mg. Every other external destination stays broadcast-gated/denied — so a prompt-injected agent can't message a *different* external, and stale `external-*` destinations aren't an attack surface (NICE-2).

### C6 — Formatter (IMPORTANT-2/3)
- The re-targeted row carries `from:'external-<id>'` + `actorKind:'external'`. The formatter shows a **visible, non-authoritative** marker (`actor_type=external_contact`, the displayName) and makes the default reply target the external's destination — never relying on display name for identity, never rendering it as a board-group member.

### C7 — External-safe capability mode (BLOCKER-6, round 2) — the load-bearing control
The reply gate (C5) confines the *recipient*; it does NOT confine the *content*. An external turn still drives the board agent, which can read board-private state (tasks, other people's data, memory) and — since replying to *this* external is allowed — be prompt-injected into exfiltrating it. So an external turn must run the agent in a **restricted capability mode**: **default-deny reads/tools/context**, allowing ONLY the grant-scoped flows (accept/clarify invite; add/read notes on the *granted meeting* occurrence). Mechanism options to settle in P3 (this is the one open mechanism question):
- **(a) Tool-level gate** — extend the `requiresChatActor`/`chat-actor-guard` wrapper to an `externalSafeOnly` gate that denies every MCP tool not on the external whitelist when `turn_external_actor` is resolved (mirrors the existing per-tool guard; deterministic, testable). **Preferred** — same enforcement seam as SEC#12/#13.
- **(b) Per-turn system-prompt constraint** — weaker (model-trust), not sufficient alone; at most a complement to (a).
- Engine reads must ALSO scope to the granted meeting for external turns (an `api_read` of the board must not return other tasks). The read tools take the resolved actor; for an external actor they return only grant-visible rows.

### C3-lifecycle — `turn_external_actor` clear/reset (BLOCKER-7, round 2)
The reply gate (C5) and capability mode (C7) both key on "the current resolved external actor." The channel MUST be **cleared exception-safely at every turn boundary** (before pinning a new turn AND after the turn completes/errors), exactly like `clearTurnActor`. Otherwise a stale external actor from a prior turn could authorize a later `send_message(to='external-<id>')` or keep the agent in external-safe mode wrongly. **Test:** after an external turn completes, a `send_message` to that external is denied (channel cleared).

## Security / trust model (the crux, hardened)
1. **Authentication only via the trusted channel.** `externalId` reaches the engine ONLY through host-set `content.externalActor` → `turn_external_actor`. No `content.sender` for external rows (so `turn_actor` can't bind them as a board person). Model-supplied `sender_external_id` stays stripped.
2. **Mutually exclusive identities.** Board-person XOR external per turn; any mix ⇒ poison both.
3. **Authorization is engine + DB + per-meeting**, re-checked at mutation time. The channel is authentication; grants in the channel are prompt context only.
4. **Default-deny for deterministic paths.** External turns are refused by deterministic mutation handlers except the narrow accept/note whitelist routed through the actor-aware path.
5. **Reply confinement.** Only to the current external's exact cold-DM mg; all other external sends gated.
6. **Content confinement (B6).** External turns run in external-safe capability mode: default-deny reads/tools/context; reads scoped to the granted meeting. Confining the recipient is necessary but NOT sufficient — content must be confined too.
7. **Actor lifecycle (B7).** `turn_external_actor` cleared exception-safely at every turn boundary; no stale actor carries authority into a later turn.
8. **Identity = authentication, not display.** JID→externalId is authentication, so resolver ambiguity (duplicate `direct_chat_jid`, BR-variant collision) **must fail closed** (promoted from NICE → requirement). `resolveExternalDm` already fails closed on 2-contact phone matches; add the same for duplicate `direct_chat_jid`.
9. **Expiry/revocation** falls through to the normal no-agent drop (resolver returns null).

## Schema / migrations
**None new.** Reuses `session_state` (new key `turn_external_actor`), `agent_destinations` ('channel'), the cold-DM `messaging_group`, `external_contacts`/`meeting_external_participants`. Host-parked disambiguation state can live in a small host-side table or reuse an existing pending-state table (decide in P2).

## Open decisions — RESOLVED by Codex round 1
- **D1 (disambiguation):** conversational ONLY when all grants on one board; **cross-board ⇒ host-parked prompt** (BLOCKER-3). 
- **D2 (`hasExternalGrant` granularity):** **per-meeting, engine/DB-authoritative**, re-checked at mutation (+ occurrence if occurrence-level grants matter) (BLOCKER-4).
- **D3 (reply-dest lifecycle):** leaving permanent destinations is safe ONLY because the send exception is current-actor-scoped (BLOCKER-5/NICE-2); otherwise prune.

## Test plan (TDD-shaped)
- **Host:** same-board grant → routes (`externalActor`, `from`, trigger:1) + dest created; cross-board grants → NOT routed, parked prompt; unknown/expired → falls through; destination name-collision on a different mg → fail closed.
- **Container:** host-set `externalActor` → resolves `sender_external_id`; model-supplied `sender_external_id` → stripped; external row → `turn_actor` poisoned; mixed turn → both poisoned; external turn hitting a non-whitelist deterministic mutation handler → denied.
- **Engine:** accepted external + grant on meeting A adds a note (attributed `external_contact`); same external attempts a note on meeting B (no grant) → denied; expired-at-mutation grant → denied; task/board mutation by external → denied.
- **Reply:** `send_message(to='external-<id>')` for the *current* external → delivers to its cold-DM mg; for a *different* external → broadcast-gated/denied.

## Phasing (multi-session)
1. **P1 (this doc) — DONE:** design + Codex rounds 1 & 2 → build-ready (B6/B7 + IMPORTANTs incorporated). **One mechanism to settle at P3 start:** the external-safe capability gate (C7 — preferred option (a), tool-level `externalSafeOnly` wrapper).
2. **P2 host:** unrouted-DM resolver (pre-`!isMention`) + same-board route + cross-board TTL-parked disambiguation (consumed host-side) + reply-dest (collision-safe) + shared cold-DM helper extraction + `resolveExternalDm` dup-`direct_chat_jid` fail-closed. Host-testable.
3. **P3 container:** `turn-external-actor` channel (with exception-safe turn-boundary clear) + poison-`turn_actor` + deterministic default-deny + **C7 external-safe capability gate (reads/tools)** + chat-surface set + engine per-meeting DB grant re-check at the chat call sites.
4. **P4:** end-to-end + Codex round-3 security pass + formatter + broadcast-gate exception + the B7 "stale-actor send denied after turn" test.

## NICE (carry into build)
- `resolveExternalDm`: fail closed on duplicate `direct_chat_jid` (schema isn't unique on it).
- Trusted channel shape stays minimal `{externalId, displayName, sourceDmMgId}`.
