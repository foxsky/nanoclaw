# #396 — deferred_notification offline re-queue: grounded design spec

**Status:** design locked, NOT built. Dedicated build session. Author: nanoclaw engine agent, 2026-06-04, all claims source-verified on branch `skill/taskflow-v2`.

## Scope correction (read first — the task title oversells it)

`deferred_notification` (a notification with `target_person_id` but null JID) fires in exactly TWO situations:

1. **Cross-board provisioning window (the ONLY case #396 fixes).** A person registered on a parent board, assigned a task *before* their child board finishes provisioning. Their parent `board_people.notification_group_jid` is transiently null until `provision-child-board` sets it (`src/modules/taskflow/provision-child-board.ts:205,287`). V1 re-queued (5-min TTL) and delivered once the JID resolved.
2. **Same-group assignees (NOT a regression — do NOT "fix").** `notification_group_jid` is left null *by design* when the target group equals the board's own group (`provision-child-board.ts:201-203` — "Skip when target equals parent group; otherwise … double-deliver to the same chat"). These people see the task in their own board group; a separate cross-chat notification is redundant. In V1 these re-queued, never resolved, and dropped at the 5-min TTL. V2 host-skips them immediately. **Same outcome — not a parity gap.** #396 must NOT start delivering these (it would double-notify).

⇒ #396 = "deliver a cross-board assignee's notification once their child board provisions, if within 5 min." Severity is MEDIUM (bounded race), not HIGH. If a deployment always provisions boards before assigning, #396 is deferrable past cutover.

## Hard constraints (verified)

- **Re-resolution MUST be container-side.** Codex#3 (`src/modules/taskflow/taskflow-notify.ts:9-23`): the host does ZERO taskflow.db routing reads; the engine resolves person→`notification_group_jid` in-subprocess and hands the host a resolved JID. So the host cannot re-resolve a deferred notification — only the engine can.
- **At-most-once.** Project rule: best-effort, no retry → no duplicate. Delete the queued row the instant a delivery is emitted; the delete and the emit must be inside one engine transaction so a wake that re-runs cannot double-emit (cf. the poll-loop boundary-leak feedback: prove no double-send in BOTH the emit-success AND the error/no-result paths).
- **Liveness (the #397 residual).** A queued notification whose task was deleted must be dropped, not delivered. Check task existence at drain time.

## Design — event-driven flush (preferred over the polling sweep)

The re-delivery moment is precisely when `provision-child-board` sets the JID. Drive the flush off that event, not a timer.

**Table** (engine-owned, in the board's `taskflow.db`, created in `ensureTaskSchema`):
```
pending_notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id     TEXT NOT NULL,      -- board whose engine resolves the JID (the PARENT board)
  target_person_id TEXT NOT NULL,  -- who to deliver to once their JID resolves
  task_id      TEXT,               -- for liveness: drop if the task is gone
  message      TEXT NOT NULL,      -- exact V1-faithful replay text
  created_at   TEXT NOT NULL       -- TTL anchor; DEFERRED_NOTIFICATION_TTL_MS = 5*60*1000
)
```

**Units (each TDD, RED→GREEN, Codex per unit):**

1. **Queue accessor** (container, `container/agent-runner/src/...`): `enqueuePendingNotification`, `drainDeliverablePendingNotifications(boardId, now)` (returns rows whose person now has a non-null JID AND task is live AND `now - created_at <= TTL`; deletes the returned rows + the expired ones in one tx; leaves still-unresolved-within-TTL rows). Pure-ish, fully unit-testable on an in-memory `taskflow.db`.
2. **Enqueue on defer** (container, `taskflow-notify-dispatch.ts` / the engine): when a `deferred_notification` is produced for the provisioning-window case, persist it. MUST exclude the same-group case (case 2 above) — only enqueue when the person has a child-board registration but no JID yet, else the queue fills with rows that never resolve. (Decision point: gate on `child_board_registrations` existence.)
3. **Provisioning → wake** (host, `provision-child-board.ts`): after setting `notification_group_jid`, write an `on_wake` `messages_in` row to the PARENT board's container so a fresh engine run drains the queue. Reuse the existing `on_wake` primitive (`container/agent-runner/src/db/messages-in.ts`) + `src/host-sweep.ts` scheduling precedent. Host writes taskflow.db here already (it sets the JID) — this is a WRITE + a wake, NOT a routing read, so Codex#3 holds.
4. **Drain on wake** (container, poll-loop): on the provisioning wake, call the accessor, emit one `direct_message` per deliverable row via `dispatchNotificationEvents`, inside the same tx that deletes the rows.
5. **TTL safety net** (optional): if a board never re-wakes, expired rows linger. A coarse drain on the board's next normal wake (or the existing standup/digest runner) clears them. Don't add a dedicated timer unless a deployment needs it.

**Do NOT** build a per-board polling sweep (the original workflow plan) — waking a container every 30-60s per board is far heavier than V1's filesystem poll and is unnecessary given the provisioning event is the real trigger.

## Open questions for the build session

- Confirm `child_board_registrations` (or equivalent) is the right gate to distinguish case-1 (enqueue) from case-2 (skip) at enqueue time.
- Confirm the PARENT board's container is the right wake target (it owns the task + resolves the person's JID post-provision).
- Decide whether to also flush on the person's FIRST inbound DM (a second natural "JID became known" trigger) or leave that to #396-v2.
