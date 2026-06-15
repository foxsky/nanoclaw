import { afterEach, describe, expect, it, vi } from 'vitest';

// The DB layer writes nothing we assert here; stub it so resolveOneCLIApproval's
// authorized path doesn't need a real central DB. The SECURITY-critical path we test
// (an unauthorized responder) returns BEFORE any DB call, so these stubs are only a guard.
vi.mock('../../db/sessions.js', () => ({
  createPendingApproval: vi.fn(),
  deletePendingApproval: vi.fn(),
  getPendingApprovalsByAction: vi.fn(() => []),
  updatePendingApprovalStatus: vi.fn(),
}));

import {
  __seedPendingForTest,
  isAuthorizedResponder,
  resolveOneCLIApproval,
  responderIdFromPayload,
  stopOneCLIApprovalHandler,
} from './onecli-approvals.js';

afterEach(() => {
  // Clears the in-memory pending map + any seeded timers so tests don't leak.
  stopOneCLIApprovalHandler();
});

describe('isAuthorizedResponder (only an eligible approver may resolve a credentialed action)', () => {
  it('accepts a responder present in the eligible approver set', () => {
    expect(isAuthorizedResponder('whatsapp:5511999', ['whatsapp:5511999', 'whatsapp:5511888'])).toBe(true);
  });

  it('rejects a responder who is not an eligible approver', () => {
    // The whole point: a non-admin/owner who can reach or forge the response must not approve.
    expect(isAuthorizedResponder('whatsapp:6500000', ['whatsapp:5511999'])).toBe(false);
  });

  it('FAILS CLOSED on an empty/unverifiable responder (no namespaced id → deny)', () => {
    // If the channel didn't surface who clicked, we cannot prove authorization → deny.
    expect(isAuthorizedResponder('', ['whatsapp:5511999'])).toBe(false);
    expect(isAuthorizedResponder('whatsapp:5511999', [])).toBe(false);
  });
});

describe('responderIdFromPayload (raw platform id must be namespaced before the privilege check)', () => {
  it('namespaces channelType + userId to the users(id) format pickApprover returns', () => {
    expect(responderIdFromPayload({ userId: '5511999', channelType: 'whatsapp' })).toBe('whatsapp:5511999');
  });

  it('returns "" (→ fail closed) when the clicker id or channel is missing', () => {
    expect(responderIdFromPayload({ userId: null, channelType: 'whatsapp' })).toBe('');
    expect(responderIdFromPayload({ userId: '5511999', channelType: '' })).toBe('');
  });
});

describe('resolveOneCLIApproval responder authorization (the credential-approval re-auth gate)', () => {
  it('returns false for an unknown approval id (falls through to other handlers)', () => {
    expect(resolveOneCLIApproval('oa-nope', 'approve', 'whatsapp:5511999')).toBe(false);
  });

  it('IGNORES an approve from a non-approver: does not resolve the action, leaves it pending', () => {
    // A response carrying a known questionId but from a user who is NOT an eligible
    // approver (a different chat/user, or a forged/replayed response) must NOT approve
    // the credentialed action. It is swallowed (claimed=true so it doesn't fall through
    // and delete the row) while the in-memory decision stays unresolved for a real approver.
    const box = __seedPendingForTest('oa-1', ['whatsapp:5511999']);
    const claimed = resolveOneCLIApproval('oa-1', 'approve', 'whatsapp:6500000'); // not an approver
    expect(claimed).toBe(true);
    expect(box.resolved).toBeNull(); // credential access was NOT granted
  });

  it('IGNORES an approve with an empty responder (unverifiable clicker fails closed)', () => {
    const box = __seedPendingForTest('oa-2', ['whatsapp:5511999']);
    const claimed = resolveOneCLIApproval('oa-2', 'approve', '');
    expect(claimed).toBe(true);
    expect(box.resolved).toBeNull();
  });

  it('resolves the action when the responder IS an eligible approver', () => {
    const box = __seedPendingForTest('oa-3', ['whatsapp:5511999']);
    const claimed = resolveOneCLIApproval('oa-3', 'approve', 'whatsapp:5511999');
    expect(claimed).toBe(true);
    expect(box.resolved).toBe('approve'); // a real approver's decision goes through
  });
});
