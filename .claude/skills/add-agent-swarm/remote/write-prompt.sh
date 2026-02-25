#!/usr/bin/env bash
set -euo pipefail

# Usage: write-prompt.sh <task_id>
# Reads prompt content from stdin, writes to ~/.agent-swarm/prompts/<task_id>.txt

TASK_ID="$1"
SWARM_DIR="$HOME/.agent-swarm"
PROMPT_FILE="$SWARM_DIR/prompts/$TASK_ID.txt"

mkdir -p "$SWARM_DIR/prompts"
cat > "$PROMPT_FILE"
