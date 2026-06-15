/**
 * #419 (SEC#13) — the ENFORCEMENT half of the per-turn actor binding.
 *
 * `turn-actor.ts` pins the authenticated sender; `normalizeAgentIds` binds
 * `sender_name` to it. But binding alone is NOT fail-closed: an unresolved
 * actor only fails the engine's PERSON-gated checks (isManager/isAssignee), so
 * unprivileged chat mutations (create / comment / update-unowned) would still
 * run attributed to a no-real-person value (Codex #419 BLOCKER). So every chat
 * mutate tool is wrapped with `requiresChatActor`, which DENIES the call up
 * front when the turn has no single authenticated chat sender.
 *
 * Surface: the in-session chat agent only. The FastAPI/dashboard subprocess
 * authenticates server-side (getVerbatimIds()), and #407 approved replay runs
 * the ORIGINAL handler with park-time-authenticated args (isApprovedReplay()) —
 * both bypass the guard. Reads are NOT wrapped (an unresolved turn must still be
 * able to read; only board MUTATIONS require an authenticated actor).
 *
 * Coverage is locked by chat-actor-guard.test.ts, which enumerates the
 * registered tools and asserts every board-mutating tool denies on an
 * unresolved actor — so a newly-added mutate tool that forgets the wrapper
 * fails the suite rather than silently shipping a spoofable mutation.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isApprovedReplay } from './replay-flag.js';
import { getVerbatimIds } from './taskflow-helpers.js';
import { getTurnActor } from './turn-actor.js';
import { getTurnExternalActor } from './turn-external-actor.js';
import type { McpToolDefinition } from './types.js';
import { jsonResponse } from './util.js';

/** Returns a permission_denied result when the in-session chat surface has no
 *  single authenticated sender this turn; otherwise null (proceed). */
export function denyIfChatActorUnresolved(): CallToolResult | null {
  if (!process.env.NANOCLAW_TASKFLOW_BOARD_ID || getVerbatimIds() || isApprovedReplay()) {
    return null;
  }
  if (getTurnActor().resolved) return null;
  return jsonResponse({
    success: false,
    error_code: 'permission_denied',
    error:
      'Could not authenticate the requester for this action — there is no single confirmed sender for this turn.',
  });
}

/** Wrap a board-mutating tool so its handler is gated by the per-turn actor.
 *  The original `tool` schema is preserved; only the handler is fronted. */
export function requiresChatActor(def: McpToolDefinition): McpToolDefinition {
  return {
    ...def,
    handler: async (args) => denyIfChatActorUnresolved() ?? def.handler(args),
  };
}

/**
 * RC5-ext P3 (C7) — external-safe capability gate: the B6 content-confinement
 * control. Confining the *recipient* of an external's reply is not enough — an
 * external turn drives the board agent, which could be prompt-injected into
 * reading board-private state and exfiltrating it. So when the turn resolves to
 * an authenticated EXTERNAL actor, DEFAULT-DENY every MCP tool except the narrow
 * grant-scoped flow (accept the meeting invite; add a note to the granted
 * meeting). Applied CENTRALLY at the dispatch seam (server.ts) so a newly-added
 * tool is denied by construction — never opt-in per tool.
 *
 * Non-external turns (board person, system/scheduled) are UNAFFECTED — the gate
 * returns null. Verbatim (FastAPI) and #407 approved replay bypass (server-/
 * park-authenticated). Note: the whitelisted tools still pass through their own
 * `requiresChatActor` (board-actor) guard, which denies on an external turn
 * until the actor-aware guard + engine per-meeting re-check (C4) land — so this
 * unit confines content WITHOUT yet opening the note/accept flow.
 */
const EXTERNAL_SAFE_TOOLS: ReadonlySet<string> = new Set(['api_task_add_note']);
const EXTERNAL_SAFE_ADMIN_ACTIONS: ReadonlySet<string> = new Set(['accept_external_invite']);

export function denyIfExternalActorBlocked(toolName: string, args: Record<string, unknown>): CallToolResult | null {
  if (!process.env.NANOCLAW_TASKFLOW_BOARD_ID || getVerbatimIds() || isApprovedReplay()) return null;
  if (!getTurnExternalActor().resolved) return null; // not an external turn → no capability restriction
  // External turn: allow ONLY the grant-scoped flow; deny everything else.
  if (toolName === 'api_admin') {
    const action = typeof args.action === 'string' ? args.action : '';
    if (EXTERNAL_SAFE_ADMIN_ACTIONS.has(action)) return null;
  } else if (EXTERNAL_SAFE_TOOLS.has(toolName)) {
    return null;
  }
  return jsonResponse({
    success: false,
    error_code: 'permission_denied',
    error: 'External participants can only accept their meeting invite and add notes to their own meeting.',
  });
}
