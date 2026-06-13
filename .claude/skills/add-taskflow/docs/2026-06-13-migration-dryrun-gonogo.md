# v1→v2 Migration — Sandbox Dry-Run GO/NO-GO (2026-06-13)

**Verdict: GO — with operational caveats. Zero BLOCKER, zero HIGH.**

The deterministic migration (data fidelity + orchestration) is sound. Every data-fidelity claim was verified against **DB state** (not log lines) in an isolated sandbox, then independently re-attacked by 14 adversarial verifier/runbook agents. Remaining items are operational cutover-host config (owned by tf-mcontrol/operator) or paths covered by unit tests but not exercised by this corpus — none block cutover.

## Method (sandbox-isolated; never touched `/root/nanoclaw/data` or `.63`)
- **Fixture** `/tmp/v1-fixture`: consistent read-only snapshot (`VACUUM INTO`) of the real prod corpus — `store/messages.db` (10 registered_groups, 6 active + 24 paused tasks, 8 session rows), `data/taskflow/taskflow.db` (34 boards, 252 board_holidays), + `data/sessions/` (15 folders), `groups/` (24), `.env`. Path chosen so the live `nanoclaw` systemd unit (WorkingDirectory=`/root/nanoclaw`) does **not** serve it → `taskflow.ts`'s live-v1 guard correctly stays inert.
- **Sandbox** `/tmp/v2-dryrun`: empty `data/` target. `DATA_DIR = resolve(process.cwd(),'data')`, so every step ran with **CWD=sandbox** (`node --import <tsx-loader> <abs-step> /tmp/v1-fixture`) — the integration-test harness pattern. No step could write the live install.
- **Steps run in sequence**: db → groups → sessions → tasks → taskflow → destinations, then the startup self-heal `backfillContainerConfigs()`. All exited 0.
- **Note**: full interactive `bash migrate-v2.sh` (bootstrap pnpm install + Docker build + service switchover + `exec claude`) was **not** run headless (unconditional TTY guard; heavy/flaky). Its orchestration was instead validated by code-review (Codex gpt-5.5/xhigh, 4 rounds → SAFE-TO-MERGE on the recent gate-reorder) + the step-sequence + 254 passing tests.

## Phase 1 — regression net: **254/254 green**
`setup/migrate-v2/` + `environment` + migrate-board-claudemd + migrate-scheduled-tasks + repatch-deployed/motivational + taskflow-mount + backfill-container-configs + runner-gate-apply + main-control + router-engage. Both typechecks clean.

## Phase 2 — data-fidelity claims (adversarially CONFIRMED against DB state)
| # | Claim | Verdict | Key evidence |
|---|-------|---------|--------------|
| C1 | Engage parity: `requires_trigger=0`→`'.'`, `=1`→trigger | **CONFIRMED** | v1 8/2 split → v2 `pattern\|.`×8 + `pattern\|@Tars`×2, folder-for-folder; `shared.ts:108-125` → `db.ts:211` |
| C2 | F3/F4 model+persona | **CONFIRMED** | `container_configs`=10; model on exactly the 3 *registered* model-boards (`claude-sonnet-4-6`); persona on all 10; sec-secti (non-registered) correctly excluded |
| C3 | `continuation:claude` = authoritative v1 session id | **CONFIRMED** | 8/8 in-scope match authoritative; for all 4 multi-JSONL folders the written id is the authoritative one, **not** the mtime-newest (Gap #1 + prefix-refresh proven); 2 no-row folders fall back to mtime (in scope of design) |
| C4 | F7 paused-task dormancy | **CONFIRMED** (NICE) | 6 active→pending, 20 paused→**paused (dormant)**, terminal dropped, cron recurrence preserved; never auto-resumed (traced to `session-db.ts:141-143` wake query + resume-only call sites). 24→20 gap = 4 sec-secti orphan tasks skipped upstream (unregistered group), not over-dropped |
| C5 | taskflow + holiday travel | **CONFIRMED** | taskflow.db **byte-identical** (sha256 match, 2318336 B); boards 34=34, holidays 252=252, tasks 384=384; content digests match |
| C6 | JSONL transcript fidelity | **CONFIRMED** | recursive byte-compare of **356/356** JSONLs (incl. nested `subagents/`) across all 10 migrated folders, both directions; largest (14.5 MB main transcript) cmp-identical |
| C7 | Destinations degraded = fail-soft, not a bug | **PARTIAL** (NICE) | Conclusion right (no resolver bug; 37/37 resolved point at real mg, 0 dangling). **Mechanism corrected**: the 33+5 unresolved short-circuit at folder→agent_group (24 boards aren't registered_groups), **not** JID-absence (25/34 link JIDs *are* present as person-derived mg). Self-heals on every boot via `backfill-taskflow-destinations`. |

## Phase 3 — cutover runbook cross-check
| # | Item | Status | Note |
|---|------|--------|------|
| R1 | Engine deploy = mounted src + `bun`, no dist rebuild | **VERIFIED** | `entrypoint.sh:16` / `container-runner.ts:612` `exec bun run /app/src/index.ts`; `agent-runner/dist` excluded in `.dockerignore` |
| R2 | Env trio (`TASKFLOW_MCP_RUNTIME=bun`, `_SERVER_BIN`, `_SERVICE_OUTBOUND_DB`) | **CODE-PRESENT-UNTESTED** (MEDIUM, op/tf-mcontrol) | Read by the **external** tf-mcontrol FastAPI (not nanoclaw src). Documented in `docs/v2-cutover-runbook.md:45-52` + asserted by `scripts/cutover-runbook.test.ts` (passing). Spawn target `taskflow-server-entry.ts` takes `--db`/`--service-outbound-db` CLI args; absent service-db = fail-closed per-call (no double-send) |
| R3 | Stale `dist/taskflow-mcp-server.js` | **CODE-PRESENT-UNTESTED** (MEDIUM, op) | Moot for the current nanoclaw runtime (bun runs mounted src; dist excluded). Only relevant to a tf-mcontrol host that referenced a dist |
| R4 | `scheduled_tasks`→`messages_in` drain + table-drop ordering | **CODE-PRESENT-UNTESTED** (none) | Ordering/drain-gate/idempotency correct (`index.ts:98-114`) + 17 unit tests; this corpus's taskflow.db has no `scheduled_tasks` table → no-op branch, drop-with-rows path not exercised here |
| R5 | `backfillContainerConfigs` idempotent/no-clobber | **VERIFIED** (NICE) | `backfill-container-configs.ts:120-155` skips existing rows |
| R6 | Service switchover + REVERT | **VERIFIED** | slugged `nanoclaw-v2-<sha1>`; `rollback_to_v1_no_v2` + EXIT trap + the (recently-moved) pre-copy v1-stop gate keep v1 restorable in every abort path |
| R7 | OneCLI `ensureAgent` selective-mode gotcha | **VERIFIED** (NICE) | `container-runner.ts:577`; remediation documented in `CLAUDE.md:156` |

## Gap list (severity · owner)
1. **Destinations unresolved on partial corpus** — NICE · migration/self-heal. Expected when boards ≫ registered_groups; fail-soft + idempotent boot self-heal. *Verify at .63 cutover that the unresolved count shrinks once the full group set exists.*
2. **Env trio must be set on the cutover host** — MEDIUM · tf-mcontrol/operator. Documented in `docs/v2-cutover-runbook.md` + test; not a nanoclaw code defect. Confirm set before the tf-mcontrol MCP starts.
3. **`scheduled_tasks` drop-with-rows path** — none · already unit-tested; not exercised by this corpus (no such table). No action.
4. **`additionalMounts` not exercised** — none · this corpus has no custom mounts; covered by `taskflow-mount.test.ts`.
5. **CLAUDE.md:158 stale line ref** ("container-runner.ts:385" → actual 577) — NICE · docs.
6. **Full interactive `bash migrate-v2.sh`** (bootstrap/Docker/switchover/exec) — reviewed-not-run-headless. Recommend one live sandboxed interactive pass on a throwaway box before flipping .63, to exercise the bootstrap + container build + switchover prompts end-to-end.

## Reproducibility
Fixture `/tmp/v1-fixture`, sandbox `/tmp/v2-dryrun`; loader `node_modules/.pnpm/tsx@4.21.0/.../esm/index.mjs`; run each step with `cd /tmp/v2-dryrun && node --import <loader> /root/nanoclaw/setup/migrate-v2/<step>.ts /tmp/v1-fixture`. Adversarial verification: workflow `migration-dryrun-gonogo` (14 agents, all findings DB-grounded).
