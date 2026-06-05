# #396 — deferred_notification offline re-queue: grounded design spec

**Status:** FUNCTIONAL — units 1, 2, 4 shipped (TDD + Codex-reviewed); unit 3 deferred. Author: nanoclaw engine agent, 2026-06-04, all claims source-verified on branch `skill/taskflow-v2`.

## BUILD STATUS (2026-06-04)

| Unit | What | Status |
|------|------|--------|
| 1 | `pending_notifications` table + `drainDeliverablePendingNotifications` (at-most-once delete-in-tx, 5-min TTL, liveness) — `container/agent-runner/src/db/pending-notifications.ts` | ✅ shipped (904ae268) |
| 2 | enqueue (child-board gate) wired into `finalizeCreatedTaskResult` (create path) | ✅ shipped + hardened (Codex: enqueue-before-dispatch, fail-soft) |
| 4 | `drainAndDispatchPendingNotifications` at the poll-loop turn boundary — delivers once the assignee's board provisions | ✅ shipped |
| 5 | enqueue on the mutation path (`finalizeMutationResult` — reassign/move/admin/update/note) + shared `enqueueDeferredNotificationsInSession` (in-session-only gate, fail-soft) | ✅ shipped (dbae7f26) |
| 3 | drain on the IDLE poll path too — a running-but-idle parent delivers within ~1s of provisioning (V1's 1s poll cadence), container-side | ✅ shipped (e3a27c74) |

**Functional** on BOTH create and reassign/move, across active turns AND running-idle polls. Active boards drain at the turn boundary; a running-but-idle parent drains every `POLL_INTERVAL_MS` (1000ms) — exactly V1's 1s host-poll cadence — so a deferred delivers within ~1s of the child board provisioning. Mutation-path enqueue stores `task_id = null` (the reassign result doesn't surface it to the finalizer → liveness skipped there; create tracks `task_id`).

**Why no host silent-wake (the originally-planned unit 3).** The poll loop filters `system` messages (`poll-loop.ts:3922`) and a zero-length batch never reaches the turn boundary (`:3934`), so a gated/system wake never triggers the drain, and any drain-triggering wake would invoke the agent (spurious output). The idle-poll drain achieves the same idle delivery container-side without that problem.

**Remaining edge — a TORN-DOWN idle container** (narrower than V1's own TTL-drop; tracked as a separate optional task). If the parent container is killed for staleness right after register+assign, no poll loop runs, so the idle-poll drain can't fire; the deferred waits for the container to respawn (next message) and expires at the 5-min TTL if none arrives. V1 had no per-board containers (one always-on process), so this is a V2-architecture artifact. Closing it needs a HOST respawn-wake: after `provision-child-board` sets the JID (`provision-child-board.ts:205,287`), resolve the parent session and write a wake to its `messages_in` — but that wake must be silent (no spurious agent output; mirror #387 runner-gating) AND the poll loop needs a drain-only path for a zero-agent wake (it currently filters `system` and skips the turn boundary on an empty batch). Real host+poll-loop work; do as its own unit.

---

## Original design spec (units 3+ reference)

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
