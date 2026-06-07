# NanoClaw v2 Cutover Runbook

This runbook is the cutover-day operating procedure for the v1 to v2 TaskFlow migration. It assumes the code is on `skill/taskflow-v2`, production data has just been snapshotted, and the operator has signed the `v1-bug-corrected` exceptions in `docs/v2-cutover-exception-list.md`.

## Preflight

1. Capture a fresh online backup of v1 `store/messages.db` and `data/taskflow/taskflow.db`.
2. Verify both backups with `PRAGMA integrity_check`.
3. Confirm the latest regenerated board prompts have no legacy TaskFlow tool names, raw sqlite, v1 transport args, or v1 scheduling-schema references:

   ```bash
   rg -n "\btaskflow_(query|report|move|reassign|update|admin|create|dependency|hierarchy|undo)\b|mcp__sqlite__|board_id:|target_chat_jid|target_group_jid|schedule_type|schedule_value" groups/*/CLAUDE.local.md
   ```

   The command must return no matches.

4. Confirm the v1 service is healthy before migration:

   ```bash
   systemctl is-active nanoclaw
   ```

5. Keep the v1 unit file installed. The migration disables/stops v1 but does not delete the unit, so rollback remains possible.

## Migration

Run the normal migration script from the v2 checkout:

```bash
bash migrate-v2.sh
```

Required operator choices:

- Stop v1 when prompted before copying `taskflow.db`.
- Do not proceed if the script reports uncheckpointed WAL frames.
- Do not proceed if both user and system `nanoclaw` units are installed or active.
- Confirm the `1c-groups` step reports migrated prompts. The migration writes v2 `CLAUDE.local.md` files through `src/modules/taskflow/migrate-board-claudemd.ts`; it must not copy raw v1 `CLAUDE.md` prose unchanged.
- Accept the v2 switchover only after the script reports successful DB, group, session, scheduled task, TaskFlow DB, and container build steps.

## Canary Plan

Canary window: first 50 real production messages after v2 switchover, or the first 24 hours, whichever comes first.

Success metric:

- 0 operator interventions required for lost replies, duplicate replies, wrong-board mutations, or false task lookups.
- At least 95 percent human-judged-correct responses.
- No unreviewed `v1-bug-corrected` behavior copied from v1.

Extra watch items from Phase 3:

- SETD meeting note selection: messages like "reunião sobre X" should not silently attach to a same-named project when the user clearly means a meeting.
- SETD participant reminders: fresh-session ambiguity may need operator confirmation when the recent meeting context is missing.
- Laizys duplicate-create prompts: v2 should ask before duplicating tasks already present in the synced board state.
- SEC cross-board-visible child tasks and meeting flows.

Rollback triggers:

- Any wrong task mutation on a production board.
- Any false "not found" for a task visible in the board or org scope.
- Any duplicate outbound reply pattern that repeats after one restart.
- More than 2 operator interventions in the first 50 messages.
- Human-judged correctness below 95 percent in the canary window.

## Rollback

Rollback is intended for the first 24 hours after cutover. After that, taskflow.db divergence must be reconciled manually before v1 can safely resume.

First identify the actual v2 service unit. It is slugged, not literally `nanoclaw-v2`:

```bash
V2_SERVICE=$(grep '^SERVICE_UNIT:' logs/migrate-steps/service-install.log | tail -1 | sed 's/^SERVICE_UNIT: *//')
test -n "$V2_SERVICE"
```

If the service-install log is unavailable, compute it from the checkout:

```bash
V2_SERVICE=$(pnpm exec tsx -e "import{getSystemdUnit}from'./src/install-slug.ts';console.log(getSystemdUnit())")
```

Systemd user-unit rollback:

```bash
systemctl --user stop "$V2_SERVICE"
systemctl --user disable "$V2_SERVICE"
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
systemctl --user status nanoclaw
```

Systemd system-unit rollback:

```bash
sudo systemctl stop "$V2_SERVICE"
sudo systemctl disable "$V2_SERVICE"
sudo systemctl enable nanoclaw
sudo systemctl start nanoclaw
sudo systemctl status nanoclaw
```

If the v2 service name is unclear, identify both unit files before stopping/starting anything:

```bash
systemctl --user list-unit-files | rg nanoclaw
systemctl list-unit-files | rg nanoclaw
```

TaskFlow DB reconciliation:

1. Stop v2 before copying any DB back.
2. Compare v2 `data/taskflow/taskflow.db` to the pre-cutover v1 backup.
3. If rollback happens inside 24 hours and no accepted v2-only production mutations exist, move the v2 DB aside and restart v1 on its original DB.
4. If v2 accepted production mutations, export the changed `tasks` (notes live in the `tasks.notes` column — there is no `task_notes` table), `task_history`, `board_chat`, and `archive` rows for operator review before restarting v1.

Message/channel/session reconciliation:

1. Keep the pre-cutover v1 `store/messages.db` backup immutable (in v1 this file IS the message log — v1 reads it after the rollback).
2. Before restarting v1, inspect the **v2** message state for inbound rows consumed after cutover and outbound rows already delivered — see the schema note below for where those rows actually live in v2 (it is NOT `store/messages.db`).
3. If rollback happens after any v2 reply was delivered, do not blindly copy v2 message state over v1. Export the cutover-window `messages_in` / `messages_out` rows and their delivery status from the v2 per-session DBs for operator review.
   - **v2 schema note:** v2 does NOT keep messages in `store/messages.db`. On a v2 box `store/messages.db` is only a setup-time group-name cache (a single `chats` table written by the group-sync step, `setup/groups.ts`), and WhatsApp/baileys auth lives in `store/auth/` — neither holds message rows. The real per-session rows are: `messages_in` under `data/v2-sessions/<agent_group_id>/<session_id>/inbound.db`, `messages_out` under the sibling `outbound.db` (two-DB session split), with routing + `session_state` in the central `data/v2.db` (and the session `outbound.db`). Export from those, not from `store/messages.db`.
4. Clear or move aside v2-only container/session state (`data/v2-sessions/`, `data/v2.db`) before restarting v1 so v1 does not inherit v2 session assumptions.

Minimum post-rollback checks:

```bash
systemctl is-active nanoclaw
# Real health gate (exits non-zero so it can't be skimmed past): scripts/q.ts opens
# without fileMustExist, so a missing DB would be silently CREATED empty and report
# "ok" — assert the file exists AND that integrity_check literally returns "ok".
rollback_ok=1
for db in data/taskflow/taskflow.db store/messages.db; do
  if [ ! -f "$db" ]; then
    echo "MISSING (investigate before declaring rollback healthy): $db"; rollback_ok=0; continue
  fi
  res=$(pnpm exec tsx scripts/q.ts "$db" "PRAGMA integrity_check")
  echo "$db: $res"
  [ "$res" = "ok" ] || { echo "INTEGRITY FAIL: $db"; rollback_ok=0; }
done
[ "$rollback_ok" = 1 ] || { echo "ROLLBACK HEALTH CHECK FAILED — do not declare healthy"; exit 1; }
```

Then send one operator-owned smoke message to the main control channel and one TaskFlow board message that only reads state.

## Evidence From 2026-05-29 Dry Run

- Disposable v1 snapshot: `/tmp/nanoclaw-v1-snapshot-cutover-20260529`
- Disposable v2 target: `/tmp/nanoclaw-v2-migration-dryrun-20260529`
- Source synced prod pair: `/tmp/prod-interactions-latest`
- DB step: `OK:groups=35,created=35,reused=0,skipped=0,main_promoted=1`
- Groups step: `OK:folders=37,claudes=36,files=0`
- Patched groups-step prompt migration check: `/tmp/nanoclaw-v2-groups-dryrun-20260530` wrote 36 migrated prompts; immediate rerun wrote 0; scan found no legacy TaskFlow tool-name, `mcp__sqlite__`, `board_id:`, `target_chat_jid`, `target_group_jid`, `schedule_type`, or `schedule_value` leaks.
- Scheduled tasks step: `OK:active=117,migrated=117,skipped=0,failed=0`
- TaskFlow copy path: `OK:taskflow=copied,boards=34,tasks=384`
- Idempotency rerun: DB reused 35 groups, groups copied 0 files, scheduled tasks skipped 117 existing rows, TaskFlow copy returned `SKIPPED:v2 taskflow.db already populated`.
- Integrity: copied TaskFlow DB has 34 boards, 384 tasks, and `PRAGMA integrity_check` returns `ok`.

## Creation-Defect Remediation (Cutover-Day Checklist #6)

Run AFTER the TaskFlow DB copy step and BEFORE the canary, against the **migrated v2** `data/taskflow/taskflow.db` (never the live v1 DB). Capture all output in the cutover log. Background: `docs/v1-creation-empirical-map.md`; exceptions EX-014 / EX-015.

### 6a. Mariany dual-identity merge — REQUIRED, automated (EX-015)

This is EX-015's **sole** prevention (the engine reconcile was removed), so it **must run and must be verified** — there is no orchestration step that runs it for you. Treat the two commands below as a gate: do not start the canary until the `--apply` log shows the `APPLIED` line with no rollback error.

```bash
cp data/taskflow/taskflow.db data/taskflow/taskflow.db.pre-creation-fix      # backup
pnpm exec tsx setup/migrate-v2/fix-creation-defects.ts data/taskflow/taskflow.db        2>&1 | tee -a "$CUTOVER_LOG"   # dry-run (review)
pnpm exec tsx setup/migrate-v2/fix-creation-defects.ts data/taskflow/taskflow.db --apply 2>&1 | tee -a "$CUTOVER_LOG"   # apply
# redundant spot-check on the highest-volume columns (the script's own scan below is the authoritative all-column gate):
pnpm exec tsx scripts/q.ts data/taskflow/taskflow.db "SELECT (SELECT count(*) FROM board_people WHERE instr(REPLACE(person_id,'mariany-borges',''),'mariany')>0) + (SELECT count(*) FROM tasks WHERE instr(REPLACE(COALESCE(_last_mutation,'')||COALESCE(notes,'')||COALESCE(assignee,''),'mariany-borges',''),'mariany')>0) + (SELECT count(*) FROM archive WHERE instr(REPLACE(COALESCE(task_snapshot,'')||COALESCE(history,'')||COALESCE(assignee,''),'mariany-borges',''),'mariany')>0) + (SELECT count(*) FROM task_history WHERE instr(REPLACE(COALESCE(details,'')||COALESCE(\"by\",''),'mariany-borges',''),'mariany')>0) AS residual_mariany_refs"   # expect 0
```

**Pass criteria — the authoritative gate is the `--apply` run itself:** it prints `APPLIED mariany->mariany-borges: {...}` and does **not** throw `merge aborted (rolled back)`. The merge rewrites both plain (`"mariany"`) and escaped (`\"mariany\"`, JSON-serialized-as-string inside snapshots/archive — the live snapshot has 4) refs; its fail-loud residual scan is **depth-agnostic** (strips the keeper, then fails on any surviving `mariany` substring at any escaping depth) and covers **every** person-ref column (board_people, board_admins, boards.owner_person_id, tasks.*, archive.*, task_history.*, child_board_registrations, subtask_requests, attachment_audit_log, meeting_external_participants, people), rolling back rather than reporting a false success. The hand-written post-check above is a redundant spot-check on the four highest-volume columns only — convenient, not exhaustive; trust the script's scan, not it. The same run also DETECTS and flags 6b + 6c (it does not auto-fix them).

### 6a.1. Welcome Check re-homing — scan migrated boards (EX-016)

V2 sends the first-interaction welcome HOST-EAGERLY at provisioning for NEW boards and the migrator STRIPS the v1 agent-prompt `## Welcome Check` from migrated boards. Already-welcomed boards (`welcome_sent = 1`) need nothing; the only edge is a board whose v1 welcome FAILED (`welcome_sent` still `0`) and then migrated — it is welcomed by neither path. Scan + manually welcome any survivors (expected: none / a handful). Non-blocking for the canary.

```bash
pnpm exec tsx scripts/q.ts data/taskflow/taskflow.db "SELECT board_id FROM board_runtime_config WHERE welcome_sent = 0"   # expect empty
```

For each row returned, send a brief welcome from that board's chat (or set `welcome_sent = 1` if the board is intentionally silent).

### 6b. Sanunciel orphan re-provision — manual, live agent (EX-014)

`person_id=sanunciel` ("Estagiário Computação") is registered on `board-seci-taskflow` but owns no child board; his 2 tasks (`P16.1`, `P16.2`) sit on the parent with `child_exec_enabled=0`. **SQL cannot create his board** (it needs a real WhatsApp group). Post-cutover, from the **SECI board chat**, ask the agent to provision his child board — you must supply his **division/sigla** (the board is named after the division, never the person). Once it exists, delegate `P16.1`/`P16.2` to it via the agent's reassign / child-exec flow. Verify:

```bash
pnpm exec tsx scripts/q.ts data/taskflow/taskflow.db "SELECT id FROM boards WHERE owner_person_id='sanunciel'"   # expect 1 row
```

### 6c. Hudson duplicate-board cluster — operator decision

Hudson owns THREE boards under `board-thiago-taskflow`:

| board | group_jid | tasks | registered? |
|---|---|---|---|
| `board-po-setd-secti-taskflow-2` | …888254 | **1** | **YES** (canonical per `child_board_registrations`) |
| `board-po-setd-secti-taskflow` | …448705 | 0 | no |
| `board-hudson-taskflow` | …541463 | 0 | no (orphan from a claimed v1 teardown) |

The registered + populated board is the `…-2`. **Recommended:** keep `…-2`; archive/remove the two empty boards and abandon their WhatsApp groups. If you want the clean name, after removing the empty `po-setd-secti-taskflow` you can rename `…-2`'s folder/group (a separate per-board rename). Three real WhatsApp groups exist, so do this **via the agent / `ncl`, not raw SQL**, so the groups are handled — this is a judgment call, not a scripted fix.
- Scope: this was a step-level dry run against disposable paths. It did not stop the active host service, install/start the v2 service, or execute a live answer smoke; those checks happen during the cutover switchover and canary.
