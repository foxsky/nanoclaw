/**
 * Pure parity-verdict function for mutation replay. The Verdict union
 * documents the result space.
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
      divergence: `v1 succeeded; v2 failed: ${extractFailureReason(v2)}`,
    };
  }
  return {
    ...base,
    verdict: 'relaxation',
    divergence: `v1 failed (${extractFailureReason(v1)}); v2 succeeded`,
  };
}

function checkPayloadMatch(v1: Record<string, unknown>, v2: Record<string, unknown>, base: ReplayComparison): ReplayComparison {
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
    return base;
  }
  return {
    ...base,
    verdict: 'both_rejected',
    divergence: `v1=${extractFailureReason(v1)} | v2=${extractFailureReason(v2)}`,
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

/**
 * Engine rejections surface via `error` (string) OR `offer_register` (object
 * emitted by buildOfferRegisterError when a referenced person isn't registered).
 * Both must be checked or we lose the reason on the offer_register branch.
 */
function extractFailureReason(result: Record<string, unknown>): string {
  const errorStr = stringField(result, 'error');
  if (errorStr) return errorStr;

  const offer = result.offer_register;
  if (offer && typeof offer === 'object' && !Array.isArray(offer)) {
    const o = offer as Record<string, unknown>;
    const name = stringField(o, 'name');
    const message = stringField(o, 'message');
    if (name || message) {
      return `offer_register${name ? ` (${name})` : ''}${message ? `: ${message}` : ''}`;
    }
  }
  return '(no error message)';
}
