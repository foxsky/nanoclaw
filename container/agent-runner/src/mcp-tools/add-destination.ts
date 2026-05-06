import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err, generateId, log, nonEmptyString, ok } from './util.js';

export const addDestinationTool: McpToolDefinition = {
  tool: {
    name: 'add_destination',
    description:
      "Wire a new named destination on YOUR session's agent group so you can address it by `local_name` in send_message. Specify EXACTLY ONE of `target_messaging_group_id` (a chat) or `target_agent_group_id` (another agent). Only callable from the operator-designated main control chat — calls from elsewhere are silently dropped on the host. Fire-and-forget.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        local_name: { type: 'string', description: "The name your agent will use to refer to the target (will be normalized — lowercase + hyphens)." },
        target_messaging_group_id: { type: 'string', description: 'Messaging group id (chat). Mutually exclusive with target_agent_group_id.' },
        target_agent_group_id: { type: 'string', description: 'Agent group id (another agent). Mutually exclusive with target_messaging_group_id.' },
      },
      required: ['local_name'],
    },
  },
  async handler(args) {
    if (!nonEmptyString(args.local_name)) return err('local_name is required and must be a non-empty string');
    const hasMg = !!nonEmptyString(args.target_messaging_group_id);
    const hasAg = !!nonEmptyString(args.target_agent_group_id);
    if (!hasMg && !hasAg) return err('one target is required: target_messaging_group_id or target_agent_group_id');
    if (hasMg && hasAg) return err('exactly one target allowed: target_messaging_group_id OR target_agent_group_id, not both');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'add_destination', ...args }),
    });

    log(`add_destination: ${requestId} → "${args.local_name}" → ${hasMg ? `chat ${args.target_messaging_group_id}` : `agent ${args.target_agent_group_id}`}`);
    return ok(`Destination wire request submitted (id=${requestId}). Fire-and-forget — non-main callers are silently dropped on the host.`);
  },
};

registerTools([addDestinationTool]);
