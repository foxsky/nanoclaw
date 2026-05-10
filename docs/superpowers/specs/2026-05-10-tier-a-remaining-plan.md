# Tier A — Remaining Work Plan

**Created:** 2026-05-10 (after A1/A6/A7/A8/A10/A11.1-5/A5-Phase-1 closed in the same session)

This document scopes the four Tier A items still open before v2 production cutover. Each is multi-session work; the breakdown below is what each session can ship.

## Remaining items

| # | Effort | Status |
|---|---|---|
| A2 | 1-2 days | mutation parity (full 235 corpus) |
| A3 | 2-3 days | migration safety (clean cutover verified) |
| A4 | 1 day | rollback verified |
| A5 Phase 2 | 1-2 days | CLAUDE.md regen for 4774 remaining v1 refs (update/query/create/hierarchy/dependency) |

**Total: ~5-8 days of focused work.**

## A2 — Mutation parity (full corpus)

**Context:** Read-side parity is already proven (623/623 same-shape v2 calls in the 2026-05-09 validation pilot). Mutation parity has been verified on a 10-mutation slice (8/10 expected delta; 2/10 hit guards). A2 expands this to the full 235 mutation corpus.

**Sub-tasks:**

1. **A2.1 — Build a reusable mutation-replay harness** (3-4h)
   - Parse session JSONLs from `/tmp/v2-pilot/*-sessions/` for `tool_use` + `tool_result` pairs whose tool name matches v1 mutation tools (taskflow_move, taskflow_admin, taskflow_reassign, taskflow_undo, taskflow_create, taskflow_update).
   - For each call, fork the v1 prod taskflow.db into a scratch DB, apply the same mutation through v2 engine, diff post-state row-by-row against v1's expected post-state.
   - Output a per-mutation report: `{ tool, params, v1_success, v2_success, state_diff_summary }`.

2. **A2.2 — Run the corpus and triage** (4-6h)
   - Replay ~235 mutations through the harness.
   - Bucket results:
     - ✅ same-shape success + same DB state
     - ⚠ same shape, different state (engine semantic shift — needs decision)
     - ❌ v1 success / v2 failure (regression — needs fix)
     - ⚠ v1 failure / v2 success (engine relaxation — usually OK, verify)
   - File any ❌ as bugs.

3. **A2.3 — Document acceptable v2 semantic shifts** (1-2h)
   - For each ⚠ shift, decide: accept-as-improvement, restore-v1-behavior, or document-as-known-difference.

**Success criterion:** ≥95% of mutations same-shape success + same-state; remaining 5% triaged and decided.

## A3 — Migration safety (clean cutover verified)

**Context:** `migrate-v2.sh` exists (26KB). Has never been run against a real v1 install in a controlled test. A3 proves it can clean-cutover an installation without data loss.

**Sub-tasks:**

1. **A3.1 — Build a v1-install clone harness** (4-6h)
   - Snapshot a v1 install (data/, groups/, .env, config files).
   - Restore the snapshot to a scratch directory.
   - Verify v1 host can start against the snapshot (sanity check).

2. **A3.2 — Run `migrate-v2.sh` against the clone** (2-3h)
   - Execute migration on the scratch directory.
   - Capture every step's output to a per-step log.
   - Expected post-state: agent_groups seeded, messaging_groups seeded, sessions DBs created, container_configs populated (carrying `.mcp.json` per A6).

3. **A3.3 — Build a post-migration verification suite** (4-6h)
   - SQL queries against `data/v2.db`: every v1 agent group has a corresponding row; every v1 messaging group is wired; every v1 board's `.mcp.json` sqlite server is in `container_configs.mcp_servers`.
   - Spot check 3-5 boards: do their CLAUDE.md + workspace files exist under `groups/<folder>/`?
   - Verify scheduled tasks were migrated to `messages_in` (per A.3.2 Step 2.3.g.2).

4. **A3.4 — Smoke-run the migrated v2 host** (2-3h)
   - Start v2 service against the migrated state.
   - Send one synthetic WhatsApp message to each top-tier board (a few).
   - Verify the agent container spawns, the engine reads taskflow.db, and a response gets delivered.

**Success criterion:** Migration completes without errors; post-migration verification suite green; smoke test produces correct responses on 3+ boards.

## A4 — Rollback verified

**Context:** `migrate-v2.sh` mentions "v1 unit file kept for rollback" but no automated rollback test exists.

**Sub-tasks:**

1. **A4.1 — Document the rollback procedure** (1-2h)
   - Step-by-step: stop v2 service, restore v1 data snapshot, re-enable v1 service.
   - Identify what's destructive: does `migrate-v2.sh` modify the v1 data dir, or copy from it? (Should copy; verify.)

2. **A4.2 — Test the rollback against an A3 clone** (3-4h)
   - Take the A3 clone (post-migration state).
   - Execute documented rollback.
   - Verify v1 service starts successfully.
   - Send a test message through v1, verify it still works.

3. **A4.3 — Document the irreversible window** (1h)
   - From cutover-execution to rollback-finished, how long is the window?
   - What happens to messages received during the cutover gap?

**Success criterion:** Rollback completes in <30 minutes; v1 service runs normally afterward; cutover playbook references this procedure.

## A5 Phase 2 — CLAUDE.md regen for the remaining 4774 v1 refs

**Context:** Phase 1 (commit `191bd5fb`) migrated 26.2% (1697/6471) of v1 tool refs across 36 boards. The remaining 73.8% (4774 refs) are calls to 5 tools with **different param shapes** in v2:

| v1 tool | v1 refs | v2 mapping | Approach |
|---|---|---|---|
| `taskflow_update` | 1918 | `api_update_simple_task` (subset of fields) + `api_task_add_note`/`edit_note`/`remove_note` | Workflow-language rewrite |
| `taskflow_query` | 1676 | `api_filter_board_tasks`, `api_board_activity`, `api_linked_tasks` | Per-sub-query mapping |
| `taskflow_create` | 861 | `api_create_simple_task`, `api_create_meeting_task` (A10) | Per-type branching |
| `taskflow_hierarchy` | 191 | `api_linked_tasks` (partial) | Partial map + manual review |
| `taskflow_dependency` | 128 | Folds into `api_update_simple_task` or `api_admin` action | Workflow-language rewrite |

**Sub-tasks:**

1. **A5.2.1 — Decide per-tool approach** (2-3h)
   - For each of the 5: ship a new MCP wrapper that preserves v1 vocabulary (like A11 did for move/admin/etc.), OR rewrite CLAUDE.md workflow language to compose v2's split surface.
   - Cost trade-off: new wrappers cost ~1-3h each but make A5 Phase 2 mechanical; workflow rewrites cost more per-board but no engine changes.

2. **A5.2.2 — Build wrappers for chosen tools** (4-12h depending on count)
   - Same pattern as A11: TDD-RED → GREEN → Codex → /simplify → commit.

3. **A5.2.3 — Extend the substitution script** (1-2h)
   - Add the new tools to `scripts/migrate-board-claudemd.ts`.
   - Re-run on the 36 cloned boards; expect 95%+ migration coverage.

4. **A5.2.4 — Manual review of edge cases** (2-4h)
   - The remaining few percent will be irregular call shapes the regex can't handle. Eyeball and fix.

5. **A5.2.5 — Apply to prod boards** (0.5h)
   - SSH to `nanoclaw@192.168.2.63`, run the script against `~/nanoclaw/groups/*/CLAUDE.md`.
   - Verify the migration counts match the cloned-boards run.

**Success criterion:** ≥95% migration coverage across all 37 boards; verified by sample-reading 3-5 boards.

## Recommended ordering

A2 → A3 → A4 → A5 Phase 2 is the natural order:
1. A2 first because it builds the most cutover confidence cheaply.
2. A3 next because it's the highest-risk operation.
3. A4 immediately after A3 (shares the clone harness).
4. A5 Phase 2 last because it has the smallest production-risk surface (boards keep working with current CLAUDE.md until the substituted version replaces it).

Cutover is gated on all four. Total ~5-8 days of focused work.
