import { describe, expect, it } from 'bun:test';

import { addReassignFormattedResult } from './taskflow-api-mutate.ts';
import type { ReassignResult } from '../taskflow-engine.ts';

// Phase-3 unit-2-core: the v2 MCP reassign confirmation must be
// BYTE-FAITHFUL to v1's `formatReassignReply` (poll-loop.ts:2281), not
// the plainer string the old wrapper produced. emitMutationConfirmation
// emits `result.formatted`, so this wrapper's output IS the user-facing
// card. Source of truth (reachable wrapper branches):
//   1 task : `✅ *<id>* — <title>\n\nReatribuída para <person>.`
//   N tasks: `✅ <n> tarefas reatribuídas para <person>:\n\n• *<id>* — <title>` …
// Guards (unchanged): no card on failure / requires_confirmation /
// empty tasks_affected / engine-preset formatted.

describe('addReassignFormattedResult — v1-faithful confirmation card', () => {
  it('single task → exact v1 formatReassignReply format', () => {
    const out = addReassignFormattedResult(
      { success: true, tasks_affected: [{ task_id: 'P11.15', title: 'Solicitar acesso', was_linked: false }] } as ReassignResult,
      'Lucas',
    );
    expect(out.formatted).toBe('✅ *P11.15* — Solicitar acesso\n\nReatribuída para Lucas.');
  });

  it('multiple tasks → exact v1 multi-task format', () => {
    const out = addReassignFormattedResult(
      {
        success: true,
        tasks_affected: [
          { task_id: 'A1', title: 'Task A', was_linked: false },
          { task_id: 'B2', title: 'Task B', was_linked: false },
        ],
      } as ReassignResult,
      'carol',
    );
    expect(out.formatted).toBe('✅ 2 tarefas reatribuídas para carol:\n\n• *A1* — Task A\n• *B2* — Task B');
  });

  it('no card on failure', () => {
    const out = addReassignFormattedResult({ success: false } as ReassignResult, 'x');
    expect(out.formatted).toBeUndefined();
  });

  it('no card on requires_confirmation (dry run / disambiguation)', () => {
    const out = addReassignFormattedResult(
      { success: true, requires_confirmation: 'confirm?', tasks_affected: [{ task_id: 'T', title: 't', was_linked: false }] } as ReassignResult,
      'x',
    );
    expect(out.formatted).toBeUndefined();
  });

  it('no card on empty tasks_affected', () => {
    const out = addReassignFormattedResult({ success: true, tasks_affected: [] } as ReassignResult, 'x');
    expect(out.formatted).toBeUndefined();
  });

  it('passes through an engine-preset formatted unchanged', () => {
    const out = addReassignFormattedResult(
      { success: true, formatted: 'engine-set', tasks_affected: [{ task_id: 'T', title: 't', was_linked: false }] } as ReassignResult,
      'x',
    );
    expect(out.formatted).toBe('engine-set');
  });
});
