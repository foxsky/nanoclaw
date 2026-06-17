#!/usr/bin/env bash
#
# /add-taskflow — install the TaskFlow overlay (Kanban + GTD team task management).
#
# Channel-style install-overlay (ADR 0006). Core ships near-pristine upstream +
# the 10 extension contracts; TaskFlow is fork-owned overlay files this installer
# copies in, plus idempotent grep-then-append barrel registrations that wire the
# overlay's registrants (modules, MCP tools, migrate-v2 step) into core.
#
# Steps:
#   a. Resolve + fetch the TaskFlow source branch (no merge/checkout).
#   b. COPY every path in setup/add-taskflow/copy-set.txt via `git show <branch>:p > p`.
#   c. REGISTER: idempotent grep-then-append the 3 barrel append-sets (ADR 0006).
#   d. DEPS: host `pnpm install` only if a new dep is needed; container `bun install`
#      only if container/agent-runner/package.json changed (overlay is source-only —
#      normally neither runs).
#   e. BUILD: `pnpm run build` (host). A real install MUST also run
#      `./container/build.sh` (the container ships TaskFlow code). Set
#      TASKFLOW_SKIP_CONTAINER_BUILD=1 to skip it (e.g. verification).
#
# Re-running is a clean no-op (need_install guard + grep-guarded appends).
#
# Emits exactly one status block on stdout (ADD_TASKFLOW). Chatty progress → stderr.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

COPY_SET="$PROJECT_ROOT/setup/add-taskflow/copy-set.txt"

# Resolve which remote carries the TaskFlow branch — handles forks where the
# branch lives on a non-origin remote. Reuse the channels-remote helper.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
TASKFLOW_REMOTE="${TASKFLOW_REMOTE:-$(resolve_channels_remote)}"
# Branch (override via TASKFLOW_BRANCH). Default: the fork's TaskFlow bundle.
TASKFLOW_BRANCH="${TASKFLOW_BRANCH:-skill/taskflow-v2}"
SOURCE_REF="${TASKFLOW_REMOTE}/${TASKFLOW_BRANCH}"

# Sentinel overlay file — its presence is the cheapest "files copied" check.
SENTINEL="src/modules/taskflow/index.ts"

emit_status() {
  local status=$1 error=${2:-}
  local already=${TASKFLOW_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_TASKFLOW ==="
  echo "STATUS: ${status}"
  echo "SOURCE_REF: ${SOURCE_REF}"
  echo "TASKFLOW_ALREADY_INSTALLED: ${already}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-taskflow] $*" >&2; }

# --- Barrel append-sets (ADR 0006 "Installer barrel-append manifest") ----------
# host modules barrel — 2 imports
MODULES_BARREL="src/modules/index.ts"
MODULES_IMPORTS=(
  "import './send-otp/index.js';"
  "import './taskflow/index.js';"
)
# container chat MCP barrel — 17 imports (taskflow-api-board.js intentionally absent)
MCP_BARREL="container/agent-runner/src/mcp-tools/index.ts"
MCP_IMPORTS=(
  "import './send-otp.js';"
  "import './transcribe-audio.js';"
  "import './provision-root-board.js';"
  "import './provision-child-board.js';"
  "import './create-group.js';"
  "import './add-destination.js';"
  "import './taskflow-api-read.js';"
  "import './taskflow-api-mutate.js';"
  "import './taskflow-api-update.js';"
  "import './taskflow-api-notes.js';"
  "import './rename-board-person.js';"
  "import './taskflow-api-comment.js';"
  "import './memory.js';"
  "import './db/taskflow-db.js';"
  "import './db/web-chat-reply-transform.js';"
  "import './dispatch-extensions.js';"
  "import './emit-hooks.js';"
)
# host migrate-v2 register barrel — 1 import
MIGRATE_BARREL="src/migrate-v2-steps-register.ts"
MIGRATE_IMPORTS=(
  "import './modules/taskflow/migrate-v2-main-control.js';"
)

# Append a literal import line to a barrel only if absent (grep -q guard).
append_if_missing() {
  local file=$1 line=$2
  if ! grep -qF "$line" "$file" 2>/dev/null; then
    echo "$line" >> "$file"
  fi
}

barrels_registered() {
  # True iff EVERY append-set line is already present in its barrel.
  local line
  for line in "${MODULES_IMPORTS[@]}"; do
    grep -qF "$line" "$MODULES_BARREL" 2>/dev/null || return 1
  done
  for line in "${MCP_IMPORTS[@]}"; do
    grep -qF "$line" "$MCP_BARREL" 2>/dev/null || return 1
  done
  for line in "${MIGRATE_IMPORTS[@]}"; do
    grep -qF "$line" "$MIGRATE_BARREL" 2>/dev/null || return 1
  done
  return 0
}

# Idempotency: installed iff the sentinel overlay exists AND all barrels are wired.
need_install() {
  [ ! -f "$SENTINEL" ] && return 0
  ! barrels_registered && return 0
  return 1
}

TASKFLOW_ALREADY_INSTALLED=true
if need_install; then
  TASKFLOW_ALREADY_INSTALLED=false

  if [ ! -f "$COPY_SET" ]; then
    emit_status failed "copy-set manifest not found: $COPY_SET"
    exit 1
  fi

  log "Fetching ${TASKFLOW_BRANCH} from ${TASKFLOW_REMOTE}…"
  git fetch "$TASKFLOW_REMOTE" "$TASKFLOW_BRANCH" >&2 2>/dev/null || {
    emit_status failed "git fetch ${TASKFLOW_REMOTE} ${TASKFLOW_BRANCH} failed"
    exit 1
  }

  # b. COPY the overlay files.
  log "Copying overlay files from ${SOURCE_REF}…"
  copied=0
  while IFS= read -r raw; do
    # strip comments / blanks
    path="${raw%%#*}"
    path="$(printf '%s' "$path" | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
    [ -z "$path" ] && continue
    mkdir -p "$(dirname "$path")"
    if ! git show "${SOURCE_REF}:${path}" > "$path" 2>/dev/null; then
      emit_status failed "git show ${SOURCE_REF}:${path} failed (missing in source branch?)"
      exit 1
    fi
    copied=$((copied + 1))
  done < "$COPY_SET"
  log "Copied ${copied} overlay files."

  # c. REGISTER barrels (idempotent grep-then-append).
  log "Wiring barrel registrations…"
  for line in "${MODULES_IMPORTS[@]}"; do append_if_missing "$MODULES_BARREL" "$line"; done
  for line in "${MCP_IMPORTS[@]}";     do append_if_missing "$MCP_BARREL" "$line"; done
  for line in "${MIGRATE_IMPORTS[@]}"; do append_if_missing "$MIGRATE_BARREL" "$line"; done

  # d. DEPS. The overlay is source-only — neither package.json normally changes.
  #    Run installs only when a real change is detected (respect the lockfile).
  if ! git diff --quiet -- package.json pnpm-lock.yaml 2>/dev/null; then
    log "Host manifest changed — pnpm install (frozen lockfile)…"
    pnpm install --frozen-lockfile >&2 2>/dev/null || {
      emit_status failed "pnpm install failed"
      exit 1
    }
  fi
  if ! git diff --quiet -- container/agent-runner/package.json 2>/dev/null; then
    log "Container manifest changed — bun install…"
    ( cd container/agent-runner && bun install ) >&2 2>/dev/null || {
      emit_status failed "container bun install failed"
      exit 1
    }
  fi

  # e. BUILD host.
  log "Building host (pnpm run build)…"
  pnpm run build >&2 2>/dev/null || {
    emit_status failed "pnpm run build failed"
    exit 1
  }

  # Container image carries TaskFlow code — MANDATORY in a real install.
  if [ "${TASKFLOW_SKIP_CONTAINER_BUILD:-0}" = "1" ]; then
    log "TASKFLOW_SKIP_CONTAINER_BUILD=1 — skipping ./container/build.sh (verification only)."
  else
    log "Rebuilding container image (./container/build.sh)…"
    ./container/build.sh >&2 2>/dev/null || {
      emit_status failed "./container/build.sh failed"
      exit 1
    }
  fi
else
  log "TaskFlow overlay already installed — skipping."
fi

emit_status success
