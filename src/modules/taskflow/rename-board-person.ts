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

  const personId = nonEmptyString(content.person_id);
  const name = nonEmptyString(content.name);
  if (!personId || !name) {
    log.warn('rename_board_person: invalid payload', {
      sessionId: session.id,
      hasPerson: !!personId,
      hasName: !!name,
    });
    return;
  }

  const db = new Database(TASKFLOW_DB_PATH);
  try {
    const exists = db.prepare('SELECT 1 FROM board_people WHERE person_id = ? LIMIT 1').get(personId);
    if (!exists) {
      log.warn('rename_board_person: person not found', { sessionId: session.id, personId });
      return;
    }
    const res = db.prepare('UPDATE board_people SET name = ? WHERE person_id = ?').run(name.trim(), personId);
    log.info('rename_board_person applied', { sessionId: session.id, personId, boardsUpdated: res.changes });
  } finally {
    db.close();
  }
}
