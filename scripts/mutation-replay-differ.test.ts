import { describe, expect, it } from 'vitest';
import { diffTaskState, diffHistoryCounts } from './mutation-replay-differ.js';

describe('diffTaskState — row-by-row task table diff', () => {
  it('reports an empty diff when before === after', () => {
    const snap = [{ id: 'T1', column: 'inbox', assignee: 'alice' }];
    const result = diffTaskState(snap, snap);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged_count).toBe(1);
  });

  it('detects added task', () => {
    const before = [{ id: 'T1', column: 'inbox' }];
    const after = [
      { id: 'T1', column: 'inbox' },
      { id: 'T2', column: 'inbox' },
    ];
    const result = diffTaskState(before, after);
    expect(result.added).toEqual(['T2']);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged_count).toBe(1);
  });

  it('detects removed task', () => {
    const before = [
      { id: 'T1', column: 'inbox' },
      { id: 'T2', column: 'inbox' },
    ];
    const after = [{ id: 'T1', column: 'inbox' }];
    const result = diffTaskState(before, after);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['T2']);
    expect(result.changed).toEqual([]);
    expect(result.unchanged_count).toBe(1);
  });

  it('detects a single-field change with before/after values', () => {
    const before = [{ id: 'T1', column: 'inbox', assignee: 'alice' }];
    const after = [{ id: 'T1', column: 'in_progress', assignee: 'alice' }];
    const result = diffTaskState(before, after);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([
      {
        id: 'T1',
        fields: { column: { before: 'inbox', after: 'in_progress' } },
      },
    ]);
    expect(result.unchanged_count).toBe(0);
  });

  it('detects multi-field changes on the same task', () => {
    const before = [{ id: 'T1', column: 'inbox', assignee: 'alice', due_date: null }];
    const after = [{ id: 'T1', column: 'in_progress', assignee: 'bob', due_date: '2026-12-01' }];
    const result = diffTaskState(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].id).toBe('T1');
    expect(Object.keys(result.changed[0].fields).sort()).toEqual(['assignee', 'column', 'due_date']);
    expect(result.changed[0].fields.due_date).toEqual({ before: null, after: '2026-12-01' });
  });

  it('treats null and undefined as equal', () => {
    const before = [{ id: 'T1', column: 'inbox', assignee: null }];
    const after = [{ id: 'T1', column: 'inbox', assignee: undefined as unknown as string }];
    const result = diffTaskState(before, after);
    expect(result.changed).toEqual([]);
    expect(result.unchanged_count).toBe(1);
  });

  it('treats missing-key as equal to null/undefined', () => {
    const before = [{ id: 'T1', column: 'inbox' }];
    const after = [{ id: 'T1', column: 'inbox', assignee: null }];
    const result = diffTaskState(before, after);
    expect(result.changed).toEqual([]);
  });

  it('reports a real value vs null/missing as a change', () => {
    const before = [{ id: 'T1', column: 'inbox' }];
    const after = [{ id: 'T1', column: 'inbox', assignee: 'alice' }];
    const result = diffTaskState(before, after);
    expect(result.changed).toEqual([
      { id: 'T1', fields: { assignee: { before: undefined, after: 'alice' } } },
    ]);
  });

  it('ignores volatile fields by default: updated_at, _last_mutation', () => {
    const before = [
      { id: 'T1', column: 'inbox', updated_at: '2026-01-01', _last_mutation: 'foo' },
    ];
    const after = [
      { id: 'T1', column: 'inbox', updated_at: '2026-12-01', _last_mutation: 'bar' },
    ];
    const result = diffTaskState(before, after);
    expect(result.changed).toEqual([]);
    expect(result.unchanged_count).toBe(1);
  });

  it('respects an explicit ignoreFields override', () => {
    const before = [{ id: 'T1', column: 'inbox', flag: 1 }];
    const after = [{ id: 'T1', column: 'inbox', flag: 99 }];
    const withIgnore = diffTaskState(before, after, { ignoreFields: new Set(['flag']) });
    expect(withIgnore.changed).toEqual([]);

    const withoutIgnore = diffTaskState(before, after, { ignoreFields: new Set() });
    expect(withoutIgnore.changed).toHaveLength(1);
  });

  it('handles JSON-stringified columns: identical JSON arrays produce no diff', () => {
    const before = [{ id: 'T1', column: 'inbox', labels: '["urgent","red"]' }];
    const after = [{ id: 'T1', column: 'inbox', labels: '["urgent","red"]' }];
    const result = diffTaskState(before, after);
    expect(result.changed).toEqual([]);
  });

  it('handles a complex mixed scenario: added + removed + changed simultaneously', () => {
    const before = [
      { id: 'T1', column: 'inbox' },
      { id: 'T2', column: 'in_progress' },
      { id: 'T3', column: 'done' },
    ];
    const after = [
      { id: 'T1', column: 'in_progress' }, // changed
      // T2 removed
      { id: 'T3', column: 'done' }, // unchanged
      { id: 'T4', column: 'inbox' }, // added
    ];
    const result = diffTaskState(before, after);
    expect(result.added).toEqual(['T4']);
    expect(result.removed).toEqual(['T2']);
    expect(result.changed).toEqual([
      { id: 'T1', fields: { column: { before: 'inbox', after: 'in_progress' } } },
    ]);
    expect(result.unchanged_count).toBe(1);
  });
});

describe('diffHistoryCounts — task_history row deltas', () => {
  it('returns zero delta for identical row counts per task', () => {
    const before = [
      { task_id: 'T1', action: 'created' },
      { task_id: 'T1', action: 'moved' },
    ];
    const after = [...before];
    expect(diffHistoryCounts(before, after)).toEqual({ added_total: 0, per_task: {} });
  });

  it('counts rows added per task_id', () => {
    const before = [{ task_id: 'T1', action: 'created' }];
    const after = [
      { task_id: 'T1', action: 'created' },
      { task_id: 'T1', action: 'moved' },
      { task_id: 'T2', action: 'created' },
    ];
    expect(diffHistoryCounts(before, after)).toEqual({
      added_total: 2,
      per_task: { T1: 1, T2: 1 },
    });
  });

  it('does not report removed history rows (history is append-only)', () => {
    const before = [
      { task_id: 'T1', action: 'created' },
      { task_id: 'T1', action: 'moved' },
    ];
    const after = [{ task_id: 'T1', action: 'created' }];
    // History should never shrink in a valid replay; we still don't crash, just report 0 added.
    expect(diffHistoryCounts(before, after)).toEqual({ added_total: 0, per_task: {} });
  });
});
