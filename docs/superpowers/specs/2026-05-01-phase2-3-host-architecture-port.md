# Phase 2 + 3 Host-Architecture Port — Strategic Design

> **STATUS: OBSOLETE (2026-05-01).** This entire spec is premised on editing `src/` directly to align toward upstream (Strategy A bottom-up port). The skills-only rule (`feedback_no_nanoclaw_codebase_changes.md`) forbids that approach. The Phase 2 + 3 work has been reframed under v3.0 of the migration plan: Track A skill extraction (`add-whatsapp` + `add-taskflow` absorb fork-private behavior into `modify/` trees) followed by Track B cutover (codebase tree replaced with upstream + skill replay). See `docs/superpowers/plans/2026-04-23-nanoclaw-v2-migration.md` v3.0 for the current authoritative framing. The content below is preserved for historical context only — do NOT execute against it.

> **Original status:** strategic. Replaces the implicit "Phase 2 = WhatsApp adapter, Phase 3 = isMain rewrite" framing with the empirical reality: porting v2's host-side modules cascades through the entire architecture. **The honest budget is 5-7 weeks of focused work** for both phases combined.

## The realization

Phase 2 Task 2.3 ("port v2's permissions module") was scoped today (2026-05-01) as 1 week of work. Closer inspection of the import graph shows that's not bounded:

```
src/modules/permissions/sender-approval.ts
  ← imports `getDeliveryAdapter` from src/delivery.ts             (NOT in fork)
  ← imports `getMessagingGroup` from src/db/messaging-groups.ts   (NOT in fork)
  ← imports `InboundEvent` from src/channels/adapter.ts           (NOT in fork)
  ← imports `pickApprovalDelivery, pickApprover` from src/modules/approvals/primitive.ts
                                                                  (NOT in fork — own subtree)

src/modules/approvals/primitive.ts
  ← imports `getSession, createPendingApproval` from src/db/sessions.ts  (NOT in fork)
  ← imports `wakeContainer` from src/container-runner.ts (v1 has it but with different signature)
  ← imports `writeSessionMessage` from src/session-manager.ts            (NOT in fork)
  ← imports `getMessagingGroup` from src/db/messaging-groups.ts          (NOT in fork)
  ← imports `getAdminsOfAgentGroup` from src/modules/permissions/db/user-roles.ts
                                                                          (its own subtree)
```

Every host-side module brings in 3-5 more host-side modules. The cascade reaches:
- v2 central DB layer (~6 files: connection, agent-groups, messaging-groups, sessions, dropped-messages, schema)
- v2 delivery / response-registry / session-manager (~3 files)
- v2 ChannelAdapter abstraction (`src/channels/adapter.ts` + `channel-registry.ts` + `ask-question.ts`)
- v2 type definitions (`src/types.ts` is fundamentally different in v2)
- Plus the ~16 files inside permissions/ + approvals/ themselves

**Total surface for "v2 host port": ~30 files, ~3000-5000 lines of code.** Plus the test files.

## Why Phase 1 was different

Phase 1 (Bun container-runtime port) was successful in 1 day because `container/agent-runner/` is a self-contained tree with its own package.json, deps, and entry point. The host-side `src/` is the opposite — every file imports from 3-5 others; cherry-picking a module pulls in the whole graph.

## Two strategies

### Strategy A: Bottom-up port (5-7 weeks)

Port the v2 host architecture in dependency order:

1. **Week 1: v2 type system + DB layer.** Replace our `src/types.ts`, `src/db.ts`, `src/db/*` with v2's. Includes the `messaging_groups` + `agent_groups` + `messaging_group_agents` triple, two-DB session split (`inbound.db` + `outbound.db`), `users` / `user_roles` / `agent_group_members` / `user_dms`, `pending_*_approvals`. ~12 schema migrations.
2. **Week 2: v2 channel abstraction.** New `ChannelAdapter` interface, `channel-registry.ts`, `ask-question.ts` option helper. Re-port our v1 `WhatsAppChannel` against v2's interface (THIS is what original Phase 2 was supposed to be — but it's smaller now because we're rebuilding everything, not patching).
3. **Week 3: v2 delivery + session-manager + response-registry.** `delivery.ts`, `session-manager.ts`, `host-sweep.ts`. Touches every IPC path.
4. **Week 4: v2 permissions module.** Now its imports resolve cleanly. The actual permissions/ + approvals/ directory port is straightforward at this point.
5. **Week 5: v2 router + isMain rewrite.** All ~167 isMain hits become `await hasAdminRole(senderUserId, agentGroupId)` calls now that user_roles is in place.
6. **Week 6: TaskFlow sidecar table + scheduled_tasks port.** Phase 3 cleanup.
7. **Week 7: Wire-up + integration tests.**

Pros: each week ships an internally-consistent layer. Easier to test. Easier to revert.
Cons: long. The host has zero working state between Week 1 (types/DB) and Week 4 (permissions); can't smoke-test until all four lower layers are in.

### Strategy B: Top-down with stubs (4-6 weeks, riskier)

Port permissions/ first (channel-side too); stub every dependency that doesn't exist yet; replace stubs as we port the lower layers.

Pros: working approval-card flow earlier (with stub backend); closer to TDD.
Cons: lots of throwaway stubs; messy intermediate states; harder to review.

### Recommendation: Strategy A

A is the disciplined choice. It also matches v2's own development order — upstream built the layers bottom-up too.

## Re-budget

| Phase (old name) | Old budget | New budget | Notes |
|---|---|---|---|
| Phase 2 (WhatsApp re-port) | 2-3 weeks | merged into 2+3 | Was always "host port + adapter wire-up" |
| Phase 3 (isMain rewrite + sidecar + scheduled_tasks + env) | 4 weeks | merged into 2+3 | The 167 isMain sites are part of the host port |
| **Combined (host architecture port)** | **6-7 weeks** | **5-7 weeks Strategy A** | About the same; just merged honestly |

Net plan: was 14-18 weeks → today's "10-13 weeks" claim was over-optimistic by 1-2 weeks. **Realistic estimate: 11-15 weeks full-time** if Strategy A.

## What does NOT change

- Phase -1 ✅ (infra, rollback infra)
- Phase -1.5 ✅ (security audit no-op)
- Phase 0 ✅ 7/8 (recon + migrator dry-run + OneCLI + Bun smoke; only WhatsApp pairing op-blocked)
- Phase 1 ✅ (Bun container port — self-contained tree, properly isolated)
- Phase 4 (shadow test on test-taskflow) — still 5 days, blocked on Phase 0.5
- Phase 5 (cutover) — still 2h window
- Phase 6 (composed CLAUDE.md, a2a-lite) — still ~2 weeks

## Lessons that drove this realization

Per memory `feedback_codex_before_closure.md`: today's "Phase 2 dissolved" claim was the WORST under-scope. The v2/v1 whatsapp.ts diff was 21 lines BUT only because both files I diffed were our fork. Real upstream diff was 1504 lines. AND even that was a small piece of the actual host port. Three layers of under-scope, each caught by Codex review.

Per memory `feedback_diff_direction_check.md`: not just the diff, but the IMPORT GRAPH around the diff. A small file diff doesn't mean a small port; you have to walk the imports.

Per memory `feedback_tdd_test_first.md`: writing tests forces you to confront the dependency graph. If we'd started writing the integration test BEFORE implementing, we'd have hit "missing module" errors by import #2. The test would have surfaced this scope realization in 5 minutes, not after 36 commits of optimism.

## Next session: starting Strategy A Week 1

### Updated Week 1 dependency order (Codex review #3 caught 3 missing deps)

The naive "types + db/ first" plan misses transitive imports that block the typecheck gate:

- `upstream/main:src/types.ts:158` imports `./channels/ask-question.js` — must port that file too
- `upstream/main:src/db/messaging-groups.ts:11-16` imports `../modules/agent-to-agent/db/agent-destinations.js` — module-level import, not optional
- `upstream/main:src/db/connection.ts:5` imports `../log.js` — but our fork has `logger.ts`, not `log.ts`. Either rename + adapt, or stub `log.ts` as a re-export.

`db/sessions.ts` does NOT import session-manager.ts (good). And v2's `db/*` does NOT import `delivery.ts` or `response-registry.ts` (good — those still come in Week 3).

### Concrete first commits on feat/v2-migration

```bash
cd /root/nanoclaw-feat-v2
git fetch upstream main

# Step 1: rename our logger.ts so v2's log.ts import resolves.
git mv src/logger.ts src/log.ts
# (Update every importer of logger.ts → log.ts, ~10-15 sites.)

# Step 2: pull in v2's types + supporting one-liners.
git checkout upstream/main -- src/types.ts src/channels/ask-question.ts

# Step 3: pull in v2's db layer + the agent-destinations module it imports.
git checkout upstream/main -- src/db/ src/modules/agent-to-agent/db/agent-destinations.ts

# Step 4: typecheck. Expect ~200-250 errors initially (was 150-200 before
# Codex's revision; the additional modules surface more import sites).
cd container/agent-runner && bunx tsc --noEmit
```

### Work breakdown

1. Rename `logger.ts` → `log.ts` + update importers (~half day).
2. Pull v2's `types.ts`, `channels/ask-question.ts` (~1 hour).
3. Pull v2's `db/` directory + `modules/agent-to-agent/db/agent-destinations.ts` (~1 hour).
4. Migrate our existing `db.ts` callers one-by-one to the new shape (rest of Week 1).
5. Remove our `registered_groups` reads (satisfied by v2's `messaging_groups` joins now).
6. End-of-week gate: `bunx tsc --noEmit` passes on host.

Watch out for: any v2 db file that itself depends on something Week 2-3 ports (delivery, session-manager). If found, need to stub or reorder.
