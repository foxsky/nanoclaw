import { afterEach, describe, expect, it } from 'bun:test';

import {
  EXECUTE_APPROVED_ACTION,
  REQUEST_APPROVAL_ACTION,
  executeApprovedAction,
  isApprovedReplay,
  parkForApproval,
  registerApprovedExecutor,
  runAsApprovedReplay,
} from './taskflow-approval.js';
import type { WriteMessageOut } from '../db/messages-out.js';

// SEC#1 unit 3 (#407): a destructive/mass action the gate refuses is no longer a dead end — it is
// PARKED for admin approval. parkForApproval writes a host-visible `taskflow_request_approval`
// system row and returns a non-retry `pending_approval` to the agent. On approve the host writes a
// `taskflow_execute_approved` row, and executeApprovedAction re-runs the ORIGINAL tool handler
// deterministically (no LLM) under a gate-bypass flag — so the boundary stays deterministic code.

function captureEmit() {
  const rows: WriteMessageOut[] = [];
  const emit = (msg: WriteMessageOut): number => {
    rows.push(msg);
    return 1;
  };
  return { rows, emit };
}

function parseContent(row: WriteMessageOut) {
  return JSON.parse(row.content) as Record<string, unknown>;
}

describe('parkForApproval', () => {
  it('writes a taskflow_request_approval system row carrying tool/args/category/summary', () => {
    const { rows, emit } = captureEmit();
    const res = parkForApproval(
      {
        tool: 'api_reassign',
        args: { target_person: 'Bob', source_person: 'Alice', confirmed: true },
        decision: { gated: true, category: 'mass_mutation', reason: 'bulk change to 8 tasks (>= 5) requires admin approval' },
        summary: 'reassign 8 tasks from Alice to Bob',
      },
      { emit, newId: () => 'req-fixed-1' },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    expect(rows[0].id).toBe('req-fixed-1');
    const c = parseContent(rows[0]);
    expect(c.action).toBe(REQUEST_APPROVAL_ACTION);
    expect(c.request_id).toBe('req-fixed-1'); // request_id MUST equal the row id (host correlates on it)
    expect(c.tool).toBe('api_reassign');
    expect(c.args).toEqual({ target_person: 'Bob', source_person: 'Alice', confirmed: true });
    expect(c.category).toBe('mass_mutation');
    expect(c.summary).toBe('reassign 8 tasks from Alice to Bob');

    // The agent-facing result is a NON-retry pending signal, not a hard error the model will paper over.
    const payload = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.error_code).toBe('pending_approval');
    expect(payload.request_id).toBe('req-fixed-1');
    expect(String(payload.message)).toMatch(/do not retry/i);
  });
});

describe('runAsApprovedReplay / isApprovedReplay', () => {
  it('is false by default, true only inside the runner, and restores even on throw', async () => {
    expect(isApprovedReplay()).toBe(false);
    let seenInside = false;
    await runAsApprovedReplay(() => {
      seenInside = isApprovedReplay();
    });
    expect(seenInside).toBe(true);
    expect(isApprovedReplay()).toBe(false);

    await expect(
      runAsApprovedReplay(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(isApprovedReplay()).toBe(false); // flag cleared despite the throw — a failed replay can't leave the gate open
  });
});

describe('executeApprovedAction', () => {
  afterEach(() => {
    // executors map is module-global; clear our test tool between cases
    registerApprovedExecutor('test_tool', () => ({ content: [{ text: '{}' }] }));
  });

  it('re-invokes the registered executor with the parked args, under the replay flag', async () => {
    let receivedArgs: Record<string, unknown> | null = null;
    let replayActiveDuringCall = false;
    registerApprovedExecutor('test_tool', (args) => {
      receivedArgs = args;
      replayActiveDuringCall = isApprovedReplay();
      return { content: [{ text: JSON.stringify({ success: true }) }] };
    });

    const notes: string[] = [];
    await executeApprovedAction(
      { action: EXECUTE_APPROVED_ACTION, tool: 'test_tool', args: { x: 1 }, approved: true, summary: 's' },
      { notify: (t) => notes.push(t) },
    );

    expect(receivedArgs).toEqual({ x: 1 });
    expect(replayActiveDuringCall).toBe(true); // the gate must be bypassed for the approved re-run
    expect(notes).toHaveLength(0); // a successful re-run emits its own native confirmation; no extra notice
  });

  it('on a declined action notifies and does NOT run the executor', async () => {
    let called = false;
    registerApprovedExecutor('test_tool', () => {
      called = true;
      return { content: [{ text: '{}' }] };
    });
    const notes: string[] = [];
    await executeApprovedAction(
      { tool: 'test_tool', args: {}, approved: false, summary: 'delete 9 tasks' },
      { notify: (t) => notes.push(t) },
    );
    expect(called).toBe(false);
    expect(notes.join('\n')).toMatch(/declined/i);
    expect(notes.join('\n')).toContain('delete 9 tasks');
  });

  it('surfaces an engine failure (result success:false) as a fail-loud notice', async () => {
    registerApprovedExecutor('test_tool', () => ({
      content: [{ text: JSON.stringify({ success: false, error: 'person not found' }) }],
    }));
    const notes: string[] = [];
    await executeApprovedAction(
      { tool: 'test_tool', args: {}, approved: true, summary: 'reassign' },
      { notify: (t) => notes.push(t) },
    );
    expect(notes.join('\n')).toMatch(/failed/i);
    expect(notes.join('\n')).toContain('person not found');
  });

  it('fail-closed: a row MISSING the approved flag does NOT execute (treated as declined)', async () => {
    let called = false;
    registerApprovedExecutor('test_tool', () => {
      called = true;
      return { content: [{ text: '{}' }] };
    });
    const notes: string[] = [];
    // No `approved` field at all — must NOT run (the gate can never fail open).
    await executeApprovedAction({ tool: 'test_tool', args: {}, summary: 'malformed' }, { notify: (t) => notes.push(t) });
    expect(called).toBe(false);
    expect(notes.join('\n')).toMatch(/declined/i);
  });

  it('notifies (no throw) when no executor is registered for the tool', async () => {
    const notes: string[] = [];
    await executeApprovedAction(
      { tool: 'no_such_tool', args: {}, approved: true, summary: 'mystery' },
      { notify: (t) => notes.push(t) },
    );
    expect(notes.join('\n')).toMatch(/could not run|no handler/i);
  });
});
