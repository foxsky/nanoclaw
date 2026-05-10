/**
 * A2.1.c — pure state-differ for mutation-replay parity tests.
 *
 * Compares two snapshots of the `tasks` table (and optionally `task_history`)
 * to determine whether a v2 mutation produced the same delta as v1.
 *
 * Volatile timestamp fields are ignored by default — `updated_at` and
 * `_last_mutation` always change on any successful mutation, so they're
 * not meaningful signal for parity comparison. Callers can override via
 * the `ignoreFields` option.
 *
 * Null/undefined/missing are treated as the same absence of value, since
 * SQLite returns null for nullable columns and JS `delete row.col` produces
 * `undefined` — they mean the same thing to a row consumer.
 */

export type TaskRow = Record<string, unknown>;

export interface FieldDiff {
  before: unknown;
  after: unknown;
}

export interface TaskChanged {
  id: string;
  fields: Record<string, FieldDiff>;
}

export interface StateDiff {
  added: string[];
  removed: string[];
  changed: TaskChanged[];
  unchanged_count: number;
}

export interface DiffOptions {
  /** Field names whose changes should be suppressed from the diff. */
  ignoreFields?: ReadonlySet<string>;
}

const DEFAULT_IGNORE: ReadonlySet<string> = new Set(['updated_at', '_last_mutation']);

export function diffTaskState(
  before: TaskRow[],
  after: TaskRow[],
  options: DiffOptions = {},
): StateDiff {
  const ignore = options.ignoreFields ?? DEFAULT_IGNORE;
  const beforeById = new Map(before.map((r) => [String(r.id), r]));
  const afterById = new Map(after.map((r) => [String(r.id), r]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: TaskChanged[] = [];
  let unchanged_count = 0;

  for (const id of afterById.keys()) {
    if (!beforeById.has(id)) added.push(id);
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) removed.push(id);
  }

  for (const [id, beforeRow] of beforeById) {
    const afterRow = afterById.get(id);
    if (!afterRow) continue;
    const fields = compareRows(beforeRow, afterRow, ignore);
    if (Object.keys(fields).length === 0) unchanged_count++;
    else changed.push({ id, fields });
  }

  return { added, removed, changed, unchanged_count };
}

function compareRows(
  before: TaskRow,
  after: TaskRow,
  ignore: ReadonlySet<string>,
): Record<string, FieldDiff> {
  const fields: Record<string, FieldDiff> = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (ignore.has(key) || key === 'id') continue;
    const b = before[key];
    const a = after[key];
    if (!equivalent(b, a)) fields[key] = { before: b, after: a };
  }
  return fields;
}

function equivalent(a: unknown, b: unknown): boolean {
  // null / undefined / missing-key all collapse to "no value"
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

export interface HistoryDiff {
  added_total: number;
  /** Per-task_id count of newly-appended history rows. */
  per_task: Record<string, number>;
}

export function diffHistoryCounts(
  before: ReadonlyArray<{ task_id: string }>,
  after: ReadonlyArray<{ task_id: string }>,
): HistoryDiff {
  const beforeCounts = new Map<string, number>();
  for (const row of before) {
    beforeCounts.set(row.task_id, (beforeCounts.get(row.task_id) ?? 0) + 1);
  }
  const afterCounts = new Map<string, number>();
  for (const row of after) {
    afterCounts.set(row.task_id, (afterCounts.get(row.task_id) ?? 0) + 1);
  }

  const per_task: Record<string, number> = {};
  let added_total = 0;
  for (const [taskId, afterN] of afterCounts) {
    const delta = afterN - (beforeCounts.get(taskId) ?? 0);
    if (delta > 0) {
      per_task[taskId] = delta;
      added_total += delta;
    }
  }
  return { added_total, per_task };
}
