#!/usr/bin/env bash
# Rollback NanoClaw v2 to v1.x in <15 minutes.
#
# Usage:
#   V1_SHA=<sha> ./scripts/rollback-to-v1.sh <snapshot-dir>
#
# Example:
#   V1_SHA=9cc1619 ./scripts/rollback-to-v1.sh /root/prod-snapshot-20260430
#
# Dry run (prints what it would do, makes NO changes):
#   DRY_RUN=1 V1_SHA=9cc1619 ./scripts/rollback-to-v1.sh /root/prod-snapshot-20260430
#
# Prerequisites (Phase -1):
#   - Phase -1.2: nanoclaw-agent:v1-rollback image present on prod (or v1-image.tar at /home/nanoclaw/backup/)
#   - Phase -1.3: snapshot dir contains store/messages.db, data/taskflow/taskflow.db, md5.txt
#   - SSH key auth to nanoclaw@192.168.2.63 with sudo -n
#
# Steps:
#   1. Verify snapshot integrity (md5 must match baseline)
#   2. Stop v2 service on prod (systemctl --user stop nanoclaw)
#   3. Reset prod git tree to V1_SHA (git reset --hard)
#   4. Restore DBs from snapshot (scp messages.db + taskflow.db)
#   5. Re-tag v1-rollback image as :latest
#   6. Restart service (systemctl --user start nanoclaw)
#   7. Verify active

set -euo pipefail

PROD_HOST="${PROD_HOST:-nanoclaw@192.168.2.63}"
PROD_PATH="${PROD_PATH:-/home/nanoclaw/nanoclaw}"
DRY_RUN="${DRY_RUN:-0}"

SNAPSHOT_DIR="${1:-}"
if [ -z "$SNAPSHOT_DIR" ]; then
  echo "ERROR: missing snapshot dir" >&2
  echo "Usage: V1_SHA=<sha> $0 <snapshot-dir>" >&2
  exit 2
fi
V1_SHA="${V1_SHA:-}"
if [ -z "$V1_SHA" ]; then
  echo "ERROR: V1_SHA env var is required" >&2
  echo "       Set it to the v1.x git SHA on prod to restore (e.g. last shipped pre-v2 commit)." >&2
  exit 2
fi

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY-RUN] $*"
  else
    eval "$*"
  fi
}

ssh_run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY-RUN] ssh $PROD_HOST \"$*\""
  else
    ssh -o BatchMode=yes "$PROD_HOST" "$*"
  fi
}

scp_run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY-RUN] scp $1 $PROD_HOST:$2"
  else
    scp "$1" "$PROD_HOST:$2"
  fi
}

START_TIME=$(date +%s)

echo "==> Step 1/7: Verify snapshot integrity"
test -d "$SNAPSHOT_DIR" || { echo "ERROR: $SNAPSHOT_DIR not found" >&2; exit 1; }
test -f "$SNAPSHOT_DIR/store/messages.db" || { echo "ERROR: messages.db missing" >&2; exit 1; }
test -f "$SNAPSHOT_DIR/data/taskflow/taskflow.db" || { echo "ERROR: taskflow.db missing" >&2; exit 1; }
test -f "$SNAPSHOT_DIR/md5.txt" || { echo "ERROR: md5.txt baseline missing" >&2; exit 1; }
( cd "$SNAPSHOT_DIR" && md5sum -c md5.txt ) || { echo "ERROR: snapshot integrity check FAILED" >&2; exit 1; }
echo "    snapshot integrity ok"

echo ""
echo "==> Step 2/7: Stop v2 service on prod"
ssh_run "systemctl --user stop nanoclaw"

echo ""
echo "==> Step 3/7: Reset prod git tree to $V1_SHA"
# We git reset --hard. If V1_SHA is unreachable (e.g. it was on a branch that was force-pushed),
# this will fail loudly — better than silent partial rollback.
ssh_run "cd $PROD_PATH && git fetch origin --no-tags && git reset --hard $V1_SHA"

echo ""
echo "==> Step 4/7: Restore DBs from snapshot"
scp_run "$SNAPSHOT_DIR/store/messages.db"           "$PROD_PATH/store/messages.db"
scp_run "$SNAPSHOT_DIR/data/taskflow/taskflow.db"   "$PROD_PATH/data/taskflow/taskflow.db"
# Defensive: nuke any leftover SQLite WAL/SHM from v2 to avoid v2 schema bleeding into v1.
ssh_run "rm -f $PROD_PATH/store/messages.db-wal $PROD_PATH/store/messages.db-shm $PROD_PATH/data/taskflow/taskflow.db-wal $PROD_PATH/data/taskflow/taskflow.db-shm"

echo ""
echo "==> Step 5/7: Re-tag v1-rollback image as nanoclaw-agent:latest"
# If the v1-rollback tag was lost (rare), restore from /home/nanoclaw/backup/v1-image.tar
ssh_run "sudo -n docker image inspect nanoclaw-agent:v1-rollback >/dev/null 2>&1 || sudo -n docker load -i /home/nanoclaw/backup/v1-image.tar"
ssh_run "sudo -n docker tag nanoclaw-agent:v1-rollback nanoclaw-agent:latest"

echo ""
echo "==> Step 6/7: Restart service"
ssh_run "systemctl --user start nanoclaw"

echo ""
echo "==> Step 7/7: Verify active (10s settle window)"
if [ "$DRY_RUN" != "1" ]; then sleep 10; fi
ssh_run "systemctl --user is-active nanoclaw"

ELAPSED=$(( $(date +%s) - START_TIME ))
echo ""
echo "✓ Rollback complete in ${ELAPSED}s. Service is active on $PROD_HOST."
echo "  Verify externally: send a WhatsApp message to a TaskFlow group and confirm response."
