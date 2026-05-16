/**
 * 0h-v2 Option A — Unit 2: the TaskFlow "service session".
 *
 * One well-known synthetic agent_group + always-`active` session whose
 * `outbound.db` is the landing surface for FastAPI-originated
 * `taskflow_notify` rows. The FastAPI MCP subprocess has no agent and
 * no session of its own; `src/delivery.ts` only drains `messages_out`
 * from a *registered, `status='active'`* session
 * (`getActiveSessions()`, db/sessions.ts:66). This session is that
 * surface — never messaged, never spawned (container_status stays
 * 'stopped'), only drained by the 60s `pollSweep`.
 *
 * `ensureTaskflowServiceSession()` is idempotent and self-healing: it
 * runs on host startup and re-activates the session if anything ever
 * closed it (a closed session is silently skipped by pollSweep, which
 * would make every FastAPI notification vanish with no error).
 */
import { createAgentGroup, createSession, getAgentGroup, getSession, updateSession } from '../../db/index.js';
import { initSessionFolder, outboundDbPath } from '../../session-manager.js';

/** Stable id used for BOTH the synthetic agent_group and the session. */
export const TASKFLOW_SERVICE_ID = 'taskflow-service';

/**
 * Absolute path the FastAPI MCP subprocess must be handed (Unit 4) so
 * its `enqueueOutboundMessage` writes exactly where `delivery.ts`
 * drains. Deterministic — derived from the same `outboundDbPath` the
 * drain loop uses, so the two can never silently diverge.
 */
export function taskflowServiceOutboundDbPath(): string {
  return outboundDbPath(TASKFLOW_SERVICE_ID, TASKFLOW_SERVICE_ID);
}

/**
 * Ensure the agent_group + an `active` session row exist (no FS). Split
 * out so it is unit-testable against an in-memory DB — the full
 * `ensureTaskflowServiceSession` also touches the real, non-overridable
 * `DATA_DIR`, which a unit test must not create/delete (it could clobber
 * a live service session on a running host).
 */
export function ensureTaskflowServiceSessionRecord(): void {
  if (!getAgentGroup(TASKFLOW_SERVICE_ID)) {
    createAgentGroup({
      id: TASKFLOW_SERVICE_ID,
      name: 'TaskFlow Service',
      folder: TASKFLOW_SERVICE_ID,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  }

  const existing = getSession(TASKFLOW_SERVICE_ID);
  if (!existing) {
    createSession({
      id: TASKFLOW_SERVICE_ID,
      agent_group_id: TASKFLOW_SERVICE_ID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
  } else if (existing.status !== 'active') {
    updateSession(TASKFLOW_SERVICE_ID, { status: 'active' });
  }
}

/**
 * Full bootstrap: ensure the DB rows AND the on-disk session folder +
 * inbound/outbound DB pair. Call once on host startup. The folder step
 * targets the real `DATA_DIR` (non-overridable const) and is itself
 * idempotent (`initSessionFolder` = recursive mkdir + `ensureSchema`),
 * so it is NOT unit-tested in isolation — exercising it would create or
 * delete real project paths. See `ensureTaskflowServiceSessionRecord`.
 */
export function ensureTaskflowServiceSession(): void {
  ensureTaskflowServiceSessionRecord();
  initSessionFolder(TASKFLOW_SERVICE_ID, TASKFLOW_SERVICE_ID);
}
