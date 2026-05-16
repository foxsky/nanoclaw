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
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
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
    // FastAPI passes the URL board_id verbatim (plain UUID for new
    // boards). Do NOT normalize/prefix it (R2.7; Codex 2026-05-16).
    const boardId = requireString(args, 'board_id');
    if (boardId === null) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'board_id: required string',
      });
    }

    // Handler owns arg-shape validation + normalization (validation_error);
    // the engine does the DB mutation (R2.8 step 4b-i — single-source the
    // PATCH /boards logic via engine.updateBoard).
    const fields: { name?: string; description?: string | null } = {};

    // name: None/absent skips; a string is trimmed and must be non-empty.
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
      fields.name = trimmed;
    }

    // description: present (incl. explicit null) is a write; whitespace or
    // empty collapses to NULL.
    if ('description' in args && args.description !== undefined) {
      if (args.description !== null && typeof args.description !== 'string') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'description: expected string or null',
        });
      }
      fields.description =
        args.description === null ? null : (args.description as string).trim() || null;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const r = engine.updateBoard(boardId, fields);
      if (!r.success) {
        return jsonResponse({ success: false, error_code: r.error_code, error: r.error });
      }
      return jsonResponse({ success: true, data: r.data });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error_code: 'internal_error', error: msg });
    }
  },
};

/** Parity: FastAPI `POST /api/v1/boards/{id}/people` (main.py:2786).
 *  Direct-SQL — deliberately NOT the engine `register_person` path
 *  (slug person_id, hierarchy auto-provision, different semantics). */
export const apiAddBoardPersonTool: McpToolDefinition = {
  tool: {
    name: 'api_add_board_person',
    description:
      "Add a person to a board. person_id is the phone's digits, or a uuid4 when no phone. Owner authorization is enforced by the API layer before this tool runs.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        name: { type: 'string' },
        phone: { type: ['string', 'null'] },
        role: { type: 'string' },
      },
      required: ['board_id', 'name'],
    },
  },
  async handler(args) {
    // FastAPI passes the URL board_id verbatim (plain UUID for new
    // boards). Do NOT normalize/prefix it (R2.7; Codex 2026-05-16).
    const boardId = requireString(args, 'board_id');
    if (boardId === null) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'board_id: required string',
      });
    }
    if (typeof args.name !== 'string' || args.name.trim() === '') {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'name is required',
      });
    }
    const name = args.name.trim();

    // phone: str(phone).strip() if present, else None (mirrors FastAPI).
    const phone =
      args.phone === undefined || args.phone === null
        ? null
        : String(args.phone).trim();
    // role: body.get("role","member") or "member" — absent/falsy → member;
    // not trimmed.
    const role =
      args.role === undefined || args.role === null || args.role === ''
        ? 'member'
        : String(args.role);

    let personId: string;
    if (phone) {
      personId = phone.replace(/[^0-9]/g, '');
      if (personId === '') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'phone must contain digits',
        });
      }
    } else {
      personId = crypto.randomUUID();
    }

    try {
      const db = getTaskflowDb();
      const board = db.prepare('SELECT 1 FROM boards WHERE id = ?').get(boardId);
      if (!board) {
        return jsonResponse({
          success: false,
          error_code: 'not_found',
          error: 'Board not found',
        });
      }
      const existing = db
        .prepare('SELECT person_id FROM board_people WHERE board_id = ? AND person_id = ?')
        .get(boardId, personId);
      if (existing) {
        return jsonResponse({
          success: false,
          error_code: 'conflict',
          error: 'Person already on this board',
        });
      }
      db.prepare(
        'INSERT INTO board_people (board_id, person_id, name, phone, role) VALUES (?, ?, ?, ?, ?)',
      ).run(boardId, personId, name, phone || null, role);
      return jsonResponse({
        success: true,
        data: { ok: true, person_id: personId, name, phone, role },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error_code: 'internal_error', error: msg });
    }
  },
};

/** Parity: FastAPI `DELETE /api/v1/boards/{id}/people/{pid}`
 *  (main.py:2814). 404 if the person row is absent; else delete. */
export const apiRemoveBoardPersonTool: McpToolDefinition = {
  tool: {
    name: 'api_remove_board_person',
    description:
      'Remove a person from a board. Owner authorization is enforced by the API layer before this tool runs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        person_id: { type: 'string' },
      },
      required: ['board_id', 'person_id'],
    },
  },
  async handler(args) {
    // FastAPI passes the URL board_id verbatim (plain UUID for new
    // boards). Do NOT normalize/prefix it (R2.7; Codex 2026-05-16).
    const boardId = requireString(args, 'board_id');
    if (boardId === null) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'board_id: required string',
      });
    }
    const personId = requireString(args, 'person_id');
    if (personId === null) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'person_id: required string',
      });
    }

    try {
      const db = getTaskflowDb();
      const board = db.prepare('SELECT 1 FROM boards WHERE id = ?').get(boardId);
      if (!board) {
        return jsonResponse({
          success: false,
          error_code: 'not_found',
          error: 'Board not found',
        });
      }
      const row = db
        .prepare('SELECT person_id FROM board_people WHERE board_id = ? AND person_id = ?')
        .get(boardId, personId);
      if (!row) {
        return jsonResponse({
          success: false,
          error_code: 'not_found',
          error: 'Person not found',
        });
      }
      db.prepare('DELETE FROM board_people WHERE board_id = ? AND person_id = ?').run(
        boardId,
        personId,
      );
      // FastAPI returns 204 with no body; the golden body is null.
      return jsonResponse({ success: true, data: null });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error_code: 'internal_error', error: msg });
    }
  },
};

/** Parity: FastAPI `PATCH /api/v1/boards/{id}/people/{pid}`
 *  (main.py:2919). Only wip_limit and/or role; echo response. */
export const apiUpdateBoardPersonTool: McpToolDefinition = {
  tool: {
    name: 'api_update_board_person',
    description:
      "Update a board member's wip_limit and/or role. Owner authorization is enforced by the API layer before this tool runs.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        person_id: { type: 'string' },
        wip_limit: { type: ['integer', 'null'] },
        role: { type: ['string', 'null'] },
      },
      required: ['board_id', 'person_id'],
    },
  },
  async handler(args) {
    // FastAPI passes the URL board_id verbatim (plain UUID for new
    // boards). Do NOT normalize/prefix it (R2.7; Codex 2026-05-16).
    const boardId = requireString(args, 'board_id');
    if (boardId === null) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'board_id: required string',
      });
    }
    const personId = requireString(args, 'person_id');
    if (personId === null) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'person_id: required string',
      });
    }

    // body.keys() <= {wip_limit, role} and non-empty.
    const updateKeys = Object.keys(args).filter(
      (k) => k !== 'board_id' && k !== 'person_id',
    );
    if (
      updateKeys.length === 0 ||
      updateKeys.some((k) => k !== 'wip_limit' && k !== 'role')
    ) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'Only wip_limit and/or role can be updated',
      });
    }

    const wip = args.wip_limit;
    if (wip !== undefined && wip !== null) {
      // type(wip_limit) is not int (bool/float excluded) or < 1.
      if (typeof wip !== 'number' || !Number.isInteger(wip) || wip < 1) {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'wip_limit must be a positive integer or null',
        });
      }
    }
    const role = args.role;
    if (role !== undefined && role !== null) {
      if (typeof role !== 'string' || role.trim() === '') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'role must be a non-empty string or omitted',
        });
      }
    }

    try {
      const db = getTaskflowDb();
      const board = db.prepare('SELECT 1 FROM boards WHERE id = ?').get(boardId);
      if (!board) {
        return jsonResponse({
          success: false,
          error_code: 'not_found',
          error: 'Board not found',
        });
      }
      const row = db
        .prepare('SELECT person_id FROM board_people WHERE board_id = ? AND person_id = ?')
        .get(boardId, personId);
      if (!row) {
        return jsonResponse({
          success: false,
          error_code: 'not_found',
          error: 'Person not found',
        });
      }
      if ('wip_limit' in args) {
        db.prepare(
          'UPDATE board_people SET wip_limit = ? WHERE board_id = ? AND person_id = ?',
        ).run((wip ?? null) as number | null, boardId, personId);
      }
      if (role !== undefined && role !== null) {
        db.prepare(
          'UPDATE board_people SET role = ? WHERE board_id = ? AND person_id = ?',
        ).run((role as string).trim(), boardId, personId);
      }
      return jsonResponse({
        success: true,
        data: {
          ok: true,
          person_id: personId,
          wip_limit: wip === undefined ? null : (wip as number | null),
          role:
            role === undefined || role === null ? null : (role as string).trim(),
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error_code: 'internal_error', error: msg });
    }
  },
};

registerTools([
  apiUpdateBoardTool,
  apiAddBoardPersonTool,
  apiRemoveBoardPersonTool,
  apiUpdateBoardPersonTool,
]);
