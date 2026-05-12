/**
 * Read-side TaskFlow MCP tools: handler-direct tests against an in-memory
 * TaskFlow DB seeded with a small board fixture (b1 + tasks t1..t7).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  closeTaskflowDb,
  initTestTaskflowDb,
} from '../db/connection.js';

let db: Database;

function seedReadFixtures(d: Database): void {
  // Two engine code paths use DIFFERENT "today" sources:
  //   - apiBoardActivity changes_today uses SQLite `date('now', 'localtime')`.
  //   - apiFilterBoardTasks due_today uses JS `localDateString(new Date())`.
  // Under bun:test these can disagree because the JS runtime reports
  // `Intl.tz: UTC` while SQLite's C++ layer honors the OS-level TZ. So we
  // seed each fixture with the source its own filter consults. The history
  // row uses SQLite-now; the task due_date fields use JS-now. Within each
  // filter the comparison is self-consistent regardless of timezone drift.
  const localTodaySql = (d.prepare(`SELECT date('now', 'localtime') AS d`).get() as { d: string }).d;
  const now = new Date();
  const localTodayJs =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // "due this week" filter spans today..today+6 (JS local). Anchor on JS.
  const threeDaysJs = new Date(Date.now() + 3 * 86400 * 1000);
  const threeDaysStr =
    `${threeDaysJs.getFullYear()}-${String(threeDaysJs.getMonth() + 1).padStart(2, '0')}-${String(threeDaysJs.getDate()).padStart(2, '0')}`;
  // `todayStr` is the variable used by the existing seed SQL below — point
  // it at the JS-side value so the due_date fixtures stay aligned with
  // apiFilterBoardTasks. The history row uses `localTodaySql` directly.
  const todayStr = localTodayJs;
  d.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, short_code TEXT, name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL,
      title TEXT NOT NULL, "column" TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'simple',
      assignee TEXT, priority TEXT, due_date TEXT, labels TEXT,
      description TEXT, notes TEXT, parent_task_id TEXT, scheduled_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      child_exec_board_id TEXT, child_exec_person_id TEXT,
      child_exec_rollup_status TEXT
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL, task_id TEXT NOT NULL,
      action TEXT NOT NULL, "by" TEXT,
      "at" TEXT NOT NULL, details TEXT
    );
    INSERT INTO boards VALUES ('board-b1', 'TF', 'Test Board', '2024-01-01T00:00:00Z');
    INSERT INTO tasks (
      id, board_id, title, "column", type, assignee, priority, due_date, labels,
      description, notes, parent_task_id, scheduled_at, created_at, updated_at,
      child_exec_board_id, child_exec_person_id, child_exec_rollup_status
    ) VALUES
      ('t1','board-b1','Urgent Task','todo','simple','alice','urgente','2099-01-01','["bug"]',NULL,'[{"id":"n1","author":"alice","content":"seed note","created_at":"2024-01-01T00:00:00Z"}]',NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t2','board-b1','Overdue Task','todo','simple',NULL,NULL,'2020-01-01',NULL,NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t3','board-b1','Linked Task','todo','simple',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z','child-board-1',NULL,NULL),
      ('t4','board-b1','Done Task','done','simple',NULL,NULL,'2020-01-01',NULL,NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t5','board-b1','Due Today Task','todo','simple',NULL,NULL,'${todayStr}','[]',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t6','board-b1','Due This Week Task','todo','simple',NULL,NULL,'${threeDaysStr}','["backend"]',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL),
      ('t7','board-b1','High Priority Task','todo','simple',NULL,'alta','2099-02-01','[]',NULL,NULL,NULL,NULL,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z',NULL,NULL,NULL);
    INSERT INTO task_history (board_id, task_id, action, "by", "at", details)
      VALUES
        ('board-b1','t2','update','alice', '2020-01-01T00:00:00Z', '{"source":"old"}'),
        ('board-b1','t1','create','alice', '${localTodaySql}T12:00:00', '{"source":"seed"}');
  `);
}

beforeEach(() => {
  db = initTestTaskflowDb();
  seedReadFixtures(db);
});

afterEach(() => {
  closeTaskflowDb();
});

function rowsFromResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text).rows as Array<Record<string, unknown>>;
}

describe('api_board_activity MCP tool', () => {
  it('exports a tool definition with name "api_board_activity"', async () => {
    const { apiBoardActivityTool } = await import('./taskflow-api-read.ts');
    expect(apiBoardActivityTool.tool.name).toBe('api_board_activity');
  });

  it('does not advertise board_id (env-injected) and exposes mode/since', async () => {
    // v1 parity: agent never sees board_id. The host injects it from
    // NANOCLAW_TASKFLOW_BOARD_ID at the MCP boundary, identical to v1's
    // `engine.X({ ...args, board_id: boardId })` pattern. Advertising the
    // property would mislead the model — env-overwrite makes any agent
    // value silently ignored (Codex IMPORTANT 2026-05-11).
    const { apiBoardActivityTool } = await import('./taskflow-api-read.ts');
    const schema = apiBoardActivityTool.tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual([]);
    expect(schema.properties).not.toHaveProperty('board_id');
    expect(schema.properties).toHaveProperty('mode');
    expect(schema.properties).toHaveProperty('since');
  });

  it('returns history rows for changes_today', async () => {
    const { apiBoardActivityTool } = await import('./taskflow-api-read.ts');
    const result = await apiBoardActivityTool.handler({ board_id: 'board-b1', mode: 'changes_today' });
    const rows = rowsFromResult(result);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('board_id', 'board-b1');
    expect(row).toHaveProperty('task_id');
    expect(row).toHaveProperty('action');
    expect(row).toHaveProperty('by');
    expect(row).toHaveProperty('at');
    expect(row).toHaveProperty('details');
  });

  it('returns history rows for changes_since', async () => {
    const { apiBoardActivityTool } = await import('./taskflow-api-read.ts');
    const result = await apiBoardActivityTool.handler({
      board_id: 'board-b1',
      mode: 'changes_since',
      since: '2021-01-01T00:00:00Z',
    });
    const rows = rowsFromResult(result);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('create');
    expect(rows[0].details).toEqual({ source: 'seed' });
  });
});

describe('api_filter_board_tasks MCP tool', () => {
  it('exports a tool definition with name "api_filter_board_tasks"', async () => {
    const { apiFilterBoardTasksTool } = await import('./taskflow-api-read.ts');
    expect(apiFilterBoardTasksTool.tool.name).toBe('api_filter_board_tasks');
  });

  it('declares board_id and filter required, label optional', async () => {
    const { apiFilterBoardTasksTool } = await import('./taskflow-api-read.ts');
    const schema = apiFilterBoardTasksTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['filter']));
    expect(schema.properties).toHaveProperty('label');
  });

  it('documents valid filters and routes project IDs to api_query task_details', async () => {
    const { apiFilterBoardTasksTool } = await import('./taskflow-api-read.ts');
    expect(apiFilterBoardTasksTool.tool.description).toContain('overdue');
    expect(apiFilterBoardTasksTool.tool.description).toContain('task_details');
    expect(apiFilterBoardTasksTool.tool.description).toContain('P11');
  });

  it('returns urgent tasks with notes + labels arrays', async () => {
    const { apiFilterBoardTasksTool } = await import('./taskflow-api-read.ts');
    const result = await apiFilterBoardTasksTool.handler({ board_id: 'board-b1', filter: 'urgent' });
    const rows = rowsFromResult(result);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('t1');
    expect(rows[0].priority).toBe('urgente');
    expect(rows[0].board_code).toBe('TF');
    expect(Array.isArray(rows[0].labels)).toBe(true);
    expect(Array.isArray(rows[0].notes)).toBe(true);
    expect((rows[0].notes as unknown[]).length).toBe(1);
  });

  it('supports overdue, due_today, due_this_week, high_priority, by_label filters', async () => {
    const { apiFilterBoardTasksTool } = await import('./taskflow-api-read.ts');
    const ids = async (filter: string, extra: Record<string, unknown> = {}) => {
      const r = await apiFilterBoardTasksTool.handler({ board_id: 'board-b1', filter, ...extra });
      return rowsFromResult(r).map((x) => x.id);
    };
    expect(await ids('overdue')).toEqual(['t2']);
    expect(await ids('due_today')).toEqual(['t5']);
    expect(await ids('due_this_week')).toEqual(['t5', 't6']);
    expect(await ids('high_priority')).toEqual(['t7']);
    expect(await ids('by_label', { label: 'backend' })).toEqual(['t6']);
  });
});

describe('api_linked_tasks MCP tool', () => {
  it('exports a tool definition with name "api_linked_tasks"', async () => {
    const { apiLinkedTasksTool } = await import('./taskflow-api-read.ts');
    expect(apiLinkedTasksTool.tool.name).toBe('api_linked_tasks');
  });

  it('returns only tasks with child_exec_board_id', async () => {
    const { apiLinkedTasksTool } = await import('./taskflow-api-read.ts');
    const result = await apiLinkedTasksTool.handler({ board_id: 'board-b1' });
    const rows = rowsFromResult(result);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('t3');
    expect(rows[0].child_exec_board_id).toBe('child-board-1');
    expect(rows[0].parent_task_title).toBeNull();
  });
});

describe('contentFromResult helper', () => {
  it('wraps success: data into { rows }', async () => {
    const { contentFromResult } = await import('./taskflow-api-read.ts');
    const result = contentFromResult({ success: true, data: [{ id: 'x' }] });
    expect(JSON.parse(result.content[0].text)).toEqual({ rows: [{ id: 'x' }] });
  });

  it('emits success: undefined data as { rows: [] }', async () => {
    const { contentFromResult } = await import('./taskflow-api-read.ts');
    const result = contentFromResult({ success: true });
    expect(JSON.parse(result.content[0].text)).toEqual({ rows: [] });
  });

  it('wraps failure into { error }', async () => {
    const { contentFromResult } = await import('./taskflow-api-read.ts');
    const result = contentFromResult({ success: false, error: 'boom' });
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'boom' });
  });

  it('emits unknown_error when failure has no error string', async () => {
    const { contentFromResult } = await import('./taskflow-api-read.ts');
    const result = contentFromResult({ success: false });
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'unknown_error' });
  });
});

describe('v1-parity validation surface (zod equivalent)', () => {
  it('api_board_activity accepts empty-string board_id (v1 z.string() did)', async () => {
    const { apiBoardActivityTool } = await import('./taskflow-api-read.ts');
    const result = await apiBoardActivityTool.handler({ board_id: '', mode: 'changes_today' });
    expect(result.isError).toBeUndefined();
    expect(rowsFromResult(result)).toEqual([]);
  });

  it('api_board_activity rejects non-string board_id', async () => {
    const { apiBoardActivityTool } = await import('./taskflow-api-read.ts');
    const result = await apiBoardActivityTool.handler({ board_id: 42 as unknown as string });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/board_id/);
  });

  it('api_board_activity rejects unknown mode (v1 zod enum failure)', async () => {
    const { apiBoardActivityTool } = await import('./taskflow-api-read.ts');
    const result = await apiBoardActivityTool.handler({ board_id: 'board-b1', mode: 'invalid' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/mode/);
  });

  it('api_filter_board_tasks rejects non-string filter', async () => {
    const { apiFilterBoardTasksTool } = await import('./taskflow-api-read.ts');
    const result = await apiFilterBoardTasksTool.handler({ board_id: 'board-b1', filter: 7 as unknown as string });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/filter/);
  });

  it('api_linked_tasks rejects non-string board_id', async () => {
    const { apiLinkedTasksTool } = await import('./taskflow-api-read.ts');
    const result = await apiLinkedTasksTool.handler({ board_id: null as unknown as string });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/board_id/);
  });

  it('api_filter_board_tasks rejects non-string label when provided', async () => {
    const { apiFilterBoardTasksTool } = await import('./taskflow-api-read.ts');
    const result = await apiFilterBoardTasksTool.handler({
      board_id: 'board-b1',
      filter: 'urgent',
      label: 99 as unknown as string,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/label/);
  });
});

describe('tool metadata', () => {
  it('exposes concise read-tool descriptions plus filter contract details', async () => {
    const { apiBoardActivityTool, apiFilterBoardTasksTool, apiLinkedTasksTool } =
      await import('./taskflow-api-read.ts');
    expect(apiBoardActivityTool.tool.description).toBe('Board activity log');
    expect(apiFilterBoardTasksTool.tool.description).toContain('Board task filter');
    expect(apiFilterBoardTasksTool.tool.description).toContain('Valid filter values');
    expect(apiFilterBoardTasksTool.tool.description).toContain('task_details');
    expect(apiLinkedTasksTool.tool.description).toBe('Board linked tasks');
  });
});
