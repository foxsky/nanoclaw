#!/usr/bin/env bash
set -euo pipefail

# Usage: review-pr.sh <task_id>

TASK_ID="$1"
SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOG_DIR="$SWARM_DIR/logs"

source "$SWARM_DIR/.env"

WORKTREE=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .worktree' "$REGISTRY")
BRANCH=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .branch' "$REGISTRY")

if [ ! -d "$WORKTREE" ]; then
  echo "Worktree not found: $WORKTREE" >&2
  exit 1
fi

cd "$WORKTREE"
PR_NUM=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null || echo "")

if [ -z "$PR_NUM" ]; then
  echo "No PR found for branch $BRANCH" >&2
  exit 1
fi

DIFF_FILE="$LOG_DIR/diff-$TASK_ID.patch"
gh pr diff "$PR_NUM" > "$DIFF_FILE"

# Truncate diff to ~100KB to avoid CLI arg/token limits.
# Truncate at last complete line to avoid mid-line or mid-UTF8 cuts.
if [ "$(wc -c < "$DIFF_FILE")" -gt 102400 ]; then
  head -c 102400 "$DIFF_FILE" | head -n -1 > "$DIFF_FILE.tmp"
  echo -e "\n\n... [diff truncated at ~100KB] ..." >> "$DIFF_FILE.tmp"
  mv "$DIFF_FILE.tmp" "$DIFF_FILE"
fi

echo "Starting code reviews for PR #$PR_NUM..."

# Codex reviewer (thorough — edge cases, logic errors)
if [ -n "${OPENAI_API_KEY:-}" ]; then
  (
    cd "$WORKTREE"
    codex --model gpt-5.3-codex \
      --dangerously-bypass-approvals-and-sandbox \
      "Review the PR diff in $DIFF_FILE. Focus on: logic errors, missing error handling, race conditions, edge cases. Post findings as gh pr review comments on PR #$PR_NUM." \
      2>&1 | tee "$LOG_DIR/review-codex-$TASK_ID.log"
  ) &
  CODEX_PID=$!
fi

# Claude Code reviewer (validation — critical issues only)
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  (
    cd "$WORKTREE"
    claude --model claude-sonnet-4-6 \
      --dangerously-skip-permissions \
      -p "Review the PR diff in $DIFF_FILE. Only flag critical issues. Skip style suggestions. Post findings as gh pr review comment on PR #$PR_NUM." \
      2>&1 | tee "$LOG_DIR/review-claude-$TASK_ID.log"
  ) &
  CLAUDE_PID=$!
fi

# Wait for parallel reviews
[ -n "${CODEX_PID:-}" ] && wait "$CODEX_PID" || true
[ -n "${CLAUDE_PID:-}" ] && wait "$CLAUDE_PID" || true

# Gemini Code Assist reviews automatically via GitHub App — no script needed

echo "Reviews complete for PR #$PR_NUM"
