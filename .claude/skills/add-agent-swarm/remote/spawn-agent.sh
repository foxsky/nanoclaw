#!/usr/bin/env bash
set -euo pipefail

# Usage: spawn-agent.sh <repo_path> <branch_name> <model> <task_id> <priority>
# Prompt is read from ~/.agent-swarm/prompts/$TASK_ID.txt

REPO_PATH="$1"
BRANCH_NAME="$2"
MODEL="$3"
TASK_ID="$4"
PRIORITY="${5:-normal}"

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOG_DIR="$SWARM_DIR/logs"
PROMPT_FILE="$SWARM_DIR/prompts/$TASK_ID.txt"

source "$SWARM_DIR/.env"

mkdir -p "$LOG_DIR" "$SWARM_DIR/prompts"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

# Create worktree
WORKTREE_DIR="$REPO_PATH/.worktrees/$TASK_ID"
cd "$REPO_PATH"
git fetch origin main
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" origin/main 2>/dev/null || \
  git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"

# Install deps
cd "$WORKTREE_DIR"

# Install deps — auto-detect package manager (Node.js or Python)
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install --frozen-lockfile
elif [ -f "package-lock.json" ]; then
  npm ci
elif [ -f "yarn.lock" ]; then
  yarn install --frozen-lockfile
elif [ -f "pyproject.toml" ]; then
  if command -v poetry >/dev/null 2>&1; then
    poetry install --no-interaction
  elif command -v uv >/dev/null 2>&1; then
    uv sync
  else
    pip install -e ".[dev]" 2>/dev/null || pip install -e .
  fi
elif [ -f "requirements.txt" ]; then
  pip install -r requirements.txt
elif [ -f "Pipfile" ]; then
  pipenv install --dev
fi

# Launch in tmux via run-agent.sh wrapper (reads prompt from file safely).
# SAFETY: $MODEL and $PROMPT_FILE are safe to embed here because the host-side
# SAFE_ARG / SAFE_TASK_ID regexes guarantee no shell metacharacters (no quotes,
# backticks, spaces, or $) can reach this point.
tmux new-session -d -s "agent-$TASK_ID" \
  -c "$WORKTREE_DIR" \
  "source $SWARM_DIR/.env; $SWARM_DIR/run-agent.sh '$MODEL' '$PROMPT_FILE' 2>&1 | tee $LOG_DIR/$TASK_ID.log; echo '=== AGENT EXITED ===' >> $LOG_DIR/$TASK_ID.log"

# Update registry
if [ ! -f "$REGISTRY" ]; then
  echo '{"tasks":[]}' > "$REGISTRY"
fi

jq --arg id "$TASK_ID" \
   --arg repo "$(basename "$REPO_PATH")" \
   --arg branch "$BRANCH_NAME" \
   --arg worktree "$WORKTREE_DIR" \
   --arg model "$MODEL" \
   --arg promptFile "$PROMPT_FILE" \
   --arg started "$(date +%s)000" \
   --arg priority "$PRIORITY" \
   '.tasks += [{
     id: $id,
     repo: $repo,
     branch: $branch,
     worktree: $worktree,
     tmuxSession: ("agent-" + $id),
     model: $model,
     promptFile: $promptFile,
     status: "running",
     priority: $priority,
     startedAt: ($started | tonumber),
     retries: 0,
     maxRetries: 3,
     pr: null,
     checks: {ciPassed:false, codexReviewPassed:false, claudeReviewPassed:false, geminiReviewPassed:false, screenshotsIncluded:false},
     completedAt: null,
     notifyOnComplete: true
   }]' "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"

echo "Spawned agent-$TASK_ID in $WORKTREE_DIR"
