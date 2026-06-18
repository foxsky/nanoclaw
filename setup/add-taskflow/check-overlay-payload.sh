#!/usr/bin/env bash
#
# Payload/copy-set drift guardrail (Codex O4). The `taskflow-overlay` branch is
# the payload-only half of the split — it must hold EXACTLY the files the
# installer copies (the copy-set), no more, no less. Nothing else catches drift
# (e.g. a new overlay file added to split + copy-set but not pushed to the payload
# branch, or a stray core file leaking onto the payload).
#
# Asserts, against the payload branch's tree (no checkout):
#   1. Every non-comment copy-set path EXISTS on the payload branch.
#   2. The ONLY non-copy-set file on the branch is README.md (the payload's own).
#   3. The 4 installer barrels (core append targets) are NOT on the payload.
#
# Branch via $1 or $TASKFLOW_BRANCH (default taskflow-overlay; falls back to
# origin/<branch>). Exits 0 = payload in sync.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COPY_SET="$ROOT/setup/add-taskflow/copy-set.txt"
BR="${1:-${TASKFLOW_BRANCH:-taskflow-overlay}}"
# shellcheck source=setup/add-taskflow/append-sets.sh
source "$ROOT/setup/add-taskflow/append-sets.sh"
# shellcheck source=setup/add-taskflow/lib.sh
source "$ROOT/setup/add-taskflow/lib.sh"   # read_copyset

# Resolve the branch ref (local first, then origin/).
ref=""
for cand in "$BR" "origin/$BR"; do
  if git -C "$ROOT" rev-parse --verify "$cand" >/dev/null 2>&1; then ref="$cand"; break; fi
done
[ -n "$ref" ] || { echo "FAIL: payload branch '$BR' not found (local or origin)."; exit 1; }

declare -A ON_BRANCH=()
while IFS= read -r f; do ON_BRANCH["$f"]=1; done < <(git -C "$ROOT" ls-tree -r --name-only "$ref")

declare -A IN_COPYSET=()
fail=0
while IFS= read -r p; do
  IN_COPYSET["$p"]=1
  # 1. every copy-set path must be on the payload branch.
  [ -n "${ON_BRANCH[$p]:-}" ] || { echo "FAIL(1): copy-set path missing from $ref: $p"; fail=1; }
done < <(read_copyset "$COPY_SET")

# 2. the only non-copy-set file allowed on the payload is README.md.
for f in "${!ON_BRANCH[@]}"; do
  [ -n "${IN_COPYSET[$f]:-}" ] && continue
  [ "$f" = "README.md" ] && continue
  echo "FAIL(2): $ref carries a file not in the copy-set (drift / core leak): $f"; fail=1
done

# 3. the core barrels must never live on the payload.
for b in "$MODULES_BARREL" "$MCP_BARREL" "$MIGRATE_BARREL" "$EXT_BARREL"; do
  [ -n "${ON_BRANCH[$b]:-}" ] && { echo "FAIL(3): core barrel leaked onto the payload: $b"; fail=1; }
done

if [ "$fail" -ne 0 ]; then
  echo "Payload/copy-set drift — re-cut $BR from split (orphan-commit the copy-set + README)."
  exit 1
fi
echo "OK: $ref payload in sync — holds exactly the copy-set ($(grep -vcE '^\s*#|^\s*$' "$COPY_SET") files) + README; no core leak."
