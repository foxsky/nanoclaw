import { describe, expect, it } from 'bun:test';
import { buildMoveCard } from './taskflow-api-mutate.ts';

// V1-faithful move/conclude confirmation card — mirrors the create card family
// (the user's ground-truth examples: ✅ *Tarefa criada* … *id* — title /
// 👤 *Atribuída a:* / <emoji> *Coluna:* / • ⏰ Prazo / • Prioridade / • 📝 Nota).
// Today a move emits only a one-liner (addMoveFormattedResult); this card replaces it.

describe('buildMoveCard — V1-faithful move/conclude confirmation card', () => {
  it('conclude → review (T122 case): NO trailing bullets when due/priority unset (only-when-set)', () => {
    const card = buildMoveCard({
      id: 'T122',
      title: 'Feedback sobre a relação de buracos enviados para às SDUs',
      type: 'simple',
      assignee: 'Thiago Carvalho',
      column: 'review',
      due_date: null,
      priority: null,
    });
    expect(card).toBe(
      [
        '✅ *Tarefa movida*',
        '━━━━━━━━━━━━━━',
        '',
        '*T122* — Feedback sobre a relação de buracos enviados para às SDUs',
        '👤 *Atribuída a:* Thiago Carvalho',
        '🔍 *Coluna:* Revisão',
      ].join('\n'),
    );
  });

  it('shows Prazo + Prioridade bullets (with one preceding blank line) only when those fields are set', () => {
    const card = buildMoveCard({
      id: 'T9',
      title: 'x',
      type: 'simple',
      assignee: 'A',
      column: 'in_progress',
      due_date: '2026-06-19',
      priority: 'alta',
    });
    expect(card).toBe(
      [
        '✅ *Tarefa movida*',
        '━━━━━━━━━━━━━━',
        '',
        '*T9* — x',
        '👤 *Atribuída a:* A',
        '🔄 *Coluna:* Em Andamento',
        '',
        '• ⏰ Prazo: 19/06/2026',
        '• Prioridade: alta',
      ].join('\n'),
    );
  });

  it('renders a due date as DD/MM/YYYY (example A format) and the next_action ⏭️ column', () => {
    const card = buildMoveCard({
      id: 'T124',
      title: 'Registro do número',
      type: 'simple',
      assignee: 'Rafael',
      column: 'next_action',
      due_date: '2026-06-08',
      priority: 'normal',
    });
    expect(card).toContain('⏭️ *Coluna:* Próximas Ações');
    expect(card).toContain('• ⏰ Prazo: 08/06/2026');
  });

  it('project uses masculine gender + "Projeto movido" header', () => {
    const card = buildMoveCard({
      id: 'P7',
      title: 'Estágio Probatório',
      type: 'project',
      assignee: 'Thiago',
      column: 'in_progress',
      due_date: null,
      priority: 'normal',
    });
    expect(card).toContain('✅ *Projeto movido*');
    expect(card).toContain('👤 *Atribuído a:* Thiago');
    expect(card).toContain('🔄 *Coluna:* Em Andamento');
  });

  it('appends a Nota bullet only when a note is present', () => {
    const withNote = buildMoveCard({
      id: 'T114', title: 'Carta de Serviço', type: 'simple', assignee: 'Thiago',
      column: 'next_action', note: 'Araci trabalhou no planejamento estratégico da SDU',
    });
    expect(withNote).toContain('• 📝 Nota: Araci trabalhou no planejamento estratégico da SDU');
    const noNote = buildMoveCard({
      id: 'T1', title: 'x', type: 'simple', assignee: 'A', column: 'review',
    });
    expect(noNote).not.toContain('📝 Nota');
  });

  it('returns null when required fields are missing (no fabrication)', () => {
    expect(buildMoveCard({ id: 'T1', title: 'x', assignee: '', column: 'review' })).toBeNull();
    expect(buildMoveCard({ id: '', title: 'x', assignee: 'A', column: 'review' })).toBeNull();
  });
});
