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

- Stop v1 when prompted — the script now stops it before copying ANY live state (the pre-copy gate runs ahead of `1d-sessions`, not just before `taskflow.db`), and refuses up front (`abort "v1-live-manual"`) if a non-service / nohup-launched v1 is still alive via its PID file. A hard failure in `1d-sessions` / `1e-tasks` now restores v1 and aborts (it no longer continues to cutover with v1 down).
- Do not proceed if the script reports uncheckpointed WAL frames.
- Do not proceed if both user and system `nanoclaw` units are installed or active.
- Confirm the `1c-groups` step reports migrated prompts. The migration writes v2 `CLAUDE.local.md` files through `src/modules/taskflow/migrate-board-claudemd.ts`; it must not copy raw v1 `CLAUDE.md` prose unchanged.
- Accept the v2 switchover only after the script reports successful DB, group, session, scheduled task, TaskFlow DB, and container build steps.

## OneCLI Agent Secret-Mode Flip — REQUIRED before v2 can answer

The v2 container authenticates to Anthropic **only** through the OneCLI gateway — no token in `.env` reaches the container (`container-runner.ts` passes no Anthropic auth env; `agent-runner` runs the SDK with `env:{...process.env}`). The gateway injects `CLAUDE_CODE_OAUTH_TOKEN=placeholder` into the container, the bundled `claude` CLI emits `Authorization: Bearer placeholder`, and the gateway **rewrites** that header with the real vaulted token on the wire. The gateway injects that placeholder **only once the agent has the Anthropic secret effectively assigned** (verified live: an unprovisioned/selective agent's `/api/container-config` returns an empty env — no placeholder, no Bearer header → `401` on every model call).

Auto-created agents start in `selective` secret-mode with **no secrets assigned** (`container-runner.ts` → `onecli.ensureAgent` → `POST /api/agents`). The agent does not exist until the first container spawn, so the flip itself is inherently post-spawn — but you can pre-stage the *intent* with the host knob below, which flips each agent automatically the moment it is created. A board whose agent has not been flipped will silently `401` instead of answering.

**Precondition — the Anthropic credential must already be in the vault.** The migration's `3c-auth` step only *checks*; it does not create the secret. Seed it during OneCLI setup (from the v1 `CLAUDE_CODE_OAUTH_TOKEN`):

```bash
onecli secrets create --name Anthropic --type anthropic --value <token> --host-pattern api.anthropic.com   # one-time, if not already seeded
onecli secrets list | grep -i anthropic   # confirm the secret exists before flipping any agent
```

### Preferred — automated flip (set once, covers every board)

Set the host knob **before** cutover; the host then flips each agent to that mode on its first spawn (the moment the agent is created), so you never have to chase per-board flips:

```bash
grep -q '^NANOCLAW_ONECLI_AUTO_SECRET_MODE=' .env \
  && sed -i.bak 's/^NANOCLAW_ONECLI_AUTO_SECRET_MODE=.*/NANOCLAW_ONECLI_AUTO_SECRET_MODE=all/' .env && rm -f .env.bak \
  || echo 'NANOCLAW_ONECLI_AUTO_SECRET_MODE=all' >> .env
```

Mechanics + guarantees (`src/container-runner.ts` `ensureAgentSecretMode`): the host issues `PATCH /api/agents/<id>/secret-mode` with its own `ONECLI_API_KEY` (no CLI binary / `$PATH` / `~/.onecli` profile dependency). It is **fail-soft + retry** — a transient gateway error never blocks the spawn and is re-attempted on the next spawn, so a blip can't permanently strand a board at `401`; concurrent first-spawns of the same agent share one PATCH; once a flip succeeds it is skipped on every later spawn (off the hot path). Default unset = feature off (no behavior change). Valid values: `all` | `selective`. Watch `logs/nanoclaw.log` for `OneCLI agent secret-mode auto-flipped` (success) or `auto-flip failed; will retry` (transient).

### Fallback / verification — manual flip

If the knob is unset, or to confirm/repair a specific board, flip by hand. **Run AFTER a board's first message reaches v2** (that message spawns the container which creates the OneCLI agent), and BEFORE counting that board's canary samples — a `401`'d message is not a valid canary sample.

```bash
# 1. Find the agent (identifier == the agent_group id):
onecli agents list
# 2. Flip it to `all` so every vault secret with a matching host-pattern is injected:
onecli agents set-secret-mode --id <agent-id> --mode all
#    (narrower alternative — stay selective but assign only the Anthropic secret:
#       onecli secrets list                                          # find the Anthropic secret id
#       onecli agents set-secrets --id <agent-id> --secret-ids <anthropic-secret-id> )
# 3. Verify the secret is now visible to the agent:
onecli agents secrets --id <agent-id>      # the Anthropic secret must appear
```

**No container restart is needed** — the gateway resolves secrets per request, so the *next* model call from the running container picks up the credential. Re-send a board message; if it still `401`s, re-check `onecli agents secrets --id <agent-id>`.

**One OneCLI agent is created per migrated board/agent_group**, each `selective` by default on its first spawn. Flip each agent as its board enters the canary (or list all agents with `onecli agents list` and flip each to `all` up front, once each board has been messaged once so its agent exists). Do not declare a board canary-ready until its agent shows the Anthropic secret.

## TaskFlow Dashboard (tf-mcontrol) — coexistence invariants

Only relevant if the tf-mcontrol dashboard is deployed against this v2 install (it runs the engine as an MCP subprocess against the **same** `taskflow.db` the containers use). Skip this section if no dashboard is deployed. These requirements come from the R1–R5 + #396 + SEC engine work (coordination: `.claude/skills/add-taskflow/docs/2026-06-11-OUTBOUND-to-tf-mcontrol-R1-R5-status.md`).

**Deploy ORDER — engine source first, then tf, then verify env:**

1. **Deploy the current engine source tree and run `bun install` in `container/agent-runner/`.** tf-mcontrol runs the MCP subprocess from source, not from `dist/taskflow-mcp-server.js`: the live contract is `TASKFLOW_MCP_RUNTIME` + `TASKFLOW_MCP_SERVER_BIN` pointing at `container/agent-runner/src/mcp-tools/taskflow-server-entry.ts`. The old Node/`better-sqlite3` dist hand-port is retired; delete stale `dist/taskflow-mcp-server.js` copies from `.61`/`.63` during cutover so a legacy env value cannot resurrect it.
2. **Deploy/restart tf-mcontrol** (it spawns the engine subprocess from the freshly deployed source).
3. **Verify the subprocess/env/DB invariants** (each is a silent or loud failure if wrong):
   - `TASKFLOW_MCP_RUNTIME=bun` — the tf default is `node`, which is the wrong runtime for the source entrypoint.
   - `TASKFLOW_MCP_SERVER_BIN=<deploy-root>/container/agent-runner/src/mcp-tools/taskflow-server-entry.ts` — the tf default is empty, so an unset value cannot start the subprocess.
   - `TASKFLOW_SERVICE_OUTBOUND_DB` set on the tf subprocess — without it, dashboard-originated resolved-JID notifications (reassign/create DMs, parent rollups) stay in the JSON response and are **not** delivered (R3 fail-mode-b, no double-send).
   - `TASKFLOW_DB_PATH` = the shared nanoclaw global `taskflow.db` (`<DATA_DIR>/taskflow/taskflow.db`, the file containers mount at `/workspace/taskflow/`). If it points elsewhere, dashboard mutations hit a phantom DB (immediately obvious) **and** offline-assignee deferreds (#396) are stranded.
   - The shared `taskflow.db` is `journal_mode=DELETE`, **never WAL** (WAL's `-shm` mmap isn't coherent across the host/container mount). A Python WAL connection that pins the shared file makes the engine subprocess `PRAGMA journal_mode=DELETE` throw `SQLITE_BUSY` → the subprocess can't open the DB → all dashboard mutations fail loud (so this can't silently corrupt only deferreds).

**Cross-repo behavior to confirm with the dashboard build before cutover** (see the OUTBOUND addendums): the dashboard's parented-create route gates **manager-or-assignee-of-parent** (matches the engine R4 gate, addendum 6); it has **retired** its dead `deferred_notification` tasks-IPC emit now that the engine delivers dashboard deferreds via the shared queue (#396, addendum 5); and it does **not** also deliver `direct_message`/`parent_notification` (the engine owns those via the service bus, R3).

**Post-cutover, dashboard-specific:** actual WhatsApp phone-arrival of dashboard-originated notifications is only verifiable on the WhatsApp-linked prod env — confirm a dashboard reassign DM and an offline-assignee (provisioning-window) deferred each arrive on a real phone during the canary.

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

### 6d. Motivational-only scheduled-post refresh for DEPLOYED boards — surgical patcher (built)

The scheduled-post import (commits `06a268ac`/`774f0cef`/`03076f59`/`6b971d09`) has two halves with different rollout properties:

- **Holiday-skip** — *no per-board action.* It lives entirely in the host sweep + container warm-gate (`runner-gate-apply.ts`), reads `board_holidays` (which travels with `taskflow.db` in the migration copy), and honors `TASKFLOW_HOLIDAY_EXEMPT` (host env, forwarded into the container). Nothing to repatch; it's live for every board the moment v2 runs.
- **Motivational-only content** — *new boards: automatic; deployed boards: a real gap.* The behavior ("scheduled `[TF-*]` runs send only the motivational narrative, never the rendered board/report") is in `templates/CLAUDE.md.template` → `renderBoardClaudeMd`, which only writes `groups/<folder>/CLAUDE.local.md` at **new provision**. Boards provisioned before this change keep the old metrics-form digest until refreshed.

**Why you can't just re-render the deployed boards:** a full `migrate-board-claudemd` re-render would clobber the agent's free-text memory appended to the same `CLAUDE.local.md` — this is exactly why `repatch-deployed-claudemd.ts` applies *only* the surgical `patchRelayProse` (#404), never the full patcher (Codex reverted the full-patcher runner for this). The motivational refresh needs the same surgical treatment.

**Decision: option 1 — built.** `src/modules/taskflow/repatch-motivational.ts` is the V2 surgical patcher (mirrors `patchRelayProse`). It is **safe by construction**: exact multi-sentence span swaps (never blanket token renames, so it can't touch free-text memory); **vintage-preserving** (report-call edits capture and echo `(taskflow|api)_report`, never reintroducing the wrong tool name); **multi-variant** (recognizes both known deployed wordings); **idempotent** (re-running a converted board is a no-op); and **all-or-nothing per board** (any unmatched span → the board is left untouched and flagged `needs_manual`, never half-converted).

```bash
# 1. DRY-RUN first — review the per-board outcome (patched/would-patch/already/needs_manual).
pnpm exec tsx src/modules/taskflow/repatch-motivational.ts groups 2>&1 | tee -a "$CUTOVER_LOG"
# 2. SPOT-CHECK a would-patch board's diff against a backup before writing (sanity on the real migrated files):
cp groups/<folder>/CLAUDE.local.md /tmp/<folder>.pre-motiv && \
  pnpm exec tsx src/modules/taskflow/repatch-motivational.ts groups --write >/dev/null && \
  diff /tmp/<folder>.pre-motiv groups/<folder>/CLAUDE.local.md   # expect ONLY scheduled-post-section changes, memory untouched
```

**`needs_manual` boards:** a board flagged `needs_manual` is of a wording vintage this runner doesn't recognize (or has hand-edited sections) — it is **never auto-written**. Either hand-edit it to motivational-only, or add its exact old spans as a new variant in `EDITS` (the table is built for this), then re-run the dry-run. Do NOT force it.

Verify after writing — a refreshed board contains the motivational-only marker and has dropped the old "separate motivational message" model:
```bash
grep -l "Scheduled posts are motivational-only" groups/*/CLAUDE.local.md          # converted boards
grep -L "Then send a separate motivational message" groups/*/CLAUDE.local.md       # old model gone
```

### 6e. WhatsApp anti-abuse pacing for bulk group creation (RC6) — operator control

**Why this is a runbook step and not code:** WhatsApp's anti-abuse heuristics log a number out after a burst of rapid group creations (in v1 this fired at roughly **6 rapid creations** and forced a full re-pair). A logout mid-cutover is the worst time to hit it — it halts ALL delivery and ALL further provisioning at once. This is a one-off cutover-day exposure (the steady state creates groups one-at-a-time as people self-onboard), so a permanent runtime rate-limiter would over-engineer a single event and throttle legitimate self-service forever. The control is **operator pacing**, by design.

**When it applies.** Any step or session that creates WhatsApp groups in quick succession:
- bulk board (re)provisioning at cutover (the main risk — many `provision_root_board` / `provision_child_board` in a row);
- the 6b Sanunciel re-provision and the 6c Hudson cleanup (each `create_group` / re-provision is a creation);
- any operator- or agent-driven burst of `provision_child_board` / `create_group`.

**The rule. Do not create more than ~5 WhatsApp groups in a rolling few-minute window.** Prefer **one at a time**: fire a single provision, confirm it landed (group created **and** the invite-link / confirmation message was delivered to the source chat) before starting the next, and leave a deliberate gap (tens of seconds, not milliseconds) between creations. If you must create many, batch ~5, then pause several minutes before the next batch. Sequence the known cutover creations (6b, 6c, any backlog) rather than firing them together.

**Detection — stop immediately if you see any of these:**
- `createGroup` starts failing with auth / `401` / logged-out errors, or delivery stops across all boards at once;
- the host log shows a WhatsApp connection drop / re-auth loop (`logs/nanoclaw.error.log`).

**Recovery (re-pair the bot number).** Pairing-code auth works from servers; QR returns error 515. Clear the stored creds first, then re-pair, then wait before resuming creations:
```bash
# 1. Stop creating groups. 2. Clear the stale session and re-pair (pairing-code method):
rm -f store/auth/creds.json
pnpm exec tsx src/whatsapp-auth-pairing.ts <bot-phone-number>   # wait for the first QR event before it prints the pairing code
# 3. Enter the code on the bot's WhatsApp. 4. Confirm the host reconnects (logs/nanoclaw.log), then resume — paced.
```
After recovery, resume the remaining creations **more slowly** (smaller batches, longer gaps) — a number that just tripped anti-abuse is more likely to trip again.

## Post-Migration Verification Gate (added 2026-06-13)

The checks above are negative gates (no legacy leaks, no residual `mariany`, integrity ok). They do NOT positively assert that the migrated data is *correct*. Run this gate AFTER all migration steps + the first v2 boot, BEFORE the canary, against the **migrated v2** DBs (`V2=data/v2.db`, `TF=data/taskflow/taskflow.db`). Each line below was verified GREEN in the 2026-06-13 sandbox dry run; the same query against the real cutover must give the analogous result.

```bash
V2=data/v2.db; TF=data/taskflow/taskflow.db
# Engage parity (v1 requires_trigger=0 → engage_pattern='.', else the trigger). Every
# registered group must have exactly one wiring; no group missing/duplicated.
pnpm exec tsx scripts/q.ts "$V2" "SELECT engage_mode, engage_pattern, COUNT(*) FROM messaging_group_agents GROUP BY 1,2"
pnpm exec tsx scripts/q.ts "$V2" "SELECT COUNT(*) agent_groups,(SELECT COUNT(*) FROM messaging_group_agents) wirings FROM agent_groups"   # wirings == agent_groups

# F3/F4 — per-board model + persona landed in container_configs (NOT the dead settings.json).
# total == agent_groups; persona == total; model == count of boards whose v1 settings.json set ANTHROPIC_MODEL.
pnpm exec tsx scripts/q.ts "$V2" "SELECT COUNT(*) total, SUM(assistant_name IS NOT NULL AND assistant_name!='') persona, SUM(model IS NOT NULL AND model!='') model FROM container_configs"

# F7 — paused v1 tasks carried DORMANT (status='paused', never auto-resumed); active→pending; terminal dropped.
for ib in $(find data/v2-sessions -name inbound.db); do pnpm exec tsx scripts/q.ts "$ib" "SELECT status, COUNT(*) FROM messages_in WHERE kind='task' GROUP BY status"; done   # expect only pending/paused

# Session continuity — continuation:claude set per session (resume the same v1 conversation).
for ob in $(find data/v2-sessions -name outbound.db); do pnpm exec tsx scripts/q.ts "$ob" "SELECT COUNT(*) FROM session_state WHERE key='continuation:claude'"; done   # each >=1 for a folder with v1 history

# Holiday travel — board_holidays copied 1:1 with the v1 backup (feeds the holiday-skip gate, 6d).
pnpm exec tsx scripts/q.ts "$TF" "SELECT COUNT(*) FROM board_holidays"   # == count in the v1 taskflow.db backup
```

**Destinations (F1/F2) — verify resolution, not just creation.** The migrate `1g-destinations` step + the per-boot `backfillTaskflowDestinations` self-heal translate v1 cross-board (`parent-`/`source-`) and per-person (`notification_group_jid`) forwarding into `agent_destinations`. A link is **only** resolvable once BOTH endpoint group folders exist as registered v2 agent_groups — so on a partial corpus (boards ≫ registered_groups) many stay unresolved and the step degrades (fail-soft, non-abort). That is expected, not a bug. The self-heal re-attempts every boot, so the count should grow as groups exist.

```bash
pnpm exec tsx scripts/q.ts "$V2" "SELECT COUNT(*) FROM agent_destinations"                 # resolved destinations
# All resolved destinations must point at a REAL messaging_group (0 dangling):
pnpm exec tsx scripts/q.ts "$V2" "SELECT COUNT(*) FROM agent_destinations d LEFT JOIN messaging_groups m ON m.id=d.target_id WHERE m.id IS NULL"   # expect 0
```
Re-check the resolved count after the first full v2 boot; if cross-board approval forwarding or per-person DMs are expected for a board whose link is still unresolved, confirm its counterpart group was actually migrated (an unresolved link is a missing-group symptom, not a resolver fault).

## Process note: do one live interactive pass on a throwaway box first

`migrate-v2.sh` has a hard TTY guard, so its full interactive path — `setup.sh` bootstrap, container image build, switchover prompts, and the `exec claude "/migrate-from-v1"` boundary — cannot be exercised headless. The 2026-06-13 validation covered the deterministic data steps + orchestration (Codex-reviewed) + 254 passing tests, but NOT that interactive end-to-end. Before flipping `.63`, run one full `bash migrate-v2.sh` on a throwaway box (scratch clone + a corpus snapshot, never `.63`/the live install) to shake out bootstrap/Docker/switchover before the real cutover.

## 2026-06-13 dry-run evidence (supersedes the 2026-05-29 section for current behavior)

Sandbox dry run on the real prod corpus (`VACUUM INTO` snapshot → `/tmp/v1-fixture`; steps run with CWD=`/tmp/v2-dryrun`, live `data/` untouched). Report: `.claude/skills/add-taskflow/docs/2026-06-13-migration-dryrun-gonogo.md` — **GO, zero BLOCKER/HIGH**. All steps exit 0: `db OK groups=10`, `groups configs=10`, `sessions created=10 files=2698`, `tasks migrated=26 paused=20`, `taskflow boards=34 tasks=384`, `destinations` degraded (33 cross + 5 person unresolved — partial-corpus, self-heal). Verified vs DB state + re-attacked by a 14-agent adversarial workflow: engage 8`'.'`/2-trigger; container_configs 3 models + 10 personas; `continuation:claude` authoritative (not mtime) on all 4 multi-JSONL folders; F7 6 pending + 20 paused-dormant; taskflow.db byte-identical + 252 holidays; 356/356 JSONLs byte-identical. (The 2026-05-29 section above predates F1–F7 + the F7 paused-task carry — its `active=117,migrated=117` line has no paused accounting.)
