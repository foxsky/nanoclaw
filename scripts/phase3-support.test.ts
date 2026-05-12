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
});
