#!/usr/bin/env bash
set -euo pipefail

# Usage: run-agent.sh <model> <prompt_file>
# Reads prompt from file, execs the appropriate agent CLI.
# Called from tmux session created by spawn-agent.sh.

MODEL="$1"
PROMPT_FILE="$2"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

PROMPT=$(cat "$PROMPT_FILE")

case "$MODEL" in
  claude-code:opus)
    exec claude --model claude-opus-4-6 --dangerously-skip-permissions -p "$PROMPT"
    ;;
  claude-code:sonnet)
    exec claude --model claude-sonnet-4-6 --dangerously-skip-permissions -p "$PROMPT"
    ;;
  claude-code:haiku)
    exec claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions -p "$PROMPT"
    ;;
  codex)
    exec codex --model gpt-5.3-codex -c 'model_reasoning_effort=high' --dangerously-bypass-approvals-and-sandbox "$PROMPT"
    ;;
  *)
    echo "Unknown model: $MODEL" >&2
    exit 1
    ;;
esac
