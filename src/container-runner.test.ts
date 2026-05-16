import { describe, expect, it } from 'vitest';

import { replayContainerEnvArgs, resolveProviderName } from './container-runner.js';

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
