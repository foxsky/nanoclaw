# Cross-Board Mutation Forwarding Design Spec

**Date:** 2026-04-27
**Status:** Design — not yet planned for implementation
**Source:** Audit findings 2026-04-22 to 2026-04-26 — recurring "child board user wants to act on parent / sibling-delegated task" refusal pattern

## Problem

Child-board users repeatedly ask the bot to mutate tasks that **don't live on their board** and **aren't delegated to them**. The engine refuses correctly (`task X not found on this board`) but the user has no actionable next step — they retry 3+ times with variations until they give up or someone manually escalates.

Concrete cases from the 2026-04-22..26 audit window:

1. **Lucas Batista** in `asse-seci-taskflow` (`board-asse-seci-taskflow`) tried 3+ times across 23/04 and 24/04 to `add_subtask` to **P11**. P11 lives on `board-seci-taskflow` (parent SECI) and IS delegated via `child_exec` — but to **a sibling**, `board-asse-seci-taskflow-3`, not to Lucas's board. So from Lucas's engine view, P11 is "not visible." Bot refused: _"P11 pertence ao quadro pai"_.

2. **Lucas Batista** asked _"P11.11 atribuir de Lucas para Rodrigo Lima"_. P11.11 is delegated to `board-asse-seci-taskflow` (his board). The reassign action involves changing assignee on a parent-board task; the engine has no API for cross-board reassign and refused.

3. **João Antonio** in `board-est-secti-taskflow-3` declared _"p6.1 foi concluida e a p6.7 tbm e a T2 tbm"_. T2 was on his board and concluded correctly. P6.1 and P6.7 are subtasks of project P6 on `board-seci-taskflow` (parent SECI), both currently in `review` (need manager approval). Bot did NOT process the cross-board ones — they require parent-board action.

The pattern is: **the user's intent is clear, the target task is identifiable on a related board, but the engine refuses because the task is not local-or-delegated.** No structured forwarding path exists.

## Existing capabilities

- **`cross_board_subtask_mode`** (shipped 2026-04-12, Phase 1+2): per-parent-board flag (`open` / `blocked` / `approval`). When a child board calls `add_subtask` on a **delegated** parent task, the parent's mode controls behavior. The `subtask_requests` table + `handle_subtask_approval` action already implement the approval state machine. **Does NOT cover non-delegated tasks** (case 1) and **does NOT cover any mutation other than `add_subtask`** (cases 2 and 3).

- **`send_message`** MCP tool: lets a TaskFlow board's bot post a structured message into another registered group. Already used for cross-group notifications (reassignment alerts, child-board provisioning). No persistent log table yet.

- **`board_runtime_config`**: per-board K/V store (already extended for `cross_board_subtask_mode`, `welcome_sent`, runner IDs).

- **`boards.parent_board_id`**: every child board knows its parent. The chain can be walked via `getBoardLineage()` (capped at 10 levels).

- **`board_admins` / `board_people`**: track who can act on each board. A child-board user is generally NOT an admin of the parent — the cross-board ask requires the parent's admin to actually execute.

## Goal

Give child-board users an actionable path when they want to mutate a non-local, non-delegated task that exists on a related board (parent, sibling-via-parent, or any board they have visibility into).

**Non-goals:**
- Cross-org or cross-tenant mutations
- Bypassing the parent board's authorization (a child-board user must NEVER be able to silently mutate the parent)
- Replacing the existing `cross_board_subtask_mode` (which handles the delegated-task case correctly)

## Design — two complementary primitives

### Primitive 1: **Notification-push (forward)** — Phase 1

When the child-board agent detects an intent to mutate a non-local task, instead of refusing flatly, it:
1. Identifies the target board by walking `parent_board_id` and asking the auditor's name resolver / `boards.short_code` registry (`P11` → `board-seci-taskflow`).
2. Composes a structured message: _"@gestor — Lucas Batista (de ASSE-SECI/SECTI) pediu para adicionar uma subtarefa em P11: Solicitação de manifestação da SEMF…"_
3. Calls `send_message(target_chat_jid=parent.group_jid, text=…)` to post the request into the parent board's WhatsApp group.
4. Replies to Lucas: _"✉️ Pedido encaminhado ao quadro SECI. O gestor decide lá."_

The parent-board admin sees the request in their own group, decides to act (or not) using their existing TaskFlow tools. No state machine on either side. No new DB schema. It is a polished form of "go ask them yourself" — but the bot does the asking, and the user gets actionable feedback.

**Why this is enough for most cases.** Audit data over 30 days shows refusal volume is small (~1 distinct group hit "pertence ao" recently). The friction cost of approval workflows would dwarf the benefit. The notification-push route is light and reversible.

### Primitive 2: **Approval-pull** — Phase 2 (only if needed)

For mutations the parent board wants to track formally (audit requirements, governance), generalize the existing `subtask_requests` infrastructure into `mutation_requests`. Each row carries:

| Column | Notes |
|---|---|
| `id` | UUID |
| `source_board_id` | child board that asked |
| `target_board_id` | parent board with the task |
| `target_task_id` | the task to mutate |
| `mutation_type` | enum: `add_subtask` (existing), `move`, `reassign`, `update`, `cancel` |
| `proposed_changes` | JSON blob, type-specific |
| `requested_by` | person_id of the asker |
| `status` | `pending` / `approved` / `rejected` / `applied` / `failed` |
| `created_at`, `decided_at`, `applied_at` | timestamps |
| `decided_by`, `decision_note` | who approved/rejected |

A new `cross_board_mutation_mode` flag on the parent board's `board_runtime_config` controls behavior: `forward` (default — Primitive 1), `approval` (Primitive 2 routes here), `blocked` (refuse with no offer).

The `handle_mutation_approval(request_id, decision, decision_note?)` action mirrors `handle_subtask_approval`, dispatched per `mutation_type`. The existing subtask code can either be migrated into this generic table or left alone — **DO NOT migrate prematurely**. Run them side-by-side until the new code has bedded in.

## Proposed phasing

| Phase | Scope | Effort | Risk |
|---|---|---|---|
| **0** (clarify) | Decide which mutation types to support in Primitive 1's forward intent. Recommendation: `add_subtask`, `move (conclude/wait/review)`, `reassign`, `update (note/deadline)`. **Ask user.** | discussion | none |
| **1a** | CLAUDE.md template guidance: when bot detects cross-board intent → call `send_message` with a structured "request" template instead of refusing. Update `Command -> Tool Mapping` table with explicit examples. | 1-2 days | low — pure prompt-side, easy to roll back |
| **1b** | `board_runtime_config.cross_board_mutation_mode` column with default `forward`. Engine reads it on cross-board refusal sites and returns a structured `forwarded` result instead of `not_found`. Bot uses this to compose the forward message. | 2-3 days | medium — touches engine error paths |
| **2** | `mutation_requests` table + `cross_board_mutation_mode='approval'` mode + `handle_mutation_approval` action. **Defer until volume justifies it.** Track refusal count over 30 days post-Phase-1; ship Phase 2 only if `forward` proves insufficient (e.g., users abuse it, or governance requirements emerge). | 1 week | higher — DB schema, state machine, edge cases |

## Open questions for the user

1. **Mutation scope for Phase 1.** The audit shows three patterns: `add_subtask` on non-delegated parent, `move/conclude` on sibling-delegated, `reassign` cross-board. Do all three deserve forward-mode handling in Phase 1, or only `add_subtask` (the most common)? The richer the coverage, the more prompt complexity in CLAUDE.md.

2. **Identity disclosure in the forward message.** The current refusal does not name the asker. The forward message would explicitly include _"Lucas Batista (de ASSE-SECI/SECTI) pediu…"_. This is a deliberate identity surface. Confirm acceptable.

3. **Forward fan-out.** If `P11` is delegated to **multiple** child boards, the forward target should be the **parent** (where the project actually lives), not other delegate siblings. Confirm.

4. **Should Phase 1b's engine-side change be skipped entirely?** The minimum implementation for Primitive 1 is **prompt-only** — the agent already knows about parent boards from CLAUDE.md, and `send_message` already exists. The engine doesn't strictly need to participate. Trade-off: prompt-only is faster and lower-risk, but harder to enforce consistently across rapid-fire turns and across SDK retries. Engine-side gives a structured `forwarded` return value the bot can rely on.

5. **Approval-pull (Phase 2): worth designing now, or YAGNI until evidence?** I lean YAGNI — the audit volume doesn't justify governance overhead. Confirm.

6. **Auditor implications.** Forwarded mutations should NOT be flagged as `unfulfilledWrite` since the bot's structured forward IS a meaningful response. Either (a) record forwards in `send_message_log` so the existing `crossGroupSendLogged` signal catches them, or (b) add a new `mutationForwarded` signal. Option (a) is simpler.

## Recommendation

Phase 0 + Phase 1a, possibly skipping Phase 1b if the prompt-only approach proves reliable. Defer Phase 2.

Total effort if Phase 1 only: **~1-2 days** (template guidance + a few CLAUDE.md sections + a regression test that mocks `send_message` to assert forward shape). If 1b is added: **~3-5 days**.

The original "1 week" estimate (from the investigator's report) included Phase 2's full approval workflow. Without it, the work is substantially smaller.

## Decision checkpoint

Per `superpowers:brainstorming`, this spec is the **discussion artifact**. Before writing an implementation plan I need user answers to questions 1–6 above. Once decisions land, the writing-plans phase will produce the actual TDD task breakdown.

## Related specs

- `docs/superpowers/specs/2026-04-09-cross-board-subtask-approval-design.md` — the precedent
- `docs/plans/` (forthcoming) — implementation plan, after this spec is approved
