import { describe, expect, it } from 'bun:test';

import { buildCreatedTaskCard, buildInboxCard } from './taskflow-api-mutate.ts';

// BYTE-FAITHFUL spec for v1's standalone (no-reparent) create card.
// Ground truth = sec-secti GATE v1 final_responses: T0/T6/T10/T13/T14
// (simple → "Tarefa criada"), T5 (project → "Projeto criado"). Phase-3
// follow-up #7. Scope: next_action column only — inbox creates use the
// separate "📥 Capturada no Inbox" variant (no in-scope exemplar);
// recurring/meeting have none → null.

describe('buildCreatedTaskCard — v1 no-reparent create card (#7)', () => {
  it('simple task → "✅ *Tarefa criada*" with feminine "Atribuída"', () => {
    expect(
      buildCreatedTaskCard({
        id: 'T99',
        title: 'SEMEC/MEI/Prestação de Contas',
        type: 'simple',
        assignee: 'Thiago',
        column: 'next_action',
      }),
    ).toBe(
      '✅ *Tarefa criada*\n━━━━━━━━━━━━━━\n\n*T99* — SEMEC/MEI/Prestação de Contas\n👤 *Atribuída a:* Thiago\n⏭️ *Coluna:* Próximas Ações',
    );
  });

  it('project → "✅ *Projeto criado*" with masculine "Atribuído"', () => {
    expect(
      buildCreatedTaskCard({
        id: 'P28',
        title: 'SDU/Sudeste',
        type: 'project',
        assignee: 'Giovanni',
        column: 'next_action',
      }),
    ).toBe(
      '✅ *Projeto criado*\n━━━━━━━━━━━━━━\n\n*P28* — SDU/Sudeste\n👤 *Atribuído a:* Giovanni\n⏭️ *Coluna:* Próximas Ações',
    );
  });

  it('inbox column → null (separate "Capturada no Inbox" variant, no in-scope exemplar)', () => {
    expect(
      buildCreatedTaskCard({ id: 'T73', title: 'X', type: 'simple', assignee: 'Ana', column: 'inbox' }),
    ).toBeNull();
  });

  it('non-next_action column → null', () => {
    expect(
      buildCreatedTaskCard({ id: 'T1', title: 'X', type: 'simple', assignee: 'Ana', column: 'in_progress' }),
    ).toBeNull();
  });

  it('recurring / meeting type → null (no v1 exemplar)', () => {
    expect(
      buildCreatedTaskCard({ id: 'R1', title: 'X', type: 'recurring', assignee: 'Ana', column: 'next_action' }),
    ).toBeNull();
    expect(
      buildCreatedTaskCard({ id: 'M1', title: 'X', type: 'meeting', assignee: 'Ana', column: 'next_action' }),
    ).toBeNull();
  });

  it('missing id / title / assignee → null (no fabrication)', () => {
    const base = { id: 'T1', title: 'X', type: 'simple', assignee: 'Ana', column: 'next_action' };
    expect(buildCreatedTaskCard({ ...base, id: '' })).toBeNull();
    expect(buildCreatedTaskCard({ ...base, title: '   ' })).toBeNull();
    expect(buildCreatedTaskCard({ ...base, assignee: undefined })).toBeNull();
  });

  it('non-string fields → null (defensive)', () => {
    expect(
      buildCreatedTaskCard({ id: 123, title: 'X', type: 'simple', assignee: 'Ana', column: 'next_action' }),
    ).toBeNull();
  });

  // Only-when-set trailing bullets (V1 ground truth: T124 Prazo, T126 Prazo+Prioridade).
  it('appends • ⏰ Prazo (DD/MM/YYYY) only when due_date is set', () => {
    expect(
      buildCreatedTaskCard({
        id: 'T124', title: 'Registro', type: 'simple', assignee: 'Rafael',
        column: 'next_action', due_date: '2026-06-08',
      }),
    ).toBe(
      [
        '✅ *Tarefa criada*', '━━━━━━━━━━━━━━', '',
        '*T124* — Registro', '👤 *Atribuída a:* Rafael', '⏭️ *Coluna:* Próximas Ações',
        '', '• ⏰ Prazo: 08/06/2026',
      ].join('\n'),
    );
  });

  it('appends • Prioridade only when set; both bullets share one preceding blank line', () => {
    const card = buildCreatedTaskCard({
      id: 'T126', title: 'X', type: 'simple', assignee: 'Miguel',
      column: 'next_action', due_date: '2026-06-08', priority: 'alta',
    });
    expect(card).toContain('\n\n• ⏰ Prazo: 08/06/2026\n• Prioridade: alta');
  });

  it('no due/priority → byte-identical to the old no-bullet card (no trailing block)', () => {
    expect(
      buildCreatedTaskCard({ id: 'T1', title: 'X', type: 'simple', assignee: 'Ana', column: 'next_action' }),
    ).toBe(
      ['✅ *Tarefa criada*', '━━━━━━━━━━━━━━', '', '*T1* — X', '👤 *Atribuída a:* Ana', '⏭️ *Coluna:* Próximas Ações'].join('\n'),
    );
  });
});

describe('buildInboxCard — v1 "📥 Capturado no Inbox"', () => {
  it('inbox create → header + id/title only (no assignee/column line)', () => {
    expect(buildInboxCard({ id: 'T95', title: 'Reajuste aluguel do terreno/torre', column: 'inbox' })).toBe(
      ['📥 *Capturado no Inbox*', '━━━━━━━━━━━━━━', '', '*T95* — Reajuste aluguel do terreno/torre'].join('\n'),
    );
  });
  it('non-inbox column → null (buildCreatedTaskCard handles next_action)', () => {
    expect(buildInboxCard({ id: 'T1', title: 'X', column: 'next_action' })).toBeNull();
  });
});
