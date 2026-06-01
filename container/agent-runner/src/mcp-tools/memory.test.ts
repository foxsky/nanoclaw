import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openMemoryDb, searchMemory } from '../memory-store.js';
import {
  buildMemoryRecallAddendum,
  formatMemories,
  memoryNoteTool,
  memoryPruneOptions,
  memorySearchTool,
  noteMemory,
  pruneBoardMemory,
  recallAddendumText,
  recallMemory,
} from './memory.js';

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
  it('stores text for the board and returns the new id', async () => {
    db = openMemoryDb(':memory:');
    const res = await noteMemory(db, 'b1', { text: 'the deploy window is Tuesday 9am', kind: 'fact' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/mem-/);

    const hits = searchMemory(db, 'b1', 'deploy window', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('fact');
  });

  it('rejects empty/whitespace text', async () => {
    db = openMemoryDb(':memory:');
    expect((await noteMemory(db, 'b1', { text: '   ' })).isError).toBe(true);
    expect((await noteMemory(db, 'b1', {})).isError).toBe(true);
  });

  it('defaults kind to "note" when omitted', async () => {
    db = openMemoryDb(':memory:');
    await noteMemory(db, 'b1', { text: 'a plain note' });
    expect(searchMemory(db, 'b1', 'plain', 5)[0].kind).toBe('note');
  });
});

describe('recallMemory (core)', () => {
  it('returns cited memories for a hit', async () => {
    db = openMemoryDb(':memory:');
    await noteMemory(db, 'b1', { text: 'the deploy window is Tuesday 9am', kind: 'fact' });
    const res = await recallMemory(db, 'b1', { query: 'deploy window' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('deploy window is Tuesday 9am');
    expect(res.content[0].text).toContain('fact');
  });

  it('a recall miss is a normal (non-error) empty result, not an error', async () => {
    db = openMemoryDb(':memory:');
    await noteMemory(db, 'b1', { text: 'unrelated' });
    const res = await recallMemory(db, 'b1', { query: 'nonexistent topic' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text.toLowerCase()).toContain('no stored memories');
  });

  it('rejects an empty query', async () => {
    db = openMemoryDb(':memory:');
    expect((await recallMemory(db, 'b1', { query: '   ' })).isError).toBe(true);
    expect((await recallMemory(db, 'b1', {})).isError).toBe(true);
  });

  it('does not leak memories from another board', async () => {
    db = openMemoryDb(':memory:');
    await noteMemory(db, 'a', { text: 'secret alpha' });
    await noteMemory(db, 'b', { text: 'secret beta' });
    const text = (await recallMemory(db, 'a', { query: 'secret' })).content[0].text;
    expect(text).toContain('alpha');
    expect(text).not.toContain('beta');
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

describe('recallAddendumText (once-per-session auto-recall)', () => {
  it('renders a recent-memories section with the board facts (newest first)', async () => {
    db = openMemoryDb(':memory:');
    await noteMemory(db, 'b1', { text: 'deploys move to Tuesday', kind: 'decision' });
    await noteMemory(db, 'b1', { text: 'Bruno owns the mobile board' });
    const out = recallAddendumText(db, 'b1');
    expect(out).toContain('## Remembered for this board');
    expect(out).toContain('Bruno owns the mobile board'); // newest first
    expect(out).toContain('deploys move to Tuesday');
  });

  it('is empty for a board with no memories (prompt untouched on a fresh board)', () => {
    db = openMemoryDb(':memory:');
    expect(recallAddendumText(db, 'b1')).toBe('');
  });

  it('truncates an oversized memory so one entry cannot bloat every session prompt', async () => {
    db = openMemoryDb(':memory:');
    await noteMemory(db, 'b1', { text: 'X'.repeat(1000) });
    const out = recallAddendumText(db, 'b1');
    expect(out).toContain('…');
    expect(out).not.toContain('X'.repeat(400)); // capped well under the original 1000
  });

  it('buildMemoryRecallAddendum returns empty with no board env (opens no DB)', () => {
    delete process.env[ENV_KEY];
    expect(buildMemoryRecallAddendum()).toBe('');
  });
});

describe('forgetting policy gate (P4)', () => {
  const KEYS = ['NANOCLAW_MEMORY_MAX_AGE_DAYS', 'NANOCLAW_MEMORY_KEEP_TOP_N'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
  afterEach(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!))));

  it('is OFF (empty options) when no env is set — default never-forget', () => {
    KEYS.forEach((k) => delete process.env[k]);
    expect(memoryPruneOptions()).toEqual({});
  });

  it('parses positive age + budget caps from env', () => {
    process.env.NANOCLAW_MEMORY_MAX_AGE_DAYS = '90';
    process.env.NANOCLAW_MEMORY_KEEP_TOP_N = '500';
    expect(memoryPruneOptions()).toEqual({ maxAgeDays: 90, keepTopN: 500 });
  });

  it('floors a float keepTopN so it works instead of silently disabling forgetting', () => {
    process.env.NANOCLAW_MEMORY_KEEP_TOP_N = '500.9';
    delete process.env.NANOCLAW_MEMORY_MAX_AGE_DAYS;
    expect(memoryPruneOptions()).toEqual({ keepTopN: 500 });
  });

  it('ignores non-positive / garbage values rather than wiping the board', () => {
    process.env.NANOCLAW_MEMORY_MAX_AGE_DAYS = '0';
    process.env.NANOCLAW_MEMORY_KEEP_TOP_N = 'abc';
    expect(memoryPruneOptions()).toEqual({});
  });

  it('pruneBoardMemory is a no-op (0) with no board env, opening no DB', () => {
    const savedBoard = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    try {
      expect(pruneBoardMemory()).toBe(0);
    } finally {
      if (savedBoard !== undefined) process.env.NANOCLAW_TASKFLOW_BOARD_ID = savedBoard;
    }
  });
});
