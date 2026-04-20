# TaskFlow REST API as a Channel — Design

**Date:** 2026-04-20
**Status:** Approved for implementation

## Problem

The TaskFlow system has two separate implementations of the same domain logic:

- `container/agent-runner/src/taskflow-engine.ts` — canonical mutation and query engine used by all WhatsApp agents
- `taskflow-api/main.py` — FastAPI REST API serving the Mission Control SPA, with 3,655 lines of interleaved business logic, SQL, and HTTP handling

Any change to board behavior (column transitions, WIP limits, history, notifications) must be made twice. The two implementations drift. Business rules are not testable in isolation on either side.

## Goal

Make the FastAPI REST API a thin HTTP channel over the existing `TaskflowEngine`, the same way the WhatsApp container agents are a thin NLP channel over it. One implementation of domain logic, two delivery surfaces.

## Architecture

```
Internet → FastAPI (Python)
             ├── Auth, Orgs, Profile, Events  [stays pure REST]
             └── Task + Board operations
                       ↓ JSON-RPC over stdin/stdout
                 taskflow-mcp-server.js (Node.js subprocess)
                       ↓
                 TaskflowEngine(db, board_id)
                       ↓
                 taskflow.db (SQLite)
```

## New Components

### 1. `taskflow-mcp-server.ts`

A new standalone MCP stdio server at `container/agent-runner/src/taskflow-mcp-server.ts`. It accepts a single `--db` CLI argument pointing to the SQLite database. It opens one `better-sqlite3` connection at startup and holds it for the process lifetime. For each incoming tool call it instantiates `TaskflowEngine(db, board_id)` and delegates to the appropriate method.

It registers the same tool surface already used by container agents: `taskflow_create`, `taskflow_move`, `taskflow_update`, `taskflow_reassign`, `taskflow_dependency`, `taskflow_admin`, `taskflow_undo`, `taskflow_query`, `taskflow_report`. No container environment variables, no IPC directories, no workspace paths. Input in, structured JSON out.

`board_id` and `sender_name` are required parameters on every mutating tool call. The engine trusts both — it is the caller's responsibility to supply them from verified sources.

### 2. `engine/client.py`

An async Python class that manages the subprocess lifecycle. It spawns `node taskflow-mcp-server.js --db <path>` once when FastAPI starts via its lifespan context manager, and terminates it on shutdown. Requests are sent as JSON-RPC `tools/call` messages over stdin; responses are read from stdout by a background reader coroutine. Concurrent requests are serialized through an async lock on the write side and correlated by sequence ID on the read side. A 30-second per-call timeout guards against engine hangs.

## Security Boundary

The engine subprocess is a child process of FastAPI. Its stdin/stdout are private file descriptors — no network port, no socket, no other process can reach it. The OS enforces the trust boundary.

FastAPI is responsible for all HTTP-layer security: JWT validation, session revocation, board org-access checks. It never forwards raw user input to the engine. `sender_name` is always resolved from the authenticated JWT by looking up the user's phone in `board_people` — it is never taken from the request body. The engine receives only what FastAPI explicitly constructs.

Engine-side security: all tool arguments are validated by Zod schemas before any database access. The engine enforces domain-level rules (manager vs team member roles, approval gates, WIP limits, hierarchy depth limits).

Concurrency: with multiple FastAPI workers, each spawns its own engine subprocess. SQLite WAL mode handles concurrent reads; writes serialize through SQLite's internal locking.

## Route Refactoring Pattern

Each migrated task or board route sheds its inline SQL and business logic and becomes a three-step adapter: verify access (existing `require_board_access` dependency), call the engine, map the result to HTTP.

Notification delivery stays in Python. The engine returns a `notifications[]` array in every mutation result; FastAPI dispatches each entry through the existing `write_notification_ipc()` function. No IPC logic moves to the engine.

Engine errors carry an `error_code` string. A static mapping translates known codes to HTTP status codes (`board_not_found → 404`, `wip_limit_exceeded → 409`, `invalid_transition → 422`). Unknown errors default to 400.

## What Stays Pure REST

The following have no engine equivalent and remain as direct SQL routes in Python:

- Authentication: OTP request/verify, token refresh, logout
- Profile: `/auth/me` GET and PATCH
- Organizations: CRUD, members, invites
- Real-time: SSE board events, WebSocket stats stream
- Stats and health endpoints
- Heartbeat monitor

## Migration Strategy

Four phases, each independently reversible.

**Phase 1 — Infrastructure.** Add `taskflow-mcp-server.ts` and compile it. Add `engine/client.py`. Wire the subprocess into FastAPI lifespan. No routes change. Verify the engine starts, accepts a test call, and shuts down cleanly.

**Phase 2 — Task mutations.** Migrate `create_task`, `update_task`, `delete_task`. These are the highest-value routes and the most logic-heavy. Run the existing test suite after each.

**Phase 3 — Board queries and remaining task routes.** Migrate board detail, task list, activity, search, filters, linked tasks, chat, and overdue endpoints.

**Phase 4 — Cleanup.** Remove dead code from `main.py`: SQL helpers, `serialize_task`, `fetch_task`, `next_task_id`, `enforce_move_or_delete_rules`, and inline notification logic. Split remaining pure-REST routes into separate modules. The monolith is gone.

## Out of Scope

- Rewriting auth, orgs, or real-time in TypeScript
- Changing the engine's tool surface
- Migrating the production database schema
- Adding new TaskFlow features during the refactor

## Success Criteria

- All existing REST API tests pass after each phase
- No business logic duplicated between `main.py` and `taskflow-engine.ts`
- A change to a column transition rule requires editing one file
- The engine can be unit-tested without FastAPI
