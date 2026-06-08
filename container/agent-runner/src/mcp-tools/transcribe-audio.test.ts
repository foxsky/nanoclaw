import { describe, expect, it } from 'bun:test';

import { transcribeAudio, transcribeAudioTool } from './transcribe-audio.js';

const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('transcribeAudio', () => {
  it('POSTs the audio to OpenAI Whisper and returns the trimmed transcript', async () => {
    let url = '';
    let body: FormData | null = null;
    const fakeFetch = (async (u: string | URL, init: RequestInit) => {
      url = String(u);
      body = init.body as FormData;
      return new Response('  olá, tudo bem?  ', { status: 200 });
    }) as unknown as typeof fetch;

    const out = await transcribeAudio('/workspace/media/voice.ogg', {
      fetchImpl: fakeFetch,
      readFile: async () => new TextEncoder().encode('FAKE-OGG'),
    });

    expect(out).toBe('olá, tudo bem?');
    expect(url).toContain('/v1/audio/transcriptions');
    expect(body!.get('model')).toBe('whisper-1');
    expect(body!.get('response_format')).toBe('text');
    expect(body!.get('file')).toBeInstanceOf(Blob);
  });

  it('routes through the OneCLI proxy when one is provided', async () => {
    let sawProxy: string | undefined;
    const fakeFetch = (async (_u: string, init: RequestInit & { proxy?: string }) => {
      sawProxy = init.proxy;
      return new Response('hi', { status: 200 });
    }) as unknown as typeof fetch;
    await transcribeAudio('/w/v.ogg', { fetchImpl: fakeFetch, readFile: async () => new Uint8Array([1]), proxy: 'http://onecli-gw:8080' });
    expect(sawProxy).toBe('http://onecli-gw:8080');
  });

  it('throws a clear error when the file cannot be read', async () => {
    await expect(
      transcribeAudio('/nope.ogg', {
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
        readFile: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toThrow(/cannot read audio file/);
  });

  it('rejects an empty audio file without calling the API', async () => {
    let called = false;
    await expect(
      transcribeAudio('/w/empty.ogg', {
        fetchImpl: (async () => {
          called = true;
          return new Response('x', { status: 200 });
        }) as unknown as typeof fetch,
        readFile: async () => new Uint8Array(0),
      }),
    ).rejects.toThrow(/empty/);
    expect(called).toBe(false);
  });

  it('maps a 401 to a clear OneCLI-credential hint', async () => {
    const fakeFetch = (async () => new Response('missing key', { status: 401 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio('/w/v.ogg', { fetchImpl: fakeFetch, readFile: async () => new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow(/OneCLI gateway has no OpenAI credential/);
  });

  it('surfaces a non-auth API error with status + detail', async () => {
    const fakeFetch = (async () => new Response('bad audio format', { status: 400 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio('/w/v.ogg', { fetchImpl: fakeFetch, readFile: async () => new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow(/transcription failed \(400\).*bad audio format/);
  });
});

describe('transcribe_audio tool handler', () => {
  it('errors when path is missing', async () => {
    const r = await transcribeAudioTool.handler({});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/path is required/);
  });

  it('wraps a read failure as a tool error (real fs, nonexistent path — no network)', async () => {
    // Use an ALLOWED-but-nonexistent attachment path so it passes the /workspace/inbox confinement
    // and exercises the read-failure wrapping (a path outside the allowed dirs is refused earlier).
    const r = await transcribeAudioTool.handler({ path: '/workspace/inbox/does-not-exist-xyz-9f2a.ogg' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/transcription failed/);
  });
});
