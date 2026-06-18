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
# shellcheck source=setup/add-taskflow/lib.sh
source "$ROOT/setup/add-taskflow/lib.sh"   # read_copyset / resolve_import / relative_specs

# Documented, accepted container seams (ADR 0006 "Open items"). Keep in sync with
# the whole-file-overlay block in copy-set.txt — these two are the SUBSET that
# produce a core->overlay TS2307 (container index.ts -> ./poll-loop.js turn
# runtime; mcp-tools/core.ts -> ../current-batch.js). claude.ts/groups.ts are
# also whole-file overlays but don't leak a core import, so they're NOT here.
# (memory.js was decoupled via the extension registry — no longer a core import.)
ALLOWED_SEAMS='poll-loop\.js|current-batch\.js'

[ -f "$COPY_SET" ] || { echo "FAIL: copy-set not found: $COPY_SET"; exit 1; }

# Copy-set membership, built ONCE — reused for the overlay delete AND arm 3.
declare -A IN_COPYSET=()
while IFS= read -r p; do IN_COPYSET["$p"]=1; done < <(read_copyset "$COPY_SET")

WT="$(mktemp -d)/nc-split-boundary"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$ROOT" worktree add --detach "$WT" HEAD >/dev/null 2>&1

# Reuse the main worktree's installed deps.
ln -s "$ROOT/node_modules" "$WT/node_modules" 2>/dev/null || true
ln -s "$ROOT/container/agent-runner/node_modules" "$WT/container/agent-runner/node_modules" 2>/dev/null || true
cd "$WT"

# Delete the overlay (every path in the copy-set) -> pristine core.
for p in "${!IN_COPYSET[@]}"; do rm -f "$WT/$p"; done

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

# 3. setup/ steps run as `tsx` SUBPROCESSES — `pnpm run build` never compiles
#    them, so a core setup step importing an overlay file (e.g. migrate-v2
#    groups.ts/destinations.ts -> modules/taskflow/*) slips past arm 1. Assert no
#    surviving setup/ file imports a path that IS in the copy-set. (Membership,
#    not filesystem existence — a missing channel file like telegram-pairing.js,
#    absent because that channel isn't installed, is NOT an overlay leak.)
#    Reuses the IN_COPYSET set built once above.
setup_bad=""
while IFS= read -r f; do
  rel="${f#"$WT/"}"
  while IFS= read -r spec; do
    case "$spec" in *.js) ;; *) continue ;; esac
    tgt="$(resolve_import "$rel" "$spec" "$WT")"
    [ -n "${IN_COPYSET[$tgt]:-}" ] && setup_bad+="$rel -> $spec (copy-set overlay)"$'\n'
  done < <(relative_specs "$f")
done < <(find "$WT/setup" -name '*.ts' 2>/dev/null)
if [ -n "$setup_bad" ]; then
  echo "FAIL: a setup/ step imports an overlay (copy-set) path — core->overlay leak the build-only check misses:"
  printf '%s' "$setup_bad"
  exit 1
fi

echo "OK: split boundary intact — pristine-core host build green; container + setup core->overlay imports limited to the documented seams."
