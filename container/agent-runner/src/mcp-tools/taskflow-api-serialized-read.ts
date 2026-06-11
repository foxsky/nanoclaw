/**
 * R5 (INBOUND tf-mcontrol 2026-06-10): five serialized, board-scoped READ tools
 * so the dashboard routes taskflow-domain reads through the engine instead of
 * replicating `visibleTaskScope` + enrichment (board_code / board_timezone /
 * assignee-name) in Python (read-path drift). Each returns the SAME serialized
 * shape the engine already produces, so FastAPI does ZERO enrichment.
 *
 * FastAPI-only: registered solely by `taskflow-server-entry.ts` (not the chat
 * barrel `index.ts`) and allowlisted there — the WhatsApp agent keeps its own
 * richer `api_query` surface, and adding five dashboard-shaped reads to its tool
 * list would only muddy tool selection. The five single-board reads are board-
 * scoped (board_id is pinned by `normalizeAgentIds` when not verbatim), so they
 * need no fastApiOnly fail-closed guard. EXCEPTION: `api_runner_status_batch`
 * takes an arbitrary `board_ids` list (NOT board-scoped), so it IS wrapped with
 * `fastApiOnly` — only the verbatim/FastAPI surface may read cross-board crons.
 *
 * Envelope: `{success:true, data}` / `{success:false, error_code, error}` —
 * consistent with the R1/R2/R4 structured tools so FastAPI maps not_found/
 * validation_error to the right HTTP status.
 */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine, type TaskflowResult } from '../taskflow-engine.js';
import { fastApiOnly } from './taskflow-api-board.js';
import { registerTools } from './server.js';
import { normalizeAgentIds } from './taskflow-helpers.js';
import type { McpToolDefinition } from './types.js';
import { jsonResponse, requireString } from './util.js';

// Cap the batch id-list well under SQLite's bound-parameter limit (≥999 on the
// oldest builds) so a huge list can't blow the IN clause. 500 boards is far
// beyond any real dashboard board-set; over that, the caller paginates.
const RUNNER_STATUS_BATCH_MAX = 500;

function serializedResult(result: TaskflowResult) {
  if (!result.success) {
    const code = (result as { error_code?: unknown }).error_code;
    return jsonResponse({
      success: false,
      ...(typeof code === 'string' ? { error_code: code } : {}),
      error: result.error ?? 'unknown_error',
    });
  }
  return jsonResponse({ success: true, data: result.data });
}

function readonlyEngine(boardId: string): TaskflowEngine {
  return new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
}

export const apiBoardTasksTool: McpToolDefinition = {
  tool: {
    name: 'api_board_tasks',
    description:
      'Full board read in the canonical serialized task shape (board_code, board_timezone, assignee NAME, normalized priority, parsed labels, parent_task_title), honoring visibleTaskScope (own + delegated-in). Optional column filter.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        column: { type: 'string' },
      },
      required: [],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return jsonResponse({ success: false, error_code: 'validation_error', error: 'board_id: required string' });
    let column: string | undefined;
    if (args.column !== undefined) {
      if (typeof args.column !== 'string') {
        return jsonResponse({ success: false, error_code: 'validation_error', error: 'column: expected string' });
      }
      column = args.column;
    }
    return serializedResult(readonlyEngine(boardId).apiBoardTasks({ column }));
  },
};

export const apiBoardDetailTool: McpToolDefinition = {
  tool: {
    name: 'api_board_detail',
    description:
      'Composite board config read: board meta + columns/wip + language/timezone/runner cron + people + tasks_by_column counts.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return jsonResponse({ success: false, error_code: 'validation_error', error: 'board_id: required string' });
    return serializedResult(readonlyEngine(boardId).apiBoardDetail());
  },
};

export const apiListHolidaysTool: McpToolDefinition = {
  tool: {
    name: 'api_list_holidays',
    description: 'Board holidays as [{date,label}], sorted by date.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return jsonResponse({ success: false, error_code: 'validation_error', error: 'board_id: required string' });
    return serializedResult(readonlyEngine(boardId).apiListHolidays());
  },
};

export const apiListCommentsTool: McpToolDefinition = {
  tool: {
    name: 'api_list_comments',
    description:
      'Task comments (task_history action=comment) serialized to {id,author,message,created_at}, author resolved to the board display name, oldest-first. Optional limit (1-200, default 50) / offset.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
      required: ['task_id'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return jsonResponse({ success: false, error_code: 'validation_error', error: 'board_id: required string' });
    const taskId = requireString(args, 'task_id');
    if (taskId === null) return jsonResponse({ success: false, error_code: 'validation_error', error: 'task_id: required string' });
    let limit: number | undefined;
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isInteger(args.limit)) {
        return jsonResponse({ success: false, error_code: 'validation_error', error: 'limit: expected integer' });
      }
      limit = args.limit;
    }
    let offset: number | undefined;
    if (args.offset !== undefined) {
      if (typeof args.offset !== 'number' || !Number.isInteger(args.offset)) {
        return jsonResponse({ success: false, error_code: 'validation_error', error: 'offset: expected integer' });
      }
      offset = args.offset;
    }
    return serializedResult(readonlyEngine(boardId).apiListComments({ task_id: taskId, limit, offset }));
  },
};

export const apiRunnerStatusTool: McpToolDefinition = {
  tool: {
    name: 'api_runner_status',
    description: "This board's runner cron config (standup/digest/review_cron_local).",
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return jsonResponse({ success: false, error_code: 'validation_error', error: 'board_id: required string' });
    return serializedResult(readonlyEngine(boardId).apiRunnerStatus());
  },
};

export const apiRunnerStatusBatchTool: McpToolDefinition = {
  tool: {
    name: 'api_runner_status_batch',
    description:
      'Runner cron config (standup/digest/review_cron_local) for a SET of boards in ONE call — replaces the per-board api_runner_status fan-out. Returns one row per requested board id (request order; null crons for a board with no runtime config). FastAPI resolves which boards the caller may see.',
    inputSchema: {
      type: 'object' as const,
      properties: { board_ids: { type: 'array', items: { type: 'string' } } },
      required: ['board_ids'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const raw = args.board_ids;
    const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
    if (ids.length === 0) {
      return jsonResponse({ success: false, error_code: 'validation_error', error: 'board_ids: required non-empty string array' });
    }
    if (ids.length > RUNNER_STATUS_BATCH_MAX) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: `board_ids: too many (max ${RUNNER_STATUS_BATCH_MAX}); paginate the board-set.`,
      });
    }
    // The engine handle's board is irrelevant — apiRunnerStatusBatch keys on the id list.
    return serializedResult(readonlyEngine(ids[0]).apiRunnerStatusBatch(ids));
  },
};

registerTools([
  apiBoardTasksTool,
  apiBoardDetailTool,
  apiListHolidaysTool,
  apiListCommentsTool,
  apiRunnerStatusTool,
  // Unlike the single board-scoped reads above, the batch tool takes an arbitrary
  // board_ids list (NOT board-scoped by normalizeAgentIds), so gate it fail-closed
  // to the verbatim/FastAPI surface — the chat agent can't read cross-board cron
  // config through it (Codex review 2026-06-11). It is also not on the chat barrel.
  fastApiOnly(apiRunnerStatusBatchTool),
]);
