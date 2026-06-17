#!/usr/bin/env bash
#
# Split-boundary guardrail (ADR 0006). Catches copy-set drift / misclassification
# automatically — the class of bug that put generic-core well-formed.ts into the
# overlay copy-set (a core file imported it, so a pristine-core install would
# break). Run in CI on split/core-extensions and after editing the copy-set.
#
# Asserts, against a throwaway worktree with the overlay (copy-set) DELETED:
#   1. PRISTINE-CORE HOST build is GREEN — core never depends on the overlay.
#      (A misclassified core file in the copy-set => a core import goes missing
#       => host build red.)
#   2. The container `tsc --noEmit` fails ONLY on the documented container seams
#      (ADR 0006 open item). Any OTHER core->overlay TS2307 is a NEW leak or a
#      fresh misclassification and fails the gate.
#
# Exits 0 = boundary intact; non-zero with the offending import(s) otherwise.
# The branch is never modified (separate worktree, cleaned up on exit).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COPY_SET="$ROOT/setup/add-taskflow/copy-set.txt"

# Documented, accepted container seams (ADR 0006 "Open items"). Keep in sync.
# Both are UPSTREAM-shaped imports of whole-file overlays (runPollLoop and
# getCurrentInReplyTo exist in upstream), so the container is overlay-inclusive
# by design: container index.ts -> ./poll-loop.js (turn runtime);
# mcp-tools/core.ts -> ../current-batch.js. (memory.js was decoupled via the
# extension registry — it is no longer a core->overlay import.)
ALLOWED_SEAMS='poll-loop\.js|current-batch\.js'

[ -f "$COPY_SET" ] || { echo "FAIL: copy-set not found: $COPY_SET"; exit 1; }

WT="$(mktemp -d)/nc-split-boundary"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$ROOT" worktree add --detach "$WT" HEAD >/dev/null 2>&1

# Reuse the main worktree's installed deps.
ln -s "$ROOT/node_modules" "$WT/node_modules" 2>/dev/null || true
ln -s "$ROOT/container/agent-runner/node_modules" "$WT/container/agent-runner/node_modules" 2>/dev/null || true
cd "$WT"

# Delete the overlay (every path in the copy-set) -> pristine core.
while IFS= read -r raw; do
  p="${raw%%#*}"; p="$(printf '%s' "$p" | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
  [ -z "$p" ] && continue
  rm -f "$WT/$p"
done < "$COPY_SET"

# 1. Pristine-core HOST build must be green.
if ! pnpm run build >/tmp/split-boundary-host.log 2>&1; then
  echo "FAIL: pristine-core HOST build is RED — a CORE file imports an overlay (copy-set) file."
  grep -E "error TS2307" /tmp/split-boundary-host.log | head || tail -10 /tmp/split-boundary-host.log
  exit 1
fi

# 2. Container tsc: only the documented seams may be unresolved.
errs="$(pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit 2>&1 | grep "error TS2307" || true)"
bad="$(printf '%s\n' "$errs" | grep -vE "$ALLOWED_SEAMS" | grep "error TS2307" || true)"
if [ -n "$bad" ]; then
  echo "FAIL: NEW core->overlay leak beyond the documented container seams:"
  printf '%s\n' "$bad"
  exit 1
fi

echo "OK: split boundary intact — pristine-core host build green; container core->overlay imports limited to the documented seams."
