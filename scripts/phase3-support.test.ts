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
      taskflow_board_id: 'board-asse-seci-taskflow',
    }, 9);

    expect(meta.context_mode).toBe('fresh');
    expect(meta.prior_turn_depth).toBeUndefined();
    expect(meta.taskflow_board_id).toBe('board-asse-seci-taskflow');
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

  it('can disable original-corpus default chain depths for generated corpuses', () => {
    const meta = inferPhase3Metadata({
      jsonl: 'candidate.jsonl',
      turn_index: 31,
    }, 16, undefined, { useDefaultChainDepths: false });

    expect(meta.context_mode).toBe('fresh');
    expect(meta.prior_turn_depth).toBeUndefined();
  });
});

describe('Phase 3 DB snapshot helpers', () => {
  it('restores a requested snapshot into taskflow.db', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-db-'));
    fs.mkdirSync(path.join(tmp, 'taskflow'), { recursive: true });
    const live = taskflowDbPath(tmp);
    const snapshot = path.join(tmp, 'snapshot.db');
    fs.writeFileSync(live, 'live');
    fs.writeFileSync(`${live}-wal`, 'stale wal');
    fs.writeFileSync(`${live}-shm`, 'stale shm');
    fs.writeFileSync(snapshot, 'snapshot');

    expect(restoreDbSnapshot(snapshot, tmp)).toBe('restored');
    expect(fs.readFileSync(live, 'utf8')).toBe('snapshot');
    expect(fs.existsSync(`${live}-wal`)).toBe(false);
    expect(fs.existsSync(`${live}-shm`)).toBe(false);
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
    fs.writeFileSync(`${live}-wal`, 'before wal');
    fs.writeFileSync(`${live}-shm`, 'before shm');

    const result = withTaskflowDbSnapshot(tmp, () => {
      fs.writeFileSync(live, 'during');
      fs.writeFileSync(`${live}-wal`, 'during wal');
      fs.rmSync(`${live}-shm`, { force: true });
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(fs.readFileSync(live, 'utf8')).toBe('before');
    expect(fs.readFileSync(`${live}-wal`, 'utf8')).toBe('before wal');
    expect(fs.readFileSync(`${live}-shm`, 'utf8')).toBe('before shm');
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

  it('treats send_message without a recipient as a same-chat reply', () => {
    const summary = summarizeSemanticBehavior([
      {
        name: 'send_message',
        input: { text: 'A tarefa T79 não existe neste board. Você consegue verificar o título?' },
      },
      {
        name: 'taskflow_query',
        input: { query: 'search', search_text: '79' },
      },
    ]);

    expect(summary.action).toBe('read');
    expect(summary.recipient).toBeNull();
    expect(summary.outbound_intent).toBe('not_found_or_unclear');
  });

  it('does not extract board refs across paragraph breaks', () => {
    const summary = summarizeSemanticBehavior(
      [],
      [],
      'A tarefa não existe neste board\n\nSe Rafael atribuiu essa tarefa, confirme o título.',
    );

    expect(summary.board_refs).toEqual([]);
  });

  it('extracts board refs from prefixed task ids', () => {
    const summary = summarizeSemanticBehavior(
      [],
      [{ kind: 'chat', content: JSON.stringify({ text: '📋 *SEC-T10* — SEI de homologação' }) }],
    );

    expect(summary.board_refs).toEqual(['sec']);
  });

  it('treats board/project section reports as informational despite completed-section labels', () => {
    const summary = summarizeSemanticBehavior(
      [],
      [],
      '📁 *P11* — Operação\n\n*Próximas Ações:*\n• *T14* — Fazer algo\n\n*✅ Concluídas:*\n• *T11* — Finalizada',
    );

    expect(summary.outbound_intent).toBe('informational');
  });

  it('classifies already-recorded informational replies before trailing CTAs', () => {
    const summary = summarizeSemanticBehavior(
      [],
      [{ kind: 'chat', content: JSON.stringify({ text: 'A T79 já foi atualizada com esses repositórios. Deseja adicionar algo diferente?' }) }],
    );

    expect(summary.action).toBe('no-op');
    expect(summary.outbound_intent).toBe('mutation_confirmation');
  });

  it('does not classify hypothetical created-elsewhere not-found text as mutation confirmation', () => {
    const summary = summarizeSemanticBehavior(
      [{ name: 'taskflow_query', input: { query: 'search', search_text: '79' } }],
      [],
      'A tarefa T79 não existe neste board. Ela pode ter sido criada em outro board. Você consegue verificar?',
    );

    expect(summary.action).toBe('read');
    expect(summary.outbound_intent).toBe('not_found_or_unclear');
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
      board_refs: true,
      recipient: true,
      outbound_intent: true,
    });
  });

  it('does not pass a read turn that timed out without the v1 visible reply', () => {
    const turn: Phase3TurnResult = {
      turn_index: 7,
      text: 'p15.7',
      v1: {
        tools: [{ name: 'taskflow_query', input: { query: 'task_details', task_id: 'P15.7' } }],
        final_response: 'P15.7 — Ampliar institucionalização. Responsável: Lucas.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_query', input: { query: 'task_details', task_id: 'P15.7' } }],
        outbound: [],
        settle_reason: 'timeout',
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.matches).toMatchObject({
      action: true,
      task_ids: true,
      mutation_types: true,
      recipient: true,
      outbound_intent: false,
    });
    expect(comparison.classification.kind).toBe('no_outbound_timeout');
  });

  it('does not pass a successful mutation that timed out before confirmation', () => {
    const turn: Phase3TurnResult = {
      turn_index: 19,
      text: 'concluir atividade P20.2',
      v1: {
        tools: [{ name: 'taskflow_move', input: { task_id: 'P20.2', action: 'conclude' } }],
        final_response: '✅ P20.2 concluída.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_move', input: { task_id: 'P20.2', action: 'conclude' } }],
        outbound: [],
        settle_reason: 'timeout',
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.matches.action).toBe(true);
    expect(comparison.matches.mutation_types).toBe(true);
    expect(comparison.matches.outbound_intent).toBe(false);
    expect(comparison.classification.kind).toBe('no_outbound_timeout');
  });

  it('surfaces no-outbound timeout before v1-bug annotations', () => {
    const turn: Phase3TurnResult = {
      turn_index: 28,
      text: 'adicionar Ana Beatriz em M2',
      v1: {
        tools: [{ name: 'taskflow_update', input: { task_id: 'M2', updates: { add_participant: 'Ana Beatriz' } } }],
        final_response: '✅ M2 — Ana Beatriz adicionada como participante.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_update_task', input: { task_id: 'M2', updates: { add_participant: 'Ana Beatriz' } } }],
        outbound: [],
        settle_reason: 'timeout',
      },
      phase3: {
        metadata: {
          turn_index: 28,
          context_mode: 'fresh',
          v1_bug: {
            description: 'v1 wrote the wrong weekday in the same turn.',
            detected_by: 'manual_review',
          },
        },
      },
    };

    expect(compareSemanticTurn(turn).classification.kind).toBe('no_outbound_timeout');
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

  it('normalizes note-only MCP tools as update mutations', () => {
    const summary = summarizeSemanticBehavior([
      { name: 'mcp__nanoclaw__api_task_add_note', input: { task_id: 'T79', text: 'Repositórios' } },
    ]);

    expect(summary.action).toBe('mutate');
    expect(summary.mutation_types).toEqual(['update']);
  });

  it('flags provider API errors as inconclusive replay noise', () => {
    const comparison = compareSemanticTurn({
      turn_index: 1,
      text: 'SEI IA',
      v1: { tools: [], final_response: 'Pode me dar mais contexto?' },
      v2: {
        tools: [],
        outbound: [{ kind: 'chat', content: '{"text":"API Error: 529 Overloaded."}' }],
      },
    });

    expect(comparison.classification.kind).toBe('provider_error');
  });

  it('does not pass duplicate task IDs when the board reference differs', () => {
    const comparison = compareSemanticTurn({
      turn_index: 3,
      text: 'T10',
      v1: {
        tools: [{ name: 'taskflow_query', input: { query: 'task_details', task_id: 'T10' } }],
        final_response: '🔗 *T10* (board SEC) — Pedir ao Reginaldo Graça.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_query', input: { query: 'task_details', task_id: 'T10' } }],
        outbound: [{ kind: 'chat', content: '{"text":"📋 *T10*\\n\\n_Quadro: ASSE-SECI - asse-seci-taskflow_"}' }],
      },
    });

    expect(comparison.matches.task_ids).toBe(true);
    expect(comparison.matches.board_refs).toBe(false);
    expect(comparison.classification.kind).toBe('real_divergence');
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

  it('flags uncovered cross-board sqlite reads as missing_api_capability', () => {
    // v2 hasn't found the cross-board task. The production turn-17 v2
    // reply asks the user to confirm the ID, so v2's outbound intent
    // resolves to `asks_user`. Combined with v1's informational reply
    // (it found the task and showed details), the comparator's
    // intent-divergence guard refuses to mark the turn as match —
    // classifyRawSqliteTurn then routes through the t43 heuristic and
    // surfaces the gap to the operator as `missing_api_capability`.
    const decision = classifyRawSqliteTurn({
      turn_index: 17,
      text: 't43',
      v1: {
        tools: [{ name: 'mcp__sqlite__read_query', input: {} }],
        final_response: 'T43 — Cobrar ofício João Pessoa. Responsável: Laizys.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_query', input: { task_id: 'T43' } }],
        outbound: [{
          kind: 'chat',
          content: '{"text":"Não encontrei nenhuma tarefa com o ID T43. Pode verificar se o ID está correto?"}',
        }],
      },
    });
    expect(decision?.classification).toBe('missing_api_capability');
    expect(decision?.recommendation).toContain('cross-board');
  });

  it('marks raw sqlite parity as covered when first-class behavior matches', () => {
    // v2 used find_task_in_organization and reproduced v1's informational
    // task-details reply — the semantic comparison resolves to `match`,
    // so the classifier should route to `documented_tool_surface_change`
    // (capability exists and v2 demonstrated parity).
    const decision = classifyRawSqliteTurn({
      turn_index: 17,
      text: 't43',
      v1: {
        tools: [{ name: 'mcp__sqlite__read_query', input: {} }],
        final_response: 'T43 — Cobrar ofício João Pessoa. Responsável: Laizys.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_query', input: { query: 'find_task_in_organization', task_id: 'T43' } }],
        outbound: [{ kind: 'chat', content: '{"text":"T43 — Cobrar ofício João Pessoa. Responsável: Laizys."}' }],
      },
    });
    expect(decision?.classification).toBe('documented_tool_surface_change');
    expect(decision?.recommendation).toMatch(/api_\*|MCP/);
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

  it('classifies JSON outbound clarification rows by decoded text', () => {
    const summary = summarizeSemanticBehavior(
      [],
      [{ kind: 'chat', content: JSON.stringify({ text: 'Essa atividade não está cadastrada diretamente.\n\nDeseja:\n1. Criar tarefa simples' }) }],
    );

    expect(summary.action).toBe('ask');
    expect(summary.outbound_intent).toBe('asks_user');
  });

  it('keeps board output informational despite a trailing generic CTA', () => {
    const summary = summarizeSemanticBehavior(
      [{ name: 'mcp__nanoclaw__api_report', input: { type: 'standup' } }],
      [{
        kind: 'chat',
        content: JSON.stringify({
          text: '📊 *Board — Sexta, 15/05/2026*\n\n✅ *Vinculada concluída:*\n• *SEC-T10* — SEI de homologação PGM/SEMDEC ✅ (Reginaldo Graça)\n\nQuer adicionar alguma tarefa?',
        }),
      }],
    );

    expect(summary.action).toBe('read');
    expect(summary.outbound_intent).toBe('informational');
    expect(summary.task_ids).toEqual(['T10']);
    expect(summary.board_refs).toEqual(['sec']);
  });

  it('treats missing-id plus related-task grounding as informational', () => {
    const summary = summarizeSemanticBehavior(
      [{ name: 'api_query', input: { query: 'search', search_text: 'SEI' } }],
      [{
        kind: 'chat',
        content: JSON.stringify({
          text: 'A T79 continua não localizada neste board, mas encontrei tarefa relacionada:\n\n• *SEC-T10* — SEI de homologação — concluída\n\nO que você precisa fazer com a T79?',
        }),
      }],
    );

    expect(summary.action).toBe('read');
    expect(summary.outbound_intent).toBe('informational');
    expect(summary.task_ids).toEqual(['T10', 'T79']);
  });

  it('extracts task ids from no-tool outbound context replies', () => {
    const summary = summarizeSemanticBehavior(
      [],
      [{ kind: 'chat', content: JSON.stringify({ text: 'Posso encaminhar a nota de T43 para o quadro da Laizys?' }) }],
    );

    expect(summary.action).toBe('ask');
    expect(summary.task_ids).toEqual(['T43']);
  });
});

describe('Phase 3 state-drift classifications', () => {
  it('classifies ask-only task hint differences as a context hint gap', () => {
    const turn: Phase3TurnResult = {
      turn_index: 0,
      text: 'Aguardar e Acompanhar licitação para reforma do prédio pela SDU Leste',
      v1: {
        tools: [],
        final_response: 'Pode se relacionar ao P13. Deseja registrar?',
      },
      v2: {
        tools: [],
        outbound: [{ kind: 'chat', content: '{"text":"Deseja criar tarefa simples, adicionar como etapa ou capturar no inbox?"}' }],
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('ask_context_hint_gap');
    expect(comparison.matches.action).toBe(true);
    expect(comparison.matches.task_ids).toBe(false);
  });

  it('treats failed mutation attempts followed by a not-found clarification as ask behavior', () => {
    const turn: Phase3TurnResult = {
      turn_index: 11,
      text: 'T1- Preparando mapa comparativo e justificativa de preço',
      v1: {
        tools: [],
        final_response: 'Não encontrei uma tarefa T1. Você quis dizer T41?',
      },
      v2: {
        tools: [
          { name: 'mcp__nanoclaw__api_task_add_note', input: { task_id: 'T1', text: 'Preparando mapa comparativo' } },
          { name: 'mcp__nanoclaw__api_query', input: { query: 'search', search_text: 'T1' } },
        ],
        outbound: [{ kind: 'chat', content: '{"text":"Não encontrei nenhuma tarefa com o ID T1. Você quis dizer T75? Me confirma."}' }],
      },
      phase3: {
        metadata: {
          turn_index: 11,
          context_mode: 'fresh',
          expected_behavior: {
            action: 'ask',
            task_ids: ['T1', 'T41'],
            mutation_types: [],
            outbound_intent: 'asks_user',
          },
        },
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.actual.action).toBe('ask');
    expect(comparison.actual.mutation_types).toEqual([]);
    expect(comparison.classification.kind).toBe('ask_context_hint_gap');
  });

  it('classifies read-only task-set mismatches without restored snapshots as state drift', () => {
    const turn: Phase3TurnResult = {
      turn_index: 8,
      text: 'Alguma atividade do João para revisão',
      v1: {
        tools: [{ name: 'mcp__nanoclaw__taskflow_query', input: { query: 'person_review', person_name: 'João Antonio' } }],
        final_response: 'Tarefas do João em revisão: P6.1 e P6.2.',
      },
      v2: {
        tools: [{ name: 'mcp__nanoclaw__api_query', input: { query: 'person_review', person_name: 'João Antonio' } }],
        outbound: [{ kind: 'chat', content: '{"text":"Nenhuma atividade do João Antonio está em revisão. P6.10 e P6.12 estão ativas."}' }],
      },
      phase3: {
        db_snapshot_status: 'not_requested',
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('state_drift');
    expect(comparison.matches.task_ids).toBe(false);
  });

  it('classifies annotated mutation mismatches as state drift', () => {
    const turn: Phase3TurnResult = {
      turn_index: 8,
      text: 'sec-t41 : processo enviado para a CMG aguardando retorno com aprovação',
      v1: {
        tools: [
          { name: 'mcp__nanoclaw__taskflow_move', input: { task_id: 'SEC-T41', action: 'wait' } },
          { name: 'mcp__nanoclaw__taskflow_update', input: { task_id: 'SEC-T41', updates: { add_note: 'Processo enviado para a CMG.' } } },
        ],
        final_response: '✅ SEC-T41 atualizada.',
      },
      v2: {
        tools: [
          { name: 'mcp__nanoclaw__api_task_add_note', input: { task_id: 'SEC-T41', text: 'Processo enviado para a CMG.' } },
        ],
        outbound: [{ kind: 'chat', content: '{"text":"SEC-T41 já está concluída. Deseja reabrir?"}' }],
      },
      phase3: {
        db_snapshot_status: 'not_requested',
        metadata: {
          turn_index: 8,
          context_mode: 'fresh',
          state_drift: {
            description: 'Current DB already has SEC-T41 done with the same note, while v1 recorded this turn before completion.',
            evidence: 'SEC-T41 column=done; note already present.',
          },
        },
      },
    };

    const comparison = compareSemanticTurn(turn);
    expect(comparison.classification.kind).toBe('state_drift');
    expect(comparison.classification.note).toContain('SEC-T41 column=done');
  });

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
