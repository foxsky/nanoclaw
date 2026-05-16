/**
 * Board-config mutation MCP tools (tf-mcontrol MCP-engine migration,
 * single-engine rework R2.8 step 4). Each handler owns arg-shape
 * validation_error + person_id derivation, then delegates the mutation
 * to a TaskflowEngine method so the FastAPI surface drives the SAME
 * engine path the in-container WhatsApp agent uses:
 *   - api_update_board        → engine.updateBoard
 *   - api_add_board_person    → engine.addBoardPerson (R2.2 guard)
 *   - api_remove_board_person → engine.removeBoardPerson
 *   - api_update_board_person → engine.updateBoardPerson
 *
 * Owner authorization is NOT enforced here (R2.3): `call_mcp_mutation`
 * runs `require_board_owner` FastAPI-side before invoking the tool, and
 * the flat MCP args carry no non-agent user identity — the engine
 * methods do ZERO owner auth.
 */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { jsonResponse, requireString } from './util.js';

/** FastAPI `POST /api/v1/boards` (main.py:2719) → engine.createBoard
 *  (0f option (b): FastAPI preallocates board_id + resolves org_id /
 *  owner_user_id server-side and passes them flat; the engine inserts
 *  the row). Handler mirrors CreateBoardPayload validators
 *  (main.py:236): name trim+non-empty, description trim→null, org_id
 *  trim+non-empty. Flat args, no actor/sender_name (matches the other
 *  board tools / settled contract); owner auth is FastAPI-side. */
export const apiCreateBoardTool: McpToolDefinition = {
  tool: {
    name: 'api_create_board',
    description:
      'Create a board with a caller-preallocated board_id. org_id and owner_user_id are resolved by the API layer; owner authorization is enforced there before this tool runs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        org_id: { type: ['string', 'null'] },
        owner_user_id: { type: ['string', 'null'] },
      },
      required: ['board_id', 'name'],
    },
  },
  async handler(args) {
    // FastAPI passes the preallocated board_id verbatim. Do NOT
    // normalize/prefix it (R2.7; matches the other board tools).
    const boardId = requireString(args, 'board_id');
    if (boardId === null) {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'board_id: required string',
      });
    }

    // name: required; trim; empty-after-trim rejected (parity with
    // CreateBoardPayload.validate_name).
    if (typeof args.name !== 'string') {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'name: expected string',
      });
    }
    const name = args.name.trim();
    if (name === '') {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'Board name cannot be empty',
      });
    }

    // description: optional; null or trimmed (whitespace/empty → null).
    let description: string | null = null;
    if (args.description !== undefined && args.description !== null) {
      if (typeof args.description !== 'string') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'description: expected string or null',
        });
      }
      description = args.description.trim() || null;
    }

    // org_id: FastAPI-resolved (guaranteed-existing); if present must be
    // a non-empty string (parity with CreateBoardPayload.validate_org_id).
    let orgId: string | null = null;
    if (args.org_id !== undefined && args.org_id !== null) {
      if (typeof args.org_id !== 'string' || args.org_id.trim() === '') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'org_id cannot be empty',
        });
      }
      orgId = args.org_id.trim();
    }

    // owner_user_id: FastAPI-supplied (= caller); pass through.
    let ownerUserId: string | null = null;
    if (args.owner_user_id !== undefined && args.owner_user_id !== null) {
      if (typeof args.owner_user_id !== 'string') {
        return jsonResponse({
          success: false,
          error_code: 'validation_error',
          error: 'owner_user_id: expected string or null',
        });
      }
      ownerUserId = args.owner_user_id;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const r = engine.createBoard(boardId, {
        name,
        description,
        owner_user_id: ownerUserId,
        org_id: orgId,
      });
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

/** FastAPI `POST /api/v1/boards/{id}/people` (main.py:2786) →
 *  engine.addBoardPerson. NOT the WhatsApp `register_person` slug/
 *  auto-provision path: FastAPI derives person_id (phone-digits/uuid4)
 *  and delegating boards are rejected (R2.2). */
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
      // Single-engine (R2.8 step 4b-iii): engine.addBoardPerson does
      // ZERO owner auth (R2.3, FastAPI-side), rejects delegating boards
      // (R2.2 hierarchy_provision_unsupported), canonicalizes the phone
      // like the WhatsApp register_person path, and goes through the
      // shared _addBoardPersonCore. Its result IS the tool payload
      // (success → {data:{ok,...}}; not_found/conflict/hierarchy_*).
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      return jsonResponse(
        engine.addBoardPerson(boardId, { person_id: personId, name, phone, role }),
      );
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
      'Remove a person from a board (single-engine: same path as the WhatsApp agent). Active non-done tasks block removal and return tasks_to_reassign unless force=true (which unassigns them). Owner authorization is enforced by the API layer before this tool runs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        person_id: { type: 'string' },
        force: { type: 'boolean' },
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
    if (args.force !== undefined && typeof args.force !== 'boolean') {
      return jsonResponse({
        success: false,
        error_code: 'validation_error',
        error: 'force: expected boolean',
      });
    }
    const force = args.force === true;

    try {
      // Single-engine (R2.8 step 4b-ii): engine.removeBoardPerson does
      // ZERO owner auth (R2.3, FastAPI-side), resolves by EXACT
      // person_id (R2.1.a), and delegates to the shared
      // _removeBoardPersonCore. Its result IS the tool payload
      // (success → {tasks_to_reassign?, data}; not_found → error_code).
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      return jsonResponse(engine.removeBoardPerson(boardId, personId, force));
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
      // Single-engine (R2.8 4b-iv; Codex post-impl IMPORTANT 3
      // hardening): ONE transactional engine.updateBoardPerson — single
      // board/person existence check, atomic wip+role (the prior
      // two-method sequence re-checked between fields, so a mid-call
      // delete could leave wip changed yet return not_found on role).
      // ZERO owner auth (R2.3, FastAPI-side). Behavior-preserving — the
      // FastAPI contract is unchanged (handler still owns every
      // validation_error + builds the echo from validated args).
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const fields: { wip_limit?: number | null; role?: string } = {};
      if ('wip_limit' in args) fields.wip_limit = (wip ?? null) as number | null;
      if (role !== undefined && role !== null) fields.role = (role as string).trim();
      const r = engine.updateBoardPerson(boardId, personId, fields);
      if (!r.success) return jsonResponse(r);
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
  apiCreateBoardTool,
  apiUpdateBoardTool,
  apiAddBoardPersonTool,
  apiRemoveBoardPersonTool,
  apiUpdateBoardPersonTool,
]);
