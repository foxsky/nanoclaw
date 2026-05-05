import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

interface GateRow {
  session_mode: 'shared' | 'per-thread' | 'agent-shared';
  is_main_control: number | null;
}

/**
 * Single JOIN replaces what would otherwise be two prepared lookups
 * (messaging_group_agents + messaging_groups) on a hot path — every
 * privileged TaskFlow action delivery hits this gate.
 */
function lookupGateRow(messagingGroupId: string, agentGroupId: string): GateRow | undefined {
  return getDb()
    .prepare(
      `SELECT mga.session_mode AS session_mode, mg.is_main_control AS is_main_control
         FROM messaging_group_agents mga
         LEFT JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.messaging_group_id = ? AND mga.agent_group_id = ?
        LIMIT 1`,
    )
    .get(messagingGroupId, agentGroupId) as GateRow | undefined;
}

/**
 * Returns true iff the session may invoke a TaskFlow main-control privileged
 * action (send_otp, provision_*, create_group_in_board). Five fail-closed
 * checks — DM-only / stale wiring / agent-shared (can't identify trigger
 * chat) / stale messaging_group fk / not the operator-designated main.
 *
 * `action` is prepended to failure log messages so per-handler log output
 * stays v1-compatible.
 */
export function checkMainControlSession(session: Session, action: string): boolean {
  if (!session.messaging_group_id) {
    log.warn(`${action}: session has no messaging_group_id, dropping`, { sessionId: session.id });
    return false;
  }
  const row = lookupGateRow(session.messaging_group_id, session.agent_group_id);
  if (!row) {
    log.warn(`${action}: no wiring row for session, dropping (fail-closed)`, {
      sessionId: session.id,
      messagingGroupId: session.messaging_group_id,
      agentGroupId: session.agent_group_id,
    });
    return false;
  }
  if (row.session_mode === 'agent-shared') {
    log.warn(`${action}: agent-shared sessions cannot reliably identify trigger chat, dropping`, {
      sessionId: session.id,
      messagingGroupId: session.messaging_group_id,
    });
    return false;
  }
  if (row.is_main_control !== 1) {
    log.warn(`${action}: messaging group not authorized (is_main_control != 1)`, {
      sessionId: session.id,
      messagingGroupId: session.messaging_group_id,
      hasGroup: row.is_main_control !== null,
    });
    return false;
  }
  return true;
}
