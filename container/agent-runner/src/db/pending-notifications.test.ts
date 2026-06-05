import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import {
  DEFERRED_NOTIFICATION_TTL_MS,
  drainDeliverablePendingNotifications,
  enqueueDeferredCrossBoardNotifications,
  enqueuePendingNotification,
  ensurePendingNotificationsTable,
} from './pending-notifications.js';

const BOARD = 'board-parent';

// Minimal taskflow.db shape the drain joins against: board_people (resolves the
// person's notification_group_jid once their child board is provisioned) + tasks
// (liveness — drop a deferred whose task was deleted).
function setup(): Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, notification_group_jid TEXT)`);
  db.exec(`CREATE TABLE tasks (id TEXT, board_id TEXT)`);
  ensurePendingNotificationsTable(db);
  // person-A's child board IS provisioned (JID resolved); person-B's is not yet.
  db.exec(
    `INSERT INTO board_people (board_id, person_id, name, notification_group_jid) VALUES
       ('${BOARD}', 'person-A', 'Alice', 'childA@g.us'),
       ('${BOARD}', 'person-B', 'Bob', NULL)`,
  );
  db.exec(`INSERT INTO tasks (id, board_id) VALUES ('T1', '${BOARD}')`); // T1 live; 'T-DEL' absent
  return db;
}

describe('pending_notifications accessor (#396 unit 1)', () => {
  it('DEFERRED_NOTIFICATION_TTL_MS matches V1 (5 minutes)', () => {
    expect(DEFERRED_NOTIFICATION_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('enqueue persists exactly one row with the given fields', () => {
    const db = setup();
    enqueuePendingNotification(db, {
      board_id: BOARD,
      target_person_id: 'person-B',
      task_id: 'T1',
      message: 'hi',
      created_at: '2026-06-04T12:00:00.000Z',
    });
    const row = db
      .query('SELECT board_id, target_person_id, task_id, message FROM pending_notifications')
      .get() as { board_id: string; target_person_id: string; task_id: string; message: string };
    expect(row).toMatchObject({ board_id: BOARD, target_person_id: 'person-B', task_id: 'T1', message: 'hi' });
    db.close();
  });

  it('drain delivers resolved-JID + live + within-TTL rows, drops expired and dead-task rows, keeps still-unresolved rows', () => {
    // WHY: this is the whole #396 contract in one test. A deferred is delivered
    // ONLY once the person's JID resolves; it is dropped if it aged past the
    // 5-min TTL or its task was deleted; it is kept (for a later drain) while the
    // JID is still null but within TTL. At-most-once: delivered rows are removed.
    const db = setup();
    const now = '2026-06-04T12:05:00.000Z';
    const fresh = '2026-06-04T12:04:00.000Z'; // 1 min old — within TTL
    const expired = '2026-06-04T11:59:00.000Z'; // 6 min old — past the 5-min TTL

    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-A', task_id: 'T1', message: 'deliver me', created_at: fresh }); // DELIVER
    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-B', task_id: 'T1', message: 'still waiting', created_at: fresh }); // KEEP (JID null)
    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-A', task_id: 'T-DEL', message: 'dead task', created_at: fresh }); // DROP (liveness)
    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-A', task_id: 'T1', message: 'too late', created_at: expired }); // DROP (TTL)

    const delivered = drainDeliverablePendingNotifications(db, BOARD, now);
    expect(delivered.length).toBe(1);
    expect(delivered[0]).toMatchObject({ target_chat_jid: 'childA@g.us', message: 'deliver me' });

    const remaining = db.query('SELECT message FROM pending_notifications ORDER BY id').all() as Array<{ message: string }>;
    expect(remaining.map((r) => r.message)).toEqual(['still waiting']);
    db.close();
  });

  it('a null task_id carries no liveness constraint (delivers when JID resolved + within TTL)', () => {
    const db = setup();
    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-A', task_id: null, message: 'no task', created_at: '2026-06-04T12:04:30.000Z' });
    const delivered = drainDeliverablePendingNotifications(db, BOARD, '2026-06-04T12:05:00.000Z');
    expect(delivered.length).toBe(1);
    expect(delivered[0].message).toBe('no task');
    db.close();
  });

  it('fails loud on an unparseable nowIso instead of silently dropping the whole queue', () => {
    const db = setup();
    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-A', task_id: null, message: 'keep me', created_at: '2026-06-04T12:04:30.000Z' });
    expect(() => drainDeliverablePendingNotifications(db, BOARD, 'not-a-date')).toThrow(/invalid nowIso/);
    // The queue is untouched — nothing was dropped.
    expect((db.query('SELECT count(*) AS n FROM pending_notifications').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('drain is scoped to the board — another board\'s pending rows are untouched', () => {
    const db = setup();
    db.exec(`INSERT INTO board_people (board_id, person_id, name, notification_group_jid) VALUES ('board-other', 'person-A', 'Alice', 'childA@g.us')`);
    enqueuePendingNotification(db, { board_id: 'board-other', target_person_id: 'person-A', task_id: null, message: 'other board', created_at: '2026-06-04T12:04:30.000Z' });
    const delivered = drainDeliverablePendingNotifications(db, BOARD, '2026-06-04T12:05:00.000Z');
    expect(delivered.length).toBe(0);
    expect((db.query('SELECT count(*) AS n FROM pending_notifications').get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe('enqueueDeferredCrossBoardNotifications (#396 unit 2 — the cross-board gate)', () => {
  function setupGate(): Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT, child_board_id TEXT)`);
    db.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY, hierarchy_level INTEGER, max_depth INTEGER)`);
    ensurePendingNotificationsTable(db);
    // FLAT board by default (hierarchy_level == max_depth → cannot delegate), so an
    // unregistered person's null JID is permanent → not queued. A delegating board
    // is exercised in its own test below.
    db.exec(`INSERT INTO boards VALUES ('${BOARD}', 0, 0)`);
    // person-A is a cross-board delegate (has a child board); person-B is not.
    db.exec(`INSERT INTO child_board_registrations VALUES ('${BOARD}', 'person-A', 'child-A')`);
    return db;
  }

  it('enqueues a deferred_notification ONLY for a child-board-registered target', () => {
    // WHY: a same-group assignee's JID is null BY DESIGN and never resolves, so
    // queueing them would just churn until the TTL. Only cross-board delegates
    // (whose JID resolves once their child board provisions) belong in the queue.
    const db = setupGate();
    enqueueDeferredCrossBoardNotifications(
      db,
      BOARD,
      [
        { kind: 'deferred_notification', target_person_id: 'person-A', message: 'cross-board' }, // registered → enqueue
        { kind: 'deferred_notification', target_person_id: 'person-B', message: 'same-group' }, // NOT registered → skip
        { kind: 'direct_message', target_chat_jid: 'x@g.us', message: 'resolved' }, // not deferred → skip
      ],
      'T1',
      '2026-06-04T12:00:00.000Z',
    );
    const rows = db
      .query('SELECT target_person_id, task_id, message FROM pending_notifications')
      .all() as Array<{ target_person_id: string; task_id: string; message: string }>;
    expect(rows).toEqual([{ target_person_id: 'person-A', task_id: 'T1', message: 'cross-board' }]);
    db.close();
  });

  it('is a no-op when there are no deferred events', () => {
    const db = setupGate();
    enqueueDeferredCrossBoardNotifications(
      db,
      BOARD,
      [{ kind: 'direct_message', target_chat_jid: 'x@g.us', message: 'resolved' }],
      'T1',
      '2026-06-04T12:00:00.000Z',
    );
    expect((db.query('SELECT count(*) AS n FROM pending_notifications').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('enqueues an UNREGISTERED target on a DELEGATING board — the register→provision window (Codex xhigh fix)', () => {
    // This is the exact case #396 exists to deliver: a task assigned to a person
    // mid-provisioning has NO child_board_registrations row yet (it's inserted only
    // when provisioning completes), but the board can delegate, so their JID WILL
    // resolve. The old registration-only gate wrongly dropped this.
    const db = setupGate();
    db.exec(`UPDATE boards SET hierarchy_level = 0, max_depth = 2 WHERE id = '${BOARD}'`); // delegating
    enqueueDeferredCrossBoardNotifications(
      db,
      BOARD,
      [{ kind: 'deferred_notification', target_person_id: 'person-Z-unregistered', message: 'assigned mid-provision' }],
      'T7',
      '2026-06-04T12:00:00.000Z',
    );
    const rows = db
      .query('SELECT target_person_id, message FROM pending_notifications')
      .all() as Array<{ target_person_id: string; message: string }>;
    expect(rows).toEqual([{ target_person_id: 'person-Z-unregistered', message: 'assigned mid-provision' }]);
    db.close();
  });
});
