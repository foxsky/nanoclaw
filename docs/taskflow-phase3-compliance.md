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

For the known `T43` cross-board lookup pattern, the recommended compliance
decision is either to document the accepted tool-surface change or add a
first-class cross-board read API. Do not re-enable raw sqlite.

## Runtime Pinning Audit

Strict compliance replay must record and pin:

- Claude model and effort/thinking settings;
- `@anthropic-ai/claude-agent-sdk` version;
- bundled Claude Code/CLI version;
- allowed and disallowed tools;
- generated board `CLAUDE.local.md`;
- host/container environment relevant to MCP tool exposure.

Phase 3 reports evidence; it does not solve model nondeterminism by itself.

