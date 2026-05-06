import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
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
