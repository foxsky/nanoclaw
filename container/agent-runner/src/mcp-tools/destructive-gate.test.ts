import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_THRESHOLDS,
  evaluateDestructiveAction,
  isStructureAdminAction,
  resolveThresholds,
} from './destructive-gate.js';

describe('evaluateDestructiveAction', () => {
  it('does NOT gate normal single-task work (the gate must not block legitimate use)', () => {
    expect(evaluateDestructiveAction({ kind: 'mutation', affected: 1 }).gated).toBe(false);
    expect(evaluateDestructiveAction({ kind: 'mutation', affected: 4 }).gated).toBe(false); // below default 5
    expect(evaluateDestructiveAction({ kind: 'delete', affected: 1 }).gated).toBe(false);
    expect(evaluateDestructiveAction({ kind: 'delete', affected: 2 }).gated).toBe(false); // below default 3
    expect(evaluateDestructiveAction({ kind: 'broadcast', destinations: 1, external: false }).gated).toBe(false);
  });

  it('gates mass reassign/move/update at or above the threshold (category mass_mutation)', () => {
    const d = evaluateDestructiveAction({ kind: 'mutation', affected: 5 });
    expect(d.gated).toBe(true);
    expect(d.category).toBe('mass_mutation');
    expect(d.reason).toContain('5');
  });

  it('gates bulk delete at the threshold, and ALWAYS gates a delete that erases history/archive', () => {
    expect(evaluateDestructiveAction({ kind: 'delete', affected: 3 }).category).toBe('destructive_delete');
    // History/archive erasure is irreversible → gated even for a single row.
    const hist = evaluateDestructiveAction({ kind: 'delete', affected: 1, touchesHistory: true });
    expect(hist.gated).toBe(true);
    expect(hist.category).toBe('destructive_delete');
    expect(hist.reason).toContain('irreversible');
  });

  it('ALWAYS gates a structure change (remove board / person / admin)', () => {
    const d = evaluateDestructiveAction({ kind: 'structure', adminAction: 'remove_child_board' });
    expect(d.gated).toBe(true);
    expect(d.category).toBe('structure');
    expect(d.reason).toContain('remove_child_board');
  });

  it('ALWAYS gates an external send, and gates a fan-out broadcast at the threshold', () => {
    expect(evaluateDestructiveAction({ kind: 'broadcast', destinations: 1, external: true }).category).toBe('broadcast');
    expect(evaluateDestructiveAction({ kind: 'broadcast', destinations: 3, external: false }).gated).toBe(true);
    expect(evaluateDestructiveAction({ kind: 'broadcast', destinations: 2, external: false }).gated).toBe(false);
  });

  it('honors env threshold overrides', () => {
    const tight = { massMutation: 2, massDelete: 1, broadcast: 1 };
    expect(evaluateDestructiveAction({ kind: 'mutation', affected: 2 }, tight).gated).toBe(true);
    expect(evaluateDestructiveAction({ kind: 'delete', affected: 1 }, tight).gated).toBe(true);
    expect(evaluateDestructiveAction({ kind: 'broadcast', destinations: 1, external: false }, tight).gated).toBe(true);
  });
});

describe('resolveThresholds', () => {
  it('uses safe defaults when no env override is set', () => {
    expect(resolveThresholds({})).toEqual(DEFAULT_THRESHOLDS);
  });

  it('applies valid positive overrides', () => {
    const t = resolveThresholds({ TASKFLOW_GATE_MASS: '10', TASKFLOW_GATE_DELETE: '2', TASKFLOW_GATE_BROADCAST: '5' });
    expect(t).toEqual({ massMutation: 10, massDelete: 2, broadcast: 5 });
  });

  it('FAILS SAFE: a malformed or non-positive override never disables the gate (falls back to default)', () => {
    expect(resolveThresholds({ TASKFLOW_GATE_MASS: 'banana' }).massMutation).toBe(DEFAULT_THRESHOLDS.massMutation);
    expect(resolveThresholds({ TASKFLOW_GATE_DELETE: '0' }).massDelete).toBe(DEFAULT_THRESHOLDS.massDelete);
    expect(resolveThresholds({ TASKFLOW_GATE_BROADCAST: '-1' }).broadcast).toBe(DEFAULT_THRESHOLDS.broadcast);
  });
});

describe('isStructureAdminAction', () => {
  it('flags removals/revocations as structure changes; truly-additive task ops are not', () => {
    expect(isStructureAdminAction('remove_child_board')).toBe(true);
    expect(isStructureAdminAction('remove_person')).toBe(true);
    expect(isStructureAdminAction('remove_admin')).toBe(true);
    // register_person auto-provisions a child board (a deterministic, system-driven additive flow);
    // set_wip_limit is a per-person cap — neither is a privilege/structure escalation.
    expect(isStructureAdminAction('register_person')).toBe(false);
    expect(isStructureAdminAction('set_wip_limit')).toBe(false);
  });

  it('#411: gates merge_project + privilege grants + cross-board policy as structure changes', () => {
    // merge_project archives + re-IDs a whole project; add_manager/add_delegate are PRIVILEGE grants
    // (escalation under injection — the "additive = safe" heuristic predates the threat model);
    // set_cross_board_subtask_mode flips a board-wide write policy.
    for (const action of ['merge_project', 'add_manager', 'add_delegate', 'set_cross_board_subtask_mode']) {
      expect(isStructureAdminAction(action)).toBe(true);
      const d = evaluateDestructiveAction({ kind: 'structure', adminAction: action });
      expect(d.gated).toBe(true);
      expect(d.category).toBe('structure');
    }
  });
});
