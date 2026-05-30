/**
 * rename_board_person MCP tool — container side (skill/taskflow-v2).
 *
 * Corrects a board member's display NAME (e.g. fix a name truncated by
 * auto-provisioning). Like send_otp / provision_*, this is a MAIN-CONTROL-gated
 * delivery action: the tool writes a `kind:'system'` outbound row
 * `{ action: 'rename_board_person', board_id, person_id, name }`, and the host
 * handler (src/modules/taskflow/rename-board-person.ts) enforces the
 * is_main_control gate and applies the rename. Fire-and-forget — a non-main
 * caller is ack'd here but silently dropped by the host.
 *
 * Name is per-PERSON identity, so the host rewrites it on EVERY board the person
 * belongs to (`board_people.name` is denormalized per board; the init name-heal
 * reconciles by person_id). The cross-board write is exactly why it is
 * main-control-gated rather than exposed to the per-board FastAPI surface.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err, generateId, log, nonEmptyString, ok } from './util.js';

export const renameBoardPersonTool: McpToolDefinition = {
  tool: {
    name: 'rename_board_person',
    description:
      "Correct a board member's display NAME. Only callable from the operator-designated main control chat — calls from elsewhere are silently dropped on the host. The name is the person's identity, so it is applied across ALL boards the person belongs to. Fire-and-forget: the ack returns when submitted, not when applied. For board-scoped wip_limit/role use api_update_board_person.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string', description: 'A board the person is on (locates the person).' },
        person_id: { type: 'string' },
        name: { type: 'string', description: 'The corrected display name (non-empty).' },
      },
      required: ['board_id', 'person_id', 'name'],
    },
  },
  async handler(args) {
    const boardId = nonEmptyString(args.board_id);
    if (!boardId) return err('board_id is required and must be a non-empty string');
    const personId = nonEmptyString(args.person_id);
    if (!personId) return err('person_id is required and must be a non-empty string');
    const name = nonEmptyString(args.name);
    if (!name) return err('name is required and must be a non-empty string');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'rename_board_person', board_id: boardId, person_id: personId, name }),
    });

    log(`rename_board_person: ${requestId} → ${personId} ("${name}")`);
    return ok(
      `Rename submitted (id=${requestId}). Fire-and-forget — host applies it across the person's boards, only from the main control chat.`,
    );
  },
};

registerTools([renameBoardPersonTool]);
