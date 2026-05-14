# Taskflow Phase 3 Compliance Validation

Phase 2 validates v2 behavior against the curated corpus with fresh-per-turn
isolation. That remains the right default for independent turns. Phase 3 is a
separate compliance mode for turns where v1 behavior depended on in-session
context, historical DB state, or raw sqlite/tool-surface details that Phase 2
cannot prove by tool-name comparison alone.

## When To Use Phase 3

Use Phase 3 for:

- context-dependent replies such as `sim`, `esta tarefa`, or assignment
  follow-ups that depend on the immediately preceding live turn;
- state-sensitive mutations where the current DB may already be at the target
  state;
- v1 raw-sqlite turns that must be classified as an accepted tool-surface
  change or a missing first-class `api_*` capability;
- semantic compliance reports that compare action, task IDs, mutation type,
  recipient, and outbound intent.

Do not use Phase 3 to make normal Phase 2 carry synthetic session state. The
context chain must come from the real source JSONL.

## Metadata

Phase 3 accepts optional metadata with one row per corpus index:

```json
[
  {
    "turn_index": 16,
    "context_mode": "chain",
    "source_jsonl": ".claude/projects/-workspace-group/example.jsonl",
    "source_turn_index": 42,
    "prior_turn_depth": 1,
    "state_snapshot": "/tmp/phase3-state/turn-16/taskflow.db",
    "target_state_snapshot": "/tmp/phase3-state/turn-16-target/taskflow.db",
    "expected_behavior": {
      "action": "forward",
      "task_ids": ["M1", "M2"],
      "allow_extra_task_ids": true,
      "recipient": "120363426975449622@g.us",
      "recipient_aliases": ["Ana Beatriz"]
    }
  }
]
```

Fields:

- `context_mode`: `fresh` or `chain`.
- `source_jsonl`: original source JSONL path, relative to `--source-root`.
- `source_turn_index`: source turn index inside the extracted JSONL.
- `prior_turn_depth`: number of real prior turns to replay before the target.
- `state_snapshot`: optional per-turn Taskflow DB snapshot.
- `target_state_snapshot`: optional chain-mode Taskflow DB snapshot restored
  after context turns and immediately before the scored target turn. Use this
  when context is needed for session history but the target must start from a
  historical DB state that differs from v2's synthetic context mutations.
- `expected_behavior`: optional semantic expectation. If omitted, Phase 3
  derives expected behavior from v1 recorded tools.
- `expected_behavior.allow_extra_task_ids`: optional explicit allowance for
  forward/read turns where v2 includes parent/project IDs while preserving the
  requested task focus.
- `expected_behavior.recipient_aliases`: optional local v2 destination names
  that resolve to the same raw v1 recipient JID in the test seed.

Known context-chain defaults are inferred for corpus turns `16`, `22`, `23`,
`25`, and `27`, but explicit metadata is preferred for compliance work.
The SECI compliance metadata for this migration is checked in at
`scripts/phase3-seci-metadata.json`.

## Planning

Print the inferred Phase 3 plan without running containers:

```bash
pnpm exec tsx scripts/phase3-driver.ts \
  --corpus /tmp/whatsapp-curated-seci-v4.json \
  --metadata /tmp/phase3-metadata.json \
  --source-root /tmp/v2-pilot/all-sessions/seci-taskflow \
  --all \
  --plan-only
```

## Running Context-Chain Validation

Seed the SECI dev-only named destinations before validating forward turns:

```bash
pnpm exec tsx scripts/phase3-seed-seci-destinations.ts data/v2.db
```

This inserts or updates only `ag-phase2-seci` fixture rows:

- `Laizys` → `120363425774136187@g.us`
- `Ana Beatriz` → `120363426975449622@g.us`

Run a single context-dependent turn:

```bash
sudo -u nanoclaw -H env LOG_LEVEL=info \
  NANOCLAW_PHASE2_RAW_PROMPT=1 \
  NANOCLAW_TOOL_USES_PATH=/workspace/.tool-uses.jsonl \
  bash -c 'cd /root/nanoclaw && /root/nanoclaw/node_modules/.bin/tsx \
    scripts/phase3-driver.ts \
      --corpus /tmp/whatsapp-curated-seci-v4.json \
      --metadata scripts/phase3-seci-metadata.json \
      --source-root /tmp/v2-pilot/all-sessions/seci-taskflow \
      --turn 16 \
      --out /tmp/phase3-v2-results-turn16.json'
```

`phase3-driver.ts --corpus` is forwarded into the underlying Phase 2 driver,
so Phase 3 can replay either the original 30-turn corpus or a generated
coverage-audit candidate corpus. The original 30-turn corpus has built-in
chain-mode defaults for its known missing-context turns; generated corpuses
stay fresh by default unless their own metadata asks for chain mode. For
example, after producing
`/tmp/whatsapp-seci-next-candidates-20260514.json`, plan it with:

```bash
pnpm exec tsx scripts/phase3-driver.ts \
  --corpus /tmp/whatsapp-seci-next-candidates-20260514.json \
  --source-root /tmp/v2-pilot/all-sessions/seci-taskflow \
  --all \
  --plan-only
```

The driver snapshots the live Taskflow DB before the run and restores it
afterward. If `state_snapshot` is set and exists, it is restored before the
turn. If it is missing, the result is marked as `state_snapshot_missing` rather
than treated as a v2 behavior bug.

## State Snapshots

Exact historical per-turn Taskflow snapshots were not present in the local
workspace as of 2026-05-12. The checked candidates
(`/tmp/v2-pilot/taskflow*.db`, `data/taskflow/taskflow.db`, and
`data/taskflow/taskflow.db.pre-turn24-cleanup-20260511`) already contained
post-turn state for `P6.7`, `T84`, and `T85`.

For targeted validation only, reconstructed snapshots were created under:

- `/tmp/phase3-state/seci-reconstructed-20260512/pre-turn21/taskflow.db`
- `/tmp/phase3-state/seci-reconstructed-20260512/pre-turn24/taskflow.db`
- `/tmp/phase3-state/seci-reconstructed-20260512/pre-turn26/taskflow.db`

These roll back only the state needed by the SECI corpus turns: `P6.7` before
the Apr 10 review-flow clarification, the `T84` allocation before turn 24, and
the `T85` allocation before turn 26. They are useful for targeted confidence
checks, but they are not original production snapshots. For audit-grade
compliance, replace these metadata paths with true per-turn DB captures.

## Semantic Comparison

Compare Phase 3 output:

```bash
pnpm exec tsx scripts/phase3-compare.ts \
  --in /tmp/phase3-v2-results-turn16.json \
  --out /tmp/phase3-comparison-turn16.json \
  --out-text /tmp/phase3-comparison-turn16.txt
```

The comparator reports:

- user-facing action: `ask`, `read`, `mutate`, `forward`, or `no-op`;
- task IDs read or affected;
- mutation types;
- outbound recipient;
- outbound content intent;
- raw-sqlite parity recommendations.

## Raw SQLite Policy

v2 keeps raw sqlite blocked. Phase 3 classifies v1 raw sqlite turns as:

- `missing_context`: replay with context-chain before deciding;
- `state_drift` or `state_snapshot_missing`: rerun with the correct DB state;
- `documented_tool_surface_change`: accepted v1→v2 surface difference;
- `missing_api_capability`: add a narrow first-class `api_*` capability if
  strict parity is required.

For the known `T43` cross-board lookup pattern (corpus turn 17), the
compliance decision was to add a first-class `api_query({ query:
'find_task_in_organization', task_id: 'TXXX' })` capability. The engine
scopes the lookup to the agent's org tree (root + descendants, same
scope as `find_person_in_organization`) and returns owning-board
metadata for the agent to render. Mutation paths still go through the
strict, board-scoped `getTask` — no new cross-board write surface was
introduced. Do not re-enable raw sqlite.

## Full-History Coverage Audit

The SECI 30-turn corpus is the compliance baseline used for the Phase 2/3
migration closure, but it is not the entire historical interaction space. To
avoid over-claiming from one curated slice, run the coverage audit against all
extracted human WhatsApp turns before declaring full-board migration
confidence.

First extract the full historical corpus without truncation:

```bash
pnpm exec tsx scripts/whatsapp-replay-curate.ts \
  --jsonls /tmp/v2-pilot/all-sessions/seci-taskflow \
  --out /tmp/whatsapp-all-seci-$(date +%Y%m%d).json \
  --max 10000
```

Then compare that full corpus with the validated baseline:

```bash
pnpm exec tsx scripts/taskflow-replay-coverage-audit.ts \
  --all /tmp/whatsapp-all-seci-20260514.json \
  --baseline /tmp/whatsapp-curated-seci-v4.json \
  --out-json /tmp/taskflow-full-history-coverage-20260514.json \
  --out-text /tmp/taskflow-full-history-coverage-20260514.txt \
  --candidate-out /tmp/whatsapp-seci-next-candidates-20260514.json
```

The audit is free: it reads v1-recorded transcripts and does not run an agent.
It groups turns by behavior signature, reports which signatures the validated
baseline did not cover, and emits a candidate replay corpus focused on
uncovered or under-sampled behavior. As of the 2026-05-14 SECI audit:

- full extracted human turns: `295`;
- validated baseline turns: `30`;
- behavior signatures covered by the baseline: `23/87`;
- uncovered signatures: `64`, including `56` high-priority signatures;
- suggested next replay set: `40` turns.

The highest-risk uncovered buckets were:

- meeting/project/inbox creation flows;
- scheduling/reminder flows;
- bulk admin reparent/detach and approval flows;
- Agent/Bash-assisted summaries and board reviews;
- archive-search and search-plus-details read flows;
- v1 raw-sqlite notification/cross-board routing reads that need explicit
  `api_*` equivalents or documented tool-surface-change classification.

Use the generated candidate corpus as the next paid replay target only after
approval. The candidate corpus is intentionally coverage-oriented rather than
random: it tries to prove missing behavior classes, not re-run already-proven
single-tool basics. If that pass exposes real v2 bugs, patch the canonical
engine/MCP/provider/template layer and add regression tests before expanding
again.

The first paid 40-turn coverage replay was run on 2026-05-14:

- results: `/tmp/phase3-v2-results-seci-coverage-20260514.json`;
- comparison: `/tmp/phase3-comparison-seci-coverage-20260514.txt`;
- completed all `40/40` turns;
- semantic comparator baseline: `5/40` matches, `3` no-outbound timeouts,
  `13` real-divergence candidates, `7` state-drift classifications,
  `8` read-only-extra classifications, `3` documented raw-sqlite
  tool-surface changes, and `1` allocation-drift case.

The highest fan-out read regressions in that replay were project-summary
requests. v2 now exposes three first-class MCP query discriminators:

- `api_query({ query: 'projects' })` for compact active project lists;
- `api_query({ query: 'project_next_actions' })` for one-shot next actions
  grouped by project;
- `api_query({ query: 'projects_detailed' })` for projects, active
  activities, and note excerpts.

A targeted paid replay after this fix used:

- results: `/tmp/phase3-v2-results-seci-projects-afterfix-20260514.json`;
- turns: `6`, `25`, and `26`;
- outcome: each turn used exactly one `api_query` and produced one outbound
  response. This removed the prior 32-call detailed-report loop, 40-call
  project-next-actions loop, and 27-call project-list loop from the coverage
  replay.

The bulk person-approval bucket was then validated after adding a deterministic
approval handler:

- results:
  `/tmp/phase3-v2-results-seci-bulk-approval-after-deterministic-20260514.json`;
- turns: `7`, `34`, `35`, and `36`;
- outcome: each turn used one `api_query` and produced one outbound response.
  Turn `7` no longer times out. Because the current DB has no review tasks for
  Mauro, Rodrigo Lima, Joselé, or João Antonio, these targeted replays are
  state-drift/no-op evidence; the mutation path is covered by the integration
  test that bulk-approves a seeded review queue without querying the provider.

The raw-sqlite forwarding bucket now has a v2-native destination path:

- `scripts/backfill-taskflow-person-destinations.ts` reads
  `board_people.notification_group_jid`, creates/reuses `messaging_groups`
  rows, and wires `agent_destinations` by person name.
- `scripts/phase3-seed-seci-destinations.ts` also seeds Phase 3-only
  forwarding fixtures for Rafael and Thiago, whose v1 turn looked outside the
  SECI board_people rows.
- deterministic forwarding now handles:
  - `enviar mensagem para o Mauro priorizar a tarefa P2.5`;
  - `enviar mensagem para Ana Beatriz com os detalhes da M4`.

Targeted paid replay after this fix used:

- results: `/tmp/phase3-v2-results-seci-forwarding-afterfix-20260514.json`;
- turns: `3` and `28`;
- outcome: both turns used `api_query` + `send_message` and produced two
  outbound rows. Turn `28` still depends on historical state because the
  current DB no longer has `M4`, so the routing behavior is fixed but exact
  content parity requires the missing pre-turn DB snapshot.

Main findings from that coverage replay:

- Bulk approval/review flows are not proven by the original 30-turn corpus.
  The replay surfaced no-outbound or no-op behavior on examples such as
  "aprovar todas as atividades de Rodrigo Lima", "aprovar tarefas josele",
  and "aprovar todas as tarefas de João Antonio". The current DB already has
  the v1-targeted tasks in `done`, so exact verdicts require historical
  per-turn DB snapshots before treating these as v2 product bugs.
- Broad project/report queries complete but often fan out into many
  `api_query` calls and sometimes `Monitor`/`TaskOutput`. This is a result
  shape/performance gap: prefer compact first-class MCP summaries over prompt
  steering.
- Several raw-sqlite forwarding/routing turns now need explicit
  tool-surface decisions: either accepted v1→v2 change, seeded named
  destination/context-chain replay, or a narrow first-class `api_*` read.
- Candidate turn 2 exposed a real meeting-create bug: when the agent supplied
  an unregistered participant, v2 fell back from meeting creation to a plain
  task. This was fixed in the engine/MCP layer: meetings are now created with
  registered participants and return `unresolved_participants` plus a prompt
  for staff/external registration. Targeted replay
  `/tmp/phase3-v2-results-seci-coverage-turn2-afterfix-20260514.json`
  confirms the real agent path now uses only `api_create_meeting_task`.
- Candidate turn 35 exposed a real no-outbound failure on an empty
  `person_review` read for "aprovar tarefas josele". The current DB already
  has the historical v1 target task in `done`, so the correct v2 behavior
  under current state is a no-op explanation. The engine now returns a
  `formatted` no-review summary for `person_review`; targeted replay
  `/tmp/phase3-v2-results-seci-coverage-turn35-afterfix-20260514.json`
  confirms the real agent path now sends outbound instead of timing out.
- Reconstructed snapshots for the bulk approval family were created under
  `/tmp/phase3-state/seci-coverage-bulk/` and replayed through
  `/tmp/whatsapp-seci-bulk-approval-snapshots-20260514.json`. Those snapshots
  showed a real v2 gap: after reading review candidates, the agent could
  either report "approved" without mutating or perform several individual
  moves and fail to send a final confirmation. The MCP surface now supports
  `api_move({ task_ids: [...] })`, single moves include a formatted
  confirmation, and the Taskflow template maps "aprovar todas as
  tarefas/atividades de Nome" to query-plus-bulk-move. Replay
  `/tmp/phase3-v2-results-seci-bulk-approval-bulkmove-20260514.json`
  confirms the bulk family now uses MCP mutation calls and sends outbound.

## Comparator Classifications

Phase 3's comparator (`scripts/phase3-support.ts`) collapses turns into
the smallest set of classes that lets a reviewer act on each one. As of
2026-05-12 the canonical set is:

- `match` — semantic action, task IDs, mutation types, and recipient all
  match the expected behavior.
- `read_only_extra` — v2 grounded with an extra read before answering.
  Acceptable behavior; v1's recorded run skipped the grounding because
  it had context that the test seed doesn't reproduce.
- `state_snapshot_missing` — comparison cannot conclude because no
  per-turn DB snapshot pinned the historical state. Treat as inconclusive,
  not a v2 bug.
- `state_allocation_drift` — the only mismatch is on freshly-allocated
  task IDs (`T###` / `M###` where v2's number is larger than v1's) on
  an otherwise identical create/admin or reassign/update sequence. v2's
  sequence allocator handed out the next free ID because earlier corpus
  turns advanced the counter in the cumulative DB. Provide a per-turn
  snapshot to compare exact IDs; not a v2 product bug.
- `destination_registration_gap` — v1 forwarded to a raw WhatsApp JID
  (e.g. `120363...@g.us`) and v2 cannot match that JID to any row in
  `agent_destinations`. Production has these wired but the Phase 3
  test seed does not. Update the seed (or register the destination) —
  not a v2 product bug.
- `documented_tool_surface_change` — v1 used a tool v2 deliberately
  removed (raw sqlite). Either documented as accepted or paired with a
  new first-class `api_*` capability.
- `missing_api_capability` — v1 used raw sqlite for a behavior v2 needs
  to expose through `api_*`. Currently empty for the seci corpus
  (closed by `find_task_in_organization`).
- `missing_context` — chain-mode turn whose source JSONL is absent.
  Provide the source root or remove the chain-mode default.
- `v1_bug_flagged` — corpus turn is annotated with `v1_bug` metadata
  (auditor self-correction detector or human review marked v1's
  recorded behavior as itself wrong). Surfaced above `match` so a v2
  that reproduces the v1 mistake doesn't silently pass and a v2 that
  corrects the mistake isn't flagged as a regression. Requires manual
  verification of v2's tool payload before cutover.
- `real_divergence` — none of the above; observed v2 behavior genuinely
  differs from the expected. Investigate as a candidate v2 bug or
  template gap.

### Auditor self-correction detection (corpus annotation)

The v1 task_history has same-task / same-user / <60-min mutation pairs
where the second row supersedes the first with a different `details`
value. The skill-side `auditor-script.sh` documents the recipe;
`scripts/q.ts` against `/tmp/v2-pilot/taskflow.db` runs it directly:

```sql
SELECT a.task_id, a.by, a.at, b.at, a.details, b.details
  FROM task_history a JOIN task_history b
    ON a.board_id = b.board_id AND a.task_id = b.task_id
   AND a.by = b.by AND a.id < b.id
   AND a.details <> b.details
   AND (julianday(b.at) - julianday(a.at)) * 1440 BETWEEN 0 AND 60
 WHERE a.board_id = 'board-seci-taskflow'
   AND a.action = 'updated' AND b.action = 'updated'
   AND ((a.details LIKE '%Reuni%reagendada%' AND b.details LIKE '%Reuni%reagendada%')
     OR (a.details LIKE '%Prazo definido%' AND b.details LIKE '%Prazo definido%'));
```

Running this against the seci board's full task_history (2026-05-12)
surfaced **1 canonical bot-error pair**:

- **M1 / giovanni / 2026-04-14T11:04 → 11:36** (32 min apart): v1 wrote
  `Reunião reagendada para 17/04/2026 às 11:00` for user prompt
  *"alterar M1 para quinta-feira 11h"*; user-corrected to
  `16/04/2026 às 11:00`. April 17, 2026 is Friday; quinta-feira = Apr 16
  (Thursday). Documented in the 2026-04-14 skill changelog as the
  weekday-resolution + DST guard motivator.

This pair lands inside the curated 30-turn corpus at **turn 28**
(user_message timestamp `2026-04-14T11:04:01Z`, tool input
`{ task_id: 'M1', updates: { scheduled_at: '2026-04-17T11:00:00' } }`).
The user correction at 11:36 is outside the curated 30-turn window.
The turn is now annotated in `scripts/phase3-seci-metadata.json` with a
`v1_bug` block and the comparator routes it to `v1_bug_flagged`.

Two additional v1 bot-error candidates were found on the board but do not
affect this cutover corpus:

- **P8 reassign round-trip**: v1 reassigned the task one way and then back
  within the same correction window. The prompt window is outside the curated
  30-turn replay, so it is useful as board history evidence but not a Phase 3
  acceptance blocker for the current corpus.
- **P22.1 reassign round-trip**: same pattern and same conclusion — outside
  the 30 validated turns, therefore not part of the current v2 parity score.

Known blind spot: the self-correction auditor only catches v1 mistakes that a
human later corrected in task history. If v1 was wrong and nobody noticed, the
history has no correction pair to detect. Catching that class requires a
separate LLM-assisted corpus audit that reads each user request and compares
it against v1's recorded tool payload and final response. That audit has not
been run yet, so the current claim is "parity against v1, with known
self-corrected v1 mistakes flagged", not "v1 was always semantically correct."

Action-priority note: when v1 ran a `taskflow_query` / `api_query` and
the final response also contained a `Deseja...?` follow-up, the action
is now classified as `read` (the substantive work) rather than `ask`
(the trailing CTA). Pure clarification turns with no tool calls remain
`ask`. See seci turn 21 for the canonical example.

## Closure summary (2026-05-12, seci corpus)

After comparator improvements + `find_task_in_organization` + regenerated
seci `CLAUDE.local.md` + the deterministic Taskflow pure-greeting guard,
the paid 30-turn semantic comparison with the validated turn 1 replacement
classifies as:

| Class | Count | Turns |
|-------|-------|-------|
| `match` | 16 | 1 6 7 8 9 10 11 12 13 14 17 18 19 20 21 28 |
| `read_only_extra` | 5 | 0 2 3 4 5 |
| `state_allocation_drift` | 2 | 24 26 (T84→T96, T85→T96 — cumulative-DB allocator drift) |
| `state_snapshot_missing` | 4 | 22 23 25 27 (no per-turn DB pinning) |
| `destination_registration_gap` | 2 | 16 29 (cross-board JID forward; test-seed wiring gap) |
| `documented_tool_surface_change` | 1 | (raw sqlite use that v2 intentionally blocks) |
| `real_divergence` | 0 | none |

**Former real divergence closed**: turn 1 — `oi` (bare greeting).
CLAUDE.md guidance alone did not reliably override Claude's generic
assistant greeting. The runner now handles pure greetings deterministically
only when `NANOCLAW_TASKFLOW_BOARD_ID` is set, returning the v1-style
Taskflow scope sentence with no tools and no provider query.

**Recommendation on another paid full Phase 3 pass**: not warranted
right now. The comparator changes are deterministic and the targeted
turn 1 validation passed. The derived full comparison is:
`/tmp/phase3-comparison-full-paid-20260512-with-turn1-fix.txt`. A new replay
would only be worth running once at least one of the following is also
in place:

1. Per-turn historical DB snapshots for turns 22-27 (closes
   `state_snapshot_missing` and `state_allocation_drift`).
2. A registered `agent_destinations` row for the corpus's expected
   sibling-board chat and DM-group JIDs (closes
   `destination_registration_gap` for turns 16 and 29).

Each of those is independent; do them first, then schedule one paid
pass that verifies all three at once.

Update: the dev seed rows are now reproducible via
`scripts/phase3-seed-seci-destinations.ts`, and
`scripts/phase3-seci-metadata.json` records the local destination aliases.
The remaining state evidence is represented by reconstructed snapshots, not
true historical captures.

Targeted pending-only replay update:
`/tmp/phase3-comparison-pending-20260513-all-limited-closed.txt`
validates that turns `16`, `22`, `23`, `24`, `25`, `26`, `27`, and `29` now
match under the Phase 3 setup. Turn `23` remains documented as a v1 raw-sqlite
tool-surface change, but the observable behavior is now covered by
first-class MCP/API operations and raw sqlite stays blocked.

The turn `16` and `22` closures are deliberately narrow runner-side TaskFlow
confirmation handlers; turn `23` is a narrow target-state replay closure:

- Turn `16`: if real replay context establishes a pending sibling-board note
  forward and the user answers `sim`, v2 resolves the seeded named destination
  and sends through `send_message`, preserving v1's raw-JID forward behavior
  without re-enabling sqlite.
- Turn `22`: if the previous assistant question asks to reopen and require
  approval for exact task ID `P6.7`, a bare confirmation performs
  `api_move(P6.7, reopen)` and `api_update_task(P6.7,
  requires_close_approval=true)`. It does not mutate parent `P6` or sibling
  subtasks.
- Turn `23`: Phase 3 restores a target-state snapshot after replaying the
  two context turns, so the target starts from v1's pre-target state
  (`P6.7` done with approval disabled). v2 then performs
  `api_query(task_details P6.7)`, `api_update_task(P6.7,
  requires_close_approval=true)`, and `api_move(P6.7, reopen)`, replacing
  v1's raw sqlite write/read with first-class MCP/API behavior.

## Final SECI Closure (2026-05-14)

The remaining migration gaps were closed with targeted Phase 3 replay rather
than another full paid run. The combined evidence file replaces only the
targeted rerun turns from the latest paid run:

- Results: `/tmp/phase3-v2-results-combined-final-20260514.json`
- Comparison: `/tmp/phase3-comparison-combined-final-20260514.txt`

Final classification:

| Class | Count | Turns |
|-------|-------|-------|
| `match` | 29 | all except 28 |
| `v1_bug_flagged` | 1 | 28 |
| `real_divergence` | 0 | none |

Resolved items:

- Turns `0`, `2`, `3`: v2 asks for clarification without mutating and now
  preserves v1-style contextual project hints (`P13`, `P17/P17.1`, `P12`)
  from the Phase 2 raw prompt's board context.
- Turn `8`: reconstructed pre-turn snapshot restores `P6.1` and `P6.2` to
  review, and v2 now answers the person-review read through the deterministic
  MCP-backed `api_query(person_review)` path.
- Turn `12`: reconstructed pre-turn snapshot restores `P20.2` to Mariany's
  active tasks, and the semantic comparison matches.

The reconstructed snapshots are local validation artifacts, not historical
captures:

- `/tmp/phase3-state/seci-reconstructed-20260514/pre-turn8/taskflow.db`
- `/tmp/phase3-state/seci-reconstructed-20260514/pre-turn12/taskflow.db`

Turn `28` remains deliberately annotated as `v1_bug_flagged`. v1 resolved
`quinta-feira` to Friday; v2 must correct that behavior, not reproduce it for
bug-for-bug parity. Cutover requires human signoff that this is an accepted
intentional divergence from v1's mistaken output.

## Post-review hardening (2026-05-12, Codex gpt-5.5/high)

A Codex review of the closure work flagged two BLOCKERs and three
IMPORTANTs. All addressed before merge:

1. **BLOCKER — turn 17 must not classify as `match` until v2 actually
   exercises `find_task_in_organization`.** The pre-review comparator
   ignored `outbound_intent`, so v1's "T43 details" reply and v2's
   "Não encontrei T43" reply both reduced to `action=read, task_ids=[T43]`
   and got marked `match`. The comparator now includes
   `outbound_intent` in the `matches` struct and rejects the
   `informational → asks_user|not_found_or_unclear` transition.
   Turn 17 now correctly classifies as `documented_tool_surface_change`
   on the pre-fix v2 results — honest "v2 needs revalidation with the
   new tool" rather than false-positive parity.
2. **BLOCKER — regenerated `groups/seci-taskflow/CLAUDE.local.md` had
   reverted (no `find_task_in_organization` rule).** Re-regenerated
   from the template. Added a `migrate-board-claudemd.test.ts`
   regression: the substitution must preserve the cross-board task
   lookup rule and rename `taskflow_query` → `api_query` inside it.
3. **IMPORTANT — `state_allocation_drift` was too permissive.** Now
   requires `actual.mutation_types.includes('create')`. A
   reassign+update with task-id mismatch will no longer get excused as
   allocator drift; it surfaces as `real_divergence` (or
   `state_snapshot_missing` when explicit metadata flags it).
4. **IMPORTANT — `destination_registration_gap` was too permissive.**
   Now requires `actual.mutation_types.length === 0` and
   `actual.action ∈ {forward, no-op}`. A forward+mutate hybrid cannot
   hide behind this class.
5. **IMPORTANT — added missing comparator/engine negative tests**:
   v2-not-found-vs-v1-informational (BLOCKER 1 lockdown),
   reassign-only-no-allocation-drift, forward-with-mutation-no-gap,
   dangling-parent orphan isolation for `find_task_in_organization`,
   and the migration regeneration regression.

After these fixes, re-running the comparator on the existing v2
results produces 14/30 matches (turn 17 demoted to
`documented_tool_surface_change`). The current canonical artifact for
the comparator-only re-classification is
`/tmp/phase3-comparison-full-paid-20260512-rev2.txt`.

The "Closure summary" table above (16/30, including the
deterministic-greeting-guard turn 1 fix) reflects a separate targeted
validation run that included the runner-side greeting guard. A fresh
paid 30-turn pass with the rebuilt container is the only thing that
will reconcile the two numbers honestly. Until then: 14/30 is what
the comparator says about the unchanged v2 output, and the headline
movement is "8 real divergences → 1 (turn 1) before the greeting
guard, → 0 after". Turn 17 is parked as
`documented_tool_surface_change` awaiting fresh-run revalidation of
`find_task_in_organization`.

## Ongoing v1-bug monitor (host cron)

`scripts/audit-v1-bugs-daily.ts` wraps the auditor for a daily
host-side run and writes two artifacts per day to `data/audit/`:

- `v1-bugs-YYYY-MM-DD.json` — raw findings keyed by board.
- `v1-bugs-YYYY-MM-DD.md` — grouped human-readable summary.

The wrapper opens `data/taskflow/taskflow.db` read-only. taskflow.db
runs in `journal_mode=DELETE` (per `src/taskflow-db.ts:484`), so the
wrapper's shared lock can briefly block host writers; the systemd
unit caps wall-clock with `TimeoutSec=300` to keep this bounded.
The wrapper emits a one-line summary to stdout that the unit appends
to `logs/audit-v1-bugs.log` (not the journal — `StandardOutput=append:`
targets the file, not journald).

Manual invocation (the cron uses the same command):

```bash
sudo -u nanoclaw -H /root/nanoclaw/node_modules/.bin/tsx \
  /root/nanoclaw/scripts/audit-v1-bugs-daily.ts
```

To enable the daily timer:

```bash
sudo install -m 644 /root/nanoclaw/scripts/systemd/nanoclaw-audit-v1-bugs.service /etc/systemd/system/
sudo install -m 644 /root/nanoclaw/scripts/systemd/nanoclaw-audit-v1-bugs.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nanoclaw-audit-v1-bugs.timer
# Verify next firing:
systemctl list-timers nanoclaw-audit-v1-bugs.timer
```

The timer fires at 06:00 local with up to 5 min of randomized delay
(see `scripts/systemd/nanoclaw-audit-v1-bugs.timer`). `Persistent=true`
catches up on next boot if the host was off at the scheduled time.
Output is appended to `logs/audit-v1-bugs.log` and
`logs/audit-v1-bugs.error.log`.

The daily monitor is **detect-and-write only** — it does not surface
findings to any board chat or DM. A future v2-native scheduled task
(MCP `audit_v1_bugs` action) is the right home for in-chat surfacing
once the cutover lands.

## Runtime Pinning Audit

Strict compliance replay must record and pin:

- Claude model and effort/thinking settings;
- `@anthropic-ai/claude-agent-sdk` version;
- bundled Claude Code/CLI version;
- allowed and disallowed tools;
- generated board `CLAUDE.local.md`;
- host/container environment relevant to MCP tool exposure.

Phase 3 reports evidence; it does not solve model nondeterminism by itself.
