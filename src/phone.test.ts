import { describe, it, expect } from 'vitest';
import { normalizePhone } from './phone.js';

describe('normalizePhone (Brazilian-aware canonicalization)', () => {
  describe('already-canonical E164 Brazilian inputs pass through unchanged', () => {
    it('13-digit mobile with CC — standard post-2012 format', () => {
      expect(normalizePhone('5585999991234')).toBe('5585999991234');
    });

    it('12-digit landline with CC', () => {
      expect(normalizePhone('558632221234')).toBe('558632221234');
    });

    it('12-digit pre-2012 mobile with CC (8-digit subscriber)', () => {
      expect(normalizePhone('558688983914')).toBe('558688983914');
    });

    it('+55 prefix with formatting', () => {
      expect(normalizePhone('+55 (85) 99999-1234')).toBe('5585999991234');
    });
  });

  describe('Brazilian inputs missing country code get 55 prepended', () => {
    it('11-digit mobile without CC — the core bug', () => {
      expect(normalizePhone('86999986334')).toBe('5586999986334');
    });

    it('10-digit landline without CC', () => {
      expect(normalizePhone('8688080333')).toBe('558688080333');
    });

    it('formatted 11-digit mobile', () => {
      expect(normalizePhone('(85) 99999-1234')).toBe('5585999991234');
    });
  });

  describe('regression: Reginaldo production case must collide', () => {
    // Live production had the same person stored two ways — causing cross-board
    // matching to fail. Both inputs must canonicalize to the same string.
    it('55-prefixed and CC-less forms of the same number match', () => {
      const withCC = normalizePhone('5586999986334');
      const withoutCC = normalizePhone('86999986334');
      expect(withCC).toBe(withoutCC);
    });
  });

  describe('international and degenerate inputs', () => {
    it('empty string → empty string', () => {
      expect(normalizePhone('')).toBe('');
    });

    it('whitespace / non-digits only → empty string', () => {
      expect(normalizePhone('   ---')).toBe('');
    });

    it('too short (< 10 digits) → returns digits unchanged, does not force BR prefix', () => {
      // A 7-digit local number (e.g. a legacy short code) must not become
      // '557654321' — that would produce a phantom Brazilian number.
      expect(normalizePhone('1234567')).toBe('1234567');
    });

    it('US number (10 digits starting with valid BR DDD) — accepted false-positive', () => {
      // US (415) 555-1234 = 4155551234. The first two digits (41) happen to be
      // a valid Brazilian DDD (Curitiba). We prepend 55 anyway. Documented
      // trade-off: the user base is Brazilian government workers, not US
      // subscribers, so this false-positive is acceptable.
      expect(normalizePhone('4155551234')).toBe('554155551234');
    });

    it('already-international non-BR (14+ digits) → kept as-is', () => {
      // +44 20 7946 0958 = 442079460958 (12 digits). This collides with the
      // Brazilian 12-digit E164 format but starts with 44, not 55. Return
      // as-is rather than corrupting it with an extra 55.
      expect(normalizePhone('442079460958')).toBe('442079460958');
    });

    it('14-digit input that starts with 55 → kept as-is (likely bad data)', () => {
      // If someone double-typed '555585999991234', we don't try to heal that.
      expect(normalizePhone('555585999991234')).toBe('555585999991234');
    });
  });

  describe('DDD-0 guard (prevents trunk-code confusion)', () => {
    it('11-digit starting with 0 is NOT prepended (likely trunk-dialed local call)', () => {
      // 0 + DDD + number — '08599991234' — means a trunk-prefixed domestic call.
      // Prepending 55 would yield a bogus '55 + 0 + 85 + ...' number.
      expect(normalizePhone('08599991234')).toBe('08599991234');
    });
  });

  // Parity guard: the container copy (taskflow-engine.ts) and the host
  // copy (phone.ts) must produce identical output. If they drift, either
  // the engine writes rows the host can't look up or vice versa. This test
  // exercises the host copy only; an equivalent copy-pasted test lives in
  // the container suite to exercise the engine copy. If either side is
  // changed, BOTH must be updated.
  describe('parity fixtures (must match taskflow-engine.ts normalizePhone)', () => {
    const fixtures: Array<[string, string]> = [
      ['5585999991234', '5585999991234'],
      ['+55 (85) 99999-1234', '5585999991234'],
      ['86999986334', '5586999986334'],
      ['8688080333', '558688080333'],
      ['558699487547', '558699487547'],
      ['', ''],
      ['   ---', ''],
      ['1234567', '1234567'],
      ['08599991234', '08599991234'],
      ['442079460958', '442079460958'],
    ];
    for (const [input, expected] of fixtures) {
      it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
        expect(normalizePhone(input)).toBe(expected);
      });
    }
  });
});
