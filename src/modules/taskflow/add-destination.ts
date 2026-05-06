import type Database from 'better-sqlite3';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import type { Session } from '../../types.js';
import { checkMainControlSession } from './permission.js';
import { nonEmptyString } from './util.js';

export async function handleAddDestination(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  if (!checkMainControlSession(session, 'add_destination')) return;

  const localNameRaw = nonEmptyString(content.local_name);
  if (!localNameRaw) {
    log.warn('add_destination: local_name missing or empty', { sessionId: session.id });
    return;
  }
  // normalizeName never returns empty — falls back to 'unnamed' on garbage input.
  const localName = normalizeName(localNameRaw);

  const targetMg = nonEmptyString(content.target_messaging_group_id);
  const targetAg = nonEmptyString(content.target_agent_group_id);
  if (!!targetMg === !!targetAg) {
    log.warn('add_destination: exactly one of target_messaging_group_id / target_agent_group_id required', {
      sessionId: session.id,
      hasMg: !!targetMg,
      hasAg: !!targetAg,
    });
    return;
  }

  const targetType: 'channel' | 'agent' = targetMg ? 'channel' : 'agent';
  const targetId = (targetMg ?? targetAg)!;

  // Verify target exists. Both lookups are point queries on the central DB.
  if (targetType === 'channel') {
    if (!getMessagingGroup(targetId)) {
      log.warn('add_destination: target messaging group not found', { sessionId: session.id, targetId });
      return;
    }
  } else if (!getAgentGroup(targetId)) {
    log.warn('add_destination: target agent group not found', { sessionId: session.id, targetId });
    return;
  }

  // Reject collision on this agent's local namespace OR on the (target_type,
  // target_id) pair. The latter prevents wiring the same target twice under
  // different names.
  if (getDestinationByName(session.agent_group_id, localName)) {
    log.warn('add_destination: local_name already in use', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      localName,
    });
    return;
  }
  if (getDestinationByTarget(session.agent_group_id, targetType, targetId)) {
    log.warn('add_destination: target already wired under another name', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      targetType,
      targetId,
    });
    return;
  }

  createDestination({
    agent_group_id: session.agent_group_id,
    local_name: localName,
    target_type: targetType,
    target_id: targetId,
    created_at: new Date().toISOString(),
  });

  // Refresh the running container's projection so the agent sees the new
  // destination on its very next send_message attempt. Failures here MUST
  // propagate — swallowing them would log "wired" while the container
  // keeps serving the stale projection (the exact stale-state hazard the
  // agent-destinations.ts top-of-file invariant calls out). The central
  // row is already written and is the source of truth; a thrown error
  // signals to delivery.ts that the action did not fully apply.
  writeDestinations(session.agent_group_id, session.id);

  log.info('add_destination: wired', {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    localName,
    targetType,
    targetId,
  });
}
