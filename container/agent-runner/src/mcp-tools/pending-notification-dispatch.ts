import type { Database } from 'bun:sqlite';

import { getTaskflowDb } from '../db/connection.js';
import { drainDeliverablePendingNotifications } from '../db/pending-notifications.js';
import type { NotificationEvent } from './taskflow-helpers.js';
import { getServiceOutboundDbPath } from './taskflow-helpers.js';
import { dispatchNotificationEvents } from './taskflow-notify-dispatch.js';
import { log } from './util.js';

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
  const servicePath = deps.servicePath !== undefined ? deps.servicePath : getServiceOutboundDbPath();
  if (servicePath) return 0;

  let deliverable;
  try {
    const db = deps.db ?? getTaskflowDb();
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
