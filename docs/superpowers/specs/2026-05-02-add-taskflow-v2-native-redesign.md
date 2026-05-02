# Phase A.3 Design — v2-Aligned `add-taskflow` Skill

> **Status:** strategic spec. Awaits user review before plan authoring (Phase A.3 plan) and code authoring. Per memory `feedback_use_v2_natives_dont_duplicate.md`: adopt v2's design patterns, don't preserve v1 mechanisms.

**Date:** 2026-05-02
**Sources:** `upstream/main @ 1b08b58f` + `upstream/channels` + Codex review #5 corrections + v2 feature evaluation (`docs/superpowers/audits/2026-05-02-v2-features-for-our-skills.md`).

## Goal

Redesign the `add-taskflow` skill so that, on a clean `upstream/main` clone with the skill applied, our 28 production TaskFlow boards work end-to-end with **zero fork-private logic that v2 already covers**. Skill becomes a thin layer of TaskFlow domain code (Kanban state machine, WIP enforcement, weekly review templates, Kipp audit prompts) on top of v2's primitives (`schedule_task`, `ask_user_question`, `destinations`, `user_roles`, `messaging_group_agents`, sender-approval flow).

## What changed vs v1 TaskFlow

| Concept | v1 TaskFlow (today) | v2-aligned TaskFlow (this spec) |
|---|---|---|
| **Board provisioning** | Operator slash command → fork-private IPC plugin auto-creates WhatsApp group + adds participants + seeds DB | Operator manually creates WhatsApp group + adds members → bot detects via `unknown_sender_policy='request_approval'` → admin-card approves wiring → `create_agent` MCP tool → TaskFlow seeds DB via MCP tools |
| **Per-board trigger** | `registered_groups.trigger_pattern` (e.g., `@Case`) | `messaging_group_agents.engage_pattern='.'` (always engage) + agent prefix as CLAUDE.md convention |
| **isMain check** | 169 `isMain` hits across 20+ files | `users` + `user_roles(role='admin', agent_group_id=X)` + `hasAdminRole()` helper |
| **Daily/weekly schedules (Kipp, digest, standup, weekly review)** | Fork-private `task-scheduler.ts` + `scheduled_tasks` table | v2's `schedule_task` MCP tool with cron recurrence + timezone-aware `processAfter` |
| **Cross-board task forward (≤300s admin reply)** | `subtask_requests` table + text protocol `/aprovar abc123` | v2's `ask_user_question` MCP tool (admin DM card) |
| **Cross-board task forward (multi-day pending)** | `subtask_requests` table indefinite | `subtask_requests` STAYS fork-private (v2 has no multi-day approval primitive) + a `schedule_task` poller that re-asks via `ask_user_question` until answered |
| **Cross-board outbound routing** | Direct JID lookup + write to taskflow.db | `destinations` named-ACL + `send_message(to: 'audit-board', text: ...)` |
| **External meeting participant onboarding** | Operator-driven; reads taskflow.db; uses `dm-routing.ts` | Bot DMs the participant first → if unknown, `unknown_sender_policy='request_approval'` triggers admin card "Allow X for Meeting Y?" → on approve, `user_dms` row + scoped `agent_group_members` |
| **Board admin permission grant** | `is_primary_manager` column on `board_admins` table | `user_roles(user_id, role='admin', agent_group_id=<board>)` per memory `project_v2_user_roles_invariant.md` |
| **Task `/undo` (60s window)** | `task_history` table (fork-private) | `task_history` STAYS fork-private (v2 has no equivalent) — TaskFlow domain feature |
| **TaskFlow memory layer** | `add-taskflow-memory` skill (separate) | UNCHANGED — separate skill |
| **Agent prefix in shared-number mode** | Per-group `trigger_pattern` matched in `whatsapp.ts:550` echo-detection | CLAUDE.md prompts each board's agent to prefix outbound with the board's name (`Case: ...`); v2 ASSISTANT_HAS_OWN_NUMBER mode (one number per agent) avoids shared-prefix detection entirely if we set it up that way per board |

**What disappears entirely:**
- `src/task-scheduler.ts` (R1)
- `src/dm-routing.ts` (sender-approval covers it)
- `src/ipc.ts` + `src/ipc-plugins/*` (no IPC in v2)
- `src/sender-allowlist.ts` (`sender_scope='known'` covers it)
- `src/session-cleanup.ts` (v2's session-manager does it)
- `src/session-commands.ts` (`add-compact` upstream skill owns it)
- v1 `trigger_pattern` column + the routing logic that consumed it
- v1 `is_main` column + 169 isMain checks
- `Channel.createGroup` / `lookupPhoneJid` / `resolvePhoneJid` (operator + sender-approval cover it; `whatsapp-fixes` skill DELETED)

**What stays fork-private in `add-taskflow`:**
- TaskFlow domain logic in `taskflow-engine.ts`: Kanban state machine, WIP limits, task lifecycle (`add_task`, `move_task`, `update_task`, `cancel_task`, `add_note`, `add_subtask`, etc.) exposed as MCP tools
- `taskflow_groups` sidecar table (v2 has no equivalent for our 4 custom columns)
- `subtask_requests` table for multi-day cross-board approval
- `task_history` for 60s undo
- 8 meeting query views + meeting workflow state machine
- Cross-board mutation forwarding rule logic (preemptive forwarding to siblings)
- CLAUDE.md template (~400 lines, board-specific instructions)
- Daily auditor (Kipp) prompt + the heredoc audit script (NOTE: actually owned by `add-embeddings` skill)

## v2-aligned board provisioning flow

### Provisioning a NEW board (post-cutover UX)

```
┌──────────────────────────────────────────────────────────────┐
│  Operator                                                     │
└──────────────────────────────────────────────────────────────┘
   1. In WhatsApp, create new group "SECTI - General"
   2. Add the bot's number + the team members
   3. Send a message in the new group: "@<assistant> hi"

┌──────────────────────────────────────────────────────────────┐
│  Bot (v2 router + sender-approval module)                    │
└──────────────────────────────────────────────────────────────┘
   4. v2 router sees inbound from unknown messaging_group
      → unknown_sender_policy='request_approval' (set per-platform default)
   5. requestSenderApproval() → sends DM to operator (the global owner)
      with ask_user_question card:
        "Allow new group SECTI - General?"
        Options: ["Wire as TaskFlow board", "Allow as standalone", "Deny"]

┌──────────────────────────────────────────────────────────────┐
│  Operator                                                     │
└──────────────────────────────────────────────────────────────┘
   6. Replies "/wire-as-taskflow-board"

┌──────────────────────────────────────────────────────────────┐
│  TaskFlow (add-taskflow MCP tool: provision_taskflow_board)  │
└──────────────────────────────────────────────────────────────┘
   7. provision_taskflow_board MCP tool fires:
      a. create_agent("secti-general", instructions=<TaskFlow CLAUDE.md template>)
         → v2 creates agent_groups row + per-agent container directory
      b. INSERT messaging_group_agents (
              agent_group_id, messaging_group_id,
              engage_mode='pattern', engage_pattern='.',
              sender_scope='known', ignored_message_policy='accumulate'
         )
         → wires the SECTI WhatsApp group to the new agent
      c. INSERT user_roles for each pre-existing group member who's an admin:
            (user_id, role='admin', agent_group_id=<secti-board-id>)
      d. INSERT taskflow_groups (sidecar):
            (agent_group_id=<secti-board-id>, hierarchy_level=0, max_depth=2,
             holiday_calendar='BR-CE', custom-config-json)
      e. Init Kanban schema: 6 columns + WIP limits in board's per-agent SQLite
      f. Schedule daily/weekly tasks via schedule_task MCP tool:
            schedule_task(prompt='Kipp daily audit ...', recurrence='0 4 * * *')
            schedule_task(prompt='Morning standup ...', recurrence='0 9 * * 1-5')
            schedule_task(prompt='Evening digest ...', recurrence='0 18 * * 1-5')
            schedule_task(prompt='Weekly review ...', recurrence='0 16 * * 5')
      g. Reply to operator: "✅ Board created: secti-general (n admins, 4 schedules)"
```

**Key changes:** no `createGroup`, no `lookupPhoneJid`, no auto-add-participants. Humans handle the platform group; TaskFlow handles the agent + wiring + scheduling. UX cost: 2 manual steps (create group + add members) before TaskFlow provisioning.

### Migrating EXISTING 28 boards (cutover)

The migrate-v2 driver (`/root/nanoclaw-migrate-v2/setup/migrate/seed-v2.ts`) handles most of this — but per Codex review #5, it does NOT seed TaskFlow board admins → `user_roles`. Our migration step:

1. **migrate-v2 driver runs** → creates `agent_groups` + `messaging_groups` + `messaging_group_agents` rows for all 28 boards. Sets `engage_pattern='.'` + `sender_scope='known'` (per migrate-v2 source). The 28 WhatsApp groups already exist; no `createGroup` needed.
2. **TaskFlow post-migration script** (Phase A.3 deliverable in `add-taskflow/add/scripts/`):
   - For each board: read v1's `board_admins` table → INSERT `user_roles(user_id, role='admin', agent_group_id=<board-id>)` per memory `project_v2_user_roles_invariant.md`. NEVER scoped 'owner'.
   - Read v1's `taskflow_managed`+`taskflow_hierarchy_level`+`taskflow_max_depth`+`is_main` columns → INSERT `taskflow_groups` sidecar rows.
   - For each board's existing v1 `scheduled_tasks` rows → CALL `schedule_task` MCP tool to re-create as v2 schedules.
3. **operator smoke-test**: each board's daily/weekly schedules fire correctly; cross-board forwarding works; all admin commands respond.

## Cross-board approval flow

### Pattern 1: in-session prompt (≤300s)

Use case: bot is replying to operator and needs a quick yes/no before continuing.

```ts
// In a TaskFlow agent's CLAUDE.md prompt:
//   "If you need to confirm a critical action, call ask_user_question."

ask_user_question(
  title='Confirm bulk reassign',
  question='Reassign 12 tasks from Laizys to Carlos?',
  options=['yes', 'no'],
  timeout=60,
)
// Blocks ≤60s; on answer, returns the selected value.
```

Storage: v2's `pending_questions` table (transient).

### Pattern 2: multi-day cross-board approval (parent admin must approve a child board's request)

Use case: child board "audit-team" wants to forward a finding to parent board "secti-leadership"; the leadership board's admin has 3 days to approve/deny.

v2 has NO multi-day primitive (`ask_user_question` 300s default). So:

**TaskFlow keeps `subtask_requests` table fork-private** (in `add-taskflow/add/migrations/<NNN>-subtask-requests.sql`) but DRIVES it via v2 primitives:

1. Child board calls fork-private `forward_to_parent_with_approval` MCP tool.
2. Tool inserts row in `subtask_requests` (status='pending', created_at=now, expires_at=now+72h).
3. Tool calls `schedule_task` MCP tool — recurring every 12h until row is answered or expires:
   ```
   schedule_task(prompt='Re-ask cross-board approval for request <id>', recurrence='0 */12 * * *')
   ```
4. Each scheduled run calls `ask_user_question` (admin DM, 300s) → if answered, mark row as 'approved'/'denied' + cancel the recurrence + apply mutation. If timed out (no answer in 300s), the next 12h run re-asks.
5. After 72h: an end-of-window scheduled cleanup auto-denies + notifies child board.

This achieves multi-day approval using v2 primitives (`schedule_task` + `ask_user_question`) + a small fork-private table (`subtask_requests`) that just tracks the workflow state.

**Why we keep `subtask_requests`:** it carries TaskFlow-specific metadata (which task was forwarded, which parent it went to, what mutation it represents) that wouldn't fit in v2's generic `pending_questions`. The TABLE is fork-private; the WORKFLOW uses v2 primitives.

## External meeting participant onboarding

### Old flow (`dm-routing.ts`)

External participant DMs the bot → `dm-routing.ts` reads `taskflow.db` → finds participant in `meeting_external_participants` → routes message to the right TaskFlow board's session.

### New flow (v2 sender-approval)

External participant DMs the bot → v2 router sees unknown sender → `unknown_sender_policy='request_approval'` → `pending_sender_approvals` row + admin DM card:

```
"Unknown sender +5511999... wrote 'Hi, I'm Maria from FinDept'.
 Allow this contact?"
Options: ["Allow as meeting participant for Meeting M22", "Deny"]
```

On approve: TaskFlow MCP tool fires:
- INSERT `users(id='whatsapp:5511999...@s.whatsapp.net', display_name='Maria FinDept')`
- INSERT `user_dms(user_id, dm_messaging_group_id)` for the bot's DM with Maria
- INSERT `agent_group_members(user_id, agent_group_id=<related-board>)` so future DMs route correctly
- Reply via `replay_inbound` to deliver Maria's original message to the right board

**Net deletion:** `dm-routing.ts` (~250 LOC) + `meeting_external_participants` table can simplify substantially. The TaskFlow-specific bits (which meeting M-id, status='accepted'/'pending', access_expires_at) move into a smaller `meeting_externals` table that just tracks meeting↔external_user_id pairings. v2 handles the routing + permission.

## Permissions seeding

Per memory `project_v2_user_roles_invariant.md`:

```sql
-- For each board's pre-existing admins:
INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES
  ('whatsapp:5585999...@s.whatsapp.net', 'admin', '<board-agent-group-id>', '<operator>', '2026-XX-XX');
-- NEVER 'owner' with non-null agent_group_id (v2 forbids; isOwner() ignores those rows).
-- Single global owner = the platform operator.
```

Phase A.3 deliverable: `add-taskflow/add/scripts/seed-board-admins.ts` reads v1's `board_admins` table during cutover migration and INSERTs scoped 'admin' rows per the rule above.

## Engage pattern + sender scope

Per Codex review #5 + memory: every TaskFlow board's `messaging_group_agents` row is seeded with:

| Column | Value | Why |
|---|---|---|
| `engage_mode` | `'pattern'` | We want regex-based engagement, not @-mention based |
| `engage_pattern` | `'.'` | Always engage — every message in the group is for this board's agent. Per migrate-v2 driver convention. |
| `sender_scope` | `'known'` | Only known group members trigger the agent; unknown senders go through sender-approval flow |
| `ignored_message_policy` | `'accumulate'` | Even when not triggering, message context is preserved for next agent turn |

The agent's "name" (e.g., "Case", "Audit") is a CLAUDE.md prompt convention — the agent prefixes its outbound with `Case: ...`. The router doesn't drive this; the agent does.

**Why not `engage_pattern='@Case'`?** Per Codex review #5: setting that would DROP messages without the literal mention, breaking production traffic.

## Scheduling migration (R1 adoption)

For each existing v1 `scheduled_tasks` row (Kipp daily 04:00, digest evening, standup morning, weekly review Friday):

```ts
// add-taskflow/add/scripts/migrate-scheduled-tasks.ts
for (const task of v1ScheduledTasks) {
  await scheduleTaskMcpTool({
    prompt: task.prompt,
    processAfter: nextRunAfter(task.cron),  // ISO 8601 in user TZ
    recurrence: task.cron,
    script: task.script ?? null,             // pre-agent hook (Kipp uses one)
  });
}
```

v2's `schedule_task` is timezone-aware (interprets naive ISO timestamps in `<context timezone="..."/>`). Our boards' TZ is `America/Fortaleza`.

**Caveat (Codex #5 R1 finding):** v2's recurrence uses `cron-parser.next()` from "now," not from prior scheduled time. Missed windows during downtime are SKIPPED. Our v1 task-scheduler does catch-up. **Decision needed:** is missed-run catch-up required for Kipp/digest/standup? If yes, fork-private wrapper in TaskFlow that:
  - On host boot, scans v1 `scheduled_tasks` for any whose `last_run + interval < now`.
  - For each, fire a one-shot `schedule_task(processAfter=now+5s)` to catch up.

This is a small ~50-LOC fork-private helper that doesn't conflict with v2's design.

## MCP tool inventory (what `add-taskflow` contributes)

Each TaskFlow domain operation gets exposed as an MCP tool the agent can call. Lives in `add-taskflow/add/container/agent-runner/src/mcp-tools/taskflow.ts` registered alongside v2's stock tools.

**Board-management tools (admin-only):**

| MCP tool | Purpose | Calls v2 primitive? |
|---|---|---|
| `provision_taskflow_board` | Wire an existing messaging_group as a TaskFlow board | Yes — `create_agent`, INSERT `messaging_group_agents`, `schedule_task` ×4 |
| `archive_taskflow_board` | Decommission a board (preserve data, stop schedules) | Yes — `cancel_task` for all board schedules |
| `add_board_admin` | Promote a member to admin | Yes — INSERT `user_roles` |
| `remove_board_admin` | Demote an admin | Yes — DELETE from `user_roles` |

**Kanban tools (any board member):**

| MCP tool | Purpose |
|---|---|
| `add_task` | Create task in Inbox column |
| `move_task` | Move task between columns |
| `update_task` | Edit title/priority/labels/description |
| `cancel_task` | Soft-delete (60s undo via task_history) |
| `add_note` / `update_note` / `remove_note` | Task notes |
| `set_due_date` | Set/change/clear due date (skip-non-business-days option) |
| `bulk_reassign` | Reassign N tasks from A to B in one call |
| `add_subtask` / `remove_subtask` | Subtask management |

**Cross-board tools (preemptive forwarding):**

| MCP tool | Purpose |
|---|---|
| `forward_to_parent` | Send mutation to parent board (no approval needed for sibling-rule cases) |
| `forward_to_parent_with_approval` | Multi-day approval workflow (uses subtask_requests + schedule_task + ask_user_question) |

**Meeting tools:**

| MCP tool | Purpose |
|---|---|
| `add_meeting_participant` (internal) | Add a board member to an existing meeting |
| `add_meeting_participant_external` | Initiates sender-approval flow for an external person |
| `remove_meeting_participant` | Remove from meeting |
| `transition_meeting` | State machine: planned → confirmed → in_progress → done |
| `set_meeting_note_status` | Pre/meeting/post note triage |

**Query tools (read-only):**

| MCP tool | Purpose |
|---|---|
| `list_tasks` (filtered by column/assignee/etc.) | Kanban view |
| `list_meetings` (8 view-shaped variants) | Upcoming, today, overdue, by status, etc. |
| `task_history` | Audit trail per task |

Total: ~25-30 MCP tools. Consolidates v1's CLAUDE.md natural-language router into typed tool calls.

## File ownership in `add-taskflow` skill

```
.claude/skills/add-taskflow/
├── manifest.yaml                                    # core_version, adds, modifies, depends, tests
├── SKILL.md                                         # orchestration + rationale
├── CHANGELOG.md
├── add/                                             # NET-NEW files installed
│   ├── container/agent-runner/src/mcp-tools/
│   │   └── taskflow.ts                              # 25-30 MCP tool registrations
│   ├── container/agent-runner/src/
│   │   └── taskflow-engine.ts                       # domain logic (Kanban, WIP, lifecycle)
│   ├── add/scripts/
│   │   ├── seed-board-admins.ts                     # cutover-time user_roles seeder
│   │   ├── migrate-scheduled-tasks.ts               # v1 → schedule_task converter
│   │   └── apply-engage-config.sql                  # set engage_pattern='.' on all boards
│   └── data/migrations/
│       ├── 001-taskflow-groups-sidecar.sql          # 4 custom columns
│       ├── 002-subtask-requests.sql                 # multi-day approval workflow
│       ├── 003-task-history.sql                     # 60s undo
│       └── 004-meeting-externals.sql                # meeting↔external user pairings
├── modify/                                          # SURGICAL EDITS to upstream
│   ├── container/agent-runner/src/mcp-tools/index.ts.intent.md
│   │   # describes "register taskflow.ts MCP tools alongside v2 stock"
│   └── (NO FULL-FILE COPIES — per "no-byte-duplication" rule)
├── templates/
│   └── CLAUDE.md.template                           # board-specific agent prompts
└── tests/
    ├── taskflow.test.ts                             # MCP tool unit tests
    ├── seed-board-admins.test.ts
    └── cross-board-forward.test.ts
```

**Key constraints (per memory `feedback_use_v2_natives_dont_duplicate.md`):**
- NO `modify/<path>.ts` files containing duplicated upstream content. Only `.intent.md` files describing surgical edits.
- All net-new files in `add/` (no upstream equivalent exists).

## CLAUDE.md.template updates

The board-agent CLAUDE.md prompt evolves to:

- Reference TaskFlow MCP tools by name (instead of natural-language SQLite instructions).
- Include "agent prefix" instruction: `Always start your messages with "<board-name>: "` for shared-number echo detection.
- Reference v2 primitives directly: "Use `ask_user_question` for confirmations." "Use `send_message(to: '<dest>')` for cross-board."
- Drop instructions about `/aprovar`, `/cancelar` text protocols (replaced by ask_user_question cards).
- Add timezone declaration: `<context timezone="America/Fortaleza"/>` so `schedule_task` interprets naive timestamps correctly.

Estimated template size: ~300 lines (down from v1's ~400). MCP tools eliminate natural-language SQL routing.

## Test plan

- **Unit tests** for each MCP tool (in `tests/taskflow.test.ts`): given mock DB state + tool args, verify correct DB mutations + return shape.
- **Integration tests** for board provisioning: spin up a v2 worktree + apply add-taskflow + invoke `provision_taskflow_board` → verify agent_groups + messaging_group_agents + scheduled_tasks rows + Kanban schema initialized.
- **Cross-board forward test**: child board calls `forward_to_parent_with_approval` → verify subtask_requests row + schedule_task scheduled + ask_user_question card delivered to admin DM.
- **Seeder test**: run `seed-board-admins.ts` against a v1 snapshot → verify user_roles rows match v1 board_admins (1:1, scoped 'admin', not 'owner').
- **Schedule migration test**: run `migrate-scheduled-tasks.ts` → verify each v1 scheduled_tasks row produces an equivalent schedule_task call.

## Open design questions

**Q1. Catch-up for missed schedules.** Codex #5 found v2's `schedule_task` skips missed windows during downtime. Is catch-up required for Kipp/digest/standup? If yes, ~50-LOC fork-private wrapper. If no, accept skipped runs as an operational improvement (no zombie audits trying to catch up after multi-day outages).

**Q2. Engage pattern: `'.'` vs more specific.** Per Codex #5, migrate-v2 uses `'.'` (always engage). For boards where the agent SHOULDN'T respond to off-topic group chatter, would `'.+'` or a board-specific regex (`@<board>|/<command>`) be better? Affects ignored_message_policy interaction.

**Q3. Multi-agent in shared-number mode.** If 28 boards share one WhatsApp number, v2's `isBotMessage = content.startsWith(\`${ASSISTANT_NAME}:\`)` echo-detection only catches the global ASSISTANT_NAME prefix. Either (a) each agent sets `ASSISTANT_HAS_OWN_NUMBER=true` (separate WhatsApp number per board — operationally expensive), or (b) we add a fork-private "agent-prefix-aware echo detection" patch (small, would benefit upstream as a PR). Decision needed.

**Q4. `taskflow_groups` sidecar table location.** v2's session DB is per-session. Our `taskflow_groups` is per-board (per-agent_group). Does it live in the central `data/v2.db` or in each board's per-agent SQLite? Probably central, as a v2 module would do. Design needs confirmation.

**Q5. CLAUDE.md template per-board variation.** Currently each TaskFlow board has slight customizations (timezone, holiday calendar, board name). Where does the per-board variation live? Options: (a) generated at provisioning time and copied into `groups/<folder>/CLAUDE.md`, (b) static template + runtime-substituted via context preamble. v2's `init-first-agent` skill uses (a). Likely the right pattern for us.

**Q6. Migration of existing 28 boards' `scheduled_tasks` rows.** v1's scheduled_tasks include trigger_message_id/trigger_chat_jid/trigger_sender for replay (per memory). v2's schedule_task doesn't have those fields. Do we lose attribution at cutover? Or do we add fork-private metadata to v2 schedules?

## Effort estimate (revised)

Per Codex #5 + this redesign:

- Phase A.3 (this skill) total: **3-4 weeks** (was 3 weeks in v3.0; +0-1 week for the redesigned board-provisioning flow + sender-approval onboarding).
- Net `add-taskflow` size after extraction: **10-12K LOC** (was 18-20K under previous estimate). Bigger reductions because:
  - `dm-routing.ts` largely absorbed by v2 sender-approval (~250 LOC saved).
  - `task-scheduler.ts` deleted (~500 LOC saved).
  - Board provisioning IPC plugins replaced by MCP tools that call v2 primitives (~1500 LOC of v1 IPC orchestration → ~500 LOC of MCP tool definitions).
  - `subtask_requests` workflow becomes much thinner (state table + 3 small handlers vs ~600 LOC of v1 workflow).
- `whatsapp-fixes` skill: **DELETED** (Phase A.2 reversed; no fork-private channel extensions).

Total Track A (revised): **6-9 weeks** (was 7-8 in v3.0; net similar; redesign work offsets eliminated whatsapp-fixes).

## What this spec does NOT yet cover (deferred to plan)

- TDD test breakdown per MCP tool (will be in the executable plan)
- Exact MCP tool input/output schemas (table sketches above; full Zod schemas in plan)
- Exact migration of existing 28 boards' state (per-board script vs bulk script)
- `add-taskflow/manifest.yaml` final structure
- Schema migrations exact SQL (sketched; full SQL in plan)
- CLAUDE.md template diff vs v1

## Recommendation

Approve this spec, then I:
1. Author the Phase A.3 implementation plan (`docs/superpowers/plans/2026-05-02-phase-a3-add-taskflow-v2-native.md`) — broken into TDD-shaped tasks.
2. Run a Codex skeptical review of the plan before execution.
3. Begin Phase A.3 execution per the writing-plans + executing-plans skills.

The 6 open design questions (Q1-Q6) need answers before the plan can be authored. I'll surface them in our next exchange.
