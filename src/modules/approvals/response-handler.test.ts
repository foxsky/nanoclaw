/**
 * M5/L3 — the CENTRAL responder re-auth gate in handleRegisteredApproval. The three handlers that
 * had no inner check before (install_packages, add_mcp_server, cli_command) are now protected here:
 * a response from a non-approver must NOT execute the handler and must NOT consume the pending row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/sessions.js');
vi.mock('../../session-manager.js');
vi.mock('../../container-runner.js');
vi.mock('./primitive.js');

import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { PendingApproval, Session } from '../../types.js';
import { getApprovalHandler, pickApprover } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';

const session = { id: 's1', agent_group_id: 'ag1', messaging_group_id: 'mg1', thread_id: null } as Session;
const handler = vi.fn();

function approvalRow(): PendingApproval {
  return { approval_id: 'appr-1', session_id: 's1', action: 'install_packages', payload: '{}' } as PendingApproval;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPendingApproval).mockReturnValue(approvalRow());
  vi.mocked(getSession).mockReturnValue(session);
  vi.mocked(getApprovalHandler).mockReturnValue(handler);
  // pickApprover returns NAMESPACED ids — the only eligible approver here is whatsapp:admin.
  vi.mocked(pickApprover).mockReturnValue(['whatsapp:admin']);
});

describe('handleRegisteredApproval responder re-auth (M5/L3)', () => {
  it('does NOT execute the handler or delete the row when the responder is not an approver', async () => {
    const claimed = await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: 'attacker', // → whatsapp:attacker, not in the approver set
      channelType: 'whatsapp',
      platformId: '',
      threadId: null,
    });
    expect(claimed).toBe(true); // claimed (so it doesn't fall through to other handlers)
    expect(handler).not.toHaveBeenCalled(); // the privileged action did NOT run
    expect(deletePendingApproval).not.toHaveBeenCalled(); // row left pending for a real approver
  });

  it('fails CLOSED when the clicker id is missing (cannot prove authorization)', async () => {
    const claimed = await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: null,
      channelType: 'whatsapp',
      platformId: '',
      threadId: null,
    });
    expect(claimed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(deletePendingApproval).not.toHaveBeenCalled();
  });

  it('executes the handler for a genuine approver', async () => {
    await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: 'admin', // → whatsapp:admin, in the approver set
      channelType: 'whatsapp',
      platformId: '',
      threadId: null,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(deletePendingApproval).toHaveBeenCalledWith('appr-1');
  });
});
