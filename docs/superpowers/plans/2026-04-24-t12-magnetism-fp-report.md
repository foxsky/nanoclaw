# T12 Magnetism — Phase 0 FP Backfill Report

**Date:** 2026-04-24
**Analyzer:** `scripts/magnetism-backfill.mjs` at plan-commit state
**Snapshot:** `/tmp/prod-snapshot-20260424/` (fresh today)
**Window:** 30 days (2026-03-25 → 2026-04-24)

## Result

```json
{
  "days": 30,
  "totalMutations": 671,
  "magnetismCandidates": 1,
  "projectedWeekly_fleet": 0.23,
  "max_per_board_weekly": 0.5,
  "perBoardRates": [
    {
      "board_id": "board-thiago-taskflow",
      "candidates": 1,
      "active_days": 14,
      "weekly_normalized": 0.5
    }
  ],
  "samples": [
    {
      "board_id": "board-thiago-taskflow",
      "task_id": "P6",
      "expected": "M11",
      "at": "2026-04-22T11:21:59.377Z",
      "user_msg_preview": "Próxima ação: Enviar mensagem para Alyne aprovar a visualização dos recursos de ",
      "bot_msg_preview": "Case: Não entendi a referência. \"24/04\" se refere a: • Reagendar a M11 — Reunião com o time de IA para 24/04?"
    }
  ]
}
```

## Gate decision: PASS

Target: `max_per_board_weekly ≤ 1.0`. Actual: **0.5**. Only `board-thiago-taskflow` produced a candidate (1 in 14 active days). Every other active board produced zero candidates.

Proceed to Phase 1.

## Sample analysis

The single flagged candidate is a genuine magnetism pattern: the bot asked Thiago about reagendar M11 on 2026-04-22 at 11:21:59 UTC. The user's reply (not explicitly named, inferred) contained no task refs. The agent then mutated **P6** (setting its next_action) — not M11. The shape matches exactly what the guard is designed to catch.

## Canonical 2026-04-23 T12/T13 case — NOT in the backfill

The T12/T13 case that inspired this plan did **not** appear as a candidate. Reason: the bug manifested as confabulation without a mutation — the agent said *"Já foi feito — prazo de T12 removido"* at 12:08:55 UTC but never actually called `update()` again. There is no `task_history` row for that response, so the analyzer (which iterates mutations) cannot see it.

The guard would still fire IF the agent had actually called `update(task_id='T12')` in response to *"só retire o prazo"* — the shape matches:
- User message: no task refs
- Prior bot message (concatenated within 30s): *"Cancelar T13? Confirme com 'sim'."* — single ref T13, confirmation shape
- Agent intended task_id: T12
- → `ambiguous_task_context` with `expected='T13'`

But the real bug was **no-op confabulation**, a different bug class. Out of scope for this plan; noted as a known gap. Addressing it would require comparing bot text to task_history writes per turn — a future detector.

## Known limitations of the analyzer

- **Mutation-keyed**: invisible to no-op confabulations.
- **`LIMIT 1` on user message**: assumes one user msg before the mutation. Bursts within the same 10-min pre-window only the latest is picked.
- **30s bot concatenation window**: wider splits (>30s) in bot prompts aren't joined.
- **`is_bot_message` vs `is_from_me`**: we OR both. Edge cases where a scheduled task sent from a different user account could be attributed wrongly — but we haven't seen this empirically.

## Files

- `/root/nanoclaw/scripts/magnetism-backfill.mjs` — the analyzer
- `/tmp/prod-snapshot-20260424/messages.db` + `taskflow.db` — snapshot used
