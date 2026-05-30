import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTaskflowDb } from '../../taskflow-db.js';
import type { Session } from '../../types.js';

const now = '2026-05-30T00:00:00Z';
const TMPROOT = path.join(os.tmpdir(), `nanoclaw-rename-board-person-test-${process.pid}`);

const fakeSession: Session = {
  id: 'sess-main',
  agent_group_id: 'ag-main',
  messaging_group_id: 'mg-main',
  thread_id: null,
  agent_provider: 'claude',
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: now,
};

let gateAllow: boolean;
let tfDb: Database.Database;
const sharedState = vi.hoisted(() => ({ tfDbPath: '' }));

// Main-control gate is unit-tested in permission.test.ts; here we toggle it.
vi.mock('./permission.js', () => ({
  checkMainControlSession: vi.fn(() => gateAllow),
}));

vi.mock('./provision-shared.js', async (orig) => {
  const actual = await orig<typeof import('./provision-shared.js')>();
  return {
    ...actual,
    get TASKFLOW_DB_PATH() {
      return sharedState.tfDbPath;
    },
  };
});

const content = { action: 'rename_board_person', board_id: 'b-1', person_id: 'jeff', name: '  Jefferson Corrected  ' };

beforeEach(() => {
  fs.mkdirSync(TMPROOT, { recursive: true });
  sharedState.tfDbPath = path.join(TMPROOT, `tf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
  tfDb = initTaskflowDb(sharedState.tfDbPath);
  // Same person (person_id 'jeff') on two boards, divergent names.
  tfDb.exec(`
    INSERT INTO boards (id, group_jid, group_folder) VALUES ('b-1','j1','f1'),('b-2','j2','f2');
    INSERT INTO board_people (board_id, person_id, name) VALUES ('b-1','jeff','Jefferson Full'),('b-2','jeff','Jeff');
  `);
  tfDb.close();
  gateAllow = true;
});

afterEach(() => {
  try {
    tfDb.close();
  } catch {}
  fs.rmSync(TMPROOT, { recursive: true, force: true });
});

function names(): Array<{ board_id: string; name: string }> {
  const db = new Database(sharedState.tfDbPath, { readonly: true });
  const rows = db
    .prepare('SELECT board_id, name FROM board_people WHERE person_id=? ORDER BY board_id')
    .all('jeff') as Array<{ board_id: string; name: string }>;
  db.close();
  return rows;
}

describe('handleRenameBoardPerson', () => {
  it('renames the person on EVERY board (per-person identity) + trims, when caller is main control', async () => {
    const { handleRenameBoardPerson } = await import('./rename-board-person.js');
    await handleRenameBoardPerson(content, fakeSession, {} as Database.Database);
    expect(names()).toEqual([
      { board_id: 'b-1', name: 'Jefferson Corrected' },
      { board_id: 'b-2', name: 'Jefferson Corrected' },
    ]);
  });

  it('drops (no write) when the caller is NOT main control', async () => {
    gateAllow = false;
    const { handleRenameBoardPerson } = await import('./rename-board-person.js');
    await handleRenameBoardPerson(content, fakeSession, {} as Database.Database);
    expect(names()).toEqual([
      { board_id: 'b-1', name: 'Jefferson Full' },
      { board_id: 'b-2', name: 'Jeff' },
    ]);
  });

  it('drops on empty name even from main control', async () => {
    const { handleRenameBoardPerson } = await import('./rename-board-person.js');
    await handleRenameBoardPerson({ ...content, name: '   ' }, fakeSession, {} as Database.Database);
    expect(names()).toEqual([
      { board_id: 'b-1', name: 'Jefferson Full' },
      { board_id: 'b-2', name: 'Jeff' },
    ]);
  });
});
