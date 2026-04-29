# Multi-Action User Turns Ignored After First Verb

**Date surfaced:** 2026-04-29
**Source:** semantic-audit dryrun NDJSON (`data/audit/semantic-dryrun-2026-04-29.ndjson`), 14 unique response deviations across 4 TaskFlow boards
**Severity:** moderate — every failed turn loses 1+ user-requested action; bot reports success on the first action, hides the rest

## Symptom

When a user sends a single message containing 2+ distinct write verbs, the bot executes only the first verb, then emits a confirmation reply that mentions only that verb. Subsequent verbs are silently dropped.

Concrete failures from 2026-04-29 NDJSON:

| Task | User asked for | Bot did |
|---|---|---|
| T14 | `adicionar nota X` + `adicionar nota Y` + `alterar prazo 30/04` | only first note |
| T17 | `alterar prazo 08/05` + `adicionar nota A` + `adicionar nota B` + `coluna Aguardando` | only prazo |
| T13 | 3× `adicionar nota` + `finalizar T13` | reported "tarefa criada" only |
| P11.15 | `adicionar nota` + `alterar prazo 30/04` | neither — replied with current state |
| P20.5 | `adicionar nota` + `finalizar P20.5` | neither |
| T16 | `colocar T16 em coluna aguardando` | moved to `next_action` (wrong) |
| SEAF-T2 | `adicionar nota` + `Atribuir a João Henrique` | only note |
| T88 | `adicionar nota` + `finalizar T88` | only note |
| P5.9 | `Adicionar nota` + `mover para Aguardando` | only note |
| P4.5 | `alterar prazo da P4.5 para 15/05` | prazo not changed (single-verb edge case — engine returned old date) |
| t15 | `adicionar nota` + `finalizar T15` | only note |

## Root Cause

The `update_task` tool surface (`UpdateParams.updates` in `container/agent-runner/src/taskflow-engine.ts:170-200`) is structured so each scalar action takes its own field, and several common pairs are mutually exclusive in a single call — `add_note × N`, `add_note + add_subtask`, `add_note + due_date + finalize` all require sequential tool calls.

The TaskFlow CLAUDE.md template (`.claude/skills/add-taskflow/templates/CLAUDE.md.template`) has exactly **one** explicit multi-action recipe: line 246, the `"TXXX para Y, prazo DD/MM"` reassign+due_date case, which says "Two calls in sequence ... Report both outcomes in a single reply." No general principle covers the rest. There are general acknowledgement rules (line 81: "MUST acknowledge every message"; line 113: "ALWAYS reply ... after every write operation") but these address message-level acknowledgement, not verb-level execution within a single user turn.

Without an explicit "execute every verb" rule, Sonnet (the bot model) treats the first successful tool call as fulfillment of the user's intent and emits a final reply, dropping the remaining verbs. This is a classic early-termination pattern when the system prompt under-specifies multi-step behavior.

## Why the heuristic auditor missed it

The heuristic in `auditor-script.sh` checks `unfulfilledWrite` by matching **task-level** signals (`task_history` row presence, column moves, etc.). It does not parse the user's message for multiple verbs and cross-check each one against `task_history`. So a turn that successfully adds the first note registers a `task_history` write event and clears the heuristic, even though 2-3 other actions silently failed.

The semantic audit's response pass (`deepseek-v4-pro:cloud`) reads the user message and the bot's reply as natural language and asks "did the bot fulfill the user's intent?" — it correctly identifies the dropped verbs.

## Recommended Fix

Add to `CLAUDE.md.template` after line 81 ("Multiple Messages in a Session"):

```
## Multi-Action Turns

When a single user message contains 2+ distinct write actions, you MUST:

1. Identify every action verb (adicionar nota, alterar prazo, finalizar, mover,
   atribuir, etc.)
2. Execute each via its own tool call IN SEQUENCE — do NOT stop after the first
3. After all calls complete, produce ONE reply listing every action's outcome
   as a bullet point

Do not let a single successful tool call satisfy a multi-verb request. After
each tool call, re-read the user's original message: if any verb you identified
is still pending, call the next tool before replying.

Anti-pattern: user says "adicionar nota X e alterar prazo da T14 para 30/04"
→ bot calls update_task(add_note=X) → engine returns success → bot replies
"✅ T14 atualizada" — the prazo is silently dropped.
```

After updating the template, re-run `scripts/migrate-claude-md-multi-action.mjs` (to be created in the fix PR) against every TaskFlow board's `CLAUDE.md` to propagate the rule.

## Followup

- Open a PR to land the template change + per-board migration
- Verify on the next dryrun NDJSON that multi-action failures drop to near-zero
- The single-verb edge case on P4.5 (prazo set to 28/04 instead of 15/05) is a separate engine or NLU bug — investigate independently, not covered by the multi-action rule.

## References

- NDJSON: `data/audit/semantic-dryrun-2026-04-29.ndjson` on prod
- Engine update surface: `container/agent-runner/src/taskflow-engine.ts:170-200`
- Template: `.claude/skills/add-taskflow/templates/CLAUDE.md.template:79-81, 246`
