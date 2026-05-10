# Tier A1 — Feature Parity Inventory

**Started:** 2026-05-10
**Source data:** 14 days of prod sessions across 29 boards (`/tmp/v2-pilot/all-sessions/`)
**v1 tool surface:** 15 distinct MCP tools used in production
**v2 tool surface:** 30 MCP tools defined on `skill/taskflow-v2` branch

## 1. MCP tool mapping

### Direct name match (4 of 15)

| v1 tool | v2 tool | Status |
|---|---|---|
| `mcp__nanoclaw__list_tasks` | `list_tasks` | ✓ Direct match |
| `mcp__nanoclaw__schedule_task` | `schedule_task` | ✓ Direct match |
| `mcp__nanoclaw__send_message` | `send_message` | ✓ Direct match |
| `mcp__nanoclaw__update_task` | `update_task` | ✓ Direct match |

### Refactored — capability consolidated or split (8 of 15)

| v1 tool | v1 prod calls (14d) | v2 equivalent(s) | Mapping notes |
|---|---|---|---|
| `taskflow_update` | 121 | `api_update_simple_task` (covers update + move + reassign per description) | Update + move + reassign consolidated into one tool |
| `taskflow_move` | 53 | `api_update_simple_task` (same as above) | Subsumed by api_update_simple_task |
| `taskflow_reassign` | 4 | `api_update_simple_task` (same as above) | Subsumed |
| `taskflow_query` | 226 | `api_board_activity` + `api_filter_board_tasks` + `api_linked_tasks` | Split into 3 specific query tools |
| `taskflow_create` | 33 | `api_create_simple_task` | v1 covered create-task and create-meeting; v2 only has simple — meeting create path TBD |
| `taskflow_admin` | 81 | `provision_root_board`, `provision_child_board`, `create_group`, `add_destination`, `cancel_task`, `pause_task`, `resume_task` | Admin split into specific provisioning tools |

### POTENTIALLY MISSING — need investigation (3 of 15)

| v1 tool | v1 prod calls (14d) | Status | Investigation needed |
|---|---|---|---|
| `taskflow_report` | 44 | ⚠️ No direct MCP tool in v2 | Engine method `engine.report()` exists (verified earlier: 462 prod calls replayed cleanly through it). But no MCP tool wraps it. How does Claude invoke board reports in v2? Possible answers: (a) `api_board_activity` covers this, (b) v2's CLAUDE.md doesn't use a report tool — it composes from filter calls, (c) it's a real gap. |
| `taskflow_dependency` | 0 in seci, unknown elsewhere | ⚠️ No v2 tool | Used for setting blocked_by relationships. v2's `api_update_simple_task` may cover via the `updates.blocked_by` field. Need to verify. |
| `taskflow_hierarchy` | 1 call | ⚠️ Probably covered by `api_linked_tasks` | api_linked_tasks description "Board linked tasks" — likely the v2 equivalent. |

### External / cross-skill tools (2 of 15)

| v1 tool | v2 equivalent | Status |
|---|---|---|
| `mcp__sqlite__read_query` | `nanoclaw` tool (TBD) | v2 has a `nanoclaw` tool — likely the new structured ncl CLI. Raw SQL may have been deliberately removed in favor of structured queries. |
| `memory_recall` | `add-taskflow-memory` skill (separate) | Fork-private skill, separate MCP server. Not part of v2 taskflow MCP. |

### v2-only tools (no v1 prod usage) — 25 tools

These exist in v2 but aren't seen in v1 prod traffic. Most are operational/admin:
- `add_destination`, `add_mcp_server`, `add_reaction`, `ask_user_question`
- `cancel_task`, `pause_task`, `resume_task` (task lifecycle)
- `create_agent`, `create_group`, `provision_child_board`, `provision_root_board` (provisioning)
- `edit_message` (chat editing)
- `install_packages` (self-mod, requires approval)
- `nanoclaw` (admin CLI bridge)
- `send_card`, `send_file` (richer delivery)
- `send_otp` (auth flow)
- Plus the 7 api_* tools we've already mapped

## 2. Action items before Tier A1 can be marked complete

| # | Action | Effort | Status |
|---|---|---|---|
| AI-1 | Confirm `api_update_simple_task` covers move + reassign | 1h | Verified — description: "(field updates, column move, reassign)" |
| AI-2 | Determine `taskflow_report` v2 MCP exposure | 2h | **CONFIRMED MISSING** — see Section 6 |
| AI-3 | Verify `api_linked_tasks` covers `taskflow_hierarchy` | 30min | Likely yes per description "Board linked tasks" |
| AI-4 | Determine fate of `taskflow_dependency` | 30min | Probably folded into `api_update_simple_task.updates.blocked_by` |
| AI-5 | Document `nanoclaw` MCP tool | 30min | **It's not a tool** — it's the server name (`Server({name: 'nanoclaw'})` in server.ts) |
| AI-6 | Confirm `add-taskflow-memory` has `memory_recall` equivalent | 30min | TBD — separate skill |
| AI-7 | Verify meeting-type task creation in v2 | 1h | TBD |

## 6. CRITICAL FINDING — runner prompts reference non-existent SQLite MCP tools

**Evidence:**

v2's STANDUP_PROMPT (in `src/modules/taskflow/provision-shared.ts` on skill/taskflow-v2):
> "[TF-STANDUP] You are running the morning standup for this group. **Query the board from /workspace/taskflow/taskflow.db using the SQLite MCP tools — SELECT from tasks, board_people, board_config for your board_id.** If no tasks exist on your board AND no parent-board tasks are assigned to your people, do NOT send any message — just perform housekeeping (archival) silently and exit. Otherwise: 1) Send the Kanban board to this group via send_message (grouped by column, show overdue with 🔴). 2) Include per-person sections in the group message with their personal board, WIP status (X/Y), and prompt for updates. 3) Check for tasks with column = 'done' and updated_at older than 30 days — INSERT them into archive and DELETE from tasks. 4) List any inbox items that need processing."

**Problem:** v2's MCP registry exposes the following tools (verified from `container/agent-runner/src/mcp-tools/*.ts` on skill/taskflow-v2):

```
add_destination, add_mcp_server, add_reaction, api_board_activity,
api_create_simple_task, api_delete_simple_task, api_filter_board_tasks,
api_linked_tasks, api_task_add_note, api_task_edit_note, api_task_remove_note,
api_update_simple_task, ask_user_question, cancel_task, create_agent,
create_group, edit_message, install_packages, list_tasks, pause_task,
provision_child_board, provision_root_board, resume_task, schedule_task,
send_card, send_file, send_message, send_otp, update_task
```

**No `mcp__sqlite__*` tool.** No raw-SQL tool. No exposure of `engine.report()`.

The standup runner expects to "SELECT from tasks, board_people, board_config" — Claude will try to call a SQLite tool that doesn't exist and the runner will fail.

**Impact:**
- standup runner: BROKEN
- digest runner: BROKEN (same pattern)
- weekly review runner: BROKEN (same pattern)
- These are the 3 daily-fire runners on all 28 boards. ~84+ daily firings across prod.

**Engine method `engine.report()` exists** (verified earlier: 462 prod calls replayed cleanly through it in the read-side validation), but **it's orphaned** — no MCP tool wraps it. The replay test bypassed the MCP layer and called the engine method directly, which is why the gap wasn't caught earlier.

**Possible fixes (need product decision):**

**Option F1: Add v2 MCP wrapper for `engine.report()`**
- Add `api_board_report` (or similar) MCP tool that calls `engine.report({type})`
- Update runner prompts to call this tool
- Effort: 4-6h (tool definition + handler + tests + prompt updates)
- Pro: Preserves v1's "one structured report call" pattern that Claude finds easy to use
- Con: Adds back complexity that v2's refactor tried to remove

**Option F2: Expose SQLite MCP tool**
- Wire an SQLite MCP server alongside the nanoclaw server (as v1 did)
- Add `mcp__sqlite__read_query` to v2
- Pro: STANDUP_PROMPT works as-is
- Con: Re-introduces raw SQL surface that v2's structured API was designed to replace

**Option F3: Rewrite runner prompts to use api_* tools**
- Update STANDUP_PROMPT, DIGEST_PROMPT, REVIEW_PROMPT to use `api_filter_board_tasks` + `api_board_activity` + `api_linked_tasks` instead of raw SQL
- Effort: 1-2 days (prompt design + per-runner testing)
- Pro: Aligns with v2's design intent (no raw SQL)
- Con: Prompts get longer (must compose from multiple tool calls) — more LLM turns per runner

**Recommended:** F1 (re-expose engine.report via MCP) — preserves runner UX without re-introducing raw SQL. Cleanest path to behavior parity with v1.

This blocker is more severe than the A5 CLAUDE.md regeneration finding because even AFTER regenerating CLAUDE.md with new tool names, the runner prompts ALSO reference non-existent SQLite tools.

**Updated A1 conclusion:** v2's MCP tool surface is INCOMPLETE for the runner use case. This is a Tier A hard blocker that must ship before cutover.

Total Tier A1 status: ~60% complete. SQL table inventory + CLAUDE.md walk still pending.

## 3. SQL table inventory (PARTIAL — done 2026-05-10)

### v1 prod tables
- `taskflow.db`: 27 tables (boards, tasks, board_people, archive, task_history, board_chat, users, sessions, organizations, org_members, org_invites, board_admins, board_config, board_runtime_config, board_groups, board_holidays, board_id_counters, child_board_registrations, external_contacts, meeting_external_participants, subtask_requests, agent_heartbeats, csp_reports, attachment_audit_log, otp_requests, people, revoked_tokens)
- `messages.db`: 11 tables (agent_turn_messages, agent_turns, chats, messages, outbound_messages, registered_groups, router_state, scheduled_tasks, send_message_log, sessions, task_run_logs)

### v2 schema
- Host bootstraps 15 TaskFlow tables (via `src/taskflow-db.ts` on skill branch): archive, attachment_audit_log, board_admins, board_config, board_groups, board_holidays, board_id_counters, board_people, board_runtime_config, boards, child_board_registrations, external_contacts, meeting_external_participants, task_history, tasks
- Engine creates 5 more on first use (via `container/agent-runner/src/taskflow-engine.ts`): board_holidays, board_id_counters, external_contacts, meeting_external_participants, subtask_requests
- Central DB (`data/v2.db`): agent_groups, messaging_groups, messaging_group_agents, user_roles, agent_group_members, pending_approvals, agent_destinations, dropped_messages, sessions, container_configs, etc.
- Per-session: `inbound.db` (messages_in + routing) + `outbound.db` (messages_out + session_state)

### v1 tables not present in v2 host schema (12)

| Table | v1 rows | Status / risk |
|---|---|---|
| `board_chat` | 224 | **REAL GAP** — 0 references in v2 source. v1 logs agent outputs here; v2 doesn't. Any consumer of board_chat will return empty after migration. |
| `users` | 33 | Probably mapped: v2 has `src/modules/permissions/db/users.ts` (central DB user table). Need to verify migration script transforms v1 users → v2 users + user_roles. |
| `sessions` | 18 | v1's auth/session tracking. v2's `sessions` is different concept (agent_group×messaging_group session routing). v1 sessions table appears legacy; need migration verification. |
| `organizations` | 2 | Multi-tenant org model. v2 has no `organizations` — its entity model is users + agent_groups + messaging_groups. Need product decision: are orgs required? |
| `org_members` | 5 | Same as above. |
| `org_invites` | 2 | Same as above. |
| `agent_heartbeats` | 0 | Unused in prod. v2 uses file-touch heartbeat instead (per memory). Safe. |
| `csp_reports` | 0 | Web frontend security reports. Unused. Safe. |
| `otp_requests` | 0 | v2 has its own send_otp/pending_otp flow. Verify migration not needed. |
| `people` | 0 | Empty; data lives in board_people instead. Safe. |
| `revoked_tokens` | 0 | Unused. Safe. |
| `subtask_requests` | 0 | Empty in prod — cross-board subtask approval. v2 engine creates this table lazily. Safe. |

### Real schema gaps to address before cutover

**A7 (new blocker) — `board_chat` not written by v2:**
- 224 rows in prod, actively populated by v1's `appendAgentOutputToBoardChat()` in `src/index.ts`
- v2 source has zero `board_chat` references
- Impact: post-cutover, agent outputs aren't logged. Any feature reading this table (board history, board-level audit) silently returns empty.
- Fix: either (a) port `appendAgentOutputToBoardChat` to v2 host's delivery path, or (b) document that v2 deliberately drops board_chat and update any downstream consumers.

**A8 (new — migration question) — multi-tenant org model:**
- v1 has `organizations / org_members / org_invites` (small but live data)
- v2 has no equivalent — entity model is users + agent_groups + messaging_groups
- Migration question: how do v1 orgs map to v2 agent_groups? Each org → one agent_group? Or are orgs irrelevant in the v2 model?
- Effort to decide: 1-2h with product owner.

**A9 (new — migration verification) — users/sessions mapping:**
- v1 `users` (33 rows) and `sessions` (18 rows) need explicit v2 mapping
- v2 entity model has user_roles, agent_groups, agent_group_members, messaging_groups — different shape
- Migration script (`bash migrate-v2.sh`) must transform v1 users → v2 user_roles + agent_group_members. Verify in Tier A3.

## 4. CLAUDE.md instruction inventory (TODO)

For each board, walk per-board CLAUDE.md and verify every instruction maps to a v2 code path. Per-board because boards have customized CLAUDE.md content.

## 5. Skill enablement inventory (TODO)

Per prod board, list which fork-private skills are enabled (add-taskflow-memory, whatsapp-fixes, add-long-term-context, add-reactions, etc.) and verify v2 install paths exist for each.

---

## Findings so far

✅ **Read-side** (verified earlier): 100% same-shape across 623 prod tool calls
✅ **Mutation paths** (verified earlier on 10-slice): engine methods exist + work correctly
⚠️ **MCP tool surface diverges**: v2 refactored. Aggregate functionality appears preserved, but the **internal tool names Claude calls have changed**. CLAUDE.md per-board files MUST tell Claude the new tool names — or Claude will try old names and fail.

**Critical pre-cutover check:** every per-board CLAUDE.md must be regenerated for v2 with the new tool names. The skill copies forward the v1 CLAUDE.md, but the tool-call instructions inside it reference `taskflow_query`, `taskflow_report`, `taskflow_move`, `taskflow_reassign`, `taskflow_update`. These names don't exist in v2's MCP registry. The board agents will fail to find the tools without a CLAUDE.md regeneration step.

This is a **Tier A blocker** for cutover that wasn't in the readiness checklist. Adding it.
