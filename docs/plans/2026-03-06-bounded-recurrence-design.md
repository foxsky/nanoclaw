# Bounded Recurrence for TaskFlow

**Date:** 2026-03-06
**Status:** Approved

## Problem

Recurring tasks (R-xxx) and recurring projects (project + recurrence) cycle forever. Users need tasks that recur for a fixed period — e.g., "weekly for 6 weeks" or "monthly until June 30th".

## Design

### Data Model

Two new nullable columns on `tasks`:

```sql
ALTER TABLE tasks ADD COLUMN max_cycles INTEGER;
ALTER TABLE tasks ADD COLUMN recurrence_end_date TEXT;
```

- `max_cycles`: positive integer. Task expires when `current_cycle + 1 >= max_cycles`.
- `recurrence_end_date`: ISO date (`YYYY-MM-DD`). Task expires when `next_due_date > recurrence_end_date`.
- Bounds are **mutually exclusive**: only one can be set at a time (`max_cycles` XOR `recurrence_end_date`).
- If neither is set, task recurs forever (current behavior preserved).

### Engine Changes

In `advanceRecurringTask()`, before resetting the task:

```
next_due = advance(current_due, frequency)
next_cycle = current_cycle + 1

expiry_reason = null
if max_cycles AND next_cycle >= max_cycles: expiry_reason = 'max_cycles'
if recurrence_end_date AND next_due > recurrence_end_date: expiry_reason = 'end_date'

if expiry_reason:
  leave task in 'done' (don't reset)
  persist current_cycle = next_cycle
  return { expired: true, cycle_number: next_cycle, reason: expiry_reason }
else:
  reset to next_action (current behavior)
  return { expired: false, new_due_date, cycle_number: next_cycle }
```

Apply bounded recurrence to **all tasks with `recurrence`**, including recurring projects.

`CreateParams` gains optional `max_cycles` and `recurrence_end_date` fields, stored on INSERT.
- Validation: reject create when both are provided.

`UpdateParams.updates` gains optional `max_cycles` and `recurrence_end_date` to modify bounds on existing recurring tasks.
- `max_cycles` and `recurrence_end_date` in updates should be nullable (`null` clears the field).
- Setting one bound clears the other bound automatically, preserving exclusivity.

### MoveResult Extension

`recurring_cycle` gains an optional `expired` flag:

```typescript
recurring_cycle?: {
  cycle_number: number;
  expired: boolean;
  new_due_date?: string;
  reason?: 'max_cycles' | 'end_date';
}
```

### MCP Tool Schema

`taskflow_create`: add `max_cycles?: number` and `recurrence_end_date?: string`.

`taskflow_update`: add `max_cycles?: number | null` and `recurrence_end_date?: string | null` to the updates object.
- Reject requests that try to set both in one call.

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
| "mensal por 3 meses até 30/06 para Y: X" | Ask user to choose one bound (`max_cycles` **or** `recurrence_end_date`) |
| "estender R-003 por mais 6 ciclos" | `updates: { max_cycles: current + 6 }` |
| "estender R-003 até 30/09" | `updates: { recurrence_end_date: '2026-09-30' }` |

### Migration + Compatibility

- Update canonical schema in `src/taskflow-db.ts` (`TASKFLOW_SCHEMA`) to include new columns.
- Add idempotent `ALTER TABLE` migration steps in `initTaskflowDb()` for existing databases.
- Update `restore_task` insert/select column lists to include `max_cycles` and `recurrence_end_date`.
- Include new fields in update undo snapshots so `taskflow_undo` restores bounded-recurrence edits.

### Files Touched

1. `container/agent-runner/src/taskflow-engine.ts` — CreateParams, UpdateParams, advanceRecurringTask, restore/undo compatibility
2. `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP tool schemas
3. `container/agent-runner/src/taskflow-engine.test.ts` — bounded recurrence and exclusivity test cases
4. `src/taskflow-db.ts` — canonical schema + idempotent migration
5. `.claude/skills/add-taskflow/templates/CLAUDE.md.template` — command mapping + expiry handling
6. `.claude/skills/add-taskflow/tests/taskflow.test.ts` — schema/template assertions
7. Skill copies synced (add/ and modify/ directories)
