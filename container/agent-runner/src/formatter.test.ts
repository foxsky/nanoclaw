/**
 * v1-parity tests for formatter behavior.
 *
 * Port of src/v1/formatting.test.ts (at commit 27c5220, parent of the v1
 * deletion commit 86becf8). Covers: context timezone header, reply_to +
 * quoted_message rendering, XML escaping, and stripInternalTags.
 *
 * Timestamp-format assertions use `formatLocalTime()` output format, which
 * is host locale-dependent for decorators (month abbr, "," separator) but
 * stable for the numeric parts we assert on (hour, minute, year).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { formatMessages, stripInternalTags } from './formatter.js';
import { TIMEZONE } from './timezone.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { timestamp?: string },
) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, timestamp, JSON.stringify(content));
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the <messages> block', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const msgsIdx = result.indexOf('<messages>');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(msgsIdx).toBeGreaterThan(ctxIdx);
  });

  it('includes replay date context when Phase 3 sets a historical now', () => {
    const previous = process.env.NANOCLAW_PHASE_REPLAY_NOW;
    process.env.NANOCLAW_PHASE_REPLAY_NOW = '2026-05-04T13:12:29.000Z';
    try {
      const result = formatMessages([]);
      expect(result).toContain('now="2026-05-04T13:12:29.000Z"');
      expect(result).toContain('today="2026-05-04"');
      expect(result).toContain('weekday="segunda-feira"');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_PHASE_REPLAY_NOW;
      else process.env.NANOCLAW_PHASE_REPLAY_NOW = previous;
    }
  });
});

describe('Phase 2 replay raw prompt', () => {
  it('uses the recorded v1 prompt verbatim only when explicitly enabled', () => {
    const previous = process.env.NANOCLAW_PHASE2_RAW_PROMPT;
    process.env.NANOCLAW_PHASE2_RAW_PROMPT = '1';
    try {
      const rawPrompt = '--- Recent conversation history ---\n<context timezone="America/Fortaleza" />';
      insertMessage('m1', 'chat', { sender: 'Alice', text: 'ignored', phase2RawPrompt: rawPrompt });
      expect(formatMessages(getPendingMessages())).toBe(rawPrompt);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_PHASE2_RAW_PROMPT;
      else process.env.NANOCLAW_PHASE2_RAW_PROMPT = previous;
    }
  });

  it('adds replay date context around raw prompts only for Phase 3 historical replay', () => {
    const previousRaw = process.env.NANOCLAW_PHASE2_RAW_PROMPT;
    const previousNow = process.env.NANOCLAW_PHASE_REPLAY_NOW;
    process.env.NANOCLAW_PHASE2_RAW_PROMPT = '1';
    process.env.NANOCLAW_PHASE_REPLAY_NOW = '2026-05-12T13:59:45.000Z';
    try {
      const rawPrompt = '<messages><message sender="Alice">Criar tarefa. Prazo 14/05</message></messages>';
      insertMessage('m1', 'chat', { sender: 'Alice', text: 'ignored', phase2RawPrompt: rawPrompt });
      const result = formatMessages(getPendingMessages());
      expect(result).toContain('now="2026-05-12T13:59:45.000Z"');
      expect(result).toContain('today="2026-05-12"');
      expect(result.endsWith(rawPrompt)).toBe(true);
    } finally {
      if (previousRaw === undefined) delete process.env.NANOCLAW_PHASE2_RAW_PROMPT;
      else process.env.NANOCLAW_PHASE2_RAW_PROMPT = previousRaw;
      if (previousNow === undefined) delete process.env.NANOCLAW_PHASE_REPLAY_NOW;
      else process.env.NANOCLAW_PHASE_REPLAY_NOW = previousNow;
    }
  });

  it('escapes the same field in normal production formatting', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'visible', phase2RawPrompt: '<raw>' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('visible</message>');
    expect(result).not.toBe('<raw>');
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply_to and quoted_message when no reply context', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe(
      'The answer is 42',
    );
  });
});
