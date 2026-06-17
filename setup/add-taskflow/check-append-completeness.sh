#!/usr/bin/env bash
#
# Append-completeness guardrail (ADR 0006, "Security-critical append
# completeness"). The companion to check-split-boundary.sh.
#
# The core barrels ship PRISTINE — they do NOT import any overlay file. The
# ONLY thing that loads an overlay's top-level side-effect registration
# (registerEmitHook board gates, the web-origin anti-spoof outbound transform,
# migrations, boot hooks, …) is the installer's grep-then-append step. So a
# registrant that is in the copy-set but NOT reachable from an append import
# ships COPIED-BUT-NEVER-IMPORTED: silently inert. For the SEC gates that means
# in-container chat tools ship UNGATED. Nothing else catches this class.
#
# This asserts, against the real worktree (overlay present):
#   A. No DANGLING append — every append import resolves to a copy-set file.
#   B. No ORPHAN registrant — every copy-set file with a top-level register*()
#      call is REACHABLE (BFS over relative imports) from an append seed.
#
# Append-sets are read from the shared source of truth append-sets.sh, so the
# installer and this check can never drift. Exits 0 = wiring complete.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COPY_SET="$ROOT/setup/add-taskflow/copy-set.txt"
# shellcheck source=setup/add-taskflow/append-sets.sh
source "$ROOT/setup/add-taskflow/append-sets.sh"

# Top-level self-registration calls a copy-set file may use to wire into a core
# registry. A file matching any of these (at line start) MUST be reachable from
# an append seed or it ships inert. Keep in sync with the extension contracts.
REGISTER_CALLS='registerBootStep|registerSystemPromptAddendum|registerMigration|registerContainerContributor|registerStartupHook|registerDueMessageGate|registerTaskScriptSanitizer|registerOutboundTransform|registerEmitHook|registerExtraDb|registerTestSchema|registerDeliveryAction|setUnroutedDmResolver|registerHostSweepHook|registerMigrateV2Step|registerBackfillStep'

[ -f "$COPY_SET" ] || { echo "FAIL: copy-set not found: $COPY_SET"; exit 1; }
cd "$ROOT"

# --- copy-set membership (repo-relative paths) ---------------------------------
declare -A IN_COPYSET=()
COPYSET_PATHS=()
while IFS= read -r raw; do
  p="${raw%%#*}"; p="$(printf '%s' "$p" | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
  [ -z "$p" ] && continue
  IN_COPYSET["$p"]=1
  COPYSET_PATHS+=("$p")
done < "$COPY_SET"

# Resolve an import spec (./x.js, ../db/y.js) seen in $1's dir to a repo-relative
# .ts path. Empty if the spec isn't relative.
resolve_import() {
  local from_file=$1 spec=$2
  case "$spec" in
    ./*|../*) ;;
    *) return 0 ;;
  esac
  local dir target
  dir="$(dirname "$from_file")"
  target="$(realpath -m --relative-to="$ROOT" "$ROOT/$dir/$spec")"
  printf '%s\n' "${target%.js}.ts"
}

# Extract relative import/from specifiers from a file (covers side-effect
# `import './x.js'`, `... from './x.js'`, and re-exports `export ... from`).
relative_specs() {
  grep -oE "(from|import)[[:space:]]+'(\.[^']+)'" "$1" 2>/dev/null \
    | grep -oE "'\.[^']+'" | tr -d "'" || true
}

fail=0

# --- seeds: resolve each append import; Check A (no dangling append) -----------
seeds=()
check_appendset() {
  local barrel=$1; shift
  local line spec target
  for line in "$@"; do
    spec="$(printf '%s' "$line" | grep -oE "'\.[^']+'" | tr -d "'")"
    [ -z "$spec" ] && continue
    target="$(resolve_import "$barrel" "$spec")"
    if [ -z "${IN_COPYSET[$target]:-}" ]; then
      echo "FAIL(A): append into $barrel imports '$spec' -> $target, which is NOT in the copy-set (dangling append)."
      fail=1
      continue
    fi
    seeds+=("$target")
  done
}
check_appendset "$MODULES_BARREL" "${MODULES_IMPORTS[@]}"
check_appendset "$MCP_BARREL"     "${MCP_IMPORTS[@]}"
check_appendset "$MIGRATE_BARREL" "${MIGRATE_IMPORTS[@]}"
check_appendset "$EXT_BARREL"     "${EXT_IMPORTS[@]}"

# --- BFS reachability over overlay relative imports ---------------------------
declare -A REACHED=()
frontier=()
for s in "${seeds[@]}"; do
  [ -z "${REACHED[$s]:-}" ] && { REACHED["$s"]=1; frontier+=("$s"); }
done
while [ ${#frontier[@]} -gt 0 ]; do
  next=()
  for f in "${frontier[@]}"; do
    [ -f "$f" ] || continue
    while IFS= read -r spec; do
      [ -z "$spec" ] && continue
      tgt="$(resolve_import "$f" "$spec")"
      [ -z "$tgt" ] && continue
      # Only traverse edges that stay within the overlay.
      [ -n "${IN_COPYSET[$tgt]:-}" ] || continue
      if [ -z "${REACHED[$tgt]:-}" ]; then REACHED["$tgt"]=1; next+=("$tgt"); fi
    done < <(relative_specs "$f")
  done
  frontier=("${next[@]}")
done

# --- Check B: every registrant must be reachable ------------------------------
for p in "${COPYSET_PATHS[@]}"; do
  [ -f "$p" ] || continue
  grep -qE "^[[:space:]]*($REGISTER_CALLS)\(" "$p" || continue
  if [ -z "${REACHED[$p]:-}" ]; then
    echo "FAIL(B): $p self-registers (top-level register*()) but is NOT reachable from any installer append seed — it would ship COPIED-BUT-INERT."
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Append-completeness check FAILED — see above. Fix the installer append-set in setup/add-taskflow/append-sets.sh."
  exit 1
fi
echo "OK: append-completeness intact — every copy-set registrant is reachable from an installer append; no dangling appends."
