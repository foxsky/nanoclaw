# ADR 0006 — Executing the nanoclaw ↔ TaskFlow-V2 split (contracts + waves + overlay)

**Status:** accepted (2026-06-16). Follows ADR 0004 (boundary mapping) and ADR 0005
(68-node host component). Work branch: `split/core-extensions` (worktree
`/root/nanoclaw-split`, off `skill/taskflow-v2` @ `235b110c`). Upstream baseline
`8d57bdfa` (v2.0.54).

Design produced by workflow `wf_f6ef1465-b46` (41 agents) and **two Codex
gpt-5.5/xhigh review rounds** (round 1 set contracts-first; round 2 found the
gaps fixed below — verdict was "not-yet-sound", now reconciled).

## Goal
Core ends **near-pristine upstream**; TaskFlow becomes an **install-overlay**.
Every fork delta is one of: (a) a registration into a core extension contract,
(b) a fork-owned overlay file the installer copies, or (c) a trivially-upstreamable
correctness/security fix carried in-place.

## Target delivery model
Channel-style install-overlay (like `/add-slack`), **not** an npm package (host
runs compiled `dist/`; container source-mounts `/app/src`). `/add-taskflow`:
`git fetch skill/taskflow-v2` → copy fork-owned files via `git show <branch>:<path>
> <path>` → idempotent grep-then-append barrel registrations → deps (`pnpm` host /
`bun` container) → `pnpm run build` + `./container/build.sh` (MANDATORY — TaskFlow
ships container code). Pure copy-and-register **only after** the contracts land in
core. `poll-loop.ts`, `providers/claude.ts`, `current-batch.ts` are **whole-file
overlays forever** (not hookable).

## Landing strategy (decided)
**Fork branch now + upstream PRs in parallel.** Implement the contracts on
`split/core-extensions` to unblock + validate immediately; open upstream PRs to
nanoclaw for the generic contracts; drop the fork copies when upstream merges.
The contracts are generic decoupling machinery (NOT TaskFlow logic) — a deliberate,
scoped exception to "fork code only in `.claude/skills/`". Upstream PRs must **not**
carry TaskFlow barrel imports — those are the installer's append step.

## Core extension contracts (10)
Mirror existing patterns: `response-registry.ts` `onShutdown`,
`provider-container-registry.ts`, the name-keyed migration array, the
`registerDeliveryAction` / `setUnroutedDmResolver` registries.

| # | side | contract | replaces (inline today) | hardening (Codex r2) |
|---|------|----------|-------------------------|----------------------|
| 1 | host | `registerStartupHook(phase,name,fn,{order,critical})` / `getStartupHooks` | 4 inline TaskFlow boot blocks in `index.ts` | `critical` ⇒ fail-loud re-throw; service session MUST exist before delivery polls |
| 2 | host | `registerContainerContributor` / `collectContainerContributions` | `container-runner.ts` taskflow.db mount + NANOCLAW_MEMORY_*/board/holiday env | **REJECT duplicate/reserved containerPaths** (no remount of `/workspace` or inbound.db — SEC#8) + env precedence: contributed env cannot override host-critical (board-id/provider/gateway/OneCLI). #414 RO inbound mount + invalidPackageName + secret-mode + killContainer STAY inline core |
| 3 | host | `registerMigration(m)` | `db/migrations/index.ts` 2 inline imports+entries | name-keyed idempotency unchanged; rename fork `016-user-roles-unique-indexes`→`module-*` (collides w/ upstream incoming 016) |
| 4 | host | `registerDueMessageGate` + recurrence TZ resolver | `host-sweep.ts` runner-gate + board-TZ recurrence (Codex r2 BLOCKER — was missing) | gate fail-open per existing #387 lock-tested behavior |
| 5 | host | `registerTaskScriptSanitizer(fn)` | `scheduling/actions.ts` schedule_task.script RCE host leg (SEC#11) | default no-op for core; **install-side fail-closed on sanitizer error** (strip) |
| 6 | container | `registerExtraDb` / `registerTestSchema` | `connection.ts` 3rd-DB (getTaskflowDb) on the two-DB layer | — |
| 7 | container | `registerOutboundTransform(fn)` | `messages-out.ts` web-chat reply gate | **FAIL-CLOSED**: a throw on a web-origin turn must NOT fall back to writing the plain chat row (spoof-resistance also in `current-batch.ts`; G1 idempotency/G2 sender-fallback/anti-spoof survive verbatim) |
| 8 | container | `registerEmitHook(tool,{preEmit,postEmit,externalTargetGuard})` | `core.ts` send/file/edit/react SEC#11/#410 board gates | **registry lives in `server.ts`; invocations inside `core.ts` AFTER routing** (gates need the resolved routing tuple server.ts lacks). Preserve server.ts external-actor deny; **compose with `requiresChatActor`, not bypass** |
| 9 | container | `providers/types.ts` optional `confinedExternal?` / `supportsConfinedExternal?` | RC5-ext confined-external contract fields | inert optional members; absent ⇒ false ⇒ fail-closed |
| 10 | host | `registerBackfillStep` (or fork-owned whole-file overlay — see open Q) | `backfill-container-configs.ts` (.mcp.json backfill) | single consumer; registry-vs-overlay TBD |

## Execution waves (sequential — the 68-node component forbids parallel)
Build (`pnpm run build`) + tests after each seam; land importers as deps complete.

- **W1 — leaf foundations.** `types.ts` **NON-instance** parts only (the
  `is_main_control?` augment moves to a fork `.d.ts` — SEC-sensitive, NOT cosmetic);
  the leaf in-place upstreamable fixes (`config`, `delivery`, `container-runtime`,
  `claude-md-compose`, `channels/adapter`, `channels/index`, `cli/dispatch`,
  `db/session-db`, `permissions/index`, `permissions/db/user-roles`,
  `approvals/primitive` channelType, `self-mod/request`, `agent-destinations`,
  container `config.ts`); `session-manager` attachment-containment + odd-seq move
  carefully (Codex: NOT a noop). **`types.ts` `instance` field is deferred to W2.**
  Gate: host+container build+test green.
- **W2 — registries + DB/security leaves.** Contracts 3,6,7,10 land as **inert
  no-ops on pristine core first** (upstream builds green with zero fork modules),
  THEN fork modules register. The **migration + `messaging-groups.ts` +
  `types.ts` `instance` trio is ATOMIC** (ADR 0005). Also: `onecli-approvals`,
  `cli/resources/groups`, `scheduling/recurrence`, container `messages-out.ts` +
  `current-batch.ts`, `mcp-tools/server.ts` (emit-hook registry + external deny —
  must land before core.ts). **CODEX SEC GATE.**
- **W3 — hub seams.** `router.ts`, `container-runner.ts` (contract 2),
  `host-sweep.ts` (contract 4), `scheduling/actions.ts` (5),
  `approvals/response-handler.ts`, `providers/claude.ts` (overlay),
  `mcp-tools/core.ts` (contract 8). **CODEX SEC GATE (mandatory, multi-round):**
  prove each fork guard survives — router unrouted-DM fail-closed-on-throw;
  claude denylist-union + confined-external fail-closed; core emit-hook composes
  with requiresChatActor; response-handler re-auth-leaves-pending; actions
  script-strip fail-closed.
- **W4 — barrels.** `src/modules/index.ts` (already imports taskflow — preserve)
  + container `mcp-tools/index.ts` (~13 tool imports). Idempotent grep-then-append.
- **W5 — composition root + runner overlay.** `index.ts` → pristine composition
  root + two `runStartupPhase('post-db'|'post-services')` drains (contract 1);
  `poll-loop.ts` ships WHOLE as overlay. **CODEX SEC GATE (final, xhigh):** startup
  ordering (service session before delivery polls), critical-hook fail-loud, full
  RC5-ext + actor-domain + web-origin regression replay. Re-cut
  `release/taskflow-bundle-v2` only after all waves green + Codex CLEAN.

## poll-loop.ts
Whole-file fork overlay. A TurnRuntime hook pipeline is **rejected**: more work +
reopens the BLOCKER-class SEC holes hardened over ~10 Codex rounds. Zone-1
deterministic-dispatch evacuation (~290 lines behind a `DeterministicCommandRegistry`,
golden-order test) is a **separate later refactor**, not split critical path.

`poll-loop.test.ts` ships WITH the poll-loop overlay (installer-copied) and is
EXCLUDED from the pristine-core test run — it imports the TaskFlow overlay
(`mcp-tools/db/taskflow-db.js`) because it is the companion test of the whole-file
poll-loop overlay. A pristine-core `bun test` (no `/add-taskflow`) must not be
expected to resolve it.

## Installer barrel-append manifest (source of truth — checked in, not history-only)

The `/add-taskflow` installer's idempotent grep-then-append step (W4) must
re-append exactly these side-effect imports. After W4 reverted both barrels to
pristine (commit `274718a9`), these imports live ONLY in the installer's
append-set — the core barrels must NOT carry them. The authoritative list is the
block removed by `274718a9`; reproduced here so it is not history-only:

**`src/modules/index.ts`** (host) — 2 lines:
- `import './send-otp/index.js';`
- `import './taskflow/index.js';`

**`container/agent-runner/src/mcp-tools/index.ts`** (container chat barrel) — 17 lines:
- `import './send-otp.js';`
- `import './transcribe-audio.js';`
- `import './provision-root-board.js';`
- `import './provision-child-board.js';`
- `import './create-group.js';`
- `import './add-destination.js';`
- `import './taskflow-api-read.js';`
- `import './taskflow-api-mutate.js';`
- `import './taskflow-api-update.js';`
- `import './taskflow-api-notes.js';`
- `import './rename-board-person.js';`
- `import './taskflow-api-comment.js';`
- `import './memory.js';`
- `import './db/taskflow-db.js';`
- `import './db/web-chat-reply-transform.js';`
- `import './dispatch-extensions.js';`
- `import './emit-hooks.js';`

**`src/migrate-v2-steps-register.ts`** (host, v1→v2 migration) — 1 line:
- `import './modules/taskflow/migrate-v2-main-control.js';`

This registers the `is_main=1` → `is_main_control=1` carry-over as a generic
migrate-v2 post-seed step (contract: `src/migrate-v2-steps.ts`). It replaces the
former direct overlay coupling in `setup/migrate-v2/db.ts` (the production-core
leak the fan-out review flagged) — core `db.ts` now builds/runs pristine with zero
TaskFlow modules and runs zero steps. Importing the overlay step also pulls in
`migrations-register.js`, so the `is_main_control` column migration is registered
before `runMigrations()` creates it.

**`taskflow-api-board.js` is INTENTIONALLY NOT in the chat barrel** (preserve the
SEC cross-board exclusion — its read tools belong to the FastAPI engine seam
`taskflow-server-entry.ts` only).

**Security-critical append completeness:** `./emit-hooks.js` (SEC#11/#410 send/
file/edit/react board gates) and `./db/web-chat-reply-transform.js` (contract #7
FAIL-CLOSED web-origin anti-spoof outbound transform) self-register at module top
level and have NO non-test importer in core. If the installer omits either append,
the in-container chat tools ship UNGATED / the web-origin anti-spoof silently falls
through. `dispatch-extensions.js` is additionally imported transitively by
`taskflow-server-entry.ts`, but the chat barrel still needs its own append.

## Concrete installer (DONE)
`setup/add-taskflow.sh` + the checked-in copy-set manifest `setup/add-taskflow/copy-set.txt`
implement the channel-style overlay install: fetch the TaskFlow branch -> copy every
path in the copy-set via `git show <ref>:p > p` -> idempotent grep-then-append the 3
barrel append-sets above -> host `pnpm run build` (+ mandatory `./container/build.sh`
in a real install; `TASKFLOW_SKIP_CONTAINER_BUILD=1` for verification). `need_install`
checks the sentinel overlay file AND all 3 barrels, so re-runs are a clean no-op;
the append is grep-guarded so a partial barrel re-appends only the missing line.

**Copy-set = 245 fork-owned overlay files.** Derived from the Tier-A fork-manifest
minus generic-core (phone/group-queue/dm-routing/group-sender/v1-types) minus the
core extension contracts, PLUS the split-created TaskFlow registrants, then VERIFIED
by the delete-pristine-build / install-rebuild loop. Two Tier-A entries were
re-classified as **core** during verification (the pristine-core build named them):
`src/package-validation.ts{,.test.ts}` — ADR contract #2 keeps `invalidPackageName`
inline core (three core files import it). The leak `src/container-runner.test.ts`
(core SEAM) -> `modules/taskflow/container-contributions.js` was fixed by moving the
4 TaskFlow env-arg describe blocks into the overlay's `container-contributions.test.ts`.

Verified: pristine-core **host** build+tsc GREEN with the overlay deleted; after
install, host build + container `tsc --noEmit` GREEN, host `pnpm test` 1136 pass /
4 fail (the known `ensureAgentSecretMode` ONECLI_URL flakes — no resolution/import
errors), container `bun test` 1914 pass / 0 fail; `emit-hooks.js` +
`db/web-chat-reply-transform.js` (SEC gates) wire on install; idempotent re-run is a
no-op.

## Open items
- **Container-side split is incomplete on this branch.** A pristine-core *container*
  `tsc --noEmit` (overlay deleted) does NOT pass: 4 core SEAM files still import
  overlay paths — `index.ts`->`./poll-loop.js` (whole-file overlay) + `./mcp-tools/memory.js`;
  `mcp-tools/core.ts`->`../current-batch.js` (whole-file overlay); `mcp-tools/scheduling.ts`->`../well-formed.js`.
  The whole-file overlays of upstream files (`poll-loop.ts`, `current-batch.ts`) need a
  pristine-upstream baseline kept in core that the installer overwrites; the fork-new
  leaves (`memory.ts` `buildMemoryRecallAddendum`/`pruneBoardMemory`, `well-formed.ts`
  `truncateChars`) need their core-consumed symbols moved behind a core stub. Tracked
  as the remaining container decoupling (W2/W5 container leg).
- An executable CI guardrail (check out pristine core, assert host build green; run
  the installer, assert `pnpm test` + `bun test` green; enumerate top-level `register*`
  registrants and assert each appears in the documented append-set) would catch drift +
  the two orphan registrants mechanically.
- Contract 10 backfill: `registerBackfillStep` vs whole-file overlay (single consumer).
- `016-user-roles-unique-indexes`: push upstream as generic hardening vs `module-*` rename.
- `StartupContext` two-phase (`post-db`/`post-services`) — confirm no near-term hook needs a third.
- `host-core.test.ts` in-flight working-tree change overlaps W1/W3 seams (ADR 0003 stage-own-hunks).

## Constraints (firm)
Never deploy to `.63` for this work. Never touch the shared live `/root/nanoclaw`
tree — all edits on the `split/core-extensions` worktree. Stage only own hunks.
Never prettier `.md`. Container deps via `bun` (not pnpm); host respects
`minimumReleaseAge`.
