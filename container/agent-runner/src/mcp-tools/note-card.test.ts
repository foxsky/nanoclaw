import { describe, expect, it } from 'bun:test';

import {
  addNoteFormattedResult,
  buildNoteCard,
} from './taskflow-api-mutate.ts';

// Scope: simple add_note only. Reply-note (parent_note_id) and dedup
// (engine returns 'Nota já existente: …') both refuse the card —
// no fabrication; user gets the bare-text fallback in those cases.

const EXACT_TURN34 =
  '✅ *P11.23* atualizada\n━━━━━━━━━━━━━━\n\n• Nota: Demanda no chamado CAST 38876';
const EXACT_TURN35 =
  '✅ *P11.15* atualizada\n━━━━━━━━━━━━━━\n\n• Nota: Verificar se a melhor opção é usar Tailscale ou AnyDesk';

describe('buildNoteCard — v1-faithful add_note card (simple-note scope)', () => {
  it('byte-exact v1 Turn-34 card', () => {
    expect(buildNoteCard('P11.23', 'Demanda no chamado CAST 38876')).toBe(EXACT_TURN34);
  });

  it('byte-exact v1 Turn-35 card', () => {
    expect(
      buildNoteCard('P11.15', 'Verificar se a melhor opção é usar Tailscale ou AnyDesk'),
    ).toBe(EXACT_TURN35);
  });

  it('empty taskId → null', () => {
    expect(buildNoteCard('', 'x')).toBeNull();
  });

  it('empty noteText → null', () => {
    expect(buildNoteCard('P1', '')).toBeNull();
  });

  it('non-string taskId → null', () => {
    expect(buildNoteCard(42 as unknown as string, 'x')).toBeNull();
  });

  it('non-string noteText → null', () => {
    expect(buildNoteCard('P1', 42 as unknown as string)).toBeNull();
  });

  it('multi-line note text → preserved verbatim inside the bullet', () => {
    expect(buildNoteCard('P1', 'line1\nline2')).toBe(
      '✅ *P1* atualizada\n━━━━━━━━━━━━━━\n\n• Nota: line1\nline2',
    );
  });
});

function addNoteResult(over: Record<string, unknown> = {}) {
  return {
    success: true,
    data: { id: 'P11.23', title: 'Treinamento E-governe' },
    changes: ['Note added: Demanda no chamado CAST 38876'],
    ...over,
  };
}

describe('addNoteFormattedResult — wires buildNoteCard onto api_task_add_note', () => {
  it('success + simple note → result.formatted = byte-exact v1 card', () => {
    const out = addNoteFormattedResult(addNoteResult() as never, {
      task_id: 'P11.23',
      text: 'Demanda no chamado CAST 38876',
    });
    expect((out as { formatted?: string }).formatted).toBe(EXACT_TURN34);
  });

  it('failure → unchanged (no card)', () => {
    const out = addNoteFormattedResult(addNoteResult({ success: false }) as never, {
      task_id: 'P11.23',
      text: 'x',
    });
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('preserves an already-set formatted (no double-format)', () => {
    const out = addNoteFormattedResult(addNoteResult({ formatted: 'pre' }) as never, {
      task_id: 'P11.23',
      text: 'x',
    });
    expect((out as { formatted?: string }).formatted).toBe('pre');
  });

  it('parent_note_id present (reply note) → unchanged (no corpus exemplar; no fabrication)', () => {
    const out = addNoteFormattedResult(addNoteResult() as never, {
      task_id: 'P11.23',
      text: 'x',
      parent_note_id: 42,
    });
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('engine dedup branch (changes startsWith "Nota já existente:") → byte-exact "Nota já existente na <id>" card (deterministic emit, Codex seci Turn 35)', () => {
    const out = addNoteFormattedResult(
      addNoteResult({
        changes: ['Nota já existente: Demanda no chamado CAST 38876'],
      }) as never,
      { task_id: 'P11.23', text: 'Demanda no chamado CAST 38876' },
    );
    expect((out as { formatted?: string }).formatted).toBe(
      `Nota já existente na P11.23 — "Demanda no chamado CAST 38876" já estava registrada anteriormente. Nenhuma duplicata foi adicionada.`,
    );
  });

  it('empty taskId arg → unchanged (defensive; engine would have errored upstream anyway)', () => {
    const out = addNoteFormattedResult(addNoteResult() as never, {
      task_id: '',
      text: 'x',
    });
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('empty noteText arg → unchanged (defensive)', () => {
    const out = addNoteFormattedResult(addNoteResult() as never, {
      task_id: 'P11.23',
      text: '',
    });
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });
});
