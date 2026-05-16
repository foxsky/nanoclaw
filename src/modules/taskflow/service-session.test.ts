/**
 * 0h-v2 Option A — Unit 2: the TaskFlow "service session".
 *
 * The FastAPI MCP subprocess has no agent and no session, but
 * `src/delivery.ts` only drains `messages_out` rows that sit in a
 * *registered, `status='active'`* session's `outbound.db`
 * (`getActiveSessions()` → `WHERE status='active'`, db/sessions.ts:66).
 * So FastAPI-originated `taskflow_notify` rows need ONE well-known,
 * always-active synthetic session to land in.
 *
 * These tests pin the three invariants that, if broken, make every
 * FastAPI-originated notification silently vanish:
 *  1. the agent_group + an *active* session row exist after ensure,
 *  2. ensure is idempotent (it runs on every host startup),
 *  3. ensure HEALS a session that got closed (else pollSweep stops
 *     draining it and notifications die with no error), and
 *  4. the path we will hand the subprocess (Unit 4) is byte-identical
 *     to the path `delivery.ts` actually drains for that session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getAgentGroup, getSession, initTestDb, runMigrations, updateSession } from '../../db/index.js';
import { outboundDbPath } from '../../session-manager.js';
import {
  TASKFLOW_SERVICE_ID,
  ensureTaskflowServiceSessionRecord,
  taskflowServiceOutboundDbPath,
} from './service-session.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('ensureTaskflowServiceSessionRecord', () => {
  it('creates the agent_group and an active session (pollSweep only drains status=active)', () => {
    ensureTaskflowServiceSessionRecord();
    const ag = getAgentGroup(TASKFLOW_SERVICE_ID);
    expect(ag?.id).toBe(TASKFLOW_SERVICE_ID);
    expect(ag?.folder).toBe(TASKFLOW_SERVICE_ID);
    const s = getSession(TASKFLOW_SERVICE_ID);
    expect(s?.agent_group_id).toBe(TASKFLOW_SERVICE_ID);
    expect(s?.status).toBe('active');
    expect(s?.messaging_group_id).toBeNull(); // synthetic; routing is resolved host-side per-payload
  });

  it('is idempotent — runs on every host startup, must not throw or duplicate', () => {
    ensureTaskflowServiceSessionRecord();
    expect(() => ensureTaskflowServiceSessionRecord()).not.toThrow();
    // getSession is by PK; a duplicate INSERT would have thrown UNIQUE
    // above, so reaching here with a row proves single, stable identity.
    expect(getSession(TASKFLOW_SERVICE_ID)?.status).toBe('active');
  });

  it('re-activates a session that was closed (else pollSweep silently stops draining it)', () => {
    ensureTaskflowServiceSessionRecord(); // creates agent_group + active session
    updateSession(TASKFLOW_SERVICE_ID, { status: 'closed' }); // something closed it
    expect(getSession(TASKFLOW_SERVICE_ID)?.status).toBe('closed');
    ensureTaskflowServiceSessionRecord(); // next startup must heal it
    expect(getSession(TASKFLOW_SERVICE_ID)?.status).toBe('active');
  });
});

describe('taskflowServiceOutboundDbPath', () => {
  it('equals the exact path delivery.ts drains for the service session', () => {
    // The subprocess (Unit 4) will be handed THIS path; if it diverges
    // from what delivery.ts drains, rows are written somewhere nothing
    // reads. Asserting against outboundDbPath(...) makes drift fail here.
    expect(taskflowServiceOutboundDbPath()).toBe(outboundDbPath(TASKFLOW_SERVICE_ID, TASKFLOW_SERVICE_ID));
    expect(taskflowServiceOutboundDbPath()).toMatch(
      /\/data\/v2-sessions\/taskflow-service\/taskflow-service\/outbound\.db$/,
    );
  });
});
