import type { Database } from 'bun:sqlite';

/**
 * #396 — deferred-notification offline re-queue (V1 5-min TTL parity).
 *
 * A cross-board assignment notification is "deferred" when the assignee's child
 * board has not finished provisioning, so their `board_people.notification_group_jid`
 * is still null and the engine can't resolve a delivery JID. V1 re-queued such
 * notifications (host-side poll) until the JID resolved or a 5-minute TTL fired.
 *
 * V2 persists them HERE, in the (engine-owned) taskflow.db, and re-resolves them
 * CONTAINER-side — the host does ZERO taskflow.db routing reads (Codex#3). A
 * drain runs when the parent board's container wakes (e.g. on provisioning
 * completion): rows whose JID has resolved + whose task is still live + within
 * TTL are returned for delivery and removed; expired or dead-task rows are
 * dropped; still-unresolved rows are left for a later drain.
 *
 * Design: add-taskflow/docs/2026-06-04-deferred-notification-requeue-design.md.
 */

export const DEFERRED_NOTIFICATION_TTL_MS = 5 * 60 * 1000;

export interface PendingNotificationInput {
  /** The board whose engine resolves the assignee's JID (the parent board). */
  board_id: string;
  target_person_id: string;
  /** The task the notification is about, for liveness (drop if deleted). May be
   *  null for notifications not tied to a single task. */
  task_id: string | null;
  /** The exact V1-faithful replay text. */
  message: string;
  /** ISO timestamp; the TTL anchor. */
  created_at: string;
}

export interface DeliverablePendingNotification {
  id: number;
  target_chat_jid: string;
  message: string;
}

export function ensurePendingNotificationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL,
      target_person_id TEXT NOT NULL,
      task_id TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

/** Minimal structural shape of a normalized notification event — avoids a
 *  dependency on the MCP-tool NotificationEvent union. */
interface MaybeDeferredEvent {
  kind: string;
  target_person_id?: string;
  message: string;
}

/**
 * #396 enqueue gate. From a batch of normalized notification events, persist
 * ONLY the `deferred_notification` ones whose target is a cross-board delegate
 * (has a `child_board_registrations` row on this board) — those are the ones
 * whose JID will resolve once their child board provisions. Same-group
 * assignees have a null JID by design that never resolves, so they are skipped
 * (queueing them would churn until the TTL). `direct_message` / other kinds are
 * already deliverable and are ignored here.
 */
export function enqueueDeferredCrossBoardNotifications(
  db: Database,
  boardId: string,
  events: ReadonlyArray<MaybeDeferredEvent>,
  taskId: string | null,
  nowIso: string,
): void {
  // A null-JID assignee notification is worth queueing only if the JID can still
  // resolve. Two cases qualify: (a) the person already has a child_board_registrations
  // row (cross-board delegate — JID will be set), OR (b) this is a DELEGATING board
  // (hierarchy_level < max_depth): a person registered here is getting an
  // auto-provisioned child board, so a notification sent DURING the
  // register→provision window — when NO registration row exists yet — will resolve
  // once provisioning sets notification_group_jid. Gating only on (a), as before,
  // false-excluded that window — the EXACT case #396 exists to deliver
  // (Codex xhigh 2026-06-05). A flat board (can't delegate) leaves an assignee's
  // JID permanently null (their own group), so those are correctly skipped.
  let boardCanDelegate = false;
  try {
    const boardRow = db
      .query(`SELECT hierarchy_level, max_depth FROM boards WHERE id = $board_id`)
      .get({ $board_id: boardId }) as { hierarchy_level: number | null; max_depth: number | null } | null;
    boardCanDelegate =
      !!boardRow &&
      boardRow.hierarchy_level != null &&
      boardRow.max_depth != null &&
      boardRow.hierarchy_level < boardRow.max_depth;
  } catch {
    // Older/partial schema without hierarchy columns → treat as flat (the safe,
    // more-restrictive registered-only gate). Production's boards table always
    // has these columns (canDelegateDown relies on them).
    boardCanDelegate = false;
  }
  const isRegistered = db.query(
    `SELECT 1 FROM child_board_registrations WHERE parent_board_id = $board_id AND person_id = $person_id LIMIT 1`,
  );
  for (const ev of events) {
    if (ev.kind !== 'deferred_notification' || !ev.target_person_id) continue;
    if (!boardCanDelegate && !isRegistered.get({ $board_id: boardId, $person_id: ev.target_person_id })) continue;
    enqueuePendingNotification(db, {
      board_id: boardId,
      target_person_id: ev.target_person_id,
      task_id: taskId,
      message: ev.message,
      created_at: nowIso,
    });
  }
}

export function enqueuePendingNotification(db: Database, n: PendingNotificationInput): void {
  db.query(
    `INSERT INTO pending_notifications (board_id, target_person_id, task_id, message, created_at)
     VALUES ($board_id, $target_person_id, $task_id, $message, $created_at)`,
  ).run({
    $board_id: n.board_id,
    $target_person_id: n.target_person_id,
    $task_id: n.task_id,
    $message: n.message,
    $created_at: n.created_at,
  });
}

interface DrainRow {
  id: number;
  task_id: string | null;
  message: string;
  created_at: string;
  jid: string | null;
  task_live: number;
}

/**
 * Drain the queue for `boardId` at `nowIso`. Returns the rows that are NOW
 * deliverable (JID resolved + task live + within TTL) and DELETES them; ALSO
 * deletes expired rows (past TTL) and dead-task rows (neither delivered); LEAVES
 * rows whose JID is still null but within TTL.
 *
 * AT-MOST-ONCE by design: the read + deletes run in one transaction and
 * deliverable rows are removed BEFORE the caller actually sends them. A caller
 * that crashes between draining and sending therefore LOSES those notifications
 * rather than risking a duplicate on the next drain — this matches the project's
 * "best-effort, no retry → no duplicate" rule (cf. dispatchNotificationEvents).
 */
export function drainDeliverablePendingNotifications(
  db: Database,
  boardId: string,
  nowIso: string,
): DeliverablePendingNotification[] {
  const nowMs = Date.parse(nowIso);
  // Fail loud: a bad clock would otherwise silently drop the ENTIRE queue (every
  // row's age becomes NaN → expired). The caller passes a trusted ISO timestamp.
  if (!Number.isFinite(nowMs)) {
    throw new Error(`drainDeliverablePendingNotifications: invalid nowIso "${nowIso}"`);
  }
  const drain = db.transaction((): DeliverablePendingNotification[] => {
    const rows = db
      .query(
        `SELECT pn.id, pn.task_id, pn.message, pn.created_at,
                bp.notification_group_jid AS jid,
                (pn.task_id IS NULL
                 OR EXISTS (SELECT 1 FROM tasks t WHERE t.board_id = pn.board_id AND t.id = pn.task_id)) AS task_live
           FROM pending_notifications pn
           LEFT JOIN board_people bp
             ON bp.board_id = pn.board_id AND bp.person_id = pn.target_person_id
          WHERE pn.board_id = $board_id`,
      )
      .all({ $board_id: boardId }) as DrainRow[];

    const deliverable: DeliverablePendingNotification[] = [];
    const removeIds: number[] = [];
    for (const r of rows) {
      const ageMs = nowMs - Date.parse(r.created_at);
      // Expired (or an unparseable created_at — fail-safe drop, never re-queue forever).
      if (!Number.isFinite(ageMs) || ageMs > DEFERRED_NOTIFICATION_TTL_MS) {
        removeIds.push(r.id);
        continue;
      }
      // Task was deleted between defer and drain — drop, don't deliver.
      if (!r.task_live) {
        removeIds.push(r.id);
        continue;
      }
      // JID resolved → deliverable; remove it (at-most-once).
      if (r.jid) {
        deliverable.push({ id: r.id, target_chat_jid: r.jid, message: r.message });
        removeIds.push(r.id);
        continue;
      }
      // Else: JID still null, within TTL, task live → leave for a later drain.
    }

    if (removeIds.length) {
      db.query(
        `DELETE FROM pending_notifications WHERE id IN (${removeIds.map(() => '?').join(',')})`,
      ).run(...removeIds);
    }
    return deliverable;
  });
  return drain();
}
