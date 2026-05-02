# v2 Feature Evaluation — TaskFlow + Memory Skills

> **Date:** 2026-05-02. **Source:** `upstream/main @ 1b08b58f` (pinned baseline) + `upstream/channels` for adapter-side. **Status:** **REVISED post-Codex review #5** — see "Corrections (Codex review #5)" section below. Original claims preserved with strikethroughs; corrected dispositions follow.

## Scope

For each v2 capability not already in v1.2.53, classify by impact on our `add-taskflow` + memory skills (`add-taskflow-memory`, `add-long-term-context`, `add-embeddings`):

- **REPLACE** — v2 ships natively what we built fork-privately. Drop the fork code at cutover; consume v2 primitive.
- **ENHANCE** — v2 ships a primitive we don't have but should adopt to improve UX/correctness.
- **PARTIAL** — overlaps but not a clean replacement; needs case-by-case.
- **SKIP** — not relevant to our 28-board WhatsApp deployment.

## Headline takeaways

(Original — partially wrong; see Corrections section.)

1. ~~**5 fork-private TaskFlow primitives are fully replaced by v2 natives**~~
2. ~~**3 v2 features substantially enhance TaskFlow**~~
3. ~~**2 v2 features are post-cutover follow-ups**~~
4. ~~**Major architectural unlock**: `ask_user_question` replaces cross-board approval~~

**Corrected (post-Codex):** **2 fully REPLACE** (R1, the migrate-v2-driven user_roles seed for board admins is also new work), **5 PARTIALLY REPLACE** (need fork-private supplements), **3 ENHANCE** (E2, E4, E6 confirmed clean). **3 ENHANCE were over-claimed** (E3 fails on WhatsApp adapter, E5 needs operator setup, E7 has real adoption cost). **R2 cross-board approval is NOT durable in v2 — fork-private retention required for multi-day workflows.**

---

## Corrections (Codex review #5, gpt-5.5/high, 2026-05-02)

Codex skeptical review of original claims found **3 BLOCKERS + 3 IMPORTANTs + 3 missed v2 features**. The original "5 REPLACE" claim was over-confident; the truthful breakdown is below.

### Blockers (would derail Phase A.3 if shipped as-written)

**B1. R2 is FALSE — `ask_user_question` cannot replace multi-day cross-board approval.**

Evidence (`container/agent-runner/src/mcp-tools/interactive.ts:74-128`): `ask_user_question` has a 300s default timeout; on timeout it returns an error to the agent. Late admin responses arrive as `kind='system'` messages (`src/modules/interactive/index.ts:33-48`) which the container's poll loop **filters out** (`container/agent-runner/src/poll-loop.ts:66-67`). So even if the admin replies a day later, the agent that asked is gone and the answer is dropped on arrival.

Our cross-board approval today uses `subtask_requests` table that survives indefinitely until approved/cancelled — a child board sends a request to its parent and waits for any admin to reply, possibly across days. v2's `ask_user_question` does not support this workflow.

**Disposition (revised):** R2 → **PARTIAL**, not REPLACE. `ask_user_question` is great for *short-lived in-session prompts* (within 300s — e.g., "Confirm deletion?" while the user is actively in the chat). Cross-board multi-day approval requires keeping `subtask_requests` (or equivalent) as a fork-private TaskFlow table. Could augment with a recurring `schedule_task` that re-asks every N hours until a row is marked answered. Net: TaskFlow approval logic STAYS in `add-taskflow`, with `ask_user_question` adopted only for ≤300s prompts.

**B2. R4 is PARTIALLY-WRONG — `destinations` doesn't replace external-participant DM routing.**

Evidence: I conflated two distinct tables. The session-DB-side `destinations` table has a global `name PRIMARY KEY` (`src/db/schema.ts:191-198`); the central `agent_destinations` table is per-agent `(agent_group_id, local_name)` (`src/db/migrations/module-agent-to-agent-destinations.ts:26-34`). ACL is enforced at delivery (`src/delivery.ts:288-309`) and routing (`src/modules/agent-to-agent/agent-route.ts:106-118`), but there's **no denied-channel safety check on outbound delivery** (`src/modules/agent-to-agent/write-destinations.ts:26-37` projects denied groups if a row exists).

More importantly: TaskFlow's external-meeting-participant DM routing (where an external person we don't have a wired channel for needs to receive a DM about a meeting) is **not addressed by `destinations`**. That feature requires our `dm-routing.ts` logic which reads `taskflow.db` for participant lookup.

**Disposition (revised):** R4 → **PARTIAL**. `destinations` replaces *some* cross-board work (named in-fleet routing). External DM routing stays in `add-taskflow` (via `dm-routing.ts` extraction).

**B3. R5's "NO Phase A work" is WRONG.**

Evidence: core `isMain` count is effectively 0 in upstream/main (only stale example in `container/build.sh:45`); v2's privilege model is real (`src/db/schema.ts:61-91`, `src/modules/permissions/db/user-roles.ts:36-60`). BUT — the migrate-v2 driver only seeds the global owner + members for v1's allowlist (`/root/nanoclaw-migrate-v2/setup/migrate/seed-v2.ts:262-347`). It does NOT seed TaskFlow's `board_admins` table → scoped `user_roles` rows. We have to do this seeding ourselves in `add-taskflow`'s extraction.

**Disposition (revised):** R5 → **REPLACE for core isMain hits** (v2 main has migrated those) + **NEW WORK in `add-taskflow`** (Phase A.3 must include a board-admin → user_roles seeder, mapping `board_admins.is_primary_manager=1` to scoped `'admin'` role per memory `project_v2_user_roles_invariant.md`).

### Importants (fix before Phase A.2/A.3 starts)

**I1. R3 seeding is dangerous.** Original disposition said "TaskFlow board provisioning seeds `engage_pattern='@<board-trigger>'`" (e.g. `@Case`). Per `migrate-v2:seed-v2.ts:375-386`, the correct seeding for production traffic is `engage_pattern='.'` ("always engage", regardless of trigger string). Setting `@Case` would DROP messages that don't include the literal `@Case` mention — production regression on day one.

**Disposition (revised):** TaskFlow boards seed `engage_mode='pattern'` + `engage_pattern='.'` (not `@<trigger>`). Per-board agent prefix (`Case:` etc.) is an **agent-side convention** in CLAUDE.md prompts, NOT v2-router-driven dispatch.

**I2. E3 (`edit_message`) is FALSE for WhatsApp.** Native WhatsApp adapter (`upstream/channels:src/channels/whatsapp.ts:650-695`) only handles `reaction` + normal sends — no `operation === 'edit'` handler. Chat SDK bridge supports edit (`upstream/channels:src/channels/chat-sdk-bridge.ts:357-361`), but we don't use Chat SDK.

**Disposition (revised):** E3 → **REMOVED** from the recommendations. Either drop the placeholder→edit pattern, OR contribute an edit handler to upstream/channels' WhatsApp adapter (post-cutover).

**I3. E7 (mount-security) has real adoption cost.** v2's mount-security is **DEFAULT** (not opt-in) at `src/container-runner.ts:323-327`. Without `~/.config/nanoclaw/mount-allowlist.json`, additional mounts are silently blocked (`src/modules/mount-security/index.ts:74-83, 230-239`). TaskFlow uses additional mounts for board folders + future Gmail/Calendar.

**Disposition (revised):** E7 → adoption cost is **non-zero**. `add-taskflow` install must populate the allowlist file with TaskFlow's required mounts. If we miss this, board provisioning silently fails. Belongs in Phase A.3 (TaskFlow extraction).

### Other corrections

- **R1** (`schedule_task`) → **PARTIALLY-WRONG**. Recurrence uses `cron-parser.next()` from "now" not from prior scheduled time (`src/modules/scheduling/recurrence.ts:21-37`); missed windows during downtime are SKIPPED. Our v1's task-scheduler does catch-up runs. If TaskFlow's daily Kipp cron is missed (host down at 04:00), v2 won't replay. Need to verify: is missed-run catch-up a TaskFlow requirement? If yes, fork-private logic stays.
- **E5** (`add-dashboard`) → **PARTIALLY-WRONG**. Skill exists but doesn't auto-install at runtime — operator copies `resources/dashboard-pusher.ts` to `src/dashboard-pusher.ts` (`upstream/main:.claude/skills/add-dashboard/SKILL.md:31-79`). Treat as post-cutover OPTIONAL.
- **P3** (`messages_in.kind`) → **PARTIALLY-WRONG**. `'webhook'` value has no real producer (`container/agent-runner/src/formatter.ts:124`, `poll-loop.test.ts:55` only). 4 of 5 kinds are real ('chat', 'chat-sdk', 'task', 'system').
- **R2 alternate**: late `system`-kind responses are filtered. If we want durable cross-board approval via v2, need a different pattern than `ask_user_question`.

### v2 features I MISSED (Codex)

**M1. `ignored_message_policy='accumulate'`** (`src/router.ts:310-319`). Materially changes how non-trigger context is preserved. When a message doesn't engage but `accumulate` is set, it's stored for the agent's next turn. Useful for TaskFlow boards where context matters across triggered messages. **Adopt:** TaskFlow board provisioning sets `ignored_message_policy='accumulate'` on `messaging_group_agents` (verify per-board if accumulate or drop is desired).

**M2. `sender_scope='known'`** (`src/modules/permissions/index.ts:193-208`). Per-wiring sender restriction separate from `unknown_sender_policy`. Could let TaskFlow boards have stricter membership than the messaging group's policy. **Adopt:** consider for boards that should only respond to known board members (vs anyone in the chat).

**M3. `pending_channel_approvals`** (`src/db/migrations/012-channel-registration.ts:34-46`). Distinct from sender approval — covers the case where an entirely new DM/group messages NanoClaw and an admin must approve registering it. Affects onboarding when new govt departments adopt TaskFlow. **Adopt:** could simplify our operator-driven board-onboarding flow further.

### LOC estimate — OVER-OPTIMISTIC

Original claim: `add-taskflow` shrinks from 23K LOC → 12-14K LOC.

Codex sample: `taskflow-engine.ts` (9,598 LOC) + `taskflow-mcp-server.ts` (611 LOC) + `taskflow-db.ts` (783 LOC) = 10,992 LOC of the largest 3 files. Most of this is **TaskFlow domain logic** — Kanban schema/lifecycle, meetings, recurrence engine, WIP enforcement, hierarchy, holidays, external-participant flows. The R1+R2+R4 replacements only touch scheduling glue, approval protocol, and routing wrappers (a small fraction of the engine).

**Revised LOC estimate:** `add-taskflow` shrinks from 23K → **18-20K LOC** (not 12-14K). Roughly 3-5K LOC deletion from R1 (scheduling glue), R2 partial (subtask_requests STAYS but approval-card render uses `ask_user_question` for short prompts), R4 partial (named in-fleet destinations replace some JID lookups), R5 (isMain hits gone — but this is mostly host-side, not in taskflow-engine). The bulk of taskflow-engine.ts is domain code that doesn't disappear.

### Updated summary table (vs original)

| ID | Original | Codex-corrected |
|---|---|---|
| R1 schedule_task | REPLACE (clean) | PARTIAL — verify catch-up requirement |
| R2 ask_user_question | REPLACE (clean) | **PARTIAL — fork keeps subtask_requests for multi-day workflows; v2 tool used for ≤300s prompts only** |
| R3 engage_pattern | REPLACE | **PARTIAL — seed `'.'` not `@<trigger>`; agent prefix is CLAUDE.md convention** |
| R4 destinations | REPLACE (clean) | **PARTIAL — external-DM routing stays in add-taskflow** |
| R5 user_roles | REPLACE (no Phase A) | **REPLACE for core + NEW WORK to seed board_admins → user_roles in Phase A.3** |
| E1 unregistered_senders | ENHANCE | CONFIRMED |
| E2 typing module | ENHANCE (zero cost) | CONFIRMED |
| E3 edit_message | ENHANCE | **REMOVED — WhatsApp adapter doesn't handle edit** |
| E4 add_reaction | ENHANCE | CONFIRMED |
| E5 add-dashboard | ENHANCE post-cutover | CONFIRMED with caveat (operator must copy pusher to src/) |
| E6 init-first-agent | ENHANCE | CONFIRMED |
| E7 mount-security | ENHANCE (zero cost today) | **PARTIAL — DEFAULT module; allowlist setup REQUIRED in Phase A.3** |
| E8 sender-approval | ENHANCE post-cutover | CONFIRMED with caveat (must set `unknown_sender_policy='request_approval'`) |
| P1 create_agent partial | CONFIRMED | CONFIRMED |
| P2 sender approval new | CONFIRMED | CONFIRMED |
| P3 messages_in.kind | PARTIAL | CONFIRMED ('webhook' aspirational; 4 of 5 kinds real) |
| **NEW M1** | n/a | `ignored_message_policy='accumulate'` — adopt for TaskFlow boards |
| **NEW M2** | n/a | `sender_scope='known'` — per-wiring restriction |
| **NEW M3** | n/a | `pending_channel_approvals` — onboarding flow |

### Implications for Phase A.3 (TaskFlow extraction)

- **Keep `subtask_requests` table** as a fork-private add-taskflow concept; integrate `ask_user_question` only for short prompts.
- **Add board_admins → user_roles seeder** as Phase A.3 task.
- **Set `engage_pattern='.'` not `@<trigger>`** in board provisioning seeds.
- **Drop `edit_message` recommendation** until WhatsApp adapter supports it.
- **Add mount-allowlist setup** to TaskFlow install steps.
- **Consider M1, M2, M3** during board provisioning script rewrite.
- **Revise LOC delete budget to ~3-5K** (not 9-11K).

---

## REPLACE: v2 ships these natively (ORIGINAL — see Corrections above)

### R1. Scheduled tasks (`schedule_task` MCP tool + `messages_in` recurrence)

**v2 surface:**
```ts
// container/agent-runner/src/mcp-tools/scheduling.ts
schedule_task(prompt, processAfter, recurrence?, script?)
list_tasks() / cancel_task(id) / pause_task(id) / resume_task(id) / update_task(id, ...)
```
`processAfter` is timezone-aware (interprets naive local timestamps in `<context timezone="..."/>`). `recurrence` is a cron expression evaluated in the user's timezone. `script` is an optional pre-agent script.

**What we replace:** our `src/task-scheduler.ts` (3 hits to `isMain`, ~500 LOC) + `scheduled_tasks` table + Kipp/digest/standup runners that re-implement scheduling.

**Migration path (Phase A.3):**
- `add-taskflow` board provisioning seeds use `schedule_task` MCP tool calls instead of writing to the v1 `scheduled_tasks` table.
- Our TaskFlow custom seeder for Kipp/digest/standup tasks gets ~70% smaller.
- v2 has a `kind` column on messages_in (`'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'`) — recurring agent tasks land as `kind='task'` with `recurrence` set.

**Net deletion:** ~500 LOC in `src/task-scheduler.ts` + ~200 LOC in TaskFlow's custom scheduling helpers. 1 schema migration (drop `scheduled_tasks`).

**Already on the v3.0 plan:** Phase A.3 Step 4b (engage_pattern config) and Step 1 (extract taskflow-engine.ts which contains scheduling helpers).

### R2. Approval cards (`ask_user_question` blocking MCP tool + `pending_questions` table)

**v2 surface:**
```ts
ask_user_question(title, question, options[], timeout=300)  // BLOCKING
// options: string OR {label, selectedLabel?, value?}
```
`pending_questions` table persists question state (`question_id`, `session_id`, `message_out_id`, `options_json`, `created_at`). Survives restart. `onAction(questionId, selectedValue, userId)` callback fires when user picks a matching option.

**What we replace:** our cross-board approval text protocol — `/aprovar <task-uuid>` / `/cancelar <task-uuid>` (currently in CLAUDE.md template + handle_subtask_approval logic). Plus our hypothetical "Permitir/Negar" sender-approval flow.

**Migration path (Phase A.3):**
- TaskFlow's cross-board subtask approval (`subtask_requests` table) becomes `ask_user_question` calls. The `pendingQuestions` map at the channel + the `pending_questions` DB table replace our subtask_requests table state.
- Sender approval, channel approval — same primitive.
- TaskFlow's PT-BR translation: pass `Permitir`/`Negar` as option labels; `optionToCommand` (in `whatsapp-fixes` whatsapp.ts) auto-generates `/permitir` / `/negar` slash commands.

**Net deletion:** `subtask_requests` table + ~300 LOC of subtask-approval handler in `taskflow-engine.ts`. The cross-board forwarding logic stays (it's a separate concern from approval).

### R3. Per-organization triggers (`messaging_group_agents.engage_pattern/engage_mode`)

**v2 surface:**
```sql
CREATE TABLE messaging_group_agents (
  agent_group_id          TEXT,
  engage_mode             TEXT NOT NULL DEFAULT 'mention',
                          -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern          TEXT,   -- regex; required when engage_mode='pattern'
  sender_scope            TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy  TEXT NOT NULL DEFAULT 'drop',
  ...
);
```
Four orthogonal axes (engage_mode, engage_pattern, sender_scope, ignored_message_policy) replace v1's opaque `trigger_rules` JSON + `response_scope` enum. v2's router consults these natively for inbound dispatch.

**What we replace:** v1's per-`registered_groups.trigger_pattern` (single string) + the implicit `is_from_me` allowlist + custom CLAUDE.md instructions that re-implement trigger logic.

**Migration path (Phase A.3):**
- `add-taskflow` board provisioning writes per-board `engage_pattern='@<board-trigger>'` (e.g. `@Case`, `@Audit`) into `messaging_group_agents`.
- v2's router handles inbound dispatch; no fork-private routing.
- Already noted in plan v3.0 Phase A.3 Step 4b.

**Net deletion:** v1's `trigger_pattern` column + ~50 LOC in `src/router.ts` doing pattern matching.

### R4. Outbound destination ACL (`destinations` table + `agent_destinations`)

**v2 surface:**
```sql
CREATE TABLE destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type    TEXT,            -- for type='channel'
  platform_id     TEXT,            -- for type='channel'
  agent_group_id  TEXT             -- for type='agent'
);
```
Agent calls `send_message(to: "audit-board", text: "...")` and v2 routes to the registered destination. `agent_destinations` controls who-can-message-whom (cross-board ACL).

**What we replace:** our cross-board forwarding pattern that writes directly to taskflow.db's `subtask_requests` + sends via JID lookup. With v2's destinations, an agent in board A says `to: "board-B-folder"` and v2 handles routing + permission check.

**Migration path (Phase A.3):**
- `add-taskflow` provisioning seeds the destinations table with named entries per board.
- Cross-board forward becomes: agent calls `send_message(to: "<target>")` instead of writing rows to taskflow.db.
- Permission check uses `agent_destinations` (the parent→child edge we already model).

**Net deletion:** ~200 LOC of cross-board JID-lookup + permission code in `taskflow-engine.ts`. Cleaner agent UX.

### R5. User-level privilege model (`users` + `user_roles` + `agent_group_members`)

**v2 surface:**
```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,  -- "phone:+1555...", "tg:123", "discord:456"
  display_name  TEXT,
  ...
);
CREATE TABLE user_roles (
  user_id          TEXT,
  role             TEXT,   -- 'owner' | 'admin'
  agent_group_id   TEXT    -- NULL for global; set for scoped admin
);
CREATE TABLE agent_group_members ( ... );  -- known membership
```
`isOwner(userId)` / `hasAdminRole(userId, agentGroupId)` / `isMember(userId, agentGroupId)` replace v1's `isMain(group)` boolean.

**What we replace:** ~169 hits to `isMain` across 20+ files in our v1 fork. v2 has migrated all of these to user-role checks.

**Migration path:** post-cutover, our skills consume v2's helpers. NO Phase A work — v2 main has done this for us. Our `add-taskflow` seed scripts populate `user_roles` for board admins (per memory `project_v2_user_roles_invariant.md`: scoped 'admin' for board admins, ONE global 'owner' for the operator).

**Net deletion:** ~169 isMain hits + the `is_main` column on `registered_groups`. Already accounted for in v3.0 plan.

---

## ENHANCE: v2 features we should adopt

### E1. `unregistered_senders` audit table

**v2 surface:**
```sql
CREATE TABLE unregistered_senders (
  channel_type, platform_id, user_id, sender_name, reason,
  messaging_group_id, agent_group_id,
  message_count, first_seen, last_seen
);
```
v2 records every dropped/blocked message into this table when sender-approval policy rejects.

**TaskFlow win:** add a section to our daily/weekly digest showing "X messages from unknown senders rejected this week" — operations visibility we don't currently have. Use case: detect spam-pattern senders, identify board-membership gaps.

**Adoption cost:** ~20 LOC to query the table in `add-taskflow`'s digest runner. Trivial.

### E2. Typing module with heartbeat-gated refresh

**v2 surface:** `src/modules/typing/index.ts` re-fires `setTyping` periodically while heartbeat shows agent is working; pauses post-delivery so the indicator can visually clear.

**TaskFlow win:** much better UX than our v1's one-shot setTyping. Currently the indicator goes stale during long agent thinking (Kipp audit, weekly review). v2's typing module is a **default module** (ships on main, no opt-in needed) — we just consume it post-cutover.

**Adoption cost:** zero. Native after cutover.

### E3. `edit_message` MCP tool

**v2 surface:** `edit_message(messageId, text)` — agent edits a previous message instead of sending new.

**TaskFlow win:** standup/digest "live update" pattern — initial message says "Computing digest...", agent edits it once content is ready. Today our agent sends two messages (placeholder then real) which clutters the chat. With `edit_message` it's one message with progressive content.

**Adoption cost:** update CLAUDE.md prompts in `add-taskflow/templates/CLAUDE.md.template` to call `edit_message` for placeholder/result patterns. ~10 LOC change to the template.

### E4. `add_reaction` MCP tool

**v2 surface:** `add_reaction(messageId, emoji)` — bot reacts to user message with ✅/❌/etc.

**TaskFlow win:** standardize what we already do informally (Kipp uses 👍 for clean audit days). Today our agent constructs reaction WhatsApp payloads inline; v2 gives a typed contract. Plus `add-reactions` skill (upstream, already on our local) provides the channel-side support.

**Adoption cost:** update CLAUDE.md prompts to use `add_reaction` instead of inline reaction strings. ~5 LOC.

### E5. `add-dashboard` skill (post-cutover monitoring)

**v2 surface:** `@nanoco/nanoclaw-dashboard` npm package + a pusher that posts agent-group/session/channel/token-usage/context-window/log JSON every 60s.

**TaskFlow win:** real-time visibility into our 28 boards' activity. Currently only Kipp daily report + manual log inspection. Dashboard would surface stuck containers, token-budget issues, channel disconnections without reactive log-grepping.

**Adoption cost:** install `@nanoco/nanoclaw-dashboard` + apply `add-dashboard` skill (upstream). Boards with own admin DM get their own dashboard view. ~1 day of operator work post-cutover. Doesn't block migration.

### E6. `init-first-agent` skill (board-provisioning UX)

**v2 surface:** walks operator through creating the first NanoClaw agent for a DM channel — resolves operator identity, wires DM messaging group, triggers welcome DM.

**TaskFlow win:** simplifies our board-provisioning UX. Today, operator runs `provision-root-board.ts` IPC plugin via a slash command; the script does multi-step wiring + WhatsApp group creation + admin permission grant. v2's `init-first-agent` skill provides the OPERATOR-walkthrough scaffold; we layer TaskFlow-specific steps on top.

**Adoption cost:** `add-taskflow` SKILL.md references `init-first-agent` as the recommended onboarding flow; TaskFlow's "provision a new department's board" wizard wraps it. ~½ day to integrate.

### E7. `mount-security` module + `additionalMounts` allowlist

**v2 surface:** `~/.config/nanoclaw/mount-allowlist.json` controls which directories agents can mount via `additionalMounts` in `container.json`. Tamper-proof from agents (not mounted into containers).

**TaskFlow win:** future Calendar/Gmail integration with OneCLI stub credentials at `~/.gmail-mcp/`, `~/.calendar-mcp/` — these need allowlisted mounts. Plus secures TaskFlow group-folder mounts against escape.

**Adoption cost:** zero migration cost. Adopt when we wire Gmail/Calendar (post-cutover).

---

## PARTIAL: v2 overlaps but doesn't fully replace

### P1. `create_agent` MCP tool vs our board provisioning

**v2 surface:** `create_agent(name, instructions)` — admin-only, fire-and-forget. Creates a long-lived companion sub-agent. Writes to `messages_out` with `kind='system'`, `action='create_agent'`.

**Overlap:** sounds like our `provision-child-board` IPC plugin.

**Why it's PARTIAL not REPLACE:**
- v2's `create_agent` creates an agent_group + a new container. Our board provisioning ALSO creates a WhatsApp group with N participants, seeds `taskflow.db` with 6-column Kanban schema, sets up scheduled tasks, configures admin permissions, writes board-specific CLAUDE.md.
- v2 supplies the agent_group skeleton; we still do the WhatsApp + TaskFlow seeding on top.

**Migration path:** TaskFlow's provision-board MCP tool (per Decision 1) calls `create_agent` first, then layers TaskFlow-specific seeding via additional delivery actions. ~40% LOC reduction in board provisioning.

### P2. `pending_sender_approvals` vs our (non-existent) sender flow

**v2 surface:** sender-approval pattern via `pending_sender_approvals` table + `requestSenderApproval()` + admin DM card with `ask_user_question`.

**Overlap:** our v1 doesn't actually have an automated sender-approval flow. Onboarding is operator-driven (operator manually adds new participants via `provision-shared.ts` IPC).

**Why it's PARTIAL:** v2 introduces capability we don't currently have. Adopting it ENHANCES our 28 boards (admin gets a card asking "Allow this new sender?" instead of operator action). But it's not REPLACING anything — it's NEW capability.

**Disposition:** treat as **ENHANCE for `add-taskflow`** (E8): post-cutover, switch from operator-driven onboarding to admin-card-driven. Saves operator hours per week.

### P3. v2 `kind` field on `messages_in` for memory provenance

**v2 surface:** `messages_in.kind ∈ {'chat', 'chat-sdk', 'task', 'webhook', 'system'}` — distinguishes message origin.

**Memory skill win:** `add-taskflow-memory` and `add-long-term-context` currently treat all turns identically. With `kind`, we could:
- Filter `kind='system'` (agent-control messages) from memory extraction.
- Tag `kind='task'` recurring runs separately so memory recall doesn't drown in standup-pattern repetition.
- Weight `kind='chat'` (genuine user input) higher in recall preamble.

**Why it's PARTIAL:** memory skills currently work fine without it; this is an opportunity, not a fix.

**Migration path:** post-cutover memory skill follow-up. ~50 LOC change to filter/weight by `kind` in recall preamble.

---

## SKIP: not relevant

- **`add-discord`, `add-slack`, `add-telegram`, `add-imessage`, `add-matrix`, `add-gchat`, `add-webex`, `add-wechat`, `add-microsoft-teams`** — we're WhatsApp-only.
- **`whatsapp-cloud.ts`** — we use Baileys (personal WhatsApp), not Cloud API.
- **`add-codex`, `add-codex-provider`, `add-opencode-provider`** — we're Anthropic-only.
- **`add-vercel-deployments`, `add-resend-email`** — out of scope.
- **`self-mod` (`install_packages`, `add_mcp_server`)** — agents requesting to install packages is a security-sensitive feature we'd want to disable for our 28 government IT boards. Possibly enable for a sandboxed dev board only.

---

## Summary table

| ID | v2 feature | Disposition | Skill impact | Effort |
|---|---|---|---|---|
| R1 | `schedule_task` MCP tool + recurrence | REPLACE | `add-taskflow` (drop `task-scheduler.ts`) | included in Phase A.3 |
| R2 | `ask_user_question` + `pending_questions` | REPLACE | `add-taskflow` (drop subtask_requests + approval text protocol) | included in Phase A.3 |
| R3 | `engage_pattern`/`engage_mode` per-board triggers | REPLACE | `add-taskflow` (board provisioning seeds these) | included in Phase A.3 |
| R4 | `destinations` named outbound ACL | REPLACE | `add-taskflow` (drop ~200 LOC cross-board JID-lookup) | included in Phase A.3 |
| R5 | `users` + `user_roles` + `agent_group_members` | REPLACE | `add-taskflow` (drop isMain checks; seed user_roles) | included in v3.0 plan |
| E1 | `unregistered_senders` audit | ENHANCE | `add-taskflow` (digest section) | +1 hour |
| E2 | typing module with heartbeat refresh | ENHANCE | zero adoption (default module) | 0 |
| E3 | `edit_message` MCP tool | ENHANCE | CLAUDE.md.template — placeholder→edit pattern | +1 hour |
| E4 | `add_reaction` MCP tool | ENHANCE | CLAUDE.md.template — standardize reactions | +30 min |
| E5 | `add-dashboard` skill | ENHANCE (post-cutover) | operator workflow | +1 day post-cutover |
| E6 | `init-first-agent` skill | ENHANCE | board-provisioning UX | +½ day |
| E7 | `mount-security` allowlist | ENHANCE (when Gmail/Calendar arrives) | future feature | 0 today |
| E8 | sender-approval flow (P2 promoted) | ENHANCE | `add-taskflow` post-cutover | +2 days post-cutover |
| P3 | `kind` field for memory provenance | PARTIAL/post-cutover | memory skills | +½ day post-cutover |
| — | All other v2 channels/providers | SKIP | n/a | n/a |

## Net impact on our skills

**`add-taskflow` size after Track A:** SHRINKS substantially.
- v1: 23,204 LOC of fork divergence (per audit CSV)
- v2-aligned (post-cutover): roughly 12,000-14,000 LOC. The R1+R2+R4 replacements eliminate `task-scheduler.ts` (500 LOC), subtask_requests + approval text protocol (~300 LOC), cross-board JID-lookup (~200 LOC), and ~5,000 LOC of `taskflow-engine.ts` MCP-tool boilerplate (since v2's typed MCP-tool framework gives more for free).
- The remaining LOC is purely TaskFlow's domain logic: Kanban state machine, WIP enforcement, weekly review templates, cross-board provisioning, Kipp audit prompts.

**`whatsapp-fixes`:** stays ~300-400 LOC for the missing channel methods (per Phase A.2 spec). Post-cutover PR could shrink it toward zero.

**`add-taskflow-memory`, `add-long-term-context`, `add-embeddings`:** mostly unchanged at cutover. Post-cutover follow-up: P3 (`kind`-based provenance) for memory recall quality.

## Recommendation

Adopt all 5 REPLACE items during Phase A.3 (already in plan via TaskFlow extraction).

Adopt E1+E3+E4+E6 during Phase A.3 board-provisioning rewrite (~½ day total — small wins).

Defer E2+E5+E7+E8+P3 to post-cutover (they don't block migration; they're improvement opportunities once the v2 baseline is stable).

Document E8 (sender-approval flow) and P3 (`kind` for memory) as **scheduled post-cutover follow-ups**.
