#!/usr/bin/env bash
#
# migrate-v2.sh — Migrate a NanoClaw v1 install into this v2 checkout.
#
# Run from the v2 directory:
#   bash migrate-v2.sh
#
# If you're in Claude Code, exit first or open a separate terminal.
#
# Finds v1 automatically (sibling directory, or $NANOCLAW_V1_PATH).
# Installs prerequisites (Node, pnpm, deps) via the existing setup.sh
# bootstrap, then runs the migration steps.
#
# Idempotent — safe to re-run. Use migrate-v2-reset.sh to wipe v2 state
# back to clean for development iteration.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# This script has interactive prompts (channel selection, service switchover)
# and streams progress output — it must run in a real terminal, not inside
# a tool subprocess (e.g. Claude Code's Bash tool, which collapses output).
if ! [ -t 0 ] || ! [ -t 1 ]; then
  echo "This script requires an interactive terminal."
  echo ""
  echo "If you're in Claude Code, exit first or open a separate terminal,"
  echo "then run:"
  echo "  bash migrate-v2.sh"
  echo ""
  exit 1
fi

LOGS_DIR="$PROJECT_ROOT/logs"
STEPS_DIR="$LOGS_DIR/migrate-steps"
MIGRATE_LOG="$LOGS_DIR/migrate-v2.log"

# Defaults for variables that may not be set if we exit early
V1_PATH=""
V1_VERSION="unknown"
ONECLI_OK=false
SERVICE_SWITCHED=false
SELECTED_CHANNELS=()
ABORTED_AT=""
# Set to true by any rollback / sudo-failure / mv-failure path so the
# final summary can surface a degraded outcome instead of green-✓ everywhere.
MIGRATION_DEGRADED=false
MIGRATION_DEGRADED_REASONS=()
# Flip to true only after migrate-v2.sh has stopped v1 itself (pre-1f gate,
# or the late switchover re-stop). Any unexpected exit while this is true
# means v1 is down with no replacement — the EXIT trap must restore it.
V1_STOPPED_BY_MIGRATION=false
# Set to true by rollback_to_v1_no_v2 so the EXIT trap doesn't double-run
# a rollback that an explicit abort path already performed.
ROLLBACK_DONE=false

# Per-step status tracking. Parallel indexed arrays so this works on
# bash 3.2 (macOS default) which has no associative arrays.
STEP_NAMES=()
STEP_STATUSES=()

record_step() {
  STEP_NAMES+=("$1")
  STEP_STATUSES+=("$2")
}

# Write handoff.json on any exit so the skill can always read it
write_handoff() {
  local handoff_dir="$LOGS_DIR/setup-migration"
  mkdir -p "$handoff_dir"

  local has_failures=false
  local i
  for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
    [ "${STEP_STATUSES[$i]}" = "failed" ] && has_failures=true
  done

  local overall="success"
  $has_failures && overall="partial"
  [ -n "$ABORTED_AT" ] && overall="failed"
  # MIGRATION_DEGRADED is set by rollback / sudo / mv failure paths that
  # don't necessarily fail a recorded step. Surface it so the skill can
  # always recover the reasons (the final summary may not have printed
  # if the script aborted mid-stream).
  [ "$MIGRATION_DEGRADED" = "true" ] && [ "$overall" = "success" ] && overall="degraded"

  local steps_json="{"
  for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
    local n="${STEP_NAMES[$i]}"
    local s="${STEP_STATUSES[$i]}"
    steps_json="${steps_json}\"${n}\": {\"status\": \"${s}\", \"log\": \"logs/migrate-steps/${n}.log\"},"
  done
  steps_json="${steps_json%,}}"

  local reasons_json="["
  for ((i=0; i<${#MIGRATION_DEGRADED_REASONS[@]}; i++)); do
    # JSON-escape: backslash first, then double-quote. Reasons are operator-
    # facing strings authored by mark_degraded call sites — no control chars
    # expected in practice, so we stop at those two.
    local r="${MIGRATION_DEGRADED_REASONS[$i]}"
    r="${r//\\/\\\\}"
    r="${r//\"/\\\"}"
    reasons_json="${reasons_json}\"${r}\","
  done
  reasons_json="${reasons_json%,}]"

  cat > "$handoff_dir/handoff.json" <<HANDOFF_EOF
{
  "version": 1,
  "started_at": "$(ts_utc)",
  "v1_path": "$V1_PATH",
  "v1_version": "$V1_VERSION",
  "overall_status": "$overall",
  "aborted_at": "$ABORTED_AT",
  "source": "migrate-v2.sh",
  "channels_installed": [$(printf '"%s",' "${SELECTED_CHANNELS[@]}" 2>/dev/null | sed 's/,$//')],
  "onecli_healthy": $ONECLI_OK,
  "service_switched": $SERVICE_SWITCHED,
  "degraded": $MIGRATION_DEGRADED,
  "degraded_reasons": $reasons_json,
  "steps": $steps_json,
  "step_logs_dir": "logs/migrate-steps",
  "followups": [
    "Seed owner user and access policy",
    "Review CLAUDE.local.md files for v1-specific patterns",
    "Verify container.json mount paths are valid"
  ]
}
HANDOFF_EOF
}

cleanup_on_exit() {
  # If v1 was stopped by us and we never landed in a clean "v2 kept" or
  # "explicit rollback" state, restore v1 now. Catches signal-driven exits
  # (Ctrl-C, SIGTERM), set -u failures, or any code path that exits without
  # going through one of the rollback call sites — otherwise the operator is
  # stranded with v1 down and v2 not switched.
  if [ "$V1_STOPPED_BY_MIGRATION" = "true" ] \
     && [ "$SERVICE_SWITCHED" = "false" ] \
     && [ "$ROLLBACK_DONE" = "false" ]; then
    step_fail "Migration interrupted with v1 stopped — restoring v1"
    rollback_to_v1_no_v2
    mark_degraded "migration interrupted after v1 was stopped — v1 restored automatically; review logs/migrate-v2.log"
  fi
  write_handoff
}

trap cleanup_on_exit EXIT

abort() {
  ABORTED_AT="$1"
  log "ABORTED at $1"
  exit 1
}

# ─── output helpers ──────────────────────────────────────────────────────

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()      { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
green()    { use_ansi && printf '\033[32m%s\033[0m' "$1" || printf '%s' "$1"; }
red()      { use_ansi && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
bold()     { use_ansi && printf '\033[1m%s\033[0m' "$1" || printf '%s' "$1"; }
clear_line() { use_ansi && printf '\r\033[2K' || printf '\n'; }

step_ok()   { printf '%s  %s\n' "$(green '✓')" "$1"; }
step_fail() { printf '%s  %s\n' "$(red '✗')"   "$1"; }
step_skip() { printf '%s  %s\n' "$(dim '–')"   "$1"; }
step_info() { printf '%s  %s\n' "$(dim '·')"   "$1"; }

ts_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$MIGRATE_LOG"
}

# ─── init logs ───────────────────────────────────────────────────────────

mkdir -p "$STEPS_DIR"
{
  echo "## $(ts_utc) · migrate-v2.sh started"
  echo "  cwd: $PROJECT_ROOT"
  echo ""
} > "$MIGRATE_LOG"

echo
bold "NanoClaw v1 → v2 migration"
echo
echo

# ─── phase 0a: bootstrap prerequisites ──────────────────────────────────

step_info "Installing prerequisites (Node, pnpm, dependencies)…"

BOOTSTRAP_RAW="$STEPS_DIR/01-bootstrap.log"
export NANOCLAW_BOOTSTRAP_LOG="$BOOTSTRAP_RAW"

if bash "$PROJECT_ROOT/setup.sh" > "$BOOTSTRAP_RAW" 2>&1; then
  # Parse the status block from setup.sh output
  STATUS=$(grep '^STATUS:' "$BOOTSTRAP_RAW" | head -1 | sed 's/^STATUS: *//')
  NODE_VERSION=$(grep '^NODE_VERSION:' "$BOOTSTRAP_RAW" | head -1 | sed 's/^NODE_VERSION: *//')

  if [ "$STATUS" = "success" ]; then
    step_ok "Prerequisites ready $(dim "(node $NODE_VERSION)")"
    log "Bootstrap succeeded: node=$NODE_VERSION"
  else
    step_fail "Bootstrap reported: $STATUS"
    echo
    dim "  See: $BOOTSTRAP_RAW"
    echo
    abort "bootstrap"
  fi
else
  step_fail "Bootstrap failed"
  echo
  echo "$(dim '── last 20 lines ──')"
  tail -20 "$BOOTSTRAP_RAW" 2>/dev/null || true
  echo
  dim "  Full log: $BOOTSTRAP_RAW"
  echo
  abort "bootstrap"
fi

# setup.sh may have installed pnpm to a prefix not on our PATH — replay
# the same lookup nanoclaw.sh does.
if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/pnpm" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  step_fail "pnpm not found after bootstrap"
  abort "pnpm-missing"
fi

# ─── phase 0b: find v1 install ──────────────────────────────────────────

find_v1() {
  # Explicit override
  if [ -n "${NANOCLAW_V1_PATH:-}" ]; then
    if [ -f "$NANOCLAW_V1_PATH/store/messages.db" ]; then
      echo "$NANOCLAW_V1_PATH"
      return 0
    fi
    step_fail "NANOCLAW_V1_PATH=$NANOCLAW_V1_PATH does not contain store/messages.db"
    return 1
  fi

  # Scan sibling directories for anything claw-ish with a v1 DB
  local parent
  parent="$(dirname "$PROJECT_ROOT")"
  for entry in "$parent"/*/; do
    [ -d "$entry" ] || continue
    # Skip ourselves
    [ "$(cd "$entry" && pwd)" = "$PROJECT_ROOT" ] && continue
    # Must have the v1 DB
    [ -f "$entry/store/messages.db" ] || continue
    # Must not be v2 (check package.json version)
    if [ -f "$entry/package.json" ]; then
      local ver
      ver=$(grep '"version"' "$entry/package.json" 2>/dev/null | head -1 | sed -E 's/.*"([0-9]+)\..*/\1/')
      [ "$ver" = "2" ] && continue
    fi
    echo "$(cd "$entry" && pwd)"
    return 0
  done

  return 1
}

V1_PATH=""
if V1_PATH=$(find_v1); then
  V1_VERSION=$(grep '"version"' "$V1_PATH/package.json" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || echo "unknown")
  step_ok "Found v1 at $(dim "$V1_PATH") $(dim "(v$V1_VERSION)")"
  log "v1 found: $V1_PATH (v$V1_VERSION)"
else
  step_fail "No v1 install found"
  echo
  echo "  $(dim 'Set NANOCLAW_V1_PATH to point at your v1 checkout:')"
  echo "  $(dim 'NANOCLAW_V1_PATH=~/nanoclaw bash migrate-v2.sh')"
  echo
  abort "v1-not-found"
fi

# ─── phase 0c: validate v1 DB ───────────────────────────────────────────

V1_DB="$V1_PATH/store/messages.db"

# Quick schema check — make sure the tables we need exist.
# Uses the in-tree wrapper instead of the sqlite3 CLI: setup.sh (run via
# phase 0a above) installs Node + better-sqlite3 but NOT the sqlite3 CLI,
# and #2191 documented how a missing CLI here used to surface as a
# misleading "registered_groups missing" abort.
TABLES=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT name FROM sqlite_master WHERE type='table'" 2>/dev/null || true)

if echo "$TABLES" | grep -q "registered_groups"; then
  step_ok "v1 database has registered_groups"
else
  step_fail "v1 database missing registered_groups table"
  abort "v1-db-invalid"
fi

# Show what we found
GROUP_COUNT=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT COUNT(*) FROM registered_groups" 2>/dev/null || echo 0)
TASK_COUNT=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT COUNT(*) FROM scheduled_tasks WHERE status='active'" 2>/dev/null || echo 0)
ENV_KEYS=0
if [ -f "$V1_PATH/.env" ]; then
  ENV_KEYS=$(grep -c '=' "$V1_PATH/.env" 2>/dev/null || echo 0)
fi

step_info "v1 state: $(bold "$GROUP_COUNT") groups, $(bold "$TASK_COUNT") active tasks, $(bold "$ENV_KEYS") env keys"

echo
step_ok "Phase 0 complete — ready to migrate"
echo
log "Phase 0 complete: groups=$GROUP_COUNT tasks=$TASK_COUNT env_keys=$ENV_KEYS"

export NANOCLAW_V1_PATH="$V1_PATH"
export NANOCLAW_V2_PATH="$PROJECT_ROOT"

# ─── run_step helper ─────────────────────────────────────────────────────
# Runs a TypeScript migration step, captures output, reports success/failure.

# Step outcomes are tracked via record_step() into STEP_NAMES/STEP_STATUSES
# (defined above, near write_handoff).

run_step() {
  local name=$1 label=$2 script=$3
  shift 3
  local raw="$STEPS_DIR/${name}.log"

  if pnpm exec tsx "$script" "$@" > "$raw" 2>&1; then
    local result
    result=$(grep '^OK:' "$raw" | head -1 || true)
    step_ok "$label $(dim "$result")"
    log "$name: $result"
    record_step "$name" "success"
    # Surface partial errors (rows skipped due to parse/lookup failures)
    # even when the step exited successfully — they're easy to miss in the
    # raw log and have caused silent migrations before. Promote the recorded
    # status from "success" to "partial" and mark the run degraded so the
    # final summary + handoff.json reflect the non-fatal errors.
    if grep -q '^ERROR:' "$raw" 2>/dev/null; then
      local err_count
      err_count=$(grep -c '^ERROR:' "$raw")
      echo "  $(dim "${err_count} error(s) reported — see $raw")"
      grep '^ERROR:' "$raw" | head -3 | while IFS= read -r line; do
        echo "  $(dim "$line")"
      done
      log "$name: ${err_count} non-fatal errors"
      STEP_STATUSES[${#STEP_STATUSES[@]}-1]="partial"
      mark_degraded "$name reported ${err_count} non-fatal error(s) — see logs/migrate-steps/${name}.log"
    fi
  elif grep -q '^SKIPPED:' "$raw" 2>/dev/null; then
    local reason
    reason=$(grep '^SKIPPED:' "$raw" | head -1 | sed 's/^SKIPPED://')
    step_skip "$label $(dim "($reason)")"
    log "$name: skipped ($reason)"
    record_step "$name" "skipped"
  else
    step_fail "$label"
    echo
    tail -10 "$raw" 2>/dev/null | while IFS= read -r line; do
      echo "  $(dim "$line")"
    done
    echo
    log "$name: FAILED (see $raw)"
    record_step "$name" "failed"
  fi
}

# ─── v1 service state (detected once, reused by 1f gate + switchover) ──
#
# Detect v1 service state ONCE at script start. The pre-1f-taskflow gate
# below needs v1 stopped (taskflow.ts refuses to copy against a live v1 to
# avoid WAL race + silent data loss), so we ask up front and keep that
# state through the rest of the migration. The late "Service switchover"
# block reads V1_WAS_RUNNING (not a re-detection) so it still knows to
# offer the v2 start prompt even though v1 is already down by then.

V1_SERVICE=""
V2_SERVICE=""
PLATFORM_SERVICE=""

if [ "$(uname -s)" = "Darwin" ]; then
  PLATFORM_SERVICE="launchd"
  V1_SERVICE="com.nanoclaw"
  V2_SERVICE=$(pnpm exec tsx -e "import{getLaunchdLabel}from'./src/install-slug.js';console.log(getLaunchdLabel())" 2>/dev/null || echo "")
elif [ "$(uname -s)" = "Linux" ]; then
  PLATFORM_SERVICE="systemd"
  V1_SERVICE="nanoclaw"
  V2_SERVICE=$(pnpm exec tsx -e "import{getSystemdUnit}from'./src/install-slug.js';console.log(getSystemdUnit())" 2>/dev/null || echo "")
fi

V1_WAS_RUNNING=false
V1_SYSTEMD_SCOPE=""
if [ "$PLATFORM_SERVICE" = "systemd" ]; then
  # Probe BOTH scopes — refusing to guess between them is safer than
  # short-circuiting on the first match. A misconfigured host with v1
  # installed under both scopes would otherwise have the system unit
  # silently kept writing during the 1f-taskflow copy (the bash gate
  # would say "stopped" but taskflow.ts's broader probe would detect
  # the still-running system unit).
  V1_USER_ACTIVE=false
  V1_SYSTEM_ACTIVE=false
  systemctl --user is-active "$V1_SERVICE" >/dev/null 2>&1 && V1_USER_ACTIVE=true
  systemctl is-active "$V1_SERVICE" >/dev/null 2>&1 && V1_SYSTEM_ACTIVE=true
  # Also probe INSTALLED scope (unit file present) — an inactive-but-enabled
  # system unit otherwise leaves V1_SYSTEMD_SCOPE empty, and disable_v1_service
  # silently falls through without disabling, letting v1 auto-start on reboot
  # and race v2.
  V1_USER_INSTALLED=false
  V1_SYSTEM_INSTALLED=false
  if [ -e "$HOME/.config/systemd/user/${V1_SERVICE}.service" ]; then
    V1_USER_INSTALLED=true
  fi
  if [ -e "/etc/systemd/system/${V1_SERVICE}.service" ] \
     || [ -e "/usr/lib/systemd/system/${V1_SERVICE}.service" ] \
     || [ -e "/lib/systemd/system/${V1_SERVICE}.service" ]; then
    V1_SYSTEM_INSTALLED=true
  fi
  if [ "$V1_USER_ACTIVE" = "true" ] && [ "$V1_SYSTEM_ACTIVE" = "true" ]; then
    step_fail "v1 ($V1_SERVICE) is active under BOTH --user and system systemd scopes."
    echo "  $(dim 'Both scopes writing to v1 state simultaneously is misconfiguration')"
    echo "  $(dim 'and unsafe to migrate. Stop one before re-running migrate-v2.sh:')"
    echo
    echo "  $(dim '$') systemctl --user stop $V1_SERVICE   $(dim '# disable user unit')"
    echo "  $(dim '$') sudo systemctl stop $V1_SERVICE     $(dim '# disable system unit')"
    echo
    abort "v1-dual-scope-active"
  fi
  if [ "$V1_USER_INSTALLED" = "true" ] && [ "$V1_SYSTEM_INSTALLED" = "true" ]; then
    step_fail "v1 ($V1_SERVICE) is installed under BOTH --user and system systemd scopes."
    echo "  $(dim 'Even with one inactive, leaving both unit files in place means v1')"
    echo "  $(dim 'can auto-restart from the other scope on reboot and race v2. Remove')"
    echo "  $(dim 'or disable one before re-running migrate-v2.sh:')"
    echo
    echo "  $(dim '$') systemctl --user disable --now $V1_SERVICE"
    echo "  $(dim '$') sudo systemctl disable --now $V1_SERVICE"
    echo
    abort "v1-dual-scope-installed"
  fi
  # Determine scope: active wins, otherwise installed (so an inactive-but-
  # enabled unit is still routed through disable_v1_service correctly).
  if [ "$V1_USER_ACTIVE" = "true" ]; then
    V1_WAS_RUNNING=true
    V1_SYSTEMD_SCOPE="--user"
  elif [ "$V1_SYSTEM_ACTIVE" = "true" ]; then
    V1_WAS_RUNNING=true
    V1_SYSTEMD_SCOPE="system"
  elif [ "$V1_USER_INSTALLED" = "true" ]; then
    V1_SYSTEMD_SCOPE="--user"
  elif [ "$V1_SYSTEM_INSTALLED" = "true" ]; then
    V1_SYSTEMD_SCOPE="system"
  fi
elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
  launchctl list "$V1_SERVICE" >/dev/null 2>&1 && V1_WAS_RUNNING=true
fi

# Mark the migration as degraded with a one-line reason. Reasons appear
# verbatim in the final summary so the operator can grep for them.
mark_degraded() {
  MIGRATION_DEGRADED=true
  MIGRATION_DEGRADED_REASONS+=("$1")
}

# Restart v1 and move v2's copied taskflow.db aside. Used when:
#  - operator picks 'skip' at the late switchover prompt AFTER pre-1f stopped v1
#  - v2 service install fails after pre-1f stopped v1
#  - operator picks 'revert' after v2 was up briefly
# Sets MIGRATION_DEGRADED on any sub-step failure (sudo cache expired,
# mv failed) so the summary shows the operator needs to act manually.
rollback_to_v1_no_v2() {
  ROLLBACK_DONE=true
  if [ "$PLATFORM_SERVICE" = "systemd" ]; then
    if [ "$V1_SYSTEMD_SCOPE" = "system" ]; then
      if sudo -n systemctl start "$V1_SERVICE" 2>/dev/null; then
        step_ok "Restarted $V1_SERVICE"
      else
        step_fail "Could not restart $V1_SERVICE — run 'sudo systemctl start $V1_SERVICE' manually"
        mark_degraded "v1 service ($V1_SERVICE, system) not restarted — sudo cache expired; run 'sudo systemctl start $V1_SERVICE'"
      fi
    else
      if systemctl --user start "$V1_SERVICE" 2>/dev/null; then
        step_ok "Restarted $V1_SERVICE"
      else
        step_fail "Could not restart $V1_SERVICE"
        mark_degraded "v1 service ($V1_SERVICE, user) not restarted — run 'systemctl --user start $V1_SERVICE'"
      fi
    fi
  elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
    if launchctl load ~/Library/LaunchAgents/${V1_SERVICE}.plist 2>/dev/null; then
      step_ok "Restarted $V1_SERVICE"
    else
      step_fail "Could not restart $V1_SERVICE"
      mark_degraded "v1 service ($V1_SERVICE, launchd) not restarted — run 'launchctl load ~/Library/LaunchAgents/${V1_SERVICE}.plist'"
    fi
  fi
  if [ -f "$PROJECT_ROOT/data/taskflow/taskflow.db" ]; then
    local aside_path="$PROJECT_ROOT/data/taskflow/taskflow.db.reverted-$(date +%s)"
    if mv "$PROJECT_ROOT/data/taskflow/taskflow.db" "$aside_path" 2>/dev/null; then
      step_ok "Moved v2 taskflow.db aside so a future rerun re-copies from v1"
    else
      step_fail "Could not move v2 taskflow.db aside — future migrate-v2.sh reruns will skip the TaskFlow copy"
      mark_degraded "stale v2 taskflow.db remains at data/taskflow/taskflow.db — remove manually before re-running migrate-v2.sh"
    fi
  fi
}

# Disable the v1 service so it doesn't auto-start, but leave the unit file
# on disk so the user can rollback. Honors V1_SYSTEMD_SCOPE so sudo-installed
# system units are disabled too — otherwise a sudo v1 install reboots back
# into existence and races v2. Returns 0 on success, 1 on failure so the
# caller can mark the migration degraded.
disable_v1_service() {
  if [ "$PLATFORM_SERVICE" = "systemd" ]; then
    if [ "$V1_SYSTEMD_SCOPE" = "system" ]; then
      local stop_ok=true disable_ok=true
      sudo -n systemctl stop "$V1_SERVICE" 2>/dev/null || stop_ok=false
      sudo -n systemctl disable "$V1_SERVICE" 2>/dev/null || disable_ok=false
      if [ "$stop_ok" = "true" ] && [ "$disable_ok" = "true" ]; then
        step_ok "Disabled $V1_SERVICE (system unit; file kept for rollback)"
        return 0
      fi
      # Disable failure is as serious as stop failure — without disable,
      # v1 auto-restarts on reboot and races v2. Surface both so the
      # caller (and mark_degraded) sees the full picture.
      step_fail "Could not fully disable $V1_SERVICE (stop=$stop_ok, disable=$disable_ok) — run 'sudo systemctl stop $V1_SERVICE && sudo systemctl disable $V1_SERVICE' manually so v1 doesn't auto-start on reboot"
      return 1
    fi
    local v1_file="$HOME/.config/systemd/user/${V1_SERVICE}.service"
    if [ -f "$v1_file" ] || [ -L "$v1_file" ]; then
      local stop_ok=true disable_ok=true
      systemctl --user stop "$V1_SERVICE" 2>/dev/null || stop_ok=false
      systemctl --user disable "$V1_SERVICE" 2>/dev/null || disable_ok=false
      if [ "$stop_ok" = "true" ] && [ "$disable_ok" = "true" ]; then
        step_ok "Disabled $V1_SERVICE (unit file kept for rollback)"
        return 0
      fi
      step_fail "Could not fully disable $V1_SERVICE (stop=$stop_ok, disable=$disable_ok) — run 'systemctl --user stop $V1_SERVICE && systemctl --user disable $V1_SERVICE' manually"
      return 1
    fi
    return 0
  elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
    local v1_plist="$HOME/Library/LaunchAgents/${V1_SERVICE}.plist"
    if [ -f "$v1_plist" ] || [ -L "$v1_plist" ]; then
      if launchctl unload "$v1_plist" 2>/dev/null; then
        step_ok "Unloaded $V1_SERVICE (plist kept for rollback)"
        return 0
      fi
      step_fail "Could not unload $V1_SERVICE — run 'launchctl unload $v1_plist' manually so v1 doesn't auto-restart on next login"
      return 1
    fi
    return 0
  fi
  return 0
}

# ─── phase 1: core state ────────────────────────────────────────────────

echo "$(bold 'Phase 1: Core state')"
echo

run_step "1a-env" \
  "Merge .env" \
  "setup/migrate-v2/env.ts" "$V1_PATH"

run_step "1b-db" \
  "Seed v2 database" \
  "setup/migrate-v2/db.ts" "$V1_PATH"

run_step "1c-groups" \
  "Copy group folders" \
  "setup/migrate-v2/groups.ts" "$V1_PATH"

run_step "1d-sessions" \
  "Copy session data" \
  "setup/migrate-v2/sessions.ts" "$V1_PATH"

run_step "1e-tasks" \
  "Port scheduled tasks" \
  "setup/migrate-v2/tasks.ts" "$V1_PATH"

# Pre-1f-taskflow gate — taskflow.ts refuses to copy v1's taskflow.db
# while v1 is live (isV1ServiceActive() probe blocks the copy to prevent
# silent WAL race + data loss across all groups). If v1 is running, ask
# the user to stop now; we keep v1 stopped through Phase 2/3 so the late
# Service switchover block can do an orderly v2 start.
if [ "$V1_WAS_RUNNING" = "true" ]; then
  STOP_ANSWER_FILE=$(mktemp)
  pnpm exec tsx setup/migrate-v2/switchover-prompt.ts --stop-for-taskflow "$STOP_ANSWER_FILE" || true
  STOP_ANSWER=$(cat "$STOP_ANSWER_FILE" 2>/dev/null || echo "cancel")
  rm -f "$STOP_ANSWER_FILE"

  if [ "$STOP_ANSWER" != "stop" ]; then
    step_fail "v1 stop declined — TaskFlow copy cannot proceed safely without it"
    abort "1f-taskflow-prereq"
  fi

  if [ "$PLATFORM_SERVICE" = "systemd" ]; then
    # sudo -n (non-interactive) so a missing sudo cache fails fast with a
    # visible "try this manually" hint instead of silently hanging on a
    # password prompt redirected to /dev/null.
    if [ "$V1_SYSTEMD_SCOPE" = "--user" ]; then
      stop_cmd=(systemctl --user stop "$V1_SERVICE")
      hint="systemctl --user stop $V1_SERVICE"
    else
      stop_cmd=(sudo -n systemctl stop "$V1_SERVICE")
      hint="sudo systemctl stop $V1_SERVICE"
    fi
    if "${stop_cmd[@]}" 2>/dev/null; then
      V1_STOPPED_BY_MIGRATION=true
      step_ok "Stopped $V1_SERVICE"
    else
      step_fail "Could not stop $V1_SERVICE (run '$hint' manually then re-run)"
      abort "1f-taskflow-prereq"
    fi
  elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
    if launchctl unload "$HOME/Library/LaunchAgents/${V1_SERVICE}.plist" 2>/dev/null; then
      V1_STOPPED_BY_MIGRATION=true
      step_ok "Stopped $V1_SERVICE"
    else
      step_fail "Could not stop $V1_SERVICE"
      abort "1f-taskflow-prereq"
    fi
  fi
fi

run_step "1f-taskflow" \
  "Copy v1 taskflow.db (global boards/tasks state)" \
  "setup/migrate-v2/taskflow.ts" "$V1_PATH"

# TaskFlow state powers boards/tasks for every group. A failure here
# (uncheckpointed WAL, integrity violation, partial copy) means v2 would
# start with empty or corrupt TaskFlow data → silent data loss across
# all groups. Abort before any later phase commits us further.
if [ "${STEP_STATUSES[${#STEP_STATUSES[@]}-1]}" = "failed" ]; then
  echo
  step_fail "1f-taskflow is required for cutover — aborting migration"
  echo
  echo "  $(dim 'See:') $STEPS_DIR/1f-taskflow.log"
  echo
  # If pre-1f stopped v1, restore it before aborting — otherwise the
  # operator is stranded with both v1 down and v2 not installed.
  # rollback_to_v1_no_v2 marks MIGRATION_DEGRADED on any sub-failure
  # (sudo cache expired, mv failed); the EXIT trap still runs.
  if [ "$V1_WAS_RUNNING" = "true" ]; then
    rollback_to_v1_no_v2
  fi
  abort "1f-taskflow"
fi

echo
step_ok "Phase 1 complete"
echo

# ─── phase 2: channels (interactive) ────────────────────────────────────

echo "$(bold 'Phase 2: Channels')"
echo

# Channel selection — clack multiselect (interactive) or NANOCLAW_CHANNELS env var.
# NANOCLAW_CHANNELS accepts comma-separated channel names: "telegram,discord"
SELECTED_CHANNELS=()
CHANNEL_SELECT_OUT="$STEPS_DIR/2a-channels-selected.txt"

pnpm exec tsx setup/migrate-v2/select-channels.ts "$CHANNEL_SELECT_OUT" || true

if [ -f "$CHANNEL_SELECT_OUT" ]; then
  while IFS= read -r ch; do
    [ -n "$ch" ] && SELECTED_CHANNELS+=("$ch")
  done < "$CHANNEL_SELECT_OUT"
fi

if [ ${#SELECTED_CHANNELS[@]} -eq 0 ]; then
  echo
  step_skip "No channels selected"
else
  echo
  step_info "Selected: ${SELECTED_CHANNELS[*]}"
  echo

  # 2b. Copy channel auth state
  run_step "2b-channel-auth" \
    "Copy channel credentials" \
    "setup/migrate-v2/channel-auth.ts" "$V1_PATH" "${SELECTED_CHANNELS[@]}"

  # 2c. Install channel code
  for ch in "${SELECTED_CHANNELS[@]}"; do
    INSTALL_SCRIPT="setup/install-${ch}.sh"
    STEP_NAME="2c-install-${ch}"
    if [ -f "$INSTALL_SCRIPT" ]; then
      STEP_LOG="$STEPS_DIR/${STEP_NAME}.log"
      if bash "$INSTALL_SCRIPT" > "$STEP_LOG" 2>&1; then
        STATUS_LINE=$(grep '^STATUS:' "$STEP_LOG" | head -1 | sed 's/^STATUS: *//')
        if [ "$STATUS_LINE" = "already-installed" ]; then
          step_skip "Install $ch $(dim "(already installed)")"
          record_step "$STEP_NAME" "skipped"
        else
          step_ok "Install $ch"
          record_step "$STEP_NAME" "success"
        fi
        log "install-$ch: $STATUS_LINE"
      else
        step_fail "Install $ch"
        tail -5 "$STEP_LOG" 2>/dev/null | while IFS= read -r line; do
          echo "  $(dim "$line")"
        done
        log "install-$ch: FAILED (see $STEP_LOG)"
        record_step "$STEP_NAME" "failed"
      fi
    else
      step_skip "Install $ch $(dim "(no install script)")"
      log "install-$ch: no install script"
      record_step "$STEP_NAME" "failed"
    fi
  done

  # 2d. (Removed) WhatsApp LID resolution was previously needed because the
  # v6 adapter couldn't reliably translate LID→phone JIDs, so the migration
  # pre-created dual messaging_groups rows. With Baileys v7, the adapter
  # resolves LIDs via extractAddressingContext + signalRepository.lidMapping
  # on every inbound message, so dual rows are unnecessary and were causing
  # split sessions.
fi

echo
step_ok "Phase 2 complete"
echo

# ─── phase 3: infrastructure ────────────────────────────────────────────

echo "$(bold 'Phase 3: Infrastructure')"
echo

# 3a. Docker — install if missing (OneCLI needs it)
if command -v docker >/dev/null 2>&1; then
  DOCKER_V=$(docker --version 2>/dev/null | head -1)
  step_ok "Docker available $(dim "($DOCKER_V)")"
  log "Docker: $DOCKER_V"
else
  step_info "Installing Docker…"
  DOCKER_LOG="$STEPS_DIR/3a-docker.log"
  if bash setup/install-docker.sh > "$DOCKER_LOG" 2>&1; then
    hash -r 2>/dev/null || true
    step_ok "Docker installed"
    record_step "3a-docker" "success"
    log "Docker: installed"
  else
    step_fail "Docker install failed $(dim "(see $DOCKER_LOG)")"
    record_step "3a-docker" "failed"
    log "Docker: FAILED"
  fi
fi

# 3b. OneCLI — detect or install via setup step (requires Docker)
ONECLI_OK=false
ONECLI_URL_FROM_ENV=$(grep '^ONECLI_URL=' .env 2>/dev/null | head -1 | sed 's/^ONECLI_URL=//')
ONECLI_URL_CHECK="${ONECLI_URL_FROM_ENV:-http://127.0.0.1:10254}"

if curl -sf "${ONECLI_URL_CHECK}/api/health" >/dev/null 2>&1; then
  step_ok "OneCLI running at $(dim "$ONECLI_URL_CHECK")"
  ONECLI_OK=true
  log "OneCLI: running at $ONECLI_URL_CHECK"
elif command -v docker >/dev/null 2>&1; then
  step_info "Setting up OneCLI…"
  ONECLI_LOG="$STEPS_DIR/3b-onecli.log"
  ONECLI_ERR="$STEPS_DIR/3b-onecli.err"
  if pnpm exec tsx setup/index.ts --step onecli > "$ONECLI_LOG" 2>"$ONECLI_ERR"; then
    step_ok "OneCLI ready"
    ONECLI_OK=true
    record_step "3b-onecli" "success"
    log "OneCLI: installed/configured"
  else
    step_fail "OneCLI setup failed $(dim "(see $ONECLI_LOG)")"
    record_step "3b-onecli" "failed"
    log "OneCLI: FAILED"
  fi
else
  step_fail "OneCLI needs Docker $(dim "(install Docker first)")"
  record_step "3b-onecli" "failed"
  log "OneCLI: skipped (no Docker)"
fi

# 3c. Anthropic credential — run the auth setup step if no credential found
if grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env 2>/dev/null; then
  step_ok "Anthropic credential found in .env"
  log "Anthropic credential: found in .env"
elif [ "$ONECLI_OK" = "true" ]; then
  step_info "Registering Anthropic credential…"
  AUTH_LOG="$STEPS_DIR/3c-auth.log"
  AUTH_ERR="$STEPS_DIR/3c-auth.err"
  if pnpm exec tsx setup/index.ts --step auth > "$AUTH_LOG" 2>"$AUTH_ERR"; then
    step_ok "Anthropic credential registered"
    record_step "3c-auth" "success"
    log "Anthropic credential: registered via auth step"
  else
    step_fail "Auth setup failed $(dim "(see $AUTH_LOG)")"
    record_step "3c-auth" "failed"
    log "Anthropic credential: FAILED"
  fi
else
  step_info "No Anthropic credential $(dim "(OneCLI not available — add manually to .env)")"
  log "Anthropic credential: skipped (no OneCLI)"
fi

# 3d. Container skills — DEFERRED to /migrate-from-v1 Phase 4.
#
# Earlier versions of this script blindly copied every v1 container skill
# that wasn't already present in v2. That was actively harmful: v1 skills
# like `pdf-reader` require binaries (`pdftotext` / poppler-utils) that
# v2's Dockerfile doesn't install, and `status` / `capabilities` reference
# `/workspace/project` which v2 doesn't mount. The skills would mount into
# every agent and break the moment the agent tried to use them.
#
# The categorization is human-judgement work (compatible vs incompatible
# vs superseded), so it lives in /migrate-from-v1 Phase 4 / Step 2. Just
# report what's there for the operator's awareness.
V1_SKILLS_DIR="$V1_PATH/container/skills"
if [ -d "$V1_SKILLS_DIR" ]; then
  V1_SKILL_COUNT=$(find "$V1_SKILLS_DIR" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
  step_skip "v1 has $V1_SKILL_COUNT container skill(s) — /migrate-from-v1 Phase 4 will review and copy compatible ones"
  log "Container skills: deferred (v1=$V1_SKILL_COUNT, copied=0 — /migrate-from-v1 handles)"
else
  step_skip "No v1 container skills"
fi

# 3e. Build agent container image
if command -v docker >/dev/null 2>&1; then
  step_info "Building agent container image…"
  BUILD_LOG="$STEPS_DIR/3e-container-build.log"
  if bash container/build.sh > "$BUILD_LOG" 2>&1; then
    step_ok "Container image built"
    record_step "3e-build" "success"
    log "Container build: success"
  else
    step_fail "Container build failed"
    record_step "3e-build" "failed"
    tail -10 "$BUILD_LOG" 2>/dev/null | while IFS= read -r line; do
      echo "  $(dim "$line")"
    done
    log "Container build: FAILED (see $BUILD_LOG)"
  fi
else
  step_fail "Docker not available — cannot build container"
  record_step "3e-build" "failed"
  log "Container build: skipped (no Docker)"
fi

echo
step_ok "Phase 3 complete"
echo

# ─── service switchover ─────────────────────────────────────────────────

echo "$(bold 'Service switchover')"
echo

# Helpers rollback_to_v1_no_v2 + disable_v1_service are defined earlier
# (right after V1_WAS_RUNNING detection) so the 1f-taskflow failure path
# can also call rollback_to_v1_no_v2 — otherwise the abort at line 528
# would strand the operator with v1 down.

# Platform + service names were detected once before Phase 1. V1_WAS_RUNNING
# reflects v1's state at script start; if 1f-taskflow's pre-stop gate fired,
# v1 is already stopped here but V1_WAS_RUNNING stays true so the switchover
# block still offers the v2 start prompt.

SERVICE_SWITCHED=false
if [ "$V1_WAS_RUNNING" = "true" ]; then
  step_info "v1 service was running at script start $(dim "($V1_SERVICE)")"

  # Ask user if they want to switch
  SWITCH_ANSWER_FILE=$(mktemp)
  pnpm exec tsx setup/migrate-v2/switchover-prompt.ts --offer-switch "$SWITCH_ANSWER_FILE" || true
  SWITCH_ANSWER=$(cat "$SWITCH_ANSWER_FILE" 2>/dev/null || echo "skip")
  rm -f "$SWITCH_ANSWER_FILE"

  if [ "$SWITCH_ANSWER" = "switch" ]; then
    # v1 was already stopped by the 1f-taskflow pre-stop gate. Verify and
    # log; only stop again if somehow still running (Restart=on-failure on
    # a system unit can resurrect v1 between phases). Honors V1_SYSTEMD_SCOPE
    # so a sudo-installed v1 that re-activated isn't missed by a --user probe.
    #
    # If a re-stop fails (sudo cache expired, launchctl errored), bailing
    # out and proceeding to v2 install is unsafe — v1 would race v2 against
    # the same DBs. Abort the switchover, roll back, and let the operator
    # re-run after fixing privileges.
    V1_RESTOP_FAILED=false
    if [ "$PLATFORM_SERVICE" = "systemd" ]; then
      if [ "$V1_SYSTEMD_SCOPE" = "system" ] && systemctl is-active "$V1_SERVICE" >/dev/null 2>&1; then
        if sudo -n systemctl stop "$V1_SERVICE" 2>/dev/null; then
          V1_STOPPED_BY_MIGRATION=true
          step_ok "Stopped v1 service"
        else
          V1_RESTOP_FAILED=true
          step_fail "Could not re-stop v1 — run 'sudo systemctl stop $V1_SERVICE' manually"
        fi
      elif [ "$V1_SYSTEMD_SCOPE" = "--user" ] && systemctl --user is-active "$V1_SERVICE" >/dev/null 2>&1; then
        if systemctl --user stop "$V1_SERVICE" 2>/dev/null; then
          V1_STOPPED_BY_MIGRATION=true
          step_ok "Stopped v1 service"
        else
          V1_RESTOP_FAILED=true
          step_fail "Could not stop v1"
        fi
      fi
    elif [ "$PLATFORM_SERVICE" = "launchd" ] && launchctl list "$V1_SERVICE" >/dev/null 2>&1; then
      if launchctl unload ~/Library/LaunchAgents/${V1_SERVICE}.plist 2>/dev/null; then
        V1_STOPPED_BY_MIGRATION=true
        step_ok "Stopped v1 service"
      else
        V1_RESTOP_FAILED=true
        step_fail "Could not stop v1"
      fi
    fi

    if [ "$V1_RESTOP_FAILED" = "true" ]; then
      # v1 is still running with stale TaskFlow state already copied to v2.
      # Starting v2 here would be a split-brain. Roll back and abort cleanly.
      step_fail "v1 resurrected between phases and could not be re-stopped — aborting switchover to prevent split-brain"
      rollback_to_v1_no_v2
      record_step "service-install" "failed"
      mark_degraded "v1 ($V1_SERVICE) could not be re-stopped at switchover — re-run migrate-v2.sh after restoring sudo cache or stopping v1 manually"
      abort "v1-restop-failed"
    fi

    # Install and start v2 service
    V2_SERVICE_LOG="$STEPS_DIR/service-install.log"
    V2_SERVICE_ERR="$STEPS_DIR/service-install.err"
    if pnpm exec tsx setup/index.ts --step service > "$V2_SERVICE_LOG" 2>"$V2_SERVICE_ERR"; then
      # Parse the actual unit name from the service step stdout (clean, no ANSI)
      if [ "$PLATFORM_SERVICE" = "systemd" ]; then
        V2_SERVICE=$(grep '^SERVICE_UNIT:' "$V2_SERVICE_LOG" | head -1 | sed 's/^SERVICE_UNIT: *//')
      elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
        V2_SERVICE=$(grep '^SERVICE_LABEL:' "$V2_SERVICE_LOG" | head -1 | sed 's/^SERVICE_LABEL: *//')
      fi
      step_ok "v2 service installed and started $(dim "($V2_SERVICE)")"
      SERVICE_SWITCHED=true
    else
      # v2 install failed and v1 is still down from pre-1f. Don't strand
      # the operator: restart v1, move v2 taskflow.db aside, leave a clear
      # failure trail. SERVICE_SWITCHED stays false so the keep/revert
      # prompt is skipped.
      step_fail "Could not start v2 service $(dim "(see $V2_SERVICE_LOG)") — rolling back to v1"
      rollback_to_v1_no_v2
      record_step "service-install" "failed"
      mark_degraded "v2 service install failed — diagnose with 'pnpm exec tsx setup/index.ts --step service', then re-run migrate-v2.sh"
      step_info "Diagnose v2 install with: $(dim 'pnpm exec tsx setup/index.ts --step service'), then re-run migrate-v2.sh"
    fi

    if [ "$SERVICE_SWITCHED" = "true" ]; then
      echo
      step_info "v2 is running — send a test message to your bot"
      echo

      # Ask: keep or revert?
      KEEP_ANSWER_FILE=$(mktemp)
      pnpm exec tsx setup/migrate-v2/switchover-prompt.ts --keep-or-revert "$KEEP_ANSWER_FILE" || true
      KEEP_ANSWER=$(cat "$KEEP_ANSWER_FILE" 2>/dev/null || echo "keep")
      rm -f "$KEEP_ANSWER_FILE"

      if [ "$KEEP_ANSWER" = "revert" ]; then
        # Stop v2 first, then use the shared rollback helper for v1 restart
        # + taskflow.db move-aside.
        if [ "$PLATFORM_SERVICE" = "systemd" ] && [ -n "$V2_SERVICE" ]; then
          systemctl --user stop "$V2_SERVICE" 2>/dev/null || true
          systemctl --user disable "$V2_SERVICE" 2>/dev/null || true
        elif [ "$PLATFORM_SERVICE" = "launchd" ] && [ -n "$V2_SERVICE" ]; then
          launchctl unload ~/Library/LaunchAgents/${V2_SERVICE}.plist 2>/dev/null || true
        fi
        rollback_to_v1_no_v2
        step_ok "Reverted to v1 service"
        SERVICE_SWITCHED=false
      else
        step_ok "Keeping v2 service"
        # Operator chose v2 — v1 staying off is intentional. Clear the
        # "stranded" flag so the EXIT trap doesn't undo the switch.
        V1_STOPPED_BY_MIGRATION=false
        if ! disable_v1_service; then
          mark_degraded "v1 ($V1_SERVICE) was not disabled — sudo cache expired; v1 will auto-restart on reboot and race v2"
        fi
      fi
    fi
  else
    # User picked 'skip' at the offer-switch prompt AFTER pre-1f stopped v1.
    # We can't leave both v1 and v2 down. Restore v1 + invalidate the copied
    # taskflow.db so a future rerun re-copies fresh.
    step_info "v1 was stopped to copy TaskFlow data; restoring since you opted not to switch"
    rollback_to_v1_no_v2
    step_info "v2 install is staged but not running — re-run migrate-v2.sh later"
  fi
else
  step_skip "v1 service not running — nothing to switch"
  if ! disable_v1_service; then
    mark_degraded "v1 ($V1_SERVICE) was not disabled — sudo cache expired; v1 will auto-restart on reboot and race v2"
  fi
fi

echo

# ─── phase 4: handoff ───────────────────────────────────────────────────
# handoff.json is written by the EXIT trap (write_handoff) — always, even on
# abort. Here we just print the summary.

echo "$(bold 'Phase 4: Handoff')"
echo

step_ok "Wrote handoff summary"

# Summary
# Derive header from BOTH degraded-flag AND per-step results — a failed
# step doesn't auto-flip MIGRATION_DEGRADED, so the header would otherwise
# claim "Migration complete" even when 1d-sessions or 3e-build is failed.
SUMMARY_HAS_FAILURES=false
SUMMARY_HAS_PARTIALS=false
for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
  case "${STEP_STATUSES[$i]}" in
    failed)  SUMMARY_HAS_FAILURES=true ;;
    partial) SUMMARY_HAS_PARTIALS=true ;;
  esac
done

# Render a single "What was done" line by step name. Pulls the recorded
# status so failed/partial steps don't display green-✓. Falls back to
# success-✓ for steps that never recorded (most of these are 100%-
# completion gates that abort on failure, so an absent record means the
# script reached this summary block with the step done).
render_step_line() {
  local name="$1" label="$2"
  local i
  for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
    if [ "${STEP_NAMES[$i]}" = "$name" ]; then
      case "${STEP_STATUSES[$i]}" in
        success) echo "    $(green '✓')  $label" ;;
        partial) echo "    $(red '!')  $label $(dim '(with errors — see logs/migrate-steps/')${name}$(dim '.log)')" ;;
        failed)  echo "    $(red '✗')  $label $(dim '(failed — see logs/migrate-steps/')${name}$(dim '.log)')" ;;
        skipped) echo "    $(dim '–')  $label $(dim '(skipped)')" ;;
        *)       echo "    $(dim '·')  $label" ;;
      esac
      return
    fi
  done
  echo "    $(green '✓')  $label"
}

echo
if [ "$SUMMARY_HAS_FAILURES" = "true" ] || [ "$MIGRATION_DEGRADED" = "true" ]; then
  echo "$(bold '── Migration completed with issues — see below ──')"
elif [ "$SUMMARY_HAS_PARTIALS" = "true" ]; then
  echo "$(bold '── Migration completed with non-fatal errors — see below ──')"
else
  echo "$(bold '── Migration complete ──')"
fi
echo
echo "  $(dim 'v1:')  $V1_PATH"
echo "  $(dim 'v2:')  $PROJECT_ROOT"
echo
echo "  $(bold 'What was done:')"
render_step_line "1a-env"      ".env keys merged"
render_step_line "1b-db"       "Database seeded (agent groups, messaging groups, wiring)"
render_step_line "1c-groups"   "Group folders copied (CLAUDE.md → CLAUDE.local.md)"
render_step_line "1d-sessions" "Session data copied"
render_step_line "1e-tasks"    "Scheduled tasks ported"
render_step_line "1f-taskflow" "TaskFlow state copied (boards, tasks)"
if [ ${#SELECTED_CHANNELS[@]} -gt 0 ]; then
echo "    $(green '✓')  Channels installed: ${SELECTED_CHANNELS[*]}"
fi
echo "    $(green '✓')  Container skills review deferred to /migrate-from-v1 Phase 4"
render_step_line "3e-build"    "Container image built"
if [ "$SERVICE_SWITCHED" = "true" ] && [ -n "$V2_SERVICE" ]; then
echo "    $(green '✓')  Service switched to v2 $(dim "($V2_SERVICE)")"
echo
echo "  $(bold 'Rollback to v1:')"
if [ "$PLATFORM_SERVICE" = "systemd" ]; then
  if [ "$V1_SYSTEMD_SCOPE" = "system" ]; then
echo "    $(dim '$') systemctl --user stop $V2_SERVICE && sudo systemctl start $V1_SERVICE"
  else
echo "    $(dim '$') systemctl --user stop $V2_SERVICE && systemctl --user start $V1_SERVICE"
  fi
elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
echo "    $(dim '$') launchctl unload ~/Library/LaunchAgents/${V2_SERVICE}.plist && launchctl load ~/Library/LaunchAgents/${V1_SERVICE}.plist"
fi
fi
if [ "$MIGRATION_DEGRADED" = "true" ]; then
echo
echo "  $(bold 'Issues to resolve before re-running:')"
for reason in "${MIGRATION_DEGRADED_REASONS[@]}"; do
echo "    $(dim '!')  $reason"
done
fi
echo
echo "  $(bold 'What still needs a human:')"
if [ "$ONECLI_OK" = "false" ]; then
echo "    $(dim '·')  Set up OneCLI: pnpm exec tsx setup/index.ts --step onecli"
fi
if ! grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env 2>/dev/null; then
echo "    $(dim '·')  Add Anthropic credential to .env or OneCLI vault"
fi
echo "    $(dim '·')  Run $(bold '/migrate-from-v1') in Claude to finish:"
echo "       $(dim '- Seed your owner account')"
echo "       $(dim '- Set access policies')"
echo "       $(dim '- Port any custom v1 code')"
echo
echo "  $(dim "Handoff: $LOGS_DIR/setup-migration/handoff.json")"
echo "  $(dim "Full log: $MIGRATE_LOG")"
echo "  $(dim "Step logs: $STEPS_DIR/")"
echo

# ─── hand off to Claude ─────────────────────────────────────────────────

if command -v claude >/dev/null 2>&1; then
  write_handoff
  trap - EXIT
  exec claude "/migrate-from-v1"
fi
