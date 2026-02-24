# TaskFlow Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `add-taskflow` NanoClaw skill that sets up Kanban+GTD task management via WhatsApp groups, with no source code changes.

**Architecture:** Config-only skill. A SKILL.md interactive wizard collects user preferences, generates a group CLAUDE.md (operating manual), TASKS.json (data), ARCHIVE.json (archive), and creates 3 scheduled runners via IPC. Templates use `{{PLACEHOLDER}}` substitution.

**Tech Stack:** NanoClaw skills system, WhatsApp IPC (`schedule_task`, `send_message`), CLAUDE.md templates

**Reference:** Design doc at `docs/plans/2026-02-24-taskflow-design.md`. Existing skill pattern at `.claude/skills/add-travel-assistant/SKILL.md`.

---

### Task 1: Create skill directory structure

**Files:**
- Create: `.claude/skills/add-taskflow/SKILL.md` (empty placeholder)
- Create: `.claude/skills/add-taskflow/templates/CLAUDE.md.template` (empty placeholder)
- Create: `.claude/skills/add-taskflow/templates/TASKS.json.template` (empty placeholder)
- Create: `.claude/skills/add-taskflow/templates/ARCHIVE.json.template` (empty placeholder)

**Step 1: Create directories**

```bash
mkdir -p /root/nanoclaw/.claude/skills/add-taskflow/templates
```

**Step 2: Create placeholder files**

```bash
touch /root/nanoclaw/.claude/skills/add-taskflow/SKILL.md
touch /root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template
touch /root/nanoclaw/.claude/skills/add-taskflow/templates/TASKS.json.template
touch /root/nanoclaw/.claude/skills/add-taskflow/templates/ARCHIVE.json.template
```

**Step 3: Commit**

```bash
git add .claude/skills/add-taskflow/
git commit -m "chore: scaffold add-taskflow skill directory"
```

---

### Task 2: Write TASKS.json.template

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/TASKS.json.template`

This is the empty data template created for each new task group. All `{{PLACEHOLDERS}}` are substituted during setup.

**Step 1: Write the template**

Write this content to `.claude/skills/add-taskflow/templates/TASKS.json.template`:

```json
{
  "meta": {
    "schema_version": "1.0",
    "language": "{{LANGUAGE}}",
    "timezone": "{{TIMEZONE}}",
    "wip_limit_default": {{WIP_LIMIT}},
    "columns": ["inbox", "next_action", "in_progress", "waiting", "review", "done"],
    "runner_task_ids": {
      "standup": null,
      "digest": null,
      "review": null
    }
  },
  "people": [],
  "tasks": [],
  "next_id": 1
}
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/templates/TASKS.json.template
git commit -m "feat: add TASKS.json template for taskflow skill"
```

---

### Task 3: Write ARCHIVE.json.template

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/ARCHIVE.json.template`

**Step 1: Write the template**

Write this content to `.claude/skills/add-taskflow/templates/ARCHIVE.json.template`:

```json
{
  "meta": {
    "schema_version": "1.0",
    "note": "Archived tasks from {{GROUP_NAME}}. Tasks move here after 30 days in done or when cancelled."
  },
  "tasks": []
}
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/templates/ARCHIVE.json.template
git commit -m "feat: add ARCHIVE.json template for taskflow skill"
```

---

### Task 4: Write CLAUDE.md.template — Identity & Data Loading

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`

This is the operating manual for the container agent. It must be comprehensive since the agent has no other context about TaskFlow. Write it in sections across Tasks 4-8.

**Step 1: Write the header, identity, and critical data-loading instruction**

Write to `.claude/skills/add-taskflow/templates/CLAUDE.md.template`:

```markdown
# {{ASSISTANT_NAME}} — TaskFlow ({{GROUP_NAME}})

You are {{ASSISTANT_NAME}}, the task management assistant for {{MANAGER_NAME}}. You manage a Kanban+GTD board for {{GROUP_CONTEXT}}.

All output in {{LANGUAGE}}.

## CRITICAL: Load Data First

**On EVERY interaction, BEFORE responding, you MUST:**

1. Read `/workspace/group/TASKS.json`
2. Parse the board state (people, tasks, columns)
3. Then process the user's request
4. After any changes, write the updated TASKS.json back

**NEVER ask "what tasks do you have?" — you KNOW from TASKS.json!**

## WhatsApp Formatting

Do NOT use markdown headings (##). Only use:
- *Bold* (single asterisks)
- _Italic_ (underscores)
- Bullet points
- ```Code blocks```

## File Paths

All files are at `/workspace/group/`. Available files:
- `TASKS.json` — active tasks (read-write)
- `ARCHIVE.json` — completed/cancelled tasks (read-write)
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "feat: add CLAUDE.md template header with data loading rules"
```

---

### Task 5: Write CLAUDE.md.template — Board Rules & Column Definitions

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template` (append)

**Step 1: Append board rules section**

Append to the template:

```markdown

## The Kanban Board

Every task is in exactly one column:

📥 Inbox → ⏭️ Next Action → 🔄 In Progress → ⏳ Waiting → 👁️ Review → ✅ Done

| Column | Status | Rule | WIP? |
|--------|--------|------|------|
| 📥 Inbox | `inbox` | Captured without details. Manager must process. | No |
| ⏭️ Next Action | `next_action` | Processed, ready. `next_action` defined. Assignee pulls. | No |
| 🔄 In Progress | `in_progress` | Being executed actively. | Yes |
| ⏳ Waiting | `waiting` | Blocked by third party. `waiting_for` filled. | No |
| 👁️ Review | `review` | Executor finished. Manager approves to close. | No |
| ✅ Done | `done` | Approved and complete. Auto-archived after 30 days. | No |

Additional statuses (not columns):
- `cancelled` — moved to ARCHIVE.json immediately

### Transition Rules

- `inbox` → `next_action`: requires `assignee`, `next_action` filled
- `next_action` → `in_progress`: assignee pulls (check WIP first)
- `in_progress` → `waiting`: requires `waiting_for` filled. Frees 1 WIP slot.
- `waiting` → `in_progress`: check WIP before resuming
- `in_progress` → `review`: executor marks as ready for review
- `review` → `done`: manager approves
- Any → `done`: manager can shortcut with "concluida"
- Any → `cancelled`: manager confirms, move to ARCHIVE.json

### WIP Limit

Before moving any task to 🔄 In Progress:
1. Count tasks with `column: "in_progress"` for that assignee
2. If >= their `wip_limit`: warn and do NOT move
3. Manager can force with "forcar T-XXX para andamento"

Tasks in ⏳ Waiting do NOT count toward WIP.

### Task Types

- **simple** (T-NNN): Single action
- **project** (P-NNN): Has `subtasks[]`. `next_action` is always the first pending subtask.
- **recurring** (R-NNN): Has `recurrence{}` and `current_cycle{}`. Cycles repeat per schedule.

### Archival

During standup, check for tasks with `column: "done"` where `updated_at` is older than 30 days. Move them to ARCHIVE.json.
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "feat: add board rules and column definitions to CLAUDE.md template"
```

---

### Task 6: Write CLAUDE.md.template — GTD Rules & Command Parsing

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template` (append)

**Step 1: Append GTD rules and command parsing**

Append to the template:

```markdown

## GTD Rules

### Quick Capture (Inbox)

When the user says "anotar:", "lembrar:", "registrar:" or similar without full details:
- Create in Inbox with minimum info (title only)
- Do NOT require assignee, deadline, or next_action
- Confirm: "📥 T-XXX added to Inbox"

When the user provides assignee and details from the start:
- Skip Inbox, create directly in Next Action or In Progress

### Processing Inbox

When user says "processar inbox" or during standup:
- List Inbox items
- For each: ask for assignee, deadline, and next_action
- Move to ⏭️ Next Action when complete

### Next Action Rule

Every task outside Inbox and Done MUST have `next_action` filled — the concrete, immediate action to take.

### Waiting For Rule

Every task in ⏳ Waiting MUST have `waiting_for` filled — who/what is being waited on.

### Projects

For project tasks (P-NNN):
- `next_action` is always derived from the first pending subtask
- When a subtask completes, auto-update `next_action` to the next pending subtask
- When all subtasks complete, move project to Review

## Command Parsing

Interpret user messages naturally. Key patterns:

### Capture & Processing
| Pattern | Action |
|---------|--------|
| "anotar: X" / "lembrar: X" / "registrar: X" | Create in Inbox |
| "processar inbox" / "o que tem no inbox?" | List and process Inbox items |
| "T-XXX para [pessoa], prazo [data]" | Process inbox item → Next Action |
| "proxima acao T-XXX: Y" | Update next_action field |

### Board Movement
| Pattern | Action |
|---------|--------|
| "comecando T-XXX" / "iniciando T-XXX" | Move to In Progress (check WIP) |
| "T-XXX aguardando Y" | Move to Waiting, set waiting_for |
| "T-XXX retomada" | Move to In Progress (check WIP) |
| "T-XXX pronta para revisao" | Move to Review |
| "T-XXX aprovada" | Move from Review to Done |
| "T-XXX concluida" / "T-XXX feita" | Move to Done (shortcut) |
| "cancelar T-XXX" | Move to Cancelled → Archive (confirm first) |

### Task Creation
| Pattern | Action |
|---------|--------|
| "tarefa para X: Y ate Z" | Create simple task in Next Action |
| "projeto para X: Y. Etapas: ..." | Create project with subtasks |
| "mensal para X: Y todo dia Z" | Create recurring task |

### Queries & Management
| Pattern | Action |
|---------|--------|
| "quadro" / "status" / "como esta?" | Show full board |
| "quadro do [pessoa]" | Show person's tasks |
| "atrasadas" | Show overdue tasks |
| "o que esta aguardando?" | Show waiting tasks |
| "estender prazo T-XXX para Y" | Update due_date, recreate reminders |
| "limite do [pessoa] para N" | Update wip_limit |
| "cadastrar [nome], telefone [numero], [cargo]" | Add person to people[] |

### Confirmation Required
Always confirm before:
- Cancelling a task
- Reassigning a task
- Deleting a person
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "feat: add GTD rules and command parsing to CLAUDE.md template"
```

---

### Task 7: Write CLAUDE.md.template — Runner Formats & IPC Usage

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template` (append)

**Step 1: Append runner formats and IPC section**

Append to the template:

```markdown

## Standup Format (Morning)

When running a standup (triggered by scheduled task or user request "quadro"):

### Group message:

📊 *Board — [WEEKDAY], [DATE]*

📥 *Inbox (N):*
[list with title]
_→ Process: define assignee and next action_

⏭️ *Next Action (N):*
[ID] ([person]): [title] → _[next_action]_

🔄 *In Progress (N):*
[ID] ([person]): [title] → _[next_action]_ [⏰ deadline if near]

⏳ *Waiting (N):*
[ID] ([person]): [title] → _[waiting_for]_ [X days]

🔴 *Overdue (N):*
[ID] ([person]): [title] — X days overdue

🔁 *Recurring:*
[ID] ([person]): [title] — next: [date]

👁️ *Review (N):*
[ID] ([person]): [title] — pending approval

### Individual message (via send_message to each person):

📋 *Good morning, [NAME]!*
*Your board:*
🔄 [in progress tasks with next_action]
⏳ [waiting tasks]
⏭️ [tasks ready to pull]
_WIP: X/Y_
Any updates?

## Manager Digest Format (Evening)

When running the digest (from main group context):

Read TASKS.json from all task groups under `/workspace/project/groups/`. Consolidate:

🔥 *Overdue*
[group] ID ([person]): [title] — X days overdue

⏳ *Next 48h*
[group] ID ([person]): [title] — due [date]

🚧 *Waiting / Blocked*
[group] ID ([person]): [title] → [waiting_for] ([X days])

💤 *No update (24h+)*
[group] ID ([person]): [title] — last update [date]

✅ *Completed today*
[group] ID ([person]): [title]

Suggest 3 follow-up actions.

## Weekly Review Format (Friday)

Full GTD review:

📋 *Weekly Review — [PERIOD]*
*Summary:* Completed: N | Created: N | Overdue: N

📥 *Inbox to process:* [items]
⏳ *Waiting 5+ days:* [items with follow-up suggestion]
🔴 *Overdue:* [items with suggestion]
🔄 *No update 3+ days:* [items]
📆 *Next week:* [deadlines and recurrences]

Individual weekly summary via send_message to each person.

## IPC Usage

### send_message

Send a message to an individual WhatsApp number:

```bash
echo '{"type":"send_message","to":"[PHONE]@s.whatsapp.net","text":"[MESSAGE]"}' > /workspace/ipc/messages/msg_$(date +%s%N).json
```

**Rate limit:** Max 10 messages/min. Space batch sends by 5 seconds.

### schedule_task

Create a scheduled task:

```bash
echo '{"type":"schedule_task","prompt":"[PROMPT]","schedule_type":"[cron|once]","schedule_value":"[CRON_OR_TIMESTAMP]","context_mode":"group"}' > /workspace/ipc/tasks/task_$(date +%s%N).json
```

- `cron`: recurring (e.g., `"0 11 * * 1-5"` for weekdays 08:00 BRT)
- `once`: one-time at ISO timestamp (auto-cleans after execution)
- Prompts must be self-contained (include all instructions)

### cancel_task

```bash
echo '{"type":"cancel_task","taskId":"[TASK_ID]"}' > /workspace/ipc/tasks/cancel_$(date +%s%N).json
```

When concluding or cancelling a task, clean up its `scheduled_task_ids`.

## Configuration

- Language: {{LANGUAGE}}
- Timezone: {{TIMEZONE}}
- WIP limit default: {{WIP_LIMIT}}
- Standup cron: {{STANDUP_CRON}}
- Digest cron: {{DIGEST_CRON}}
- Review cron: {{REVIEW_CRON}}
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "feat: add runner formats and IPC usage to CLAUDE.md template"
```

---

### Task 8: Write SKILL.md — Phase 1 (Configuration)

**Files:**
- Modify: `.claude/skills/add-taskflow/SKILL.md`

This is the main skill file — the interactive wizard that Claude Code executes when the user runs `/add-taskflow`.

**Step 1: Write SKILL.md frontmatter and Phase 1**

Write to `.claude/skills/add-taskflow/SKILL.md`:

```markdown
---
name: add-taskflow
description: "Add Kanban+GTD task management for team coordination via WhatsApp. Board with 6 columns (Inbox, Next Action, In Progress, Waiting, Review, Done), WIP limits, quick capture, morning standup, evening digest, weekly review. Uses native IPC tools schedule_task and send_message. All via CLAUDE.md + TASKS.json, no source code changes. Use when user wants to manage a team, track tasks, follow up on assignments, or monitor execution via WhatsApp."
---

# TaskFlow — Kanban+GTD Task Management via WhatsApp

Transforms NanoClaw groups into a task management system using Kanban (visual board, WIP limit, pull) and GTD (quick capture, next action, weekly review). Uses 100% native infrastructure: `schedule_task`, `send_message`, `task-scheduler.ts`.

No source code changes. Config-only skill.

**Design doc:** `docs/plans/2026-02-24-taskflow-design.md`

## Phase 1: Configuration

### 1. Pre-flight Checks

Read `.env` to get `ASSISTANT_NAME` (default: "Andy"). This will be used as the trigger prefix.

### 2. Collect Configuration

Use `AskUserQuestion` to collect the following, one at a time:

1. **Manager name** — Who is the team manager? (e.g., "Miguel")

2. **Language** — Which language for all agent output?
   - Options: "pt-BR (Recommended)", "en-US", "es-ES"
   - Default: pt-BR

3. **Timezone** — What timezone for scheduled tasks?
   - Suggest based on language (pt-BR → America/Fortaleza, en-US → America/New_York)
   - Accept any valid IANA timezone

4. **Group layout** — How should groups be organized?
   - "Shared group" — One group for all tasks, individual notifications via send_message
   - "Individual groups" — One WhatsApp group per person (you + person + bot)
   - "Both" — Shared group for the board + individual groups for private standups
   - "I'll decide per person" — Ask for each person during People Registration

5. **WIP limit** — Maximum tasks in "In Progress" per person (default: 3)

6. **Runner schedules** — Accept defaults or customize:
   - Standup: weekdays 08:00 local (cron in UTC based on timezone)
   - Digest: weekdays 18:00 local (cron in UTC based on timezone)
   - Weekly review: Fridays 11:00 local (cron in UTC based on timezone)

**Timezone conversion:** Convert local times to UTC cron expressions:
- Get UTC offset for the configured timezone (account for DST if applicable)
- Example: 08:00 in America/Fortaleza (UTC-3) = 11:00 UTC → cron `"0 11 * * 1-5"`
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/SKILL.md
git commit -m "feat: add SKILL.md Phase 1 — configuration collection"
```

---

### Task 9: Write SKILL.md — Phase 2 (Group Creation)

**Files:**
- Modify: `.claude/skills/add-taskflow/SKILL.md` (append)

**Step 1: Append Phase 2**

Append to `.claude/skills/add-taskflow/SKILL.md`:

```markdown

## Phase 2: Group Creation

For each task group to create:

### 1. Identify WhatsApp Group

Ask if the user has an existing WhatsApp group or wants to create a new one.

- If existing: Find the JID from `/workspace/ipc/available_groups.json` or query the database
- If new: Tell the user to create the group in WhatsApp first, add the bot, then we'll register it

### 2. Create Group Directory

```bash
mkdir -p groups/{{GROUP_FOLDER}}/conversations groups/{{GROUP_FOLDER}}/logs
```

The folder name must be lowercase with hyphens, no spaces or special characters.

### 3. Generate CLAUDE.md

Read the template from `.claude/skills/add-taskflow/templates/CLAUDE.md.template`.

Substitute all `{{PLACEHOLDER}}` variables:
- `{{ASSISTANT_NAME}}` — From `.env` `ASSISTANT_NAME`
- `{{GROUP_NAME}}` — Display name for the group
- `{{MANAGER_NAME}}` — From Phase 1
- `{{GROUP_CONTEXT}}` — Brief description (e.g., "the operations team", "Alexandre's tasks")
- `{{LANGUAGE}}` — From Phase 1
- `{{TIMEZONE}}` — From Phase 1
- `{{WIP_LIMIT}}` — From Phase 1
- `{{STANDUP_CRON}}` — UTC cron expression from Phase 1
- `{{DIGEST_CRON}}` — UTC cron expression from Phase 1
- `{{REVIEW_CRON}}` — UTC cron expression from Phase 1

Write the result to `groups/{{GROUP_FOLDER}}/CLAUDE.md`.

### 4. Generate TASKS.json

Read `.claude/skills/add-taskflow/templates/TASKS.json.template`. Substitute placeholders. Write to `groups/{{GROUP_FOLDER}}/TASKS.json`.

### 5. Generate ARCHIVE.json

Read `.claude/skills/add-taskflow/templates/ARCHIVE.json.template`. Substitute placeholders. Write to `groups/{{GROUP_FOLDER}}/ARCHIVE.json`.

### 6. Register Group

Instruct the user to register from the **main channel**:

```
@{{ASSISTANT_NAME}} register the group "{{GROUP_NAME}}" with JID {{GROUP_JID}} and folder {{GROUP_FOLDER}}
```

Or use the `register_group` MCP tool directly:
```
register_group(
  jid: "{{GROUP_JID}}",
  name: "{{GROUP_NAME}}",
  folder: "{{GROUP_FOLDER}}",
  trigger: "@{{ASSISTANT_NAME}}"
)
```

**Folder name validation:** Must be lowercase with hyphens only. The IPC handler enforces this.
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/SKILL.md
git commit -m "feat: add SKILL.md Phase 2 — group creation"
```

---

### Task 10: Write SKILL.md — Phase 3 (People Registration)

**Files:**
- Modify: `.claude/skills/add-taskflow/SKILL.md` (append)

**Step 1: Append Phase 3**

Append to `.claude/skills/add-taskflow/SKILL.md`:

```markdown

## Phase 3: People Registration

### 1. Collect Team Members

Ask the user for team members, one at a time or in batch:

For each person:
- **Name** — Display name (e.g., "Alexandre")
- **Phone** — Full number with country code, no spaces (e.g., "5586999990001")
- **Role** — Job title or function (e.g., "Tecnico", "Administrativo")
- **WIP limit** — Override default? (optional, default: use global WIP limit)

### 2. Add to TASKS.json

Read `groups/{{GROUP_FOLDER}}/TASKS.json`. For each person, add to the `people` array:

```json
{
  "id": "{{NAME_LOWERCASE}}",
  "name": "{{NAME}}",
  "phone": "{{PHONE}}",
  "role": "{{ROLE}}",
  "wip_limit": {{WIP_LIMIT}}
}
```

The `id` is the name lowercased with special characters removed (e.g., "Alexandre" → "alexandre", "Maria Jose" → "maria-jose").

**Input sanitization:**
- Strip newlines and control characters from names
- Limit names to 50 characters
- Validate phone matches pattern `[0-9]+` (digits only)

Write the updated TASKS.json back.

### 3. Confirm

Show the user the registered team:

```
Team registered:
- Alexandre (5586999990001) — Tecnico, WIP: 3
- Rafael (5586999990002) — TI/Redes, WIP: 3
- Laizes (5586999990003) — Administrativo, WIP: 3
```
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/SKILL.md
git commit -m "feat: add SKILL.md Phase 3 — people registration"
```

---

### Task 11: Write SKILL.md — Phase 4 (Runner Setup)

**Files:**
- Modify: `.claude/skills/add-taskflow/SKILL.md` (append)

**Step 1: Append Phase 4**

Append to `.claude/skills/add-taskflow/SKILL.md`:

```markdown

## Phase 4: Runner Setup

Create 3 scheduled tasks from the **main channel** using the `schedule_task` MCP tool.

### Timezone Handling

All cron expressions must be in UTC. Convert using the configured timezone:
- Read `TZ` from `.env` or use the configured timezone
- Example: 08:00 in America/Fortaleza (UTC-3) = 11:00 UTC

### 1. Morning Standup (per task group)

From the main channel:

```
schedule_task(
  prompt: "You are running the morning standup for this group. Read /workspace/group/TASKS.json. Then: 1) Send the Kanban board to this group (grouped by column, show overdue with 🔴). 2) For each person in people[], send an individual message via send_message to [phone]@s.whatsapp.net with their personal board, WIP status, and ask for updates. Space messages by 5 seconds. 3) Check for tasks with column 'done' and updated_at older than 30 days — move them to ARCHIVE.json. 4) List any inbox items that need processing.",
  schedule_type: "cron",
  schedule_value: "{{STANDUP_CRON}}",
  context_mode: "group",
  target_group_jid: "{{GROUP_JID}}"
)
```

### 2. Manager Digest (on main group)

```
schedule_task(
  prompt: "You are generating the manager digest. Read TASKS.json from all task group folders under /workspace/project/groups/ (skip 'main' and 'global'). For each group that has a TASKS.json, consolidate: 🔥 Overdue tasks, ⏳ Tasks due in next 48h, 🚧 Waiting/blocked tasks, 💤 Tasks with no update in 24h+, ✅ Tasks completed today. Format as a concise executive summary. Suggest 3 specific follow-up actions with group and task ID.",
  schedule_type: "cron",
  schedule_value: "{{DIGEST_CRON}}",
  context_mode: "group"
)
```

Note: Digest runs on the main group (no `target_group_jid`), which has `/workspace/project` mounted read-only.

### 3. Weekly Review (on main group)

```
schedule_task(
  prompt: "You are running the weekly GTD review. Read TASKS.json from all task group folders under /workspace/project/groups/ (skip 'main' and 'global'). Produce: 1) Summary: completed, created, overdue this week. 2) Inbox items pending processing. 3) Waiting tasks older than 5 days (suggest follow-up). 4) Overdue tasks (suggest action). 5) In Progress tasks with no update in 3+ days. 6) Next week preview (deadlines and recurrences). Send the review to this group. Then send individual weekly summaries to each person via send_message. Space messages by 5 seconds.",
  schedule_type: "cron",
  schedule_value: "{{REVIEW_CRON}}",
  context_mode: "group"
)
```

### 4. Store Runner IDs

After creating each scheduled task, the MCP tool returns a task ID. Update `groups/{{GROUP_FOLDER}}/TASKS.json` → `meta.runner_task_ids` with:

```json
{
  "standup": "{{STANDUP_TASK_ID}}",
  "digest": "{{DIGEST_TASK_ID}}",
  "review": "{{REVIEW_TASK_ID}}"
}
```

This allows managing runners later (pause, cancel, update).
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/SKILL.md
git commit -m "feat: add SKILL.md Phase 4 — runner setup"
```

---

### Task 12: Write SKILL.md — Phase 5 (Verification)

**Files:**
- Modify: `.claude/skills/add-taskflow/SKILL.md` (append)

**Step 1: Append Phase 5**

Append to `.claude/skills/add-taskflow/SKILL.md`:

```markdown

## Phase 5: Verification

### 1. Test Message

Tell the user to send a test message to the task group:

```
@{{ASSISTANT_NAME}} quadro
```

The agent should:
- Read TASKS.json
- Show an empty board (no tasks yet)
- Respond with the board format

### 2. Test Quick Capture

Tell the user to test quick capture:

```
@{{ASSISTANT_NAME}} anotar: tarefa de teste
```

The agent should:
- Create T-001 in Inbox
- Respond: "📥 T-001 added to Inbox: tarefa de teste"

### 3. Setup Summary

Show the user a summary of everything created:

```
TaskFlow setup complete!

Group: {{GROUP_NAME}} ({{GROUP_JID}})
Folder: groups/{{GROUP_FOLDER}}/
People: [list]

Scheduled runners:
- Morning standup: {{STANDUP_TIME}} local ({{STANDUP_CRON}} UTC) — ID: {{STANDUP_TASK_ID}}
- Manager digest: {{DIGEST_TIME}} local ({{DIGEST_CRON}} UTC) — ID: {{DIGEST_TASK_ID}}
- Weekly review: {{REVIEW_TIME}} local ({{REVIEW_CRON}} UTC) — ID: {{REVIEW_TASK_ID}}

Files created:
- groups/{{GROUP_FOLDER}}/CLAUDE.md (operating manual)
- groups/{{GROUP_FOLDER}}/TASKS.json (task data)
- groups/{{GROUP_FOLDER}}/ARCHIVE.json (archive)

Quick start:
- "anotar: X" — quick capture to inbox
- "tarefa para [pessoa]: X ate [data]" — create task
- "quadro" — show board
- "processar inbox" — process inbox items
```

### 4. Prompt-Injection Guardrails

The CLAUDE.md template already enforces:
- All inputs are untrusted data
- Privileged actions (register_group, cross-group tasks) only from main channel
- Destructive actions (cancel, delete, reassign) require confirmation
```

**Step 2: Commit**

```bash
git add .claude/skills/add-taskflow/SKILL.md
git commit -m "feat: add SKILL.md Phase 5 — verification and summary"
```

---

### Task 13: Final review and integration commit

**Files:**
- Verify: `.claude/skills/add-taskflow/SKILL.md` (complete)
- Verify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template` (complete)
- Verify: `.claude/skills/add-taskflow/templates/TASKS.json.template` (complete)
- Verify: `.claude/skills/add-taskflow/templates/ARCHIVE.json.template` (complete)

**Step 1: Review all files**

Read each file and verify:
- SKILL.md has all 5 phases
- CLAUDE.md.template has all sections (identity, data loading, board rules, GTD, commands, runners, IPC, config)
- TASKS.json.template has correct JSON structure
- ARCHIVE.json.template has correct JSON structure
- All `{{PLACEHOLDER}}` names are consistent between SKILL.md and templates

**Step 2: Verify file permissions**

```bash
ls -la .claude/skills/add-taskflow/
ls -la .claude/skills/add-taskflow/templates/
```

Ensure all files are owned by `nanoclaw:nanoclaw` (UID 1000).

**Step 3: Fix permissions if needed**

```bash
chown -R nanoclaw:nanoclaw .claude/skills/add-taskflow/
```

**Step 4: Verify the skill appears in the skill list**

The skill should auto-register based on the frontmatter in SKILL.md. Check that `/add-taskflow` is available.

**Step 5: Final commit**

```bash
git add .claude/skills/add-taskflow/
git commit -m "feat: complete add-taskflow skill — Kanban+GTD task management via WhatsApp"
```
