import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { ContextService } from './context-service.js';
import {
  parseTurnsFromJsonl,
  captureAgentTurn,
  jsonlPath,
} from './context-sync.js';

const TEST_DIR = path.join(import.meta.dirname, '..', 'test-context-sync');
const TEST_DB = path.join(TEST_DIR, 'context.db');

function makeSvc(): ContextService {
  return new ContextService(TEST_DB, {
    summarizer: 'ollama',
    ollamaHost: '',
    retainDays: 90,
  });
}

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/* ================================================================== */
/*  parseTurnsFromJsonl                                                */
/* ================================================================== */

describe('parseTurnsFromJsonl', () => {
  it('extracts a basic user->assistant turn', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
        sessionId: 'sess-1',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello, how are you?' }],
        },
        uuid: 'u1',
        timestamp: '2026-03-15T10:00:01.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I am doing well, thank you!' }],
        },
        uuid: 'a1',
        timestamp: '2026-03-15T10:00:05.000Z',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe('Hello, how are you?');
    expect(turns[0].agentResponse).toBe('I am doing well, thank you!');
    expect(turns[0].timestamp).toBe('2026-03-15T10:00:00.000Z');
    expect(turns[0].lastAssistantUuid).toBe('a1');
    expect(turns[0].toolCalls).toHaveLength(0);
    expect(turns[0].endIndex).toBe(3); // exclusive end
  });

  it('extracts multiple turns separated by dequeue operations', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'First question' }],
        },
        uuid: 'u1',
        timestamp: '2026-03-15T10:00:01.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'First answer' }],
        },
        uuid: 'a1',
      }),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:05:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Second question' }],
        },
        uuid: 'u2',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Second answer' }],
        },
        uuid: 'a2',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(2);
    expect(turns[0].userMessage).toBe('First question');
    expect(turns[0].agentResponse).toBe('First answer');
    expect(turns[0].timestamp).toBe('2026-03-15T10:00:00.000Z');
    expect(turns[0].endIndex).toBe(3);

    expect(turns[1].userMessage).toBe('Second question');
    expect(turns[1].agentResponse).toBe('Second answer');
    expect(turns[1].timestamp).toBe('2026-03-15T10:05:00.000Z');
    expect(turns[1].endIndex).toBe(6);
  });

  it('skips compact_boundary and the following user entry', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Real user message' }],
        },
        uuid: 'u1',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Real response' }],
        },
        uuid: 'a1',
      }),
      // compact_boundary
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
      }),
      // Synthetic compaction summary (should be skipped)
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content:
            'This session is being continued from a previous conversation...',
        },
        uuid: 'u-compact',
      }),
      // Continuation of the session after compaction
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Continuing after compaction' }],
        },
        uuid: 'a-compact',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    // Should only get the first real turn
    // The synthetic user message after compact_boundary is skipped
    // The assistant after compaction has no user message to pair with
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe('Real user message');
  });

  it('handles tool_result continuation within a turn', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run the task' }],
        },
        uuid: 'u1',
      }),
      // Assistant calls a tool
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'taskflow_move', id: 'tc1' }],
        },
        uuid: 'a1',
      }),
      // Tool result (user entry with only tool_result blocks)
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tc1',
              content: 'Task moved successfully to in-progress',
            },
          ],
        },
        uuid: 'u-tool',
      }),
      // Assistant continues after tool result
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Done! Task has been moved to in-progress.',
            },
          ],
        },
        uuid: 'a2',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe('Run the task');
    expect(turns[0].agentResponse).toBe(
      'Done! Task has been moved to in-progress.',
    );
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].tool).toBe('taskflow_move');
    expect(turns[0].toolCalls[0].resultSummary).toBe(
      'Task moved successfully to in-progress',
    );
    expect(turns[0].lastAssistantUuid).toBe('a2');
  });

  it('does not return incomplete turns (user without assistant response)', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Complete turn' }],
        },
        uuid: 'u1',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Complete response' }],
        },
        uuid: 'a1',
      }),
      // Second turn: user message only, no assistant response
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:05:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Incomplete turn' }],
        },
        uuid: 'u2',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe('Complete turn');
    // The cursor should only advance past the complete turn
    expect(turns[0].endIndex).toBe(3);
  });

  it('does not return turn with only tool_use (no text response)', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Do something' }],
        },
        uuid: 'u1',
      }),
      // Assistant only calls a tool, no text
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'some_tool', id: 'tc1' }],
        },
        uuid: 'a1',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    // No text in assistant response, so turn is incomplete
    expect(turns).toHaveLength(0);
  });

  it('handles assistant with text + tool_use blocks', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Check status' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check...' },
            { type: 'tool_use', name: 'taskflow_status', id: 'tc1' },
          ],
        },
        uuid: 'a1',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tc1',
              content: '5 tasks in progress',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'You have 5 tasks in progress.' }],
        },
        uuid: 'a2',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].agentResponse).toContain('Let me check...');
    expect(turns[0].agentResponse).toContain('You have 5 tasks in progress.');
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].tool).toBe('taskflow_status');
  });

  it('uses startIndex for correct endIndex calculation', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
        },
        uuid: 'a1',
      }),
    ];

    // Starting from offset 100 (simulating cursor position)
    const turns = parseTurnsFromJsonl(lines, 100);
    expect(turns).toHaveLength(1);
    expect(turns[0].endIndex).toBe(103); // 100 + 3 lines
  });

  it('ignores enqueue operations (not turn boundaries)', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'User msg' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Response part 1' }],
        },
        uuid: 'a1',
      }),
      // enqueue in the middle — should NOT create a turn boundary
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-03-15T10:01:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Response part 2' }],
        },
        uuid: 'a2',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    // enqueue should not split the turn
    expect(turns).toHaveLength(1);
    expect(turns[0].agentResponse).toContain('Response part 1');
    expect(turns[0].agentResponse).toContain('Response part 2');
  });

  it('skips user entries with string content (compaction summaries)', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      // String content user entry — should be skipped
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content:
            'This session is being continued from a previous conversation...',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'OK, continuing' }],
        },
        uuid: 'a1',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    // The string-content user message was skipped, so no user message for the turn
    expect(turns).toHaveLength(0);
  });

  it('skips unknown entry types', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      }),
      // Unknown type
      JSON.stringify({ type: 'heartbeat', data: 'ping' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'World' }],
        },
        uuid: 'a1',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe('Hello');
    expect(turns[0].agentResponse).toBe('World');
  });

  it('handles empty lines and malformed JSON gracefully', () => {
    const lines = [
      '',
      'not json at all',
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Valid turn' }],
        },
      }),
      '',
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Valid response' }],
        },
        uuid: 'a1',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe('Valid turn');
  });

  it('handles turn without dequeue (fallback: user with non-tool_result array)', () => {
    const lines = [
      // No dequeue — user message starts directly
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Direct message' }],
        },
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Direct response' }],
        },
        uuid: 'a1',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe('Direct message');
    expect(turns[0].timestamp).toBe('2026-03-15T10:00:00.000Z');
  });

  it('extracts tool_result with array content (nested text blocks)', () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run command' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'bash', id: 'tc1' }],
        },
        uuid: 'a1',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tc1',
              content: [
                { type: 'text', text: 'Command output line 1' },
                { type: 'text', text: 'Command output line 2' },
              ],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Command completed.' }],
        },
        uuid: 'a2',
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].toolCalls[0].resultSummary).toContain(
      'Command output line 1',
    );
    expect(turns[0].toolCalls[0].resultSummary).toContain(
      'Command output line 2',
    );
  });
});

/* ================================================================== */
/*  Cursor: does not advance past incomplete turns                     */
/* ================================================================== */

describe('cursor does not advance past incomplete turns', () => {
  it('returns endIndex of last COMPLETE turn only', () => {
    const lines = [
      // Turn 1: complete
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 1' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Response 1' }],
        },
        uuid: 'a1',
      }),
      // Turn 2: incomplete (user only)
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:05:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 2 incomplete' }],
        },
      }),
    ];

    const turns = parseTurnsFromJsonl(lines, 0);
    expect(turns).toHaveLength(1);
    // endIndex of the complete turn should be 3 (after line 0,1,2)
    expect(turns[0].endIndex).toBe(3);
  });

  it('works with startIndex offset for incomplete trailing turn', () => {
    const lines = [
      // Turn 1: complete
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Turn A' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Response A' }],
        },
        uuid: 'a1',
      }),
      // Turn 2: complete
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:05:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Turn B' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Response B' }],
        },
        uuid: 'a2',
      }),
      // Turn 3: incomplete
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:10:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Turn C incomplete' }],
        },
      }),
    ];

    // Simulate reading from cursor position 50
    const turns = parseTurnsFromJsonl(lines, 50);
    expect(turns).toHaveLength(2);
    expect(turns[0].endIndex).toBe(53); // 50 + 3
    expect(turns[1].endIndex).toBe(56); // 50 + 6
    // Incomplete turn C does not appear and cursor stops at 56
  });
});

/* ================================================================== */
/*  captureAgentTurn integration                                       */
/* ================================================================== */

describe('captureAgentTurn', () => {
  it('reads JSONL and inserts turns into the context service', async () => {
    const svc = makeSvc();

    // Create a fake JSONL file
    const sessionId = 'test-session-001';
    const groupFolder = 'test-group';
    const filePath = jsonlPath(groupFolder, sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
        sessionId,
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'T1 iniciado' }],
        },
        uuid: 'u1',
        timestamp: '2026-03-15T10:00:01.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'T1 movido para Em Andamento' }],
        },
        uuid: 'a1',
        timestamp: '2026-03-15T10:00:05.000Z',
      }),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    await captureAgentTurn(svc, groupFolder, sessionId);

    // Verify leaf node was created
    const nodes = svc.db
      .prepare(
        "SELECT * FROM context_nodes WHERE group_folder = 'test-group' AND level = 0",
      )
      .all() as any[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toMatch(
      /^leaf:test-group:2026-03-15T10:00:00\.000Z:\d{4}$/,
    );

    // Verify session
    const session = svc.db
      .prepare(
        "SELECT * FROM context_sessions WHERE group_folder = 'test-group'",
      )
      .get() as any;
    expect(session).toBeTruthy();
    expect(session.agent_response).toBe('T1 movido para Em Andamento');

    // Verify cursor was updated
    const cursor = svc.db
      .prepare(
        "SELECT * FROM context_cursors WHERE group_folder = 'test-group'",
      )
      .get() as any;
    expect(cursor).toBeTruthy();
    expect(cursor.session_id).toBe(sessionId);
    expect(cursor.last_entry_index).toBe(3);
    expect(cursor.last_assistant_uuid).toBe('a1');

    svc.close();
  });

  it('skips scheduled-task turns but still advances cursor', async () => {
    const svc = makeSvc();
    const sessionId = 'test-session-sched';
    const groupFolder = 'test-group';
    const filePath = jsonlPath(groupFolder, sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const lines = [
      // Turn 1: scheduled task (should be skipped)
      JSON.stringify({
        type: 'queue-operation', operation: 'dequeue',
        timestamp: '2026-03-15T08:00:00.000Z', sessionId,
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '[SCHEDULED TASK - automated]\n\n[TF-STANDUP]' }] },
        uuid: 'u-sched', timestamp: '2026-03-15T08:00:01.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Board is empty. Skip.' }] },
        uuid: 'a-sched', timestamp: '2026-03-15T08:00:05.000Z',
      }),
      // Turn 2: human message (should be captured)
      JSON.stringify({
        type: 'queue-operation', operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z', sessionId,
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'atividades Wanderlan' }] },
        uuid: 'u-human', timestamp: '2026-03-15T10:00:01.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Wanderlan has 2 tasks.' }] },
        uuid: 'a-human', timestamp: '2026-03-15T10:00:05.000Z',
      }),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    await captureAgentTurn(svc, groupFolder, sessionId);

    // Only the human turn should be captured
    const nodes = svc.db
      .prepare("SELECT * FROM context_nodes WHERE group_folder = ? AND level = 0")
      .all(groupFolder) as any[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toContain('2026-03-15T10:00:00');

    // But cursor should advance past BOTH turns
    const cursor = svc.db
      .prepare("SELECT * FROM context_cursors WHERE group_folder = ?")
      .get(groupFolder) as any;
    expect(cursor.last_entry_index).toBe(6); // past all 6 lines

    svc.close();
  });

  it('resumes from cursor position on second call', async () => {
    const svc = makeSvc();

    const sessionId = 'test-session-002';
    const groupFolder = 'resume-group';
    const filePath = jsonlPath(groupFolder, sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // First batch
    const turn1Lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'First turn' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'First response' }],
        },
        uuid: 'a1',
      }),
    ];
    fs.writeFileSync(filePath, turn1Lines.join('\n') + '\n');

    await captureAgentTurn(svc, groupFolder, sessionId);

    // Verify first turn captured
    let nodes = svc.db
      .prepare(
        `SELECT * FROM context_nodes WHERE group_folder = '${groupFolder}' AND level = 0`,
      )
      .all();
    expect(nodes).toHaveLength(1);

    // Append second turn
    const turn2Lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T11:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Second turn' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Second response' }],
        },
        uuid: 'a2',
      }),
    ];
    fs.appendFileSync(filePath, turn2Lines.join('\n') + '\n');

    await captureAgentTurn(svc, groupFolder, sessionId);

    // Now should have 2 nodes
    nodes = svc.db
      .prepare(
        `SELECT * FROM context_nodes WHERE group_folder = '${groupFolder}' AND level = 0 ORDER BY time_start`,
      )
      .all();
    expect(nodes).toHaveLength(2);

    // Cursor should be at 6
    const cursor = svc.db
      .prepare(
        `SELECT * FROM context_cursors WHERE group_folder = '${groupFolder}'`,
      )
      .get() as any;
    expect(cursor.last_entry_index).toBe(6);
    expect(cursor.last_assistant_uuid).toBe('a2');

    svc.close();
  });

  it('resets cursor when session ID changes', async () => {
    const svc = makeSvc();
    const groupFolder = 'reset-group';

    // First session
    const session1 = 'session-old';
    const file1 = jsonlPath(groupFolder, session1);
    fs.mkdirSync(path.dirname(file1), { recursive: true });
    fs.writeFileSync(
      file1,
      [
        JSON.stringify({
          type: 'queue-operation',
          operation: 'dequeue',
          timestamp: '2026-03-14T10:00:00.000Z',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Old session msg' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Old session resp' }],
          },
          uuid: 'a-old',
        }),
      ].join('\n') + '\n',
    );

    await captureAgentTurn(svc, groupFolder, session1);

    // Verify cursor points to old session
    let cursor = svc.db
      .prepare(
        `SELECT * FROM context_cursors WHERE group_folder = '${groupFolder}'`,
      )
      .get() as any;
    expect(cursor.session_id).toBe(session1);
    expect(cursor.last_entry_index).toBe(3);

    // New session
    const session2 = 'session-new';
    const file2 = jsonlPath(groupFolder, session2);
    fs.writeFileSync(
      file2,
      [
        JSON.stringify({
          type: 'queue-operation',
          operation: 'dequeue',
          timestamp: '2026-03-15T10:00:00.000Z',
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'New session msg' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'New session resp' }],
          },
          uuid: 'a-new',
        }),
      ].join('\n') + '\n',
    );

    await captureAgentTurn(svc, groupFolder, session2);

    // Cursor should now point to new session, starting from 0 and ending at 3
    cursor = svc.db
      .prepare(
        `SELECT * FROM context_cursors WHERE group_folder = '${groupFolder}'`,
      )
      .get() as any;
    expect(cursor.session_id).toBe(session2);
    expect(cursor.last_entry_index).toBe(3);
    expect(cursor.last_assistant_uuid).toBe('a-new');

    // Should have 2 nodes total (one from each session)
    const nodes = svc.db
      .prepare(
        `SELECT * FROM context_nodes WHERE group_folder = '${groupFolder}' AND level = 0`,
      )
      .all();
    expect(nodes).toHaveLength(2);

    svc.close();
  });

  it('returns gracefully when JSONL file does not exist', async () => {
    const svc = makeSvc();

    // No file created — should not throw
    await captureAgentTurn(svc, 'missing-group', 'nonexistent-session');

    // No nodes or cursors should be created
    const nodes = svc.db
      .prepare('SELECT COUNT(*) as cnt FROM context_nodes')
      .get() as any;
    expect(nodes.cnt).toBe(0);

    const cursors = svc.db
      .prepare('SELECT COUNT(*) as cnt FROM context_cursors')
      .get() as any;
    expect(cursors.cnt).toBe(0);

    svc.close();
  });

  it('does not advance cursor past incomplete trailing turn', async () => {
    const svc = makeSvc();

    const sessionId = 'test-session-incomplete';
    const groupFolder = 'incomplete-group';
    const filePath = jsonlPath(groupFolder, sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Complete turn + incomplete turn at end
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Complete' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
        },
        uuid: 'a1',
      }),
      // Incomplete: user without assistant
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-15T10:05:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Pending...' }],
        },
      }),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    await captureAgentTurn(svc, groupFolder, sessionId);

    // Only 1 node (complete turn)
    const nodes = svc.db
      .prepare(
        `SELECT * FROM context_nodes WHERE group_folder = '${groupFolder}'`,
      )
      .all();
    expect(nodes).toHaveLength(1);

    // Cursor at 3, not 5
    const cursor = svc.db
      .prepare(
        `SELECT * FROM context_cursors WHERE group_folder = '${groupFolder}'`,
      )
      .get() as any;
    expect(cursor.last_entry_index).toBe(3);

    svc.close();
  });

  it('handles errors gracefully without throwing', async () => {
    // Test with a broken service (db closed)
    const svc = makeSvc();
    svc.close(); // close DB to force errors

    // Should not throw
    await expect(captureAgentTurn(svc, 'grp', 'sess')).resolves.toBeUndefined();
  });
});

/* ================================================================== */
/*  jsonlPath                                                          */
/* ================================================================== */

describe('jsonlPath', () => {
  it('constructs correct host-side path', () => {
    const p = jsonlPath('my-group', 'abc-123');
    // Path is now absolute (uses DATA_DIR from config.ts)
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toContain(
      'data/sessions/my-group/.claude/projects/-workspace-group/abc-123.jsonl',
    );
  });
});
