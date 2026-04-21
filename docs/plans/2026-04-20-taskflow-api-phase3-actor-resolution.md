# TaskFlow API Phase 3 — Explicit Actor Resolution

**Date:** 2026-04-20
**Status:** Proposed

## Goal

Introduce one deterministic adapter-side actor resolution flow for future
mutation migration:

```text
JWT/session or static API token
  -> authenticated caller identity
  -> board-scoped TaskFlow actor or explicit API-only actor
  -> structured actor contract
```

This phase exists to remove heuristic identity bridging before any mutation
route is migrated to the adapter path.

## Why This Phase Exists

Today the API and engine still disagree on mutation identity:

- FastAPI auth produces `user_id` / token-level access, not a TaskFlow actor
- the engine authorizes mutations using TaskFlow identities
- current Python mutation routes stamp history with generic values such as
  `'web-api'`
- the redesign explicitly forbids synthesizing free-form `sender_name` and
  hoping the semantics line up

That means mutation migration is still blocked even though the low-risk read
slice is complete.

## Non-Goals

This phase does **not**:

- migrate `create`, `update`, or `delete` routes
- unify notifications
- unify realtime invalidation
- change the REST response shape of existing read routes
- force board chat or comments into the engine

## Scope

This phase should deliver:

1. a structured actor contract
2. one deterministic board-scoped actor resolver
3. explicit error/failure codes
4. tests for no-match, ambiguous-match, and unavailable-resolution paths
5. a clear allow/deny matrix for future mutation routes

It should not deliver actual mutation-route migration.

## Ground Truth In Current Code

Current behavior that is useful but insufficient:

- `require_board_access()` authenticates and scopes board/org access, but does
  not resolve a TaskFlow actor
- `_resolve_person_id()` already proves that user-to-person mapping can be done
  without heuristics, but it is global and informational, not board-scoped
- `/auth/me` exposes a best-effort `person_id` enrichment path, but this is not
  yet the adapter contract for mutations
- current write routes still record `'web-api'` in `task_history`, which is not
  valid actor resolution

## Design Decision

Actor resolution happens in the API adapter boundary, not inside raw route code
and not by passing a free-form `sender_name` into the engine.

For future migrated mutation routes:

- FastAPI authenticates the caller
- FastAPI validates board/org access
- the adapter resolves the caller to either:
  - a board-scoped TaskFlow human actor, or
  - an explicit API-only actor type
- only then may a mutation adapter method run

## Structured Actor Contract

Define one adapter-facing contract, for example:

```ts
type ApiActor =
  | {
      actor_type: 'taskflow_person',
      source_auth: 'jwt',
      user_id: string,
      board_id: string,
      person_id: string,
      display_name: string,
    }
  | {
      actor_type: 'api_service',
      source_auth: 'api_token',
      board_id: string,
      service_name: string,
    }
```

Rules:

- `taskflow_person` is the only actor type allowed for human mutation semantics
- `api_service` is explicit; it is not a disguised human
- no mutation adapter may accept a raw `sender_name` in place of this contract

## Resolution Rules

### JWT caller

Input:

- authenticated `user_id`
- target `board_id`

Resolution algorithm:

1. load the authenticated user row
2. normalize the user phone digits
3. search `board_people` only for the target board
4. compare normalized phones
5. collect distinct matching `person_id`s

Outcomes:

- exactly 1 match -> resolve to `taskflow_person`
- 0 matches -> fail with `actor_not_found`
- more than 1 distinct match -> fail with `actor_ambiguous`

Important:

- this is board-scoped, not global across all boards
- do not fall back to matching by display name
- do not invent a synthetic `sender_name`

### Static API token caller

Input:

- authenticated API token
- target `board_id`

Outcome:

- resolve to `api_service`

Important:

- this actor type is explicit
- future mutation routes must declare whether `api_service` is allowed
- if a mutation requires a human TaskFlow actor, `api_service` must fail with
  `actor_type_not_allowed`

## Failure Contract

Define structured adapter error codes:

- `actor_not_found`
- `actor_ambiguous`
- `actor_resolution_unavailable`
- `actor_type_not_allowed`

Recommended HTTP mapping:

- `actor_not_found` -> `422 Unprocessable Entity`
- `actor_ambiguous` -> `409 Conflict`
- `actor_resolution_unavailable` -> `503 Service Unavailable`
- `actor_type_not_allowed` -> `403 Forbidden`

These codes must be stable before any mutation route migrates.

## API-Only Actor Policy

Do not decide this ad hoc per route implementation.

This phase should produce an explicit policy table:

- routes requiring human task accountability:
  - create assigned task
  - update task
  - delete task
  - reassign
  - dependency changes
  - hierarchy changes
  -> `taskflow_person` required

- routes that may later allow service actors:
  - narrowly defined administrative automation endpoints only
  -> explicit opt-in, never implicit fallback

If a route does not have a written policy, it must not accept `api_service`.

## Implementation Plan

### Task 1 — Add resolver types

Add explicit Python-side resolver result types, for example:

- `ResolvedTaskflowActor`
- `ResolvedApiServiceActor`
- `ActorResolutionError`

These should live in the API adapter area, not as ad hoc dicts in route code.

### Task 2 — Add board-scoped JWT resolver

Implement a resolver helper along the lines of:

```python
resolve_board_actor(conn, board_id, claims) -> ResolvedActor
```

Behavior:

- requires board access to have already been validated
- for JWT callers, resolves exactly one board-local `person_id`
- for API tokens, returns explicit `api_service`
- raises structured resolution errors, not generic `HTTPException`s deep inside
  the matching logic

### Task 3 — Normalize phone matching contract

Re-use the existing digit-normalization logic.

Document and test:

- exact E.164 vs WhatsApp digit differences
- leading `9` normalization cases already handled today
- ambiguity when multiple `board_people` rows match the same authenticated user

### Task 4 — Add adapter error mapping

Add one mapping layer from structured actor-resolution errors to HTTP status
 and response detail.

Do not scatter route-specific status choices.

### Task 5 — Add tests

Minimum test matrix:

- JWT user resolves to exactly one board actor
- JWT user has no matching board actor -> `actor_not_found`
- JWT user matches two distinct board actors -> `actor_ambiguous`
- API token resolves to `api_service`
- route policy rejects `api_service` where human actor is required
- resolution DB failure -> `actor_resolution_unavailable`

### Task 6 — Add dry-run integration point

Before migrating mutations, add one non-mutating integration seam that proves
the contract can be built and passed through.

Candidate seam:

- `GET /api/v1/boards/{board_id}/actor-resolution`
- `allow_api_service=false` proves future human-only route policy without
  migrating mutations

This phase should validate the contract without migrating task writes yet.

## Acceptance Criteria

- there is exactly one documented actor-resolution flow
- no migrated or planned mutation path depends on raw `sender_name`
- ambiguity is a hard failure, not a warning
- API token callers are modeled explicitly, not disguised as humans
- failure codes and HTTP mappings are documented and tested
- at least one integration-level test proves the structured actor contract can
  be produced for a real board/user pair
- no mutation route migration is included in this phase

## Out of Scope Until Later Phases

Still blocked after this phase:

- mutation migration itself
- notification routing unification
- event invalidation unification
- comment/chat migration decisions

Those remain Phase 4 / Phase 6 concerns.

## Immediate Follow-Up After This Phase

If this phase completes successfully, the next step is not "move mutations
immediately." The next step is:

1. finish Phase 4 notification and invalidation unification
2. confirm the actor contract is the one used by the adapter
3. only then plan the first mutation migration slice
