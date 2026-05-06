import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';

const now = '2026-05-06T00:00:00Z';

let gateAllow: boolean;
let writeDestinationsSpy: ReturnType<typeof vi.fn>;

vi.mock('./permission.js', () => ({
  checkMainControlSession: vi.fn(() => gateAllow),
}));

vi.mock('../agent-to-agent/write-destinations.js', () => ({
  writeDestinations: (agentGroupId: string, sessionId: string) => {
    (writeDestinationsSpy as unknown as (a: string, b: string) => void)(agentGroupId, sessionId);
  },
}));

const session: Session = {
  id: 'sess-main',
  agent_group_id: 'ag-main',
  messaging_group_id: 'mg-main',
  thread_id: null,
  agent_provider: 'claude',
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: now,
};

function seedAgentGroup(id: string, folder: string) {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, folder, folder, 'claude', now);
}

function seedMessagingGroup(id: string, isMain = 0) {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, is_main_control, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, 'whatsapp', `120363${id}@g.us`, id, 1, 'strict', isMain, now);
}

function readDestinations() {
  return getDb()
    .prepare('SELECT agent_group_id, local_name, target_type, target_id FROM agent_destinations ORDER BY local_name')
    .all() as Array<{ agent_group_id: string; local_name: string; target_type: string; target_id: string }>;
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  seedAgentGroup('ag-main', 'main');
  seedMessagingGroup('mg-main', 1);
  gateAllow = true;
  writeDestinationsSpy = vi.fn();
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

describe('handleAddDestination', () => {
  it('drops when the gate denies', async () => {
    gateAllow = false;
    seedMessagingGroup('mg-target');
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination(
      { action: 'add_destination', local_name: 'caio', target_messaging_group_id: 'mg-target' },
      session,
      {} as never,
    );
    expect(readDestinations()).toEqual([]);
    expect(writeDestinationsSpy).not.toHaveBeenCalled();
  });

  it('drops when neither target is provided', async () => {
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination({ action: 'add_destination', local_name: 'caio' }, session, {} as never);
    expect(readDestinations()).toEqual([]);
  });

  it('drops when BOTH targets are provided', async () => {
    seedMessagingGroup('mg-target');
    seedAgentGroup('ag-target', 'target');
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination(
      {
        action: 'add_destination',
        local_name: 'caio',
        target_messaging_group_id: 'mg-target',
        target_agent_group_id: 'ag-target',
      },
      session,
      {} as never,
    );
    expect(readDestinations()).toEqual([]);
  });

  it('drops when target messaging group does not exist', async () => {
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination(
      { action: 'add_destination', local_name: 'caio', target_messaging_group_id: 'mg-nope' },
      session,
      {} as never,
    );
    expect(readDestinations()).toEqual([]);
  });

  it('drops when target agent group does not exist', async () => {
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination(
      { action: 'add_destination', local_name: 'caio', target_agent_group_id: 'ag-nope' },
      session,
      {} as never,
    );
    expect(readDestinations()).toEqual([]);
  });

  it('happy path: creates channel destination + refreshes container projection', async () => {
    seedMessagingGroup('mg-target');
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination(
      { action: 'add_destination', local_name: 'caio', target_messaging_group_id: 'mg-target' },
      session,
      {} as never,
    );
    const rows = readDestinations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_group_id: 'ag-main',
      local_name: 'caio',
      target_type: 'channel',
      target_id: 'mg-target',
    });
    expect(writeDestinationsSpy).toHaveBeenCalledWith('ag-main', 'sess-main');
  });

  it('happy path: creates agent destination', async () => {
    seedAgentGroup('ag-target', 'target');
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination(
      { action: 'add_destination', local_name: 'TaskBot', target_agent_group_id: 'ag-target' },
      session,
      {} as never,
    );
    const rows = readDestinations();
    expect(rows).toHaveLength(1);
    // local_name normalized to 'taskbot'
    expect(rows[0]).toMatchObject({
      agent_group_id: 'ag-main',
      local_name: 'taskbot',
      target_type: 'agent',
      target_id: 'ag-target',
    });
  });

  it('drops when local_name collides on this agent', async () => {
    seedMessagingGroup('mg-a');
    seedMessagingGroup('mg-b');
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination(
      { action: 'add_destination', local_name: 'caio', target_messaging_group_id: 'mg-a' },
      session,
      {} as never,
    );
    expect(readDestinations()).toHaveLength(1);
    await handleAddDestination(
      { action: 'add_destination', local_name: 'caio', target_messaging_group_id: 'mg-b' },
      session,
      {} as never,
    );
    expect(readDestinations()).toHaveLength(1); // still 1; second call dropped
    // Only one writeDestinations call, from the successful first invocation
    expect(writeDestinationsSpy).toHaveBeenCalledTimes(1);
  });

  it('drops when target already wired under a different local_name', async () => {
    seedMessagingGroup('mg-target');
    const { handleAddDestination } = await import('./add-destination.js');
    await handleAddDestination(
      { action: 'add_destination', local_name: 'first-name', target_messaging_group_id: 'mg-target' },
      session,
      {} as never,
    );
    await handleAddDestination(
      { action: 'add_destination', local_name: 'second-name', target_messaging_group_id: 'mg-target' },
      session,
      {} as never,
    );
    const rows = readDestinations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.local_name).toBe('first-name');
  });
});

describe('taskflow module index', () => {
  it('registers handleAddDestination as the "add_destination" delivery action on import', async () => {
    const registerSpy = vi.fn();
    vi.doMock('../../delivery.js', () => ({ registerDeliveryAction: registerSpy }));
    await import('./index.js');
    const calls = (registerSpy as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toContain('add_destination');
    vi.doUnmock('../../delivery.js');
  });
});
