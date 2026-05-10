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
| `organizations` | 2 | **Dead schema.** Both rows are E2E test fixtures (slugs `e2e-org-test`, `test-org-qa`). Zero refs in v1 prod engine, MCP surface, board CLAUDE.md, or any session corpus. v2 migrator can drop silently. See A8 closed-as-not-a-blocker (2026-05-10). |
| `org_members` | 5 | Same — all 5 reference the two E2E orgs. Drop silently. |
| `org_invites` | 2 | Both phone-based, both expired 2026-04-09. Drop silently. |
| `agent_heartbeats` | 0 | Unused in prod. v2 uses file-touch heartbeat instead (per memory). Safe. |
| `csp_reports` | 0 | Web frontend security reports. Unused. Safe. |
| `otp_requests` | 0 | v2 has its own send_otp/pending_otp flow. Verify migration not needed. |
| `people` | 0 | Empty; data lives in board_people instead. Safe. |
| `revoked_tokens` | 0 | Unused. Safe. |
| `subtask_requests` | 0 | Empty in prod — cross-board subtask approval. v2 engine creates this table lazily. Safe. |

### Real schema gaps to address before cutover

**A7 (CLOSED 2026-05-10 — deferred to tf-mcontrol-deploy) — `board_chat` write path:**
- Investigated 2026-05-10. `board_chat` last write was 2026-04-02 (~38 days ago); active `task_history` last write was 2026-05-08 (~2 days ago). Sample senders are all QA fixtures (`QA-Validator`, `PF-Test`, `QA-R22-debug-*`, `badge-test-*`).
- The reader is tf-mcontrol's dashboard (`taskflow-dashboard/src/components/BoardChat.tsx`, polls `/chat` every 5s). tf-mcontrol is **not deployed to prod** (`ls ~/tf-mcontrol` fails on remote `192.168.2.63`).
- The `send_board_chat` MCP tool that v1 used appears only in legacy `data/sessions/*/agent-runner-src/ipc-mcp-stdio.ts` IPC stubs — not in any active v2 skill. **0 calls in 14d of prod session corpora**.
- **Decision: not a v2-cutover blocker.** When tf-mcontrol deploys, add `send_board_chat` MCP tool (or wire the dashboard to consume agent responses on a different channel) — that's a tf-mcontrol-deploy gate, not a v2-cutover gate.
- See memory `project_v2_a7_phantom_blocker.md` for the searches and evidence.

**A8 (CLOSED 2026-05-10) — multi-tenant org model — phantom blocker:**
- Investigated 2026-05-10. v1 has the schema but it is dead code. Searches in v1 prod's taskflow-engine.ts, MCP tool surface, board CLAUDE.md, all 3 session corpora, migrate-v2.sh, and setup/migrate-v2/ all returned **zero** references.
- The 2 organizations rows are E2E test fixtures (slugs `e2e-org-test`, `test-org-qa`). The 2 org_invites are both expired 2026-04-09. The 5 org_members reference only the test fixtures.
- **Decision: drop silently in v2 migrator.** No migration logic needed.
- Effort consumed: ~15 min investigation, 0h code. Tier A blocker count: 10 → 9.
- See memory `project_v2_a8_phantom_blocker.md` for the searches and evidence.

**A9 (new — migration verification) — users/sessions mapping:**
- v1 `users` (33 rows) and `sessions` (18 rows) need explicit v2 mapping
- v2 entity model has user_roles, agent_groups, agent_group_members, messaging_groups — different shape
- Migration script (`bash migrate-v2.sh`) must transform v1 users → v2 user_roles + agent_group_members. Verify in Tier A3.

## 4. Per-board CLAUDE.md inventory (DONE 2026-05-10)

37 board CLAUDE.md files cloned from prod (28 active + 9 test/seed). Every single board references v1 tool names AND SQLite MCP tools.

**Revised 2026-05-10 (deeper inspection):**
- All 37 files have **distinct md5 hashes** — not a clean template set; each board is personalized.
- Size: ~125-126 KB per file. Tool refs: median 198 per board, max 225, min 0.
- v1 tool refs are embedded in **workflow language** with full call signatures (e.g. `taskflow_move({task_id, action: 'review', sender_name: SENDER})`), not as standalone identifiers. Text substitution is not viable.

**Critical finding — A5 is downstream of missing MCP tools (A11):** v2 lacks MCP exposure for `taskflow_move`, `taskflow_reassign`, `taskflow_admin`, `taskflow_undo`, `taskflow_report`, `taskflow_hierarchy`, and `taskflow_dependency`. The engine methods exist but no MCP wrappers exist. Rewriting CLAUDE.md to use only v2's current surface (`api_update_simple_task`, `api_filter_board_tasks`, etc.) would regress agent capabilities (no state-machine moves, no reparenting, no undo, no reports). See memory `project_v2_a5_blocked_on_missing_mcp_tools.md`.

| Variant (rough) | Boards | v1 tool refs | sqlite_ref |
|---|---|---|---|
| Parent / SECTI-level | 12 | ~221 each | 5 each |
| SEAF / GE-sup | 6 | ~196 each | 4 each |
| Subordinate boards | 11 | ~185 each | 4 each |
| sm-setd / hudson / edilson | 3 | 183 | 4 |
| infra-setd-secti | 1 | 187 | 4 |

(Variants are statistical proxies — every file is still individually personalized.)

A5 confirmed at full scale: all 37 boards need CLAUDE.md regen before cutover.
A6 confirmed at full scale: all 37 boards reference SQLite MCP tools (4-5 refs each).

## 5. Skill enablement inventory (DONE 2026-05-10)

**Discovery:** Every board's `groups/<folder>/.mcp.json` declares the `sqlite` MCP server:

```json
{
  "mcpServers": {
    "sqlite": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-sqlite-npx", "/workspace/taskflow/taskflow.db"]
    }
  }
}
```

All 30 boards have this `.mcp.json` (verified by SSH `for d in groups/*/; do ...`).

**Critical finding — `migrate-v2.sh` does NOT carry forward `.mcp.json`:**
- v2's `container_configs.mcp_servers` JSON column exists (the v2.0.48 DB-backed config — line 13 of `src/db/container-configs.ts`)
- `setup/migrate-v2/*.ts` files (db.ts, groups.ts, shared.ts) have **zero** references to `.mcp.json`, `mcpServers`, `mcp_servers`, or `sqlite`
- Result: migrated v2 board containers start WITHOUT the sqlite MCP server → CLAUDE.md's `mcp__sqlite__read_query` references resolve to "Unknown tool" at runtime

This refines A6 root cause:
- **Original A6:** v2 has no MCP wrapper for engine.report() → standup runners fail
- **Refined:** v2's runner prompts could call SQLite tools IF the sqlite MCP server were wired per board. v1 wires it via `.mcp.json`. v2 should wire it via `container_configs.mcp_servers` — but migrate-v2 doesn't populate that column. **Fix is in the migration script, not v2's MCP registry.**

**Refined A6 fix (smaller):** modify `setup/migrate-v2/db.ts` to read each v1 board's `.mcp.json` and seed the matching `container_configs.mcp_servers` row. ~1-2h instead of 4-6h.

## 6. Meeting-type task creation (DONE 2026-05-10)

**A10 (new blocker):** v2 has no MCP exposure for meeting-type task creation.

- `engine.create()` supports `type: 'meeting'` (verified — code has `if (params.type === 'meeting' && params.participants) {...}`)
- `api_create_simple_task` MCP tool schema rejects this: only `title`, `assignee`, `priority`, `due_date`, `description` allowed. No `type`, `participants`, or `scheduled_at` fields.
- Production has meeting tasks across 3+ boards (board-thiago-taskflow has 16 alone).

**Fix options:**
- F1: Add `api_create_meeting_task` MCP tool with `participants` + `scheduled_at` + `type='meeting'`
- F2: Extend `api_create_simple_task` to accept `type` + `participants` + `scheduled_at` (rename to `api_create_task`)
- F3: Document workaround — meetings created via direct DB write (regression from v1's chat-driven flow)

Effort: 3-4h for F1 or F2.

## Final A1 summary

| Sub-task | Status | Blockers found |
|---|---|---|
| MCP tool inventory | ✅ Done | A5 (CLAUDE.md regen), A6 (runner sqlite refs) |
| Runner prompt surface | ✅ Done | A6 (deeper investigation) |
| SQL table inventory | ✅ Done | A7 (board_chat), A8 (orgs), A9 (users/sessions) |
| Per-board CLAUDE.md walk | ✅ Done | All 37 boards confirmed for A5, A6 |
| Skill enablement per-board | ✅ Done | A6 refined fix (migration script change, 1-2h) |
| Meeting-type creation | ✅ Done | A10 (new — meeting MCP exposure) |

**A1 status: 100% complete.**

## Final Tier A blocker list (9 must-pass items; A7 and A8 closed)

| # | Blocker | Effort | Status | Source |
|---|---|---|---|---|
| A1 | Feature parity inventory | 4-8h | ✅ DONE 2026-05-10 | original |
| A2 | Mutation parity (full 235 corpus) | 1-2 days | pending | original |
| A3 | Migration safety | 2-3 days | pending | original |
| A4 | Rollback verified | 1 day | pending | original |
| A5 | Per-board CLAUDE.md regeneration | 1-2 days | **blocked on A11** | A1.4 |
| A6 | Migration carries forward .mcp.json (refined) | 1-2h | ✅ DONE 2026-05-10 (commits 995b3211 → a798557d → 714b5b78) | A1.5 |
| ~~A7~~ | ~~board_chat not written by v2~~ | ~~4-6h~~ | ✅ CLOSED 2026-05-10 — deferred to tf-mcontrol-deploy | A1.3 |
| ~~A8~~ | ~~Multi-tenant org model migration~~ | ~~1-2h~~ | ✅ CLOSED 2026-05-10 — phantom blocker, dead schema | A1.3 |
| A9 | users/sessions migration mapping | (verified in A3) | pending | A1.3 |
| A10 | Meeting-type task MCP exposure | 3-4h | pending | A1.6 |
| **A11** | **Build missing v2 MCP tools (taskflow_move, taskflow_reassign, taskflow_admin, taskflow_undo, taskflow_report, taskflow_hierarchy, taskflow_dependency)** | **1-2 weeks** | pending | A1.4 |

**Remaining Tier A engineering:** A11 (1-2w) → A5 (1-2d) + A10 (3-4h). A2-A4 validation (~5-6d). **Total: ~2-3 weeks** to clear Tier A (revised up from 8-10 days because A11 surfaced).

Total realistic timeline to production: **14-17 weeks** (revised up from 12-15).

---

## Findings so far

✅ **Read-side** (verified earlier): 100% same-shape across 623 prod tool calls
✅ **Mutation paths** (verified earlier on 10-slice): engine methods exist + work correctly
⚠️ **MCP tool surface diverges**: v2 refactored. Aggregate functionality appears preserved, but the **internal tool names Claude calls have changed**. CLAUDE.md per-board files MUST tell Claude the new tool names — or Claude will try old names and fail.

**Critical pre-cutover check:** every per-board CLAUDE.md must be regenerated for v2 with the new tool names. The skill copies forward the v1 CLAUDE.md, but the tool-call instructions inside it reference `taskflow_query`, `taskflow_report`, `taskflow_move`, `taskflow_reassign`, `taskflow_update`. These names don't exist in v2's MCP registry. The board agents will fail to find the tools without a CLAUDE.md regeneration step.

This is a **Tier A blocker** for cutover that wasn't in the readiness checklist. Adding it.
