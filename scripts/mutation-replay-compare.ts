/**
 * A2.1.b — pure parity-verdict function for mutation replay.
 *
 * Given a v1 tool_result output (from session JSONL) and a v2 engine
 * output (or wrapped MCP-tool output), returns a structured verdict on
 * whether v2's behavior matches v1's.
 *
 * Verdicts:
 *   match              — both succeeded with consistent payload, OR both
 *                        failed with matching error_code.
 *   both_rejected      — both failed but error messages differ. Usually
 *                        acceptable (engine error-message wording can
 *                        evolve); flag for review.
 *   regression         — v1 success, v2 failure. Investigate.
 *   relaxation         — v1 failure, v2 success. Investigate (engine
 *                        became more permissive).
 *   divergent_payload  — both succeeded but the result payload differs
 *                        in a load-bearing field (task_id mismatch, etc.).
 *   cannot_compare     — v1 output is missing (orphan tool_use).
 *
 * v2 results may be either raw engine output ({success, task_id, ...}) or
 * wrapped MCP-tool output ({success, data: {...}, notification_events}).
 * We unwrap the `data` envelope before comparing task_id-shaped fields.
 */

export type ToolResult = Record<string, unknown> | null;

export type Verdict =
  | 'match'
  | 'both_rejected'
  | 'regression'
  | 'relaxation'
  | 'divergent_payload'
  | 'cannot_compare';

export interface ReplayComparison {
  verdict: Verdict;
  v1_success: boolean | null;
  v2_success: boolean | null;
  v2_error_code?: string;
  /** Human-readable reason when verdict != 'match'. */
  divergence?: string;
}

export function compareReplayResult(v1: ToolResult, v2: ToolResult): ReplayComparison {
  if (v1 == null) {
    return {
      verdict: 'cannot_compare',
      v1_success: null,
      v2_success: v2 == null ? null : Boolean(v2.success),
      divergence: 'v1 output is null (orphan tool_use)',
    };
  }
  if (v2 == null) {
    return {
      verdict: 'cannot_compare',
      v1_success: Boolean(v1.success),
      v2_success: null,
      divergence: 'v2 output is null',
    };
  }

  const v1Success = Boolean(v1.success);
  const v2Success = Boolean(v2.success);
  const v2ErrorCode =
    typeof v2.error_code === 'string' ? v2.error_code : undefined;
  const base: ReplayComparison = {
    verdict: 'match',
    v1_success: v1Success,
    v2_success: v2Success,
    ...(v2ErrorCode ? { v2_error_code: v2ErrorCode } : {}),
  };

  if (v1Success && v2Success) {
    return checkPayloadMatch(v1, v2, base);
  }
  if (!v1Success && !v2Success) {
    return resolveBothRejected(v1, v2, base);
  }
  if (v1Success && !v2Success) {
    return {
      ...base,
      verdict: 'regression',
      divergence: `v1 succeeded; v2 failed: ${stringField(v2, 'error') ?? '(no error message)'}`,
    };
  }
  // !v1Success && v2Success
  return {
    ...base,
    verdict: 'relaxation',
    divergence: `v1 failed (${stringField(v1, 'error') ?? '(no v1 error)'}); v2 succeeded`,
  };
}

function checkPayloadMatch(v1: Record<string, unknown>, v2: Record<string, unknown>, base: ReplayComparison): ReplayComparison {
  // v2 MCP-wrapper shape: { success, data: {...inner...}, notification_events }
  // Unwrap so the task_id check works against either shape.
  const v2Inner = unwrapData(v2);
  const v1Tid = stringField(v1, 'task_id');
  const v2Tid = stringField(v2Inner, 'task_id') ?? stringField(v2, 'task_id');

  if (v1Tid && v2Tid && v1Tid !== v2Tid) {
    return {
      ...base,
      verdict: 'divergent_payload',
      divergence: `task_id mismatch: v1=${v1Tid} vs v2=${v2Tid}`,
    };
  }
  return base; // match
}

function resolveBothRejected(v1: Record<string, unknown>, v2: Record<string, unknown>, base: ReplayComparison): ReplayComparison {
  const v1ErrCode = stringField(v1, 'error_code');
  const v2ErrCode = stringField(v2, 'error_code');
  if (v1ErrCode && v2ErrCode && v1ErrCode === v2ErrCode) {
    return base; // exact match on error_code → 'match'
  }
  // Both failed; either no error_code or mismatching codes. Surface as
  // 'both_rejected' so callers can decide if message-text drift matters.
  return {
    ...base,
    verdict: 'both_rejected',
    divergence: `v1=${stringField(v1, 'error') ?? '?'} | v2=${stringField(v2, 'error') ?? '?'}`,
  };
}

function unwrapData(result: Record<string, unknown>): Record<string, unknown> {
  const data = result.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return result;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}
