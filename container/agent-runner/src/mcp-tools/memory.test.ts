import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openMemoryDb, searchMemory } from '../memory-store.js';
import { formatMemories, memoryNoteTool, memorySearchTool, noteMemory, recallMemory } from './memory.js';

const ENV_KEY = 'NANOCLAW_TASKFLOW_BOARD_ID';
let savedEnv: string | undefined;
let db: ReturnType<typeof openMemoryDb> | null = null;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  db?.close();
  db = null;
});

/**
 * The board id comes from the host-injected env, never from the model, so memory can
 * never leak across boards. When the env is absent the group is not a TaskFlow board and
 * the tool must refuse WITHOUT opening any DB (so it never creates state for a non-board
 * group). This is the load-bearing isolation + opt-in invariant.
 */
describe('memory tools — board gate (no cross-board leak, opt-in)', () => {
  it('memory_search refuses with no board env and touches no DB', async () => {
    delete process.env[ENV_KEY];
    const res = await memorySearchTool.handler({ query: 'anything' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain('taskflow board');
  });

  it('memory_note refuses with no board env', async () => {
    delete process.env[ENV_KEY];
    const res = await memoryNoteTool.handler({ text: 'remember this' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain('taskflow board');
  });
});

describe('noteMemory (core)', () => {
  it('stores text for the board and returns the new id', () => {
    db = openMemoryDb(':memory:');
    const res = noteMemory(db, 'b1', { text: 'the deploy window is Tuesday 9am', kind: 'fact' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/mem-/);

    const hits = searchMemory(db, 'b1', 'deploy window', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('fact');
  });

  it('rejects empty/whitespace text', () => {
    db = openMemoryDb(':memory:');
    expect(noteMemory(db, 'b1', { text: '   ' }).isError).toBe(true);
    expect(noteMemory(db, 'b1', {}).isError).toBe(true);
  });

  it('defaults kind to "note" when omitted', () => {
    db = openMemoryDb(':memory:');
    noteMemory(db, 'b1', { text: 'a plain note' });
    expect(searchMemory(db, 'b1', 'plain', 5)[0].kind).toBe('note');
  });
});

describe('recallMemory (core)', () => {
  it('returns cited memories for a hit', () => {
    db = openMemoryDb(':memory:');
    noteMemory(db, 'b1', { text: 'the deploy window is Tuesday 9am', kind: 'fact' });
    const res = recallMemory(db, 'b1', { query: 'deploy window' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('deploy window is Tuesday 9am');
    expect(res.content[0].text).toContain('fact');
  });

  it('a recall miss is a normal (non-error) empty result, not an error', () => {
    db = openMemoryDb(':memory:');
    noteMemory(db, 'b1', { text: 'unrelated' });
    const res = recallMemory(db, 'b1', { query: 'nonexistent topic' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text.toLowerCase()).toContain('no stored memories');
  });

  it('rejects an empty query', () => {
    db = openMemoryDb(':memory:');
    expect(recallMemory(db, 'b1', { query: '   ' }).isError).toBe(true);
    expect(recallMemory(db, 'b1', {}).isError).toBe(true);
  });

  it('does not leak memories from another board', () => {
    db = openMemoryDb(':memory:');
    noteMemory(db, 'a', { text: 'secret alpha' });
    noteMemory(db, 'b', { text: 'secret beta' });
    expect(recallMemory(db, 'a', { query: 'secret' }).content[0].text).toContain('alpha');
    expect(recallMemory(db, 'a', { query: 'secret' }).content[0].text).not.toContain('beta');
  });
});

describe('formatMemories', () => {
  it('renders kind, text and the saved date for each hit', () => {
    const out = formatMemories([
      {
        id: 'mem-1',
        board_id: 'b1',
        kind: 'fact',
        text: 'the deploy window is Tuesday 9am',
        source_session: 'sess-7',
        source_ts: null,
        created_at: '2026-05-31T12:00:00Z',
      },
    ]);
    expect(out).toContain('[fact]');
    expect(out).toContain('the deploy window is Tuesday 9am');
    expect(out).toContain('2026-05-31');
  });
});
