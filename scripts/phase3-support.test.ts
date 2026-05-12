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
    });
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

  it('recommends first-class API support for raw sqlite cross-board lookup', () => {
    const decision = classifyRawSqliteTurn({
      turn_index: 17,
      text: 't43',
      v1: { tools: [{ name: 'mcp__sqlite__read_query', input: {} }] },
      v2: { tools: [{ name: 'mcp__nanoclaw__api_query', input: { task_id: 'T43' } }], outbound: [] },
    });

    expect(decision?.classification).toBe('missing_api_capability');
    expect(decision?.recommendation).toContain('cross-board');
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
