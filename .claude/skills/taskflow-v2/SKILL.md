---
name: taskflow-v2
description: Add TaskFlow (Kanban+GTD task management) on a NanoClaw v2 install. Code on the skill/taskflow-v2 branch; this skill installs it.
---

# TaskFlow v2 — Kanban+GTD Task Management

This skill installs TaskFlow's v2-architecture port. The actual code (TaskFlow engine, MCP tools, host-side mounts, scheduler integration) lives on the `skill/taskflow-v2` git branch and is installed by merging that branch.

**Status (2026-05-09):** the code branch is feature-complete on the v2 architecture but still soaking before first cutover. Sub-task 2.3.x (5 ipc-plugin handlers + bun:sqlite engine + 9 mutate MCP tools + scheduling migration + container mount) ports done. Phase 3 (per-board setup) instructions below are provisional — finalize during the first board provision.

## Capabilities

What TaskFlow v2 ships (delta vs the v1 `add-taskflow` skill):

- All v1 user-facing features (board topology, WIP limits, quick capture, standup/digest/review runners, meetings, cross-board subtasks, holiday calendar, undo, audit) — re-implemented on the v2 architecture, not ported as v1 commits.
- v2-native scheduling: `messages_in` rows with `kind='task'`, `process_after` (UTC), `recurrence` (cron in `TIMEZONE`). No `scheduled_tasks` table after migration.
- v2-native session DBs: per-session `inbound.db` + `outbound.db` (host writes inbound, container writes outbound). Heartbeat is a file touch, not a row update.
- v2-native permissions: `is_main_control` per-CHAT gate; admin-approval flow via `pickApprover` → operator DM → `pending_approval` row.
- v2-native delivery: 5 delivery actions ported as MCP tool + handler pairs (send_otp, provision_root_board, provision_child_board, create_group, add_destination).
- TaskFlow engine on `bun:sqlite` with `journal_mode=DELETE` (cross-mount safe; `host.docker.internal` taskflow.db mount).

## Phase 1: Pre-flight

### Check baseline

```bash
# NanoClaw v2 host? (looks for a v2-only file path)
test -f src/db/migrations/index.ts && echo "v2: OK" || { echo "v2 baseline missing"; exit 1; }

# WhatsApp adapter present AND has the fork-extension primitives TaskFlow needs?
grep -q "from './whatsapp" src/channels/index.ts && \
grep -q "createGroup\|lookupPhoneJid\|resolvePhoneJid" src/channels/whatsapp.ts \
  && echo "whatsapp+extensions: OK" \
  || echo "whatsapp adapter or extensions missing"
```

If v2 baseline is missing, the host is on a pre-v2 NanoClaw version. Two cases:

- **Legacy v1 install** (host was on v1.x.x): `/update-nanoclaw` won't work — v1→v2 is an architecture rewrite, not a merge. Run `bash migrate-v2.sh` first (upstream's platform migrator), then `/migrate-from-v1` for cleanup, then re-run this skill's Phase 1.
- **Up-to-date v2 with stale main**: `/update-nanoclaw` is the right tool — bring main current with `upstream/main`, then re-run Phase 1.

If unsure: `git log --oneline | grep -E "v1\.|v2 phase"` — v1.x version commits indicate case 1, v2 phase commits indicate case 2.

If WhatsApp is missing or the extensions aren't there, install `/add-whatsapp` (upstream's adapter) and `/whatsapp-fixes` (fork-only extensions: `createGroup`, `lookupPhoneJid`, `resolvePhoneJid`).

### Dependency note: whatsapp-fixes

`skill/taskflow-v2` is built on top of `skill/whatsapp-fixes-v2` by branch ancestry — merging `taskflow-v2` brings in the WhatsApp extensions automatically. To verify (after Phase 2 merge):

```bash
git merge-base --is-ancestor origin/skill/whatsapp-fixes-v2 HEAD \
  && echo "whatsapp-fixes-v2: included" \
  || echo "whatsapp-fixes-v2: NOT included — investigate"
```

If you have an older `skill/whatsapp-fixes` (v1, no `-v2` suffix) merge on `main` from a prior install, that's a different history; the v2 dependency is the `-v2` branch and is included by ancestry through `skill/taskflow-v2`.

### Existing v1 install?

If `data/taskflow/taskflow.db` exists with v1 board rows OR `.claude/skills/add-taskflow/` is present:

```bash
test -f data/taskflow/taskflow.db && sqlite3 data/taskflow/taskflow.db "SELECT COUNT(*) FROM boards"
```

This is a v1→v2 migration. After Phase 2 below, run `/migrate-from-v1` before any new-board setup.

## Phase 2: Apply Code Changes

### Stop the service first

```bash
# Linux
systemctl --user stop nanoclaw

# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Ensure remote

```bash
git remote -v
```

If `origin` doesn't host `skill/taskflow-v2`, the operator needs to either fetch from the fork that does (typically `git@github.com:foxsky/nanoclaw.git`) or be on a clone that already has it.

```bash
git fetch origin skill/taskflow-v2
```

### Verify branch tip

The remote tip should include a recent merge-forward against `upstream/main` (currently v2.0.54). Check:

```bash
git log --oneline origin/skill/taskflow-v2 | head -3
```

If the latest commit is `Merge upstream/main (...) into skill/taskflow-v2` (or newer), the branch is current. If it's an older skill-branch commit with no upstream merge, the remote is stale — merge-forward at the maintainer host before installing here. Otherwise the install merge below will hit infra conflicts.

### Merge the skill branch

```bash
git checkout main
git merge --no-ff --no-edit origin/skill/taskflow-v2
```

When `origin/skill/taskflow-v2` is current with upstream (the maintenance recipe below keeps it that way), this merge has near-empty conflict surface against a clean `upstream/main`. If conflicts appear in TaskFlow-owned files (`src/modules/taskflow/`, `src/taskflow-mount.ts`, `src/taskflow-db.ts`, container/agent-runner taskflow files), the host's `main` has fork-private edits that overlap with the skill — typically prefer the skill branch version for TaskFlow-owned paths.

**Maintenance recipe for skill maintainers:** the upstream branch-skill model (per `docs/skills-as-branches.md`) calls for CI to merge-forward `main` into `skill/*` branches automatically. This fork's `skill/taskflow-v2` does it manually:

```bash
git checkout skill/taskflow-v2
git fetch upstream main
git tag pre-merge-forward-$(date +%Y%m%d-%H%M%S) HEAD
git merge --no-edit upstream/main
# Resolve conflicts (typically migrations/index.ts and src/index.ts when
# upstream adds new migration entries or new startup-bootstrap steps —
# keep both sides). Then validate:
pnpm install
pnpm exec tsc --noEmit
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test
cd container/agent-runner && bun install --frozen-lockfile && bun test && cd -
./container/build.sh
git push origin skill/taskflow-v2
```

Run this whenever upstream tags a new release (or every ~25 commits, whichever comes first). Two such merges have already landed on this branch (v2.0.0→v2.0.47 in `7ba6e94f`, v2.0.48→v2.0.54 in `75c9d25d`).

### Recommended companion skills

These optional skills layer on top of TaskFlow. Install before or after, in any order:

- **`/add-compact`** — Adds the `/compact` slash command for manual context compaction. TaskFlow boards run 8+ hours/day; context accumulates across standup → digest → review cycles. Install before the first standup if you expect long sessions.
- **`/channel-formatting`** — Markdown → channel-syntax conversion at delivery (WhatsApp, Telegram, Slack). Required only if you wire a TaskFlow board to a non-WhatsApp channel; harmless on WhatsApp-only installs.
- **`/add-reactions`** — WhatsApp emoji reaction support (receive, send, store, search). Useful for lightweight task acks: 👍 = done, 🚀 = in progress, ✋ = blocked, 👀 = reviewing — maps cleanly to Kanban column transitions.
- **`/add-image-vision`**, **`/add-voice-transcription`**, **`/add-pdf-reader`** — Richer ingestion bandwidth. Members can send a photo of a whiteboard, a voice note, or a PDF attachment and the agent parses it into tasks/notes.
- **`/add-taskflow-memory`** — Per-board long-term memory via redislabs/agent-memory-server. Already a fork-private skill.

### Install dependencies + rebuild

```bash
pnpm install --frozen-lockfile
pnpm run build
./container/build.sh
```

The container rebuild is required — the agent-runner side ships new MCP tools that the existing image doesn't have.

### Validate

```bash
pnpm exec tsc --noEmit                                 # host typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
pnpm test                                              # host vitest
cd container/agent-runner && bun test                  # container bun:test
```

All four should pass. If any fail, do not proceed to Phase 3 — the merge needs to be backed out and conflicts re-resolved.

### Restart the service

> **Important — order of operations for v1→v2 migrations:** if Phase 1 detected an existing v1 install, **do not restart the service yet.** Run Phase 4 first; it does the v1→v2 platform migration *before* TaskFlow's scheduler migrator (which runs at startup) sees the database. Skipping ahead to restart here will run `migrateScheduledTasks` against a half-migrated v1 environment.
>
> For fresh installs (no v1 data), it's safe to restart now and skip Phase 4.

```bash
# Linux
systemctl --user start nanoclaw

# macOS
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Phase 3: First-board setup (TODO — finalize on first use)

> **Status:** Phase 3 is intentionally a stub. The v2 provisioning MCP tools exist (`provision_root_board`, `provision_child_board`, `create_group`, `add_destination`) and have unit tests, but end-to-end provisioning hasn't been run against a real WhatsApp group from this branch. The chat-trigger phrasing, required tool fields, and step ordering will be finalized during the first actual provision and this section updated.
>
> **Known fields the tools require** (from the skill branch source):
> - `provision_root_board`: `subject`, `person_id`, `person_name`, `person_phone`, `short_code` (manager seeded as part of provision; the subject is the team/board name)
> - `provision_child_board`: takes a parent reference + the same shape
> - `create_group`: takes a folder + display name + optional config
> - `add_destination`: routing destination wiring
>
> A separate `register_person` flow exists at the engine layer for adding non-manager team members; whether that is exposed as a delivery action or only via direct DB writes is TBD.

### Topology choices (operator decision)

Three topologies (see `docs/isolation-model.md`):
- **agent-shared**: one agent group, one messaging group, one board. Simplest.
- **shared**: one agent group, multiple messaging groups all bound to it.
- **separate agents**: multiple agent groups, each with its own messaging group.

### Per-board model + reasoning_effort (optional cost/quality tuning)

Available since upstream v2.0.52: `container_configs` carries per-agent-group `model` and `reasoning_effort` columns. Different boards can run on different Claude models with different reasoning depth without affecting the trunk default.

Recommended split for TaskFlow boards:

| Workload | Model | Reasoning effort | Why |
|---|---|---|---|
| Daily standup runner | `claude-sonnet-4-6` | `medium` | Routine roll-call, short prompts, fast. Cheaper per turn. |
| Evening digest runner | `claude-sonnet-4-6` | `medium` | Summary-shaped output, well within Sonnet's strength. |
| Weekly review runner | `claude-opus-4-7` | `high` | Cross-task analysis, anomaly detection, recommendation generation — Opus's depth pays off. |
| Cross-board subtask flows | `claude-opus-4-7` | `high` | Multi-board reconciliation; mistakes propagate. |
| Audit (Kipp-style) board | `claude-opus-4-7` | `high` | Adversarial review of a day's mutations needs the strongest model. |

Apply via `ncl groups config update`:

```bash
# Daily-cycle board (cheaper)
ncl groups config update --id <board-agent-group> --model claude-sonnet-4-6 --reasoning-effort medium

# Audit / weekly-review board (deeper)
ncl groups config update --id <audit-agent-group> --model claude-opus-4-7 --reasoning-effort high
```

Verify:

```bash
ncl groups config get --id <agent-group>
```

The setting takes effect on the next container restart for that agent group (`ncl groups restart --id <agent-group>` to apply immediately, or wait for the next user message to trigger a fresh spawn). The trunk default still applies if `model` and `reasoning_effort` are unset on a given group.

Note: the assistant model selection here is independent of the routing/permission model. The agent's *behavior* (TaskFlow CLAUDE.md, MCP tools, gates) is the same; only the LLM backing each turn differs.

### Verify after provisioning

```bash
sqlite3 data/taskflow/taskflow.db <<'EOF'
SELECT COUNT(*) AS boards FROM boards;
SELECT COUNT(*) AS people FROM board_people;
SELECT COUNT(*) AS tasks FROM tasks;
EOF

# Runner tasks live in per-session inbound DBs, not taskflow.db. Pick one:
sqlite3 data/v2-sessions/<session>/inbound.db \
  "SELECT COUNT(*) AS runners FROM messages_in WHERE kind='task' AND recurrence IS NOT NULL"
```

Runners count should be 3 per session (standup, digest, review).

## Phase 4: Migrating from v1 (only if v1 install present)

If Phase 1 detected an existing v1 install:

1. Run `/migrate-from-v1` — this is the upstream-shipped migration skill that handles v1→v2 data conversion. It does NOT migrate TaskFlow board data; it's the platform migration.
2. After platform migration, the scheduler migrator (`migrateScheduledTasks` in `src/modules/taskflow/migrate-scheduled-tasks.ts`) runs at host startup and converts every `active`/`paused` row in `scheduled_tasks` into a `messages_in` row, then drops the legacy table once drained.
3. Board rows in `boards`, `tasks`, `board_people`, `task_history` are preserved as-is; no schema migration needed for those.

For per-board CLAUDE.md regeneration on the new architecture, use the operator's main-control chat to issue:

```
@<assistant-name> regenerate CLAUDE.md for board <board-name>
```

This invokes the v2 board-config refresh path (TODO: link to the MCP tool when finalized).

## Rollback

The skill is a single merge commit on main. To undo:

```bash
git log --oneline | grep "Merge.*skill/taskflow-v2" | head -1
git revert -m 1 <that-merge-commit>
pnpm install --frozen-lockfile
pnpm run build
./container/build.sh
```

**Before restarting the service**, cancel any TaskFlow runner tasks living in per-session `messages_in`. After the revert, the agent-runner won't have TaskFlow MCP tools — recurring runner tasks will still fire (they're scheduling-layer rows, not TaskFlow code) and wake the agent into prompts referencing tools that don't exist. Easiest:

```bash
# Cancel all kind='task' rows with TaskFlow runner content across every session.
for db in data/v2-sessions/*/inbound.db; do
  sqlite3 "$db" \
    "DELETE FROM messages_in WHERE kind='task' AND content LIKE '%standup%' OR content LIKE '%digest%' OR content LIKE '%review%';"
done
```

Adjust the `LIKE` filter to match the actual runner-content shape if it differs (the migrator `taskEnvelope` wraps the prompt as `{prompt, script: null}` JSON).

Then restart:

```bash
systemctl --user restart nanoclaw  # or launchctl on macOS
```

The revert preserves data in `data/taskflow/taskflow.db` (boards/tasks/people/history). Re-installing the skill later restores normal operation; the canceled runner rows need re-seeding via Phase 3 on a per-board basis.

## Troubleshooting

- **Container build fails with `pnpm install -g vercel@latest` error** — pnpm 11 PATH issue + vercel publish bug. The `skill/taskflow-v2` branch already pins `VERCEL_VERSION=52.2.1` and sets `PATH="$PNPM_HOME/bin:$PATH"`. If the failure persists, the merge dropped those Dockerfile fixes — re-apply commit `88235e00` from `skill/taskflow-v2`.
- **`bun:sqlite` says `unable to open database file`** — the per-session `inbound.db` is mounted at runtime via `src/container-runner.ts`. If the container's `getTaskflowDb()` errors on open, check the host has `data/taskflow/taskflow.db` (created by `bootstrapTaskflowDb` at host startup).
- **Standup/digest/review tasks don't fire** — check `messages_in` has rows with `kind='task'` and `recurrence` set. Cron strings are interpreted in `TIMEZONE` (host local), not UTC.
