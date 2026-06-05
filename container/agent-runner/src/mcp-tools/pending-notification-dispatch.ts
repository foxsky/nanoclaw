import type { Database } from 'bun:sqlite';

import { getTaskflowDb } from '../db/connection.js';
import {
  drainDeliverablePendingNotifications,
  ensurePendingNotificationsTable,
  enqueueDeferredCrossBoardNotifications,
} from '../db/pending-notifications.js';
import type { NotificationEvent } from './taskflow-helpers.js';
import { isTaskflowSubprocess } from './taskflow-helpers.js';
import { dispatchNotificationEvents } from './taskflow-notify-dispatch.js';
import { log } from './util.js';

/**
 * #396 enqueue at a mutation finalizer — in-session ONLY. Persists cross-board
 * deferred (null-JID) notifications so the turn-boundary drain can deliver them
 * once the assignee's board provisions. Gated:
 * - no board → not a taskflow board → no-op;
 * - servicePath set → FastAPI subprocess → no-op (it may hold a DIFFERENT
 *   taskflow.db (Codex#3), and per #401 dashboard-originated deferreds are
 *   tf-mcontrol's to deliver — the in-session container owns the queue).
 * Fail-soft: an enqueue error must NEVER fail an already-committed mutation.
 */
export interface EnqueueDeferredDeps {
  db?: Database;
  servicePath?: string | undefined;
  nowIso?: string;
}

export function enqueueDeferredNotificationsInSession(
  boardId: string | undefined,
  events: NotificationEvent[],
  taskId: string | null,
  deps: EnqueueDeferredDeps = {},
): void {
  if (!boardId) return;
  // Subprocess gate (FastAPI/dashboard) — must NOT enqueue in-session deferreds.
  if (isTaskflowSubprocess(deps.servicePath)) return;
  try {
    enqueueDeferredCrossBoardNotifications(
      deps.db ?? getTaskflowDb(),
      boardId,
      events,
      taskId,
      deps.nowIso ?? new Date().toISOString(),
    );
  } catch (err) {
    log(`#396 deferred-notification enqueue failed: ${String(err)}`);
  }
}

/**
 * #396 unit 4 — turn-boundary drain. Called once per turn from the poll-loop:
 * deferred cross-board notifications whose assignee's child board has since
 * provisioned (JID now resolves) are drained and delivered as host-deliverable
 * `direct_message`s; expired/dead-task rows are dropped; still-unresolved rows
 * stay queued. This is the live re-delivery trigger — it fires whenever the
 * parent board's container is active, within the 5-min TTL (V1's best-effort
 * re-queue, sans the host-side poll the Codex#3 contract forbids).
 *
 * No-op for non-taskflow boards and in the FastAPI subprocess (which has no
 * session outbound.db — the in-session container owns delivery, so the
 * subprocess must NOT consume the rows).
 */
export interface DrainDispatchDeps {
  db?: Database;
  boardId?: string;
  nowIso?: string;
  servicePath?: string | undefined;
  dispatch?: (events: NotificationEvent[]) => void;
}

export function drainAndDispatchPendingNotifications(deps: DrainDispatchDeps = {}): number {
  const boardId = deps.boardId ?? process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return 0;
  if (isTaskflowSubprocess(deps.servicePath)) return 0;

  let deliverable;
  try {
    const db = deps.db ?? getTaskflowDb();
    // The idle drain can run before any TaskflowEngine construction has created
    // the table (a fresh taskflow container with no messages yet). Ensure it here
    // so a missing table doesn't throw + log-spam every poll. Idempotent.
    ensurePendingNotificationsTable(db);
    deliverable = drainDeliverablePendingNotifications(db, boardId, deps.nowIso ?? new Date().toISOString());
  } catch (err) {
    // Best-effort, like the rest of the notification path — a drain failure must
    // never break the turn boundary.
    log(`pending-notification drain failed: ${String(err)}`);
    return 0;
  }
  if (!deliverable.length) return 0;

  const events: NotificationEvent[] = deliverable.map((d) => ({
    kind: 'direct_message',
    target_chat_jid: d.target_chat_jid,
    message: d.message,
  }));
  (deps.dispatch ?? dispatchNotificationEvents)(events);
  return events.length;
}
