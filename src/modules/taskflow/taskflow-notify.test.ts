/**
 * 0h-v2 Option A — Unit 3: the `taskflow_notify` host delivery-action.
 *
 * Codex#3 binding correction (memo §0.1): the FastAPI MCP subprocess and
 * the nanoclaw host can read DIFFERENT taskflow.db files, so this host
 * handler does **ZERO taskflow.db reads**. The engine resolves all
 * TaskFlow-side routing (person→notification_group_jid, board→group_jid)
 * INSIDE the subprocess at enqueue time and puts the resolved chat JID
 * in the payload. This handler only maps resolved-JID →
 * `messaging_groups` (central v2.db) → channel adapter, FAIL-CLOSED
 * (Codex#2 / tf fail-mode (b)): on any unresolvable routing it logs an
 * error and does NOT deliver — never to a guessed destination, never
 * silently "succeeding". TaskFlow is WhatsApp-only (board notification
 * JIDs are `@g.us` groups), mirroring the send-otp precedent.
 *
 * A `{kind:'person'}` target reaching the host means the caller did NOT
 * resolve person→jid — under the Codex#3 correction the host CANNOT
 * (no trustworthy taskflow.db), so it is treated as a fail-closed
 * contract violation, not a lookup to attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '../../channels/adapter.js';
import type { Session } from '../../types.js';

let mockWhatsApp: Partial<ChannelAdapter> | undefined;

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn((channelType: string) => (channelType === 'whatsapp' ? mockWhatsApp : undefined)),
}));

import { closeDb, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { log } from '../../log.js';

const BOARD_JID = '120363000000000001@g.us';

const svcSession: Session = {
  id: 'taskflow-service',
  agent_group_id: 'taskflow-service',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-05-16T00:00:00Z',
};

function seedWhatsAppGroup(jid: string) {
  createMessagingGroup({
    id: `mg-${jid}`,
    channel_type: 'whatsapp',
    platform_id: jid,
    name: 'Board group',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: '2026-05-16T00:00:00Z',
  });
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  mockWhatsApp = {
    name: 'whatsapp',
    channelType: 'whatsapp',
    supportsThreads: false,
    setup: vi.fn(),
    teardown: vi.fn(),
    isConnected: () => true,
    deliver: vi.fn(async () => 'wa-1'),
  };
  errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
  errSpy.mockRestore();
});

async function notify(content: Record<string, unknown>) {
  const { handleTaskflowNotify } = await import('./taskflow-notify.js');
  await handleTaskflowNotify(content, svcSession, {} as never);
}

describe('handleTaskflowNotify', () => {
  it('delivers to the resolved WhatsApp group when the JID maps to a messaging_group', async () => {
    seedWhatsAppGroup(BOARD_JID);
    await notify({
      action: 'taskflow_notify',
      board_id: 'board-1',
      target: { kind: 'group', group_jid: BOARD_JID },
      text: 'hello board',
    });
    expect(mockWhatsApp!.deliver).toHaveBeenCalledOnce();
    const args = (mockWhatsApp!.deliver as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[0]).toBe(BOARD_JID);
    expect(args[1]).toBeNull();
    expect(args[2].kind).toBe('chat');
    // Adapter casts content without JSON.parse — must be an OBJECT, not a string.
    expect(typeof args[2].content).toBe('object');
    expect(args[2].content).toEqual({ type: 'text', text: 'hello board' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED on a {kind:person} target — host must NOT resolve person→jid (Codex#3 contract)', async () => {
    await notify({
      action: 'taskflow_notify',
      board_id: 'board-1',
      target: { kind: 'person', person_id: 'bob' },
      text: 'hi bob',
    });
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED when the group JID has no matching messaging_group (never deliver to a guess)', async () => {
    await notify({
      action: 'taskflow_notify',
      board_id: 'board-1',
      target: { kind: 'group', group_jid: 'unknown@g.us' },
      text: 'orphan',
    });
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED on empty/missing text (payload validation)', async () => {
    seedWhatsAppGroup(BOARD_JID);
    await notify({
      action: 'taskflow_notify',
      board_id: 'board-1',
      target: { kind: 'group', group_jid: BOARD_JID },
      text: '   ',
    });
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED when the WhatsApp adapter is unavailable', async () => {
    seedWhatsAppGroup(BOARD_JID);
    mockWhatsApp = undefined;
    await notify({
      action: 'taskflow_notify',
      board_id: 'board-1',
      target: { kind: 'group', group_jid: BOARD_JID },
      text: 'no adapter',
    });
    expect(errSpy).toHaveBeenCalled();
  });
});
