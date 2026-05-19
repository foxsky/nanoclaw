import { describe, expect, it } from 'bun:test';

import { addReparentFormattedResult } from './taskflow-api-mutate.ts';

// Phase-3 unit-2-core: the seci "add task X to project P11" turn is
// v2 `api_create_task` → `api_admin(reparent_task)`. v1's confirmation
// (`✅ *P11.23 adicionada* … 📁 *P11* — … 📋 *P11.23* — …`) reflects the
// POST-reparent state, so it must be emitted on the reparent completion
// (which routes through the unit-1-wired finalizeMutationResult), not on
// raw create. This wrapper feeds the v1-faithful buildCreateCard from the
// engine reparent result. Guards: only on action=reparent_task + success
// + all card fields present; otherwise result is unchanged.

const EXACT_TURN0 =
  '✅ *P11.23 adicionada*\n━━━━━━━━━━━━━━\n\n📁 *P11* — Operação da SECTI\n   📋 *P11.23* — Treinamento E-governe';

function reparentResult(over: Record<string, unknown> = {}) {
  return {
    success: true,
    task_id: 'P11.23',
    data: { parent_task_id: 'P11', parent_title: 'Operação da SECTI', task_title: 'Treinamento E-governe' },
    ...over,
  };
}

describe('addReparentFormattedResult — v1-faithful post-reparent create card', () => {
  it('reparent_task success → byte-exact v1 Turn-0 "adicionada" card', () => {
    const out = addReparentFormattedResult(reparentResult() as never, 'reparent_task');
    expect((out as { formatted?: string }).formatted).toBe(EXACT_TURN0);
  });

  it('non-reparent action → unchanged (no card)', () => {
    const out = addReparentFormattedResult(reparentResult() as never, 'cancel_task');
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('reparent failure → unchanged (no card)', () => {
    const out = addReparentFormattedResult(
      reparentResult({ success: false }) as never,
      'reparent_task',
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('missing task_title → no card (buildCreateCard guard, no fabrication)', () => {
    const out = addReparentFormattedResult(
      reparentResult({ data: { parent_task_id: 'P11', parent_title: 'Operação da SECTI' } }) as never,
      'reparent_task',
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('preserves an already-set formatted (no double-format)', () => {
    const out = addReparentFormattedResult(
      reparentResult({ formatted: 'pre' }) as never,
      'reparent_task',
    );
    expect((out as { formatted?: string }).formatted).toBe('pre');
  });
});
