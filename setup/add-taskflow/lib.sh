#!/usr/bin/env bash
#
# Shared primitives for the /add-taskflow installer + its boundary guardrails.
# Sibling of append-sets.sh — the single home for the copy-set / import-resolution
# helpers that were otherwise hand-rewritten in every script. Source after $ROOT
# is set; source-only, no side effects.

# Emit the cleaned copy-set: strip inline `#` comments + leading/trailing
# whitespace, drop blank lines. One repo-relative path per line. $1 = copy-set path.
read_copyset() {
  local raw p
  while IFS= read -r raw; do
    p="${raw%%#*}"
    p="$(printf '%s' "$p" | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
    [ -n "$p" ] && printf '%s\n' "$p"
  done < "$1"
}

# Resolve a relative import spec (./x.js, ../db/y.js) seen in file $1 to a path
# relative to $3 (default $ROOT), mapping `.js` -> `.ts`. Empty for non-relative
# specifiers (bare package imports).
resolve_import() {
  local from_file=$1 spec=$2 root="${3:-$ROOT}" target
  case "$spec" in ./*|../*) ;; *) return 0 ;; esac
  target="$(realpath -m --relative-to="$root" "$root/$(dirname "$from_file")/$spec")"
  printf '%s\n' "${target%.js}.ts"
}

# Extract relative import/from specifiers ('./x.js', '../y.js') from TS file $1.
# Covers side-effect `import './x'`, `... from './x'`, and re-exports.
relative_specs() {
  grep -oE "(from|import)[[:space:]]+'(\.[^']+)'" "$1" 2>/dev/null \
    | grep -oE "'\.[^']+'" | tr -d "'" || true
}
