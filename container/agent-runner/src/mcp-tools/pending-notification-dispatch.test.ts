import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { ensurePendingNotificationsTable, enqueuePendingNotification } from '../db/pending-notifications.js';
import type { NotificationEvent } from './taskflow-helpers.js';
import { drainAndDispatchPendingNotifications, enqueueDeferredNotificationsInSession } from './pending-notification-dispatch.js';

const BOARD = 'board-parent';

function seed(): Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, notification_group_jid TEXT)`);
  db.exec(`CREATE TABLE tasks (id TEXT, board_id TEXT)`);
  ensurePendingNotificationsTable(db);
  db.exec(`INSERT INTO board_people (board_id, person_id, name, notification_group_jid) VALUES ('${BOARD}', 'person-A', 'Alice', 'childA@g.us')`);
  db.exec(`INSERT INTO tasks (id, board_id) VALUES ('T1', '${BOARD}')`);
  return db;
}

describe('drainAndDispatchPendingNotifications (#396 unit 4 — turn-boundary drain)', () => {
  it('drains deliverable rows and dispatches them as direct_messages, removing them', () => {
    const db = seed();
    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-A', task_id: 'T1', message: 'Nova tarefa atribuída a você', created_at: '2026-06-04T12:04:00.000Z' });
    const dispatched: Array<{ kind: string; target_chat_jid?: string; message: string }> = [];
    const n = drainAndDispatchPendingNotifications({
      db,
      boardId: BOARD,
      nowIso: '2026-06-04T12:05:00.000Z',
      servicePath: undefined,
      dispatch: (events) => dispatched.push(...(events as typeof dispatched)),
    });
    expect(n).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ kind: 'direct_message', target_chat_jid: 'childA@g.us', message: 'Nova tarefa atribuída a você' });
    expect((db.query('SELECT count(*) AS n FROM pending_notifications').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('is a no-op (no dispatch, no drain) in the FastAPI subprocess — servicePath set', () => {
    const db = seed();
    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-A', task_id: 'T1', message: 'm', created_at: '2026-06-04T12:04:00.000Z' });
    let dispatchCalled = false;
    const n = drainAndDispatchPendingNotifications({ db, boardId: BOARD, nowIso: '2026-06-04T12:05:00.000Z', servicePath: '/svc/outbound.db', dispatch: () => { dispatchCalled = true; } });
    expect(n).toBe(0);
    expect(dispatchCalled).toBe(false);
    // The row is NOT consumed — the in-session container will deliver it.
    expect((db.query('SELECT count(*) AS n FROM pending_notifications').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('is a no-op when no board id is configured (non-taskflow board)', () => {
    let dispatchCalled = false;
    const n = drainAndDispatchPendingNotifications({ boardId: undefined, servicePath: undefined, dispatch: () => { dispatchCalled = true; } });
    expect(n).toBe(0);
    expect(dispatchCalled).toBe(false);
  });

  it('ensures the pending_notifications table when absent — no throw / log-spam on a fresh taskflow DB', () => {
    // The idle drain can run before any TaskflowEngine construction has created
    // the table. It must create it and return 0, not throw + fail-soft-log every poll.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, notification_group_jid TEXT)`);
    db.exec(`CREATE TABLE tasks (id TEXT, board_id TEXT)`);
    // pending_notifications deliberately NOT created here.
    let dispatchCalled = false;
    const n = drainAndDispatchPendingNotifications({ db, boardId: BOARD, nowIso: '2026-06-04T12:05:00.000Z', servicePath: undefined, dispatch: () => { dispatchCalled = true; } });
    expect(n).toBe(0);
    expect(dispatchCalled).toBe(false);
    const exists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_notifications'").get();
    expect(exists).not.toBeNull();
    db.close();
  });

  it('does not dispatch when nothing is deliverable yet (JID still null)', () => {
    const db = seed();
    db.exec(`INSERT INTO board_people (board_id, person_id, name, notification_group_jid) VALUES ('${BOARD}', 'person-B', 'Bob', NULL)`);
    enqueuePendingNotification(db, { board_id: BOARD, target_person_id: 'person-B', task_id: 'T1', message: 'waiting', created_at: '2026-06-04T12:04:00.000Z' });
    let dispatchCalled = false;
    const n = drainAndDispatchPendingNotifications({ db, boardId: BOARD, nowIso: '2026-06-04T12:05:00.000Z', servicePath: undefined, dispatch: () => { dispatchCalled = true; } });
    expect(n).toBe(0);
    expect(dispatchCalled).toBe(false);
    expect((db.query('SELECT count(*) AS n FROM pending_notifications').get() as { n: number }).n).toBe(1); // kept
    db.close();
  });
});

describe('enqueueDeferredNotificationsInSession (#396 — gated in-session enqueue)', () => {
  const deferred: NotificationEvent[] = [{ kind: 'deferred_notification', target_person_id: 'person-A', message: 'reassigned to you' }];
  function gateDb(): Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT, child_board_id TEXT)`);
    db.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY, hierarchy_level INTEGER, max_depth INTEGER)`);
    ensurePendingNotificationsTable(db);
    db.exec(`INSERT INTO boards VALUES ('${BOARD}', 0, 0)`); // flat (enqueue gates on registration here)
    db.exec(`INSERT INTO child_board_registrations VALUES ('${BOARD}', 'person-A', 'child-A')`);
    return db;
  }
  const count = (db: Database) => (db.query('SELECT count(*) AS n FROM pending_notifications').get() as { n: number }).n;

  it('enqueues in-session (no servicePath)', () => {
    const db = gateDb();
    enqueueDeferredNotificationsInSession(BOARD, deferred, 'T9', { db, servicePath: undefined, nowIso: '2026-06-04T12:00:00.000Z' });
    expect(count(db)).toBe(1);
    db.close();
  });

  it('ALSO enqueues in the FastAPI subprocess (servicePath set) — the dashboard db IS the shared taskflow.db the container drains (#396; supersedes #401)', () => {
    // The FastAPI subprocess opens the SAME global taskflow.db (--db) the board's
    // container mounts, so a deferred enqueued here is drained+delivered by the
    // container's existing #396 drain (+ the #402 provisioning-wake). Reverses the
    // earlier no-op: dashboard-originated offline-assignee notifications were
    // undelivered (tf's IPC-file path has no host consumer).
    const db = gateDb();
    enqueueDeferredNotificationsInSession(BOARD, deferred, 'T9', { db, servicePath: '/svc/outbound.db', nowIso: '2026-06-04T12:00:00.000Z' });
    expect(count(db)).toBe(1);
    db.close();
  });

  it('STILL excludes a same-group/unregistered assignee on the subprocess (the queue must not fill with never-resolving rows)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT, child_board_id TEXT)`);
    db.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY, hierarchy_level INTEGER, max_depth INTEGER)`);
    ensurePendingNotificationsTable(db);
    db.exec(`INSERT INTO boards VALUES ('${BOARD}', 0, 0)`); // flat (can't delegate), and NO registration row
    enqueueDeferredNotificationsInSession(BOARD, deferred, 'T9', { db, servicePath: '/svc/outbound.db', nowIso: '2026-06-04T12:00:00.000Z' });
    expect(count(db)).toBe(0);
    db.close();
  });

  it('no-ops when board is undefined (non-taskflow board)', () => {
    const db = gateDb();
    enqueueDeferredNotificationsInSession(undefined, deferred, 'T9', { db, servicePath: undefined, nowIso: '2026-06-04T12:00:00.000Z' });
    expect(count(db)).toBe(0);
    db.close();
  });
});
