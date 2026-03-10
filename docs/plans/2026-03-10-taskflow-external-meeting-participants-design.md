# TaskFlow External Meeting Participants — Design

**Date:** 2026-03-10
**Status:** Proposed

## Overview

Add support for **external meeting participants** in TaskFlow.

An external participant is:

- not a member of `board_people`
- not part of the board's internal team model
- invited to a specific meeting
- reachable by direct WhatsApp message
- allowed to interact with that meeting until it ends

This feature extends the existing meeting model without turning external attendees into board users.

## Implementation Scope

This is a **TaskFlow skill improvement**, not a direct runtime-only change.

Implementation work should be scoped to the `add-taskflow` skill package only:

- `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- `.claude/skills/add-taskflow/tests/taskflow.test.ts`
- any new skill-bundled migration, reference, or test files under `.claude/skills/add-taskflow/`

Do not treat `container/agent-runner/src/...` as the primary implementation target for this feature in the design. The skill package is the source of the improvement, and the runtime changes should flow from applying the skill package.

## Goals

- Allow a manager or meeting organizer to add a participant who is outside the board.
- Store the external participant's name and phone so the runtime can recognize incoming direct messages.
- Send a direct-message invite when the external participant is added.
- Allow the external participant to interact with the meeting in DM using the same meeting note flows as internal participants.
- Keep access scoped to the invited meeting only.

## Non-Goals

- External participants are not board members.
- External participants do not get access to board-wide queries or task management.
- External participants do not become managers, delegates, or assignees.
- This feature does not add general customer/contact CRM functionality.
- This feature does not create a separate child board or shared board for the external participant.

## Current Constraints

Current TaskFlow meeting participants are stored as internal `person_id` values in the meeting task's `participants` JSON field and are resolved from `board_people`.

Current notification routing is also board-person based:

- recipient resolution comes from `board_people`
- notification target is `board_people.notification_group_jid`
- meeting note permissions check the sender against `board_people` identity

This means the current model cannot represent a non-board attendee cleanly.

Current skill-bundled messaging and routing are also **group-scoped**:

- outbound TaskFlow notifications target WhatsApp groups via `notification_group_jid`
- queued IPC messages currently validate `target_chat_jid` as a group JID ending in `@g.us`
- TaskFlow tools are currently registered only for TaskFlow-managed group contexts, not arbitrary DMs

This means DM invite and DM command support are not implementation details to defer. They are a hard prerequisite for this feature.

Within skill scope, the current behavior is defined primarily by:

- `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- `.claude/skills/add-taskflow/templates/CLAUDE.md.template`

## Proposed Model

Introduce two new entities:

### 1. External Contact

A reusable identity for a person outside the board.

Suggested table: `external_contacts`

Fields:

- `external_id TEXT PRIMARY KEY`
- `display_name TEXT NOT NULL`
- `phone TEXT NOT NULL`
- `direct_chat_jid TEXT`
- `status TEXT NOT NULL DEFAULT 'active'`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `last_seen_at TEXT`

Rules:

- `phone` must be normalized to a canonical digits-only format
- `phone` should be unique globally
- `direct_chat_jid` is the resolved WhatsApp DM JID when known

### 2. Meeting External Participant

A meeting-occurrence-scoped access grant for an external contact.

Suggested table: `meeting_external_participants`

Fields:

- `board_id TEXT NOT NULL`
- `meeting_task_id TEXT NOT NULL`
- `occurrence_scheduled_at TEXT NOT NULL`
- `external_id TEXT NOT NULL`
- `invite_status TEXT NOT NULL`
- `invited_at TEXT`
- `accepted_at TEXT`
- `revoked_at TEXT`
- `access_expires_at TEXT`
- `created_by TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Suggested unique key:

- `(board_id, meeting_task_id, occurrence_scheduled_at, external_id)`

Suggested `invite_status` values:

- `pending`
- `invited`
- `accepted`
- `declined`
- `revoked`
- `expired`

## Core Decision

External participants should be **meeting-occurrence-scoped identities**, not board users.

Rationale:

- avoids polluting `board_people` with non-team contacts
- avoids accidental access to task and board features
- keeps authorization simple: access is granted by a specific meeting occurrence invitation, not by team membership
- matches the real-world use case of guests, clients, vendors, and interview candidates
- prevents one invite on a recurring meeting task from leaking into future occurrences

## Permissions

### Allowed for external participants

- view the invited meeting's agenda
- view the invited meeting's minutes
- add agenda or minutes notes
- reply to an existing note
- mark note status on that meeting
- view meeting participants

### Not allowed for external participants

- board queries (`quadro`, `inbox`, `status`, `resumo`, etc.)
- team queries (`quadro do Alexandre`, `estatisticas`, etc.)
- create normal tasks directly
- reschedule a meeting
- add or remove participants
- cancel the meeting
- process inbox
- process minutes into tasks/inbox
- any admin action

### Allowed for internal organizer / manager

- add an external participant
- remove an external participant
- resend invite
- revoke access

## Invite and DM Flow

### Add external participant

User intent examples:

- `adicionar participante externo M1: Maria, telefone 5585999991234`
- `convidar cliente para M1: Maria, 5585999991234`

Flow:

1. Organizer or manager requests external participant creation.
2. Engine requires the meeting to have `scheduled_at` set before inviting an external participant.
3. Engine treats the current `scheduled_at` value as the invited occurrence key.
4. Engine normalizes the phone.
5. Engine finds or creates `external_contacts` row.
6. Engine creates or updates `meeting_external_participants`.
7. Engine emits a DM notification payload.
8. Runtime sends the invite to the external participant's direct chat.

Rules:

- v1 invites require a scheduled meeting occurrence; unscheduled draft meetings cannot invite externals yet
- for recurring meetings, the invite applies to the specific occurrence identified by `occurrence_scheduled_at`, not to every future cycle

### Invite message

Minimum message contents:

- meeting title
- meeting ID
- scheduled time
- organizer name
- short explanation that the recipient can reply in this DM to interact with the meeting
- a clear acceptance prompt

Example:

```text
📅 Convite para reunião

Você foi convidado para *M1 — Alinhamento semanal*
Quando: 2026-03-12T14:00:00Z
Organizador: Rafael

Responda nesta conversa para participar da pauta e da ata.
Para confirmar, diga: aceitar convite M1
```

### Acceptance

User intent example:

- `aceitar convite M1`

Flow:

1. DM sender is resolved by `direct_chat_jid` or normalized phone.
2. Engine finds pending/invited grant for `M1` and the matching invited occurrence.
3. Engine marks `invite_status = 'accepted'`.
4. Engine allows meeting-occurrence-scoped commands for that sender.

### DM interaction after acceptance

Allowed examples:

- `pauta M1`
- `pauta M1: preciso discutir prazo de entrega`
- `ata M1`
- `ata M1: cliente confirmou aprovação`
- `ata M1 #3: vamos enviar proposta até sexta`
- `marcar item M1 #3 como resolvido`
- `participantes M1`

### Access lifetime

Recommended v1 policy:

- active from invite acceptance until meeting completion
- plus a short grace period after conclusion, e.g. 7 days

After that, the occurrence-scoped grant moves to `expired` and DM commands are refused.

## Identity Resolution

The current sender-resolution flow only knows `board_people`.

Add a DM-specific sender resolution path:

1. If message comes from a TaskFlow group, keep the existing `board_people` resolution.
2. If message comes from a direct chat:
   - resolve by `external_contacts.direct_chat_jid`
   - fallback to normalized phone
3. Find active `meeting_external_participants` grants for that external contact.
4. Match the grant to a concrete meeting occurrence using `meeting_task_id` plus `occurrence_scheduled_at`.
5. If exactly one active occurrence matches, use that meeting context.
6. If more than one active occurrence matches and the command omits the meeting ID, ask for disambiguation.

## Notification Model

Current meeting notifications are built from internal participants only.

Extend notification recipients to include:

- internal board participants
- organizer
- external meeting participants

Notification target model should support two destination kinds:

- board/group destination via `notification_group_jid`
- direct-message destination via `direct_chat_jid`

Suggested normalized notification payload:

- `target_kind: 'group' | 'dm'`
- `target_person_id?: string`
- `target_external_id?: string`
- `target_chat_jid: string | null`
- `message: string`

This is a contract change from the current group-only notification payload shape and must be implemented before external invites can ship.

This should be used by:

- invite notifications
- reminder notifications
- meeting-start notifications
- cancellation notifications

## Query Behavior

### `meeting_participants`

Extend response to return:

- `organizer`
- `participants` for internal board participants
- `external_participants` for invited external contacts

Suggested response shape:

```json
{
  "organizer": { "person_id": "person-1", "name": "Rafael" },
  "participants": [
    { "person_id": "person-2", "name": "Alexandre", "role": "Dev" }
  ],
  "external_participants": [
    { "external_id": "ext-1", "display_name": "Maria Cliente", "invite_status": "accepted" }
  ]
}
```

Privacy rules:

- managers and organizers may receive phone details when needed for admin actions
- internal non-admin participants should not receive external participant phone numbers by default
- external participants should not receive other participants' raw phone numbers

## Mutation Behavior

### New meeting update operations

Suggested `taskflow_update` additions:

- `add_external_participant: { name: string, phone: string }`
- `remove_external_participant: { external_id?: string, phone?: string, name?: string }`
- `reinvite_external_participant: { external_id?: string, phone?: string }`

Permissions:

- organizer or manager only

### Meeting note operations

External participants should be treated like internal meeting participants for these operations only:

- `add_note`
- `edit_note` if note author
- `remove_note` if note author
- `set_note_status`

To make author-based permissions correct, meeting notes must use a stable actor identity instead of display-name-only ownership.

Required note metadata additions:

- `author_actor_type: 'board_person' | 'external_contact'`
- `author_actor_id: string`
- `author_display_name: string`

Authorization rules for `edit_note` / `remove_note` must compare the stable actor identity, not just the rendered display name.

Backward compatibility:

- legacy notes that only store display-name authorship may still render unchanged
- for legacy notes without stable actor metadata, only organizer/manager should edit or remove them unless a safe identity match is available

They must not bypass privilege checks for:

- `scheduled_at`
- `add_participant`
- `remove_participant`
- labels
- title
- recurrence
- any task field outside meeting-note interaction

## Admin / Registration Behavior

This feature should not use `register_person`, because that would incorrectly create a board user.

Instead, create a separate meeting-external registration path.

Suggested admin tool surface:

- `taskflow_admin({ action: 'register_external_contact', name, phone, sender_name })`

However, for a tight v1, explicit standalone registration can be optional if `add_external_participant` performs upsert automatically.

## DM Command Routing

Direct-message routing should be intentionally narrow.

If a sender is resolved as an external contact:

- accept only meeting commands
- require a meeting ID unless exactly one active grant exists
- reject board commands with a short explanation

Example rejection:

```text
Seu acesso está restrito às reuniões para as quais você foi convidado. Use um comando como "pauta M1" ou "ata M1".
```

## Security Model

Security boundaries:

- external access is meeting-occurrence-scoped, not board-scoped
- phone number alone is not enough after first contact; prefer resolved `direct_chat_jid`
- revoked or expired access must block further DM interaction
- if the same phone is invited to multiple meetings or occurrences, the DM flow must require meeting ID disambiguation
- note authorship checks must rely on stable actor identity, not display name alone

Auditability:

- record invite, accept, decline, revoke, and expire events in `task_history`
- include actor identity (`sender_name` for organizer, `external_id` for DM contact)

## Migration Strategy

No migration of existing meeting participants is required.

Additive changes only:

- create `external_contacts`
- create `meeting_external_participants`
- extend meeting note metadata to store stable author identity for new notes
- extend query and notification logic

Existing meetings continue to work unchanged.

Existing notes may remain in legacy format, but author-based edit/remove behavior for those notes should remain conservative until stable actor metadata exists.

## Risks

### 1. DM transport and routing support

Biggest risk: the runtime and WhatsApp integration must reliably support:

- sending direct messages to non-group contacts
- receiving those direct messages in a way the assistant can route to TaskFlow

This must be validated before implementation begins. In the current skill-bundled implementation, outbound messaging and TaskFlow tool registration are group-scoped, so this is a concrete blocker until resolved.

### 2. Identity ambiguity

The same contact may be invited to multiple meetings or multiple recurring occurrences across boards.

Mitigation:

- require explicit meeting ID in DM commands unless only one active grant exists

### 3. Over-broad permissions

If external senders are treated like board users by mistake, they could gain board-wide access.

Mitigation:

- separate identity path
- separate authorization branch
- explicit allowlist of meeting-only commands

### 4. Display-name authorship collisions

Current meeting-note permissions are vulnerable if author identity is tracked only by visible name.

Mitigation:

- store stable `author_actor_type` + `author_actor_id` on notes
- avoid granting external note-author permissions from display-name matches alone

### 5. Notification duplication

Current notification dispatch assumes group-based behavior for many TaskFlow flows.

Mitigation:

- unify notification payload shape before adding DM recipients

## Recommended v1 Scope

Keep v1 intentionally narrow:

- manager/organizer adds external participant by name + phone
- meeting must already be scheduled before an external invite is allowed
- system sends DM invite
- external participant accepts in DM
- external participant can interact only with:
  - `pauta`
  - `ata`
  - note replies
  - note status
  - `participantes`
- organizer/manager can revoke or re-invite
- no board-wide access
- no scheduling/admin actions from DM

## Implementation Phases

### Phase 0: Transport validation and routing prerequisite

- confirm the runtime can send direct messages to arbitrary contacts
- confirm inbound DMs can invoke the TaskFlow skill surface
- extend the IPC/message dispatch contract beyond group-only `@g.us` routing
- do not proceed with feature implementation until this path is proven

### Phase 1: Data model

- add `external_contacts`
- add `meeting_external_participants`
- key meeting access by `occurrence_scheduled_at`
- extend meeting notes with stable author identity metadata
- add skill-scoped migrations and tests under `.claude/skills/add-taskflow/`

### Phase 2: Meeting engine support

- extend the skill-bundled meeting engine copy
- extend participant query logic
- extend notification-recipient resolution
- add update operations for external participants

### Phase 3: DM routing

- update the skill-bundled routing/tooling surface
- resolve DM sender as external contact
- map sender to active meeting-occurrence grants
- add meeting-occurrence-scoped authorization

### Phase 4: Invite flow

- send invite DM
- accept/decline flow
- revoke/expire flow

### Phase 5: Prompt and UX

- extend TaskFlow skill prompt/template
- document DM commands
- document manager-side commands

### Phase 6: Hardening

- multi-meeting and multi-occurrence disambiguation
- recurring-occurrence invite and expiry coverage
- audit history coverage
- rate-limit and duplicate-notification handling

## Open Questions

1. Can the current runtime officially support DM send/receive for arbitrary contacts, or only groups, and how will TaskFlow tools be exposed in DM context?
2. Should organizer-created meetings allow non-managers to add external participants, or should that be manager-only?
3. Should external participants be allowed to see the full historical minutes of the invited occurrence, or only notes created after they accept?
4. Should access expire immediately on cancellation, or remain visible in read-only mode for a short period?
5. Do we want explicit RSVP states beyond `accepted` / `declined` in v1?
6. Should managers see external participant phone numbers in `meeting_participants`, or should that require a separate admin query?

## References

- `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- `docs/plans/2026-03-08-meeting-notes-design.md`
