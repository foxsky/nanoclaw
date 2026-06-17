import type { Database } from 'bun:sqlite';

import { getTaskflowDb } from './db/taskflow-db.js';
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
 * #396 enqueue at a mutation finalizer. Persists cross-board deferred (null-JID)
 * notifications so the container drain (turn-boundary + idle-poll, + the #402
 * provisioning-wake) delivers them once the assignee's board provisions. Runs on
 * BOTH the in-session WhatsApp-agent path AND the FastAPI/dashboard subprocess —
 * they open the SAME global taskflow.db (the container mounts `<DATA_DIR>/taskflow/`;
 * the subprocess opens it via `--db`/`TASKFLOW_DB_PATH`, which MUST be that file
 * for dashboard mutations to hit real tasks), so a deferred enqueued by the
 * subprocess is drained+delivered by the board's container. This SUPERSEDES the
 * earlier #401 "tf-mcontrol owns dashboard deferred delivery" decision: tf's
 * tasks-IPC deferred path has no v2 host consumer (it delivered nothing), so
 * routing through the shared queue closes the offline-assignee gap with no new
 * surface and no double-send (the drain is at-most-once, delete-in-tx). Codex#3
 * still holds — this is the ENGINE writing taskflow.db, not the host re-resolving.
 * Same-group (never-resolving) assignees are excluded by
 * `enqueueDeferredCrossBoardNotifications`'s own delegate/registration gate.
 * Gated only on: no board → not a taskflow board → no-op. Fail-soft: an enqueue
 * error must NEVER fail an already-committed mutation.
 *
 * (The `…InSession` name is historical — kept to avoid churning the ~7 call sites
 * while a parallel session is active in those files.)
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
