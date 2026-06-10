import { writeMessageOut } from '../db/messages-out.js';
import { evaluateDestructiveAction } from './destructive-gate.js';
import { registerTools } from './server.js';
import { isApprovedReplay, parkForApproval, registerApprovedExecutor } from './taskflow-approval.js';
import { getVerbatimIds } from './taskflow-helpers.js';
import type { McpToolDefinition } from './types.js';
import { err, generateId, log, nonEmptyString, ok } from './util.js';

export const createGroupTool: McpToolDefinition = {
  tool: {
    name: 'create_group',
    description:
      "Create a new WhatsApp group with the given subject and participants. Allowed from the operator's main control chat OR from a TaskFlow board with depth headroom (parent.hierarchy_level + 1 ≤ parent.max_depth). Calls from elsewhere are silently dropped on the host. Use provision_root_board / provision_child_board to provision a board with a group; this tool is for groups WITHOUT a board.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'Group subject (max 100 chars).' },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of <digits>@s.whatsapp.net JIDs (1-256, deduplicated).',
        },
      },
      required: ['subject', 'participants'],
    },
  },
  async handler(args) {
    if (!nonEmptyString(args.subject)) return err('subject is required and must be a non-empty string');
    if (!Array.isArray(args.participants) || args.participants.length === 0) {
      return err('participants is required and must be a non-empty array');
    }

    // SEC#11 (Codex whole-epic sign-off): create_group opens a NEW WhatsApp group with an
    // attacker-choosable subject + participant list — an injection-reachable network side effect (spam
    // groups, adding an attacker's number). Hold board-chat calls for admin approval; main-control (no
    // NANOCLAW_TASKFLOW_BOARD_ID) and FastAPI/verbatim bypass, and the approved replay re-emits the row.
    if (process.env.NANOCLAW_TASKFLOW_BOARD_ID && !getVerbatimIds() && !isApprovedReplay()) {
      return parkForApproval({
        tool: 'create_group',
        args,
        decision: evaluateDestructiveAction({ kind: 'structure', adminAction: 'create_group' }),
        summary: `create WhatsApp group "${String(args.subject)}" (${(args.participants as unknown[]).length} participants)`,
      });
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'create_group', ...args }),
    });

    log(`create_group: ${requestId} → "${args.subject}" (${args.participants.length} participants)`);
    return ok(
      `Group create request submitted (id=${requestId}). The host validates auth + subject + participants then calls adapter.createGroup. Fire-and-forget.`,
    );
  },
};

registerTools([createGroupTool]);
// #407/#411 wiring (see approved-executors.ts for the main-process registration): approved replay
// re-invokes this handler under isApprovedReplay(), bypassing the gate to emit the real create row.
registerApprovedExecutor('create_group', (args) => createGroupTool.handler(args));
