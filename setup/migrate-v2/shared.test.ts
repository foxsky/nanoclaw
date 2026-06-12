import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { personaFromTrigger, readV1AgentModel } from './shared.js';

// F4 — persona derivation from v1 registered_groups.trigger_pattern.
describe('personaFromTrigger', () => {
  it.each([
    ['@Case', 'Case'],
    ['@Kipp', 'Kipp'],
    ['@Tars', 'Tars'],
    ['@ Spaced ', 'Spaced'], // single leading @ stripped, then trimmed
  ])('strips a single leading @ from %j → %j', (input, expected) => {
    expect(personaFromTrigger(input)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['', ''],
    ['   ', '   '],
    ['.', '.'], // respond-to-everything regex, not a persona
    ['.*', '.*'],
    ['Case', 'Case'], // bare name without @ — don't guess a persona
    ['regex.*pattern', 'regex.*pattern'],
    ['@', '@'], // @ with no name
  ])('returns null for the non-persona pattern %j', (_label, input) => {
    expect(personaFromTrigger(input as string | null)).toBeNull();
  });

  it('does not title-case or otherwise transform the name', () => {
    expect(personaFromTrigger('@lowercase')).toBe('lowercase');
    expect(personaFromTrigger('@MixedCase')).toBe('MixedCase');
  });

  it.each(['@Case\\b', '@(Case|Kipp)', '@Case.*', '@Ca[se]', '@a+b'])(
    'returns null for a regex-shaped @-pattern %j (not a real persona)',
    (input) => {
      expect(personaFromTrigger(input)).toBeNull();
    },
  );

  it('accepts a multi-word persona (space is not a regex metachar)', () => {
    expect(personaFromTrigger('@Maria Silva')).toBe('Maria Silva');
  });
});

// F3 — per-agent model read from v1 session settings.json.
describe('readV1AgentModel', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-model-'));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function seedSettings(folder: string, contents: unknown): string {
    const dir = path.join(root, 'data', 'sessions', folder, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(contents));
    return root;
  }

  it('reads env.ANTHROPIC_MODEL (the v1 storage location)', () => {
    seedSettings('secti-taskflow', { env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6', OTHER: 'x' } });
    expect(readV1AgentModel(root, 'secti-taskflow')).toBe('claude-sonnet-4-6');
  });

  it('falls back to a top-level model key (older v1 variants)', () => {
    seedSettings('legacy', { model: 'claude-opus-4-8' });
    expect(readV1AgentModel(root, 'legacy')).toBe('claude-opus-4-8');
  });

  it('returns null when no model override is present (board inherits SDK default)', () => {
    seedSettings('no-override', { env: { SOMETHING_ELSE: 'y' } });
    expect(readV1AgentModel(root, 'no-override')).toBeNull();
  });

  it('returns null when the settings file is absent', () => {
    expect(readV1AgentModel(root, 'never-existed')).toBeNull();
  });

  it('returns null (never throws) on malformed JSON', () => {
    const dir = path.join(root, 'data', 'sessions', 'broken', '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
    expect(readV1AgentModel(root, 'broken')).toBeNull();
  });

  it('trims and ignores a blank model value', () => {
    seedSettings('blank', { env: { ANTHROPIC_MODEL: '   ' } });
    expect(readV1AgentModel(root, 'blank')).toBeNull();
  });
});
