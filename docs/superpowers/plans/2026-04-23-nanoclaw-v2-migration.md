# NanoClaw v2 Migration Plan (v3.0 — skills-only constraint)

> **For agentic workers:** the BLOCKING rule for this plan is `feedback_no_nanoclaw_codebase_changes.md`. Every change ships through `.claude/skills/<skill>/`. Never edit `src/`, `container/agent-runner/src/`, `setup/`, `scripts/`, or `package.json` directly. Carve-outs: `docs/` and `/root/.claude/projects/-root-nanoclaw/memory/`. If a step seems to require a codebase edit, the step is wrong-shaped — STOP and route through a skill.

**Revision history:**
- v1 → v2.7 — superseded. All earlier revisions premised the migration on editing `src/` directly to align toward upstream (Strategy A bottom-up port, the v1-types quarantine, the Phase 2.3 surgical adapter additions, etc.). The user reaffirmed three times on 2026-05-01 that fork-private code must live in skills only. Earlier plan content is preserved in git history (`git log docs/superpowers/plans/2026-04-23-nanoclaw-v2-migration.md`); see commit `98209b39` for the last v2.7 state.
- v3.0 (2026-05-01 EOD) — full rewrite under skills-only. Migration becomes a two-track project: (Track A) move every byte of fork-private code from `src/`/`container/`/`setup/` into the owning skill's `add/`/`modify/` trees, annotated with `.intent.md`; (Track B) at cutover, wipe the codebase tree, pull `upstream/main`, replay all skills. Skills are durable source of truth; codebase tree is downstream destination.

---

**Goal:** Migrate our fork from `nanoclaw@1.2.53` to upstream `v2.x` (currently `2.0.21`+) with:
- **Zero TaskFlow data loss** (`data/taskflow/taskflow.db` preserved).
- **Zero new fork divergence in the codebase tree** — every fork-private behavior lives in `.claude/skills/`.
- **Tested rollback recipe** validated before production cutover.
- **15-minute rollback SLA** + minimal disruption to 31 live government IT TaskFlow groups.

**Architecture:** Skill-managed migration. Track A clears codebase debt by extracting fork-private behavior into well-formed skills (`manifest.yaml` + `add/` + `modify/<path>` + `modify/<path>.intent.md` + `tests/`). When Track A completes, the codebase tree is upstream-shape modulo skill applications. Track B is then a near-mechanical cutover: nuke codebase, pull `upstream/main`, replay skills.

**Tech Stack (unchanged):** Bun 1.3.x (container), Node + pnpm@10.33.0 (host), SQLite (`bun:sqlite` container / `better-sqlite3` host), Anthropic Agent SDK 0.2.116, Docker + Proxmox VM orchestration, self-hosted OneCLI (path A2a) for v2 credential vault.

**Source-grounded facts:** `/root/.claude/projects/-root-nanoclaw/memory/project_v2_migration_assessment.md`. If facts conflict with upstream code at execution time, STOP and reconcile.

---

## Strategic decisions (v3.0)

1. **Skills-only rule (BLOCKING).** Every fork-private feature lives in `.claude/skills/<skill>/`. The codebase tree is downstream destination managed BY skill installation. Carve-outs: `docs/`, memory. Reaffirmed three times on 2026-05-01; reverting 12 commits + branch state followed each reaffirmation. See `feedback_no_nanoclaw_codebase_changes.md`.

2. **Cutover model: fleet-level, not per-group.** Baileys' `useMultiFileAuthState` uses a single shared auth directory; two processes racing on it corrupt Signal keys. Per-group 24h shadow is physically impossible with a single WhatsApp identity. Decision: Phase 4 dedicated test-board shadow (separate auth) is the sole pre-cutover validation; cut all 28 prod groups in a scheduled window with tested 15-minute rollback SLA. Adding a second WhatsApp number for prod-shadow is a follow-up project.

3. **IPC stays file-based.** v2 still supports `.heartbeat` + `outbox/` file channels (`src/session-manager.ts:59-62`; `host-sweep.ts:5-8`). The 9 `src/ipc-plugins/*.ts` get extracted into a fork-private skill's `modify/` tree. Rewriting them as MCP tools is deferred to post-cutover.

4. **Self-hosted OneCLI ADOPTED for v2.** `use-native-credential-proxy` skill conflicts in 5 files vs v2.0.22. Self-hosted OneCLI is free, aligned with v2's hard-throw at `container-runner.ts:459`, and unblocks Calendar/Gmail. **1.x install retains native credential proxy through cutover**; only v2 adopts OneCLI. See `project_onecli_decision.md`.

5. **TaskFlow DB preserved.** `data/taskflow/taskflow.db` is fully orthogonal to v2 platform schema. The 4 TaskFlow-custom columns on `registered_groups` (`taskflow_managed`, `taskflow_hierarchy_level`, `taskflow_max_depth`, `is_main`) move to a `taskflow_groups` sidecar table — but the schema migration is owned by the `add-taskflow` skill's `modify/` tree, not by direct codebase edits.

6. **`outbound_messages` durable queue preserved as fork-private** — the schema additions and runtime use go in the owning skill (`add-outbound-resilience`, NEW — see Phase A inventory).

7. **Personal WhatsApp (Baileys), not Cloud API.** Confirmed for both v1 fork and `upstream/channels`. `add-whatsapp` skill is upstream-tracked; verify v2 alignment in Track A audit.

8. **Timeline: 8-12 weeks full-time** (revised from 11-15 weeks under the old plan). The skills-only rule front-loads work into Track A skill extraction (~5-8 weeks) but compresses Track B to ~1 week (since cutover is mostly a `git reset && replay-skills`). Net is shorter because the painful "edit src/ to align with upstream" weeks disappear.

---

## What changed from v2.7 → v3.0

| Area | v2.7 framing | v3.0 framing |
|---|---|---|
| Migration unit | "Edit `src/types.ts`, `src/db.ts`, `src/channels/whatsapp.ts`, etc." | "Edit `.claude/skills/<skill>/modify/<path>` and `.intent.md`." |
| Phase 1 (Bun container port) | "Mechanically port 17 container files in `container/agent-runner/src/`." | "Author `bun-container-runtime` skill (modify/container/agent-runner/{package.json,Dockerfile,src/*.ts})." |
| Phase 2 (WhatsApp re-port) | "Surgical addition of `ask_question`/`onAction` to our v1 `src/channels/whatsapp.ts`." | "v2 upstream already has these in core. After cutover, `add-whatsapp` skill consumes them. NO surgical fork additions — period." |
| Phase 2.5 (TaskFlow permissions) | "Pull `src/modules/permissions/` into our fork; seed v2 tables; touch `src/db.ts`." | "v2 upstream provides permissions natively. `add-taskflow` skill handles seed scripts (`add/scripts/seed-taskflow-permissions.ts`) and consumes upstream permissions API." |
| Phase 3 (isMain rewrite) | "Rewrite ~169 isMain hits across 20+ files in `src/`." | "v2 upstream has already migrated isMain → `hasAdminRole()`. After cutover, NO isMain hits exist in core. Skill-private isMain checks (if any) live in skill `modify/` trees." |
| v1-types quarantine | "Rescue v1 names into `src/v1-types.ts` so v1 modules keep compiling." | "Wrong shape. v1 types disappear at cutover when src/ is replaced. Skills that depended on them either consume v2 equivalents or carry their own types in `add/`." |
| Approval-card primitives (ask_question / onAction) | "Add to `src/channels/whatsapp.ts` for early adoption." | "Wait for cutover. Upstream provides them natively." |
| Cutover mechanism | "Replace files one-by-one through Phase 5 days." | "`git reset --hard upstream/main && apply-all-skills.sh` in the cutover window." |

---

## The two tracks

### Track A: Skill Extraction (~5-8 weeks)

**Premise:** every fork-private behavior currently lives in `src/` or `container/agent-runner/src/` without being captured by a skill's `add/`/`modify/` tree. Track A inventories these and extracts them into well-formed skills.

A "well-formed skill" follows the `add-image-vision` template:

```
.claude/skills/<skill>/
├── manifest.yaml          # declares core_version, adds[], modifies[], structured deps
├── SKILL.md               # orchestration logic for installation + rationale
├── add/<path>             # NEW files at install time
├── modify/<path>          # MODIFIED versions of existing core files
├── modify/<path>.intent.md  # natural-language description of WHAT was modified
└── tests/<...>.test.ts    # tests for the skill itself
```

The `.intent.md` files are the durable contract: they describe WHAT change was made and WHY, so when upstream evolves and the file structure changes, an agentic worker can re-apply the modification on the new shape rather than blindly copying outdated bytes.

**Track A delivers:** the codebase tree contains zero fork-private divergence — every byte that's not from upstream is either captured in a skill's `add/` or wholesale-replaced via `modify/`.

### Track B: Cutover (~1 week + 2h cutover window + 72h soak)

**Premise:** with Track A done, the codebase tree is "upstream + skill applications." Cutover becomes:

```bash
# In cutover window:
git fetch upstream && git reset --hard upstream/main
./scripts/apply-all-skills.sh    # ships in `migrate-nanoclaw` skill (upstream)
npm install && ./container/build.sh
sqlite3 store/messages.db < migrate-v2.sql
systemctl restart nanoclaw
```

Track B exists primarily to (1) validate the apply-all-skills replay produces a working clone, (2) shadow-test on dedicated boards, (3) execute the cutover window, (4) monitor 72h.

---

## Critical file map (skills-only frame)

### Skills currently in `.claude/skills/` (40 total)

```
add-agent-swarm           add-image-vision        add-slack
add-compact               add-karpathy-llm-wiki   add-taskflow
add-discord               add-long-term-context   add-taskflow-memory
add-emacs                 add-macos-statusbar     add-telegram
add-embeddings            add-ollama-tool         add-telegram-swarm
add-gmail                 add-parallel            add-travel-assistant
add-pdf-reader            add-voice-transcription add-whatsapp
channel-formatting        claw                    convert-to-apple-container
customize                 debug                   get-qodo-rules
init-onecli               migrate-from-openclaw   ...
```

(Inventory at `ls /root/nanoclaw/.claude/skills/`. v3.0 audits them all in Track A Phase A.1.)

### Skills with proper `add/`+`modify/` structure (the "good shape")

`add-image-vision`, `add-pdf-reader`, `add-voice-transcription`, `add-agent-swarm`, `add-taskflow-memory`, `add-macos-statusbar`. These are already well-formed and serve as the template.

### Skills MISSING `add/`+`modify/` structure (the "debt")

`add-taskflow` is the largest case: SKILL.md references `container/agent-runner/src/taskflow-engine.ts` as the runtime, but the file lives in the codebase tree, not in the skill. Track A Phase A.2 enumerates every such case.

### Codebase files that look fork-private but aren't owned by any skill

To be inventoried in Phase A.1. Likely candidates:
- `src/db.ts` — has fork-private columns (`outbound_messages`, `agent_turn_messages`, `send_message_log`, taskflow custom cols) embedded in v1's schema
- `src/task-scheduler.ts` — fork-private scheduler
- `src/group-queue.ts` — fork-private agent-swarm queue (probably already in `add-agent-swarm`?)
- `src/ipc-plugins/*` — 9 fork-private IPC plugins
- `src/dm-routing.ts` — fork-private external-DM routing for TaskFlow meetings
- `src/taskflow-db.ts`, `src/taskflow-embedding-sync.ts` — TaskFlow runtime
- `container/agent-runner/src/{taskflow-engine,taskflow-mcp-server,semantic-audit,embedding-reader,context-reader}.ts` — TaskFlow + audit + memory runtime

---

## Revised prerequisites (BLOCKING — verify before Phase A)

- [ ] **Disk: ≥30GB free locally.** ✅ DONE (Phase -1 Task -1.1, 2026-04-30).
- [ ] **Audit-fix stability** at commit `ed52fa7` ≥3 daily Kipp audits without regression. ✅ DONE.
- [ ] **User commit to skills-only rule.** ✅ Reaffirmed 3x on 2026-05-01.
- [ ] **Clean working tree** local + prod.
- [ ] **`.env` backup** at `/root/.env-pre-v2-backup-<date>` chmod 400.
- [ ] **Pinned upstream baseline.** Track A starts against a specific upstream commit hash. Document in Phase A sign-off. (Drift trajectory: ~25 commits/day; re-pin between Track A and Track B.)

---

## Phase -1: Infrastructure Prep (DONE — preserved from v2.7)

✅ Task -1.1: disk reclaimed (61G; 30G+ free).
✅ Task -1.2: prod image pinned (`nanoclaw-agent:v1-rollback`, saved as `.tar`, md5 verified).
✅ Task -1.3: prod snapshot at `/root/prod-snapshot-20260430/` (chmod 444 + md5 baseline).
✅ Task -1.4 Step 1+3: `scripts/rollback-to-v1.sh` written, dry-run tested, snapshot-freshness gate, post-restart functional probes. (NOTE: `scripts/` is codebase. Under v3.0 this script's source-of-truth moves to a `migrate-nanoclaw-v2` skill's `add/` tree as part of Track A.)
⏸️ Task -1.4 Step 2: live sandbox rehearsal — needs disposable test VM.
⏸️ Task -1.5: PT-BR user-comms templates.
⏸️ Task -1.6: circuit breaker boot smoke — needs Track B image.

---

## Phase -1.5: Security back-port — DONE (no-op for v1, 2026-05-01)

✅ Audit at `docs/security/phase-1.5-attachment-traversal-audit-2026-05-01.md`. v1 codebase has no vulnerable sinks; `isValidGroupFolder()` stricter than v2's `isSafeAttachmentName`. No back-port needed.

---

## Phase 0: Recon & Gate (DONE — preserved from v2.7)

✅ Task 0.1: throwaway v2 worktree at `/root/nanoclaw-feat-v2/` (now reverted to pre-session state).
✅ Task 0.2: upstream migrator dry-run.
✅ Task 0.3: self-hosted OneCLI installed + verified.
✅ Task 0.4: Bun + bun:sqlite smoke (replay against new skills in Phase A.4).
⏸️ Task 0.5: WhatsApp v2-native adapter pairing — operator-blocked (test phone).
✅ Task 0.6: env allowlist audit.
✅ Task 0.7: `.env` safety audit.

---

## Track A: Skill Extraction

### Phase A.1: Audit fork divergence vs upstream (Week 1, ~3 days)

**Goal:** enumerate every byte of fork-private code in the codebase tree and map it to a skill (existing or new).

- [ ] **Step 1: Generate divergence diff.** `git diff upstream/main -- src/ container/agent-runner/src/ setup/ scripts/ package.json container/Dockerfile > /tmp/fork-divergence.patch`. This is the corpus of fork-private code.
- [ ] **Step 2: Classify each diff hunk.** For each hunk, label:
  - **Already in a skill** — the skill's `add/` or `modify/<path>` already covers it. Verify byte-equivalence; flag drift.
  - **In a skill but in `modify/<path>` without `.intent.md`** — partial coverage; needs `.intent.md` authored.
  - **Owned by no skill** — extraction debt. Map to the right skill or create a new one.
- [ ] **Step 3: Classification artifact.** Output a CSV at `docs/superpowers/audits/2026-05-XX-skill-divergence-audit.csv` with columns: `path,owner-skill,coverage-status,extraction-effort-days,notes`. Sortable for prioritization.
- [ ] **Step 4: Phase A.1 sign-off.** User reviews the audit; agrees on the per-skill extraction priority before Phase A.2 starts.

**Success criteria:**
- 100% of fork-divergence hunks classified (zero "?" rows).
- Total extraction effort estimated.
- Pinned upstream commit hash recorded.

### Phase A.2: TaskFlow extraction — biggest debt (Weeks 2-4)

**Goal:** make `add-taskflow` self-contained. Currently the skill's `SKILL.md` references runtime files in `container/agent-runner/src/` that aren't owned by the skill.

**Files to extract** (initial list, refined by A.1 audit):
- `container/agent-runner/src/taskflow-engine.ts` (1409 lines, 53 exports, ~579 SQL sites)
- `container/agent-runner/src/taskflow-mcp-server.ts`
- `container/agent-runner/src/taskflow-engine.test.ts`
- `src/taskflow-db.ts`
- `src/taskflow-db.test.ts`
- `src/taskflow-embedding-sync.ts`
- `src/dm-routing.ts` + `src/dm-routing.test.ts`
- `groups/<board>/CLAUDE.md` (deferred to runtime — covered by templates/CLAUDE.md.template already)

**Extraction approach (per file):**
1. Copy the file verbatim into `add-taskflow/add/<original-path>` (since these files don't exist in upstream `src/`, they're additions, not modifications).
2. If the file is modified (vs upstream having a different version), use `modify/<path>` with `.intent.md` instead.
3. Author `add-taskflow/add/<path>.intent.md` (or `modify/<path>.intent.md`) describing: WHAT the file does, WHY it diverges from upstream (or WHY it's net-new), what UPSTREAM API it consumes.
4. Update `add-taskflow/manifest.yaml`: add `adds:` entry per file.
5. Update `add-taskflow/SKILL.md` orchestration to ensure files copy at install time.
6. Run skill-replay test: apply `add-taskflow` to a clean upstream worktree → verify all 53 exports of `taskflow-engine.ts` resolve, all tests pass.

- [ ] Step 1: extract `taskflow-engine.ts` (largest, do first).
- [ ] Step 2: extract `taskflow-mcp-server.ts` + tests.
- [ ] Step 3: extract `taskflow-db.ts`, `taskflow-embedding-sync.ts`, `dm-routing.ts` + tests.
- [ ] Step 4: schema additions (`taskflow_groups` sidecar, custom indices) authored as `add-taskflow/add/migrations/<NNN>-taskflow-sidecar.sql` + an init script.
- [ ] Step 5: skill-replay test on a clean upstream worktree. Verify TaskFlow MCP tools register, schema migrates, prod-snapshot test data loads cleanly.
- [ ] Step 6: gate sign-off.

**Success criteria:**
- `add-taskflow` skill applies cleanly to a fresh `upstream/main` clone and produces a working TaskFlow runtime.
- Test count parity: every `taskflow-engine.test.ts` test passes after replay.
- `add-taskflow/manifest.yaml` core_version matches the pinned upstream commit's NanoClaw version.

### Phase A.3: Per-skill audits + extractions (Weeks 4-6, parallelizable)

For each non-empty diff cluster from Phase A.1, repeat the Phase A.2 pattern.

Likely targets (refined by A.1):

- [ ] **`add-agent-swarm`** — extract `src/group-queue.ts`, `src/group-queue.test.ts`, swarm-related IPC plugins. Verify `add-agent-swarm/modify/src/ipc.ts.intent.md` matches what's actually in `src/ipc.ts`.
- [ ] **`add-outbound-resilience` (NEW)** — extract `outbound_messages` schema + `src/outbound-dispatcher.ts` + tests. Owns the 2026-04-14 SIGKILL-resilience fix.
- [ ] **`add-long-term-context`** — verify all `context-service.ts`, `context-sync.ts`, `context-reader.ts`, `embedding-reader.ts`, etc. owned. (Likely the heaviest audit-correction skill.)
- [ ] **`add-taskflow-memory`** — extract `groups/<board>/.taskflow-memory.json` orchestration if not already in `modify/`.
- [ ] **`add-whatsapp`** — currently ships only `SKILL.md`; needs to absorb `src/channels/whatsapp.ts` modifications (vs upstream's `whatsapp.ts`) into `modify/`. Diff against `upstream/channels:src/channels/whatsapp.ts` to find true v1↔v2 surface delta.
- [ ] **`add-image-vision`, `add-pdf-reader`, `add-voice-transcription`** — already well-formed; spot-check `.intent.md` accuracy vs current code.
- [ ] **Audit-related skills** — `auditor-script.sh` heredoc + cron + Kipp prompt belong to a (currently missing) `add-semantic-audit` skill.

**Each skill follows the same pattern:**
1. Diff codebase vs upstream for the skill's surface.
2. For each fork-divergent file/hunk: extract into `add/` (new file) or `modify/<path>` (modified file).
3. Author `.intent.md` for every modify/.
4. Update `manifest.yaml`.
5. Skill-replay test on clean upstream.
6. Gate sign-off per skill.

### Phase A.4: Bun container runtime — author as a skill (Week 6)

**Goal:** the Bun port (formerly Phase 1) becomes the `bun-container-runtime` skill. Net-new in `add/`, no `src/` edits.

- [ ] Create `.claude/skills/bun-container-runtime/`.
- [ ] `manifest.yaml` declares: `modifies: [container/agent-runner/package.json, container/Dockerfile, container/agent-runner/tsconfig.json, container/agent-runner/src/index.ts, container/agent-runner/src/db-util.ts, container/agent-runner/src/auditor-script.sh]`.
- [ ] `modify/container/agent-runner/package.json` swaps `better-sqlite3` for `bun:sqlite`. Plus `.intent.md` describing why.
- [ ] `modify/container/Dockerfile` replaces npm install + `npx tsc --outDir` with `bun install` + `bun run`. Plus `.intent.md`.
- [ ] `modify/container/agent-runner/src/<every file with better-sqlite3>` swaps imports. Plus `.intent.md` per file.
- [ ] `modify/container/agent-runner/src/auditor-script.sh` swaps heredoc imports. Plus `.intent.md`.
- [ ] Tests in `tests/` validate the skill applied to `upstream/main` produces a passing `bun test` and `bun run` boot.

### Phase A.5: Track A gate (Week 7)

**Validation:**
- [ ] On a clean upstream-cloned worktree, run `apply-all-skills.sh` (NEW utility — owned by `migrate-nanoclaw-v2` skill).
- [ ] Worktree post-replay must produce a tree byte-equivalent to current production codebase (modulo prettier whitespace).
- [ ] `npm run build && npm test` pass on the replayed worktree.
- [ ] Container `./container/build.sh` succeeds.
- [ ] Smoke-test boot against an isolated `data/` dir produces no import-resolution errors.
- [ ] Sign-off: every fork-private behavior is captured in a skill.

---

## Track B: Cutover

### Phase B.1: Shadow run on test boards (Week 8, ~5 days)

**Goal:** end-to-end validation of the skill-replay-based install on dedicated test boards.

Test infrastructure: `test-taskflow` + `e2e-taskflow` boards on a SEPARATE WhatsApp number (operator-blocked on Phase 0.5; resolve before Phase B.1 starts).

- [ ] Spin up `nanoclaw-v2-shadow` install: `git clone upstream/main && apply-all-skills.sh && systemctl start`. Use a separate WhatsApp pairing.
- [ ] Replay 5 days of normal TaskFlow operations (board provisioning, task mutations, scheduled audits, sender approvals, cross-board forwards).
- [ ] Daily delta vs prod: compare outputs (Kipp daily report, digest summary, weekly review) for material divergence.
- [ ] Drill rollback: simulate each failure mode (Baileys auth corruption, schema migration mid-fail, OneCLI down). Confirm `rollback-to-v1.sh` recovers in ≤15 minutes per drill.
- [ ] Phase B.1 gate: 5 clean days + all rollback drills pass.

### Phase B.2: Production cutover (Week 9, 2h window + 72h soak)

**Pre-cutover (T-72h):**
- [ ] Send PT-BR user-comms (template from Phase -1 Task -1.5): "TaskFlow scheduled maintenance Sunday 03:00-05:00 BR. Boards may be slow during the window."
- [ ] Re-pin upstream commit hash; re-run Phase A.5 gate against the freshly-pinned hash. If skills drift caused regressions, fix in skills before proceeding.
- [ ] Fresh prod snapshot + md5 baseline.
- [ ] OneCLI v2 vault populated with all 28 boards' credentials.

**Cutover window (Sunday 03:00-05:00 BR):**
- [ ] Stop production: `systemctl stop nanoclaw`.
- [ ] Snapshot live DBs (atomic via `sqlite3 .backup`).
- [ ] On prod: `git fetch upstream && git checkout main-v2 && git reset --hard <pinned-upstream-hash>`.
- [ ] Run `migrate-v2.sh` against `store/messages.db` (preserves `data/taskflow/taskflow.db`).
- [ ] `apply-all-skills.sh` (replays every skill against the fresh upstream tree).
- [ ] `npm install && ./container/build.sh`.
- [ ] Start: `systemctl start nanoclaw`.
- [ ] Smoke: 1 trigger message per critical board; verify Kipp scheduled task fires; verify cross-board forward works.

**Post-cutover (72h):**
- [ ] Monitor logs for any silent regressions.
- [ ] Confirm 2 daily Kipp audits run cleanly.
- [ ] Confirm digest + standup runners fire for ≥3 active boards.
- [ ] No-rollback gate: if 72h soak passes without rollback, declare cutover complete.

### Phase B.3: Post-cutover cleanup (Week 10-11)

- [ ] Decommission v1 artifacts (old branches, unused docker images, native-credential-proxy install on v1 path).
- [ ] Merge `feat/v2-migration` orchestration branch → `main`.
- [ ] Update memory: project_v2_migration_assessment → "MIGRATED 2026-XX-XX".
- [ ] Retire `nanoclaw-feat-v2` worktree.

---

## Track A success metric: "skill-replay equivalence"

After Phase A.5, a clean clone of `upstream/main` + `apply-all-skills.sh` must produce a tree functionally equivalent to current production NanoClaw 1.x. Validation:

```bash
# In a scratch dir:
git clone https://github.com/qwibitai/nanoclaw nc-replay && cd nc-replay
git checkout <pinned-upstream-hash>
.claude/scripts/apply-all-skills.sh    # owned by migrate-nanoclaw-v2 skill
npm install && npm test                # parity with prod
./container/build.sh                   # container builds
diff -r ../prod-tree . | grep -v node_modules | grep -v dist
# expected: only data/ store/ .git/ differ; src/ container/ setup/ scripts/ are identical
```

If `diff` shows fork-divergent code in src/ that's NOT in any skill → Phase A is incomplete.

---

## Rollback procedures

### During Track A (per-skill)

If a skill extraction breaks runtime: `git revert` the skill commits; the codebase tree was never edited so rollback is purely skill-level.

### During Track B.1 shadow

If shadow detects a regression: fix in skill, re-replay, re-shadow. No production impact.

### During Track B.2 cutover window

`scripts/rollback-to-v1.sh` (already in `migrate-nanoclaw-v2/add/`):
1. Stop nanoclaw.
2. `git reset --hard v1-rollback-tag`.
3. Restore prod DB snapshot.
4. `docker tag nanoclaw-agent:v1-rollback nanoclaw-agent:latest`.
5. `systemctl start nanoclaw`.
6. Functional probes: WhatsApp connection-open log, registered_groups SELECT, no-v2-schema-bleed.
7. SLA: ≤15 minutes.

### Post-72h soak

Cutover is irreversible by design (data has flowed through v2 schema). If a regression surfaces post-72h, treat it as a normal bug fix authored as a new skill change.

---

## Out-of-scope / deferred

- **Multi-tenant fleet expansion** (1000+ boards across K NanoClaw instances). Per `project_v2_migration_assessment.md`: post-migration. Each instance gets own self-hosted OneCLI.
- **Path B (full upstream/channels repoint of WhatsApp adapter):** v2 upstream has it natively post-cutover. No fork repoint needed.
- **Per-group shadow:** Baileys auth is shared state. Single test-board shadow only.
- **Migrating IPC plugins to MCP tools:** stays file-based through cutover; revisit in a post-cutover project.

---

## Self-review (v3.0)

- **Spec coverage:** Phase A inventories every fork-divergent hunk; Phase B's gate is "skill-replay equivalence" — this catches gaps.
- **Skills-only constraint enforced:** every step that touches a file specifies the skill that owns it. Zero `src/` edits in any phase.
- **Realistic timeline:** Track A 5-8 weeks (load-bearing — TaskFlow extraction alone is ~3 weeks given 1409-line `taskflow-engine.ts`). Track B 1-2 weeks (cutover mechanics are simple once skills are durable).
- **Rollback at every gate:** per-skill (revert commit), shadow (re-replay), cutover (rollback-to-v1.sh in 15min).
- **What this plan does NOT cover** (deliberate): the apply-all-skills.sh utility design — that's a separate spec under `migrate-nanoclaw-v2` skill. The per-skill `manifest.yaml` schema — already exists, see `add-image-vision/manifest.yaml`. The exact runner for Phase A.1 audit CSV — owned by Track A start.

**Open question:** does upstream's `migrate-nanoclaw` skill already have an `apply-all-skills.sh` runner, or do we need to author one? Verify in Phase A.1 Step 1 before sizing Phase B.

---

## Phase mapping (old plan → new plan)

| v2.7 phase | v3.0 phase | Notes |
|---|---|---|
| Phase -1 (infra prep) | Phase -1 | Unchanged. Mostly DONE. |
| Phase -1.5 (security) | Phase -1.5 | Unchanged. DONE — no-op. |
| Phase 0 (recon + gate) | Phase 0 | Unchanged. DONE except 0.5 (operator-blocked). |
| Phase 1 (Bun container port via direct edits) | Phase A.4 (Bun runtime as a skill) | Reframed: net-new skill instead of direct file rename. |
| Phase 2 (WhatsApp re-port) | Track A: extract divergence in `add-whatsapp` | Phase 2 surgical additions removed. v2 upstream provides primitives natively post-cutover. |
| Phase 2.5 (TaskFlow permissions) | Track A: extract into `add-taskflow` | Permission seeders go in `add-taskflow/add/scripts/`. |
| Phase 3 (isMain rewrite) | Eliminated | v2 upstream already migrated isMain → hasAdminRole. Post-cutover, no isMain hits in core. Skill-private isMain checks (if any) live in skill modify/. |
| Phase 4 (shadow) | Phase B.1 | Same shape. |
| Phase 5 (cutover) | Phase B.2 | Same shape but uses skill-replay mechanism. |
| Phase 6 (cleanup) | Phase B.3 | Same shape. |

---

## Drift-protection notes

- **Pin upstream baseline at Phase A.1 start.** Repin between Track A and Track B (drift trajectory ~25 commits/day).
- **Skills are the durable contract.** When upstream evolves between repins, the `.intent.md` files describe the SEMANTIC change; an agentic worker re-applies the change to the new upstream shape.
- **Never hand-edit a `modify/<path>` to silently match new upstream.** If upstream's structure changes, update both `modify/<path>` AND `modify/<path>.intent.md`. The .intent.md is the contract; the modify/ file is the artifact.
- **Skills for upstream-tracking features (e.g., `add-whatsapp`) periodically re-sync** against upstream — that's a recurring task, not a v2-only event.

---

## Lessons preserved from v2.7 (still apply under v3.0)

- `feedback_codex_before_closure.md` — run skeptical review BEFORE declaring closure. Caught 9 BLOCKERs across 4 reviews.
- `feedback_diff_direction_check.md` — explicitly state diff endpoints; check both for fork-vs-fork ambiguity.
- `feedback_npm_install_for_typecheck.md` — full npm install before typecheck.
- `feedback_get_returns_null_in_bun_sqlite.md` — bun:sqlite `.get()` returns null, not undefined.
- `feedback_bun_regex_source_escapes_unicode.md` — bun renders non-ASCII regex source as `\uXXXX`.

---

**Status:** v3.0 strategic. Pending user sign-off before Phase A.1 starts. Net timeline: **8-12 weeks full-time** (was 11-15 in v2.7). The skills-only constraint front-loads Track A but compresses Track B to a near-mechanical replay.
