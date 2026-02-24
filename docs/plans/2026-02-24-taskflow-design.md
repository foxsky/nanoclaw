# TaskFlow — Kanban+GTD Task Management Skill Design

**Date**: 2026-02-24
**Status**: Approved

## Summary

NanoClaw skill that transforms WhatsApp groups into a Kanban+GTD task management system for team coordination. Config-only — no source code changes. All behavior via CLAUDE.md instructions + IPC tools (`schedule_task`, `send_message`).

## Requirements

| Requirement | Decision |
|-------------|----------|
| Data storage | Separate files: `TASKS.json` (active), `ARCHIVE.json` (completed) |
| CLAUDE.md | Instructions and rules only (no task data) |
| Group layout | Flexible — manager chooses per setup: shared, individual, or both |
| Columns | 6: Inbox → Next Action → In Progress → Waiting → Review → Done |
| Runners | 3: Morning standup, evening digest, weekly review |
| Language | Configurable (default: pt-BR) |
| Timezone | Configurable (default: America/Fortaleza) |
| Source code | No `src/` changes |

## Architecture

### File Layout

```
.claude/skills/add-taskflow/
  SKILL.md                  # Skill definition (interactive setup wizard)

# Created per task group during setup:
groups/<group-name>/
  CLAUDE.md                 # Operating manual (rules, identity, Kanban/GTD instructions)
  TASKS.json                # Active tasks (source of truth)
  ARCHIVE.json              # Completed/cancelled tasks (auto-archived after 30 days)
```

### Runtime Flow

1. User sends message to task group (e.g. `@Tars anotar: verificar ar condicionado`)
2. Container agent starts, reads `CLAUDE.md` (instructions)
3. Agent reads `TASKS.json` (data) — instructed at top of CLAUDE.md
4. Agent processes command, updates `TASKS.json`, responds in chat
5. For individual notifications: `send_message` IPC to personal numbers
6. Scheduled runners trigger via `schedule_task` IPC → same flow

### Critical Constraint

The agent must explicitly read `TASKS.json` at the start of every interaction. The CLAUDE.md instructions enforce this with a top-level directive.

## Data Model (TASKS.json)

```json
{
  "meta": {
    "schema_version": "1.0",
    "language": "pt-BR",
    "timezone": "America/Fortaleza",
    "wip_limit_default": 3,
    "columns": ["inbox", "next_action", "in_progress", "waiting", "review", "done"],
    "runner_task_ids": {
      "standup": null,
      "digest": null,
      "review": null
    }
  },
  "people": [
    {
      "id": "alexandre",
      "name": "Alexandre",
      "phone": "5586999990001",
      "role": "Tecnico",
      "wip_limit": 3
    }
  ],
  "tasks": [
    {
      "id": "T-001",
      "type": "simple",
      "title": "Receber e instalar o novo filtro",
      "column": "in_progress",
      "assignee": "alexandre",
      "priority": "normal",
      "next_action": "Instalar o filtro amanha",
      "waiting_for": null,
      "due_date": "2026-02-28",
      "created_at": "2026-02-24T10:00:00Z",
      "updated_at": "2026-02-25T09:00:00Z",
      "scheduled_task_ids": [],
      "history": []
    }
  ],
  "next_id": 2
}
```

### Task Types

| Type | ID Pattern | Description |
|------|-----------|-------------|
| `simple` | `T-NNN` | Single action |
| `project` | `P-NNN` | Has `subtasks[]` array, `next_action` derived from first pending subtask |
| `recurring` | `R-NNN` | Has `recurrence{}` and `current_cycle{}` |

### Columns (6)

| Column | Emoji | Description | WIP counts? |
|--------|-------|-------------|-------------|
| `inbox` | 📥 | Captured, needs processing | No |
| `next_action` | ⏭️ | Processed, ready to execute | No |
| `in_progress` | 🔄 | Being worked on | Yes |
| `waiting` | ⏳ | Blocked by third party | No |
| `review` | 👁️ | Executor finished, manager approves | No |
| `done` | ✅ | Complete (archived after 30 days) | No |

### Archive

`ARCHIVE.json` has the same structure. Tasks move there after 30 days in `done` or when `cancelled`. The standup runner handles archival automatically.

## CLAUDE.md Template

The group CLAUDE.md is a pure operating manual:

1. **Identity** — who the agent is, who the manager is
2. **Critical: Read TASKS.json first** — top-level instruction to load data on every interaction
3. **Board rules** — 6 columns, transition rules, WIP enforcement
4. **GTD rules** — quick capture, next_action always required, waiting_for required
5. **Command parsing** — natural language command table (capture, move, conclude, etc.)
6. **Runner behavior** — standup/digest/review output formats
7. **IPC usage** — `send_message` and `schedule_task` patterns with rate limits
8. **Config** — language, timezone, WIP default, cron schedules

## Scheduled Runners

### 1. Morning Standup (per task group, weekdays)
- **Default cron**: `0 11 * * 1-5` (08:00 BRT)
- **Behavior**: Reads TASKS.json → sends board summary to group → sends individual `send_message` to each person with personal board + WIP + asks for updates
- **Also handles**: overdue detection, inbox reminder, 30-day archive cleanup

### 2. Manager Digest (main group, weekdays evening)
- **Default cron**: `0 21 * * 1-5` (18:00 BRT)
- **Behavior**: Reads TASKS.json from all registered task groups → consolidates executive summary → sends to main group
- **Sections**: overdue, next 48h, blocked/waiting, no updates, completed today

### 3. Weekly Review (main group, Fridays)
- **Default cron**: `0 14 * * 5` (11:00 BRT)
- **Behavior**: Full GTD review — weekly metrics, aging tasks, bottlenecks, inbox cleanup, waiting follow-ups
- **Format**: Executive summary with suggested actions + individual summaries via `send_message`

All runner prompts are self-contained (include full instructions so the agent knows what to do when triggered by the scheduler).

## Interactive Setup Flow (SKILL.md)

### Phase 1 — Configuration
1. Ask manager name
2. Ask language (default: pt-BR)
3. Ask timezone (default: America/Fortaleza)
4. Ask group layout: shared, individual, or both
5. Ask WIP limit default (default: 3)
6. Ask runner schedule preferences (or accept defaults)

### Phase 2 — Group Creation
For each group:
1. Ask group name (or use existing WhatsApp group)
2. Generate CLAUDE.md from template with config values
3. Create empty TASKS.json with meta + empty tasks/people arrays
4. Create empty ARCHIVE.json
5. Register group via `register_group` IPC (if not already registered)

### Phase 3 — People Registration
1. Ask for team members: name, phone, role
2. Add to TASKS.json → `people[]` array
3. Optionally set per-person WIP limits

### Phase 4 — Runner Setup
1. Create standup scheduled task (per task group) via main group IPC
2. Create digest scheduled task (on main group)
3. Create weekly review scheduled task (on main group)
4. Store scheduled_task_ids in TASKS.json `meta.runner_task_ids`

### Phase 5 — Verification
1. Send test message to the task group
2. Confirm the agent can read TASKS.json
3. Show summary of what was created

## Natural Language Commands

| Intent | Examples |
|--------|----------|
| Quick capture | "anotar: X", "lembrar: X" → inbox |
| Process inbox | "processar inbox", "T-001 para Alexandre, prazo sexta" |
| Create complete | "tarefa para X: Y ate Z" → next_action |
| Pull (start) | "comecando T-001", "iniciando T-001" → in_progress (check WIP) |
| Waiting | "T-001 aguardando X" → waiting |
| Resume | "T-001 retomada" → in_progress (check WIP) |
| Submit for review | "T-001 pronta para revisao" → review |
| Approve | "T-001 aprovada" → done |
| Conclude | "T-001 concluida" → done (shortcut skipping review) |
| Cancel | "cancelar T-001" → archive |
| View board | "quadro", "status" |
| Person view | "quadro do Alexandre" |
| Overdue | "atrasadas" |
| Change deadline | "estender prazo T-001 para 30/03" |
| Change WIP | "limite do Alexandre para 4" |
| Create project | "projeto para X: Y. Etapas: ..." |
| Create recurring | "mensal para X: Y todo dia Z" |

## Technical Considerations

- **TASKS.json size**: For teams of 3-5 people with ~20 active tasks, TASKS.json stays well under 50KB. The agent can read this easily.
- **Archival**: Auto-archive after 30 days keeps TASKS.json lean. Standup runner handles this.
- **Rate limiting**: `send_message` capped at 10/min, 5s spacing in batch sends.
- **Timezone**: All cron expressions in UTC. Display times converted per config timezone.
- **Issue #293**: Idle containers can block scheduled tasks. Mitigate by reducing `IDLE_TIMEOUT` in `src/config.ts`.
- **Cross-group access**: Digest and review runners need to read TASKS.json from multiple groups. They run from main group context which has project-level read access.
