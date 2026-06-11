# 2026-06-11 v1->v2 Migration / Cutover Validation

## Verdict

**GO-with-conditions for the tested migration mechanics. Not final GO for .63 cutover.**

The current code path has fresh scratch evidence for core v1->v2 migration, TaskFlow copy, scheduled-task porting, startup `container_configs` backfill, and the required creation-defect remediation script. Final .63 GO still requires a cutover-day .63 snapshot run, real host/container/service checks, channel auth, live smoke, and the operator decisions listed below.

## Defects Fixed During Validation

### tf-mcontrol runbook stale dist path

The runbook still told tf-mcontrol to deploy a rebuilt `dist/taskflow-mcp-server.js`. That was stale after the R1-R5 + #396 + SEC engine work.

Fix in this worktree:

- `docs/v2-cutover-runbook.md` now instructs tf-mcontrol to run the engine MCP subprocess from source with:
  - `TASKFLOW_MCP_RUNTIME=bun`
  - `TASKFLOW_MCP_SERVER_BIN=<deploy-root>/container/agent-runner/src/mcp-tools/taskflow-server-entry.ts`
  - `TASKFLOW_SERVICE_OUTBOUND_DB`
- `scripts/cutover-runbook.test.ts` guards the source+bun contract and rejects the retired rebuilt-dist wording.

TDD evidence:

- RED: `npx vitest run scripts/cutover-runbook.test.ts` failed before the runbook edit because `TASKFLOW_MCP_RUNTIME=bun` was absent.
- GREEN: `npx vitest run scripts/cutover-runbook.test.ts` passed after the edit.

### BLOB scheduled-task prompt migration

A workflow verifier found one active v1 scheduled task (`auditor-daily`) whose `prompt` column was a SQLite BLOB. The old `tasks.ts` path inserted that value into JSON as `{ "type": "Buffer", "data": [...] }`, which would render at runtime as `[object Object]`.

Fix:

- `setup/migrate-v2/tasks.ts` now decodes Buffer prompts as UTF-8 text before serializing the v2 `messages_in.content` envelope.
- `setup/migrate-v2/step-integration.test.ts` now drives real `db.ts` + `tasks.ts` subprocesses and asserts a BLOB prompt migrates as a string.

TDD evidence:

- RED: `npx vitest run setup/migrate-v2/step-integration.test.ts -t "decodes legacy BLOB"` reproduced the Buffer-object JSON.
- GREEN: same command passed after the fix.
- Fixed dry-run SQL: all 117 migrated `kind='task'` rows have `json_type(content,'$.prompt') = 'text'`; `auditor-daily` extracts as the original Portuguese auditor prompt text.

## Fresh Scratch Wrapper Run

Scratch v2 tree:

- `/tmp/nanoclaw-v2-current-dryrun-20260611-blobfix`
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
- all 117 migrated task prompts are JSON strings (`json_type='text'`), including `auditor-daily`
- all inbound/outbound DB integrity checks: `ok`

## Creation-Defect Remediation

Executed against the scratch migrated DB:

```bash
node --import tsx setup/migrate-v2/fix-creation-defects.ts /tmp/nanoclaw-v2-current-dryrun-20260611-blobfix/data/taskflow/taskflow.db
node --import tsx setup/migrate-v2/fix-creation-defects.ts /tmp/nanoclaw-v2-current-dryrun-20260611-blobfix/data/taskflow/taskflow.db --apply
```

Archived scratch logs:

- `/tmp/nanoclaw-v2-current-dryrun-20260611-blobfix/logs/validation/fix-creation-defects-dry-run.log`
- `/tmp/nanoclaw-v2-current-dryrun-20260611-blobfix/logs/validation/fix-creation-defects-apply.log`
- `/tmp/nanoclaw-v2-current-dryrun-20260611-blobfix/logs/validation/fix-creation-defects-second-apply.log`

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
- direct residual checks: `board_people.person_id='mariany' = 0`, `board_admins.person_id='mariany' = 0`, `boards.owner_person_id='mariany' = 0`, `tasks.assignee='mariany' = 0`, `archive.assignee='mariany' = 0`, `task_history.by='mariany' = 0`
- manual items remain by design:
  - re-provision Sanunciel's child board via the live agent after cutover
  - resolve Hudson duplicate-board cluster by operator decision

## Regression / Build Evidence

Current workspace validation:

- `npx vitest run setup/migrate-v2/*.test.ts scripts/cutover-runbook.test.ts`: 5 files, 58 tests passed
- after BLOB fix: `npx vitest run setup/migrate-v2/*.test.ts scripts/cutover-runbook.test.ts`: 5 files, 59 tests passed
- `npm run typecheck`: passed
- `npx vitest run`: 77 files, 986 tests passed
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

Workflow verifier passes found additional report-changing gaps:

1. `auditor-daily` BLOB prompt migration was malformed before the fix above. The defect is now covered by regression test and a fresh fixed dry run.
2. Creation-defect stdout needed archived artifacts. The fixed dry run now writes dry-run/apply/second-apply logs under `logs/validation/`.
3. Runbook step 6d, the motivational-only deployed-board refresh, is not executed in this scratch validation and remains a cutover condition.
4. The runbook preflight prompt-scan regex is currently too broad/noisy for the migrated scratch prompts; it matches current v2 notification prose such as `target_chat_jid`. Narrow or explicitly adjudicate this gate before cutover.
5. tf-mcontrol checks need the full operational checklist if the dashboard is deployed, not just the env-var text guard.

## Remaining Conditions Before Final .63 GO

1. Copy a fresh cutover-day .63 snapshot to scratch and run the wrapper cleanly with counts/integrity matching the backup and no unexplained skips/failures.
2. Run `fix-creation-defects.ts --apply` on the migrated cutover DB and capture the same apply/idempotency/residual evidence, plus documented operator decisions for Sanunciel and Hudson.
3. Run the runbook's 6d motivational-only refresh against the migrated deployed-board prompts: dry-run, write, diff spot-check, and marker verification.
4. Fix or adjudicate the runbook prompt-scan regex before using it as a cutover gate; the current broad scan can match valid v2 notification prose.
5. Exercise real host-facing cutover gates outside the sandbox: v1 service health preflight, real Docker build, service start, channel auth, retained v1 unit for rollback, rollback path if needed, canary watch items, and live smoke with `service_switched=true`.
6. If tf-mcontrol is deployed, verify:
   - engine source deployed before tf and `bun install` run in `container/agent-runner/`
   - `TASKFLOW_MCP_RUNTIME=bun`
   - `TASKFLOW_MCP_SERVER_BIN` points at `container/agent-runner/src/mcp-tools/taskflow-server-entry.ts`
   - `TASKFLOW_SERVICE_OUTBOUND_DB` is set
   - shared `TASKFLOW_DB_PATH`
   - shared DB `journal_mode=DELETE`
   - stale `.61`/`.63` `dist/taskflow-mcp-server.js` copies deleted or made unreachable
   - dashboard manager-or-assignee parent gate, retired deferred IPC, and no double-delivery behavior confirmed
   - dashboard reassign DM and offline-assignee deferred arrive on a real phone during canary
