/**
 * Authenticated client for tf-mcontrol's `/internal/board-chat/*`
 * endpoints (0h-v2 ticks contract, tf `3ccf716`). Used by the host
 * delivery-actions `taskflow_web_chat_inbound` (mark-delivered) and
 * `taskflow_web_chat_reply` (agent-reply).
 *
 * Auth + transport rules (nanoclaw v3 ACK, source-verified against tf
 * `main.py:require_internal_token` / the endpoint bodies):
 * - Bearer `TASKFLOW_INTERNAL_TOKEN`, DISTINCT from the god-mode
 *   `TASKFLOW_API_TOKEN`. Read via `readEnvFile` (NOT process.env) so
 *   it cannot leak to the agent container — the contract requires the
 *   token be host-only.
 * - 2xx → `ok` (caller reads the JSON body).
 * - 4xx (validation reject / 401 bad token / 413) → `terminal`:
 *   PERMANENT. Caller logs loud + returns normally; `delivery.ts` must
 *   NOT retry (its generic machinery blanket-retries any throw — a
 *   retried validation-4xx would poison the queue).
 * - 5xx / network / missing host config → `retry`: transient (or a
 *   permanent operator error that retry-then-dead-letter surfaces
 *   correctly). Caller throws so `delivery.ts` retries → eventually
 *   `markDeliveryFailed`.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

export type TaskflowInternalOutcome =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'terminal'; errorCode: string }
  | { kind: 'retry'; reason: string };

/**
 * Pure HTTP-status → outcome classification. The load-bearing
 * correctness of the whole ticks reply/delivery path: it decides
 * dead-letter vs retry. `bodyJson` is tf's parsed response (its 4xx
 * detail is `{ error_code }`; 401 detail is a plain string).
 */
export function classifyTaskflowResponse(status: number, bodyJson: unknown): TaskflowInternalOutcome {
  if (status >= 200 && status < 300) {
    const data = bodyJson && typeof bodyJson === 'object' ? (bodyJson as Record<string, unknown>) : {};
    return { kind: 'ok', data };
  }
  if (status >= 400 && status < 500) {
    const detail = bodyJson && typeof bodyJson === 'object' ? (bodyJson as { detail?: unknown }).detail : undefined;
    const errorCode =
      detail && typeof detail === 'object' && typeof (detail as { error_code?: unknown }).error_code === 'string'
        ? (detail as { error_code: string }).error_code
        : `http_${status}`;
    return { kind: 'terminal', errorCode };
  }
  return { kind: 'retry', reason: `http_${status}` };
}

/**
 * POST to a tf `/internal/board-chat/*` path. Throws on the `retry`
 * outcome (network, 5xx, missing config) so the host delivery-action's
 * thrown error makes `delivery.ts` retry → dead-letter. Returns `ok`
 * or `terminal` for the caller to handle (terminal = log loud, return
 * normally, no retry).
 */
export async function postTaskflowInternal(
  path: string,
  body: Record<string, unknown>,
): Promise<{ kind: 'ok'; data: Record<string, unknown> } | { kind: 'terminal'; errorCode: string }> {
  const env = readEnvFile(['TASKFLOW_API_BASE_URL', 'TASKFLOW_INTERNAL_TOKEN']);
  const base = env.TASKFLOW_API_BASE_URL;
  const token = env.TASKFLOW_INTERNAL_TOKEN;
  if (!base || !token) {
    // Permanent operator misconfig — but throw (retry path) not
    // terminal: a temporarily-missing .env on a redeploy should
    // recover on retry rather than silently dead-letter the message.
    throw new Error('taskflow internal-api: TASKFLOW_API_BASE_URL/TASKFLOW_INTERNAL_TOKEN unset');
  }
  const url = `${base.replace(/\/+$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `taskflow internal-api ${path}: network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const json = await res.json().catch(() => null);
  const outcome = classifyTaskflowResponse(res.status, json);
  if (outcome.kind === 'retry') {
    throw new Error(`taskflow internal-api ${path}: ${outcome.reason}`);
  }
  if (outcome.kind === 'terminal') {
    log.error('taskflow internal-api: validation reject (dead-letter, NOT retried)', {
      path,
      status: res.status,
      errorCode: outcome.errorCode,
    });
  }
  return outcome;
}
