import { describe, expect, it } from 'vitest';
import {
  parseJsonlForMutations,
  v1ToV2EngineCall,
} from './mutation-replay-harness.js';

describe('parseJsonlForMutations — extract v1 mutation tool calls from session JSONL', () => {
  it('extracts a single taskflow_move tool_use + matching tool_result', () => {
    const lines = [
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__nanoclaw__taskflow_move',
              input: { task_id: 'T1', action: 'start', sender_name: 'alice' },
            },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [{ type: 'text', text: '{"success":true,"task_id":"T1"}' }],
            },
          ],
        },
      }),
    ];
    const result = parseJsonlForMutations(lines.join('\n'));
    expect(result).toHaveLength(1);
    expect(result[0].tool_name).toBe('taskflow_move');
    expect(result[0].tool_use_id).toBe('tu_1');
    expect(result[0].input).toEqual({ task_id: 'T1', action: 'start', sender_name: 'alice' });
    expect(result[0].output).toEqual({ success: true, task_id: 'T1' });
  });

  it('filters non-mutation tools (e.g. taskflow_report, taskflow_query)', () => {
    const lines = [
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__nanoclaw__taskflow_report',
              input: { type: 'digest' },
            },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_2',
              name: 'mcp__nanoclaw__taskflow_query',
              input: { query: 'task_details' },
            },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_3',
              name: 'mcp__nanoclaw__taskflow_update',
              input: { task_id: 'T1', updates: { add_note: 'X' }, sender_name: 'alice' },
            },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_3',
              content: [{ type: 'text', text: '{"success":true}' }],
            },
          ],
        },
      }),
    ];
    const result = parseJsonlForMutations(lines.join('\n'));
    // Only taskflow_update is a mutation; report/query are read-only
    expect(result).toHaveLength(1);
    expect(result[0].tool_name).toBe('taskflow_update');
  });

  it('handles tool_use without matching tool_result (orphan tool_use)', () => {
    const lines = [
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_orphan',
              name: 'mcp__nanoclaw__taskflow_move',
              input: { task_id: 'T1', action: 'start', sender_name: 'alice' },
            },
          ],
        },
      }),
    ];
    const result = parseJsonlForMutations(lines.join('\n'));
    expect(result).toHaveLength(1);
    expect(result[0].output).toBeNull(); // no matching tool_result
  });

  it('skips malformed JSON lines', () => {
    const lines = [
      'this is not JSON',
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__nanoclaw__taskflow_move',
              input: { task_id: 'T1', action: 'start', sender_name: 'alice' },
            },
          ],
        },
      }),
    ];
    const result = parseJsonlForMutations(lines.join('\n'));
    expect(result).toHaveLength(1);
  });

  it('skips empty lines', () => {
    const lines = [
      '',
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__nanoclaw__taskflow_move',
              input: { task_id: 'T1', action: 'start', sender_name: 'alice' },
            },
          ],
        },
      }),
      '',
    ];
    const result = parseJsonlForMutations(lines.join('\n'));
    expect(result).toHaveLength(1);
  });

  it('captures the JSONL line timestamp on each extracted mutation', () => {
    // A2.4 sequential replay sorts mutations across all sessions chronologically.
    // Each tool_use must therefore carry the timestamp of its source JSONL line.
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-08T15:38:09.618Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'mcp__nanoclaw__taskflow_move',
              input: { task_id: 'T1', action: 'start', sender_name: 'alice' } },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-08T15:38:11.842Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_2', name: 'mcp__nanoclaw__taskflow_update',
              input: { task_id: 'T1', updates: { add_note: 'X' }, sender_name: 'alice' } },
          ],
        },
      }),
    ];
    const result = parseJsonlForMutations(lines.join('\n'));
    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe('2026-04-08T15:38:09.618Z');
    expect(result[1].timestamp).toBe('2026-04-08T15:38:11.842Z');
  });

  it('captures monotonic line_index for stable secondary ordering (Codex IMPORTANT)', () => {
    // Same JSONL line may hold multiple tool_use blocks; same-timestamp
    // mutations across different lines need a stable secondary order to
    // disambiguate. line_index is 0-based across the WHOLE JSONL.
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-08T15:38:09.618Z',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'mcp__nanoclaw__taskflow_move',
            input: { task_id: 'T1', action: 'start', sender_name: 'a' } },
          { type: 'tool_use', id: 'tu_2', name: 'mcp__nanoclaw__taskflow_update',
            input: { task_id: 'T1', updates: { add_note: 'X' }, sender_name: 'a' } },
        ]},
      }),
      JSON.stringify({
        timestamp: '2026-04-08T15:38:11.842Z',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_3', name: 'mcp__nanoclaw__taskflow_move',
            input: { task_id: 'T2', action: 'start', sender_name: 'a' } },
        ]},
      }),
    ];
    const result = parseJsonlForMutations(lines.join('\n'));
    expect(result).toHaveLength(3);
    // tu_1 and tu_2 share a timestamp but tu_1 comes first in the line
    expect(result[0].line_index).toBeLessThan(result[1].line_index!);
    expect(result[1].line_index).toBeLessThan(result[2].line_index!);
  });

  it('timestamp is undefined when the JSONL line has none', () => {
    const lines = [
      JSON.stringify({
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'mcp__nanoclaw__taskflow_move', input: {} },
        ]},
      }),
    ];
    const result = parseJsonlForMutations(lines.join('\n'));
    expect(result[0].timestamp).toBeUndefined();
  });

  it('all 8 v1 mutation tools are recognized (including dependency + hierarchy)', () => {
    const tools = [
      'taskflow_move', 'taskflow_admin', 'taskflow_reassign',
      'taskflow_undo', 'taskflow_create', 'taskflow_update',
      'taskflow_dependency', 'taskflow_hierarchy',
    ];
    const lines = tools.map((tool, i) =>
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `tu_${i}`,
              name: `mcp__nanoclaw__${tool}`,
              input: {},
            },
          ],
        },
      }),
    );
    const result = parseJsonlForMutations(lines.join('\n'));
    expect(result).toHaveLength(8);
    expect(result.map((r) => r.tool_name).sort()).toEqual(tools.slice().sort());
  });
});

describe('v1ToV2EngineCall — map v1 tool name+params to v2 engine method+params', () => {
  it('taskflow_move → engine.move with board_id injected', () => {
    const result = v1ToV2EngineCall(
      'taskflow_move',
      { task_id: 'T1', action: 'start', sender_name: 'alice' },
      'board-secti',
    );
    expect(result.method).toBe('move');
    expect(result.params).toEqual({
      board_id: 'board-secti',
      task_id: 'T1',
      action: 'start',
      sender_name: 'alice',
    });
  });

  it('taskflow_admin → engine.admin', () => {
    const result = v1ToV2EngineCall(
      'taskflow_admin',
      { action: 'cancel_task', task_id: 'T1', sender_name: 'alice' },
      'board-x',
    );
    expect(result.method).toBe('admin');
    expect(result.params.board_id).toBe('board-x');
    expect(result.params.action).toBe('cancel_task');
  });

  it('taskflow_reassign → engine.reassign', () => {
    const result = v1ToV2EngineCall(
      'taskflow_reassign',
      { task_id: 'T1', target_person: 'bob', sender_name: 'alice', confirmed: true },
      'board-x',
    );
    expect(result.method).toBe('reassign');
    expect(result.params.target_person).toBe('bob');
  });

  it('taskflow_undo → engine.undo', () => {
    const result = v1ToV2EngineCall(
      'taskflow_undo',
      { sender_name: 'alice' },
      'board-x',
    );
    expect(result.method).toBe('undo');
    expect(result.params.board_id).toBe('board-x');
    expect(result.params.sender_name).toBe('alice');
  });

  it('taskflow_create → engine.create', () => {
    const result = v1ToV2EngineCall(
      'taskflow_create',
      { type: 'simple', title: 'X', sender_name: 'alice' },
      'board-x',
    );
    expect(result.method).toBe('create');
    expect(result.params.type).toBe('simple');
  });

  it('taskflow_update → engine.update', () => {
    const result = v1ToV2EngineCall(
      'taskflow_update',
      { task_id: 'T1', updates: { add_note: 'X' }, sender_name: 'alice' },
      'board-x',
    );
    expect(result.method).toBe('update');
    expect(result.params.task_id).toBe('T1');
  });

  it('taskflow_dependency → engine.dependency', () => {
    const result = v1ToV2EngineCall(
      'taskflow_dependency',
      { task_id: 'T1', depends_on: 'T2', sender_name: 'alice' },
      'board-x',
    );
    expect(result.method).toBe('dependency');
    expect(result.params.task_id).toBe('T1');
  });

  it('taskflow_hierarchy → engine.hierarchy', () => {
    const result = v1ToV2EngineCall(
      'taskflow_hierarchy',
      { task_id: 'P1', sender_name: 'alice' },
      'board-x',
    );
    expect(result.method).toBe('hierarchy');
    expect(result.params.task_id).toBe('P1');
  });

  it('throws on unknown tool name', () => {
    expect(() =>
      v1ToV2EngineCall('taskflow_unknown', {}, 'board-x'),
    ).toThrow(/Unknown v1 mutation tool/);
  });

  it('input board_id (if present) is overwritten by passed board_id', () => {
    // Defensive: v1 inputs shouldn't carry board_id but if they did,
    // the harness-supplied board_id wins (matches v1's engine.method({...args, board_id}))
    const result = v1ToV2EngineCall(
      'taskflow_move',
      { board_id: 'wrong', task_id: 'T1', action: 'start', sender_name: 'alice' },
      'board-correct',
    );
    expect(result.params.board_id).toBe('board-correct');
  });
});
