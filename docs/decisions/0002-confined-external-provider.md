# 0002 — An external-driven turn runs in a confined provider, not just a tool gate

**Status:** Accepted (2026-06-15)

## Context
The C7 capability gate (`denyIfExternalActorBlocked`) default-denies nanoclaw MCP
tools on a resolved-external turn. But that gate sees **only** the nanoclaw MCP
surface. It does NOT confine: the SDK built-in tools (`Read`/`Bash`/`Glob`/… —
not nanoclaw tools), the system prompt, the `cwd` (Claude Code auto-loads the
board `CLAUDE.md` from it), board `additionalDirectories`, or other installed MCP
servers. Adversarial review (Codex, 4 rounds on C4c) proved that "confine the
recipient of the reply" is not enough — the *content* the agent can read and
reflect back must be confined too (the "B6" control).

## Decision
An external turn runs in a **confined provider mode** (`QueryInput.confinedExternal`
/ `AgentProvider.supportsConfinedExternal`), layered defense-in-depth:

1. **Availability** via `disallowedTools` (already blocks built-in fs/bash/web for
   every turn) + `mcpServers` restricted to `nanoclaw` only. `allowedTools` is NOT
   the mechanism (see GOTCHAS → "`allowedTools` does NOT restrict…").
2. **Neutral `cwd`** — a fresh `mkdtemp` 0700 dir outside `/workspace`, removed
   after — so no board `CLAUDE.md` auto-loads.
3. **Minimal external-only system prompt**; **fresh continuation never persisted**
   (the board transcript stays board-private; the external turn is stateless).
4. **Engine boundary** — `apiAddNote` never resolves an external `sender_name` to a
   board person (so a display-name collision can't grant manager/assignee
   authority) and authorizes only `meeting + accepted, non-expired grant`,
   re-checked at mutation time.
5. A provider that does not set `supportsConfinedExternal` **fails the external
   turn closed** rather than running it with full board tools.

Enforced by: `confined-external.test.ts`, `chat-actor-guard.test.ts` registry
coverage, the engine spoof/grant tests, and the P4 e2e.

## Consequences
- **+** Multiple independent gates (provider tools, cwd, prompt, engine grant) —
  no single bypass opens the hole.
- **+** Fails closed for non-confining providers.
- **−** Adds a provider capability flag + a confined query path distinct from the
  board path (some duplication, justified by the different requirements).
- **−** The external agent runs with a minimal prompt — less helpful, by design.

## References
- `.claude/skills/add-taskflow/docs/2026-06-13-rc5ext-inbound-design.md` (§C7)
- `container/agent-runner/src/providers/claude.ts` (`computeAllowedTools`, confined branch)
- `container/agent-runner/src/poll-loop.ts` (the confined gate + `runConfinedExternalQuery`)
- `container/agent-runner/src/taskflow-engine.ts` (`apiAddNote` external auth)
- Commit C4c `195293cd`; go-live `156ac4dc`
