# TaskFlow No Direct SQL Writes — Design

**Date:** 2026-03-10
**Status:** Proposed

## Overview

Redesign the TaskFlow skill and runtime so TaskFlow-managed groups no longer rely on agent-authored SQL mutations.

Today, the TaskFlow template still permits a small set of legitimate direct SQLite writes, and that leaves an escape hatch when TaskFlow MCP tools are unavailable or ignored. This design removes that category entirely.

The end state is:

- TaskFlow mutations go through explicit `taskflow_*` tools only
- TaskFlow SQL access is read-only from the agent's perspective
- metadata writes currently done by prompt instructions move into runtime or narrow tools
- a TaskFlow-managed container fails closed if its TaskFlow tool surface is missing

## Problem

The current system still allows some direct SQL writes in TaskFlow groups:

- welcome/session bookkeeping in `board_runtime_config`
- sender display-name normalization in `board_people`
- documented SQL fallback for exceptional operations not covered by `taskflow_*`

Even though the template strongly prefers `taskflow_*` tools, these legitimate exceptions weaken enforcement:

- the agent can rationalize a direct write when tools are missing
- `mcp__sqlite__write_query` remains a mutation path inside TaskFlow groups
- Bash-based SQLite access can recreate missing behavior outside the engine

This is not only a prompt-quality issue. It is an architecture issue: the agent still has more write paths than the TaskFlow engine.

## Goals

- Remove all legitimate direct SQL mutation instructions from the TaskFlow skill/template.
- Make `taskflow_*` the only supported mutation path for TaskFlow board/task state.
- Move non-task metadata writes out of prompt-authored SQL and into runtime or explicit tools.
- Allow future runtime enforcement to disable direct SQLite writes in TaskFlow groups without breaking normal operation.
- Preserve current TaskFlow capabilities and operator UX.

## Non-Goals

- This design does not remove read-only SQL queries from TaskFlow groups.
- This design does not redesign TaskFlow data storage away from SQLite.
- This design does not replace all ad-hoc reporting with engine queries in one step.
- This design does not attempt to solve every prompt non-compliance issue by policy alone.

## Current State

The TaskFlow template currently:

- instructs the agent to `SELECT welcome_sent` and `UPDATE board_runtime_config` on first session interaction
- instructs the agent to update `board_people.name` after first-name or single-person fallback identity resolution
- documents `mcp__sqlite__write_query` as a last resort for writes with no `taskflow_*` equivalent

The runtime already contains partial hardening:

- TaskFlow MCP registration is gated by TaskFlow env vars
- TaskFlow-managed startup now fails closed when required TaskFlow MCP registration is missing
- Bash sanitization can block direct writes to `taskflow.db`

But full enforcement is not yet safe because the skill still documents and depends on some SQL writes.

## Core Decision

TaskFlow-managed groups should become **tool-only for writes**.

That means:

- task mutations: explicit `taskflow_*` tools only
- TaskFlow metadata mutations: runtime-owned or exposed through narrow tools
- SQL from the agent: read-only

This is the only clean way to guarantee that notification dispatch, undo snapshots, history recording, ID generation, recurrence behavior, hierarchy linking, and authorization all stay inside the engine.

## Proposed Architecture

### 1. Remove SQL mutation guidance from the TaskFlow template

The TaskFlow template should stop legitimizing direct SQL writes.

Changes:

- remove the `UPDATE board_runtime_config` welcome instruction from the prompt
- remove the `UPDATE board_people` display-name sync instruction from the prompt
- remove `mcp__sqlite__write_query` as an approved fallback mutation path for TaskFlow groups
- replace "write via SQL if no tool exists" with:
  - use an explicit TaskFlow tool if one exists
  - otherwise fail closed or capture to inbox when appropriate

### 2. Move welcome bookkeeping to runtime-owned behavior

The first-session welcome flow should no longer depend on agent-written SQL.

Preferred implementation:

- host/runtime or agent-runner checks `board_runtime_config.welcome_sent`
- if unset, runtime prepends/queues the welcome behavior
- runtime updates `welcome_sent`

Alternative:

- expose a narrow tool such as `taskflow_runtime_ack_welcome`

The key rule is that the agent should not issue raw SQL to update welcome state.

### 3. Move sender display-name normalization out of prompt SQL

The current prompt-directed `board_people.name` normalization should become host/runtime-owned or tool-owned.

Preferred implementation:

- sender resolution stays in runtime or engine
- when the system resolves a safe first-name/single-person fallback match, runtime updates the canonical display name

Alternative:

- add a narrow tool such as `taskflow_sync_person_display_name`

Requirements:

- update only when the match is already considered safe by the existing identity rules
- never broaden authorization by changing identity mapping logic

### 4. Close the generic write fallback

After the above two migrations, TaskFlow groups should no longer require agent-authored SQL writes for normal operation.

Then enforce:

- do not include `mcp__sqlite__write_query` in the TaskFlow-managed allowed tool set
- keep `mcp__sqlite__read_query` for inspection and ad-hoc read-only answers
- keep Bash write blocking against `taskflow.db`

### 5. Preserve exceptional operations through explicit tools

If the product still needs some mutation not covered by the engine, add a narrow tool instead of allowing raw SQL.

Examples:

- runtime metadata acknowledgment
- display-name sync
- other board-scoped maintenance operations that are intentionally supported

Rule:

- every supported mutation should have a named tool with validation and a constrained schema

## Prompt/Skill Changes

The TaskFlow template should be updated as follows.

### Remove

- any instruction telling the agent to `UPDATE board_runtime_config`
- any instruction telling the agent to `UPDATE board_people`
- any instruction authorizing `mcp__sqlite__write_query` as a fallback mutation path
- the section that tells the agent how to manually write `task_history`, `_last_mutation`, or `updated_at`

### Keep

- read-only SQL for inspection and unsupported analytical questions
- strong instruction that `taskflow_create`, `taskflow_move`, `taskflow_update`, `taskflow_reassign`, and related tools are the only mutation path
- inbox capture fallback when the intended action cannot be executed safely

### Add

- explicit statement that TaskFlow groups are read-only at the SQL layer from the agent's perspective
- explicit statement that direct DB writes are a policy violation even if technically possible
- guidance that missing TaskFlow tools is a runtime error condition, not a reason to improvise SQL writes

## Runtime Changes

### Allowed tools

For TaskFlow-managed groups:

- allow `mcp__sqlite__read_query`
- disallow `mcp__sqlite__write_query`

For non-TaskFlow contexts:

- no change implied by this design

### Bash hardening

Keep and enforce blocking for direct writes targeting `taskflow.db`.

Minimum blocked categories:

- `update`
- `insert`
- `delete`
- `replace`
- `alter`
- `drop`

Scope:

- block when the command targets `taskflow.db` or `/workspace/taskflow`
- do not block ordinary read-only inspection commands

### Fail-closed startup

TaskFlow-managed containers should exit immediately when:

- `NANOCLAW_TASKFLOW_BOARD_ID` is missing
- `taskflow.db` is not mounted/present
- required `taskflow_*` tools fail to register

This prevents silent degradation into non-TaskFlow behavior.

## Migration Plan

### Phase 1: Prompt redesign

- update `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- update TaskFlow skill tests that assert template content
- remove all direct-write instructions from the template

### Phase 2: Metadata relocation

- implement runtime-owned welcome bookkeeping
- implement runtime-owned or tool-owned display-name sync
- add tests proving TaskFlow groups no longer need agent SQL writes for these cases

### Phase 3: Enforcement

- remove `mcp__sqlite__write_query` from TaskFlow-managed allowed tools
- keep `mcp__sqlite__read_query`
- keep Bash `taskflow.db` write blocking enabled

### Phase 4: Validation

- verify standard TaskFlow workflows still work:
  - welcome flow
  - sender identity fallback
  - create/move/update/reassign
  - meeting flows
  - inbox fallback
- verify TaskFlow groups cannot mutate `taskflow.db` via SQL tool or Bash

## Risks

### 1. Hidden dependency on prompt-authored writes

There may be undocumented workflows relying on direct SQL writes today.

Mitigation:

- inventory current template/tests before removing the path
- add focused regression tests for welcome and sender-name sync

### 2. Over-blocking Bash

A naive Bash blocker could incorrectly stop legitimate read-only debugging commands.

Mitigation:

- block only clear write verbs plus TaskFlow DB target detection
- keep the rule scoped to TaskFlow-managed groups

### 3. Tool gaps

Removing SQL write fallback may expose missing narrow tools.

Mitigation:

- add narrow tools where product behavior truly needs a supported mutation path
- prefer runtime-owned bookkeeping where no user-facing tool is needed

## Success Criteria

- TaskFlow template contains no direct SQL mutation instructions.
- Normal TaskFlow operation does not require agent-authored SQL writes.
- TaskFlow-managed groups no longer expose `mcp__sqlite__write_query`.
- Direct TaskFlow DB writes via Bash are blocked.
- Managed TaskFlow containers fail closed when TaskFlow tool registration is incomplete.
- Notifications, history, undo, and authorization remain engine-owned for all supported mutations.

## Implementation Scope

Primary files:

- `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- `.claude/skills/add-taskflow/tests/taskflow.test.ts`
- `.claude/skills/add-taskflow/modify/container/agent-runner/src/index.ts`
- `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- any runtime files that own welcome/session bookkeeping and sender identity updates

Local runtime parity should be maintained in:

- `container/agent-runner/src/index.ts`
- `container/agent-runner/src/ipc-mcp-stdio.ts`

## Recommended Next Step

Implement the prompt redesign first, then move welcome bookkeeping and display-name sync out of SQL, and only then remove `mcp__sqlite__write_query` for TaskFlow-managed groups.
