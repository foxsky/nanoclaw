import { afterEach, describe, expect, it } from 'bun:test';

import { addReassignFormattedResult } from './taskflow-api-mutate.ts';
import { buildReassignCard, buildReassignInfo, buildReassignLookup } from './reassign-card.ts';
import { setVerbatimIds } from './taskflow-helpers.ts';
import { formatReassignReply } from '../poll-loop.ts';
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

// Phase-3 follow-up (Turn-37 richness gap): v1's reassign confirmation was
// LLM-composed (no deterministic source), so this is NOT a byte-port — it's a
// v2-COHERENT enrichment reusing v2's own create/update card vocabulary (SEP,
// 📁/📋 parent tree, ⏰ Prazo dd/mm/yyyy) + the canonical assignee name. Rich
// form only when a single task has a resolvable parent; everything else keeps
// the existing short/multi form (no fabrication for shapes without a parent).
describe('buildReassignCard — v2-coherent rich card (pure fn)', () => {
  it('single task with parent + due_date → rich card (v2 conventions)', () => {
    expect(
      buildReassignCard({
        id: 'P22.1',
        title: 'Agendar a coleta de dados',
        parentId: 'P22',
        parentTitle: 'Pesquisa TIC Governo 2025',
        dueDate: '2026-04-30',
        assignee: 'Mariany Borges',
      }),
    ).toBe(
      [
        '✅ *P22.1* reatribuída',
        '━━━━━━━━━━━━━━',
        '',
        '📁 *P22* — Pesquisa TIC Governo 2025',
        '   📋 *P22.1* — Agendar a coleta de dados',
        '',
        '👤 *Para:* Mariany Borges',
        '⏰ Prazo: 30/04/2026',
      ].join('\n'),
    );
  });

  it('omits the Prazo line when there is no due_date', () => {
    expect(
      buildReassignCard({
        id: 'P9.3',
        title: 'Revisar minuta',
        parentId: 'P9',
        parentTitle: 'Operação',
        assignee: 'Lucas',
      }),
    ).toBe('✅ *P9.3* reatribuída\n━━━━━━━━━━━━━━\n\n📁 *P9* — Operação\n   📋 *P9.3* — Revisar minuta\n\n👤 *Para:* Lucas');
  });

  it('returns null when there is no parent AND no from-assignee (→ short form)', () => {
    expect(buildReassignCard({ id: 'T1', title: 'Top-level task', assignee: 'Ana' })).toBeNull();
  });

  it('no parent but a known from-assignee → De/Para format (corpus: laizys#2)', () => {
    expect(
      buildReassignCard({ id: 'T47', title: 'Top-level task', assignee: 'Maura', fromAssignee: 'Laizys' }),
    ).toBe('✅ *T47* reatribuída\n━━━━━━━━━━━━━━\n\n👤 *De:* Laizys\n👤 *Para:* Maura');
  });

  it('parent present but title unresolvable + from → null, NOT De/Para (Codex gate)', () => {
    expect(
      buildReassignCard({ id: 'P1.2', title: 't', parentId: 'P1', parentTitle: null, assignee: 'A', fromAssignee: 'B' }),
    ).toBeNull();
  });

  it('parent + from-assignee → parent-tree format wins (De is for no-parent only)', () => {
    expect(
      buildReassignCard({
        id: 'P22.1',
        title: 'Agendar a coleta de dados',
        parentId: 'P22',
        parentTitle: 'Pesquisa TIC Governo 2025',
        assignee: 'Mariany Borges',
        fromAssignee: 'Rodrigo Lima',
      }),
    ).toBe(
      '✅ *P22.1* reatribuída\n━━━━━━━━━━━━━━\n\n📁 *P22* — Pesquisa TIC Governo 2025\n   📋 *P22.1* — Agendar a coleta de dados\n\n👤 *Para:* Mariany Borges',
    );
  });

  it('omits a malformed due_date rather than emitting garbage', () => {
    expect(
      buildReassignCard({
        id: 'P1.1', title: 't', parentId: 'P1', parentTitle: 'Proj', dueDate: 'not-a-date', assignee: 'Bob',
      }),
    ).toBe('✅ *P1.1* reatribuída\n━━━━━━━━━━━━━━\n\n📁 *P1* — Proj\n   📋 *P1.1* — t\n\n👤 *Para:* Bob');
  });
});

// addReassignFormattedResult now consumes a resolved `info` (the same
// ReassignTaskInfo both emitters build via buildReassignInfo) — NOT a lazy
// lookup fn. Moving the lookup OUT of the formatter is the BLOCKER fix: a
// post-commit lookup throw can no longer escape into api_reassign's catch and
// report success:false on an already-committed mutation.
describe('addReassignFormattedResult — rich card via resolved info', () => {
  it('single task with a resolvable parent → rich card', () => {
    const out = addReassignFormattedResult(
      { success: true, tasks_affected: [{ task_id: 'P22.1', title: 'Agendar a coleta de dados', was_linked: false }] } as ReassignResult,
      'Mariany Borges',
      { parent_task_id: 'P22', parent_task_title: 'Pesquisa TIC Governo 2025', due_date: '2026-04-30' },
    );
    expect(out.formatted).toBe(
      '✅ *P22.1* reatribuída\n━━━━━━━━━━━━━━\n\n📁 *P22* — Pesquisa TIC Governo 2025\n   📋 *P22.1* — Agendar a coleta de dados\n\n👤 *Para:* Mariany Borges\n⏰ Prazo: 30/04/2026',
    );
  });

  it('single task with no resolvable parent and no from → falls back to the short form', () => {
    const out = addReassignFormattedResult(
      { success: true, tasks_affected: [{ task_id: 'T9', title: 'Top task', was_linked: false }] } as ReassignResult,
      'Ana',
      null,
    );
    expect(out.formatted).toBe('✅ *T9* — Top task\n\nReatribuída para Ana.');
  });

  // R2 parity: the MCP path (api_reassign) must render a no-parent reassign the
  // SAME way the poll-loop deterministic path does — De/Para, not the short form
  // — so the same logical event doesn't render two ways depending on the emitter.
  it('single task, no parent but a known from-assignee → De/Para card (path parity with poll-loop)', () => {
    const out = addReassignFormattedResult(
      { success: true, tasks_affected: [{ task_id: 'T47', title: 'Top task', was_linked: false }] } as ReassignResult,
      'Maura',
      { parent_task_id: null, parent_task_title: null, due_date: null, from_assignee: 'Laizys' },
    );
    expect(out.formatted).toBe('✅ *T47* reatribuída\n━━━━━━━━━━━━━━\n\n👤 *De:* Laizys\n👤 *Para:* Maura');
  });

  it('multi-task reassign keeps the short multi form even with info', () => {
    const out = addReassignFormattedResult(
      {
        success: true,
        tasks_affected: [
          { task_id: 'P22.1', title: 'A', was_linked: false },
          { task_id: 'P22.2', title: 'B', was_linked: false },
        ],
      } as ReassignResult,
      'Mariany Borges',
      { parent_task_id: 'P22', parent_task_title: 'Proj', due_date: null },
    );
    expect(out.formatted).toBe('✅ 2 tarefas reatribuídas para Mariany Borges:\n\n• *P22.1* — A\n• *P22.2* — B');
  });
});

// buildReassignInfo centralizes what BOTH emitters need after a committed
// reassign: the subprocess gate, the post-commit parent/due lookup, and the
// from_assignee merge — all fail-soft. The mutation has already committed, so a
// lookup throw must degrade to the short/De-Para card, never bubble up.
describe('buildReassignInfo — shared, fail-soft post-commit resolver', () => {
  const fakeEngine = {
    getTask: (id: string) =>
      id === 'P22.1'
        ? { parent_task_id: 'P22', due_date: '2026-04-30' }
        : id === 'P22'
          ? { title: 'Pesquisa TIC Governo 2025' }
          : id === 'T1'
            ? { parent_task_id: null, due_date: null }
            : null,
  };
  afterEach(() => setVerbatimIds(false));

  it('in-session: merges the resolved parent/due with the pre-captured from-assignee', () => {
    setVerbatimIds(false);
    expect(buildReassignInfo(fakeEngine, 'P22.1', 'Rodrigo Lima')).toEqual({
      parent_task_id: 'P22',
      parent_task_title: 'Pesquisa TIC Governo 2025',
      due_date: '2026-04-30',
      from_assignee: 'Rodrigo Lima',
    });
  });

  it('in-session top-level task: carries from_assignee so the caller can render De/Para', () => {
    setVerbatimIds(false);
    expect(buildReassignInfo(fakeEngine, 'T1', 'Laizys')?.from_assignee).toBe('Laizys');
  });

  it('tf-mcontrol subprocess: returns null even with a from-assignee (exact prior short form)', () => {
    setVerbatimIds(true);
    expect(buildReassignInfo(fakeEngine, 'P22.1', 'Rodrigo Lima')).toBeNull();
  });

  it('lookup throws (post-commit) → fail-soft to the from-assignee, never throws (BLOCKER)', () => {
    setVerbatimIds(false);
    const throwingEngine = {
      getTask: () => {
        throw new Error('db gone');
      },
    };
    expect(buildReassignInfo(throwingEngine, 'P1', 'Rodrigo')).toEqual({ from_assignee: 'Rodrigo' });
  });

  it('lookup throws with no from-assignee → null (short form), never throws', () => {
    setVerbatimIds(false);
    const throwingEngine = {
      getTask: () => {
        throw new Error('db gone');
      },
    };
    expect(buildReassignInfo(throwingEngine, 'P1')).toBeNull();
  });
});

// Codex hot-path gate: api_reassign is allowlisted in the tf-mcontrol FastAPI
// subprocess, so the rich-card lookup MUST be gated off there to keep the exact
// prior short-form API response. buildReassignLookup encodes that gate.
describe('buildReassignLookup — tf-mcontrol subprocess gate', () => {
  const fakeEngine = {
    getTask: (id: string) =>
      id === 'P22.1'
        ? { parent_task_id: 'P22', due_date: '2026-04-30' }
        : id === 'P22'
          ? { title: 'Pesquisa TIC Governo 2025' }
          : null,
  };
  afterEach(() => setVerbatimIds(false));

  it('returns undefined in the tf-mcontrol subprocess (→ caller keeps the short form)', () => {
    setVerbatimIds(true);
    expect(buildReassignLookup(fakeEngine)).toBeUndefined();
  });

  it('in-session: resolves parent_task_title + due_date for the rich card', () => {
    setVerbatimIds(false);
    const lookup = buildReassignLookup(fakeEngine);
    expect(lookup).toBeDefined();
    expect(lookup!('P22.1')).toEqual({
      parent_task_id: 'P22',
      parent_task_title: 'Pesquisa TIC Governo 2025',
      due_date: '2026-04-30',
    });
  });

  it('in-session: null when the task is gone (→ short-form fallback)', () => {
    setVerbatimIds(false);
    expect(buildReassignLookup(fakeEngine)!('GONE')).toBeNull();
  });
});

// Phase-3 Turn-37 ROOT-CAUSE fix: the card users actually see for "atribuir <id>
// para <X>" is emitted by the DETERMINISTIC poll-loop handler via
// formatReassignReply (poll-loop.ts), NOT the MCP addReassignFormattedResult.
// So the rich card must be wired HERE too. Single-task + resolvable parent → rich
// (buildReassignCard); everything else unchanged.
describe('formatReassignReply — rich card via parent info (poll-loop deterministic path)', () => {
  const single = {
    success: true,
    tasks_affected: [{ task_id: 'P22.1', title: 'Agendar a coleta de dados', was_linked: false }],
  } as ReassignResult;

  it('single task WITH parent info → rich card', () => {
    expect(
      formatReassignReply(single, 'P22.1', 'Mariany Borges', {
        parent_task_id: 'P22',
        parent_task_title: 'Pesquisa TIC Governo 2025',
        due_date: '2026-04-30',
      }),
    ).toBe(
      '✅ *P22.1* reatribuída\n━━━━━━━━━━━━━━\n\n📁 *P22* — Pesquisa TIC Governo 2025\n   📋 *P22.1* — Agendar a coleta de dados\n\n👤 *Para:* Mariany Borges\n⏰ Prazo: 30/04/2026',
    );
  });

  it('single task with NO parent info → short card (prior behavior)', () => {
    expect(formatReassignReply(single, 'P22.1', 'Mariany Borges')).toBe(
      '✅ *P22.1* — Agendar a coleta de dados\n\nReatribuída para Mariany Borges.',
    );
  });

  it('single task with info but no resolvable parent → short card', () => {
    expect(
      formatReassignReply(single, 'P22.1', 'Mariany Borges', { parent_task_id: null, parent_task_title: null, due_date: null }),
    ).toBe('✅ *P22.1* — Agendar a coleta de dados\n\nReatribuída para Mariany Borges.');
  });

  it('single task, no parent but a from-assignee → De/Para card', () => {
    expect(
      formatReassignReply(
        { success: true, tasks_affected: [{ task_id: 'T47', title: 'Top task', was_linked: false }] } as ReassignResult,
        'T47',
        'Maura',
        { parent_task_id: null, parent_task_title: null, due_date: null, from_assignee: 'Laizys' },
      ),
    ).toBe('✅ *T47* reatribuída\n━━━━━━━━━━━━━━\n\n👤 *De:* Laizys\n👤 *Para:* Maura');
  });

  it('engine-preset formatted → ✅-prefixed (unchanged)', () => {
    expect(
      formatReassignReply(
        { success: true, formatted: 'X', tasks_affected: [{ task_id: 'T', title: 't', was_linked: false }] } as ReassignResult,
        'T',
        'Ana',
        { parent_task_id: 'P', parent_task_title: 'Proj', due_date: null },
      ),
    ).toBe('✅ X');
  });

  it('multi-task → multi short form (unchanged)', () => {
    expect(
      formatReassignReply(
        {
          success: true,
          tasks_affected: [
            { task_id: 'A', title: 'a', was_linked: false },
            { task_id: 'B', title: 'b', was_linked: false },
          ],
        } as ReassignResult,
        'A',
        'Ana',
        { parent_task_id: 'P', parent_task_title: 'Proj', due_date: null },
      ),
    ).toBe('✅ 2 tarefas reatribuídas para Ana:\n\n• *A* — a\n• *B* — b');
  });

  it('zero tasks_affected → simple fallback (unchanged)', () => {
    expect(formatReassignReply({ success: true, tasks_affected: [] } as ReassignResult, 'P5', 'Ana')).toBe(
      '✅ *P5* reatribuída para Ana.',
    );
  });
});
