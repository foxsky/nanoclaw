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
