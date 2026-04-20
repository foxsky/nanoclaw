# TaskFlow REST API as a Channel — Amended Design

**Date:** 2026-04-20
**Status:** Amended after code review (fifth revision)

## Companion Artifacts

This plan is the primary implementation document.

The following companion docs are part of the plan package and should be read as
required inputs before implementation starts:

- `docs/plans/2026-04-20-taskflow-api-channel-redesign.md`
- `docs/plans/2026-04-20-taskflow-api-compatibility-matrix.md`

Role of each document:

- this plan: target architecture, constraints, sequencing, and migration rules
- redesign doc: rationale for abandoning the thin-channel assumption and the
  higher-level replacement architecture
- compatibility matrix: route-by-route and field-by-field source-of-truth for
  what can migrate, what needs translation, and what stays API-owned

Current package gaps to resolve before implementation:

- the compatibility matrix must be extended where this plan requires concrete
  DTO parity or mutation-readiness checklists
- the normalized notification DTO schema must be written as a companion artifact
  before Phase 6 mutation migration begins
- the actor-resolution path must be chosen and documented before any Phase 1
  code is written

## Problem

The TaskFlow system has two overlapping implementations around the same SQLite
data:

- `container/agent-runner/src/taskflow-engine.ts` — canonical workflow engine
  used by WhatsApp agents
- `/root/tf-mcontrol/taskflow-api/app/main.py` — FastAPI REST API serving the
  Mission Control SPA

The original version of this plan assumed the REST API could become a thin HTTP
transport over the existing engine with minimal translation. That assumption is
not correct.

The API and the engine do not currently expose the same contract:

- the API uses REST- and dashboard-shaped payloads
- the engine uses TaskFlow-native mutation and query semantics
- actor identity, assignee handling, priorities, comments, history, and query
  scope do not line up one-to-one

So the goal is not "forward HTTP to `TaskflowEngine` unchanged". The goal is to
move domain logic toward the engine without breaking the existing REST contract.

## Revised Goal

Reduce duplicated business logic by introducing an explicit adapter layer
between FastAPI and `TaskflowEngine`.

The engine remains the workflow core. FastAPI remains the REST/auth/org
boundary. The adapter becomes the compatibility layer that translates between
them.

## Architecture

```text
Internet → FastAPI (Python)
             ├── Auth, Orgs, Profile, Events, Comments/Chat, multi-board reads
             └── Board-local task/board routes that can be adapted safely
                       ↓ NDJSON-framed JSON-RPC over stdin/stdout
                 taskflow-mcp-server.js (Node.js subprocess)
                       ↓
                 TaskFlow API Adapter
                       ↓
                 TaskflowEngine(db, board_id)
                       ↓
                 taskflow.db (SQLite)
```

## What The Review Confirmed

### Already handled by this direction

- The new stdio server must not depend on container-only env vars such as
  `NANOCLAW_CHAT_JID`, `/workspace/ipc`, or task-managed group runtime paths.
- SQLite WAL is still the intended concurrency mode, but it must be enabled
  explicitly in the new Node server startup path rather than assumed.
- Engine changes required by this plan (bootstrap extraction, actor struct,
  composite patch, optional notifications on result types) are all
  backward-compatible with the existing WhatsApp agent channel.

### Real blockers that change the design

1. `TaskflowEngine` startup work is not safe to run per request.
   The constructor currently runs schema/bootstrap logic on each non-readonly
   instantiation: `ensureTaskSchema()`, `migrateLegacyProjectSubtasks()`, and
   `reconcileDelegationLinks()`.

2. `sender_name` is not a sufficient actor bridge.
   Authorization should be based on a precise TaskFlow identity, not on a name
   string that is then re-resolved inside the engine. At the same time, history
   and notifications still need a human display name.

3. REST `PATCH /tasks/{id}` does not map directly to one engine call.
   The API accepts raw field edits and raw `column` changes in one endpoint.
   The engine splits those concerns across `update`, `move`, and some admin
   actions.

4. Some REST queries are multi-board and do not belong to one board-scoped
   engine instance.
   `/tasks/search` and `/tasks/overdue` are cross-board today.

5. Comments, board chat, realtime invalidation, and current REST history shape
   are still API-owned contracts.

6. Existing database rows were written by the Python path using Portuguese
   priority values and display-name assignee strings. These are not compatible
   with engine semantics and must be normalized before the adapter reads them.

7. The subprocess is a serial request queue. Node.js with `better-sqlite3` is
   synchronous and single-threaded. Every concurrent FastAPI request collapses
   into a serial queue at the stdin pipe. This is a known throughput constraint
   that the architecture accepts explicitly for the first implementation.

These findings are captured in more detail in the companion redesign and
compatibility matrix documents above. Implementation must not proceed from this
plan alone while ignoring those artifacts.

## New Components

### 1. `taskflow-mcp-server.ts`

A standalone stdio server at
`container/agent-runner/src/taskflow-mcp-server.ts`.

It accepts a `--db` CLI argument, opens one `better-sqlite3` connection at
startup, enables WAL and busy timeout explicitly, and stays alive for the
process lifetime.

It does **not** depend on:

- container group env vars
- workspace-only file paths
- IPC message directories
- WhatsApp runtime-only context

It exposes an API adapter surface for REST use cases. It does not expose raw
engine methods as the only public contract.

Startup requirement:

- after all async initialization completes (modules loaded, SQLite connection
  open, MCP server listening), emit a known ready sentinel line to stderr
- all other console output must go to stderr, not stdout; stdout is the
  exclusive channel for JSON-RPC messages

### 2. TaskFlow API Adapter

This is the missing piece from the original plan.

The adapter owns:

- actor resolution input contract
- request/response translation
- priority translation
- assignee translation
- structured error codes
- normalized notification payloads
- PATCH orchestration for mixed update + workflow requests

The adapter may internally call `TaskflowEngine`, but FastAPI should not be
responsible for reproducing engine-specific translation logic itself.

### 3. `engine/client.py`

An async Python client that manages the subprocess lifecycle.

It spawns `node taskflow-mcp-server.js --db <path>` once during FastAPI
lifespan startup, keeps stdin/stdout private, correlates JSON-RPC requests by
ID, and enforces per-call timeouts.

This client is a manual stdio JSON-RPC implementation, not a wrapper around the
Node SDK `Client.connect()` lifecycle.

#### Wire protocol

The transport uses newline-delimited JSON (NDJSON):

- each message is a single UTF-8 line terminated by `\n`
- the Node server must not emit multi-line JSON on stdout
- the Python client reads stdout with `readline()`
- any stdout line that does not parse as valid JSON-RPC is a fatal protocol
  error; the client must close the session and fail all pending requests

The Node server's stdout is the exclusive JSON-RPC channel. The Node server
must redirect all console output to stderr before any module is imported.
stderr is available for logging and for the ready sentinel.

#### Request correlation and concurrency

The client assigns a monotonically increasing integer ID to each outgoing
request. The Node server must echo the same ID in every response.

The initial implementation serializes calls: only one outstanding request is in
flight at a time. The client must not send the next request until the previous
response has been received or the per-call timeout has fired. This is a known
throughput limitation accepted for the first implementation; concurrent
multiplexing is a future enhancement.

#### Subprocess readiness

The client must not send `initialize` until the Node process signals readiness.

Required behavior:

- monitor stderr for the ready sentinel line emitted by the server at startup
- if the sentinel is not received within the startup timeout, declare startup
  failed, send SIGKILL to the subprocess, and surface the failure to FastAPI
  lifespan

The startup timeout value must be documented in configuration alongside the
subprocess path and database path.

#### MCP session flow

After readiness is confirmed:

1. send `initialize` with `protocolVersion`, `capabilities`, and `clientInfo`
2. await the `initialize` response
3. send `notifications/initialized`
4. call `tools/list` and validate the response against the expected tool manifest
   embedded in the client; if any expected tool is missing or has a changed
   input schema, fail startup with a logged error naming the specific mismatch
5. only then begin accepting incoming requests

The design must not assume raw `tools/call` is the first message sent.

`tools/list` is always called at startup; it is not optional. Its purpose is to
make version skew between the Python client and the Node server a startup
failure rather than a silent runtime failure.

Implementation rule:

- use the SDK-supported protocol version, not a hardcoded string outside the
  SDK contract
- do not layer a second manual handshake on top of an SDK-managed client if
  implementation later switches to SDK lifecycle management

## Subprocess Resilience

The subprocess client is part of the production request path and must define
failure behavior explicitly.

### Failure detection

Treat as distinct fatal events that all close the session:

- child-process exit (any exit code)
- stdout EOF
- stderr EOF while process is expected to be alive
- broken-pipe write failure

### In-flight request cleanup

When the read loop task terminates for any reason, its completion callback must
iterate every entry in the pending requests map and call
`future.set_exception(SubprocessUnavailableError(...))` on each, then clear the
map. This callback is registered unconditionally at read loop startup and fires
on both normal exit and exception.

"Fail immediately" means the exception is set synchronously in the cleanup
callback, not after the per-call timeout fires. Per-call timeouts remain as a
safety net but must not be the primary mechanism for unblocking callers on
subprocess death.

### Restart policy

No automatic restart. Subprocess death is permanent until the FastAPI process
is restarted by the process supervisor (systemd, Docker restart policy, or
equivalent).

After subprocess death:

- the client transitions to a permanent failed state
- all subsequent calls to the client return `SubprocessUnavailableError`
  immediately without attempting to send to stdin
- FastAPI maps this error to HTTP 503 for all migrated routes
- the `/health` endpoint returns a non-200 status (see Health and Observability)

Restart responsibility belongs to the process supervisor, not to application
code. This avoids tight crash loops and keeps failure modes observable.

### Replay policy

- failed in-flight mutations are failed permanently to the caller; they are not
  retried
- automatic retry is not implemented in the initial version for any call type
- if idempotent read retries are added later, the adapter must explicitly mark
  each retryable method as idempotent; this cannot be inferred implicitly

### Graceful shutdown

During FastAPI lifespan shutdown:

- stop accepting new requests
- send a graceful termination signal to the subprocess
- wait for the subprocess to confirm connection close, up to a defined shutdown
  timeout
- after the timeout, send SIGKILL
- document the expected shutdown time and configure the process supervisor's
  stop timeout to be at least shutdown_timeout + 5 seconds

### WAL lock on deployment restart

During a rolling restart, the previous subprocess may be mid-query when the
shutdown signal arrives. The new subprocess's connection will contend for the
WAL write lock. The `busy_timeout` pragma must be set to a value that tolerates
a graceful shutdown in progress. The value must be documented alongside the
subprocess configuration.

### Development mode

Uvicorn `--reload` triggers lifespan shutdown and startup on every file save.
Rapid reloads can leave multiple overlapping subprocess connections competing
for the WAL write lock. The recommended development configuration is to set
`TASKFLOW_DISABLE_MCP_SUBPROCESS=1`, which bypasses the subprocess entirely and
uses the fake client (see Testing Strategy). Development against a real
subprocess requires sequential saves and a reload debounce.

## Subprocess Throughput Model

The Node subprocess with `better-sqlite3` is synchronous. It processes one
request at a time, blocking the Node event loop for the duration of each
SQLite call. Combined with the serialized-call policy in `engine/client.py`,
the adapter throughput is bounded by:

```
max_throughput = 1 / average_query_latency
```

All concurrent FastAPI requests queue at the Python client. Each waits for the
previous to complete before sending. This is a known constraint accepted for the
first implementation.

Per-call timeout enforcement:

- the Python client sets a timeout on each `await` call
- if the timeout fires, the Python coroutine raises and the in-flight request ID
  is removed from the pending map
- the Node process is still running the slow query; it will eventually respond,
  but the response will be discarded because its correlation ID is no longer
  registered
- the Node process is not interrupted; the queue resumes normally after the
  timed-out query finishes

A slow query therefore adds to the queue latency of all subsequent requests for
its full duration. There is no Node-level query cancellation in the initial
implementation. The per-call timeout at the Python layer protects individual
callers but does not free the subprocess.

Required configuration:

- per-call timeout: must be documented and configurable; default must be
  conservative enough to expose real slowness without masking it
- the Node server must log all queries exceeding a defined slow-query threshold
  to stderr

Concurrent multiplexing (multiple outstanding requests with ID-based response
routing) is a valid future enhancement. It must not be implemented until the
serialized model has proven insufficient and the correlation ID model is
validated in production.

## Pre-Migration Data Requirements

The existing database was written by the Python path using conventions that
differ from the engine's conventions. These differences are not adapter concerns
at the request boundary — they are stored data format conflicts. They must be
resolved before the adapter reads any data.

### Priority value normalization

Current state: `tasks.priority` rows written by the Python path contain
Portuguese values (`urgente`, `alta`, `normal`, `baixa`).

Engine convention: English values (`urgent`, `high`, `normal`, `low`).

If this is not normalized before Phase 3, adapter filter queries that translate
incoming Portuguese REST values to English before calling the engine will not
match existing rows, silently excluding pre-migration tasks from results.

Required action before Phase 3:

- run a one-time data migration normalizing all `tasks.priority` values to
  English enums
- this migration must be idempotent and auditable
- the canonical storage convention after migration is English enums; the adapter
  translates at the REST boundary only, never at the storage level
- this migration is a hard Phase 2 deliverable, not optional

### Assignee display-name assessment

Current state: `tasks.assignee` rows written by the Python path contain display
names (e.g., `"Miguel"`). The engine treats this column as a `person_id`.

`reconcileDelegationLinks()` reads the assignee column and writes
`child_exec_person_id`. If it reads a display name and writes it as if it were
a person_id, the `child_exec_*` state is silently corrupted.

Required action before Phase 3:

- assess which Phase 3 query surfaces read `child_exec_*` fields from rows
  whose assignee may be a display name
- if any Phase 3 route depends on correctly reconciled `child_exec_*` fields,
  a data normalization pass resolving all display-name assignees to person_ids
  must run before Phase 3 deploys
- if no Phase 3 route depends on these fields, document this explicitly and
  defer normalization to before Phase 6 mutations
- the assessment result must be recorded in the compatibility matrix

### task_history format discrimination

Current state: `task_history` rows written by the Python PATCH path contain
JSON `changes` bundles in Python's format. Rows written by the engine have
engine-native history semantics.

The Phase 3 activity adapter reads from `task_history`. It must handle both
formats without assuming a uniform structure.

Required before Phase 3:

- document both the Python `changes` bundle schema and the engine history row
  schema
- define a discriminator for the Phase 3 activity normalizer (either a column
  value, a JSON structure signature, or an explicit `source` field added to new
  rows)
- add the discriminator to new engine-written rows at the time Phase 3 deploys,
  so pre- and post-migration rows can be distinguished at read time

### Column string representation

The engine must write column identifiers as the same string values that the
Python PATCH transition validator expects. Before Phase 6, verify that all
column name strings used by the engine match exactly the strings in the Python
transition map. Document this assertion explicitly. Any mismatch must be
resolved before Phase 6 deploys.

## Engine Changes Required Before Route Migration

The original plan tried to avoid changing the engine surface. That is not
realistic. A small number of explicit changes are required.

### 1. Separate bootstrap work from request-path instantiation

Per-request engine instantiation is acceptable only if constructor side effects
are removed from that path.

Required change:

- move schema/bootstrap routines out of the constructor into explicit startup
  or maintenance functions

At minimum, separate:

- global schema/bootstrap work
- one-time legacy subtask migration
- board-scoped delegation reconciliation

Important nuance:

- a single startup warm-up instantiation is not sufficient, because
  `reconcileDelegationLinks()` is board-scoped
- the `readonly` constructor option skips bootstrap work and is the accepted
  interim mechanism for Phase 3 reads; it is not a full long-term solution, but
  it is sufficient to begin Phase 3 before the full bootstrap extraction is
  complete, provided the reconciliation freshness contract is also defined
- long-lived per-board engine instances are an implementation option, not the
  only acceptable architecture; the real requirement is that reconciliation is
  no longer hidden inside per-request construction

Required reconciliation rule:

- the design must define how board-scoped reconciliation freshness is guaranteed
  for every migrated read path

Minimum trigger set:

- child-board registration or removal
- assignee changes on tasks owned by the board
- create/delete flows that can create or remove child-exec links
- any admin or provisioning action that changes board-to-person delegation state

Disallowed state:

- readonly/query-safe reads that assume previously reconciled delegation links
  remain correct forever with no refresh trigger

### 2. Split actor identity from actor display

FastAPI should pass a structured actor contract, not only `sender_name`.

Required adapter/engine contract for human actors:

- `sender_person_id` for authorization
- `sender_display_name` for history/messages

Required decision for API token actors (see Security Boundary):

- define how an API token caller is represented as an engine actor before any
  mutation route migrates

`sender_external_id` is removed from the REST adapter contract. External
participants authenticate only via WhatsApp and cannot reach the REST API.
If a non-REST path ever needs this field, it must be documented separately.

Required decision before implementation:

- choose one canonical place where TaskFlow actor resolution happens

This choice must be made and documented before any Phase 1 code is written, not
during Phase 2. Building the client, the adapter interface, and the wire
protocol requires knowing the actor contract shape. The choice cannot be
deferred to implementation.

Allowed options:

- FastAPI resolves actor identity and passes a verified actor object into the
  adapter (the adapter receives a hydrated actor, not a user_id)
- the adapter resolves actor identity from authenticated FastAPI context (the
  adapter receives a user_id and is responsible for the lookup)

Under option A, the trust boundary statement is: "FastAPI authenticates the
caller and resolves actor identity; the adapter receives a verified actor
object."

Under option B, the trust boundary statement is: "FastAPI authenticates the
caller and passes an authenticated user context; the adapter resolves actor
identity from that context."

These are different wire contracts. Pick one. Document it. The current plan
text "the adapter receives a verified actor object" is only true under option A.
If option B is chosen, that sentence must be rewritten.

Disallowed state:

- resolution logic partially in Python and partially in the adapter with no
  single source of truth
- this choice deferred to Phase 2

The plan must not proceed with any Phase 1 work until one actor-resolution path
is chosen and documented here.

### 3. Add stable adapter error codes

The engine does not currently return the `error_code` field assumed by the
original plan.

Required change:

- the adapter must translate engine string failures into stable, typed error
  codes before FastAPI maps them to HTTP statuses
- actor resolution failure must return a defined HTTP status code (not 500)
  covering at minimum: no match found, ambiguous match, resolution unavailable

## Security Boundary

FastAPI remains responsible for:

- JWT validation
- session and token checks
- org and board access checks
- caller type detection (human vs agent)

The Node side remains private to FastAPI via stdin/stdout.

The trust boundary is described by whichever actor-resolution option is chosen
(see Engine Changes Required, section 2). One of the following must be true:

- FastAPI authenticates and resolves actor identity; the adapter receives a
  verified actor object (option A)
- FastAPI authenticates and passes authenticated user context; the adapter
  resolves actor identity (option B)

FastAPI must not forward raw request body values as actor identity under either
option.

### API token actors

Static API token callers (`is_agent: true` in `BoardAccessClaims`) have no
WhatsApp JID and no `person_id` in the TaskFlow identity space. If a mutation
route migrates through the adapter, the engine will need an actor to authorize
against. Without a defined actor representation for API token callers, every
mutation by an API token through the adapter will fail engine authorization.

Required decision before Phase 6:

- define the engine actor representation for an API token caller

Allowed options:

- a designated synthetic `person_id` that the engine recognizes as an API actor
  and treats as having manager-level authority on the target board
- an explicit `api_actor` flag on the actor contract that the engine handles as
  a bypass of assignee/manager checks for REST-authorized operations
- a product decision that API token callers cannot use migrated mutation routes
  in the first pass and must wait for a dedicated path

This decision must be recorded in the compatibility matrix under actor identity.

### Authorization model change

The current REST API allows a JWT user with org-level board access to mutate
tasks without requiring that user to be the assignee or a manager. The engine
enforces assignee/manager rules.

When mutation routes migrate through the adapter, callers who relied on
org-level access without matching TaskFlow identity will receive permission
errors where they previously succeeded.

This is a behavior change to the REST API contract. It must be treated as a
product decision with explicit acknowledgment, not as an incidental side effect
of the migration. The decision must be recorded before Phase 6 begins:

- either accept that migrated routes enforce engine authorization rules and
  communicate this to affected callers, or
- define an adapter-level authority bypass for org-authorized callers that
  preserves current permissiveness on specific routes

## Route Refactoring Pattern

Each migrated route follows this pattern:

1. FastAPI validates HTTP/auth/org access.
2. FastAPI calls a typed adapter method.
3. The adapter translates REST semantics to engine semantics.
4. FastAPI maps the adapter result to the existing REST response shape.

Compatibility rule:

- first-pass migrations preserve the current route-specific REST contract, even
  where REST task DTOs are inconsistent across endpoints today
- cross-route DTO normalization is a separate product/API cleanup, not an
  implicit side effect of adapter migration

## Mutation Design Rules

### Task create

`POST /boards/{board_id}/tasks` cannot be a direct raw call to
`taskflow_create`.

The adapter must preserve REST behavior including:

- simple-task-only entry point
- current assignee semantics
- current response shape
- explicit decision on duplicate detection behavior
- explicit decision on default column behavior

### Task update

`PATCH /boards/{board_id}/tasks/{task_id}` is a compatibility route, not a thin
engine proxy.

The adapter must:

- translate REST priorities to engine priorities
- translate assignee payloads to/from TaskFlow identity
- map raw target columns to engine workflow actions when possible
- route `cancelled`-style requests to the correct admin path when supported
- decide whether mixed field update + column move remains one logical mutation
  or stays API-owned until atomic orchestration exists

This is not a "nice to have later" detail. Before any PATCH migration starts,
there must be an explicit go/no-go decision:

- either add a composite transactional mutation path that preserves atomic
  REST PATCH semantics, or
- keep REST PATCH API-owned

If atomic compatibility cannot be preserved, this route must not migrate.

Implementation consequence:

- `PATCH /boards/{board_id}/tasks/{task_id}` is not an active migration target
  until the plan package records one chosen implementation

Allowed end states:

- composite transactional adapter/engine mutation exists
- PATCH remains permanently API-owned

### Task delete

`DELETE /boards/{board_id}/tasks/{task_id}` should not move until archive
semantics are matched intentionally.

The API currently owns a specific archive snapshot/history behavior. That must
either be preserved by the adapter or explicitly changed as a product decision.

## Task DTO Compatibility

Any route that returns task objects in REST shape must have an explicit field
compatibility check before migration.

Required artifact:

- a field-by-field compatibility matrix between current REST task serialization
  and the adapter output for that route

This is especially required for routes that currently depend on fields such as:

- `board_code`
- `parent_task_title`
- parsed `notes`
- `child_exec_board_id`
- `child_exec_person_id`
- `child_exec_rollup_status`

No route returning serialized task objects should migrate based on a generic
`TaskflowResult.data: any` assumption.

Minimum required coverage in the compatibility matrix:

- serializer field map for `GET /boards/{board_id}/tasks`
- serializer field map for `GET /boards/{board_id}`
- route-specific serializer field maps for every other migrated endpoint that
  returns task DTOs
- explicit source for every REST field that does not come directly from raw
  engine task rows
- explicit note when two REST routes intentionally preserve different task DTO
  shapes during parity migration

Until that extension exists, no serializer-backed route is ready for
implementation planning.

## Query Scope Rules

### Board-scoped queries that can move first

These have the best fit with the existing engine surface:

- board activity
- board filter queries
- linked tasks

### Board-local queries that still need shaping

These may migrate later through the adapter:

- board task list
- board detail

They still require response-shape translation and task DTO compatibility proof.

### Multi-board queries that stay outside the board-scoped engine first

These should remain API-owned initially:

- `/tasks/search`
- `/tasks/overdue`

They are cross-board in the REST API and do not have a clean home in a single
board-scoped engine instance.

If we later move them, that should be via:

- a dedicated multi-board adapter mode, or
- FastAPI orchestration over visible boards with a clear performance budget

### Phase 3 hard prerequisites

Phase 3 reads (activity, filter, linked-tasks) require ALL of the following
before deployment:

- Phase 2 bootstrap extraction is complete, OR `readonly: true` is confirmed as
  the safe construction path for all three routes
- reconciliation freshness contract is defined for all three query surfaces
- priority value normalization migration has run
- assignee display-name assessment is complete and any required data migration
  has run
- `task_history` format discriminator is defined and the Phase 3 activity
  normalizer handles both Python-format and engine-format rows
- DTO field maps for all three routes exist in the compatibility matrix

Phase 3 does not require:

- the mutation actor contract (reads do not need actor resolution)
- adapter error codes (reads can return a generic read error)
- notification coverage (reads do not produce notifications)

Phase 3 must not proceed while any hard prerequisite above is incomplete.

## What Stays Pure REST For Now

These surfaces remain direct FastAPI ownership in the first migration:

- authentication
- profile
- organizations
- real-time SSE/WebSocket endpoints
- comments endpoints
- board chat endpoints
- multi-board search and overdue routes

Reason:

They either have no engine equivalent today or they define a REST contract that
does not map directly to the engine/tool surface.

Note on health: the health endpoint is not migrated to the Node side, but its
contract changes under this architecture (see Health and Observability).

Note on stats: stats endpoints remain API-owned and are out of scope for this
migration.

## Notifications

### Overview

Notification delivery is dispatched from Python, but the current
`write_notification_ipc()` helper covers only one notification type. The
adapter must return a normalized notification payload. FastAPI must dispatch it.
For notification types that Python cannot currently dispatch, an explicit design
decision is required before those mutation routes can migrate.

### Normalized notification DTO

The adapter returns a list of zero or more notification objects alongside the
mutation result. Each object has:

- `type`: one of `deferred | group | dm` (see below for parent)
- type-specific fields:
  - `deferred`: `target_person_id`, `content`
  - `group`: `group_jid`, `content`, `dedup_key`
  - `dm`: `recipient_jid`, `content`
- `dedup_key` (optional): when set, dispatch must suppress duplicates with the
  same key within a defined window

This schema must be published as a shared type definition (TypeScript on the
adapter side, Python dataclass or TypedDict on the FastAPI side) before Phase 6
mutation migration begins.

### Dispatch ownership by type

| Type | FastAPI dispatch capability | Owner |
| --- | --- | --- |
| `deferred` | `write_notification_ipc()` can dispatch | FastAPI |
| `group` | No existing Python dispatch function | Required decision before Phase 6 |
| `dm` | No existing Python dispatch function | Required decision before Phase 6 |
| `parent` | No existing Python dispatch function | Node-side (see below) |

For group and DM notifications:

- a required product decision must be made before Phase 6: either build a
  Python dispatch path for group and DM notifications, or keep these mutation
  surfaces off the migration list until the dispatch path exists
- a mutation route must not migrate if its notification coverage includes group
  or DM types and no Python dispatch path exists

For parent board notifications:

- parent notification dedup logic must stay Node-side; it cannot be reproduced
  by the current Python dispatch infrastructure without a stateful dedup store
- parent notifications are dispatched by the adapter internally and are NOT
  included in the normalized payload returned to FastAPI
- FastAPI never sees parent notifications; the adapter is responsible for their
  delivery

### Notification coverage gating

Every migrated mutation path must have notification coverage verified in the
compatibility matrix before migration proceeds.

Current migration-blocking status:

- dependency routes: `DependencyResult` returns no notifications; these routes
  are NOT migration candidates until the engine adds notification fields to
  `DependencyResult`
- undo routes: `UndoResult` returns no notifications; same constraint applies

These routes are removed from the minimum coverage checklist until their engine
result types include notification payloads.

Minimum coverage required for routes that are migration candidates:

- create
- delete
- move
- reassign
- update subtypes (tracked per subtype, not as one bucket)

Minimum update subtype breakdown:

- simple field edits
- column/workflow moves
- note operations
- participant changes
- recurrence or scheduling changes
- external-participant-specific paths

Update routes with unresolved subtype coverage are not migration-eligible for
those subtypes.

### Partial dispatch failure policy

If the adapter returns a payload with multiple notification objects and FastAPI
can dispatch some but not others:

- `deferred` dispatch failures are logged and tolerated; they do not fail the
  mutation
- `group` and `dm` failures follow the dispatch policy defined before Phase 6
- a mutation result is not rolled back due to notification dispatch failure;
  notification failures are observable events, not transaction participants

### Realtime invalidation

The current SSE/WebSocket invalidation model hashes tasks, boards, people, and
config to detect changes. When mutations go through the Node subprocess, Python
no longer executes them directly and cannot infer what changed.

Required before Phase 6:

- define whether the adapter returns an invalidation hint alongside the
  notification payload (specifying which entity types changed), or FastAPI
  recomputes the hash unconditionally after every adapter mutation call
- if unconditional recomputation is chosen, document the latency impact and
  confirm it is acceptable
- if an invalidation hint is used, define its schema as part of the normalized
  mutation result DTO

Until this is defined, realtime invalidation behavior for migrated mutations is
undefined and will produce stale UI state.

## Health and Observability

### Health endpoint

The `/health` endpoint must probe subprocess liveness as part of its check. A
healthy HTTP 200 from FastAPI that conceals a dead subprocess is operationally
incorrect.

Required behavior:

- the health response must include a `subprocess` field with `healthy` or
  `unavailable`
- if the subprocess is unavailable, the health endpoint must return a non-200
  status
- the probe must be lightweight (a no-op ping or a process liveness check, not
  a database query)
- the health check must distinguish between "subprocess never started"
  (Phase 1 not yet deployed), "subprocess starting" (in startup window), and
  "subprocess died after startup" (failure mode)

This replaces the assumption that stats/health stays "pure REST" unchanged. The
route stays Python, but its contract changes.

### Subprocess boundary logging

Every MCP tool call must emit a structured log entry at the Python boundary
containing at minimum:

- tool name
- correlation ID
- duration in milliseconds
- success or error (and error code if error)

This log is the primary signal for diagnosing wrong-data bugs, slow queries, and
version skew.

### Required metrics

The following must be tracked and exported as operational metrics:

- per-tool call latency (P50, P95, P99)
- per-tool error rate
- subprocess restart count since process start (gauge; goes to 0 on restart)
- pending request queue depth (gauge)
- subprocess unavailable status (gauge; 1 = unavailable)

Without these, a wrong-data bug or a slow-query degradation has no operational
signal outside of user-facing error rates.

## Testing Strategy

The subprocess architecture changes the test surface and must be designed up
front.

### Default API test behavior

Chosen default: disable subprocess startup via an environment variable and
inject a fake client.

Mechanism:

- set `TASKFLOW_DISABLE_MCP_SUBPROCESS=1` in the default test environment
- the lifespan handler checks this variable at startup
- when set, it injects a `FakeMCPClient` instance (implementing the same
  abstract interface as `MCPSubprocessClient`) into FastAPI app state
- all endpoint tests import and use the app with this variable set
- the `FakeMCPClient` returns canned responses that can be configured per test

This mechanism must be part of Phase 1 and must be implemented before any route
is wired to the adapter. Implicit fixture behavior is not acceptable.

### Integration tests

Integration tests cover:

- real subprocess startup and the MCP handshake sequence
- subprocess crash and pending request cleanup
- graceful shutdown and WAL connection release
- `tools/list` validation at startup
- per-tool call/response round-trips with a real SQLite database

Integration tests run separately from the default API test suite, either in a
dedicated CI job or behind an explicit opt-in flag.

### CI build pipeline

As a Phase 1 deliverable alongside `taskflow-mcp-server.ts`, the CI
configuration must include:

- Node version pin
- `npm ci` for Node dependencies
- TypeScript compilation producing `taskflow-mcp-server.js`
- Python dependency install
- default API test suite execution (subprocess disabled)
- integration test suite execution (subprocess enabled, compiled binary present)

The integration test suite must not be optional or skipped by default in CI.
Without this, the compiled binary does not exist in CI and integration tests
never run as a merge gate.

## Rollback Strategy

### During Phases 3–6

Python SQL paths for non-migrated routes remain in `main.py`. Migrated routes
can be rolled back to their Python SQL paths by reverting the route handler
without a data migration, provided:

- the adapter has not yet written data in a format incompatible with what the
  Python path reads (verify before each phase deploys)
- the route is guarded by a per-route feature flag or configuration that allows
  switching back to the Python handler without a full deployment

A per-route bypass mechanism (environment variable or configuration flag) is
strongly recommended for any write route that migrates in Phase 6. This allows
an operator to redirect a route back to Python on a running instance if a bug
is discovered.

### One-way boundaries

Phase 7 cleanup removes Python SQL paths. After Phase 7 cleanup runs for a
given route, rollback requires reverting code AND assessing whether the adapter
has written data in formats the Python path would misread.

Phase 7 is a one-way boundary per route. Before Phase 7 cleanup runs for any
route, assert in writing that:

- the adapter writes data in a format byte-for-byte compatible with what the
  Python path reads
- this assertion has been validated by a test that writes via the adapter and
  reads via the Python SQL path

If this assertion cannot be made, do not run Phase 7 cleanup for that route
until the compatibility is resolved.

### "Proven stable" definition

A route is eligible for Phase 7 cleanup when ALL of the following are true,
measured in production:

- 72 consecutive hours with error rate below 0.1% on that route
- P99 latency within 30% of the Python baseline measured before migration
- zero subprocess restarts during the window
- no wrong-data incidents reported for that route during the window

This threshold must be checked against monitoring data, not eyeballed.

## Required Planning Artifacts Before Implementation

The following artifacts are considered part of this plan and must stay current
with implementation work:

- the amended main plan document
- the redesign document
- the compatibility matrix
- the normalized notification DTO schema (required before Phase 6)
- the actor-resolution decision (required before Phase 1)

Minimum expectations:

- if a route changes migration status, update the compatibility matrix
- if the architecture boundary changes, update the redesign document and this
  plan
- if a new adapter method is introduced, its place in the migration sequence
  must be reflected here
- if a serializer-backed route is considered for migration, the compatibility
  matrix must include its field-level DTO map first
- if a mutation route is considered for migration, the compatibility matrix must
  include its notification coverage status first
- if transport failure or restart behavior changes, this plan must record the
  replay policy explicitly
- if a data migration runs for pre-migration data normalization, it must be
  recorded in the compatibility matrix with its scope and idempotency guarantee

No route should be migrated based on this plan unless its behavior is covered in
the compatibility matrix or intentionally added there first.

## Migration Strategy

### Pre-Phase 1 — Required decisions

Before any Phase 1 code is written:

- choose and document the canonical actor-resolution path (option A or B, see
  Engine Changes Required, section 2)
- document the actor contract wire format for the chosen option
- document the actor representation for API token callers

These are not Phase 1 deliverables. They are prerequisites. Phase 1
implementation decisions (subprocess protocol, adapter interface, Python client
interface) depend on knowing the actor contract.

### Phase 1 — Infrastructure

- add `taskflow-mcp-server.ts` with stderr-only console output and startup ready
  sentinel
- add `engine/client.py` with NDJSON framing, readiness detection, MCP
  handshake, mandatory `tools/list` validation, and serialized call model
- wire subprocess lifecycle into FastAPI startup/shutdown with defined shutdown
  timeout
- enable WAL and busy timeout explicitly in Node startup; document the
  busy_timeout value
- implement the MCP initialize/initialized flow in the manual Python client
- implement full failure detection (exit, EOF, broken pipe) and in-flight
  request cleanup
- implement restart policy: no auto-restart, 503 on subprocess unavailability
- implement `TASKFLOW_DISABLE_MCP_SUBPROCESS=1` test isolation with FakeMCPClient
- implement subprocess boundary structured logging
- update `/health` to probe subprocess liveness
- add CI build pipeline for TypeScript compilation before tests run
- cover real subprocess startup/shutdown, handshake, and failure in dedicated
  integration tests
- add per-tool metrics (latency, error rate, restart counter, queue depth)
- no route migrations yet

### Phase 2 — Engine/bootstrap extraction and pre-migration data work

- remove constructor bootstrap side effects from request-path instantiation
- expose explicit bootstrap/reconciliation entry points
- define the structured actor contract (per the pre-Phase 1 decision)
- define the board-reconciliation freshness contract and its rerun triggers
- fix engine update semantics so transactional failure paths throw/rollback
  instead of returning partial-write failures
- define adapter error codes including actor-resolution failure codes
- decide how actor display name is sourced and propagated alongside precise
  identity
- run priority value normalization migration on the production database
- complete assignee display-name assessment; run normalization if required
- define `task_history` format discriminator; add source field to new rows
- verify column string representation parity between engine and Python PATCH
- confirm the compatibility matrix still matches the intended migration surface

No REST route should migrate before this phase is done.

### Phase 3 — Low-risk board-local reads

Migrate only:

- board activity
- board filter queries
- linked tasks

All Phase 3 hard prerequisites (see Query Scope Rules) must be met before
deployment.

These validate the subprocess and adapter architecture with limited behavioral
risk. They do not require the mutation actor contract.

### Phase 4 — Additional board-local reads

Evaluate migration of:

- board task list
- board detail

Only after response-shape compatibility is proven via an explicit task DTO
compatibility check.

This phase is blocked until the compatibility matrix includes the required
field-level DTO maps for both routes and any other serializer-backed route moved
with them.

### Phase 5 — Multi-board query decision

Choose one explicit design for:

- `/tasks/search`
- `/tasks/overdue`

Options:

- keep in FastAPI SQL
- add adapter-level multi-board query methods
- orchestrate per-board calls from FastAPI with caching/performance controls

### Phase 6 — Mutations

Migrate mutations only after all of the following are true:

- constructor/request-path bootstrap issue is resolved
- actor identity is structured and canonical resolution path is implemented
- API token actor representation is defined
- adapter error codes exist including actor-resolution failure codes
- assignee and priority translation are implemented
- PATCH mixed-mutation behavior has an explicit implementation decision
- engine update paths no longer allow partial commits on failure
- normalized notification DTO schema is published as a shared type
- Python dispatch path exists for all notification types returned by candidate
  routes, or affected routes are explicitly deferred
- parent notification dedup stays Node-side and is excluded from FastAPI payload
- notification coverage is verified per mutation surface in the compatibility
  matrix
- update notification coverage is broken down by mutation subtype
- transport-loss replay policy is implemented and tested
- realtime invalidation strategy (hint vs. unconditional recompute) is chosen
  and implemented
- authorization regression is acknowledged as a product decision and
  communicated to affected callers
- per-route bypass mechanism is in place for rollback without redeployment

Mutation order:

- create
- delete

`update` is not in the default mutation order. Add it only after one of these
is true:

- a composite transactional PATCH-compatible path exists
- the product decision is to leave REST PATCH API-owned permanently

Only if each route can preserve current REST contract semantics.

### Phase 7 — Cleanup

After a route meets the "proven stable" definition (see Rollback Strategy):

- assert adapter/Python write format compatibility before removing Python paths
- remove dead SQL/business-logic paths from `main.py` for that route
- keep comments/chat/realtime code where still appropriate
- split remaining REST-only modules out of the monolith
- keep the redesign doc and compatibility matrix aligned with the final state

Phase 7 runs incrementally per route, not as a single batch. Each route's
cleanup is gated on its own stability window.

## Out of Scope

- rewriting auth, orgs, or realtime in TypeScript
- moving comments/chat into the engine in this refactor
- forcing multi-board REST queries into one board-scoped engine abstraction
- changing product behavior silently under the label of "refactor"
- building concurrent multiplexing in the subprocess client in the first
  implementation (serial call model is accepted for Phase 1–3)

## Success Criteria

- existing REST behavior is preserved for migrated routes
- engine constructor side effects are no longer on the request path
- actor authorization uses precise identity, not only a display-name bridge
- no business rule is duplicated between FastAPI and the engine without an
  explicit adapter reason
- low-risk board-local routes migrate first
- multi-board queries and mixed PATCH semantics are handled by explicit design,
  not assumption
- subprocess death surfaces as a fast, observable 503, not a hung request
- the health endpoint accurately reflects subprocess state
- notification dispatch covers all notification types returned by migrated
  mutation routes
- pre-migration data normalization runs before the adapter reads any board data
- Phase 7 cleanup only runs after the "proven stable" threshold is met and
  write-format compatibility is verified
