import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { initTaskflowDb } from '../../taskflow-db.js';
import type { ChannelAdapter } from '../../channels/adapter.js';
import type { Session } from '../../types.js';

const now = '2026-05-05T00:00:00Z';
const TMPROOT = path.join(os.tmpdir(), `nanoclaw-create-group-test-${process.pid}`);

const sharedState = vi.hoisted(() => ({ tfDbPath: '' }));

let mockWhatsAppAdapter: Partial<ChannelAdapter> | undefined;

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn((channelType: string) => {
    if (channelType === 'whatsapp') return mockWhatsAppAdapter;
    return undefined;
  }),
}));

vi.mock('./provision-shared.js', async (orig) => {
  const actual = await orig<typeof import('./provision-shared.js')>();
  return {
    ...actual,
    get TASKFLOW_DB_PATH() {
      return sharedState.tfDbPath;
    },
  };
});

const validInput = {
  action: 'create_group',
  subject: 'Project Atlas',
  participants: ['5511999000001@s.whatsapp.net', '5511999000002@s.whatsapp.net'],
};

function seedAgentAndMessagingGroup(opts: { agentId: string; folder: string; messagingId: string; isMain?: number }) {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(opts.agentId, opts.folder, opts.folder, 'claude', now);
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, is_main_control, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.messagingId,
      'whatsapp',
      `120363${opts.messagingId}@g.us`,
      opts.folder,
      1,
      'strict',
      opts.isMain ?? 0,
      now,
    );
}

function seedTaskflowBoard(folder: string, opts?: { hierarchyLevel?: number; maxDepth?: number }) {
  const db = initTaskflowDb(sharedState.tfDbPath);
  db.prepare(
    `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `board-${folder}`,
    `120363999@g.us`,
    folder,
    'hierarchy',
    opts?.hierarchyLevel ?? 0,
    opts?.maxDepth ?? 3,
    null,
    'TST',
  );
  db.close();
}

beforeEach(() => {
  fs.mkdirSync(TMPROOT, { recursive: true });
  sharedState.tfDbPath = path.join(TMPROOT, `tf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
  initTaskflowDb(sharedState.tfDbPath).close();

  initTestDb();
  runMigrations(getDb());

  mockWhatsAppAdapter = {
    name: 'whatsapp',
    channelType: 'whatsapp',
    supportsThreads: false,
    setup: vi.fn(),
    teardown: vi.fn(),
    isConnected: () => true,
    deliver: vi.fn(),
    createGroup: vi.fn(async () => ({ jid: '120363NEW@g.us', subject: 'Created' })),
    resolvePhoneJid: vi.fn(async (phone: string) => `${phone.replace(/\D/g, '')}@s.whatsapp.net`),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  closeDb();
  fs.rmSync(TMPROOT, { recursive: true, force: true });
});

const sessionFor = (agentId: string, mgId: string): Session => ({
  id: 'sess-1',
  agent_group_id: agentId,
  messaging_group_id: mgId,
  thread_id: null,
  agent_provider: 'claude',
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: now,
});

describe('handleCreateGroup', () => {
  it('drops when session is not main-control AND not a TaskFlow board', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-1', folder: 'random', messagingId: '111', isMain: 0 });
    const { handleCreateGroup } = await import('./create-group.js');
    await handleCreateGroup(validInput, sessionFor('ag-1', '111'), {} as never);
    expect(mockWhatsAppAdapter!.createGroup).not.toHaveBeenCalled();
  });

  it('allows from main-control chat WITHOUT auto-suffixing the subject', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-main', folder: 'main', messagingId: '111', isMain: 1 });
    const { handleCreateGroup } = await import('./create-group.js');
    await handleCreateGroup(validInput, sessionFor('ag-main', '111'), {} as never);
    expect(mockWhatsAppAdapter!.createGroup).toHaveBeenCalledOnce();
    const call = (mockWhatsAppAdapter!.createGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('Project Atlas'); // raw subject, no -TaskFlow suffix
  });

  it('allows from a TaskFlow board with depth headroom and auto-appends " - TaskFlow"', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-eng', folder: 'eng-taskflow', messagingId: '222', isMain: 0 });
    seedTaskflowBoard('eng-taskflow', { hierarchyLevel: 0, maxDepth: 3 });
    const { handleCreateGroup } = await import('./create-group.js');
    await handleCreateGroup(validInput, sessionFor('ag-eng', '222'), {} as never);
    expect(mockWhatsAppAdapter!.createGroup).toHaveBeenCalledOnce();
    const call = (mockWhatsAppAdapter!.createGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('Project Atlas - TaskFlow');
  });

  it('drops when TaskFlow board is at max depth (leaf)', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-leaf', folder: 'leaf-taskflow', messagingId: '333', isMain: 0 });
    seedTaskflowBoard('leaf-taskflow', { hierarchyLevel: 3, maxDepth: 3 });
    const { handleCreateGroup } = await import('./create-group.js');
    await handleCreateGroup(validInput, sessionFor('ag-leaf', '333'), {} as never);
    expect(mockWhatsAppAdapter!.createGroup).not.toHaveBeenCalled();
  });

  it('does not double-append " - TaskFlow" when already present', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-eng', folder: 'eng-taskflow', messagingId: '222', isMain: 0 });
    seedTaskflowBoard('eng-taskflow');
    const { handleCreateGroup } = await import('./create-group.js');
    await handleCreateGroup({ ...validInput, subject: 'Already - TaskFlow' }, sessionFor('ag-eng', '222'), {} as never);
    const call = (mockWhatsAppAdapter!.createGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('Already - TaskFlow');
  });

  it('drops invalid subject (empty / >100 chars)', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-main', folder: 'main', messagingId: '111', isMain: 1 });
    const { handleCreateGroup } = await import('./create-group.js');
    await handleCreateGroup({ ...validInput, subject: '   ' }, sessionFor('ag-main', '111'), {} as never);
    expect(mockWhatsAppAdapter!.createGroup).not.toHaveBeenCalled();
    await handleCreateGroup({ ...validInput, subject: 'x'.repeat(101) }, sessionFor('ag-main', '111'), {} as never);
    expect(mockWhatsAppAdapter!.createGroup).not.toHaveBeenCalled();
  });

  it('drops invalid participants (empty / non-array / bad JID / duplicates / too many)', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-main', folder: 'main', messagingId: '111', isMain: 1 });
    const { handleCreateGroup } = await import('./create-group.js');
    const session = sessionFor('ag-main', '111');
    await handleCreateGroup({ ...validInput, participants: [] }, session, {} as never);
    await handleCreateGroup({ ...validInput, participants: 'not-an-array' as never }, session, {} as never);
    await handleCreateGroup({ ...validInput, participants: ['not-a-jid'] }, session, {} as never);
    await handleCreateGroup(
      { ...validInput, participants: ['5511999000001@s.whatsapp.net', '5511999000001@s.whatsapp.net'] },
      session,
      {} as never,
    );
    expect(mockWhatsAppAdapter!.createGroup).not.toHaveBeenCalled();
  });

  it('round-trips participants via resolvePhoneJid and dedupes post-resolution', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-main', folder: 'main', messagingId: '111', isMain: 1 });
    // Both inputs canonicalize to the same JID — adapter returns the canonical one.
    (mockWhatsAppAdapter!.resolvePhoneJid as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('5511999000001@s.whatsapp.net')
      .mockResolvedValueOnce('5511999000001@s.whatsapp.net');
    const { handleCreateGroup } = await import('./create-group.js');
    await handleCreateGroup(
      { ...validInput, participants: ['5511999000001@s.whatsapp.net', '5511999999999@s.whatsapp.net'] },
      sessionFor('ag-main', '111'),
      {} as never,
    );
    const call = (mockWhatsAppAdapter!.createGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toEqual(['5511999000001@s.whatsapp.net']); // deduplicated
  });

  it('drops when WhatsApp adapter is unavailable', async () => {
    seedAgentAndMessagingGroup({ agentId: 'ag-main', folder: 'main', messagingId: '111', isMain: 1 });
    mockWhatsAppAdapter = undefined;
    const { handleCreateGroup } = await import('./create-group.js');
    await expect(handleCreateGroup(validInput, sessionFor('ag-main', '111'), {} as never)).resolves.toBeUndefined();
  });
});

describe('taskflow module index', () => {
  it('registers handleCreateGroup as the "create_group" delivery action on import', async () => {
    const registerSpy = vi.fn();
    vi.doMock('../../delivery.js', () => ({ registerDeliveryAction: registerSpy }));
    await import('./index.js');
    const calls = (registerSpy as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toContain('create_group');
    vi.doUnmock('../../delivery.js');
  });
});
