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
# shellcheck source=setup/add-taskflow/lib.sh
source "$ROOT/setup/add-taskflow/lib.sh"   # read_copyset / resolve_import / relative_specs

# The core-registry functions wired specifically through the 4 INSTALLER BARRELS
# (NOT provider/channel/FastAPI-entry registrars — those load via their own roots,
# which this check does not model). A copy-set file that calls one of these at top
# level MUST be reachable from an append seed or it ships inert.
#
# Detection caveats Codex flagged and how they're handled:
#  - assignment form: catch both a BARE statement and an assignment LHS
#    (`const h = registerEmitHook(`, `export const h = await registerEmitHook(`).
#    Anchored at line-start so `//` / `*` comment lines never match.
#  - test files are EXCLUDED below: they run under the test runner, never load via
#    a production barrel, so "ships inert" is meaningless for them.
#  RESIDUAL (documented bound): this NAME list is maintenance-required — a NEW
#  contract's barrel-wired registrar must be added here. A purely structural
#  `register[A-Z]…(` shape match was rejected: it false-flags the provider
#  (registerProvider), channel (registerChannel) and FastAPI-seam registrars that
#  are wired via OTHER roots this check doesn't seed. Full self-maintenance would
#  require modeling those roots (entrypoints + whole-file overwrites) — NICE TODO.
REG_NAME='(registerBootStep|registerSystemPromptAddendum|registerMigration|registerContainerContributor|registerStartupHook|registerDueMessageGate|registerTaskScriptSanitizer|registerOutboundTransform|registerEmitHook|registerExtraDb|registerTestSchema|registerDeliveryAction|setUnroutedDmResolver|registerHostSweepHook|registerMigrateV2Step|registerBackfillStep)'
REGISTRANT_RE="^[[:space:]]*((export[[:space:]]+)?(const|let|var)[[:space:]]+[A-Za-z0-9_\$]+[[:space:]]*=[[:space:]]*(await[[:space:]]+)?)?${REG_NAME}\("

[ -f "$COPY_SET" ] || { echo "FAIL: copy-set not found: $COPY_SET"; exit 1; }
cd "$ROOT"

# --- copy-set membership (repo-relative paths) ---------------------------------
declare -A IN_COPYSET=()
COPYSET_PATHS=()
while IFS= read -r p; do IN_COPYSET["$p"]=1; COPYSET_PATHS+=("$p"); done < <(read_copyset "$COPY_SET")

fail=0

# --- seeds: resolve each append import; Check A (no dangling append) -----------
# Seed the BFS reachable-set directly (no separate seeds[] array): add_seed marks
# a node reached and enqueues it — used both to seed and inside the BFS.
declare -A REACHED=()
frontier=()
add_seed() { [ -z "${REACHED[$1]:-}" ] && { REACHED["$1"]=1; frontier+=("$1"); }; }
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
    add_seed "$target"
  done
}
check_appendset "$MODULES_BARREL" "${MODULES_IMPORTS[@]}"
check_appendset "$MCP_BARREL"     "${MCP_IMPORTS[@]}"
check_appendset "$MIGRATE_BARREL" "${MIGRATE_IMPORTS[@]}"
check_appendset "$EXT_BARREL"     "${EXT_IMPORTS[@]}"

# --- BFS reachability over overlay relative imports (frontier already seeded) --
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
  case "$p" in *.test.ts) continue ;; esac   # test files load via the runner, never a barrel
  grep -qE "$REGISTRANT_RE" "$p" || continue
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
