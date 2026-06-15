/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on reject, we notify the agent and move on.
 *   2. OneCLI credential approvals (`action = 'onecli_credential'`). Resolved
 *      via an in-memory Promise — see onecli-approvals.ts.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { wakeContainer } from '../../container-runner.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { ONECLI_ACTION, resolveOneCLIApproval, responderIdFromPayload } from './onecli-approvals.js';
import { getApprovalHandler, pickApprover } from './primitive.js';

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  // OneCLI credential approvals — resolved via in-memory Promise first. Pass the namespaced
  // responder id so resolveOneCLIApproval can re-authorize who actually responded.
  if (resolveOneCLIApproval(payload.questionId, payload.value, responderIdFromPayload(payload))) {
    return true;
  }

  // DB-backed pending_approvals.
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (approval.action === ONECLI_ACTION) {
    // Row exists but the in-memory resolver is gone (timer fired or the process
    // was in a weird state). Nothing to do — just drop the row.
    deletePendingApproval(payload.questionId);
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, payload.userId ?? '', payload.channelType ?? '');
  return true;
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
  channelType: string,
): Promise<void> {
  if (!approval.session_id) {
    deletePendingApproval(approval.approval_id);
    return;
  }
  const session = getSession(approval.session_id);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  const notify = (text: string): void => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  // Re-authorize the RESPONDER before acting on ANY registered approval (install_packages,
  // add_mcp_server, cli_command, taskflow_gated_action). The card is DM'd to one approver, but the
  // response path keys only on the questionId — a forged/cross-channel response could otherwise
  // drive a privileged handler. Namespace the raw clicker id to the user_roles form (mirrors
  // gated-action.ts / onecli-approvals.ts) and require membership in the eligible approver set.
  // Unauthorized → leave the row pending for a genuine approver (do not delete or execute), and
  // tell the agent so it isn't left waiting silently (matches the prior gated-action.ts behavior).
  const responderId = userId ? (userId.includes(':') ? userId : `${channelType}:${userId}`) : null;
  if (!responderId || !pickApprover(session.agent_group_id).includes(responderId)) {
    log.warn('Approval response ignored: responder is not an eligible approver', {
      approvalId: approval.approval_id,
      action: approval.action,
      responderId,
    });
    notify(`Your ${approval.action} response was ignored: the responder is not an authorized approver.`);
    return;
  }

  if (selectedOption !== 'approve') {
    notify(`Your ${approval.action} request was rejected by admin.`);
    log.info('Approval rejected', { approvalId: approval.approval_id, action: approval.action, userId });
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, userId, channelType, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  deletePendingApproval(approval.approval_id);
  await wakeContainer(session);
}
