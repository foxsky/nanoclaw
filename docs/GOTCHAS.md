# GOTCHAS — the footguns, routed-to

Each entry is a fixed shape so it's scannable: **Rule / Why / How it bites /
Verify / Guardrail / Last incident.** This is the L1 spine of the agent second
brain. The router that points agents here at the right moment is the **"Agent
trigger map (second brain)"** section of the root `CLAUDE.md`; the full playbook
is `tf-mcontrol/docs/SECOND-BRAIN.md` (sibling repo).

**The ritual:** every silent bug earns a guardrail. Before closing one, ask *"what
is the cheapest executable check that would have caught this?"* and add it in the
same change — then add the entry here.

---

## bun:sqlite `.get()` returns `null`, not `undefined`
**Rule.** In container code (`container/agent-runner/`, runs on Bun), treat a
missing row from `stmt.get()` as `null`. Guard with `if (!row)` or `== null`,
never `row === undefined`.
**Why.** `bun:sqlite` returns `null` for no-row; `better-sqlite3` (the host) returns
`undefined`. The two trees look identical but differ here.
**How it bites.** A `row === undefined` check silently treats "not found" as
truthy (or a real null row as absent) — wrong branch, no crash.
**Verify.** `grep -rn "\.get(" container/agent-runner/src | grep "=== undefined"` → should be empty.
**Guardrail.** None executable yet (candidate lint).
**Last incident.** Pre-2026-06; see memory `feedback_get_returns_null_in_bun_sqlite`.

## Prettier corrupts skill/markdown; the hook only formats `src/**/*.ts`
**Rule.** NEVER run prettier on `.md` (especially `.claude/skills/**/SKILL.md`).
The commit hook's `format:fix` is scoped to `src/**/*.ts` only — container files
and markdown are untouched by it.
**Why.** Prettier reflows markdown and mangles SKILL.md structure/frontmatter.
**How it bites.** Skill markdown silently restructured; the change reads as a
huge diff and can break skill parsing.
**Verify.** `package.json` `format:fix` glob is `"src/**/*.ts"`.
**Guardrail.** The hook scope itself (it can't reach `.md`).
**Last incident.** 2026-06-13; see memory `reference_prettier_skips_md_corrupts_skills`.

## `allowedTools` does NOT restrict availability under `bypassPermissions`
**Rule.** To actually remove a tool from an agent, use `disallowedTools`
(`SDK_DISALLOWED_TOOLS`) and/or restrict the visible `mcpServers`. Do NOT rely on
`allowedTools` — under `permissionMode: 'bypassPermissions'` it only *auto-approves*
and gates nothing.
**Why.** Claude Agent SDK semantics: `allowedTools` = auto-approve list; `tools` /
`disallowedTools` = availability. The built-in fs/bash tools are blocked for every
turn by `disallowedTools`, not by the allowlist.
**How it bites.** A "restricted" tool list that restricts nothing — e.g. a confined
external turn could still call `Read`/`Bash` over board-private files.
**Verify.** `container/agent-runner/src/providers/confined-external.test.ts`,
`providers/security-denylist.test.ts`.
**Guardrail.** Those tests (L0) + `computeAllowedTools` is a pure, tested fn.
**Last incident.** 2026-06-15, RC5-ext C4c Codex round 2.

## The MockProvider stream stays open — a one-shot turn's `finally` never runs in tests
**Rule.** To assert turn-boundary cleanup (channel clear, continuation NOT
persisted, etc.) in an integration test, use a **self-ending** provider whose
`events` async-generator *returns* after the `result` event. The shared
`MockProvider` blocks waiting for `push()/end()` (it models a long-lived board
stream), so the poll-loop's `finally` won't have run when your assertion fires.
**Why.** `runConfinedExternalQuery`/`processQuery` only reach `finally` when the
event stream completes; MockProvider keeps it open for follow-ups.
**How it bites.** Asserting post-turn state reads *pre-`finally`* state → a false
failure (or, worse, a false pass that hides a real cleanup bug).
**Verify.** `CapturingExternalProvider` pattern in `integration.test.ts` (RC5-ext P4).
**Guardrail.** The pattern itself (a documented test idiom).
**Last incident.** 2026-06-15, RC5-ext P4 e2e (`9f3f6e71`).

## Shared working tree + concurrent agent sessions
**Rule.** Several `claude --resume` sessions edit `/root/nanoclaw` at once. Before
editing a shared/hot file: `git fetch` + grep the recent log. When committing:
**stage only your own files/hunks** and **verify each staged diff is yours**
(`git diff --cached`) — never `git add -A`. Prefer a worktree-per-unit for
parallel work.
**Why.** The session-start `git status` snapshot is stale; another session's
uncommitted edits sit in the same tree. The commit hook also reformats
`src/**/*.ts` in place, touching files you didn't stage.
**How it bites.** You sweep another session's WIP into your commit, or two
sessions collide on the same file/table.
**Verify.** `git status --short` (expect only your files); `git diff --cached --stat`.
**Guardrail.** Convention (no executable guard — the weak point; see ADR 0003).
**Last incident.** 2026-06-11 R4 actor-gate collision; 2026-06-15 formatter near-miss.

## Never `node dist/index.js`; never deploy v2 work to `.63` pre-cutover
**Rule.** Restart the service with `systemctl restart nanoclaw` — never run
`node dist/index.js` directly. NEVER deploy v2 / migration work to `192.168.2.63`
(live V1 production) until cutover; `.61` only.
**Why.** Running as root creates root-owned files under `data/ipc/` and
`data/sessions/` that the container (UID 1000) can't read → EACCES loop. `.63` is
live V1 prod; v2 code there before cutover corrupts the live install.
**How it bites.** Silent EACCES crash-loop; or v2 code on a live V1 box.
**Verify.** N/A — operational discipline.
**Guardrail.** None (operational); firm standing rule.
**Last incident.** Standing; firm rule dated 2026-05-16.
