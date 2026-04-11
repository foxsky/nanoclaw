#!/usr/bin/env bash
# Deploy NanoClaw to production with pre-flight validation.
# Usage: ./scripts/deploy.sh
set -euo pipefail

REMOTE="nanoclaw@192.168.2.63"
REMOTE_DIR="/home/nanoclaw/nanoclaw"

echo "=== Pre-flight checks ==="

# 1. Build locally (tsc may emit type warnings for dev-only files; that's OK
#    as long as dist/index.js is produced — step 2 validates it actually works)
echo "[1/6] Building..."
npm run build 2>&1 || true

# 2. Verify the compiled entry point can at least be parsed by Node
#    (catches missing runtime deps like the baileys incident)
echo "[2/6] Verifying dist/index.js imports..."
node --input-type=module -e "
  // Dynamic import resolves all top-level imports without executing main()
  import('$(pwd)/dist/index.js').then(
    () => console.log('  OK: all imports resolved'),
    (err) => { console.error('  FAIL:', err.message); process.exit(1); }
  );
" 2>&1 || { echo "ABORT: entry point has unresolvable imports. Fix before deploying."; exit 1; }

# 3. Regenerate group CLAUDE.md files from the canonical template.
#    The template at .claude/skills/add-taskflow/templates/CLAUDE.md.template
#    is the source of truth; per-group rendered copies in groups/*/CLAUDE.md
#    MUST match the template (minus mustache variable substitution) at every
#    deploy. Always regen before the rsync so production picks up whatever
#    landed in the template since the last deploy. Script is idempotent — no
#    diff if the template hasn't changed.
echo "[3/6] Regenerating group CLAUDE.md from template..."
node scripts/generate-claude-md.mjs 2>&1 \
  || { echo "ABORT: group CLAUDE.md regen failed. Fix the template or script before deploying."; exit 1; }

# 4. Sync files
echo "[4/6] Syncing to production..."
rsync -az --delete dist/ "$REMOTE:$REMOTE_DIR/dist/"
rsync -az --delete container/agent-runner/src/ "$REMOTE:$REMOTE_DIR/container/agent-runner/src/"
rsync -az container/agent-runner/package.json container/agent-runner/package-lock.json \
  "$REMOTE:$REMOTE_DIR/container/agent-runner/"
rsync -az container/Dockerfile container/build.sh container/.dockerignore "$REMOTE:$REMOTE_DIR/container/"
rsync -az groups/ "$REMOTE:$REMOTE_DIR/groups/"
rsync -az package.json package-lock.json "$REMOTE:$REMOTE_DIR/"
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --ignore-scripts" 2>&1 | tail -1 \
  || { echo "ABORT: npm install failed on remote."; exit 1; }

# 5. Rebuild the agent container image if container inputs changed.
#    Fingerprint covers everything the Dockerfile COPY steps consume.
echo "[5/6] Checking if agent container needs rebuild..."
LOCAL_FP=$(find container/Dockerfile container/.dockerignore container/build.sh \
  container/agent-runner/package.json container/agent-runner/package-lock.json \
  container/agent-runner/tsconfig.json container/agent-runner/src/ \
  -type f 2>/dev/null | sort | xargs cat | sha256sum | awk '{print $1}')
REMOTE_FP=$(ssh "$REMOTE" "cat $REMOTE_DIR/container/.build-fingerprint 2>/dev/null || echo none")
if [ "$LOCAL_FP" != "$REMOTE_FP" ]; then
  echo "  Container inputs changed — rebuilding nanoclaw-agent image on remote..."
  # Do NOT pipe through tail here — the pipeline exit code would become tail's,
  # masking a failed build. Let the full build output stream through so errors
  # are visible, and let ssh's real exit code propagate.
  ssh "$REMOTE" "cd $REMOTE_DIR && ./container/build.sh" 2>&1 \
    || { echo "ABORT: container build failed on remote. Service NOT restarted."; exit 1; }
  ssh "$REMOTE" "echo '$LOCAL_FP' > $REMOTE_DIR/container/.build-fingerprint"
  echo "  Image rebuilt."
else
  echo "  Fingerprint matches — skipping rebuild."
fi

# 6. Verify imports on production before restarting
echo "[6/6] Verifying imports on production..."
ssh "$REMOTE" "cd $REMOTE_DIR && node --input-type=module -e \"
  import('./dist/index.js').then(
    () => console.log('  OK: production imports resolved'),
    (err) => { console.error('  FAIL:', err.message); process.exit(1); }
  );
\"" 2>&1 || { echo "ABORT: production import check failed. Service NOT restarted."; exit 1; }

# 7. Restart service
echo "=== Restarting service ==="
ssh "$REMOTE" "systemctl --user restart nanoclaw"
sleep 4

# 8. Verify service is running
STATUS=$(ssh "$REMOTE" "systemctl --user is-active nanoclaw" 2>&1)
if [ "$STATUS" = "active" ]; then
  echo "=== Deploy successful === (service: $STATUS)"
  ssh "$REMOTE" "grep 'Connected to WhatsApp' $REMOTE_DIR/logs/nanoclaw.log | tail -1"
else
  echo "=== DEPLOY FAILED === (service: $STATUS)"
  ssh "$REMOTE" "journalctl --user -u nanoclaw -n 5 --no-pager" 2>&1
  exit 1
fi
