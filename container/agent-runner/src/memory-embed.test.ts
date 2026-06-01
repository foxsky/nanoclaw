import { describe, expect, it } from 'bun:test';

import { embedModel, embedText } from './memory-embed.js';

describe('embedModel (hybrid gate)', () => {
  it('returns the deps model when provided', () => {
    expect(embedModel({ model: 'bge-m3' })).toBe('bge-m3');
  });
  it('is null when no model is configured — embeddings off, FTS5-only', () => {
    const saved = process.env.NANOCLAW_MEMORY_EMBED_MODEL;
    delete process.env.NANOCLAW_MEMORY_EMBED_MODEL;
    try {
      expect(embedModel()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.NANOCLAW_MEMORY_EMBED_MODEL = saved;
    }
  });
});

describe('embedText (Ollama /api/embed via injected fetch)', () => {
  it('posts {model,input} to {url}/api/embed and returns a Float32Array', async () => {
    const cap: { url?: string; body?: Record<string, unknown> } = {};
    const f = (async (url: string, init: { body: string }) => {
      cap.url = url;
      cap.body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }) };
    }) as unknown as typeof fetch;
    const v = await embedText('deploy is Tuesday', { model: 'bge-m3', url: 'http://ollama.lan:11434', fetchImpl: f });
    expect(cap.url).toBe('http://ollama.lan:11434/api/embed');
    expect(cap.body!.model).toBe('bge-m3');
    expect(cap.body!.input).toBe('deploy is Tuesday');
    expect(v).toBeInstanceOf(Float32Array);
    expect(Array.from(v!)).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
  });

  it('returns null and makes no call when no model is configured', async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, json: async () => ({ embeddings: [[1]] }) };
    }) as unknown as typeof fetch;
    expect(await embedText('hello', { fetchImpl: f })).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null and makes no call for empty text', async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, json: async () => ({ embeddings: [[1]] }) };
    }) as unknown as typeof fetch;
    expect(await embedText('   ', { model: 'bge-m3', fetchImpl: f })).toBeNull();
    expect(called).toBe(false);
  });

  it('fails soft (returns null) on a non-OK response — must never break a write', async () => {
    const f = (async () => ({ ok: false, status: 500, text: async () => 'boom' })) as unknown as typeof fetch;
    expect(await embedText('hi there', { model: 'bge-m3', url: 'http://x:1', fetchImpl: f })).toBeNull();
  });

  it('adds the embed host to NO_PROXY so the call is direct, not gateway-routed', async () => {
    const saved = { n: process.env.NO_PROXY, l: process.env.no_proxy };
    const f = (async () => ({ ok: true, json: async () => ({ embeddings: [[1, 2]] }) })) as unknown as typeof fetch;
    try {
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
      await embedText('x y z', { model: 'bge-m3', url: 'http://embed-host.lan:11434', fetchImpl: f });
      expect(process.env.NO_PROXY).toContain('embed-host.lan');
    } finally {
      saved.n === undefined ? delete process.env.NO_PROXY : (process.env.NO_PROXY = saved.n);
      saved.l === undefined ? delete process.env.no_proxy : (process.env.no_proxy = saved.l);
    }
  });
});
