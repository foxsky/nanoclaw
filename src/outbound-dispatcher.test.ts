import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let tmpDir: string;
let dbPath: string;

vi.mock('./config.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-outbound-'));
  return {
    ASSISTANT_NAME: 'Case',
    DATA_DIR: dir,
    STORE_DIR: dir,
  };
});

async function freshDb() {
  const cfg = await import('./config.js');
  tmpDir = cfg.DATA_DIR;
  dbPath = path.join(tmpDir, 'messages.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  return dbMod;
}

describe('outbound_messages durable queue', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    try {
      if (tmpDir && fs.existsSync(tmpDir))
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('enqueues and reads back pending rows in FIFO order', async () => {
    const db = await freshDb();
    const id1 = db.enqueueOutbound({
      chatJid: '111@g.us',
      groupFolder: 'a',
      text: 'first',
      senderLabel: 'Case',
      source: 'user',
    });
    const id2 = db.enqueueOutbound({
      chatJid: '222@g.us',
      groupFolder: 'b',
      text: 'second',
      senderLabel: null,
      source: 'task',
    });
    const pending = db.getPendingOutbound();
    expect(pending).toHaveLength(2);
    expect(pending[0].id).toBe(id1);
    expect(pending[1].id).toBe(id2);
    expect(db.countPendingOutbound()).toBe(2);
  });

  it('markOutboundSent removes row from pending set', async () => {
    const db = await freshDb();
    const id = db.enqueueOutbound({
      chatJid: '1@g.us',
      groupFolder: 'a',
      text: 't',
      senderLabel: null,
      source: 'user',
      triggerTurnId: 'turn-1',
    });
    db.markOutboundSent(id, {
      messageId: 'msg-out-1',
      timestamp: '2026-04-19T12:00:00.000Z',
    });
    expect(db.countPendingOutbound()).toBe(0);
    expect(db.getPendingOutbound()).toHaveLength(0);
    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        `SELECT trigger_turn_id, delivered_message_id, delivered_message_timestamp
         FROM outbound_messages
         WHERE id = ?`,
      )
      .get(id) as {
        trigger_turn_id: string | null;
        delivered_message_id: string | null;
        delivered_message_timestamp: string | null;
      };
    raw.close();
    expect(row).toEqual({
      trigger_turn_id: 'turn-1',
      delivered_message_id: 'msg-out-1',
      delivered_message_timestamp: '2026-04-19T12:00:00.000Z',
    });
  });

  it('abandons a row after N failed attempts', async () => {
    const db = await freshDb();
    const id = db.enqueueOutbound({
      chatJid: '1@g.us',
      groupFolder: 'a',
      text: 't',
      senderLabel: null,
      source: 'user',
    });
    for (let i = 0; i < 2; i++) {
      const r = db.markOutboundAttemptFailed(id, 'boom', 3);
      expect(r.abandoned).toBe(false);
      expect(r.attempts).toBe(i + 1);
    }
    const final = db.markOutboundAttemptFailed(id, 'boom', 3);
    expect(final.abandoned).toBe(true);
    expect(final.attempts).toBe(3);
    expect(db.countPendingOutbound()).toBe(0); // abandoned rows excluded
  });

  it('dispatcher delivers pending rows through getChannel', async () => {
    const db = await freshDb();
    db.enqueueOutbound({
      chatJid: 'x@g.us',
      groupFolder: 'a',
      text: 'hello',
      senderLabel: 'Case',
      source: 'user',
      triggerTurnId: 'turn-123',
    });
    const sent: Array<{ jid: string; text: string; sender?: string }> = [];
    const channel = {
      sendMessageWithReceipt: vi.fn(async (
        jid: string,
        text: string,
        sender?: string,
      ) => {
        sent.push({ jid, text, sender });
        return {
          messageId: 'wa-msg-123',
          timestamp: '2026-04-19T12:05:00.000Z',
        };
      }),
    } as any;
    const { OutboundDispatcher } = await import('./outbound-dispatcher.js');
    const dispatcher = new OutboundDispatcher({ getChannel: () => channel });
    const result = await dispatcher.drain(2000);
    expect(result.drained).toBe(true);
    expect(sent).toEqual([{ jid: 'x@g.us', text: 'hello', sender: 'Case' }]);
    expect(db.countPendingOutbound()).toBe(0);
    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        `SELECT trigger_turn_id, delivered_message_id
         FROM outbound_messages
         WHERE chat_jid = 'x@g.us'`,
      )
      .get() as { trigger_turn_id: string | null; delivered_message_id: string | null };
    raw.close();
    expect(row).toEqual({
      trigger_turn_id: 'turn-123',
      delivered_message_id: 'wa-msg-123',
    });
  });

  it('dispatcher leaves rows pending when getChannel returns null', async () => {
    const db = await freshDb();
    db.enqueueOutbound({
      chatJid: 'x@g.us',
      groupFolder: 'a',
      text: 'hello',
      senderLabel: null,
      source: 'user',
    });
    const { OutboundDispatcher } = await import('./outbound-dispatcher.js');
    const dispatcher = new OutboundDispatcher({ getChannel: () => null });
    const result = await dispatcher.drain(500);
    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(1);
    // Row still pending, no attempt recorded (channel wasn't available).
    const rows = db.getPendingOutbound();
    expect(rows[0].attempts).toBe(0);
  });

  it('bounds a hung sendMessage so drain respects its deadline', async () => {
    const db = await freshDb();
    db.enqueueOutbound({
      chatJid: 'x@g.us',
      groupFolder: 'a',
      text: 'hello',
      senderLabel: null,
      source: 'user',
    });
    // Channel whose sendMessage never resolves — the legitimate shutdown
    // hazard Codex flagged: one stuck transport call must not hold drain
    // past its deadline.
    const channel = {
      sendMessage: () => new Promise(() => {}),
    } as any;
    const { OutboundDispatcher } = await import('./outbound-dispatcher.js');
    const dispatcher = new OutboundDispatcher({ getChannel: () => channel });
    const t0 = Date.now();
    const result = await dispatcher.drain(3000);
    const elapsed = Date.now() - t0;
    // drain deadline is 3000ms; per-send timeout is 5000ms. The deadline is
    // checked between ticks, not mid-send, so worst-case elapsed is
    // roughly deadline + SEND_TIMEOUT_MS. Bound it generously: the
    // critical property is that drain returns in bounded time even with a
    // permanently stuck transport, not a precise ceiling.
    expect(elapsed).toBeLessThan(10000);
    expect(result.drained).toBe(false);
    const row = db.getPendingOutbound()[0];
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    expect(row.last_error).toMatch(/timed out/i);
  }, 20000);

  it('a full batch of hung rows does not hold drain past budget', async () => {
    // Codex second-round finding: tick() processes up to DISPATCH_BATCH
    // rows sequentially. Without a per-row deadline check, 25 hung sends
    // at SEND_TIMEOUT_MS each would keep drain() blocked for 125s even
    // with a 20s overall budget — long past systemd's stop timeout.
    const db = await freshDb();
    for (let i = 0; i < 25; i++) {
      db.enqueueOutbound({
        chatJid: `x${i}@g.us`,
        groupFolder: 'a',
        text: `hung-${i}`,
        senderLabel: null,
        source: 'user',
      });
    }
    const channel = {
      sendMessage: () => new Promise(() => {}),
    } as any;
    const { OutboundDispatcher } = await import('./outbound-dispatcher.js');
    const dispatcher = new OutboundDispatcher({ getChannel: () => channel });
    const t0 = Date.now();
    const result = await dispatcher.drain(3000);
    const elapsed = Date.now() - t0;
    // Worst case: drain deadline (3s) + one last in-flight send's
    // remaining budget (~5s). Anything near 25*5=125s would be a bug.
    expect(elapsed).toBeLessThan(10000);
    expect(result.drained).toBe(false);
    // At least some rows got an attempt before the deadline fired.
    const rows = db.getPendingOutbound(30);
    const withAttempts = rows.filter((r) => r.attempts > 0);
    expect(withAttempts.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('boot recovery: pending rows survive restart', async () => {
    const db = await freshDb();
    db.enqueueOutbound({
      chatJid: 'r@g.us',
      groupFolder: 'a',
      text: 'survived',
      senderLabel: null,
      source: 'user',
    });

    // Simulate restart: close existing handle, reopen via a raw SQLite connection
    // to confirm rows are durable on disk (no in-memory buffering).
    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        `SELECT text FROM outbound_messages WHERE sent_at IS NULL AND abandoned_at IS NULL`,
      )
      .get() as { text: string };
    raw.close();
    expect(row.text).toBe('survived');
  });
});
