# Cross-Board Subtask Creation with Approval

**Date:** 2026-04-09
**Status:** Design revised after code review — two-phase approach

## Problem

When a project (e.g., P24) lives on a parent board (SEC) and is delegated to a child board (SECI) via `child_exec`, users on the child board believe they cannot create subtasks on it. The bot refuses with "P24 pertence ao quadro pai".

**However, code review revealed the engine already supports this.** The `add_subtask` action works on delegated tasks: `requireTask()` finds them via `child_exec`, permission passes for the assignee, `insertSubtaskRow` creates the subtask on the parent board with `board_id = parent_board_id`, and `linkedChildBoardFor` auto-delegates it back to the child board.

The refusal is not from the engine or CLAUDE.md templates — it's the LLM's own conservative inference. No code in the engine blocks `add_subtask` on delegated tasks (only `cancel_task` has an explicit cross-board guard at `taskflow-engine.ts:6163`).

## Solution: Two Phases

### Phase 1: Template fix (enables direct subtask creation)

Add explicit CLAUDE.md guidance telling the bot that `add_subtask` IS allowed on delegated tasks. Zero engine changes. The existing code path handles everything correctly:

1. Child board calls `add_subtask` on delegated task
2. Engine creates subtask with `board_id = parent_board_id`
3. `linkedChildBoardFor` auto-delegates back to child board
4. Rollup and notifications flow via existing mechanisms

### Phase 2: Optional approval workflow (governance)

If the organization requires that parent board managers approve new subtasks created by child boards, add an IPC-based approval flow. This is additive — Phase 1 works without it.

---

## Phase 1: Template Changes

### Child board template (`add-taskflow/templates/CLAUDE.md.template`)

Add to subtask creation rules:

```
Delegated tasks (tasks where board_id ≠ this board, visible via child_exec):
- You CAN create subtasks on delegated tasks using taskflow_update add_subtask.
  The engine creates the subtask on the parent board and auto-delegates it back.
- You CAN assign subtasks to members of this board.
- You CANNOT cancel or delete delegated tasks (only the owning board can).
- For bulk operations ("copiar todas"), create each subtask individually.
```

### What this enables

Giovanni on SECI, with P24 delegated from SEC:
```
Giovanni: "P24 adicionar subtarefa Elaborar plano XYZ"
Bot: "✅ P24.4 — Elaborar plano XYZ criada e delegada para este quadro."
```

No IPC, no approval, no waiting. The engine already does the right thing.

---

## Phase 2: Approval Workflow (if governance required)

Only implement if the organization decides child boards should NOT unilaterally create subtasks on parent board projects.

### Prerequisite

Add an engine guard to `add_subtask` that blocks child boards from creating subtasks on delegated tasks directly. Without this guard, Phase 2 has no enforcement — the bot could bypass the approval by calling `add_subtask` directly.

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
- Tasks table composite PK architecture (unchanged)

## Implementation Priority

**Phase 1 is the immediate fix.** Template-only change, no code, unblocks Giovanni today. Ship as part of the next CLAUDE.md template regeneration.

**Phase 2 is deferred** until the organization explicitly requires approval governance for cross-board subtask creation. The engine changes, persistence table, and IPC routing make it a multi-day effort.
