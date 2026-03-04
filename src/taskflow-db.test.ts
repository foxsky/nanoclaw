import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { initTaskflowDb } from './taskflow-db.js';

describe('initTaskflowDb', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates board_people with notification_group_jid', () => {
    const db = initTaskflowDb(':memory:');
    const columns = db
      .prepare(`PRAGMA table_info(board_people)`)
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toContain(
      'notification_group_jid',
    );

    db.close();
  });

  it('adds notification_group_jid to an existing legacy board_people table', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-db-test-'));
    tempDirs.push(tempDir);

    const dbPath = path.join(tempDir, 'taskflow.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE board_people (
        board_id TEXT REFERENCES boards(id),
        person_id TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        role TEXT DEFAULT 'member',
        wip_limit INTEGER,
        PRIMARY KEY (board_id, person_id)
      );
      INSERT INTO boards (id) VALUES ('board-1');
      INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit)
      VALUES ('board-1', 'p1', 'Pat', '5511999999999', 'member', 3);
    `);
    legacyDb.close();

    const db = initTaskflowDb(dbPath);
    const columns = db
      .prepare(`PRAGMA table_info(board_people)`)
      .all() as Array<{ name: string }>;
    const person = db
      .prepare(
        `SELECT person_id, name, notification_group_jid
         FROM board_people
         WHERE board_id = ? AND person_id = ?`,
      )
      .get('board-1', 'p1') as {
      person_id: string;
      name: string;
      notification_group_jid: string | null;
    };

    expect(columns.map((column) => column.name)).toContain(
      'notification_group_jid',
    );
    expect(person).toEqual({
      person_id: 'p1',
      name: 'Pat',
      notification_group_jid: null,
    });

    db.close();
  });
});
