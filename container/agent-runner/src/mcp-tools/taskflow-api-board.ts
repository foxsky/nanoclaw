/**
 * Board-config mutation MCP tools (Phase 1 of the tf-mcontrol MCP-engine
 * migration). Pure-SQL parity with the FastAPI handlers — no engine
 * method (mirrors api_update_simple_task: logic lives in the handler).
 *
 * Owner authorization is NOT enforced here: `call_mcp_mutation` runs
 * `require_board_owner` FastAPI-side before invoking the tool, and the
 * flat MCP args carry no non-agent user identity. Engine tools do the
 * mutation only.
 */
import { getTaskflowDb } from '../db/connection.js';
import { registerTools } from './server.js';
import { normalizeAgentIds } from './taskflow-helpers.js';
import type { McpToolDefinition } from './types.js';
import { jsonResponse, requireString } from './util.js';

/** Parity: FastAPI `PATCH /api/v1/boards/{id}` (main.py:2744) +
 *  UpdateBoardPayload validators (main.py:268-288). */
export const apiUpdateBoardTool: McpToolDefinition = {
  tool: {
    name: 'api_update_board',
    description:
      "Update a board's name and/or description. Owner authorization is enforced by the API layer before this tool runs.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        name: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
      },
      required: ['board_id'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'board_id: required string',
      });
    }

    const sets: string[] = [];
    const values: (string | null)[] = [];

    // name: validate_name — None/absent skips; a string is trimmed and
    // must be non-empty.
    if ('name' in args && args.name !== undefined && args.name !== null) {
      if (typeof args.name !== 'string') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'name: expected string',
        });
      }
      const trimmed = args.name.trim();
      if (trimmed === '') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'Board name cannot be empty',
        });
      }
      sets.push('name = ?');
      values.push(trimmed);
    }

    // description: validate_description + handler `if "description" in
    // updates` — present (incl. explicit null) is a write; whitespace or
    // empty collapses to NULL.
    if ('description' in args && args.description !== undefined) {
      if (args.description !== null && typeof args.description !== 'string') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'description: expected string or null',
        });
      }
      const d =
        args.description === null ? null : (args.description as string).trim() || null;
      sets.push('description = ?');
      values.push(d);
    }

    try {
      const db = getTaskflowDb();
      const existing = db
        .prepare('SELECT * FROM boards WHERE id = ?')
        .get(boardId) as Record<string, unknown> | null;
      if (!existing) {
        return jsonResponse({
          success: false,
          error_code: 'not_found',
          error: 'Board not found',
        });
      }
      if (sets.length === 0) {
        // FastAPI returns the unchanged row, no updated_at bump.
        return jsonResponse({ success: true, data: existing });
      }
      sets.push("updated_at = datetime('now')");
      db.prepare(`UPDATE boards SET ${sets.join(', ')} WHERE id = ?`).run(
        ...values,
        boardId,
      );
      const row = db
        .prepare('SELECT * FROM boards WHERE id = ?')
        .get(boardId) as Record<string, unknown>;
      return jsonResponse({ success: true, data: row });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error_code: 'internal_error', error: msg });
    }
  },
};

registerTools([apiUpdateBoardTool]);
