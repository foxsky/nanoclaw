import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
import { closeTaskflowDb } from '../db/connection.js';
import { setVerbatimIds } from './taskflow-helpers.js';
import {
  applyBoardConfigColumns,
  applyServedReadSchema,
  setupEngineDb,
} from './taskflow-test-fixtures.js';
import {
  apiBoardDetailTool,
  apiBoardTasksTool,
  apiListCommentsTool,
  apiListHolidaysTool,
  apiRunnerStatusTool,
} from './taskflow-api-serialized-read.js';

/**
 * R5 (INBOUND tf-mcontrol 2026-06-10): five serialized, board-scoped READ tools
 * so the dashboard routes taskflow-domain reads through the engine instead of
 * replicating `visibleTaskScope` + enrichment (board_code / board_timezone /
 * assignee-name) in Python. Each returns the SAME serialized shape the engine
 * already produces (`serializeApiTask` + board_timezone), so FastAPI does ZERO
 * enrichment. Tested through the real MCP handlers (the surface FastAPI calls).
 */
const BOARD = 'board-r5';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD);
  applyBoardConfigColumns(db); // boards.phone etc.
  applyServedReadSchema(db); // board_config + runner-cron columns
  // setupEngineDb seeds no board_runtime_config row; insert one with a non-default
  // timezone so the per-task board_timezone JOIN is observable (not the fallback).
  db.prepare(
    `INSERT INTO board_runtime_config (board_id, language, timezone, standup_cron_local, digest_cron_local, review_cron_local)
     VALUES (?, 'pt-BR', 'America/Sao_Paulo', '0 9 * * 1-5', '0 18 * * 1-5', '0 8 * * 1')`,
  ).run(BOARD);
  db.prepare(
    `INSERT INTO board_config (board_id, columns, wip_limit) VALUES (?, '["inbox","next_action","done"]', 7)`,
  ).run(BOARD);
  // A second person so assignee-name resolution is observable.
  db.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'Bob', 'member')`,
  ).run(BOARD);
  setVerbatimIds(true); // FastAPI subprocess is always verbatim
});
afterEach(() => {
  setVerbatimIds(false);
  closeTaskflowDb();
});

function seedTask(
  id: string,
  fields: Partial<{
    title: string;
    assignee: string | null;
    column: string;
    priority: string | null;
    due_date: string | null;
    labels: string;
    parent_task_id: string | null;
    type: string;
    created_at: string;
    updated_at: string;
  }> = {},
) {
  db.prepare(
    `INSERT INTO tasks (board_id, id, type, title, assignee, "column", priority, due_date, labels, parent_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    BOARD,
    id,
    fields.type ?? 'simple',
    fields.title ?? `Task ${id}`,
    fields.assignee ?? null,
    fields.column ?? 'inbox',
    fields.priority ?? null,
    fields.due_date ?? null,
    fields.labels ?? '[]',
    fields.parent_task_id ?? null,
    fields.created_at ?? '2026-06-01T00:00:00.000Z',
    fields.updated_at ?? '2026-06-01T00:00:00.000Z',
  );
}

async function call(tool: { handler: (a: Record<string, unknown>) => Promise<unknown> | unknown }, args: Record<string, unknown>) {
  const res = (await tool.handler({ board_id: BOARD, ...args })) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0].text);
}

describe('R5 api_board_tasks — serialized visible-scope board read', () => {
  it('returns serializeApiTask-shape tasks with board_code, board_timezone, assignee NAME, parsed labels, parent_task_title', async () => {
    seedTask('P1', { type: 'project', title: 'Big Project' });
    seedTask('T1', {
      title: 'Child task',
      assignee: 'bob',
      column: 'next_action',
      priority: 'high',
      labels: '["urgent","ops"]',
      parent_task_id: 'P1',
    });
    const r = await call(apiBoardTasksTool, {});
    expect(r.success).toBe(true);
    const t1 = (r.data as Array<Record<string, unknown>>).find((t) => t.id === 'T1')!;
    expect(t1.board_code).toBe('TF');
    expect(t1.board_timezone).toBe('America/Sao_Paulo'); // owning-board tz, NOT the default
    expect(t1.assignee).toBe('Bob'); // person_id resolved to display NAME (drift kill)
    expect(t1.priority).toBe('alta'); // normalized
    expect(t1.labels).toEqual(['urgent', 'ops']); // parsed array, not a JSON string
    expect(t1.parent_task_title).toBe('Big Project');
  });

  it('filters by the optional column arg and rejects an invalid column with validation_error', async () => {
    seedTask('T1', { column: 'inbox' });
    seedTask('T2', { column: 'next_action' });
    const r = await call(apiBoardTasksTool, { column: 'next_action' });
    expect(r.success).toBe(true);
    const ids = (r.data as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(['T2']);

    const bad = await call(apiBoardTasksTool, { column: 'bogus' });
    expect(bad.success).toBe(false);
    expect(bad.error_code).toBe('validation_error');
  });

  it('orders by COALESCE(updated_at, created_at) DESC, id ASC', async () => {
    seedTask('T1', { updated_at: '2026-06-01T00:00:00.000Z' });
    seedTask('T2', { updated_at: '2026-06-03T00:00:00.000Z' });
    seedTask('T3', { updated_at: '2026-06-02T00:00:00.000Z' });
    const r = await call(apiBoardTasksTool, {});
    expect((r.data as Array<{ id: string }>).map((t) => t.id)).toEqual(['T2', 'T3', 'T1']);
  });

  it('returns not_found for a non-existent board', async () => {
    setVerbatimIds(true);
    const res = (await apiBoardTasksTool.handler({ board_id: 'ghost-board' })) as {
      content: Array<{ text: string }>;
    };
    const r = JSON.parse(res.content[0].text);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });

  it('honors visibleTaskScope: includes a task delegated IN from a parent board, with the OWNING board code/timezone', async () => {
    // A parent board owns PT1 and delegates it to BOARD for execution. The
    // dashboard's board view must show it (the whole reason these tools exist is
    // to stop FastAPI re-implementing this scope in Python and drifting).
    db.prepare(
      `INSERT INTO boards (id, short_code, name) VALUES ('parent-board', 'PB', 'Parent')`,
    ).run();
    db.prepare(
      `INSERT INTO board_runtime_config (board_id, language, timezone) VALUES ('parent-board', 'pt-BR', 'America/Manaus')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (board_id, id, type, title, "column", child_exec_board_id, child_exec_enabled, created_at, updated_at)
       VALUES ('parent-board', 'PT1', 'simple', 'Delegated work', 'in_progress', ?, 1, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z')`,
    ).run(BOARD);
    seedTask('T1', { column: 'inbox' });
    const r = await call(apiBoardTasksTool, {});
    const delegated = (r.data as Array<Record<string, unknown>>).find((t) => t.id === 'PT1')!;
    expect(delegated).toBeTruthy();
    expect(delegated.board_id).toBe('parent-board'); // owning board, not the viewing board
    expect(delegated.board_code).toBe('PB');
    expect(delegated.board_timezone).toBe('America/Manaus'); // owning board's tz
  });

  it('does NOT leak a task from an unrelated board (not delegated in) — cross-board scope boundary', async () => {
    // A task on another board with NO delegation to BOARD must be invisible. These
    // tools are FastAPI-facing, so a scope hole here is a cross-board data leak.
    db.prepare(
      `INSERT INTO boards (id, short_code, name) VALUES ('other-board', 'OB', 'Other')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (board_id, id, type, title, "column", created_at, updated_at)
       VALUES ('other-board', 'OT1', 'simple', 'Secret', 'inbox', '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z')`,
    ).run();
    seedTask('T1', { column: 'inbox' });
    const r = await call(apiBoardTasksTool, {});
    const ids = (r.data as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain('T1');
    expect(ids).not.toContain('OT1');
  });
});

describe('R5 cross-board read boundary', () => {
  it('api_list_comments returns not_found for a task on an unrelated board (board-scoped getTask)', async () => {
    db.prepare(
      `INSERT INTO boards (id, short_code, name) VALUES ('other-board', 'OB', 'Other')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (board_id, id, type, title, "column", created_at, updated_at)
       VALUES ('other-board', 'OT1', 'simple', 'Secret', 'inbox', '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES ('other-board', 'OT1', 'comment', 'x', '2026-06-05T01:00:00.000Z', 'leak?')`,
    ).run();
    const r = await call(apiListCommentsTool, { task_id: 'OT1' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});

describe('R5 api_board_detail — composite config read', () => {
  it('returns board meta + columns/wip + language/timezone/cron + people + tasks_by_column', async () => {
    seedTask('T1', { column: 'inbox' });
    seedTask('T2', { column: 'inbox' });
    seedTask('T3', { column: 'next_action' });
    const r = await call(apiBoardDetailTool, {});
    expect(r.success).toBe(true);
    const d = r.data as Record<string, unknown>;
    expect((d.board as Record<string, unknown>).id).toBe(BOARD);
    expect((d.board as Record<string, unknown>).short_code).toBe('TF');
    expect(d.language).toBe('pt-BR');
    expect(d.timezone).toBe('America/Sao_Paulo');
    expect(d.wip_limit).toBe(7);
    expect(d.columns).toEqual(['inbox', 'next_action', 'done']);
    expect(d.standup_cron_local).toBe('0 9 * * 1-5');
    const people = d.people as Array<{ name: string }>;
    expect(people.map((p) => p.name)).toEqual(['Bob', 'alice']); // ORDER BY name ASC
    expect(d.tasks_by_column).toEqual({ inbox: 2, next_action: 1 });
  });

  it('returns not_found for a non-existent board', async () => {
    const res = (await apiBoardDetailTool.handler({ board_id: 'ghost-board' })) as {
      content: Array<{ text: string }>;
    };
    const r = JSON.parse(res.content[0].text);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});

describe('R5 api_list_holidays', () => {
  it('returns [{date,label}] sorted by date', async () => {
    db.prepare(`INSERT INTO board_holidays (board_id, holiday_date, label) VALUES (?, '2026-12-25', 'Natal')`).run(BOARD);
    db.prepare(`INSERT INTO board_holidays (board_id, holiday_date, label) VALUES (?, '2026-09-07', 'Independência')`).run(BOARD);
    const r = await call(apiListHolidaysTool, {});
    expect(r.success).toBe(true);
    expect(r.data).toEqual([
      { date: '2026-09-07', label: 'Independência' },
      { date: '2026-12-25', label: 'Natal' },
    ]);
  });
});

describe('R5 api_list_comments', () => {
  it('returns {id,author,message,created_at} with author resolved to display NAME, ordered oldest-first', async () => {
    seedTask('T1', { assignee: 'alice' });
    db.prepare(
      `INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, 'T1', 'comment', 'bob', '2026-06-02T10:00:00.000Z', 'first')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, 'T1', 'comment', 'alice', '2026-06-02T11:00:00.000Z', 'second')`,
    ).run(BOARD);
    // a non-comment row must be excluded
    db.prepare(
      `INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, 'T1', 'move', 'bob', '2026-06-02T12:00:00.000Z', 'moved')`,
    ).run(BOARD);
    const r = await call(apiListCommentsTool, { task_id: 'T1' });
    expect(r.success).toBe(true);
    const data = r.data as Array<Record<string, unknown>>;
    expect(data.map((c) => c.message)).toEqual(['first', 'second']);
    expect(data[0].author).toBe('Bob'); // person_id 'bob' → 'Bob'
    expect(data[1].author).toBe('alice');
    expect(data[0].created_at).toBe('2026-06-02T10:00:00.000Z');
  });

  it('returns not_found for a non-existent task', async () => {
    const r = await call(apiListCommentsTool, { task_id: 'NOPE' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});

describe('R5 api_runner_status', () => {
  it('returns the board cron config', async () => {
    const r = await call(apiRunnerStatusTool, {});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      board_id: BOARD,
      standup_cron_local: '0 9 * * 1-5',
      digest_cron_local: '0 18 * * 1-5',
      review_cron_local: '0 8 * * 1',
    });
  });
});

describe('R5 FastAPI-only registration invariant', () => {
  it('the chat barrel (mcp-tools/index.ts) does NOT import the serialized-read tools', () => {
    // These five reads are registered ONLY by taskflow-server-entry.ts (FastAPI) and
    // allowlisted there — keeping them off the in-container WhatsApp agent's tool list
    // (tool-selection hygiene). An accidental chat-barrel import would expose 5 redundant
    // own-board reads (board-pinned by normalizeAgentIds, so not a cross-board leak, but
    // still a contract regression). A source-string assertion pins the invariant — no test
    // would otherwise fail on a stray import (precedent: subprocess-gate invariant).
    const barrel = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');
    expect(barrel).not.toContain('taskflow-api-serialized-read');
  });
});
