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

| # | Action | Effort |
|---|---|---|
| AI-1 | Confirm `api_update_simple_task` actually covers move + reassign (read source + test) | 1h |
| AI-2 | Determine if `taskflow_report` capability has a v2 MCP exposure — if not, document the workaround (compose from api_filter_board_tasks calls) | 2h |
| AI-3 | Verify `api_linked_tasks` covers `taskflow_hierarchy` | 30min |
| AI-4 | Determine fate of `taskflow_dependency` — has it always meant `blocked_by` updates? If yes, `api_update_simple_task` covers it | 30min |
| AI-5 | Document `nanoclaw` MCP tool — what does it do? Is it raw SQL? Read-only? | 30min |
| AI-6 | Confirm `add-taskflow-memory` skill has `memory_recall` equivalent (Phase 1 shipped per memory) | 30min |
| AI-7 | Verify meeting-type task creation in v2 (api_create_simple_task seems to be simple-only) | 1h |

Total: ~6h of focused investigation.

## 3. SQL table inventory (TODO)

Not yet started. Need to:
- Enumerate every table v1 reads/writes (from prod's taskflow.db + messages.db)
- Compare to v2's reads/writes (from migrations + engine code)
- Schema diff for any shared tables

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
