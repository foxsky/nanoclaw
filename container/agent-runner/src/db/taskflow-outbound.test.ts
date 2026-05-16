import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * `enqueueOutboundMessage` — the 0h-v2 Option A engine helper. The
 * FastAPI MCP subprocess (bun) has NO /workspace session DBs and cannot
 * import the host's `writeOutboundDirect` (Node/better-sqlite3 — never
 * shared across the runtime boundary). This is the bun-side, path-
 * EXPLICIT, race-safe writer that mirrors `writeOutboundDirect`'s
 * atomic single-statement seq assignment so `src/delivery.ts` drains it
 * identically. It writes a `system`-kind row whose content carries the
 * `taskflow_notify` delivery-action payload; routing columns stay NULL
 * (the host `taskflow_notify` handler resolves board→channel,
 * fail-closed — Codex review #2 constraints).
 */
const MESSAGES_OUT_DDL = `
  CREATE TABLE messages_out (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT,
    timestamp TEXT NOT NULL, deliver_after TEXT, recurrence TEXT,
    kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT,
    thread_id TEXT, content TEXT NOT NULL
  );
`;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tf-outbound-'));
  dbPath = join(dir, 'outbound.db');
  const d = new Database(dbPath);
  d.exec(MESSAGES_OUT_DDL);
  d.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function enqueue(args: Parameters<
  typeof import('./taskflow-outbound.ts').enqueueOutboundMessage
>[1]) {
  const { enqueueOutboundMessage } = await import('./taskflow-outbound.ts');
  return enqueueOutboundMessage(dbPath, args);
}

function rows() {
  const d = new Database(dbPath);
  try {
    return d.prepare('SELECT * FROM messages_out ORDER BY seq ASC').all() as Array<
      Record<string, unknown>
    >;
  } finally {
    d.close();
  }
}

describe('enqueueOutboundMessage', () => {
  it('writes a system-kind row carrying the taskflow_notify payload; routing cols NULL', async () => {
    const seq = await enqueue({
      id: 'tfn-1',
      board_id: 'board-001',
      target: { kind: 'group', group_jid: 'g@x' },
      text: 'hello',
      metadata: { source: 'api_send_chat' },
    });
    expect(typeof seq).toBe('number'); // returns the assigned seq
    const all = rows();
    expect(all).toHaveLength(1);
    const row = all[0];
    expect(row.id).toBe('tfn-1');
    expect(row.kind).toBe('system');
    expect(row.platform_id).toBeNull();
    expect(row.channel_type).toBeNull();
    expect(row.thread_id).toBeNull();
    expect(typeof row.timestamp).toBe('string');
    expect((row.seq as number) > 0).toBe(true);
    const content = JSON.parse(row.content as string);
    expect(content.action).toBe('taskflow_notify');
    expect(content.board_id).toBe('board-001');
    expect(content.target).toEqual({ kind: 'group', group_jid: 'g@x' });
    expect(content.text).toBe('hello');
    expect(content.metadata).toEqual({ source: 'api_send_chat' });
  });

  it('is idempotent on id (INSERT OR IGNORE — no duplicate, no throw on retry)', async () => {
    await enqueue({ id: 'dup', board_id: 'b', target: { kind: 'person', person_id: 'p1' }, text: 'a' });
    await enqueue({ id: 'dup', board_id: 'b', target: { kind: 'person', person_id: 'p1' }, text: 'a' });
    expect(rows()).toHaveLength(1);
  });

  it('assigns a unique, strictly increasing seq across distinct enqueues (atomic, race-safe)', async () => {
    await enqueue({ id: 'm1', board_id: 'b', target: { kind: 'person', person_id: 'p1' }, text: '1' });
    await enqueue({ id: 'm2', board_id: 'b', target: { kind: 'person', person_id: 'p2' }, text: '2' });
    await enqueue({ id: 'm3', board_id: 'b', target: { kind: 'group', group_jid: 'g' }, text: '3' });
    const seqs = rows().map((r) => r.seq as number);
    expect(seqs).toHaveLength(3);
    expect(seqs[0]).toBeLessThan(seqs[1]);
    expect(seqs[1]).toBeLessThan(seqs[2]);
    expect(new Set(seqs).size).toBe(3);
  });
});
