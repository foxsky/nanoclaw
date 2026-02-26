#!/usr/bin/env bash
# Shared registry locking helper.
# Usage: source "$SWARM_DIR/lib-lock.sh"
#        with_registry_lock "$LOCK_FILE" <command> [args...]

with_registry_lock() {
  local lock_file="$1"; shift
  if command -v flock >/dev/null 2>&1; then
    (
      flock -w 30 9 || { echo "Failed to acquire registry lock" >&2; exit 1; }
      "$@"
    ) 9>"$lock_file"
  else
    local lockdir="${lock_file}.d"
    local attempts=0
    while [ "$attempts" -lt 300 ]; do
      if mkdir "$lockdir" 2>/dev/null; then
        trap 'rmdir "$lockdir" 2>/dev/null || true' EXIT
        "$@"
        local rc=$?
        rmdir "$lockdir" 2>/dev/null || true
        trap - EXIT
        return "$rc"
      fi
      attempts=$((attempts + 1))
      sleep 0.1
    done
    echo "Failed to acquire registry lock" >&2
    return 1
  fi
}
