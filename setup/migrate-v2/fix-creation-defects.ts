/**
 * One-shot remediation for the V1 board/user CREATION defects that survive the
 * v2 cutover (see docs/v1-creation-empirical-map.md). Run AFTER the verbatim
 * taskflow.db copy (setup/migrate-v2/taskflow.ts), against the migrated v2 db.
 *
 * Of the 3 carried-forward data populations, only ONE is a safe SQL fix:
 *   - Mariany (dual person_id)        -> auto-merged here (EX-015).
 *   - Sanunciel (orphaned person)     -> NOT fixable by SQL (a board needs a real
 *                                        WhatsApp group); flagged for live re-provision.
 *   - Hudson duplicate board cluster  -> real, populated boards with their own
 *                                        groups; an operator decision, flagged not fixed.
 *
 * Default is DRY-RUN. Pass --apply to mutate. Idempotent + transactional, with a
 * post-merge residual scan that rolls back and fails loud if any reference to the
 * stub id survives.
 */

import Database from 'better-sqlite3';

// Every column that can hold a person_id — either as the bare value or embedded as
// a quoted `"<id>"` token in a JSON blob. board_people / board_admins are handled
// separately (composite PKs). Each column gets BOTH an exact rewrite and a JSON
// token rewrite: on a pure-value column the token pass no-ops (no quotes match),
// on a pure-JSON column the exact pass no-ops — so the union is correct everywhere
// and we never have to classify a column by kind.
const PERSON_REF_COLUMNS: Array<[table: string, column: string]> = [
  ['boards', 'owner_person_id'],
  ['tasks', 'assignee'],
  ['tasks', 'created_by'],
  ['tasks', 'child_exec_person_id'],
  ['tasks', '_last_mutation'],
  ['tasks', 'notes'],
  ['tasks', 'participants'],
  ['tasks', 'subtasks'],
  ['task_history', 'by'],
  ['task_history', 'details'],
  ['archive', 'assignee'],
  ['archive', 'task_snapshot'],
  ['archive', 'history'],
  ['child_board_registrations', 'person_id'],
  ['attachment_audit_log', 'actor_person_id'],
  ['meeting_external_participants', 'created_by'],
  ['subtask_requests', 'requested_by_person_id'],
  ['subtask_requests', 'subtasks_json'],
  // Dead v1 stub table (empty in v2), but keep the merge + residual scan
  // schema-complete in case it is ever populated before --apply runs.
  ['people', 'person_id'],
];

export interface MergeSummary {
  applied: boolean;
  boardPeopleDeleted: number;
  boardPeopleRekeyed: number;
  adminsTransferred: number;
  adminsDropped: number;
  tasksReassigned: number;
  exactUpdates: number;
  jsonRewrites: number;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/** Columns that still contain the stub id (exact value OR quoted JSON token). */
function residualColumns(db: Database.Database, stubId: string): string[] {
  const token = `%"${stubId}"%`;
  const out: string[] = [];
  const checks: Array<[string, string]> = [['board_people', 'person_id'], ['board_admins', 'person_id'], ...PERSON_REF_COLUMNS];
  for (const [table, col] of checks) {
    if (!columnExists(db, table, col)) continue;
    const n = (db.prepare(`SELECT count(*) AS c FROM ${table} WHERE "${col}" = ? OR "${col}" LIKE ?`).get(stubId, token) as { c: number }).c;
    if (n > 0) out.push(`${table}.${col} (${n})`);
  }
  return out;
}

/**
 * Merge a role/phone-less duplicate `stubId` into the canonical `keeperId`,
 * rewriting every reference. SCOPED to a known, human-confirmed pair — this is
 * NOT a general name-based auto-merge (that would risk merging two real people).
 * The JSON rewrite is token-safe: `"stub"` never matches inside `"stub-suffix"`.
 * After rewriting, a residual scan throws (rolling back) if any stub ref survives.
 */
export function mergeDuplicatePerson(db: Database.Database, stubId: string, keeperId: string): MergeSummary {
  const keeperExists = db.prepare(`SELECT 1 FROM board_people WHERE person_id = ? LIMIT 1`).get(keeperId);
  if (!keeperExists) {
    throw new Error(`merge aborted: keeper person_id '${keeperId}' not found in board_people`);
  }

  const token = `"${stubId}"`;
  const replacement = `"${keeperId}"`;
  const like = `%${token}%`;

  const run = db.transaction((): MergeSummary => {
    const s: MergeSummary = {
      applied: false,
      boardPeopleDeleted: 0,
      boardPeopleRekeyed: 0,
      adminsTransferred: 0,
      adminsDropped: 0,
      tasksReassigned: 0,
      exactUpdates: 0,
      jsonRewrites: 0,
    };

    // board_people PK (board_id, person_id): where the keeper already shares the
    // board the stub row collides -> delete it; otherwise rekey it onto the keeper.
    for (const { board_id } of db.prepare(`SELECT board_id FROM board_people WHERE person_id = ?`).all(stubId) as Array<{ board_id: string }>) {
      const keeperHere = db.prepare(`SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?`).get(board_id, keeperId);
      if (keeperHere) {
        db.prepare(`DELETE FROM board_people WHERE board_id = ? AND person_id = ?`).run(board_id, stubId);
        s.boardPeopleDeleted++;
      } else {
        db.prepare(`UPDATE board_people SET person_id = ? WHERE board_id = ? AND person_id = ?`).run(keeperId, board_id, stubId);
        s.boardPeopleRekeyed++;
      }
    }

    // board_admins PK (board_id, person_id, admin_role): transfer each grant unless
    // the keeper already holds that exact role on that board (then drop the dup).
    for (const { board_id, admin_role } of db.prepare(`SELECT board_id, admin_role FROM board_admins WHERE person_id = ?`).all(stubId) as Array<{ board_id: string; admin_role: string }>) {
      const collides = db.prepare(`SELECT 1 FROM board_admins WHERE board_id = ? AND person_id = ? AND admin_role = ?`).get(board_id, keeperId, admin_role);
      if (collides) {
        db.prepare(`DELETE FROM board_admins WHERE board_id = ? AND person_id = ? AND admin_role = ?`).run(board_id, stubId, admin_role);
        s.adminsDropped++;
      } else {
        db.prepare(`UPDATE board_admins SET person_id = ? WHERE board_id = ? AND person_id = ? AND admin_role = ?`).run(keeperId, board_id, stubId, admin_role);
        s.adminsTransferred++;
      }
    }

    for (const [table, col] of PERSON_REF_COLUMNS) {
      if (!columnExists(db, table, col)) continue;
      const exact = db.prepare(`UPDATE ${table} SET "${col}" = ? WHERE "${col}" = ?`).run(keeperId, stubId).changes;
      const json = db.prepare(`UPDATE ${table} SET "${col}" = REPLACE("${col}", ?, ?) WHERE "${col}" LIKE ?`).run(token, replacement, like).changes;
      s.exactUpdates += exact;
      s.jsonRewrites += json;
      if (table === 'tasks' && col === 'assignee') s.tasksReassigned = exact;
    }

    // Fail loud: nothing referencing the stub may survive. Throwing rolls back the txn.
    const residual = residualColumns(db, stubId);
    if (residual.length > 0) {
      throw new Error(`merge aborted (rolled back): stub '${stubId}' still referenced by ${residual.join(', ')} — add these columns to PERSON_REF_COLUMNS`);
    }

    s.applied = s.boardPeopleDeleted + s.boardPeopleRekeyed + s.adminsTransferred + s.adminsDropped + s.exactUpdates + s.jsonRewrites > 0;
    return s;
  });

  return run();
}

export interface DuplicateBoardCluster {
  owner: string;
  parent: string;
  ids: string[];
}

/** Boards sharing the same (owner_person_id, parent_board_id) — the double-fire signature. */
export function detectDuplicateBoards(db: Database.Database): DuplicateBoardCluster[] {
  return (
    db
      .prepare(
        `SELECT owner_person_id AS owner, parent_board_id AS parent, group_concat(id) AS ids, count(*) AS n
         FROM boards
         WHERE owner_person_id IS NOT NULL AND owner_person_id != '' AND parent_board_id IS NOT NULL
         GROUP BY owner_person_id, parent_board_id
         HAVING n > 1`,
      )
      .all() as Array<{ owner: string; parent: string; ids: string }>
  ).map((r) => ({ owner: r.owner, parent: r.parent, ids: String(r.ids).split(',') }));
}

export interface StubDuplicate {
  boardId: string;
  stubId: string;
  keeperId: string;
  name: string;
}

/** Read-only: a role/phone-less board_people row whose name also appears under a
 *  DIFFERENT, fully-populated person_id on the same board (the Mariany signature).
 *  Surfaces candidates for human review — does NOT auto-merge. */
export function detectStubDuplicateIdentities(db: Database.Database): StubDuplicate[] {
  return db
    .prepare(
      `SELECT a.board_id AS boardId, a.person_id AS stubId, b.person_id AS keeperId, a.name AS name
       FROM board_people a JOIN board_people b
         ON a.board_id = b.board_id AND a.name = b.name AND a.person_id <> b.person_id
       WHERE (a.role IS NULL OR a.role = '') AND (a.phone IS NULL OR a.phone = '')
         AND b.role IS NOT NULL AND b.role != ''`,
    )
    .all() as StubDuplicate[];
}

/** Targeted check for a known orphaned person (registered, owns no board). */
export function checkOrphanPerson(db: Database.Database, personId: string): { present: boolean; ownsBoard: boolean; taskCount: number } {
  const present = !!db.prepare(`SELECT 1 FROM board_people WHERE person_id = ? LIMIT 1`).get(personId);
  const ownsBoard = !!db.prepare(`SELECT 1 FROM boards WHERE owner_person_id = ? LIMIT 1`).get(personId);
  const taskCount = (db.prepare(`SELECT count(*) AS c FROM tasks WHERE assignee = ?`).get(personId) as { c: number }).c;
  return { present, ownsBoard, taskCount };
}

/**
 * `PRAGMA wal_checkpoint(TRUNCATE)` does NOT throw on contention — it returns a row
 * whose `busy` column is 1 when a live writer blocks the checkpoint (0 otherwise; -1
 * log/checkpointed on a non-WAL no-op). So the --apply live-writer guard must inspect
 * the row, not catch a thrown SQLITE_BUSY (which never comes). Note this only detects
 * an ACTIVE lock holder, not an idle-but-open connection — the real "v1 stopped"
 * guarantee is out-of-band (Checklist #6 runs on the migrated copy, after the taskflow
 * copy step's service gate, before the canary).
 */
export function checkpointReportsBusyWriter(rows: Array<{ busy?: number }>): boolean {
  return (rows[0]?.busy ?? 0) !== 0;
}

function main(): void {
  const dbPath = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!dbPath || dbPath.startsWith('--')) {
    console.error('usage: tsx setup/migrate-v2/fix-creation-defects.ts <taskflow.db> [--apply]   (default: dry-run)');
    process.exit(2);
  }
  const db = new Database(dbPath, apply ? undefined : { readonly: true });
  db.pragma('busy_timeout = 5000');
  if (apply) {
    // The migrated taskflow.db is WAL-mode, so even a readonly dry-run on the same
    // file leaves a -wal/-shm sidecar — a stale sidecar is NOT proof the db is open
    // elsewhere (the documented flow is dry-run then --apply on the same file).
    // Distinguish stale from live by checkpointing: TRUNCATE clears a stale WAL and
    // reports busy=1 if a live writer holds the db (it does NOT throw — see
    // checkpointReportsBusyWriter). The merge itself is transactional, so this is a
    // fail-fast pre-flight, not the sole safeguard.
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }>;
    if (checkpointReportsBusyWriter(checkpoint)) {
      console.error(`refusing --apply: ${dbPath} is held by a live writer (checkpoint busy). Stop the service first.`);
      db.close();
      process.exit(2);
    }
  }
  try {
    console.log(`\n=== V1 creation-defect remediation (${apply ? 'APPLY' : 'DRY-RUN'}) on ${dbPath} ===`);
    if (apply) console.log(`(back up ${dbPath} first — this mutates in place)`);
    console.log('');

    // 1. Mariany (EX-015) — the one safe auto-fix.
    const stubs = detectStubDuplicateIdentities(db);
    console.log(`[1] dual-identity stubs detected: ${stubs.length}`);
    for (const s of stubs) console.log(`    - "${s.name}" on ${s.boardId}: ${s.stubId} -> ${s.keeperId}`);
    const isMarianyPair = (s: StubDuplicate) => s.stubId === 'mariany' && s.keeperId === 'mariany-borges';
    if (stubs.some(isMarianyPair)) {
      if (apply) {
        const sum = mergeDuplicatePerson(db, 'mariany', 'mariany-borges');
        console.log(`    APPLIED mariany->mariany-borges:`, JSON.stringify(sum));
      } else {
        console.log(`    WOULD merge mariany->mariany-borges (re-run with --apply)`);
      }
    }
    if (stubs.some((s) => !isMarianyPair(s))) {
      console.log(`    ⚠ OTHER stub-dup candidates found above — NOT auto-merged; confirm each by hand.`);
    }

    // 2. Sanunciel (EX-014) — cannot be SQL-fixed (board needs a real WhatsApp group).
    const orphan = checkOrphanPerson(db, 'sanunciel');
    console.log(`\n[2] Sanunciel orphan: present=${orphan.present} ownsBoard=${orphan.ownsBoard} tasks=${orphan.taskCount}`);
    if (orphan.present && !orphan.ownsBoard) {
      console.log(`    ⚠ MANUAL: re-provision Sanunciel's child board via the live agent post-cutover (SQL cannot create the WhatsApp group). His ${orphan.taskCount} task(s) stay on the parent until then.`);
    }

    // 3. Hudson duplicate-board cluster — real groups; operator decision.
    const dups = detectDuplicateBoards(db);
    console.log(`\n[3] duplicate-board clusters (same owner+parent): ${dups.length}`);
    for (const d of dups) console.log(`    ⚠ MANUAL: owner=${d.owner} parent=${d.parent} -> ${d.ids.join(', ')} (each is a real WhatsApp group; operator picks the canonical one + migrates content).`);

    console.log(`\n=== done (${apply ? 'changes committed' : 'no changes — dry-run'}) ===\n`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('fix-creation-defects.ts')) {
  main();
}
