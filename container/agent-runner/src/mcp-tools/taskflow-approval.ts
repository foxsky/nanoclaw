/**
 * SEC#1 unit 3 (#407) — admin-approval round-trip for gated TaskFlow actions.
 *
 * The destructive-gate (destructive-gate.ts) classifies which mass/destructive/structure/broadcast
 * actions a chat agent must NOT run unilaterally. Unit 2 made those sites REFUSE. This unit turns a
 * refusal into a human-in-the-loop round-trip WITHOUT moving the mutation off the deterministic path:
 *
 *   1. PARK (here, container): instead of refusing, the tool writes a `taskflow_request_approval`
 *      system row to outbound.db and returns a non-retry `pending_approval` to the agent.
 *   2. HOST: the delivery action requests an admin approval (existing approvals primitive). On approve
 *      the host writes a `taskflow_execute_approved` system row back into inbound.db (trigger=1).
 *   3. REPLAY (here, container): the poll-loop intercepts that system row BEFORE the LLM ever sees it
 *      and calls executeApprovedAction, which re-invokes the ORIGINAL tool handler deterministically
 *      under isApprovedReplay() — a flag the gate sites honor to bypass ONLY the gate.
 *
 * WHY a dedicated replay flag and not getVerbatimIds(): verbatim also tells normalizeAgentIds to TRUST
 * the caller's board_id. The replay must NOT relax board pinning — an approved action still executes
 * against this container's own board (NANOCLAW_TASKFLOW_BOARD_ID), so a tampered/foreign board_id in
 * the parked args can never escape. isApprovedReplay() bypasses the gate and nothing else.
 *
 * The mutation runs inside the container because taskflow.db is container-only (the host cannot see or
 * write it). The host can only decide WHEN; the container is the only place that can DO.
 */
import { writeMessageOut, type WriteMessageOut } from '../db/messages-out.js';
import type { GateDecision } from './destructive-gate.js';
import { emitDeterministicToolMessage } from './mutation-confirmation.js';
import { isApprovedReplay, runAsApprovedReplay } from './replay-flag.js';
import { generateId, jsonResponse, log } from './util.js';

/** outbound system action: container → host, "an admin must approve this gated action". */
export const REQUEST_APPROVAL_ACTION = 'taskflow_request_approval';
/** inbound system action: host → container, "the admin decided; run (or decline) it now". */
export const EXECUTE_APPROVED_ACTION = 'taskflow_execute_approved';

// --- gate-bypass flag for the approved re-run -------------------------------------------------
// The flag + its two accessors moved to replay-flag.ts (a dependency-free leaf) so taskflow-helpers
// can consult isApprovedReplay() inside normalizeAgentIds (#419 actor binding) without closing an
// import cycle through this module. Imported above for internal use (executeApprovedAction) and
// re-exported here so every existing `from './taskflow-approval.js'` importer is unchanged.
export { isApprovedReplay, runAsApprovedReplay };

// --- executor registry ------------------------------------------------------------------------
// The gated tools register their own handler here at import time (no import cycle: the tool modules
// already depend on this module for parkForApproval). executeApprovedAction looks the handler up by
// the tool name parked in the request, so the approved action re-runs EXACTLY the original code path.
export type ApprovedExecutor = (args: Record<string, unknown>) => Promise<unknown> | unknown;
const executors = new Map<string, ApprovedExecutor>();

export function registerApprovedExecutor(tool: string, exec: ApprovedExecutor): void {
  executors.set(tool, exec);
}

export function getApprovedExecutor(tool: string): ApprovedExecutor | undefined {
  return executors.get(tool);
}

// --- park -------------------------------------------------------------------------------------
export interface ParkRequest {
  /** MCP tool name, used as the executor-registry key on replay (e.g. 'api_reassign', 'send_message'). */
  tool: string;
  /** The ORIGINAL tool args, parked verbatim and replayed unchanged on approval. */
  args: Record<string, unknown>;
  /** The gate decision that triggered the park (category + human reason). */
  decision: GateDecision;
  /** Short human description for the admin approval card (e.g. "reassign 8 tasks from Alice to Bob"). */
  summary: string;
}

interface ParkDeps {
  emit?: (msg: WriteMessageOut) => number;
  newId?: () => string;
}

/**
 * Park a gated action for admin approval. Writes the request system row and returns the agent-facing
 * `pending_approval` response. The request_id IS the row id, so the host's approval card can correlate
 * the approval back to this exact request.
 */
export function parkForApproval(req: ParkRequest, deps: ParkDeps = {}) {
  const emit = deps.emit ?? writeMessageOut;
  const requestId = (deps.newId ?? generateId)();

  emit({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({
      action: REQUEST_APPROVAL_ACTION,
      request_id: requestId,
      tool: req.tool,
      args: req.args,
      category: req.decision.category,
      reason: req.decision.reason,
      summary: req.summary,
    }),
  });
  log(`parkForApproval: ${req.tool} held for admin approval (${req.decision.category}) request=${requestId}`);

  return jsonResponse({
    success: false,
    error_code: 'pending_approval',
    request_id: requestId,
    gate: { category: req.decision.category },
    error: req.decision.reason,
    message:
      'This action needs admin approval and has been routed to an admin. Do NOT retry it — when an ' +
      'admin approves, it runs automatically and the result posts here. Tell the user it is pending ' +
      'admin approval.',
  });
}

// --- execute (deterministic replay) -----------------------------------------------------------
interface ExecuteDeps {
  getExecutor?: (tool: string) => ApprovedExecutor | undefined;
  notify?: (text: string) => void;
  runReplay?: <T>(fn: () => Promise<T> | T) => Promise<T>;
}

/**
 * Inspect a tool handler's MCP result for a definitive failure (isError, or a JSON body with
 * success:false). Returns a human reason on failure, else null. Best-effort — an unparseable or
 * success-shaped result is treated as success (the handler's own confirmation card already fired).
 */
function extractFailure(result: unknown): string | null {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  if (!r || typeof r !== 'object') return null;
  const text = r.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      const body = JSON.parse(text) as { success?: unknown; error?: unknown };
      if (body && body.success === false) {
        return typeof body.error === 'string' && body.error ? body.error : 'the action did not complete';
      }
    } catch {
      // Non-JSON success text (e.g. send_message's "Message sent …") — not a failure.
    }
  }
  if (r.isError) return 'the action did not complete';
  return null;
}

/**
 * Run an admin's decision on a parked action. Called by the poll-loop for a `taskflow_execute_approved`
 * system row, OUTSIDE the agent turn. On approve it re-invokes the original handler under the gate
 * bypass; the handler emits its own native confirmation to the board chat (session routing is
 * session-stable, so it lands in the conversation the request came from). A decline / missing handler /
 * engine failure is surfaced fail-loud to the same conversation.
 */
export async function executeApprovedAction(content: Record<string, unknown>, deps: ExecuteDeps = {}): Promise<void> {
  const getExecutor = deps.getExecutor ?? getApprovedExecutor;
  const notify = deps.notify ?? ((t: string) => emitDeterministicToolMessage(t));
  const runReplay = deps.runReplay ?? runAsApprovedReplay;

  const tool = String(content.tool ?? '');
  const summary = String(content.summary ?? tool);
  const args = (content.args as Record<string, unknown>) ?? {};
  // Fail-closed: ONLY an explicit approved:true runs the action. A malformed/missing flag is treated
  // as not-approved (declined) rather than executing — the gate must never fail open.
  const approved = content.approved === true;

  if (!approved) {
    notify(`❌ "${summary}" was declined by an admin — nothing was changed.`);
    return;
  }

  const exec = getExecutor(tool);
  if (!exec) {
    log(`executeApprovedAction: no executor registered for "${tool}"`);
    notify(`⚠️ Approved action "${summary}" could not run — no handler for ${tool}. Nothing was changed.`);
    return;
  }

  try {
    const result = await runReplay(() => exec(args));
    const failure = extractFailure(result);
    if (failure) {
      notify(`⚠️ Approved action "${summary}" failed: ${failure}`);
      return;
    }
    log(`executeApprovedAction: ran "${tool}" after admin approval`);
  } catch (e) {
    log(`executeApprovedAction: "${tool}" threw: ${String(e)}`);
    notify(`⚠️ Approved action "${summary}" failed to apply: ${(e as Error).message}`);
  }
}
