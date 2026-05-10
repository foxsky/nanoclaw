import { describe, expect, it } from 'vitest';
import { compareReplayResult } from './mutation-replay-compare.js';

describe('compareReplayResult — judge v1 vs v2 mutation parity', () => {
  it('both success, identical task_id → shape_match true', () => {
    const result = compareReplayResult(
      { success: true, task_id: 'T1' },
      { success: true, task_id: 'T1' },
    );
    expect(result.verdict).toBe('match');
    expect(result.v1_success).toBe(true);
    expect(result.v2_success).toBe(true);
  });

  it('both failure with matching error_code → shape_match', () => {
    const result = compareReplayResult(
      { success: false, error: 'Task not found', error_code: 'not_found' },
      { success: false, error: 'Task not found', error_code: 'not_found' },
    );
    expect(result.verdict).toBe('match');
  });

  it('both failure with different reasons → still match (both rejected)', () => {
    // Engine semantic differences are acceptable as long as both rejected.
    // Caller can drill into result.divergence for details if needed.
    const result = compareReplayResult(
      { success: false, error: 'Permission denied' },
      { success: false, error: 'Cannot ... in waiting' },
    );
    expect(result.verdict).toBe('both_rejected');
  });

  it('v1 success / v2 failure → regression flag', () => {
    const result = compareReplayResult(
      { success: true, task_id: 'T1' },
      { success: false, error: 'Permission denied' },
    );
    expect(result.verdict).toBe('regression');
    expect(result.divergence).toContain('Permission denied');
  });

  it('v1 failure / v2 success → relaxation flag (engine became more permissive)', () => {
    const result = compareReplayResult(
      { success: false, error: 'Permission denied' },
      { success: true, task_id: 'T1' },
    );
    expect(result.verdict).toBe('relaxation');
  });

  it('both success but different task_id → divergence flag', () => {
    const result = compareReplayResult(
      { success: true, task_id: 'T1' },
      { success: true, task_id: 'T2' },
    );
    expect(result.verdict).toBe('divergent_payload');
    expect(result.divergence).toMatch(/task_id/);
  });

  it('both success, v2 has extra fields → still match (additive evolution OK)', () => {
    const result = compareReplayResult(
      { success: true, task_id: 'T1' },
      { success: true, task_id: 'T1', wip_warning: { person: 'alice', current: 1, limit: 1 } },
    );
    expect(result.verdict).toBe('match');
  });

  it('v1 output null (orphan tool_use, no result) → cannot_compare', () => {
    const result = compareReplayResult(null, { success: true, task_id: 'T1' });
    expect(result.verdict).toBe('cannot_compare');
    expect(result.divergence).toMatch(/v1.*null|orphan/i);
  });

  it('exposes v2 error_code when present', () => {
    const result = compareReplayResult(
      { success: true, task_id: 'T1' },
      { success: false, error: 'X', error_code: 'ambiguous_task_context' },
    );
    expect(result.v2_error_code).toBe('ambiguous_task_context');
  });

  it('engine output wrapped in { success: true, data: {...} } (api_create/api_move shape) — unwraps for task_id check', () => {
    // v2 wrappers (api_create_simple_task etc.) return { success, data, notification_events }
    // and put task_id inside data. v1 returned task_id at the top level. Compare unwrapped.
    const result = compareReplayResult(
      { success: true, task_id: 'T1' },
      { success: true, data: { task_id: 'T1', column: 'inbox' }, notification_events: [] },
    );
    expect(result.verdict).toBe('match');
  });
});
