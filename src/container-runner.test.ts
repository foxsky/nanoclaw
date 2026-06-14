import { describe, expect, it, vi } from 'vitest';

import {
  ensureAgentSecretMode,
  holidayExemptEnvArgs,
  memoryEnvArgs,
  replayContainerEnvArgs,
  resolveFlipMode,
  resolveProviderName,
  taskflowEmbedEnvArgs,
} from './container-runner.js';

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

describe('replayContainerEnvArgs', () => {
  it('passes Phase 3 historical replay time into the container', () => {
    expect(
      replayContainerEnvArgs({
        NANOCLAW_TOOL_USES_PATH: '/workspace/.tool-uses.jsonl',
        NANOCLAW_PHASE2_RAW_PROMPT: '1',
        NANOCLAW_PHASE_REPLAY_NOW: '2026-05-12T13:59:45.000Z',
      }),
    ).toEqual([
      '-e',
      'NANOCLAW_TOOL_USES_PATH=/workspace/.tool-uses.jsonl',
      '-e',
      'NANOCLAW_PHASE2_RAW_PROMPT=1',
      '-e',
      'NANOCLAW_PHASE_REPLAY_NOW=2026-05-12T13:59:45.000Z',
    ]);
  });
});

describe('memoryEnvArgs', () => {
  it('forwards operator-set NANOCLAW_MEMORY_* host env into the container', () => {
    expect(
      memoryEnvArgs({
        NANOCLAW_MEMORY_EMBED_MODEL: 'bge-m3',
        NANOCLAW_MEMORY_EXTRACT_BACKEND: 'ollama',
      }),
    ).toEqual(['-e', 'NANOCLAW_MEMORY_EXTRACT_BACKEND=ollama', '-e', 'NANOCLAW_MEMORY_EMBED_MODEL=bge-m3']);
  });

  it('never forwards board scope, proxy, or auth even alongside memory vars', () => {
    // The allowlist is the isolation guarantee: a forwarded var can never override
    // NANOCLAW_TASKFLOW_BOARD_ID (cross-board leak) nor the gateway proxy/auth.
    expect(
      memoryEnvArgs({
        NANOCLAW_MEMORY_EMBED_MODEL: 'bge-m3',
        NANOCLAW_TASKFLOW_BOARD_ID: 'board-someone-else',
        HTTPS_PROXY: 'http://gateway:8080',
        ANTHROPIC_AUTH_TOKEN: 'secret',
      }),
    ).toEqual(['-e', 'NANOCLAW_MEMORY_EMBED_MODEL=bge-m3']);
  });

  it('forwards only the known knobs, not arbitrary NANOCLAW_MEMORY_* names', () => {
    // Exact allowlist (not a prefix): an operator who names a secret in the namespace must
    // not have it forwarded into every container.
    expect(
      memoryEnvArgs({
        NANOCLAW_MEMORY_EMBED_MODEL: 'bge-m3',
        NANOCLAW_MEMORY_SECRET: 'should-not-leak',
      }),
    ).toEqual(['-e', 'NANOCLAW_MEMORY_EMBED_MODEL=bge-m3']);
  });

  it('returns nothing when no memory vars are set', () => {
    expect(memoryEnvArgs({ TZ: 'UTC' })).toEqual([]);
  });
});

describe('taskflowEmbedEnvArgs', () => {
  it('returns [] when OLLAMA_HOST is unset (feature off — no semantic search)', () => {
    expect(taskflowEmbedEnvArgs({})).toEqual([]);
    // model alone is not enough — the host feeder is what gates the feature
    expect(taskflowEmbedEnvArgs({ EMBEDDING_MODEL: 'bge-m3' })).toEqual([]);
  });

  it('forwards OLLAMA_HOST + EMBEDDING_MODEL under the NANOCLAW_TASKFLOW_EMBED_* namespace', () => {
    // The container must embed the search query with the SAME model the host
    // feeder indexed tasks with, else query/task vectors are incomparable.
    expect(taskflowEmbedEnvArgs({ OLLAMA_HOST: 'http://192.168.2.13:11434', EMBEDDING_MODEL: 'bge-m3' })).toEqual([
      '-e',
      'NANOCLAW_TASKFLOW_EMBED_URL=http://192.168.2.13:11434',
      '-e',
      'NANOCLAW_TASKFLOW_EMBED_MODEL=bge-m3',
    ]);
  });

  it('defaults the model to bge-m3 (the feeder default) when EMBEDDING_MODEL is unset', () => {
    expect(taskflowEmbedEnvArgs({ OLLAMA_HOST: 'http://h:11434' })).toEqual([
      '-e',
      'NANOCLAW_TASKFLOW_EMBED_URL=http://h:11434',
      '-e',
      'NANOCLAW_TASKFLOW_EMBED_MODEL=bge-m3',
    ]);
  });
});

describe('holidayExemptEnvArgs', () => {
  it('ALWAYS forwards the group folder so the container gate can match the exempt key', () => {
    // NANOCLAW_GROUP_FOLDER is the exempt key the container's isHolidayExempt matches
    // ('folder' or 'folder:kind'). Without it forwarded, every holiday-exempt entry is dead
    // in the warm gate. Must be present even with no operator exempt list set.
    expect(holidayExemptEnvArgs('thiago-taskflow', {})).toEqual(['-e', 'NANOCLAW_GROUP_FOLDER=thiago-taskflow']);
  });

  it('forwards TASKFLOW_HOLIDAY_EXEMPT verbatim under the SAME name the container reads', () => {
    // The container's isHolidayExempt reads process.env.TASKFLOW_HOLIDAY_EXEMPT directly, so
    // the host must inject it under that exact name and value — no rename, no reformat.
    expect(holidayExemptEnvArgs('acme', { TASKFLOW_HOLIDAY_EXEMPT: 'acme:standup,beta' })).toEqual([
      '-e',
      'NANOCLAW_GROUP_FOLDER=acme',
      '-e',
      'TASKFLOW_HOLIDAY_EXEMPT=acme:standup,beta',
    ]);
  });

  it('does NOT emit a TASKFLOW_HOLIDAY_EXEMPT entry when unset (no empty -e)', () => {
    // An empty `-e TASKFLOW_HOLIDAY_EXEMPT=` would make the container read '' (falsy, fine) but
    // pollutes the arg list; more importantly the contract is "only when set". Folder still goes.
    expect(holidayExemptEnvArgs('acme', {})).toEqual(['-e', 'NANOCLAW_GROUP_FOLDER=acme']);
    expect(holidayExemptEnvArgs('acme', { TASKFLOW_HOLIDAY_EXEMPT: '' })).toEqual(['-e', 'NANOCLAW_GROUP_FOLDER=acme']);
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
    await ensureAgentSecretMode('ag-1', 'all', { fetchImpl, flipped: new Set(['ag-1:selective']), inflight: new Map() });
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
      async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => new Response('nope', { status: 503 }),
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
