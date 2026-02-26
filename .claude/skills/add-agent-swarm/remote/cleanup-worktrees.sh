#!/usr/bin/env bash
# set -e: fail fast on corrupt registry before pruning.
# Cleanup operations in the while-loop subshell are best-effort and
# do not propagate failures to the parent shell.
set -euo pipefail

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOCK_FILE="$REGISTRY.lock"

if [ ! -f "$REGISTRY" ]; then
  exit 0
fi

CUTOFF=$(( $(date +%s) - 86400 ))

jq -c '.tasks[] | select((.status == "merged" or .status == "failed") and (.completedAt != null) and ((.completedAt / 1000) < '"$CUTOFF"'))' "$REGISTRY" | while IFS= read -r task; do
  TASK_ID=$(echo "$task" | jq -r '.id')
  WORKTREE=$(echo "$task" | jq -r '.worktree')

  echo "Cleaning up: $TASK_ID"

  tmux kill-session -t "agent-$TASK_ID" 2>/dev/null || true

  if [ -d "$WORKTREE" ]; then
    REPO_ROOT=$(cd "$WORKTREE/.." && cd "$(git rev-parse --show-toplevel)" && pwd 2>/dev/null) || true
    if [ -n "$REPO_ROOT" ]; then
      (cd "$REPO_ROOT" && git worktree remove "$WORKTREE" --force 2>/dev/null) || true
    fi
  fi

  rm -f "$SWARM_DIR/logs/$TASK_ID.log"
  rm -f "$SWARM_DIR/logs/review-codex-$TASK_ID.log"
  rm -f "$SWARM_DIR/logs/review-claude-$TASK_ID.log"
  rm -f "$SWARM_DIR/prompts/$TASK_ID.txt"
done

source "$SWARM_DIR/lib-lock.sh"

prune_registry() {
  jq --argjson cutoff "$CUTOFF" \
    '.tasks |= [.[] | select(
      .status == "running" or .status == "pr_created" or .status == "reviewing" or .status == "ready_for_review" or
      ((.completedAt == null) or ((.completedAt / 1000) >= $cutoff))
    )]' "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"
}

if ! with_registry_lock "$LOCK_FILE" prune_registry; then
  echo "Cleanup failed: unable to prune registry safely" >&2
  exit 1
fi

echo "Cleanup complete"
