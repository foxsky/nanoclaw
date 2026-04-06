# E2E Live Test Protocol

Reusable test suite for validating NanoClaw TaskFlow on production after deploys. Tests run via one-shot `scheduled_tasks` rows against `secti-taskflow` (the QA board).

## Prerequisites

- Service running on remote (`systemctl --user status nanoclaw`)
- WhatsApp connected (check logs for `Connected to WhatsApp`)
- `secti-taskflow` registered with `requires_trigger=0`
- Board `board-secti-taskflow` exists and is empty (or has known baseline state)

## Test target

| Field | Value |
|-------|-------|
| group_folder | `secti-taskflow` |
| chat_jid | `120363407145013007@g.us` |
| board_id | `board-secti-taskflow` |
| schedule_type | `once` |
| context_mode | `group` |

## Inserting a test

```sql
INSERT INTO scheduled_tasks (
  id, group_folder, chat_jid, prompt,
  schedule_type, schedule_value,
  next_run, last_run, last_result,
  status, created_at, context_mode, script
) VALUES (
  '<test-id>',
  'secti-taskflow',
  '120363407145013007@g.us',
  '<prompt>',
  'once', '',
  '<ISO 8601 UTC, a few seconds in the past>', NULL, NULL,
  'active', '<now ISO 8601 UTC>', 'group', NULL
);
```

## Polling for completion

```bash
sqlite3 store/messages.db "SELECT status, last_run, substr(last_result, 1, 200) FROM scheduled_tasks WHERE id='<test-id>';"
```

Scheduler poll interval: 60s. Expect pickup within ~75s. Container execution adds 20–90s depending on LLM response length.

## Cleanup

Always delete after verification:
```sql
DELETE FROM scheduled_tasks WHERE id='<test-id>';
```

---

## Test Suite

### T1 — Auth + Read Empty Board

**Purpose:** Validates auth (credential proxy placeholder exchange), SDK initialization, MCP connection, and the read path against an empty board.

**Prompt constraints:**
- Call `taskflow_query` with `query="board"` on `board-secti-taskflow`
- Report the task count
- No writes, no WhatsApp messages, no file changes
- End with marker `E2E-T1-COMPLETE`

**Verification:**
- `last_result` contains marker and reports 0 tasks
- Container log shows `Exit Code: 0`
- Container args include `-e CLAUDE_CODE_OAUTH_TOKEN=placeholder` (or `ANTHROPIC_API_KEY=placeholder`)
- Session initialized (check for `Session initialized:` in stderr)
- `taskflow.db` row counts unchanged

**Catches:** Auth failures (placeholder not set, proxy not running, token expired), MCP server connectivity, board schema issues.

---

### T2 — Read Non-Empty Board

**Purpose:** Validates the agent correctly parses and counts tasks from a board with real data, including hierarchical child_exec delegations.

**Target board:** `anali-sist-secti-taskflow` (1 direct task + 4 child_exec from parent).

**Prompt constraints:**
- Call `taskflow_query` with `query="board"`
- Report exact task count and task titles
- No writes, no WhatsApp messages, no file changes
- End with marker `E2E-T2-COMPLETE`

**Verification:**
- Agent reports correct count (cross-check with SQL):
  ```sql
  SELECT COUNT(*) FROM tasks
  WHERE board_id='board-anali-sist-secti-taskflow'
     OR child_exec_board_id='board-anali-sist-secti-taskflow';
  ```
- Task titles match direct SQL query
- `taskflow.db` row counts unchanged

**Catches:** Broken board query, child_exec delegation not surfacing, task data corruption.

---

### T3 — Write Round-Trip (Create → Read → Delete)

**Purpose:** Validates the full CRUD path — task creation, read-back, and hard delete. Specifically regression-tests the `task_comments` FK bug (fixed 2026-04-05).

**Prompt constraints:**
- Create task with title exactly `[E2E-T3-TEST] delete me` in inbox
- Read back to confirm
- Delete via `cancel_task` — **must hard-delete, not conclude**. If cancel_task fails, include `DELETE-FAILED` in output
- Read again to confirm board is empty
- Report all step results
- Only `board-secti-taskflow`, no WhatsApp messages, no file changes
- End with marker `E2E-T3-COMPLETE`

**Verification:**
- All 5 steps succeeded (create, read, delete, final read, report)
- Output does NOT contain `DELETE-FAILED`
- Direct SQL confirms no stragglers:
  ```sql
  SELECT COUNT(*) FROM tasks WHERE board_id='board-secti-taskflow';
  SELECT COUNT(*) FROM tasks WHERE title LIKE '%E2E-T3%';
  ```

**Catches:** FK constraint regressions, broken MCP write tools, task ID counter issues, permission model bugs (cancel_task requires board manager identity).

---

### T4 — Person Tasks Parent Title (Hallucination Regression)

**Purpose:** Validates that `taskflow_query person_tasks` returns `parent_title` for subtasks, preventing the agent from hallucinating project names.

**Target:** Query Wanderlan's tasks on `seci-taskflow` (has P16.3 with `parent_task_id=P16`).

**Prompt constraints:**
- Call `taskflow_query` with `query="person_tasks"` and `person_name="wanderlan"`
- For each returned task that has a `parent_task_id`, report: the `parent_task_id`, the `parent_title` field value (or "MISSING" if the field is absent)
- Do NOT fabricate or guess parent titles — only report what the tool returned
- No writes, no WhatsApp messages, no file changes
- End with marker `E2E-T4-COMPLETE`

**Verification:**
- Output includes `parent_title` for P16.3 (should be "Dados Abertos e Internos")
- Output does NOT contain "Spia Patrimonial" or any fabricated title
- Cross-check with SQL:
  ```sql
  SELECT t.id, t.parent_task_id, pt.title AS expected_parent_title
  FROM tasks t
  LEFT JOIN tasks pt ON pt.board_id = t.board_id AND pt.id = t.parent_task_id
  WHERE t.assignee = 'wanderlan'
    AND (t.board_id = 'board-seci-taskflow'
         OR (t.child_exec_board_id = 'board-seci-taskflow' AND t.child_exec_enabled = 1));
  ```

**Catches:** Missing parent_title JOIN in getTasksByAssignee, LLM hallucination of project names, person_tasks query regressions.

**Note:** This test must run on `seci-taskflow` (not `secti-taskflow`) because Wanderlan's tasks are on that board. Use:
- group_folder: `seci-taskflow`
- chat_jid: `120363406395935726@g.us`

---

### T5 — Scheduled Script Path (No LLM)

**Purpose:** Validates the container spawn + script execution path without invoking the LLM. Tests that the `wakeAgent=false` code path works.

**Prompt:** Any (won't be used if script returns `wakeAgent: false`)

**Script field:** A JS snippet that reads the board and returns data without waking the agent:
```
const db = require('better-sqlite3')('/workspace/taskflow/taskflow.db');
const count = db.prepare('SELECT COUNT(*) as n FROM tasks WHERE board_id = ?').get('board-secti-taskflow');
db.close();
JSON.stringify({ wakeAgent: false, data: { taskCount: count.n } });
```

**Verification:**
- Container log shows `Script decided not to wake agent: wakeAgent=false`
- Container exits with code 0
- No SDK session created (no `Session initialized:` in stderr)

**Catches:** Script execution regressions, better-sqlite3 availability inside container, taskflow.db mount accessibility.

---

## Running the Full Suite

After a deploy, run tests in order: T1 → T2 → T3 → T4. Each takes ~75–120s (60s scheduler poll + 15–60s execution). Total: ~6–8 minutes for the full suite.

T5 is optional (tests a different code path not affected by most changes).

If T1 fails (auth), skip T2–T4 (all will fail the same way). Fix auth first.

If T3 reports `DELETE-FAILED`, check if `task_comments` table has reappeared (e.g., from a backup restore or an agent re-creating it). Run:
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name='task_comments';
```

## Baseline Capture

Before running tests, capture row counts for diff:
```sql
-- taskflow.db
SELECT 'tasks' AS t, COUNT(*) AS n FROM tasks
UNION ALL SELECT 'task_history', COUNT(*) FROM task_history
UNION ALL SELECT 'board_chat', COUNT(*) FROM board_chat;

-- store/messages.db
SELECT 'scheduled_tasks' AS t, COUNT(*) AS n FROM scheduled_tasks
UNION ALL SELECT 'messages', COUNT(*) FROM messages;
```

After tests, re-run and verify counts match (T3 may temporarily +1/−1 tasks during execution but should return to baseline after delete).
