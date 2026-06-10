/**
 * Agent management MCP tools: create_agent.
 *
 * send_to_agent was removed — sending to another agent is now just
 * send_message(to="agent-name") since agents and channels share the
 * unified destinations namespace.
 *
 * create_agent spawns a fresh, long-lived companion agent group from attacker-
 * controllable args (name + CLAUDE.md instructions). The host handler
 * (src/modules/agent-to-agent/create-agent.ts) does NOT re-authorize the caller,
 * so exposure is the boundary.
 *
 * SEC#11 (whole-epic security sign-off): on a TaskFlow board the agent's curated
 * MCP surface must stay the taskflow/api tools only — a prompt-injected board
 * agent must not be able to spin up a new, non-board-pinned agent group. claude.ts
 * exposes the nanoclaw MCP server as a wildcard (mcp__nanoclaw__*) and create_agent
 * is denied by neither list, so we fail closed HERE: when NANOCLAW_TASKFLOW_BOARD_ID
 * is set we neither register the tool nor honor a forged call — the handler refuses
 * and emits NO outbound row, so the host never acts.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description:
      'Create a long-lived companion sub-agent (research assistant, task manager, specialist) — the name becomes your destination for it. Admin-only. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name (also becomes your destination name for this agent)' },
        instructions: { type: 'string', description: 'CLAUDE.md content for the new agent (personality, role, instructions)' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    // SEC#11: fail closed on TaskFlow boards — never emit a create_agent system row from a
    // board container. Refusing here (before writeMessageOut) guarantees nothing reaches the host.
    if (process.env.NANOCLAW_TASKFLOW_BOARD_ID) {
      return err('create_agent is not available on TaskFlow boards');
    }
    const name = args.name as string;
    if (!name) return err('name is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
      }),
    });

    log(`create_agent: ${requestId} → "${name}"`);
    return ok(`Creating agent "${name}". You will be notified when it is ready.`);
  },
};

// Do not even advertise the tool to TaskFlow board agents (defense-in-depth atop the
// handler guard above). NANOCLAW_TASKFLOW_BOARD_ID is set in the MCP subprocess env for
// board sessions; generic (non-board) agents register and use create_agent unchanged.
if (!process.env.NANOCLAW_TASKFLOW_BOARD_ID) {
  registerTools([createAgent]);
}
