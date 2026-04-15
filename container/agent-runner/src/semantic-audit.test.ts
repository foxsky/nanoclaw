import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildPrompt,
  callOllama,
  deriveContextHeader,
  extractScheduledAtValue,
  parseOllamaResponse,
  runSemanticAudit,
} from './semantic-audit.js';
import type {
  QualifyingMutation,
  FactCheckContext,
  SemanticDeviation,
} from './semantic-audit.js';

describe('semantic-audit type surface', () => {
  it('QualifyingMutation carries task_history row + extracted value', () => {
    const m: QualifyingMutation = {
      taskId: 'M1',
      boardId: 'board-seci-taskflow',
      action: 'updated',
      by: 'giovanni',
      at: '2026-04-14T11:04:11.450Z',
      details: '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}',
      fieldKind: 'scheduled_at',
      extractedValue: '2026-04-17T11:00',
    };
    expect(m.fieldKind).toBe('scheduled_at');
  });

  it('FactCheckContext carries prompt inputs', () => {
    const c: FactCheckContext = {
      userMessage: 'alterar M1 para quinta-feira 11h',
      userDisplayName: 'Carlos Giovanni',
      messageTimestamp: '2026-04-14T11:03:37.000Z',
      boardTimezone: 'America/Fortaleza',
      headerToday: '2026-04-14',
      headerWeekday: 'terça-feira',
    };
    expect(c.headerToday).toBe('2026-04-14');
  });

  it('SemanticDeviation is the full output shape', () => {
    const d: SemanticDeviation = {
      taskId: 'M1',
      boardId: 'board-seci-taskflow',
      fieldKind: 'scheduled_at',
      at: '2026-04-14T11:04:11.450Z',
      by: 'giovanni',
      userMessage: 'alterar M1 para quinta-feira 11h',
      storedValue: '2026-04-17T11:00',
      intentMatches: false,
      deviation: 'User said quinta (Thursday = 16/04) but stored 17/04 (Friday)',
      confidence: 'high',
      rawResponse: '{"intent_matches":false,...}',
    };
    expect(d.intentMatches).toBe(false);
  });
});

describe('extractScheduledAtValue', () => {
  it('parses the canonical reagendada string', () => {
    const r = extractScheduledAtValue(
      '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}',
    );
    expect(r).toBe('2026-04-17T11:00');
  });

  it('parses single-digit day/month with zero-padding', () => {
    const r = extractScheduledAtValue(
      '{"changes":["Reunião reagendada para 3/5/2026 às 8:30"]}',
    );
    expect(r).toBe('2026-05-03T08:30');
  });

  it('returns null when no reagendada phrase present', () => {
    const r = extractScheduledAtValue('{"changes":["Prazo definido: 2026-04-15"]}');
    expect(r).toBeNull();
  });

  it('returns null on malformed details JSON', () => {
    expect(extractScheduledAtValue('not json{')).toBeNull();
  });

  it('returns null on empty/undefined input', () => {
    expect(extractScheduledAtValue('')).toBeNull();
  });
});

describe('deriveContextHeader', () => {
  it('gives today + pt-BR weekday for a Fortaleza timestamp', () => {
    // 2026-04-14T11:03:37.000Z is 08:03 local in America/Fortaleza (UTC-3) — still Tuesday.
    const h = deriveContextHeader('2026-04-14T11:03:37.000Z', 'America/Fortaleza');
    expect(h).toEqual({ today: '2026-04-14', weekday: 'terça-feira' });
  });

  it('handles a UTC day boundary that sits on the previous local day', () => {
    // 2026-04-15T02:00:00Z is 2026-04-14 23:00 in Fortaleza — still Tuesday.
    const h = deriveContextHeader('2026-04-15T02:00:00.000Z', 'America/Fortaleza');
    expect(h).toEqual({ today: '2026-04-14', weekday: 'terça-feira' });
  });

  it('falls back to UTC on invalid timezone', () => {
    // 2026-04-15T01:00:00Z is still 2026-04-14 22:00 in America/Fortaleza.
    // If fallback incorrectly returned America/Fortaleza, today would be '2026-04-14'.
    // Correct UTC fallback gives '2026-04-15'.
    const h = deriveContextHeader('2026-04-15T01:00:00.000Z', 'Not/A_Zone');
    expect(h.today).toBe('2026-04-15');
    expect(h.weekday).toBe('quarta-feira');
  });

  it('throws RangeError on invalid isoTimestamp', () => {
    expect(() => deriveContextHeader('not a timestamp', 'America/Fortaleza')).toThrow(RangeError);
  });
});

describe('buildPrompt', () => {
  const mutation: QualifyingMutation = {
    taskId: 'M1',
    boardId: 'board-seci-taskflow',
    action: 'updated',
    by: 'giovanni',
    at: '2026-04-14T11:04:11.450Z',
    details: '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}',
    fieldKind: 'scheduled_at',
    extractedValue: '2026-04-17T11:00',
  };

  const context: FactCheckContext = {
    userMessage: 'alterar M1 para quinta-feira 11h',
    userDisplayName: 'Carlos Giovanni',
    messageTimestamp: '2026-04-14T11:03:37.000Z',
    boardTimezone: 'America/Fortaleza',
    headerToday: '2026-04-14',
    headerWeekday: 'terça-feira',
  };

  it('includes the stored value, user message, and context header', () => {
    const p = buildPrompt(mutation, context);
    expect(p).toContain('M1');
    expect(p).toContain('2026-04-17T11:00');
    expect(p).toContain('alterar M1 para quinta-feira 11h');
    expect(p).toContain('2026-04-14');
    expect(p).toContain('terça-feira');
    expect(p).toContain('America/Fortaleza');
  });

  it('asks for fenced JSON output with chain-of-thought reasoning', () => {
    const p = buildPrompt(mutation, context);
    expect(p).toMatch(/intent_matches/);
    expect(p).toMatch(/confidence/);
    expect(p).toMatch(/deviation/);
    expect(p).toMatch(/```json/);
    expect(p).toMatch(/passo a passo/);
    expect(p).toMatch(/dia da semana/);
  });

  it('handles a null userMessage gracefully', () => {
    const p = buildPrompt(mutation, { ...context, userMessage: null });
    expect(p).toContain('(mensagem do usuário não localizada)');
  });
});

describe('parseOllamaResponse', () => {
  it('parses a clean JSON response', () => {
    const r = parseOllamaResponse(
      '{"intent_matches":false,"deviation":"wrong day","confidence":"high"}',
    );
    expect(r).toEqual({
      intentMatches: false,
      deviation: 'wrong day',
      confidence: 'high',
    });
  });

  it('strips surrounding code fences', () => {
    const r = parseOllamaResponse(
      '```json\n{"intent_matches":true,"deviation":null,"confidence":"high"}\n```',
    );
    expect(r).toEqual({
      intentMatches: true,
      deviation: null,
      confidence: 'high',
    });
  });

  it('finds the JSON block when surrounded by prose', () => {
    const r = parseOllamaResponse(
      'Here is the JSON: {"intent_matches":true,"deviation":null,"confidence":"med"} that is all.',
    );
    expect(r?.intentMatches).toBe(true);
    expect(r?.confidence).toBe('med');
  });

  it('returns null on unparseable response', () => {
    expect(parseOllamaResponse('not json at all')).toBeNull();
  });

  it('returns null when confidence is not in the allowed set', () => {
    const r = parseOllamaResponse(
      '{"intent_matches":false,"deviation":"x","confidence":"extreme"}',
    );
    expect(r).toBeNull();
  });

  it('returns null when intent_matches is not boolean', () => {
    const r = parseOllamaResponse(
      '{"intent_matches":"yes","deviation":null,"confidence":"high"}',
    );
    expect(r).toBeNull();
  });
});

describe('callOllama', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the raw response text on 200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '{"intent_matches":false,"deviation":"x","confidence":"high"}' }),
    });
    const r = await callOllama('http://ollama:11434', 'test-model:fake', 'test prompt');
    expect(r).toBe('{"intent_matches":false,"deviation":"x","confidence":"high"}');
  });

  it('returns null when fetch throws', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    const r = await callOllama('http://ollama:11434', 'test-model:fake', 'test');
    expect(r).toBeNull();
  });

  it('returns null on non-OK response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const r = await callOllama('http://ollama:11434', 'test-model:fake', 'test');
    expect(r).toBeNull();
  });

  it('returns null when host is empty (feature off)', async () => {
    const r = await callOllama('', 'test-model:fake', 'test');
    expect(r).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts to /api/generate WITHOUT format=json (CoT prompt + fenced JSON output)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '```json\n{}\n```' }),
    });
    await callOllama('http://ollama:11434', 'test-model:fake', 'hello');
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('http://ollama:11434/api/generate');
    const body = JSON.parse(call[1].body);
    expect(body).toMatchObject({
      model: 'test-model:fake',
      prompt: 'hello',
      stream: false,
    });
    // format: 'json' would force strict JSON-only output, blocking the
    // chain-of-thought reasoning that several models need to compute the
    // weekday from the date. We deliberately omit it.
    expect(body.format).toBeUndefined();
  });
});

import Database from 'better-sqlite3';

function seedAuditDbs() {
  const tf = new Database(':memory:');
  tf.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
    CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
    CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT
    );
    INSERT INTO boards VALUES ('board-seci-taskflow', NULL);
    INSERT INTO board_runtime_config VALUES ('board-seci-taskflow', 'America/Fortaleza');
    INSERT INTO board_people VALUES ('board-seci-taskflow', 'giovanni', 'Carlos Giovanni');
    INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
      ('board-seci-taskflow', 'M1', 'updated', 'giovanni',
       '2026-04-14T11:04:11.450Z',
       '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}');
  `);

  const msg = new Database(':memory:');
  msg.exec(`
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
      content TEXT, timestamp TEXT,
      is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
    INSERT INTO registered_groups VALUES ('120363407@g.us', 'seci-taskflow', 'SECI-SECTI', 1);
    INSERT INTO messages VALUES (
      'msg1', '120363407@g.us', '558688@s.whatsapp.net', 'Carlos Giovanni',
      'alterar M1 para quinta-feira 11h', '2026-04-14T11:03:37.000Z', 0, 0
    );
  `);

  return { tf, msg };
}

describe('runSemanticAudit', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns one deviation for the Giovanni case when Ollama says intent_matches=false', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response:
          '{"intent_matches":false,"deviation":"User said quinta (16/04) but stored 17/04","confidence":"high"}',
      }),
    });

    const { tf, msg } = seedAuditDbs();
    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-14T00:00:00.000Z', endIso: '2026-04-15T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });

    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].taskId).toBe('M1');
    expect(result.deviations[0].intentMatches).toBe(false);
    expect(result.deviations[0].confidence).toBe('high');
    expect(result.deviations[0].userMessage).toContain('quinta-feira');
    expect(result.deviations[0].storedValue).toBe('2026-04-17T11:00');
    expect(result.counters).toMatchObject({ examined: 1, noTrigger: 0, boardMapFail: 0, ollamaFail: 0, parseFail: 0 });

    tf.close();
    msg.close();
  });

  it('returns empty when no qualifying mutations exist', async () => {
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT
      );
      INSERT INTO boards VALUES ('board-empty', NULL);
      INSERT INTO board_runtime_config VALUES ('board-empty', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
    `);
    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-14T00:00:00.000Z', endIso: '2026-04-15T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });
    expect(result.deviations).toEqual([]);
    expect(result.counters.examined).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    tf.close();
    msg.close();
  });

  it('skips a mutation when Ollama returns a malformed response, increments parseFail', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: 'not json' }),
    });
    const { tf, msg } = seedAuditDbs();
    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-14T00:00:00.000Z', endIso: '2026-04-15T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });
    expect(result.deviations).toEqual([]);
    expect(result.counters.examined).toBe(1);
    expect(result.counters.parseFail).toBe(1);
    tf.close();
    msg.close();
  });
});
