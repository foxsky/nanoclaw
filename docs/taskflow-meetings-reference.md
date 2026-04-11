# TaskFlow Meetings Reference

Focused reference for the TaskFlow meetings feature implemented by the MCP tools and TaskFlow engine.

## Overview

Meetings are a dedicated TaskFlow task type:

- Type: `meeting`
- ID prefix: `M`
- Organizer: stored in `assignee`
- Participants: stored separately in `participants`
- Schedule field: `scheduled_at` (ISO-8601 UTC)

By default, `due_date` is not the primary field for meetings. Scheduling, reminders, upcoming-meeting queries, and start notifications all use `scheduled_at`.

## Query Resources

Meeting-specific query resources are exposed through `taskflow_query`:

| Query | Required params | Returns |
|-------|-----------------|---------|
| `meetings` | none | All non-done meeting tasks |
| `meeting_agenda` | `task_id` | Pre-meeting notes (`phase = 'pre'`) with one-level replies |
| `meeting_minutes` | `task_id` | Current meeting task, raw notes, and formatted minutes |
| `upcoming_meetings` | none | Non-done meetings with `scheduled_at >= now` |
| `meeting_participants` | `task_id` | Organizer plus resolved participant records |
| `meeting_open_items` | `task_id` | Notes whose status is still `open` |
| `meeting_history` | `task_id` | Task history rows for the meeting |
| `meeting_minutes_at` | `task_id`, `at` (`YYYY-MM-DD`) | Archived or current minutes for a specific occurrence date |

## Create Options

Meetings are created through `taskflow_create` with `type: 'meeting'`.

Meeting-relevant options:

| Field | Type | Notes |
|------|------|-------|
| `type` | `'meeting'` | Required |
| `title` | `string` | Required |
| `assignee` | `string` | Optional explicit organizer; defaults to sender when omitted |
| `scheduled_at` | `string` | Optional ISO-8601 UTC datetime |
| `participants` | `string[]` | Optional participant names |
| `priority` | `'low' \| 'normal' \| 'high' \| 'urgent'` | Optional |
| `labels` | `string[]` | Optional |
| `recurrence` | `'daily' \| 'weekly' \| 'monthly' \| 'yearly'` | Optional recurring meeting pattern |
| `recurrence_anchor` | `string` | Optional explicit anchor; auto-filled from `scheduled_at` when omitted |
| `max_cycles` | `number` | Optional bounded recurrence limit |
| `recurrence_end_date` | `string` | Optional bounded recurrence end date |
| `sender_name` | `string` | Required |

Recurring meetings require the first occurrence to be scheduled with `scheduled_at`.

## Update Options

Meetings use the normal `taskflow_update` tool plus meeting-specific fields:

| Update field | Purpose |
|-------------|---------|
| `add_note` | Add a new agenda/minutes/post-meeting note |
| `edit_note` | Edit an existing note by numeric ID |
| `remove_note` | Remove a note by numeric ID |
| `parent_note_id` | Thread a note under an existing note |
| `scheduled_at` | Reschedule the meeting |
| `add_participant` | Add one participant |
| `remove_participant` | Remove one participant |
| `set_note_status` | Change note status |

Supported meeting note statuses:

- `open`
- `checked`
- `task_created`
- `inbox_created`
- `dismissed`

## External Participants

External meeting participants — people outside the board's registered
team — can be invited to a meeting. Use `taskflow_update` with
`add_external_participant: { display_name, phone }` to register them.
The engine stores the external contact in the `external_contacts` and
`meeting_external_participants` tables, then automatically dispatches
a WhatsApp direct-message invitation to the provided phone.

After the invite, the external participant can reply in DM to add
meeting notes or confirm attendance. Their access is scoped to the
invited meeting only and expires when the meeting concludes.

To remove an external participant, use
`update(remove_external_participant: external_id)`.

Example — invite an external participant to `M1`:

```json
taskflow_update({
  "task_id": "M1",
  "sender_name": "Rafael",
  "updates": {
    "add_external_participant": {
      "display_name": "Marina Souza",
      "phone": "+5585999990000"
    }
  }
})
```

## Workflow Options

Meetings use the normal `taskflow_move` workflow actions:

- `start`
- `wait`
- `resume`
- `return`
- `review`
- `approve`
- `reject`
- `conclude`
- `reopen`
- `force_start`

Meeting-specific behavior:

- Meetings start in `next_action`
- Meetings do not count toward WIP limits
- `wait` / `resume` are supported for interrupted meetings
- `conclude` applies the normal done flow with a soft warning if open notes remain
- Recurring meetings archive the current occurrence before advancing to the next one

### Cross-board visibility

When a user on a child board is invited as a participant to a meeting owned
by the parent board, the meeting appears in their `taskflow_query` results
(via the cross-board branch in `getTask()`). They can read the meeting,
add notes, and update their own participation status, but they do not own
the meeting — only the parent-board organizer can conclude, cancel, or
reschedule it.

## Notes Model

Meeting notes reuse the normal notes array, with extra metadata:

- `phase`: `pre`, `meeting`, or `post`
- `parent_note_id`: optional threaded reply target
- `status`: one of the meeting note statuses above

Phase is derived automatically from the meeting column:

- `next_action` -> `pre`
- `in_progress` -> `meeting`
- `waiting` -> `meeting`
- `review` -> `post`

## Common Examples

Create a one-off meeting:

```json
taskflow_create({
  "type": "meeting",
  "title": "Planning sync",
  "scheduled_at": "2026-03-12T14:00:00Z",
  "participants": ["Alexandre", "Giovanni"],
  "sender_name": "Rafael"
})
```

Get the agenda for `M1`:

```json
taskflow_query({ "query": "meeting_agenda", "task_id": "M1" })
```

Add a threaded meeting note under note `3`:

```json
taskflow_update({
  "task_id": "M1",
  "sender_name": "Rafael",
  "updates": {
    "add_note": "Need a follow-up task for onboarding",
    "parent_note_id": 3
  }
})
```

Reschedule a meeting:

```json
taskflow_update({
  "task_id": "M1",
  "sender_name": "Rafael",
  "updates": {
    "scheduled_at": "2026-03-13T15:30:00Z"
  }
})
```

Retrieve minutes for a past occurrence:

```json
taskflow_query({
  "query": "meeting_minutes_at",
  "task_id": "M1",
  "at": "2026-03-10"
})
```

## Source of Truth

Implementation and schema:

- `container/agent-runner/src/ipc-mcp-stdio.ts`
- `container/agent-runner/src/taskflow-engine.ts`

Design notes and user-facing routing examples:

- `docs/plans/2026-03-08-meeting-notes-design.md`
- `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
