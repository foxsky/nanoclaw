/**
 * SEC#1 unit 3 (#407) — host side of the TaskFlow gated-action approval round-trip.
 *
 * The container's destructive/broadcast gate (container/agent-runner/src/mcp-tools/destructive-gate.ts
 * + taskflow-approval.ts) PARKS a high-impact action instead of running it, writing a
 * `taskflow_request_approval` system row. This module:
 *
 *   1. handleTaskflowRequestApproval — delivery action for that row. Routes it to a human approver
 *      via the standard approvals primitive (pickApprover → DM card), keyed `taskflow_gated_action`.
 *   2. applyTaskflowGatedAction — the approval handler. On APPROVE it hands the action back to the
 *      container as a `taskflow_execute_approved` system row, which the container's poll-loop runs
 *      DETERMINISTICALLY (no LLM) with the gate bypassed. The mutation MUST run in the container —
 *      taskflow.db is container-only; the host can only decide, never execute.
 *
 * Cross-process string contract with taskflow-approval.ts (the two trees share no modules): the
 * container writes REQUEST_APPROVAL_ACTION and consumes EXECUTE_APPROVED_ACTION. Keep these in sync.
 */
import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
// Import the pure registry from primitive.js, NOT the approvals barrel: the barrel (index.js) has an
// import-time onDeliveryAdapterReady side effect, and pulling it into taskflow/index.ts's graph breaks
// test isolation for everything that transitively imports this module. Production still loads the
// barrel first via src/modules/index.ts, so the delivery-adapter wiring is unaffected at runtime.
import { pickApprover, requestApproval, type ApprovalHandler } from '../approvals/primitive.js';

/** Container → host: "an admin must approve this gated action" (taskflow-approval.ts REQUEST_APPROVAL_ACTION). */
export const TASKFLOW_REQUEST_APPROVAL = 'taskflow_request_approval';
/** Host → container: "the admin approved; run it now" (taskflow-approval.ts EXECUTE_APPROVED_ACTION). */
export const TASKFLOW_EXECUTE_APPROVED = 'taskflow_execute_approved';

export async function handleTaskflowRequestApproval(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = typeof content.request_id === 'string' ? content.request_id : '';
  const tool = typeof content.tool === 'string' ? content.tool : '';
  if (!requestId || !tool) {
    log.warn('taskflow_request_approval missing request_id/tool — dropping', { sessionId: session.id });
    return;
  }
  const summary = typeof content.summary === 'string' ? content.summary : tool;
  const category = typeof content.category === 'string' ? content.category : 'restricted';
  const reason = typeof content.reason === 'string' ? content.reason : '';
  const args = (content.args as Record<string, unknown>) ?? {};

  const agentGroup = getAgentGroup(session.agent_group_id);
  const agentName = agentGroup?.name ?? session.agent_group_id;

  await requestApproval({
    session,
    agentName,
    action: 'taskflow_gated_action',
    // Carried verbatim on the pending_approvals row; handed back to applyTaskflowGatedAction on approve.
    payload: { request_id: requestId, tool, args, summary, category },
    title: 'TaskFlow action needs approval',
    question: `Agent "${agentName}" wants to run a ${category} action: ${summary}${reason ? `\n(${reason})` : ''}`,
  });
}

export const applyTaskflowGatedAction: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  // RE-AUTHORIZE the clicker. The shared approvals response-handler dispatches on any matching
  // response without checking the responder is an eligible approver (it relies on the card being
  // DM'd to one). For a destructive/structure action that is not enough — require the clicker to be
  // an actual approver (scoped admin → global admin → owner) for THIS agent group. pickApprover
  // returns exactly that eligible set; a click from anyone else is refused and runs nothing.
  if (!pickApprover(session.agent_group_id).includes(userId)) {
    log.warn('TaskFlow gated action: approve click from a non-approver — refusing', {
      agentGroupId: session.agent_group_id,
      userId,
    });
    notify(
      'A gated TaskFlow action could not be approved: the responder is not an authorized approver. Nothing was changed.',
    );
    return;
  }

  const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
  const tool = typeof payload.tool === 'string' ? payload.tool : '';
  const summary = typeof payload.summary === 'string' ? payload.summary : tool;
  const args = (payload.args as Record<string, unknown>) ?? {};

  // Queue the approved action for the container to execute deterministically. trigger=1 so the host
  // sweep wakes a cold container; on_wake=0 so a warm one picks it up on its next poll.
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `tf-appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      action: TASKFLOW_EXECUTE_APPROVED,
      request_id: requestId,
      tool,
      args,
      summary,
      approved: true,
    }),
    trigger: 1,
    onWake: 0,
  });
  log.info('TaskFlow gated action approved — queued for deterministic replay', {
    agentGroupId: session.agent_group_id,
    tool,
    userId,
  });

  // Nudge the container so the approved action runs promptly (idempotent if already running).
  const live = getSession(session.id);
  if (live) void wakeContainer(live);
};
