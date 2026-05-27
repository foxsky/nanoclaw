import { describe, expect, it } from 'bun:test';

import { addHierarchyFormattedResult } from './taskflow-api-mutate.ts';

const EXACT_TURN18 =
  '🔗 *P11.19* — Rollup atualizado\n━━━━━━━━━━━━━━\n\n• Status: _sem atividade_ — nenhuma tarefa iniciada no quadro do Rodrigo ainda\n• Coluna mantida: ⏭️ Próximas Ações';

describe('addHierarchyFormattedResult — refresh_rollup card', () => {
  it('formats the v1 Phase-3 Turn-18 refresh_rollup confirmation', () => {
    const out = addHierarchyFormattedResult(
      {
        success: true,
        task_id: 'P11.19',
        rollup_status: 'no_work_yet',
        rollup_summary: 'nenhuma tarefa iniciada no quadro do Rodrigo ainda',
        new_column: 'next_action',
      },
      'refresh_rollup',
    );

    expect(out.formatted).toBe(EXACT_TURN18);
  });

  it('preserves an engine-provided formatted field', () => {
    const out = addHierarchyFormattedResult(
      {
        success: true,
        formatted: 'engine card',
        task_id: 'P11.19',
        rollup_status: 'no_work_yet',
        new_column: 'next_action',
      },
      'refresh_rollup',
    );

    expect(out.formatted).toBe('engine card');
  });

  it('does not format failed hierarchy calls', () => {
    const out = addHierarchyFormattedResult(
      {
        success: false,
        task_id: 'P11.19',
        rollup_status: 'no_work_yet',
        new_column: 'next_action',
      },
      'refresh_rollup',
    );

    expect(out.formatted).toBeUndefined();
  });

  it('does not format non-rollup hierarchy actions', () => {
    const out = addHierarchyFormattedResult(
      {
        success: true,
        task_id: 'P11.19',
        rollup_status: 'no_work_yet',
        new_column: 'next_action',
      },
      'link',
    );

    expect(out.formatted).toBeUndefined();
  });

  it('fails closed when required rollup fields are missing', () => {
    const out = addHierarchyFormattedResult(
      {
        success: true,
        task_id: 'P11.19',
        rollup_status: 'no_work_yet',
      },
      'refresh_rollup',
    );

    expect(out.formatted).toBeUndefined();
  });
});
