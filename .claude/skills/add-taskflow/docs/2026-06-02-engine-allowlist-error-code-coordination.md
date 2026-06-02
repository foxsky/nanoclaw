# TaskFlow Engine Deliverables — Unblocking the tf-mcontrol Roadmap in One Pass

**Audience:** the nanoclaw engine agent (owner of `/root/nanoclaw/container/agent-runner/src/`).
**Purpose:** for each remaining tf-mcontrol roadmap area (reassign, hierarchy, stats, archive, meetings, rich-update), state the EXACT engine deliverable — which `api_*` tool(s) are needed and whether each already exists, the `{success, error_code, error}` envelope each must return so the dashboard can map it to an HTTP status, and the `FASTAPI_ALLOWLIST` entry the standalone subprocess must add. The dashboard drives the SAME TaskFlow engine the in-container WhatsApp agent uses, by spawning `bun container/agent-runner/src/mcp-tools/taskflow-server-entry.ts --db <taskflow.db>` and calling its `api_*` tools over stdio.

Synthesized 2026-06-02 from current source on branch `skill/taskflow-v2`, verified directly (not inferred from commit messages). Load-bearing files:
- Allowlist + D1 gating: `/root/nanoclaw/container/agent-runner/src/mcp-tools/taskflow-server-entry.ts:45-82`
- Server-side allowlist gate (list + call): `/root/nanoclaw/container/agent-runner/src/mcp-tools/server.ts:45-58`
- Reference envelope shape (board-config tools): `/root/nanoclaw/container/agent-runner/src/mcp-tools/taskflow-api-board.ts:617-626` + per-tool handlers
- Mutate tool surface (D1 source): `/root/nanoclaw/container/agent-runner/src/mcp-tools/taskflow-api-mutate.ts:2109-2114`
- `err` / `jsonResponse` helpers: `/root/nanoclaw/container/agent-runner/src/mcp-tools/util.ts:13,35`
- `finalizeMutationResult` (error_code passthrough): `/root/nanoclaw/container/agent-runner/src/mcp-tools/taskflow-api-mutate.ts:233-239`
- Engine error_code emissions: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
- Dashboard HTTP mapping + envelope parser: `/root/tf-mcontrol/taskflow-api/app/main.py:1605-1695, 1741-1748`
- MCP client (decodes the text block; no `isError` check): `/root/tf-mcontrol/taskflow-api/app/engine/client.py:262-273`

> **CONSTRAINT REMINDER:** tf-mcontrol is active cross-session work and is READ-ONLY here. Every tf-mcontrol change below is a *request to the tf-mcontrol owner*, not something the engine agent edits. The engine agent's write surface is `container/agent-runner/src/` only.

---

## 1. error_code vocabulary — what the engine must emit, and the HTTP it maps to

The dashboard's HTTP status is derived **entirely from the `error_code`** the engine returns in the failure envelope. The map is `MCP_MUTATION_ERROR_STATUS` (`main.py:1605-1628`), which first spreads in `ACTOR_RESOLUTION_STATUS` (`main.py:1228-1233`). On a `{success:false}` result, the dashboard does `MCP_MUTATION_ERROR_STATUS.get(error_code, 502)` (`main.py:1745`).

| error_code | HTTP | Mapped? | Engine emits today? | Source (map / engine) |
|---|---|---|---|---|
| `validation_error` | **422** | ✅ | ✅ (3×) | `main.py:1609` / engine `2761` etc. |
| `not_found` | **404** | ✅ | ✅ (18×) | `main.py:1607` / engine `2659` etc. |
| `conflict` | **409** | ✅ | ✅ (5×) | `main.py:1608` / engine `2663` etc. |
| `permission_denied` | **403** | ✅ | ✅ (7×) | `main.py:1619` / engine `4713` etc. |
| `invalid_transition` | **409** | ✅ | ✅ (1×) | `main.py:1620` / engine `4635` |
| `hierarchy_provision_unsupported` | **422** | ✅ | ✅ (1×) | `main.py:1615` / engine `9302` |
| `actor_type_not_allowed` | **403** | ✅ | ✅ (5×) | `main.py:1232` (via spread `:1606`) / engine `2674` etc. |
| `internal_error` | **500** | ✅ | ❌ **never** — only synthesized by tool-handler `catch` blocks (`taskflow-api-board.ts:131`, `taskflow-api-update.ts:361`), never by the engine itself | `main.py:1624` |
| `actor_not_found` | **422** | ✅ | (actor-resolution family) | `main.py:1229` |
| `actor_ambiguous` | **409** | ✅ | (actor-resolution family) | `main.py:1230` |
| `actor_resolution_unavailable` | **503** | ✅ | (actor-resolution family) | `main.py:1231` |
| `unknown` | **502** | ✅ | (default when `error` present but no `error_code`) | `main.py:1627, 1683-1685` |
| `invalid_confirmed_task_id` | — | ❌ **NOT mapped → falls through to 502** | ✅ (1×, engine `1068`, via magnetism guard) | engine `1068` |
| `AMBIGUOUS_TASK_CONTEXT` (constant; resolves to a string literal at engine `1080`) | — | ❌ **NOT mapped → 502** | ✅ (1×) | engine `1080` |

**Canonical set a roadmap tool should emit to map cleanly:** `validation_error` (422), `not_found` (404), `conflict` (409), `permission_denied` (403), `invalid_transition` (409), `hierarchy_provision_unsupported` (422), `internal_error` (500), plus the actor-* family. Anything outside this set → **502** ("engine forgot the contract").

### Codes the roadmap needs that are NOT cleanly mapped today

1. **`invalid_confirmed_task_id`** (engine `1068`) and the magnetism-ambiguity constant at engine `1080` are engine-emitted but **absent from the map → 502**. These surface on the rich-update / move / meeting paths via the shared magnetism guard. **Decision required (§6 Q1):** either the engine renames these to a mapped code (`conflict` or `validation_error`), or tf-mcontrol adds map entries. Until then, a legitimate "which task did you mean?" disambiguation reads as a 502 bad-gateway.

2. **No engine method emits `internal_error`.** It is produced only by handler `catch` blocks. The 12 D1 mutate tools' `catch` blocks emit **codeless** `{success:false, error}` (e.g. `api_move` `:1147`, `api_admin` `:1373`, `api_reassign` `:1435`, `api_hierarchy` `:1882`, `api_dependency` `:1944`), so an engine **throw** on a roadmap path becomes `unknown → 502`, not 500. **Decision required (§6 Q2):** roadmap-facing mutate tools should classify `catch` into at least `internal_error` (→500), matching the board-config reference tools.

### Three distinct failure shapes the dashboard parser sees — all three must be tolerated by the engine's design

`parse_mcp_mutation_result` (`main.py:1656-1695`) branches strictly on the boolean `success` field, after `engine/client.py:262-273` JSON-decodes the `tools/call` text block:

- **(A) Structured envelope** `{success:false, error_code, error}` via `jsonResponse` → clean HTTP map. **This is the target for every roadmap tool.**
- **(B) Codeless envelope** `{success:false, error}` (no `error_code`) → `unknown → 502` (`main.py:1683-1685`). Every D1 dispatcher (`admin`, `reassign`, `hierarchy`, `dependency`, `update`*, `query`, `report`, `undo`, `create`) returns this on failure today.
- **(C) Raw `err()` text** `{content:[{text:"Error: …"}], isError:true}` (`util.ts:13`) — **NOT a `{success,…}` JSON envelope at all.** The client (`engine/client.py:262-273`) does `json.loads(item['text'])` with **no `isError` check**; `"Error: …"` fails to parse → the parser raises `ValueError("MCP mutation result missing boolean success")` → **503** "invalid response" (`main.py:1695, 1734-1739`). Every mutate handler emits `err(...)` for bad arg shapes (e.g. `taskflow-api-mutate.ts:807`, and the shared `parseTaskActorArgs` at `util.ts:55-63`). **This is the most dangerous trap: arg-shape rejections become a 503 transport error, not a 422.**

> *`update` (and the tools routing through it — `api_update_task`, `api_reschedule_meeting`, `api_note_meeting`) is codeless **except** it can surface `invalid_confirmed_task_id` (engine `1068`) via the shared magnetism guard.

**Cross-cutting engine deliverable (applies to every roadmap area):** the FastAPI-facing tools must (a) replace `err(...)` arg-shape rejections with `jsonResponse({success:false, error_code:'validation_error', error:…})`, and (b) give `catch` blocks a real `error_code` (min `internal_error`). The board-config tools in `taskflow-api-board.ts` already do both — copy that shape.

---

## 2. `taskflow-server-entry.ts` ALLOWLIST (the D1 defect)

### Gating mechanism — the over-exposure is contained, but adding a tool is a 1-line allowlist edit

`taskflow-server-entry.ts:25-31` imports all 7 taskflow modules purely for their module-scope `registerTools([...])` side effects. Importing `taskflow-api-mutate.js` (line 26) registers its **entire 16-tool surface** into the shared global `toolMap` (`server.ts:21-33`). Exposure is then gated by `FASTAPI_ALLOWLIST` passed to `startMcpServer(FASTAPI_ALLOWLIST)` (`taskflow-server-entry.ts:106`). The gate is **correct and complete** — it filters BOTH `tools/list` (`server.ts:45-49`) AND `tools/call` (`server.ts:51-58`: a registered-but-disallowed name returns `Unknown tool: <name>`). So the D1 over-registration is unreachable at runtime; the only thing that makes a tool callable is adding its exact name to the allowlist.

**Convention (load-bearing, do not violate):** the file header (`taskflow-server-entry.ts:36-43`) mandates **add-on-migration least-privilege** — never pre-authorize an unbuilt name; add each tool's name in the **same commit** that lands its dashboard route. (Rationale: a future same-named tool would auto-expose.)

### Current state (verified by direct read of source)

- **Total registered into `toolMap`: 33 tools** (read 3 + mutate 16 + update 1 + notes 3 + board 8 + comment 1 + chat 1).
- **Allowlist literal = 21 entries** (`taskflow-server-entry.ts:47-81`, counted directly):
  `api_create_simple_task`, `api_update_simple_task`, `api_delete_simple_task`, `api_move`, `api_move_to_column`, `api_task_add_note`, `api_task_edit_note`, `api_task_remove_note`, `api_board_activity`, `api_filter_board_tasks`, `api_linked_tasks`, `api_create_board`, `api_delete_board`, `api_add_holiday`, `api_remove_holiday`, `api_update_board`, `api_add_board_person`, `api_remove_board_person`, `api_update_board_person`, `api_task_add_comment`, `api_send_chat`.
- **D1 over-exposure = 12 mutate tools registered but NOT allowlisted** (the 16 mutate tools minus the 4 allowlisted ones — `api_create_simple_task`, `api_move`, `api_move_to_column`, `api_delete_simple_task`):
  `api_create_meeting_task`, `api_create_task`, `api_admin`, `api_reassign`, `api_undo`, `api_report`, `api_update_task`, `api_query`, `api_hierarchy`, `api_dependency`, `api_reschedule_meeting`, `api_note_meeting`.

  All 12 are registered but unlisted/uncallable — exactly the roadmap-blocked surface.

### Target allowlist for the roadmap

Adding a roadmap tool = appending its name string to the `FASTAPI_ALLOWLIST` set (`taskflow-server-entry.ts:45-82`), in the same commit that hardens its envelope. Per area:

| Area | Names to add to `FASTAPI_ALLOWLIST` |
|---|---|
| reassign | `api_reassign` |
| hierarchy | `api_hierarchy` (and — pending Q3 — `api_admin` for reparent/detach, or a narrower tool) |
| stats | `api_query` |
| archive | `api_query` (read) + decision Q4 for the write path (`api_report` and/or `api_admin`) |
| meetings | `api_create_meeting_task`, `api_reschedule_meeting`, `api_note_meeting`, `api_query` (read modes) |
| rich-update | `api_create_task`, `api_update_task` |

**Recommendation: explicit allowlist, NOT a whole-module import switch.** The current explicit `Set` is the correct design and should be preserved. Do **not** "fix D1" by exposing the whole `taskflow-api-mutate` module — that would expose `api_admin` (17 actions, including `register_person`/`remove_person`/`merge_project`) wholesale and break the least-privilege convention. Add names one at a time, gated on dashboard-readiness.

**Highest-risk single addition: `api_admin`.** One allowlist entry exposes all **17** `ADMIN_ACTIONS` (`taskflow-api-mutate.ts:45-51`: `register_person, remove_person, add_manager, add_delegate, remove_admin, set_wip_limit, set_cross_board_subtask_mode, cancel_task, restore_task, process_inbox, manage_holidays, process_minutes, process_minutes_decision, accept_external_invite, reparent_task, detach_task, merge_project, handle_subtask_approval`). If the dashboard only needs reparent/detach (hierarchy) or cancel/restore (archive), prefer a **narrow dedicated tool** over exposing `api_admin`. Flagged as Q3/Q4.

---

## 3. Per-area matrix

For each area: needed tool(s) + EXISTS/MISSING (file:line); required error_codes; tf-mcontrol endpoint(s) + wired/direct-SQL status; open question/risk.

### 3.1 Reassign — `api_reassign` EXISTS, not exposed
- **Tool:** `api_reassign` — **EXISTS**, `taskflow-api-mutate.ts:1378`. Single (`task_id`) or bulk transfer (`source_person`→`target_person`); `confirmed=false` is a dry-run returning `requires_confirmation`. Flat args: `{board_id, target_person, sender_name, confirmed, task_id?, source_person?}` (required: `target_person`, `sender_name`, `confirmed`).
- **error_codes needed:** today the `reassign` engine dispatcher is **codeless on failure** (shape B). Engine must return structured codes: `not_found` (404, unknown person/task), `conflict` (409, over-WIP / already-assigned / empty bulk set) or `validation_error` (422, bad shape), `permission_denied`/`actor_type_not_allowed` (403, non-manager bulk transfer). Plus cross-cutting: replace `err()` arg branches with `validation_error` (shape A); give `catch` `internal_error`. The dry-run is a **success** envelope with `requires_confirmation` — NOT an error; the dashboard must render a confirm step.
- **tf-mcontrol endpoint:** **none today** (no `/reassign` route; verified). Single reassign is done DIRECT via `PATCH …/tasks/{id}` → `api_update_simple_task` assignee (`main.py:3229`). Bulk transfer + dry-run are absent. New route e.g. `POST /boards/{id}/tasks/reassign`.
- **Allowlist:** add `api_reassign`.
- **Risk/open:** confirm the dashboard wants the dry-run/confirm two-step UX (it is the only way to do bulk safely).

### 3.2 Hierarchy — `api_hierarchy` EXISTS, not exposed
- **Tool:** `api_hierarchy` — **EXISTS**, `taskflow-api-mutate.ts:1830`. Actions `link`/`unlink`/`refresh_rollup`/`tag_parent`. Flat args: `{board_id, action, task_id, sender_name, person_name?, parent_task_id?}`. **Reparent/detach/merge are NOT here** — they are `api_admin` actions `reparent_task`/`detach_task`/`merge_project` (`ADMIN_ACTIONS`, `taskflow-api-mutate.ts:45-51`).
- **error_codes needed:** `hierarchy` dispatcher is **codeless** today. Engine must emit `not_found` (404, task/person/parent), `conflict` (409, illegal link state), `hierarchy_provision_unsupported` (422, already mapped — engine `9302`), `permission_denied` (403). Cross-cutting `err()`→`validation_error` and `catch`→`internal_error`.
- **tf-mcontrol endpoint:** **none today** for writes. Reads work fully via `GET /boards/{id}/linked-tasks` → `api_linked_tasks` (already allowlisted). New route e.g. `POST /boards/{id}/tasks/{id}/hierarchy`.
- **Allowlist:** add `api_hierarchy`. Reparent/detach need either `api_admin` (broad) or a narrow new tool — see Q3.
- **Risk/open:** Q3 — does the dashboard need reparent/detach (→ `api_admin` or new tool), or only link/unlink (→ `api_hierarchy` alone)?

### 3.3 Stats — NO dedicated tool; maps to `api_query`, NOT `api_report`
- **Tool:** `api_query` — **EXISTS**, `taskflow-api-mutate.ts` (registered in the mutate block). Statistics are query **sub-modes**: `statistics`, `person_statistics`, `month_statistics`, `summary` (engine `taskflow-engine.ts` ~`8276/8304/8348/8375`). Returns `{success:true, data:{total_active, by_column, overdue, avg_tasks_per_person, …}}`. **No `api_stats`/`api_statistics` tool exists; do not invent one.**
- **`api_report` is NOT the stats home** — it is standup/digest/weekly only; weekly/digest carry *some* roll-up stats inside their payload, but raw per-board/per-person/per-month counts are the `api_query` path.
- **error_codes needed:** read-side; failures are codeless `{success:false, error}` (e.g. missing `person_name` for `person_statistics`). Engine should emit `validation_error` (422, bad mode/missing param) and `not_found` (404, unknown person). Mostly 200-with-data.
- **tf-mcontrol endpoint:** `GET /stats` → `api_query statistics` is wired but **board-wide only** (`main.py:2851`). No per-person, no monthly. New routes e.g. `GET /boards/{id}/stats/people`, `…/stats/monthly`.
- **Allowlist:** add `api_query`.
- **Risk/open:** Q5 — `api_query` is ONE tool gating ALL its read sub-modes (statistics, archive, completed, meeting reads). One allowlist entry exposes the entire read API. It is non-mutating, but the engine agent must confirm no sub-mode leaks cross-board data without board scoping under `setVerbatimIds(true)`. Also: the engine must **publish the exact flat-arg contract for `person_statistics`/`month_statistics`** (param names) — that contract lives in `taskflow-engine.ts`, not the mutate handler, and the dashboard owner needs it to build the request.

### 3.4 Archive — NO dedicated mutation tool; split read (`api_query`) + write (`api_report` side-effect / `api_admin`)
- **Read:** `api_query` sub-modes `archive` (engine ~`8083`, last ~20), `archive_search`, `completed_today`/`completed_this_week`/`completed_this_month`, `person_completed`. **EXISTS** (same `api_query` tool). `{success:true, data:rows}`.
- **Write — NO dedicated tool:** auto-archive of done tasks >30 days runs as a **side-effect of `api_report type=standup`** (engine housekeeping). Manual cancel→archive and restore are **`api_admin` actions** `cancel_task`/`restore_task` (`ADMIN_ACTIONS`, `taskflow-api-mutate.ts:45-51`). **There is no `api_archive`/`api_restore`/`api_unarchive` tool.**
- **error_codes needed:** read path — `validation_error` (422, bad window/mode), else 200. Write path (if exposed) — `not_found` (404), `conflict` (409).
- **tf-mcontrol endpoint:** **none today.** `/tasks/search` (`main.py:3534`) is DIRECT-SQL over **active** tasks only — not the archive. New read routes e.g. `GET /boards/{id}/archive`, `…/archive/search`, `…/completed?window=`.
- **Allowlist:** `api_query` (read, shared with stats). Write path pending Q4.
- **Risk/open:** Q4 — this is the one area lacking a clean dedicated write tool. The engine agent must learn from the dashboard owner whether "archive" means (a) read-only completed-work visibility (→ `api_query` alone, no engine write work), (b) report-driven auto-cleanup (→ expose `api_report`), or (c) explicit cancel/restore buttons (→ expose `api_admin`, broad, OR build dedicated `api_archive_task`/`api_restore_task` thin tools delegating to the same engine code, returning `not_found`/`conflict`). **Do not guess** — the write semantic is undetermined.

### 3.5 Meetings — three tools EXIST, none exposed (largest net-new surface)
- **Tools (all EXIST):** `api_create_meeting_task` (`taskflow-api-mutate.ts:858`), `api_reschedule_meeting` (`:1984`), `api_note_meeting` (`:2047`). Reschedule/note resolve the meeting by **M-id OR free-text name** via shared `resolveMeetingTaskId` (`:1956`). Reads via `api_query` meeting sub-modes (`meetings`, `upcoming_meetings`, agenda/minutes/participants/open-items, engine ~`8302-8411`).
- **error_codes needed — ⚠ critical envelope gap:** `resolveMeetingTaskId` returns `{success:false, error}` with **NO `error_code`** for the 0-match, 2+-match (ambiguity), and wrong-board cases (`:1965, 1972, 1978`). The 2+-match case returns `data.candidates` and is a **disambiguation prompt, not a true error** — the dashboard needs a distinct signal (e.g. a PROPOSED-NEW `error_code:'ambiguous'` + `candidates`, OR a `success:true` envelope carrying `candidates`) so it renders a picker rather than a 502. For 0-match → `not_found` (404); malformed M-id → `validation_error` (422). `create_meeting_task` is codeless today (via `finalizeCreatedTaskResult`, `taskflow-api-mutate.ts:184`); reschedule/note route through `engine.update` → codeless except `invalid_confirmed_task_id`. All three need the cross-cutting `err()`→`validation_error` + `catch`→`internal_error` treatment, plus structured codes on the resolution branches.
  - **PROPOSED-NEW `error_code:'ambiguous'`** — not currently emitted by the engine; flagged as Q1-adjacent. If used, tf-mcontrol must add a map entry (suggest 409 or a 200-with-candidates contract). Do not assume it maps today.
- **tf-mcontrol endpoint:** **none today.** Meeting tasks appear only as Kanban cards. New routes e.g. `POST /boards/{id}/meetings`, `PATCH …/meetings/{id}` (reschedule), `POST …/meetings/{id}/notes`, plus read routes.
- **Allowlist:** add `api_create_meeting_task`, `api_reschedule_meeting`, `api_note_meeting`, `api_query`.
- **Risk/open:** Q6 — engine must decide and publish how ambiguity is signaled (new code vs success-with-candidates). The dashboard owner must agree the contract before this area ships.

### 3.6 Rich-update / rich-create — `api_create_task` / `api_update_task` EXIST, not exposed
- **Tools (both EXIST):** `api_create_task` (`taskflow-api-mutate.ts:1517`; type=simple/project/recurring/inbox, labels, subtasks, recurrence, `scheduled_at`) and `api_update_task` (`:1685`; composite `updates` object — participant ops, subtask rename/reopen/assign, recurrence ops, `set_note_status`, `scheduled_at`, `next_action`). Distinct from the already-exposed flat `api_update_simple_task` (`taskflow-api-update.ts`).
- **Reference good-citizen:** `api_update_simple_task` (`taskflow-api-update.ts`) is the **only** handler that owns its codes end-to-end (`not_found` `:127/160`, `actor_type_not_allowed` `:181`, `conflict` `:191`, `validation_error` `:212`, `internal_error` `:361`). Copy this for the rich tools.
- **error_codes needed:** `api_update_task` routes through `engine.update`, which is **codeless except `invalid_confirmed_task_id`** (engine `1068`, via the magnetism guard at engine `5643→1068`). `api_create_task` is codeless via `finalizeCreatedTaskResult` (`:184`). Engine deliverable: emit `not_found` (404, task/parent/participant), `validation_error` (422, bad type/recurrence/label), `permission_denied`/`actor_type_not_allowed` (403, role-gated update), `conflict` (409, illegal subtask/recurrence state). Plus cross-cutting `err()`→`validation_error`, `catch`→`internal_error`, and resolve `invalid_confirmed_task_id` (Q1).
- **tf-mcontrol endpoint:** **DIRECT to the SIMPLE tools only.** `POST …/tasks` → `api_create_simple_task` forwards only `{title, assignee, priority, due_date, description}` (`main.py:3194`). `PATCH …/tasks/{id}` → `api_update_simple_task` forwards only `{column, title, description, assignee, priority, due_date, labels}` (`main.py:3229`). The rich tools are **never called** — grep-confirmed, no `api_create_task`/`api_update_task` call site in `main.py`. *(An older audit referenced a mapping at "line 3217" → `api_create_task`; current source does NOT contain it. Treat the rich path as unwired.)*
- **Allowlist:** add `api_create_task`, `api_update_task`.
- **Risk/open:** the dashboard must decide whether to branch the existing routes (rich fields present → rich tool, else simple) or add new routes. Engine should publish the flat-field `inputSchema` for both (`:1519+`, `:1687+`).

---

## 4. ENGINE-AGENT CHECKLIST (ordered, one pass)

Do the cross-cutting envelope work FIRST — it is shared by every area and is the highest-leverage fix.

1. **Cross-cutting envelope hardening on the FastAPI-facing mutate tools** (`taskflow-api-mutate.ts`):
   a. Replace every `err(...)` arg-shape rejection with `jsonResponse({success:false, error_code:'validation_error', error:…})` (otherwise → 503). Covers `api_reassign`, `api_hierarchy`, `api_create_task`, `api_update_task`, `api_create_meeting_task`, `api_reschedule_meeting`, `api_note_meeting`, and `api_query` arg checks.
   b. Give every roadmap tool's `catch` block a real `error_code` (min `internal_error` → 500) instead of codeless `{success:false, error}`.
2. **Add structured `error_code` to the engine dispatcher methods on failure** (currently codeless): `reassign`, `hierarchy`, `update` (the rich path), `query`-validation, and the meeting resolution branches in `resolveMeetingTaskId`. Use only mapped codes: `not_found`/`conflict`/`validation_error`/`permission_denied`/`actor_type_not_allowed`. `finalizeMutationResult` (`taskflow-api-mutate.ts:233-239`) already passes `error_code` through, so a returned (not thrown) structured failure propagates intact.
3. **Resolve the two unmapped codes** (Q1): rename `invalid_confirmed_task_id` (engine `1068`) and the magnetism-ambiguity constant (engine `1080`) to a mapped code (`conflict` or `validation_error`), OR coordinate a tf-mcontrol map addition. Decide the meeting-ambiguity signal (Q6): PROPOSED-NEW `error_code:'ambiguous'` vs `success:true` + `candidates`.
4. **Add the allowlist entries** to `FASTAPI_ALLOWLIST` (`taskflow-server-entry.ts:45-82`), one name per area, in the same commit as that area's hardening: `api_reassign`, `api_hierarchy`, `api_query`, `api_create_meeting_task`, `api_reschedule_meeting`, `api_note_meeting`, `api_create_task`, `api_update_task`. Hold `api_admin` / `api_report` pending Q3/Q4.
5. **Publish flat-arg contracts** the dashboard owner needs but cannot read from the mutate handlers (they live in `taskflow-engine.ts`): `api_query` sub-mode params for `person_statistics`/`month_statistics`/`archive`/`archive_search`/`completed_*`; and the `inputSchema` flat fields for `api_create_task`/`api_update_task`/`api_create_meeting_task`.
6. **Preserve the contract invariants** any new/hardened tool must satisfy: flat top-level args only; accept FastAPI-resolved `sender_name`/`sender_is_service` for actor-attributed actions (engine does NO owner/board/org auth — that stays FastAPI-side, `main.py:3971-3972`); rely on the flat `board_id` arg (NEVER an ambient `NANOCLAW_TASKFLOW_BOARD_ID` env — it is stripped, `client.py:26,34-35`); keep emitting the literal `MCP server ready` stderr sentinel and the three handshake tools (`api_filter_board_tasks`, `api_linked_tasks`, `api_board_activity`, `client.py:154-157`).

---

## 5. OPEN QUESTIONS (confirm with the user / tf-mcontrol owner before the engine agent starts)

- **Q1 — Unmapped codes.** Should the engine rename `invalid_confirmed_task_id` (engine `1068`) and the magnetism-ambiguity constant (engine `1080`) to a mapped code (`conflict`/`validation_error`), or will tf-mcontrol add map entries? These are on the move/rich-update/meeting paths and currently 502.
- **Q2 — `internal_error` source.** No engine method emits `internal_error`; only handler `catch` blocks do. Confirm the engine agent should classify roadmap-tool `catch` blocks into `internal_error` (→500) rather than leaving them codeless (→502).
- **Q3 — Hierarchy reparent.** Does the dashboard need reparent/detach/merge (→ expose `api_admin`, which is broad: 17 actions; OR build a narrow dedicated tool), or only `api_hierarchy`'s link/unlink/refresh_rollup/tag_parent?
- **Q4 — Archive write semantic (undetermined).** Is "archive" read-only completed-work visibility (`api_query` only, no engine write), report-driven auto-cleanup (`api_report`), or explicit cancel/restore (`api_admin` broad, OR new `api_archive_task`/`api_restore_task` thin tools)? Do not guess.
- **Q5 — `api_query` blast radius.** Exposing `api_query` (needed for stats AND archive AND meeting reads) opens the entire read sub-mode surface in one allowlist entry. Acceptable? Confirm no sub-mode leaks cross-board data under `setVerbatimIds(true)` board scoping.
- **Q6 — Meeting ambiguity signal.** How should `resolveMeetingTaskId`'s 2+-match case be signaled — a PROPOSED-NEW `error_code:'ambiguous'` (needs a tf-mcontrol map entry), or a `success:true` envelope carrying `candidates` (so the dashboard renders a picker)? It is a disambiguation prompt, not an error.
- **Q7 — Rich-route shape.** Should tf-mcontrol branch the existing `POST/PATCH …/tasks` routes (rich fields → rich tool, else simple) or add separate rich endpoints? (tf-mcontrol decision; affects how the engine documents the flat-field schema.)
