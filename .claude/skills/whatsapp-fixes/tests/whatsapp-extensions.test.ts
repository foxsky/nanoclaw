/**
 * Tests for the 3 ChannelAdapter extensions added by whatsapp-fixes:
 *   - createGroup(subject, participants)
 *   - lookupPhoneJid(phone)
 *   - resolvePhoneJid(phone)
 *
 * Per `whatsapp-fixes/modify/src/channels/whatsapp.ts.intent.md`.
 *
 * These tests validate the SHAPE the skill installs (after the modify/ files
 * are applied to a clean upstream/channels install). Until the implementation
 * step lands, ALL tests in this file FAIL — which is the TDD-RED state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks for Baileys (so tests don't hit network) ---

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/wa-fixes-test-store',
  DATA_DIR: '/tmp/wa-fixes-test-data',
  ASSISTANT_NAME: 'TestAgent',
  ASSISTANT_HAS_OWN_NUMBER: false,
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
      },
    },
    user: { id: '1234567890:1@s.whatsapp.net' },
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wa-msg-default' } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    groupCreate: vi
      .fn()
      .mockResolvedValue({ id: '120363999999@g.us', subject: 'Test Group' }),
    groupMetadata: vi.fn().mockResolvedValue({
      id: '120363999999@g.us',
      subject: 'Test Group',
      participants: [
        { id: '1234567890@s.whatsapp.net' },
        { id: '5511999000001@s.whatsapp.net' },
        { id: '5511999000002@s.whatsapp.net' },
      ],
    }),
    groupInviteCode: vi.fn().mockResolvedValue('ABCDEFGHIJ'),
    groupParticipantsUpdate: vi.fn().mockResolvedValue([{ status: 'success' }]),
    onWhatsApp: vi
      .fn()
      .mockResolvedValue([
        { jid: '5511999000001@s.whatsapp.net', exists: true },
      ]),
    end: vi.fn(),
    _ev: ev,
  };
}

let fakeSocket: ReturnType<typeof createFakeSocket>;

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(() => fakeSocket),
  Browsers: { macOS: vi.fn(() => ['macOS', 'Chrome', '']) },
  DisconnectReason: { loggedOut: 401 },
  fetchLatestWaWebVersion: vi
    .fn()
    .mockResolvedValue({ version: [2, 3000, 0] }),
  normalizeMessageContent: vi.fn((c: unknown) => c),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  useMultiFileAuthState: vi
    .fn()
    .mockResolvedValue({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(),
    }),
}));

// --- Adapter import (resolves AFTER skill is applied) ---
//
// In the deployed skill, the modify/<path>.ts files become src/channels/adapter.ts
// and src/channels/whatsapp.ts. Importing the adapter here exercises the
// installed extensions. Until the modify/ files include the 3 method
// implementations, the imports below will type-check but the methods
// will be undefined → tests assert their existence and fail.
import { createWhatsAppAdapter } from '../modify/src/channels/whatsapp.js';

beforeEach(() => {
  fakeSocket = createFakeSocket();
});

describe('whatsapp-fixes ChannelAdapter extensions', () => {
  describe('createGroup', () => {
    it('exposes createGroup on the adapter', () => {
      const adapter = createWhatsAppAdapter();
      expect(typeof adapter.createGroup).toBe('function');
    });

    it('calls sock.groupCreate and returns the new JID + subject', async () => {
      const adapter = createWhatsAppAdapter();
      await adapter.setup({} as never);
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
      const adapter = createWhatsAppAdapter();
      await adapter.setup({} as never);
      const tooMany = Array.from(
        { length: 1024 },
        (_, i) => `551199900${String(i).padStart(4, '0')}@s.whatsapp.net`,
      );
      await expect(adapter.createGroup!('Big Group', tooMany)).rejects.toThrow(
        /1024/,
      );
      expect(fakeSocket.groupCreate).not.toHaveBeenCalled();
    });

    it('returns droppedParticipants when verify shows missing members', async () => {
      const adapter = createWhatsAppAdapter();
      await adapter.setup({} as never);
      // Simulate platform returning fewer participants than requested
      fakeSocket.groupMetadata.mockResolvedValueOnce({
        id: '120363999999@g.us',
        subject: 'Test Group',
        participants: [{ id: '1234567890@s.whatsapp.net' }], // only the bot itself
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
      const adapter = createWhatsAppAdapter();
      expect(typeof adapter.lookupPhoneJid).toBe('function');
    });

    it('returns the JID when sock.onWhatsApp confirms registration', async () => {
      const adapter = createWhatsAppAdapter();
      await adapter.setup({} as never);
      const jid = await adapter.lookupPhoneJid!('+5511999000001');
      expect(fakeSocket.onWhatsApp).toHaveBeenCalled();
      expect(jid).toBe('5511999000001@s.whatsapp.net');
    });

    it('returns null when sock.onWhatsApp says not registered', async () => {
      const adapter = createWhatsAppAdapter();
      await adapter.setup({} as never);
      fakeSocket.onWhatsApp.mockResolvedValueOnce([{ exists: false }]);
      const jid = await adapter.lookupPhoneJid!('+5511999000099');
      expect(jid).toBeNull();
    });

    it('returns null when phone normalizes to empty', async () => {
      const adapter = createWhatsAppAdapter();
      await adapter.setup({} as never);
      const jid = await adapter.lookupPhoneJid!('not-a-phone');
      expect(jid).toBeNull();
      expect(fakeSocket.onWhatsApp).not.toHaveBeenCalled();
    });
  });

  describe('resolvePhoneJid', () => {
    it('exposes resolvePhoneJid on the adapter', () => {
      const adapter = createWhatsAppAdapter();
      expect(typeof adapter.resolvePhoneJid).toBe('function');
    });

    it('constructs <digits>@s.whatsapp.net without platform round-trip', async () => {
      const adapter = createWhatsAppAdapter();
      await adapter.setup({} as never);
      const jid = await adapter.resolvePhoneJid!('+5511999000001');
      expect(jid).toBe('5511999000001@s.whatsapp.net');
      expect(fakeSocket.onWhatsApp).not.toHaveBeenCalled();
    });

    it('throws when phone normalizes to empty', async () => {
      const adapter = createWhatsAppAdapter();
      await adapter.setup({} as never);
      await expect(adapter.resolvePhoneJid!('not-a-phone')).rejects.toThrow();
    });
  });
});
