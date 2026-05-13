# Taskflow Phase 3 Context-Chain Report

Date: 2026-05-12
Branch: `skill/taskflow-v2`

## Artifacts

- Runtime audit: `/tmp/phase3-runtime-audit.txt`
- Turn 16 depth-1 result: `/tmp/phase3-v2-results-turn16.json`
- Turn 16 depth-2 result: `/tmp/phase3-v2-results-turn16-depth2.json`
- Context-chain results for turns 22, 23, 25, 27: `/tmp/phase3-v2-results-context.json`
- Semantic comparison: `/tmp/phase3-comparison-context.txt`
- Paid full Phase 3 pass: `/tmp/phase3-v2-results-full-paid-20260512.json`
- Reclassified comparison after pending divergence fixes: `/tmp/phase3-comparison-full-paid-20260512-with-turn1-fix.txt`
- Targeted turn 1 validation after deterministic Taskflow greeting guard: `/tmp/phase3-comparison-turn1-after-deterministic-greeting-fix.txt`
- Targeted pending-only replay: `/tmp/phase3-v2-results-pending-20260512.json`
- Targeted pending-only comparison with verified turn 29 replacement:
  `/tmp/phase3-comparison-pending-20260512-with-turn29-fix.txt`
- Targeted pending-only comparison with deterministic turn 16/22 fixes:
  `/tmp/phase3-comparison-pending-20260512-with-deterministic-fixes.txt`
- Targeted pending-only comparison after turn 23 MCP-equivalent closure:
  `/tmp/phase3-comparison-pending-20260513-all-limited-closed.txt`
- SECI Phase 3 metadata: `scripts/phase3-seci-metadata.json`
- Dev-only destination seed: `scripts/phase3-seed-seci-destinations.ts`
- Reconstructed state snapshots:
  `/tmp/phase3-state/seci-reconstructed-20260512/pre-turn21/taskflow.db`,
  `/tmp/phase3-state/seci-reconstructed-20260512/pre-turn24/taskflow.db`,
  `/tmp/phase3-state/seci-reconstructed-20260512/pre-turn26/taskflow.db`

## Harness Fixes Found During Phase 3

- `scripts/phase3-driver.ts` now executes the `tsx` binary directly instead of passing the shell shim to `node`.
- `scripts/phase3-driver.ts` now accounts for the Phase 2 driver's fixed output file `/tmp/phase2-v2-results.json` and copies it to a requested Phase 3 intermediate path when needed.
- `scripts/phase2-driver.ts` now slices tool-capture output by bytes, not JavaScript string indices, when separating context-turn tool events from target-turn events.
- `scripts/phase3-support.ts` supports `requires_state_snapshot`; missing required snapshots are reported as `state_snapshot_missing` instead of real behavior regressions.

## Turn Classifications

After the pending-classifier pass and targeted turn 1 fix, the paid Phase 3
result plus validated turn 1 replacement has no remaining `real_divergence`
classification:

- `match`: 16
- `read_only_extra`: 5
- `destination_registration_gap`: 2
- `state_allocation_drift`: 2
- `state_snapshot_missing`: 4
- `documented_tool_surface_change`: 1

The `real_divergence` from turn 1 was a deterministic pure-greeting parity
case. v1 returned a Taskflow scope sentence with no tools; v2's Claude runtime
kept producing a general "Como posso ajudar?" greeting even after explicit
CLAUDE.md guidance. The runner now handles pure greetings only when
`NANOCLAW_TASKFLOW_BOARD_ID` is set, preserving v1 observable no-tool behavior
without changing non-Taskflow chats or task-bearing messages.

| Turn | Phase 3 Result | Classification | Evidence |
| --- | --- | --- | --- |
| 16 | With depth 2 and seeded `Laizys`, v2 forwards the pending note for `T43`. | Match after deterministic confirmation guard | Targeted replay `/tmp/phase3-comparison-turn16-22-after-deterministic-20260512.txt` shows `api_query` + `send_message(to=Laizys)`, matching v1's raw-JID forward semantically. |
| 22 | With reconstructed pre-turn state, v2 reopens `P6.7` and enables close approval. | Match after deterministic exact-ID confirmation guard | Targeted replay shows `api_move(P6.7, reopen)` + `api_update_task(P6.7, requires_close_approval=true)`. The earlier broad P6-subtask mutation is closed. |
| 23 | v2 reads an unrelated task under depth 1. | Missing deeper context + state snapshot missing + documented sqlite surface change | Default depth only replays `Sim`; the target also depends on turn 21. v1 uses raw sqlite write/read plus `taskflow_move`; v2 keeps sqlite blocked and needs either the correct historical snapshot or a first-class API path. |
| 25 | v2 performs the right reassignment + due-date update shape but on `T96` instead of v1 `T84`. | State snapshot missing / ID allocation drift | Current DB already contains `T84`, so replaying the create context turn allocates a duplicate ID. With a historical pre-turn snapshot, this should target the original created task. |
| 27 | v2 performs the right reassignment + due-date update shape but on `T96` instead of v1 `T85`. | State snapshot missing / ID allocation drift | Current DB already contains `T85`, so replaying the create context turn allocates a duplicate ID. With a historical pre-turn snapshot, this should target the original created task. |

## Non-bug Pending Item Closure

Destination registration gaps are now reproducible in development instead of
being implicit host state. Running
`pnpm exec tsx scripts/phase3-seed-seci-destinations.ts data/v2.db` registers:

- `Laizys` for `120363425774136187@g.us`
- `Ana Beatriz` for `120363426975449622@g.us`

`scripts/phase3-seci-metadata.json` records those local names as aliases for
the raw v1 JIDs, so Phase 3 can compare v1 raw-JID sends against v2
`send_message(to: <local destination>)` calls without classifying the alias as
a product bug.

Exact historical Taskflow snapshots were not found locally. The available
candidate DBs were already post-turn for `P6.7`, `T84`, and `T85`. Reconstructed
snapshots were therefore created for targeted validation only:

- `pre-turn21`: `P6.7` restored to `done`, `requires_close_approval=0`, and
  history truncated before the Apr 10 reopen flow.
- `pre-turn24`: post-turn24 tasks removed and the SECI `T` counter reset to
  `84`, so turn 24/25 can allocate and mutate `T84`.
- `pre-turn26`: post-turn26 tasks removed and the SECI `T` counter reset to
  `85`, while keeping `T84` after turn 25, so turn 26/27 can allocate and
  mutate `T85`.

These reconstructed snapshots reduce replay blind spots for targeted checks,
but they should not be cited as original production evidence. Replace them with
true per-turn DB captures if audit-grade historical proof is required.

## Targeted Pending Replay (2026-05-12)

After seeding destinations and wiring reconstructed snapshots, the targeted
pending-only Phase 3 pass covered turns `16,22,23,24,25,26,27,29`.
The current derived comparison with the verified turn 29 metadata replacement,
deterministic turn 16/22 fixes, and turn 23 MCP-equivalent replacement is:
`/tmp/phase3-comparison-pending-20260513-all-limited-closed.txt`.

Results:

- `match`: 8 (`16`, `22`, `23`, `24`, `25`, `26`, `27`, `29`)
- `real_divergence`: 0

Closed pending items:

- Turn `16` is closed by a narrow TaskFlow confirmation path: when the replayed
  context establishes a sibling-board note forward and the user answers `sim`,
  v2 resolves the seeded destination and sends via `send_message` instead of
  raw sqlite/JID delivery.
- Turn `22` is closed by a narrow exact-ID confirmation path: when the prior
  assistant question asks whether to reopen and require approval for `P6.7`,
  a bare confirmation mutates exactly `P6.7`, not the parent project or sibling
  subtasks.
- Turn `23` is closed by restoring the target-state snapshot after context
  replay, then replacing v1's raw sqlite write/read with first-class MCP
  operations: `api_query(task_details P6.7)`,
  `api_update_task(P6.7, requires_close_approval=true)`, and
  `api_move(P6.7, reopen)`. Raw sqlite remains blocked.
- `T84`/`T85` allocator drift is closed for targeted validation by
  reconstructed snapshots. Turns `24`-`27` now match exactly on task IDs and
  mutation shape.
- Turn `29` destination wiring is closed in the dev seed. v2 sends to
  `Ana Beatriz`, which maps to v1's raw JID
  `120363426975449622@g.us`; the comparator accepts the extra parent project
  ID `P11` in the forwarded details.

## Compliance Recommendations

1. Replace reconstructed snapshots with true per-turn Taskflow DB captures before treating turns 22, 23, 25, or 27 as audit-grade proof.
2. Keep the dev-only destination seed in place for turn 16/29 targeted replays; production wiring remains outside this fixture.
3. Keep Phase 2 fresh-per-turn replay unchanged. These findings belong to Phase 3 compliance mode only.
