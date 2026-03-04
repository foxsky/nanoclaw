# TaskFlow: Normalized Task-to-Board Link Model

## Purpose

This note captures a possible future evolution of TaskFlow's hierarchy model.

Today, TaskFlow stores one canonical task row in `tasks` and uses inline linkage
columns (`child_exec_*`, `linked_parent_*`) to expose that task across boards.
That keeps mutation simple, but it makes deep delegation awkward because a child
board can see a delegated task without actually owning it.

The alternative documented here is to keep `tasks` as the canonical task store
while moving cross-board relationships into a separate normalized relation table.

## Current Model

Current ownership:

- `tasks.board_id` = the single owning board

Current cross-board linkage:

- `tasks.child_exec_enabled`
- `tasks.child_exec_board_id`
- `tasks.child_exec_person_id`
- `tasks.linked_parent_board_id`
- `tasks.linked_parent_task_id`

This gives:

- one authoritative task row
- no task duplication across boards
- simple updates for assignee, column, due date, notes, reminders

Current runtime behavior on top of that storage:

- when a task is linked to another board via `child_exec_*`, the receiving board
  can still move that same task directly through the normal GTD phases
- the `🔗` marker indicates cross-board routing, not a read-only mirror
- `atualizar status T-XXX` / `sincronizar T-XXX` is reserved for pulling
  rollup from an immediate child board only after the current board delegates
  the same deliverable further down

But it also creates a structural limit:

- a child board can view a delegated parent task
- that child board does not own the row
- the child cannot cleanly re-delegate the same row further down using the same
  ownership rule

## Proposed Model

Keep `tasks` as the canonical task table, but separate ownership from visibility.

Suggested shape:

```sql
CREATE TABLE tasks (
  id TEXT NOT NULL,
  owning_board_id TEXT NOT NULL REFERENCES boards(id),
  title TEXT NOT NULL,
  assignee TEXT,
  "column" TEXT DEFAULT 'inbox',
  due_date TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owning_board_id, id)
);

CREATE TABLE task_board_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owning_board_id TEXT NOT NULL REFERENCES boards(id),
  task_id TEXT NOT NULL,
  board_id TEXT NOT NULL REFERENCES boards(id),
  link_type TEXT NOT NULL,
  person_id TEXT,
  parent_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owning_board_id, task_id, board_id, link_type)
);
```

Where:

- `tasks.owning_board_id` is the single source of truth for mutable task state
- `task_board_links` describes which boards can see or operate on the task

Suggested `link_type` values:

- `owner` = canonical owning board
- `delegated_execution` = task is being executed in a child board
- `parent_reference` = local task contributes upward to a parent deliverable
- `visibility_only` = read-only cross-board view if needed later

## Why This Helps

This keeps the current "one canonical task row" property while making hierarchy
relationships explicit and extensible.

Benefits:

- one task can be referenced by multiple boards without duplicating task rows
- ownership stays explicit instead of being inferred from mixed-purpose columns
- deep hierarchies become easier to represent
- child/grandchild relationships become queryable without overloading `tasks`
- future tooling can reason about board relationships from one table
- the current "linked tasks stay actionable on the receiving board" behavior can
  remain intact while delegation and visibility become explicit data instead of
  being split across task columns

Most important: this solves the current limitation where a board can see a task
from its parent but cannot safely re-delegate the same row further down because
it does not own that row.

## Example

Root board owns the deliverable:

```text
tasks:
- owning_board_id = board-sec-taskflow
- id = T-004
- title = "Migracao da nuvem"
```

Link rows:

```text
task_board_links:
- (board-sec-taskflow, T-004) -> board-sec-taskflow      [owner]
- (board-sec-taskflow, T-004) -> board-seci-taskflow     [delegated_execution, person_id=giovanni]
```

If `board-seci-taskflow` creates a local manager-layer task:

```text
tasks:
- owning_board_id = board-seci-taskflow
- id = T-101
- title = "Planejar migracao por etapas"
```

Additional links:

```text
task_board_links:
- (board-seci-taskflow, T-101) -> board-seci-taskflow    [owner]
- (board-seci-taskflow, T-101) -> board-sec-taskflow     [parent_reference, parent_task_id=T-004]
- (board-seci-taskflow, T-101) -> board-grandchild       [delegated_execution, person_id=subordinate]
```

This keeps each level's deliverable locally owned while still preserving the
rollup chain.

## Migration Notes

This is a design note only. It is not implemented.

If adopted later:

1. Add `task_board_links`.
2. Backfill existing `child_exec_*` and `linked_parent_*` state into link rows.
3. Replace visibility queries that currently depend on `child_exec_board_id`.
4. Replace link/unlink commands to write `task_board_links`.
5. Remove the old inline linkage columns only after all prompts, queries, and
   migrations are updated.

## Decision Summary

If TaskFlow stays focused on a single delegation hop per owned task, the current
schema is acceptable.

If TaskFlow needs robust multi-level delegation, the better long-term path is:

- keep `tasks` canonical
- add a normalized task-to-board relation table
- model ownership and visibility as separate concerns
