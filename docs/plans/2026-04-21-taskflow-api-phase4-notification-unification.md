# Phase 4: Notification and Event-Invalidation Unification

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define and implement shared primitives so that when task mutations move to the Node adapter (Phase 6), FastAPI does not need to reconstruct notification semantics from incomplete engine results.

**Architecture:** Python continues to own deferred IPC notification writes for the REST API channel. Node mutation tools will return fully-formed `NotificationEvent` objects; Python receives and dispatches them. SSE invalidation is extended to cover `board_chat` changes, which are currently invisible to the hash-based polling loop.

**Tech Stack:** Python (FastAPI, sqlite3), TypeScript (MCP SDK), SQLite, IPC filesystem protocol.

---

## Pre-existing failures — fix first

Three tests in `tests/test_api.py` fail because they assert specific `id` values on `task_history` rows, but the conftest fixture already seeds 2 non-comment rows (ids 1 and 2) before each test runs. The comment rows inserted in those tests get ids 3 and 4, not 1 and 2.

### Task 0: Fix hardcoded id assertions in comment tests

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/tests/test_api.py:491-675`

**Step 1: Understand the fixtures**

The conftest (`tests/conftest.py`) inserts 2 `task_history` rows in the `db_path` fixture:
- id=1: `action='update'`, `by='alice'`, `at='2020-01-01...'`
- id=2: `action='create'`, `by='alice'`, `at=datetime('now',...)`

So any comment rows inserted by tests start at id=3.

**Step 2: Fix test_get_comments_reads_task_history_rows_with_pagination**

The test inserts 2 comment rows (ids 3 and 4) and calls `limit=1&offset=1`, expecting the second — but asserts `"id": 2`. Change the assertion so id is not checked:

Find (around line 521):
```python
    assert response.json() == [
        {
            "id": 2,
            "task_id": "task-simple",
            "author_id": "bob",
            "author_name": "bob",
            "message": "Second",
            "created_at": "2026-04-01T11:00:00Z",
        }
    ]
```
Replace with:
```python
    body = response.json()
    assert len(body) == 1
    row = body[0]
    assert row["task_id"] == "task-simple"
    assert row["author_id"] == "bob"
    assert row["author_name"] == "bob"
    assert row["message"] == "Second"
    assert row["created_at"] == "2026-04-01T11:00:00Z"
```

**Step 3: Fix test_get_comments_accepts_t_number_task_reference**

Find the assertion around line 608:
```python
    assert response.json() == [
        {
            "id": 1,
            "task_id": "task-simple",
            "author_id": "alice",
            "author_name": "alice",
            "message": "First",
            "created_at": "2026-04-01T10:00:00Z",
        }
    ]
```
Replace with:
```python
    body = response.json()
    assert len(body) == 1
    row = body[0]
    assert row["task_id"] == "task-simple"
    assert row["author_id"] == "alice"
    assert row["message"] == "First"
    assert row["created_at"] == "2026-04-01T10:00:00Z"
```

**Step 4: Fix test_get_comments_accepts_uuid_style_task_reference**

Find the assertion around line 670:
```python
    assert response.json() == [
        {
            "id": 1,
            "task_id": "T1",
            "author_id": "alice",
            "author_name": "alice",
            "message": "First",
            "created_at": "2026-04-01T10:00:00Z",
        }
    ]
```
Replace with:
```python
    body = response.json()
    assert len(body) == 1
    row = body[0]
    assert row["task_id"] == "T1"
    assert row["author_id"] == "alice"
    assert row["message"] == "First"
    assert row["created_at"] == "2026-04-01T10:00:00Z"
```

**Step 5: Run the three tests to confirm they pass**

Run from `/root/tf-mcontrol/taskflow-api`:
```bash
TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py::test_get_comments_reads_task_history_rows_with_pagination tests/test_api.py::test_get_comments_accepts_t_number_task_reference tests/test_api.py::test_get_comments_accepts_uuid_style_task_reference -v
```
Expected: 3 passed.

**Step 6: Run the full test suite to confirm no regressions**

```bash
TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py -x -q 2>&1 | tail -5
```
Expected: 0 failed.

**Step 7: Commit**

```bash
cd /root/tf-mcontrol && git add taskflow-api/tests/test_api.py && git commit -m "fix: remove hardcoded task_history id assertions in comment tests"
```

---

## Phase 4 implementation

### Task 1: Fix board_chat SSE invalidation

**Background:** `fetch_change_hash()` in `main.py` polls `MAX(tasks.updated_at)` and row counts. Board chat messages live in the `board_chat` table and are invisible to this hash — inserting a chat message never triggers an SSE `taskflow:updated` event. This is the "board-chat invalidation" gap.

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py` (around line 1816)
- Test: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`

**Step 1: Write the failing test**

Add after the existing `fetch_change_hash` tests (search for "test_sse" or add near the end of the file before `# ==================== AUTH TESTS ====================`):

```python
@pytest.mark.asyncio
async def test_sse_hash_changes_when_board_chat_message_inserted(main_module, db_path):
    """Board chat inserts must change the SSE change hash so the poller fires."""
    with main_module.db_connection() as conn:
        hash_before = main_module.fetch_change_hash(conn)

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO board_chat (board_id, sender_name, sender_type, content, created_at)
            VALUES ('board-001', 'alice', 'user', 'hello', '2026-04-21T10:00:00Z')
            """
        )
        conn.commit()

    with main_module.db_connection() as conn:
        hash_after = main_module.fetch_change_hash(conn)

    assert hash_before != hash_after
```

**Step 2: Run to confirm it fails**

```bash
cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py::test_sse_hash_changes_when_board_chat_message_inserted -v
```
Expected: FAIL (hash_before == hash_after).

**Step 3: Fix fetch_change_hash to include board_chat**

In `/root/tf-mcontrol/taskflow-api/app/main.py`, find `fetch_change_hash` (line ~1816):

```python
def fetch_change_hash(conn: sqlite3.Connection) -> str:
    board_people_count = conn.execute("SELECT COUNT(*) AS count FROM board_people").fetchone()["count"]
    board_config_count = 0
    if table_exists(conn, "board_config"):
        board_config_count = conn.execute("SELECT COUNT(*) AS count FROM board_config").fetchone()["count"]
    task_bits = conn.execute(
        """
        SELECT COALESCE(MAX(updated_at), '') AS max_updated_at, COUNT(*) AS count
        FROM tasks
        """
    ).fetchone()
    boards_count = conn.execute("SELECT COUNT(*) AS count FROM boards").fetchone()["count"]
    return f"{task_bits['max_updated_at']}:{task_bits['count']}|{boards_count}|{board_people_count}|{board_config_count}"
```

Replace with:

```python
def fetch_change_hash(conn: sqlite3.Connection) -> str:
    board_people_count = conn.execute("SELECT COUNT(*) AS count FROM board_people").fetchone()["count"]
    board_config_count = 0
    if table_exists(conn, "board_config"):
        board_config_count = conn.execute("SELECT COUNT(*) AS count FROM board_config").fetchone()["count"]
    task_bits = conn.execute(
        """
        SELECT COALESCE(MAX(updated_at), '') AS max_updated_at, COUNT(*) AS count
        FROM tasks
        """
    ).fetchone()
    boards_count = conn.execute("SELECT COUNT(*) AS count FROM boards").fetchone()["count"]
    board_chat_max = ""
    if table_exists(conn, "board_chat"):
        row = conn.execute("SELECT COALESCE(MAX(created_at), '') AS max_at FROM board_chat").fetchone()
        board_chat_max = row["max_at"]
    return f"{task_bits['max_updated_at']}:{task_bits['count']}|{boards_count}|{board_people_count}|{board_config_count}|{board_chat_max}"
```

**Step 4: Run to confirm the test passes**

```bash
cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py::test_sse_hash_changes_when_board_chat_message_inserted -v
```
Expected: PASS.

**Step 5: Run full suite**

```bash
TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py -x -q 2>&1 | tail -5
```
Expected: 0 failed.

**Step 6: Commit**

```bash
cd /root/tf-mcontrol && git add taskflow-api/app/main.py taskflow-api/tests/test_api.py && git commit -m "feat: include board_chat in SSE change hash for real-time invalidation"
```

---

### Task 2: Define NotificationEvent TypeScript contract

**Background:** When Phase 6 mutation tools are added to `taskflow-mcp-server.ts`, they must return notification events in their result so Python can dispatch them without reconstructing message text. This task defines the contract types — no runtime mutation code yet.

There are three notification event kinds used by the current system:
- `deferred_notification` — written to `ipc/<group_folder>/tasks/`, delivered when the board is provisioned
- `direct_message` — written to `ipc/messages/`, delivered immediately via WhatsApp JID
- `parent_notification` — sent to the parent board's group when a child-board task changes

**Files:**
- Modify: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.ts`
- Test: `/root/nanoclaw/container/agent-runner/src/taskflow-mcp-server.test.ts`

**Step 1: Write a failing test that imports the contract types**

In `taskflow-mcp-server.test.ts`, add a test block:

```typescript
describe('NotificationEvent contract', () => {
  it('parseNotificationEvents accepts valid deferred_notification', () => {
    const events = parseNotificationEvents([
      { kind: 'deferred_notification', target_person_id: 'person-1', message: 'hello', board_id: 'b1' },
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('deferred_notification')
  })

  it('parseNotificationEvents accepts valid direct_message', () => {
    const events = parseNotificationEvents([
      { kind: 'direct_message', target_chat_jid: '12@g.us', message: 'hi' },
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('direct_message')
  })

  it('parseNotificationEvents accepts valid parent_notification', () => {
    const events = parseNotificationEvents([
      { kind: 'parent_notification', parent_group_jid: '99@g.us', message: 'child updated' },
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('parent_notification')
  })

  it('parseNotificationEvents skips items with unknown kind', () => {
    const events = parseNotificationEvents([
      { kind: 'unknown_kind', message: 'ignored' },
    ])
    expect(events).toHaveLength(0)
  })

  it('parseNotificationEvents returns empty for non-array input', () => {
    expect(parseNotificationEvents(null)).toHaveLength(0)
    expect(parseNotificationEvents(undefined)).toHaveLength(0)
    expect(parseNotificationEvents('string')).toHaveLength(0)
  })
})
```

**Step 2: Run to confirm it fails**

```bash
cd /root/nanoclaw/container/agent-runner && npx vitest run src/taskflow-mcp-server.test.ts 2>&1 | tail -15
```
Expected: FAIL (`parseNotificationEvents is not exported`).

**Step 3: Add the contract types and validator to taskflow-mcp-server.ts**

Add after the existing `ResolvedActor` / `parseActorArg` block:

```typescript
type DeferredNotificationEvent = {
  kind: 'deferred_notification'
  board_id: string
  target_person_id: string
  message: string
}

type DirectMessageEvent = {
  kind: 'direct_message'
  target_chat_jid: string
  message: string
}

type ParentNotificationEvent = {
  kind: 'parent_notification'
  parent_group_jid: string
  message: string
}

export type NotificationEvent =
  | DeferredNotificationEvent
  | DirectMessageEvent
  | ParentNotificationEvent

export function parseNotificationEvents(raw: unknown): NotificationEvent[] {
  if (!Array.isArray(raw)) return []
  const out: NotificationEvent[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    if (obj.kind === 'deferred_notification') {
      if (typeof obj.board_id === 'string' && obj.board_id &&
          typeof obj.target_person_id === 'string' && obj.target_person_id &&
          typeof obj.message === 'string') {
        out.push(obj as DeferredNotificationEvent)
      }
    } else if (obj.kind === 'direct_message') {
      if (typeof obj.target_chat_jid === 'string' && obj.target_chat_jid &&
          typeof obj.message === 'string') {
        out.push(obj as DirectMessageEvent)
      }
    } else if (obj.kind === 'parent_notification') {
      if (typeof obj.parent_group_jid === 'string' && obj.parent_group_jid &&
          typeof obj.message === 'string') {
        out.push(obj as ParentNotificationEvent)
      }
    }
  }
  return out
}
```

**Step 4: Run to confirm the tests pass**

```bash
cd /root/nanoclaw/container/agent-runner && npx vitest run src/taskflow-mcp-server.test.ts 2>&1 | tail -10
```
Expected: all tests pass, including the new 5.

**Step 5: Build to verify TypeScript compiles**

```bash
cd /root/nanoclaw/container/agent-runner && npx tsc --noEmit 2>&1
```
Expected: no errors.

**Step 6: Commit**

```bash
cd /root/nanoclaw && git add container/agent-runner/src/taskflow-mcp-server.ts container/agent-runner/src/taskflow-mcp-server.test.ts && git commit -m "feat: add NotificationEvent contract types and parseNotificationEvents to MCP server"
```

---

### Task 3: Add Python dispatch_mcp_notification_events

**Background:** When Phase 6 mutation tools return `notification_events` in their MCP result, Python needs a single function to dispatch them all without reconstructing message text. This function wraps the existing `write_notification_ipc` for deferred events; direct-message and parent-notification events are logged but not yet handled (the Python API channel does not deliver direct WhatsApp messages — that is the Node IPC channel's job).

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py` (after `notify_task_commented`, around line 2090)
- Test: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`

**Step 1: Write the failing test**

```python
def test_dispatch_mcp_notification_events_writes_deferred_ipc(tmp_path, main_module, monkeypatch):
    """dispatch_mcp_notification_events must call write_notification_ipc for each deferred event."""
    dispatched = []

    def fake_write(conn, board_id, person_id, message):
        dispatched.append({"board_id": board_id, "person_id": person_id, "message": message})

    monkeypatch.setattr(main_module, "write_notification_ipc", fake_write)

    events = [
        {"kind": "deferred_notification", "board_id": "board-001", "target_person_id": "person-1", "message": "Task assigned"},
        {"kind": "deferred_notification", "board_id": "board-001", "target_person_id": "person-2", "message": "Task moved"},
        {"kind": "direct_message", "target_chat_jid": "12345@g.us", "message": "direct"},
        {"kind": "parent_notification", "parent_group_jid": "99@g.us", "message": "parent"},
    ]

    with main_module.db_connection() as conn:
        main_module.dispatch_mcp_notification_events(conn, events)

    assert dispatched == [
        {"board_id": "board-001", "person_id": "person-1", "message": "Task assigned"},
        {"board_id": "board-001", "person_id": "person-2", "message": "Task moved"},
    ]


def test_dispatch_mcp_notification_events_ignores_empty_list(main_module, monkeypatch):
    """dispatch_mcp_notification_events must not fail on empty or non-list input."""
    called = []
    monkeypatch.setattr(main_module, "write_notification_ipc", lambda *a, **kw: called.append(1))

    with main_module.db_connection() as conn:
        main_module.dispatch_mcp_notification_events(conn, [])
        main_module.dispatch_mcp_notification_events(conn, None)

    assert called == []
```

**Step 2: Run to confirm they fail**

```bash
cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py::test_dispatch_mcp_notification_events_writes_deferred_ipc tests/test_api.py::test_dispatch_mcp_notification_events_ignores_empty_list -v
```
Expected: FAIL (`AttributeError: module has no attribute 'dispatch_mcp_notification_events'`).

**Step 3: Implement dispatch_mcp_notification_events**

Add after `notify_task_commented` (around line 2090) in `/root/tf-mcontrol/taskflow-api/app/main.py`:

```python
def dispatch_mcp_notification_events(
    conn: sqlite3.Connection,
    events: Optional[List[Dict[str, Any]]],
) -> None:
    """Dispatch notification events returned by a Node MCP mutation tool.

    Deferred notifications are written to the IPC directory for the NanoClaw
    orchestrator to deliver. Direct-message and parent-notification events are
    not dispatched by this channel — those require WhatsApp JID routing that
    is the responsibility of the Node IPC channel.
    """
    if not events:
        return
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("kind") == "deferred_notification":
            board_id = event.get("board_id", "")
            person_id = event.get("target_person_id", "")
            message = event.get("message", "")
            if board_id and person_id and message:
                write_notification_ipc(conn, board_id, person_id, message)
```

**Step 4: Run to confirm the tests pass**

```bash
cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py::test_dispatch_mcp_notification_events_writes_deferred_ipc tests/test_api.py::test_dispatch_mcp_notification_events_ignores_empty_list -v
```
Expected: 2 passed.

**Step 5: Run full suite**

```bash
TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py -x -q 2>&1 | tail -5
```
Expected: 0 failed.

**Step 6: Commit**

```bash
cd /root/tf-mcontrol && git add taskflow-api/app/main.py taskflow-api/tests/test_api.py && git commit -m "feat: add dispatch_mcp_notification_events for Phase 6 mutation results"
```

---

### Task 4: Add call_mcp_mutation Python helper

**Background:** The existing `call_required_mcp_rows` helper handles read-only MCP tools — it expects `{ rows: [...] }` back and fails if unavailable. Mutations need a different shape: `{ success, data, notification_events }`. This task adds `call_mcp_mutation` that calls the tool, dispatches any notification events, and returns the mutation result data — leaving callers free from notification dispatch boilerplate.

**Files:**
- Modify: `/root/tf-mcontrol/taskflow-api/app/main.py` (after `call_required_mcp_rows`, around line 1315)
- Test: `/root/tf-mcontrol/taskflow-api/tests/test_api.py`

**Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_call_mcp_mutation_returns_data_and_dispatches_events(main_module, monkeypatch):
    """call_mcp_mutation must return result data and dispatch notification events."""
    from unittest.mock import AsyncMock, MagicMock

    dispatched = []
    monkeypatch.setattr(main_module, "dispatch_mcp_notification_events", lambda conn, evts: dispatched.extend(evts or []))

    fake_client = MagicMock()
    fake_client.is_alive.return_value = True
    fake_client.call = AsyncMock(return_value={
        "success": True,
        "data": {"id": "task-1", "title": "New task"},
        "notification_events": [
            {"kind": "deferred_notification", "board_id": "b1", "target_person_id": "p1", "message": "assigned"},
        ],
    })

    fake_request = MagicMock()
    fake_request.app.state.mcp_client = fake_client

    fake_claims = MagicMock()
    monkeypatch.setattr(main_module, "ensure_board_access_prechecked", lambda *a, **kw: None)

    result = await main_module.call_mcp_mutation(fake_request, "board-001", fake_claims, "api_create_task", {"title": "New task"})

    assert result == {"id": "task-1", "title": "New task"}
    assert len(dispatched) == 1
    assert dispatched[0]["kind"] == "deferred_notification"


@pytest.mark.asyncio
async def test_call_mcp_mutation_raises_503_when_unavailable(main_module, monkeypatch):
    """call_mcp_mutation must raise 503 when MCP client is unavailable."""
    from fastapi import HTTPException

    fake_request = MagicMock()
    fake_request.app.state.mcp_client = None

    fake_claims = MagicMock()
    monkeypatch.setattr(main_module, "ensure_board_access_prechecked", lambda *a, **kw: None)

    with pytest.raises(HTTPException) as exc_info:
        await main_module.call_mcp_mutation(fake_request, "board-001", fake_claims, "api_create_task", {})

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_call_mcp_mutation_raises_503_on_engine_failure(main_module, monkeypatch):
    """call_mcp_mutation must raise 503 when the engine reports success=False."""
    from fastapi import HTTPException
    from unittest.mock import AsyncMock, MagicMock

    fake_client = MagicMock()
    fake_client.is_alive.return_value = True
    fake_client.call = AsyncMock(return_value={"success": False, "error": "Task not found"})

    fake_request = MagicMock()
    fake_request.app.state.mcp_client = fake_client

    fake_claims = MagicMock()
    monkeypatch.setattr(main_module, "ensure_board_access_prechecked", lambda *a, **kw: None)

    with pytest.raises(HTTPException) as exc_info:
        await main_module.call_mcp_mutation(fake_request, "board-001", fake_claims, "api_create_task", {})

    assert exc_info.value.status_code == 503
    assert "Task not found" in exc_info.value.detail
```

**Step 2: Run to confirm they fail**

```bash
cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py::test_call_mcp_mutation_returns_data_and_dispatches_events tests/test_api.py::test_call_mcp_mutation_raises_503_when_unavailable tests/test_api.py::test_call_mcp_mutation_raises_503_on_engine_failure -v
```
Expected: 3 failed (`AttributeError: module has no attribute 'call_mcp_mutation'`).

**Step 3: Implement call_mcp_mutation**

Add directly after `call_required_mcp_rows` (around line 1315) in `/root/tf-mcontrol/taskflow-api/app/main.py`:

```python
async def call_mcp_mutation(
    request: Request,
    board_id: str,
    claims: BoardAccessClaims,
    tool_name: str,
    args: Dict[str, Any],
) -> Dict[str, Any]:
    """Call a Node MCP mutation tool, dispatch notification events, return result data.

    The MCP tool must return { success: bool, data?: any, error?: str,
    notification_events?: NotificationEvent[] }. Raises HTTPException(503) on
    transport failure or engine-reported failure.
    """
    ensure_board_access_prechecked(board_id, claims)
    mcp_client = getattr(request.app.state, "mcp_client", None)
    if mcp_client is None or not mcp_client.is_alive():
        raise HTTPException(status_code=503, detail="TaskFlow MCP unavailable")
    try:
        result = await mcp_client.call(tool_name, args)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="TaskFlow MCP unavailable") from exc
    if not result.get("success"):
        error_msg = result.get("error") or "engine error"
        raise HTTPException(status_code=503, detail=f"TaskFlow MCP error: {error_msg}")
    notification_events = result.get("notification_events")
    if notification_events:
        try:
            with db_connection() as conn:
                dispatch_mcp_notification_events(conn, notification_events)
        except Exception as exc:
            logger.warning("dispatch_mcp_notification_events failed: %s", exc)
    return result.get("data") or {}
```

**Step 4: Run to confirm the tests pass**

```bash
cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py::test_call_mcp_mutation_returns_data_and_dispatches_events tests/test_api.py::test_call_mcp_mutation_raises_503_when_unavailable tests/test_api.py::test_call_mcp_mutation_raises_503_on_engine_failure -v
```
Expected: 3 passed.

**Step 5: Run full suite**

```bash
TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/test_api.py -x -q 2>&1 | tail -5
```
Expected: 0 failed.

**Step 6: Commit**

```bash
cd /root/tf-mcontrol && git add taskflow-api/app/main.py taskflow-api/tests/test_api.py && git commit -m "feat: add call_mcp_mutation helper for Phase 6 mutation delegation"
```

---

### Task 5: Wire and verify — run full suites

**Step 1: Run Python tests**

```bash
cd /root/tf-mcontrol/taskflow-api && TASKFLOW_DISABLE_MCP_SUBPROCESS=1 pytest tests/ -q 2>&1 | tail -5
```
Expected: 0 failed (all tests including actor resolution and new Phase 4 tests).

**Step 2: Run Node tests**

```bash
cd /root/nanoclaw/container/agent-runner && npx vitest run src/taskflow-mcp-server.test.ts 2>&1 | tail -10
```
Expected: all tests pass.

**Step 3: Update redesign doc current state**

In `/root/nanoclaw/docs/plans/2026-04-20-taskflow-api-channel-redesign.md`, update:
- "Phase 4 notification and event-invalidation unification" → mark complete in What is still not done
- Add Phase 4 completion bullet to Current State section
- Update Immediate Next Step to Phase 6 prerequisites checklist

**Step 4: Final commit**

```bash
cd /root/nanoclaw && git add docs/plans/2026-04-20-taskflow-api-channel-redesign.md && git commit -m "docs: mark Phase 4 complete in channel redesign"
```

---

## What this phase does NOT do

- Does not implement any mutation MCP tools (`api_create_task`, etc.) — that is Phase 6
- Does not migrate any mutation routes from Python to Node
- Does not change the SSE streaming architecture (polling loop stays)
- Does not route direct-message (JID-based) notifications through the API channel — those remain the Node IPC channel's responsibility
- Does not touch Phase 1 (wrapper extraction from `ipc-mcp-stdio.ts`)

## Prerequisites for Phase 6 (mutations)

After Phase 4, the following must be true before Phase 6 can begin:

- [ ] Actor resolution is deterministic (Phase 3 — ✅ done)
- [ ] `NotificationEvent` contract types are exported from Node (Phase 4 Task 2 — this phase)
- [ ] `dispatch_mcp_notification_events` is in Python (Phase 4 Task 3 — this phase)
- [ ] `call_mcp_mutation` helper is in Python (Phase 4 Task 4 — this phase)
- [ ] board_chat SSE invalidation is fixed (Phase 4 Task 1 — this phase)
- [ ] All existing test suite passes (0 failures) — this phase
