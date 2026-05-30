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
- Confirm the `1c-groups` step reports migrated prompts. The migration writes v2 `CLAUDE.local.md` files through `scripts/migrate-board-claudemd.ts`; it must not copy raw v1 `CLAUDE.md` prose unchanged.
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
V2_SERVICE=$(pnpm exec tsx -e "import{getSystemdUnit}from'./src/install-slug.js';console.log(getSystemdUnit())")
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
4. If v2 accepted production mutations, export the changed `tasks`, `task_history`, `board_chat`, `task_notes`, and `archive` rows for operator review before restarting v1.

Message/channel/session reconciliation:

1. Keep the pre-cutover `store/messages.db` backup immutable.
2. Before restarting v1, inspect v2 `store/messages.db` for inbound rows consumed after cutover and outbound rows already delivered.
3. If rollback happens after any v2 reply was delivered, do not blindly copy v2 `store/messages.db` over v1. Export the cutover-window `messages_in`, `messages_out`, `sessions`, and delivery status rows for operator review.
4. Clear or move aside v2-only container/session state before restarting v1 so v1 does not inherit v2 session assumptions.

Minimum post-rollback checks:

```bash
systemctl is-active nanoclaw
sqlite3 data/taskflow/taskflow.db "PRAGMA integrity_check;"
sqlite3 store/messages.db "PRAGMA integrity_check;"
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
- Scope: this was a step-level dry run against disposable paths. It did not stop the active host service, install/start the v2 service, or execute a live answer smoke; those checks happen during the cutover switchover and canary.
