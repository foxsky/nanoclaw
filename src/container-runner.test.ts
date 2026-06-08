import { describe, expect, it } from 'vitest';

import {
  holidayExemptEnvArgs,
  memoryEnvArgs,
  replayContainerEnvArgs,
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
    expect(holidayExemptEnvArgs('acme', { TASKFLOW_HOLIDAY_EXEMPT: '' })).toEqual([
      '-e',
      'NANOCLAW_GROUP_FOLDER=acme',
    ]);
  });
});
