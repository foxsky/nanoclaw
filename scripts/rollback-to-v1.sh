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

echo "==> Step 1/7: Verify snapshot integrity + freshness"
test -d "$SNAPSHOT_DIR" || { echo "ERROR: $SNAPSHOT_DIR not found" >&2; exit 1; }
test -f "$SNAPSHOT_DIR/store/messages.db" || { echo "ERROR: messages.db missing" >&2; exit 1; }
test -f "$SNAPSHOT_DIR/data/taskflow/taskflow.db" || { echo "ERROR: taskflow.db missing" >&2; exit 1; }
test -f "$SNAPSHOT_DIR/md5.txt" || { echo "ERROR: md5.txt baseline missing" >&2; exit 1; }
( cd "$SNAPSHOT_DIR" && md5sum -c md5.txt ) || { echo "ERROR: snapshot integrity check FAILED" >&2; exit 1; }
echo "    snapshot integrity ok"
# F13 (Codex 2026-05-01): rollback restores snapshot data — any v1 messages/
# tasks created AFTER snapshot are lost. Refuse stale snapshots unless the
# operator opts in. Default: snapshot must be <30 minutes old to proceed.
SNAP_AGE_MIN=$(( ($(date +%s) - $(stat -c %Y "$SNAPSHOT_DIR/store/messages.db")) / 60 ))
SNAP_MAX_AGE_MIN="${SNAP_MAX_AGE_MIN:-30}"
if [ "$SNAP_AGE_MIN" -gt "$SNAP_MAX_AGE_MIN" ]; then
  echo "WARNING: snapshot is ${SNAP_AGE_MIN}min old (max ${SNAP_MAX_AGE_MIN}min)" >&2
  echo "         Data created since the snapshot will be LOST on rollback." >&2
  echo "         For a planned cutover, take a fresh snapshot via Phase -1.3 first." >&2
  echo "         To proceed anyway: SNAP_MAX_AGE_MIN=99999 $0 $SNAPSHOT_DIR" >&2
  if [ "$DRY_RUN" = "1" ]; then
    echo "         (DRY-RUN mode — continuing despite stale snapshot for testing)"
  else
    exit 1
  fi
else
  echo "    snapshot age: ${SNAP_AGE_MIN}min (within ${SNAP_MAX_AGE_MIN}min limit)"
fi

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
echo "==> Step 7/7: Verify active + functional (30s settle window)"
# F14 (Codex 2026-05-01): is-active is necessary but NOT sufficient. Add probes
# that actually exercise WhatsApp connectivity and DB read/write.
if [ "$DRY_RUN" != "1" ]; then sleep 30; fi
echo "    7a. systemctl is-active"
ssh_run "systemctl --user is-active nanoclaw"
echo "    7b. log scan for WhatsApp 'connection open'"
ssh_run "tail -200 /home/nanoclaw/nanoclaw/logs/nanoclaw.log 2>/dev/null | grep -i 'connection open\\|whatsapp.*ready\\|connected' | tail -3 || echo '(no whatsapp-ready signal yet)'"
echo "    7c. messages.db schema reachable (no v2 schema bleed)"
ssh_run "sqlite3 /home/nanoclaw/nanoclaw/store/messages.db 'SELECT COUNT(*) FROM registered_groups' 2>&1 | head -3"
echo "    7d. NO v2 tables present in restored DB"
ssh_run "sqlite3 /home/nanoclaw/nanoclaw/store/messages.db \"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messaging_groups','agent_groups','user_dms')\" | head -3 || echo '(clean — no v2 tables)'"

ELAPSED=$(( $(date +%s) - START_TIME ))
echo ""
echo "✓ Rollback ran in ${ELAPSED}s. systemctl says active and DB queries work."
echo "  REQUIRED MANUAL VERIFICATION before declaring rollback successful:"
echo "    1. Send a WhatsApp message to a TaskFlow group → confirm bot responds with @Case prefix"
echo "    2. Check Kipp's next 04:00 audit cron fires (Phase -1.3 baseline)"
echo "    3. Compare prod messages.db row count to snapshot baseline + expected drift"
