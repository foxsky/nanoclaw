# Bounded Recurrence for TaskFlow

**Date:** 2026-03-06
**Status:** Approved

## Problem

Recurring tasks (R-xxx) cycle forever. Users need tasks that recur for a fixed period — e.g., "weekly for 6 weeks" or "monthly until June 30th".

## Design

### Data Model

Two new nullable columns on `tasks`:

```sql
ALTER TABLE tasks ADD COLUMN max_cycles INTEGER;
ALTER TABLE tasks ADD COLUMN recurrence_end_date TEXT;
```

- `max_cycles`: total cycles before expiry. Task expires when `current_cycle + 1 >= max_cycles`.
- `recurrence_end_date`: ISO date string. Task expires when `next_due_date > recurrence_end_date`.
- If both set, whichever triggers first wins.
- If neither set, task recurs forever (current behavior preserved).

### Engine Changes

In `advanceRecurringTask()`, before resetting the task:

```
next_due = advance(current_due, frequency)
next_cycle = current_cycle + 1

expired = false
if max_cycles AND next_cycle >= max_cycles: expired = true
if recurrence_end_date AND next_due > recurrence_end_date: expired = true

if expired:
  leave task in 'done' (don't reset)
  return { expired: true, final_cycle: next_cycle, reason: 'max_cycles' | 'end_date' }
else:
  reset to next_action (current behavior)
  return { new_due_date, cycle_number }
```

`CreateParams` gains optional `max_cycles` and `recurrence_end_date` fields, stored on INSERT.

`UpdateParams.updates` gains optional `max_cycles` and `recurrence_end_date` to modify bounds on existing recurring tasks.

### MoveResult Extension

`recurring_cycle` gains an optional `expired` flag:

```typescript
recurring_cycle?: {
  new_due_date: string;
  cycle_number: number;
  expired?: boolean;
  reason?: 'max_cycles' | 'end_date';
}
```

### MCP Tool Schema

`taskflow_create`: add `max_cycles?: number` and `recurrence_end_date?: string`.

`taskflow_update`: add `max_cycles?: number` and `recurrence_end_date?: string` to the updates object.

### Agent Behavior on Expiry

When `recurring_cycle.expired` is true, the agent shows:

> ✅ R-003 concluída (ciclo final: 6/6)
>
> Recorrência encerrada. Deseja:
> 1. Renovar por mais N ciclos
> 2. Estender até uma nova data
> 3. Arquivar

### Command Mapping (pt-BR)

| User says | Params |
|-----------|--------|
| "semanal por 6 semanas para Y: X" | `recurrence: 'weekly', max_cycles: 6` |
| "mensal até 30/06 para Y: X" | `recurrence: 'monthly', recurrence_end_date: '2026-06-30'` |
| "mensal por 3 meses até 30/06 para Y: X" | Both — whichever triggers first |
| "estender R-003 por mais 6 ciclos" | `updates: { max_cycles: current + 6 }` |
| "estender R-003 até 30/09" | `updates: { recurrence_end_date: '2026-09-30' }` |

### Files Touched

1. `container/agent-runner/src/taskflow-engine.ts` — CreateParams, advanceRecurringTask, update handler
2. `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP tool schemas
3. `.claude/skills/add-taskflow/templates/CLAUDE.md.template` — command mapping + expiry handling
4. `.claude/skills/add-taskflow/tests/taskflow.test.ts` — new test cases
5. Skill copies synced (add/ and modify/ directories)
