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

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const REQUIRED_FIELDS = ['subject', 'person_id', 'person_name', 'person_phone', 'short_code'] as const;

export const provisionRootBoardTool: McpToolDefinition = {
  tool: {
    name: 'provision_root_board',
    description:
      'Create a new TaskFlow root board: provisions a new WhatsApp group with the manager, seeds taskflow.db, wires the agent in v2, lays down the per-board filesystem, schedules standup/digest/review/onboarding crons, and sends welcome + confirmation messages. Only callable from the operator-designated main control chat — calls from elsewhere are silently dropped on the host. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'Group/board subject. " - TaskFlow" suffix is appended automatically if absent.' },
        person_id: { type: 'string', description: "Manager's TaskFlow person id (used in board_admins, board_people, task_history)." },
        person_name: { type: 'string', description: "Manager's display name." },
        person_phone: { type: 'string', description: "Manager's phone (will be canonicalized at the host)." },
        short_code: { type: 'string', description: 'Short uppercase code used in the board id prefix (e.g. "ENG").' },
        participants: { type: 'array', items: { type: 'string' }, description: 'Optional initial participants as <digits>@s.whatsapp.net JIDs.' },
        trigger: { type: 'string', description: 'Optional mention trigger pattern (defaults to "@Case").' },
        requires_trigger: { type: 'boolean', description: 'If true, the agent only responds to messages matching `trigger`.' },
        language: { type: 'string', description: 'Optional language tag (default "pt-BR").' },
        timezone: { type: 'string', description: 'Optional IANA timezone (default "America/Fortaleza").' },
        wip_limit: { type: 'number', description: 'Optional default WIP limit (default 5).' },
        max_depth: { type: 'number', description: 'Optional max depth for child boards (default 3).' },
        model: { type: 'string', description: 'Optional Claude model override (default "claude-sonnet-4-6").' },
        group_context: { type: 'string', description: 'Optional free-text context describing the group.' },
        standup_cron_local: { type: 'string', description: 'Optional standup cron in local tz.' },
        digest_cron_local: { type: 'string', description: 'Optional digest cron in local tz.' },
        review_cron_local: { type: 'string', description: 'Optional review cron in local tz.' },
        standup_cron_utc: { type: 'string', description: 'Optional standup cron in UTC.' },
        digest_cron_utc: { type: 'string', description: 'Optional digest cron in UTC.' },
        review_cron_utc: { type: 'string', description: 'Optional review cron in UTC.' },
        group_folder: { type: 'string', description: 'Optional folder override (default sanitized short_code + "-taskflow").' },
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

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'provision_root_board', ...args }),
    });

    log(`provision_root_board: ${requestId} → ${args.short_code} ("${args.subject}")`);
    return ok(
      `Provisioning request submitted (id=${requestId}). The host will create the WhatsApp group, seed the board, wire the agent, schedule runners, and send welcome + confirmation messages. Fire-and-forget — non-main callers are silently dropped on the host.`,
    );
  },
};

registerTools([provisionRootBoardTool]);
