import { afterEach, describe, expect, it } from 'bun:test';

import { closeTaskflowDb } from '../db/connection.ts';
import { resolveAuthenticatedSenderPerson } from './actor-person-resolution.ts';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.ts';

// Delta-parity audit 2026-06-10 (HIGH, #419 follow-up): the turn-actor channel
// pins the HOST-authenticated inbound sender, but on the native WhatsApp
// adapter that is a JID ('5586…@s.whatsapp.net'), not a display name — and
// engine person resolution has no phone/JID path, so every person-gated
// operation failed on a live WhatsApp board. This resolver restores V1's
// documented phone-match rule (template Sender Identification rule 3)
// deterministically: exact person_id/name first, else phone-digit match for
// JID/phone-shaped senders. Fail-closed: no match or AMBIGUOUS match → null.

const BOARD = 'board-actor-res';

afterEach(() => {
  closeTaskflowDb();
});

function seed(people: Array<{ id: string; name: string; phone?: string }>) {
  const db = setupEngineDb(BOARD, { withBoardAdmins: true });
  // board_people.phone is host-schema (src/taskflow-db.ts), not ensureTaskSchema.
  applyBoardConfigColumns(db);
  for (const p of people) {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role, phone) VALUES (?, ?, ?, 'member', ?)`,
    ).run(BOARD, p.id, p.name, p.phone ?? null);
  }
  return db;
}

describe('resolveAuthenticatedSenderPerson', () => {
  it('resolves a WhatsApp phone JID to the board person via phone digits', () => {
    const db = seed([{ id: 'bob', name: 'Roberto Lima', phone: '5586981234567' }]);
    expect(resolveAuthenticatedSenderPerson(BOARD, '5586981234567@s.whatsapp.net', db)).toEqual({
      personId: 'bob',
      name: 'Roberto Lima',
    });
  });

  it('resolves a device-suffixed WhatsApp phone JID', () => {
    const db = seed([{ id: 'bob', name: 'Roberto Lima', phone: '5586981234567' }]);
    expect(resolveAuthenticatedSenderPerson(BOARD, '5586981234567:12@s.whatsapp.net', db)?.personId).toBe('bob');
  });

  it('does NOT phone-match bare digits or @lid (only authenticated @s.whatsapp.net — anti-spoof)', () => {
    // Bare digits and LIDs are not authenticated phone JIDs; phone-matching them
    // would let a non-WhatsApp sender impersonate a board member by phone.
    const db = seed([{ id: 'bob', name: 'Roberto Lima', phone: '5586981234567' }]);
    expect(resolveAuthenticatedSenderPerson(BOARD, '5586981234567', db)).toBeNull();
    expect(resolveAuthenticatedSenderPerson(BOARD, '5586981234567@lid', db)).toBeNull();
  });

  it('matches normalized phone variants (stored local format vs JID country format)', () => {
    // normalizePhone canonicalizes both sides: an 11-digit BR-local stored
    // phone matches the 13-digit JID form.
    const db = seed([{ id: 'ana', name: 'Ana Souza', phone: '(86) 98123-4567' }]);
    expect(resolveAuthenticatedSenderPerson(BOARD, '5586981234567@s.whatsapp.net', db)?.personId).toBe('ana');
  });

  it('keeps the existing exact person_id / name resolution (chat-sdk display-name senders)', () => {
    const db = seed([{ id: 'bob', name: 'Roberto Lima', phone: '5586981234567' }]);
    expect(resolveAuthenticatedSenderPerson(BOARD, 'bob', db)?.personId).toBe('bob');
    expect(resolveAuthenticatedSenderPerson(BOARD, 'Roberto Lima', db)?.personId).toBe('bob');
  });

  it('returns null for an unknown JID (fail-closed — engine denies person-gated ops)', () => {
    const db = seed([{ id: 'bob', name: 'Roberto Lima', phone: '5586981234567' }]);
    expect(resolveAuthenticatedSenderPerson(BOARD, '5599999999999@s.whatsapp.net', db)).toBeNull();
  });

  it('returns null when two people share the phone (EX-015 dual-person — ambiguous must not pick one)', () => {
    const db = seed([
      { id: 'mariany', name: 'Mariany Borges', phone: '5586981234567' },
      { id: 'mariany-2', name: 'Mariany B.', phone: '5586981234567' },
    ]);
    expect(resolveAuthenticatedSenderPerson(BOARD, '5586981234567@s.whatsapp.net', db)).toBeNull();
  });

  it('does not phone-match non-JID-shaped display names or group JIDs', () => {
    const db = seed([{ id: 'bob', name: 'Roberto Lima', phone: '5586981234567' }]);
    expect(resolveAuthenticatedSenderPerson(BOARD, 'Maria 1234', db)).toBeNull();
    // group JID digits are not a phone — no match, never a person
    expect(resolveAuthenticatedSenderPerson(BOARD, '120363400000000111@g.us', db)).toBeNull();
  });
});
