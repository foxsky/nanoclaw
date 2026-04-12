# Cross-Board Subtask Creation with Approval

**Date:** 2026-04-09
**Revised:** 2026-04-12 — added per-board `cross_board_subtask_mode` flag
**Status:** Design revised — flag-gated approach (Phase 1 + configurable Phase 2)

## Problem

When a project (e.g., P24) lives on a parent board (SEC) and is delegated to a child board (SECI) via `child_exec`, users on the child board believe they cannot create subtasks on it. The bot refuses with "P24 pertence ao quadro pai".

**However, code review revealed the engine already supports this.** The `add_subtask` action works on delegated tasks: `requireTask()` finds them via `child_exec`, permission passes for the assignee, `insertSubtaskRow` creates the subtask on the parent board with `board_id = parent_board_id`, and `linkedChildBoardFor` auto-delegates it back to the child board.

The refusal is not from the engine or CLAUDE.md templates — it's the LLM's own conservative inference. No code in the engine blocks `add_subtask` on delegated tasks (only `cancel_task` has an explicit cross-board guard at `taskflow-engine.ts:6163`).

## Design: Per-Board Flag

Instead of a binary Phase 1 (always open) vs Phase 2 (always require approval), a per-board flag lets the organization configure each board independently — some open, some gated, some blocked.

### Flag: `cross_board_subtask_mode`

Lives in `board_runtime_config` (parent board's row). Three values:

| Value | Behavior | When to use |
|---|---|---|
| `'open'` (default) | Child board can create subtasks directly on delegated projects. No approval needed. | Trust-based orgs, small teams, fast iteration. Matches Phase 1. |
| `'approval'` | Child board subtask creation is blocked by the engine; routed to an IPC-based approval flow where the parent board manager approves/rejects. | Governance-heavy orgs, regulated environments, large hierarchies. Matches Phase 2. |
| `'blocked'` | Child board subtask creation is blocked; no approval flow, just a refusal message directing the user to ask the parent board directly. | Strict top-down orgs where only the parent board creates project structure. |

**The flag is on the PARENT board** (the project owner), not the child board. The parent decides how its projects may be extended. A child board's bot reads the parent board's flag when the user tries to `add_subtask` on a delegated task.

### Schema migration

```sql
ALTER TABLE board_runtime_config ADD COLUMN cross_board_subtask_mode TEXT NOT NULL DEFAULT 'open';
```

Idempotent via the existing `try { ALTER ... } catch {}` pattern in the engine's DB init.

### Engine check (all modes)

In the `add_subtask` path, after `requireTask()` resolves a delegated task:

```
if (task.board_id !== this.boardId) {
  // Task is delegated — check the parent board's subtask mode
  const parentMode = db.prepare(
    `SELECT cross_board_subtask_mode FROM board_runtime_config WHERE board_id = ?`
  ).get(task.board_id)?.cross_board_subtask_mode ?? 'open';

  if (parentMode === 'blocked') {
    return { success: false, error: 'O quadro pai não permite criação de subtarefas por quadros filhos. Peça ao gestor do quadro pai para adicionar a subtarefa.' };
  }
  if (parentMode === 'approval') {
    // Route to the approval flow (see Phase 2 below)
    return this.requestParentSubtaskApproval(task, subtaskTitle, senderName);
  }
  // parentMode === 'open' → fall through to existing add_subtask logic
}
```

### Admin command to change the mode

```
"modo subtarefa cross-board: aberto" → taskflow_admin({ action: 'set_config', key: 'cross_board_subtask_mode', value: 'open' })
"modo subtarefa cross-board: aprovação" → taskflow_admin({ action: 'set_config', key: 'cross_board_subtask_mode', value: 'approval' })
"modo subtarefa cross-board: bloqueado" → taskflow_admin({ action: 'set_config', key: 'cross_board_subtask_mode', value: 'blocked' })
```

Manager-only. The template teaches the admin commands; the engine validates the value is one of the three allowed strings.

## Solution: Two Phases (unchanged, now flag-gated)

### Phase 1: Template fix + `'open'` mode (enables direct subtask creation)

Add explicit CLAUDE.md guidance telling the bot that `add_subtask` IS allowed on delegated tasks. The engine check above fires but falls through for `'open'` mode. Zero approval overhead.

1. Child board calls `add_subtask` on delegated task
2. Engine checks `cross_board_subtask_mode` on parent board → `'open'`
3. Engine creates subtask with `board_id = parent_board_id`
4. `linkedChildBoardFor` auto-delegates back to child board
5. Rollup and notifications flow via existing mechanisms

**Ship Phase 1 immediately.** Default flag value is `'open'`, so all existing boards get the current behavior (direct creation) without any configuration change.

### Phase 2: Approval workflow (activates on `'approval'` mode)

Only fires when the parent board's flag is set to `'approval'`. This is additive — boards that never set the flag continue with Phase 1 behavior.

---

## Phase 1: Template Changes + Engine Flag Check

### Engine: flag check in `add_subtask` path

Add the `cross_board_subtask_mode` check as shown in the Design section above. For Phase 1, the check fires but the default `'open'` value falls through to the existing logic. No behavior change for any board until a manager explicitly sets the flag to `'approval'` or `'blocked'`.

### Child board template (`add-taskflow/templates/CLAUDE.md.template`)

Add to subtask creation rules:

```
Delegated tasks (tasks where board_id ≠ this board, visible via child_exec):
- You CAN create subtasks on delegated tasks using taskflow_update add_subtask.
  The engine creates the subtask on the parent board and auto-delegates it back.
- You CAN assign subtasks to members of this board.
- You CANNOT cancel or delete delegated tasks (only the owning board can).
- For bulk operations ("copiar todas"), create each subtask individually.
- If the parent board has set `cross_board_subtask_mode = 'approval'`, the engine
  will return a pending-approval response instead of creating the subtask directly.
  Present the approval status to the user and explain it needs the parent board
  manager's approval.
- If the parent board has set `cross_board_subtask_mode = 'blocked'`, the engine
  will refuse. Explain that the parent board does not allow subtask creation from
  child boards and suggest asking the parent board manager directly.
```

### What this enables

Giovanni on SECI, with P24 delegated from SEC (default `'open'` mode):
```
Giovanni: "P24 adicionar subtarefa Elaborar plano XYZ"
Bot: "✅ P24.4 — Elaborar plano XYZ criada e delegada para este quadro."
```

No IPC, no approval, no waiting. The engine already does the right thing.

---

## Phase 2: Approval Workflow (activates on `cross_board_subtask_mode = 'approval'`)

Only fires when the parent board manager sets the flag to `'approval'`. Boards that keep the default `'open'` are unaffected.

### Prerequisite

**Already handled by the flag check in Phase 1.** When `cross_board_subtask_mode = 'approval'`, the engine's `add_subtask` path does NOT fall through — it routes to `requestParentSubtaskApproval()` instead. No separate engine guard needed; the same check serves both enforcement and routing.

### User Flow

```
Child Board (SECI)                       Parent Board (SEC)
─���────────────────                       ─────────────────
1. User: "P24 add subtask
   Elaborar plano XYZ"

2. Bot: "Solicitação enviada ao
   quadro SEC para aprovação."
                                         3. Bot: "Solicitação de subtarefa
                                            P24.4 — Elaborar plano XYZ
                                            Solicitado por: Giovanni (SECI)
                                            Aprovar / Rejeitar?"

                                         4. Manager: "Aprovar"

                                         5. Bot creates P24.4 on SEC,
                                            auto-delegates back to SECI

6. Bot: "P24.4 — Elaborar plano XYZ
   aprovada e delegada para este quadro."
```

### IPC Communication Model

Cross-board messaging uses `send_message` MCP tool with `target_chat_jid`. The container writes to its OWN `/workspace/ipc/messages/` directory with the target group's JID. The host-side watcher (`src/ipc.ts`) reads, authorizes via `isIpcMessageAuthorized`, and routes as a WhatsApp text message.

**Containers cannot write directly to other groups' IPC directories.** Each container only has its own IPC mount.

This means approval requests arrive as **WhatsApp text messages**, not structured JSON. The parent board agent must LLM-parse the request from formatted text and act on it.

### Request format (sent as text via `send_message`)

```
🔔 *Solicitação de subtarefa*

Quadro: SECI-SECTI
Tarefa pai: P24 — Agência INOVATHE
Subtarefa proposta: "Elaborar plano XYZ"
Responsável: Giovanni
Prazo: 15/04/2026
Solicitado por: Carlos Giovanni
ID: req-1744200000-a3f2

Para aprovar, responda com: @Case aprovar req-1744200000-a3f2
Para rejeitar: @Case rejeitar req-1744200000-a3f2 [motivo]
```

### Persistence requirement

A `subtask_requests` table is needed in the TaskFlow DB to survive agent restarts:

```sql
CREATE TABLE IF NOT EXISTS subtask_requests (
  request_id TEXT PRIMARY KEY,
  source_board_id TEXT NOT NULL,
  target_board_id TEXT NOT NULL,
  parent_task_id TEXT NOT NULL,
  subtasks_json TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by TEXT,
  resolved_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

### `merge_project` admin action (ships with Phase 1)

Merges a LOCAL duplicate project into a DELEGATED (or any other target) project. The subtasks are UPDATE'd in place — no content copying, no zombie rows.

**Call shape:**
```
taskflow_admin({
  action: 'merge_project',
  source_project_id: 'P5',     // local duplicate → will be archived
  target_project_id: 'P24',    // delegated project → receives subtasks
  sender_name: SENDER
})
```

**Manager-only.** Both projects must be visible from the current board (source is local, target is local or delegated via child_exec).

**Algorithm (validated by subagent review 2026-04-12, zero blockers):**

The entire operation runs inside `db.transaction()` for atomicity.

1. **Resolve both projects.** `requireTask(source)` and `requireTask(target)`. Target must be `type='project'`. Source must be `type='project'`. Fail if either doesn't exist or isn't a project.

2. **Compute new subtask IDs.** Read the target project's existing subtasks via `getSubtaskRows()`, take `max(N) + 1` for the next subtask number (same pattern as `insertSubtaskRow` at taskflow-engine.ts ~L3961). This avoids ID collisions.

3. **For each source subtask, UPDATE in place:**
   ```sql
   UPDATE tasks
   SET board_id = :target_board_id,
       id = :new_subtask_id,           -- e.g., P24.5
       parent_task_id = :target_project_id,
       child_exec_enabled = :ce_enabled,
       child_exec_board_id = :ce_board,
       child_exec_person_id = :ce_person,
       updated_at = :now
   WHERE board_id = :source_board_id AND id = :old_subtask_id;
   ```
   - `child_exec` fields computed via `linkedChildBoardFor(target_board_id, assignee)` — must be set explicitly because `linkedChildBoardFor` only fires on INSERT, not UPDATE.
   - **Pre-existence check:** verify the target (board_id, new_subtask_id) doesn't already exist before the UPDATE.

4. **Rekey task_history:**
   ```sql
   UPDATE task_history SET board_id = :target_board_id, task_id = :new_subtask_id
   WHERE board_id = :source_board_id AND task_id = :old_subtask_id;
   ```
   Safe — `task_history.id` is AUTOINCREMENT, unaffected by the board_id/task_id change.

5. **Rekey blocked_by references.** Scan the board's tasks for `blocked_by LIKE '%"P5.1"%'`, parse the JSON array, replace old ID → new ID, re-serialize. O(N) but acceptable for typical board sizes.

6. **Add migration notes** (so there's a trail of what happened):
   - On each migrated subtask: _"Migrada de P5.2 (projeto P5 mesclado em P24)"_
   - On the target project: _"Projeto P5 mesclado — subtarefas migradas: P5.1→P24.5, P5.2→P24.6, P5.3→P24.7"_
   - On the source project (before archiving): _"Projeto mesclado em P24 — todas as subtarefas migradas"_

7. **Merge project-level notes.** Any notes on the source project (not on subtasks) are appended to the target project's notes array with a `[de P5]` prefix so the target project retains the context.

8. **Archive the empty source project shell** with `archive_reason: 'merged'` and full snapshot. **MUST happen AFTER subtask migration** — if done before, the archive snapshot would include the subtask rows and the DELETE would remove them.

9. **Return result:**
   ```json
   {
     "success": true,
     "merged": { "P5.1": "P24.5", "P5.2": "P24.6", "P5.3": "P24.7" },
     "source_archived": "P5",
     "notes_added": 5
   }
   ```

**Same-board merge also works.** If source and target are on the same board (two local projects, no cross-board involved), only `id` and `parent_task_id` change — `board_id` stays the same. The algorithm is identical.

**Template guidance for the bot:**
```
"mesclar P5 em P24" / "juntar P5 com P24" →
  taskflow_admin({ action: 'merge_project', source_project_id: 'P5',
                   target_project_id: 'P24', sender_name: SENDER })
```

The bot should confirm the mapping to the user:
```
✅ *Projeto P5 mesclado em P24*
━━━━━━━━━━━━━━

Subtarefas migradas:
• P5.1 → P24.5 — Elaborar plano XYZ
• P5.2 → P24.6 — Revisar documento ABC
• P5.3 → P24.7 — Agendar reunião DEF

Projeto P5 arquivado. Notas do P5 copiadas para P24.
```

### Engine changes (Phase 2 only)

1. **New guard on `add_subtask`**: Reject when `task.board_id !== this.boardId` and task is delegated. Return error message guiding the user to the approval flow.

2. **New action: `request_parent_subtask`** (child board): Validates task is delegated, inserts into `subtask_requests`, sends formatted text to parent board via `send_message`.

3. **New action: `handle_subtask_approval`** (parent board): Reads `request_id` from manager response, looks up in `subtask_requests`, calls `add_subtask` on approve, updates status.

### Multi-level relay (3+ levels)

When a middle board (level 1) receives an approval request for a task it doesn't own (`task.board_id ≠ this.boardId`), it relays upward to its `parent_board_id` via `send_message`. The request text passes through as-is. Response flows back down the same chain.

Start with 2-level support. Extend to 3+ levels as follow-up if the hierarchy requires it.

### Error handling

| Case | Behavior |
|---|---|
| Parent board agent offline | Text message sits in WhatsApp group, processed when agent spawns |
| Manager never responds | Request stays `pending` in `subtask_requests` — no timeout |
| Task un-delegated before approval | `handle_subtask_approval` checks `child_exec` still active; rejects if not |
| Duplicate request | `request_id` dedup via `subtask_requests` table |
| Bulk "copiar todas" | Single request with array in `subtasks_json`, single approval prompt |
| Agent restart | Pending requests survive in `subtask_requests`; agent can query status |

---

## What This Does NOT Change

- Existing same-board subtask creation (unchanged)
- Existing `child_exec` delegation mechanism (unchanged)
- Existing `linked_parent_*` tagging (unchanged)
- Existing rollup mechanism (unchanged)
- Tasks table composite PK architecture (unchanged — `merge_project` uses UPDATE on the PK, not schema changes)

## Implementation Priority

**Phase 1 is the immediate fix.** Template change + engine flag-check scaffolding. Unblocks Giovanni today. Default flag value `'open'` means zero behavior change for existing boards. Ship as part of the next deploy.

- Template: add the delegated-subtask guidance + mode-aware error handling
- Engine: add `cross_board_subtask_mode` column to `board_runtime_config` (idempotent `ALTER TABLE`), add the flag check in the `add_subtask` code path
- Tests: cover `'open'` (fall-through), `'blocked'` (refuse), and `'approval'` (route to approval or stub error until Phase 2 ships)

**Phase 2 is deferred** until a board manager sets `cross_board_subtask_mode = 'approval'`. The engine changes, persistence table (`subtask_requests`), and IPC routing make it a multi-day effort — but the flag means it can ship incrementally without forcing governance on boards that don't want it.

**Rollout strategy:** Ship Phase 1, let all boards default to `'open'`. If a specific board needs governance, the manager runs `"modo subtarefa cross-board: aprovação"` and that board switches to the approval flow. No redeployment needed — just an admin command.
