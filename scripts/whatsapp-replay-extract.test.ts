import { describe, expect, it } from 'vitest';
import { extractConversationTurns } from './whatsapp-replay-extract.js';

describe('extractConversationTurns — pull WhatsApp-input turns from session JSONL', () => {
  it('extracts a single turn: user text → assistant tool_use → tool_result → assistant final text', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-22T14:27:36.655Z',
        message: { role: 'user', content: 'rename T100 to NEWNAME' },
      }),
      JSON.stringify({
        timestamp: '2026-04-22T14:27:41.553Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'rename', signature: 'X' }] },
      }),
      JSON.stringify({
        timestamp: '2026-04-22T14:27:42.194Z',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'mcp__nanoclaw__taskflow_update',
            input: { task_id: 'T100', updates: { title: 'NEWNAME' }, sender_name: 'miguel' } },
        ]},
      }),
      JSON.stringify({
        timestamp: '2026-04-22T14:27:42.228Z',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '{"success":true}' }] },
        ]},
      }),
      JSON.stringify({
        timestamp: '2026-04-22T14:27:43.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Renamed T100 to NEWNAME.' }] },
      }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(1);
    expect(turns[0].user_message).toBe('rename T100 to NEWNAME');
    expect(turns[0].user_timestamp).toBe('2026-04-22T14:27:36.655Z');
    expect(turns[0].tool_uses).toHaveLength(1);
    expect(turns[0].tool_uses[0].tool_name).toBe('taskflow_update');
    expect(turns[0].tool_uses[0].input).toEqual({
      task_id: 'T100', updates: { title: 'NEWNAME' }, sender_name: 'miguel',
    });
    expect(turns[0].tool_uses[0].output).toEqual({ success: true });
    expect(turns[0].final_response).toBe('Renamed T100 to NEWNAME.');
  });

  it('handles user content as a list of blocks (text type wraps the message)', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-22T14:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'iniciar T1' }] },
      }),
      JSON.stringify({
        timestamp: '2026-04-22T14:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
      }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(1);
    expect(turns[0].user_message).toBe('iniciar T1');
    expect(turns[0].final_response).toBe('OK');
    expect(turns[0].tool_uses).toEqual([]);
  });

  it('splits multiple turns separated by user-text messages', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'msg one' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] } }),
      JSON.stringify({ timestamp: 't3', message: { role: 'user', content: 'msg two' } }),
      JSON.stringify({ timestamp: 't4', message: { role: 'assistant', content: [{ type: 'text', text: 'r2' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(2);
    expect(turns[0].user_message).toBe('msg one');
    expect(turns[0].final_response).toBe('r1');
    expect(turns[1].user_message).toBe('msg two');
    expect(turns[1].final_response).toBe('r2');
  });

  it('user tool_result messages do NOT start a new turn (they belong to the prior turn)', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'do thing' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_1', name: 'mcp__nanoclaw__taskflow_move', input: { task_id: 'T1' } },
      ]}}),
      JSON.stringify({ timestamp: 't3', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '{"success":true}' }] },
      ]}}),
      JSON.stringify({ timestamp: 't4', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(1);
    expect(turns[0].tool_uses).toHaveLength(1);
    expect(turns[0].tool_uses[0].output).toEqual({ success: true });
  });

  it('captures multiple tool_uses in one turn in order', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'do many things' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_a', name: 'mcp__nanoclaw__taskflow_move', input: { task_id: 'T1' } },
        { type: 'tool_use', id: 'tu_b', name: 'mcp__nanoclaw__taskflow_update', input: { task_id: 'T1' } },
      ]}}),
      JSON.stringify({ timestamp: 't3', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_a', content: [{ type: 'text', text: '{"success":true,"first":1}' }] },
        { type: 'tool_result', tool_use_id: 'tu_b', content: [{ type: 'text', text: '{"success":true,"second":2}' }] },
      ]}}),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(1);
    expect(turns[0].tool_uses.map((t) => t.tool_use_id)).toEqual(['tu_a', 'tu_b']);
    expect(turns[0].tool_uses[0].output).toEqual({ success: true, first: 1 });
    expect(turns[0].tool_uses[1].output).toEqual({ success: true, second: 2 });
  });

  it('skips lifecycle lines where role is missing or null (no message.role)', () => {
    const lines = [
      JSON.stringify({ timestamp: 't0', type: 'system', operation: 'session_start' }),
      JSON.stringify({ timestamp: 't0b', message: {} }),
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(1);
    expect(turns[0].user_message).toBe('hi');
  });

  it('skips malformed JSON lines silently', () => {
    const lines = [
      'not-json',
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'ok' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(1);
  });

  it('discards turns with no user_message (no leading user-text line — orphan assistant)', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'assistant', content: [{ type: 'text', text: 'orphan' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(0);
  });

  it('the last turn does not require a final_response (truncated session)', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'truncated' } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(1);
    expect(turns[0].user_message).toBe('truncated');
    expect(turns[0].final_response).toBeNull();
  });

  it('mcp__nanoclaw__ prefix is stripped on tool_name', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'x' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_1', name: 'mcp__nanoclaw__taskflow_query', input: {} },
      ]}}),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].tool_uses[0].tool_name).toBe('taskflow_query');
  });

  it('non-mcp tools (Bash, Read, etc.) are captured verbatim — Phase 2 may use them', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'x' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      ]}}),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].tool_uses[0].tool_name).toBe('Bash');
  });

  it('thinking blocks are ignored (not surfaced in the turn record)', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'x' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
        { type: 'text', text: 'final' },
      ]}}),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].final_response).toBe('final');
    expect(turns[0].tool_uses).toEqual([]);
  });

  it('mixed user content (text + tool_result) attaches tool_result to prior turn AND starts new turn', () => {
    // Codex IMPORTANT: when a user message has BOTH a tool_result and text,
    // the prior turn must receive the tool_result before a new turn begins.
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'first' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_1', name: 'mcp__nanoclaw__taskflow_query', input: {} },
      ]}}),
      // Mixed user line: tool_result (for prior turn) + text (starts new turn)
      JSON.stringify({ timestamp: 't3', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '{"success":true,"data":"A"}' }] },
        { type: 'text', text: 'second message' },
      ]}}),
      JSON.stringify({ timestamp: 't4', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(2);
    expect(turns[0].user_message).toBe('first');
    expect(turns[0].tool_uses[0].output).toEqual({ success: true, data: 'A' });
    expect(turns[1].user_message).toBe('second message');
  });

  it('send_message tool_use surfaces as outbound_text (distinct from final_response)', () => {
    // Codex IMPORTANT: in many v1 flows the agent's outbound user-visible reply
    // is delivered via the `send_message` tool, not the final assistant text.
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'do thing' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_1', name: 'send_message',
          input: { text: 'Done! ✅', destination: 'whatsapp' } },
      ]}}),
      JSON.stringify({ timestamp: 't3', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '{"success":true}' }] },
      ]}}),
      JSON.stringify({ timestamp: 't4', message: { role: 'assistant', content: [{ type: 'text', text: '<internal>logged</internal>' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(1);
    expect(turns[0].outbound_text).toBe('Done! ✅');
    expect(turns[0].final_response).toBe('<internal>logged</internal>');
  });

  it('multiple send_message calls concatenate as outbound_text segments', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'multi reply' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_a', name: 'send_message', input: { text: 'Part 1', destination: 'X' } },
        { type: 'tool_use', id: 'tu_b', name: 'send_message', input: { text: 'Part 2', destination: 'X' } },
      ]}}),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].outbound_text).toBe('Part 1\nPart 2');
  });

  it('outbound_text is null when no send_message tool is called', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'x' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].outbound_text).toBeNull();
  });

  it('parses v1 prompt envelope: history preamble + context + <message> blocks', () => {
    const raw = [
      '--- Recent conversation history ---',
      '[19 de abr., 18:56] **Who:** Miguel Oliveira',
      'previous message',
      '',
      '<context timezone="America/Fortaleza" today="2026-04-22" weekday="quarta-feira" />',
      '<messages>',
      '<message sender="Carlos Giovanni" time="Apr 22, 2026, 11:27 AM">T100 muda título: Eturb</message>',
      '</messages>',
    ].join('\n');
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: raw } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].user_message).toBe(raw);
    expect(turns[0].parsed_messages).toHaveLength(1);
    expect(turns[0].parsed_messages[0].sender).toBe('Carlos Giovanni');
    expect(turns[0].parsed_messages[0].time).toBe('Apr 22, 2026, 11:27 AM');
    expect(turns[0].parsed_messages[0].text).toBe('T100 muda título: Eturb');
  });

  it('captures MULTIPLE <message> blocks in one turn as a list (batched inbound)', () => {
    // Codex IMPORTANT: when an operator forwards/batches multiple messages,
    // the prompt holds N <message> blocks; first-only was lossy.
    const raw = [
      '<messages>',
      '<message sender="Alice" time="10:00 AM">first</message>',
      '<message sender="Bob" time="10:01 AM">second</message>',
      '<message sender="Alice" time="10:02 AM">third</message>',
      '</messages>',
    ].join('\n');
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: raw } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].parsed_messages).toHaveLength(3);
    expect(turns[0].parsed_messages.map((m) => m.text)).toEqual(['first', 'second', 'third']);
    expect(turns[0].parsed_messages.map((m) => m.sender)).toEqual(['Alice', 'Bob', 'Alice']);
  });

  it('parses <message> with attrs in arbitrary order (id="..." before sender)', () => {
    // Codex IMPORTANT: v2 formatter may emit `id="..." from="..." sender="..." time="..."`.
    const raw = '<message id="m1" sender="Carol" time="11:00 AM">hello</message>';
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: raw } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].parsed_messages).toHaveLength(1);
    expect(turns[0].parsed_messages[0].sender).toBe('Carol');
    expect(turns[0].parsed_messages[0].text).toBe('hello');
  });

  it('XML-unescapes parsed message fields', () => {
    // &amp; &lt; &gt; &quot; &#39; should decode in sender/time/text
    const raw = '<message sender="A&amp;B" time="10:00 AM">5 &lt; 10 &amp; &quot;ok&quot;</message>';
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: raw } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].parsed_messages[0].sender).toBe('A&B');
    expect(turns[0].parsed_messages[0].text).toBe('5 < 10 & "ok"');
  });

  it('parsed_messages is empty array when the prompt lacks the <message> envelope', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'just plain text' } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].parsed_messages).toEqual([]);
  });

  it('outbound_messages uses the real v1 input field `target_chat_jid` for destination', () => {
    // Real v1 send_message input shape: { text, target_chat_jid }. We support
    // `destination` as a fallback for forward-compat with v2 tool variants.
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'multi' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_a', name: 'send_message',
          input: { text: 'Part 1', target_chat_jid: '120363425@g.us' } },
        { type: 'tool_use', id: 'tu_b', name: 'send_message',
          input: { text: 'Part 2', target_chat_jid: '120363426@g.us' } },
      ]}}),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].outbound_messages).toEqual([
      { tool_use_id: 'tu_a', destination: '120363425@g.us', text: 'Part 1' },
      { tool_use_id: 'tu_b', destination: '120363426@g.us', text: 'Part 2' },
    ]);
    expect(turns[0].outbound_text).toBe('Part 1\nPart 2');
  });

  it('outbound_messages falls back to `destination` field when target_chat_jid is absent', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'x' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_a', name: 'send_message',
          input: { text: 'Part 1', destination: 'chatA' } },
      ]}}),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].outbound_messages[0].destination).toBe('chatA');
  });

  it('outbound_messages destination=null when both fields are absent', () => {
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: 'x' } }),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_a', name: 'send_message', input: { text: 'OK' } },
      ]}}),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns[0].outbound_messages[0].destination).toBeNull();
  });

  it('a turn whose only user content is a tool_result (no leading text) is NOT a turn', () => {
    // Belt-and-braces guard: if a JSONL begins mid-conversation with a tool_result,
    // we don't promote it to a new turn (since there's no real user message).
    const lines = [
      JSON.stringify({ timestamp: 't1', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'orphan', content: [{ type: 'text', text: '{}' }] },
      ]}}),
      JSON.stringify({ timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } }),
    ];
    const turns = extractConversationTurns(lines.join('\n'));
    expect(turns).toHaveLength(0);
  });
});
