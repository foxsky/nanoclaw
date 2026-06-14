/**
 * RC5-ext inbound — host resolver (P2.4). Authenticates an external's DM JID
 * against their meeting grants and routes a same-board reply into the board's
 * agent session with an externalId-only actor identity (no board-person
 * `sender`), the external's cold-DM mg as the reply address, and a
 * collision-safe `external-<id>` reply destination. Cross-board grants are
 * NEVER routed (fail-closed until P2.5 host-parks them).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../../db/index.js';
import { createDestination, getDestinationByName } from '../agent-to-agent/db/agent-destinations.js';
import { findSession, findSessionForAgent } from '../../db/sessions.js';
import { inboundDbPath } from '../../session-manager.js';
import type { ChannelAdapter, InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup } from '../../types.js';
import { _resetParkedDisambiguation } from './parked-disambiguation.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

let mockWhatsApp: Partial<ChannelAdapter> | undefined;
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn((t: string) => (t === 'whatsapp' ? mockWhatsApp : undefined)),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-rc5ext-test' };
});

const TEST_DIR = '/tmp/nanoclaw-rc5ext-test';
const BOARD_JID = '120363408855255405@g.us';
const COLD_DM_JID = '5585999991234@s.whatsapp.net';

function now() {
  return new Date().toISOString();
}

function futureExpiresAt(): string {
  return new Date(Date.now() + 30 * 86400 * 1000).toISOString();
}

/** In-memory taskflow.db with one accepted same-board grant for ext-1. */
function makeTaskflowDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE external_contacts (
      external_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
      direct_chat_jid TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT
    );
    CREATE TABLE meeting_external_participants (
      board_id TEXT NOT NULL, meeting_task_id TEXT NOT NULL, occurrence_scheduled_at TEXT NOT NULL,
      external_id TEXT NOT NULL, invite_status TEXT NOT NULL, invited_at TEXT, accepted_at TEXT,
      revoked_at TEXT, access_expires_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (board_id, meeting_task_id, occurrence_scheduled_at, external_id)
    );
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL,
      board_role TEXT DEFAULT 'standard', hierarchy_level INTEGER, max_depth INTEGER,
      parent_board_id TEXT, short_code TEXT
    );
  `);
  db.exec(
    `INSERT INTO external_contacts VALUES ('ext-1', 'Maria', '5585999991234', '${COLD_DM_JID}', 'active', '2026-01-01', '2026-01-01', NULL);
     INSERT INTO boards VALUES ('board-1', '${BOARD_JID}', 'team-alpha', 'standard', NULL, NULL, NULL, NULL);`,
  );
  db.prepare(
    `INSERT INTO meeting_external_participants VALUES ('board-1', 'M1', '2026-03-12T14:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, ?, 'person-1', '2026-03-10', '2026-03-10')`,
  ).run(futureExpiresAt());
  return db;
}

function coldDmMg(): MessagingGroup {
  return {
    id: 'mg-cold-ext1',
    channel_type: 'whatsapp',
    platform_id: COLD_DM_JID,
    name: 'Maria',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  } as MessagingGroup;
}

function dmEvent(text = 'sure, 2pm works'): InboundEvent {
  return {
    channelType: 'whatsapp',
    platformId: COLD_DM_JID,
    threadId: null,
    message: { id: 'in-ext-1', kind: 'chat', content: JSON.stringify({ text }), timestamp: now() },
  };
}

let tfDb: Database.Database;

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  // The board side, in central v2.db.
  createAgentGroup({
    id: 'ag-board',
    name: 'Board Agent',
    folder: 'team-alpha',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-board',
    channel_type: 'whatsapp',
    platform_id: BOARD_JID,
    name: 'Team Alpha',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-board',
    messaging_group_id: 'mg-board',
    agent_group_id: 'ag-board',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  tfDb = makeTaskflowDb();
});

beforeEach(() => {
  mockWhatsApp = {
    name: 'whatsapp',
    channelType: 'whatsapp',
    supportsThreads: false,
    deliver: vi.fn(async () => 'wa-1'),
  } as Partial<ChannelAdapter>;
});

afterEach(() => {
  tfDb.close();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  _resetParkedDisambiguation();
  vi.clearAllMocks();
});

/** Add a second board (board-2 / team-beta) grant for ext-1 → cross-board. */
function addSecondBoardGrant() {
  tfDb.exec(`INSERT INTO boards VALUES ('board-2', '999999999@g.us', 'team-beta', 'standard', NULL, NULL, NULL, NULL)`);
  tfDb
    .prepare(
      `INSERT INTO meeting_external_participants VALUES ('board-2', 'M5', '2026-03-20T10:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, ?, 'person-2', '2026-03-10', '2026-03-10')`,
    )
    .run(futureExpiresAt());
  // The board-2 side in central v2.db.
  createAgentGroup({ id: 'ag-board2', name: 'Board2', folder: 'team-beta', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-board2',
    channel_type: 'whatsapp',
    platform_id: '999999999@g.us',
    name: 'Team Beta',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-board2',
    messaging_group_id: 'mg-board2',
    agent_group_id: 'ag-board2',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function board2InboundRows() {
  const session = findSession('mg-board2', null);
  if (!session) return [];
  const db = new Database(inboundDbPath('ag-board2', session.id));
  const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ content: string }>;
  db.close();
  return rows;
}

async function route(mg = coldDmMg(), event = dmEvent()) {
  const { resolveUnroutedExternalDm } = await import('./external-dm-route.js');
  return resolveUnroutedExternalDm(mg, event, { taskflowDb: tfDb });
}

function boardInboundRows() {
  const session = findSession('mg-board', null);
  if (!session) return [];
  const db = new Database(inboundDbPath('ag-board', session.id));
  const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{
    content: string;
    platform_id: string;
    channel_type: string;
    trigger: number;
  }>;
  db.close();
  return rows;
}

describe('resolveUnroutedExternalDm — same-board route', () => {
  it('routes a same-board external DM into the board session with an externalId-only actor', async () => {
    const { wakeContainer } = await import('../../container-runner.js');
    const ok = await route();
    expect(ok).toBe(true);

    const rows = boardInboundRows();
    expect(rows).toHaveLength(1);
    const c = JSON.parse(rows[0].content);
    // AUTH = externalId only; NO board-person `sender`.
    expect(c.sender).toBeUndefined();
    expect(c.actorKind).toBe('external');
    expect(c.externalActor).toEqual({
      externalId: 'ext-1',
      displayName: 'Maria',
      sourceDmMgId: 'mg-cold-ext1',
      boardId: 'board-1',
    });
    expect(c.from).toBe('external-ext-1');
    expect(c.text).toBe('sure, 2pm works');
    // Reply address = the EXTERNAL's cold-DM mg, not the board group.
    expect(rows[0].platform_id).toBe(COLD_DM_JID);
    expect(rows[0].trigger).toBe(1);
    expect(wakeContainer).toHaveBeenCalledOnce();
  });

  it('creates a collision-safe external-<id> reply destination pointing at the cold-DM mg', async () => {
    await route();
    const dest = getDestinationByName('ag-board', 'external-ext-1');
    expect(dest).toBeDefined();
    expect(dest!.target_type).toBe('channel');
    expect(dest!.target_id).toBe('mg-cold-ext1');
  });

  it('FAIL-CLOSED: does not route when external-<id> already names a DIFFERENT target', async () => {
    // A pre-existing destination under the same name pointing elsewhere must
    // never be silently repointed (would redirect the reply to a wrong target).
    createDestination({
      agent_group_id: 'ag-board',
      local_name: 'external-ext-1',
      target_type: 'channel',
      target_id: 'mg-some-other',
      created_at: now(),
    });
    const ok = await route();
    expect(ok).toBe(false);
    expect(boardInboundRows()).toHaveLength(0);
  });

  it('returns false (falls through to drop) when the JID has no active grant', async () => {
    const mg = { ...coldDmMg(), platform_id: '5585000000000@s.whatsapp.net' } as MessagingGroup;
    const ev = { ...dmEvent(), platformId: '5585000000000@s.whatsapp.net' };
    const ok = await route(mg, ev);
    expect(ok).toBe(false);
    expect(boardInboundRows()).toHaveLength(0);
  });

  it('returns false on empty text (does not route an empty external turn)', async () => {
    const ok = await route(coldDmMg(), dmEvent('   '));
    expect(ok).toBe(false);
    expect(boardInboundRows()).toHaveLength(0);
  });

  it('FAIL-CLOSED: a non-WhatsApp DM whose platform_id equals the external phone is NOT authenticated', async () => {
    // External identity is a WhatsApp JID; a telegram/signal DM that happens to
    // carry a matching platform_id must never be authed as the external.
    const mg = { ...coldDmMg(), channel_type: 'telegram' } as MessagingGroup;
    const ok = await route(mg, dmEvent());
    expect(ok).toBe(false);
    expect(boardInboundRows()).toHaveLength(0);
  });

  it('board-scopes routing: a second board sharing the group_jid does NOT receive the message (B2)', async () => {
    // boards.group_jid is not unique — wire a SECOND agent group (team-beta) to
    // the SAME board messaging_group. The external's grant is on board-1
    // (group_folder team-alpha), so only ag-board may receive the row.
    createAgentGroup({ id: 'ag-beta', name: 'Beta', folder: 'team-beta', agent_provider: null, created_at: now() });
    createMessagingGroupAgent({
      id: 'mga-beta',
      messaging_group_id: 'mg-board',
      agent_group_id: 'ag-beta',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const ok = await route();
    expect(ok).toBe(true);
    // routed ONLY to the team-alpha board agent's session
    const alpha = findSessionForAgent('ag-board', 'mg-board', null);
    const alphaDb = new Database(inboundDbPath('ag-board', alpha!.id));
    expect(alphaDb.prepare('SELECT * FROM messages_in').all()).toHaveLength(1);
    alphaDb.close();
    // the team-beta agent (co-wired to the same group) gets NOTHING — no session
    // was even resolved for it.
    expect(findSessionForAgent('ag-beta', 'mg-board', null)).toBeUndefined();
  });
});

describe('resolveUnroutedExternalDm — cross-board host-parked disambiguation', () => {
  // groupJid order: '120363...@g.us' < '999999999@g.us', so choice 1 = team-alpha
  // (board-1), choice 2 = team-beta (board-2).
  it('prompts + parks (consumes) without routing into any board on the first cross-board message', async () => {
    addSecondBoardGrant();
    const ok = await route(coldDmMg(), dmEvent('hey, about the meeting'));
    expect(ok).toBe(true); // consumed, never dropped
    expect(boardInboundRows()).toHaveLength(0);
    expect(board2InboundRows()).toHaveLength(0);
    // a numbered prompt went back to the external's cold-DM jid
    expect(mockWhatsApp!.deliver).toHaveBeenCalledOnce();
    const sent = (mockWhatsApp!.deliver as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sent[0]).toBe(COLD_DM_JID);
    expect(sent[2].content.text).toMatch(/1\. team-alpha[\s\S]*2\. team-beta/);
  });

  it('a numeric selection is consumed host-side (not forwarded) and binds the chosen board', async () => {
    addSecondBoardGrant();
    await route(coldDmMg(), dmEvent('hi')); // prompt + park
    const ok = await route(coldDmMg(), dmEvent('2')); // pick team-beta
    expect(ok).toBe(true);
    // the bare "2" must NOT be forwarded as board content
    expect(boardInboundRows()).toHaveLength(0);
    expect(board2InboundRows()).toHaveLength(0);
  });

  it('after selecting a board, the next real message routes there (no re-prompt)', async () => {
    addSecondBoardGrant();
    await route(coldDmMg(), dmEvent('hi')); // prompt
    await route(coldDmMg(), dmEvent('2')); // select team-beta
    (mockWhatsApp!.deliver as ReturnType<typeof vi.fn>).mockClear();

    const ok = await route(coldDmMg(), dmEvent('I can do 3pm instead'));
    expect(ok).toBe(true);
    // routed to the CHOSEN board (board-2), not board-1, and no further prompt
    expect(boardInboundRows()).toHaveLength(0);
    const rows = board2InboundRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('I can do 3pm instead');
    expect(JSON.parse(rows[0].content).externalActor.externalId).toBe('ext-1');
    expect(mockWhatsApp!.deliver).not.toHaveBeenCalled();
  });

  it('consumes a stale numeric selection when grants collapse to one board between prompt and reply (I1)', async () => {
    addSecondBoardGrant();
    await route(coldDmMg(), dmEvent('hi')); // prompt + park (2 boards)
    // board-2's grant is revoked before the external replies → single board now
    tfDb.exec(`UPDATE meeting_external_participants SET invite_status = 'revoked' WHERE board_id = 'board-2'`);

    const ok = await route(coldDmMg(), dmEvent('2')); // stale pick for the old prompt
    expect(ok).toBe(true);
    // the bare "2" must NOT be forwarded as content to the remaining board
    expect(boardInboundRows()).toHaveLength(0);
  });

  it('re-prompts on an unparseable selection (no valid number), still consuming', async () => {
    addSecondBoardGrant();
    await route(coldDmMg(), dmEvent('hi')); // prompt #1
    const ok = await route(coldDmMg(), dmEvent('the second one please')); // not a number
    expect(ok).toBe(true);
    expect(boardInboundRows()).toHaveLength(0);
    expect(board2InboundRows()).toHaveLength(0);
    // prompted again (2 total deliveries)
    expect(mockWhatsApp!.deliver).toHaveBeenCalledTimes(2);
  });
});
