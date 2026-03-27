#!/usr/bin/env bash
# Deploy NanoClaw to production with pre-flight validation.
# Usage: ./scripts/deploy.sh
set -euo pipefail

REMOTE="nanoclaw@192.168.2.63"
REMOTE_DIR="/home/nanoclaw/nanoclaw"

echo "=== Pre-flight checks ==="

# 1. Build locally
echo "[1/4] Building..."
npm run build 2>&1 | grep -v '^$'

# 2. Verify the compiled entry point can at least be parsed by Node
#    (catches missing runtime deps like the baileys incident)
echo "[2/4] Verifying dist/index.js imports..."
node --input-type=module -e "
  // Dynamic import resolves all top-level imports without executing main()
  import('$(pwd)/dist/index.js').then(
    () => console.log('  OK: all imports resolved'),
    (err) => { console.error('  FAIL:', err.message); process.exit(1); }
  );
" 2>&1 || { echo "ABORT: entry point has unresolvable imports. Fix before deploying."; exit 1; }

# 3. Sync files
echo "[3/4] Syncing to production..."
rsync -az --delete dist/ "$REMOTE:$REMOTE_DIR/dist/"
rsync -az --delete container/agent-runner/src/ "$REMOTE:$REMOTE_DIR/container/agent-runner/src/"
rsync -az package.json package-lock.json "$REMOTE:$REMOTE_DIR/"
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --ignore-scripts 2>&1 | tail -1"

# 4. Verify imports on production before restarting
echo "[4/4] Verifying imports on production..."
ssh "$REMOTE" "cd $REMOTE_DIR && node --input-type=module -e \"
  import('./dist/index.js').then(
    () => console.log('  OK: production imports resolved'),
    (err) => { console.error('  FAIL:', err.message); process.exit(1); }
  );
\"" 2>&1 || { echo "ABORT: production import check failed. Service NOT restarted."; exit 1; }

# 5. Restart service
echo "=== Restarting service ==="
ssh "$REMOTE" "systemctl --user restart nanoclaw"
sleep 4

# 6. Verify service is running
STATUS=$(ssh "$REMOTE" "systemctl --user is-active nanoclaw" 2>&1)
if [ "$STATUS" = "active" ]; then
  echo "=== Deploy successful === (service: $STATUS)"
  ssh "$REMOTE" "grep 'Connected to WhatsApp' $REMOTE_DIR/logs/nanoclaw.log | tail -1"
else
  echo "=== DEPLOY FAILED === (service: $STATUS)"
  ssh "$REMOTE" "journalctl --user -u nanoclaw -n 5 --no-pager" 2>&1
  exit 1
fi
