# Taskflow Phase 3 Context-Chain Report

Date: 2026-05-12
Branch: `skill/taskflow-v2`

## Artifacts

- Runtime audit: `/tmp/phase3-runtime-audit.txt`
- Turn 16 depth-1 result: `/tmp/phase3-v2-results-turn16.json`
- Turn 16 depth-2 result: `/tmp/phase3-v2-results-turn16-depth2.json`
- Context-chain results for turns 22, 23, 25, 27: `/tmp/phase3-v2-results-context.json`
- Semantic comparison: `/tmp/phase3-comparison-context.txt`

## Harness Fixes Found During Phase 3

- `scripts/phase3-driver.ts` now executes the `tsx` binary directly instead of passing the shell shim to `node`.
- `scripts/phase3-driver.ts` now accounts for the Phase 2 driver's fixed output file `/tmp/phase2-v2-results.json` and copies it to a requested Phase 3 intermediate path when needed.
- `scripts/phase2-driver.ts` now slices tool-capture output by bytes, not JavaScript string indices, when separating context-turn tool events from target-turn events.
- `scripts/phase3-support.ts` supports `requires_state_snapshot`; missing required snapshots are reported as `state_snapshot_missing` instead of real behavior regressions.

## Turn Classifications

| Turn | Phase 3 Result | Classification | Evidence |
| --- | --- | --- | --- |
| 16 | Fails with depth 1; with depth 2 v2 identifies that `T43` belongs to Laizys but does not forward. | Missing API/destination capability | v1 sends `send_message(target_chat_jid=120363425774136187@g.us)`. v2 only has the `seci-taskflow` named destination for `ag-phase2-seci`, so it tells the user to send directly instead of forwarding. |
| 22 | v2 mutates active P6 subtasks instead of reopening `P6.7`. | State snapshot missing / state drift | Current DB has later `P6.7` history and `requires_close_approval=1`; v1 baseline had `P6.7` done with approval disabled. |
| 23 | v2 reads an unrelated task under depth 1. | Missing deeper context + state snapshot missing + documented sqlite surface change | Default depth only replays `Sim`; the target also depends on turn 21. v1 uses raw sqlite write/read plus `taskflow_move`; v2 keeps sqlite blocked and needs either the correct historical snapshot or a first-class API path. |
| 25 | v2 performs the right reassignment + due-date update shape but on `T96` instead of v1 `T84`. | State snapshot missing / ID allocation drift | Current DB already contains `T84`, so replaying the create context turn allocates a duplicate ID. With a historical pre-turn snapshot, this should target the original created task. |
| 27 | v2 performs the right reassignment + due-date update shape but on `T96` instead of v1 `T85`. | State snapshot missing / ID allocation drift | Current DB already contains `T85`, so replaying the create context turn allocates a duplicate ID. With a historical pre-turn snapshot, this should target the original created task. |

## Compliance Recommendations

1. Add per-turn Taskflow DB snapshots for stateful context chains before treating turns 22, 23, 25, or 27 as behavior regressions.
2. Add a first-class v2 capability for cross-board/sibling-board note forwarding if strict v1 parity is required for turn 16. Do not re-enable raw sqlite.
3. For turn 23, rerun with at least depth 2 after a historical DB snapshot is available; depth 1 is provably insufficient.
4. Keep Phase 2 fresh-per-turn replay unchanged. These findings belong to Phase 3 compliance mode only.
