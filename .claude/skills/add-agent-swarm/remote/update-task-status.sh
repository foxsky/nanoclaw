#!/usr/bin/env bash
set -euo pipefail

# Usage: update-task-status.sh <task_id> <status>

TASK_ID="$1"
NEW_STATUS="$2"
SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"

if [ ! -f "$REGISTRY" ]; then
  echo "Registry not found: $REGISTRY" >&2
  exit 1
fi

case "$NEW_STATUS" in
  running|pr_created|reviewing|ready_for_review|merged|failed) ;;
  *)
    echo "Invalid status: $NEW_STATUS" >&2
    exit 1
    ;;
esac

jq --arg id "$TASK_ID" --arg status "$NEW_STATUS" \
  '(.tasks[] | select(.id == $id)).status = $status |
   (if $status == "merged" or $status == "failed" then
      (.tasks[] | select(.id == $id)).completedAt = (now * 1000 | floor)
    else
      .
    end)' \
  "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"

echo "Updated $TASK_ID status to $NEW_STATUS"
