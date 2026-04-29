import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildPrompt,
  buildResponsePrompt,
  callOllama,
  CASUAL_PATTERN,
  dedupeDeviations,
  deriveContextHeader,
  extractScheduledAtValue,
  parseOllamaResponse,
  runResponseAudit,
  runSemanticAudit,
  writeDryRunLog,
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
      sourceTurnId: 'turn-123',
      sourceMessageIds: ['msg-1', 'msg-2'],
      responseMessageId: null,
      storedValue: '2026-04-17T11:00',
      responsePreview: null,
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
    // think: false disables the separate <think>...</think> hidden
    // reasoning block on newer Qwen3/glm/deepseek-v4 cloud models —
    // visible prose reasoning in the response is preserved (the model
    // still derives weekdays in the body), but latency drops 4-12×
    // because the hidden CoT channel is suppressed. Per 2026-04-28
    // summarization shootout. Honored by Ollama 0.6+; older versions
    // and non-thinking models silently ignore.
    expect(body.think).toBe(false);
  });
});

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
    // storedValue now carries the tz annotation — `annotateUtcTimestamps`
    // labels Z-less ISO as "already local TZ" so classifiers don't guess.
    expect(result.deviations[0].storedValue).toContain('2026-04-17T11:00');
    expect(result.deviations[0].storedValue).toContain('already local');
    expect(result.counters).toMatchObject({ examined: 1, noTrigger: 0, boardMapFail: 0, ollamaFail: 0, parseFail: 0, skippedCasual: 0, skippedNoResponse: 0 });

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

  it('increments noTrigger when no user message exists in the 10-min window', async () => {
    // Giovanni is registered but the seed has no message in the window
    // before 2026-04-14T11:04:11. Use a mutation with a board_people match
    // but outside the message window.
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);
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
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363407@g.us', 'seci-taskflow', 'SECI-SECTI', 1);
      -- Message is BEFORE the 10-min window (mutation at 11:04:11, window = 10:54:11..11:04:11)
      INSERT INTO messages VALUES ('m-stale', '120363407@g.us', '558688@s.whatsapp.net', 'Carlos Giovanni', 'some old msg', '2026-04-14T10:00:00.000Z', 0, 0);
    `);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}' }),
    });
    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-14T00:00:00.000Z', endIso: '2026-04-15T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });
    expect(result.counters.examined).toBe(1);
    expect(result.counters.noTrigger).toBe(1);
    expect(result.counters.boardMapFail).toBe(0);
    // Mutation audit now SKIPS the classifier when userMessage is null —
    // no user message means no evidence, so emitting a deviation was an
    // FP source (dryrun 2026-04-19: 14 of 33 FPs were these leaks).
    expect(result.deviations).toEqual([]);
    tf.close();
    msg.close();
  });

  it('increments boardMapFail when board cannot resolve to a group jid', async () => {
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);
      INSERT INTO boards VALUES ('board-orphan', NULL);
      INSERT INTO board_runtime_config VALUES ('board-orphan', 'America/Fortaleza');
      INSERT INTO board_people VALUES ('board-orphan', 'giovanni', 'Carlos Giovanni');
      INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
        ('board-orphan', 'M1', 'updated', 'giovanni',
         '2026-04-14T11:04:11.450Z',
         '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      -- No registered_groups row for folder 'orphan' — the two-step lookup fails.
    `);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}' }),
    });
    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-14T00:00:00.000Z', endIso: '2026-04-15T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });
    expect(result.counters.examined).toBe(1);
    expect(result.counters.boardMapFail).toBe(1);
    expect(result.counters.noTrigger).toBe(0);
    // boardMapFail prevents userMessage resolution → classifier skipped,
    // no deviation emitted (same rationale as the noTrigger test above).
    expect(result.deviations).toEqual([]);
    tf.close();
    msg.close();
  });

  it('covers due_date mutations (Prazo definido)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);
      INSERT INTO boards VALUES ('board-seci-taskflow', NULL);
      INSERT INTO board_runtime_config VALUES ('board-seci-taskflow', 'America/Fortaleza');
      INSERT INTO board_people VALUES ('board-seci-taskflow', 'lucas', 'Lucas Batista');
      INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
        ('board-seci-taskflow', 'P11.20', 'updated', 'lucas',
         '2026-04-15T11:38:06.000Z',
         '{"changes":["Prazo definido: 2026-04-15"]}');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363407@g.us', 'seci-taskflow', 'SECI', 1);
      INSERT INTO messages VALUES ('m1', '120363407@g.us', '558@s.whatsapp.net', 'Lucas Batista', 'alterar prazo para 15/04', '2026-04-15T11:37:00.000Z', 0, 0);
    `);

    const result = await runSemanticAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].fieldKind).toBe('due_date');
    expect(result.deviations[0].storedValue).toContain('Prazo definido');
    tf.close(); msg.close();
  });

  it('covers reassignment mutations', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);
      INSERT INTO boards VALUES ('board-setec', NULL);
      INSERT INTO board_runtime_config VALUES ('board-setec', 'America/Fortaleza');
      INSERT INTO board_people VALUES ('board-setec', 'rafael', 'RAFAEL AMARAL CHAVES');
      INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
        ('board-setec', 'T24', 'reassigned', 'rafael',
         '2026-04-15T18:04:54.000Z',
         '{"from_assignee":"rafael","to_assignee":"joao-evangelista"}');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363408@g.us', 'setec', 'SETEC', 1);
      INSERT INTO messages VALUES ('m1', '120363408@g.us', '558@s.whatsapp.net', 'RAFAEL AMARAL CHAVES', 'atribuir para joão', '2026-04-15T18:04:41.000Z', 0, 0);
    `);

    const result = await runSemanticAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].fieldKind).toBe('assignee');
    expect(result.deviations[0].storedValue).toContain('joao-evangelista');
    tf.close(); msg.close();
  });

  it('covers created mutations with scheduled_at', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);
      INSERT INTO boards VALUES ('board-thiago', NULL);
      INSERT INTO board_runtime_config VALUES ('board-thiago', 'America/Fortaleza');
      INSERT INTO board_people VALUES ('board-thiago', 'thiago', 'Thiago Carvalho');
      INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
        ('board-thiago', 'M20', 'created', 'thiago',
         '2026-04-15T14:03:43.000Z',
         '{"type":"meeting","title":"Apresentação final","scheduled_at":"2026-04-23T11:00:00.000Z"}');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363423@g.us', 'thiago', 'Thiago', 1);
      INSERT INTO messages VALUES ('m1', '120363423@g.us', '558@s.whatsapp.net', 'Thiago Carvalho', 'agendar reunião apresentação final 23/04 8h', '2026-04-15T14:03:13.000Z', 0, 0);
    `);

    const result = await runSemanticAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].fieldKind).toBe('scheduled_at');
    expect(result.deviations[0].storedValue).toContain('scheduled_at');
    tf.close(); msg.close();
  });

  it('resolves mutation triggers via secondary board_groups chat jid', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        group_jid TEXT,
        group_folder TEXT,
        parent_board_id TEXT
      );
      CREATE TABLE board_groups (
        board_id TEXT,
        group_jid TEXT,
        group_folder TEXT,
        PRIMARY KEY (board_id, group_jid)
      );
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);
      INSERT INTO boards VALUES ('board-multi-chat', 'PRIMARY@g.us', 'primary-folder', NULL);
      INSERT INTO board_groups VALUES ('board-multi-chat', '120363499@g.us', 'secondary-folder');
      INSERT INTO board_runtime_config VALUES ('board-multi-chat', 'America/Fortaleza');
      INSERT INTO board_people VALUES ('board-multi-chat', 'alice', 'Alice Example');
      INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
        ('board-multi-chat', 'M1', 'updated', 'alice',
         '2026-04-15T11:04:11.450Z',
         '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}');
    `);

    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363499@g.us', 'secondary-folder', 'Secondary', 1);
      INSERT INTO messages VALUES (
        'm1', '120363499@g.us', '558@s.whatsapp.net', 'Alice Example',
        'mudar a reunião para quinta às 11h', '2026-04-15T11:03:30.000Z', 0, 0
      );
    `);

    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });

    expect(result.counters.boardMapFail).toBe(0);
    expect(result.counters.noTrigger).toBe(0);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].userMessage).toContain('quinta às 11h');
    tf.close(); msg.close();
  });

  it('prefers exact trigger_turn_id correlation over the legacy 10-minute sender-name window', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        group_jid TEXT,
        group_folder TEXT,
        parent_board_id TEXT
      );
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT,
        task_id TEXT,
        action TEXT,
        by TEXT,
        at TEXT,
        details TEXT,
        trigger_turn_id TEXT
      );
      INSERT INTO boards VALUES ('board-exact-turn', '120363599@g.us', 'exact-turn-group', NULL);
      INSERT INTO board_runtime_config VALUES ('board-exact-turn', 'America/Fortaleza');
      INSERT INTO board_people VALUES ('board-exact-turn', 'alice', 'Alice Example');
      INSERT INTO task_history (board_id, task_id, action, by, at, details, trigger_turn_id) VALUES
        ('board-exact-turn', 'M1', 'updated', 'alice',
         '2026-04-15T11:04:11.450Z',
         '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}',
         'turn-123');
    `);

    const msg = new Database(':memory:');
    msg.exec(`
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
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      CREATE TABLE agent_turn_messages (
        turn_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_chat_jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        message_timestamp TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (turn_id, ordinal)
      );
      INSERT INTO registered_groups VALUES ('120363599@g.us', 'exact-turn-group', 'Exact Turn', 1);
      INSERT INTO messages VALUES
        ('legacy-window-hit', '120363599@g.us', 'alice@s.whatsapp.net', 'Alice Example',
         'mensagem errada que só bate pela janela', '2026-04-15T11:04:00.000Z', 0, 0),
        ('turn-msg-1', '120363599@g.us', 'alice@s.whatsapp.net', 'Alice Example',
         'primeiro pedido', '2026-04-15T11:03:10.000Z', 0, 0),
        ('turn-msg-2', '120363599@g.us', 'alice@s.whatsapp.net', 'Alice Example',
         'na verdade quinta às 11h', '2026-04-15T11:03:20.000Z', 0, 0);
      INSERT INTO agent_turn_messages VALUES
        ('turn-123', 'turn-msg-1', '120363599@g.us', 'alice@s.whatsapp.net', 'Alice Example', '2026-04-15T11:03:10.000Z', 0),
        ('turn-123', 'turn-msg-2', '120363599@g.us', 'alice@s.whatsapp.net', 'Alice Example', '2026-04-15T11:03:20.000Z', 1);
    `);

    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });

    expect(result.counters.noTrigger).toBe(0);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].userMessage).toContain('primeiro pedido');
    expect(result.deviations[0].userMessage).toContain('na verdade quinta às 11h');
    expect(result.deviations[0].userMessage).not.toContain('mensagem errada');
    expect(result.deviations[0].sourceTurnId).toBe('turn-123');
    expect(result.deviations[0].sourceMessageIds).toEqual(['turn-msg-1', 'turn-msg-2']);
    tf.close(); msg.close();
  });

  it('classifies title changes as title, not due_date', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        group_jid TEXT,
        group_folder TEXT,
        parent_board_id TEXT
      );
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);
      INSERT INTO boards VALUES ('board-title', '120363500@g.us', 'title-group', NULL);
      INSERT INTO board_runtime_config VALUES ('board-title', 'America/Fortaleza');
      INSERT INTO board_people VALUES ('board-title', 'alice', 'Alice Example');
      INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
        ('board-title', 'T5', 'updated', 'alice',
         '2026-04-15T11:04:11.450Z',
         '{"changes":["Título alterado para \\"Novo título\\""]}');
    `);

    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363500@g.us', 'title-group', 'Title', 1);
      INSERT INTO messages VALUES (
        'm1', '120363500@g.us', '558@s.whatsapp.net', 'Alice Example',
        'renomear a tarefa para Novo título', '2026-04-15T11:03:30.000Z', 0, 0
      );
    `);

    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });

    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].fieldKind).toBe('title');
    expect(result.deviations[0].storedValue).toContain('Título alterado');
    tf.close(); msg.close();
  });

  it('skips a mutation when Ollama returns a non-OK response, increments ollamaFail', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
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
    expect(result.counters.ollamaFail).toBe(1);
    expect(result.counters.parseFail).toBe(0);
    tf.close();
    msg.close();
  });
});

describe('runResponseAudit', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedResponseDbs() {
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      INSERT INTO boards VALUES ('board-seci-taskflow', '120363407@g.us', 'seci-taskflow', NULL);
      INSERT INTO board_runtime_config VALUES ('board-seci-taskflow', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363407@g.us', 'seci-taskflow', 'SECI-SECTI', 1);
      INSERT INTO messages VALUES ('u1', '120363407@g.us', '558@s.whatsapp.net', 'Carlos Giovanni',
        'não estou falando do caso da M3, mas das atualizações realizadas pelo Lucas em p9.7 e p11.20',
        '2026-04-15T20:24:27.000Z', 0, 0);
      INSERT INTO messages VALUES ('b1', '120363407@g.us', 'bot', 'Case',
        'Encontrei o provável culpado. notification_group_jid apontando para o mesmo grupo...',
        '2026-04-15T20:26:04.000Z', 1, 1);
    `);
    return { tf, msg };
  }

  it('flags a bot response that ignores user intent (Giovanni redirect case)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"User asked about Lucas updates to P9.7/P11.20, bot talked about notification_group_jid config instead","confidence":"high"}',
      }),
    });

    const { tf, msg } = seedResponseDbs();
    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.examined).toBe(1);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].fieldKind).toBe('response');
    expect(result.deviations[0].by).toBe('Carlos Giovanni');
    expect(result.deviations[0].intentMatches).toBe(false);
    expect(result.deviations[0].deviation).toContain('notification_group_jid');
    tf.close(); msg.close();
  });

  it('does not record deviations when bot response matches intent', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":true,"deviation":null,"confidence":"high"}',
      }),
    });

    const { tf, msg } = seedResponseDbs();
    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.examined).toBe(1);
    expect(result.deviations).toEqual([]);
    tf.close(); msg.close();
  });

  it('counts skippedNoResponse when bot never replies to a user message', async () => {
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      INSERT INTO boards VALUES ('board-seci-taskflow', '120363407@g.us', 'seci-taskflow', NULL);
      INSERT INTO board_runtime_config VALUES ('board-seci-taskflow', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363407@g.us', 'seci-taskflow', 'SECI', 1);
      INSERT INTO messages VALUES ('u1', '120363407@g.us', '558@s.whatsapp.net', 'Giovanni', 'quadro', '2026-04-15T10:00:00.000Z', 0, 0);
    `);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.examined).toBe(0);
    expect(result.counters.skippedNoResponse).toBe(1);
    expect(result.deviations).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
    tf.close(); msg.close();
  });

  it('collapses a burst of user messages into ONE interaction with concatenated content', async () => {
    // 3 user messages in 10s, then 1 bot response — collapse into a single
    // audited interaction whose userContent includes ALL three messages,
    // so the decisive intent (often in msg 2 or 3) is never dropped.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"bot ignored corrections","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      INSERT INTO boards VALUES ('board-burst', '120363409@g.us', 'burst-group', NULL);
      INSERT INTO board_runtime_config VALUES ('board-burst', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363409@g.us', 'burst-group', 'Burst', 1);
      INSERT INTO messages VALUES ('u1', '120363409@g.us', '558@s.whatsapp.net', 'Alice', 'primeiro pedido', '2026-04-15T10:00:00.000Z', 0, 0);
      INSERT INTO messages VALUES ('u2', '120363409@g.us', '558@s.whatsapp.net', 'Alice', 'na verdade M5 não M3', '2026-04-15T10:00:05.000Z', 0, 0);
      INSERT INTO messages VALUES ('u3', '120363409@g.us', '558@s.whatsapp.net', 'Alice', 'para quinta-feira', '2026-04-15T10:00:10.000Z', 0, 0);
      INSERT INTO messages VALUES ('b1', '120363409@g.us', 'bot', 'Case', 'Resposta consolidada...', '2026-04-15T10:01:00.000Z', 1, 1);
    `);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.examined).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.deviations).toHaveLength(1);
    // The audited user content must include ALL three messages
    expect(result.deviations[0].userMessage).toContain('primeiro pedido');
    expect(result.deviations[0].userMessage).toContain('na verdade M5 não M3');
    expect(result.deviations[0].userMessage).toContain('para quinta-feira');
    expect(result.deviations[0].sourceMessageIds).toEqual(['u1', 'u2', 'u3']);
    expect(result.deviations[0].responseMessageId).toBe('b1');
    // Prompt sent to Ollama must also contain all three
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.prompt).toContain('primeiro pedido');
    expect(body.prompt).toContain('na verdade M5 não M3');
    expect(body.prompt).toContain('para quinta-feira');
    tf.close(); msg.close();
  });

  it('prefers exact outbound turn correlation over the first bot row in the time window', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"bot exato ainda divergiu","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      INSERT INTO boards VALUES ('board-exact-response', '1203634099@g.us', 'exact-response-group', NULL);
      INSERT INTO board_runtime_config VALUES ('board-exact-response', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
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
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      CREATE TABLE agent_turn_messages (
        turn_id TEXT,
        message_id TEXT,
        message_chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        message_timestamp TEXT,
        ordinal INTEGER
      );
      CREATE TABLE outbound_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        group_folder TEXT,
        text TEXT NOT NULL,
        sender_label TEXT,
        source TEXT NOT NULL,
        trigger_turn_id TEXT,
        enqueued_at TEXT NOT NULL,
        sent_at TEXT,
        delivered_message_id TEXT,
        delivered_message_timestamp TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        abandoned_at TEXT
      );
      INSERT INTO registered_groups VALUES ('1203634099@g.us', 'exact-response-group', 'Exact Response', 1);
      INSERT INTO messages VALUES ('u1', '1203634099@g.us', '558@s.whatsapp.net', 'Alice', 'primeiro pedido', '2026-04-15T10:00:00.000Z', 0, 0);
      INSERT INTO messages VALUES ('u2', '1203634099@g.us', '558@s.whatsapp.net', 'Alice', 'na verdade quero a resposta exata', '2026-04-15T10:00:05.000Z', 0, 0);
      INSERT INTO messages VALUES ('b-unrelated', '1203634099@g.us', 'bot', 'Case', 'Resposta de outra interação', '2026-04-15T10:00:20.000Z', 1, 1);
      INSERT INTO messages VALUES ('b-exact', '1203634099@g.us', 'bot', 'Case', 'Resposta exata do turno auditado', '2026-04-15T10:01:00.000Z', 1, 1);
      INSERT INTO agent_turn_messages VALUES
        ('turn-response-1', 'u1', '1203634099@g.us', '558@s.whatsapp.net', 'Alice', '2026-04-15T10:00:00.000Z', 0),
        ('turn-response-1', 'u2', '1203634099@g.us', '558@s.whatsapp.net', 'Alice', '2026-04-15T10:00:05.000Z', 1);
      INSERT INTO outbound_messages (
        chat_jid, group_folder, text, sender_label, source, trigger_turn_id,
        enqueued_at, sent_at, delivered_message_id, delivered_message_timestamp
      ) VALUES (
        '1203634099@g.us',
        'exact-response-group',
        'Resposta exata do turno auditado',
        'Case',
        'user',
        'turn-response-1',
        '2026-04-15T10:00:50.000Z',
        '2026-04-15T10:01:00.000Z',
        'b-exact',
        '2026-04-15T10:01:00.000Z'
      );
    `);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.examined).toBe(1);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].sourceTurnId).toBe('turn-response-1');
    expect(result.deviations[0].sourceMessageIds).toEqual(['u1', 'u2']);
    expect(result.deviations[0].responseMessageId).toBe('b-exact');
    expect(result.deviations[0].at).toBe('2026-04-15T10:01:00.000Z');
    expect(result.deviations[0].responsePreview).toContain('Resposta exata do turno auditado');
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.prompt).toContain('Resposta exata do turno auditado');
    expect(body.prompt).not.toContain('Resposta de outra interação');
    tf.close(); msg.close();
  });

  it('skips web-origin messages by sender field (not just sender_name)', async () => {
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      INSERT INTO boards VALUES ('board-web', '120363410@g.us', 'web-group', NULL);
      INSERT INTO board_runtime_config VALUES ('board-web', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363410@g.us', 'web-group', 'Web', 1);
      -- sender starts with 'web:' but sender_name is a normal human name
      INSERT INTO messages VALUES ('u1', '120363410@g.us', 'web:test', 'Human Name', 'quadro', '2026-04-15T10:00:00.000Z', 0, 0);
      INSERT INTO messages VALUES ('b1', '120363410@g.us', 'bot', 'Case', 'Aqui está o quadro...', '2026-04-15T10:01:00.000Z', 1, 1);
    `);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.examined).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    tf.close(); msg.close();
  });

  it('skips casual acknowledgements without calling Ollama', async () => {
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      INSERT INTO boards VALUES ('board-casual', '120363411@g.us', 'casual-group', NULL);
      INSERT INTO board_runtime_config VALUES ('board-casual', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363411@g.us', 'casual-group', 'Casual', 1);
      INSERT INTO messages VALUES ('u1', '120363411@g.us', '558@s.whatsapp.net', 'Alice', 'ok', '2026-04-15T10:00:00.000Z', 0, 0);
      INSERT INTO messages VALUES ('b1', '120363411@g.us', 'bot', 'Case', 'Tudo certo!', '2026-04-15T10:01:00.000Z', 1, 1);
    `);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.examined).toBe(0);
    expect(result.counters.skippedCasual).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
    tf.close(); msg.close();
  });

  it('anchors response deviations to the BOT timestamp and stores the audited excerpt', async () => {
    const longBotResp = 'A'.repeat(1000) + ' PRAZO: 2026-04-20 ' + 'B'.repeat(1000);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"desvio","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      INSERT INTO boards VALUES ('board-anchor', '120363412@g.us', 'anchor-group', NULL);
      INSERT INTO board_runtime_config VALUES ('board-anchor', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.prepare(
      `CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));`,
    ).run();
    msg.prepare(
      `CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);`,
    ).run();
    msg.prepare(
      `INSERT INTO registered_groups VALUES ('120363412@g.us', 'anchor-group', 'Anchor', 1);`,
    ).run();
    msg.prepare(
      `INSERT INTO messages VALUES ('u1', '120363412@g.us', '558@s.whatsapp.net', 'Alice', 'qual o prazo de T5?', '2026-04-15T10:00:00.000Z', 0, 0);`,
    ).run();
    msg.prepare(
      `INSERT INTO messages VALUES ('b1', '120363412@g.us', 'bot', 'Case', ?, '2026-04-15T10:01:30.000Z', 1, 1);`,
    ).run(longBotResp);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.deviations).toHaveLength(1);
    const dev = result.deviations[0];
    // Deviation is about the bot's response, so .at must match the bot timestamp
    expect(dev.at).toBe('2026-04-15T10:01:30.000Z');
    expect(dev.sourceMessageIds).toEqual(['u1']);
    expect(dev.responseMessageId).toBe('b1');
    // responsePreview must use truncateKeepEnds (head + tail), not a head-only slice.
    // The truncated form contains the separator sentinel.
    expect(dev.responsePreview).toContain('[...truncado...]');
    // And must preserve the tail (where the real answer lived)
    expect(dev.responsePreview).toContain('BBBBB');
    tf.close(); msg.close();
  });

  it('resolves board deterministically via group_jid (ignores wrong group_folder row)', async () => {
    // Two boards share a similar group_folder; only one has the matching
    // group_jid. Resolution must pick the group_jid match, not whichever
    // group_folder row SQLite returns first.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"x","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      -- wrong-jid board uses same folder (legacy rename scenario)
      INSERT INTO boards VALUES ('board-old', 'OLD-JID@g.us', 'shared-folder', NULL);
      INSERT INTO boards VALUES ('board-new', '120363413@g.us', 'shared-folder', NULL);
      INSERT INTO board_runtime_config VALUES ('board-new', 'America/Fortaleza');
      INSERT INTO board_runtime_config VALUES ('board-old', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363413@g.us', 'shared-folder', 'Shared', 1);
      INSERT INTO messages VALUES ('u1', '120363413@g.us', '558@s.whatsapp.net', 'Alice', 'pergunta real', '2026-04-15T10:00:00.000Z', 0, 0);
      INSERT INTO messages VALUES ('b1', '120363413@g.us', 'bot', 'Case', 'resposta', '2026-04-15T10:01:00.000Z', 1, 1);
    `);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.deviations).toHaveLength(1);
    // Must bind to board-new (jid match), not board-old (folder-only match)
    expect(result.deviations[0].boardId).toBe('board-new');
    tf.close(); msg.close();
  });

  it('counts boardMapFail for registered groups with no matching board', async () => {
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363414@g.us', 'orphan-folder', 'Orphan', 1);
    `);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.boardMapFail).toBe(1);
    expect(result.counters.examined).toBe(0);
    tf.close(); msg.close();
  });

  it('resolves via board_groups join table when boards.group_jid missing', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"mock","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      -- board exists but with a DIFFERENT primary group_jid; secondary group
      -- is wired via board_groups join table.
      INSERT INTO boards VALUES ('board-multi', 'PRIMARY-JID@g.us', 'primary', NULL);
      INSERT INTO board_groups VALUES ('board-multi', '120363415@g.us', 'secondary-folder');
      INSERT INTO board_runtime_config VALUES ('board-multi', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363415@g.us', 'secondary-folder', 'Secondary', 1);
      INSERT INTO messages VALUES ('u1', '120363415@g.us', '558@s.whatsapp.net', 'Alice', 'pergunta', '2026-04-15T10:00:00.000Z', 0, 0);
      INSERT INTO messages VALUES ('b1', '120363415@g.us', 'bot', 'Case', 'resposta', '2026-04-15T10:01:00.000Z', 1, 1);
    `);

    const result = await runResponseAudit({
      msgDb: msg, tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434', ollamaModel: 'test-model:fake',
    });

    expect(result.counters.examined).toBe(1);
    expect(result.counters.boardMapFail).toBe(0);
    tf.close(); msg.close();
  });

  it('does not attribute Alice\'s reply to Bob when another user speaks first', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: '{"intent_matches":false,"deviation":"Bob only","confidence":"high"}',
      }),
    });

    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, parent_board_id TEXT);
      CREATE TABLE board_groups (board_id TEXT, group_jid TEXT, group_folder TEXT, PRIMARY KEY (board_id, group_folder));
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      INSERT INTO boards VALUES ('board-interleaved', '120363416@g.us', 'interleaved-group', NULL);
      INSERT INTO board_runtime_config VALUES ('board-interleaved', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
      INSERT INTO registered_groups VALUES ('120363416@g.us', 'interleaved-group', 'Interleaved', 1);
      INSERT INTO messages VALUES ('u1', '120363416@g.us', 'alice@s.whatsapp.net', 'Alice', 'pedido da Alice', '2026-04-15T10:00:00.000Z', 0, 0);
      INSERT INTO messages VALUES ('u2', '120363416@g.us', 'bob@s.whatsapp.net', 'Bob', 'pedido do Bob', '2026-04-15T10:00:20.000Z', 0, 0);
      INSERT INTO messages VALUES ('b1', '120363416@g.us', 'bot', 'Case', 'resposta para o Bob', '2026-04-15T10:00:40.000Z', 1, 1);
    `);

    const result = await runResponseAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-15T00:00:00.000Z', endIso: '2026-04-16T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });

    expect(result.counters.skippedNoResponse).toBe(1);
    expect(result.counters.examined).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].userMessage).toBe('pedido do Bob');
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.prompt).toContain('pedido do Bob');
    expect(body.prompt).not.toContain('pedido da Alice');
    msg.close(); tf.close();
  });
});

describe('buildResponsePrompt — approval-gate fulfillment rule', () => {
  // Regression for the 2026-04-29 P20.5 case: Lucas asked to add a note
  // AND finalize. Bot did BOTH — note added, then attempted finalize
  // which the engine routed to `review` because the task has
  // requires_close_approval=true. Successful execution. Audit's
  // response classifier didn't recognize the approval-gate path and
  // flagged it as unfulfilled. The prompt must teach the classifier
  // that "moved to review awaiting approval" counts as fulfilled when
  // user asked to conclude/finalize.
  const interaction = {
    userTimestamp: '2026-04-27T11:34:56.000Z',
    userSender: 'lucas',
    userContent: 'P20.5 nota: X. finalizar P20.5',
    botTimestamp: '2026-04-27T11:35:30.000Z',
    botContent: '✅ P20.5 movida para Revisão (aguardando aprovação do gestor)',
    chatJid: '120363408810515104@g.us',
  };
  const ctx = {
    boardTimezone: 'America/Fortaleza',
    headerToday: '2026-04-27',
    headerWeekday: 'segunda-feira',
  };

  it('mentions the requires_close_approval / Revisão fulfillment path', () => {
    const prompt = buildResponsePrompt(interaction, ctx);
    expect(prompt).toMatch(/requires_close_approval|aprovaç[ãa]o.*finaliz|Revis[ãa]o.*aprovaç/i);
    expect(prompt).toMatch(/finaliz|conclu/i);
  });

  it('places the approval-gate clarification in the NÃO-é-divergência section', () => {
    const prompt = buildResponsePrompt(interaction, ctx);
    // The "não é divergência" cases are numbered "3." in the rule list.
    // The new rule must live there (not in section 4 or 5).
    const section3Match = prompt.match(/3\. \*\*Casos que NÃO são divergência[\s\S]*?(?=\n\n4\. )/);
    expect(section3Match).not.toBeNull();
    expect(section3Match![0]).toMatch(/Revis[ãa]o|requires_close_approval/);
  });
});

describe('dedupeDeviations', () => {
  // Real-world signal: deepseek-v4-pro on the response pass produced 26
  // records for 14 unique bot replies on 2026-04-29 (1.86×). The mutation
  // pass on Sonnet produced 4 records for 3 distinct (task, field) pairs
  // (P11.25 assignee × 2). Same underlying failure restated from
  // different angles. Dedup at consumption keeps NDJSON forensics intact
  // while preventing the report from spamming duplicate items.
  const baseDev = (overrides: Partial<SemanticDeviation>): SemanticDeviation => ({
    taskId: null,
    boardId: 'b1',
    fieldKind: 'response',
    at: '2026-04-29T10:00:00.000Z',
    by: 'lucas',
    userMessage: 'adicionar nota X e alterar prazo',
    sourceTurnId: null,
    sourceMessageIds: ['m1'],
    responseMessageId: 'r1',
    storedValue: null,
    responsePreview: '✅ atualizada',
    intentMatches: false,
    deviation: 'first framing',
    confidence: 'high',
    rawResponse: '{}',
    ...overrides,
  });

  it('collapses response deviations on the same (boardId, responseMessageId)', () => {
    const out = dedupeDeviations([
      baseDev({ deviation: 'first framing' }),
      baseDev({ deviation: 'second framing' }),
      baseDev({ deviation: 'third framing' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps response deviations on different responseMessageIds', () => {
    const out = dedupeDeviations([
      baseDev({ responseMessageId: 'r1' }),
      baseDev({ responseMessageId: 'r2' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('collapses mutation deviations on the same (boardId, taskId, fieldKind, at)', () => {
    const out = dedupeDeviations([
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        deviation: 'first take',
      }),
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        deviation: 'second take',
      }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps mutation deviations on different fieldKinds for the same task', () => {
    const out = dedupeDeviations([
      baseDev({
        fieldKind: 'assignee',
        taskId: 'M22',
        responseMessageId: null,
      }),
      baseDev({
        fieldKind: 'scheduled_at',
        taskId: 'M22',
        responseMessageId: null,
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps records that have no anchor (taskId AND responseMessageId both null)', () => {
    const out = dedupeDeviations([
      baseDev({ taskId: null, responseMessageId: null, deviation: 'orphan 1' }),
      baseDev({ taskId: null, responseMessageId: null, deviation: 'orphan 2' }),
    ]);
    // No reliable dedup key — keep both rather than risk losing real signal.
    expect(out).toHaveLength(2);
  });

  it('uses sourceMutationId as the mutation dedup anchor when present', () => {
    // task_history.id is the canonical row anchor — two genuinely
    // distinct task_history rows with the same `at` (millisecond
    // collision under concurrent writes) would collapse on the
    // at-based key but stay separate on the id-based key.
    const out = dedupeDeviations([
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        sourceMutationId: 1001,
        deviation: 'first row',
      }),
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        sourceMutationId: 1002,
        // Same `at` as above (default from baseDev) — would collide
        // on the at-based key. The id discriminates.
        deviation: 'second row, same millisecond',
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('collapses LLM-framing duplicates on the same sourceMutationId', () => {
    const out = dedupeDeviations([
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        sourceMutationId: 1001,
        deviation: 'framing 1',
      }),
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        sourceMutationId: 1001,
        deviation: 'framing 2',
      }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('falls back to (taskId, fieldKind, at) when sourceMutationId is missing', () => {
    // Backwards-compat path: older NDJSON records may not carry
    // sourceMutationId. Dedup should still collapse same-row
    // duplicates and split same-task different-day mutations.
    const out = dedupeDeviations([
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        sourceMutationId: null,
        at: '2026-04-29T09:00:00.000Z',
        deviation: 'morning',
      }),
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        sourceMutationId: null,
        at: '2026-04-29T15:00:00.000Z',
        deviation: 'afternoon',
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps mutation deviations on different at timestamps for the same (task, field)', () => {
    // Two genuinely different same-day mutations on the same field
    // (e.g., user reassigns P11.25 morning, then again afternoon —
    // bot did the wrong thing both times) are NOT duplicates and
    // must both surface. LLM-framing duplicates share the same `at`
    // (the source mutation timestamp), real reruns differ.
    const out = dedupeDeviations([
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        at: '2026-04-29T09:00:00.000Z',
        storedValue: 'rodrigo-lima',
      }),
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
        at: '2026-04-29T15:00:00.000Z',
        storedValue: 'edilson',
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('prefers higher-confidence record when duplicates collide', () => {
    // First-wins would silently downgrade a high-confidence judgment
    // to a low one when the loop happens to see the low one first.
    // Confidence vocabulary is 'high' | 'med' | 'low' (CONFIDENCE_VALUES).
    const out = dedupeDeviations([
      baseDev({ confidence: 'low', deviation: 'low-conf framing' }),
      baseDev({ confidence: 'high', deviation: 'high-conf framing' }),
      baseDev({ confidence: 'med', deviation: 'med-conf framing' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('high');
    expect(out[0].deviation).toBe('high-conf framing');
  });

  it("'med' beats 'low' on dedup collision (rank table contract)", () => {
    // Regression guard: an earlier draft used 'medium' in the rank
    // table while the prompt contract emits 'med', so real 'med'
    // deviations got rank 0 and lost to 'low'.
    const out = dedupeDeviations([
      baseDev({ confidence: 'low', deviation: 'low first' }),
      baseDev({ confidence: 'med', deviation: 'med second' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('med');
  });

  it('prefers longer deviation prose when confidence ties on duplicates', () => {
    const out = dedupeDeviations([
      baseDev({ confidence: 'high', deviation: 'short' }),
      baseDev({ confidence: 'high', deviation: 'a substantially longer framing of the same failure' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].deviation).toBe('a substantially longer framing of the same failure');
  });

  it('falls back to first-emitted on a full tie', () => {
    const out = dedupeDeviations([
      baseDev({ confidence: 'high', deviation: 'first', sourceMessageIds: ['m1'] }),
      baseDev({ confidence: 'high', deviation: 'first', sourceMessageIds: ['m2'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceMessageIds).toEqual(['m1']);
  });

  it('does not collide a mutation with a response that share boardId only', () => {
    const out = dedupeDeviations([
      baseDev({
        fieldKind: 'assignee',
        taskId: 'P11.25',
        responseMessageId: null,
      }),
      baseDev({
        fieldKind: 'response',
        taskId: null,
        responseMessageId: 'r1',
      }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('writeDryRunLog', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-dryrun-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates a dated NDJSON file and appends one line per deviation', () => {
    const deviations: SemanticDeviation[] = [
      {
        taskId: 'M1', boardId: 'b1', fieldKind: 'scheduled_at',
        at: '2026-04-14T11:04:11.450Z', by: 'giovanni',
        userMessage: 'alterar M1 para quinta-feira', storedValue: '2026-04-17T11:00',
        sourceTurnId: 'turn-1', sourceMessageIds: ['m1'], responseMessageId: null,
        responsePreview: null,
        intentMatches: false, deviation: 'wrong day', confidence: 'high',
        rawResponse: '{"intent_matches":false}',
      },
      {
        taskId: 'M2', boardId: 'b1', fieldKind: 'scheduled_at',
        at: '2026-04-14T12:00:00.000Z', by: 'alexandre',
        userMessage: null, storedValue: '2026-04-16T10:00',
        responsePreview: null,
        intentMatches: true, deviation: null, confidence: 'high',
        rawResponse: '{"intent_matches":true}',
      },
    ];
    writeDryRunLog(deviations, tmpRoot, new Date('2026-04-14T20:00:00.000Z'));
    const file = path.join(tmpRoot, 'semantic-dryrun-2026-04-14.ndjson');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).taskId).toBe('M1');
    expect(JSON.parse(lines[0]).sourceTurnId).toBe('turn-1');
    expect(JSON.parse(lines[1]).taskId).toBe('M2');
  });

  it('is a no-op on empty array', () => {
    writeDryRunLog([], tmpRoot);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('appends to an existing file on subsequent calls same day', () => {
    const dev: SemanticDeviation = {
      taskId: 'M3', boardId: 'b1', fieldKind: 'scheduled_at',
      at: '2026-04-14T13:00:00.000Z', by: 'lucas',
      userMessage: null, storedValue: null, responsePreview: null,
      intentMatches: true, deviation: null, confidence: 'low',
      rawResponse: '{}',
    };
    const fixedDate = new Date('2026-04-14T15:00:00.000Z');
    writeDryRunLog([dev], tmpRoot, fixedDate);
    writeDryRunLog([dev], tmpRoot, fixedDate);
    const file = path.join(tmpRoot, 'semantic-dryrun-2026-04-14.ndjson');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
