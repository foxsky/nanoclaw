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
    "expected_behavior": {
      "action": "forward",
      "task_ids": ["M1", "M2"],
      "recipient": "Ana Beatriz"
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
- `expected_behavior`: optional semantic expectation. If omitted, Phase 3
  derives expected behavior from v1 recorded tools.

Known context-chain defaults are inferred for corpus turns `16`, `22`, `23`,
`25`, and `27`, but explicit metadata is preferred for compliance work.

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

Run a single context-dependent turn:

```bash
sudo -u nanoclaw -H env LOG_LEVEL=info \
  NANOCLAW_PHASE2_RAW_PROMPT=1 \
  NANOCLAW_TOOL_USES_PATH=/workspace/.tool-uses.jsonl \
  bash -c 'cd /root/nanoclaw && /root/nanoclaw/node_modules/.bin/tsx \
    scripts/phase3-driver.ts \
      --corpus /tmp/whatsapp-curated-seci-v4.json \
      --metadata /tmp/phase3-metadata.json \
      --source-root /tmp/v2-pilot/all-sessions/seci-taskflow \
      --turn 16 \
      --out /tmp/phase3-v2-results-turn16.json'
```

The driver snapshots the live Taskflow DB before the run and restores it
afterward. If `state_snapshot` is set and exists, it is restored before the
turn. If it is missing, the result is marked as `state_snapshot_missing` rather
than treated as a v2 behavior bug.

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
- `real_divergence` — none of the above; observed v2 behavior genuinely
  differs from the expected. Investigate as a candidate v2 bug or
  template gap.

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

## Runtime Pinning Audit

Strict compliance replay must record and pin:

- Claude model and effort/thinking settings;
- `@anthropic-ai/claude-agent-sdk` version;
- bundled Claude Code/CLI version;
- allowed and disallowed tools;
- generated board `CLAUDE.local.md`;
- host/container environment relevant to MCP tool exposure.

Phase 3 reports evidence; it does not solve model nondeterminism by itself.
