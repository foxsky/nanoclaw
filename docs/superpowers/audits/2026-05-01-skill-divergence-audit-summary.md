# Phase A.1 — Skill Divergence Audit (2026-05-01)

> **Status:** awaiting user sign-off on debt-disposition decisions before Phase A.2 starts.

## Executive summary

| Metric | Count |
|---|---|
| Total fork-divergent files vs `upstream/main` | **143** (114 added + 29 modified + 1 renamed; deletions excluded) |
| Total LOC of divergence | **~65,000** (insertions + deletions) |
| Files covered by our 6 skills | **54 (37.8%)** — 38,561 LOC (59.3%) |
| Files in DEBT (no-skill home) | **89 (62.2%)** — 26,424 LOC (40.7%) |

**Pinned upstream baseline:** `1b08b58f` (`upstream/main` HEAD at 2026-05-01).
**Fork-point:** `eba94b72` (2026-04-15). 603 upstream commits since fork; 915 fork-side commits since fork.

**Headline:** our 6 skills cover the load-bearing 60% of fork code by LOC (the big TaskFlow + audit + memory + context runtimes), but 89 files (~26K LOC) of fork divergence don't fit any of our skills. That's the debt to triage.

## Our 6 skills (confirmed)

| Skill | Files | LOC | Status |
|---|---|---|---|
| `add-taskflow` | 29 | 23,204 | ✅ confirmed; biggest skill — TaskFlow runtime, scheduler, board provisioning, cross-board, migrate-claude-md scripts, sender-allowlist, DM routing, tz-util, session-commands |
| `add-embeddings` | 14 | 7,902 | ✅ confirmed; absorbs auditor heredoc + semantic-audit + Kipp + digest-skip + audit-actor (semantic-audit uses embeddings) |
| `add-long-term-context` | 6 | 6,184 | ✅ confirmed; per-board context DB, DAG/rollup, qwen3-coder summarization, MCP tools |
| `add-taskflow-memory` | 5 | 1,271 | ✅ confirmed; Redis-backed memory layer, agent-memory-server v0.13.2 |
| `whatsapp-fixes` | 9 | 3,264 | ✅ confirmed; LID verification, reconnection, multi-trigger, phone util, group-folder validation |
| `add-travel-assistant` | 0 | 0 | ✅ confirmed; entirely skill-internal — no codebase divergence beyond what's already in skill |

**Total: 54 files / 38,561 LOC under skill ownership.**

(Note: file counts assume audit-level classification; some files may belong to multiple skills via different `modify/<path>` patches. Actual skill-extraction work in Phase A.2 will refine these.)

## Debt categories (89 files, 26,424 LOC)

Files that don't cleanly fit our 6 skills. Each row needs a disposition decision before Phase A.2 starts.

| Category | Files | LOC | Disposition options |
|---|---|---|---|
| **multi-skill core** (`src/types.ts`, `src/index.ts`, `src/container-runner.ts`, `src/db.ts`, `src/config.ts`, `src/env.ts`, `src/log.ts`, `src/db.test.ts`, `src/db-migration.test.ts`) | 9 | 5,831 | These have additions from MANY skills. Each skill that adds something must capture its piece in `modify/<path>` + `.intent.md`. Track A Phase A.3 redistributes. |
| **multi-skill setup** (`setup/*` — register, container, env, mounts, service, verify, groups, timezone) | 12 | 1,720 | Setup orchestration touched by many features. Same redistribution pattern. |
| **multi-skill container** (`container/Dockerfile`, `container/agent-runner/src/index.ts`, `db-util.ts`, `runtime-config.ts`, `ipc-mcp-stdio.ts`, `ipc-tooling.ts`) | 9 | 3,530 | Per-skill `modify/<path>` redistributes. |
| **no-skill: ipc-plugins** (`src/ipc.ts`, 9 `src/ipc-plugins/*.ts`) | 8 | 3,756 | Mostly TaskFlow-supporting plugins (provision-shared, send-otp, create-group, provision-child-board, provision-root-board). **Recommend: absorb into `add-taskflow/modify/`** since TaskFlow is the consumer. |
| **multi-skill router** (`src/router.ts`, `src/routing.test.ts`) | 2 | 741 | Per-skill `modify/<path>` for routing hooks. |
| **multi-skill or upstream-overlap** (`src/timezone.ts`, `src/group-sender.ts`, `src/channels/index.ts`, `src/channels/registry.ts`, `src/container-runtime.ts`, `src/transcription.ts`, etc.) | 9 | 462 | Distribute across skills that touch them. |
| **multi-skill or ops** (`src/agent-runner-ipc-tooling.test.ts`, `src/ipc-auth.test.ts`, `src/ipc-dm-auth.test.ts`) | 3 | 1,117 | TaskFlow uses these; absorb into `add-taskflow/modify/`. |
| **no-skill: session-management** (`src/session-cleanup.ts`, `src/session-commands.ts`, `src/session-commands.test.ts`) | 3 | 435 | Session commands (`/undo`, `/forward`) are TaskFlow features. **Recommend: absorb into `add-taskflow`**. |
| **no-skill: remote-control** (`src/remote-control.ts`, `src/remote-control.test.ts`) | 2 | 621 | What is this? Need to inspect. |
| **no-skill: outbound-resilience** (`src/outbound-dispatcher.ts`, related schema) | 2 | 507 | The 2026-04-14 SIGKILL-resilience fix. Generic NanoClaw improvement, not TaskFlow-specific. **Decision needed: absorb into `add-taskflow` (since TaskFlow drove the need), upstream as PR, or accept loss?** |
| **excluded: add-agent-swarm** | 2 | 1,242 | Confirmed as not-ours. **Skill REMOVED 2026-05-01** (`.claude/skills/add-agent-swarm/` deleted; 26 files). Runtime files (`src/agent-swarm.ts`, `src/agent-swarm-monitor.ts`, `src/group-queue.ts`) remain in codebase as orphaned debt — die at cutover when `src/` is reset to upstream. `SWARM_SSH_TARGET` not set in `.env` → not in active use → no production impact. |
| **upstream: native-credential-proxy** | 2 | 324 | Fork-private divergence in `src/credential-proxy.ts`. v2 cutover replaces this with self-hosted OneCLI. Drop. |
| **upstream: channel-formatting** (`src/text-styles.ts`) | 1 | 337 | upstream has a `channel-formatting` skill branch. Use upstream's instead of fork-private. |
| **ops-tooling** (`scripts/deploy.sh`, `scripts/cleanup-sessions.sh`, etc.) | 3 | 261 | Not skill territory — these are ops scripts. Keep but document outside skills. |
| **migration-time obsolete** (`scripts/migrate-v2-patches/*`) | 2 | 61 | Created during this session's reverted work. Drop. |
| **docs / not skill** | 2 | 281 | `scripts/e2e-live-tests.md`, README files. Move to `docs/` or absorb. |
| **multi-skill deps** (`package.json`) | 1 | 14 | Per-skill manifest declares its own npm_dependencies. |
| **UNCLASSIFIED** | 8 | 1,920 | Need manual review (mostly tests + small utilities). |

## Decisions needed before Phase A.2

### Decision 1: How to absorb the IPC plugins — RESOLVED 2026-05-01

8 files (3,756 LOC) — `src/ipc.ts` + `src/ipc-plugins/{create-group,send-otp,provision-shared,provision-child-board,provision-root-board}.ts` and tests.

**v2 architectural finding (per `https://github.com/qwibitai/nanoclaw` README):** v2 has **NO IPC** as a concept — eliminated by design. The README explicitly states "no cross-mount contention, no IPC, no stdin piping." The two-DB session model (`inbound.db` host-write / `outbound.db` container-write) replaces IPC entirely. Container writes structured action payloads to `outbound.db`; host's delivery sweep picks up and routes to handlers registered via `registerDeliveryAction(action, handler)` in `src/delivery.ts`.

**v2 architectural translation of our 5 plugins:**

| v1 plugin | v2 shape |
|---|---|
| `create-group.ts` (155 LOC) | New MCP tool `create_group` in `add-taskflow/add/container/agent-runner/src/mcp-tools/create-group.ts` + delivery action handler in `add-taskflow/add/src/delivery-actions/create-group.ts` (calls `WhatsAppChannel.createGroup()`). |
| `send-otp.ts` (54 LOC) | MCP tool `send_otp` + delivery action handler — same pattern. |
| `provision-root-board.ts` + `provision-child-board.ts` + `provision-shared.ts` (1668 LOC) | 2 MCP tools (`provision_root_board`, `provision_child_board`) + 2 delivery action handlers. The handlers internally call v2's `src/db/agent-groups.ts` + `src/db/messaging-groups.ts` helpers (which already exist in upstream). The bulky logic stays roughly the same; what disappears is the v1 IPC dispatcher boilerplate. |

**Resolved disposition:** absorb into `add-taskflow/modify/` and `add-taskflow/add/`. Result will be ~10-12 small skill files (5 MCP tool definitions + 5 delivery action handlers + 2 register-patch `modify/<index>.ts` files), totaling ~1.5-2K LOC (down from 3.8K LOC) since v2's helpers do the heavy lifting and the IPC dispatcher boilerplate disappears.

**Net win:** v2's "no IPC" design makes this cleaner than v1, not harder.

### Decision 2: outbound-resilience (SIGKILL-recovery)

2 files (507 LOC). The durable outbound queue prevents message loss on SIGKILL. Generic improvement; not TaskFlow-specific.

Options:
- (a) Absorb into `add-taskflow` (TaskFlow is the primary consumer).
- (b) Drop — accept that SIGKILL during message send may lose messages until upstream adopts a similar feature.
- (c) Submit as upstream PR; preserve in skill until upstream merges.

### Decision 3: session-cleanup + session-commands

3 files (435 LOC). `/undo`, `/forward`, session inactivity cleanup.

Options:
- (a) Absorb into `add-taskflow` (TaskFlow uses both).
- (b) Drop — `/undo` becomes manual via DB; cleanup runs via upstream defaults.

### Decision 4: remote-control

2 files (621 LOC). What does this do? **I need to inspect before recommending.**

### Decision 5: agent-swarm

Confirmed as not-ours; dies at cutover. **Sanity check:** is `SWARM_SSH_TARGET` set in production `.env`? If yes, the swarm is in use; we should warn before letting it die.

### Decision 6: the multi-skill files

29 files across `multi-skill core / setup / container / router / overlap`. These need **redistribution** — each existing skill that adds something to those files captures its piece in `modify/<path>` + `.intent.md`. That's labor-intensive (essentially auditing every skill's footprint on shared files), but it's the only path that preserves the skills-only rule.

Phase A.2 (TaskFlow extraction) is the biggest single piece. Phase A.3 redistributes per-skill.

## Coverage gaps in our 6 skills

Of our 54 ours-files, only 27 are currently captured in any skill's `manifest.yaml`-declared `add/`/`modify/` (per the existing `add-image-vision` template). The other ~27 files are physically in `src/` but the skills don't yet declare ownership.

Per-skill manifest gaps:
- **add-taskflow** — currently has NO `manifest.yaml` (skill is "natural-language only"; SKILL.md describes the runtime but doesn't declare files). Phase A.2 authors the manifest from scratch.
- **add-embeddings** — no manifest yet; needs one declaring auditor + semantic-audit + Kipp adoption.
- **add-long-term-context** — has SKILL.md only; needs full add/+modify/ tree.
- **add-taskflow-memory** — already has well-formed manifest + add/ + modify/ (per earlier inspection). Light work needed.
- **whatsapp-fixes** — needs manifest + add/+modify/ tree.
- **add-travel-assistant** — currently no codebase divergence; verify nothing's leaking.

## What Phase A.2 produces

For each of our 6 skills:
1. `manifest.yaml` declaring all `add:` files and `modify:` paths.
2. `add/<path>` containing each net-new file.
3. `modify/<path>` containing the modified version of each existing file.
4. `modify/<path>.intent.md` describing WHAT the modification does and WHY (semantic contract for replay across upstream evolution).
5. `tests/` for skill-replay validation.

When complete, applying the skill against a fresh `upstream/main` clone produces a working clone of the feature.

## Pinned upstream baseline

Track A starts against:
- **`upstream/main` = `1b08b58f`** (2026-05-01)
- Re-pin between Track A completion and Track B cutover (drift trajectory ~25 commits/day).

## Audit artifact

Full per-file CSV at: `/root/nanoclaw/docs/superpowers/audits/2026-05-01-skill-divergence-audit.csv` (143 rows, columns: `path, status, loc, owner-skill, coverage, effort`).

Sortable by skill, by LOC, by coverage status. Use this to drive Phase A.2 task planning.

## Next step

Once you sign off on Decisions 1-6 above, I can:
- Re-run the classification with your final dispositions
- Estimate per-skill extraction effort with the agreed scope
- Hand off Phase A.1 → Phase A.2 (start with `add-taskflow` — biggest skill, ~3 weeks)
