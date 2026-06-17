/**
 * TaskFlow overlay for the ADR 0006 contract 8 per-tool EMIT-hook extension
 * point in `server.ts`. Importing this module (side-effect only, from the
 * `mcp-tools/index.ts` barrel) registers the fork's SEC#11/#410 board gates for
 * the core send/file/edit/react tools WITHOUT core importing any fork module:
 * core calls the inert `runEmit*` runners AFTER routing, and they no-op until
 * this overlay registers a hook.
 *
 * All gate rationale below is preserved verbatim from the original inline
 * implementation in `core.ts` (pre-split). The behavior is byte-for-byte the
 * same; only the call site moved from inline-in-core to a registered hook.
 *
 * It also registers the #410 approved-executor entries so the host can replay an
 * APPROVED forward deterministically.
 */
import path from 'path';

import { getSessionRouting } from '../db/session-routing.js';
import { sendFile, sendMessage } from './core.js';
import { evaluateDestructiveAction } from './destructive-gate.js';
import { markDeterministicMutationEmitted } from './mutation-dedup.js';
import { registerEmitHook } from './server.js';
import { isApprovedReplay, parkForApproval, registerApprovedExecutor } from './taskflow-approval.js';
import { getVerbatimIds } from './taskflow-helpers.js';
import { err } from './util.js';

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
function markIfSameConv(routing: { channel_type: string | null; platform_id: string | null }): void {
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
  routing: { channel_type: string | null; platform_id: string | null; resolvedName?: string },
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

// --- contract 8 registrations -----------------------------------------------------------------

registerEmitHook('send_message', {
  preEmit: (args, routing) => maybeParkBroadcast('send_message', args, routing),
  postEmit: (routing) => markIfSameConv(routing),
});

registerEmitHook('send_file', {
  preEmit: (args, routing) => maybeParkBroadcast('send_file', args, routing),
  // SEC#11: confine board agents' send_file source path. realpathSync collapses `..` AND symlinks
  // (existence already checked by core before this hook runs), so neither a traversal nor a planted
  // link can reach the cross-board taskflow.db, the session DBs, or /workspace/global. Generic
  // (non-board) agents send arbitrary files as before — this is the TaskFlow board boundary only.
  sourceGuard: (resolvedPath) =>
    process.env.NANOCLAW_TASKFLOW_BOARD_ID && !isAllowedBoardSendFilePath(resolvedPath)
      ? err(
          `sending is restricted to your workspace (/workspace/agent) and delivered attachments — refusing '${resolvedPath}'`,
        )
      : null,
  safeFilename: (requested, sourcePath) => safeOutboxFilename(requested, sourcePath),
  postEmit: (routing) => markIfSameConv(routing),
});

registerEmitHook('edit_message', {
  externalTargetGuard: (routing) =>
    isExternalBoardTarget(routing)
      ? err('editing a message in another conversation is not allowed on TaskFlow boards')
      : null,
});

registerEmitHook('add_reaction', {
  externalTargetGuard: (routing) =>
    isExternalBoardTarget(routing)
      ? err('reacting to a message in another conversation is not allowed on TaskFlow boards')
      : null,
});

// #410: register the gated send tools so the host can replay an APPROVED forward deterministically
// (executeApprovedAction → handler under isApprovedReplay(), which bypasses the broadcast gate).
registerApprovedExecutor('send_message', (a) => sendMessage.handler(a));
registerApprovedExecutor('send_file', (a) => sendFile.handler(a));
