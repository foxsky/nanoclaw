import { describe, expect, it } from 'bun:test';

import {
  addUpdateFormattedResult,
  buildAddSubtaskCard,
} from './taskflow-api-mutate.ts';

// v2-coherent SUBSET of v1's add_subtask card. v1 source for this card
// is not in the agent-runner repo; corpus exemplars (seci Turn 9, Turn 39)
// show two divergent v1 templates (`*P22 atualizada*` whole-bold + 📋 +
// `⏰ Prazo: dd/mm/yyyy (hoje)` vs `*P2* atualizada` + ↳ + ID-conflict
// footer). v2 ships the Turn-9 header style + 📁 parent + 📋 sub
// adicionada. No due_date line (engine path doesn't carry sub due_date),
// no `(hoje)` relative-date tag (un-replayable), no Turn-39 ↳/ID-conflict
// variant (separate template, no v1 source).

const EXACT_T9_SHAPE =
  '✅ *P22 atualizada*\n━━━━━━━━━━━━━━\n\n📁 *P22* — Cidadão Beneficiário dos Programas Sociais - CadÚnico\n   📋 *P22.2* — Visita aos CRAS adicionada';

describe('buildAddSubtaskCard — v2-coherent add_subtask card (Turn-9 header style)', () => {
  it('byte-exact v2 card for {parent, sub} (Turn-9 shape, no date)', () => {
    expect(
      buildAddSubtaskCard(
        { id: 'P22', title: 'Cidadão Beneficiário dos Programas Sociais - CadÚnico' },
        { id: 'P22.2', title: 'Visita aos CRAS' },
      ),
    ).toBe(EXACT_T9_SHAPE);
  });

  it('whole-line bold on header (mirrors Turn-9 *P22 atualizada*, NOT *P22* atualizada)', () => {
    const card = buildAddSubtaskCard(
      { id: 'P22', title: 'parent' },
      { id: 'P22.2', title: 'sub' },
    );
    expect(card).toContain('✅ *P22 atualizada*');
    expect(card).not.toContain('*P22* atualizada');
  });

  it('with sub.due_date → appends ⏰ Prazo: dd/mm/yyyy line (no relative tag without `today`)', () => {
    expect(
      buildAddSubtaskCard(
        { id: 'P22', title: 'parent' },
        { id: 'P22.2', title: 'sub', due_date: '2026-05-14' },
      ),
    ).toBe(
      '✅ *P22 atualizada*\n━━━━━━━━━━━━━━\n\n📁 *P22* — parent\n   📋 *P22.2* — sub adicionada\n   ⏰ Prazo: 14/05/2026',
    );
  });

  it('with sub.due_date AND today === due_date → appends "(hoje)" tag', () => {
    expect(
      buildAddSubtaskCard(
        { id: 'P22', title: 'parent' },
        { id: 'P22.2', title: 'sub', due_date: '2026-05-14' },
        '2026-05-14',
      ),
    ).toBe(
      '✅ *P22 atualizada*\n━━━━━━━━━━━━━━\n\n📁 *P22* — parent\n   📋 *P22.2* — sub adicionada\n   ⏰ Prazo: 14/05/2026 (hoje)',
    );
  });

  it('with sub.due_date but today !== due_date → no "(hoje)" tag', () => {
    expect(
      buildAddSubtaskCard(
        { id: 'P22', title: 'parent' },
        { id: 'P22.2', title: 'sub', due_date: '2026-05-14' },
        '2026-05-21',
      ),
    ).toBe(
      '✅ *P22 atualizada*\n━━━━━━━━━━━━━━\n\n📁 *P22* — parent\n   📋 *P22.2* — sub adicionada\n   ⏰ Prazo: 14/05/2026',
    );
  });

  it('invalid ISO sub.due_date → no date line (fall back to no-date card)', () => {
    expect(
      buildAddSubtaskCard(
        { id: 'P22', title: 'parent' },
        { id: 'P22.2', title: 'sub', due_date: '14/05/2026' },
      ),
    ).toBe('✅ *P22 atualizada*\n━━━━━━━━━━━━━━\n\n📁 *P22* — parent\n   📋 *P22.2* — sub adicionada');
  });

  it('missing parent.id → null', () => {
    expect(buildAddSubtaskCard({ id: '', title: 't' }, { id: 'P1.1', title: 's' })).toBeNull();
  });

  it('missing parent.title → null (no fabrication)', () => {
    expect(buildAddSubtaskCard({ id: 'P1', title: '' }, { id: 'P1.1', title: 's' })).toBeNull();
  });

  it('missing sub.id → null', () => {
    expect(buildAddSubtaskCard({ id: 'P1', title: 't' }, { id: '', title: 's' })).toBeNull();
  });

  it('missing sub.title → null', () => {
    expect(buildAddSubtaskCard({ id: 'P1', title: 't' }, { id: 'P1.1', title: '' })).toBeNull();
  });

  it('non-string field → null', () => {
    expect(
      buildAddSubtaskCard(
        { id: 'P1', title: 't' },
        { id: 42 as unknown as string, title: 's' },
      ),
    ).toBeNull();
  });
});

function updateResultWithSubtask(over: Record<string, unknown> = {}) {
  return {
    success: true,
    task_id: 'P22',
    title: 'Cidadão Beneficiário dos Programas Sociais - CadÚnico',
    changes: ['Subtarefa P22.2 "Visita aos CRAS" adicionada'],
    subtask: { id: 'P22.2', title: 'Visita aos CRAS' },
    ...over,
  };
}

describe('addUpdateFormattedResult — add_subtask dispatch', () => {
  it('updates = {add_subtask only}, result.subtask present → emits card from result.subtask + result.title', () => {
    const out = addUpdateFormattedResult(
      updateResultWithSubtask() as never,
      { add_subtask: 'Visita aos CRAS' },
    );
    expect((out as { formatted?: string }).formatted).toBe(EXACT_T9_SHAPE);
  });

  it('updates = {add_subtask object form} with due_date + today injected → emits card with (hoje) tag', () => {
    const out = addUpdateFormattedResult(
      updateResultWithSubtask({ subtask: { id: 'P22.2', title: 'Visita aos CRAS', due_date: '2026-05-14' } }) as never,
      { add_subtask: { title: 'Visita aos CRAS', due_date: '2026-05-14' } },
      '2026-05-14',
    );
    expect((out as { formatted?: string }).formatted).toBe(
      '✅ *P22 atualizada*\n━━━━━━━━━━━━━━\n\n📁 *P22* — Cidadão Beneficiário dos Programas Sociais - CadÚnico\n   📋 *P22.2* — Visita aos CRAS adicionada\n   ⏰ Prazo: 14/05/2026 (hoje)',
    );
  });

  it('updates = {add_subtask, due_date} multi-key → null (date applies to parent, not sub; no fabrication)', () => {
    const out = addUpdateFormattedResult(
      updateResultWithSubtask() as never,
      { add_subtask: 'Visita aos CRAS', due_date: '2026-05-14' },
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('updates = {add_subtask} but result.subtask missing → unchanged', () => {
    const out = addUpdateFormattedResult(
      updateResultWithSubtask({ subtask: undefined }) as never,
      { add_subtask: 'Visita aos CRAS' },
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('failure → unchanged', () => {
    const out = addUpdateFormattedResult(
      updateResultWithSubtask({ success: false }) as never,
      { add_subtask: 'X' },
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('preserves already-set formatted (no double-format)', () => {
    const out = addUpdateFormattedResult(
      updateResultWithSubtask({ formatted: 'pre' }) as never,
      { add_subtask: 'X' },
    );
    expect((out as { formatted?: string }).formatted).toBe('pre');
  });

  it('missing parent.title on result (engine returned without title) → unchanged', () => {
    const out = addUpdateFormattedResult(
      updateResultWithSubtask({ title: '' }) as never,
      { add_subtask: 'X' },
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });
});
