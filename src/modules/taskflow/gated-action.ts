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

/** Collapse whitespace + truncate so a value can't blow up or line-break the approval card. */
function clip(value: unknown, max = 100): string | null {
  if (typeof value !== 'string') return null;
  const one = value.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Render a sanitized, concrete preview of the parked action's args so the human approver can make an
 * informed decision (NOT just "a mass_mutation"). Pulls the salient fields the gated tools carry —
 * destination, message/file, task ids, people, action — and truncates each. Defensive: ignores
 * unexpected shapes.
 */
function previewArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (label: string, raw: unknown) => {
    const v = clip(raw);
    if (v) parts.push(`${label}: ${v}`);
  };
  push('action', args.action);
  push('to', args.to);
  push('person', args.person_name);
  push('from', args.source_person);
  push('→', args.target_person);
  push('task', args.task_id);
  if (Array.isArray(args.task_ids) && args.task_ids.length) {
    parts.push(`tasks(${args.task_ids.length}): ${args.task_ids.slice(0, 10).map(String).join(', ')}`);
  }
  push('file', args.filename ?? args.path);
  push('text', args.text);
  return parts.join(' · ');
}

export async function handleTaskflowRequestApproval(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = typeof content.request_id === 'string' ? content.request_id : '';
  const tool = typeof content.tool === 'string' ? content.tool : '';
  if (!requestId || !tool) {
    log.warn('taskflow_request_approval missing request_id/tool — dropping', { sessionId: session.id });
    return;
  }
  // SEC#11: summary/category/reason originate in the container row and are partly agent-influenced —
  // an injected agent could craft a misleading headline to socially-engineer the approver. They render
  // verbatim into the approval card below, so sanitize them the same way previewArgs sanitizes its
  // fields: collapse whitespace + clip. (The concrete, trusted preview is appended separately.)
  const summary = clip(content.summary) ?? tool;
  const category = clip(content.category) ?? 'restricted';
  const reason = clip(content.reason) ?? '';
  const args = (content.args as Record<string, unknown>) ?? {};

  const agentGroup = getAgentGroup(session.agent_group_id);
  const agentName = agentGroup?.name ?? session.agent_group_id;

  const preview = previewArgs(args);
  await requestApproval({
    session,
    agentName,
    action: 'taskflow_gated_action',
    // Carried verbatim on the pending_approvals row; handed back to applyTaskflowGatedAction on approve.
    payload: { request_id: requestId, tool, args, summary, category },
    title: 'TaskFlow action needs approval',
    question:
      `Agent "${agentName}" wants to run a ${category} action: ${summary}` +
      `${preview ? `\n${preview}` : ''}${reason ? `\n(${reason})` : ''}`,
  });
}

export const applyTaskflowGatedAction: ApprovalHandler = async ({ session, payload, userId, channelType, notify }) => {
  // RE-AUTHORIZE the clicker. The shared approvals response-handler dispatches on any matching
  // response without checking the responder is an eligible approver (it relies on the card being
  // DM'd to one). For a destructive/structure action that is not enough — require the clicker to be
  // an actual approver (scoped admin → global admin → owner) for THIS agent group.
  //
  // The response carries the RAW platform user id (e.g. "6037840640"); user_roles / pickApprover
  // store namespaced ids ("<channel>:<handle>"). Namespace before comparing (mirrors the permissions
  // module) — without this the check would refuse EVERY approval. pickApprover returns exactly the
  // eligible set; a click from anyone else is refused and runs nothing.
  const clickerId = userId ? (userId.includes(':') ? userId : `${channelType}:${userId}`) : null;
  if (!clickerId || !pickApprover(session.agent_group_id).includes(clickerId)) {
    log.warn('TaskFlow gated action: approve click from a non-approver — refusing', {
      agentGroupId: session.agent_group_id,
      clickerId,
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
  // sweep wakes a cold container; on_wake=0 so a warm one picks it up on its next poll. The execute
  // row id is DETERMINISTIC on request_id: if the host crashed between this write and deleting the
  // pending_approvals row, a re-click writes the SAME id, which the messages_in PK rejects (caught
  // below) — so an approval executes AT MOST ONCE even across a host crash + re-click.
  const execId = requestId ? `tf-appr-${requestId}` : `tf-appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: execId,
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
  } catch (e) {
    // Duplicate execId (PK violation) → this approval was already queued; do not re-queue or re-wake.
    log.info('TaskFlow gated action already queued (duplicate approval) — ignoring', {
      agentGroupId: session.agent_group_id,
      execId,
      err: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  log.info('TaskFlow gated action approved — queued for deterministic replay', {
    agentGroupId: session.agent_group_id,
    tool,
    clickerId,
  });

  // Nudge the container so the approved action runs promptly (idempotent if already running).
  const live = getSession(session.id);
  if (live) void wakeContainer(live);
};
