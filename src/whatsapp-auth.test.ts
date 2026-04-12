import { describe, expect, it } from 'vitest';

import { sanitizePhoneNumber } from './whatsapp-auth.js';

describe('sanitizePhoneNumber', () => {
  it('strips a leading + before the country code', () => {
    expect(sanitizePhoneNumber('+14155551234')).toBe('14155551234');
  });

  it('strips spaces from formatted international numbers', () => {
    expect(sanitizePhoneNumber('+1 415 555 1234')).toBe('14155551234');
    expect(sanitizePhoneNumber('55 11 99999 9999')).toBe('5511999999999');
  });

  it('strips dashes and parentheses', () => {
    expect(sanitizePhoneNumber('+1 (415) 555-1234')).toBe('14155551234');
  });

  it('passes through already-clean numbers', () => {
    expect(sanitizePhoneNumber('14155551234')).toBe('14155551234');
  });

  it('rejects undefined or empty input', () => {
    expect(sanitizePhoneNumber(undefined)).toBeNull();
    expect(sanitizePhoneNumber('')).toBeNull();
    expect(sanitizePhoneNumber('   ')).toBeNull();
  });

  it('rejects too-short numbers (likely typos, not real phones)', () => {
    expect(sanitizePhoneNumber('1234567')).toBeNull();
  });

  it('rejects numbers with a leading 0 (trunk prefix, missing country code)', () => {
    // e.g. Brazilian national format "011 99999 9999" — Baileys needs country code
    expect(sanitizePhoneNumber('011999999999')).toBeNull();
    expect(sanitizePhoneNumber('0 11 99999 9999')).toBeNull();
  });

  it('rejects input that is only non-digit characters', () => {
    expect(sanitizePhoneNumber('+++---')).toBeNull();
    expect(sanitizePhoneNumber('abc')).toBeNull();
  });
});
