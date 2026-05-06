/**
 * Read-side TaskFlow MCP tools (skill/taskflow-v2 sub-task 2.3.c).
 *
 * Wraps three v1 tools onto the v2 registry pattern:
 *   - api_board_activity      → engine.apiBoardActivity
 *   - api_filter_board_tasks  → engine.apiFilterBoardTasks
 *   - api_linked_tasks        → engine.apiLinkedTasks
 *
 * Each handler instantiates a fresh `TaskflowEngine(getTaskflowDb(),
 * board_id, { readonly: true })`. The engine's readonly path skips
 * `ensureTaskSchema()` — the host (or a test seed) must have the schema in
 * place before the tool is called.
 *
 * Validation mirrors v1's zod surface byte-for-byte: required fields are
 * `typeof === 'string'` checks (empty strings accepted, exactly as
 * `z.string()`), optional enums are strict-validated against the v1
 * allow-list, and unknown enum values return an error response (not a
 * silent coercion).
 *
 * Mutate-side tools land in 2.3.d. Helpers shared with the mutate side
 * (parseActorArg, parseNotificationEvents, normalizeEngineNotificationEvents)
 * arrive there too.
 */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err } from './util.js';

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
        board_id: { type: 'string' },
        mode: { type: 'string', enum: ['changes_today', 'changes_since'] },
        since: { type: 'string' },
      },
      required: ['board_id'],
    },
  },
  async handler(args) {
    if (typeof args.board_id !== 'string') return err('board_id: required string');
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
    const engine = new TaskflowEngine(getTaskflowDb(), args.board_id, { readonly: true });
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
        board_id: { type: 'string' },
        filter: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['board_id', 'filter'],
    },
  },
  async handler(args) {
    if (typeof args.board_id !== 'string') return err('board_id: required string');
    if (typeof args.filter !== 'string') return err('filter: required string');
    let label: string | undefined;
    if (args.label !== undefined) {
      if (typeof args.label !== 'string') return err('label: expected string');
      label = args.label;
    }
    const engine = new TaskflowEngine(getTaskflowDb(), args.board_id, { readonly: true });
    return contentFromResult(engine.apiFilterBoardTasks({ filter: args.filter, label }));
  },
};

export const apiLinkedTasksTool: McpToolDefinition = {
  tool: {
    name: 'api_linked_tasks',
    description: 'Board linked tasks',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
      },
      required: ['board_id'],
    },
  },
  async handler(args) {
    if (typeof args.board_id !== 'string') return err('board_id: required string');
    const engine = new TaskflowEngine(getTaskflowDb(), args.board_id, { readonly: true });
    return contentFromResult(engine.apiLinkedTasks());
  },
};

registerTools([apiBoardActivityTool, apiFilterBoardTasksTool, apiLinkedTasksTool]);
