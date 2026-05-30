import Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { checkMainControlSession } from './permission.js';
import { TASKFLOW_DB_PATH } from './provision-shared.js';
import { nonEmptyString } from './util.js';

/**
 * Main-control-gated person rename (host side). The container `rename_board_person`
 * tool emits this as a `kind:'system'` action; only the operator-designated main
 * control chat is authorized (mirrors send_otp / provision_*). Fire-and-forget:
 * the v2 system-action path returns void, so a dropped call never surfaces an
 * error to the agent.
 *
 * Name is per-PERSON identity, so it rewrites `board_people.name` on EVERY board
 * the person belongs to (`WHERE person_id = ?`). This keeps all boards consistent
 * and leaves the init name-heal (which reconciles by person_id) a no-op instead
 * of reverting a single-board rename.
 */
export async function handleRenameBoardPerson(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  if (!checkMainControlSession(session, 'rename_board_person')) return;

  const boardId = nonEmptyString(content.board_id);
  const personId = nonEmptyString(content.person_id);
  const name = nonEmptyString(content.name);
  if (!boardId || !personId || !name) {
    log.warn('rename_board_person: invalid payload', {
      sessionId: session.id,
      hasBoard: !!boardId,
      hasPerson: !!personId,
      hasName: !!name,
    });
    return;
  }

  const db = new Database(TASKFLOW_DB_PATH);
  try {
    // Membership precondition: the person must be on the board the caller named
    // (catches a typo'd/mismatched id from renaming the wrong person). The rename
    // itself stays per-PERSON (WHERE person_id) so all the person's boards stay
    // consistent and the init name-heal (which reconciles by person_id) is a no-op.
    const onBoard = db
      .prepare('SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(boardId, personId);
    if (!onBoard) {
      log.warn('rename_board_person: person not on the named board', { sessionId: session.id, boardId, personId });
      return;
    }
    const res = db.prepare('UPDATE board_people SET name = ? WHERE person_id = ?').run(name.trim(), personId);
    log.info('rename_board_person applied', { sessionId: session.id, personId, boardsUpdated: res.changes });
  } finally {
    db.close();
  }
}
