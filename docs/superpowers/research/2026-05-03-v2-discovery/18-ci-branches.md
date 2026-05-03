# 18 — v2 CI Patterns and Branch Maintenance Expectations

**Date:** 2026-05-03
**Context:** Codex#9 IMPORTANT-3 + I10 said v2 expects branch CI + weekly merge-forward. Track A's plan needs a CI + branch-maintenance design that's actually viable for our 5-skill bundle (cost-realistic, not aspirational).

---

## TL;DR

1. **The merge-forward CI workflow described in `docs/skills-as-branches.md` does NOT exist in upstream/v2.** It existed historically (`merge-forward-skills.yml` + `fork-sync-skills.yml`) but was deleted in commit `d4073a01` (2026-03-25) because **auto-resolved `package.json` conflicts silently stripped fork-specific dependencies**.
2. **Today, upstream maintains skill branches manually** via the `BRANCH-FORK-MAINTENANCE.md` runbook (added in `8bb8e036`, lives on each skill branch — not on `v2` or `main`). Forward-merge is operator-driven, not bot-driven.
3. **v2's actual CI is a single `ci.yml` running on PRs to `main` only.** No branch matrix, no `skill/*` triggers, no `release/*` triggers. ~22 lines.
4. **For our 5-skill bundle, weekly merge-forward is realistic at ~2-4h/week steady-state** (1 light week + 1 painful week per pair); batched bi-weekly is closer to 3-5h/cycle but with worse conflict surface. Actual upstream/v2 commit velocity: **335 commits in 4 weeks, 120 in 2 weeks, 0 last week** — bursty.

---

## 1. v2's CI Workflow Shape

### Source: `git show remotes/upstream/v2:.github/workflows/ci.yml`

```yaml
name: CI
on:
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.12
      - run: pnpm install --frozen-lockfile
      - name: Install agent-runner deps (Bun)
        working-directory: container/agent-runner
        run: bun install --frozen-lockfile
      - name: Format check
        run: pnpm run format:check
      - name: Typecheck host
        run: pnpm exec tsc --noEmit
      - name: Typecheck container
        run: pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
      - name: Host tests
        run: pnpm exec vitest run
      - name: Container tests
        working-directory: container/agent-runner
        run: bun test
```

### Findings

| Aspect | v2 Reality | Notes |
|---|---|---|
| **Triggers** | `pull_request` to `main` only | No push triggers, no schedule, no `skill/*` triggers |
| **Jobs** | Single `ci` job | No matrix |
| **Runner** | `ubuntu-latest` | Single runner |
| **Matrix** | None | No node-version matrix, no OS matrix |
| **Services** | None | No Postgres/Redis/etc. |
| **Stack** | pnpm 10.33.0 (host) + Bun 1.3.12 (container) | `packageManager: "pnpm@10.33.0"` in v2 root `package.json` |
| **Steps** | format:check → typecheck (host) → typecheck (container) → vitest → bun test | 6 verification steps |
| **Caching** | `actions/setup-node@v4` with `cache: pnpm` | Single cache layer |
| **Estimated duration** | ~4-6 minutes per run | Empirical estimate from steps; no measured data in repo |

### Other v2 workflows

```
.github/workflows/bump-version.yml   # push:main, src/** + container/** — bumps patch version
.github/workflows/ci.yml              # PR to main — verification
.github/workflows/label-pr.yml        # PR opened/edited — labels by type
.github/workflows/update-tokens.yml   # push:main, src/** + container/** + CLAUDE.md — token-count badge
```

All four target `main` branch only. **No `skill/*` workflow exists in v2.**

---

## 2. Branch Protection

### Findings (from upstream layer)

- `.github/CODEOWNERS` exists on v2:
  ```
  /src/ @gavrielc @gabi-simons
  /container/ @gavrielc @gabi-simons
  /groups/ @gavrielc @gabi-simons
  /launchd/ @gavrielc @gabi-simons
  /package.json @gavrielc @gabi-simons
  /package-lock.json @gavrielc @gabi-simons
  /.claude/skills/   # Skills - open to contributors (no specific owner)
  ```
- We cannot directly inspect GitHub branch-protection settings (needs API access), but **the CI workflow being PR-only on `main` strongly implies branch protection requires PR + green CI for `main`**. Skill branches are unprotected.
- No `skill/*` codeowners — skill branches are intentionally open to contributors.

---

## 3. Per-Skill-Branch CI: NOT RUN

**Critical finding:** Upstream v2 does NOT run CI on `skill/*` branches automatically. The `ci.yml` triggers only on `pull_request: branches: [main]`.

This means:
- A push directly to `skill/foo` branch on upstream has zero CI gates
- A `git merge upstream/skill/foo` could pull in code that fails typecheck/tests
- Validation is downstream — happens when a user merges the skill into their fork and runs locally

**Implication for Track A:** Our fork is responsible for our own per-branch CI. We cannot rely on upstream gates for skill-branch quality.

---

## 4. Merge-Forward Expectations: Aspirational, Not Automated

### What `docs/skills-as-branches.md` (lines 195-204) claims

```
A GitHub Action runs on every push to `main`:
1. List all `skill/*` branches
2. For each skill branch, merge `main` into it (merge-forward, not rebase)
3. Run build and tests on the merged result
4. If tests pass, push the updated skill branch
5. If a skill fails (conflict, build error, test failure), open a GitHub issue
```

### What actually exists on upstream/v2

**Nothing.** The doc is aspirational — it describes a system that was tried and explicitly removed.

### Historical evidence

- **`merge-forward-skills.yml`** existed and ran on every push to `main`. Looped over `skill/*` branches, attempted merge, auto-resolved `package.json`/`package-lock.json`/`badge.svg` with `git checkout --theirs`, ran `npm ci && npm run build && npm test`, opened an issue on failure, and notified channel forks via `repository_dispatch`.
- **`fork-sync-skills.yml`** mirrored the same pattern on channel forks — listening to `repository_dispatch` from upstream.
- **Both deleted in commit `d4073a01`** (Mar 25 2026, gavrielc):
  > "These workflows auto-resolved package.json conflicts with --theirs, silently stripping fork-specific dependencies during upstream syncs."
- **Replacement is operator-driven:** `docs/BRANCH-FORK-MAINTENANCE.md` (added in `8bb8e036`, present on each skill branch) is a 79-line manual runbook. No automation, no schedule, no bot.

### Quote from `BRANCH-FORK-MAINTENANCE.md`

```
## When to merge forward

After any main change that touches shared files (package.json, src/index.ts,
CLAUDE.md, etc.). Small frequent merges = trivial conflicts. Large infrequent
merges = painful.
```

> **Same files conflict every time:**
> - `package.json` — Take main's version + keep fork/branch-specific deps
> - `package-lock.json` — `git checkout main -- package-lock.json && npm install`
> - `.env.example` — Combine: main's entries + fork/branch-specific entries
> - `repo-tokens/badge.svg` — Take main's version

This is real, lived experience that informed the deletion of the auto-merge bot. The manual procedure is the current best practice on upstream.

---

## 5. Conflict Resolution at Scale

### The 5 × 6 = 30 merges question

For our 5 skills (`whatsapp-fixes-v2`, `taskflow-v2`, `taskflow-memory-v2`, `long-term-context-v2`, `embeddings-v2`) over 6 weeks of weekly forward-merge:

| Merge type | Frequency | Effort | Notes |
|---|---|---|---|
| **Trivial (lockfile/badge/version only)** | ~60% | 2-5 min | `git checkout main -- package-lock.json && pnpm install` |
| **`.env.example` combine** | ~20% | 5-10 min | Trivial three-way text merge |
| **Source touch (shared file modified both sides)** | ~15% | 15-45 min | Real review needed; can cascade if v2 changed an interface our skill uses |
| **Painful (foundational change)** | ~5% | 1-4 hours | E.g. v2's pnpm migration, container Bun migration, types.ts wholesale replacement (precedent: feedback_v1_types_quarantine_pattern.md, 54→1 errors took an iteration cycle) |

### Estimating per-week average

- v2 main commit velocity (last 4 weeks): **335 commits → ~84 commits/week, but bursty (120 in last 2 weeks, 0 in last week)**
- Most of those are non-conflicting; expect **1-3 conflict-inducing main commits per week** affecting any one skill (those that touch shared files)
- For a 5-skill fan-out, expect **3-8 minor conflicts and 0-2 painful conflicts per week** in aggregate

### Dependent-branch conflict cascading

When `taskflow-v2` is built on top of `whatsapp-fixes-v2`, a conflict in `whatsapp-fixes-v2` propagates: forward-merging main into `whatsapp-fixes-v2` first, then forward-merging the updated `whatsapp-fixes-v2` into `taskflow-v2`, doubles the conflict surface. Expect **+30-50% effort overhead** for our 2 base + 3 dependent layout vs 5 independent.

---

## 6. Dependent Branch CI

### Question

If `skill/taskflow-v2` depends on `skill/whatsapp-fixes-v2`, does CI need to merge those in first?

### Answer

**Yes, if we want CI to validate the same code users will execute.** Upstream v2 doesn't address this because their dependent-skill tree (`skill/voice-transcription` ← `skill/whatsapp`, `skill/local-whisper` ← `skill/voice-transcription`) has no CI at all on the branches.

### Dependency tree from `docs/skills-as-branches.md` (lines 519-529)

```
skill/whatsapp           ← main
skill/voice-transcription ← skill/whatsapp
skill/image-vision       ← skill/whatsapp
skill/pdf-reader         ← skill/whatsapp
skill/local-whisper      ← skill/voice-transcription
```

The doc says "Dependent skill branches are branched from their parent skill branch, not from main" and "Dependencies are implicit in git history — `git merge-base --is-ancestor` determines whether one skill branch is an ancestor of another."

### For our bundle

If we adopt the same pattern:
- `skill/taskflow-v2` branches from `skill/whatsapp-fixes-v2` (not main)
- A user who merges `skill/taskflow-v2` automatically gets `whatsapp-fixes-v2` too
- CI on `skill/taskflow-v2` already includes the `whatsapp-fixes-v2` code (no separate merge step needed in CI)
- Forward-merge order: main → `whatsapp-fixes-v2`, then `whatsapp-fixes-v2` → `taskflow-v2` (cascade)

### Alternative: independent branches (all branched from main)

- Simpler CI per branch
- Users must `git merge skill/whatsapp-fixes-v2 && git merge skill/taskflow-v2` separately
- Conflicts at user-merge time become Track A's problem, not maintainer's
- **Trade-off: simpler upstream, harder downstream.** v2's "branched from parent" pattern shifts complexity to maintainer (us) for user simplicity.

---

## 7. `release/*` Branch CI Shape

### Codex#7 IMPORTANT-2 suggested `release/taskflow-bundle-v2`

A pre-merged branch combining all 5 skills. Already exists locally (see `git branch`: `release/taskflow-bundle-v2`).

### Recommended CI shape (NOT in v2 upstream, this is our addition)

```yaml
name: Release Bundle CI
on:
  pull_request:
    branches: [release/taskflow-bundle-v2]
  push:
    branches: [release/taskflow-bundle-v2]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.12 }
      - run: pnpm install --frozen-lockfile
      - run: cd container/agent-runner && bun install --frozen-lockfile
      - run: pnpm run format:check
      - run: pnpm exec tsc --noEmit
      - run: pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
      - run: pnpm exec vitest run
      - run: cd container/agent-runner && bun test
      # Bundle-specific: verify all 5 skills still merge cleanly from individual branches
      - name: Verify skill branches merge clean to bundle
        run: |
          for skill in whatsapp-fixes-v2 taskflow-v2 taskflow-memory-v2 long-term-context-v2 embeddings-v2; do
            git fetch origin "skill/$skill"
            git merge-tree --write-tree HEAD "origin/skill/$skill" > /dev/null
          done
```

The bundle CI is essentially v2's CI **plus** a "skills still compose" verification step. Cost: same ~5 min as v2 CI + ~30s for the merge-tree check.

### Why this matters

If we ship `release/taskflow-bundle-v2` to production via `./scripts/deploy.sh`, **the bundle branch is what runs on prod**. The 5 individual skill branches are sources; the bundle is the assembled binary. CI gates must catch bundle-level breakage.

---

## 8. Cost Estimate (Concrete)

### Per-week, 5-skill bundle, weekly cadence

| Activity | Time | Notes |
|---|---|---|
| Forward-merge main → `whatsapp-fixes-v2` | 10-30 min | `package.json`/lockfile resolution, occasional source conflict |
| Cascade: `whatsapp-fixes-v2` → `taskflow-v2` | 5-15 min | Usually trivial, sometimes signature drift |
| Cascade: `taskflow-v2` → `taskflow-memory-v2` | 5-10 min | Memory layer is additive, low conflict surface |
| Forward-merge main → `long-term-context-v2` | 5-15 min | Mostly independent of channel code |
| Forward-merge main → `embeddings-v2` | 5-15 min | Mostly independent |
| Re-bundle into `release/taskflow-bundle-v2` | 10-20 min | 5 merge commits + lockfile re-resolve + format:write |
| Run CI locally + fix break | 15-60 min | Variable, ~50% of weeks |
| Deploy to prod | 5-10 min | `./scripts/deploy.sh` |
| **Steady-state weekly total** | **~60-180 min (1-3h)** | Median ~2h |
| **Painful week (foundational v2 change)** | **+2-6h** | E.g. types.ts replacement, runtime swap, schema change |

### CI minutes (GitHub Actions)

- v2's `ci.yml` per run: ~5 min
- Per push to a `skill/*` branch (if we add CI): ~5 min × 5 skills × 1 push/week = 25 min/week
- Bundle CI per push: ~6 min × 2 pushes/week = 12 min/week
- PR runs (forward-merge + bundle): ~5 min × 5-10 PRs/week = 25-50 min/week
- **Total: ~60-90 CI minutes/week** = well within the GitHub Free tier (2000 min/month) for a private repo, free for public

### Weekly vs bi-weekly comparison

| Cadence | Effort/cycle | Cycles/6wk | Total 6wk | Conflict surface |
|---|---|---|---|---|
| **Weekly** | 1-3h | 6 | **6-18h** | Smaller per merge; conflicts caught early |
| **Bi-weekly** | 3-7h | 3 | **9-21h** | Larger per merge; harder to bisect; v2's own doc warns "Large infrequent merges = painful" |
| **Batched (3-weekly)** | 6-15h | 2 | **12-30h** | Foundational v2 changes accumulate; risk of multi-day stalls |

**Recommendation: weekly cadence.** Lower total effort, predictable, aligns with v2's documented best practice ("small frequent merges = trivial conflicts"). Bi-weekly defensible if a week is light (matches the "bursty" upstream velocity pattern — last week had 0 commits).

---

## 9. Actual v2 Skills in Upstream

### Branch list (from `git ls-remote https://github.com/qwibitai/nanoclaw.git`)

```
refs/heads/main
refs/heads/v2
refs/heads/skill/apple-container
refs/heads/skill/channel-formatting
refs/heads/skill/compact
refs/heads/skill/emacs
refs/heads/skill/migrate-from-openclaw
refs/heads/skill/migrate-nanoclaw
refs/heads/skill/native-credential-proxy
refs/heads/skill/ollama-tool
refs/heads/skill/qmd
refs/heads/skill/setup-dynamic-context
refs/heads/skill/wiki
```

**Count: 11 active `skill/*` branches.**

### What's missing from upstream (vs the docs/skills-as-branches.md migration table)

The docs claim these branches exist:
```
skill/whatsapp, skill/telegram, skill/slack, skill/discord, skill/gmail
skill/voice-transcription, skill/image-vision, skill/pdf-reader, skill/local-whisper
skill/reactions
```

**None of these are on upstream `qwibitai/nanoclaw`.** They've migrated to **separate fork repos**:
- `nanoclaw-whatsapp`
- `nanoclaw-telegram`
- `nanoclaw-discord`
- `nanoclaw-slack`
- `nanoclaw-gmail`
- `nanoclaw-docker-sandboxes` (referenced in deleted `merge-forward-skills.yml` notification list)

The `skills-as-branches.md` doc is **out of date with reality**. Channels are forks; only non-channel feature skills live on upstream branches.

### Recent activity per skill branch (last 3 commits)

| Branch | Last commit | Cadence |
|---|---|---|
| `skill/apple-container` | Merge PR #1609, fix proxy bind | Active (recent fixes) |
| `skill/channel-formatting` | "merge: catch up with upstream main" | Maintained — manual catch-up commits |
| `skill/compact` | "merge: catch up with upstream main" | Same |
| `skill/emacs` | "merge: catch up with upstream main" | Same |
| `skill/migrate-from-openclaw` | feature work, then quiet | Stable |
| `skill/migrate-nanoclaw` | feature work, diagnostics | Active |
| `skill/native-credential-proxy` | "merge: catch up with upstream main" | Maintained manually |
| `skill/ollama-tool` | "merge: catch up with upstream main" | Same |
| `skill/qmd` | feature work | Active |
| `skill/setup-dynamic-context` | feature work | Active |
| `skill/wiki` | "Merge branch 'main' into skill/wiki" | Maintained manually |

**Pattern:** ~half the branches show commits like `"merge: catch up with upstream main"` and `"docs: note that workflow removal recurs on every forward merge"` — concrete evidence the maintainer is **hand-driving forward-merges** and writing docs about it (the "workflow removal recurs" phrasing means deleting `bump-version.yml` + `update-tokens.yml` from forks every time main merges them back in — a known recurring chore).

This validates the cost model: even one human maintainer with 11 branches manages ~weekly forward-merges manually without it being a full-time job, but it's also not zero — and they explicitly chose this over the failed automation.

---

## 10. Recommendations for Track A

### A. Adopt v2's CI shape verbatim for our `release/taskflow-bundle-v2` and individual skill branches

- Single `ci.yml` per branch family
- pnpm + Bun matrix (host + container)
- format:check → typecheck × 2 → vitest → bun test
- Trigger on `pull_request` to the protected branch (bundle + each skill)

### B. Add per-`skill/*-v2` branch CI (deviation from upstream)

Upstream doesn't do this because they tolerate broken skill branches; we can't, because our prod runs from `release/taskflow-bundle-v2`. Trigger on push to each `skill/*-v2` branch, run the same CI.

### C. Manual forward-merge with a checklist, NOT a bot

Reasons:
- Upstream tried automation, found it silently stripped fork deps, deleted it
- Our 5 skills have **fork-private logic** (e.g., taskflow's `cross_board_subtask_mode`) that's exactly the kind of thing auto-`--theirs` would clobber
- A 1-3h/week manual chore with a runbook is cheaper than building+maintaining a custom merge-resolution bot

Adopt upstream's `BRANCH-FORK-MAINTENANCE.md` as our template; tailor file list (we have `data/`, `groups/`, `.claude/skills/` to consider).

### D. Cadence: weekly, with a bi-weekly fallback for confirmed-quiet weeks

- Default Monday-morning forward-merge
- Skip if `git log upstream/v2 --since="last Monday"` is empty (matches the "0 commits last week" pattern)
- Don't go more than 2 weeks without a forward-merge — v2's docs explicitly warn this is painful

### E. Order forward-merges to respect skill dependencies

```
upstream/v2 main
    ↓
skill/whatsapp-fixes-v2 (base)
    ↓
skill/taskflow-v2 (depends on whatsapp-fixes-v2)
    ↓
skill/taskflow-memory-v2 (depends on taskflow-v2)

upstream/v2 main
    ↓
skill/long-term-context-v2 (independent)

upstream/v2 main
    ↓
skill/embeddings-v2 (independent)

→ all five fan into → release/taskflow-bundle-v2
```

Cascade: never forward-merge a child before its parent.

### F. Estimated total maintenance budget for 6-week migration

- **Best case (light weeks): 6h × 6 = 36h** (mostly trivial lockfile resolution)
- **Expected case: 12-18h** (1-3h/week median + 1 painful week)
- **Worst case (foundational v2 changes hit during migration): 30-40h** (e.g., if v2 ships a types.ts replacement during week 3)

These are **operator hours, not developer-feature hours.** They're recurring overhead on top of skill-development effort, not part of it.

---

## Citations

| Claim | File / Source | Lines |
|---|---|---|
| v2 CI workflow content | `git show remotes/upstream/v2:.github/workflows/ci.yml` | 1-30 |
| Workflow list | `git ls-tree -r remotes/upstream/v2 .github/` | full |
| CODEOWNERS | `git show remotes/upstream/v2:.github/CODEOWNERS` | 1-10 |
| PR template | `git show remotes/upstream/v2:.github/PULL_REQUEST_TEMPLATE.md` | 1-18 |
| Aspirational merge-forward CI | `git show remotes/upstream/v2:docs/skills-as-branches.md` | 195-204 |
| "merge-forward CI scales" claim | same | 222-225 |
| Skill dependency tree | same | 519-529 |
| Migration table (out of date) | same | 451-466 |
| Removal of merge-forward-skills.yml | `git show d4073a01` | full commit |
| Pre-removal merge-forward-skills.yml | `git show d4073a01^:.github/workflows/merge-forward-skills.yml` | 1-179 |
| BRANCH-FORK-MAINTENANCE.md (manual runbook) | `git show remotes/upstream/skill/channel-formatting:docs/BRANCH-FORK-MAINTENANCE.md` | 1-79 |
| v2 main commit velocity | `git log --since="4 weeks ago" --oneline remotes/upstream/v2 \| wc -l` | 335 / 4wk |
| Skill branch list | `git ls-remote https://github.com/qwibitai/nanoclaw.git \| grep refs/heads/skill/` | 11 branches |
| "merge: catch up" commits | `git log --oneline remotes/upstream/skill/channel-formatting` | recent |
| Auto-merge failure root cause | `git show d4073a01` (commit message) | 1-3 |

## Files referenced (absolute paths)

- `/root/nanoclaw/.github/workflows/ci.yml` (our fork's current CI)
- `/root/nanoclaw/.github/workflows/bump-version.yml`
- `/root/nanoclaw/.github/workflows/label-pr.yml`
- `/root/nanoclaw/.github/workflows/update-tokens.yml`
- `/root/nanoclaw/.github/CODEOWNERS`
- `/root/nanoclaw/.github/PULL_REQUEST_TEMPLATE.md`
- `/root/nanoclaw/scripts/deploy.sh` (existing prod deploy automation)
- `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/18-ci-branches.md` (this file)
