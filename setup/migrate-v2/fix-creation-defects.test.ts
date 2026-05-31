import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkpointReportsBusyWriter, detectDuplicateBoards, mergeDuplicatePerson } from './fix-creation-defects.js';

let db: Database.Database;

function schema(d: Database.Database) {
  d.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, owner_person_id TEXT, parent_board_id TEXT);
    CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, role TEXT, phone TEXT, wip_limit INTEGER, PRIMARY KEY(board_id, person_id));
    CREATE TABLE board_admins (board_id TEXT, person_id TEXT, phone TEXT, admin_role TEXT, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY(board_id, person_id, admin_role));
    CREATE TABLE tasks (id TEXT PRIMARY KEY, board_id TEXT, assignee TEXT, _last_mutation TEXT, notes TEXT);
    CREATE TABLE archive (id TEXT PRIMARY KEY, board_id TEXT, assignee TEXT, task_snapshot TEXT, history TEXT);
    CREATE TABLE task_history (id TEXT PRIMARY KEY, task_id TEXT, "by" TEXT, details TEXT);
  `);
}

// Reproduce the real Mariany shape: a role/phone-less stub `mariany` and a full
// `mariany-borges` ON THE SAME BOARD (so the stub PK-collides and must be deleted),
// the stub carrying delegate+manager admin grants `mariany-borges` lacks, plus
// assignee + by + JSON-embedded refs.
function seedMariany(d: Database.Database) {
  d.exec(`
    INSERT INTO boards VALUES
      ('board-seci-taskflow','jseci','',''),
      ('board-semcaspi','jsem','mariany-borges','board-seci-taskflow');
    INSERT INTO board_people VALUES
      ('board-seci-taskflow','mariany','Mariany Borges','','',NULL),
      ('board-seci-taskflow','mariany-borges','Mariany Borges','Analista de Inovação','5586981352365',NULL),
      ('board-semcaspi','mariany-borges','Mariany Borges','Analista de Inovação','5586981352365',3);
    INSERT INTO board_admins VALUES
      ('board-seci-taskflow','mariany','','delegate',0),
      ('board-seci-taskflow','mariany','','manager',0),
      ('board-semcaspi','mariany-borges','5586981352365','manager',1);
    INSERT INTO tasks VALUES
      ('T1','board-seci-taskflow','mariany','{"action":"approve","by":"mariany","at":"x"}','[{"by":"mariany","author_actor_id":"mariany","text":"oi"},{"by":"mariany-borges","author_actor_id":"mariany-borges"}]'),
      ('T2','board-seci-taskflow','mariany-borges','{"by":"mariany-borges"}','[]');
    INSERT INTO archive VALUES
      ('A1','board-seci-taskflow','mariany','{"assignee":"mariany"}','[{"by":"mariany"}]');
    INSERT INTO task_history VALUES
      ('H1','T1','mariany','{"from":"review","to":"done"}'),
      ('H2','T1','mariany','{"actor":"mariany"}'),
      ('H3','T2','mariany-borges','{"actor":"mariany-borges"}');
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  schema(db);
});
afterEach(() => db.close());

describe('mergeDuplicatePerson (Mariany)', () => {
  it('merges the stub into the full id across every table and removes the stub', () => {
    seedMariany(db);
    const summary = mergeDuplicatePerson(db, 'mariany', 'mariany-borges');

    // stub gone everywhere
    expect(db.prepare(`SELECT count(*) c FROM board_people WHERE person_id='mariany'`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT count(*) c FROM board_admins WHERE person_id='mariany'`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT count(*) c FROM tasks WHERE assignee='mariany'`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT count(*) c FROM archive WHERE assignee='mariany'`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT count(*) c FROM task_history WHERE "by"='mariany'`).get()).toEqual({ c: 0 });

    // the full person now carries the transferred admin grants (delegate + manager) on the parent board
    const roles = db
      .prepare(`SELECT admin_role FROM board_admins WHERE board_id='board-seci-taskflow' AND person_id='mariany-borges' ORDER BY admin_role`)
      .all()
      .map((r: any) => r.admin_role);
    expect(roles).toEqual(['delegate', 'manager']);

    // exactly one board_people row for the person on the parent board (stub deleted, full kept)
    expect(db.prepare(`SELECT count(*) c FROM board_people WHERE board_id='board-seci-taskflow' AND person_id='mariany-borges'`).get()).toEqual({ c: 1 });

    // JSON token rewrite happened, and did NOT corrupt pre-existing "mariany-borges"
    expect(db.prepare(`SELECT _last_mutation m FROM tasks WHERE id='T1'`).get()).toEqual({ m: '{"action":"approve","by":"mariany-borges","at":"x"}' });
    expect(db.prepare(`SELECT _last_mutation m FROM tasks WHERE id='T2'`).get()).toEqual({ m: '{"by":"mariany-borges"}' });
    expect(db.prepare(`SELECT details d FROM task_history WHERE id='H2'`).get()).toEqual({ d: '{"actor":"mariany-borges"}' });
    expect(db.prepare(`SELECT details d FROM task_history WHERE id='H3'`).get()).toEqual({ d: '{"actor":"mariany-borges"}' });

    // tasks.notes (the column Codex caught) rewritten, pre-existing "mariany-borges" untouched
    expect(db.prepare(`SELECT notes n FROM tasks WHERE id='T1'`).get()).toEqual({
      n: '[{"by":"mariany-borges","author_actor_id":"mariany-borges","text":"oi"},{"by":"mariany-borges","author_actor_id":"mariany-borges"}]',
    });

    expect(summary.boardPeopleDeleted).toBe(1);
    expect(summary.adminsTransferred).toBe(2);
    expect(summary.tasksReassigned).toBe(1);
  });

  it('is idempotent — a second run changes nothing', () => {
    seedMariany(db);
    mergeDuplicatePerson(db, 'mariany', 'mariany-borges');
    const second = mergeDuplicatePerson(db, 'mariany', 'mariany-borges');
    expect(second.applied).toBe(false);
    expect(db.prepare(`SELECT count(*) c FROM board_people WHERE person_id='mariany-borges'`).get()).toEqual({ c: 2 });
  });

  it('no-ops (does not throw) when the stub is absent', () => {
    db.exec(`INSERT INTO board_people VALUES ('board-seci-taskflow','mariany-borges','Mariany Borges','Analista','555',NULL);`);
    const summary = mergeDuplicatePerson(db, 'mariany', 'mariany-borges');
    expect(summary.applied).toBe(false);
  });

  it('refuses to merge if the keeper does not exist (guards against a bad pair)', () => {
    db.exec(`INSERT INTO board_people VALUES ('b','mariany','Mariany','','',NULL);`);
    expect(() => mergeDuplicatePerson(db, 'mariany', 'mariany-borges')).toThrow(/keeper/i);
  });

  // Production data embeds JSON columns AS STRINGS inside other JSON (update snapshots,
  // archive payloads), so a ref is stored doubly-serialized as \"mariany\" — which the
  // plain "mariany" token never matches. The old merge left these behind AND the
  // residual scan reported success (verified on the live snapshot: 4 escaped survivors).
  it('rewrites escaped JSON refs (\\"mariany\\") embedded in serialized snapshots', () => {
    db.exec(`INSERT INTO board_people VALUES ('b','mariany-borges','Mariany Borges','Analista','555',NULL);`);
    const embedded = JSON.stringify({ snapshot: JSON.stringify({ by: 'mariany' }) }); // contains \"mariany\"
    db.prepare(`INSERT INTO tasks VALUES ('T9','b','mariany-borges', ?, '[]')`).run(embedded);

    mergeDuplicatePerson(db, 'mariany', 'mariany-borges');

    const m = (db.prepare(`SELECT _last_mutation AS m FROM tasks WHERE id='T9'`).get() as { m: string }).m;
    expect(m.includes('\\"mariany\\"')).toBe(false); // escaped stub ref converted
    expect(m.includes('\\"mariany-borges\\"')).toBe(true);
  });

  // The residual scan must FAIL LOUD (roll back) on any surviving stub ref the rewrite
  // didn't convert — e.g. a deeper-escaped form — rather than report a false success.
  it('rolls back if any stub ref survives the rewrite (deeper-escaped form)', () => {
    db.exec(`INSERT INTO board_people VALUES ('b','mariany-borges','Mariany Borges','Analista','555',NULL);`);
    const doubleEscaped = JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ by: 'mariany' }) }) });
    db.prepare(`INSERT INTO tasks VALUES ('T10','b','mariany-borges', ?, '[]')`).run(doubleEscaped);

    expect(() => mergeDuplicatePerson(db, 'mariany', 'mariany-borges')).toThrow(/still referenced|rolled back/);
    // rolled back: the deeper-escaped ref is untouched (no partial mutation)
    const m = (db.prepare(`SELECT _last_mutation AS m FROM tasks WHERE id='T10'`).get() as { m: string }).m;
    expect(m.includes('mariany')).toBe(true);
  });
});

describe('checkpointReportsBusyWriter (--apply live-writer guard)', () => {
  // PRAGMA wal_checkpoint(TRUNCATE) does NOT throw on contention — it returns a row
  // whose `busy` field is 1 when a live writer blocks the checkpoint. The guard must
  // inspect that field, not rely on a thrown SQLITE_BUSY (which never comes).
  it('refuses when busy=1 (a live writer holds the db)', () => {
    expect(checkpointReportsBusyWriter([{ busy: 1, log: 5, checkpointed: 0 }])).toBe(true);
  });

  it('proceeds when busy=0 (stale WAL fully checkpointed)', () => {
    expect(checkpointReportsBusyWriter([{ busy: 0, log: 0, checkpointed: 0 }])).toBe(false);
  });

  it('proceeds on a non-WAL no-op checkpoint (busy=0, log/checkpointed=-1)', () => {
    expect(checkpointReportsBusyWriter([{ busy: 0, log: -1, checkpointed: -1 }])).toBe(false);
  });

  it('proceeds (does not refuse) on an empty/absent result row', () => {
    expect(checkpointReportsBusyWriter([])).toBe(false);
  });
});

describe('detectDuplicateBoards', () => {
  it('flags boards sharing the same owner + parent (the Hudson cluster), and not unique ones', () => {
    db.exec(`
      INSERT INTO boards VALUES
        ('board-hudson','j1','hudson','board-thiago'),
        ('board-po-setd','j2','hudson','board-thiago'),
        ('board-po-setd-2','j3','hudson','board-thiago'),
        ('board-solo','j4','ana','board-thiago');
    `);
    const dups = detectDuplicateBoards(db);
    expect(dups).toHaveLength(1);
    expect(dups[0].ids.sort()).toEqual(['board-hudson', 'board-po-setd', 'board-po-setd-2']);
    expect(dups[0].owner).toBe('hudson');
  });
});
