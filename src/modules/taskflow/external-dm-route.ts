/**
 * RC5-ext inbound — the unrouted-DM resolver (host side).
 *
 * Registered into the router's `setUnroutedDmResolver` hook (see
 * `modules/taskflow/index.ts`). When a DM lands on a wiring-less cold-DM
 * messaging_group, this authenticates the sender JID against the external's
 * meeting grants and, if the grants are all on ONE board, routes the reply
 * into that board's agent session with a narrowly-scoped external-actor
 * identity. Returning true consumes the message; false falls through to the
 * router's existing drop.
 *
 * ⚠️ NOT YET REGISTERED — DARK UNTIL P3. The host can authenticate + route an
 * external's content into a board session, but the CONTAINER guards that make
 * that safe (poison `turn_actor` so an external is never bound as a board
 * person; deny deterministic mutation fast-paths for external turns; the
 * external-safe capability mode that default-denies reads/tools; the engine's
 * per-meeting DB grant re-check) are P3 work and do not exist yet. Registering
 * this resolver before P3 would route external content into a board agent's
 * context with only the SEC#13 mutation guard protecting it — leaving the B6
 * content-exfiltration hole open. So this is built + unit-tested here, and
 * `index.ts` deliberately does NOT wire it until P3 lands. See
 * `2026-06-13-rc5ext-inbound-design.md` §C7/§Phasing.
 *
 * Security invariants enforced here (host half):
 *   - AUTH = `externalId` only. The row carries `content.externalActor`
 *     ({externalId, displayName, sourceDmMgId}) and `actorKind:'external'`,
 *     and NO `content.sender` — so the container can never bind it as a board
 *     person via `turn_actor`. Grants are NOT carried as auth (the engine
 *     re-checks per-meeting at mutation time, P3/C4).
 *   - Cross-board grants are NEVER routed into a guessed board (would leak one
 *     board's inbound to another's agent). Same-board only here; cross-board
 *     is host-parked in P2.5.
 *   - The routed row's delivery address is the EXTERNAL's cold-DM mg, so a
 *     default reply goes back to the external, never leaked to the board group.
 *   - The reply destination (`external-<id>` → the cold-DM mg) is created
 *     collision-safe: if the name already points at a DIFFERENT mg, fail closed.
 */
import type Database from 'better-sqlite3';

import type { InboundEvent } from '../../channels/adapter.js';
import { DATA_DIR } from '../../config.js';
import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { getTaskflowDb, resolveExternalDm } from '../../dm-routing.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from '../agent-to-agent/db/agent-destinations.js';

/**
 * Ensure the board agent can reply to this external by the stable local name
 * `external-<externalId>`, resolving to the external's cold-DM messaging_group
 * (`target_type:'channel'`). Collision-safe: if the name is already taken by a
 * DIFFERENT target, return false (caller fails closed — never repoint an
 * existing destination, which could redirect a reply to the wrong recipient).
 */
function ensureExternalReplyDestination(agentGroupId: string, externalId: string, coldDmMgId: string): boolean {
  const localName = normalizeName(`external-${externalId}`);
  const existing = getDestinationByName(agentGroupId, localName);
  if (existing) {
    return existing.target_type === 'channel' && existing.target_id === coldDmMgId;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: localName,
    target_type: 'channel',
    target_id: coldDmMgId,
    created_at: new Date().toISOString(),
  });
  return true;
}

function safeText(event: InboundEvent): string {
  try {
    const parsed = JSON.parse(event.message.content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return event.message.content ?? '';
  }
}

export interface ExternalDmRouteDeps {
  /** Injected taskflow.db handle for tests; production uses getTaskflowDb(DATA_DIR). */
  taskflowDb?: Database.Database;
}

export async function resolveUnroutedExternalDm(
  mg: MessagingGroup,
  event: InboundEvent,
  deps: ExternalDmRouteDeps = {},
): Promise<boolean> {
  const db = deps.taskflowDb ?? getTaskflowDb(DATA_DIR);
  if (!db) return false; // no taskflow.db → not a taskflow install / unreadable → fall through

  const jid = mg.platform_id;
  const route = resolveExternalDm(db, jid);
  if (!route) return false; // no active grant / not an external → fall through to the router's drop

  const ctx = { externalId: route.externalId, dmMgId: mg.id, jid };

  // Cross-board grants must NOT be routed into a guessed board (would leak one
  // board's inbound to another's agent). Host-parked disambiguation is P2.5;
  // until then this is fail-closed — log + decline (the router drops it, which
  // is itself the safe outcome: the external is not routed in).
  if (route.needsDisambiguation) {
    log.info('rc5-ext inbound: cross-board external DM — parked disambiguation not yet wired, not routing', ctx);
    return false;
  }

  const text = safeText(event);
  if (!text.trim()) {
    log.info('rc5-ext inbound: empty external DM text — not routing', ctx);
    return false;
  }

  const boardMg = getMessagingGroupByPlatform('whatsapp', route.groupJid);
  if (!boardMg) {
    log.error('rc5-ext inbound: no messaging_group for grant group_jid — not routing', {
      ...ctx,
      groupJid: route.groupJid,
    });
    return false;
  }
  const agents = getMessagingGroupAgents(boardMg.id);
  if (agents.length === 0) {
    log.error('rc5-ext inbound: board messaging_group has no wired agents — not routing', {
      ...ctx,
      boardMgId: boardMg.id,
    });
    return false;
  }

  let routed = false;
  for (const agent of agents) {
    const ag = getAgentGroup(agent.agent_group_id);
    if (!ag) continue;

    if (!ensureExternalReplyDestination(agent.agent_group_id, route.externalId, mg.id)) {
      log.error('rc5-ext inbound: reply-destination name collision on a different target — not routing', {
        ...ctx,
        agentGroupId: agent.agent_group_id,
      });
      continue; // fail closed for this agent; never repoint an existing destination
    }

    const { session } = resolveSession(agent.agent_group_id, boardMg.id, null, agent.session_mode);

    writeSessionMessage(session.agent_group_id, session.id, {
      id: `rc5ext:${event.message.id}:${agent.agent_group_id}`,
      kind: 'chat',
      timestamp: event.message.timestamp,
      // Delivery address = the EXTERNAL's cold-DM mg: a default reply goes back
      // to the external, never leaked to the board group.
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: null,
      content: JSON.stringify({
        text,
        // AUTH carries ONLY externalId; displayName/sourceDmMgId are context.
        // NO `sender` — the container must not bind this as a board person.
        externalActor: {
          externalId: route.externalId,
          displayName: route.displayName,
          sourceDmMgId: mg.id,
        },
        actorKind: 'external',
        from: `external-${route.externalId}`,
      }),
      trigger: 1,
    });

    const fresh = getSession(session.id);
    if (fresh) await wakeContainer(fresh);
    routed = true;

    log.info('rc5-ext inbound: routed external DM into board session', {
      ...ctx,
      agentGroupId: agent.agent_group_id,
      sessionId: session.id,
      boardMgId: boardMg.id,
    });
  }

  return routed;
}
