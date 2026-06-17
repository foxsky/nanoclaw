import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

// stopContainer shells out to docker; stub it so killContainer can be unit-tested. Keep the rest.
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  stopContainer: vi.fn(),
}));

import {
  __seedActiveContainerForTest,
  ensureAgentSecretMode,
  killContainer,
  resolveFlipMode,
  resolveProviderName,
} from './container-runner.js';

describe('killContainer last-killer-wins (L4)', () => {
  it('a later kill with no onExit cancels an earlier caller’s respawn callback', () => {
    const proc = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (proc as unknown as { kill: () => void }).kill = vi.fn();
    __seedActiveContainerForTest('sess-l4', proc, 'nanoclaw-l4');

    const respawn = vi.fn();
    killContainer('sess-l4', 'self-mod apply', respawn); // earlier caller wants a respawn
    killContainer('sess-l4', 'stuck sweep'); // later caller wants it DEAD (no onExit)
    (proc as unknown as EventEmitter).emit('close', 0);

    // The stale respawn must NOT fire, and no 'close' listener should leak.
    expect(respawn).not.toHaveBeenCalled();
    expect((proc as unknown as EventEmitter).listenerCount('close')).toBe(0);
  });

  it('a single kill still runs its onExit on close (no regression)', () => {
    const proc = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (proc as unknown as { kill: () => void }).kill = vi.fn();
    __seedActiveContainerForTest('sess-l4b', proc, 'nanoclaw-l4b');

    const respawn = vi.fn();
    killContainer('sess-l4b', 'restart', respawn);
    (proc as unknown as EventEmitter).emit('close', 0);

    expect(respawn).toHaveBeenCalledTimes(1);
  });
});

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('resolveFlipMode', () => {
  it('returns null when the knob is unset (opt-in: default off, no behavior change)', () => {
    // The feature must never flip an agent unless the operator explicitly asked. Behavior for
    // anyone who has not set the knob must be byte-identical to before this code shipped.
    expect(resolveFlipMode({})).toBeNull();
  });

  it('passes through both real gateway modes (the knob value IS the mode)', () => {
    expect(resolveFlipMode({ NANOCLAW_ONECLI_AUTO_SECRET_MODE: 'all' })).toBe('all');
    expect(resolveFlipMode({ NANOCLAW_ONECLI_AUTO_SECRET_MODE: 'selective' })).toBe('selective');
  });

  it('fails closed on a malformed value (a typo must not reach the gateway as a bad mode)', () => {
    // Returning null (not the raw string) is what stops `onecli ... --mode al` / a bad PATCH body;
    // the caller separately warns so the operator sees their typo rather than silent no-op.
    expect(resolveFlipMode({ NANOCLAW_ONECLI_AUTO_SECRET_MODE: 'al' })).toBeNull();
    expect(resolveFlipMode({ NANOCLAW_ONECLI_AUTO_SECRET_MODE: '' })).toBeNull();
  });
});

describe('ensureAgentSecretMode', () => {
  const okFetch = () =>
    vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

  it('does NOT call the gateway when mode is null (feature off → zero behavior change)', async () => {
    const fetchImpl = okFetch();
    await ensureAgentSecretMode('ag-1', null, { fetchImpl, flipped: new Set(), inflight: new Map() });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('PATCHes the secret-mode endpoint with Bearer auth + {id,mode}, then records the agent as done', async () => {
    // The flip must hit the gateway's own API with the host's ONECLI_API_KEY (NOT a CLI/HOME
    // profile), so it works regardless of $PATH or where ~/.onecli lives.
    const fetchImpl = okFetch();
    const flipped = new Set<string>();
    await ensureAgentSecretMode('ag-1', 'all', {
      fetchImpl,
      onecliUrl: 'http://gw:10254',
      apiKey: 'k3y',
      flipped,
      inflight: new Map(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(init).toBeDefined();
    expect(url).toBe('http://gw:10254/api/agents/ag-1/secret-mode');
    expect(init!.method).toBe('PATCH');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer k3y');
    expect(JSON.parse(init!.body as string)).toEqual({ id: 'ag-1', mode: 'all' });
    expect(flipped.has('ag-1:all')).toBe(true); // recorded by id:mode → won't re-flip
  });

  it('omits Authorization when no api key is configured (keyless gateway must not get Bearer undefined)', async () => {
    // Mirrors the SDK: an unauthenticated local gateway would 401 forever on `Bearer undefined`.
    const fetchImpl = okFetch();
    await ensureAgentSecretMode('ag-1', 'all', { fetchImpl, apiKey: '', flipped: new Set(), inflight: new Map() });
    const init = fetchImpl.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('skips the gateway for an already-flipped agent (stays off the per-spawn hot path)', async () => {
    // Once a flip has succeeded this process, every later spawn of that agent must be a no-op —
    // no PATCH per message. This is what makes the feature free on the steady-state path.
    const fetchImpl = okFetch();
    await ensureAgentSecretMode('ag-1', 'all', { fetchImpl, flipped: new Set(['ag-1:all']), inflight: new Map() });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keys dedup by id AND mode (a different requested mode is not falsely skipped)', async () => {
    // `selective` already done must NOT suppress an `all` request — they are distinct intents.
    const fetchImpl = okFetch();
    await ensureAgentSecretMode('ag-1', 'all', {
      fetchImpl,
      flipped: new Set(['ag-1:selective']),
      inflight: new Map(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ id: 'ag-1', mode: 'all' });
  });

  it('serializes concurrent first-spawns of the same agent into ONE PATCH (no race/dead-zone)', async () => {
    // Two sessions of the same agent group can spawn at once; without sharing the in-flight
    // promise, one could proceed to applyContainerConfig before the flip lands and boot at 401.
    const fetchImpl = okFetch();
    const flipped = new Set<string>();
    const inflight = new Map<string, Promise<void>>();
    await Promise.all([
      ensureAgentSecretMode('ag-1', 'all', { fetchImpl, flipped, inflight }),
      ensureAgentSecretMode('ag-1', 'all', { fetchImpl, flipped, inflight }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(flipped.has('ag-1:all')).toBe(true);
  });

  it('is fail-soft and RETRIES: a failed flip neither throws nor marks the agent done', async () => {
    // The critical correctness property Codex flagged: a transient gateway error must not
    // permanently strand an agent at 401. It must not abort the spawn (no throw), and the agent
    // must stay out of the done-set so the next spawn re-attempts — eventually succeeding.
    const flipped = new Set<string>();
    const inflight = new Map<string, Promise<void>>();
    const failing = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> =>
        new Response('nope', { status: 503 }),
    );
    await expect(
      ensureAgentSecretMode('ag-1', 'all', { fetchImpl: failing, flipped, inflight }),
    ).resolves.toBeUndefined(); // fail-soft: never throws
    expect(flipped.has('ag-1:all')).toBe(false); // NOT recorded → retried next spawn

    const okAgain = okFetch();
    await ensureAgentSecretMode('ag-1', 'all', { fetchImpl: okAgain, flipped, inflight });
    expect(okAgain).toHaveBeenCalledTimes(1); // the retry actually fires
    expect(flipped.has('ag-1:all')).toBe(true);
  });
});
