/**
 * Phase 2 tool_use capture — pure extractor + append-only writer.
 *
 * Why these tests: when we drive v2 against curated v1 turns, we need to
 * compare the v2 agent's tool_use sequence (name + input) to v1's recorded
 * sequence. The SDK's in-process message stream is the cheapest hook —
 * extracting tool_use/tool_result blocks here gives us per-session JSONL
 * the comparison harness can read without scraping ~/.claude/projects.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { appendToolEvents, extractToolEvents } from './claude-tool-capture.js';

describe('extractToolEvents', () => {
  it('pulls tool_use blocks from assistant messages', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check that task.' },
          { type: 'tool_use', id: 'toolu_X', name: 'api_query', input: { task_id: 'P15.7' } },
        ],
      },
    };
    expect(extractToolEvents(msg)).toEqual([
      { kind: 'tool_use', id: 'toolu_X', name: 'api_query', input: { task_id: 'P15.7' } },
    ]);
  });

  it('extracts multiple tool_use blocks in a single message', () => {
    // Why: parallel tool calls (rare but legal) — must not drop the second.
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'a1', name: 'api_query', input: { q: 1 } },
          { type: 'tool_use', id: 'a2', name: 'api_create_task', input: { title: 't' } },
        ],
      },
    };
    expect(extractToolEvents(msg)).toEqual([
      { kind: 'tool_use', id: 'a1', name: 'api_query', input: { q: 1 } },
      { kind: 'tool_use', id: 'a2', name: 'api_create_task', input: { title: 't' } },
    ]);
  });

  it('pulls tool_result blocks from user messages', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_X', content: 'task data', is_error: false },
        ],
      },
    };
    expect(extractToolEvents(msg)).toEqual([
      { kind: 'tool_result', id: 'toolu_X', output: 'task data', is_error: false },
    ]);
  });

  it('marks tool_result is_error true when the SDK flags an error', () => {
    // Why: comparator needs to distinguish "v2 called the right tool but it
    // errored" from "v2 picked a different tool than v1".
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_Y', content: 'task not found', is_error: true },
        ],
      },
    };
    expect(extractToolEvents(msg)).toEqual([
      { kind: 'tool_result', id: 'toolu_Y', output: 'task not found', is_error: true },
    ]);
  });

  it('returns empty for assistant messages with only text', () => {
    expect(
      extractToolEvents({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    ).toEqual([]);
  });

  it('returns empty for non-assistant/user message types', () => {
    expect(extractToolEvents({ type: 'system', subtype: 'init' })).toEqual([]);
    expect(extractToolEvents({ type: 'result' })).toEqual([]);
    expect(extractToolEvents({ type: 'compact_boundary' })).toEqual([]);
  });

  it('handles string content (user messages we push() in MessageStream)', () => {
    // Why: the agent-runner pushes plain user text — those messages flow back
    // through the loop with content: string, not blocks. Must not crash.
    expect(
      extractToolEvents({
        type: 'user',
        message: { content: 'just plain user text' },
      }),
    ).toEqual([]);
  });

  it('handles malformed messages without crashing', () => {
    expect(extractToolEvents(null)).toEqual([]);
    expect(extractToolEvents(undefined)).toEqual([]);
    expect(extractToolEvents({})).toEqual([]);
    expect(extractToolEvents({ type: 'assistant' })).toEqual([]);
    expect(extractToolEvents({ type: 'assistant', message: {} })).toEqual([]);
    expect(extractToolEvents({ type: 'assistant', message: { content: 'string' } })).toEqual([]);
  });
});

describe('appendToolEvents', () => {
  it('appends events as JSON Lines, one per line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-cap-'));
    const file = path.join(tmp, 'cap.jsonl');
    try {
      appendToolEvents(file, [{ kind: 'tool_use', id: 'a', name: 'x', input: { k: 1 } }]);
      appendToolEvents(file, [{ kind: 'tool_result', id: 'a', output: 'ok', is_error: false }]);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ kind: 'tool_use', id: 'a', name: 'x', input: { k: 1 } });
      expect(JSON.parse(lines[1])).toEqual({ kind: 'tool_result', id: 'a', output: 'ok', is_error: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes nothing for an empty events array', () => {
    // Why: the hot path in translateEvents calls this on every message —
    // if extractToolEvents returns [] the writer must not create the file.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-cap-'));
    const file = path.join(tmp, 'cap.jsonl');
    try {
      appendToolEvents(file, []);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('creates parent directories if missing', () => {
    // Why: NANOCLAW_TOOL_USES_PATH may point at a sub-path that doesn't exist
    // yet (e.g. /workspace/phase2/cap.jsonl). Auto-mkdir keeps the driver
    // setup minimal.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-cap-'));
    const file = path.join(tmp, 'nested', 'sub', 'cap.jsonl');
    try {
      appendToolEvents(file, [{ kind: 'tool_use', id: 'a', name: 'x', input: {} }]);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
