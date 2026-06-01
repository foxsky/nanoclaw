import { describe, expect, it } from 'vitest';

import { memoryEnvArgs, replayContainerEnvArgs, resolveProviderName } from './container-runner.js';

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
    ).toEqual(['-e', 'NANOCLAW_MEMORY_EMBED_MODEL=bge-m3', '-e', 'NANOCLAW_MEMORY_EXTRACT_BACKEND=ollama']);
  });

  it('never forwards board scope, proxy, or auth even alongside memory vars', () => {
    // The prefix allowlist is the isolation guarantee: a forwarded var can never override
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

  it('returns nothing when no memory vars are set', () => {
    expect(memoryEnvArgs({ TZ: 'UTC' })).toEqual([]);
  });
});
