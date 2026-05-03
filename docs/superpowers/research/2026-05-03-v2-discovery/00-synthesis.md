# v2 Migration — Architecture Synthesis (re-discovery 2026-05-03)

**Source:** 20 discovery docs in this directory (regenerated after data-loss earlier today). All grounded in v2 source + production DB queries.

---

## Executive headline

Migration of 5 fork-private skills to NanoClaw v2 is **viable**. ~85% of fork additions move into 5 `skill/*-v2` git branches. ~9k LOC drops at cutover (replaced by v2 native primitives). v2 absorbs ~19.5k LOC of upstream improvements for free.

**Five architectural realities** (some refined from prior session):

1. **Production is 5 active boards + 23 fan-out** (latest re-validation: actually 10 active + 27 of 37 dead in 60d). Many features I scoped (cross-board approval, recurring tasks, external participants) are dead-or-near-dead. **28% of outbound is cross-board** (bigger than digest+notification fans).
2. **v2's documented merge-forward CI was deleted** (commit d4073a01, 2026-03-25). Auto-`--theirs` silently stripped fork-private deps. **Manual weekly forward-merge** is the canonical pattern — 12-18h over 6 weeks.
3. **Two skill-apply patterns coexist**: channel scripts (`setup/add-X.sh`) for chat adapters; generic `git fetch + git merge skill/X` for everything else. **Pattern C marketplace doesn't exist in v2**.
4. **All channel sends route through `agent_destinations` ACL with no wildcards.** TaskFlow needs ~784 rows seeded.
5. **DST is a non-issue.** America/Fortaleza dropped DST in 2019.

**One big new finding from re-run:** Per Agent 20, **4 of 5 fork skills are intent stubs whose source still lives in trunk** — must MOVE into the skill branch's source tree before cutover. Only `add-taskflow-memory` ships meaningful source today.

---

## Decision matrix — final ground-truth verdicts

### Path A architectural confirmations

| Item | Verdict | Source |
|---|---|---|
| Skill structure | Path A (git branches) for `skill/taskflow-v2`. Pattern A (true merge) for engine-side skills; Pattern B (`setup/add-X.sh` script) for channel-class. `skill/whatsapp-fixes-v2` matches Pattern B (channel adapter overlay). | 17 |
| Branch dependencies | `skill/whatsapp-fixes-v2` ⊂ `base/v2-fork-anchor` (after add-whatsapp installed via setup script). `skill/taskflow-v2` is Pattern A and SKILL.md probes for whatsapp-fixes presence (file-based, not merge-base). | 07, 17 |
| Migration system | TS modules under `src/db/migrations/`, **`module-taskflow-NNN-<purpose>.ts`** naming. Append to barrel. No down() rollback. Idempotency on `name`. | 01 |
| TaskFlow tables | **14 fork-private** in new `data/taskflow/taskflow.db` (init via skill startup, NOT migration runner). **1 sidecar** in central `data/v2.db` (`taskflow_group_settings`). **3 dropped** (`board_groups` → `messaging_group_agents`; `board_admins` → `user_roles`+extension; `send_message_log` → query v2 session DBs). | 04 |
| Permissions | `board_admins` → `user_roles(role='admin', agent_group_id=X)` (30 grants). Add fork-private extension `taskflow_board_admin_meta` for `is_primary_manager`/`is_delegate`. Owner global only. | 13 |

### MCP / Engine layer

| Item | Verdict | Source |
|---|---|---|
| MCP tool registration | Side-effect-import barrel `mcp-tools/index.ts`. **Single file `mcp-tools/taskflow.ts`** (mirrors `scheduling.ts`); engine logic in `mcp-tools/taskflow/{db,tasks,boards,projects}.ts`. | 06 |
| Test enumeration | v2 has zero MCP tests today. Recommend handler-direct unit tests + per-module `ALL_TASKFLOW_TOOLS` array (skill-private; do NOT modify `server.ts`). | 06 |
| Tool schema | Raw JSON Schema, NOT Zod. | 06 |
| Container DB writes | Container can't write `inbound.db`. Mutations route via `writeMessageOut({kind:'system'})` with host dispatcher. | 06 |
| `kind` taxonomy | 5 values: `chat`, `chat-sdk`, `system`, `task` + adapter inbound. `kind='system'` short-circuits at `delivery.ts:254` (never wires). `registerDeliveryAction` is for `kind='system'` only. | 08 |
| `taskflow_send_message_with_audit` | **Pre-queue insert in container wrapper MCP**: capture `seq` from `writeMessageOut`, write log row immediately with `status='queued'`. Reconcile via periodic sweep that JOINs against `inbound.db.delivered`. NOT post-delivery hook (would require core edit; rejected). | 08, 09 |

### Channel adapter (`whatsapp-fixes-v2`)

| Item | Verdict | Source |
|---|---|---|
| Apply procedure | `setup/add-whatsapp.sh` (8 steps, scripted). Skill probes prereqs by file-existence checks. | 07 |
| Test approach | Side-effect import + `getChannelAdapter('whatsapp')` from registry. Seed fake `store/auth/creds.json` for tests. NOT factory export. | 07 |
| Branching | `skill/whatsapp-fixes-v2` direct from `base/v2-fork-anchor`. Adds 3 optional methods to `src/channels/adapter.ts` interface + implementations in `src/channels/whatsapp.ts`. | 07 |
| Echo detection | Global via ASSISTANT_NAME + ASSISTANT_HAS_OWN_NUMBER flag in `src/config.ts`. Per-board identity is router-layer, not channel-layer. | 07 |

### Routing / Permissions

| Item | Verdict | Source |
|---|---|---|
| Engage logic | 3 gates: `evaluateEngage` → `accessGate` → `senderScopeGate`. Closed enums: `engage_mode ∈ {pattern,mention,mention-sticky}`, `engage_pattern` is regex source (`'.'` is sentinel for always-engage), `sender_scope ∈ {all,known}`, `ignored_message_policy ∈ {drop,accumulate}`, `unknown_sender_policy ∈ {strict,request_approval,public}`. | 11 |
| **TaskFlow defaults — REVISED** | Re-run agent recommends **`pattern + '(@Case|@Tars|^/[a-z])' + known + accumulate`** (NOT `'.'`). With `'.'` + 28 boards × 10 members × 45 msg/day = ~10k wakes/day. With proposed defaults: ~2-3k wakes/day. **Worth user review** — earlier session said `'.'` was fine. | 11 |
| Migrate-v2 driver override | Driver defaults `sender_scope='all' + ignored=drop`. Our migration must override. | 11 |
| Sender approval | Fire-and-forget on first contact; admin from `user_roles`; on Allow → `agent_group_members` + `routeInbound` replay. Cutover for 3 prod external_contacts: do nothing (all stale). | 12 |
| Destinations ACL | All channel sends route through; **no wildcards**. TaskFlow needs **~784 rows seeded** (28 × 27 peer pairs). Post-provisioning: explicit `writeDestinations(parent, sess)` on running parents. | 14 |
| Inbound lifecycle | 7-step trace. Trigger context: `messages_in.id = '<wa-id>:<agent_group_id>'`. Cross-board sends generate fresh `a2a-*` id (original platform id NOT propagated). MCP tools have no first-class trigger accessor — TaskFlow must read its own session's inbound.db. | 15 |

### Cross-board approval (port-forward of dead code)

| Item | Verdict | Source |
|---|---|---|
| Production usage | Zero. 0/28 boards approval mode. `subtask_requests` empty. `/aprovar` never invoked. | 19 |
| Port-forward decision | Preserve engine code on `skill/taskflow-v2`. No dashboard panel. Keep `/aprovar` text protocol unchanged. | 19, 10 |
| pending_approvals refactor | Rejected for 3 reasons: parent-group visibility vs admin DM; hardcoded approve/reject options; TaskFlow's reject-with-reason free-text. | 10 |

### Operational / Scheduling

| Item | Verdict | Source |
|---|---|---|
| Cron eval | cron-parser 5.x, eval next-from-now. Identical to v1. | 16 |
| DST | Non-issue (Fortaleza no DST since 2019). | 16 |
| Catch-up | None. Most-recently-missed slot fires once on first wake. | 16 |
| **NEW finding:** v2 has NO central `scheduled_tasks` table | Tasks live per-session at `data/v2-sessions/{ag}/{sid}/inbound.db` as `messages_in WHERE kind='task'`. Migration must iterate per-session. | 16 |
| Skill apply | Two patterns coexist; Pattern C marketplace deleted (commit d4073a01). | 17 |
| CI/maintenance | Manual weekly forward-merge canonical. 6-week total: 12-18h expected, 36h worst case. Don't depend on upstream's promise — they removed the bot. | 18 |

### Production reality (refined)

| Item | Verdict | Source |
|---|---|---|
| Active boards | **27/37 boards have zero task creation in 60d** (73% dead). Core 10 actively used. | 19 |
| **Cross-board sends** | **422 sends in 60d (28% of outbound) — used for child→parent rollups + parent→child broadcasts.** Earlier "100% group / 0 DM" was true on `target_kind` but masked this. **If v2 ships without `send_message` to arbitrary group JIDs, the SECTI fleet's roll-up/roll-down communication breaks immediately.** | 19 |
| Top features | Task CRUD via WhatsApp, cross-board send_message, reassignment with auto-relink, daily routines (87 active crons, 98.1% success), subtasks (depth ≤2). | 19 |
| Dead features | `subtask_requests` (0 rows), external participants (0 acceptances), DM as user channel (4 real-user DMs), recurring tasks (3 across 2 boards). | 19 |
| Active prod incident | Kipp daily audit broken since 2026-05-03 — credential-proxy "no access to Claude" fault. Separate scope. | 19 |
| `task_history` action canonicalization | 8 unfixed action-name doublets (`create`/`created`, `update`/`updated`/`update_field`, etc.) — debt for v2. | 19 |

### Fork divergence summary

| Item | Verdict | Source |
|---|---|---|
| Top divergence files | (1) `taskflow-engine.ts` 9598 LOC (add-taskflow), (2) `taskflow.test.ts` 7572 (add-taskflow), (3) `taskflow-engine.test.ts` 7218 (add-taskflow), (4) `src/index.ts` 1555 (DEBT, multi-skill), (5) `src/container-runner.ts` 1349 (DEBT, multi-skill). | 20 |
| Migration completeness | **4 of 5 skills are intent stubs** — source still in trunk. Must MOVE before cutover. Only `add-taskflow-memory` ships source today. | 20 |
| Multi-skill debt | ~15% of divergence is genuine multi-skill DEBT (`src/{index,container-runner,router,types,ipc}.ts`) needing modify-with-intent or upstream PRs. | 20 |
| Upstream PR opportunity | Optional post-cutover: 4 ChannelAdapter extension methods (`createGroup`, `lookupPhoneJid`, `resolvePhoneJid`, `syncGroups`) — would shrink whatsapp-fixes but not block migration. | 20 |

---

## What changed vs the lost prior synthesis (notable refinements)

1. **Engage pattern recommendation** flipped from `'.'` to `'(@Case|@Tars|^/[a-z])'` — re-run agent surfaced 10k wakes/day with `'.'`. **Needs user review** (earlier said `'.'` was fine).
2. **`send_message_log` placement** flipped from "fork-private central via TS migration" to "DROPPED + auditor reads v2 session DBs directly" (Agent 04, 19's joint recommendation). Saves ~200 LOC auditor + a migration.
3. **No central `scheduled_tasks` table** — v2 stores per-session. Migration shape changes (per-session iteration).
4. **Cross-board volume** — 28% of outbound (not the lower digest-only assumption).
5. **Active boards: 10, not 5.** 27 of 37 dead — even more aggressive deletion candidates than prior estimate.
6. **4 of 5 skills are intent stubs** — major scope finding for actual migration code-move.

---

## Open questions (from Discovery 04 + 17)

1. **`send_message_log` drop verdict** — auditor rewrite (~200 LOC) needed; user review before commit.
2. **`taskflow_group_settings` central vs ALTER `agent_groups`** — sidecar table picked; alternative not foreclosed.
3. **`is_primary_manager` drop vs extension** — extension picked.
4. **`boards.id` ↔ `agent_groups.id` namespace** — keep separate (one-way door deferred).
5. **Engage pattern: `'.'` vs `'(@Case|@Tars|^/[a-z])'`** — needs user call.
6. **External_contacts cutover** — do nothing for the 3 stale rows.
7. **`board_id_counters` table** — surfaced in Discovery 04, not in original list; place in fork-private taskflow.db.

---

**Document tree (all committed to main):**
- `00-synthesis.md` (this file)
- `01-migrations.md` through `20-fork-divergence.md` — 20 deep-research docs
- Per-doc range: 215-471 lines, all v2-source-cited.
