#!/usr/bin/env bash
set -euo pipefail

# Usage: kill-agent.sh <task_id> <cleanup|keep>

TASK_ID="$1"
CLEANUP="${2:-keep}"
SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOCK_FILE="$REGISTRY.lock"

# Kill tmux session
tmux kill-session -t "agent-$TASK_ID" 2>/dev/null || true

if [ "$CLEANUP" = "cleanup" ] && [ -f "$REGISTRY" ]; then
  WORKTREE=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .worktree' "$REGISTRY")
  BRANCH=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .branch' "$REGISTRY")

  if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
    REPO_ROOT=$(cd "$WORKTREE/.." && cd "$(git rev-parse --show-toplevel)" && pwd)
    cd "$REPO_ROOT"
    git worktree remove "$WORKTREE" --force 2>/dev/null || true
  fi

  if [ -n "$BRANCH" ]; then
    git branch -D "$BRANCH" 2>/dev/null || true
  fi

  # Update registry status — only overwrite if task was still active
  source "$SWARM_DIR/lib-lock.sh"

  mark_task_failed() {
    jq --arg id "$TASK_ID" \
      '(.tasks[] | select(.id == $id and (.status == "running" or .status == "pr_created" or .status == "reviewing"))).status = "failed" |
       (.tasks[] | select(.id == $id and .completedAt == null)).completedAt = (now * 1000 | floor)' \
      "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"
  }

  with_registry_lock "$LOCK_FILE" mark_task_failed
fi

echo "Killed agent-$TASK_ID"
