/**
 * Three read-only TaskFlow MCP tools: api_board_activity,
 * api_filter_board_tasks, api_linked_tasks.
 *
 * Each handler instantiates a fresh `TaskflowEngine(getTaskflowDb(),
 * board_id, { readonly: true })`. The readonly path skips
 * `ensureTaskSchema()` — the host (or a test) must seed schema before
 * the tool is called.
 */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import { normalizeAgentIds } from './taskflow-helpers.js';
import type { McpToolDefinition } from './types.js';
import { err, requireString } from './util.js';

export function contentFromResult(result: { success: boolean; data?: unknown; error?: string }) {
  if (!result.success) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ error: result.error ?? 'unknown_error' }) },
      ],
    };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ rows: result.data ?? [] }) }],
  };
}

export const apiBoardActivityTool: McpToolDefinition = {
  tool: {
    name: 'api_board_activity',
    description: 'Board activity log',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['changes_today', 'changes_since'] },
        since: { type: 'string' },
      },
      required: [],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    let mode: 'changes_today' | 'changes_since' | undefined;
    if (args.mode !== undefined) {
      if (args.mode !== 'changes_today' && args.mode !== 'changes_since') {
        return err('mode: expected one of changes_today | changes_since');
      }
      mode = args.mode;
    }
    let since: string | undefined;
    if (args.since !== undefined) {
      if (typeof args.since !== 'string') return err('since: expected string');
      since = args.since;
    }
    const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
    return contentFromResult(engine.apiBoardActivity({ mode, since }));
  },
};

export const apiFilterBoardTasksTool: McpToolDefinition = {
  tool: {
    name: 'api_filter_board_tasks',
    description: 'Board task filter',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filter: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['filter'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const filter = requireString(args, 'filter');
    if (filter === null) return err('filter: required string');
    let label: string | undefined;
    if (args.label !== undefined) {
      if (typeof args.label !== 'string') return err('label: expected string');
      label = args.label;
    }
    const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
    return contentFromResult(engine.apiFilterBoardTasks({ filter, label }));
  },
};

export const apiLinkedTasksTool: McpToolDefinition = {
  tool: {
    name: 'api_linked_tasks',
    description: 'Board linked tasks',
    inputSchema: {
      type: 'object' as const,
      properties: {
      },
      required: [],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
    return contentFromResult(engine.apiLinkedTasks());
  },
};

registerTools([apiBoardActivityTool, apiFilterBoardTasksTool, apiLinkedTasksTool]);
