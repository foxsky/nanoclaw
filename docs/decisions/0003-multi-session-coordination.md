# 0003 — Coordination protocol for concurrent agent sessions on one working tree

**Status:** Accepted (2026-06-15)

## Context
`/root/nanoclaw` is edited by **multiple concurrent `claude --resume` sessions**
plus background test runners. They share one working tree and one branch
(`skill/taskflow-v2`). The session-start `git status` snapshot goes stale within
minutes, and the commit hook reformats `src/**/*.ts` in place (touching files a
session didn't stage). This has caused real collisions (the 2026-06-11 R4
actor-gate collision; a 2026-06-15 formatter near-miss).

## Decision
Until the tree is isolated per-agent, every session follows a manual protocol:

1. **Before** editing a shared/hot file: `git fetch` + grep the recent log for
   in-flight work on it.
2. **Stage only your own files/hunks** — never `git add -A`/`git add .`. List the
   exact paths you authored.
3. **Verify** the staged diff is yours before committing (`git diff --cached`),
   especially after the format hook runs.
4. Prefer a **worktree-per-unit** (`isolation: worktree`) for parallel work so
   sessions don't share a mutable tree at all.

## Consequences
- **+** Prevents one session sweeping another's WIP into a commit; prevents
  same-file collisions.
- **−** It is **manual discipline** — the weak point. There is no executable
  guard today. Candidate (not yet built): a pre-commit check that flags staged
  files the current session did not touch. Hard to automate reliably; documented
  here so it isn't forgotten.
- **−** Worktrees cost setup time/disk; use for genuinely parallel mutation only.

## References
- GOTCHAS → "Shared working tree + concurrent agent sessions"
- Memory: `project_v2_r4_actor_gate_collision` (the collision that taught this)
- Root `CLAUDE.md` → Agent trigger map
