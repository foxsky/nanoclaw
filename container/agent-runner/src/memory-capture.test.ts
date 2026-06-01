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
});
