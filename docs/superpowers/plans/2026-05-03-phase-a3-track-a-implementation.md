# Phase A.3 — Track A Implementation Plan

> **Goal:** migrate 5 fork-private skills (TaskFlow + 4 supporting) to NanoClaw v2 via **Path A** (git-branch model). Production v1.2.53 stays running until Track B cutover.
>
> **Estimated total:** 8-10 weeks (refined post Codex GAP validation; was 7-8). +2 weeks for 25 RUNTIME-BLOCKERs (5 new sub-tasks 2.3.o-s) + ~3-4 days for 101 PLAN-BLOCKER batch (2.3.5). Engineering scope was originally over-estimated by synthesis (claimed 9-10 weeks); reframe collapses most "BLOCKERs" to PLAN-BLOCKERs.
>
> **GAP validation source:** `docs/superpowers/audits/2026-05-03-feature-coverage/21-codex-validation.md` (178 GAPs validated: 25 RUNTIME / 101 PLAN / 15 HIGH / 9 MED / 14 LOW / 5 OVERCLAIM / 8 DEPRECATED-CORRECTLY).
>
> America/Fortaleza no DST since 2019; bi-weekly merge cadence; no upstream PR dependency.
>
> **Status (2026-05-03):** Phase A.3.0 done; A.3.0.5 paused mid-execution; v2 discovery (20 docs + synthesis) regenerated after data loss; ready for A.3.0.5 resumption.

**Anchored docs:**
- v2 discovery synthesis: `docs/superpowers/research/2026-05-03-v2-discovery/00-synthesis.md`
- 20 discovery docs in same directory (01-20)
- Strategic spec: `docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` (commit 561ad3cd)
- Production validation: `~/.claude/projects/-root-nanoclaw/memory/project_v2_migration_production_validation.md`
- Branch infrastructure record: `~/.claude/projects/-root-nanoclaw/memory/project_v2_track_a_phase_a30_done.md`

---

## Approach (TDD throughout)

Every code-bearing step: RED → GREEN → REFACTOR. Codex skeptical review (gpt-5.5/high) on every branch before merge to `release/taskflow-bundle-v2`.

Per-skill convention: skill branches use `-v2` suffix to avoid clobbering the existing 3-5-week-old `skill/*` branches (kept as reference for porting).

---

## Phase A.3.0 — Branch infrastructure ✅ DONE

| Step | State | Result |
|---|---|---|
| 0.1 git topology verified | ✅ | `origin = foxsky/nanoclaw`; `upstream = qwibitai`; `prod = .63`; existing `skill/*` branches stale (5w, 630 behind v2) |
| 0.2 base/v2-fork-anchor | ✅ | Pushed to origin @ `271a62c3` (`upstream/v2 5ae66624` + CI scaffold) |
| 0.3 skill-branch-ci.yml | ✅ | pnpm@10.33.0 + bun 1.3.12 + node 20; triggers on `skill/*-v2`, `release/taskflow-bundle-v2`, `base/v2-fork-anchor` |
| 0.4 release/taskflow-bundle-v2 | ✅ | Pushed to origin @ same SHA |
| 0.5 conflict-surface preflight | skipped | Old `skill/*` branches too stale to merge forward; not relevant for fresh `-v2` branches |
| 0.6 snapshot fixture | deferred | Encrypted-storage decision pending (S3 bucket + GPG, or CI secret store) |
| BONUS: origin/channels | ✅ | Pushed from upstream/channels (A.3.0.5 prerequisite) |

**Pin SHAs (Codex#10 IMPORTANT-5):**
- `upstream_v2_base_sha` = `5ae66624eb36c9fdb22539599261c0b3ca11ede5`
- `base_with_whatsapp_sha` = TBD post-A.3.0.5
- `base_with_ci_sha` = `271a62c3aa556d1cec8f8abcc963b96333eb4b9d`

---

## Phase A.3.0.5 — Apply upstream `add-whatsapp` (PAUSED mid-execution)

**Goal:** v2 trunk doesn't ship channels. Run `setup/add-whatsapp.sh` to install adapter from `origin/channels`.

**Current state:** script ran partially before user interrupt. Working state stashed at `stash@{0}` ("Phase A.3.0.5 add-whatsapp WIP + Batch 1 audit outputs").
- Modified (in stash): `package.json`, `pnpm-lock.yaml`, `src/channels/index.ts`
- Untracked (in stash): `setup/groups.ts`, `src/channels/whatsapp.ts`

**Resume procedure:**
```bash
git checkout base/v2-fork-anchor
git stash apply stash@{0}                    # restore add-whatsapp WIP
# Verify completeness:
diff <(git show origin/channels:src/channels/whatsapp.ts) src/channels/whatsapp.ts
diff <(git show origin/channels:setup/groups.ts) setup/groups.ts
grep "import './whatsapp.js';" src/channels/index.ts || echo "MISSING"
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test src/channels/
git add .
git commit -m "ci(skill): apply upstream add-whatsapp to base/v2-fork-anchor"
git push origin base/v2-fork-anchor
git checkout release/taskflow-bundle-v2
git merge base/v2-fork-anchor --ff-only
git push origin release/taskflow-bundle-v2
```

**Acceptance:** `src/channels/whatsapp.ts` exists, registers via side-effect import; pnpm install + tsc + vitest green; `base_with_whatsapp_sha` recorded.

---

## Phase A.3.1 — `skill/whatsapp-fixes-v2` (proves Path A end-to-end)

**Why first:** smallest skill (3 method ports); no upstream conflicts; `skill/taskflow-v2` depends on it.

**Branches off:** `base/v2-fork-anchor` (after A.3.0.5).

### Steps

| Step | Action | Verification |
|---|---|---|
| 1.1 | `git checkout -b skill/whatsapp-fixes-v2 base/v2-fork-anchor` | Branch created |
| 1.2 (RED) | Port v1 test → `src/channels/whatsapp-extensions.test.ts` (host-side, NOT container). **Imports:** side-effect import + `getChannelAdapter('whatsapp')` from `src/channels/channel-registry.ts`. NO `createWhatsAppAdapter()` factory (Discovery 07). Seed fake `store/auth/creds.json` for tests. | Tests fail because 3 methods missing on adapter |
| 1.3 (GREEN) | Extend `src/channels/adapter.ts` interface with 3 optional methods: `createGroup`, `lookupPhoneJid`, `resolvePhoneJid` | Typecheck passes |
| 1.4 (GREEN) | Implement methods in `src/channels/whatsapp.ts` (~115 LOC port from v1 fork's whatsapp.ts:705-820 — adapt `logger.*` → `log.*`) | Tests pass |
| 1.5 (REFACTOR) | `pnpm run typecheck && pnpm test` clean. Codex review on branch diff. Address findings. Push. | All green |
| 1.6 | Merge `skill/whatsapp-fixes-v2` → `release/taskflow-bundle-v2` (FF or 3-way) | Release branch CI green |

**Acceptance:** 9+ adapter-extension tests pass; merged into release branch.

---

## Phase A.3.2 — `skill/taskflow-v2` (master skill)

**Branches off:** `skill/whatsapp-fixes-v2`.

### Step 2.0 — MOVE TaskFlow source from trunk to skill branch (Discovery 20 finding)

**Critical scope finding:** 4 of 5 fork skills are intent-only stubs whose source still lives in v1 trunk. Before any new work, the source must be relocated:

| Source path (currently in v1 trunk) | LOC | Move to |
|---|---|---|
| `container/agent-runner/src/taskflow-engine.ts` | 9598 | `skill/taskflow-v2` branch (same path) |
| `container/agent-runner/src/taskflow-engine.test.ts` | 7218 | same |
| `.claude/skills/add-taskflow/tests/taskflow.test.ts` | 7572 | branch tests directory |
| TaskFlow MCP tool registrations | varies | `container/agent-runner/src/mcp-tools/taskflow.ts` (single file per Discovery 06) |
| TaskFlow engine internals | varies | `container/agent-runner/src/taskflow/{db,tasks,boards,projects}.ts` |
| `src/dm-routing.ts` (250 LOC) | 250 | branch |
| `src/ipc-plugins/*` (multiple) | varies | rewrite as MCP tools per 2.3.a |

**Acceptance for 2.0:** TaskFlow source files exist on `skill/taskflow-v2` branch; v1 trunk's copies stay intact (don't break v1 production).

### Step 2.1 — Create branch + scaffold (Pattern A, file-based prereq probes)

**Pattern DECIDED empirically:** v2 has 4 channel skills using Pattern B (`setup/add-X.sh`: whatsapp/discord/telegram/teams) and ~10 generic skills using Pattern A (true branch merge). TaskFlow is a feature skill, not a channel — Pattern A applies. Per audit 17: **branch from `base/v2-fork-anchor`, NOT from `skill/whatsapp-fixes-v2`**, and assert prereqs by file-based probes (not merge-base ancestry).

```bash
git checkout base/v2-fork-anchor
git checkout -b skill/taskflow-v2
```

**SKILL.md prereq check** (file-based, runtime — fail fast if `whatsapp-fixes` not applied):
```bash
test -f src/channels/whatsapp.ts || { echo "ERROR: skill/whatsapp-fixes-v2 must be applied first"; exit 1; }
grep -q "createGroup" src/channels/adapter.ts || { echo "ERROR: whatsapp-fixes ChannelAdapter extensions missing"; exit 1; }
```

This avoids merge-base ancestry brittleness (skill branches are independently maintained; ancestry is fragile across upstream merges).

### Step 2.2 — RED: port tests with v2 import shape

Adapt all test imports for v2 paths (`log.ts` not `logger.ts`; v2 module structure).

### Step 2.3 — GREEN: 12-14 sub-tasks (each its own RED-GREEN cycle)

| Sub-task | Touches | Verification |
|---|---|---|
| 2.3.a IPC plugins → MCP tools (single file `mcp-tools/taskflow.ts` per Discovery 06) | container/agent-runner/src/mcp-tools/taskflow.ts | engine tests for each domain action |
| 2.3.b `provision_taskflow_board` MCP (uses `whatsapp-fixes.createGroup` + v2's `create_agent`) | mcp-tools/taskflow.ts | integration test from A.3.1 patterns |
| 2.3.c `taskflow_send_message_with_audit` wrapper | mcp-tools/taskflow.ts | **Pre-queue insert (Discovery 08, 09):** wrapper writes log row immediately after `writeMessageOut` with `delivery_status='queued'`; reconciliation sweep updates from `delivered`. NOT `registerDeliveryAction` (kind='system' only). |
| 2.3.d Schema migrations | `src/db/migrations/module-taskflow-NNN-*.ts` (TS modules per Discovery 01) | **2 central** (`taskflow_group_settings`, optionally `send_message_log` — see 2.3.m); **1 fork-private DB initializer** in `src/modules/taskflow/init-db.ts` for `data/taskflow/taskflow.db` — **15 tables**: boards, board_runtime_config, taskflow_board_admin_meta, board_people, board_config, board_holidays, tasks, task_history, archive, child_board_registrations, subtask_requests, external_contacts, meeting_external_participants, attachment_audit_log, **board_id_counters** (per-board task-id sequence state, engine line 1203; per-board operational state per Discovery 04). Test: migration runner on fresh `data/v2.db`; init test on missing taskflow.db. |
| 2.3.e `seed-board-admins.ts` (Discovery 13) | scripts/ | 30 v1 board_admins → `user_roles(role='admin')` + `taskflow_board_admin_meta(is_primary_manager, is_delegate)` extension. Pre-create 3 `users` for legacy external_contacts. **Invariant:** `COUNT(*) FROM user_roles WHERE role='owner' AND agent_group_id IS NOT NULL` = 0. |
| 2.3.f `migrate-scheduled-tasks.ts` (Discovery 16) | scripts/ | Read v1 active cron rows from `store/messages.db`; map `chat_jid` → v2 `(agent_group_id, session_id)`; INSERT directly into per-session `data/v2-sessions/{ag}/{sid}/inbound.db` as `messages_in (kind='task', recurrence=<cron>, ...)`. **Per-session iteration** (no central scheduled_tasks). Skip 26 once-completed rows. |
| 2.3.g `dm-routing.ts` port + regression test | container/agent-runner/src/dm-routing.ts | Test: missing `external_contacts` table returns null without throwing (regression for prod dist drift bug per memory `project_dm_routing_silent_bug.md`). Per Discovery 12: TaskFlow's invitation-send flow calls `addMember()` to seed `agent_group_members` (so v2 first-contact gate doesn't fire for invited externals); `resolveExternalDm` survives as a context-tag layer. |
| 2.3.h Cross-board approval port-forward (dead code preserved) | engine | Test: `aprovar <id>` text protocol fires `handle_subtask_approval`; NO `ask_user_question` involvement. Per Discovery 10: `subtask_requests` + `/aprovar` text protocol kept (3 reasons reject `pending_approvals` refactor). |
| 2.3.i CLAUDE.md.template ports | templates/ | Manual review: per-board prompt renders correctly. Keep `/aprovar` `/rejeitar` text protocols. |
| 2.3.j Post-provisioning send + ACL refresh (Discovery 14) | engine integration | Per Discovery 14: skill calls `writeDestinations(parent_id, sess_id)` directly for affected agent_groups. `wakeContainer` on running container is no-op. **Sparse seed DECIDED empirically: 68 `agent_destinations` rows** (production has 68 distinct cross-board source→target pairs all-time per `send_message_log`; dense 756 would add 688 unused). Future pairs created via `add_destination` MCP if needed. Test: provision new board, immediately send from existing parent → assert delivered. |
| 2.3.k Engage config override (Discovery 11) | apply-engage-config.sql (target `data/v2.db`) | **Override** migrate-v2 driver default: set all 28 `messaging_group_agents` to `engage_mode='pattern' + engage_pattern='@Case\|^/' + sender_scope='known' + ignored_message_policy='accumulate' + unknown_sender_policy='request_approval'`. **Engage pattern DECIDED empirically:** all 28 prod boards already use `trigger_pattern='@Case'` per `registered_groups`; matching that preserves v1 behavior + adds slash-command capture. NOT `'.'` (which would silently change to always-engage). |
| 2.3.l Reconciliation sweep seeding | scripts/ | Seed recurring scheduled task to update `taskflow_send_message_log.status` from `inbound.db.delivered` joins. Per-session via v2's schedule_task. |
| **NEW 2.3.m** Drop `send_message_log` + auditor rewrite (Discovery 03, 04, 19) | container/agent-runner/src/auditor-script.sh + auditor-prompt.txt | **Per re-discovery:** drop `send_message_log` table entirely. Rewrite Kipp auditor to query v2 session DBs directly (`outbound.db.messages_out` ⨝ `inbound.db.delivered` ⨝ `inbound.db.messages_in`) for cross-board send detection. ~200 LOC auditor change. **User review needed before commit.** |
| **NEW 2.3.n** task_history action-name canonicalization (Discovery 19) | engine | 8 unfixed doublets identified (`create`/`created`, `update`/`updated`/`update_field`, `concluded`/`conclude`, etc.). Pick canonical names + UPDATE migration on cutover. |
| **NEW 2.3.o** Runtime permission gate (8 RUNTIME-BLOCKERs from Codex GAP validation) | `src/modules/taskflow/permissions.ts` (new module) | Per Codex 11.1, 11.3, 10.2, 10.3, P.7, P.8, 11.8: implement (a) **3-tier role-label runtime gate** reading `taskflow_board_admin_meta.role_label` ('manager'/'delegate'/'observer') beyond v2's binary `user_roles`; (b) **`sender_name → user_id` bridge** for caller identity in MCP wrappers; (c) **delegate carve-out** for `process_inbox`, `approve`, `reject` (manager-or-delegate); (d) **dual-write atomicity** between v2 `user_roles` INSERT and `taskflow_board_admin_meta` INSERT in same transaction; (e) **`auto_provision_request` wiring** as a v2 system-action that fires on `register_person` for unprovisioned hierarchy boards. Tests cover all 6 production permission denials + the 1 delegate (sanunciel). |
| **NEW 2.3.p** Auditor architecture rewrite (5 RUNTIME-BLOCKERs: R12, R15, AH.8, AH.11, AH.13, Y.8) | `container/agent-runner/src/auditor-script.sh` + `auditor-prompt.txt` (heredoc + DB row). **Owner: `skill/embeddings-v2`** — auditor uses semantic search for cross-message correlation; entire auditor stack (auditor-script.sh, semantic-audit\*.ts, auditor-{dm-detection,delivery-health}.test.ts, taskflow-embedding-sync.ts, digest-skip-script.sh) lives there per Discovery 20. **Step relocates from A.3.2 to A.3.5 (skill/embeddings-v2 phase).** | Replaces and absorbs 2.3.m. (a) **`auditTrailDivergence` detector**: drop OR redefine — bug class disappears under v2's single-store; explicit decision required. (b) **Kipp isolated session**: define v2 provisioning shape — currently `context_mode='isolated'` not in v2; must use dedicated agent_group + `schedule_task` with `pre_agent_script`. (c) **8 interaction-record signals** rebuilt: `crossGroupSendLogged` per-session DB walk; `isCrossBoardForward` from new `send_message_log` projection; `taskMutationFound` unchanged; `isDmSend` heuristic re-grounded; `auditTrailDivergence` decision baked in; `selfCorrections`/`noResponse`/`isIntent`/`isRead` ported. (d) **Coupling with 2.3.c + 2.3.r**: hook placement decision (pre-queue wrapper vs registerDeliveryAction) drives audit truth; lock together. ~250-350 LOC + 28 prompt UPDATEs (per audit 13). |
| **NEW 2.3.q** Cross-board send pipeline (3 RUNTIME-BLOCKERs: K.4, K.5, W.5) | `mcp-tools/taskflow.ts` send wrapper + `src/modules/taskflow/cross-board.ts` (new) | (a) **`trigger_message_id` propagation**: TaskFlow wrapper accepts `trigger_inbound_seq` param; resolves via `SELECT id FROM messages_in WHERE seq=?`; embeds in audit row. (b) **5-second notification consolidation**: in-process buffer per (source_board, target_chat_jid) within a single agent turn; flush at turn end via host-side coalesce. Critical for 28% cross-board outbound volume (~422 sends/60d) — without it, 2× notification spam day-1. (c) **Send audit hook placement decision (W.5)**: lock pre-queue insert pattern (Discovery 09) NOT post-delivery hook (Codex#10 B5: container can't write central; via host-side `kind='system'` action handler). |
| **NEW 2.3.r** Cross-DB write/identity boundary (4 RUNTIME-BLOCKERs: S5, S15, S20, V.13) | Multiple — `init-db.ts`, `cross-board.ts`, host migration scripts | (a) **`board_people` two-table write**: live `register_person` writes to fork-private `data/taskflow/taskflow.db.board_people` AND v2 central `data/v2.db.users` + `agent_group_members` atomically. Reconciliation script for backfill. (b) **`send_message_log` storage decision (lock with 2.3.p)**: drop v1 table OR new central audit table; affects auditor data path. (c) **Web-UI table collision (S20)**: prod `data/taskflow/taskflow.db` has `users` + `sessions` tables (web-UI `tf-mcontrol`) — naming collision with v2 central `users` + `sessions`. Decision: rename web tables (`taskflow_web_users`, `taskflow_web_sessions`) OR isolate behind FK. (d) **`find_person_in_organization` (V.13)**: cross-board org walk needs central DB read access; pattern: TaskFlow MCP queries via mounted central DB (read-only). |
| **NEW 2.3.s** IPC-replacement runtime patterns (4 RUNTIME-BLOCKERs: W.1, W.7, W.9, W.10) | Multiple | (a) **Raw sqlite MCP access (W.1)**: keep/drop/read-only decision for `mcp-server-sqlite-npx` (28 boards ship it as second MCP server with raw SQL write access). Recommend mount read-only. (b) **Auto-fire child provisioning (W.7)**: v2 replacement for `register_person` → `provision_child_board` IPC chain — emit system action from MCP result. (c) **`register_group` hierarchy metadata (W.9)**: v2's `create_agent` lacks `hierarchy_level`/`max_depth` fields — write to fork-private `taskflow_group_settings` sidecar in same transaction. (d) **`send_otp` IPC path (W.10)**: web-admin OTP path — design v2 input/delivery (engage_pattern doesn't apply; bot-initiated outbound only). |
| **NEW 2.3.t** Deprecated-feature dispositions (8 items per Codex) | spec + scripts/migration | Explicit per-item disposition for the 8 DEPRECATED-CORRECTLY features. **Three categories:** (1) PORT-FORWARD DEAD CODE (engine ports unchanged on `skill/taskflow-v2`; spec marks dormant): cross-board approval (`subtask_requests` + `mode='approval'`, 0 boards opt in); recurring bounds (`max_cycles`/`recurrence_end_date`, 0 prod usage); external meeting participants push-flow (3 ever, 0 accepted — keep engine, drop spec promotion). (2) FORMAL DEPRECATION (drop spec entries; replace with skill links): attachment intake `CONFIRM_IMPORT` protocol (vapor: no OCR, no `rejected_mutations` table) — replace with one-line ref to `add-image-vision` + `add-pdf-reader`. (3) DROP AT CUTOVER (migration script removes table or content; v2 has equivalent or none needed): `board_groups` (superseded by v2 `messaging_group_agents` — migration script INSERTs equivalents then DROP); `agent_heartbeats` (0 rows, web-UI artifact); `people` stub (0 rows, superseded by `board_people` + v2 `users`); `board_chat` (224-row burst then dead — decision: rename to `taskflow_web_chat` if web-UI preserved, else drop). **Acceptance:** spec has explicit "Dormant features (port-forward only)" section; migration script idempotently DROPs the 3 unused tables; 1 CHANGELOG entry per deprecation. **Coupled with 2.3.r** (web-UI table collision) for `board_chat` decision. |

### Step 2.3.5 — Spec/Plan enumeration batch (101 PLAN-BLOCKERs)

**Goal:** absorb 101 PLAN-BLOCKER GAPs from Codex validation in a single batch update — they're all "engine port-forward already covers behavior; just need spec/plan/test enumeration." NOT new code.

**Source:** `docs/superpowers/audits/2026-05-03-feature-coverage/21-codex-validation.md` per-audit GAP tables.

**Approach:** single doc-PR sweep across spec + plan + tests covering:
- 8+ MCP tools missing from spec inventory (`process_inbox`, `register_person`, `restore_task`, `manage_holidays` 4 ops, `reparent_task`, `detach_task`, `merge_project`, `reinvite_meeting_participant_external`)
- Missing acceptance tests for engine behaviors (J.* rollup, K.x meeting, weekday/DST, default-assignee, dotted subtask IDs, etc.)
- Spec/plan internal contradictions resolved (B9: `/aprovar`; B6: `register_person`)
- Template port (1316 LOC, 11 v2-breaking sites — per 2.3.i, expanded with Codex G-15.1 through G-15.9)
- Test count corrections (audit 18: 234+/901+/126 actual = 330/374/134)
- Phone canonicalization parity tests
- 5 OVERCLAIMs explicitly dropped (K.17.phone-mask, S13, X.10, Y.6, Z.2)
- 8 DEPRECATED-CORRECTLY confirmations (attachment intake, etc.)

Estimated: ~3-4 days of doc + test author work; NO engine changes.

**Acceptance:** every PLAN-BLOCKER from Codex validation has a corresponding spec entry + acceptance test stub.

### Step 2.4 — Engine-canonical regression suite (Discovery 06)

Per Discovery 06: v2's MCP registration uses side-effect-import barrel; private `allTools[]` at `mcp-tools/server.ts:21-22`. **Approach:** export per-module `ALL_TASKFLOW_TOOLS` array from `mcp-tools/taskflow.ts` (skill-private; do NOT modify `server.ts` to add introspection accessor — that violates skill-only).

Regression suite imports `ALL_TASKFLOW_TOOLS` → iterates → asserts each tool's handler is invocable directly (handler-direct unit tests, bypassing MCP server).

### Step 2.5 — REFACTOR + Codex review

`pnpm run typecheck && pnpm test` clean. Codex review on diff. Address findings.

### Step 2.6 — Merge to `release/taskflow-bundle-v2`

CI on merged tree.

**A.3.2 acceptance:** all engine tests pass; production-validation invariants hold; Codex clean.

---

## Phase A.3.3 — `skill/taskflow-memory-v2` (manifest→branch)

**Branches off:** `release/taskflow-bundle-v2`.

This skill **already ships meaningful source today** (only one of the 5 that does — Discovery 20 finding). Convert manifest+modify shape to direct branch edits.

| Step | Action |
|---|---|
| 3.1 Create branch + drop manifest | `git rm` manifest.yaml + `add/`+`modify/` directories |
| 3.2 RED: port tests | Move test files to direct paths on branch |
| 3.3 GREEN: 4 wiring re-targets | (a) `src/types.ts` extensions; (b) `src/index.ts` startup; (c) `container/agent-runner/src/runtime-config.ts` env-var exposure; (d) **NEW for v2:** `container/agent-runner/src/mcp-tools/memory.ts` — register 4 memory tools via v2's MCP module directly (no IPC; Discovery 06 pattern); (e) `container/agent-runner/src/index.ts` auto-recall preamble injection |
| 3.4 GREEN: copy add/ files | 3 files port directly: `memory-client.ts`, `memory-client.test.ts`, `index-preambles.test.ts` |
| 3.5 Production deployment validation | Per memory `project_memory_layer_phase1.md`: Phase 1 SHIPPED LOCALLY only. Verify `192.168.2.65:8000/v1/health`. Smoke test on v2 worktree: store/recall/list/forget. Verify auto-recall preamble injection in container logs. |
| 3.6 Codex review + merge | Standard |

**Acceptance:** smoke test green; Codex clean; merged.

---

## Phase A.3.4 — `skill/long-term-context-v2` (revalidation)

Already uses git-branch model in v1 fork. Verify it merges cleanly with v2 baseline.

| Step | Action |
|---|---|
| 4.1 | `git checkout -b skill/long-term-context-v2 release/taskflow-bundle-v2` (or branch from upstream/v2 directly) |
| 4.2 | Cherry-pick or merge v1's `skill/long-term-context` content; resolve conflicts (likely on `src/index.ts`, `container/agent-runner/src/index.ts`, `runtime-config.ts`) |
| 4.3 | Tests pass: `src/context-service.test.ts`, `src/context-sync.test.ts`, `container/agent-runner/src/context-reader.test.ts` |
| 4.4 | Per Discovery (re-run): `captureAgentTurn` host-side hook is FORK-KEEP (v2 has no general-purpose session-end hook). Patch v2's container-runner to fire the hook from skill |
| 4.5 | Codex review + merge |

---

## Phase A.3.5 — `skill/embeddings-v2` (revalidation)

Same shape as A.3.4. Q-CAP confirmed v2 has no vector primitive — fork-keep all features.

`queryVector` hook on host stays as fork-private patch (Discovery: no v2 equivalent).

---

## Phase A.3.6 — Migration dry-run + invariant verification

**Goal:** verify cutover migration scripts produce valid v2 state from v1 production snapshot.

### Steps
- 6.1 Fresh v2 worktree from `release/taskflow-bundle-v2`. `pnpm install`. `./container/build.sh`.
- 6.2 Restore encrypted v1-prod snapshot via `scripts/restore-fixture.sh` (extracts to `/tmp/fixture/store/messages.db`, `data/taskflow/taskflow.db`, `groups/<board>/taskflow.db`).
- 6.3 Apply migration scripts:
  ```bash
  pnpm tsx scripts/seed-board-admins.ts
  pnpm tsx scripts/migrate-scheduled-tasks.ts        # per-session iteration
  sqlite3 data/v2.db < scripts/apply-engage-config.sql   # central, NOT store/messages.db
  pnpm tsx scripts/seed-agent-destinations.ts            # ~784 ACL rows
  ```
- 6.4 Verify post-migration invariants (source-driven counts):
  - `SELECT COUNT(*) FROM user_roles WHERE role='owner' AND agent_group_id IS NOT NULL` = **0** (memory invariant)
  - `SELECT COUNT(*) FROM user_roles WHERE role='admin' AND agent_group_id IS NOT NULL` = `(SELECT COUNT(*) FROM v1_snapshot.board_admins)`
  - `SELECT role, is_primary_manager, is_delegate, COUNT(*) FROM user_roles ur JOIN taskflow_board_admin_meta m ON (ur.user_id, ur.agent_group_id) = (m.user_id, m.agent_group_id) GROUP BY 1,2,3` matches v1 distribution
  - `SELECT COUNT(*) FROM messaging_group_agents WHERE engage_pattern=<chosen pattern> AND sender_scope='known' AND ignored_message_policy='accumulate'` matches taskflow-managed count
  - `SELECT COUNT(*) FROM agent_destinations` = 784 (28 × 27)
  - **Per-session schedule verification:** for each agent_group's session, `SELECT COUNT(*) FROM messages_in WHERE kind='task'` matches v1 cron row count for that board
  - `SELECT COUNT(*) FROM board_holidays` (in `data/taskflow/taskflow.db`) matches v1
  - `SELECT COUNT(*) FROM external_contacts` = 3 (matches prod validation)

**Acceptance:** all invariants match expected counts.

---

## Phase A.3.7 — Bundle integration tests

**Goal:** smoke test 25-30 TaskFlow MCP tools + cross-cutting flows on the migrated v2 state.

### Step 7.1 — Per-tool coverage

For each MCP tool category, author at least one happy-path + one error-path test:
- Board management (4 tools)
- Kanban (10 tools)
- Cross-board (2 tools — including approval port-forward)
- Meetings (5 tools)
- Query (3+ tools)
- Audit (1 tool: `taskflow_send_message_with_audit`)

**Coverage gate:** every tool has at least 2 tests; CI reports tool-by-tool.

### Step 7.2 — Cross-cutting flows

- Provisioning (via `whatsapp-fixes.createGroup` + `create_agent` + ACL refresh)
- **Cross-board send + audit (28% of outbound — load-bearing per Discovery 19):** agent A → group B; assert `taskflow_send_message_log` row written; assert `messages_out` queued; assert delivery confirmed via reconciliation sweep
- DM routing + meeting auto-correlation (regression for empty-table guard)
- Memory layer: store/recall/list/forget per board
- Long-term context: capture turn → summarize → preamble injection
- Embeddings: index task → similarity search

### Step 7.3 — Test scope by board activity (Discovery 19 refinement)

Production: 10 active boards / 27 dead. Test scope:
- **All-tool smoke:** runs once on fresh state (board-agnostic)
- **Production-flow smoke:** focused on the 10 active boards (seci, sec, laizys, asse-seci, thiago + others)
- **Fan-out send paths:** verify cross-board send to all 27 dead boards still routable (they receive crons even if they don't author)

### Step 7.4 — Final Codex skeptical review

Run on merged `release/taskflow-bundle-v2` diff vs `upstream/v2`.

**Acceptance:** all tests green; Codex clean.

---

## Phase A.3.8 — Cutover gate (Track B handoff)

Track A done when: `release/taskflow-bundle-v2` is green on CI + Codex skeptical review + dry-run migration (A.3.6) + bundle integration tests (A.3.7).

Track B (cutover) is a separate plan.

---

## Open questions (need user call before A.3.2 step 2.3.k commits)

1. **engage_pattern**: `'.'` (~10k wakes/day; prior session said fine) vs `'(@Case|@Tars|^/[a-z])'` (~2-3k wakes/day; re-discovery recommends).
2. **`send_message_log` drop** (Discovery 03/04/19 recommend): auditor rewrite (~200 LOC) — confirm acceptable.
3. **`agent_destinations` seed strategy**: dense ~784 rows (recommended for safety) vs sparse audit-driven (~30 rows from actual cross-board pairs in last 60d).
4. **`board_id_counters` table** (newly surfaced in Discovery 04): place in fork-private taskflow.db.
5. **Pattern A vs B for `skill/taskflow-v2`**: branch from skill/whatsapp-fixes-v2 with file-based prereq probes (Discovery 17 recommendation; Pattern B-style probe rather than merge-base).

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Upstream releases new v2 mid-Track-A → 5 branches need merge-forward | **Bi-weekly merge-forward** (Discovery 18: v2's auto-bot was DELETED at commit d4073a01 because auto-`--theirs` stripped fork deps; manual is canonical). 12-18h over 6 weeks expected; 36h worst case. CI scaffolding ~1 day. Security exception: same-day merge on CVE advisories. |
| Branch dependencies (skill/taskflow-v2 needs skill/whatsapp-fixes-v2; whatsapp-fixes-v2 needs add-whatsapp; add-whatsapp needs origin/channels) | Strict ancestor order: A.3.0 → A.3.0.5 → A.3.1 → A.3.2 → A.3.3-5 → A.3.6-7 |
| dm-routing.ts prod dist drift reproduces on v2 build | A.3.2 step 2.3.g adds explicit table-existence regression test |
| Cross-board approval feature gets enabled mid-Track-A | Port-forward preserves capability; engine tests verify; no UI scope creep |
| Memory layer prod deployment incomplete | A.3.3 step 3.5 explicitly verifies before merge |
| 4 of 5 skills are intent stubs | A.3.2 step 2.0 explicitly handles source relocation |
| Cross-board volume (28% of outbound) | A.3.2 step 2.3.j ACL seeding ~784 rows critical; integration test in A.3.7 |
| Active prod incident (Kipp credential-proxy) | Separate v1 hotfix scope; not Track A |
| Track A drags past 8 weeks | Codex review at each branch + per-phase acceptance criteria are objective |

---

## What this plan does NOT cover

- **Track B (cutover):** separate plan; happens after Track A green
- **Active prod incident** Kipp daily audit broken since 2026-05-03 (credential-proxy fault) — separate v1 hotfix
- **Review-column approval dashboard panel** — real user need but separate scope (`tf-mcontrol`)
- **dm-routing prod hotfix (dist drift)** — separate hotfix
- **Counter-proposal feature** — scope-creep deferred indefinitely
- **Pattern C marketplace plugin** — DELETED in v2 (commit d4073a01); defer
- **`add-travel-assistant`** — explicitly excluded per user
- **Memory layer Phase 1 prod deployment** — prerequisite for A.3.3 but operational, not code

---

**Document generated:** 2026-05-03 (after re-discovery + Codex#10 corrections + Discovery 16-20 production-reality refinement)
