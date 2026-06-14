/**
 * RC5-ext inbound — cross-board disambiguation helpers. The board selection is
 * DETERMINISTIC routing (a 1-based index), not a model call: these tests pin
 * that contract and the stable, grant-derived choice ordering.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetParkedDisambiguation,
  bindParkedChoice,
  buildDisambiguationChoices,
  clearParkedDisambiguation,
  getParkedDisambiguation,
  parkDisambiguation,
  parseDisambiguationChoice,
  renderDisambiguationPrompt,
  type ParkedChoice,
} from './parked-disambiguation.js';

afterEach(() => _resetParkedDisambiguation());

const CHOICES: ParkedChoice[] = [
  { boardId: 'b1', groupJid: '111@g.us', label: 'team-alpha' },
  { boardId: 'b2', groupJid: '999@g.us', label: 'team-beta' },
];

describe('buildDisambiguationChoices', () => {
  it('dedupes by board and orders stably by groupJid', () => {
    const choices = buildDisambiguationChoices([
      { boardId: 'b2', groupJid: '999@g.us', groupFolder: 'team-beta' },
      { boardId: 'b1', groupJid: '111@g.us', groupFolder: 'team-alpha' },
      { boardId: 'b1', groupJid: '111@g.us', groupFolder: 'team-alpha' }, // dup meeting on same board
    ]);
    expect(choices.map((c) => c.boardId)).toEqual(['b1', 'b2']); // sorted by groupJid
  });
});

describe('parseDisambiguationChoice', () => {
  it('reads a valid 1-based index', () => {
    expect(parseDisambiguationChoice('2', CHOICES)?.boardId).toBe('b2');
    expect(parseDisambiguationChoice('1 please', CHOICES)?.boardId).toBe('b1');
  });
  it('rejects out-of-range and non-numeric replies', () => {
    expect(parseDisambiguationChoice('3', CHOICES)).toBeNull();
    expect(parseDisambiguationChoice('0', CHOICES)).toBeNull();
    expect(parseDisambiguationChoice('the first one', CHOICES)).toBeNull();
    expect(parseDisambiguationChoice('', CHOICES)).toBeNull();
  });
  it('does not misread a number embedded mid-sentence as a selection', () => {
    // Only a LEADING number selects — "call me at 2pm" must not pick choice 2.
    expect(parseDisambiguationChoice('call me at 2pm', CHOICES)).toBeNull();
  });
});

describe('park / get / bind / clear', () => {
  it('parks then resolves for the matching external only', () => {
    parkDisambiguation('mg-1', 'ext-1', CHOICES);
    expect(getParkedDisambiguation('mg-1', 'ext-1')?.chosen).toBeNull();
    expect(getParkedDisambiguation('mg-1', 'ext-OTHER')).toBeNull(); // bound to ext-1
  });

  it('bindParkedChoice records the selection; clear removes it', () => {
    parkDisambiguation('mg-1', 'ext-1', CHOICES);
    bindParkedChoice('mg-1', 'ext-1', CHOICES[1]);
    expect(getParkedDisambiguation('mg-1', 'ext-1')?.chosen?.boardId).toBe('b2');
    clearParkedDisambiguation('mg-1');
    expect(getParkedDisambiguation('mg-1', 'ext-1')).toBeNull();
  });

  it('bindParkedChoice is a no-op for a mismatched external', () => {
    parkDisambiguation('mg-1', 'ext-1', CHOICES);
    bindParkedChoice('mg-1', 'ext-IMPOSTOR', CHOICES[0]);
    expect(getParkedDisambiguation('mg-1', 'ext-1')?.chosen).toBeNull();
  });
});

describe('renderDisambiguationPrompt', () => {
  it('numbers each choice by label', () => {
    expect(renderDisambiguationPrompt(CHOICES)).toMatch(/1\. team-alpha[\s\S]*2\. team-beta/);
  });
});
