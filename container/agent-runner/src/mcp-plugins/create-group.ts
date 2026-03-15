import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const PARTICIPANT_JID_PATTERN = /^\d{6,20}@s\.whatsapp\.net$/;

interface McpPluginContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  isTaskflowManaged?: boolean;
  taskflowHierarchyLevel?: string;
  taskflowMaxDepth?: string;
  writeIpcFile: (dir: string, data: object) => string;
  TASKS_DIR: string;
  MESSAGES_DIR: string;
}

// Best-effort authorization check for fast user feedback.
// The host-side plugin performs its own independent authorization check
// and is the sole authority — if these checks diverge, the host silently
// drops the request after the agent already received "creation requested".
function canUseCreateGroup(ctx: McpPluginContext): boolean {
  if (ctx.isMain) return true;
  if (!ctx.isTaskflowManaged) return false;

  const level =
    ctx.taskflowHierarchyLevel === undefined || ctx.taskflowHierarchyLevel === ''
      ? undefined
      : Number.parseInt(ctx.taskflowHierarchyLevel, 10);
  const maxDepth =
    ctx.taskflowMaxDepth === undefined || ctx.taskflowMaxDepth === ''
      ? undefined
      : Number.parseInt(ctx.taskflowMaxDepth, 10);

  if (
    level !== undefined &&
    maxDepth !== undefined &&
    !Number.isNaN(level) &&
    !Number.isNaN(maxDepth) &&
    level >= 0 &&
    maxDepth >= 0
  ) {
    // Runtime levels are 0-based; maxDepth is a 1-based depth count
    // (e.g., maxDepth 2 = root + one child). Leaf boards are at level == maxDepth - 1.
    return level + 1 <= maxDepth;
  }

  return false;
}

export function register(server: McpServer, ctx: McpPluginContext): void {
  server.tool(
    'create_group',
    'Create a new WhatsApp group. Available in the main group and in groups created from the TaskFlow skill, as long as the configured TaskFlow hierarchy depth limit has not been reached.',
    {
      subject: z.string().trim().min(1).max(100).describe('Group name'),
      participants: z
        .array(
          z
            .string()
            .trim()
            .regex(
              PARTICIPANT_JID_PATTERN,
              'Must be a WhatsApp user JID like "5585999998888@s.whatsapp.net"',
            ),
        )
        .min(1)
        .max(256)
        .refine(
          (participants) => new Set(participants).size === participants.length,
          'Participants must be unique',
        )
        .describe('Phone numbers (e.g., "5585999998888@s.whatsapp.net")'),
    },
    async (args) => {
      if (!canUseCreateGroup(ctx)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Only the main group and eligible TaskFlow groups below their hierarchy depth limit can create groups.',
            },
          ],
          isError: true,
        };
      }
      ctx.writeIpcFile(ctx.TASKS_DIR, {
        type: 'create_group',
        subject: args.subject,
        participants: args.participants,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Group "${args.subject}" creation requested.` }] };
    },
  );
}
