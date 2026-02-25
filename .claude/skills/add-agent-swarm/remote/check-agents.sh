#!/usr/bin/env bash
set -uo pipefail
# NOTE: deliberately NOT set -e — individual task failures must not kill the loop

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"

if [ ! -f "$REGISTRY" ]; then
  echo "[]"
  exit 0
fi

process_task() {
  local task="$1"
  local TASK_ID BRANCH WORKTREE TMUX_ALIVE PR_NUM CI_STATUS REVIEW_STATUS CRITICAL HAS_SCREENSHOTS

  TASK_ID=$(echo "$task" | jq -r '.id')
  BRANCH=$(echo "$task" | jq -r '.branch')
  WORKTREE=$(echo "$task" | jq -r '.worktree')

  # Check tmux session
  TMUX_ALIVE=false
  if tmux has-session -t "agent-$TASK_ID" 2>/dev/null; then
    TMUX_ALIVE=true
  fi

  # Defaults
  PR_NUM="null"
  CI_STATUS="null"
  REVIEW_STATUS="null"
  CRITICAL=0
  HAS_SCREENSHOTS=false

  if [ -d "$WORKTREE" ]; then
    local saved_dir
    saved_dir=$(pwd)
    cd "$WORKTREE" || return

    local pr_raw
    pr_raw=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null || echo "")

    if [ -n "$pr_raw" ]; then
      PR_NUM="$pr_raw"

      # Check CI
      local ci_raw
      ci_raw=$(gh pr checks "$pr_raw" --json state -q '.[].state' 2>/dev/null | sort -u || echo "")
      if echo "$ci_raw" | grep -q "FAILURE"; then
        CI_STATUS='"failing"'
      elif echo "$ci_raw" | grep -q "SUCCESS"; then
        CI_STATUS='"passing"'
      elif [ -n "$ci_raw" ]; then
        CI_STATUS='"pending"'
      fi

      # Check reviews
      local review_raw
      review_raw=$(gh pr view "$pr_raw" --json reviewDecision -q .reviewDecision 2>/dev/null || echo "")
      case "$review_raw" in
        APPROVED) REVIEW_STATUS='"approved"' ;;
        CHANGES_REQUESTED) REVIEW_STATUS='"changes_requested"' ;;
        *) REVIEW_STATUS='"pending"' ;;
      esac

      # Count critical comments — resolve owner/repo from git context
      local owner_repo
      owner_repo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
      if [ -n "$owner_repo" ]; then
        CRITICAL=$(gh api "repos/$owner_repo/pulls/$pr_raw/comments" \
          --jq '[.[] | select(.body | test("critical|blocker"; "i"))] | length' 2>/dev/null || echo "0")
      fi

      # Check for screenshots in PR body
      if gh pr view "$pr_raw" --json body -q '.body' 2>/dev/null | grep -q '!\['; then
        HAS_SCREENSHOTS=true
      fi
    fi
    cd "$saved_dir" 2>/dev/null || true
  fi

  jq -n \
    --arg id "$TASK_ID" \
    --argjson tmux "$TMUX_ALIVE" \
    --argjson pr "$PR_NUM" \
    --argjson ci "$CI_STATUS" \
    --argjson review "$REVIEW_STATUS" \
    --argjson critical "$CRITICAL" \
    --argjson screenshots "$HAS_SCREENSHOTS" \
    '{id:$id, tmux_alive:$tmux, pr_number:$pr, ci_status:$ci, review_status:$review, critical_comments:$critical, has_screenshots:$screenshots}'
}

# Buffer process_task output to avoid emitting partial JSON on failure
jq -c '.tasks[] | select(.status != "merged" and .status != "failed")' "$REGISTRY" | while IFS= read -r task; do
  result=$(process_task "$task" 2>/dev/null) && echo "$result" || true
done | jq -s '.'
