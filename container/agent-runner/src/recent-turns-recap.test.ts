import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRecentVerbatimTurns } from './recent-turns-recap.js';

function setupDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-test-'));
  const dbPath = path.join(dir, 'messages.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  db.close();
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function insertMessages(
  dbPath: string,
  rows: Array<{
    id: string;
    chat_jid: string;
    sender?: string;
    sender_name?: string;
    content: string;
    timestamp: string;
    is_from_me: 0 | 1;
    is_bot_message?: 0 | 1;
  }>,
) {
  const db = new Database(dbPath);
  const stmt = db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      r.chat_jid,
      r.sender ?? null,
      r.sender_name ?? null,
      r.content,
      r.timestamp,
      r.is_from_me,
      r.is_bot_message ?? 0,
    );
  }
  db.close();
}

describe('getRecentVerbatimTurns', () => {
  let env: { dbPath: string; cleanup: () => void };

  beforeEach(() => {
    env = setupDb();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('returns null when messages.db is missing', () => {
    const out = getRecentVerbatimTurns('chat@g.us', {
      messagesDbPath: '/nonexistent/path.db',
    });
    expect(out).toBeNull();
  });

  it('returns null when chatJid is empty', () => {
    insertMessages(env.dbPath, [
      {
        id: 'm1',
        chat_jid: 'chat@g.us',
        sender_name: 'Alice',
        content: 'hello',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        is_from_me: 0,
      },
    ]);
    const out = getRecentVerbatimTurns('', {
      messagesDbPath: env.dbPath,
    });
    expect(out).toBeNull();
  });

  it('returns null when no messages match the time window', () => {
    insertMessages(env.dbPath, [
      {
        id: 'm1',
        chat_jid: 'chat@g.us',
        sender_name: 'Alice',
        content: 'old message',
        timestamp: new Date(Date.now() - 30 * 60_000).toISOString(),
        is_from_me: 0,
      },
    ]);
    const out = getRecentVerbatimTurns('chat@g.us', {
      messagesDbPath: env.dbPath,
      maxAgeMinutes: 15,
    });
    expect(out).toBeNull();
  });

  it('renders user + bot exchange in chronological order', () => {
    const now = Date.now();
    insertMessages(env.dbPath, [
      {
        id: 'm1',
        chat_jid: 'chat@g.us',
        sender_name: 'Thiago',
        content: 'Despachar SEI informando em produção e treinamento',
        timestamp: new Date(now - 6 * 60_000).toISOString(),
        is_from_me: 0,
      },
      {
        id: 'm2',
        chat_jid: 'chat@g.us',
        sender_name: 'Bot',
        content: 'Tarefa criada T19 — Despachar SEI...',
        timestamp: new Date(now - 5 * 60_000).toISOString(),
        is_from_me: 1,
        is_bot_message: 1,
      },
      {
        id: 'm3',
        chat_jid: 'chat@g.us',
        sender_name: 'Thiago',
        content: 'Essa tarefa faz parte do projeto Estágio Probatório',
        timestamp: new Date(now - 2 * 60_000).toISOString(),
        is_from_me: 0,
      },
      {
        id: 'm4',
        chat_jid: 'chat@g.us',
        sender_name: 'Bot',
        content: 'Não encontrei nenhum projeto com esse nome. Deseja que eu crie um?',
        timestamp: new Date(now - 90_000).toISOString(),
        is_from_me: 1,
        is_bot_message: 1,
      },
    ]);
    const out = getRecentVerbatimTurns('chat@g.us', {
      messagesDbPath: env.dbPath,
      maxAgeMinutes: 15,
    })!;
    expect(out).toContain('--- Recent turns');
    // Chronological order: oldest first
    const idxThiagoFirst = out.indexOf('Despachar SEI');
    const idxBotFirst = out.indexOf('Tarefa criada T19');
    const idxThiagoSecond = out.indexOf('Estágio Probatório');
    const idxBotOffer = out.indexOf('Deseja que eu crie um?');
    expect(idxThiagoFirst).toBeGreaterThan(0);
    expect(idxBotFirst).toBeGreaterThan(idxThiagoFirst);
    expect(idxThiagoSecond).toBeGreaterThan(idxBotFirst);
    expect(idxBotOffer).toBeGreaterThan(idxThiagoSecond);
    // Roles labeled correctly
    expect(out).toMatch(/Thiago: Despachar SEI/);
    expect(out).toMatch(/Bot: Tarefa criada T19/);
  });

  it('excludes the message currently being processed via explicit excludeFrom (strict less-than)', () => {
    // The message currently being processed lands in messages.db before
    // the container spawn (host-side storeMessage). Its sender-claimed
    // timestamp can be older than now-5s under WhatsApp delivery latency,
    // so the wallclock heuristic alone is not enough — callers MUST pass
    // the current message's timestamp via excludeFrom.
    const now = Date.now();
    const incomingTimestamp = new Date(now - 30_000).toISOString();
    insertMessages(env.dbPath, [
      {
        id: 'm1',
        chat_jid: 'chat@g.us',
        sender_name: 'Alice',
        content: 'previous message',
        timestamp: new Date(now - 90_000).toISOString(),
        is_from_me: 0,
      },
      {
        id: 'm2',
        chat_jid: 'chat@g.us',
        sender_name: 'Alice',
        content: 'message currently being processed',
        timestamp: incomingTimestamp,
        is_from_me: 0,
      },
    ]);
    const out = getRecentVerbatimTurns('chat@g.us', {
      messagesDbPath: env.dbPath,
      maxAgeMinutes: 15,
      excludeFrom: incomingTimestamp,
    })!;
    expect(out).toContain('previous message');
    expect(out).not.toContain('message currently being processed');
  });

  it('labels messages by is_bot_message=1 (not is_from_me=1)', () => {
    // is_from_me=1 covers ANY echo from the linked phone number,
    // including messages typed by a human operator (when
    // ASSISTANT_HAS_OWN_NUMBER=false). is_bot_message=1 is the precise
    // signal that the bot generated the message.
    const now = Date.now();
    insertMessages(env.dbPath, [
      {
        id: 'm1',
        chat_jid: 'chat@g.us',
        sender_name: 'Bot Account',
        content: 'auto-generated bot reply',
        timestamp: new Date(now - 60_000).toISOString(),
        is_from_me: 1,
        is_bot_message: 1,
      },
      {
        id: 'm2',
        chat_jid: 'chat@g.us',
        sender_name: 'Operator',
        content: 'manual operator typing from shared phone',
        timestamp: new Date(now - 30_000).toISOString(),
        is_from_me: 1,
        is_bot_message: 0,
      },
    ]);
    const out = getRecentVerbatimTurns('chat@g.us', {
      messagesDbPath: env.dbPath,
    })!;
    // Bot-generated message labeled "Bot"
    expect(out).toMatch(/Bot: auto-generated bot reply/);
    // Operator message labeled by sender_name, NOT "Bot"
    expect(out).toMatch(/Operator: manual operator typing/);
  });

  it('truncates long content to maxCharsPerLine with ellipsis', () => {
    const long = 'A'.repeat(500);
    insertMessages(env.dbPath, [
      {
        id: 'm1',
        chat_jid: 'chat@g.us',
        sender_name: 'Alice',
        content: long,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        is_from_me: 0,
      },
    ]);
    const out = getRecentVerbatimTurns('chat@g.us', {
      messagesDbPath: env.dbPath,
      maxCharsPerLine: 50,
    })!;
    expect(out).toContain('…');
    // 50 As + ellipsis, no full 500-char line
    expect(out).not.toMatch(/A{200}/);
  });

  it('caps the number of turns at maxTurns (most recent kept)', () => {
    const now = Date.now();
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      chat_jid: 'chat@g.us',
      sender_name: 'Alice',
      content: `message ${i}`,
      // i=0 oldest, i=19 newest (within window)
      timestamp: new Date(now - (20 - i) * 30_000).toISOString(),
      is_from_me: 0 as 0,
    }));
    insertMessages(env.dbPath, rows);
    const out = getRecentVerbatimTurns('chat@g.us', {
      messagesDbPath: env.dbPath,
      maxAgeMinutes: 15,
      maxTurns: 5,
    })!;
    // Should contain the 5 most recent (15..19) and NOT the older (0..14)
    expect(out).toContain('message 19');
    expect(out).toContain('message 15');
    expect(out).not.toContain('message 14');
    expect(out).not.toContain('message 5');
  });

  it('isolates by chat_jid (does not leak messages from other groups)', () => {
    const now = Date.now();
    insertMessages(env.dbPath, [
      {
        id: 'm1',
        chat_jid: 'chat-A@g.us',
        sender_name: 'Alice',
        content: 'in chat A',
        timestamp: new Date(now - 60_000).toISOString(),
        is_from_me: 0,
      },
      {
        id: 'm2',
        chat_jid: 'chat-B@g.us',
        sender_name: 'Bob',
        content: 'in chat B',
        timestamp: new Date(now - 60_000).toISOString(),
        is_from_me: 0,
      },
    ]);
    const out = getRecentVerbatimTurns('chat-A@g.us', {
      messagesDbPath: env.dbPath,
    })!;
    expect(out).toContain('in chat A');
    expect(out).not.toContain('in chat B');
  });

  it('falls back from sender_name to sender to "User"', () => {
    insertMessages(env.dbPath, [
      {
        id: 'm1',
        chat_jid: 'chat@g.us',
        sender: '5598765432@s.whatsapp.net',
        content: 'no sender_name',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        is_from_me: 0,
      },
      {
        id: 'm2',
        chat_jid: 'chat@g.us',
        content: 'no sender at all',
        timestamp: new Date(Date.now() - 30_000).toISOString(),
        is_from_me: 0,
      },
    ]);
    const out = getRecentVerbatimTurns('chat@g.us', {
      messagesDbPath: env.dbPath,
    })!;
    expect(out).toContain('5598765432@s.whatsapp.net: no sender_name');
    expect(out).toContain('User: no sender at all');
  });
});
