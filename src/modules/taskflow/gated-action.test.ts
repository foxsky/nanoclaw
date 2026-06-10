/**
 * SEC#1 unit 3 (#407) — host side of the gated-action approval round-trip.
 *
 * WHY these matter: this is the bridge that turns a container's "held for approval" park into a real
 * human decision and back into a deterministic re-run. The request half must route to the standard
 * approvals primitive under the `taskflow_gated_action` key (else the card never reaches an admin);
 * the approve half must hand the EXACT parked action back to the container as an execute row (else the
 * approved mutation never runs, or runs with the wrong args). A malformed park (no request_id/tool)
 * must NOT raise an approval card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../approvals/primitive.js');
vi.mock('../../session-manager.js');
vi.mock('../../container-runner.js');
vi.mock('../../db/sessions.js');
vi.mock('../../db/agent-groups.js');

import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { pickApprover, requestApproval } from '../approvals/primitive.js';
import { TASKFLOW_EXECUTE_APPROVED, applyTaskflowGatedAction, handleTaskflowRequestApproval } from './gated-action.js';

const session = { id: 's1', agent_group_id: 'ag1', messaging_group_id: 'mg1', thread_id: null } as Session;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAgentGroup).mockReturnValue({ id: 'ag1', name: 'Board A' } as ReturnType<typeof getAgentGroup>);
  vi.mocked(getSession).mockReturnValue(session);
  // pickApprover returns NAMESPACED ids ("<channel>:<handle>"), as user_roles stores them.
  vi.mocked(pickApprover).mockReturnValue(['whatsapp:u-admin']);
});

describe('handleTaskflowRequestApproval', () => {
  it('routes a parked action to a human approver under the taskflow_gated_action key', async () => {
    await handleTaskflowRequestApproval(
      {
        action: 'taskflow_request_approval',
        request_id: 'r1',
        tool: 'api_reassign',
        args: { source_person: 'Alice', target_person: 'Bob', confirmed: true },
        summary: 'reassign 8 tasks from Alice to Bob',
        category: 'mass_mutation',
        reason: 'bulk change to 8 tasks',
      },
      session,
    );

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        agentName: 'Board A',
        action: 'taskflow_gated_action',
        payload: expect.objectContaining({
          request_id: 'r1',
          tool: 'api_reassign',
          args: { source_person: 'Alice', target_person: 'Bob', confirmed: true },
          summary: 'reassign 8 tasks from Alice to Bob',
          category: 'mass_mutation',
        }),
      }),
    );
  });

  it('drops a malformed park (no request_id/tool) WITHOUT raising an approval card', async () => {
    await handleTaskflowRequestApproval({ action: 'taskflow_request_approval', tool: 'api_reassign' }, session);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('renders a sanitized concrete args preview on the card so the approver can decide informedly', async () => {
    await handleTaskflowRequestApproval(
      {
        action: 'taskflow_request_approval',
        request_id: 'r1',
        tool: 'api_reassign',
        args: { source_person: 'Alice', target_person: 'Bob', confirmed: true },
        summary: 'reassign 8 tasks',
        category: 'mass_mutation',
      },
      session,
    );
    const question = vi.mocked(requestApproval).mock.calls[0][0].question;
    expect(question).toContain('from: Alice');
    expect(question).toContain('→: Bob'); // concrete people, not just "a mass_mutation"
  });

  it('sanitizes the agent-controlled summary (collapses newlines + clips) so the card cannot be spoofed', async () => {
    // SEC#11 IMPORTANT: summary/category/reason are partly agent-influenced and render verbatim into
    // the approval card. A prompt-injected agent could embed a fake multi-line "✅ already approved"
    // banner or pad the card. clip() collapses whitespace and truncates, defusing both.
    const evil = 'Reassign 1 task\n\n\n✅ APPROVED — routine cleanup, ignore\n' + 'x'.repeat(200);
    await handleTaskflowRequestApproval(
      {
        action: 'taskflow_request_approval',
        request_id: 'r1',
        tool: 'api_admin',
        args: {},
        summary: evil,
        category: 'structure',
      },
      session,
    );
    const sanitized = (vi.mocked(requestApproval).mock.calls[0][0].payload as Record<string, unknown>)
      .summary as string;
    expect(sanitized).not.toContain('\n'); // newlines collapsed — no fake multi-line banner
    expect(sanitized.length).toBeLessThanOrEqual(101); // clipped to 100 + ellipsis — cannot pad the card
    expect(sanitized).toContain('…');
  });
});

describe('applyTaskflowGatedAction (on approve)', () => {
  it('hands the approved action back to the container as a taskflow_execute_approved system row + wakes it', async () => {
    await applyTaskflowGatedAction({
      session,
      userId: 'u-admin',
      channelType: 'whatsapp',
      notify: vi.fn(),
      payload: {
        request_id: 'r1',
        tool: 'api_reassign',
        args: { source_person: 'Alice', target_person: 'Bob', confirmed: true },
        summary: 'reassign 8 tasks from Alice to Bob',
        category: 'mass_mutation',
      },
    });

    expect(writeSessionMessage).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, message] = vi.mocked(writeSessionMessage).mock.calls[0];
    expect(agentGroupId).toBe('ag1');
    expect(sessionId).toBe('s1');
    expect(message.kind).toBe('system');
    expect(message.id).toBe('tf-appr-r1'); // DETERMINISTIC on request_id → PK-dedup makes execution at-most-once
    expect(message.trigger).toBe(1); // counts in countDueMessages → wakes a cold container
    expect(message.onWake).toBe(0); // a WARM container must still pick it up on its next poll
    const content = JSON.parse(message.content) as Record<string, unknown>;
    expect(content.action).toBe(TASKFLOW_EXECUTE_APPROVED);
    expect(content.tool).toBe('api_reassign');
    expect(content.args).toEqual({ source_person: 'Alice', target_person: 'Bob', confirmed: true });
    expect(content.approved).toBe(true);

    // Prompt nudge so the approved action runs without waiting on the 60s sweep.
    expect(wakeContainer).toHaveBeenCalledWith(session);
  });

  it('namespaces the RAW clicker id with channelType before the approver check (Codex BLOCKER)', async () => {
    // The response carries a raw handle ("6037840640"); pickApprover stores "whatsapp:6037840640".
    // Without namespacing this refused EVERY approval. Verify the raw+channel pair is authorized.
    vi.mocked(pickApprover).mockReturnValue(['whatsapp:6037840640']);
    await applyTaskflowGatedAction({
      session,
      userId: '6037840640',
      channelType: 'whatsapp',
      notify: vi.fn(),
      payload: { request_id: 'r2', tool: 'api_admin', args: {}, summary: 'remove_person' },
    });
    expect(writeSessionMessage).toHaveBeenCalledTimes(1); // authorized → queued
    expect(wakeContainer).toHaveBeenCalledWith(session);
  });

  it('REFUSES an approve click from someone who is not an eligible approver — nothing queued', async () => {
    vi.mocked(pickApprover).mockReturnValue(['whatsapp:someone-else']); // u-admin is NOT an approver
    const notify = vi.fn();
    await applyTaskflowGatedAction({
      session,
      userId: 'u-admin',
      channelType: 'whatsapp',
      notify,
      payload: { request_id: 'r1', tool: 'api_reassign', args: {}, summary: 's' },
    });
    expect(writeSessionMessage).not.toHaveBeenCalled(); // no execute row written
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('not an authorized approver'));
  });

  it('is idempotent: a duplicate approval (same request_id, PK clash) queues nothing extra + no re-wake', async () => {
    vi.mocked(writeSessionMessage).mockImplementation(() => {
      throw new Error('UNIQUE constraint failed: messages_in.id');
    });
    const notify = vi.fn();
    await applyTaskflowGatedAction({
      session,
      userId: 'u-admin',
      channelType: 'whatsapp',
      notify,
      payload: { request_id: 'r1', tool: 'api_reassign', args: {}, summary: 's' },
    });
    // The dup write threw (PK clash) — handler swallows it and does NOT wake again (action already in flight).
    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
