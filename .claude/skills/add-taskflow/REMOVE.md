# Remove TaskFlow

Reverses `/add-taskflow` (`setup/add-taskflow.sh`): it (1) copies the overlay
files listed in `setup/add-taskflow/copy-set.txt`, (2) appends 4 barrel
self-registration imports (`setup/add-taskflow/append-sets.sh`), and (3) builds.
Unlike a single channel, TaskFlow spans host `src/`, the container, `setup/`, and
DB migrations — so removal restores the upstream baselines of the whole-file
overlays it overwrote. Returning to pristine core is exactly what
`core/nanoclaw-pristine` already is; this is the per-install version of that.

Run from the repo root. `BASELINE` is upstream `8d57bdfa` (v2.0.54) — or the
commit you were on **before** `/add-taskflow`, if you have it.

```bash
BASELINE=8d57bdfa   # upstream nanoclaw baseline, or your pre-install commit

# 1. Strip the 4 appended barrel imports (idempotent — only removes our lines).
#    The append-sets are the source of truth the installer used.
source setup/add-taskflow/append-sets.sh
strip() { local file=$1; shift; local line
  for line in "$@"; do
    grep -vF "$line" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  done
}
strip "$MODULES_BARREL"  "${MODULES_IMPORTS[@]}"
strip "$MCP_BARREL"      "${MCP_IMPORTS[@]}"
strip "$MIGRATE_BARREL"  "${MIGRATE_IMPORTS[@]}"
strip "$EXT_BARREL"      "${EXT_IMPORTS[@]}"

# 2. Delete every overlay file in the copy-set.
grep -vE '^\s*#' setup/add-taskflow/copy-set.txt \
  | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//' | grep -v '^$' \
  | while IFS= read -r p; do rm -f "$p"; done

# 3. Restore the 5 whole-file overlays OF UPSTREAM FILES the install overwrote
#    (deleting them in step 2 would otherwise break the build — the core entry
#    index.ts / mcp-tools/core.ts import them, and setup invokes groups.ts).
for f in \
  container/agent-runner/src/poll-loop.ts \
  container/agent-runner/src/current-batch.ts \
  container/agent-runner/src/providers/claude.ts \
  container/agent-runner/src/providers/factory.test.ts \
  setup/migrate-v2/groups.ts ; do
  git checkout "$BASELINE" -- "$f"
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
