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

import {
  closeDb,
  createMessagingGroup,
  getMessagingGroupByPlatform,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
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

// RC5-ext delivery: a meeting notification to a never-contacted external arrives
// with a string-built `${phone}@s.whatsapp.net` JID and NO messaging_group, so it
// used to fail-closed (safe non-delivery). Resolve the phone via WhatsApp's
// onWhatsApp() round-trip (host-only socket) — confirming the number is real AND
// canonicalizing the BR 9th-digit form — then lazily cold-provision a DM
// messaging_group so it actually delivers (and future ones skip the round-trip).
describe('deliverTextToWhatsAppJid — RC5-ext cold-DM fallback for never-contacted externals', () => {
  async function deliver(jid: string, text = 'hi external') {
    const { deliverTextToWhatsAppJid } = await import('./taskflow-notify.js');
    return deliverTextToWhatsAppJid(jid, text, { board_id: 'board-1' });
  }

  it('cold-provisions a DM messaging_group via onWhatsApp() and delivers to the CANONICAL jid (9th-digit fixed)', async () => {
    const builtJid = '5585999992345@s.whatsapp.net'; // wrong 13-digit form
    const canonicalJid = '558599992345@s.whatsapp.net'; // server-canonical 12-digit form
    mockWhatsApp!.lookupPhoneJid = vi.fn(async () => canonicalJid);

    const ok = await deliver(builtJid);

    expect(ok).toBe(true);
    expect(mockWhatsApp!.lookupPhoneJid).toHaveBeenCalledOnce();
    // delivered to the canonical JID, never the string-built one
    expect((mockWhatsApp!.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(canonicalJid);
    // a reusable cold-DM messaging_group now exists for the canonical JID
    const mg = getMessagingGroupByPlatform('whatsapp', canonicalJid);
    expect(mg).toBeDefined();
    expect(mg!.is_group).toBe(0);
  });

  it('reuses an existing messaging_group without a round-trip when the DM jid is already known', async () => {
    const dmJid = '558599992345@s.whatsapp.net';
    createMessagingGroup({
      id: 'mg-known-dm',
      channel_type: 'whatsapp',
      platform_id: dmJid,
      name: 'Known external',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: '2026-05-16T00:00:00Z',
    });
    mockWhatsApp!.lookupPhoneJid = vi.fn(async () => 'should-not-be-called@s.whatsapp.net');

    const ok = await deliver(dmJid);

    expect(ok).toBe(true);
    expect(mockWhatsApp!.lookupPhoneJid).not.toHaveBeenCalled();
    expect((mockWhatsApp!.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(dmJid);
  });

  it('FAIL-CLOSED when the number is not on WhatsApp (lookupPhoneJid → null) — no provision, no deliver', async () => {
    mockWhatsApp!.lookupPhoneJid = vi.fn(async () => null);
    const ok = await deliver('5585999990000@s.whatsapp.net');
    expect(ok).toBe(false);
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
    expect(getMessagingGroupByPlatform('whatsapp', '5585999990000@s.whatsapp.net')).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED when lookupPhoneJid throws (transient socket error)', async () => {
    mockWhatsApp!.lookupPhoneJid = vi.fn(async () => {
      throw new Error('socket down');
    });
    const ok = await deliver('5585999990000@s.whatsapp.net');
    expect(ok).toBe(false);
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
  });

  it('does NOT round-trip a GROUP jid with no messaging_group — stays fail-closed (can never onWhatsApp a group)', async () => {
    mockWhatsApp!.lookupPhoneJid = vi.fn(async () => 'x@s.whatsapp.net');
    const ok = await deliver('unknown@g.us');
    expect(ok).toBe(false);
    expect(mockWhatsApp!.lookupPhoneJid).not.toHaveBeenCalled();
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED when onWhatsApp returns a non-DM JID (local safety invariant, not just adapter trust)', async () => {
    mockWhatsApp!.lookupPhoneJid = vi.fn(async () => '120363@g.us'); // bogus: a group, not a DM
    const ok = await deliver('5585999990000@s.whatsapp.net');
    expect(ok).toBe(false);
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
    expect(getMessagingGroupByPlatform('whatsapp', '120363@g.us')).toBeUndefined();
  });

  it('FAIL-CLOSED when the adapter has no onWhatsApp capability (no lookupPhoneJid)', async () => {
    // mockWhatsApp has no lookupPhoneJid in the default fixture
    const ok = await deliver('5585999990000@s.whatsapp.net');
    expect(ok).toBe(false);
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
  });
});
