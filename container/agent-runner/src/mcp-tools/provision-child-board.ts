import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err, generateId, log, nonEmptyString, ok } from './util.js';

const REQUIRED_FIELDS = ['person_id', 'person_name', 'person_phone', 'person_role'] as const;

function slugForBoardFolder(value: string): string {
  return value
    .replace(/\s*-\s*TaskFlow\s*$/iu, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function resolvedGroupFolder(args: Record<string, unknown>): string | null {
  const groupFolder = typeof args.group_folder === 'string' ? args.group_folder.trim() : '';
  if (groupFolder) return groupFolder;
  const groupName = typeof args.group_name === 'string' ? args.group_name.trim() : '';
  if (!groupName) return null;
  const slug = slugForBoardFolder(groupName);
  return slug ? `${slug}-taskflow` : null;
}

export const provisionChildBoardTool: McpToolDefinition = {
  tool: {
    name: 'provision_child_board',
    description:
      "Create a child TaskFlow board under YOUR current board (only callable from a TaskFlow board's session, and only when the parent has depth headroom). Provisions a new private WhatsApp group with the assignee, seeds taskflow.db inheriting parent runtime config, wires the agent in v2, schedules runners + onboarding, and links any existing tasks the assignee owned on the parent. If the same person already has a board under a DIFFERENT parent, the action LINKS to that existing board instead of creating a duplicate. Fire-and-forget.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: "Assignee's TaskFlow person id." },
        person_name: { type: 'string', description: "Assignee's display name." },
        person_phone: { type: 'string', description: "Assignee's phone (will be canonicalized at the host)." },
        person_role: { type: 'string', description: "Assignee's role (e.g. 'developer', 'designer', 'manager')." },
        short_code: { type: 'string', description: 'Optional short code for the child board.' },
        group_folder: {
          type: 'string',
          description:
            "Folder name for the child board. Pass the assignee's division/group name (e.g. 'ux-setd-secti-taskflow'). If omitted but group_name is present, it is derived from group_name; it never falls back to the person name.",
        },
        group_name: { type: 'string', description: "Child board/group display name, usually '<division> - TaskFlow'." },
      },
      required: [...REQUIRED_FIELDS],
    },
  },
  async handler(args) {
    for (const field of REQUIRED_FIELDS) {
      if (!nonEmptyString(args[field])) {
        return err(`${field} is required and must be a non-empty string`);
      }
    }
    const groupFolder = resolvedGroupFolder(args);
    if (!groupFolder) {
      return err('group_folder is required unless group_name is provided; child boards must be named after the division/group, never the person');
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'provision_child_board', ...args, group_folder: groupFolder }),
    });

    log(`provision_child_board: ${requestId} → ${args.person_id} ("${args.person_name}")`);
    return ok(
      `Provisioning request submitted (id=${requestId}). The host will look up your parent board, create the assignee's private group, seed the child board (inheriting your runtime config), and link any existing tasks. If the assignee already has a board under another parent, the host will LINK to that one instead. Fire-and-forget.`,
    );
  },
};

registerTools([provisionChildBoardTool]);
