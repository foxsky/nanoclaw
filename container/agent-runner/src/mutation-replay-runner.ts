/**
 * A2.1.b — Bun-side mutation runner.
 *
 * Pure dispatch function over a v2 TaskflowEngine. Given a V2EngineCall
 * (the output of `v1ToV2EngineCall()` in scripts/mutation-replay-harness.ts),
 * invokes engine[method](params) and returns the result. Wraps any thrown
 * error into the same `{ success: false, error }` shape the engine uses
 * for rejections, so a single result-shape gives parity-comparison code
 * a stable surface.
 *
 * Lives in the Bun-side `container/agent-runner/` tree because the engine
 * uses `bun:sqlite`. Host-side `scripts/` (Node + better-sqlite3) cannot
 * import the engine; the pure pieces of the harness (parser, differ, fork
 * helper, compare verdict) live there and are language-agnostic. The full
 * corpus replay is then a Bun script that combines:
 *   1. (host) parseJsonlForMutations + v1ToV2EngineCall + forkSqliteDb
 *      → produces an array of (call, scratchDbPath, v1Output) records.
 *   2. (bun)  for each record: open TaskflowEngine on scratchDbPath,
 *      call runMutation(), compare via compareReplayResult().
 *
 * No assumptions about specific engine methods — runMutation is generic
 * over `method: string`, returning an error shape if the method is missing.
 */

import type { TaskflowEngine } from './taskflow-engine.ts';

export interface V2EngineCall {
  method: string;
  params: Record<string, unknown>;
}

export type RunnerResult = Record<string, unknown> & { success: boolean };

export function runMutation(engine: TaskflowEngine, call: V2EngineCall): RunnerResult {
  const fn = (engine as unknown as Record<string, unknown>)[call.method];
  if (typeof fn !== 'function') {
    return { success: false, error: `Unknown engine method: ${call.method}` };
  }
  try {
    // engine methods take a single params object (CreateParams, MoveParams,
    // AdminParams, ...) and return TaskflowResult-shaped objects.
    const result = (fn as (p: unknown) => unknown).call(engine, call.params);
    if (result && typeof result === 'object' && 'success' in result) {
      return result as RunnerResult;
    }
    return { success: false, error: 'Engine method returned non-result-shaped value' };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: message };
  }
}
