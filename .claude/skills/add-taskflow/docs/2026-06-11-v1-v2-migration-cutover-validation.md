# 2026-06-11 v1->v2 Migration / Cutover Validation

## Verdict

**GO-with-conditions for the tested migration mechanics. Not final GO for .63 cutover.**

The current code path has fresh scratch evidence for core v1->v2 migration, TaskFlow copy, scheduled-task porting, startup `container_configs` backfill, and the required creation-defect remediation script. Final .63 GO still requires a cutover-day .63 snapshot run, real host/container/service checks, channel auth, live smoke, and the operator decisions listed below.

## New Blocker Fixed Before Report

The runbook still told tf-mcontrol to deploy a rebuilt `dist/taskflow-mcp-server.js`. That is stale after the R1-R5 + #396 + SEC engine work.

Fix in this worktree:

- `docs/v2-cutover-runbook.md` now instructs tf-mcontrol to run the engine MCP subprocess from source with:
  - `TASKFLOW_MCP_RUNTIME=bun`
  - `TASKFLOW_MCP_SERVER_BIN=<deploy-root>/container/agent-runner/src/mcp-tools/taskflow-server-entry.ts`
  - `TASKFLOW_SERVICE_OUTBOUND_DB`
- `scripts/cutover-runbook.test.ts` guards the source+bun contract and rejects the retired rebuilt-dist wording.

TDD evidence:

- RED: `npx vitest run scripts/cutover-runbook.test.ts` failed before the runbook edit because `TASKFLOW_MCP_RUNTIME=bun` was absent.
- GREEN: `npx vitest run scripts/cutover-runbook.test.ts` passed after the edit.

## Fresh Scratch Wrapper Run

Scratch v2 tree:

- `/tmp/nanoclaw-v2-current-dryrun-20260611`
- Source was a clean archive of `HEAD`; `node_modules` was symlinked from the workspace.
- External-only checks were faked in `/tmp/nanoclaw-v2-cutover-fakebin-20260611`:
  - `systemctl`/`sudo`: prevent live service touches
  - `docker`/`curl`: avoid real Docker/OneCLI side effects
  - `pnpm install`: no-op because linked deps were already present
  - `pnpm exec tsx`: routed through `node --import tsx` to avoid sandbox IPC failure

V1 fixture:

- `/tmp/nanoclaw-v1-snapshot-cutover-20260529`
- `registered_groups`: 35
- active scheduled tasks: 117
- TaskFlow: 34 boards, 384 tasks, `PRAGMA integrity_check=ok`
- No `.env`
- No `data/sessions/` transcript directory
- No legacy `container.json` / `.mcp.json` files in migrated groups

Wrapper result:

- `logs/setup-migration/handoff.json`: `overall_status=success`, `service_switched=false`, `degraded=false`
- `1a-env`: skipped, no v1 `.env`
- `1b-db`: `OK:groups=35,created=35,reused=0,skipped=0,main_promoted=1`
- `1c-groups`: `OK:folders=37,claudes=36,files=0`
- `1d-sessions`: skipped, no v1 `data/sessions/`
- `1e-tasks`: `OK:active=117,migrated=117,skipped=0,failed=0`
- `1f-taskflow`: `OK:taskflow=copied,boards=34,tasks=384`
- channels: none selected
- service switchover: skipped because v1 reported inactive in scratch

Post-run SQL:

- `v2.db`: 35 `agent_groups`, 35 `messaging_groups`, 35 `messaging_group_agents`, 35 `sessions`
- all 35 wirings: `unknown_sender_policy=public`, `engage_mode=pattern`, `engage_pattern='.'`
- startup backfill created 35 `container_configs` default rows; central DB integrity `ok`
- `taskflow.db`: 34 boards, 384 tasks, 252 `board_holidays`; integrity `ok`
- per-session DBs: 35 `inbound.db`, 35 `outbound.db`
- migrated scheduled tasks in inbound queues: 117
- all inbound/outbound DB integrity checks: `ok`

## Creation-Defect Remediation

Executed against the scratch migrated DB:

```bash
pnpm exec tsx setup/migrate-v2/fix-creation-defects.ts /tmp/nanoclaw-v2-current-dryrun-20260611/data/taskflow/taskflow.db
pnpm exec tsx setup/migrate-v2/fix-creation-defects.ts /tmp/nanoclaw-v2-current-dryrun-20260611/data/taskflow/taskflow.db --apply
```

Dry-run found the expected items:

- Mariany dual identity: `mariany -> mariany-borges`
- Sanunciel orphan: present, owns no board, 2 tasks; manual reprovision required
- Hudson duplicate-board cluster: operator must choose canonical board

Apply result:

- `APPLIED mariany->mariany-borges`
- `boardPeopleDeleted=1`
- `adminsTransferred=2`
- `tasksReassigned=5`
- `exactUpdates=84`
- `jsonRewrites=58`

Idempotency / residual evidence:

- second `--apply`: dual-identity stubs detected `0`
- `PRAGMA integrity_check=ok`
- direct residual checks: `board_people.person_id='mariany' = 0`, `tasks.assignee='mariany' = 0`, `archive.assignee='mariany' = 0`
- manual items remain by design:
  - re-provision Sanunciel's child board via the live agent after cutover
  - resolve Hudson duplicate-board cluster by operator decision

## Regression / Build Evidence

Current workspace validation:

- `npx vitest run setup/migrate-v2/*.test.ts scripts/cutover-runbook.test.ts`: 5 files, 58 tests passed
- `npm run typecheck`: passed
- `npx vitest run`: 77 files, 985 tests passed
- `container/agent-runner`: `bun test`: 87 files, 1744 pass, 1 todo, 0 fail
- `container/agent-runner`: `bun run typecheck`: passed
- `npm run build`: passed

## Adversarial Review

Codex gpt-5.5/xhigh read-only review returned **GO-with-conditions**, not final GO.

Findings:

1. Unconditional .63 GO is not supported by this scratch fixture because it is not a cutover-day .63 snapshot and skipped `.env` plus transcript session copy.
2. Host-facing cutover was not exercised: `service_switched=false`, Docker/container checks were faked.
3. Creation-defect remediation evidence was required; this report now adds dry-run, apply, idempotency, and residual checks.
4. If tf-mcontrol is deployed, dashboard integration remains conditional on real env/runtime/shared-DB/phone-arrival checks.

## Remaining Conditions Before Final .63 GO

1. Copy a fresh cutover-day .63 snapshot to scratch and run the wrapper cleanly with counts/integrity matching the backup and no unexplained skips/failures.
2. Run `fix-creation-defects.ts --apply` on the migrated cutover DB and capture the same apply/idempotency/residual evidence, plus documented operator decisions for Sanunciel and Hudson.
3. Exercise real host-facing cutover gates outside the sandbox: real Docker build, service start, channel auth, and live smoke with `service_switched=true`.
4. If tf-mcontrol is deployed, verify:
   - `TASKFLOW_MCP_RUNTIME=bun`
   - `TASKFLOW_MCP_SERVER_BIN` points at `container/agent-runner/src/mcp-tools/taskflow-server-entry.ts`
   - `TASKFLOW_SERVICE_OUTBOUND_DB` is set
   - shared `TASKFLOW_DB_PATH`
   - dashboard reassign DM and offline-assignee deferred arrive on a real phone during canary

