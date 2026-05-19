import { describe, expect, it } from 'bun:test';

import { buildCreateCard } from './taskflow-api-mutate.ts';

// Phase-3 unit-2-core: v1's generic "task created under a project" card.
// No reusable v1 formatter exists; the authoritative ground truth is the
// corpus v1.final_response (seci Turn 0, "p11 adicionar nova tarefa
// Treinamento E-governe"):
//
//   ✅ *P11.23 adicionada*
//   ━━━━━━━━━━━━━━
//
//   📁 *P11* — Operação da SECTI
//      📋 *P11.23* — Treinamento E-governe
//
// (the "Case: " prefix is v1's delivery prefix, not the card). Only the
// with-parent shape has a ground-truth exemplar — the no-parent and the
// ID-conflict "atualizada/↳" variants are intentionally NOT guessed
// (return null; follow-up increments + Codex gate).

const EXACT_TURN0 =
  '✅ *P11.23 adicionada*\n━━━━━━━━━━━━━━\n\n📁 *P11* — Operação da SECTI\n   📋 *P11.23* — Treinamento E-governe';

describe('buildCreateCard — v1-faithful generic create card', () => {
  it('with parent → byte-exact v1 Turn-0 format', () => {
    expect(
      buildCreateCard({
        id: 'P11.23',
        title: 'Treinamento E-governe',
        parent_task_id: 'P11',
        parent_task_title: 'Operação da SECTI',
      }),
    ).toBe(EXACT_TURN0);
  });

  it('no parent → null (no ground-truth exemplar — do NOT guess)', () => {
    expect(
      buildCreateCard({ id: 'P5', title: 'New project', parent_task_id: null, parent_task_title: null }),
    ).toBeNull();
  });

  it('missing parent title → null (cannot build the 📁 line faithfully)', () => {
    expect(
      buildCreateCard({ id: 'P11.23', title: 'X', parent_task_id: 'P11', parent_task_title: null }),
    ).toBeNull();
  });

  it('missing id or title → null', () => {
    expect(buildCreateCard({ id: '', title: 'X', parent_task_id: 'P1', parent_task_title: 'P' })).toBeNull();
    expect(buildCreateCard({ id: 'P1.1', title: '', parent_task_id: 'P1', parent_task_title: 'P' })).toBeNull();
  });
});
