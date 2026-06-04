/**
 * PARITY-BLOCKER (#389): deterministic notification dispatch — restores
 * V1's `dispatchNotifications()` (ipc-mcp-stdio.ts:918) which V2 dropped.
 *
 * The engine GENERATES cross-chat notifications and the api_* tools
 * normalize them into `notification_events`, but nothing consumed them
 * (4 producers, 0 non-test consumers) — so cross-board reassign
 * notifications, external-invite DMs and parent rollups were silently
 * undelivered. The container now emits a `taskflow_dispatch_notifications`
 * system row; this host handler delivers it.
 *
 * `planNotificationDeliveries` is the pure routing/policy seam: it decides
 * which kinds deliver now (direct_message + parent_notification — both
 * carry an engine-resolved JID, so the host honours the Codex#3
 * host-zero-taskflow-reads contract) and which are skipped-with-reason
 * (destination_message → #395, deferred_notification → #396) so nothing is
 * silently dropped.
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
import { planNotificationDeliveries } from './taskflow-dispatch.js';

describe('planNotificationDeliveries', () => {
  it('routes direct_message to its target_chat_jid (the reassign/invite-DM gap)', () => {
    const { deliveries, skipped } = planNotificationDeliveries([
      { kind: 'direct_message', target_chat_jid: '551199@s.whatsapp.net', message: 'reassigned to you' },
    ]);
    expect(skipped).toEqual([]);
    expect(deliveries).toEqual([{ kind: 'direct_message', jid: '551199@s.whatsapp.net', text: 'reassigned to you' }]);
  });

  it('routes parent_notification to its parent_group_jid (the rollup gap)', () => {
    const { deliveries } = planNotificationDeliveries([
      { kind: 'parent_notification', parent_group_jid: '120363@g.us', message: 'child task done' },
    ]);
    expect(deliveries).toEqual([{ kind: 'parent_notification', jid: '120363@g.us', text: 'child task done' }]);
  });

  it('skips destination_message with a #395 reason — never silently dropped', () => {
    const { deliveries, skipped } = planNotificationDeliveries([
      { kind: 'destination_message', destination_name: 'peer-board', message: 'approve please' },
    ]);
    expect(deliveries).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].kind).toBe('destination_message');
    expect(skipped[0].reason).toContain('#395');
  });

  it('skips deferred_notification with a #396 reason — never silently dropped', () => {
    const { deliveries, skipped } = planNotificationDeliveries([
      { kind: 'deferred_notification', target_person_id: 'p-bob', message: 'you have a task' },
    ]);
    expect(deliveries).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].kind).toBe('deferred_notification');
    expect(skipped[0].reason).toContain('#396');
  });

  it('skips a direct_message missing its jid rather than delivering to a guess', () => {
    const { deliveries, skipped } = planNotificationDeliveries([{ kind: 'direct_message', message: 'no target' }]);
    expect(deliveries).toEqual([]);
    expect(skipped[0]).toMatchObject({ kind: 'direct_message' });
  });

  it('skips a direct_message whose target is not a WhatsApp JID (e.g. an unresolved person_id)', () => {
    const { deliveries, skipped } = planNotificationDeliveries([
      { kind: 'direct_message', target_chat_jid: 'lucas', message: 'leaked person id' },
    ]);
    expect(deliveries).toEqual([]);
    expect(skipped[0]).toMatchObject({ kind: 'direct_message' });
  });

  it('skips a parent_notification whose jid is a DM JID, not a group (must be @g.us)', () => {
    const { deliveries, skipped } = planNotificationDeliveries([
      { kind: 'parent_notification', parent_group_jid: '5511@s.whatsapp.net', message: 'rollup' },
    ]);
    expect(deliveries).toEqual([]);
    expect(skipped[0]).toMatchObject({ kind: 'parent_notification' });
  });

  it('skips an event with an empty/whitespace message (nothing to deliver)', () => {
    const { deliveries, skipped } = planNotificationDeliveries([
      { kind: 'direct_message', target_chat_jid: '551199@s.whatsapp.net', message: '   ' },
    ]);
    expect(deliveries).toEqual([]);
    expect(skipped[0]).toMatchObject({ kind: 'direct_message' });
  });

  it('skips an unknown kind and a non-array payload without throwing', () => {
    expect(planNotificationDeliveries([{ kind: 'bogus', message: 'x' }]).skipped[0].reason).toContain('unknown');
    expect(planNotificationDeliveries(undefined).deliveries).toEqual([]);
    expect(planNotificationDeliveries('nope').skipped).toHaveLength(1);
  });

  it('routes a mixed batch — delivers the resolvable kinds, skips the rest, order preserved', () => {
    const { deliveries, skipped } = planNotificationDeliveries([
      { kind: 'direct_message', target_chat_jid: 'a@s.whatsapp.net', message: 'one' },
      { kind: 'deferred_notification', target_person_id: 'p1', message: 'two' },
      { kind: 'parent_notification', parent_group_jid: 'b@g.us', message: 'three' },
    ]);
    expect(deliveries.map((d) => d.text)).toEqual(['one', 'three']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].kind).toBe('deferred_notification');
  });
});

const DM_JID = '551199@s.whatsapp.net';
const PARENT_JID = '120363000000000001@g.us';

const svcSession: Session = {
  id: 'taskflow-service',
  agent_group_id: 'taskflow-service',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-06-03T00:00:00Z',
};

function seedWhatsAppGroup(jid: string) {
  createMessagingGroup({
    id: `mg-${jid}`,
    channel_type: 'whatsapp',
    platform_id: jid,
    name: 'group',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: '2026-06-03T00:00:00Z',
  });
}

describe('handleTaskflowDispatchNotifications', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

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
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
    warnSpy.mockRestore();
  });

  async function dispatch(content: Record<string, unknown>) {
    const { handleTaskflowDispatchNotifications } = await import('./taskflow-dispatch.js');
    await handleTaskflowDispatchNotifications(content, svcSession, {} as never);
  }

  it('delivers direct_message + parent_notification to their resolved JIDs in one batch', async () => {
    seedWhatsAppGroup(DM_JID);
    seedWhatsAppGroup(PARENT_JID);
    await dispatch({
      action: 'taskflow_dispatch_notifications',
      board_id: 'board-1',
      events: [
        { kind: 'direct_message', target_chat_jid: DM_JID, message: 'reassigned to you' },
        { kind: 'parent_notification', parent_group_jid: PARENT_JID, message: 'child done' },
      ],
    });
    const deliver = mockWhatsApp!.deliver as ReturnType<typeof vi.fn>;
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([DM_JID, PARENT_JID]);
    expect(deliver.mock.calls[0][2].content).toEqual({ type: 'text', text: 'reassigned to you' });
  });

  it('skips deferred_notification with a logged warning and delivers nothing for it (fail-loud, not silent)', async () => {
    await dispatch({
      action: 'taskflow_dispatch_notifications',
      board_id: 'board-1',
      events: [{ kind: 'deferred_notification', target_person_id: 'p-bob', message: 'later' }],
    });
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('a malformed event does not sink the rest of the batch', async () => {
    seedWhatsAppGroup(DM_JID);
    await dispatch({
      action: 'taskflow_dispatch_notifications',
      board_id: 'board-1',
      events: [
        { kind: 'direct_message', message: 'no jid' },
        { kind: 'direct_message', target_chat_jid: DM_JID, message: 'good one' },
      ],
    });
    expect(mockWhatsApp!.deliver).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a thrown adapter.deliver on event 1 does NOT prevent event 2, and the handler never throws (no retry → no duplicate)', async () => {
    seedWhatsAppGroup(DM_JID);
    seedWhatsAppGroup(PARENT_JID);
    let n = 0;
    mockWhatsApp!.deliver = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('network blip');
      return 'wa-2';
    });
    await expect(
      dispatch({
        action: 'taskflow_dispatch_notifications',
        board_id: 'board-1',
        events: [
          { kind: 'direct_message', target_chat_jid: DM_JID, message: 'first (fails)' },
          { kind: 'parent_notification', parent_group_jid: PARENT_JID, message: 'second (ok)' },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(mockWhatsApp!.deliver).toHaveBeenCalledTimes(2);
  });
});
