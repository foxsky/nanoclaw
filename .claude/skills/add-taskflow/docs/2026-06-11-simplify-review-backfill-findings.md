# /simplify review — destination-backfill feature (4 unpushed commits + working tree), 2026-06-11

**To the session owning the backfill work** (b7fea307 / 93af2a29 / the dirty working tree): four
parallel cleanup reviewers (reuse / simplification / efficiency / altitude) ran over your diffs.
Your files were ALL mid-edit, so nothing was changed — findings handed off here instead, deduped
from 21 raw to 8 mechanisms, priority order. The one reviewed hunk NOT yours (taskflow-engine.ts
gate comment) came back clean.

## P1 — one `ensureDestination` helper (3 reviewers converged on this)
The exists→target-compare→collision-count→dry-run→insert composite is hand-copied **3×** across the
two backfill modules (cross-board child leg ~128, parent leg ~155; person ~134) and already
DIVERGED: the person module's dry-run gained the in-memory `planned` map (in-run duplicate-name
detection) — the cross-board dry-run still has the false-all-clear blind spot its own sibling's test
comment warns about. The same composite also lives inline at provision-child-board.ts:424/549 and
create-agent.ts:99. Fix: one `ensureDestination(agentGroupId, localName, targetId, {dryRun, planned,
report, log})` next to `createDestination` in agent-destinations.ts — 6+ immediate call sites.

## P2 — startup self-heal never self-disables (altitude)
`backfillTaskflowDestinations` (src/index.ts:~108) rescans every link + board_people row on EVERY
boot forever, re-warning the same collisions forever, and is a permanent second writer of rows the
provision path owns (naming drift ⇒ silent resurrections). The repo's own counter-precedent sits one
line above: `dropScheduledTasksIfDrained` (self-disabling). Fix: completed-clean marker (v2.db row or
a migrations entry once `unresolved===0 && name_collisions===0`); keep re-run-until-clean only while
the marker is absent.

## P3 — N+1 + missing transaction (efficiency; matters at prod scale on the boot path)
- Both loops re-prepare + point-query per row: cross-board = 6 prepares+queries/link (and
  re-resolves the same (folder,jid) per child); person = 3/row over the biggest table. Fix: bulk-load
  agent_groups / messaging_group(+agents) / agent_destinations into 3 Maps up front (the `planned`
  map already proves the pattern); loop does zero DB reads. Healed steady state becomes O(1)-ish.
- No `db.transaction()` around the insert loops ⇒ one fsync PER ROW on first boot/migration
  (hundreds of rows at cutover) + partial state if interrupted. Wrap each backfill's writes.

## P4 — migrate-v2.sh 1g/1h at wrong depth (altitude)
They're shell-level grafts conscripting the operator CLIs into run_step's OK:/ERROR: grep contract
(the exit(1)→ERROR-lines whipsaw between your two snapshots is the symptom), and the
no-taskflow.db skip is silent — unlike every sibling step's recorded `SKIPPED:`. Fix: a thin
`setup/migrate-v2/destinations.ts` step module (peer of tasks.ts) owning the protocol + a
step-integration.test.ts case; revert the scripts/ CLIs to pure operator tools.

## P5 — reuse the existing db layer (reuse)
- person:71 `findMessagingGroupId` ≡ `getMessagingGroupByPlatform` (src/db/messaging-groups.ts:43).
- person:78 `insertMessagingGroup` raw INSERT bypasses `createMessagingGroup` (:30) — the layer whose
  comment exists to keep `is_main_control` out of insert paths; wireV2 already inserts the identical
  constants via the helper.
- person:41 `normalizeIdPart` = third slugifier; compose `normalizeName`
  (agent-destinations.ts:128) + the NFD strip from `sanitizeFolder` (provision-shared.ts:235).
- cross-board:72 `resolveAgentAndMessagingGroup` join ≡ `getMessagingGroupsByAgentGroup`
  (messaging-groups.ts:289) + `.find(platform_id)`. (Moot if P3's bulk-Maps land.)

## P6 — blob-decode altitude (CORRECTNESS-ADJACENT — route to /code-review if disputed)
`normalizePrompt` (tasks.ts:42) patches ONE of TWO readers of v1 `scheduled_tasks.prompt`:
`migrate-scheduled-tasks.ts:123` reads the same column from the v1-copied taskflow.db on every boot
and would still serialize a blob row as `{"type":"Buffer",...}`. Right altitude: decode inside the
shared `taskEnvelope()` (provision-shared.ts:223) and have tasks.ts call it (it imports host modules
already) — both readers inherit. Also: the 3-branch normalizePrompt collapses to
`Buffer.isBuffer(p) ? p.toString('utf8') : String(p)`.

## P7 — small dedups (simplification)
- The fail-soft rationale prose is written 4× (both CLI epilogues + migrate-v2.sh comment + the
  self-heal docstring) — it already needed a 3-file synchronized edit once IN this diff. Keep it once.
- Twin try-blocks in backfill-taskflow-destinations.ts:31-63 → one `heal(label, fn, summarize)`.
- Collision/unresolved counts printed 3× per CLI run → keep ERROR: + OK: only.
- Three test files each carry their own seedBoard/seedV2Wiring copy → export once
  (e.g. src/modules/taskflow/backfill-test-helpers.ts).

## P8 — triple `hasTable('agent_destinations')` per boot
Orchestrator pre-checks; both modules re-check + throw the same condition. Keep one layer.
