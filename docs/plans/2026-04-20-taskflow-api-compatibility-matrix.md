# TaskFlow API Compatibility Matrix

**Date:** 2026-04-20
**Status:** Phase 0 contract freeze
**Companion docs:**

- `docs/plans/2026-04-20-taskflow-api-channel-design.md`
- `docs/plans/2026-04-20-taskflow-api-channel-redesign.md`

## Purpose

This document freezes the current compatibility problem into an explicit matrix.

For every relevant API contract surface, it answers three questions:

1. What does the REST API do today?
2. What does the current TaskFlow engine/tool surface do today?
3. What must an adapter do to preserve behavior without reintroducing Python-side
   domain duplication?

This is the artifact that should exist before route migration begins.

## Source of Truth

Primary code references:

- FastAPI app: `/root/tf-mcontrol/taskflow-api/app/main.py`
- API tests: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`
- Engine core: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
- Current MCP wrapper: `/root/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts`
- TaskFlow skill/runtime assumptions: `/root/nanoclaw/.claude/skills/add-taskflow/SKILL.md`

## Reading Guide

`Can reuse engine directly` means the route is already close enough to a
current engine/query surface that a thin adapter may be enough.

`Needs adapter translation` means the engine may still be the workflow core,
but the API contract differs enough that a dedicated compatibility layer is
required.

`Keep API-owned for now` means there is no meaningful engine equivalent yet and
forcing migration would only create accidental complexity.

## Global Compatibility Matrix

| Surface | REST API Today | Engine/Tool Today | Gap Type | Migration Recommendation |
| --- | --- | --- | --- | --- |
| Actor identity | JWT/static token, org/owner scoped | `sender_name` / `sender_external_id`, TaskFlow person semantics | Authorization model mismatch | Needs adapter translation |
| Task assignee field | Display name in payload and DB writes | `person_id` in engine semantics | Storage + payload mismatch | Needs adapter translation |
| Priority field | Portuguese values | English values | Enum mismatch | Needs adapter translation |
| Task create default behavior | Creates `simple`, usually `inbox` unless specified | Auto-assigns sender, defaults to `next_action` | Workflow mismatch | Needs adapter translation |
| Task update semantics | Partial patch over API payload, can replace serialized notes | Field-specific engine updates with permission gates | Payload + auth mismatch | Needs adapter translation |
| Task delete | Web-only archive/delete path for simple/inbox tasks | Engine has admin/archive flows, different semantics | Mutation mismatch | Needs adapter translation |
| Comments | `task_history(action='comment')` | Engine notes on `tasks.notes` | Data model mismatch | Keep API-owned for now |
| Board chat | Separate `board_chat` table | `send_board_chat` only writes agent messages | Missing read/write parity | Keep API-owned for now |
| Board detail | Board metadata + people + runtime config + counts | `taskflow_query('board')` returns grouped tasks | Query shape mismatch | Needs adapter translation |
| Task list | API task serializer shape | Engine task rows include TaskFlow-native semantics | Response shape mismatch | Needs adapter translation |
| Global search | Cross-board, org-filtered | Board-scoped search | Scope mismatch | Needs adapter translation |
| Filters | API-specific overdue/today/week/label/priority | Similar query concepts exist, but values differ | Query + enum mismatch | Needs adapter translation |
| Activity | Raw `task_history` rows with API filtering | Similar engine queries exist | Moderate shape mismatch | Can reuse engine with adapter |
| Linked tasks | Simple board query | Similar engine board/linked view exists | Low | Can reuse engine with adapter |
| Overdue | Cross-board/org-filtered API query | Board-scoped engine query exists | Scope mismatch | Needs adapter translation |
| Notifications | Python helper writes deferred IPC only | Wrapper handles group, DM, deferred, parent dedup | Side-effect mismatch | Needs adapter translation |
| Realtime invalidation | DB hash over tasks/boards/people/config | No API-grade invalidation contract | Side-effect mismatch | Keep API-owned, add hooks |
| Duplicate detection | None in API create route | Wrapper performs duplicate detection | Behavior mismatch | Needs adapter translation or explicit product decision |
| Semantic search | None in API route | Wrapper + engine support embeddings | Capability mismatch | Optional adapter enhancement |

## Identity And Authorization Matrix

### A. Request actor resolution

| Concern | REST API Today | Engine/Tool Today | Adapter Requirement |
| --- | --- | --- | --- |
| Auth credential | JWT cookie/header or static API token | No JWT understanding; expects already-resolved actor fields | FastAPI continues auth and resolves actor before adapter call |
| Board access | Org-based access via `require_board_access` + `check_board_org_access` | Board-scoped engine instance assumes caller is already allowed to target board | FastAPI should keep coarse board access checks |
| Mutation authority | Often org/owner scoped at route level | Assignee/manager/participant/external-contact scoped | Migration must not silently tighten auth; mismatched caller types stay API-owned until product sign-off |
| Identity lookup | `_resolve_person_id()` maps user phone to `person_id`, but task routes do not use it today | `resolvePerson()/requirePerson()` operate in TaskFlow identity space | FastAPI resolves `HumanActor` before any migrated mutation |
| Ambiguity handling | `_resolve_person_id()` returns `None` on ambiguity | Engine assumes a valid person or returns permission failure | Adapter must fail explicitly on ambiguous actor resolution, not guess |
| Static API token callers | `is_agent=True`, no `person_id` | Engine expects TaskFlow identity for mutation auth | Treat as `ServiceActor`; keep mutation path API-owned until explicit service-actor semantics exist |
| External participant identity | Not part of JWT REST caller model | Engine supports `sender_external_id` for meeting flows | Reserve for non-REST flows; not required in REST actor contract |

### B. Why this is high risk

- The API currently allows a JWT user with org access to mutate tasks without
  proving they are the assignee or a manager.
- The engine denies many such actions unless the actor is a recognized
  TaskFlow human.
- Passing a derived `sender_name` into the engine would change product behavior
  even if the route signatures stay the same.

Recorded product decision:

- migration does not silently tighten authorization
- if a route cannot preserve current REST caller behavior for a caller type, that
  caller type remains API-owned until explicit approval exists for the stricter
  behavior

## Task Field Matrix

| Field | REST API Today | Engine/Tool Today | Adapter Requirement |
| --- | --- | --- | --- |
| `id` | Exposed as board-local task ID, with helper support for `T1` and `DEVT1-uuid` comment lookups | Engine supports raw and prefixed task IDs | Mostly reusable |
| `assignee` | API accepts `assignee` or `assignee_id`, resolves to display name, returns display name | Engine expects/returns TaskFlow identity semantics centered on `person_id` | Translate request and response consistently |
| `priority` | `urgente`, `alta`, `normal`, `baixa` | `urgent`, `high`, `normal`, `low` | Bidirectional enum translation |
| `column` | API validates against REST-visible columns | Engine uses same workflow columns plus richer transition rules | Mostly reusable once actor semantics are resolved |
| `notes` | API patch can replace serialized note array directly | Engine note updates are command-style operations | Do not map blindly; either keep API-owned or design a dedicated adapter behavior |
| `type` | API create route only creates `simple`; update/delete restrict web path to `simple`/`inbox` | Engine supports `simple`, `project`, `recurring`, `inbox`, `meeting` | Adapter can constrain supported create/update path |
| `due_date` | API accepts/returns date string, no business-day logic | Engine applies business-day and recurrence rules | Product decision needed: preserve current API behavior or adopt engine behavior intentionally |
| `scheduled_at` | Exposed in serializer but not first-class in web task mutation route | Engine treats it as core for meetings | Separate meeting/API migration, not part of simple task parity |
| `requires_close_approval` | API only checks it defensively if column exists | Engine treats it as first-class workflow policy | Adapter must decide if REST exposes this or continues current limited behavior |

## REST Task DTO Matrix

This section expands the generic compatibility problem into the concrete REST
task serializer contract currently used by the dashboard.

Reference serializer:

- FastAPI `serialize_task()` in `/root/tf-mcontrol/taskflow-api/app/main.py`

Route-coverage rule:

- field-level DTO coverage is required for every migrated route that returns
  serialized task objects, not only the board list/detail exemplars below

Current serializer-backed task routes that need route-specific coverage before
migration:

- `POST /boards/{board_id}/tasks`
- `PATCH /boards/{board_id}/tasks/{task_id}`
- `GET /boards/{board_id}/tasks`
- `GET /boards/{board_id}/linked-tasks`
- `GET /boards/{board_id}/tasks/filter`
- `GET /tasks/search`
- `GET /tasks/overdue`

Normalization rule:

- first-pass adapter migration preserves each route's current REST shape unless
  the plan package records an intentional API normalization decision
- current REST inconsistencies, such as `parent_task_title` appearing on some
  routes and not others, must be recorded explicitly instead of being
  accidentally "fixed" during migration

### A. `GET /boards/{board_id}/tasks` task DTO

| REST Field | REST Source Today | Engine Source Today | Adapter Requirement |
| --- | --- | --- | --- |
| `id` | `tasks.id` | Raw task row has `id` | Reusable |
| `board_id` | `tasks.board_id` | Raw task row has `board_id` | Reusable |
| `board_code` | SQL join to `boards.short_code AS board_code` | Not present in `queryVisibleTasks()` rows | Must join or enrich explicitly |
| `title` | `tasks.title` | Raw task row has `title` | Reusable |
| `assignee` | Display name stored/read by REST | Raw task row carries TaskFlow assignee semantics | Translate to REST display-name contract |
| `column` | `tasks.column` | Raw task row has `column` | Reusable |
| `priority` | Portuguese-facing value | Raw row uses engine value set | Translate if route migrates through engine-owned values |
| `due_date` | `tasks.due_date` | Raw task row has `due_date` | Reusable |
| `type` | `tasks.type` with REST restrictions | Raw task row has `type` | Reusable if REST constraints remain above adapter |
| `labels` | Parsed JSON list | Raw task row has JSON text | Parse to REST shape |
| `description` | `tasks.description` | Raw task row has `description` | Reusable |
| `notes` | Parsed REST note array | Raw task row has engine-owned `notes` semantics | Do not assume parity; explicit route decision required |
| `parent_task_id` | `tasks.parent_task_id` | Raw task row has `parent_task_id` | Reusable |
| `parent_task_title` | SQL subquery alias `parent_task_title` | Engine query uses `parent_title` alias | Rename and preserve semantics explicitly |
| `scheduled_at` | `tasks.scheduled_at` | Raw task row has `scheduled_at` | Reusable |
| `created_at` | `tasks.created_at` | Raw task row has `created_at` | Reusable |
| `updated_at` | `tasks.updated_at` | Raw task row has `updated_at` | Reusable |
| `child_exec_board_id` | `tasks.child_exec_board_id` | Raw task row has `child_exec_board_id` | Reusable |
| `child_exec_person_id` | `tasks.child_exec_person_id` | Raw task row has `child_exec_person_id` | Reusable |
| `child_exec_rollup_status` | `tasks.child_exec_rollup_status` | Raw task row has `child_exec_rollup_status` | Reusable |

Migration gate:

- this route must not migrate until every serializer field above has an explicit
  adapter source

### B. `GET /boards/{board_id}` board detail DTO

| REST Field Group | REST Source Today | Engine Source Today | Adapter Requirement |
| --- | --- | --- | --- |
| Board row metadata | Direct `boards` row | `query('board')` does not return it | Compose outside raw board query |
| Runtime config | `board_runtime_config` join | Not returned by engine board query | Compose explicitly |
| Column config | `board_config.columns` | Not returned by engine board query | Compose explicitly |
| `people` list | Direct `board_people` query | Not returned by engine board query | Compose explicitly |
| `tasks_by_column` | REST count helper | Engine board query groups rows, but not board detail REST shape | Normalize intentionally |
| Linked tasks | Separate REST route/query | Engine board query returns `linked_tasks` | Can reuse with shaping |

Migration gate:

- board detail must not migrate on the assumption that `query('board')` is
  already the REST board detail contract

## Route Matrix

### 1. `POST /boards/{board_id}/tasks`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Route intent | Create a simple task for dashboard use | Create any TaskFlow task type | Constrain adapter to simple-task creation first |
| Assignee input | `assignee_id` or `assignee`, resolved to display name | Assignee resolved as TaskFlow person | Translate incoming assignee to `person_id`, but preserve REST response shape |
| Default column | `payload.column or "inbox"` | `inbox` only for `type='inbox'`, otherwise `next_action` | Explicitly override to preserve current web behavior |
| Auto-assignment | None if no assignee provided | Auto-assigns sender when possible | Disable or post-process for API parity |
| Duplicate detection | None | Wrapper may warn/block on similar tasks | Either disable for API adapter or add explicit product contract |
| Notifications | Python helper creates deferred notification only | Wrapper can produce richer notifications | Normalize notifications through adapter |
| Result shape | Serialized task row in API format | Engine result is mutation-centric | Re-fetch/reshape into REST contract |

Recommendation: `Needs adapter translation`

### 2. `PATCH /boards/{board_id}/tasks/{task_id}`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Mutation style | Generic partial patch over task resource | Command-style field updates with TaskFlow auth | Adapter must map only supported REST fields |
| Auth | Board/org access only | Assignee/manager/meeting participant/external rules | Explicit actor-resolution or keep route API-owned |
| Notes | Full note-array replacement | Note add/edit/remove/status operations | Do not migrate note replacement naively |
| Priority | Portuguese values | English values | Translate |
| Assignee | Display name response | `person_id` semantics | Translate |
| Column move restrictions | API manually blocks recurring/delegated and close-approval violations | Engine has richer transition rules | Adapter can benefit from engine rules, but only after actor semantics are explicit |
| History output | API writes JSON `changes` bundle into `task_history` | Engine records its own history semantics | Decide whether API history contract must stay as-is |

Recommendation: `Needs adapter translation`

### 3. `DELETE /boards/{board_id}/tasks/{task_id}`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Supported task types | `simple` / `inbox` only | Engine supports broader admin flows | Keep REST constraints explicit |
| Archive behavior | Snapshot + history copied into `archive`, then delete row | Engine has its own archive/admin semantics | Preserve current archive semantics unless product change is intentional |
| Auth | Board/org access only | Manager/TaskFlow auth depending on action | Explicit actor-resolution needed |

Recommendation: `Needs adapter translation`

### 4. `GET /boards/{board_id}/tasks`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Scope | Board-local task list with optional `column` filter | Board and delegated visibility depending on query path | Keep board-local REST semantics unless intentionally expanded |
| Shape | API serializer includes `parent_task_title`, display-name assignee, API notes | Engine returns TaskFlow-native task rows | Response translation layer |

Recommendation: `Needs adapter translation`

### 5. `GET /boards/{board_id}`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Includes | Board row, people, runtime config, column config, task counts | `query('board')` returns grouped tasks + linked tasks | Compose from adapter or keep query API-owned |

Recommendation: `Needs adapter translation`

### 6. `GET /tasks/search`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Scope | Cross-board search, then org visibility filtering | Board-scoped search only | Adapter must orchestrate per-board search or keep SQL path |
| Search mode | Title, description, ID lexical match | Lexical + optional semantic, board-local | Product decision required |

Recommendation: `Needs adapter translation`

### 7. `GET /boards/{board_id}/tasks/filter`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Filter names | `overdue`, `due_today`, `due_this_week`, `urgent`, `high_priority`, `by_label` | Similar query concepts exist | Adapter can map |
| Priority values | Portuguese | English | Translate |
| Sorting | REST sorts by due date | Engine queries often already order, but not identically everywhere | Normalize output ordering |

Recommendation: `Can reuse engine with adapter`

### 8. `GET /boards/{board_id}/activity`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Modes | `changes_today`, `changes_since` | `changes_today`, `changes_since`, `changes_this_week` | Good alignment |
| Output | Raw task_history rows with JSON-decoded details | Similar engine query output | Shape normalization only |

Recommendation: `Can reuse engine with adapter`

### 9. `GET /boards/{board_id}/linked-tasks`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Scope | Board-local linked tasks | `query('board')` also includes linked tasks | Low mismatch |

Recommendation: `Can reuse engine with adapter`

### 10. `GET /tasks/overdue`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Scope | Global or org-filtered across visible boards | Board-scoped overdue query | Adapter must aggregate per visible board or keep API SQL |

Recommendation: `Needs adapter translation`

### 11. `GET/POST /boards/{board_id}/tasks/{task_id}/comments`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Storage | `task_history(action='comment')` | No dedicated comment tool; notes are different | No direct mapping |
| Pagination | Explicit `limit`/`offset` over comment history rows | No comment pagination contract | Keep API-owned |
| Notification side effect | Python helper notifies assignee | Engine note notifications are different | Keep API-owned for now |

Recommendation: `Keep API-owned for now`

### 12. `GET/POST /boards/{board_id}/chat`

| Dimension | Current REST | Current Engine | Required Adapter Behavior |
| --- | --- | --- | --- |
| Storage | `board_chat` table | `send_board_chat` only inserts agent reply rows | No parity |
| Reader | API supports listing board chat | No engine query for board chat | Keep API-owned |

Recommendation: `Keep API-owned for now`

## Side-Effect Matrix

| Side Effect | Current Owner | Current Behavior | Adapter Requirement |
| --- | --- | --- | --- |
| Duplicate detection | MCP wrapper | Warn/block create based on embeddings | Decide whether API adapter opts in |
| Semantic ranking | MCP wrapper + engine | Search can be embedding-assisted | Optional enhancement, not required for parity |
| Deferred notifications | Python helper and wrapper | Python can only write by `target_person_id`; wrapper also handles richer routing | Centralize in adapter/runtime service |
| DM notifications | Wrapper | Sends direct DMs to external contacts or direct recipients | Python helper cannot reproduce this; adapter required |
| Parent notification dedup | Wrapper | Suppresses duplicate parent-group sends | Must stay Node-side if reused |
| Child-board provisioning trigger | Wrapper on admin action | Emits provisioning IPC | If admin flows migrate, this must move with them |
| Comment invalidation | Python route | Manually bumps `tasks.updated_at` | Keep explicit hook if comments stay API-owned |
| SSE/WebSocket invalidation | Python | Hash over tasks/boards/board_people/board_config | Keep API-owned until a better event contract exists |

## Mutation Notification Coverage Matrix

This section records whether a candidate delegated mutation path currently
returns notification payloads suitable for REST-side dispatch.

| Mutation Surface | Current Engine/Wrapper Coverage | Migration Readiness |
| --- | --- | --- |
| Create | Returns notifications | Can migrate if REST parity is preserved |
| Move | Returns notifications | Can migrate if REST route semantics align |
| Reassign | Returns notifications | Can migrate if route semantics align |
| Update: simple field edits | Mixed; engine path exists but REST parity and rollback behavior are unresolved | Can migrate only if PATCH atomicity and rollback semantics are solved |
| Update: column/workflow moves | Move notifications exist, but REST PATCH bundling is unresolved | Can migrate only if PATCH atomicity and route semantics are solved |
| Update: note operations | Different semantics from REST comment endpoints | Keep API-owned or model separately |
| Update: participant changes | Mixed meeting-specific behavior | Evaluate separately before migration |
| Update: recurrence or scheduling changes | Mixed behavior and different REST exposure | Evaluate separately before migration |
| Update: external-participant paths | Mixed meeting-specific behavior | Evaluate separately before migration |
| Delete via REST route | No direct REST-parity engine mutation | Keep API-owned until delete/archive semantics are explicit |
| Dependency | No notifications returned | Not ready for delegated migration |
| Undo | No notifications returned | Not ready for delegated migration |
| Admin actions | Mixed coverage depending on action | Evaluate per action before migration |

Migration gate:

- a mutation route should not migrate until its notification coverage status is
  explicitly marked acceptable here

## Error Contract Matrix

| Concern | Current REST | Current Engine/Wrapper | Adapter Requirement |
| --- | --- | --- | --- |
| Error shape | HTTP status + `detail` | `{ success: false, error: string }` | Define structured adapter error codes before migration |
| Validation failures | Pydantic -> 400/422 depending on route | Tool schema + engine string error | Normalize statuses deliberately |
| Permission failures | `HTTPException(403)` | `success: false, error: "Permission denied..."` | Explicit mapping table required |
| Missing resource | 404 from Python helper | Engine mostly returns string errors | Adapter must introduce stable codes |
| Busy/overload | Route-local DB failures today | Single subprocess queue + SQLite writer contention | Map queue saturation / `SQLITE_BUSY` to stable retriable busy/unavailable errors |

## What Can Move First

Lowest-risk candidates:

- board activity
- board filter queries
- linked tasks

Medium risk:

- board task list
- board detail

High risk:

- multi-board search
- multi-board overdue
- task create
- task update
- task delete

Do not migrate comments or board chat in the first pass.

## What The Adapter Must Guarantee

Before any mutation route migrates, the adapter must guarantee:

- deterministic actor resolution
- FastAPI-owned actor resolution before adapter invocation
- caller-type-aware routing (`HumanActor` vs `ServiceActor`)
- bidirectional assignee translation
- bidirectional priority translation
- explicit error codes
- normalized notification dispatch contract
- preserved REST response shape

## Decision Log

### Keep API-owned for now

- `/boards/{board_id}/tasks/{task_id}/comments`
- `/boards/{board_id}/chat`
- SSE/WebSocket emission logic

Reason:

These surfaces currently define product behavior that is not represented in the
engine as-is. Forcing them into the migration early would create churn without
reducing meaningful duplication.

### Adapter-first migration targets

- board activity
- board filters
- linked tasks

Reason:

These already have meaningful engine/query equivalents and can validate the
subprocess/client architecture with limited behavioral risk.

## Immediate Follow-Up

The next implementation artifact after this matrix should be a concrete adapter
interface document, with typed request/response shapes for:

- actor resolution result
- normalized task DTO
- normalized notification DTO
- structured adapter error result
