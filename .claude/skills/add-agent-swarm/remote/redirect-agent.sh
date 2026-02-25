#!/usr/bin/env bash
set -euo pipefail

# Usage: redirect-agent.sh <task_id>
# Message is read from ~/.agent-swarm/prompts/redirect-<task_id>.txt

TASK_ID="$1"
SWARM_DIR="$HOME/.agent-swarm"
MSG_FILE="$SWARM_DIR/prompts/redirect-$TASK_ID.txt"

if [ ! -f "$MSG_FILE" ]; then
  echo "ERROR: Message file not found: $MSG_FILE" >&2
  exit 1
fi

# Use load-buffer + paste-buffer instead of send-keys to safely handle
# arbitrary message content (avoids tmux escape sequence interpretation)
tmux load-buffer -b redirect "$MSG_FILE"
tmux paste-buffer -b redirect -t "agent-$TASK_ID"
tmux send-keys -t "agent-$TASK_ID" Enter
tmux delete-buffer -b redirect 2>/dev/null || true
rm -f "$MSG_FILE"
