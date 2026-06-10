/**
 * #407 approved-replay gate-bypass flag, extracted to a dependency-free leaf
 * module.
 *
 * Originally lived in taskflow-approval.ts. It was lifted here so
 * `taskflow-helpers.ts` (#419) can consult `isApprovedReplay()` inside
 * `normalizeAgentIds` WITHOUT importing taskflow-approval — which would close
 * an import cycle (taskflow-helpers → taskflow-approval → mutation-confirmation
 * → taskflow-helpers). taskflow-approval re-exports both functions, so every
 * existing importer (`from './taskflow-approval.js'`) is unchanged.
 *
 * Single process-global. The replay runs OUTSIDE an agent turn (in the
 * poll-loop, before the LLM filter), so no concurrent MCP tool call can observe
 * it racing.
 */

let _approvedReplay = false;

/** True only while executeApprovedAction is re-invoking a handler. Gate sites
 *  (and the #419 actor binder) skip their gate/bind when set. */
export function isApprovedReplay(): boolean {
  return _approvedReplay;
}

/** Run `fn` with the gate-bypass flag set; always restore it, even if `fn` throws. */
export async function runAsApprovedReplay<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = _approvedReplay;
  _approvedReplay = true;
  try {
    return await fn();
  } finally {
    _approvedReplay = prev;
  }
}
