# v1 Daily-Auditor Self-Correction Extensions

Adds two missing self-correction patterns to the v1 daily auditor
(`container/agent-runner/src/auditor-script.sh` + `auditor-prompt.txt` on
the prod host). The patch is **fork-private staging** here in
`.claude/skills/`; the operator copies the patched files to prod when
ready and restarts agents to pick them up.

## What's covered today (prod baseline, unchanged by this patch)

The shipped v1 monitor already detects **date-field self-correction
pairs** — same `task_id` / same `by` / <60 min, both `updated` rows
with `Reunião reagendada` or `Prazo definido` in `details`. The agent
classifies each pair as 🔴 bot error vs ⚪ legitimate iteration via
`auditor-prompt.txt` rule #9.

## What this patch adds

Two new pattern families, both fed into the same `selfCorrections`
payload field with a new `pattern` discriminator:

| Pattern | SQL signature | Bot-error meaning |
|---|---|---|
| `reassign_round_trip` | `action='reassigned'` × 2, same user, `a.to=b.from AND a.from=b.to` within 60 min | Bot picked the wrong assignee (magnetism / homonym); user reverted |
| `conclude_reopen` | `action='conclude'` then `action='reopen'`, same user, within 60 min | Bot concluded too early (terse misread / wrong target); same user reopened |

The agent classification rules in the patched `auditor-prompt.txt`
distinguish these from legitimate iteration patterns.

Existing `date_field_correction` rows now also carry
`pattern: 'date_field_correction'` so all three patterns share one
payload shape; legacy consumers reading `selfCorrections` without
looking at `pattern` continue to work (the field is additive).

## Files

```
baseline/             ← prod canonical as of 2026-05-13 (for diffing)
  auditor-script.sh
  auditor-prompt.txt

patched/              ← apply these on top of prod
  auditor-script.sh
  auditor-prompt.txt

PATCH-auditor-script.diff   ← unified diff against baseline
PATCH-auditor-prompt.diff
```

The two `PATCH-*.diff` files apply cleanly with `patch -p0` against a
fresh copy of `baseline/`. Verified locally (round-trip diff produces
zero delta against `patched/`).

## Verification done before staging

- `node --check` on the JS body extracted from the patched script:
  parses clean (1,556 lines, no syntax errors).
- New SQL runs against the live prod-cloned `data/taskflow/taskflow.db`
  and produces the expected hits:
  - `reassign_round_trip`: P8 (giovanni, 2026-04-07 → +3.1 min) and
    P22.1 (mariany, 2026-04-23 → +2.3 min) on `board-seci-taskflow`.
  - `conclude_reopen`: T9 (laizys, 2026-04-17 → +48.3 min) on
    `board-laizys-taskflow`.
- All three previously-known findings from the host-side daily monitor
  (`scripts/audit-v1-bugs.ts`) are surfaced by the patched v1 auditor.

## Deploy

The auditor script lives next to the agent-runner source on prod:

```
nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-script.sh
nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-prompt.txt
```

Each agent container also carries a per-board copy at
`data/sessions/<board>/agent-runner-src/auditor-script.sh`. **Important
caveat from the 2026-05-13 deploy**: `auditor-script.sh` and
`auditor-prompt.txt` are NOT in the host's `CORE_AGENT_RUNNER_FILES`
allowlist (`src/container-runner.ts:85`), so they are not refreshed by
`syncCoreAgentRunnerFiles` on container respawn. The first-time
`fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true })`
only fires when the per-board dir does not yet exist — which never
fires again after the initial board provision. Without explicit
fix-up, the per-board copies stay frozen at whatever auditor version
was canonical when the board was first provisioned.

So the deploy needs **two steps**: update canonical AND fan out to
the 33 per-board copies.

Recommended sequence (run from a workstation that has SSH key auth to
the prod box):

```bash
# 1) Back up the prod canonical copies
ssh nanoclaw@192.168.2.63 'cp /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-script.sh{,.pre-self-correction-extensions-$(date +%Y%m%d)}'
ssh nanoclaw@192.168.2.63 'cp /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-prompt.txt{,.pre-self-correction-extensions-$(date +%Y%m%d)}'

# 2) Copy the patched files
scp .claude/skills/add-taskflow/v1-auditor-extensions/patched/auditor-script.sh \
    nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/container/agent-runner/src/
scp .claude/skills/add-taskflow/v1-auditor-extensions/patched/auditor-prompt.txt \
    nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/container/agent-runner/src/

# 3) (Optional) Verify the JS body still parses on the prod side
ssh nanoclaw@192.168.2.63 'sed -n "/^cat > \/tmp\/auditor.js/,/^SCRIPT_EOF/p" /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-script.sh | sed "1d;\$d" | node --check'

# 4) Fan out the canonical to each per-board copy (CORE_AGENT_RUNNER_FILES
#    does NOT cover auditor-script.sh / auditor-prompt.txt — see
#    src/container-runner.ts:85 — so we manually rsync).
ssh nanoclaw@192.168.2.63 '
  for d in /home/nanoclaw/nanoclaw/data/sessions/*/agent-runner-src; do
    [ -d "$d" ] || continue
    cp /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-script.sh "$d/auditor-script.sh"
    cp /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-prompt.txt "$d/auditor-prompt.txt"
  done
'

# 5) **CRITICAL** — update the `auditor-daily` scheduled task's `prompt`
#    column. The auditor task fires daily at 04:00 BR via a row in
#    `store/messages.db` `scheduled_tasks`. The row's `script` column
#    is a wrapper (`bash /workspace/project/container/agent-runner/src/auditor-script.sh`)
#    that reads the canonical script from disk at runtime — so step 2
#    is enough for script changes. BUT the row's `prompt` column is the
#    LLM-side classifier prompt, stored as text at task-creation time
#    and READ from the row by the host scheduler — NOT from
#    `auditor-prompt.txt` on disk. Step 2 alone leaves the prompt
#    stale. Missed this on the 2026-05-13 deploy; caught by Codex
#    review. Fix:
ssh nanoclaw@192.168.2.63 '
  DB=/home/nanoclaw/nanoclaw/store/messages.db
  CANON=/home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-prompt.txt
  # Back up current prompt before overwrite (in case rollback is needed)
  sqlite3 "$DB" "SELECT prompt FROM scheduled_tasks WHERE id = '\''auditor-daily'\''" \
    > /tmp/auditor-daily-prompt.pre-deploy-$(date +%Y%m%dT%H%M%SZ).bak
  # Update with the patched canonical
  sqlite3 "$DB" "UPDATE scheduled_tasks SET prompt = readfile('\''$CANON'\'') WHERE id = '\''auditor-daily'\''"
  # Verify byte counts match
  echo "row length: $(sqlite3 "$DB" "SELECT length(prompt) FROM scheduled_tasks WHERE id = '\''auditor-daily'\''")"
  echo "file length: $(wc -c < "$CANON")"
'

# 6) Restart the host service so any in-flight container that holds the
#    auditor script open gets the new version on its next fire. The
#    auditor itself is run fresh on each scheduled wake (`node /tmp/auditor.js`
#    after a heredoc-extract), so this is belt-and-braces — typically not
#    strictly required after step 4.
ssh nanoclaw@192.168.2.63 'systemctl --user restart nanoclaw'

# 6) Verify (all 33 per-board copies should hash-match the canonical):
ssh nanoclaw@192.168.2.63 '
  CANON=$(md5sum /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-script.sh | cut -d" " -f1)
  for d in /home/nanoclaw/nanoclaw/data/sessions/*/agent-runner-src; do
    [ -d "$d" ] || continue
    [ "$(md5sum "$d/auditor-script.sh" | cut -d" " -f1)" = "$CANON" ] || echo "LAGGING: $d"
  done
  echo "(no LAGGING lines = clean)"
'
```

The auditor task runs daily inside each agent container at the existing
scheduled cadence — no separate timer install needed. The next daily
fire produces the extended audit; the agent will see `pattern` on each
`selfCorrections` row and apply the new classification rules in
`auditor-prompt.txt`.

## Rollback

If the patch causes any issue, restore from the dated `.pre-*` backup
created in step 1:

```bash
ssh nanoclaw@192.168.2.63 '
  # 1. Restore canonical files from dated backup
  cp /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-script.sh.pre-self-correction-extensions-YYYYMMDD \
     /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-script.sh
  cp /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-prompt.txt.pre-self-correction-extensions-YYYYMMDD \
     /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-prompt.txt
  # 2. Fan canonical out to all per-board copies
  for d in /home/nanoclaw/nanoclaw/data/sessions/*/agent-runner-src; do
    [ -d "$d" ] || continue
    cp /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-script.sh "$d/"
    cp /home/nanoclaw/nanoclaw/container/agent-runner/src/auditor-prompt.txt "$d/"
  done
  # 3. Revert the auditor-daily scheduled task prompt to the backed-up version
  DB=/home/nanoclaw/nanoclaw/store/messages.db
  sqlite3 "$DB" "UPDATE scheduled_tasks SET prompt = readfile(\"/tmp/auditor-daily-prompt.pre-deploy-YYYYMMDDTHHMMSSZ.bak\") WHERE id = \"auditor-daily\""
  # 4. Restart host service
  systemctl --user restart nanoclaw
'
```

The patch is purely additive (new SQL, new pattern field, new
classification branches in the prompt) so a rollback only removes the
new signal — it doesn't regress the existing date-correction
detection.

## Retirement plan

This patch is **throwaway code by design**. The v2 audit equivalent is
already shipped in the migration branch via the
`mcp__nanoclaw__api_query({ query: 'audit_v1_bugs' })` MCP tool, which
covers all three patterns natively and runs inside the v2 agent-runner.
When v2 cuts over, the v1 auditor is retired; this patch is retired
with it.
