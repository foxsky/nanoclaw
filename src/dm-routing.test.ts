import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolveExternalDm, type DmRouteResult } from './dm-routing.js';

function seedDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_contacts (
      external_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      direct_chat_jid TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meeting_external_participants (
      board_id TEXT NOT NULL,
      meeting_task_id TEXT NOT NULL,
      occurrence_scheduled_at TEXT NOT NULL,
      external_id TEXT NOT NULL,
      invite_status TEXT NOT NULL,
      invited_at TEXT,
      accepted_at TEXT,
      revoked_at TEXT,
      access_expires_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (board_id, meeting_task_id, occurrence_scheduled_at, external_id)
    );
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      group_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      board_role TEXT DEFAULT 'standard',
      hierarchy_level INTEGER,
      max_depth INTEGER,
      parent_board_id TEXT,
      short_code TEXT
    );
  `);
  db.exec(`
    INSERT INTO external_contacts VALUES ('ext-1', 'Maria', '5585999991234', '5585999991234@s.whatsapp.net', 'active', '2026-01-01', '2026-01-01', NULL);
    INSERT INTO boards VALUES ('board-1', '120363408855255405@g.us', 'team-alpha', 'standard', NULL, NULL, NULL, NULL);
    INSERT INTO meeting_external_participants VALUES ('board-1', 'M1', '2026-03-12T14:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, '2026-03-19T14:00:00Z', 'person-1', '2026-03-10', '2026-03-10');
  `);
}

describe('resolveExternalDm', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resolves a known DM JID to the board group', () => {
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.groupJid).toBe('120363408855255405@g.us');
    expect(result!.groupFolder).toBe('team-alpha');
    expect(result!.externalId).toBe('ext-1');
    expect(result!.grants).toHaveLength(1);
    expect(result!.grants[0].meetingTaskId).toBe('M1');
  });

  it('returns null for unknown DM JID', () => {
    const result = resolveExternalDm(db, '5585000000000@s.whatsapp.net');
    expect(result).toBeNull();
  });

  it('returns null for expired grants', () => {
    db.exec(
      `UPDATE meeting_external_participants SET invite_status = 'expired'`,
    );
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).toBeNull();
  });

  it('returns null for revoked grants', () => {
    db.exec(
      `UPDATE meeting_external_participants SET invite_status = 'revoked'`,
    );
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).toBeNull();
  });

  it('returns multiple grants when contact is in multiple meetings', () => {
    db.exec(
      `INSERT INTO meeting_external_participants VALUES ('board-1', 'M2', '2026-03-15T10:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, '2026-03-22T10:00:00Z', 'person-1', '2026-03-10', '2026-03-10')`,
    );
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.grants).toHaveLength(2);
  });

  it('performs lazy expiry when access_expires_at is past', () => {
    db.exec(
      `UPDATE meeting_external_participants SET access_expires_at = '2020-01-01T00:00:00Z', invite_status = 'accepted'`,
    );
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).toBeNull();
    // Verify status was updated to expired
    const row = db
      .prepare(`SELECT invite_status FROM meeting_external_participants`)
      .get() as any;
    expect(row.invite_status).toBe('expired');
  });

  it('flags needsDisambiguation when active grants span different groups', () => {
    db.exec(
      `INSERT INTO boards VALUES ('board-2', '999999999@g.us', 'team-beta', 'standard', NULL, NULL, NULL, NULL)`,
    );
    db.exec(
      `INSERT INTO meeting_external_participants VALUES ('board-2', 'M5', '2026-03-20T10:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, '2026-03-27T10:00:00Z', 'person-2', '2026-03-10', '2026-03-10')`,
    );
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.needsDisambiguation).toBe(true);
  });

  it('does NOT flag needsDisambiguation for multiple meetings on the same board', () => {
    db.exec(
      `INSERT INTO meeting_external_participants VALUES ('board-1', 'M2', '2026-03-15T10:00:00Z', 'ext-1', 'accepted', '2026-03-10', '2026-03-10', NULL, '2026-03-22T10:00:00Z', 'person-1', '2026-03-10', '2026-03-10')`,
    );
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.needsDisambiguation).toBe(false);
    expect(result!.grants).toHaveLength(2);
  });

  it('resolves by phone fallback when direct_chat_jid is null', () => {
    db.exec(`UPDATE external_contacts SET direct_chat_jid = NULL`);
    // Phone-based lookup: strip @s.whatsapp.net and match
    const result = resolveExternalDm(db, '5585999991234@s.whatsapp.net');
    expect(result).not.toBeNull();
    expect(result!.externalId).toBe('ext-1');
    // Verify direct_chat_jid was backfilled
    const row = db
      .prepare(
        `SELECT direct_chat_jid FROM external_contacts WHERE external_id = 'ext-1'`,
      )
      .get() as any;
    expect(row.direct_chat_jid).toBe('5585999991234@s.whatsapp.net');
  });
});
