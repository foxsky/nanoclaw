# 17. v2 Skill Apply Procedure — How "skill branches" actually work in practice

**Date:** 2026-05-03
**Status:** v2 ground truth — `remotes/upstream/v2`
**Question:** Beyond `add-whatsapp`, how does v2 actually install skills? What's the full operational reality (scripts, conventions, idempotency, dependencies, CI, conflict resolution)? What should TaskFlow's apply story look like?

---

## TL;DR

v2 ships **two parallel skill-apply patterns**, not one:

1. **Channel-skill pattern** — `git show <branch>:<file> > <file>` selective copy + node-script edits to `setup/index.ts`, automated by `setup/add-<channel>.sh` (idempotent, machine-callable, used by `nanoclaw.sh`). Source branch is `origin/channels`, NOT `skill/<name>`.
2. **Generic-skill pattern** — `git fetch upstream skill/<name> && git merge upstream/skill/<name>`, conflicts resolved by Claude inline. Used by `apple-container`, `ollama-tool`, `image-vision`, etc. Pure SKILL.md instructions; no setup script.

The aspirational `docs/skills-as-branches.md` describes pattern #2 only, plus a CI merge-forward bot, plus a marketplace plugin — but **none of the bot/marketplace machinery is shipped on `v2` today**: no `.github/workflows/skill-merge-forward.yml`, no `.claude-plugin/marketplace.json`, no `nanoclaw-skills` repo wired into `.claude/settings.json`. CI on v2 is a single `ci.yml` running format/typecheck/test on PRs to `main`. `update-skills` SKILL.md exists and uses `git merge-base` heuristics to detect previously-merged skills.

For TaskFlow we need **a hybrid**: an `add-taskflow` SKILL.md (pattern #2 shape: fetch + merge `skill/taskflow-v2`) plus an optional `setup/add-taskflow.sh` for non-interactive re-runs and headless environments. Dependencies (`whatsapp-fixes-v2` → `add-whatsapp`) are encoded by **branching one skill from another** — `skill/whatsapp-fixes-v2` is created off `skill/whatsapp` (or off `add-whatsapp`'s installed state on a fork's main), so merging it transitively brings in its parent's commits via merge-base. No separate manifest.

---

## 1. What's actually in a skill branch?

Two shapes coexist on upstream:

### 1a. `origin/channels` — a flat library of channel adapters

`git ls-tree -r upstream/channels --name-only` shows ~30+ `add-*` skill SKILL.md files plus per-channel adapter source under `src/channels/*.ts`, helpers, tests, and setup steps under `setup/*.ts`. Each entry has paired `REMOVE.md` + `VERIFY.md` files (e.g. `add-discord/REMOVE.md`, `add-discord/VERIFY.md`).

This branch is **not merged wholesale** — it's a source repo from which `setup/add-<channel>.sh` and the channel SKILL.md cherry-pick specific files via `git show <ref>:<path>`.

### 1b. `skill/<name>` — true merge-target branches

`git ls-remote upstream` shows: `skill/apple-container`, `skill/channel-formatting`, `skill/compact`, `skill/emacs`, `skill/migrate-from-openclaw`, `skill/migrate-nanoclaw`, `skill/native-credential-proxy`, `skill/ollama-tool`, `skill/qmd`, `skill/setup-dynamic-context`, `skill/wiki`. These ARE meant to be merged with `git merge upstream/skill/<name>`.

A skill branch contains:
- New source files (`container/agent-runner/src/ollama-mcp-stdio.ts`, `src/container-runtime.ts`, etc.)
- Modified existing source (`container/agent-runner/src/index.ts` for MCP config, `src/container-runner.ts` for log surfacing)
- `package.json` dependency additions
- `.env.example` entries
- The skill's own SKILL.md (lives in `.claude/skills/<name>/`)
- Sometimes scripts (`scripts/ollama-watch.sh`)

There is **no `manifest.yaml`, `add/`, `modify/`, `tests/intent.md`** structure. v2 deleted the entire skills-engine taxonomy. Skill branches are just normal git branches — `git diff upstream/main..upstream/skill/ollama-tool` is the full payload.

---

## 2. What scripts support apply?

`git ls-tree -r upstream/v2 setup/add-*.sh` returns exactly **four**:

```
setup/add-discord.sh
setup/add-teams.sh
setup/add-telegram.sh
setup/add-whatsapp.sh
```

All four are channel adapters. **No `setup/add-ollama-tool.sh`, no `setup/add-apple-container.sh`** — those skills have SKILL.md only. The pattern is asymmetric:

- **Channel skills**: SKILL.md (manual) + `setup/add-<channel>.sh` (automated, called by `bash nanoclaw.sh` from the `setup/auto.ts` driver). The script and SKILL.md are kept in sync — every channel SKILL.md says `Keep in sync with .claude/skills/add-<x>/SKILL.md` (or vice versa).
- **All other skills**: SKILL.md only. Operator runs `git fetch && git merge` by hand under Claude's guidance.

The four scripts share a common shape:

1. `set -euo pipefail`, `cd $PROJECT_ROOT`
2. Pinned adapter version (`@chat-adapter/telegram@4.26.0`, etc.)
3. `emit_status()` writes a structured stdout block (`=== NANOCLAW SETUP: ADD_XYZ ===`) for the parent `setup/auto.ts` parser
4. `log()` sends progress to stderr so it doesn't pollute the status block
5. `need_install()` precheck (idempotency — see §3)
6. If install needed: `git fetch origin channels`, `git show origin/channels:<f> > <f>` for each file, `node -e '...'` to splice STEPS map entries into `setup/index.ts`, `pnpm install <pinned-versions>`, `pnpm run build`
7. Persist credentials via an `upsert_env()` helper: awk-based KEY=VALUE rewrite in `.env`, then `cp .env data/env/env` for the container mount
8. Restart service via `launchctl kickstart` (Darwin) or `systemctl --user restart nanoclaw` (Linux)
9. Final `emit_status success`

Key choices:
- **Why `node -e` instead of `sed`**: BSD vs GNU sed in-place + escape semantics differ; node is cross-platform.
- **Why `origin/channels` not `upstream/channels`**: scripts assume the user's `origin` already tracks the qwibitai repo on a fresh clone. After `/setup` reroutes to a fork, this is wrong — but v2's setup skill compensates by renaming `origin → upstream` and adding the fork as `origin`, then re-fetching.
- **Why pinned versions in shell**: reproducibility; the SKILL.md and script can drift if anyone forgets to update both, hence the `Keep in sync` comment.

---

## 3. Idempotency: how do skills detect "already applied"?

**Convention: per-skill precheck, no shared library.**

Each `setup/add-*.sh` defines its own `need_install()`:

```bash
# add-whatsapp.sh
need_install() {
  [ ! -f src/channels/whatsapp.ts ] && return 0
  [ ! -f setup/groups.ts ] && return 0
  ! grep -q "^import './whatsapp.js';" src/channels/index.ts 2>/dev/null && return 0
  ! grep -q "'whatsapp-auth':" setup/index.ts 2>/dev/null && return 0
  ! grep -q "^  groups:" setup/index.ts 2>/dev/null && return 0
  return 1
}
```

The probe checks file existence + grep for self-registration imports + grep for STEPS map entries. If any check fails the marker is missing → install needed. Otherwise emit `ADAPTER_ALREADY_INSTALLED: true` and skip the install phase but **still proceed to credential persistence + service restart** (so re-running with new credentials updates them).

The matching SKILL.md has a "Pre-flight (idempotent)" section enumerating the same checks in prose — Claude reads it, runs the checks, jumps to "Credentials" if all pass.

For pure-merge skills (apple-container, ollama-tool), the SKILL.md instead probes a sentinel like:

```bash
grep "CONTAINER_RUNTIME_BIN" src/container-runtime.ts
# or
test -f container/agent-runner/src/ollama-mcp-stdio.ts
```

— meaning "the merge already happened, the artifact is on disk." Skip to verify/configure phase.

**There is no central registry, no `.nanoclaw/` state file, no `installed-skills.json`.** Re-applying a skill is safe as long as either (a) the merge is idempotent (already-merged → no-op fast-forward), or (b) the script's `need_install()` short-circuits.

---

## 4. Dependency declaration

**Encoded in git history, not metadata.** From `docs/skills-as-branches.md`:

> Some skills depend on other skills. E.g., `skill/telegram-swarm` requires `skill/telegram`. Dependent skill branches are branched from their parent skill branch, not from `main`.
>
> This means `skill/telegram-swarm` includes all of telegram's changes plus its own additions. When a user merges `skill/telegram-swarm`, they get both — no need to merge telegram separately.
>
> Dependencies are implicit in git history — `git merge-base --is-ancestor` determines whether one skill branch is an ancestor of another. No separate dependency file is needed.

In practice on v2 today this is partially observable but partially aspirational:
- `skill/voice-transcription` is documented as branching from `skill/whatsapp` in the migration table
- `skill/local-whisper` from `skill/voice-transcription`
- `skill/image-vision`, `skill/pdf-reader` from `skill/whatsapp`
- `skill/telegram-swarm` from `skill/telegram`

But **the channel skills themselves use the `origin/channels` flat-source pattern**, not `skill/whatsapp` — so the dependency chain has a discontinuity. A user who installs WhatsApp via `setup/add-whatsapp.sh` has the files but **no merge commit pointing at `skill/whatsapp`**. Then merging `skill/voice-transcription` (branched from `skill/whatsapp`) re-introduces all of `skill/whatsapp`'s commits, which conflict with the already-installed channel adapter.

This is the same migration pain that `docs/skills-as-branches.md` calls out for the old skills-engine: "Git doesn't know these changes came from a skill, so merging a skill branch on top would conflict or duplicate." It's an unsolved seam in v2's design.

For our 5 fork-private skills, this means we cannot rely on parent-branch chaining if the parent is a channel skill. We must either:
- Branch all 5 from `main` and let the operator install in dependency order, with each skill's SKILL.md asserting "ensure `/add-whatsapp` ran first"
- Or fork our own `skill/whatsapp-merged` branch that bundles `add-whatsapp.sh`'s output as a real merge commit, then chain from there

The second is cleaner for downstream chaining; the first is closer to what v2 ships.

---

## 5. Branch maintenance — keeping skill branches current

`docs/skills-as-branches.md` describes a CI bot:

> A GitHub Action runs on every push to `main`:
> 1. List all `skill/*` branches
> 2. For each skill branch, merge `main` into it (merge-forward, not rebase)
> 3. Run build and tests on the merged result
> 4. If tests pass, push the updated skill branch
> 5. If a skill fails (conflict, build error, test failure), open a GitHub issue for manual resolution

**This bot does not exist on v2 today.** `git ls-tree upstream/v2 .github/workflows/` lists only `bump-version.yml`, `ci.yml`, `label-pr.yml`, `update-tokens.yml`. None of them touch skill branches.

`ci.yml` runs format:check, typecheck (host + container), `vitest run`, and `bun test` on PRs to `main` — that's it. No multi-branch matrix, no merge-forward.

Operationally this means **skill branches are kept current by hand** by the upstream maintainer, by periodically merging main into each `skill/*` branch and force-pushing. For the channel skills it doesn't matter — they're cherry-picked from `origin/channels` at apply time, which always reflects HEAD.

For our fork: we can either run our own merge-forward action (one Github Action, ~50 lines, easy to ship) or accept manual maintenance — at 5 skills with low churn this is fine.

---

## 6. Multi-skill bundle — operator workflow for our 5 skills

The 5 fork-private skills are: `add-taskflow`, `whatsapp-fixes-v2`, `cross-board-subtasks`, `taskflow-memory`, plus the upstream-eligible ones we choose to keep on a branch. Two workflow shapes:

**Sequential merges (closer to v2):**
```bash
/add-whatsapp                          # upstream skill, our prerequisite
git fetch upstream skill/whatsapp-fixes-v2 && git merge upstream/skill/whatsapp-fixes-v2
git fetch upstream skill/taskflow-v2 && git merge upstream/skill/taskflow-v2
git fetch upstream skill/cross-board-subtasks && git merge upstream/skill/cross-board-subtasks
git fetch upstream skill/taskflow-memory && git merge upstream/skill/taskflow-memory
```
Operator chooses what to install. Each merge is a separate operator decision. Conflicts resolved at merge time by Claude.

**Pre-merged release branch (curated flavor):**
A `release/taskflow-flavor` branch on our fork that has all 5 already merged and CI-tested. Operator does one merge: `git merge upstream/release/taskflow-flavor`. This matches `docs/skills-as-branches.md`'s "Flavors" section. Cheaper for end users; more maintenance burden for us (need to re-curate every time main moves).

For 28 boards on a single fork, the sequential pattern is fine — we're the only operator. For external operators (if we open-source the TaskFlow flavor), the release-branch approach is friendlier.

---

## 7. Conflict resolution

`docs/skills-as-branches.md`:

> ### Conflict resolution
>
> At any merge step, conflicts may arise. Claude resolves them — reading the conflicted files, understanding the intent of both sides, and producing the correct result. This is what makes the branch approach viable at scale.

**Where this happens in practice: at merge time on the operator's machine, inside the `/add-<skill>` or `/update-skills` Claude session.** SKILL.md files include language like "If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides." The `update-skills` SKILL.md is more explicit:

> If conflicts occur:
> - Run `git status` to identify conflicted files.
> - For each conflicted file:
>   - Open the file.
>   - Resolve only conflict markers.

CI does NOT resolve conflicts. The aspirational "merge-forward bot opens a Github issue if conflicts" is not implemented. So today the entire flow is human-machine-interactive, not headless.

**Claude is expected to read conflict markers, understand both sides, and write the resolved file.** This works well for additive changes (new lines in `src/channels/index.ts`) and for orthogonal source files. It works less well for tightly-coupled changes (two skills that both rewrite `src/index.ts` orchestration logic) — those are flagged by `update-skills` as "review needed" and fall back to the operator.

---

## 8. TaskFlow's specific apply story

Concrete plan for `skill/taskflow-v2`:

### Branch shape

`skill/taskflow-v2` is a normal git branch on our fork, branched from `main` (NOT from `add-whatsapp` — see §4 discontinuity). It contains:
- `.claude/skills/add-taskflow/SKILL.md` (the apply instructions — see below)
- `setup/add-taskflow.sh` (optional non-interactive driver)
- All TaskFlow-specific source: `src/taskflow/*.ts`, taskflow MCP tools wired into `container/agent-runner/src/`, schema migrations under `migrations/`
- `package.json` deps (whatever TaskFlow needs that v2 doesn't ship)
- A row in `.env.example` documenting any TaskFlow env vars

### `.claude/skills/add-taskflow/SKILL.md` — what it should contain

Frontmatter, then:

1. **Prerequisites** — assert `/add-whatsapp` has run (`test -f src/channels/whatsapp.ts && grep -q "import './whatsapp.js';" src/channels/index.ts`); assert `/whatsapp-fixes-v2` has run (probe for the createGroup/lookupPhoneJid/resolvePhoneJid extensions).
2. **Pre-flight (idempotent)** — probe for sentinel files: `test -f src/taskflow/board-service.ts && sqlite3 data/v2.db "SELECT 1 FROM sqlite_master WHERE name='taskflow_boards'"`. If both true, skip to "Configure first board."
3. **Apply code changes** — the merge:
   ```bash
   git remote -v | grep -q upstream || git remote add upstream <fork-url>
   git fetch upstream skill/taskflow-v2
   git merge upstream/skill/taskflow-v2
   ```
   With "If conflicts arise, resolve by reading both sides — common conflict points are `src/index.ts` (orchestrator) and `container/agent-runner/src/index.ts` (MCP registration)."
4. **Run migrations** — `pnpm exec tsx scripts/run-migrations.ts` (or equivalent) to apply taskflow schema deltas to `data/v2.db`.
5. **Validate** — `pnpm run build && pnpm exec vitest run --grep taskflow`.
6. **Configure first board** — interactive: ask operator for board name, division, channel JID, manager phone; create the row in `taskflow_boards`; create the agent group via v2's `create_agent` flow.
7. **Verify end-to-end** — send a test message via WhatsApp, confirm the bot responds with TaskFlow's first-board greeting.
8. **Troubleshooting** — common issues (missing migrations, wrong channel JID, agent group not approved).

### `setup/add-taskflow.sh` — what it should contain

Mirror the channel-skill pattern but for the merge case:

```bash
#!/usr/bin/env bash
# Apply skill/taskflow-v2 non-interactively. Idempotent. Designed to be
# called from setup/auto.ts or a deployment script. Emits one ADD_TASKFLOW
# status block on stdout.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

SKILL_BRANCH="upstream/skill/taskflow-v2"

emit_status() {
  local status=$1 error=${2:-}
  echo "=== NANOCLAW SETUP: ADD_TASKFLOW ==="
  echo "STATUS: ${status}"
  echo "ALREADY_INSTALLED: ${ALREADY_INSTALLED:-false}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}
log() { echo "[add-taskflow] $*" >&2; }

need_install() {
  [ ! -f src/taskflow/board-service.ts ] && return 0
  ! sqlite3 data/v2.db "SELECT 1 FROM sqlite_master WHERE name='taskflow_boards'" 2>/dev/null | grep -q 1 && return 0
  return 1
}

# Prereq probes — fail fast with operator-friendly errors.
test -f src/channels/whatsapp.ts || { emit_status failed "run /add-whatsapp first"; exit 1; }
grep -q "createGroup" src/channels/whatsapp.ts || { emit_status failed "run /whatsapp-fixes-v2 first"; exit 1; }

ALREADY_INSTALLED=true
if need_install; then
  ALREADY_INSTALLED=false
  log "Fetching skill/taskflow-v2…"
  git fetch upstream skill/taskflow-v2 >&2 2>/dev/null || { emit_status failed "git fetch failed"; exit 1; }
  log "Merging skill/taskflow-v2…"
  git merge --no-edit upstream/skill/taskflow-v2 >&2 || { emit_status failed "merge had conflicts — resolve interactively via /add-taskflow"; exit 1; }
  log "Installing deps…"
  pnpm install >&2 || { emit_status failed "pnpm install failed"; exit 1; }
  log "Running migrations…"
  pnpm exec tsx scripts/run-migrations.ts >&2 || { emit_status failed "migrations failed"; exit 1; }
  log "Building…"
  pnpm run build >&2 || { emit_status failed "build failed"; exit 1; }
fi

# Restart service to pick up new MCP tools.
case "$(uname -s)" in
  Darwin) launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" >&2 2>/dev/null || true ;;
  Linux)  systemctl --user restart nanoclaw >&2 2>/dev/null || sudo systemctl restart nanoclaw >&2 2>/dev/null || true ;;
esac
sleep 5

emit_status success
```

The script bails if conflicts arise — it does NOT try to auto-resolve. That's the operator's (Claude's) job inside `/add-taskflow`. The script exists for the headless re-apply case (deploys, fresh-clone bootstrap, CI smoke tests) where we know the branch is conflict-free against the target main.

### Cutover checklist

When we're ready to ship `skill/taskflow-v2`:
1. Curate the branch off our fork's `main`. Verify `git diff upstream/v2..skill/taskflow-v2` is the TaskFlow payload only — no incidental drift.
2. Write `.claude/skills/add-taskflow/SKILL.md` and `setup/add-taskflow.sh` ON the skill branch (so they ship with it; merging brings both into operator's main).
3. Run `pnpm run build && pnpm exec vitest run` against the merged result on a fresh clone of v2 to verify clean apply.
4. Add a brief entry to `docs/skills-as-branches.md` (our fork's copy) listing `skill/taskflow-v2` in the migration table.
5. Document the prereq chain in TaskFlow's SKILL.md: `/add-whatsapp` → `/whatsapp-fixes-v2` → `/add-taskflow` → optionally `/add-cross-board-subtasks` → optionally `/add-taskflow-memory`.

---

## Citations

| Claim | Source |
|-------|--------|
| `setup/add-*.sh` is exactly four files | `git ls-tree -r upstream/v2 setup/add-*.sh` |
| Channel skills use `git show origin/channels:<file>` | `setup/add-whatsapp.sh` lines 49-52, `setup/add-telegram.sh` lines 60-72, `setup/add-discord.sh` line 60, `setup/add-teams.sh` line 65 |
| Idempotency via `need_install()` precheck | `setup/add-whatsapp.sh` lines 36-43; `.claude/skills/add-whatsapp/SKILL.md` "Pre-flight (idempotent)" |
| `node -e` over sed for cross-platform editing | `setup/add-whatsapp.sh` lines 60-79 (explicit comment), `setup/add-telegram.sh` lines 80-91 |
| Pinned adapter versions, sync with SKILL.md | `setup/add-whatsapp.sh` lines 22-25 ("Keep in sync with .claude/skills/add-whatsapp/SKILL.md") |
| Status block contract for `setup/auto.ts` parser | `setup/add-whatsapp.sh` lines 27-35 (`emit_status`); same shape across all four |
| `upsert_env()` helper for `.env` | `setup/add-discord.sh` lines 86-94, `setup/add-teams.sh` lines 90-98 |
| Skill-branch list on remote | `git ls-remote upstream` (channels, skill/apple-container, skill/channel-formatting, skill/compact, skill/emacs, skill/migrate-from-openclaw, skill/migrate-nanoclaw, skill/native-credential-proxy, skill/ollama-tool, skill/qmd, skill/setup-dynamic-context, skill/wiki) |
| Generic skills use `git fetch && git merge upstream/skill/<n>` | `.claude/skills/convert-to-apple-container/SKILL.md` "Phase 2: Apply Code Changes" — "Merge the skill branch" |
| Conflict resolution is at merge time, by Claude, on operator's machine | `docs/skills-as-branches.md` "Conflict resolution" section; `.claude/skills/update-skills/SKILL.md` Step 3 |
| `update-skills` uses merge-base heuristic to detect previously-installed skills | `.claude/skills/update-skills/SKILL.md` "Step 1: Detect installed skills" |
| Dependencies are implicit in git history, no manifest | `docs/skills-as-branches.md` "Skill dependencies" section |
| CI workflows on v2 do NOT include merge-forward bot | `git ls-tree upstream/v2 .github/workflows/` — only `bump-version.yml`, `ci.yml`, `label-pr.yml`, `update-tokens.yml` |
| Marketplace plugin not yet wired | `git ls-tree upstream/v2 .claude/settings.json` — no `extraKnownMarketplaces` configured; no `nanoclaw-skills` marketplace repo referenced |
| Migration discontinuity for old-engine skills | `docs/skills-as-branches.md` "Existing users migrating from the old skills engine" section |
