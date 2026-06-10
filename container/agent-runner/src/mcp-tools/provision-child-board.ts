import { writeMessageOut } from '../db/messages-out.js';
import { evaluateDestructiveAction } from './destructive-gate.js';
import { registerTools } from './server.js';
import { isApprovedReplay, parkForApproval, registerApprovedExecutor } from './taskflow-approval.js';
import { getVerbatimIds } from './taskflow-helpers.js';
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

    // SEC#11 (Codex whole-epic sign-off): provisioning a child board opens a private WhatsApp group
    // with the assignee, spawns a new agent group, AND links the assignee's existing parent tasks into
    // it — an injection-reachable structure + network + spawn escalation with a real cross-board
    // task-exfil sub-path (aim a child board at an attacker phone + a victim's person_id). Hold
    // board-chat calls for admin approval (the operator's "structure → approval" decision); the
    // approved replay re-invokes this handler under isApprovedReplay() to emit the real provision row.
    // provision_child_board is board-only (the host rejects non-board callers), so main-control — which
    // has no NANOCLAW_TASKFLOW_BOARD_ID — never reaches here; FastAPI/verbatim bypasses.
    if (process.env.NANOCLAW_TASKFLOW_BOARD_ID && !getVerbatimIds() && !isApprovedReplay()) {
      return parkForApproval({
        tool: 'provision_child_board',
        args: { ...args, group_folder: groupFolder },
        decision: evaluateDestructiveAction({ kind: 'structure', adminAction: 'provision_child_board' }),
        summary: `provision child board (${groupFolder}) for ${String(args.person_name)} (${String(args.person_phone)})`,
      });
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
// #407/#411 wiring: the approved replay re-invokes the original handler (under isApprovedReplay(), so the
// gate above is bypassed and the real provision row is emitted). Registered in approved-executors.ts for
// the MAIN poll-loop process too — see that module's process-boundary note.
registerApprovedExecutor('provision_child_board', (args) => provisionChildBoardTool.handler(args));
