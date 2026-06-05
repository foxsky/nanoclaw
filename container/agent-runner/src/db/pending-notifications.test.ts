import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import {
  DEFERRED_NOTIFICATION_TTL_MS,
  drainDeliverablePendingNotifications,
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
