# 0001 — Security-sensitive inbound features ship DARK until every guard exists

**Status:** Accepted (2026-06-15)

## Context
A new inbound path that lets an *external* (non-board) party drive a board agent
(RC5-ext: an external WhatsApp participant DMs the bot) is a new attack surface.
Building the whole flow and only then turning it on means the half-built,
partially-guarded version is reachable in production the moment any single piece
lands.

## Decision
Build the entire flow with the activation switch **OFF** until every container
guard exists, then flip it in one reviewed change.

**During the DARK build phase (C4b `0de97550` → P4 `9f3f6e71`):**
- The host resolver (`resolveUnroutedExternalDm`) was written + unit-tested but
  **not registered** (`setUnroutedDmResolver` was not called) — so no external row
  could be written into a board session.
- The poll-loop kept a **fail-closed gate** for any external-actor row until the
  confined execution path was complete.

**At go-live (`156ac4dc` — registration happened ONLY after C4b/C4c/C6/P4 all
landed Codex-clean):** `src/modules/taskflow/index.ts` now calls
`setUnroutedDmResolver(resolveUnroutedExternalDm)`. Current enforcement is the
registered host resolver (grant-gated, fail-closed) + the confined poll-loop path
(C4b/C4c) + the engine per-meeting grant re-check.

**The flow is registered in code but NOT deployed** — production is still inert
until a deliberate deploy (see GOTCHAS → "never deploy v2 to `.63` pre-cutover").
The *pattern* this ADR records — ship dark, register only when fully guarded — is
what generalizes; the dark↔live state above is point-in-time.

## Consequences
- **+** Every unit lands safe (DARK) and is reviewable in isolation; no
  half-guarded surface is ever live.
- **+** A clear, auditable go-live commit (`156ac4dc`) that a human can gate on.
- **−** There is intentionally "dead until wired" code between build and go-live.
  A reviewer might try to "clean up" the unregistered resolver or the
  fail-closed gate — **do not**; the darkness is the safety property.
- **−** "Built" ≠ "live". Track the activation switch explicitly so nobody assumes
  the feature is on.

## References
- `.claude/skills/add-taskflow/docs/2026-06-13-rc5ext-inbound-design.md` (§Phasing)
- Commits: C4b `0de97550` · C4c `195293cd` · C6 `169cc358` · P4 `9f3f6e71` · go-live `156ac4dc`
- `src/modules/taskflow/index.ts` (the `setUnroutedDmResolver` switch)
- GOTCHAS → "Never deploy v2 work to .63 pre-cutover" (registered-in-code ≠ deployed)
