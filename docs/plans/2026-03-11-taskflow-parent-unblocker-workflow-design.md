# TaskFlow Parent Unblocker Workflow

Date: 2026-03-11
Status: Phase 1 in progress

## Problem

In hierarchy boards, a child board sometimes needs action from the parent board to unblock a delegated task.

Today there are three different intents mixed together:

1. The child still owns the task, but the parent must approve or do one unblocker step.
2. Ownership of the same task really needs to move back to the parent.
3. The parent needs a separate tracked task while the child keeps owning the original task.

The current runtime supports generic reassignment, but person resolution is board-local. That makes "send this upward to a parent-only person" a poor default from child boards, and it also encourages using reassignment where `waiting_for` or `next_action` would model the work more accurately.

## Desired Behavior

Default decision rule:

1. If the parent only needs to unblock work and the child still owns delivery:
   - keep the same task assigned to the child-board assignee
   - prefer `next_action` naming the parent-side step
   - use `waiting` with a reason only after the task is already in progress

2. If ownership of the same task really moves back to the parent:
   - use reassignment semantics
   - under the current runtime, this normally happens from the parent/control board because person resolution is board-local

3. If the parent needs its own tracked deliverable:
   - create a separate parent-board task
   - keep the child task in `waiting` if needed

## Why This Is the Right Default

- It preserves the single-task history when ownership does not actually change.
- It matches the existing linked-task model: parent owns policy and final approval, child executes.
- It avoids forcing upward cross-board reassignment for cases that are really just dependencies.
- It works with the current engine today without new runtime features.

## Phase 1: Prompt and Skill Guidance

Goal: change default agent behavior without changing engine semantics.

Implementation:

- Update the TaskFlow template to explicitly prefer:
  - `taskflow_update(... updates: { next_action: 'parent-side unblocker' })`
  - `taskflow_move(... action: 'wait', reason: 'parent-side unblocker')` only for tasks already in progress
- Explain that `devolver` keeps its existing "back to queue" meaning.
- Explain that reassignment alone is for real ownership transfer, and that true upward reassignment currently happens from the parent/control board.
- Explain that a separate parent task is better when the parent has its own deliverable, and that this task is created from the parent/control board.
- Propagate this guidance through generated child-board prompts.
- Add tests that fail if the guidance is removed from the template.

Status: **In progress.**

- Local TaskFlow template updated with parent-unblocker guidance.
- Local TaskFlow tests added to lock in the guidance.
- Local generated child-board CLAUDE.md files already align with the updated template.
- Remote rollout is not part of this phase unless the skill is explicitly synced there later.

## Phase 2: Engine Convenience for Explicit Upward Handoff

Goal: support explicit upward-handoff workflows cleanly when ownership really must move.

Candidate implementation:

- Add a first-class "return to parent" command path for linked tasks.
- Keep `devolver TXXX` as return-to-queue and use a different explicit upward-handoff wording.
- Record dedicated history metadata so returned work is distinguishable from ordinary reassignment.
- Require explicit confirmation when the handoff changes task ownership across hierarchy boundaries.

Open design question:

- Should upward return be implemented as a dedicated engine action, or remain a prompt-level alias over `taskflow_reassign` once parent-target resolution exists?

## Phase 3: Parent Task Request Helper

Goal: support the "parent has separate work" case explicitly.

Candidate implementation:

- Add a command pattern such as:
  - `criar tarefa no quadro pai para Miguel: aprovar orçamento da T22`
- Runtime creates a new task on the parent/control board and optionally updates the child task to `waiting`.
- Parent and child tasks remain separate on purpose.

This phase is optional, but it would remove prompt improvisation for a common hierarchy workflow.

## Validation

Phase 1 is considered complete when:

- the TaskFlow template contains the parent-unblocker guidance
- generated child-board prompts contain the same guidance
- tests fail if the guidance or generated prompt alignment regresses

Phase 2 is considered complete when:

- a child-board user can explicitly return a linked task upward through a supported command
- history distinguishes upward return from normal reassignment
- notifications remain single-send

## Risks

- If this stays prompt-only forever, agents can still choose reassignment in edge cases.
- If we add engine-level upward return later, we must keep the semantics distinct from generic reassignment.
- A parent-task helper must not create duplicate work accidentally when the user really intended a plain unblocker note.

## Recommendation

Ship Phase 1 now.

Do not force engine changes until there is clear evidence that prompt guidance alone is insufficient. The current linked-task model already supports the preferred workflow through `waiting_for` and `next_action`, so prompt guidance is the correct first implementation step.
