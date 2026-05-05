/**
 * Host-side delivery action handler tests for provision_root_board.
 *
 * The shared main-control gate (../taskflow/permission.ts) is mocked to a
 * controllable boolean — gate logic has its own integration test. The
 * filesystem + settings.json + onboarding schedule are sanity-checked but
 * the heavy assertion surface is on taskflow.db rows, v2 wiring, and the
 * confirmation/welcome messages.
 */
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
const TMPROOT = path.join(os.tmpdir(), `nanoclaw-provision-root-board-test-${process.pid}`);

const fakeSession: Session = {
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

let mockWhatsAppAdapter: Partial<ChannelAdapter> | undefined;
let gateAllow: boolean;
let tfDb: Database.Database;

const sharedState = vi.hoisted(() => ({ tfDbPath: '' }));

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn((channelType: string) => {
    if (channelType === 'whatsapp') return mockWhatsAppAdapter;
    return undefined;
  }),
}));

vi.mock('./permission.js', () => ({
  checkMainControlSession: vi.fn(() => gateAllow),
}));

vi.mock('./provision-shared.js', async (orig) => {
  const actual = await orig<typeof import('./provision-shared.js')>();
  return {
    ...actual,
    get TASKFLOW_DB_PATH() {
      return sharedState.tfDbPath;
    },
    // Skip filesystem + ownership in tests; their helpers have their own coverage.
    createBoardFilesystem: vi.fn(),
    fixOwnership: vi.fn(),
  };
});

const validInput = {
  action: 'provision_root_board',
  subject: 'Setor de Engenharia',
  person_id: 'p-001',
  person_name: 'Caio Guimarães',
  person_phone: '+5585999991234',
  short_code: 'ENG',
};

beforeEach(() => {
  fs.mkdirSync(TMPROOT, { recursive: true });
  sharedState.tfDbPath = path.join(TMPROOT, `tf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
  tfDb = initTaskflowDb(sharedState.tfDbPath);
  tfDb.close();

  initTestDb();
  runMigrations(getDb());
  // Seed the operator's main control row in v2 DB so the wiring lookups
  // resolve. (Gate is mocked, but the handler still reads getMessagingGroup
  // for the main chat to send the confirmation back.)
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('ag-main', 'main', 'main', 'claude', now);
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, is_main_control, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('mg-main', 'whatsapp', '120363111@g.us', 'Main Control', 1, 'strict', 1, now);

  gateAllow = true;
  mockWhatsAppAdapter = {
    name: 'whatsapp',
    channelType: 'whatsapp',
    supportsThreads: false,
    setup: vi.fn(),
    teardown: vi.fn(),
    isConnected: () => true,
    deliver: vi.fn(async () => 'wa-msg-id-1'),
    lookupPhoneJid: vi.fn(async () => '5585999991234@s.whatsapp.net'),
    resolvePhoneJid: vi.fn(async (phone: string) => `${phone.replace(/\D/g, '')}@s.whatsapp.net`),
    createGroup: vi.fn(async () => ({
      jid: '120363999@g.us',
      subject: 'Setor de Engenharia - TaskFlow',
    })),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  closeDb();
  fs.rmSync(TMPROOT, { recursive: true, force: true });
});

describe('handleProvisionRootBoard', () => {
  it('drops when the gate denies', async () => {
    gateAllow = false;
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard(validInput, fakeSession, {} as never);
    expect(mockWhatsAppAdapter!.createGroup).not.toHaveBeenCalled();
  });

  it.each(['subject', 'person_id', 'person_name', 'person_phone', 'short_code'] as const)(
    'drops when required field "%s" is empty',
    async (field) => {
      const { handleProvisionRootBoard } = await import('./provision-root-board.js');
      await handleProvisionRootBoard({ ...validInput, [field]: '   ' }, fakeSession, {} as never);
      expect(mockWhatsAppAdapter!.createGroup).not.toHaveBeenCalled();
    },
  );

  it('drops when the WhatsApp adapter has no createGroup capability', async () => {
    mockWhatsAppAdapter = { ...mockWhatsAppAdapter!, createGroup: undefined };
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard(validInput, fakeSession, {} as never);
    expect(mockWhatsAppAdapter!.deliver).not.toHaveBeenCalled();
  });

  it('happy path: creates WhatsApp group, seeds taskflow.db, wires v2, sends welcome + confirmation', async () => {
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard(validInput, fakeSession, {} as never);

    // 1. createGroup called with the suffixed subject + manager JID in participants
    expect(mockWhatsAppAdapter!.createGroup).toHaveBeenCalledOnce();
    const createCall = (mockWhatsAppAdapter!.createGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[0]).toBe('Setor de Engenharia - TaskFlow');
    expect(createCall[1]).toEqual(expect.arrayContaining([expect.stringMatching(/@s\.whatsapp\.net$/)]));

    // 2. taskflow.db rows seeded
    const db = new Database(sharedState.tfDbPath);
    const board = db
      .prepare('SELECT id, group_jid, group_folder, hierarchy_level, max_depth, short_code FROM boards')
      .get() as Record<string, unknown>;
    expect(board.short_code).toBe('ENG');
    expect(board.group_jid).toBe('120363999@g.us');
    expect(board.hierarchy_level).toBe(0);
    const cfg = db.prepare('SELECT wip_limit FROM board_config WHERE board_id = ?').get(board.id) as {
      wip_limit: number;
    };
    expect(cfg.wip_limit).toBe(5);
    const runtime = db
      .prepare('SELECT timezone, language FROM board_runtime_config WHERE board_id = ?')
      .get(board.id) as {
      timezone: string;
      language: string;
    };
    expect(runtime.timezone).toBe('America/Fortaleza');
    expect(runtime.language).toBe('pt-BR');
    const admin = db
      .prepare('SELECT person_id, admin_role, is_primary_manager FROM board_admins WHERE board_id = ?')
      .get(board.id) as Record<string, unknown>;
    expect(admin.person_id).toBe('p-001');
    expect(admin.admin_role).toBe('manager');
    expect(admin.is_primary_manager).toBe(1);
    const person = db
      .prepare('SELECT name, phone, role FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(board.id, 'p-001') as Record<string, string>;
    expect(person.name).toBe('Caio Guimarães');
    expect(person.role).toBe('manager');
    const taskHistory = db.prepare('SELECT action FROM task_history WHERE board_id = ?').get(board.id) as {
      action: string;
    };
    expect(taskHistory.action).toBe('root_board_created');
    db.close();

    // 3. v2 wiring (agent_groups + messaging_groups + messaging_group_agents)
    const ag = getDb().prepare('SELECT id, name, folder FROM agent_groups WHERE folder LIKE ?').get('eng-taskflow%') as
      | Record<string, string>
      | undefined;
    expect(ag).toBeDefined();
    expect(ag!.folder).toMatch(/^eng-taskflow/);
    const mg = getDb()
      .prepare('SELECT id, channel_type, platform_id, name FROM messaging_groups WHERE platform_id = ?')
      .get('120363999@g.us') as Record<string, string> | undefined;
    expect(mg).toBeDefined();
    expect(mg!.channel_type).toBe('whatsapp');
    const wiring = getDb()
      .prepare(
        'SELECT messaging_group_id, agent_group_id, engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = ?',
      )
      .get(mg!.id) as Record<string, string>;
    expect(wiring.agent_group_id).toBe(ag!.id);
    expect(wiring.engage_mode).toBe('pattern');
    expect(wiring.engage_pattern).toBe('.');

    // 4. confirmation to main + welcome to new group via adapter.deliver (object content)
    const deliverCalls = (mockWhatsAppAdapter!.deliver as ReturnType<typeof vi.fn>).mock.calls;
    expect(deliverCalls.length).toBe(2);
    const targetJids = deliverCalls.map((c) => c[0]).sort();
    expect(targetJids).toEqual(['120363111@g.us', '120363999@g.us']);
    for (const call of deliverCalls) {
      const payload = call[2];
      expect(payload.kind).toBe('chat');
      expect(typeof payload.content).toBe('object');
      expect((payload.content as { type: string }).type).toBe('text');
    }

    // 5. board_runtime_config.welcome_sent flipped to 1
    const dbAgain = new Database(sharedState.tfDbPath);
    const welcome = dbAgain
      .prepare('SELECT welcome_sent FROM board_runtime_config WHERE board_id = ?')
      .get(board.id) as {
      welcome_sent: number;
    };
    expect(welcome.welcome_sent).toBe(1);
    dbAgain.close();
  });

  it('drops when a board with the same short_code already exists', async () => {
    const db = initTaskflowDb(sharedState.tfDbPath);
    db.prepare(
      `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES ('board-existing', '120363000@g.us', 'existing-taskflow', 'hierarchy', 0, 3, NULL, 'ENG')`,
    ).run();
    db.close();
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard(validInput, fakeSession, {} as never);
    expect(mockWhatsAppAdapter!.createGroup).not.toHaveBeenCalled();
  });

  it('appends " - TaskFlow" suffix to subject if absent', async () => {
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard({ ...validInput, subject: 'Plain Subject' }, fakeSession, {} as never);
    const createCall = (mockWhatsAppAdapter!.createGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[0]).toBe('Plain Subject - TaskFlow');
  });

  it('does not double-append " - TaskFlow" when already present', async () => {
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard(
      { ...validInput, subject: 'Already Has Suffix - TaskFlow' },
      fakeSession,
      {} as never,
    );
    const createCall = (mockWhatsAppAdapter!.createGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[0]).toBe('Already Has Suffix - TaskFlow');
  });

  it('persists trigger_turn_id from content into task_history', async () => {
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard({ ...validInput, trigger_turn_id: 'turn-abc-123' }, fakeSession, {} as never);
    const db = new Database(sharedState.tfDbPath);
    const row = db.prepare('SELECT trigger_turn_id FROM task_history').get() as { trigger_turn_id: string | null };
    expect(row.trigger_turn_id).toBe('turn-abc-123');
    db.close();
  });

  it('trims whitespace-padded participant JIDs before passing to createGroup', async () => {
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard(
      { ...validInput, participants: ['   5511999000001@s.whatsapp.net  '] },
      fakeSession,
      {} as never,
    );
    const createCall = (mockWhatsAppAdapter!.createGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[1]).toContain('5511999000001@s.whatsapp.net');
    // No whitespace-padded entries reach the adapter.
    for (const jid of createCall[1]) {
      expect(jid).toBe(jid.trim());
    }
  });

  it('detects folder collision against existing agent_groups.folder, not messaging_groups.name', async () => {
    // Pre-existing agent group with the folder we'd otherwise pick. v1 missed this
    // collision because it used registered_groups[].folder; v2 must use agent_groups.folder.
    getDb()
      .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('ag-existing', 'existing-eng', 'eng-taskflow', 'claude', now);
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard(validInput, fakeSession, {} as never);
    // The new agent group should use a deduplicated folder (eng-taskflow-2 etc.)
    const ag = getDb()
      .prepare('SELECT folder FROM agent_groups WHERE id != ? AND folder LIKE ?')
      .all('ag-existing', 'eng-taskflow%') as Array<{ folder: string }>;
    const newFolders = ag.map((r) => r.folder).filter((f) => f !== 'eng-taskflow' && f !== 'main');
    expect(newFolders.length).toBeGreaterThan(0);
    expect(newFolders[0]).toMatch(/^eng-taskflow-/);
  });

  it('wires engage_mode=mention when requires_trigger=true', async () => {
    const { handleProvisionRootBoard } = await import('./provision-root-board.js');
    await handleProvisionRootBoard({ ...validInput, requires_trigger: true }, fakeSession, {} as never);
    const wiring = getDb()
      .prepare('SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id != ?')
      .get('mg-main') as { engage_mode: string; engage_pattern: string | null };
    expect(wiring.engage_mode).toBe('mention');
    expect(wiring.engage_pattern).toBeNull();
  });
});

describe('taskflow module index', () => {
  it('registers handleProvisionRootBoard as the "provision_root_board" delivery action on import', async () => {
    const registerSpy = vi.fn();
    vi.doMock('../../delivery.js', () => ({ registerDeliveryAction: registerSpy }));
    await import('./index.js');
    expect(registerSpy).toHaveBeenCalledWith('provision_root_board', expect.any(Function));
    vi.doUnmock('../../delivery.js');
  });
});
