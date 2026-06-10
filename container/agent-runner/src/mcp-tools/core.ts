/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { getCurrentInReplyTo } from '../current-batch.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { evaluateDestructiveAction } from './destructive-gate.js';
import { markDeterministicMutationEmitted } from './mutation-dedup.js';
import { registerTools } from './server.js';
import { isApprovedReplay, parkForApproval, registerApprovedExecutor } from './taskflow-approval.js';
import { getVerbatimIds } from './taskflow-helpers.js';
import type { McpToolDefinition } from './types.js';

/**
 * Mark the dedup flag when an explicit emission lands in the SAME
 * conversation the user wrote in. Codex Turn-25 follow-up (2026-05-23):
 * when the model calls send_message/send_file AND ALSO emits the same text
 * as bare-text-final (or wraps it in a same-conv `<message>` block), both
 * went through unconditionally — the `ba24ef23` scope decision kept
 * explicit-emission paths as a blanket BYPASS. That bypass holds when the
 * destination is genuinely a DIFFERENT conversation (cross-board relay);
 * it fails when send_message targets the same chat the user wrote in,
 * because the bare-text-final is then a redundant narration. Cross-conv
 * send_message keeps the bypass (bare-text in the source conv is a
 * legitimate separate reply).
 */
function markIfSameConv(routing: { channel_type: string; platform_id: string }): void {
  const session = getSessionRouting();
  if (
    session.channel_type &&
    session.platform_id &&
    session.channel_type === routing.channel_type &&
    session.platform_id === routing.platform_id
  ) {
    markDeterministicMutationEmitted();
  }
}

/**
 * #410 broadcast/forward gate. A send to a destination that is NOT the current conversation
 * (external) is an intra-org forward/exfil primitive — on a TaskFlow board it must be held for admin
 * approval, the same park round-trip as the destructive mutate gates. Returns a park response (the
 * caller must `return` it) or null to proceed. Scoped to board agents (NANOCLAW_TASKFLOW_BOARD_ID
 * set) so core non-board agents' send_message is untouched; the FastAPI/verbatim surface and the
 * approved replay both bypass. send_message is single-destination, so the count never trips — the
 * `external` flag (cross-conversation) is the live signal.
 *
 * SCOPE (honest): this gates the AGENT's injection surface (the send_message/send_file MCP tools).
 * The deterministic poll-loop forward handlers (sendToDestination) forward board data cross-board from
 * PARSED USER COMMANDS — a separate, user-authorized path the agent cannot reach — and are NOT gated
 * here; closing that for full parity is tracked separately (SEC#7).
 */
function maybeParkBroadcast(
  toolName: string,
  args: Record<string, unknown>,
  routing: { channel_type: string; platform_id: string; resolvedName: string },
) {
  if (!process.env.NANOCLAW_TASKFLOW_BOARD_ID) return null; // board agents only
  if (getVerbatimIds() || isApprovedReplay()) return null;
  const session = getSessionRouting();
  // External = the session has a known conversation AND this send leaves it. A reply-in-place
  // (`to` omitted) or a send back to the same channel+platform resolves equal → not external.
  const external =
    !!session.channel_type &&
    !!session.platform_id &&
    (routing.channel_type !== session.channel_type || routing.platform_id !== session.platform_id);
  const d = evaluateDestructiveAction({ kind: 'broadcast', destinations: 1, external });
  if (!d.gated) return null;
  return parkForApproval({ tool: toolName, args, decision: d, summary: `${toolName} to ${routing.resolvedName}` });
}

/**
 * SEC#11 (Codex whole-epic sign-off): edit_message/add_reaction route by HISTORICAL message seq
 * (getRoutingBySeq), so without this an injected board agent could target a prior message that was sent
 * to an EXTERNAL destination — posting arbitrary new text into another conversation (edit_message, an
 * exfil bypass of the #410 broadcast gate) or pinging it (add_reaction). Refuse when the resolved target
 * routing is not the current conversation. Board sessions only; mirrors maybeParkBroadcast's external check.
 */
export function isExternalBoardTarget(routing: { channel_type: string | null; platform_id: string | null }): boolean {
  if (!process.env.NANOCLAW_TASKFLOW_BOARD_ID) return false;
  const session = getSessionRouting();
  if (!session.channel_type || !session.platform_id) return false;
  return routing.channel_type !== session.channel_type || routing.platform_id !== session.platform_id;
}

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

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    // Default: reply to whatever thread/channel this session is bound to.
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    // No session routing (e.g., agent-shared or internal-only agent) —
    // fall back to the legacy single-destination shortcut.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1"). Optional if you have only one destination.',
        },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text) return err('text is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const parked = maybeParkBroadcast('send_message', args, routing);
    if (parked) return parked;

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    markIfSameConv(routing);
    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

// SEC#11: dirs a TaskFlow board agent may legitimately send a file FROM — its own workspace
// (generated reports/charts, and CLAUDE.local.md, which are the board's own data) plus the two
// host-written inbound-attachment dirs (session-manager `inbox/<msg>/...`, whatsapp adapter
// `attachments/...`). Everything else is off-limits: send_file copies the file into the outbox and
// delivers it to chat, re-creating the arbitrary-file-read + exfil primitive the disallowed
// Read/Bash tools exist to remove. The cross-board taskflow.db (ALL boards), the session DBs, and
// /workspace/global are the high-value targets a same-conversation send would otherwise leak — the
// #410 broadcast gate only inspects the DESTINATION, so it never held them.
const BOARD_SEND_FILE_PREFIXES = ['/workspace/agent/', '/workspace/inbox/', '/workspace/attachments/'];

/**
 * True iff `p` resolves (after collapsing `..`) to a file under a dir a board agent may send from.
 * Pure prefix check on resolve(p) — mirrors transcribe-audio's isAllowedAttachmentPath. The handler
 * additionally realpath-resolves before calling this so symlinks collapse too.
 */
export function isAllowedBoardSendFilePath(p: string): boolean {
  const abs = path.resolve(p);
  return BOARD_SEND_FILE_PREFIXES.some((prefix) => abs.startsWith(prefix));
}

/**
 * SEC#11: the outbox display filename is a NAME, never a path. `copyFileSync(src, join(outboxDir,
 * filename))` with a crafted `filename` ("../../taskflow/taskflow.db") would direct the WRITE outside
 * the per-message outbox dir — overwriting the shared cross-board DB or poisoning agent memory. Force
 * basename (strips every path component) and reject the degenerate `.`/`..`/empty, falling back to the
 * source file's basename. Applies to ALL agents — a display name has no legitimate path separators.
 */
export function safeOutboxFilename(requested: string | undefined, sourcePath: string): string {
  const base = path.basename((requested ?? '').trim());
  return base && base !== '.' && base !== '..' ? base : path.basename(sourcePath);
}

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const parked = maybeParkBroadcast('send_file', args, routing);
    if (parked) return parked;

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    // SEC#11: confine board agents' send_file source path. realpathSync collapses `..` AND symlinks
    // (existence already checked above), so neither a traversal nor a planted link can reach the
    // cross-board taskflow.db, the session DBs, or /workspace/global. Generic (non-board) agents
    // send arbitrary files as before — this is the TaskFlow board boundary only.
    if (process.env.NANOCLAW_TASKFLOW_BOARD_ID && !isAllowedBoardSendFilePath(fs.realpathSync(resolvedPath))) {
      return err(
        `sending is restricted to your workspace (/workspace/agent) and delivered attachments — refusing '${filePath}'`,
      );
    }

    const id = generateId();
    const filename = safeOutboxFilename(args.filename as string | undefined, resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    markIfSameConv(routing);
    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    // SEC#11: editing a message that went to another conversation posts arbitrary new text there,
    // bypassing the #410 broadcast gate. Refuse external edits on a board session.
    if (isExternalBoardTarget(routing)) {
      return err('editing a message in another conversation is not allowed on TaskFlow boards');
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    // SEC#11: a reaction on a message in another conversation is a cross-conversation ping. Refuse it on
    // a board session (consistent with edit_message above).
    if (isExternalBoardTarget(routing)) {
      return err('reacting to a message in another conversation is not allowed on TaskFlow boards');
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction]);

// #410: register the gated send tools so the host can replay an APPROVED forward deterministically
// (executeApprovedAction → handler under isApprovedReplay(), which bypasses the broadcast gate).
registerApprovedExecutor('send_message', (a) => sendMessage.handler(a));
registerApprovedExecutor('send_file', (a) => sendFile.handler(a));
