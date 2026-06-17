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

## Open items
- Contract 10 backfill: `registerBackfillStep` vs whole-file overlay (single consumer).
- `016-user-roles-unique-indexes`: push upstream as generic hardening vs `module-*` rename.
- `StartupContext` two-phase (`post-db`/`post-services`) — confirm no near-term hook needs a third.
- `host-core.test.ts` in-flight working-tree change overlaps W1/W3 seams (ADR 0003 stage-own-hunks).

## Constraints (firm)
Never deploy to `.63` for this work. Never touch the shared live `/root/nanoclaw`
tree — all edits on the `split/core-extensions` worktree. Stage only own hunks.
Never prettier `.md`. Container deps via `bun` (not pnpm); host respects
`minimumReleaseAge`.
