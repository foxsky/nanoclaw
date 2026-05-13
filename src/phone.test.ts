import { describe, expect, it } from 'vitest';

import { isWhatsAppJid } from './phone.js';

describe('isWhatsAppJid', () => {
  it('accepts WhatsApp group JIDs (@g.us)', () => {
    expect(isWhatsAppJid('120363426975449622@g.us')).toBe(true);
    expect(isWhatsAppJid('120363425774136187@g.us')).toBe(true);
  });

  it('accepts personal handle JIDs (@s.whatsapp.net)', () => {
    expect(isWhatsAppJid('5585999990001@s.whatsapp.net')).toBe(true);
  });

  it('accepts broadcast JIDs (@broadcast)', () => {
    expect(isWhatsAppJid('5585999990001@broadcast')).toBe(true);
  });

  it('rejects non-JID strings (destination names, empty, undefined)', () => {
    expect(isWhatsAppJid('Ana Beatriz')).toBe(false);
    expect(isWhatsAppJid('seci-taskflow')).toBe(false);
    expect(isWhatsAppJid('')).toBe(false);
    expect(isWhatsAppJid(null)).toBe(false);
    expect(isWhatsAppJid(undefined)).toBe(false);
  });

  it('is case-insensitive on the suffix', () => {
    expect(isWhatsAppJid('120363@G.US')).toBe(true);
    expect(isWhatsAppJid('5585@S.WhatsApp.Net')).toBe(true);
  });
});
