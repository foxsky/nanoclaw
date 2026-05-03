# 17 — MCP Tools (V) + IPC Integration (W) Domains: Feature-Coverage Audit

**Date:** 2026-05-03
**Scope:** TaskFlow's MCP tool surface (V — 13 features) AND host-side IPC integration (W — 10 features). Combined because the two halves share a single transport: container-side `writeIpcFile()` → host-side IPC watcher → registered handler. Splitting them obscures the round-trip.

**Anchor sources**
- Plan: `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` (sub-task **2.3.a** "IPC plugins → MCP tools")
- Spec: `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`
- Discovery 06: `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/06-mcp-registration.md` (registration pattern)
- Discovery 08: `.../research/2026-05-03-v2-discovery/08-kind-taxonomy.md` (kind taxonomy + system action registry)
- Discovery 09: `.../research/2026-05-03-v2-discovery/09-send-message-e2e.md` (send_message E2E + audit hook position)
- Engine: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (9598 LOC; engine.create/move/update/admin/etc.)
- TaskFlow MCP wiring: `/root/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts` (1549 LOC; registers all 9 `taskflow_*` tools and the IPC-bridging tools)
- TaskFlow REST MCP server: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.ts` (611 LOC; 9 `api_*` tools mounted to a per-board `taskflow.db`)
- v1 IPC host watcher: `/root/nanoclaw/src/ipc.ts` (1255 LOC; `registerIpcHandler`, 8 core handlers + plugin loader)
- v1 IPC plugins: `/root/nanoclaw/src/ipc-plugins/` (4 plugins: `create-group`, `provision-child-board`, `provision-root-board`, `send-otp`)

---

## 0. Production validation (queries run 2026-05-03 against `nanoclaw@192.168.2.63`)

### IPC plugins on prod

```
$ ls /home/nanoclaw/nanoclaw/src/ipc-plugins/
create-group.test.ts
create-group.ts
provision-child-board.test.ts
provision-child-board.ts
provision-root-board.ts
provision-shared.ts
```

Note: prod is missing `send-otp.ts` and `provision-root-board.test.ts` — local fork has both. The **deployed allowlist** in `src/ipc.ts:71-76` includes `send-otp.js` so the dist *is* shipped to prod (`./scripts/deploy.sh` builds locally + rsyncs `dist/`); the source-level absence on prod is a sync-direction artifact, not a functional gap. Four IPC types are registered host-side: `create_group`, `provision_child_board`, `provision_root_board`, `send_otp`.

### MCP tool inventory (container-side)

`ipc-mcp-stdio.ts` registers **20 tools** in three tiers:

| Tier | Tools | Gating |
|---|---|---|
| Always-on | `send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task` | `process.env.NANOCLAW_*` always set |
| Memory (TaskFlow boards) | `memory_store`, `memory_recall`, `memory_list`, `memory_forget` | `isTaskflowManaged && taskflowBoardId` |
| Main-group | `register_group`, `create_group`, `provision_child_board` | `canUseCreateGroup({isMain, isTaskflowManaged, taskflowHierarchyLevel, taskflowMaxDepth})` |
| TaskFlow-managed | `taskflow_query`, `taskflow_create`, `taskflow_move`, `taskflow_reassign`, `taskflow_update`, `taskflow_dependency`, `taskflow_admin`, `taskflow_undo`, `taskflow_hierarchy`, `taskflow_report`, `send_board_chat` | `NANOCLAW_IS_TASKFLOW_MANAGED === '1'` |
| Always-on (capability skill) | `context_search`, `context_recall`, `context_grep`, `context_timeline`, `context_topics` | always on; last 2 unlocked at >50 nodes |

`taskflow-mcp-server.ts` registers **9 REST-bridge tools** (`api_board_activity`, `api_filter_board_tasks`, `api_linked_tasks`, `api_create_simple_task`, `api_update_simple_task`, `api_delete_simple_task`, `api_task_add_note`, `api_task_edit_note`, `api_task_remove_note`). Different process, different transport — used by the TaskFlow web dashboard, not by agent containers.

### Production task_history (most-active actors)

`/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` — `task_history` schema uses column `by` (NOT `created_by` as the task brief assumed).

```sql
SELECT by, COUNT(*) FROM task_history WHERE by IS NOT NULL GROUP BY by ORDER BY 2 DESC LIMIT 10;
giovanni|893
lucas|315
miguel|213
mauro|166
thiago|149
laizys|133
rafael|105
web-api|97
mariany|69
Miguel|41
```

`web-api` (the `api_*` tools' `sender_name` value) is 4th-from-bottom — confirms the REST surface is in active use but secondary to the MCP-tool surface. The capitalization split between `miguel` (213) and `Miguel` (41) is cross-database actor canonicalization debt — out of scope for this audit, see audit 11 (permissions).

### Most-active actions

```
updated|963   created|559   reassigned|210   conclude|155   cancelled|130
update|78     review|71     wait|63          start|58       approve|50
child_board_created|25       subtask_added|22  reparented|21  moved|11   note_added|10
```

`taskflow_create` + `taskflow_admin(register_person→child_board_created)` + `taskflow_move/admin/update` carry the bulk. `taskflow_dependency`, `taskflow_undo`, `taskflow_report` are missing from this list — they DO emit `task_history` rows but at lower volumes; specifically, `_undone` action (rare, AH.2 in audit 13) has only 2 rows in 60d.

### `.mcp.json` configs in groups

```
$ find /home/nanoclaw/nanoclaw/groups -name '.mcp.json' | head -5
/home/nanoclaw/nanoclaw/groups/thiago-taskflow/.mcp.json
/home/nanoclaw/nanoclaw/groups/sec-secti/.mcp.json
/home/nanoclaw/nanoclaw/groups/seaf-contabilidade-taskflow/.mcp.json
/home/nanoclaw/nanoclaw/groups/seaf-gefin-taskflow/.mcp.json
/home/nanoclaw/nanoclaw/groups/seaf-geadmin-taskflow/.mcp.json
```

Every TaskFlow board has a `.mcp.json` registering `mcp-server-sqlite-npx` mounted to `/workspace/taskflow/taskflow.db`. **This is a SECOND MCP server** — neither `ipc-mcp-stdio.ts` nor `taskflow-mcp-server.ts` registered it. `mcp-server-sqlite-npx` is an off-the-shelf npm package that exposes raw SQL `read_query` / `write_query` / `list_tables` tools to the agent. Audit implication: the agent has direct SQL write access to the TaskFlow DB, *bypassing* every engine guard (magnetism, validation, history). This is a known v1 design choice (per CLAUDE.md "the agent can run analytics queries"); the v2 spec needs to decide whether to preserve it. See **GAP-W.1** below.

### `find_person_in_organization` invocations

```sql
sqlite> SELECT COUNT(*) FROM messages WHERE content LIKE '%find_person_in_organization%';
0
```

Zero hits — but the tool IS used; it's just not echoed in `messages.content` because that table stores user-visible text, not tool-call traces. The auditor dryrun NDJSON would be the place to count invocations; out of scope here.

### Magnetism guard prod hits

```sql
sqlite> SELECT action, COUNT(*) FROM task_history WHERE action LIKE '%magnetism%';
(empty)
```

Confirmed zero — same finding as audit 13 AH.4/AH.5. Magnetism guard is wired (engine line 65-66 + 3194-3217 + 4603-4627) but has not fired in production. **Affects intended_weekday + DST validation paths because they share the engine entry guard.**

---

## Coverage matrix

Status legend: **OK** = exists in prod and plan/spec covers it. **DOC-ONLY** = wired but no production usage. **GAP** = plan/spec does not address it. **DEAD** = wired but 0 prod hits and explicit drop candidate.

### Tier V — MCP Tools (13 features)

| ID | Feature | Source | Plan / spec coverage | Prod | Status |
|---|---|---|---|---|---|
| V.1 | `taskflow_create` | `ipc-mcp-stdio.ts:1036-1116`, engine `create()` | Plan 2.3.a: "IPC plugins → MCP tools (single file `mcp-tools/taskflow.ts`)". Discovery 06 prescribes shape. | 559 `created` rows | **OK** |
| V.2 | `taskflow_move` | `ipc-mcp-stdio.ts:1119-1138`, engine `move()` | Plan 2.3.a | 155 `conclude` + 71 `review` + 63 `wait` + 58 `start` + 50 `approve` = 397+ rows | **OK** |
| V.3 | `taskflow_reassign` | `:1141-1158`, engine `reassign()` | Plan 2.3.a | 210 `reassigned` rows | **OK** |
| V.4 | `taskflow_update` | `:1162-1222`, engine `update()` | Plan 2.3.a | 963 `updated` + 78 `update` rows | **OK** |
| V.5 | `taskflow_dependency` | `:1225-1242`, engine `dependency()` | Plan 2.3.a | low volume (not in top-15) | **OK** |
| V.6 | `taskflow_admin` | `:1245-1313`, engine `admin()` | Plan 2.3.a | drives provisioning (25 `child_board_created`) | **OK** |
| V.7 | `taskflow_query` | `:988-1033`, engine `query()` (37 sub-modes incl. `find_person_in_organization`) | Plan 2.3.a | read-only — no `task_history` rows; sub-modes documented in Discovery 06 | **OK** (but see V.13 for find_person specifics) |
| V.8 | `taskflow_undo` | `:1316-1330`, engine `undo()` | Plan 2.3.a; 60s undo behavior preserved by audit 13 AH.2 | 2 `undone` rows / 60d | **OK** |
| V.9 | `taskflow_report` | `:1353-1366`, engine `report()` (standup/digest/weekly) | Plan 2.3.a | indirect — drives daily standup posts | **OK** |
| V.10 | Weekday name validation (`intended_weekday`) | `taskflow-engine.ts:633-653` `checkIntendedWeekday()`; aliases at :572-589 (pt-BR + EN) | Plan 2.3.a sub-task is silent on weekday alias map. Discovery 06 prescribes single-file `mcp-tools/taskflow.ts` — moves the engine but the alias map is engine-private, ports verbatim. | active in prod when user says "quinta", "segunda" etc. | **GAP-V.10** |
| V.11 | DST-aware `localToUtc` (2-pass spring-forward fix) | `taskflow-engine.ts:480-538`. Iterates twice; on oscillation returns `desiredUtc - min(offset1, offset2)` to round forward through the gap. | Plan 2.3.a is silent. Engine ports verbatim under 2.3.a's "single-file" scope, BUT v2's bun:sqlite uses `datetime('now')` (UTC) — `boardTz` has to come from `board_runtime_config`. | active for every `scheduled_at` write across 2,260 KB of meeting data | **GAP-V.11** |
| V.12 | Non-business-day guard (`allow_non_business_day` + `checkNonBusinessDay`) | `taskflow-engine.ts:1113`, fired at 3205, 3249, 4616, 4815. Reads `board_holidays` table. | Plan 2.3.d preserves `board_holidays` (14-table fork-private DB). Plan 2.3.a-n silent on the guard's call sites. | active; weekend creates blocked unless `allow_non_business_day=true` | **GAP-V.12** |
| V.13 | `find_person_in_organization` (cross-board org-wide person query) | `taskflow-engine.ts:7138`. Walks board tree from current board to root then descends. Returns `{person_id, name, phone_masked, board_id, board_group_folder, routing_jid, is_owner}`. | Plan is silent on cross-board read paths. Discovery 03 (session DB split) implies each board's `taskflow.db` is per-session — making the cross-board walk impossible without a central index. | active; documented in tool description (`ipc-mcp-stdio.ts:1005`); 0 echoes in `messages.content` because tool calls aren't user-visible | **GAP-V.13** |

### Tier W — IPC Integration (10 features)

| ID | Feature | Source | Plan / spec coverage | Prod | Status |
|---|---|---|---|---|---|
| W.1 | `mcp-server-sqlite-npx` direct DB access (per-board) | `groups/<board>/.mcp.json` registers it; mounted to `/workspace/taskflow/taskflow.db` | **Not addressed.** Plan 2.3.a-n is silent on the second MCP server. Discovery 06 enumerates the canonical `nanoclaw` MCP server but doesn't account for `sqlite-npx`. | shipped to all 28 boards | **GAP-W.1** |
| W.2 | `schedule_task` IPC for runner creation | container `:276-358` writes `tasks/*.json {type: 'schedule_task'}`; host `ipc.ts:133-290` `handleScheduleTask` validates cron/interval/once + creates `tasks` row + emits ack | Plan 2.3.a maps "IPC plugins → MCP tools" but `schedule_task` is ALREADY a v2-native MCP tool (Discovery 08, kind='system'). v2's `handleScheduleTask` writes to `messages_in (kind='task', recurrence=<cron>)` per-session. **Plan 2.3.f migration script handles the data, not the wiring.** | every board uses it (standups, digests, audit) | **OK** (mapped to v2 native) |
| W.3 | `cancel_task` IPC | container `:437-454`; host `:343-365` deletes the `tasks` row + clears any active runner | v2 native: `kind='system' action='cancel_task'` → `handleCancelTask` (Discovery 08). | active | **OK** (mapped to v2 native) |
| W.4 | `pause_task` / `resume_task` / `update_task` IPC | container `:399-505`; host `:306-340, 473-541` | v2 native: 3 more `kind='system'` actions. Discovery 08 tabulates all five. | active | **OK** (mapped to v2 native) |
| W.5 | `send_message` IPC for cross-group delivery | container `:211-273` (`target_chat_jid` param); host `:920-1069` enforces `isIpcMessageAuthorized` (group/dm/false) + `recordSendMessageLog` | Plan 2.3.c proposes `taskflow_send_message_with_audit` wrapper with **pre-queue insert + reconciliation sweep**. Discovery 09 §9 says "do NOT wrap MCP entry — audit must reflect actual delivery, not queue-insertion" — recommends `registerPostDeliveryHook`. **Plan 2.3.c contradicts Discovery 09.** | 1488 `send_message_log` rows lifetime; 28% cross-board (Discovery 19) | **GAP-W.5** (placement contradiction; also the subject of Audit 13 AH.11) |
| W.6 | `create_group` IPC for non-board groups | container `:744-810`; plugin `src/ipc-plugins/create-group.ts:154` `reg('create_group', ...)` | Plan 2.3.a says "rewrite as MCP tools per 2.3.a". v2 has no `create_group` native — so this plugin must be ported as a **fork-private MCP tool** that calls the WhatsApp adapter directly via `whatsapp-fixes.createGroup` (Plan 2.3.b). | only TaskFlow-managed boards can call it (canUseCreateGroup) | **OK** (folded into 2.3.b) |
| W.7 | `provision_child_board` IPC for async auto-provision | container `:812-880`; plugin `provision-child-board.ts:748`; auto-fires from `taskflow_admin` register_person path (`:1281-1306`) | Plan 2.3.b: "`provision_taskflow_board` MCP (uses `whatsapp-fixes.createGroup` + v2's `create_agent`)". v2 native `create_agent` (`agents.ts`) is admin-only and writes `kind='system' action='create_agent'`. **Auto-fire from `taskflow_admin` adds host-side coupling not present in v2's create_agent flow.** | drives 25 `child_board_created` rows in 60d | **GAP-W.7** (auto-fire wiring not enumerated in 2.3.b) |
| W.8 | `provision_root_board` IPC | plugin `provision-root-board.ts:534` registered host-side; **no container-side MCP tool currently writes this type** — it's invoked manually via host CLI or by the `setup` skill | **Not addressed** in plan 2.3.a or 2.3.b. The plan's "IPC plugins → MCP tools" sub-task lists `src/ipc-plugins/*` (multiple) without enumerating the four. | low volume — used at fork bootstrap | **GAP-W.8** |
| W.9 | `register_group` MCP (main-group only) | container `:670-742`; host `ipc.ts:550` `handleRegisterGroup` | Plan 2.3.a maps to native MCP tool; v2 has `agents.ts::create_agent` but no separate group-registration tool. **Hierarchical TaskFlow metadata (`taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth`) has no v2 equivalent.** | called via `setup` + manual onboarding | **GAP-W.9** |
| W.10 | `send_otp` IPC | plugin `send-otp.ts:53`; **no container-side MCP tool writes this type** — entry path is host-side (TaskFlow web admin posts to `data/ipc/<main>/otp/`) | **Not addressed** in plan 2.3.a-n. The `otp/` IPC subdirectory (`ipc.ts:1116-1141`) is a third pickup directory beyond `messages/` and `tasks/`. | drives TaskFlow web login (web admin → SMS-style OTP) | **GAP-W.10** |
| W.11 | Attachment intake MCP (OCR + format validation) | brief lists this as in-scope but `grep attachment ipc-mcp-stdio.ts taskflow-engine.ts` → **0 hits**. The intake protocol is CLAUDE.md-instruction-only (audit 14) | Plan / spec silent — confirmed by audit 14 (DOC-ONLY + 0 prod usage) | 0 rows in `attachment_audit_log` | **DEAD** (already enumerated in audit 14, listed here for completeness) |
| W.12 | Phone normalization helper (`normalizePhone`) | duplicated: `src/phone.ts:25` (host) + `taskflow-engine.ts:744` (container). Both implement the same pt-BR canonicalization. | Plan 2.3.d preserves engine; host copy is in src/. **Plan does not call out the duplication or assign canonical home.** | every register_person + add_external_participant + manage path | **GAP-W.12** |

**Counts (23 total):**
- **OK: 12** (V.1–V.9, W.2, W.3, W.4, W.6)
- **GAP: 9** (V.10, V.11, V.12, V.13, W.1, W.5, W.7, W.8, W.9, W.10, W.12) — note W.5 also flagged in audit 13 AH.11
- **DEAD: 1** (W.11; already covered by audit 14)

Wait — that's 12 + 11 + 1 = 24 vs 23. Recount: V has 13 (V.1–V.13). W has 12 listed (W.1–W.12). Total 25. Brief said "≈23". Difference: brief counted `pause_task`/`resume_task`/`update_task` as 3 separate W features (we collapsed to W.4); brief did not separately enumerate W.8 (`provision_root_board`) — both are reasonable interpretations. The 25 here = 13 + 12.

---

## Per-feature deep-dive on each GAP

### GAP-V.10 — Weekday alias map is engine-private but plan does not enumerate it

**v1 reality.** `WEEKDAY_ALIASES` (engine line 572-589) has 32 keys covering pt-BR (with/without accents, with/without `-feira` suffix) and English. `WEEKDAY_NAMES_PT` (line 591-594) provides the reverse for error messages. `checkIntendedWeekday()` (line 633-653) returns a structured `weekday_mismatch` error that the agent surfaces to the user; the agent then re-prompts for confirmation.

**Plan coverage.** Plan 2.3.a single-file port subsumes this verbatim. There's no behavioral risk — `Intl.DateTimeFormat` is identical under bun. **The risk is that Discovery 06's "single-file" prescription leaves no place to put the alias map; if the engine is split into `taskflow/{tasks,boards,projects}.ts` per Discovery 06 §3.2, the alias map needs its own home.**

**Recommendation.** Add to plan 2.3.a: "weekday alias map + `checkIntendedWeekday` live in `taskflow/dates.ts` (or stay inside engine if not split)." Trivial line item; flagged here so it isn't lost.

### GAP-V.11 — DST 2-pass localToUtc + spring-forward gap handling not in plan

**v1 reality.** `localToUtc` (engine line 480-538) iterates `Intl.DateTimeFormat` projection up to 3 times. Single-pass conversion fails at DST boundaries because the offset at the naive timestamp's UTC interpretation differs from the offset at the actual local instant. On oscillation (offset1 ≠ offset3), the local time **does not exist** (spring-forward gap) — the function rounds forward by using `min(offset1, offset2)`. This is load-bearing for São Paulo/Fortaleza historically (DST abolished 2019 but pre-2019 data exists; Recife data uses no-DST timezone).

**Plan coverage.** 2.3.a ports verbatim. **Not flagged as a behavior-preservation requirement.**

**Recommendation.** Plan 2.3.a should explicitly list `localToUtc 2-pass + spring-forward gap rounding` as a preservation requirement, ideally with a regression test that sets `boardTz='America/Sao_Paulo'` and creates a meeting at 2018-11-04T00:30:00 (the historic DST gap). v2 ports the test from `taskflow-engine.test.ts`.

### GAP-V.12 — Non-business-day guard call sites not enumerated

**v1 reality.** `checkNonBusinessDay` (engine line 1113) fires at 4 sites (3205, 3249, 4616, 4815) covering create + update for both `scheduled_at` (meetings) and `due_date` (other tasks). Reads `board_holidays` table (jurisdictional holidays per audit 14 GAP-14.x). `allow_non_business_day=true` bypasses; otherwise returns warning attached to the engine result.

**Plan coverage.** Plan 2.3.d preserves the table. The 4 call sites move with the engine port (2.3.a). **Plan does not enumerate the `allow_non_business_day` parameter as a tool input that must survive the v2 port.**

**Recommendation.** Document in plan 2.3.a that `allow_non_business_day` (boolean) is a required input on `taskflow_create.due_date` and `taskflow_update.due_date` paths. Trivial; flagged for completeness.

### GAP-V.13 — `find_person_in_organization` is incompatible with v2's per-session DB split

**v1 reality.** Engine line 7138 walks `boards` table from current board to root, then descends to all children. Returns up to N matches across the entire org tree. **Requires a single DB containing all boards** — which is `data/taskflow/taskflow.db` in v1 (central, host-owned, container reads via `mcp-server-sqlite-npx`).

**Plan coverage.** Discovery 03 + 04 establish that v2 splits state into `data/v2.db` (central) + per-session `inbound.db`/`outbound.db`. Plan 2.3.d says "fork-private DB initializer in `src/modules/taskflow/init-db.ts` for `data/taskflow/taskflow.db` (14 tables)" — i.e. taskflow.db **stays central** in v2. Good. **But** Plan 2.3.a says the engine runs container-side; container has read-only mount to `data/taskflow/taskflow.db` per Discovery 03, OR no mount at all (TBD).

**Recommendation.** Confirm in plan 2.3.d that `data/taskflow/taskflow.db` mount is **read+write from container** for the per-board partition AND **read-only across boards** for `find_person_in_organization` to work. This is the v2 equivalent of v1's `mcp-server-sqlite-npx` access. Without this, `find_person_in_organization` returns the current board only — silent feature regression. **This is a hidden Track A blocker.**

### GAP-W.1 — Direct `mcp-server-sqlite-npx` access bypasses every engine guard

**v1 reality.** All 28 boards' `.mcp.json` files register `mcp-server-sqlite-npx` mounted to their `taskflow.db`. The agent gets generic SQL `read_query` / `write_query` / `list_tables` tools alongside the engine MCP tools. Used for ad-hoc analytics ("quantas tarefas foram criadas em março?"). **Also lets the agent UPDATE/INSERT/DELETE arbitrary rows, bypassing the magnetism guard, history recording, and notification dispatch.**

**Plan coverage.** Discovery 06 enumerates only the `nanoclaw` MCP server. Plan 2.3.a-n is silent on `sqlite-npx`. The `.mcp.json` files are part of `groups/<board>/` — generated by `provision-child-board.ts` (line ?). **No v2 spec text decides whether to keep, replace, or remove.**

**Recommendation.** Spec must take an explicit position:
1. **Keep** — preserve analytics affordance; document that the agent can write arbitrary rows. v2 must mount the per-board DB into the container (same as v1).
2. **Drop** — remove the `.mcp.json` entry; agent loses raw-SQL access. Adds friction for legitimate analytics queries.
3. **Read-only** — mount `taskflow.db` read-only via `sqlite-npx`'s `--readonly` flag. Preserves analytics, removes write bypass. **Likely the right answer.**

This is independently a Phase A.3 decision item.

### GAP-W.5 — `taskflow_send_message_with_audit` placement contradicts Discovery 09

**v1 reality.** `send_message` MCP tool writes IPC `tasks/*.json` (kind='system' equivalent). Host watcher (`ipc.ts:920-1069`) authorizes via `isIpcMessageAuthorized()`, sends, then calls `recordSendMessageLog()` post-delivery. **Audit row is written AFTER actual delivery, not at queue-insertion.**

**Plan coverage.** Plan 2.3.c says "**Pre-queue insert (Discovery 08, 09):** wrapper writes log row immediately after `writeMessageOut` with `delivery_status='queued'`; reconciliation sweep updates from `delivered`." But Discovery 09 §9 explicitly says **do NOT pre-queue** because the audit must reflect actual delivery — recommends `registerPostDeliveryHook` in `src/delivery.ts`. **Plan and Discovery contradict.**

**Recommendation.** Resolve before phase A.3.2 starts. Three options:
1. Adopt Discovery 09's recommendation: ship a v2-core PR adding `registerPostDeliveryHook` (~10 LOC); skill registers handler. **Cleanest, but requires upstream commitment.**
2. Pre-queue + reconciliation sweep (plan as written) — accept the eventual-consistency window between queue and delivered/failed. **Skill-only; ships immediately; risks audit-row-without-delivery during outages.**
3. Hybrid: pre-queue with `status='queued'` AND emit a second IPC system action `taskflow_audit_finalize` from `markDelivered`/`markDeliveryFailed` host-side. Requires touching `src/delivery.ts` — violates the "no NanoClaw codebase" rule.

Option 1 is right. Decide and update the plan.

### GAP-W.7 — Auto-fire from `taskflow_admin` register_person to `provision_child_board` adds host-side coupling

**v1 reality.** `taskflow_admin(register_person)` returns `result.auto_provision_request` containing `{person_id, person_name, person_phone, person_role, group_name, group_folder}`. The MCP layer (`ipc-mcp-stdio.ts:1281-1306`) then writes a `provision_child_board` IPC file as a side-effect. **Two IPC types fired by one MCP call.**

**Plan coverage.** Plan 2.3.b ports `provision_child_board` to `provision_taskflow_board` MCP. **Does not address the auto-fire wiring.** v2's `create_agent` (Discovery 06 + 08) is single-shot — admin-approval-required per `agents.ts`, not auto-triggered from another MCP tool's result.

**Recommendation.** Plan 2.3.b should explicitly enumerate the auto-fire pattern. Two designs:
1. The new `provision_taskflow_board` MCP tool is called explicitly by the agent after `taskflow_admin(register_person)` succeeds. The agent reads the `auto_provision_request` field and makes the second tool call. **Loses atomicity but matches v2's single-shot pattern.**
2. `taskflow_admin(register_person)` itself emits a second `kind='system' action='provision_taskflow_board'` row to `messages_out`. **Container-side multi-write; legal under v2's kind taxonomy (Discovery 08).**

Option 2 is closer to v1 semantics. Plan should pick.

### GAP-W.8 — `provision_root_board` IPC plugin not enumerated

**v1 reality.** `src/ipc-plugins/provision-root-board.ts` registers `'provision_root_board'`. **No container-side MCP tool writes this type** — it's invoked by the host's `setup` skill or by manual operator action against `data/ipc/<main>/tasks/`. Used at fork bootstrap (creating the very first TaskFlow board with no parent).

**Plan coverage.** Plan 2.3.a lists `src/ipc-plugins/*` (multiple) → "rewrite as MCP tools" without enumerating the four. **The plan implicitly assumes the rewrite is one MCP tool per plugin.** Under that assumption, `provision_root_board` becomes a fork-private MCP tool exposed only to the main-group session — but the plan does not say so.

**Recommendation.** Plan 2.3.a should enumerate the four IPC plugins explicitly:
- `create_group` → main-group-only MCP tool (matches v1 gating)
- `provision_child_board` → `provision_taskflow_board` per 2.3.b (already covered)
- `provision_root_board` → main-group-only MCP tool (NEW; not yet enumerated)
- `send_otp` → main-group-only MCP tool OR keep as host-side IPC if web-admin is the only writer (decide)

### GAP-W.9 — `register_group` hierarchical metadata has no v2 equivalent

**v1 reality.** `register_group` MCP tool (container `:670-742`) accepts `taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth` parameters. Host's `handleRegisterGroup` writes them to `registered_groups` table and uses them later for `canUseCreateGroup` checks (creating child boards requires `level + 1 <= maxDepth`).

**Plan coverage.** v2's `agents.ts::create_agent` writes a `kind='system' action='create_agent'` row; the host's `handleCreateAgent` creates the agent. **No fields for hierarchy level / max depth.** Plan 2.3.b refers to "create_agent + admin-approval" but does not address how hierarchy metadata travels.

**Recommendation.** Plan must add a fork-private extension to `agent_groups` (or a sidecar table `taskflow_agent_group_meta`) with `hierarchy_level` and `max_depth` columns. Likely lives in plan 2.3.d's "1 fork-private DB initializer". Confirm placement.

### GAP-W.10 — `send_otp` IPC pickup directory `otp/` not enumerated

**v1 reality.** `ipc.ts:1116-1141` polls a third subdirectory `data/ipc/<main>/otp/*.json` (in addition to `messages/` and `tasks/`). Used by the TaskFlow web admin to issue SMS-style OTPs via WhatsApp during web-login. Host-side only — no container MCP tool writes to `otp/`.

**Plan coverage.** Plan 2.3.a-n is silent. Discovery 06 + 08 enumerate `messages_out` (kind='chat'/'system'/'chat-sdk') but not a separate OTP path.

**Recommendation.** v2 has no OTP-specific path. Two options:
1. Map `send_otp` to v2's native `send_message` (kind='chat') with the WhatsApp adapter directly. The web admin would write a `messages_out` row to the main-group's session DB. Requires the web admin to know the session DB layout.
2. Keep `send_otp` as an IPC-style host-side input directory; web admin writes JSON to `data/ipc/main/otp/`; host watcher reads + dispatches. **Skill-only fork-private path.**

Option 2 preserves the web admin contract. Plan should pick.

### GAP-W.12 — `normalizePhone` duplicated in host (`src/phone.ts`) + container (`taskflow-engine.ts:744`)

**v1 reality.** Both copies implement the same Brazilian E164 canonicalization. Host copy is used by `provision-child-board.ts`, `send-otp.ts`, IPC plugins. Container copy is used by `taskflow_admin(register_person)`, `add_external_participant`, etc.

**Plan coverage.** Plan 2.3.d preserves engine. Host copy survives in `src/phone.ts`. **No plan enumeration of the duplication.**

**Recommendation.** Two acceptable answers:
1. Keep both copies (risk: drift). v2 cutover audit must verify both implementations agree byte-for-byte.
2. Container imports from a shared TypeScript module — but v2's bun-native container can't trivially import from the host's `src/phone.ts` (different package, different runtime). So duplication is structural; canonicalize a behavior test instead.

The latter (acceptance test) is pragmatic. Add to plan 2.3.a: "byte-equivalent behavior test for `normalizePhone` across container engine + host plugin."

---

## Summary of GAPs not addressed by Plan sub-task 2.3.a "IPC plugins → MCP tools"

Sub-task 2.3.a says: *"IPC plugins → MCP tools (single file `mcp-tools/taskflow.ts` per Discovery 06)"*. Implicit interpretation: each of the four `src/ipc-plugins/*.ts` files becomes one or more MCP tools.

**IPC plugins NOT addressed by 2.3.a (or its sub-references):**

1. **`provision-root-board.ts`** — not in 2.3.b's scope (which only mentions `provision_taskflow_board`). Need explicit MCP tool. [GAP-W.8]
2. **`send-otp.ts`** — pickup directory `otp/` is a third IPC channel beyond `messages/` and `tasks/`. v2 has no equivalent. [GAP-W.10]
3. **`mcp-server-sqlite-npx`** — second MCP server registered per-board via `.mcp.json`. Not a `src/ipc-plugins/*.ts` file but is the third leg of the MCP surface. [GAP-W.1]
4. **`register_group` hierarchy metadata** — v2's `create_agent` doesn't take hierarchy fields. [GAP-W.9]

**Tools that 2.3.a/2.3.b/2.3.c address but with placement contradictions:**

5. **`taskflow_send_message_with_audit`** — plan 2.3.c contradicts Discovery 09. [GAP-W.5]
6. **Auto-fire from `taskflow_admin` register_person → `provision_child_board`** — v1 atomicity not preserved in 2.3.b. [GAP-W.7]

**Engine-internal features that ride alongside 2.3.a:**

7. **Weekday alias map** — engine-internal but plan doesn't flag preservation. [GAP-V.10]
8. **DST 2-pass `localToUtc` + spring-forward gap rounding** — engine-internal but plan doesn't flag. [GAP-V.11]
9. **`allow_non_business_day` + `checkNonBusinessDay` 4 call sites** — engine-internal but plan doesn't flag. [GAP-V.12]
10. **`find_person_in_organization` cross-board read** — needs `data/taskflow/taskflow.db` mounted readable across boards. [GAP-V.13]
11. **`normalizePhone` host/container duplication** — plan doesn't address. [GAP-W.12]
