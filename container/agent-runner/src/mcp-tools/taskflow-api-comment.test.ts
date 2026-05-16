import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

/**
 * `api_task_add_comment` MCP tool — flat FastAPI contract (mirrors
 * `add_task_comment` / `CreateCommentPayload` at main.py:151,3512).
 * Author is resolved FastAPI-side and passed flat (no sender_name /
 * actor parsing — R2.3). board_id is VERBATIM (handoff BLOCKER: the
 * `normalizeAgentIds` board-prefix breaks plain-UUID web-POST boards);
 * task_id IS uppercased (handoff explicitly names this tool). Returns
 * the FastAPI-parity 201 body as `data` plus `notification_events`
 * (kept as past-tense observability — owner decision 2026-05-16; the
 * WhatsApp host path delivers them, FastAPI ignores them post-0j-a).
 */
const SEED = 'board-x1';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(SEED, { withBoardAdmins: true });
  db.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid) VALUES (?, 'bob', 'Bob', 'member', 'g-bob@x')`,
  ).run(SEED);
  db.prepare(
    `INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('T1', ?, 'Fix login', 'bob', '2026-01-01', '2026-01-01')`,
  ).run(SEED);
});

afterEach(() => {
  closeTaskflowDb();
});

async function call(args: Record<string, unknown>) {
  const { apiTaskAddCommentTool } = await import('./taskflow-api-comment.ts');
  return JSON.parse((await apiTaskAddCommentTool.handler(args)).content[0].text);
}

describe('api_task_add_comment MCP tool (engine-backed)', () => {
  it('exports a tool named api_task_add_comment', async () => {
    const { apiTaskAddCommentTool } = await import('./taskflow-api-comment.ts');
    expect(apiTaskAddCommentTool.tool.name).toBe('api_task_add_comment');
  });

  it('writes the comment and returns the FastAPI 201 parity body as data', async () => {
    const r = await call({
      board_id: SEED,
      task_id: 'T1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'looks broken',
    });
    expect(r.success).toBe(true);
    expect(r.data.task_id).toBe('T1');
    expect(r.data.author_id).toBe('alice');
    expect(r.data.author_name).toBe('Alice');
    expect(r.data.message).toBe('looks broken');
    expect(typeof r.data.id).toBe('number');
    const row = db
      .prepare(
        `SELECT "by", details FROM task_history WHERE board_id=? AND task_id='T1' AND action='comment'`,
      )
      .get(SEED) as { by: string; details: string };
    expect(row).toEqual({ by: 'alice', details: 'looks broken' });
  });

  it('emits notification_events for the assignee (kept; past-tense observability)', async () => {
    const r = await call({
      board_id: SEED,
      task_id: 'T1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'please check',
    });
    expect(Array.isArray(r.notification_events)).toBe(true);
    expect(r.notification_events.length).toBe(1);
    expect(r.notification_events[0].message).toContain('please check');
    expect(r.notification_events[0].message).not.toContain('Digite');
  });

  it('uses board_id VERBATIM — never board-prefixes (handoff plain-UUID BLOCKER)', async () => {
    const UUID = '550e8400-e29b-41d4-a716-446655440000';
    db.prepare(`INSERT INTO boards (id, short_code, name) VALUES (?, 'UU', 'U')`).run(UUID);
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, created_at, updated_at) VALUES ('T9', ?, 't', '2026-01-01', '2026-01-01')`,
    ).run(UUID);
    const r = await call({
      board_id: UUID,
      task_id: 'T9',
      author_id: 'svc',
      author_name: 'svc',
      message: 'hi',
    });
    expect(r.success).toBe(true);
    expect(
      db.prepare(`SELECT 1 FROM task_history WHERE board_id=? AND action='comment'`).get(UUID),
    ).not.toBeNull();
    expect(
      db.prepare(`SELECT 1 FROM task_history WHERE board_id='board-' || ?`).get(UUID),
    ).toBeNull();
  });

  it('uppercases task_id (handoff: api_task_add_comment needs task-id normalization)', async () => {
    const r = await call({
      board_id: SEED,
      task_id: 't1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'lowercased id',
    });
    expect(r.success).toBe(true);
    expect(r.data.task_id).toBe('T1');
  });

  it('mirrors CreateCommentPayload validators (author_id + message required, non-empty after trim)', async () => {
    expect((await call({ board_id: SEED, task_id: 'T1', author_id: '  ', message: 'x' })).error_code).toBe(
      'validation_error',
    );
    expect(
      (await call({ board_id: SEED, task_id: 'T1', author_id: 'alice', message: '   ' })).error_code,
    ).toBe('validation_error');
    expect((await call({ board_id: SEED, task_id: 'T1', author_id: 'alice' })).error_code).toBe(
      'validation_error',
    );
  });

  it('passes through engine not_found for a missing task', async () => {
    const r = await call({
      board_id: SEED,
      task_id: 'NOPE',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'x',
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});
