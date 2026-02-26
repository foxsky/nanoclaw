#!/usr/bin/env bash
set -euo pipefail

SWARM_DIR="$HOME/.agent-swarm"

echo "Setting up agent swarm at $SWARM_DIR..."

mkdir -p "$SWARM_DIR/logs" "$SWARM_DIR/prompts"

if [ ! -f "$SWARM_DIR/active-tasks.json" ]; then
  echo '{"tasks":[]}' > "$SWARM_DIR/active-tasks.json"
fi

chmod +x "$SWARM_DIR/spawn-agent.sh" "$SWARM_DIR/run-agent.sh" "$SWARM_DIR/write-prompt.sh" \
  "$SWARM_DIR/check-agents.sh" "$SWARM_DIR/redirect-agent.sh" \
  "$SWARM_DIR/kill-agent.sh" "$SWARM_DIR/update-task-status.sh" "$SWARM_DIR/review-pr.sh" \
  "$SWARM_DIR/cleanup-worktrees.sh" "$SWARM_DIR/lib-lock.sh"

echo "Checking prerequisites..."
command -v git >/dev/null || { echo "FAIL: git not installed"; exit 1; }
command -v tmux >/dev/null || { echo "FAIL: tmux not installed"; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq not installed"; exit 1; }
command -v gh >/dev/null || { echo "FAIL: gh CLI not installed"; exit 1; }

# At least one runtime is needed (Node.js or Python)
if command -v node >/dev/null; then echo "OK: node found"; else echo "INFO: node not found"; fi
if command -v python3 >/dev/null; then echo "OK: python3 found"; else echo "INFO: python3 not found"; fi
if ! command -v node >/dev/null && ! command -v python3 >/dev/null; then
  echo "FAIL: neither node nor python3 installed — at least one runtime is required"
  exit 1
fi

command -v claude >/dev/null && echo "OK: claude CLI found" || echo "WARN: claude CLI not found"
command -v codex >/dev/null && echo "OK: codex CLI found" || echo "WARN: codex CLI not found"
command -v poetry >/dev/null && echo "OK: poetry found" || echo "INFO: poetry not found (optional, for Python projects)"
command -v uv >/dev/null && echo "OK: uv found" || echo "INFO: uv not found (optional, for Python projects)"

gh auth status >/dev/null 2>&1 && echo "OK: gh authenticated" || echo "WARN: gh not authenticated — run 'gh auth login'"

if [ ! -f "$SWARM_DIR/.env" ]; then
  echo ""
  echo "Enter API keys (press Enter to skip):"
  read -rp "ANTHROPIC_API_KEY: " ANTHROPIC_KEY
  read -rp "OPENAI_API_KEY: " OPENAI_KEY
  read -rp "GOOGLE_API_KEY: " GOOGLE_KEY

  cat > "$SWARM_DIR/.env" <<ENVEOF
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
OPENAI_API_KEY=${OPENAI_KEY}
GOOGLE_API_KEY=${GOOGLE_KEY}
ENVEOF
  chmod 600 "$SWARM_DIR/.env"
  echo "Keys saved to $SWARM_DIR/.env"
fi

if ! grep -q 'history-limit' ~/.tmux.conf 2>/dev/null; then
  echo 'set -g history-limit 50000' >> ~/.tmux.conf
  echo "Added tmux history-limit to ~/.tmux.conf"
fi

echo ""
echo "Setup complete. Configure SWARM_SSH_TARGET and SWARM_REPOS_JSON in NanoClaw .env"
