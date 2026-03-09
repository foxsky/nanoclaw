# Meeting Notes Feature — Design

**Date:** 2026-03-08
**Status:** Approved

## Overview

Add meeting management to TaskFlow with:

- scheduled meetings with date and time
- pre-meeting agenda / talking points
- live and post-meeting notes
- discussion-item checkoffs after the meeting
- outcome extraction into either assigned tasks or inbox entries

Meetings are a new task type (`meeting`, `M` prefix) that reuse the existing board columns with meeting-specific semantics.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Task type | New `meeting` type, `M` prefix | Distinct lifecycle, clean separation from tasks |
| Board columns | Reuse existing columns | Meetings remain visible in board/standup/digest/review |
| Schedule field | New `scheduled_at` datetime field | The feature goal requires date + time; date-only `due_date` is not enough |
| Notes structure | Extend existing notes with meeting-only metadata | No new table needed for notes; backward-compatible JSON shape |
| Note phases | `pre` / `meeting` / `post` | Agenda before, live notes during, reflections after |
| Phase tagging | Auto from column state | Column is the source of truth; no manual phase selection |
| Discussion item state | Persist per note | Needed for checkoffs, triage dedupe, and warnings |
| Outcome conversion | Task or inbox entry | Not every outcome should force immediate assignment |
| Recurrence | Both one-off and recurring | Standing meetings are common |
| Recurrence anchor | Explicit first occurrence datetime | Recurring meetings need an unambiguous starting instance |
| Participants | `participants` JSON column + assignee as organizer | Meetings are multi-person; organizer remains a single owner |
| Organizer assignment | Auto-set organizer to sender | Meetings should never fall into Inbox because no assignee was supplied |
| Participant management | Mutable after creation | Add/remove participants anytime |
| WIP limits | Meetings do not count | Scheduled meetings are not active execution work |
| Date required | No | A meeting can be drafted before it is scheduled |
| Conclude without minutes | Soft warn, do not block | Preserve momentum while still surfacing missing follow-up |
| `parent_note_id` linking | Lenient — any existing note ID | Allows note threading, not only agenda-item replies |
| Waiting column | Supported | Represents interrupted / blocked meeting execution |
| Inbox column | Not used | Meetings always have an organizer and start in `next_action` |
| Threading display | One level deep | Display remains readable in WhatsApp |
| Unprocessed definition | Open `pre` / `meeting` / `post` notes exist | Warning should clear after agenda checkoff, dismissal, or conversion |
| Note authorization | Participants can add; only author/organizer/manager can edit/remove | Meeting-specific exception to normal assignee-only note rules |
| Notifications | Explicit participant fanout | Current assignee-centric notifications are not enough |
| Historical retrieval | Explicit past-instance queries | Users must be able to revisit a specific past meeting later |
| `conclude` action | Alias for `done` with meeting soft-warn | `done` on meetings behaves identically; `conclude` is syntactic sugar |
| `review` action | Reuse existing `review` move or add if missing | Meetings need explicit post-meeting column transition |
| Cancellation | Reuse existing `cancel` flow + participant notification | No meeting-specific cancellation logic needed |

## Schema Changes

### New columns on `tasks` table

```sql
ALTER TABLE tasks ADD COLUMN participants TEXT; -- JSON array of person_ids
ALTER TABLE tasks ADD COLUMN scheduled_at TEXT; -- ISO-8601 UTC datetime, NULL = unscheduled
```

For meeting tasks, `scheduled_at` is the canonical schedule field used by board display, reminders, upcoming-meeting queries, and meeting-start logic.

For meeting tasks:

- `scheduled_at` is the event datetime
- `due_date` is unused by default and should remain `NULL` unless a future feature explicitly introduces a separate deadline such as "finalize minutes by"
- weekend and holiday meetings are allowed; the non-business-day due-date guard applies to `due_date`, not to `scheduled_at`
- reminders and "meeting starting" notifications key off `scheduled_at`, not `due_date`

### Archive snapshot contract

Historical retrieval relies on the existing `archive.task_snapshot` JSON, not a new archive table.

For meeting tasks, `task_snapshot` must preserve at least:

- core task fields: `id`, `type`, `title`, `assignee`, `column`
- meeting fields: `scheduled_at`, `participants`
- recurrence fields when applicable: `recurrence`, `recurrence_anchor`, `current_cycle`, `max_cycles`, `recurrence_end_date`
- the full notes array including `phase`, `parent_note_id`, `status`, `processed_at`, `processed_by`, and `created_task_id`
- occurrence metadata for recurring meetings: cycle number plus the scheduled datetime of the archived occurrence

No separate `meeting_archive` structure is needed if `task_snapshot` preserves the full meeting state above.

### Extended notes structure

Existing notes array entries gain meeting-only metadata:

```typescript
interface Note {
  id: number;
  text: string;
  at: string;          // ISO-8601 timestamp
  by: string;          // person_id
  phase?: 'pre' | 'meeting' | 'post';
  parent_note_id?: number;
  status?: 'open' | 'checked' | 'task_created' | 'inbox_created' | 'dismissed';
  processed_at?: string;     // ISO-8601 timestamp when status left 'open'
  processed_by?: string;     // person_id
  created_task_id?: string;  // task or inbox capture created from this note
}
```

Regular task notes remain unchanged. Only meeting tasks use the extra fields.

### ID counter

`board_id_counters` handles `M` automatically once `meeting` maps to prefix `M`.

## Lifecycle

| Column | Meeting Semantics | Auto-tagged phase |
|--------|-------------------|-------------------|
| Inbox | Not used | — |
| Next Action | Scheduled / accepting agenda | `pre` |
| In Progress | Meeting in progress | `meeting` |
| Waiting | Meeting interrupted / blocked | `meeting` |
| Review | Post-meeting follow-up | `post` |
| Done | Finalized | `post` |

Phase is determined automatically by the meeting's current column. Users can keep using `pauta` / `ata`; the engine derives `phase` from the current column.

Meetings are created directly in `next_action` with organizer = sender, even if the tool call does not explicitly pass an assignee.

## Notes Model

### Pre-notes (agenda) — `next_action`

```text
#1: Revisar orçamento Q2
#2: Definir prazos do projeto X
```

### In-meeting notes — `in_progress`

```text
#3 (on #1): Aprovado com redução de 10%
#4 (on #1): Giovanni vai revisar contratos
#5 (standalone): Problema no servidor detectado
```

### Post-notes — `review` / `done`

```text
#6 (on #5): Thiago confirmou que vai investigar amanhã
#7 (standalone): Preciso revisar contrato com fornecedor
```

### Discussion item state

All meeting notes, including agenda (`pre`) notes, begin with `status = 'open'`.

They may later transition to:

- `checked` — discussed / resolved, no follow-up task needed
- `task_created` — converted into a new task
- `inbox_created` — converted into a new inbox capture
- `dismissed` — intentionally ignored / noise

Only notes with `status = 'open'` appear in `processar ata`, `itens abertos`, and missing-minutes warnings.

For agenda notes specifically:

- `checked` means the talking point was covered and needs no further action
- `task_created` / `inbox_created` means the talking point produced follow-up work
- `dismissed` means the topic was intentionally skipped or is no longer relevant

### Structured output (`ata M1`)

Threading is one level deep for display. A note can point to another note, but display flattens grandchildren under the same visible group.

```text
📅 *M1 — Alinhamento semanal* (12/03/2026 14:00)

*Pauta:*
1. ✓ Revisar orçamento Q2
   → ✓ Aprovado com redução de 10%
   → ⤷ T15 Giovanni vai revisar contratos
2. — Definir prazos do projeto X
   → — Adiado para março

*[Novo] Problema no servidor*
   → 📥 T16 Thiago vai investigar amanhã
   → ✓ Thiago confirmou que vai investigar amanhã _(pós-reunião)_

*[Pós-reunião]*
   → ⤷ T17 Preciso revisar contrato com fornecedor
```

Status markers:

- `✓` = `checked`
- `⤷ T15` = `task_created` (distinct from threading `→`)
- `📥 T16` = `inbox_created`
- `—` = `dismissed`
- no marker = still `open`

## Commands

### Creation (manager)

| User says | Tool call |
|-----------|-----------|
| "reunião: X em DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', sender_name: SENDER })` |
| "reunião: X" | `taskflow_create({ type: 'meeting', title: 'X', sender_name: SENDER })` |
| "reunião com Y, Z: X em DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', participants: ['Y', 'Z'], sender_name: SENDER })` |
| "reunião semanal: X começando DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', recurrence: 'weekly', sender_name: SENDER })` |
| "reunião semanal com Y, Z: X começando DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', recurrence: 'weekly', participants: ['Y', 'Z'], sender_name: SENDER })` |

`scheduled_at` is parsed in the board timezone from the user's date/time expression, then stored in UTC.

Recurring meetings require an explicit first occurrence datetime via `scheduled_at`. At creation time:

- if `recurrence_anchor` is omitted, the engine sets `recurrence_anchor = scheduled_at`
- callers may still pass an explicit `recurrence_anchor` only if a future recurrence rule needs a distinct anchor semantics

That first occurrence datetime is stored as:

- `scheduled_at` for the first cycle
- `recurrence_anchor` for future cycle generation

### Notes (agenda, minutes, post-meeting)

Phase is auto-tagged from column state. The same commands work in every phase.

| User says | Tool call |
|-----------|-----------|
| "pauta M1: texto" | `taskflow_update({ task_id: 'M1', updates: { add_note: 'texto' }, sender_name: SENDER })` |
| "ata M1 #N: texto" | `taskflow_update({ task_id: 'M1', updates: { add_note: 'texto', parent_note_id: N }, sender_name: SENDER })` |
| "ata M1: texto" | `taskflow_update({ task_id: 'M1', updates: { add_note: 'texto' }, sender_name: SENDER })` |
| "editar nota M1 #N: texto" | `taskflow_update({ task_id: 'M1', updates: { edit_note: { id: N, text: 'texto' } }, sender_name: SENDER })` |
| "remover nota M1 #N" | `taskflow_update({ task_id: 'M1', updates: { remove_note: N }, sender_name: SENDER })` |
| "marcar item M1 #N como resolvido" | `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'checked' } }, sender_name: SENDER })` |
| "reabrir item M1 #N" | `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'open' } }, sender_name: SENDER })` |
| "descartar item M1 #N" | `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'dismissed' } }, sender_name: SENDER })` |

### Scheduling

| User says | Tool call |
|-----------|-----------|
| "reagendar M1 para DD/MM às HH:MM" | `taskflow_update({ task_id: 'M1', updates: { scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ' }, sender_name: SENDER })` |

### Participants

| User says | Tool call |
|-----------|-----------|
| "adicionar participante M1: Y" | `taskflow_update({ task_id: 'M1', updates: { add_participant: 'Y' }, sender_name: SENDER })` |
| "remover participante M1: Y" | `taskflow_update({ task_id: 'M1', updates: { remove_participant: 'Y' }, sender_name: SENDER })` |
| "participantes M1" | `taskflow_query({ query: 'meeting_participants', task_id: 'M1' })` |

### Movement

| User says | Tool call |
|-----------|-----------|
| "iniciando M1" | `taskflow_move({ task_id: 'M1', action: 'start', sender_name: SENDER })` |
| "M1 aguardando Y" | `taskflow_move({ task_id: 'M1', action: 'wait', reason: 'Y', sender_name: SENDER })` |
| "M1 retomada" | `taskflow_move({ task_id: 'M1', action: 'resume', sender_name: SENDER })` |
| "M1 pronta para revisao" | `taskflow_move({ task_id: 'M1', action: 'review', sender_name: SENDER })` |
| "M1 concluida" | `taskflow_move({ task_id: 'M1', action: 'done', sender_name: SENDER })` — soft warn if open pre/meeting/post notes remain |
| "cancelar M1" | `taskflow_move({ task_id: 'M1', action: 'cancel', sender_name: SENDER })` — notifies all participants |

`conclude` in natural language maps to the existing `done` action. For meeting tasks, `done` adds the open-minutes soft warning. No new action type is needed.

`review` moves to the Review column. If this action does not yet exist in the engine, add it as a general-purpose action (all task types, not meeting-only).

Cancelling a meeting reuses the existing `cancel` flow. Notes are preserved in the archive snapshot. All participants are notified.

### Triage (action-item extraction)

| User says | Tool call |
|-----------|-----------|
| "processar ata M1" | `taskflow_admin({ action: 'process_minutes', task_id: 'M1', sender_name: SENDER })` |

`process_minutes` returns only notes whose `status` is still `open`, grouped by agenda item / standalone thread.

This includes:

- open agenda items not yet marked covered
- open in-meeting notes
- open post-meeting notes

For each open item, the user may choose one of:

- Create assigned task:
  - preferred: `taskflow_admin({ action: 'process_minutes_decision', task_id: 'M1', note_id: N, decision: 'create_task', create: { type: 'simple', title: '...', assignee: '...', labels: ['ata:M1'] }, sender_name: SENDER })`
  - engine performs create + note status update in one transaction and returns the created task ID
- Create inbox entry:
  - preferred: `taskflow_admin({ action: 'process_minutes_decision', task_id: 'M1', note_id: N, decision: 'create_inbox', create: { type: 'inbox', title: '...', labels: ['ata:M1'] }, sender_name: SENDER })`
  - engine performs create + note status update in one transaction and returns the created task ID
- Mark checked / no follow-up needed:
  - `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'checked' } }, sender_name: SENDER })`
- Dismiss:
  - `taskflow_update({ task_id: 'M1', updates: { set_note_status: { id: N, status: 'dismissed' } }, sender_name: SENDER })`

Atomicity requirement:

- outcome conversion must be transactional: the created task/inbox entry and the note-status update succeed or fail together
- the engine should not rely on the agent to stitch two separate tool calls together for the normal conversion path
- a manual two-step fallback is acceptable only as an explicit recovery procedure, not the default design

### Queries

| User says | Tool call |
|-----------|-----------|
| "reunioes" | `taskflow_query({ query: 'meetings' })` |
| "pauta M1" | `taskflow_query({ query: 'meeting_agenda', task_id: 'M1' })` |
| "ata M1" | `taskflow_query({ query: 'meeting_minutes', task_id: 'M1' })` |
| "proximas reunioes" | `taskflow_query({ query: 'upcoming_meetings' })` |
| "itens abertos M1" | `taskflow_query({ query: 'meeting_open_items', task_id: 'M1' })` |
| "historico reuniao M1" | `taskflow_query({ query: 'meeting_history', task_id: 'M1' })` |
| "ata M1 de DD/MM/YYYY" | `taskflow_query({ query: 'meeting_minutes_at', task_id: 'M1', at: 'YYYY-MM-DD' })` |

**Disambiguation:** `"pauta M1"` (no colon) = query agenda. `"pauta M1: texto"` (colon + text) = add note.

## Display

### Board view

```text
📅 M1 (12/03 14:00): Alinhamento semanal — 3 participantes
```

### Standup

```text
• 📅 M1 amanhã 14:00 — Alinhamento semanal (pauta: 3 itens)
```

### Warnings

```text
⚠️ M1 ocorreu em 12/03 14:00 com itens de ata ainda abertos
```

Show this in standup, digest, and weekly review for meetings past `scheduled_at` with open `pre` / `meeting` / `post` notes.

## Recurrence

- On cycle advance for recurring meetings:
  - archive all notes, including meeting metadata and note status, into `task_history`
  - reset the notes array for the next cycle
  - preserve participants
  - advance `scheduled_at` to the next occurrence at the same local time
- Both one-off and recurring meetings are supported

## Historical Access

Past meetings must remain queryable, not only archived internally.

For one-off meetings:

- `ata M1` returns the current/final meeting record
- `historico reuniao M1` returns lifecycle plus note snapshots

For recurring meetings:

- each completed cycle must be queryable as a historical meeting instance
- archived snapshots must preserve cycle number plus scheduled occurrence datetime
- users must be able to fetch:
  - the latest cycle via `ata M5`
  - a specific past occurrence via `ata M5 de 12/03/2026`
  - a summary list via `historico reuniao M5`

Historical query output should include:

- meeting title
- scheduled occurrence datetime
- participants at that time
- agenda / meeting / post notes
- note statuses / created follow-up task IDs
- final outcome summary

## Participants

- `participants`: JSON array of person_ids, e.g. `["giovanni", "thiago"]`
- mutable after creation
- organizer = `assignee`
- organizer defaults to sender on create
- participants are attendees who may add notes
- organizer + managers can create/manage/edit/remove notes
- participants can add notes, but can edit/remove only their own notes
- meetings do not count against WIP limits

## Notifications

| Event | Who |
|-------|-----|
| Meeting created | All participants |
| Meeting reminder (days before `scheduled_at`) | All participants |
| Meeting starting | All participants |
| Meeting cancelled | All participants |
| Minutes processed / action items created | Participants with assigned action items |

Participant notifications require explicit fanout over `participants`; current assignee-only notifications are not sufficient.

Reminder granularity, scope for v1:

- reuse the existing day-based reminder infrastructure for "N days before `scheduled_at`"
- "meeting starting" is a separate exact-time notification keyed to `scheduled_at`
- sub-day relative reminders such as "2 hours before" or "15 minutes before" are out of scope unless the reminder infrastructure is extended beyond `reminder_days`

## Engine Changes Summary

1. **`create()`**: accept `type: 'meeting'`, generate `M` prefix, store `participants`, persist `scheduled_at`, resolve participant names, auto-set organizer/assignee to the sender so meetings start in `next_action`, and default `recurrence_anchor = scheduled_at` for recurring meetings when omitted
2. **`update()`**: auto-tag `phase` from column state on `add_note`; handle `parent_note_id`, `scheduled_at`, `add_participant`, `remove_participant`, and `set_note_status`
3. **`query()`**: add `meetings`, `meeting_agenda`, `meeting_minutes`, `upcoming_meetings`, `meeting_participants`, `meeting_open_items`, `meeting_history`, and `meeting_minutes_at`
4. **`admin()`**: add `process_minutes`, returning only open notes grouped for triage, plus `process_minutes_decision` for atomic create-task/create-inbox conversions
5. **`move()`**: on `done` for meeting tasks, return `unprocessed_minutes_warning: true` when open `pre` / `meeting` / `post` notes remain; add `review` action (→ Review column) if not already present; on `cancel` for meeting tasks, notify all participants
6. **`advanceRecurringTask()`**: archive meeting-note metadata plus cycle/occurrence timestamp before resetting the next cycle, using `recurrence_anchor` + recurrence rules to compute the next `scheduled_at`
7. **`formatBoardView()`**: show `📅`, `scheduled_at`, and participant count for meeting tasks
8. **WIP checks**: exclude meeting tasks from WIP counts
9. **Reports**: include meeting-specific entries and open-minutes warnings keyed from `scheduled_at`
10. **Notifications**: add participant fanout helpers for create/reminder/start/outcome events

## MCP Schema Changes

The IPC/MCP surface must be updated alongside engine work.

- **`taskflow_create`**
  - add `meeting` to `type`
  - add `scheduled_at`
  - keep `recurrence_anchor` optional; default it to `scheduled_at` for recurring meetings when omitted
  - add `participants`
- **`taskflow_update`**
  - add `scheduled_at`
  - allow `parent_note_id` when adding a note
  - add `add_participant`
  - add `remove_participant`
  - add `set_note_status`
- **`taskflow_query`**
  - add `meetings`
  - add `meeting_agenda`
  - add `meeting_minutes`
  - add `upcoming_meetings`
  - add `meeting_participants`
  - add `meeting_open_items`
  - add `meeting_history`
  - add `meeting_minutes_at`
  - add `at` parameter for occurrence-date lookup on `meeting_minutes_at`
- **`taskflow_admin`**
  - add `process_minutes`
  - add `process_minutes_decision`

## CLAUDE.md Template Changes

- add meeting commands to Command -> Tool Mapping
- add meeting display rules to Board View Format
- add meeting triage rules mirroring Inbox Processing
- add phase auto-tagging rules
- add note-status / checkoff rules
- add soft-warn rule for concluding with open minutes
- update Schema Reference with `participants`, `scheduled_at`, and meeting-note metadata
- add disambiguation rule: `"pauta M1"` = query, `"pauta M1: texto"` = add note
