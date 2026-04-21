# TaskFlow API Channel Redesign

**Date:** 2026-04-20
**Status:** Proposed replacement for `2026-04-20-taskflow-api-channel-design.md`

## Current State

As of the latest implementation pass:

- Phase 0 is complete: the compatibility matrix artifact exists
- MCP transport infrastructure exists: stdio subprocess server, Python async client,
  FakeMCPClient, lifespan wiring, and health endpoint are all implemented
  — this is plumbing that enables the remaining phases, not the redesign's Phase 1
- Phase 1 is NOT done: the reusable Node service module that consolidates
  `ipc-mcp-stdio.ts` wrapper behavior (duplicate detection, embedding injection,
  notification shaping, child-board provisioning) has not been extracted
- Phase 3 is complete: explicit actor resolution is implemented end-to-end
  - TypeScript actor contract types and exported `parseActorArg` validator
    in `taskflow-mcp-server.ts`
  - Python actor dataclasses, `resolve_board_actor()`, and
    `board_actor_resolution` route with `ensure_board_access_prechecked` guard
    and structured `ActorResolutionError` codes in `main.py`
  - Full test suite in `tests/test_actor_resolution.py` including a cross-repo
    compatibility roundtrip against the compiled Node validator
- Phase 5 is complete: low-risk reads are engine-backed
  - board activity (`engine.apiBoardActivity()`)
  - board filter queries (`engine.apiFilterBoardTasks()`)
  - linked tasks (`engine.apiLinkedTasks()`)

- Phase 4 is complete: notification and event-invalidation primitives are unified
  - `board_chat` COUNT+MAX included in SSE change hash (invalidation covers board chat)
  - `dispatch_mcp_notification_events(conn, events)` dispatches `deferred_notification`
    events via `write_notification_ipc`; logs warnings for `direct_message` and
    `parent_notification` (not yet wired to IPC senders)
  - `call_mcp_mutation(request, board_id, claims, tool_name, args)` helper handles
    MCP delegation, maps `error_kind` to 422/503, and dispatches notification events
  - `NotificationEvent` TypeScript discriminated union exported from
    `taskflow-mcp-server.ts`; `parseNotificationEvents` validates and constructs events
  - Indexes added on `tasks.updated_at` and `board_chat.created_at` for SSE hash queries

What is still not done:

- Phase 6 mutation migration

Therefore:

- no mutation routes should move next
- no plan that introduces `api_create_*`, `api_update_*`, or `api_delete_*` before actor resolution and notification/invalidation work is aligned with this redesign

## Verdict

The original "FastAPI as a thin HTTP channel over `TaskflowEngine`" plan is not
safe to implement as written.

The core problem is not only duplicated business logic. The Python API and the
TaskFlow engine currently expose different contracts over the same database:

- different task payload shapes
- different identity models
- different authorization rules
- different notification plumbing
- different query surfaces
- different comment/chat semantics

Because of that, a direct route-by-route replacement with `taskflow_*` calls
would either:

1. break the existing dashboard/API contract, or
2. re-implement API-only translation logic in Python and recreate the same
   drift under a new name

## Ground Truth

### 1. The storage contract is not shared

Today the API and the engine do not mean the same thing by the same columns.

Current API behavior:

- `tasks.assignee` is read and written as a display name
- priority values are Portuguese-facing (`urgente`, `alta`, `normal`, `baixa`)
- web comments are represented as `task_history(action='comment')`
- `PATCH /tasks/:id` supports replacing the serialized `notes` payload directly

Current engine behavior:

- `tasks.assignee` is treated as `person_id`
- priority values are English enums (`low`, `normal`, `high`, `urgent`)
- note mutation is an engine-owned workflow on `tasks.notes`
- task creation auto-assigns the sender when no assignee is given
- task creation defaults to `next_action`, not `inbox`

That means the API is not currently a pure transport shell around the engine.

### 2. The actor model is not shared

Current API auth model:

- JWT or static agent token gates board/org access
- board mutation rights are mostly org-scope or owner-scope
- task mutation endpoints do not resolve a taskflow actor before mutating

Current engine auth model:

- mutations are authorized using TaskFlow identities
- assignee vs manager rules are enforced inside the engine
- meeting note operations have participant/external-contact-specific rules

The original plan assumed FastAPI could always derive a trustworthy
`sender_name` from JWT and hand it to the engine. That is not enough:

- a dashboard user may have org access without mapping cleanly to exactly one
  `board_people` identity
- the API currently allows operations that are not modeled as
  assignee-or-manager engine actions
- external participant flows have no equivalent in the REST task routes

### 3. Important behavior lives outside `TaskflowEngine`

The current MCP wrapper does more than "delegate to the engine":

- semantic-search embedding injection
- duplicate detection on create
- DM/group/deferred notification dispatch routing
- parent notification dedup
- child-board auto-provision side effects

A standalone stdio server that only instantiates `TaskflowEngine` and calls its
methods would silently drop behavior that is currently part of TaskFlow in
production.

### 4. Phase 3 in the original plan is not possible without changing the surface

The original plan proposed migrating:

- board detail
- task list
- activity
- search
- filters
- linked tasks
- chat
- overdue

without changing the engine/tool surface.

That does not hold:

- board detail in the API includes board metadata, people, runtime config, and
  aggregated counts
- global search is cross-board and filtered by org visibility
- comments are `task_history` rows, not engine note operations
- board chat is its own table and contract
- API filters use Portuguese priority semantics

These are not thin adapters over the current `taskflow_query` results.

### 5. Notifications and realtime are coupled to mutation details

The API currently relies on:

- custom Python notification helpers
- task-history side effects
- manual `tasks.updated_at` bumps for comment writes
- coarse DB hashing for SSE/WebSocket invalidation

Moving mutation execution without explicitly redesigning event invalidation and
notification routing is likely to create stale UI behavior or double delivery.

## Replacement Architecture

The correct shape is:

```text
FastAPI (REST/API contract, auth, org scoping)
    ↓
TaskFlow API Adapter (new contract adapter, Node or shared service boundary)
    ↓
TaskflowEngine Core (workflow/domain rules)
    ↓
Shared persistence + notification/event primitives
```

## Design Principles

### 1. Keep `TaskflowEngine` as the workflow core, not the API boundary

`TaskflowEngine` remains the canonical implementation for:

- workflow transitions
- WIP limits
- approval gates
- recurrence
- hierarchy and child-board rollups
- meeting participant and external-contact rules

But it should not be treated as the final public contract for Mission Control.

### 2. Introduce an explicit API adapter contract

Add a new adapter layer that owns translation between REST semantics and engine
semantics.

The adapter is responsible for:

- actor resolution from JWT/session context to TaskFlow actor
- assignee translation between REST payloads and engine identity
- priority translation between API values and engine values
- comment/chat compatibility behavior
- notification dispatch normalization
- event invalidation hooks

This layer can live in:

- a new Node stdio server beside the engine, or
- a Node module called from that server

The key is that it is not Python re-implementing domain logic, and it is not
the raw `taskflow_*` tool surface either.

### 3. Separate three contracts explicitly

#### Contract A: Core domain contract

Internal engine-facing types:

- `person_id`
- English priority enums
- engine-owned mutation result types

#### Contract B: API adapter contract

Used between FastAPI and Node service:

- authenticated actor identity
- target board
- API payload shape
- structured error codes
- normalized notification/event payloads

#### Contract C: REST contract

What the dashboard already depends on:

- existing JSON response shapes
- current auth and org semantics
- comment/chat endpoints
- current field naming and pagination behavior

Do not pretend these are already the same thing.

## Recommended Migration Sequence

### Phase 0 — Freeze and document current contracts

Before moving routes:

- document API task payload semantics as they exist today
- document engine task payload semantics as they exist today
- list every field whose meaning differs
- list every mutation side effect currently performed in Python
- list every side effect currently performed in the MCP wrapper

This phase should produce a compatibility matrix, not code movement.

### Phase 1 — Extract wrapper behavior into reusable service code

Create a reusable Node service module around `TaskflowEngine` that also owns:

- duplicate detection
- semantic-search embedding injection
- notification result shaping
- child-board provisioning side effects when relevant

Goal: there is one TaskFlow execution path for Node-side behavior, instead of
logic split between the engine and `ipc-mcp-stdio.ts`.

### Phase 2 — Define an API adapter surface

Create explicit adapter methods for API use cases, for example:

- `api_create_simple_task`
- `api_update_simple_task`
- `api_delete_simple_task`
- `api_list_board_tasks`
- `api_board_detail`
- `api_search_visible_tasks`
- `api_filter_board_tasks`
- `api_board_activity`
- `api_list_comments`
- `api_add_comment`
- `api_list_board_chat`
- `api_add_board_chat_message`

These methods may call into `TaskflowEngine`, but they are allowed to keep
API-only compatibility behavior where the engine has no equivalent.

This is the right place to preserve dashboard behavior while shrinking Python.

### Phase 3 — Introduce explicit actor resolution

Add one adapter-side actor resolution flow:

- JWT/session -> user
- user -> board-scoped TaskFlow actor or API-only actor
- explicit failure when the identity is ambiguous

Do not pass free-form `sender_name` from Python to the engine without a
validated mapping.

If a route needs API-level authority rather than TaskFlow human authority,
model that explicitly as a separate actor type instead of faking a
`sender_name`.

This phase is now complete.

### Phase 4 — Unify notifications and event invalidation

Before migrating task mutations, define shared primitives for:

- direct DM notifications
- deferred notifications
- parent-board notifications
- comment-created invalidation
- board-chat invalidation
- board detail / stats cache-busting

FastAPI should not need to reconstruct notification semantics from incomplete
engine results.

### Phase 5 — Migrate low-risk reads first

Start with read paths whose semantics already align reasonably well:

- board activity
- board filter queries
- linked tasks

Do not start with create/update/delete.

This gives early signal on subprocess lifecycle, timeouts, error mapping, and
result serialization without taking on actor-resolution risk immediately.

Guardrails for this phase:

- preserve the current route-specific REST response shape first, even where task
  DTOs differ across endpoints today
- do not migrate any read that depends on board-scoped delegation visibility
  until the reconciliation refresh contract is explicit

Implementation status:

- Python delegation wired for `board_activity`, `filter_board_tasks`, and `linked_tasks`
- Node tools currently use direct SQL — not yet delegating to engine adapter methods
- correcting the Node tools to call `engine.apiBoardActivity()`,
  `engine.apiFilterBoardTasks()`, and `engine.apiLinkedTasks()` is the
  first task of the next implementation phase
- Python-side duplicate SQL for these migrated reads should not be treated as
  an acceptable long-term fallback

### Phase 6 — Migrate mutations only after contract translation exists

Only move task mutations after all of these are true:

- actor resolution is deterministic
- error codes are structured and stable
- notification routing is unified
- event invalidation is explicit
- API compatibility tests are green against the adapter path

This phase is still blocked. In particular, it must not begin while:

- actor resolution is still implicit, heuristic, or optional
- mutation attribution still falls back to generic values such as `web-api`
- notification/event invalidation behavior is not unified across Python and Node

### Phase 7 — Decide comments and chat separately

Do not force comments and board chat into the existing engine just because they
touch TaskFlow data.

Two valid outcomes exist:

- keep them API-owned and separate
- or promote them into explicit adapter/core surfaces

But treat them as separate product contracts. They are not just another task
mutation.

## What Must Not Happen

Do not:

- treat the current `taskflow_*` MCP tool surface as the REST API surface
- synthesize `sender_name` heuristically and hope auth semantics line up
- move create/update/delete first
- rebuild wrapper-side behavior in Python
- claim "no tool surface changes" while adding API-only compatibility logic

## Revised Success Criteria

- No TaskFlow workflow rule is implemented in both Python and Node.
- API contract compatibility is preserved for existing dashboard tests.
- Actor resolution is explicit and deterministic for every migrated mutation.
- Notification delivery supports current DM/group/deferred behavior.
- Event invalidation remains correct for tasks, comments, and board chat.
- `TaskflowEngine` remains the canonical workflow core, but not the accidental
  public API boundary.

## Immediate Next Step

Phases 0, 3, 4, and 5 are complete. Phase 1 (wrapper extraction) remains outstanding
but does not block Phase 6.

Phase 6 (mutation migration) prerequisites:

- [x] Actor resolution is deterministic (`resolve_board_actor`, `ensure_board_access_prechecked`)
- [x] Error codes are structured and stable (`error_kind: engine | system` → 422/503)
- [x] Notification routing is unified (`dispatch_mcp_notification_events`, `write_notification_ipc`)
- [x] Event invalidation is explicit (SSE hash covers tasks, board config, board chat)
- [x] `call_mcp_mutation` helper handles the full MCP delegation + error + dispatch pipeline
- [ ] API compatibility tests green against the adapter path (required before first mutation tool)

The next concrete artifact is a Phase 6 plan that introduces the first mutation tool
(`api_create_simple_task` or `api_update_simple_task`) against the adapter path,
backed by `call_mcp_mutation`.
