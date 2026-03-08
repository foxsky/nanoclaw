# TaskFlow Skill Package Changelog

## 2026-03-08

### Meeting Notes Feature

- **Meeting type** with `M`-prefix IDs via `board_id_counters`
- **Schema**: `participants TEXT` and `scheduled_at TEXT` columns on tasks
- **Phase-tagged notes**: auto-tagged from column state (`pre`/`meeting`/`post`), with `parent_note_id`, `status` (`open`/`checked`/`task_created`/`inbox_created`/`dismissed`), `processed_at`, `processed_by`, `created_task_id`
- **8 meeting query types**: `meetings`, `meeting_agenda`, `meeting_minutes`, `upcoming_meetings`, `meeting_participants`, `meeting_open_items`, `meeting_history`, `meeting_minutes_at`
- **Minutes triage**: `process_minutes` lists open items, `process_minutes_decision` atomically creates follow-up task/inbox and marks note
- **WIP exclusion**: meetings do not count against WIP limits
- **Open-minutes warning**: soft warning when concluding meeting with unprocessed notes
- **Cancel notifications**: participants notified on meeting cancellation
- **Recurring meeting advance**: archives occurrence to `task_history` (not `archive` table), advances `scheduled_at`, preserves participants
- **Board view**: calendar prefix, `scheduled_at` time, participant count display
- **Report integration**: `upcoming_meetings` and `meetings_with_open_minutes` in standup/digest/weekly
- **Scheduled notifications**: day-based reminders via `scheduled_at`, minutes-processed notifications propagated
- **MCP schema**: meeting type in `taskflow_create`, 8 queries in `taskflow_query`, meeting fields in `taskflow_update`, `process_minutes`/`process_minutes_decision` in `taskflow_admin`
- **CLAUDE.md template**: meeting commands, notes, scheduling, participants, movement, triage, queries, display, schema reference
- **Participant permissions**: meeting participants can add/triage notes without being assignee or manager
