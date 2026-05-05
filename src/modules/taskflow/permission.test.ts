/**
 * Integration tests for the main-control gate. Uses an in-memory v2 DB so the
 * SQL JOIN actually runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  setMainControlMessagingGroup,
} from '../../db/messaging-groups.js';
import type { Session } from '../../types.js';
import { checkMainControlSession } from './permission.js';

const now = '2026-05-05T00:00:00Z';

const baseSession: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-main',
  messaging_group_id: 'mg-main',
  thread_id: null,
  agent_provider: 'claude',
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: now,
};

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  // Boards-side rows so messaging_group_agents FK resolves.
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('ag-main', 'main', 'main', 'claude', now);
  createMessagingGroup({
    id: 'mg-main',
    channel_type: 'whatsapp',
    platform_id: '120363999@g.us',
    name: 'Main',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  createMessagingGroup({
    id: 'mg-board-123',
    channel_type: 'whatsapp',
    platform_id: '120363111@g.us',
    name: 'Board 123',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
});

afterEach(() => {
  closeDb();
});

function wire(messagingGroupId: string, agentGroupId: string, sessionMode: 'shared' | 'per-thread' | 'agent-shared') {
  createMessagingGroupAgent({
    id: `mga-${messagingGroupId}-${agentGroupId}`,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: sessionMode,
    priority: 0,
    created_at: now,
  });
}

describe('checkMainControlSession', () => {
  it('returns false when session.messaging_group_id is null', () => {
    expect(checkMainControlSession({ ...baseSession, messaging_group_id: null }, 'send_otp')).toBe(false);
  });

  it('returns false when no wiring row exists (fail-closed against stale fk)', () => {
    expect(checkMainControlSession(baseSession, 'send_otp')).toBe(false);
  });

  it('returns false when wiring is agent-shared (trigger chat unreliable)', () => {
    wire('mg-main', 'ag-main', 'agent-shared');
    setMainControlMessagingGroup('mg-main');
    expect(checkMainControlSession(baseSession, 'send_otp')).toBe(false);
  });

  it('returns false when messaging group has is_main_control = 0', () => {
    wire('mg-board-123', 'ag-main', 'shared');
    expect(checkMainControlSession({ ...baseSession, messaging_group_id: 'mg-board-123' }, 'send_otp')).toBe(false);
  });

  it('returns true when wiring is shared and messaging group is main control', () => {
    wire('mg-main', 'ag-main', 'shared');
    setMainControlMessagingGroup('mg-main');
    expect(checkMainControlSession(baseSession, 'send_otp')).toBe(true);
  });

  it('returns true when wiring is per-thread (preserves v1 modes)', () => {
    wire('mg-main', 'ag-main', 'per-thread');
    setMainControlMessagingGroup('mg-main');
    expect(checkMainControlSession(baseSession, 'send_otp')).toBe(true);
  });
});
