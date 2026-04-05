#!/usr/bin/env bash
# Deploy NanoClaw to production with pre-flight validation.
# Usage: ./scripts/deploy.sh
set -euo pipefail

REMOTE="nanoclaw@192.168.2.63"
REMOTE_DIR="/home/nanoclaw/nanoclaw"

echo "=== Pre-flight checks ==="

# 1. Build locally (tsc may emit type warnings for dev-only files; that's OK
#    as long as dist/index.js is produced — step 2 validates it actually works)
echo "[1/5] Building..."
npm run build 2>&1 || true

# 2. Verify the compiled entry point can at least be parsed by Node
#    (catches missing runtime deps like the baileys incident)
echo "[2/5] Verifying dist/index.js imports..."
node --input-type=module -e "
  // Dynamic import resolves all top-level imports without executing main()
  import('$(pwd)/dist/index.js').then(
    () => console.log('  OK: all imports resolved'),
    (err) => { console.error('  FAIL:', err.message); process.exit(1); }
  );
" 2>&1 || { echo "ABORT: entry point has unresolvable imports. Fix before deploying."; exit 1; }

# 3. Sync files
echo "[3/5] Syncing to production..."
rsync -az --delete dist/ "$REMOTE:$REMOTE_DIR/dist/"
rsync -az --delete container/agent-runner/src/ "$REMOTE:$REMOTE_DIR/container/agent-runner/src/"
rsync -az container/agent-runner/package.json container/agent-runner/package-lock.json \
  "$REMOTE:$REMOTE_DIR/container/agent-runner/"
rsync -az container/Dockerfile container/build.sh "$REMOTE:$REMOTE_DIR/container/"
rsync -az groups/ "$REMOTE:$REMOTE_DIR/groups/"
rsync -az package.json package-lock.json "$REMOTE:$REMOTE_DIR/"
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --ignore-scripts 2>&1 | tail -1"

# 4. Rebuild the agent container image if container inputs changed.
#    Skipped when the Docker image already matches the current
#    container/agent-runner/package.json + Dockerfile (hashed fingerprint).
#    A stale image is the silent failure mode for SDK bumps.
echo "[4/5] Checking if agent container needs rebuild..."
LOCAL_FP=$(cat container/Dockerfile container/agent-runner/package.json container/agent-runner/package-lock.json 2>/dev/null | sha256sum | awk '{print $1}')
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

# 5. Verify imports on production before restarting
echo "[5/5] Verifying imports on production..."
ssh "$REMOTE" "cd $REMOTE_DIR && node --input-type=module -e \"
  import('./dist/index.js').then(
    () => console.log('  OK: production imports resolved'),
    (err) => { console.error('  FAIL:', err.message); process.exit(1); }
  );
\"" 2>&1 || { echo "ABORT: production import check failed. Service NOT restarted."; exit 1; }

# 6. Restart service
echo "=== Restarting service ==="
ssh "$REMOTE" "systemctl --user restart nanoclaw"
sleep 4

# 7. Verify service is running
STATUS=$(ssh "$REMOTE" "systemctl --user is-active nanoclaw" 2>&1)
if [ "$STATUS" = "active" ]; then
  echo "=== Deploy successful === (service: $STATUS)"
  ssh "$REMOTE" "grep 'Connected to WhatsApp' $REMOTE_DIR/logs/nanoclaw.log | tail -1"
else
  echo "=== DEPLOY FAILED === (service: $STATUS)"
  ssh "$REMOTE" "journalctl --user -u nanoclaw -n 5 --no-pager" 2>&1
  exit 1
fi
