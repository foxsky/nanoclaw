import { describe, expect, it } from 'bun:test';

import {
  addUpdateFormattedResult,
  buildUpdateCard,
} from './taskflow-api-mutate.ts';

// Phase-3 unit-2 (update card) — restores v1's deterministic
// `✅ *id* atualizada` confirmation that v1's poll-loop writeReply
// emitted (poll-loop.ts:~2068 area) and the v1→v2 MCP-tool port dropped.
// Card is BYTE-FAITHFUL to corpus ground truth (seci Turn 2 + Turn 38).
//
// Scope (this increment): title + due_date updates only. v1's `changes`
// strings drifted from the engine's (engine line 5515 emits
// `Título alterado para "X"` double-quoted; v1 emits `*X*`; engine
// line 5574 emits raw ISO `due_date`, v1 emits `⏰ Prazo definido:
// dd/mm/yyyy`). The card BUILDER therefore derives lines from the
// `updates` input directly, not from the engine's `changes` array.
// All other update flavors (priority, description, labels, notes,
// subtasks, recurrence, participants, …) intentionally return null
// here — no fabrication; covered by future scoped follow-ups.

const TURN2_TITLE =
  'Solicitar liberação de acesso remoto por AnyDesk para o desktop da SECI, inclusive em todos os horários';
const EXACT_TURN2 = `✅ *P11.15* atualizada\n━━━━━━━━━━━━━━\n\n• Título alterado para *${TURN2_TITLE}*`;
const EXACT_TURN38 =
  '✅ *P20.6* atualizada\n━━━━━━━━━━━━━━\n\n• ⏰ Prazo definido: 04/05/2026';
// Hypothetical combined update (no corpus exemplar) — order is the
// stable v1 enumeration: title first, due_date second. The same fixed
// order would be reproduced by v1's `changes` push order in
// taskflow-engine.ts (title at 5515, due_date at 5574/5580).
const EXACT_COMBINED =
  '✅ *P11.15* atualizada\n━━━━━━━━━━━━━━\n\n• Título alterado para *New title*\n• ⏰ Prazo definido: 22/04/2026';

describe('buildUpdateCard — v1-faithful update card (title + due_date scope)', () => {
  it('title-only update → byte-exact v1 Turn-2 card', () => {
    expect(buildUpdateCard('P11.15', { title: TURN2_TITLE })).toBe(EXACT_TURN2);
  });

  it('due_date-only update → byte-exact v1 Turn-38 card (ISO → dd/mm/yyyy)', () => {
    expect(buildUpdateCard('P20.6', { due_date: '2026-05-04' })).toBe(EXACT_TURN38);
  });

  it('title + due_date update → both bullets, title first', () => {
    expect(
      buildUpdateCard('P11.15', { title: 'New title', due_date: '2026-04-22' }),
    ).toBe(EXACT_COMBINED);
  });

  it('out-of-scope key (priority) → null (no fabrication; covered by follow-up)', () => {
    expect(buildUpdateCard('P11.15', { priority: 'high' })).toBeNull();
  });

  it('out-of-scope key (description) → null', () => {
    expect(buildUpdateCard('P11.15', { description: 'x' })).toBeNull();
  });

  it('out-of-scope key (add_subtask) → null (Turn-39 variant is a separate follow-up)', () => {
    expect(buildUpdateCard('P2', { add_subtask: 'Elaborar Contrato de Gestão' })).toBeNull();
  });

  it('out-of-scope key mixed with in-scope title → null (mixed scope ⇒ no fabrication)', () => {
    expect(buildUpdateCard('P11.15', { title: 'x', priority: 'high' })).toBeNull();
  });

  it('non-string title → null', () => {
    expect(buildUpdateCard('P11.15', { title: 42 as unknown as string })).toBeNull();
  });

  it('non-string due_date → null', () => {
    expect(buildUpdateCard('P20.6', { due_date: 12345 as unknown as string })).toBeNull();
  });

  it('non-ISO due_date (already dd/mm/yyyy) → null (engine input is ISO; refuse to guess)', () => {
    expect(buildUpdateCard('P20.6', { due_date: '04/05/2026' })).toBeNull();
  });

  // Codex gate G4 IMPORTANT: shape-only ISO validation accepted impossible
  // calendar dates like '2026-13-32'. Engine `new Date(s + 'T12:00:00Z')`
  // yields NaN, weekend/holiday classifies NaN as neither, no-reminder
  // updates can succeed → would have emitted "32/13/2026" on the wire.
  it('invalid month (13) → null', () => {
    expect(buildUpdateCard('P20.6', { due_date: '2026-13-04' })).toBeNull();
  });

  it('invalid day (32) → null', () => {
    expect(buildUpdateCard('P20.6', { due_date: '2026-05-32' })).toBeNull();
  });

  it('zero month → null', () => {
    expect(buildUpdateCard('P20.6', { due_date: '2026-00-10' })).toBeNull();
  });

  it('zero day → null', () => {
    expect(buildUpdateCard('P20.6', { due_date: '2026-05-00' })).toBeNull();
  });

  it('Feb 29 on non-leap year (2026) → null', () => {
    expect(buildUpdateCard('P20.6', { due_date: '2026-02-29' })).toBeNull();
  });

  it('Feb 29 on leap year (2024) → emits card (real date)', () => {
    expect(buildUpdateCard('P20.6', { due_date: '2024-02-29' })).toBe(
      '✅ *P20.6* atualizada\n━━━━━━━━━━━━━━\n\n• ⏰ Prazo definido: 29/02/2024',
    );
  });

  it('empty updates → null', () => {
    expect(buildUpdateCard('P11.15', {})).toBeNull();
  });

  it('missing task_id → null', () => {
    expect(buildUpdateCard('', { title: 'x' })).toBeNull();
  });
});

function updateResult(over: Record<string, unknown> = {}) {
  return {
    success: true,
    task_id: 'P11.15',
    title: TURN2_TITLE,
    changes: [`Título alterado para "${TURN2_TITLE}"`],
    ...over,
  };
}

describe('addUpdateFormattedResult — wires buildUpdateCard onto api_update_task', () => {
  it('success + supported updates → result.formatted = byte-exact v1 card', () => {
    const out = addUpdateFormattedResult(updateResult() as never, { title: TURN2_TITLE });
    expect((out as { formatted?: string }).formatted).toBe(EXACT_TURN2);
  });

  it('failure → unchanged (no card)', () => {
    const out = addUpdateFormattedResult(
      updateResult({ success: false }) as never,
      { title: TURN2_TITLE },
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('preserves an already-set formatted (no double-format)', () => {
    const out = addUpdateFormattedResult(
      updateResult({ formatted: 'pre' }) as never,
      { title: TURN2_TITLE },
    );
    expect((out as { formatted?: string }).formatted).toBe('pre');
  });

  it('out-of-scope updates → unchanged (no card, no fabrication)', () => {
    const out = addUpdateFormattedResult(
      updateResult() as never,
      { priority: 'high' },
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });

  it('missing task_id on result → unchanged (defensive)', () => {
    const out = addUpdateFormattedResult(
      updateResult({ task_id: undefined }) as never,
      { title: 'x' },
    );
    expect((out as { formatted?: string }).formatted).toBeUndefined();
  });
});
