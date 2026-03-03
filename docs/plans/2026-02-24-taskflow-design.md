# TaskFlow — Kanban+GTD Task Management Skill Design

**Date**: 2026-02-24
**Status**: Approved (active behavior baseline; SQLite-backed storage)

## Transition Note

This document is the active product-behavior reference for TaskFlow: command surface, runner behavior, authorization expectations, and user-facing workflow rules. As of March 1, 2026, TaskFlow storage and provisioning should be read through the shared SQLite model. Where older examples in this document still mention `TASKS.json` / `ARCHIVE.json`, treat them as legacy migration reference only, not as the storage model for new boards.

## Summary

NanoClaw skill that transforms WhatsApp groups into a Kanban+GTD task management system for team coordination. The user-facing behavior is template-driven: CLAUDE.md instructions, shared command rules, and IPC tools (`schedule_task`, `send_message`, `cancel_task`, `list_tasks`) define the operational model. Storage and provisioning use the shared SQLite TaskFlow schema described by the SQLite implementation plans.

## Requirements

| Requirement | Decision |
|-------------|----------|
| Data storage | Shared SQLite TaskFlow schema for all topologies; legacy `TASKS.json` / `ARCHIVE.json` examples are migration-only reference. |
| CLAUDE.md | Instructions and rules only (no task data) |
| Group layout | Configurable — one shared board (recommended) or multiple separate independent boards |
| Columns | 6: Inbox → Next Action → In Progress → Waiting → Review → Done |
| Runners | 3: Morning standup, evening digest, weekly review |
| Language | Configurable (default: pt-BR) |
| Timezone | Configurable (default: America/Fortaleza) |
| Source code | Existing runtime support already in place; behavior remains template-driven |
| Group creation | Via `create_group` IPC plugin from `main` or an eligible TaskFlow-managed group that still fits the depth rule |
| Group registration | Direct `INSERT INTO registered_groups` (SQLite) |
| Runner creation | Direct `INSERT INTO scheduled_tasks` via `better-sqlite3` |

## Architecture

### File Layout

```
.claude/skills/add-taskflow/
  SKILL.md                  # Skill definition (interactive setup wizard)

# Created per task group during setup:
groups/<group-name>/
  CLAUDE.md                 # Operating manual (rules, identity, Kanban/GTD instructions)
  .mcp.json                 # SQLite MCP configuration for the shared TaskFlow database

# Shared TaskFlow storage:
data/taskflow/
  taskflow.db               # Active task, archive, history, runner, and board state
```

### Runtime Flow

1. User sends message to task group (e.g. `@Tars anotar: verificar ar condicionado`)
2. Container agent starts, reads `CLAUDE.md` (instructions)
3. Agent reads the board data store via the shared SQLite MCP tools — instructed at top of CLAUDE.md
4. Agent processes command, updates the SQLite-backed board data store, responds in chat
5. Agent uses MCP `send_message` to send replies to the group chat
6. Scheduled runners trigger via `schedule_task` IPC → same flow

### IPC Authorization Constraint

Non-main groups can only send messages to their own group chat. They **cannot** send to individual phone numbers (`[phone]@s.whatsapp.net`) — the IPC authorization at `src/ipc.ts:77-80` blocks this because phone JIDs are not registered groups. Additionally, the MCP `send_message` tool has no recipient parameter — it always sends to the current group JID.

Consequence: **Individual DMs are not supported.** All runner output (standup, digest, review) goes to the group chat with per-person sections inline. Runners execute in the target group context (`context_mode: "group"` + `target_group_jid`) which gives them direct access to the board's SQLite-backed data store. They do NOT need main group context since DMs are not used.

### Critical Constraint

The agent must explicitly read the active board data store at the start of every interaction. The CLAUDE.md instructions enforce this with a top-level directive.

## Legacy JSON Migration Reference

The JSON shape below is preserved only as a migration/input compatibility reference for already-deployed boards. The active storage model for new boards is the shared SQLite schema.

All timestamps use ISO-8601 UTC: `"2026-02-27T14:30:00.000Z"`

```json
{
  "meta": {
    "schema_version": "2.0",
    "language": "pt-BR",
    "timezone": "America/Fortaleza",
    "manager": {
      "name": "Miguel",
      "phone": "5586999990000"
    },
    "managers": [
      { "name": "Miguel", "phone": "5586999990000", "role": "manager" }
    ],
    "attachment_policy": {
      "enabled": true,
      "disabled_reason": "",
      "allowed_formats": ["pdf", "jpg", "png"],
      "max_size_bytes": 10485760
    },
    "wip_limit_default": 3,
    "columns": ["inbox", "next_action", "in_progress", "waiting", "review", "done"],
    "runner_task_ids": {
      "standup": null,
      "digest": null,
      "review": null,
      "dst_guard": null
    },
    "runner_crons_local": {
      "standup": "0 8 * * 1-5",
      "digest": "0 18 * * 1-5",
      "review": "0 11 * * 5"
    },
    "runner_crons_utc": {
      "standup": "0 11 * * 1-5",
      "digest": "0 21 * * 1-5",
      "review": "0 14 * * 5"
    },
    "dst_sync": {
      "enabled": false,
      "last_offset_minutes": null,
      "last_synced_at": null,
      "resync_count_24h": 0,
      "resync_window_started_at": null
    },
    "attachment_audit_trail": []
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
      "next_action": "Instalar o filtro amanha",
      "waiting_for": null,
      "due_date": "2026-02-28T23:59:00.000Z",
      "priority": "normal",
      "labels": [],
      "description": null,
      "blocked_by": [],
      "reminders": [],
      "next_note_id": 1,
      "notes": [],
      "created_at": "2026-02-24T10:00:00.000Z",
      "updated_at": "2026-02-25T09:00:00.000Z",
      "history": [],
      "_last_mutation": null
    }
  ],
  "next_id": 2
}
```

### Task Schemas

The canonical persisted structure is the `TASKS.json` template. The group `CLAUDE.md` template defines the allowed task types, ID patterns, transitions, and mutation rules that operate on that structure.

### Task Fields

All task types share these common fields:

- `priority`: one of `"low"`, `"normal"`, `"high"`, `"urgent"` (default: `"normal"`)
- `labels`: ordered list of short lowercase tags like `"financeiro"` or `"cliente-a"`
- `next_note_id`: next numeric note ID to assign when creating a new structured note (initialized as `1`)
- `notes`: ordered list of note entries. New notes are stored as structured objects: `{ "id": N, "text": "...", "by": "person-id", "created_at": "ISO-8601", "updated_at": "ISO-8601" }`. Legacy string notes from older boards remain valid and readable. Only structured note objects with `id` can be edited or removed.
- `history`: array of history entries. Capped at 50 entries (oldest removed first). During archival, truncated to 20.
- `description`: optional free-text description (max 500 characters) or `null`. Persists across recurring cycles.
- `blocked_by`: list of task IDs that this task depends on (advisory, not hard-blocking)
- `reminders`: list of deadline reminder objects `{ "offset_days": N, "scheduled_task_id": "..." }`
- `_last_mutation`: snapshot of task state before last mutation, for undo support

### History Action Types

`"created"`, `"moved"`, `"updated"`, `"reassigned"`, `"due_date_changed"`, `"priority_changed"`, `"label_added"`, `"label_removed"`, `"title_changed"`, `"note_added"`, `"note_edited"`, `"note_removed"`, `"review_rejected"`, `"recurrence_changed"`, `"cancelled"`, `"reopened"`, `"restored"`, `"manager_added"`, `"manager_removed"`, `"cycle_completed"`, `"subtask_added"`, `"subtask_completed"`, `"subtask_renamed"`, `"subtask_reopened"`, `"description_changed"`, `"dependency_added"`, `"dependency_removed"`, `"dependency_resolved"`, `"bulk_reassigned"`, `"undone"`

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

The active archive store is the SQLite `archive` table. The legacy `ARCHIVE.json` shape mirrors the old JSON board format and is migration reference only. Tasks move into the SQLite archive after 30 days in `done` or when `cancelled`. The standup runner handles archival automatically.

## CLAUDE.md Template

The group CLAUDE.md is a pure operating manual:

1. **Identity** — who the agent is, who the manager is
2. **Scope Guard** — refuses off-topic queries without reading TASKS.json (token savings)
3. **Critical: Read TASKS.json first** — top-level instruction to load data on every interaction
4. **Security** — prompt-injection guardrails, untrusted input handling, self-modification protection
5. **Sender Identification** — multi-manager/delegate lookup via `meta.managers[]` with role-based permissions, legacy `meta.manager` fallback. The primary full manager must also exist in the active people store (or be synthesized there during migration) even if that person should not receive normal day-to-day assignments, because sender identification and authorization depend on the people store as well as the admin-role store.
6. **Authorization rules** — full-manager-only, delegate-or-manager, assignee-only, assignee-or-manager, and everyone permissions
7. **Data schemas** — Board admin roles (`meta.managers[]`), person, task (simple/project/recurring), and history entry schemas
8. **Task structure rules** — task types, ID patterns, required fields, history handling, recurring-cycle behavior
9. **Board rules** — 6 columns, transition rules, WIP enforcement, archival, history cap
10. **GTD rules** — quick capture, next_action always required, waiting_for required, attachment intake
11. **Command parsing** — natural language command table (capture, move, conclude, manage, attach, etc.)
12. **Standup/Digest/Review formats** — board display formats with skip-if-empty rules and per-person sections inline
13. **MCP tool usage** — `send_message`, `schedule_task`, `cancel_task`, `list_tasks` with signatures and constraints
14. **Config** — language, timezone, WIP default, attachment policy, DST guard, cron schedules

Note: All runner prompts are self-contained (include full instructions). Runners execute in the target group context, not from main.

## Scheduled Runners

### 1. Morning Standup (target group context, weekdays)
- **Default cron**: `0 11 * * 1-5` (derived from the default 08:00 America/Fortaleza local schedule)
- **Context**: Runs in target group context (`context_mode: "group"` + `target_group_jid`), which gives direct access to `/workspace/group/TASKS.json`
- **Behavior**: If `tasks[]` is empty, sends nothing. Otherwise reads TASKS.json → sends board summary to group chat via `send_message` with per-person sections inline (personal board + WIP). Individual DMs not supported — `send_message` has no recipient parameter.
- **Also handles**: overdue detection, inbox reminder, 30-day archive cleanup, history cap enforcement

### 2. Manager Digest (target group context, weekdays evening)
- **Default cron**: `0 21 * * 1-5` (18:00 BRT)
- **Behavior**: If `tasks[]` is empty, sends nothing. Otherwise reads TASKS.json from the target group → produces executive summary → sends to group chat via `send_message`
- **Sections**: overdue, next 48h, blocked/waiting, no updates, completed today

### 3. Weekly Review (target group context, Fridays)
- **Default cron**: `0 14 * * 5` (11:00 BRT)
- **Behavior**: If `tasks[]` is empty, sends nothing even if the archive had activity that week. Otherwise runs the full GTD review — weekly metrics, aging tasks, bottlenecks, inbox cleanup, waiting follow-ups
- **Format**: Executive summary with suggested actions + per-person summaries inline in group message. Each inline per-person block should include: completed count, active-now tasks, waiting 5+ days, overdue items, and next-week work.

All runner prompts are self-contained (include full instructions so the agent knows what to do when triggered by the scheduler).

## Interactive Setup Flow (SKILL.md)

### Phase 1 — Configuration
1. Ask manager name
2. Ask language (default: pt-BR)
3. Ask timezone (default: America/Fortaleza)
4. Ask board topology: one shared board (recommended) or multiple separate independent boards
5. Ask WIP limit default (default: 3)
6. Ask AI model (default: claude-sonnet-4-6 — recommended for structured task management)
7. Ask runner schedule preferences (or accept defaults)

### Phase 2 — Group Creation
0. **Option A (recommended):** Use the `create_group` IPC plugin — write a JSON file to `data/ipc/{group}/tasks/` with `{ "type": "create_group", "subject": "...", "participants": [...] }`. The host process creates the group via Baileys without stopping the service. For standard single-board TaskFlow setup, this is invoked from the main group. (Hierarchy mode may additionally allow eligible TaskFlow-managed groups when their `registered_groups` row includes explicit TaskFlow depth metadata and creating one more child would still fit inside the configured depth limit, i.e. `current runtime level + 1 < max_depth`.)
   **Option B (legacy):** Stop NanoClaw service (required for direct Baileys socket access — only one connection per account).
For each group:
1. Create WhatsApp group via the `create_group` IPC plugin (Option A) or Baileys `groupCreate(subject, participants)` API (Option B), or find existing group JID from DB
2. Create group directory (`{folder}` / `{{GROUP_FOLDER}}`, lowercase with hyphens)
3. Generate CLAUDE.md from template with config values
4. Create empty TASKS.json with meta + empty tasks/people arrays
5. Create empty ARCHIVE.json
6. Configure AI model via per-group `settings.json` (pre-create `data/sessions/{folder}/.claude/settings.json` with `ANTHROPIC_MODEL`)
7. Register group via direct `INSERT INTO registered_groups` (SQLite). Standard TaskFlow writes the base columns only; hierarchy mode extends the same row with `taskflow_managed`, `taskflow_hierarchy_level`, and `taskflow_max_depth`.

If using Option B (direct Baileys), service stays stopped through Phases 2–3 (people collection doesn't need WhatsApp). If using Option A (IPC plugin), the service remains running throughout.

### Phase 3 — People Registration
1. Ask for team members: name, phone, role
2. Add to TASKS.json → `people[]` array
   - The primary full manager must also have a `people[]` record even if they should not receive normal day-to-day assignments, because sender identification and admin authorization still resolve through the active people store
3. Optionally set per-person WIP limits
4. If separate boards were chosen, repeat the same per-group setup for each board; there is no automatic cross-group sync

### Phase 4 — Runner Setup
1. Insert standup/digest/review scheduled tasks directly into `scheduled_tasks` table via `better-sqlite3` parameterized queries (no manual WhatsApp messages)
2. Store runner IDs in TASKS.json `meta.runner_task_ids` (IDs are wizard-generated, known immediately)
3. Fix file ownership (`chown`), restart service once (picks up registered groups + resumes WhatsApp)

### Phase 5 — Verification
1. Send test message to the task group
2. Confirm the agent can read TASKS.json
3. Show summary of what was created

## Natural Language Commands

| Intent | Examples | Permission |
|--------|----------|------------|
| Quick capture | "anotar: X", "lembrar: X", "registrar: X" → inbox | Everyone |
| Process inbox | "processar inbox", "T-001 para Alexandre, prazo sexta" | Delegate or full manager |
| Create complete | "tarefa para X: Y ate Z" → next_action | Full manager |
| Create project | "projeto para X: Y. Etapas: ..." | Full manager |
| Create recurring | "diario/semanal/mensal/anual para X: Y ..." | Full manager |
| Pull (start) | "comecando T-001", "iniciando T-001" → in_progress (check WIP) | Assignee |
| Waiting | "T-001 aguardando X" → waiting | Assignee |
| Resume | "T-001 retomada" → in_progress (check WIP) | Assignee |
| Return to queue | "devolver T-001" → next_action (frees WIP) | Assignee |
| Submit for review | "T-001 pronta para revisao" → review | Assignee |
| Approve | "T-001 aprovada" → done | Delegate or full manager |
| Reject review | "T-001 rejeitada: [motivo]" → in_progress (rework) | Delegate or full manager |
| Conclude | "T-001 concluida" / "T-001 feita" → done (shortcut) | Assignee or manager |
| Reopen | "reabrir T-001" → done to next_action | Assignee or manager |
| Force WIP | "forcar T-001 para andamento" → in_progress (bypass WIP) | Full manager |
| Subtask done | "P-001.1 concluida" / "P-001.1 feita" / "P-001.1 pronta" | Assignee or manager |
| Add subtask | "adicionar etapa P-001: validar rollback" | Assignee or manager |
| Rename subtask | "renomear etapa P-001.2: instalar SO atualizado" | Assignee or manager |
| Reopen subtask | "reabrir etapa P-001.2" | Assignee or manager |
| Cancel | "cancelar T-001" → archive (confirm first) | Full manager |
| Restore archived | "restaurar T-001" → next_action | Full manager |
| Reassign | "reatribuir T-001 para Rafael" (confirm first) | Full manager |
| Update next action | "proxima acao T-001: Y" | Assignee or manager |
| Rename task | "renomear T-001: novo titulo" | Assignee or manager |
| Add note | "nota T-001: texto" / "anotacao T-001: texto" | Assignee or manager |
| Edit note | "editar nota T-001 #N: texto" | Assignee or manager |
| Remove note | "remover nota T-001 #N" | Assignee or manager |
| Update priority | "prioridade T-001: alta" (baixa/normal/alta/urgente) | Assignee or manager |
| Add label | "rotulo T-001: financeiro" | Assignee or manager |
| Remove label | "remover rotulo T-001: financeiro" | Assignee or manager |
| View board | "quadro", "status", "como esta?" | Everyone |
| Person view | "quadro do Alexandre" | Everyone |
| My tasks | "minhas tarefas", "meu quadro" | Everyone |
| Show inbox | "inbox", "mostrar inbox" | Everyone |
| Show review | "revisao", "em revisao" | Everyone |
| Show person's review | "revisao do Alexandre", "em revisao do Alexandre" | Everyone |
| Show next action | "proxima acao", "proximas acoes" | Everyone |
| Show in progress | "em andamento" | Everyone |
| Task details | "detalhes T-001", "info T-001" | Everyone |
| Task history | "historico T-001" | Everyone |
| Search | "buscar contrato" (across title, next_action, waiting_for, notes) | Everyone |
| Search with label | "buscar contrato com rotulo financeiro" | Everyone |
| Show urgent | "urgentes", "prioridade urgente" | Everyone |
| Show high priority | "prioridade alta", "alta prioridade" | Everyone |
| Show by label | "rotulo financeiro", "buscar rotulo financeiro" | Everyone |
| Overdue | "atrasadas" | Everyone |
| Waiting list | "o que esta aguardando?" | Everyone |
| Waiting by person | "aguardando do Alexandre", "bloqueadas do Alexandre" | Everyone |
| Due today | "vence hoje", "vencem hoje" | Everyone |
| Due tomorrow | "vence amanha", "vencem amanha" | Everyone |
| Due this week | "vence esta semana", "vencem esta semana" | Everyone |
| Due next 7 days | "proximos 7 dias", "vencem nos proximos 7 dias" | Everyone |
| Help | "ajuda", "comandos", "help" | Everyone |
| Completed today | "concluidas hoje" | Everyone |
| Completed this week | "concluidas esta semana" | Everyone |
| Change deadline | "estender prazo T-001 para 30/03" | Full manager |
| Change WIP | "limite do Alexandre para 4" | Full manager |
| Add person | "cadastrar João, telefone 5586999990004, Analista" | Full manager |
| Remove person | "remover João" (confirm first, reassign tasks) | Full manager |
| Add manager | "adicionar gestor João, telefone 5586999990004" | Full manager |
| Add delegate | "adicionar delegado Rafael, telefone 5586999990005" | Full manager |
| Remove manager/delegate | "remover gestor João" / "remover delegado Rafael" (confirm first) | Full manager |
| Modify recurrence | "alterar recorrencia R-001 para semanal" | Full manager |
| Import from attachment | "importar anexo" (CONFIRM_IMPORT required) | Full manager |
| Update from attachment | "atualizar tarefas pelo anexo" (CONFIRM_IMPORT required) | Full manager or assignee (own tasks) |
| Remove due date | "remover prazo T-001" | Full manager |
| Completed by person | "concluidas do Alexandre" | Everyone |
| Completed this month | "concluidas do mes", "concluidas este mes" | Everyone |
| Ad-hoc digest | "resumo" (distinct from "resumo semanal"/"revisao") | Everyone |
| Archive browse | "listar arquivo" (20 most recent) | Everyone |
| Archive search | "buscar no arquivo [texto]" | Everyone |
| Batch operations | "T-005, T-006, T-007 aprovadas" (approve, reject, conclude, cancel) | Same as individual |
| Calendar view | "agenda" (14 days), "agenda da semana" (7 days) | Everyone |
| Bulk reassign | "transferir tarefas do [pessoa] para [pessoa]" (confirm first) | Full manager |
| Undo | "desfazer" (within 60s) | Mutation actor or full manager |
| Changelog | "o que mudou hoje?", "mudancas hoje", "o que mudou desde ontem?", "o que mudou esta semana?" | Everyone |
| Update description | "descricao T-001: [texto]" (max 500 chars) | Assignee or manager |
| Add dependency | "T-XXX depende de T-YYY" | Assignee or manager |
| Remove dependency | "remover dependencia T-XXX de T-YYY" | Assignee or manager |
| Add reminder | "lembrete T-XXX [N] dia(s) antes" | Assignee or manager |
| Remove reminder | "remover lembrete T-XXX" | Assignee or manager |
| Recurring project | "projeto recorrente para X: Y. Etapas: ... todo [freq]" | Full manager |
| Statistics | "estatisticas", "estatisticas do [pessoa]", "estatisticas do mes" | Everyone |

## Design Decisions

- **Escalation runner dropped**: The original reference docs proposed a mid-day escalation runner (10:00/16:00). Dropped because: the morning standup already detects overdue tasks, the manager can request ad-hoc checks ("atrasadas"), and fewer runners means less message noise. Can be added later as an optional 4th runner.
- **Clarify column dropped**: The 8-column reference model included `clarify` between inbox and next_action. Merged into the inbox→next_action processing flow — when the manager processes inbox items, they provide the missing info (assignee, deadline, next_action) in one step.
- **Contexts field dropped**: GTD `@contexts` (e.g., `@phone`, `@computer`) omitted for simplicity with small teams. Can be added to TASKS.json schema later if needed.
- **Scope guard for token savings**: The CLAUDE.md template includes a "Scope Guard" section placed before "Load Data First". Off-topic messages (not related to task management) get a short refusal without reading TASKS.json, reducing token cost from ~5000+ to ~500 per off-topic query. Zero core code changes — instruction-level enforcement in the agent's operating manual.
- **Self-modification and code change protection**: The CLAUDE.md Security section explicitly blocks: modifying CLAUDE.md/settings.json/config files, installing packages, writing scripts, creating files outside TASKS.json/ARCHIVE.json, and any code/skill/settings change requests. Users are told only the system administrator can make those changes. This is instruction-level enforcement backed by the container sandbox (non-main groups can't access project root).
- **Explicit structure rules**: The persisted structure is defined by the JSON templates, and the CLAUDE.md template defines the allowed task types, ID patterns, transitions, and mutation rules. This keeps behavior deterministic across sessions without depending on a separate schema appendix in the prompt.
- **Attachment import with confirmation gate**: Attachment-driven task creation/update uses a mandatory `CONFIRM_IMPORT {import_action_id}` token — generic replies like "ok" or "confirmado" are rejected. This prevents accidental mutations from extracted text. Audit trail entries are appended to `meta.attachment_audit_trail` on every confirmed import.
- **Multi-manager/delegate roles**: Boards support multiple admins via `meta.managers[]`, each with a `role` of `"manager"` (full access) or `"delegate"` (can process inbox and approve/reject reviews, but cannot create tasks, cancel, restore, reassign, or manage people/admins). The legacy `meta.manager` field is kept as a compatibility alias for the first full manager. The primary full manager must also have a matching people-store entry even if they are not intended to carry regular task assignments. This allows managers to delegate triage without granting full board control while preserving sender identification and authorization.
- **Editable structured notes**: Notes evolved from plain strings to objects with `id`, `text`, `by`, `created_at`, and `updated_at`. A `next_note_id` counter on each task assigns sequential IDs. Users can edit or remove notes by ID (`editar nota T-XXX #N`, `remover nota T-XXX #N`). Legacy string notes remain readable but immutable.
- **DST guard runner**: Optional 4th runner (daily at 02:17 UTC) that detects timezone offset changes and recomputes UTC cron expressions for the 3 core runners. Anti-loop guard limits resyncs to 2 per 24h window. Only relevant for DST-observing timezones; disabled by default for fixed-offset zones like America/Fortaleza.
- **TaskFlow v2 features**: 15 additional features added: task description, task dependencies (advisory), deadline reminders, remove due date, completed by person, completed this month, ad-hoc digest, archive browsing, batch operations, calendar view, bulk reassign, undo (60s window), changelog view, recurring projects, and statistics/metrics. All template-only — no source code changes.
  - Statistics and metrics must use completion history from active tasks plus archived history snapshots for archived tasks; otherwise completed counts and cycle-time calculations undercount older completed work.

## Technical Considerations

- **TASKS.json size**: For teams of 3-5 people with ~20 active tasks, TASKS.json stays well under 50KB. The agent can read this easily.
- **Archival**: Auto-archive after 30 days keeps TASKS.json lean. Standup runner handles this.
- **Rate limiting**: `send_message` capped at 10/min, 5s spacing in batch sends.
- **Timezone**: Cron expressions run in the host scheduler timezone (`process.env.TZ` when set, otherwise the host system timezone). Convert from the chosen local business time to the scheduler timezone at setup time. Example: 08:00 America/Fortaleza (UTC-3, no DST) = `"0 11 * * 1-5"` when the scheduler is running in UTC.
- **Issue #293**: Idle containers can block scheduled tasks. Mitigate by reducing `IDLE_TIMEOUT` in `src/config.ts`.
- **Cross-group access**: Runners execute in the target group context (`target_group_jid`), which gives direct `/workspace/group/` access. Non-main groups do not get project-root access, and may also receive a read-only `/workspace/global/` mount when that shared directory exists.
- **IPC authorization**: Non-main groups can only send messages to their own group chat. The MCP `send_message` tool has no recipient parameter — it always sends to the current chatJid. Individual DMs (`@s.whatsapp.net`) are not supported even from main, as user JIDs are not in `registeredGroups`.
- **MCP tools (runtime)**: Use `send_message(text, sender?)` for group messages, `schedule_task(...)` for scheduling, and `cancel_task(taskId)` only for runner maintenance. Do NOT write raw IPC JSON files from agent prompts.
- **Wizard DB access (setup-time)**: The SKILL.md wizard runs on the host (Claude Code) with direct SQLite access via `better-sqlite3`. It bypasses MCP privileges to register groups (`INSERT INTO registered_groups`) and create scheduled tasks (`INSERT INTO scheduled_tasks`) without manual WhatsApp messages. The scheduler picks up new tasks on its next poll tick; registered groups require a service restart to reload the in-memory cache.
- **Group creation**: Two options are available:
  - **IPC plugin (recommended):** The `create_group` IPC plugin (`src/ipc-plugins/create-group.ts`) allows group creation at runtime without stopping the service. The wizard writes `{ "type": "create_group", "subject": "...", "participants": [...] }` to the IPC tasks directory. The host process creates the group via Baileys and logs the resulting JID. Main group only for standard TaskFlow setup. Hierarchy mode may additionally allow eligible TaskFlow-managed groups, but only when creating one more child would still stay within the configured limit (`current runtime level + 1 < taskflow_max_depth`). See `docs/SPEC.md` § IPC Plugin Mechanism.
  - **Direct Baileys (legacy):** The wizard uses Baileys `groupCreate(subject, participants)` directly. This requires briefly stopping the NanoClaw service (only one Baileys socket per account). The service is stopped once at the start of Phase 2 and restarted once at the end of Phase 4.
  - Groups are created with the manager as participant (bot auto-added as superadmin); any additional board groups are separate independent boards rather than private mirrors. Rate limiting: 2s delay between calls. Partial failures are handled per-group (successful groups keep their JIDs, failed groups fall back to manual creation).
- **Per-group AI model**: Each group's model is configured via `data/sessions/{folder}/.claude/settings.json` with `ANTHROPIC_MODEL` in the `env` block. The wizard pre-creates this file during Phase 2 Step 6. The container runtime (`container-runner.ts`) only writes a default `settings.json` if one doesn't exist, so the wizard's file persists. If `settings.json` is changed later, restart the service to guarantee the new model is picked up. Default: `claude-sonnet-4-6` (structured task management doesn't need Opus-level reasoning). Zero core code changes — uses the existing Claude Code settings mechanism.
- **History growth**: Task `history[]` must be capped at 50 entries. When adding a new entry would exceed 50, remove the oldest first. During archival, truncate to 20. This prevents TASKS.json from growing unbounded for long-running projects.
