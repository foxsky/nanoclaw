/**
 * Tests for the 3 ChannelAdapter extensions added by skill/whatsapp-fixes-v2:
 *   - createGroup(subject, participants)
 *   - lookupPhoneJid(phone)
 *   - resolvePhoneJid(phone)
 *
 * v2 test pattern (per Discovery 07):
 *   - Side-effect import './whatsapp.js' to trigger registerChannelAdapter
 *   - Mock baileys NAMED export `makeWASocket` (not default — Discovery 07)
 *   - Bypass null-short-circuit via WHATSAPP_ENABLED env mock
 *   - Drive `initChannelAdapters` then `getChannelAdapter('whatsapp')`
 *
 * Until step 1.4 lands the impls, ALL tests in this file FAIL (TDD-RED).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

// --- Test isolation paths (vi.hoisted so the mock factory below can reference) ---
const TEST_PATHS = vi.hoisted(() => ({
  AUTH_DIR: '/tmp/nanoclaw-wa-fixes-test-store/auth',
  DATA_DIR: '/tmp/nanoclaw-wa-fixes-test-data',
  STORE_DIR: '/tmp/nanoclaw-wa-fixes-test-store',
}));

// --- Mocks (must be before any import of the SUT) ---

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_PATHS.DATA_DIR,
    STORE_DIR: TEST_PATHS.STORE_DIR,
    ASSISTANT_NAME: 'TestAgent',
    ASSISTANT_HAS_OWN_NUMBER: false,
  };
});

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    WHATSAPP_ENABLED: 'true',
    WHATSAPP_PHONE_NUMBER: '',
  })),
}));

vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

function createFakeSocket() {
  const ev = new EventEmitter();
  return {
    ev: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        ev.on(event, handler);
        // When the adapter subscribes to connection.update, fire a synthetic
        // "open" event on next tick so setup()'s firstOpen promise resolves.
        if (event === 'connection.update') {
          setImmediate(() => handler({ connection: 'open' }));
        }
      },
    },
    user: { id: '5585999000000:1@s.whatsapp.net' },
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wa-msg-default' } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    groupCreate: vi.fn().mockResolvedValue({ id: '120363999999@g.us', subject: 'Test Group' }),
    groupMetadata: vi.fn().mockResolvedValue({
      id: '120363999999@g.us',
      subject: 'Test Group',
      participants: [
        { id: '5585999000000@s.whatsapp.net' },
        { id: '5511999000001@s.whatsapp.net' },
        { id: '5511999000002@s.whatsapp.net' },
      ],
    }),
    groupInviteCode: vi.fn().mockResolvedValue('ABCDEFGHIJ'),
    groupParticipantsUpdate: vi.fn().mockResolvedValue([{ status: 'success' }]),
    onWhatsApp: vi.fn().mockResolvedValue([{ jid: '5511999000001@s.whatsapp.net', exists: true }]),
    end: vi.fn(),
    _ev: ev,
  };
}

let fakeSocket: ReturnType<typeof createFakeSocket>;

vi.mock('@whiskeysockets/baileys', () => ({
  // v2 uses NAMED import: `import { makeWASocket } from '@whiskeysockets/baileys'`
  makeWASocket: vi.fn(() => fakeSocket),
  Browsers: { macOS: vi.fn(() => ['macOS', 'Chrome', '']) },
  DisconnectReason: { loggedOut: 401 },
  fetchLatestWaWebVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  normalizeMessageContent: vi.fn((c: unknown) => c),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: { me: { id: '5585999000000:1@s.whatsapp.net' } }, keys: {} },
    saveCreds: vi.fn(),
  }),
  downloadMediaMessage: vi.fn(),
}));

// --- SUT import (side-effect: registers 'whatsapp' adapter) ---
import './whatsapp.js';
import { initChannelAdapters, getChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter } from './adapter.js';

// Pre-create a fake creds.json so the factory's null-short-circuit (whatsapp.ts:157)
// passes via WHATSAPP_ENABLED=true. Either of (creds.json, phone, WHATSAPP_ENABLED)
// is sufficient.
beforeAll(() => {
  fs.mkdirSync(TEST_PATHS.AUTH_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_PATHS.AUTH_DIR, 'creds.json'), '{}');
});

afterAll(() => {
  if (fs.existsSync(TEST_PATHS.STORE_DIR)) {
    fs.rmSync(TEST_PATHS.STORE_DIR, { recursive: true, force: true });
  }
});

let adapter: ChannelAdapter;

beforeEach(async () => {
  fakeSocket = createFakeSocket();

  // Drive the registry's factory + setup path. Stub setup config; the
  // adapter only needs the field shape, not real DB callbacks for these
  // 3 method tests.
  await initChannelAdapters(
    (a) =>
      ({
        onInbound: vi.fn(),
        onInboundEvent: vi.fn(),
        onMetadata: vi.fn(),
        onAction: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } as never,
      }) as never,
  );

  adapter = getChannelAdapter('whatsapp')!;
  expect(adapter).toBeDefined();
});

describe('whatsapp-fixes-v2 ChannelAdapter extensions', () => {
  describe('createGroup', () => {
    it('exposes createGroup on the adapter', () => {
      expect(typeof adapter.createGroup).toBe('function');
    });

    it('calls sock.groupCreate and returns the new JID + subject', async () => {
      const result = await adapter.createGroup!('Test Group', [
        '5511999000001@s.whatsapp.net',
        '5511999000002@s.whatsapp.net',
      ]);
      expect(fakeSocket.groupCreate).toHaveBeenCalledWith(
        'Test Group',
        expect.arrayContaining(['5511999000001@s.whatsapp.net']),
      );
      expect(result.jid).toBe('120363999999@g.us');
      expect(result.subject).toBe('Test Group');
    });

    it('throws when participants exceed WhatsApp 1024 limit', async () => {
      const tooMany = Array.from({ length: 1024 }, (_, i) => `551199900${String(i).padStart(4, '0')}@s.whatsapp.net`);
      await expect(adapter.createGroup!('Big Group', tooMany)).rejects.toThrow(/1024/);
      expect(fakeSocket.groupCreate).not.toHaveBeenCalled();
    });

    it('returns droppedParticipants + invite link when verify shows missing members', async () => {
      // Platform returns fewer participants than requested
      fakeSocket.groupMetadata.mockResolvedValueOnce({
        id: '120363999999@g.us',
        subject: 'Test Group',
        participants: [{ id: '5585999000000@s.whatsapp.net' }], // only the bot
      });
      const result = await adapter.createGroup!('Test Group', [
        '5511999000001@s.whatsapp.net',
        '5511999000002@s.whatsapp.net',
      ]);
      expect(result.droppedParticipants?.length).toBeGreaterThan(0);
      expect(result.inviteLink).toMatch(/ABCDEFGHIJ/);
    });
  });

  describe('lookupPhoneJid', () => {
    it('exposes lookupPhoneJid on the adapter', () => {
      expect(typeof adapter.lookupPhoneJid).toBe('function');
    });

    it('returns the JID when sock.onWhatsApp confirms registration', async () => {
      const jid = await adapter.lookupPhoneJid!('+5511999000001');
      expect(fakeSocket.onWhatsApp).toHaveBeenCalled();
      expect(jid).toBe('5511999000001@s.whatsapp.net');
    });

    it('returns null when sock.onWhatsApp says not registered', async () => {
      fakeSocket.onWhatsApp.mockResolvedValueOnce([{ exists: false }]);
      const jid = await adapter.lookupPhoneJid!('+5511999000099');
      expect(jid).toBeNull();
    });

    it('returns null when phone normalizes to empty', async () => {
      const jid = await adapter.lookupPhoneJid!('not-a-phone');
      expect(jid).toBeNull();
      expect(fakeSocket.onWhatsApp).not.toHaveBeenCalled();
    });
  });

  describe('resolvePhoneJid', () => {
    it('exposes resolvePhoneJid on the adapter', () => {
      expect(typeof adapter.resolvePhoneJid).toBe('function');
    });

    it('constructs <digits>@s.whatsapp.net without platform round-trip', async () => {
      const jid = await adapter.resolvePhoneJid!('+5511999000001');
      expect(jid).toBe('5511999000001@s.whatsapp.net');
      expect(fakeSocket.onWhatsApp).not.toHaveBeenCalled();
    });

    it('throws when phone normalizes to empty', async () => {
      await expect(adapter.resolvePhoneJid!('not-a-phone')).rejects.toThrow();
    });
  });
});
