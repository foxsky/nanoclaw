import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { openMemoryDb, searchMemory } from './memory-store.js';
import {
  buildTranscriptExcerpt,
  captureSessionMemories,
  type CaptureMessage,
  extractMemories,
  parseExtractedFacts,
  precompactHookTimeoutSec,
  shouldCapture,
} from './memory-capture.js';

let db: ReturnType<typeof openMemoryDb> | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

function msgs(n: number, body = 'this is a reasonably substantial message about the deploy plan'): CaptureMessage[] {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${body} ${i}` }));
}

/** A tiny/ephemeral session must not burn a Haiku call — auto-capture is opt-in on substance. */
describe('shouldCapture (spend guard)', () => {
  it('skips sessions with too few messages', () => {
    expect(shouldCapture(msgs(2))).toBe(false);
  });
  it('skips sessions with too little total content', () => {
    expect(
      shouldCapture([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'thanks' },
        { role: 'assistant', content: 'yw' },
      ]),
    ).toBe(false);
  });
  it('captures a substantial multi-turn session', () => {
    expect(shouldCapture(msgs(8))).toBe(true);
  });
});

describe('buildTranscriptExcerpt', () => {
  it('labels each turn by role and joins them', () => {
    const out = buildTranscriptExcerpt([
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'beta' },
    ]);
    expect(out).toContain('user: alpha');
    expect(out).toContain('assistant: beta');
  });
  it('bounds the excerpt to maxChars, keeping the most recent tail', () => {
    const out = buildTranscriptExcerpt(
      [
        { role: 'user', content: 'OLDEST' },
        { role: 'assistant', content: 'X'.repeat(500) },
        { role: 'user', content: 'NEWEST' },
      ],
      120,
    );
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain('NEWEST');
    expect(out).not.toContain('OLDEST');
  });
});

describe('parseExtractedFacts (defensive)', () => {
  it('parses a raw JSON array of strings', () => {
    expect(parseExtractedFacts('["the deploy window is Tuesday", "Ana owns the API board"]')).toEqual([
      'the deploy window is Tuesday',
      'Ana owns the API board',
    ]);
  });
  it('parses a ```json fenced array', () => {
    expect(parseExtractedFacts('```json\n["one fact"]\n```')).toEqual(['one fact']);
  });
  it('drops empty/whitespace entries, dedupes, trims, and caps to maxFacts', () => {
    expect(parseExtractedFacts('["  a  ", "", "a", "b", "c", "d", "e", "f"]', 3)).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for non-array / unparseable output (model misbehaves)', () => {
    expect(parseExtractedFacts('I could not find anything durable.')).toEqual([]);
    expect(parseExtractedFacts('{"not":"an array"}')).toEqual([]);
    expect(parseExtractedFacts('[1, 2, 3]')).toEqual([]);
  });
});

describe('extractMemories (Haiku via injected fetch)', () => {
  const okFetch = (text: string): typeof fetch =>
    (async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) })) as unknown as typeof fetch;

  it('returns parsed facts from a successful Haiku response', async () => {
    const facts = await extractMemories(msgs(8), { fetchImpl: okFetch('["deploy is Tuesday"]') });
    expect(facts).toEqual(['deploy is Tuesday']);
  });

  it('does not call the model (returns []) for a session below the capture threshold', async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) };
    }) as unknown as typeof fetch;
    const facts = await extractMemories(msgs(1), { fetchImpl: spyFetch });
    expect(facts).toEqual([]);
    expect(called).toBe(false);
  });

  it('fails soft (returns []) on a non-OK response — capture must never break compaction', async () => {
    const badFetch = (async () => ({ ok: false, status: 500, text: async () => 'boom' })) as unknown as typeof fetch;
    expect(await extractMemories(msgs(8), { fetchImpl: badFetch })).toEqual([]);
  });

  it('mirrors the SDK auth shape so the gateway can inject the credential', async () => {
    const saved = {
      base: process.env.ANTHROPIC_BASE_URL,
      key: process.env.ANTHROPIC_API_KEY,
      tok: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    const cap: { url?: string; headers?: Record<string, string> } = {};
    const capFetch = (async (url: string, init: { headers: Record<string, string> }) => {
      cap.url = url;
      cap.headers = init.headers;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) };
    }) as unknown as typeof fetch;
    const restore = (k: 'ANTHROPIC_BASE_URL' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN', v?: string) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      // Default endpoint → Anthropic-native x-api-key (the typed `anthropic` OneCLI secret rewrites it).
      delete process.env.ANTHROPIC_BASE_URL;
      process.env.ANTHROPIC_API_KEY = 'placeholder';
      await extractMemories(msgs(8), { fetchImpl: capFetch });
      expect(cap.url).toBe('https://api.anthropic.com/v1/messages');
      expect(cap.headers!['x-api-key']).toBe('placeholder');

      // Custom endpoint → Authorization: Bearer (mirrors the custom-endpoint provider config).
      process.env.ANTHROPIC_BASE_URL = 'https://llm.example.com';
      process.env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
      await extractMemories(msgs(8), { fetchImpl: capFetch });
      expect(cap.url).toBe('https://llm.example.com/v1/messages');
      expect(cap.headers!['authorization']).toBe('Bearer placeholder');
    } finally {
      restore('ANTHROPIC_BASE_URL', saved.base);
      restore('ANTHROPIC_API_KEY', saved.key);
      restore('ANTHROPIC_AUTH_TOKEN', saved.tok);
    }
  });
});

describe('extractMemories backend selection (operator-selectable)', () => {
  it('defaults to the anthropic backend (existing gateway path) and posts to /v1/messages', async () => {
    const cap: { url?: string } = {};
    const f = (async (url: string) => {
      cap.url = url;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) };
    }) as unknown as typeof fetch;
    await extractMemories(msgs(8), { fetchImpl: f });
    expect(cap.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('ollama backend posts an OpenAI-free /api/chat request (system+user, stream:false, temperature 0) and parses message.content', async () => {
    const cap: { url?: string; body?: Record<string, unknown> } = {};
    const f = (async (url: string, init: { body: string }) => {
      cap.url = url;
      cap.body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ message: { content: '["the deploy window is Tuesday"]' } }) };
    }) as unknown as typeof fetch;
    const facts = await extractMemories(msgs(8), {
      backend: 'ollama',
      ollamaUrl: 'http://ollama.local:11434',
      model: 'qwen3.6:27b',
      fetchImpl: f,
    });
    expect(cap.url).toBe('http://ollama.local:11434/api/chat');
    expect(cap.body!.model).toBe('qwen3.6:27b');
    expect(cap.body!.stream).toBe(false);
    const messages = cap.body!.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Transcript:');
    expect((cap.body!.options as { temperature?: number }).temperature).toBe(0);
    expect(facts).toEqual(['the deploy window is Tuesday']);
  });

  it('ollama backend strips a <think> reasoning block before parsing (qwen emits one)', async () => {
    const f = (async () => ({
      ok: true,
      json: async () => ({
        message: { content: '<think>let me find durable facts...</think>\n["ana owns the api board"]' },
      }),
    })) as unknown as typeof fetch;
    const facts = await extractMemories(msgs(8), {
      backend: 'ollama',
      ollamaUrl: 'http://x:1',
      model: 'q',
      fetchImpl: f,
    });
    expect(facts).toEqual(['ana owns the api board']);
  });

  it('ollama backend fails soft (returns []) on a non-OK response — capture must never break compaction', async () => {
    const f = (async () => ({ ok: false, status: 500, text: async () => 'boom' })) as unknown as typeof fetch;
    expect(
      await extractMemories(msgs(8), { backend: 'ollama', ollamaUrl: 'http://x:1', model: 'q', fetchImpl: f }),
    ).toEqual([]);
  });

  it('ollama backend returns [] and makes no call when no model is configured (cannot guess a local model)', async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, json: async () => ({ message: { content: '["x"]' } }) };
    }) as unknown as typeof fetch;
    expect(await extractMemories(msgs(8), { backend: 'ollama', ollamaUrl: 'http://x:1', fetchImpl: f })).toEqual([]);
    expect(called).toBe(false);
  });

  it('falls back to anthropic for an invalid deps.backend (JS callers bypass the TS type)', async () => {
    const cap: { url?: string } = {};
    const f = (async (url: string) => {
      cap.url = url;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) };
    }) as unknown as typeof fetch;
    await extractMemories(msgs(8), { backend: 'openai' as unknown as 'anthropic', fetchImpl: f });
    expect(cap.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('adds the ollama host to NO_PROXY so the call is direct, not routed through the gateway proxy', async () => {
    const saved = { n: process.env.NO_PROXY, l: process.env.no_proxy };
    const f = (async () => ({
      ok: true,
      json: async () => ({ message: { content: '[]' } }),
    })) as unknown as typeof fetch;
    try {
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
      await extractMemories(msgs(8), {
        backend: 'ollama',
        ollamaUrl: 'http://my-ollama.lan:11434',
        model: 'q',
        fetchImpl: f,
      });
      expect(process.env.NO_PROXY).toContain('my-ollama.lan');
      expect(process.env.no_proxy).toContain('my-ollama.lan');
    } finally {
      saved.n === undefined ? delete process.env.NO_PROXY : (process.env.NO_PROXY = saved.n);
      saved.l === undefined ? delete process.env.no_proxy : (process.env.no_proxy = saved.l);
    }
  });

  it('falls back to the anthropic backend (not silently to ollama) for an unrecognized env value', async () => {
    const saved = process.env.NANOCLAW_MEMORY_EXTRACT_BACKEND;
    const cap: { url?: string } = {};
    const f = (async (url: string) => {
      cap.url = url;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) };
    }) as unknown as typeof fetch;
    try {
      process.env.NANOCLAW_MEMORY_EXTRACT_BACKEND = 'openai'; // unknown → must not silently route anywhere odd
      await extractMemories(msgs(8), { fetchImpl: f });
      expect(cap.url).toBe('https://api.anthropic.com/v1/messages');
    } finally {
      if (saved === undefined) delete process.env.NANOCLAW_MEMORY_EXTRACT_BACKEND;
      else process.env.NANOCLAW_MEMORY_EXTRACT_BACKEND = saved;
    }
  });

  it('selects the ollama backend from NANOCLAW_MEMORY_EXTRACT_BACKEND env when deps omit it', async () => {
    const saved = {
      b: process.env.NANOCLAW_MEMORY_EXTRACT_BACKEND,
      u: process.env.NANOCLAW_MEMORY_EXTRACT_URL,
      m: process.env.NANOCLAW_MEMORY_EXTRACT_MODEL,
    };
    const cap: { url?: string } = {};
    const f = (async (url: string) => {
      cap.url = url;
      return { ok: true, json: async () => ({ message: { content: '[]' } }) };
    }) as unknown as typeof fetch;
    try {
      process.env.NANOCLAW_MEMORY_EXTRACT_BACKEND = 'ollama';
      process.env.NANOCLAW_MEMORY_EXTRACT_URL = 'http://env-host:11434';
      process.env.NANOCLAW_MEMORY_EXTRACT_MODEL = 'env-model';
      await extractMemories(msgs(8), { fetchImpl: f });
      expect(cap.url).toBe('http://env-host:11434/api/chat');
    } finally {
      for (const [k, v] of [
        ['NANOCLAW_MEMORY_EXTRACT_BACKEND', saved.b],
        ['NANOCLAW_MEMORY_EXTRACT_URL', saved.u],
        ['NANOCLAW_MEMORY_EXTRACT_MODEL', saved.m],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('precompactHookTimeoutSec (derived from the extraction budget)', () => {
  const saved = process.env.NANOCLAW_MEMORY_EXTRACT_TIMEOUT_MS;
  const savedEmbed = process.env.NANOCLAW_MEMORY_EMBED_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.NANOCLAW_MEMORY_EXTRACT_TIMEOUT_MS;
    else process.env.NANOCLAW_MEMORY_EXTRACT_TIMEOUT_MS = saved;
    if (savedEmbed === undefined) delete process.env.NANOCLAW_MEMORY_EMBED_MODEL;
    else process.env.NANOCLAW_MEMORY_EMBED_MODEL = savedEmbed;
  });

  it('defaults to 30s (20s extraction + 10s buffer) so existing behavior is preserved', () => {
    delete process.env.NANOCLAW_MEMORY_EXTRACT_TIMEOUT_MS;
    delete process.env.NANOCLAW_MEMORY_EMBED_MODEL;
    expect(precompactHookTimeoutSec()).toBe(30);
  });

  it('auto-tracks a raised extraction timeout so a slow local model is not killed mid-extraction', () => {
    delete process.env.NANOCLAW_MEMORY_EMBED_MODEL;
    process.env.NANOCLAW_MEMORY_EXTRACT_TIMEOUT_MS = '120000';
    expect(precompactHookTimeoutSec()).toBe(130); // 120s + 10s buffer
  });

  it('budgets the (concurrent) embed pass when embeddings are enabled, so capture is not killed mid-write', () => {
    delete process.env.NANOCLAW_MEMORY_EXTRACT_TIMEOUT_MS;
    process.env.NANOCLAW_MEMORY_EMBED_MODEL = 'bge-m3';
    expect(precompactHookTimeoutSec()).toBe(45); // 20s extract + 15s embed + 10s buffer
  });
});

describe('captureSessionMemories (end-to-end into the store, injected fetch+db)', () => {
  it('stores extracted facts with auto-capture provenance (capture owns its db handle)', async () => {
    // File-backed: captureSessionMemories opens + closes its own handle, so verify via a
    // separate connection (a shared :memory: handle would be closed out from under us).
    const file = path.join(os.tmpdir(), `mem-cap-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    const okFetch = (async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '["the deploy window is Tuesday 9am"]' }] }),
    })) as unknown as typeof fetch;
    try {
      const n = await captureSessionMemories({
        messages: msgs(8),
        boardId: 'b1',
        sessionId: 'sess-42',
        openDb: () => openMemoryDb(file),
        deps: { fetchImpl: okFetch },
      });
      expect(n).toBe(1);

      const verify = openMemoryDb(file);
      const hits = searchMemory(verify, 'b1', 'deploy window', 5);
      expect(hits).toHaveLength(1);
      expect(hits[0].kind).toBe('auto');
      expect(hits[0].source_session).toBe('sess-42');
      expect(hits[0].source_ts).toBeTruthy();
      verify.close();
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-journal`, { force: true });
    }
  });

  it('returns 0 (never throws) when openDb fails — best-effort must not break compaction', async () => {
    const okFetch = (async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '["a durable fact"]' }] }),
    })) as unknown as typeof fetch;
    const n = await captureSessionMemories({
      messages: msgs(8),
      boardId: 'b1',
      sessionId: 's',
      openDb: () => {
        throw new Error('disk full');
      },
      deps: { fetchImpl: okFetch },
    });
    expect(n).toBe(0);
  });

  it('is a no-op (0), opening no DB and calling no model, when no board is bound', async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '["x"]' }] }) };
    }) as unknown as typeof fetch;
    const n = await captureSessionMemories({
      messages: msgs(8),
      boardId: null,
      sessionId: 's',
      openDb: () => {
        throw new Error('openDb must not be called when no board is bound');
      },
      deps: { fetchImpl: spyFetch },
    });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it('does not re-store a fact already captured for the board (cross-session dedup)', async () => {
    const file = path.join(os.tmpdir(), `mem-dedup-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    const okFetch = (async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '["the deploy window is Tuesday 9am"]' }] }),
    })) as unknown as typeof fetch;
    try {
      const first = await captureSessionMemories({
        messages: msgs(8),
        boardId: 'b1',
        sessionId: 's1',
        openDb: () => openMemoryDb(file),
        deps: { fetchImpl: okFetch },
      });
      const second = await captureSessionMemories({
        messages: msgs(8),
        boardId: 'b1',
        sessionId: 's2',
        openDb: () => openMemoryDb(file),
        deps: { fetchImpl: okFetch },
      });
      expect(first).toBe(1);
      expect(second).toBe(0); // identical fact already stored → not duplicated across sessions

      const verify = openMemoryDb(file);
      expect(searchMemory(verify, 'b1', 'deploy window', 5)).toHaveLength(1);
      verify.close();
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-journal`, { force: true });
    }
  });
});
