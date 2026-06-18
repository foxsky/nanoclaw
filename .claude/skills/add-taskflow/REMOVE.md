# Remove TaskFlow

Reverses `/add-taskflow` (`setup/add-taskflow.sh`): it (1) copies the overlay
files listed in `setup/add-taskflow/copy-set.txt`, (2) appends 4 barrel
self-registration imports (`setup/add-taskflow/append-sets.sh`), and (3) builds.
Unlike a single channel, TaskFlow spans host `src/`, the container, `setup/`, and
DB migrations — so removal restores the **pre-install** versions of the whole-file
overlays it overwrote. Returning to pristine core is exactly what
`core/nanoclaw-pristine` already is; this is the per-install version of that.

Run from the repo root. `PRE_INSTALL` must be **the core you installed ONTO,
before `/add-taskflow`** — its versions of the overwritten files are restored.
Default `origin/core/nanoclaw-pristine` (the published pristine core). Use YOUR
pre-install commit if you installed onto a different core. **Do NOT use raw
upstream `8d57bdfa`** unless you then re-add the `poll-loop.ts` compat shim
(`assistantName?`/`agentGroupId?` on `PollLoopConfig`) — core `index.ts` passes
those and the raw-upstream poll-loop rejects them, re-breaking the build.

```bash
set -euo pipefail
PRE_INSTALL=origin/core/nanoclaw-pristine   # pre-install core ref (see above)

# 0. Preflight. Only act on an INSTALLED tree, and verify the restore source has
#    every file we may need to put back — fail loud rather than half-remove.
[ -f src/modules/taskflow/index.ts ] || { echo "TaskFlow not installed — nothing to remove."; exit 0; }
git rev-parse --verify "$PRE_INSTALL" >/dev/null 2>&1 || { echo "PRE_INSTALL ref '$PRE_INSTALL' not found (git fetch it, or set your pre-install commit)."; exit 1; }

mapfile -t OVERLAY < <(grep -vE '^\s*#' setup/add-taskflow/copy-set.txt \
  | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//' | grep -v '^$')

# 1. Strip the 4 appended barrel imports. Exact-WHOLE-line match (-x) so a line
#    that is a substring of a legit import is never touched; `|| true` so a fully-
#    emptied or no-match barrel (grep exit 1) doesn't abort under `set -e`.
source setup/add-taskflow/append-sets.sh
strip() { local file=$1; shift; local line
  for line in "$@"; do
    { grep -vxF "$line" "$file" || true; } > "$file.tmp"
    mv "$file.tmp" "$file"
  done
}
strip "$MODULES_BARREL"  "${MODULES_IMPORTS[@]}"
strip "$MCP_BARREL"      "${MCP_IMPORTS[@]}"
strip "$MIGRATE_BARREL"  "${MIGRATE_IMPORTS[@]}"
strip "$EXT_BARREL"      "${EXT_IMPORTS[@]}"

# 2. Delete every overlay file in the copy-set.
for p in "${OVERLAY[@]}"; do rm -f "$p"; done

# 3. Restore each overlay file that ALSO existed pre-install — i.e. the whole-file
#    overlays of upstream files (poll-loop/current-batch/claude/factory.test/groups
#    + any upstream test the overlay replaced). Purely-new overlay files have no
#    pre-install version and stay deleted. PRE_INSTALL (not raw upstream) keeps the
#    poll-loop compat shim, so the un-overwritten core index.ts still typechecks.
for p in "${OVERLAY[@]}"; do
  git cat-file -e "$PRE_INSTALL:$p" 2>/dev/null && git checkout "$PRE_INSTALL" -- "$p" || true
done

# 4. Rebuild host + container.
pnpm run build && ./container/build.sh
```

## Leaves behind (manual / by design)

- **DB columns + rows.** The TaskFlow migrations (e.g. `messaging_groups.is_main_control`,
  `taskflow.db`) already ran. Removing the migration files does NOT drop the columns —
  they are additive and harmless to leave. To fully reset, drop `data/taskflow.db` and the
  added columns by hand (no automatic down-migration).
- **Container deps.** The overlay is source-only, so `container/agent-runner/package.json`
  normally did not change. If it did, revert it and run `bun install` there.
- **`.env` / runtime config.** Any `TASKFLOW_*` vars you set (e.g. `TASKFLOW_OTP_DELIVERY`,
  `TASKFLOW_HOLIDAY_EXEMPT`) are inert once the code is gone; remove them at will.
- **Per-board group folders** under `groups/` created by provisioning are not touched.

## Verify

`pnpm run build` green; `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
green; `git status` shows only the intended removals. (Equivalent end-state:
`setup/add-taskflow/check-split-boundary.sh` passes — pristine core, no overlay.)
