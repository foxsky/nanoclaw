# `provision_root_board` v1 → v2 mapping (Phase A.3.2 sub-task 2.3.a.2)

User-locked design decisions from 2026-05-05 sign-off:
- **D1**: TaskFlow hierarchy fields (`taskflowManaged`, `hierarchy_level`, `max_depth`) stay on TaskFlow's own `boards` table. NO new columns on v2 `agent_groups` or `messaging_groups`.
- **D2**: Model override stays in `data/sessions/<folder>/.claude/settings.json`. No new column.
- **D3**: Board cron schedules (standup / digest / review) stay in TaskFlow's own DB (`scheduled_tasks` table — TaskFlow-private, not v2's central DB).
- **D4**: Confirmation + welcome messages dispatched synchronously via `adapter.deliver` (same path as 2.3.a.1 send_otp).
- **D5**: Drop the IPC-dirs phase entirely (v2 has session DBs; no `data/ipc/<folder>/`).

## v1 input schema (preserved verbatim — no feature loss)

```ts
{
  subject: string;                      // group/board name (auto-suffixed " - TaskFlow" if absent)
  person_id: string;                    // manager's TaskFlow person_id
  person_name: string;                  // manager's display name
  person_phone: string;                 // manager's phone (canonicalized via normalizePhone)
  person_role?: string;                 // default: "manager"
  short_code: string;                   // upper-cased, used in board id prefix
  participants?: string[];              // list of `<digits>@s.whatsapp.net` JIDs
  trigger?: string;                     // mention pattern, default "@Case"
  requires_trigger?: boolean;           // default: false
  language?: string;                    // default: "pt-BR"
  timezone?: string;                    // default: "America/Fortaleza"
  wip_limit?: number;                   // default: 5
  max_depth?: number;                   // default: 3
  model?: string;                       // default: "claude-sonnet-4-6"
  standup_cron_local?: string;          // default: "0 8 * * 1-5"
  digest_cron_local?: string;           // default: "0 18 * * 1-5"
  review_cron_local?: string;           // default: "0 11 * * 5"
  standup_cron_utc?: string;            // default: "0 11 * * 1-5"
  digest_cron_utc?: string;             // default: "0 21 * * 1-5"
  review_cron_utc?: string;             // default: "0 14 * * 5"
  group_context?: string;               // free-text, default: "<subject> task board"
  group_folder?: string;                // override; default: sanitized short_code + "-taskflow"
}
```

## v1 → v2 phase-by-phase

| v1 phase | v1 surface | v2 equivalent |
|---|---|---|
| **0. Permission gate** | `if (!isMain) drop` | reuse 2.3.a.1's per-CHAT gate via `messaging_groups.is_main_control` + wiring `session_mode != 'agent-shared'` + missing-wiring fail-closed |
| **1. createGroup dep** | `deps.createGroup` (mounted by IPC) | `getChannelAdapter('whatsapp').createGroup` (added in A.3.1) |
| **2. Validate input** | `subject || person_id || ...` non-empty trim | identical |
| **3. Parse defaults** | trigger from current group's RegisteredGroup | trigger from `messagingGroup.name` is N/A; pull from agent_groups or default to `'@Case'`. CHANGE: use the `messaging_group_agents.engage_pattern` for the source main chat as the trigger default, fall back to `'@Case'`. |
| **4. Compute folder + boardId** | `sanitizeFolder + uniqueFolder` | Same helpers ported into `src/modules/send-otp/...` actually no — into `src/modules/taskflow/provision-shared.ts` (new file). |
| **5. Open taskflow.db** | `new Database(TASKFLOW_DB_PATH)` | identical — TaskFlow has its own DB at `data/taskflow/taskflow.db`. |
| **6. Create WhatsApp group** | `deps.createGroup(subject, [...participants])` returns `{jid, subject}` | `adapter.createGroup(subject, [...participants])` returns `{jid, subject, droppedParticipants?, inviteLink?}` — extra fields surface to operator. |
| **7. Seed taskflow.db** | INSERT into boards / board_config / board_runtime_config / board_admins / board_people / task_history | identical SQL — TaskFlow domain unchanged. |
| **8. Register group** | `deps.registerGroup(jid, RegisteredGroup{...})` writes registered_groups.json | v2 split: `createAgentGroup` + `createMessagingGroup` + `createMessagingGroupAgent` + (auto-creates `agent_destinations`) — see `src/db/messaging-groups.ts`. v1's `taskflowManaged` / `taskflowHierarchyLevel` / `taskflowMaxDepth` already live in `boards` (per D1). |
| **9. Create filesystem** | `createBoardFilesystem` writes CLAUDE.md + .mcp.json + onboarding files + logs/ | v2 `initGroupFilesystem(agentGroup, {instructions: renderedClaudeMd})` writes CLAUDE.local.md from the same rendered template. .mcp.json + onboarding files written separately (v2's initGroupFilesystem doesn't handle them). logs/ dir — drop (v2 logs are centralized at `logs/nanoclaw.log`). |
| **10. settings.json** | `data/sessions/<folder>/.claude/settings.json` with `{model}` | per D2 — write to `data/v2-sessions/<agentGroupId>/.claude-shared/settings.json` with `{model, env: {...defaults}}`. Or write in `data/sessions/<folder>/.claude/` per v1 layout. **Sub-decision needed: which path?** v2 writes to `.claude-shared` (new layout); v1 wrote to `.claude` (Claude Code's discovery dir). For Claude Code SDK to pick up the model override, the SDK reads `.claude/settings.json` from the working directory. v2's `.claude-shared/` is mounted as `.claude/` inside the container (per docs/build-and-runtime.md). **Decision: write to v2's `.claude-shared/settings.json`, merge model into the existing env object.** |
| **10b. seedAvailableGroupsJson** | writes available_groups.json in IPC dir | DROP per D5 (no IPC dirs). |
| **11. scheduleRunners** | createTask × 3 (standup/digest/review) into central scheduled_tasks | per D3 — write to TaskFlow's own scheduled_tasks table (TaskFlow-private; same code path as v1). The `taskflow.db` IS TaskFlow-private; v2 doesn't share it. |
| **12. Create IPC dirs** | mkdir `data/ipc/<folder>/messages` and `tasks` | DROP per D5. |
| **13. fixOwnership** | chown -R nanoclaw:nanoclaw | identical — still needed (container runs as `node` UID 1000 = `nanoclaw` UID 1000). |
| **14. Send confirmation** | `deps.sendMessage(mainGroupJid, '✅ Quadro raiz...', assistantName)` | per D4 — `adapter.deliver(mainGroupJid, null, {kind:'chat', content:{type:'text', text:'✅ Quadro raiz...'}})`. NB: chat envelope adds `${ASSISTANT_NAME}: ` prefix (same as v1). |
| **15. Send welcome** | `deps.sendMessage(newGroupJid, '👋 Bem-vindo...', assistantName)` + UPDATE board_runtime_config.welcome_sent | identical via adapter.deliver + same UPDATE. |
| **16. Schedule onboarding** | `scheduleOnboarding` writes 5 future tasks into central scheduled_tasks | identical (TaskFlow-private scheduled_tasks). |

## New files

```
container/agent-runner/src/mcp-tools/
  provision-root-board.ts            # NEW MCP tool (validation + outbound system row)
  provision-root-board.test.ts       # NEW bun:test

src/modules/taskflow/
  provision-shared.ts                # NEW — port of v1 provision-shared helpers (sanitizeFolder, uniqueFolder, BoardRow types, generateClaudeMd, ONBOARDING_FILES, scheduleOnboarding, scheduleRunners, createBoardFilesystem, fixOwnership, TASKFLOW_DB_PATH, etc.)
  provision-root-board.ts            # NEW host-side delivery action handler
  provision-root-board.test.ts       # NEW vitest
  index.ts                           # NEW — registerDeliveryAction('provision_root_board', ...)

src/modules/index.ts                 # + import './taskflow/index.js'
container/agent-runner/src/mcp-tools/index.ts  # + import './provision-root-board.js'
```

## Permission gate (reused from 2.3.a.1)

The `provision_root_board` action runs the SAME 5-step gate evaluation as `send_otp`:
1. session.messaging_group_id != null
2. wiring exists for (messaging_group_id, agent_group_id)
3. wiring.session_mode != 'agent-shared'
4. messaging_group exists
5. messaging_group.is_main_control === 1

Factored out as a shared helper `requireMainControlSession(session): { ok: true, mg } | { ok: false }` in `src/modules/taskflow/permission.ts`. Used by all 5 provision_* / create_group_in_board / send_otp ports.

**Refactor scope creep risk**: extracting this from the 2.3.a.1 send-otp handler is cleaner but causes a diff against an already-shipped commit. Decision: extract NOW (in 2.3.a.2) since this is the second consumer; back-update send-otp/handler.ts to use the shared helper.

## Test strategy

**Container MCP tool** (bun:test):
- Schema validates required fields (subject, person_id, person_name, person_phone, short_code)
- On valid input, writes kind:'system' outbound row with action='provision_root_board' + payload
- Validation errors return isError:true (parity with send_otp)

**Host action handler** (vitest):
- Permission gate (5 cases reuse 2.3.a.1 patterns — through the shared helper)
- Validation (missing fields, normalized phone)
- WhatsApp group creation (mocks adapter.createGroup, asserts subject + participants)
- taskflow.db seed transaction (mock TaskFlow DB; assert all 5 tables get rows; assert atomicity = no half-state on error)
- v2 wiring registration (mock createAgentGroup + createMessagingGroup + createMessagingGroupAgent; assert all 3 called with right args)
- Filesystem creation (mock fs; assert CLAUDE.local.md content has rendered template)
- settings.json write
- scheduleRunners writes 3 cron rows + UPDATE board_runtime_config (mock taskflow.db)
- Confirmation + welcome message (mock adapter.deliver with object content per BLOCKER #1 fix)
- scheduleOnboarding writes 5 rows
- fixOwnership invocation (no behavior assertion; just spy)

## Acknowledged deferred

- **Bootstrap of is_main_control during /setup**: docs gap from Codex IMPORTANT #5 in 2.3.a.1.b review — closes in 2.5/2.6 skill bootstrap step.
- **Container-side defense-in-depth env-var gate**: host-only enforcement still authoritative; container mirror deferred.
- **Composed CLAUDE.md vs v1 single-file CLAUDE.md**: v2 has `composeGroupClaudeMd` rebuilding on each spawn. The v1 template content goes to `CLAUDE.local.md` (per-group memory), not the composed CLAUDE.md. **Net effect on the agent**: identical instruction set, just split across two files inside the container's view of /workspace/group/. No behavior loss.

## Estimated commit size

- `provision-shared.ts` (helpers): ~300 LOC (port of 384 LOC v1, dropping IPC artifacts + chown variant)
- `provision-root-board.ts` (handler): ~250 LOC (down from v1's 534 LOC because v2 splits some concerns into other modules)
- `provision-root-board.ts` (MCP tool): ~70 LOC (similar shape to send-otp)
- Tests: ~600 LOC across 2 files
- Permission helper extraction: ~30 LOC (refactor of send-otp/handler.ts)
- Total new/modified: ~1250 LOC
