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
5. Agent uses MCP `send_message` to send replies to the group chat
6. Scheduled runners trigger via `schedule_task` IPC → same flow

### IPC Authorization Constraint

Non-main groups can only send messages to their own group chat. They **cannot** send to individual phone numbers (`[phone]@s.whatsapp.net`) — the IPC authorization at `src/ipc.ts:77-80` blocks this because phone JIDs are not registered groups. Additionally, the MCP `send_message` tool has no recipient parameter — it always sends to the current group JID.

Consequence: **Individual DMs are not supported.** All runner output (standup, digest, review) goes to the group chat with per-person sections inline. Runners execute in the target group context (`context_mode: "group"` + `target_group_jid`) which gives them direct access to the group's TASKS.json. They do NOT need main group context since DMs are not used.

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
      "review": null,
      "dst_guard": null
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
      "description": "Receber o filtro do fornecedor e instalar no equipamento",
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
3. **Security** — prompt-injection guardrails, untrusted input handling
4. **Board rules** — 6 columns, transition rules, WIP enforcement
5. **GTD rules** — quick capture, next_action always required, waiting_for required
6. **Command parsing** — natural language command table (capture, move, conclude, etc.)
7. **Standup format** — board display format for group messages with per-person sections inline
8. **IPC usage** — MCP tools for group messages (`send_message`) and scheduling (`schedule_task`)
9. **Config** — language, timezone, WIP default, cron schedules

Note: All runner prompts are self-contained (include full instructions). Runners execute in the target group context, not from main.

## Scheduled Runners

### 1. Morning Standup (target group context, weekdays)
- **Default cron**: `0 11 * * 1-5` (08:00 BRT, server TZ=UTC)
- **Context**: Runs in target group context (`context_mode: "group"` + `target_group_jid`), which gives direct access to `/workspace/group/TASKS.json`
- **Behavior**: Reads TASKS.json → sends board summary to group chat via `send_message` with per-person sections inline (personal board + WIP). Individual DMs not supported — `send_message` has no recipient parameter.
- **Also handles**: overdue detection, inbox reminder, 30-day archive cleanup, history cap enforcement

### 2. Manager Digest (target group context, weekdays evening)
- **Default cron**: `0 21 * * 1-5` (18:00 BRT)
- **Behavior**: Reads TASKS.json from the target group → produces executive summary → sends to group chat via `send_message`
- **Sections**: overdue, next 48h, blocked/waiting, no updates, completed today

### 3. Weekly Review (target group context, Fridays)
- **Default cron**: `0 14 * * 5` (11:00 BRT)
- **Behavior**: Full GTD review — weekly metrics, aging tasks, bottlenecks, inbox cleanup, waiting follow-ups
- **Format**: Executive summary with suggested actions + per-person summaries inline in group message

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

## Design Decisions

- **Escalation runner dropped**: The original reference docs proposed a mid-day escalation runner (10:00/16:00). Dropped because: the morning standup already detects overdue tasks, the manager can request ad-hoc checks ("atrasadas"), and fewer runners means less message noise. Can be added later as an optional 4th runner.
- **Clarify column dropped**: The 8-column reference model included `clarify` between inbox and next_action. Merged into the inbox→next_action processing flow — when the manager processes inbox items, they provide the missing info (assignee, deadline, next_action) in one step.
- **Contexts field dropped**: GTD `@contexts` (e.g., `@phone`, `@computer`) omitted for simplicity with small teams. Can be added to TASKS.json schema later if needed.

## Technical Considerations

- **TASKS.json size**: For teams of 3-5 people with ~20 active tasks, TASKS.json stays well under 50KB. The agent can read this easily.
- **Archival**: Auto-archive after 30 days keeps TASKS.json lean. Standup runner handles this.
- **Rate limiting**: `send_message` capped at 10/min, 5s spacing in batch sends.
- **Timezone**: This server runs `TZ=UTC`. Cron expressions must be in UTC. Convert local times: e.g., 08:00 BRT (UTC-3) = `"0 11 * * 1-5"` in UTC. The SKILL.md Phase 1 must detect the server timezone to calculate the correct offset.
- **Issue #293**: Idle containers can block scheduled tasks. Mitigate by reducing `IDLE_TIMEOUT` in `src/config.ts`.
- **Cross-group access**: Runners execute in the target group context (`target_group_jid`), which gives direct `/workspace/group/` access. Non-main groups do NOT get `/workspace/project/`.
- **IPC authorization**: Non-main groups can only send messages to their own group chat. The MCP `send_message` tool has no recipient parameter — it always sends to the current chatJid. Individual DMs (`@s.whatsapp.net`) are not supported even from main, as user JIDs are not in `registeredGroups`.
- **MCP tools**: Use `send_message(text, sender?)` for group messages, `schedule_task(...)` for scheduling, `cancel_task(taskId)` for cleanup. Do NOT write raw IPC JSON files from agent prompts.
- **History growth**: Task `history[]` must be capped at 50 entries. When adding a new entry would exceed 50, remove the oldest first. During archival, truncate to 20. This prevents TASKS.json from growing unbounded for long-running projects.
