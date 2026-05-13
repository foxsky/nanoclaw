import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifyRawSqliteTurn,
  compareSemanticTurn,
  inferPhase3Metadata,
  restoreDbSnapshot,
  summarizeSemanticBehavior,
  taskflowDbPath,
  withTaskflowDbSnapshot,
  type Phase3TurnResult,
} from './phase3-support.js';

describe('Phase 3 metadata inference', () => {
  it('defaults known missing-context turns to chain mode', () => {
    const meta = inferPhase3Metadata({
      jsonl: 'session.jsonl',
      turn_index: 12,
    }, 16);

    expect(meta.context_mode).toBe('chain');
    expect(meta.prior_turn_depth).toBe(1);
    expect(meta.source_jsonl).toBe('session.jsonl');
    expect(meta.source_turn_index).toBe(12);
  });

  it('keeps ordinary turns fresh unless metadata says otherwise', () => {
    const meta = inferPhase3Metadata({
      jsonl: 'session.jsonl',
      turn_index: 4,
    }, 9);

    expect(meta.context_mode).toBe('fresh');
    expect(meta.prior_turn_depth).toBeUndefined();
  });

  it('honors explicit metadata overrides', () => {
    const meta = inferPhase3Metadata({}, 22, {
      turn_index: 22,
      context_mode: 'chain',
      prior_turn_depth: 3,
      source_jsonl: 'explicit.jsonl',
      source_turn_index: 99,
    });

    expect(meta.prior_turn_depth).toBe(3);
    expect(meta.source_jsonl).toBe('explicit.jsonl');
    expect(meta.source_turn_index).toBe(99);
  });
});

describe('Phase 3 DB snapshot helpers', () => {
  it('restores a requested snapshot into taskflow.db', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-db-'));
    fs.mkdirSync(path.join(tmp, 'taskflow'), { recursive: true });
    const live = taskflowDbPath(tmp);
    const snapshot = path.join(tmp, 'snapshot.db');
    fs.writeFileSync(live, 'live');
    fs.writeFileSync(snapshot, 'snapshot');

    expect(restoreDbSnapshot(snapshot, tmp)).toBe('restored');
    expect(fs.readFileSync(live, 'utf8')).toBe('snapshot');
  });

  it('reports missing snapshots without mutating live DB', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-db-'));
    fs.mkdirSync(path.join(tmp, 'taskflow'), { recursive: true });
    const live = taskflowDbPath(tmp);
    fs.writeFileSync(live, 'live');

    expect(restoreDbSnapshot(path.join(tmp, 'missing.db'), tmp)).toBe('missing');
    expect(fs.readFileSync(live, 'utf8')).toBe('live');
  });

  it('reports missing when a state snapshot is required but no path is available', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-db-'));
    fs.mkdirSync(path.join(tmp, 'taskflow'), { recursive: true });
    const live = taskflowDbPath(tmp);
    fs.writeFileSync(live, 'live');

    expect(restoreDbSnapshot(undefined, tmp, true)).toBe('missing');
    expect(fs.readFileSync(live, 'utf8')).toBe('live');
  });

  it('restores the original live DB after a callback mutates it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-db-'));
    fs.mkdirSync(path.join(tmp, 'taskflow'), { recursive: true });
    const live = taskflowDbPath(tmp);
    fs.writeFileSync(live, 'before');

    const result = withTaskflowDbSnapshot(tmp, () => {
      fs.writeFileSync(live, 'during');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(fs.readFileSync(live, 'utf8')).toBe('before');
  });
});

describe('Phase 3 semantic comparison', () => {
  it('classifies send_message as forward with recipient', () => {
    const summary = summarizeSemanticBehavior([
      {
        name: 'mcp__nanoclaw__send_message',
        input: { destination: 'Ana Beatriz', text: 'Detalhes de M1 e M2' },
      },
    ]);

    expect(summary.action).toBe('forward');
    expect(summary.recipient).toBe('Ana Beatriz');
  });

  it('extracts v2 send_message recipient from the to field', () => {
    const summary = summarizeSemanticBehavior([
      {
        name: 'mcp__nanoclaw__send_message',
        input: { to: 'seci-taskflow', text: 'Detalhes de M1 e M2' },
      },
    ]);

    expect(summary.action).toBe('forward');
    expect(summary.recipient).toBe('seci-taskflow');
  });


  it('matches explicit expected behavior by action, task ID, mutation, and recipient', () => {
    const turn: Phase3TurnResult = {
      turn_index: 99,
      text: 'atribuir P11.23 para Rodrigo',
      v1: { tools: [] },
      v2: {
        tools: [{
          name: 'mcp__nanoclaw__api_reassign',
          input: { task_id: 'P11.23', target_person: 'Rodrigo' },
        }],
        outbound: [{ kind: 'chat', content: '{"text":"Atualizado."}' }],
      },
      phase3: {
        metadata: {
          turn_index: 99,
          context_mode: 'fresh',
          expected_behavior: {
            action: 'mutate',
            task_ids: ['P11.23'],
            mutation_types: ['reassign'],
          },
        },
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('match');
    expect(comparison.matches).toEqual({
      action: true,
      task_ids: true,
      mutation_types: true,
      recipient: true,
      outbound_intent: true,
    });
  });

  it('matches registered destination aliases for raw v1 JID recipients', () => {
    const turn: Phase3TurnResult = {
      turn_index: 29,
      text: 'encaminhar M1 e M2 para Ana Beatriz',
      v1: { tools: [] },
      v2: {
        tools: [{
          name: 'mcp__nanoclaw__send_message',
          input: { to: 'Ana Beatriz', text: 'Detalhes de M1 e M2' },
        }],
        outbound: [],
      },
      phase3: {
        metadata: {
          turn_index: 29,
          context_mode: 'fresh',
          expected_behavior: {
            action: 'forward',
            task_ids: ['M1', 'M2'],
            recipient: '120363426975449622@g.us',
            recipient_aliases: ['Ana Beatriz'],
          },
        },
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('match');
    expect(comparison.matches.recipient).toBe(true);
    expect(comparison.expected.recipient).toBe('120363426975449622@g.us');
    expect(comparison.actual.recipient).toBe('Ana Beatriz');
  });

  it('allows annotated forward turns to include harmless extra task IDs', () => {
    const turn: Phase3TurnResult = {
      turn_index: 29,
      text: 'encaminhar M1 e M2 para Ana Beatriz',
      v1: { tools: [] },
      v2: {
        tools: [
          { name: 'mcp__nanoclaw__api_query', input: { task_id: 'M1' } },
          { name: 'mcp__nanoclaw__api_query', input: { task_id: 'M2' } },
          { name: 'mcp__nanoclaw__send_message', input: { to: 'Ana Beatriz', text: 'M1, M2, projeto P11' } },
        ],
        outbound: [],
      },
      phase3: {
        metadata: {
          turn_index: 29,
          context_mode: 'fresh',
          expected_behavior: {
            action: 'forward',
            task_ids: ['M1', 'M2'],
            allow_extra_task_ids: true,
            recipient: '120363426975449622@g.us',
            recipient_aliases: ['Ana Beatriz'],
          },
        },
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('match');
    expect(comparison.actual.task_ids).toEqual(['M1', 'M2', 'P11']);
  });

  it('normalizes v1 and v2 mutation tool names to the same semantic type', () => {
    const v1 = summarizeSemanticBehavior([
      { name: 'taskflow_move', input: { task_id: 'P11.16' } },
    ]);
    const v2 = summarizeSemanticBehavior([
      { name: 'mcp__nanoclaw__api_move', input: { task_id: 'P11.16' } },
    ]);

    expect(v1.mutation_types).toEqual(['move']);
    expect(v2.mutation_types).toEqual(['move']);
  });

  it('marks unavailable state snapshots as inconclusive instead of a v2 bug', () => {
    const turn: Phase3TurnResult = {
      turn_index: 28,
      text: 'adicionar Ana Beatriz em M2',
      v1: { tools: [] },
      v2: { tools: [], outbound: [] },
      phase3: {
        db_snapshot_status: 'missing',
        metadata: {
          turn_index: 28,
          context_mode: 'fresh',
          state_snapshot: '/missing/taskflow.db',
          expected_behavior: { action: 'mutate', task_ids: ['M2'] },
        },
      },
    };

    expect(compareSemanticTurn(turn).classification.kind).toBe('state_snapshot_missing');
  });

  it('surfaces the cross-board sqlite lookup pattern for the operator', () => {
    const decision = classifyRawSqliteTurn({
      turn_index: 17,
      text: 't43',
      v1: { tools: [{ name: 'mcp__sqlite__read_query', input: {} }] },
      v2: { tools: [{ name: 'mcp__nanoclaw__api_query', input: { task_id: 'T43' } }], outbound: [] },
    });

    // The classification kind has evolved alongside the engine: once
    // `find_task_in_organization` shipped, the T43 case routes to
    // `documented_tool_surface_change` (capability exists, awaiting
    // revalidation) rather than `missing_api_capability` (no capability).
    // Accept either — the load-bearing assertion is that the operator sees
    // a recommendation referencing the v1→v2 tool-surface migration.
    expect(['missing_api_capability', 'documented_tool_surface_change'])
      .toContain(decision?.classification);
    expect(decision?.recommendation).toMatch(/api_\*|cross-board|MCP/);
  });

  it('marks raw sqlite parity as covered when metadata maps it to first-class MCP behavior', () => {
    const decision = classifyRawSqliteTurn({
      turn_index: 23,
      text: 'A tarefa foi concluida não foi para revisão?',
      v1: {
        tools: [
          { name: 'mcp__sqlite__write_query', input: {} },
          { name: 'mcp__sqlite__read_query', input: {} },
          { name: 'taskflow_move', input: { task_id: 'P6.7', action: 'reopen' } },
        ],
      },
      v2: {
        tools: [
          { name: 'mcp__nanoclaw__api_update_task', input: { task_id: 'P6.7', updates: { requires_close_approval: true } } },
          { name: 'mcp__nanoclaw__api_move', input: { task_id: 'P6.7', action: 'reopen' } },
        ],
        outbound: [{ kind: 'chat', content: '{"text":"P6.7 reaberta e aprovação obrigatória ativada."}' }],
      },
      phase3: {
        metadata: {
          turn_index: 23,
          context_mode: 'chain',
          expected_behavior: {
            action: 'mutate',
            task_ids: ['P6.7'],
            mutation_types: ['move', 'update'],
            outbound_intent: 'informational',
          },
        },
      },
    });

    expect(decision?.classification).toBe('documented_tool_surface_change');
    expect(decision?.recommendation).toContain('Covered by first-class');
  });

  // Read tools + a trailing "Deseja...?" suggestion should still be classified
  // as a read (the substantive action), not as an ask. Otherwise turn 21 looks
  // divergent when v1 and v2 actually did the same read work — v1 just added a
  // follow-up CTA in its final response.
  it('prioritises read over ask when read tools were called', () => {
    const summary = summarizeSemanticBehavior(
      [{ name: 'mcp__nanoclaw__api_query', input: { query: 'task_history', task_id: 'P6.7' } }],
      [],
      'A P6.7 foi concluída diretamente. Deseja reabrir e exigir aprovação?',
    );
    expect(summary.action).toBe('read');
  });

  // No tools + asks pattern still resolves to ask. This guards against the
  // priority change above accidentally swallowing pure clarification turns.
  it('still classifies pure clarification turns as ask', () => {
    const summary = summarizeSemanticBehavior([], [], 'Qual tarefa você quer mover?');
    expect(summary.action).toBe('ask');
  });
});

describe('Phase 3 state-drift classifications', () => {
  // Turn 24 / 26: v1 historical task IDs (T84/T85) differ from v2's
  // freshly-allocated ID (T96) because the per-turn DB snapshot is missing
  // and the allocator hands out the next free slot. Treat as state drift,
  // not a v2 product bug — the tool sequence and mutation types match.
  it('classifies create+admin task-id-only mismatch as state allocation drift', () => {
    const turn: Phase3TurnResult = {
      turn_index: 24,
      text: 'p11 acrescentar tarefa Extrato de contas da PMT',
      v1: {
        tools: [
          { name: 'mcp__nanoclaw__api_create_task', input: { title: 'Extrato', type: 'simple' } },
          { name: 'mcp__nanoclaw__api_admin', input: { action: 'reparent_task', task_id: 'T84', target_parent_id: 'P11' } },
        ],
        final_response: '✅ Etapa adicionada. T84 — Extrato de contas...',
      },
      v2: {
        tools: [
          { name: 'mcp__nanoclaw__api_create_task', input: { title: 'Extrato', type: 'simple' } },
          { name: 'mcp__nanoclaw__api_admin', input: { action: 'reparent_task', task_id: 'T96', target_parent_id: 'P11' } },
        ],
        outbound: [{ kind: 'chat', content: '{"text":"✅ Tarefa adicionada T96"}' }],
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('state_allocation_drift');
    expect(comparison.matches.action).toBe(true);
    expect(comparison.matches.mutation_types).toBe(true);
    expect(comparison.matches.task_ids).toBe(false);
  });

  // state_allocation_drift only fires when this turn actually allocated a
  // task (mutation_types includes "create"). Otherwise a reassign+update
  // with task-id mismatch could be excused as "drift" when the agent in
  // fact mutated the wrong existing task.
  it('does not flag reassign-only task-id mismatch as allocation drift', () => {
    const turn: Phase3TurnResult = {
      turn_index: 99,
      text: 'atribuir tarefa para Rodrigo',
      v1: {
        tools: [
          { name: 'mcp__nanoclaw__api_reassign', input: { task_id: 'T84', target_person: 'Rodrigo' } },
          { name: 'mcp__nanoclaw__api_update_task', input: { task_id: 'T84', updates: { due_date: '2026-04-20' } } },
        ],
      },
      v2: {
        tools: [
          { name: 'mcp__nanoclaw__api_reassign', input: { task_id: 'T96', target_person: 'Rodrigo' } },
          { name: 'mcp__nanoclaw__api_update_simple_task', input: { task_id: 'T96', due_date: '2026-04-20' } },
        ],
        outbound: [],
      },
    };
    // No create in mutation_types → cannot conclude this is allocator drift
    // (it might be: v2 mutated the wrong existing task). Snapshot-gated
    // turns get state_snapshot_missing; this one (no snapshot metadata)
    // must surface as a real divergence so a human triages.
    expect(compareSemanticTurn(turn).classification.kind).not.toBe('state_allocation_drift');
  });

  // Turn 25 / 27: subsequent reassign+update referencing the same fresh task
  // ID (T96) created earlier in the run. Same drift class — but ONLY when
  // the actual task IDs all look like fresh sequence allocations (T### with
  // a numerically larger suffix than v1) and the other dimensions match.
  it('does not flag substantive task-id mismatches as state drift', () => {
    const turn: Phase3TurnResult = {
      turn_index: 99,
      text: 'mover P11.16 para concluído',
      v1: {
        tools: [{ name: 'mcp__nanoclaw__api_move', input: { task_id: 'P11.16' } }],
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_move', input: { task_id: 'P11.17' } }],
        outbound: [],
      },
    };

    const comparison = compareSemanticTurn(turn);
    // P11.16 → P11.17 is not a freshly-allocated T### task — must remain a
    // real divergence so we don't paper over wrong-target mutations.
    expect(comparison.classification.kind).toBe('real_divergence');
  });
});

describe('Phase 3 v1-bug annotation', () => {
  // The auditor's self-correction pair detector found one canonical v1 bug
  // in the seci corpus window: M1 / giovanni / 2026-04-14 — bot resolved
  // "quinta-feira" to 2026-04-17 (Friday), user manually corrected to
  // 2026-04-16 (Thursday) 32 minutes later. Turn 28 is the bot's mistake
  // recorded as if it were the correct behavior. The annotation surfaces
  // it above `match` so v2 reproducing the bug doesn't silently pass and
  // v2 correcting the bug doesn't look like a regression.
  it('surfaces v1_bug-flagged turns above match', () => {
    const turn: Phase3TurnResult = {
      turn_index: 28,
      text: 'alterar M1 para quinta-feira 11h',
      v1: {
        tools: [
          {
            name: 'mcp__nanoclaw__taskflow_update',
            input: { task_id: 'M1', updates: { scheduled_at: '2026-04-17T11:00:00' } },
          },
        ],
      },
      v2: {
        tools: [
          {
            name: 'mcp__nanoclaw__api_update_simple_task',
            input: { task_id: 'M1', scheduled_at: '2026-04-17T11:00:00' },
          },
        ],
        outbound: [{ kind: 'chat', content: '{"text":"M1 reagendada para 17/04 às 11:00."}' }],
      },
      phase3: {
        metadata: {
          turn_index: 28,
          context_mode: 'fresh',
          v1_bug: {
            description: 'weekday resolution: "quinta-feira" → 2026-04-17 (Friday); should be 2026-04-16 (Thursday)',
            detected_by: 'auditor_self_correction',
            corrected_at: '2026-04-14T11:36:29.528Z',
            expected_correction: 'scheduled_at: 2026-04-16T11:00:00',
          },
        },
      },
    };
    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('v1_bug_flagged');
  });

  it('does not flag turns without the v1_bug annotation', () => {
    const turn: Phase3TurnResult = {
      turn_index: 10,
      text: 'atribuir P11.23',
      v1: {
        tools: [{ name: 'mcp__nanoclaw__taskflow_reassign', input: { task_id: 'P11.23', target_person: 'Rodrigo' } }],
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_reassign', input: { task_id: 'P11.23', target_person: 'Rodrigo' } }],
        outbound: [{ kind: 'chat', content: '{"text":"Reatribuída."}' }],
      },
    };
    expect(compareSemanticTurn(turn).classification.kind).not.toBe('v1_bug_flagged');
  });
});

describe('Phase 3 outbound-intent gating', () => {
  // Turn 17: v1 displayed T43 details (informational); v2 ran api_query and
  // replied "Não encontrei T43" (not_found_or_unclear / asks_user). action,
  // task_ids, mutation_types, recipient all match — but the substance
  // diverges. Before this gate, the turn classified as `match`. It must
  // not.
  it('drops match when v1 was informational and v2 was not-found/asks_user', () => {
    const turn: Phase3TurnResult = {
      turn_index: 17,
      text: 't43',
      v1: {
        tools: [{ name: 'mcp__sqlite__read_query', input: { query: "SELECT * FROM tasks WHERE id = 'T43'" } }],
        final_response: '📋 *T43* — Cobrar ofício. Responsável: Laizys.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_query', input: { query: 'task_details', task_id: 'T43' } }],
        outbound: [{ kind: 'chat', content: '{"text":"Não encontrei nenhuma tarefa com o ID *T43*. Pode verificar se o ID está correto?"}' }],
      },
    };

    const comparison = compareSemanticTurn(turn);
    // v1 used raw sqlite, so the comparator routes through the documented
    // tool-surface change branch — but it must NOT say match.
    expect(comparison.classification.kind).not.toBe('match');
    expect(comparison.classification.kind).toBe('documented_tool_surface_change');
  });

  // A v1 informational + v2 informational reply with the same task focus
  // must remain match — the outbound-intent gate only fires when the
  // substance actually diverges.
  it('keeps match when v1 and v2 both produce informational read replies', () => {
    const turn: Phase3TurnResult = {
      turn_index: 7,
      text: 'detalhes P15.7',
      v1: {
        tools: [{ name: 'mcp__nanoclaw__api_query', input: { query: 'task_details', task_id: 'P15.7' } }],
        final_response: 'P15.7 — Ampliar institucionalização. Responsável: Alexandre.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_query', input: { query: 'task_details', task_id: 'P15.7' } }],
        outbound: [{ kind: 'chat', content: '{"text":"📋 *P15.7* — Ampliar institucionalização da governança. Responsável: Alexandre."}' }],
      },
    };
    expect(compareSemanticTurn(turn).classification.kind).toBe('match');
  });
});

describe('Phase 3 destination-registration classifications', () => {
  // Turn 16 / 29: v1 forwarded to a raw WhatsApp JID via target_chat_jid;
  // v2's send_message requires a named destination from agent_destinations.
  // Prod has these wired but the Phase 3 test seed does not — so v2
  // correctly declines the forward. Distinguish from "v2 lost the forward".
  it('classifies missing-named-destination forwards as destination registration gap', () => {
    const turn: Phase3TurnResult = {
      turn_index: 16,
      text: 'sim',
      v1: {
        tools: [{
          name: 'send_message',
          input: { target_chat_jid: '120363425774136187@g.us', text: '📝 Nota T43' },
        }],
      },
      v2: {
        tools: [],
        outbound: [{ kind: 'chat', content: '{"text":"👍"}' }],
      },
      phase3: {
        metadata: {
          turn_index: 16,
          context_mode: 'chain',
          expected_behavior: {
            action: 'forward',
            task_ids: ['T43'],
            recipient: '120363425774136187@g.us',
          },
        },
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('destination_registration_gap');
  });

  // destination_registration_gap must not excuse a v2 run that ALSO mutated
  // state. A forward+mutation hybrid (e.g. v2 wrote to the wrong task and
  // tried to forward) must not get covered by the registration-gap escape
  // hatch — the mutation is itself a real divergence.
  it('does not classify forward attempts that also mutated state as a gap', () => {
    const turn: Phase3TurnResult = {
      turn_index: 99,
      text: 'encaminhar T1 para Rafael',
      v1: {
        tools: [{
          name: 'send_message',
          input: { target_chat_jid: '120363400000000000@g.us', text: 'forward' },
        }],
      },
      v2: {
        tools: [
          { name: 'mcp__nanoclaw__api_update_simple_task', input: { task_id: 'T1', notes: 'oops' } },
          { name: 'mcp__nanoclaw__send_message', input: { to: 'seci-taskflow', text: 'forward' } },
        ],
        outbound: [],
      },
      phase3: {
        metadata: {
          turn_index: 99,
          context_mode: 'fresh',
          expected_behavior: {
            action: 'forward',
            task_ids: ['T1'],
            recipient: '120363400000000000@g.us',
          },
        },
      },
    };
    // A real product bug: v2 mutated T1 unexpectedly. Must not be excused.
    expect(compareSemanticTurn(turn).classification.kind).not.toBe('destination_registration_gap');
  });

  // Turn 29: v2 produced a forward but to its own board name because no
  // named destination exists for Ana Beatriz's DM group. Same gap class —
  // recipient mismatched between an expected JID and an actual local
  // destination name.
  it('detects forward-with-wrong-destination as registration gap, not v2 bug', () => {
    const turn: Phase3TurnResult = {
      turn_index: 29,
      text: 'encaminhar M1 e M2 para Ana Beatriz',
      v1: {
        tools: [{
          name: 'send_message',
          input: { target_chat_jid: '120363426975449622@g.us', text: '📅 Reuniões M1/M2' },
        }],
      },
      v2: {
        tools: [
          { name: 'mcp__nanoclaw__api_query', input: { task_id: 'M1' } },
          { name: 'mcp__nanoclaw__api_query', input: { task_id: 'M2' } },
          { name: 'mcp__nanoclaw__send_message', input: { to: 'seci-taskflow', text: '📅 Reuniões M1/M2' } },
        ],
        outbound: [{ kind: 'chat', content: '{"text":"Detalhes encaminhados."}' }],
      },
      phase3: {
        metadata: {
          turn_index: 29,
          context_mode: 'fresh',
          expected_behavior: {
            action: 'forward',
            task_ids: ['M1', 'M2'],
            recipient: '120363426975449622@g.us',
          },
        },
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('destination_registration_gap');
  });
});
