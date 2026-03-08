/**
 * TaskflowEngine — query + mutation engine for TaskFlow boards.
 *
 * All methods are SYNCHRONOUS (better-sqlite3 is sync by design).
 * Provides 36 query types covering board views, task details, search,
 * statistics, person queries, and change history, plus mutation methods
 * for creating, updating, and managing tasks.
 */
import Database from 'better-sqlite3';

/* ------------------------------------------------------------------ */
/*  Public interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface QueryParams {
  query: string;
  sender_name?: string;
  person_name?: string;
  task_id?: string;
  search_text?: string;
  label?: string;
  since?: string;
}

export interface TaskflowResult {
  success: boolean;
  data?: any;
  formatted?: string;
  error?: string;
  [key: string]: any;
}

export interface CreateParams {
  board_id: string;
  type: 'simple' | 'project' | 'recurring' | 'inbox';
  title: string;
  assignee?: string;
  due_date?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  labels?: string[];
  subtasks?: Array<string | { title: string; assignee?: string }>;
  recurrence?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrence_anchor?: string;
  max_cycles?: number;
  recurrence_end_date?: string;
  sender_name: string;
  allow_non_business_day?: boolean;
}

export interface CreateResult extends TaskflowResult {
  task_id?: string;
  column?: string;
  offer_register?: {
    name: string;
    message: string;
  };
  notifications?: Array<{
    target_person_id: string;
    notification_group_jid: string | null;
    message: string;
  }>;
}

export interface MoveParams {
  board_id: string;
  task_id: string;
  action: 'start' | 'wait' | 'resume' | 'return' | 'review' | 'approve' | 'reject' | 'conclude' | 'reopen' | 'force_start';
  sender_name: string;
  reason?: string;
  subtask_id?: string;
}

export interface MoveResult extends TaskflowResult {
  task_id?: string;
  from_column?: string;
  to_column?: string;
  wip_warning?: { person: string; current: number; limit: number };
  project_update?: { completed_subtask: string; next_subtask?: string; all_complete: boolean };
  recurring_cycle?: { cycle_number: number; expired: boolean; new_due_date?: string; reason?: 'max_cycles' | 'end_date' };
  archive_triggered?: boolean;
  notifications?: Array<{ target_person_id: string; notification_group_jid: string | null; message: string }>;
  parent_notification?: { parent_group_jid: string; message: string };
}

export interface ReassignParams {
  board_id: string;
  task_id?: string;           // single task reassignment
  source_person?: string;     // bulk transfer: transfer all from this person
  target_person: string;      // person name
  sender_name: string;
  confirmed: boolean;         // false = dry run
}

export interface ReassignResult extends TaskflowResult {
  tasks_affected?: Array<{
    task_id: string;
    title: string;
    was_linked: boolean;
    relinked_to?: string;
  }>;
  offer_register?: { name: string; message: string };
  requires_confirmation?: string;  // human-readable summary for dry run
  notifications?: Array<{ target_person_id: string; notification_group_jid: string | null; message: string }>;
}

export interface UpdateParams {
  board_id: string;
  task_id: string;
  sender_name: string;
  updates: {
    title?: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    due_date?: string | null;   // null = remove
    description?: string;
    next_action?: string;
    add_label?: string;
    remove_label?: string;
    add_note?: string;
    edit_note?: { id: number; text: string };
    remove_note?: number;
    add_subtask?: string;         // project only
    rename_subtask?: { id: string; title: string };
    reopen_subtask?: string;      // subtask ID
    assign_subtask?: { id: string; assignee: string };   // assign person to subtask
    unassign_subtask?: string;    // subtask ID to unassign
    recurrence?: string;          // change frequency
    max_cycles?: number | null;            // null = remove bound
    recurrence_end_date?: string | null;   // null = remove bound
    allow_non_business_day?: boolean;
  };
}

export interface UpdateResult extends TaskflowResult {
  task_id?: string;
  changes?: string[];      // human-readable list of what changed
  offer_register?: { name: string; message: string };
  notifications?: Array<{ target_person_id: string; notification_group_jid: string | null; message: string }>;
}

export interface DependencyParams {
  board_id: string;
  action: 'add_dep' | 'remove_dep' | 'add_reminder' | 'remove_reminder';
  task_id: string;
  target_task_id?: string;   // for dependencies
  reminder_days?: number;    // for reminders
  sender_name: string;
}

export interface DependencyResult extends TaskflowResult {
  task_id?: string;
  change?: string;           // human-readable description of what changed
}

export interface UndoParams {
  board_id: string;
  sender_name: string;
  force?: boolean;  // override WIP guard
}

export interface UndoResult extends TaskflowResult {
  task_id?: string;
  undone_action?: string;
}

export interface AdminParams {
  board_id: string;
  action: 'register_person' | 'remove_person' | 'add_manager' | 'add_delegate' | 'remove_admin' | 'set_wip_limit' | 'cancel_task' | 'restore_task' | 'process_inbox' | 'manage_holidays';
  sender_name: string;
  person_name?: string;
  phone?: string;
  role?: string;
  wip_limit?: number;
  task_id?: string;
  confirmed?: boolean;
  force?: boolean;
  group_name?: string;
  group_folder?: string;
  holiday_operation?: 'add' | 'remove' | 'set_year' | 'list';
  holidays?: Array<{ date: string; label?: string }>;
  holiday_dates?: string[];
  holiday_year?: number;
}

export interface AdminResult extends TaskflowResult {
  person_id?: string;
  tasks_to_reassign?: Array<{ task_id: string; title: string }>;
  tasks?: any[];
  auto_provision_request?: {
    person_id: string;
    person_name: string;
    person_phone: string;
    person_role: string;
    group_name?: string;
    group_folder?: string;
    message: string;
  };
}

export interface ReportParams {
  board_id: string;
  type: 'standup' | 'digest' | 'weekly';
}

export interface ReportResult extends TaskflowResult {
  data?: {
    date: string;
    overdue: Array<{ id: string; title: string; assignee_name: string | null; due_date: string }>;
    in_progress: Array<{ id: string; title: string; assignee_name: string | null }>;
    review: Array<{ id: string; title: string; assignee_name: string | null }>;
    due_today: Array<{ id: string; title: string; assignee_name: string | null }>;
    waiting: Array<{ id: string; title: string; assignee_name: string | null; waiting_for: string | null }>;
    blocked: Array<{ id: string; title: string; assignee_name: string | null; blocked_by: string[] }>;
    completed_today: Array<{ id: string; title: string; assignee_name: string | null }>;
    changes_today_count: number;
    per_person: Array<{
      name: string;
      in_progress: number;
      waiting: number;
      subtask_assignments?: number;
      completed_today?: number;
      completed_week?: number;
    }>;
    stats?: {
      total_active: number;
      completed_week: number;
      created_week: number;
      trend: 'up' | 'down' | 'same';
    };
  };
}

export interface HierarchyParams {
  board_id: string;
  action: 'link' | 'unlink' | 'refresh_rollup' | 'tag_parent';
  task_id: string;
  person_name?: string;       // for link — target person with child board
  parent_task_id?: string;    // for tag_parent — parent board deliverable ID
  sender_name: string;
}

export interface HierarchyResult extends TaskflowResult {
  task_id?: string;
  rollup_status?: string;
  rollup_summary?: string;
  new_column?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Monday of the current ISO week (Mon-Sun). */
function weekStart(): string {
  const d = new Date();
  const day = d.getDay(); // 0=Sun … 6=Sat
  const diff = day === 0 ? 6 : day - 1; // how many days since Monday
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

/** Sunday of the current ISO week. */
function weekEnd(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function sevenDaysFromNow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Monday of the previous ISO week. */
function lastWeekStart(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff - 7);
  return d.toISOString().slice(0, 10);
}

/** Sunday of the previous ISO week. */
function lastWeekEnd(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff - 1);
  return d.toISOString().slice(0, 10);
}

/** Compute a reminder date by subtracting days from a due date. */
function reminderDateFromDue(dueDate: string, daysBefore: number): string {
  const d = new Date(dueDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysBefore);
  return d.toISOString().slice(0, 10);
}

/** Advance a date by a recurrence interval and return the ISO date string. */
function advanceDateByRecurrence(d: Date, recurrence: 'daily' | 'weekly' | 'monthly' | 'yearly'): string {
  switch (recurrence) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/*  TaskflowEngine                                                     */
/* ------------------------------------------------------------------ */

export class TaskflowEngine {
  private static readonly moveActionLabels: Record<MoveParams['action'], string> = {
    start: 'movida para 🔄 Em Andamento',
    wait: 'movida para ⏳ Aguardando',
    resume: 'retomada → 🔄 Em Andamento',
    return: 'devolvida → ⏭️ Próximas Ações',
    review: 'enviada para 🔍 Revisão',
    approve: '✅ aprovada',
    reject: '↩️ rejeitada — retrabalho necessário',
    conclude: '✅ concluída',
    reopen: 'reaberta → ⏭️ Próximas Ações',
    force_start: 'forçada para 🔄 Em Andamento',
  };

  constructor(
    private db: Database.Database,
    private boardId: string,
  ) {
    this.db.pragma('busy_timeout = 5000');
    this.ensureTaskSchema();
    this.migrateLegacyProjectSubtasks();
    this.reconcileDelegationLinks();
  }

  private visibleTaskScope(alias = ''): string {
    const prefix = alias ? `${alias}.` : '';
    return `(${prefix}board_id = ? OR (${prefix}child_exec_board_id = ? AND ${prefix}child_exec_enabled = 1))`;
  }

  private visibleTaskParams(): [string, string] {
    return [this.boardId, this.boardId];
  }

  private taskBoardId(task: any): string {
    return task?.owning_board_id ?? task?.board_id ?? this.boardId;
  }

  /** Get the short_code for a board. */
  private getBoardShortCode(boardId: string): string | null {
    const row = this.db
      .prepare(`SELECT short_code FROM boards WHERE id = ?`)
      .get(boardId) as { short_code: string | null } | undefined;
    return row?.short_code ?? null;
  }

  /** Display ID: prefix delegated tasks with source board's short_code. */
  private displayId(task: any): string {
    const owning = task.owning_board_id ?? task.board_id;
    if (owning === this.boardId) return task.id;
    const sc = this.getBoardShortCode(owning);
    return sc ? `${sc}-${task.id}` : task.id;
  }

  /** Resolve a potentially board-prefixed task ID (e.g. SEC-T10 → board_id + T10). */
  private resolveInputTaskId(taskId: string): { boardId: string | null; rawId: string } {
    const match = taskId.match(/^([A-Z]{2,})-(.+)$/);
    if (!match) return { boardId: null, rawId: taskId };
    const [, shortCode, rawId] = match;
    const row = this.db
      .prepare(`SELECT id FROM boards WHERE short_code = ?`)
      .get(shortCode) as { id: string } | undefined;
    return { boardId: row?.id ?? null, rawId };
  }

  private static readonly WEEKDAY_NAMES_PT: Record<number, string> = {
    0: 'domingo', 1: 'segunda-feira', 2: 'terça-feira', 3: 'quarta-feira',
    4: 'quinta-feira', 5: 'sexta-feira', 6: 'sábado',
  };

  private _holidayCache: Map<string, string | null> | null = null;

  /** Lazily load all board holidays into a Map<date, label>. Cached per engine instance. */
  private getBoardHolidays(): Map<string, string | null> {
    if (!this._holidayCache) {
      const rows = this.db
        .prepare(`SELECT holiday_date, label FROM board_holidays WHERE board_id = ?`)
        .all(this.boardId) as Array<{ holiday_date: string; label: string | null }>;
      this._holidayCache = new Map(rows.map((r) => [r.holiday_date, r.label]));
    }
    return this._holidayCache;
  }

  /** Check if a date string (YYYY-MM-DD) falls on a weekend or board holiday. */
  private isNonBusinessDay(dateStr: string): { weekend: boolean; holiday: boolean; dow: number; label?: string } {
    const d = new Date(dateStr + 'T12:00:00Z');
    const dow = d.getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const holidays = this.getBoardHolidays();
    const holidayLabel = holidays.get(dateStr);
    return { weekend, holiday: holidayLabel !== undefined, dow, label: holidayLabel ?? undefined };
  }

  /** Return the next business day (YYYY-MM-DD) that is not a weekend or board holiday. */
  private getNextBusinessDay(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00Z');
    for (let i = 0; i < 30; i++) {
      d.setUTCDate(d.getUTCDate() + 1);
      const candidate = d.toISOString().slice(0, 10);
      const check = this.isNonBusinessDay(candidate);
      if (!check.weekend && !check.holiday) return candidate;
    }
    return dateStr;
  }

  /** Shift a date to the next business day if it falls on a weekend or holiday. */
  private shiftToBusinessDay(dateStr: string): string {
    const check = this.isNonBusinessDay(dateStr);
    if (check.weekend || check.holiday) return this.getNextBusinessDay(dateStr);
    return dateStr;
  }

  /** Validate a due date against weekends/holidays. Returns warning result or null if OK. */
  private checkNonBusinessDay(dateStr: string, allowOverride: boolean): TaskflowResult | null {
    if (allowOverride) return null;
    const check = this.isNonBusinessDay(dateStr);
    if (!check.weekend && !check.holiday) return null;
    const dayName = TaskflowEngine.WEEKDAY_NAMES_PT[check.dow];
    const reason = check.holiday
      ? (check.label ? `feriado (${check.label})` : 'feriado')
      : dayName;
    const suggested = this.getNextBusinessDay(dateStr);
    const sugDow = new Date(suggested + 'T12:00:00Z').getUTCDay();
    const sugDayName = TaskflowEngine.WEEKDAY_NAMES_PT[sugDow];
    return {
      success: false,
      non_business_day_warning: true,
      original_date: dateStr,
      suggested_date: suggested,
      reason,
      error: `Due date falls on ${reason} (${dateStr}). Suggest ${suggested} (${sugDayName}).`,
    };
  }

  private static legacySubtaskColumn(subtask: { status?: string; column?: string }): string {
    if (typeof subtask.column === 'string' && subtask.column.trim() !== '') {
      return subtask.column;
    }
    return subtask.status === 'done' ? 'done' : 'next_action';
  }

  private ensureTaskSchema(): void {
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN max_cycles INTEGER`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_end_date TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN participants TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_at TEXT`); } catch {}
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(board_id, parent_task_id)
       WHERE parent_task_id IS NOT NULL`,
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_holidays (
        board_id TEXT NOT NULL,
        holiday_date TEXT NOT NULL,
        label TEXT,
        PRIMARY KEY (board_id, holiday_date)
      )
    `);

    try { this.db.exec(`ALTER TABLE boards ADD COLUMN short_code TEXT`); } catch {}

    try { this.db.exec(`ALTER TABLE board_runtime_config ADD COLUMN country TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE board_runtime_config ADD COLUMN state TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE board_runtime_config ADD COLUMN city TEXT`); } catch {}

    // Per-prefix counters table (extensible for any future task type prefixes)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_id_counters (
        board_id TEXT NOT NULL,
        prefix TEXT NOT NULL,
        next_number INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (board_id, prefix)
      )
    `);

    // Migrate legacy per-column counters into the new table (one-time)
    const hasLegacy = (() => {
      try {
        return this.db.prepare(`SELECT next_task_number FROM board_config WHERE board_id = ?`).get(this.boardId) as any;
      } catch { return null; }
    })();
    if (hasLegacy) {
      const legacyMap: Record<string, string> = { T: 'next_task_number', P: 'next_project_number', R: 'next_recurring_number' };
      for (const [prefix, col] of Object.entries(legacyMap)) {
        const existing = this.db.prepare(`SELECT next_number FROM board_id_counters WHERE board_id = ? AND prefix = ?`).get(this.boardId, prefix) as any;
        if (!existing) {
          let val: number;
          try {
            const row = this.db.prepare(`SELECT ${col} FROM board_config WHERE board_id = ?`).get(this.boardId) as any;
            val = row?.[col] ?? 1;
          } catch { val = 1; }
          // Also check max existing ID in tasks to avoid collisions
          const maxRow = this.db.prepare(
            `SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) AS m FROM tasks WHERE board_id = ? AND id GLOB ? AND id NOT GLOB ?`
          ).get(this.boardId, `${prefix}[0-9]*`, `${prefix}*.*`) as any;
          const fromTasks = (maxRow?.m ?? 0) + 1;
          this.db.prepare(`INSERT INTO board_id_counters (board_id, prefix, next_number) VALUES (?, ?, ?)`)
            .run(this.boardId, prefix, Math.max(val, fromTasks));
        }
      }
    }
  }

  private migrateLegacyProjectSubtasks(): void {
    const projectRows = this.db
      .prepare(
        `SELECT id, board_id, assignee, priority, created_at, updated_at, subtasks
         FROM tasks
         WHERE type = 'project' AND subtasks IS NOT NULL AND subtasks != '' AND subtasks != '[]'`,
      )
      .all() as Array<{
      id: string;
      board_id: string;
      assignee: string | null;
      priority: string | null;
      created_at: string;
      updated_at: string;
      subtasks: string;
    }>;

    const subtaskRow = this.db.prepare(
      `SELECT id, title, assignee, "column", parent_task_id, priority,
              child_exec_enabled, child_exec_board_id, child_exec_person_id
         FROM tasks
        WHERE board_id = ? AND id = ?`,
    );
    const insertSubtask = this.db.prepare(
      `INSERT INTO tasks (
        id, board_id, type, title, assignee, column,
        parent_task_id, priority, labels,
        child_exec_enabled, child_exec_board_id, child_exec_person_id,
        _last_mutation, created_at, updated_at
      ) VALUES (?, ?, 'simple', ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    );
    const reconcileSubtask = this.db.prepare(
      `UPDATE tasks
          SET title = ?, assignee = ?, "column" = ?, parent_task_id = ?, priority = ?,
              child_exec_enabled = ?, child_exec_board_id = ?, child_exec_person_id = ?
        WHERE board_id = ? AND id = ?`,
    );
    const clearLegacySubtasks = this.db.prepare(
      `UPDATE tasks SET subtasks = NULL WHERE board_id = ? AND id = ?`,
    );

    for (const row of projectRows) {
      let subtasks: any[];
      try {
        subtasks = JSON.parse(row.subtasks ?? '[]');
      } catch {
        continue;
      }
      if (!Array.isArray(subtasks) || subtasks.length === 0) continue;

      let allMigrated = true;
      for (let i = 0; i < subtasks.length; i++) {
        const subtask = subtasks[i] ?? {};
        const subtaskId =
          typeof subtask.id === 'string' && subtask.id.trim() !== ''
            ? subtask.id
            : `${row.id}.${i + 1}`;
        const title =
          typeof subtask.title === 'string' && subtask.title.trim() !== ''
            ? subtask.title
            : `Subtask ${i + 1}`;
        const assignee =
          typeof subtask.assignee === 'string' && subtask.assignee.trim() !== ''
            ? subtask.assignee
            : row.assignee;
        const column = TaskflowEngine.legacySubtaskColumn(subtask);
        const childLink = this.linkedChildBoardFor(row.board_id, assignee ?? null);
        const existing = subtaskRow.get(row.board_id, subtaskId) as
          | {
              id: string;
              title: string;
              assignee: string | null;
              column: string;
              parent_task_id: string | null;
              priority: string | null;
              child_exec_enabled: number;
              child_exec_board_id: string | null;
              child_exec_person_id: string | null;
            }
          | undefined;

        if (!existing) {
          insertSubtask.run(
            subtaskId,
            row.board_id,
            title,
            assignee ?? null,
            column,
            row.id,
            row.priority ?? null,
            childLink.child_exec_enabled,
            childLink.child_exec_board_id,
            childLink.child_exec_person_id,
            null,
            row.created_at,
            row.updated_at,
          );
        } else {
          reconcileSubtask.run(
            title,
            assignee ?? null,
            column,
            row.id,
            row.priority ?? null,
            childLink.child_exec_enabled,
            childLink.child_exec_board_id,
            childLink.child_exec_person_id,
            row.board_id,
            subtaskId,
          );
        }
      }

      for (let i = 0; i < subtasks.length; i++) {
        const subtask = subtasks[i] ?? {};
        const subtaskId =
          typeof subtask.id === 'string' && subtask.id.trim() !== ''
            ? subtask.id
            : `${row.id}.${i + 1}`;
        const assignee =
          typeof subtask.assignee === 'string' && subtask.assignee.trim() !== ''
            ? subtask.assignee
            : row.assignee;
        const expectedColumn = TaskflowEngine.legacySubtaskColumn(subtask);
        const expectedChildLink = this.linkedChildBoardFor(row.board_id, assignee ?? null);
        const existing = subtaskRow.get(row.board_id, subtaskId) as
          | {
              title: string;
              assignee: string | null;
              column: string;
              parent_task_id: string | null;
              priority: string | null;
              child_exec_enabled: number;
              child_exec_board_id: string | null;
              child_exec_person_id: string | null;
            }
          | undefined;
        if (
          !existing ||
          existing.parent_task_id !== row.id ||
          existing.assignee !== (assignee ?? null) ||
          existing.column !== expectedColumn ||
          existing.child_exec_enabled !== expectedChildLink.child_exec_enabled ||
          (existing.child_exec_board_id ?? null) !== expectedChildLink.child_exec_board_id ||
          (existing.child_exec_person_id ?? null) !== expectedChildLink.child_exec_person_id
        ) {
          allMigrated = false;
          break;
        }
      }

      if (allMigrated) {
        clearLegacySubtasks.run(row.board_id, row.id);
      }
    }
  }

  private reconcileDelegationLinks(): void {
    const rows = this.db
      .prepare(
        `SELECT id, board_id, assignee, child_exec_enabled, child_exec_board_id, child_exec_person_id
           FROM tasks
          WHERE assignee IS NOT NULL
            AND (
              parent_task_id IS NOT NULL
              OR recurrence IS NOT NULL
            )`,
      )
      .all() as Array<{
      id: string;
      board_id: string;
      assignee: string | null;
      child_exec_enabled: number;
      child_exec_board_id: string | null;
      child_exec_person_id: string | null;
    }>;

    const update = this.db.prepare(
      `UPDATE tasks
          SET child_exec_enabled = ?, child_exec_board_id = ?, child_exec_person_id = ?
        WHERE board_id = ? AND id = ?`,
    );

    for (const row of rows) {
      const expected = this.linkedChildBoardFor(row.board_id, row.assignee ?? null);
      if (
        row.child_exec_enabled !== expected.child_exec_enabled ||
        (row.child_exec_board_id ?? null) !== expected.child_exec_board_id ||
        (row.child_exec_person_id ?? null) !== expected.child_exec_person_id
      ) {
        update.run(
          expected.child_exec_enabled,
          expected.child_exec_board_id,
          expected.child_exec_person_id,
          row.board_id,
          row.id,
        );
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Public helpers (used by mutation tools later)                     */
  /* ---------------------------------------------------------------- */

  /** Resolve a human-readable name to a person_id + canonical name. */
  resolvePerson(name: string): { person_id: string; name: string } | null {
    // 1. Exact match by name (case-insensitive)
    const exact = this.db
      .prepare(
        `SELECT person_id, name FROM board_people
         WHERE board_id = ? AND LOWER(name) = LOWER(?)`,
      )
      .get(this.boardId, name) as
      | { person_id: string; name: string }
      | undefined;
    if (exact) return exact;

    // 2. Exact match by person_id
    const byId = this.db
      .prepare(
        `SELECT person_id, name FROM board_people
         WHERE board_id = ? AND LOWER(person_id) = LOWER(?)`,
      )
      .get(this.boardId, name) as
      | { person_id: string; name: string }
      | undefined;
    if (byId) return byId;

    // 3. First-name match: compare first word of input against first word of each name
    const firstName = name.split(/\s+/)[0];
    if (firstName) {
      const all = this.db
        .prepare(
          `SELECT person_id, name FROM board_people WHERE board_id = ?`,
        )
        .all(this.boardId) as Array<{ person_id: string; name: string }>;
      const matches = all.filter(
        (p) => p.name.split(/\s+/)[0].toLowerCase() === firstName.toLowerCase(),
      );
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  /** Check if this board can delegate downward (not a leaf board). */
  private canDelegateDown(): boolean {
    const row = this.db
      .prepare(`SELECT hierarchy_level, max_depth FROM boards WHERE id = ?`)
      .get(this.boardId) as { hierarchy_level: number | null; max_depth: number | null } | undefined;
    return row?.hierarchy_level != null && row?.max_depth != null && row.hierarchy_level < row.max_depth;
  }

  private static readonly TASK_BY_BOARD_SQL =
    `SELECT tasks.*, tasks.board_id AS owning_board_id FROM tasks WHERE board_id = ? AND id = ?`;

  /** Fetch a single active task by its id. Handles board-prefixed IDs (e.g. SEC-T10). */
  getTask(taskId: string): any {
    const { boardId: targetBoardId, rawId } = this.resolveInputTaskId(taskId);
    if (targetBoardId) {
      // Short-code resolved — still enforce visibility (local or delegated to this board)
      const task = this.db.prepare(TaskflowEngine.TASK_BY_BOARD_SQL).get(targetBoardId, rawId) as any | undefined;
      if (!task) return null;
      if (task.board_id === this.boardId) return task;
      if (task.child_exec_board_id === this.boardId && task.child_exec_enabled === 1) return task;
      return null;
    }
    // Prefer local board for ambiguous IDs
    const local = this.db.prepare(TaskflowEngine.TASK_BY_BOARD_SQL).get(this.boardId, rawId);
    if (local) return local;
    // Fall back to delegated tasks
    return this.db
      .prepare(
        `SELECT tasks.*, tasks.board_id AS owning_board_id FROM tasks
         WHERE child_exec_board_id = ? AND child_exec_enabled = 1 AND id = ?`,
      )
      .get(this.boardId, rawId) ?? null;
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  private getAllActiveTasks(): any[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE ${this.visibleTaskScope()} ORDER BY id`)
      .all(...this.visibleTaskParams());
  }

  private getTasksByColumn(column: string): any[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${this.visibleTaskScope()} AND column = ? ORDER BY id`,
      )
      .all(...this.visibleTaskParams(), column);
  }

  private getTasksByAssignee(personId: string): any[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${this.visibleTaskScope()} AND assignee = ? ORDER BY id`,
      )
      .all(...this.visibleTaskParams(), personId);
  }

  private getSubtaskRows(parentTaskId: string, boardId = this.boardId): any[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE board_id = ? AND parent_task_id = ? ORDER BY id`,
      )
      .all(boardId, parentTaskId);
  }

  private getLinkedTasks(): any[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE child_exec_board_id = ? AND child_exec_enabled = 1
         ORDER BY id`,
      )
      .all(this.boardId);
  }

  private getHistory(taskId: string, limit?: number, boardId = this.boardId): any[] {
    const sql = limit
      ? `SELECT * FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY id DESC`;
    return limit
      ? this.db.prepare(sql).all(boardId, taskId, limit)
      : this.db.prepare(sql).all(boardId, taskId);
  }

  private restoreTaskRow(snapshot: any, boardId: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, board_id, type, title, assignee, next_action, waiting_for,
          column, priority, due_date, description, labels, blocked_by,
          reminders, next_note_id, notes, _last_mutation, created_at, updated_at,
          child_exec_enabled, child_exec_board_id, child_exec_person_id,
          child_exec_rollup_status, child_exec_last_rollup_at,
          child_exec_last_rollup_summary,
          linked_parent_board_id, linked_parent_task_id, parent_task_id,
          subtasks, recurrence, current_cycle,
          max_cycles, recurrence_end_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        boardId,
        snapshot.type ?? 'simple',
        snapshot.title,
        snapshot.assignee ?? null,
        snapshot.next_action ?? null,
        snapshot.waiting_for ?? null,
        snapshot.column ?? 'inbox',
        snapshot.priority ?? null,
        snapshot.due_date ?? null,
        snapshot.description ?? null,
        snapshot.labels ?? '[]',
        snapshot.blocked_by ?? '[]',
        snapshot.reminders ?? '[]',
        snapshot.next_note_id ?? 1,
        snapshot.notes ?? '[]',
        snapshot._last_mutation ?? null,
        snapshot.created_at ?? now,
        now,
        snapshot.child_exec_enabled ?? 0,
        snapshot.child_exec_board_id ?? null,
        snapshot.child_exec_person_id ?? null,
        snapshot.child_exec_rollup_status ?? null,
        snapshot.child_exec_last_rollup_at ?? null,
        snapshot.child_exec_last_rollup_summary ?? null,
        snapshot.linked_parent_board_id ?? null,
        snapshot.linked_parent_task_id ?? null,
        snapshot.parent_task_id ?? null,
        snapshot.subtasks ?? null,
        snapshot.recurrence ?? null,
        snapshot.current_cycle ?? null,
        snapshot.max_cycles ?? null,
        snapshot.recurrence_end_date ?? null,
      );
  }

  private requirePerson(name: string | undefined, paramName: string): { person_id: string; name: string } {
    if (!name) {
      throw new Error(`Missing required parameter: ${paramName}`);
    }
    const person = this.resolvePerson(name);
    if (!person) {
      throw new Error(`Person not found: ${name}`);
    }
    return person;
  }

  private requireTask(taskId: string | undefined): any {
    if (!taskId) {
      throw new Error('Missing required parameter: task_id');
    }
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  /* ---------------------------------------------------------------- */
  /*  Mutation helpers (shared across create/move/update/etc.)          */
  /* ---------------------------------------------------------------- */

  /** Check if a sender is in board_admins with admin_role = 'manager'. */
  private isManager(senderName: string): boolean {
    const person = this.resolvePerson(senderName);
    if (!person) return false;
    const row = this.db
      .prepare(
        `SELECT 1 FROM board_admins
         WHERE board_id = ? AND person_id = ? AND admin_role = 'manager'`,
      )
      .get(this.boardId, person.person_id);
    return !!row;
  }

  /** Validate bounded recurrence params. Returns error string or null if valid. */
  private static validateBoundedRecurrence(
    maxCycles: number | null | undefined,
    endDate: string | null | undefined,
  ): string | null {
    if (maxCycles != null && endDate != null) {
      return 'Cannot set both max_cycles and recurrence_end_date. Choose one bound.';
    }
    if (maxCycles != null && (!Number.isInteger(maxCycles) || maxCycles <= 0)) {
      return 'max_cycles must be a positive integer.';
    }
    return null;
  }

  /** Read the per-prefix counter, increment it, return the old value. Works for any prefix. */
  private getNextNumberForPrefix(prefix: string): number {
    const row = this.db
      .prepare(`SELECT next_number FROM board_id_counters WHERE board_id = ? AND prefix = ?`)
      .get(this.boardId, prefix) as { next_number: number } | undefined;
    if (row) {
      this.db
        .prepare(`UPDATE board_id_counters SET next_number = ? WHERE board_id = ? AND prefix = ?`)
        .run(row.next_number + 1, this.boardId, prefix);
      return row.next_number;
    }
    // First use of this prefix — compute from existing tasks
    const maxRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) AS m FROM tasks WHERE board_id = ? AND id GLOB ? AND id NOT GLOB ?`
    ).get(this.boardId, `${prefix}[0-9]*`, `${prefix}*.*`) as any;
    const num = (maxRow?.m ?? 0) + 1;
    this.db.prepare(`INSERT INTO board_id_counters (board_id, prefix, next_number) VALUES (?, ?, ?)`)
      .run(this.boardId, prefix, num + 1);
    return num;
  }

  /** Insert a row into task_history. */
  recordHistory(
    taskId: string,
    action: string,
    by: string,
    details?: string,
    boardId = this.boardId,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(boardId, taskId, action, by, now, details ?? null);
  }

  /** Resolve assignee person info for notifications. Returns null if self-update or missing. */
  private resolveNotifTarget(
    assigneePersonId: string | null,
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null } | null {
    if (!assigneePersonId || assigneePersonId === modifierPersonId) return null;
    const person = this.db
      .prepare(
        `SELECT notification_group_jid FROM board_people
         WHERE board_id = ? AND person_id = ?`,
      )
      .get(this.boardId, assigneePersonId) as
      | { notification_group_jid: string | null }
      | undefined;
    if (!person) return null;
    return {
      target_person_id: assigneePersonId,
      notification_group_jid: person.notification_group_jid ?? null,
    };
  }

  /** Resolve display name for a person_id. */
  private personDisplayName(personId: string): string {
    const row = this.db
      .prepare(`SELECT name FROM board_people WHERE board_id = ? AND person_id = ?`)
      .get(this.boardId, personId) as { name: string } | undefined;
    return row?.name ?? personId;
  }

  /** Format a due date for display. */
  private static formatDue(dueDate: string | null): string {
    if (!dueDate) return 'sem prazo';
    const d = new Date(dueDate);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  /** Format priority for display. */
  private static formatPriority(priority: string | null): string {
    switch (priority) {
      case 'urgent': return '🔴 urgente';
      case 'high': return '🟠 alta';
      case 'low': return '🔵 baixa';
      default: return 'normal';
    }
  }

  private static readonly columnLabels: Record<string, string> = {
    inbox: '📥 Inbox',
    next_action: '⏭️ Próximas Ações',
    in_progress: '🔄 Em Andamento',
    waiting: '⏳ Aguardando',
    review: '🔍 Revisão',
    done: '✅ Concluída',
  };

  /** Column name in pt-BR. */
  private static columnLabel(col: string): string {
    return TaskflowEngine.columnLabels[col] ?? col;
  }

  /** Build a notification for new task assignment. */
  private buildCreateNotification(
    task: { id: string; title: string; assignee: string; due_date?: string | null; priority?: string | null; column?: string },
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    const target = this.resolveNotifTarget(task.assignee, modifierPersonId);
    if (!target) return null;
    const modName = this.personDisplayName(modifierPersonId);
    const col = TaskflowEngine.columnLabel(task.column ?? 'next_action');
    const due = TaskflowEngine.formatDue(task.due_date ?? null);
    const pri = TaskflowEngine.formatPriority(task.priority ?? null);
    return {
      ...target,
      message: `🔔 *Nova tarefa atribuída a você*\n\n*${task.id}* — ${task.title}\n*Atribuído por:* ${modName}\n*Coluna:* ${col}\n\n• Prazo: ${due}\n• Prioridade: ${pri}\n\nDigite \`${task.id}\` para ver detalhes.`,
    };
  }

  /** Build a notification for task column transition. */
  private buildMoveNotification(
    task: { id: string; title: string; assignee: string },
    action: MoveParams['action'],
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    const target = this.resolveNotifTarget(task.assignee, modifierPersonId);
    if (!target) return null;
    const modName = this.personDisplayName(modifierPersonId);
    const desc = TaskflowEngine.moveActionLabels[action] ?? action;
    return {
      ...target,
      message: `🔔 *Atualização na sua tarefa*\n\n*${task.id}* — ${task.title}\n*Por:* ${modName}\n*Ação:* ${desc}\n\nDigite \`${task.id}\` para ver detalhes.`,
    };
  }

  /** Build a notification for task reassignment. */
  private buildReassignNotification(
    task: { id: string; title: string },
    fromPersonId: string | null,
    targetPerson: { person_id: string; notification_group_jid: string | null },
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } {
    const modName = this.personDisplayName(modifierPersonId);
    const header = fromPersonId
      ? `🔔 *Tarefa reatribuída para você*\n\n*${task.id}* — ${task.title}\n*Reatribuída de:* ${this.personDisplayName(fromPersonId)}\n*Por:* ${modName}`
      : `🔔 *Tarefa atribuída para você*\n\n*${task.id}* — ${task.title}\n*Por:* ${modName}`;
    return {
      target_person_id: targetPerson.person_id,
      notification_group_jid: targetPerson.notification_group_jid ?? null,
      message: `${header}\n\nDigite \`${task.id}\` para ver detalhes.`,
    };
  }

  /** Build a notification for task field updates (priority, due date, etc.). */
  private buildUpdateNotification(
    task: { id: string; title: string; assignee: string },
    changes: string[],
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    const target = this.resolveNotifTarget(task.assignee, modifierPersonId);
    if (!target) return null;
    const modName = this.personDisplayName(modifierPersonId);
    const changeList = changes.map(c => `• ${c}`).join('\n');
    return {
      ...target,
      message: `🔔 *Atualização na sua tarefa*\n\n*${task.id}* — ${task.title}\n*Modificado por:* ${modName}\n\n${changeList}\n\nDigite \`${task.id}\` para ver detalhes.`,
    };
  }

  /** List all team member names for the current board. */
  private listTeamNames(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM board_people WHERE board_id = ? ORDER BY name`)
      .all(this.boardId) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /** Build an offer_register error when a person isn't registered. */
  private buildOfferRegisterError(name: string): { success: false; offer_register: { name: string; message: string } } {
    const teamNames = this.listTeamNames();
    return {
      success: false,
      offer_register: {
        name,
        message: `${name} não está cadastrado(a). Membros atuais: ${teamNames.join(', ')}. Quer cadastrar? Preciso do *nome exibido no grupo* (display name do WhatsApp), telefone e cargo.`,
      },
    };
  }

  /** Insert a subtask row linked to a parent project. */
  private insertSubtaskRow(opts: {
    boardId?: string;
    subtaskId: string; title: string; assignee: string | null;
    column: string; parentTaskId: string; priority: string | null;
    senderName: string; now: string;
  }): void {
    const boardId = opts.boardId ?? this.boardId;
    const subMutation = JSON.stringify({ action: 'created', by: opts.senderName, at: opts.now });
    const childLink = this.linkedChildBoardFor(boardId, opts.assignee);
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, board_id, type, title, assignee, column,
          parent_task_id, priority, labels,
          child_exec_enabled, child_exec_board_id, child_exec_person_id,
          _last_mutation, created_at, updated_at
        ) VALUES (?, ?, 'simple', ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(opts.subtaskId, boardId, opts.title, opts.assignee, opts.column,
        opts.parentTaskId, opts.priority,
        childLink.child_exec_enabled, childLink.child_exec_board_id, childLink.child_exec_person_id,
        subMutation, opts.now, opts.now);
    this.recordHistory(opts.subtaskId, 'created', opts.senderName,
      JSON.stringify({ type: 'subtask', parent: opts.parentTaskId, title: opts.title, assignee: opts.assignee }),
      boardId);
  }

  /** Build a notification for subtask assignment. */
  private buildSubtaskAssignNotification(
    subtask: { id: string; title: string },
    project: { id: string; title: string },
    assigneePersonId: string,
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    const target = this.resolveNotifTarget(assigneePersonId, modifierPersonId);
    if (!target) return null;
    const modName = this.personDisplayName(modifierPersonId);
    return {
      ...target,
      message: `🔔 *Etapa atribuída para você*\n*${subtask.id}* — ${subtask.title}\n*Projeto:* ${project.id} — ${project.title}\n*Por:* ${modName}`,
    };
  }

  /** Validate that the parent task is a project and the subtask belongs to it. */
  private requireProjectSubtask(
    parentTask: { id: string; type: string },
    subtaskId: string,
  ): { success: false; error: string } | { success: true; subTask: any } {
    if (parentTask.type !== 'project') {
      return { success: false, error: 'Subtasks can only be modified on project tasks.' };
    }
    const subTask = this.getTask(subtaskId);
    if (!subTask || subTask.parent_task_id !== parentTask.id) {
      return { success: false, error: `Subtask ${subtaskId} not found.` };
    }
    return { success: true, subTask };
  }

  /** Check if an assignee has a child board registered. */
  private getChildBoardRegistration(
    personId: string,
    boardId = this.boardId,
  ): { child_board_id: string } | null {
    const row = this.db
      .prepare(
        `SELECT child_board_id FROM child_board_registrations
         WHERE parent_board_id = ? AND person_id = ?`,
      )
      .get(boardId, personId) as { child_board_id: string } | undefined;
    return row ?? null;
  }

  private linkedChildBoardFor(boardId: string, personId: string | null): {
    child_exec_enabled: number;
    child_exec_board_id: string | null;
    child_exec_person_id: string | null;
  } {
    if (!personId) {
      return { child_exec_enabled: 0, child_exec_board_id: null, child_exec_person_id: null };
    }
    const reg = this.getChildBoardRegistration(personId, boardId);
    if (!reg) {
      return { child_exec_enabled: 0, child_exec_board_id: null, child_exec_person_id: null };
    }
    return { child_exec_enabled: 1, child_exec_board_id: reg.child_board_id, child_exec_person_id: personId };
  }

  /* ---------------------------------------------------------------- */
  /*  create — taskflow_create                                         */
  /* ---------------------------------------------------------------- */

  create(params: CreateParams): CreateResult {
    try {
      return this.db.transaction(() => {
      const now = new Date().toISOString();

      /* --- Permission check --- */
      if (params.type !== 'inbox' && params.assignee) {
        if (!this.isManager(params.sender_name)) {
          return {
            success: false,
            error: `Only managers can create assigned tasks. "${params.sender_name}" is not a manager.`,
          };
        }
      }

      /* --- Assignee resolution --- */
      let assigneePersonId: string | null = null;
      if (params.assignee) {
        const person = this.resolvePerson(params.assignee);
        if (!person) return this.buildOfferRegisterError(params.assignee);
        assigneePersonId = person.person_id;
      }

      /* --- ID generation --- */
      const prefix =
        params.type === 'project'
          ? 'P'
          : params.type === 'recurring'
            ? 'R'
            : 'T';
      const num = this.getNextNumberForPrefix(prefix);
      const taskId = `${prefix}${num}`;

      /* --- Column placement --- */
      const column = params.type === 'inbox' || !assigneePersonId ? 'inbox' : 'next_action';

      /* --- Type mapping (inbox → simple for storage) --- */
      const storedType = params.type === 'inbox' ? 'simple' : params.type;

      /* --- Subtask definitions for projects (parsed but inserted after parent) --- */
      const subtaskDefs: Array<{ title: string; assigneePersonId: string | null }> = [];
      if (params.type === 'project' && params.subtasks && params.subtasks.length > 0) {
        for (const sub of params.subtasks) {
          const title = typeof sub === 'string' ? sub : sub.title;
          let subAssigneePersonId: string | null = null;
          if (typeof sub !== 'string' && sub.assignee) {
            const subPerson = this.resolvePerson(sub.assignee);
            if (!subPerson) return this.buildOfferRegisterError(sub.assignee);
            subAssigneePersonId = subPerson.person_id;
          }
          subtaskDefs.push({ title, assigneePersonId: subAssigneePersonId });
        }
      }

      /* --- Recurrence --- */
      let recurrence: string | null = null;
      let dueDate: string | null = params.due_date ?? null;
      if ((params.type === 'recurring' || params.type === 'project') && params.recurrence) {
        recurrence = params.recurrence;
        if (!dueDate) {
          dueDate = advanceDateByRecurrence(new Date(), params.recurrence);
        }
      }

      /* --- Non-business-day check --- */
      if (dueDate) {
        if (params.due_date) {
          // User-provided due date: warn if non-business day
          const warning = this.checkNonBusinessDay(dueDate, !!params.allow_non_business_day);
          if (warning) return warning;
        } else {
          // Auto-calculated due date (recurrence): silently shift to next business day
          dueDate = this.shiftToBusinessDay(dueDate);
        }
      }

      /* --- Child board auto-link --- */
      let childExecEnabled = 0;
      let childExecBoardId: string | null = null;
      let childExecPersonId: string | null = null;
      if (assigneePersonId) {
        const reg = this.getChildBoardRegistration(assigneePersonId);
        if (reg) {
          childExecEnabled = 1;
          childExecBoardId = reg.child_board_id;
          childExecPersonId = assigneePersonId;
        }
      }

      /* --- Validate bounded recurrence params --- */
      const boundError = TaskflowEngine.validateBoundedRecurrence(params.max_cycles, params.recurrence_end_date);
      if (boundError) return { success: false, error: boundError };
      if ((params.max_cycles != null || params.recurrence_end_date != null) && !recurrence) {
        return { success: false, error: 'Bounded recurrence requires a recurring task or recurring project.' };
      }

      /* --- Undo snapshot --- */
      const lastMutation = JSON.stringify({
        action: 'created',
        by: params.sender_name,
        at: now,
      });

      /* --- INSERT parent task --- */
      this.db
        .prepare(
          `INSERT INTO tasks (
            id, board_id, type, title, assignee, column,
            priority, due_date, labels, recurrence,
            max_cycles, recurrence_end_date,
            child_exec_enabled, child_exec_board_id, child_exec_person_id,
            _last_mutation, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          this.boardId,
          storedType,
          params.title,
          assigneePersonId,
          column,
          params.priority ?? null,
          dueDate,
          params.labels ? JSON.stringify(params.labels) : '[]',
          recurrence,
          params.max_cycles ?? null,
          params.recurrence_end_date ?? null,
          childExecEnabled,
          childExecBoardId,
          childExecPersonId,
          lastMutation,
          now,
          now,
        );

      /* --- Create subtask rows (project only) --- */
      const createdSubtasks: Array<{ id: string; title: string; assignee: string | null }> = [];
      for (let i = 0; i < subtaskDefs.length; i++) {
        const sub = subtaskDefs[i];
        const subtaskId = `${taskId}.${i + 1}`;
        const subColumn = sub.assigneePersonId ? 'next_action' : (assigneePersonId ? 'next_action' : 'inbox');
        const subAssignee = sub.assigneePersonId ?? assigneePersonId;
        this.insertSubtaskRow({
          boardId: this.boardId,
          subtaskId, title: sub.title, assignee: subAssignee, column: subColumn,
          parentTaskId: taskId, priority: params.priority ?? null, senderName: params.sender_name, now,
        });
        createdSubtasks.push({ id: subtaskId, title: sub.title, assignee: subAssignee });
      }

      /* --- History --- */
      const detailsSummary: Record<string, any> = {
        type: params.type,
        title: params.title,
        column,
      };
      if (assigneePersonId) detailsSummary.assignee = assigneePersonId;
      if (params.priority) detailsSummary.priority = params.priority;
      if (dueDate) detailsSummary.due_date = dueDate;
      if (params.labels?.length) detailsSummary.labels = params.labels;
      if (subtaskDefs.length > 0) detailsSummary.subtasks_count = subtaskDefs.length;
      if (recurrence) detailsSummary.recurrence = recurrence;

      this.recordHistory(taskId, 'created', params.sender_name, JSON.stringify(detailsSummary));

      /* --- Notifications --- */
      const notifications: CreateResult['notifications'] = [];
      const senderPerson = this.resolvePerson(params.sender_name);
      const senderPersonId = senderPerson?.person_id ?? params.sender_name;

      // Notify project assignee
      if (assigneePersonId) {
        const notif = this.buildCreateNotification(
          { id: taskId, title: params.title, assignee: assigneePersonId, due_date: dueDate, priority: params.priority, column },
          senderPersonId,
        );
        if (notif) notifications.push(notif);
      }

      // Notify each subtask assignee (if different from project assignee and sender)
      const notifiedSubtaskAssignees = new Set<string>();
      for (const sub of createdSubtasks) {
        if (sub.assignee && sub.assignee !== assigneePersonId && !notifiedSubtaskAssignees.has(sub.assignee)) {
          notifiedSubtaskAssignees.add(sub.assignee);
          const notif = this.buildSubtaskAssignNotification(
            { id: sub.id, title: sub.title },
            { id: taskId, title: params.title },
            sub.assignee, senderPersonId,
          );
          if (notif) notifications.push(notif);
        }
      }

      return {
        success: true,
        task_id: taskId,
        column,
        ...(notifications.length > 0 ? { notifications } : {}),
      };
      })(); // end transaction
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  move helpers                                                     */
  /* ---------------------------------------------------------------- */

  /** Check WIP limit for a person. Returns ok=true if under limit or no limit set. */
  private checkWipLimit(personId: string): { ok: boolean; current: number; limit: number; person_name: string } {
    const row = this.db
      .prepare(
        `SELECT name, wip_limit FROM board_people
         WHERE board_id = ? AND person_id = ?`,
      )
      .get(this.boardId, personId) as { name: string; wip_limit: number | null } | undefined;

    const wipLimit = row?.wip_limit ?? null;
    const personName = row?.name ?? personId;

    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM tasks
         WHERE ${this.visibleTaskScope()} AND assignee = ? AND column = 'in_progress'`,
      )
      .get(...this.visibleTaskParams(), personId) as { cnt: number };

    const current = countRow.cnt;
    if (wipLimit === null) {
      return { ok: true, current, limit: 0, person_name: personName };
    }
    return { ok: current < wipLimit, current, limit: wipLimit, person_name: personName };
  }

  /** Check if sender has manager or delegate role in board_admins. */
  private isManagerOrDelegate(senderName: string): boolean {
    const person = this.resolvePerson(senderName);
    if (!person) return false;
    const row = this.db
      .prepare(
        `SELECT 1 FROM board_admins
         WHERE board_id = ? AND person_id = ? AND admin_role IN ('manager', 'delegate')`,
      )
      .get(this.boardId, person.person_id);
    return !!row;
  }

  /** Remove taskId from other tasks' blocked_by arrays when it completes. */
  private resolveDependencies(taskId: string, boardId = this.boardId): void {
    const tasks = this.db
      .prepare(
        `SELECT id, blocked_by FROM tasks
         WHERE board_id = ? AND blocked_by LIKE ?`,
      )
      .all(boardId, `%"${taskId}"%`) as Array<{ id: string; blocked_by: string }>;

    for (const t of tasks) {
      try {
        const blockedBy: string[] = JSON.parse(t.blocked_by ?? '[]');
        const updated = blockedBy.filter((id) => id !== taskId);
        this.db
          .prepare(
            `UPDATE tasks SET blocked_by = ?, updated_at = ?
             WHERE board_id = ? AND id = ?`,
          )
          .run(JSON.stringify(updated), new Date().toISOString(), boardId, t.id);
      } catch {
        // skip malformed JSON
      }
    }
  }

  /** Archive a single task: snapshot to archive, resolve dependencies, delete. */
  private archiveTask(task: any, reason: string): void {
    const now = new Date().toISOString();
    const history = this.getHistory(task.id);
    const taskBoardId = this.taskBoardId(task);
    const archivedTask = { ...task } as any;

    if (task.type === 'project') {
      const childRows = this.getSubtaskRows(task.id, taskBoardId);
      archivedTask.archived_subtasks = childRows.map((subtask) => ({
        snapshot: subtask,
        history: this.getHistory(subtask.id, undefined, taskBoardId),
      }));
    }

    this.db
      .prepare(
        `INSERT INTO archive (board_id, task_id, type, title, assignee, archive_reason,
         linked_parent_board_id, linked_parent_task_id, archived_at, task_snapshot, history)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.boardId, task.id, task.type, task.title, task.assignee, reason,
        task.linked_parent_board_id ?? null, task.linked_parent_task_id ?? null,
        now, JSON.stringify(archivedTask), JSON.stringify(history),
      );

    this.resolveDependencies(task.id, this.boardId);

    if (task.type === 'project') {
      this.db
        .prepare(`DELETE FROM tasks WHERE board_id = ? AND parent_task_id = ?`)
        .run(taskBoardId, task.id);
    }
    this.db
      .prepare(`DELETE FROM tasks WHERE board_id = ? AND id = ?`)
      .run(taskBoardId, task.id);
  }

  /** Advance a recurring task: calculate next due_date and increment cycle. */
  private advanceRecurringTask(task: any): { cycle_number: number; expired: boolean; new_due_date?: string; reason?: 'max_cycles' | 'end_date' } {
    const recurrence = task.recurrence as 'daily' | 'weekly' | 'monthly' | 'yearly';
    const anchor = task.due_date ? new Date(task.due_date) : new Date();
    const currentCycle = parseInt(task.current_cycle ?? '0', 10);
    const nextCycle = currentCycle + 1;

    let newDueDate = advanceDateByRecurrence(anchor, recurrence);
    // Auto-shift recurring due dates off weekends/holidays (no user confirmation)
    newDueDate = this.shiftToBusinessDay(newDueDate);

    // Check expiry bounds (mutually exclusive, but check both defensively)
    let expiryReason: 'max_cycles' | 'end_date' | null = null;
    if (task.max_cycles != null && nextCycle >= task.max_cycles) {
      expiryReason = 'max_cycles';
    } else if (task.recurrence_end_date && newDueDate > task.recurrence_end_date) {
      expiryReason = 'end_date';
    }

    const now = new Date().toISOString();

    if (expiryReason) {
      // Leave task in 'done' — just update cycle number
      this.db
        .prepare(
          `UPDATE tasks SET current_cycle = ?, updated_at = ?
           WHERE board_id = ? AND id = ?`,
        )
        .run(String(nextCycle), now, this.taskBoardId(task), task.id);
      return { cycle_number: nextCycle, expired: true, reason: expiryReason };
    }

    // Normal advance: reset to next_action
    this.db
      .prepare(
        `UPDATE tasks SET column = 'next_action', due_date = ?, current_cycle = ?, reminders = '[]',
         notes = '[]', next_note_id = 1, blocked_by = '[]', next_action = NULL, waiting_for = NULL, updated_at = ?
         WHERE board_id = ? AND id = ?`,
      )
      .run(newDueDate, String(nextCycle), now, this.taskBoardId(task), task.id);

    /* Reset subtask rows for recurring projects */
    if (task.type === 'project') {
      this.db
        .prepare(
          `UPDATE tasks SET column = 'next_action', updated_at = ?
           WHERE board_id = ? AND parent_task_id = ? AND column = 'done'`,
        )
        .run(now, this.taskBoardId(task), task.id);
    }

    return { cycle_number: nextCycle, expired: false, new_due_date: newDueDate };
  }

  /* ---------------------------------------------------------------- */
  /*  move — taskflow_move                                             */
  /* ---------------------------------------------------------------- */

  move(params: MoveParams): MoveResult {
    try {
      return this.db.transaction(() => {
      const now = new Date().toISOString();

      /* --- Resolve sender --- */
      const sender = this.resolvePerson(params.sender_name);
      const senderPersonId = sender?.person_id ?? null;

      /* --- Auto-resolve subtask IDs (e.g. P16.2 → task_id=P16, subtask_id=P16.2) --- */
      if (!params.subtask_id && params.task_id.includes('.')) {
        const directTask = this.getTask(params.task_id);
        if (!directTask) {
          const parentId = params.task_id.split('.').slice(0, -1).join('.');
          params = { ...params, task_id: parentId, subtask_id: params.task_id };
        }
      }

      /* --- Fetch task --- */
      const task = this.requireTask(params.task_id);
      const taskBoardId = this.taskBoardId(task);
      const fromColumn: string = task.column;

      /* --- Define valid transitions --- */
      const transitions: Record<string, { from: string[]; to: string }> = {
        start:       { from: ['next_action'], to: 'in_progress' },
        force_start: { from: ['next_action'], to: 'in_progress' },
        wait:        { from: ['in_progress'], to: 'waiting' },
        resume:      { from: ['waiting'], to: 'in_progress' },
        return:      { from: ['in_progress'], to: 'next_action' },
        review:      { from: ['in_progress'], to: 'review' },
        approve:     { from: ['review'], to: 'done' },
        reject:      { from: ['review'], to: 'in_progress' },
        conclude:    { from: ['inbox', 'next_action', 'in_progress', 'waiting', 'review'], to: 'done' },
        reopen:      { from: ['done'], to: 'next_action' },
      };

      const transition = transitions[params.action];
      if (!transition) {
        return { success: false, error: `Unknown action: ${params.action}` };
      }

      /* --- Validate from column --- */
      if (!transition.from.includes(fromColumn)) {
        return {
          success: false,
          error: `Cannot "${params.action}" task ${params.task_id}: task is in "${fromColumn}", expected one of [${transition.from.join(', ')}].`,
        };
      }

      const toColumn = transition.to;

      /* --- Permission checks --- */
      const isAssignee = senderPersonId != null && task.assignee === senderPersonId;
      const isMgr = this.isManager(params.sender_name);
      const isMgrOrDelegate = this.isManagerOrDelegate(params.sender_name);

      switch (params.action) {
        case 'start':
        case 'wait':
        case 'resume':
        case 'return':
        case 'review':
          if (!isAssignee && !isMgr) {
            return { success: false, error: `Permission denied: "${params.sender_name}" is neither the assignee nor a manager.` };
          }
          break;
        case 'approve':
          if (!isMgrOrDelegate) {
            return { success: false, error: `Permission denied: "${params.sender_name}" is not a manager or delegate.` };
          }
          if (isAssignee) {
            return { success: false, error: `Self-approval is not allowed: "${params.sender_name}" is the assignee.` };
          }
          break;
        case 'reject':
          if (!isMgrOrDelegate) {
            return { success: false, error: `Permission denied: "${params.sender_name}" is not a manager or delegate.` };
          }
          break;
        case 'conclude':
          if (!isAssignee && !isMgr) {
            return { success: false, error: `Permission denied: "${params.sender_name}" is neither the assignee nor a manager.` };
          }
          break;
        case 'reopen':
          if (!isMgr) {
            return { success: false, error: `Permission denied: only managers can reopen tasks.` };
          }
          break;
        case 'force_start':
          if (!isMgr) {
            return { success: false, error: `Permission denied: only managers can force_start tasks.` };
          }
          break;
      }

      /* --- Project conclude guard: all subtask rows must be done --- */
      if ((params.action === 'conclude' || params.action === 'approve') && task.type === 'project') {
        const pendingSubs = this.db
          .prepare(
            `SELECT id, title, column FROM tasks
             WHERE board_id = ? AND parent_task_id = ? AND column != 'done'
             ORDER BY id`,
          )
          .all(this.boardId, task.id) as Array<{ id: string; title: string; column: string }>;
        if (pendingSubs.length > 0) {
          const list = pendingSubs.map((s) => `${s.id} (${s.column})`).join(', ');
          return {
            success: false,
            error: `Cannot conclude project ${task.id}: ${pendingSubs.length} subtask(s) not done: ${list}`,
          };
        }
      }

      /* --- WIP limit check (start, resume, reject — NOT force_start) --- */
      if (['start', 'resume', 'reject'].includes(params.action) && task.assignee) {
        const wip = this.checkWipLimit(task.assignee);
        if (!wip.ok) {
          return {
            success: false,
            error: `WIP limit exceeded for ${wip.person_name}: ${wip.current} in progress (limit: ${wip.limit}).`,
            wip_warning: { person: wip.person_name, current: wip.current, limit: wip.limit },
          };
        }
      }

      /* --- Snapshot before mutation --- */
      const snapshot = JSON.stringify({
        action: params.action,
        by: params.sender_name,
        at: now,
        snapshot: {
          column: fromColumn,
          assignee: task.assignee,
          due_date: task.due_date,
          updated_at: task.updated_at,
        },
      });

      /* --- Project subtask completion (real task rows) --- */
      let projectUpdate: MoveResult['project_update'];
      if (toColumn === 'done' && task.parent_task_id) {
        // This is a subtask being concluded — check sibling subtasks
        const siblings = this.getSubtaskRows(task.parent_task_id, taskBoardId);
        // Find next pending sibling (not in done)
        let nextSubtask: string | undefined;
        const taskIndex = siblings.findIndex((s: any) => s.id === task.id);
        // Search after current
        for (let i = taskIndex + 1; i < siblings.length; i++) {
          if (siblings[i].column !== 'done') { nextSubtask = siblings[i].id; break; }
        }
        // Search before current
        if (!nextSubtask) {
          for (let i = 0; i < taskIndex; i++) {
            if (siblings[i].column !== 'done') { nextSubtask = siblings[i].id; break; }
          }
        }
        // All complete = all siblings (including this one, which we're about to move to done) are done
        const allComplete = siblings.every((s: any) => s.id === task.id || s.column === 'done');
        projectUpdate = {
          completed_subtask: task.id,
          next_subtask: nextSubtask,
          all_complete: allComplete,
        };
      }

      /* --- Legacy JSON subtask completion (backward compat) --- */
      if (params.subtask_id && task.subtasks) {
        try {
          const subtasks: Array<{ id: string; title: string; status?: string; column?: string }> = JSON.parse(task.subtasks);
          let found = false;
          let nextSubtask: string | undefined;
          let foundIndex = -1;
          const legacyState = (subtask: { status?: string; column?: string }): 'done' | 'pending' =>
            subtask.column === 'done' || subtask.status === 'done' ? 'done' : 'pending';
          for (let i = 0; i < subtasks.length; i++) {
            if (subtasks[i].id === params.subtask_id) {
              subtasks[i].status = 'done';
              subtasks[i].column = 'done';
              found = true;
              foundIndex = i;
            }
          }
          if (found) {
            for (let i = foundIndex + 1; i < subtasks.length; i++) {
              if (legacyState(subtasks[i]) === 'pending') { nextSubtask = subtasks[i].id; break; }
            }
            if (!nextSubtask) {
              for (let i = 0; i < foundIndex; i++) {
                if (legacyState(subtasks[i]) === 'pending') { nextSubtask = subtasks[i].id; break; }
              }
            }
            const allComplete = subtasks.every((s) => legacyState(s) === 'done');
            this.db
              .prepare(`UPDATE tasks SET subtasks = ?, updated_at = ? WHERE board_id = ? AND id = ?`)
              .run(JSON.stringify(subtasks), now, taskBoardId, task.id);
            projectUpdate = {
              completed_subtask: params.subtask_id,
              next_subtask: nextSubtask,
              all_complete: allComplete,
            };
          }
        } catch {
          // skip malformed subtasks JSON
        }
      }

      /* --- Update task column, _last_mutation, updated_at --- */
      const detailsObj: Record<string, any> = { from: fromColumn, to: toColumn };
      if (params.reason) detailsObj.reason = params.reason;
      if (params.subtask_id) detailsObj.subtask_id = params.subtask_id;

      this.db
        .prepare(
          `UPDATE tasks SET column = ?, _last_mutation = ?, updated_at = ?
           WHERE board_id = ? AND id = ?`,
        )
        .run(toColumn, snapshot, now, taskBoardId, task.id);

      /* --- If waiting, store reason in waiting_for --- */
      if (params.action === 'wait' && params.reason) {
        this.db
          .prepare(
            `UPDATE tasks SET waiting_for = ? WHERE board_id = ? AND id = ?`,
          )
          .run(params.reason, taskBoardId, task.id);
      }

      /* --- Record history --- */
      this.recordHistory(
        task.id,
        params.action,
        params.sender_name,
        JSON.stringify(detailsObj),
        taskBoardId,
      );

      /* --- Side effects on completion (approve / conclude) --- */
      let recurringCycle: MoveResult['recurring_cycle'];
      if (toColumn === 'done') {
        // Dependency resolution
        this.resolveDependencies(task.id, taskBoardId);

        // Recurring cycle advance
        if (task.recurrence) {
          recurringCycle = this.advanceRecurringTask(task);
        }
      }

      const senderDisplayName = senderPersonId
        ? this.personDisplayName(senderPersonId)
        : params.sender_name;

      /* --- Notifications --- */
      const notifications: MoveResult['notifications'] = [];
      if (senderPersonId) {
        const notif = this.buildMoveNotification(
          task,
          params.action,
          senderPersonId,
        );
        if (notif) notifications.push(notif);
      }

      /* --- Linked task review rejection (reset rollup + notify child board) --- */
      if (params.action === 'reject' && task.child_exec_enabled === 1) {
        this.db
          .prepare(
            `UPDATE tasks SET child_exec_rollup_status = 'active',
             child_exec_last_rollup_at = ?, child_exec_last_rollup_summary = ?, updated_at = ?
             WHERE board_id = ? AND id = ?`,
          )
          .run(now, `Rejeitada por ${senderDisplayName}`, now, taskBoardId, task.id);

        if (task.child_exec_person_id) {
          const childPerson = this.db
            .prepare(
              `SELECT notification_group_jid FROM board_people
               WHERE board_id = ? AND person_id = ?`,
            )
            .get(taskBoardId, task.child_exec_person_id) as
            | { notification_group_jid: string | null }
            | undefined;

          if (childPerson?.notification_group_jid) {
            notifications.push({
              target_person_id: task.child_exec_person_id,
              notification_group_jid: childPerson.notification_group_jid,
              message: `↩️ *${task.id}* — ${task.title}\nRevisão rejeitada por ${senderDisplayName}. Ajustes necessários antes de nova aprovação.`,
            });
          }
        }
      }

      /* --- Parent board notification (linked task status change) --- */
      let parentNotification: MoveResult['parent_notification'];
      if (task.child_exec_enabled === 1 && task.board_id !== this.boardId) {
        // This task belongs to a parent board but is being operated on from a child board
        const parentBoard = this.db
          .prepare(`SELECT group_jid FROM boards WHERE id = ?`)
          .get(task.board_id) as { group_jid: string } | undefined;
        if (parentBoard) {
          const emoji = toColumn === 'done' ? '✅' : toColumn === 'review' ? '📋' : '🔄';
          const statusText = TaskflowEngine.columnLabel(toColumn);
          parentNotification = {
            parent_group_jid: parentBoard.group_jid,
            message: `${emoji} *${task.id}* — ${task.title}\n*Movida para:* ${statusText}\n*Por:* ${senderDisplayName}`,
          };

          // Also update rollup status on the parent task
          if (toColumn === 'done') {
            this.db
              .prepare(
                `UPDATE tasks SET child_exec_rollup_status = 'ready_for_review',
                 child_exec_last_rollup_at = ?, child_exec_last_rollup_summary = ?
                 WHERE board_id = ? AND id = ?`,
              )
              .run(now, `Concluída por ${senderDisplayName}`, task.board_id, task.id);
          }
        }
      }

      /* --- Build result --- */
      const result: MoveResult = {
        success: true,
        task_id: task.id,
        from_column: fromColumn,
        to_column: toColumn,
      };
      if (notifications.length > 0) result.notifications = notifications;
      if (projectUpdate) result.project_update = projectUpdate;
      if (recurringCycle) result.recurring_cycle = recurringCycle;
      if (parentNotification) result.parent_notification = parentNotification;

      return result;
      })(); // end transaction
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  reassign — taskflow_reassign                                     */
  /* ---------------------------------------------------------------- */

  reassign(params: ReassignParams): ReassignResult {
    try {
      return this.db.transaction(() => {
      /* --- Must specify either task_id or source_person --- */
      if (!params.task_id && !params.source_person) {
        return { success: false, error: 'Must provide either task_id (single) or source_person (bulk transfer).' };
      }

      /* --- Resolve target person --- */
      const targetPerson = this.resolvePerson(params.target_person);
      if (!targetPerson) return this.buildOfferRegisterError(params.target_person);

      /* --- Collect tasks to reassign --- */
      let tasksToReassign: any[];

      if (params.task_id) {
        /* --- Single task reassignment --- */
        const task = this.getTask(params.task_id);
        if (!task) {
          return { success: false, error: `Task not found: ${params.task_id}` };
        }
        if (task.column === 'done') {
          return { success: false, error: `Cannot reassign completed task ${params.task_id}.` };
        }

        /* --- Permission: sender must be assignee or manager --- */
        const sender = this.resolvePerson(params.sender_name);
        const senderPersonId = sender?.person_id ?? null;
        const isAssignee = senderPersonId != null && task.assignee === senderPersonId;
        const isMgr = this.isManager(params.sender_name);
        if (!isAssignee && !isMgr) {
          return { success: false, error: `Permission denied: "${params.sender_name}" is neither the assignee nor a manager.` };
        }

        tasksToReassign = [task];
      } else {
        /* --- Bulk transfer --- */
        const sourcePerson = this.resolvePerson(params.source_person!);
        if (!sourcePerson) {
          return { success: false, error: `Source person not found: ${params.source_person}` };
        }

        /* --- Same person check --- */
        if (sourcePerson.person_id === targetPerson.person_id) {
          return { success: false, error: `Source and target are the same person: ${sourcePerson.name}.` };
        }

        /* --- Permission: sender must be the source person or a manager --- */
        const sender = this.resolvePerson(params.sender_name);
        const senderPersonId = sender?.person_id ?? null;
        const isSelf = senderPersonId != null && sourcePerson.person_id === senderPersonId;
        const isMgr = this.isManager(params.sender_name);
        if (!isSelf && !isMgr) {
          return { success: false, error: `Permission denied: "${params.sender_name}" is neither the source person nor a manager.` };
        }

        /* --- Find active tasks for source person --- */
        tasksToReassign = this.db
          .prepare(
            `SELECT * FROM tasks
             WHERE board_id = ? AND assignee = ? AND column != 'done'
             ORDER BY id`,
          )
          .all(this.boardId, sourcePerson.person_id);

        if (tasksToReassign.length === 0) {
          return { success: false, error: `No active tasks found for ${sourcePerson.name}.` };
        }
      }

      /* --- Pre-fetch target's child board registration (avoid N+1) --- */
      const targetChildReg = this.getChildBoardRegistration(targetPerson.person_id);

      /* --- Build affected tasks list with relink info --- */
      const tasksAffected: ReassignResult['tasks_affected'] = [];
      for (const task of tasksToReassign) {
        const wasLinked = task.child_exec_enabled === 1;
        const relinkedTo = targetChildReg ? targetChildReg.child_board_id : undefined;

        tasksAffected.push({
          task_id: task.id,
          title: task.title,
          was_linked: wasLinked,
          ...(relinkedTo ? { relinked_to: relinkedTo } : {}),
        });
      }

      /* --- Dry run: return confirmation summary --- */
      if (!params.confirmed) {
        const taskList = tasksAffected.map((t) => {
          let desc = `  - ${t.task_id} "${t.title}"`;
          if (t.was_linked) {
            desc += t.relinked_to
              ? ` (will relink to board ${t.relinked_to})`
              : ' (will unlink — target has no child board)';
          }
          return desc;
        }).join('\n');

        const summary = `Reassign ${tasksAffected.length} task(s) to ${targetPerson.name}:\n${taskList}\n\nCall again with confirmed=true to execute.`;

        return {
          success: true,
          requires_confirmation: summary,
          tasks_affected: tasksAffected,
        };
      }

      /* --- Execute reassignment --- */
      const now = new Date().toISOString();
      const senderPerson = this.resolvePerson(params.sender_name);
      const senderPersonId = senderPerson?.person_id ?? params.sender_name;
      const notifications: ReassignResult['notifications'] = [];

      /* Pre-fetch target person notification info (avoid N+1 in loop) */
      const targetNotifInfo = targetPerson.person_id !== senderPersonId
        ? this.db
            .prepare(
              `SELECT name, notification_group_jid FROM board_people
               WHERE board_id = ? AND person_id = ?`,
            )
            .get(this.boardId, targetPerson.person_id) as
            | { name: string; notification_group_jid: string | null }
            | undefined
        : undefined;

      for (const task of tasksToReassign) {
        const wasLinked = task.child_exec_enabled === 1;

        /* --- Undo snapshot --- */
        const snapshot = JSON.stringify({
          action: 'reassigned',
          by: params.sender_name,
          at: now,
          snapshot: {
            assignee: task.assignee,
            child_exec_enabled: task.child_exec_enabled,
            child_exec_board_id: task.child_exec_board_id,
            child_exec_person_id: task.child_exec_person_id,
            updated_at: task.updated_at,
          },
        });

        /* --- Auto-relink logic (uses pre-fetched targetChildReg) --- */
        let newChildExecEnabled = task.child_exec_enabled;
        let newChildExecBoardId = task.child_exec_board_id;
        let newChildExecPersonId = task.child_exec_person_id;

        if (task.type === 'recurring') {
          // Recurring tasks (RXXX) are never linked to child boards.
          newChildExecEnabled = 0;
          newChildExecBoardId = null;
          newChildExecPersonId = null;
        } else if (targetChildReg) {
          newChildExecEnabled = 1;
          newChildExecBoardId = targetChildReg.child_board_id;
          newChildExecPersonId = targetPerson.person_id;
        } else if (wasLinked) {
          newChildExecEnabled = 0;
          newChildExecBoardId = null;
          newChildExecPersonId = null;
        }

        /* --- Update task --- */
        this.db
          .prepare(
            `UPDATE tasks SET assignee = ?, child_exec_enabled = ?, child_exec_board_id = ?,
             child_exec_person_id = ?, _last_mutation = ?, updated_at = ?
             WHERE board_id = ? AND id = ?`,
          )
          .run(
            targetPerson.person_id,
            newChildExecEnabled,
            newChildExecBoardId,
            newChildExecPersonId,
            snapshot,
            now,
            this.taskBoardId(task),
            task.id,
          );

        /* --- Record history --- */
        const details: Record<string, any> = {
          from_assignee: task.assignee,
          to_assignee: targetPerson.person_id,
        };
        if (wasLinked) {
          details.was_linked = true;
          details.relinked_to = newChildExecBoardId ?? null;
        }
        this.recordHistory(
          task.id,
          'reassigned',
          params.sender_name,
          JSON.stringify(details),
          this.taskBoardId(task),
        );

        /* --- Notification for new assignee (uses pre-fetched targetNotifInfo) --- */
        if (targetNotifInfo) {
          notifications.push(this.buildReassignNotification(
            task,
            task.assignee,
            { person_id: targetPerson.person_id, notification_group_jid: targetNotifInfo.notification_group_jid ?? null },
            senderPersonId,
          ));
        }
      }

      /* --- Build result --- */
      const result: ReassignResult = {
        success: true,
        tasks_affected: tasksAffected,
      };
      if (notifications.length > 0) result.notifications = notifications;

      return result;
      })(); // end transaction
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  update — taskflow_update                                         */
  /* ---------------------------------------------------------------- */

  update(params: UpdateParams): UpdateResult {
    try {
      return this.db.transaction(() => {
      const now = new Date().toISOString();
      const { updates } = params;

      /* --- Resolve sender --- */
      const sender = this.resolvePerson(params.sender_name);
      const senderPersonId = sender?.person_id ?? null;

      /* --- Fetch task --- */
      const task = this.requireTask(params.task_id);
      const taskBoardId = this.taskBoardId(task);

      /* --- Check task is active (not archived / done is still active in tasks table) --- */
      // Tasks only leave the tasks table when archived; if it's here, it's active.

      /* --- Permission: sender must be assignee or manager --- */
      const isAssignee = senderPersonId != null && task.assignee === senderPersonId;
      const isMgr = this.isManager(params.sender_name);
      if (!isAssignee && !isMgr) {
        return {
          success: false,
          error: `Permission denied: "${params.sender_name}" is neither the assignee nor a manager.`,
        };
      }

      /* --- Save undo snapshot --- */
      const snapshot = JSON.stringify({
        action: 'updated',
        by: params.sender_name,
        at: now,
        snapshot: {
          title: task.title,
          priority: task.priority,
          due_date: task.due_date,
          description: task.description,
          next_action: task.next_action,
          labels: task.labels,
          notes: task.notes,
          next_note_id: task.next_note_id,
          subtasks: task.subtasks,
          recurrence: task.recurrence,
          max_cycles: task.max_cycles,
          recurrence_end_date: task.recurrence_end_date,
          updated_at: task.updated_at,
        },
      });

      /* --- Process each update field --- */
      const changes: string[] = [];
      const notifications: UpdateResult['notifications'] = [];

      /* Reject setting both bounds in one call (undefined = not provided, null = clear) */
      const boundError = TaskflowEngine.validateBoundedRecurrence(
        updates.max_cycles ?? undefined,
        updates.recurrence_end_date ?? undefined,
      );
      if (boundError) return { success: false, error: boundError };

      /* Title */
      if (updates.title !== undefined) {
        if (!updates.title || updates.title.trim() === '') {
          return { success: false, error: 'Title cannot be empty.' };
        }
        this.db
          .prepare(`UPDATE tasks SET title = ? WHERE board_id = ? AND id = ?`)
          .run(updates.title, taskBoardId, task.id);
        changes.push(`Title changed to "${updates.title}"`);
      }

      /* Priority */
      if (updates.priority !== undefined) {
        const validPriorities = ['low', 'normal', 'high', 'urgent'];
        if (!validPriorities.includes(updates.priority)) {
          return { success: false, error: `Invalid priority "${updates.priority}". Must be one of: ${validPriorities.join(', ')}.` };
        }
        this.db
          .prepare(`UPDATE tasks SET priority = ? WHERE board_id = ? AND id = ?`)
          .run(updates.priority, taskBoardId, task.id);
        changes.push(`Priority set to ${updates.priority}`);
      }

      /* Due date */
      if (updates.due_date !== undefined) {
        if (updates.due_date === null) {
          this.db
            .prepare(`UPDATE tasks SET due_date = NULL, reminders = '[]' WHERE board_id = ? AND id = ?`)
            .run(taskBoardId, task.id);
          changes.push('Due date removed');
          const oldReminders: any[] = JSON.parse(task.reminders ?? '[]');
          if (oldReminders.length > 0) changes.push('Reminders cleared (no due date)');
        } else {
          /* Non-business-day check */
          const warning = this.checkNonBusinessDay(updates.due_date, !!updates.allow_non_business_day);
          if (warning) return warning;
          /* Recalculate reminder dates for the new due_date */
          const reminders: Array<{ days: number; date: string }> = JSON.parse(task.reminders ?? '[]');
          if (reminders.length > 0) {
            for (const r of reminders) {
              r.date = reminderDateFromDue(updates.due_date, r.days);
            }
            this.db
              .prepare(`UPDATE tasks SET due_date = ?, reminders = ? WHERE board_id = ? AND id = ?`)
              .run(updates.due_date, JSON.stringify(reminders), taskBoardId, task.id);
            changes.push(`Due date set to ${updates.due_date}`);
            changes.push('Reminders recalculated for new due date');
          } else {
            this.db
              .prepare(`UPDATE tasks SET due_date = ? WHERE board_id = ? AND id = ?`)
              .run(updates.due_date, taskBoardId, task.id);
            changes.push(`Due date set to ${updates.due_date}`);
          }
        }
      }

      /* Description */
      if (updates.description !== undefined) {
        if (updates.description.length > 500) {
          return { success: false, error: 'Description exceeds 500 character limit.' };
        }
        this.db
          .prepare(`UPDATE tasks SET description = ? WHERE board_id = ? AND id = ?`)
          .run(updates.description, taskBoardId, task.id);
        changes.push('Description updated');
      }

      /* Next action */
      if (updates.next_action !== undefined) {
        this.db
          .prepare(`UPDATE tasks SET next_action = ? WHERE board_id = ? AND id = ?`)
          .run(updates.next_action, taskBoardId, task.id);
        changes.push(`Next action set to "${updates.next_action}"`);
      }

      /* Add label */
      if (updates.add_label !== undefined) {
        const labels: string[] = JSON.parse(task.labels ?? '[]');
        if (!labels.includes(updates.add_label)) {
          labels.push(updates.add_label);
          this.db
            .prepare(`UPDATE tasks SET labels = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(labels), taskBoardId, task.id);
          changes.push(`Label "${updates.add_label}" added`);
        }
        // idempotent: no error if already present, but no change entry either
      }

      /* Remove label */
      if (updates.remove_label !== undefined) {
        const labels: string[] = JSON.parse(task.labels ?? '[]');
        const idx = labels.indexOf(updates.remove_label);
        if (idx >= 0) {
          labels.splice(idx, 1);
          this.db
            .prepare(`UPDATE tasks SET labels = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(labels), taskBoardId, task.id);
          changes.push(`Label "${updates.remove_label}" removed`);
        }
      }

      /* Add note */
      if (updates.add_note !== undefined) {
        const notes: Array<{ id: number; text: string; at: string; by: string }> = JSON.parse(task.notes ?? '[]');
        const noteId = task.next_note_id ?? 1;
        notes.push({ id: noteId, text: updates.add_note, at: now, by: params.sender_name });
        this.db
          .prepare(`UPDATE tasks SET notes = ?, next_note_id = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(notes), noteId + 1, taskBoardId, task.id);
        changes.push(`Note #${noteId} added`);
      }

      /* Edit note */
      if (updates.edit_note !== undefined) {
        const notes: Array<{ id: number; text: string; at: string; by: string }> = JSON.parse(task.notes ?? '[]');
        const note = notes.find((n) => n.id === updates.edit_note!.id);
        if (!note) {
          return { success: false, error: `Note #${updates.edit_note.id} not found.` };
        }
        note.text = updates.edit_note.text;
        this.db
          .prepare(`UPDATE tasks SET notes = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(notes), taskBoardId, task.id);
        changes.push(`Note #${updates.edit_note.id} edited`);
      }

      /* Remove note */
      if (updates.remove_note !== undefined) {
        const notes: Array<{ id: number; text: string; at: string; by: string }> = JSON.parse(task.notes ?? '[]');
        const idx = notes.findIndex((n) => n.id === updates.remove_note);
        if (idx < 0) {
          return { success: false, error: `Note #${updates.remove_note} not found.` };
        }
        notes.splice(idx, 1);
        this.db
          .prepare(`UPDATE tasks SET notes = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(notes), taskBoardId, task.id);
        changes.push(`Note #${updates.remove_note} removed`);
      }

      /* Add subtask (project only) — creates a real task row */
      if (updates.add_subtask !== undefined) {
        if (task.type !== 'project') {
          return { success: false, error: 'Subtasks can only be added to project tasks.' };
        }
        const existingSubtasks = this.getSubtaskRows(task.id);
        const nextNum = existingSubtasks.length + 1;
        const subtaskId = `${task.id}.${nextNum}`;
        const subColumn = task.assignee ? 'next_action' : 'inbox';
        this.insertSubtaskRow({
          boardId: taskBoardId,
          subtaskId, title: updates.add_subtask, assignee: task.assignee, column: subColumn,
          parentTaskId: task.id, priority: task.priority ?? null, senderName: params.sender_name, now,
        });
        changes.push(`Subtask ${subtaskId} "${updates.add_subtask}" added`);
      }

      /* Rename subtask (project only) — operates on subtask task row */
      if (updates.rename_subtask !== undefined) {
        const check = this.requireProjectSubtask(task, updates.rename_subtask.id);
        if (!check.success) return check;
        this.db
          .prepare(`UPDATE tasks SET title = ?, updated_at = ? WHERE board_id = ? AND id = ?`)
          .run(updates.rename_subtask.title, now, taskBoardId, updates.rename_subtask.id);
        changes.push(`Subtask ${updates.rename_subtask.id} renamed to "${updates.rename_subtask.title}"`);
      }

      /* Reopen subtask (project only) — moves subtask task row back to next_action */
      if (updates.reopen_subtask !== undefined) {
        const check = this.requireProjectSubtask(task, updates.reopen_subtask);
        if (!check.success) return check;
        if (check.subTask.column !== 'done') {
          return { success: false, error: `Subtask ${updates.reopen_subtask} is not done (current: ${check.subTask.column}).` };
        }
        this.db
          .prepare(`UPDATE tasks SET column = 'next_action', updated_at = ? WHERE board_id = ? AND id = ?`)
          .run(now, taskBoardId, updates.reopen_subtask);
        this.recordHistory(updates.reopen_subtask, 'reopened', params.sender_name, undefined, taskBoardId);
        changes.push(`Subtask ${updates.reopen_subtask} reopened`);
      }

      /* Assign subtask (project only) — reassigns a subtask to a different person */
      if (updates.assign_subtask !== undefined) {
        const check = this.requireProjectSubtask(task, updates.assign_subtask.id);
        if (!check.success) return check;
        const subPerson = this.resolvePerson(updates.assign_subtask.assignee);
        if (!subPerson) return this.buildOfferRegisterError(updates.assign_subtask.assignee);
        const childLink = this.linkedChildBoardFor(taskBoardId, subPerson.person_id);
        this.db
          .prepare(`UPDATE tasks SET assignee = ?, child_exec_enabled = ?, child_exec_board_id = ?, child_exec_person_id = ?, column = CASE WHEN column = 'inbox' THEN 'next_action' ELSE column END, updated_at = ? WHERE board_id = ? AND id = ?`)
          .run(
            subPerson.person_id,
            childLink.child_exec_enabled,
            childLink.child_exec_board_id,
            childLink.child_exec_person_id,
            now,
            taskBoardId,
            updates.assign_subtask.id,
          );
        this.recordHistory(updates.assign_subtask.id, 'reassigned', params.sender_name,
          JSON.stringify({ from_assignee: check.subTask.assignee, to_assignee: subPerson.person_id }), taskBoardId);
        changes.push(`Subtask ${updates.assign_subtask.id} assigned to ${subPerson.name}`);

        // Notify subtask assignee
        if (senderPersonId) {
          const notif = this.buildSubtaskAssignNotification(
            { id: updates.assign_subtask.id, title: check.subTask.title },
            { id: task.id, title: task.title },
            subPerson.person_id, senderPersonId,
          );
          if (notif) notifications.push(notif);
        }
      }

      /* Unassign subtask (project only) — remove assignee from subtask */
      if (updates.unassign_subtask !== undefined) {
        const check = this.requireProjectSubtask(task, updates.unassign_subtask);
        if (!check.success) return check;
        this.db
          .prepare(`UPDATE tasks SET assignee = NULL, child_exec_enabled = 0, child_exec_board_id = NULL, child_exec_person_id = NULL, updated_at = ? WHERE board_id = ? AND id = ?`)
          .run(now, taskBoardId, updates.unassign_subtask);
        this.recordHistory(updates.unassign_subtask, 'unassigned', params.sender_name,
          JSON.stringify({ from_assignee: check.subTask.assignee }));
        changes.push(`Subtask ${updates.unassign_subtask} unassigned`);
      }

      /* Recurrence (recurring only) */
      if (updates.recurrence !== undefined) {
        if (!task.recurrence) {
          return { success: false, error: 'Recurrence can only be changed on recurring tasks.' };
        }
        this.db
          .prepare(`UPDATE tasks SET recurrence = ? WHERE board_id = ? AND id = ?`)
          .run(updates.recurrence, taskBoardId, task.id);
        changes.push(`Recurrence changed to ${updates.recurrence}`);
      }

      /* max_cycles (recurring only — setting clears recurrence_end_date) */
      if (updates.max_cycles !== undefined) {
        if (!task.recurrence) {
          return { success: false, error: 'max_cycles can only be set on tasks with recurrence.' };
        }
        this.db
          .prepare(`UPDATE tasks SET max_cycles = ?, recurrence_end_date = NULL WHERE board_id = ? AND id = ?`)
          .run(updates.max_cycles, taskBoardId, task.id);
        changes.push(updates.max_cycles === null ? 'Removed max_cycles bound' : `max_cycles set to ${updates.max_cycles}`);
      }

      /* recurrence_end_date (recurring only — setting clears max_cycles) */
      if (updates.recurrence_end_date !== undefined) {
        if (!task.recurrence) {
          return { success: false, error: 'recurrence_end_date can only be set on tasks with recurrence.' };
        }
        this.db
          .prepare(`UPDATE tasks SET recurrence_end_date = ?, max_cycles = NULL WHERE board_id = ? AND id = ?`)
          .run(updates.recurrence_end_date, taskBoardId, task.id);
        changes.push(updates.recurrence_end_date === null ? 'Removed recurrence_end_date bound' : `recurrence_end_date set to ${updates.recurrence_end_date}`);
      }

      /* --- After all updates: set updated_at, _last_mutation, record history --- */
      this.db
        .prepare(
          `UPDATE tasks SET _last_mutation = ?, updated_at = ?
           WHERE board_id = ? AND id = ?`,
        )
        .run(snapshot, now, taskBoardId, task.id);

      this.recordHistory(
        task.id,
        'updated',
        params.sender_name,
        JSON.stringify({ changes }),
        taskBoardId,
      );

      /* --- Notification for task owner --- */
      if (senderPersonId && changes.length > 0) {
        const notif = this.buildUpdateNotification(
          { id: task.id, title: task.title, assignee: task.assignee },
          changes,
          senderPersonId,
        );
        if (notif) notifications.push(notif);
      }

      /* --- Build result --- */
      const result: UpdateResult = {
        success: true,
        task_id: task.id,
        changes,
      };
      if (notifications.length > 0) result.notifications = notifications;

      return result;
      })(); // end transaction
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  dependency — taskflow_dependency                                  */
  /* ---------------------------------------------------------------- */

  dependency(params: DependencyParams): DependencyResult {
    try {
      return this.db.transaction(() => {
      const now = new Date().toISOString();

      /* --- Fetch task --- */
      const task = this.requireTask(params.task_id);
      const taskBoardId = this.taskBoardId(task);

      /* --- Save undo snapshot (before any mutation) --- */
      const snapshot = JSON.stringify({
        action: params.action,
        by: params.sender_name,
        at: now,
        snapshot: {
          blocked_by: task.blocked_by,
          reminders: task.reminders,
          updated_at: task.updated_at,
        },
      });

      let change: string;

      switch (params.action) {
        /* ---- add_dep ---- */
        case 'add_dep': {
          if (!params.target_task_id) {
            return { success: false, error: 'Missing required parameter: target_task_id' };
          }
          if (params.task_id === params.target_task_id) {
            return { success: false, error: 'A task cannot depend on itself.' };
          }
          const target = this.getTask(params.target_task_id);
          if (!target) {
            return { success: false, error: `Target task not found: ${params.target_task_id}` };
          }

          const blockedBy: string[] = JSON.parse(task.blocked_by ?? '[]');
          if (blockedBy.includes(params.target_task_id)) {
            return { success: false, error: `Duplicate dependency: ${params.task_id} already depends on ${params.target_task_id}.` };
          }

          /* Circular dependency detection (BFS through blocked_by chains) */
          if (this.hasCircularDep(params.task_id, params.target_task_id)) {
            return { success: false, error: `Circular dependency detected: adding this dependency would create a cycle.` };
          }

          blockedBy.push(params.target_task_id);
          this.db
            .prepare(`UPDATE tasks SET blocked_by = ?, updated_at = ?, _last_mutation = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(blockedBy), now, snapshot, taskBoardId, task.id);

          change = `Dependency added: ${params.task_id} now blocked by ${params.target_task_id}`;
          this.recordHistory(
            task.id,
            'dep_added',
            params.sender_name,
            JSON.stringify({ target: params.target_task_id }),
            taskBoardId,
          );
          break;
        }

        /* ---- remove_dep ---- */
        case 'remove_dep': {
          if (!params.target_task_id) {
            return { success: false, error: 'Missing required parameter: target_task_id' };
          }
          const blockedBy: string[] = JSON.parse(task.blocked_by ?? '[]');
          const idx = blockedBy.indexOf(params.target_task_id);
          if (idx < 0) {
            return { success: false, error: `Dependency not found: ${params.task_id} does not depend on ${params.target_task_id}.` };
          }
          blockedBy.splice(idx, 1);
          this.db
            .prepare(`UPDATE tasks SET blocked_by = ?, updated_at = ?, _last_mutation = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(blockedBy), now, snapshot, taskBoardId, task.id);

          change = `Dependency removed: ${params.task_id} no longer blocked by ${params.target_task_id}`;
          this.recordHistory(
            task.id,
            'dep_removed',
            params.sender_name,
            JSON.stringify({ target: params.target_task_id }),
            taskBoardId,
          );
          break;
        }

        /* ---- add_reminder ---- */
        case 'add_reminder': {
          if (!task.due_date) {
            return { success: false, error: 'Cannot add reminder: task has no due date.' };
          }
          if (params.reminder_days == null || params.reminder_days < 0) {
            return { success: false, error: 'Missing or invalid parameter: reminder_days (must be >= 0).' };
          }
          const reminderDate = reminderDateFromDue(task.due_date, params.reminder_days);

          const reminders: Array<{ days: number; date: string }> = JSON.parse(task.reminders ?? '[]');
          reminders.push({ days: params.reminder_days, date: reminderDate });
          this.db
            .prepare(`UPDATE tasks SET reminders = ?, updated_at = ?, _last_mutation = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(reminders), now, snapshot, taskBoardId, task.id);

          change = `Reminder added: ${params.reminder_days} day(s) before due date (${reminderDate})`;
          this.recordHistory(
            task.id,
            'reminder_added',
            params.sender_name,
            JSON.stringify({ days: params.reminder_days, date: reminderDate }),
            taskBoardId,
          );
          break;
        }

        /* ---- remove_reminder ---- */
        case 'remove_reminder': {
          this.db
            .prepare(`UPDATE tasks SET reminders = '[]', updated_at = ?, _last_mutation = ? WHERE board_id = ? AND id = ?`)
            .run(now, snapshot, taskBoardId, task.id);

          change = `All reminders removed from ${params.task_id}`;
          this.recordHistory(task.id, 'reminder_removed', params.sender_name, undefined, taskBoardId);
          break;
        }

        default:
          return { success: false, error: `Unknown dependency action: ${(params as any).action}` };
      }

      return {
        success: true,
        task_id: task.id,
        change,
      };
      })(); // end transaction
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /**
   * BFS-based circular dependency detection.
   * Returns true if adding a dependency from taskId → targetId would create a cycle.
   * We walk the blocked_by chain starting from targetId; if we reach taskId, it's a cycle.
   */
  private hasCircularDep(taskId: string, targetId: string): boolean {
    const visited = new Set<string>();
    const queue = [targetId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === taskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const currentTask = this.getTask(current);
      if (currentTask?.blocked_by) {
        try {
          const deps: string[] = JSON.parse(currentTask.blocked_by);
          queue.push(...deps);
        } catch {
          // ignore malformed JSON
        }
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /*  Pre-formatted board view                                         */
  /* ---------------------------------------------------------------- */

  private formatBoardView(mode: 'board' | 'standup' = 'board'): string {
    const todayStr = today();
    const todayMs = new Date(todayStr).getTime();

    /* --- Person name lookup --- */
    const people = this.db
      .prepare(`SELECT person_id, name FROM board_people WHERE board_id = ?`)
      .all(this.boardId) as Array<{ person_id: string; name: string }>;
    const nameOf = new Map(people.map((p) => [p.person_id, p.name]));
    const pName = (id: string | null) => (id ? nameOf.get(id) ?? id : null);

    /* --- Short-code cache for displayId (avoids N+1 per-task DB queries) --- */
    const shortCodes = new Map<string, string | null>();
    const allBoards = this.db.prepare(`SELECT id, short_code FROM boards`).all() as Array<{ id: string; short_code: string | null }>;
    for (const b of allBoards) shortCodes.set(b.id, b.short_code);
    const dId = (task: any): string => {
      const owning = task.owning_board_id ?? task.board_id;
      if (owning === this.boardId) return task.id;
      const sc = shortCodes.get(owning) ?? null;
      return sc ? `${sc}-${task.id}` : task.id;
    };

    /* --- Fetch tasks (exclude done) --- */
    const allTasks = this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${this.visibleTaskScope()} AND column != 'done' ORDER BY id`,
      )
      .all(...this.visibleTaskParams()) as any[];

    /* --- Split top-level vs subtasks --- */
    const topLevel = allTasks.filter((t) => !t.parent_task_id);
    const subtaskMap = new Map<string, any[]>();
    for (const t of allTasks.filter((t) => t.parent_task_id)) {
      const arr = subtaskMap.get(t.parent_task_id);
      if (arr) arr.push(t);
      else subtaskMap.set(t.parent_task_id, [t]);
    }

    /* --- Promote orphaned subtasks: fetch parent from other board --- */
    const topLevelIds = new Set(topLevel.map((t) => t.id));
    for (const [parentId, subs] of subtaskMap.entries()) {
      if (!topLevelIds.has(parentId)) {
        const parentBoardId = subs[0].owning_board_id ?? subs[0].board_id;
        const parent = this.db
          .prepare(TaskflowEngine.TASK_BY_BOARD_SQL)
          .get(parentBoardId, parentId) as any | undefined;
        if (parent) {
          topLevel.push(parent);
          topLevelIds.add(parent.id);
        }
      }
    }

    /* --- Counts --- */
    const projectCount = topLevel.filter((t) => t.type === 'project').length;
    const subtaskCount = allTasks.filter((t) => t.parent_task_id).length;
    const taskCount = topLevel.length;

    /* --- Group top-level by column --- */
    const byColumn = new Map<string, any[]>();
    for (const t of topLevel) {
      const col = t.column ?? 'inbox';
      const arr = byColumn.get(col);
      if (arr) arr.push(t);
      else byColumn.set(col, [t]);
    }

    /* --- Helpers --- */
    const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    const daysDiff = (iso: string) =>
      Math.floor((new Date(iso).getTime() - todayMs) / 86400000);

    const hasNotes = (t: any): boolean => {
      if (!t.notes) return false;
      try {
        const a = typeof t.notes === 'string' ? JSON.parse(t.notes) : t.notes;
        return Array.isArray(a) && a.length > 0;
      } catch {
        return false;
      }
    };

    const pfx = (t: any): string => {
      if (t.due_date && daysDiff(t.due_date) <= 2) return '\u26a0\ufe0f ';
      if (t.child_exec_enabled === 1) return '\ud83d\udd17 ';
      if (t.type === 'project') return '\ud83d\udcc1 ';
      if (t.type === 'recurring') return '\ud83d\udd04 ';
      return '';
    };

    const dueSfx = (t: any): string => {
      if (!t.due_date) return '';
      const d = daysDiff(t.due_date);
      if (d <= 2) return ` \u23f0 *${fmtDate(t.due_date)} (${d}d!)*`;
      return ` \u23f0 ${fmtDate(t.due_date)}`;
    };

    const notesSfx = (t: any) => (hasNotes(t) ? ' \ud83d\udcac' : '');

    /* --- Build output --- */
    const urgent: string[] = [];
    const lines: string[] = [];
    const SEP = '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501';

    /* Header */
    const [y, m, d] = todayStr.split('-');
    if (mode === 'board') {
      lines.push(`\ud83d\udccb *TASKFLOW BOARD* \u2014 ${d}/${m}/${y}`);
    } else {
      const dayNames = [
        'Domingo',
        'Segunda',
        'Ter\u00e7a',
        'Quarta',
        'Quinta',
        'Sexta',
        'S\u00e1bado',
      ];
      lines.push(
        `\ud83d\udcca *Board \u2014 ${dayNames[new Date().getDay()]}, ${d}/${m}/${y}*`,
      );
    }
    lines.push(
      `\ud83d\udcca ${taskCount} tarefas \u2022 ${projectCount} projetos \u2022 ${subtaskCount} subtarefas`,
    );

    /* Columns */
    const colOrder: Array<[string, string]> = [
      ['inbox', '\ud83d\udce5 *INBOX*'],
      ['next_action', '\u23ed\ufe0f *PR\u00d3XIMAS A\u00c7\u00d5ES*'],
      ['in_progress', '\ud83d\udd04 *EM ANDAMENTO*'],
      ['waiting', '\u23f3 *AGUARDANDO*'],
      ['review', '\ud83d\udd0d *REVIS\u00c3O*'],
    ];

    for (const [col, label] of colOrder) {
      const tasks = byColumn.get(col);
      if (!tasks || tasks.length === 0) continue;

      lines.push('', SEP, '');

      if (col === 'inbox') {
        lines.push(`${label} (${tasks.length})`, '');
        for (const t of tasks) lines.push(`\u2022 ${dId(t)}: ${t.title}`);
        continue;
      }

      /* Group by person */
      const byPerson = new Map<string, any[]>();
      for (const t of tasks) {
        const key = t.assignee ?? '__none__';
        const arr = byPerson.get(key);
        if (arr) arr.push(t);
        else byPerson.set(key, [t]);
      }

      /* Sort persons by earliest due date */
      const earliest = (list: any[]) =>
        list.reduce(
          (mn: string | null, t: any) =>
            t.due_date && (!mn || t.due_date < mn) ? t.due_date : mn,
          null as string | null,
        );
      const cmpDateNullable = (a: string | null, b: string | null): number => {
        if (a && b) return a.localeCompare(b);
        if (a) return -1;
        if (b) return 1;
        return 0;
      };
      const persons = [...byPerson.entries()].sort((a, b) =>
        cmpDateNullable(earliest(a[1]), earliest(b[1])),
      );

      lines.push(label, '');

      for (const [personId, pTasks] of persons) {
        const nm = pName(personId) ?? personId;
        const subCount = pTasks.reduce(
          (n, t) => n + (subtaskMap.get(t.id)?.length ?? 0),
          0,
        );
        lines.push(`\ud83d\udc64 *${nm}* (${pTasks.length + subCount})`);

        /* Sort tasks by due date */
        const sorted = [...pTasks].sort((a, b) =>
          cmpDateNullable(a.due_date, b.due_date),
        );

        for (const t of sorted) {
          const tid = dId(t);
          let line = `${pfx(t)}${tid}: ${t.title}${dueSfx(t)}${notesSfx(t)}`;
          if (col === 'waiting' && t.waiting_for)
            line += ` \u2192 _${t.waiting_for}_`;
          lines.push(line);

          /* Track urgency */
          if (t.due_date) {
            const dd = daysDiff(t.due_date);
            if (dd <= 2) {
              if (dd < 0)
                urgent.push(`\u26a0\ufe0f *${tid} (${nm}) atrasada!*`);
              else
                urgent.push(
                  `\u26a0\ufe0f *${tid} (${nm}) vence em ${dd} dias!*`,
                );
            }
          }

          /* Subtasks */
          const subs = subtaskMap.get(t.id);
          if (subs) {
            for (const st of subs) {
              lines.push(
                `   \u21b3 ${dId(st)}: ${st.title}${dueSfx(st)}${notesSfx(st)}`,
              );
            }
          }
        }
        lines.push('');
      }
    }

    /* Footer */
    lines.push(SEP);
    for (const u of urgent) lines.push(u);

    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- */
  /*  Main query dispatcher                                            */
  /* ---------------------------------------------------------------- */

  query(params: QueryParams): TaskflowResult {
    try {
      switch (params.query) {
        /* ---------- Board views ---------- */

        case 'board': {
          const tasks = this.getAllActiveTasks();
          const linked = this.getLinkedTasks();
          const grouped: Record<string, any[]> = {};
          for (const t of tasks) {
            const col = t.column ?? 'inbox';
            (grouped[col] ??= []).push(t);
          }
          return {
            success: true,
            data: {
              columns: grouped,
              linked_tasks: linked,
              formatted_board: this.formatBoardView('board'),
            },
          };
        }

        case 'inbox':
          return { success: true, data: this.getTasksByColumn('inbox') };

        case 'review':
          return { success: true, data: this.getTasksByColumn('review') };

        case 'in_progress':
          return { success: true, data: this.getTasksByColumn('in_progress') };

        case 'next_action':
          return { success: true, data: this.getTasksByColumn('next_action') };

        case 'waiting':
          return { success: true, data: this.getTasksByColumn('waiting') };

        /* ---------- Person-scoped ---------- */

        case 'my_tasks': {
          const person = this.requirePerson(params.sender_name, 'sender_name');
          return { success: true, data: this.getTasksByAssignee(person.person_id) };
        }

        case 'person_tasks': {
          const person = this.requirePerson(params.person_name, 'person_name');
          return { success: true, data: this.getTasksByAssignee(person.person_id) };
        }

        case 'person_waiting': {
          const person = this.requirePerson(params.person_name, 'person_name');
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND assignee = ? AND column = 'waiting'
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams(), person.person_id);
          return { success: true, data: tasks };
        }

        case 'person_completed': {
          const person = this.requirePerson(params.person_name, 'person_name');
          const rows = this.db
            .prepare(
              `SELECT * FROM archive
               WHERE board_id = ? AND assignee = ?
               ORDER BY archived_at DESC`,
            )
            .all(this.boardId, person.person_id);
          return { success: true, data: rows };
        }

        case 'person_review': {
          const person = this.requirePerson(params.person_name, 'person_name');
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND assignee = ? AND column = 'review'
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams(), person.person_id);
          return { success: true, data: tasks };
        }

        /* ---------- Due-date filters ---------- */

        case 'overdue': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND due_date < ? AND column != 'done'
               ORDER BY due_date, id`,
            )
            .all(...this.visibleTaskParams(), today());
          return { success: true, data: tasks };
        }

        case 'due_today': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND due_date = ?
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams(), today());
          return { success: true, data: tasks };
        }

        case 'due_tomorrow': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND due_date = ?
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams(), tomorrow());
          return { success: true, data: tasks };
        }

        case 'due_this_week': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND due_date >= ? AND due_date <= ?
               ORDER BY due_date, id`,
            )
            .all(...this.visibleTaskParams(), weekStart(), weekEnd());
          return { success: true, data: tasks };
        }

        case 'next_7_days': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND due_date >= ? AND due_date <= ?
               ORDER BY due_date, id`,
            )
            .all(...this.visibleTaskParams(), today(), sevenDaysFromNow());
          return { success: true, data: tasks };
        }

        /* ---------- Search & filters ---------- */

        case 'search': {
          if (!params.search_text) {
            return { success: false, error: 'Missing required parameter: search_text' };
          }
          const pattern = `%${params.search_text}%`;
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND (title LIKE ? OR description LIKE ?)
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams(), pattern, pattern);
          return { success: true, data: tasks };
        }

        case 'urgent': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND priority = 'urgent'
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams());
          return { success: true, data: tasks };
        }

        case 'high_priority': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND priority IN ('urgent', 'high')
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams());
          return { success: true, data: tasks };
        }

        case 'by_label': {
          if (!params.label) {
            return { success: false, error: 'Missing required parameter: label' };
          }
          // Use LIKE on the JSON text — matches labels containing the value
          const pattern = `%"${params.label}"%`;
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND labels LIKE ?
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams(), pattern);
          return { success: true, data: tasks };
        }

        /* ---------- Task details & history ---------- */

        case 'task_details': {
          const task = this.requireTask(params.task_id);
          const history = this.getHistory(params.task_id!, 5, this.taskBoardId(task));
          const data: any = { task, recent_history: history };
          // Include subtask rows for project tasks
          if (task.type === 'project') {
            data.subtask_rows = this.getSubtaskRows(task.id, this.taskBoardId(task));
          }
          // Include parent project info for subtasks
          if (task.parent_task_id) {
            const parent = this.getTask(task.parent_task_id);
            if (parent) {
              data.parent_project = { id: parent.id, title: parent.title, column: parent.column };
            }
          }
          return { success: true, data };
        }

        case 'task_history': {
          const task = this.requireTask(params.task_id);
          const history = this.getHistory(params.task_id!, undefined, this.taskBoardId(task));
          return { success: true, data: history };
        }

        /* ---------- Archive ---------- */

        case 'archive': {
          const rows = this.db
            .prepare(
              `SELECT * FROM archive
               WHERE board_id = ?
               ORDER BY archived_at DESC
               LIMIT 20`,
            )
            .all(this.boardId);
          return { success: true, data: rows };
        }

        case 'archive_search': {
          if (!params.search_text) {
            return { success: false, error: 'Missing required parameter: search_text' };
          }
          const pattern = `%${params.search_text}%`;
          const rows = this.db
            .prepare(
              `SELECT * FROM archive
               WHERE board_id = ? AND title LIKE ?
               ORDER BY archived_at DESC`,
            )
            .all(this.boardId, pattern);
          return { success: true, data: rows };
        }

        /* ---------- Completed filters ---------- */

        case 'completed_today': {
          const t = today();
          const rows = this.db
            .prepare(
              `SELECT * FROM archive
               WHERE board_id = ? AND archived_at >= ? AND archived_at < date(?, '+1 day')
               ORDER BY archived_at DESC`,
            )
            .all(this.boardId, t, t);
          return { success: true, data: rows };
        }

        case 'completed_this_week': {
          const rows = this.db
            .prepare(
              `SELECT * FROM archive
               WHERE board_id = ? AND archived_at >= ? AND archived_at <= ?
               ORDER BY archived_at DESC`,
            )
            .all(this.boardId, weekStart(), weekEnd() + 'T23:59:59');
          return { success: true, data: rows };
        }

        case 'completed_this_month': {
          const ms = monthStart();
          // end of month: go to next month day-1 … simpler: just use >= monthStart
          const rows = this.db
            .prepare(
              `SELECT * FROM archive
               WHERE board_id = ? AND archived_at >= ?
                 AND archived_at < date(?, '+1 month')
               ORDER BY archived_at DESC`,
            )
            .all(this.boardId, ms, ms);
          return { success: true, data: rows };
        }

        /* ---------- Agenda ---------- */

        case 'agenda': {
          const t = today();
          const overdue = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND due_date < ? AND column != 'done'
               ORDER BY due_date, id`,
            )
            .all(...this.visibleTaskParams(), t);
          const dueToday = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND due_date = ?
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams(), t);
          const inProgress = this.getTasksByColumn('in_progress');
          return {
            success: true,
            data: {
              overdue,
              due_today: dueToday,
              in_progress: inProgress,
            },
          };
        }

        case 'agenda_week': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND due_date >= ? AND due_date <= ?
               ORDER BY due_date, id`,
            )
            .all(...this.visibleTaskParams(), weekStart(), weekEnd());
          return { success: true, data: tasks };
        }

        /* ---------- Change history ---------- */

        case 'changes_today': {
          const t = today();
          const rows = this.db
            .prepare(
              `SELECT * FROM task_history
               WHERE board_id = ? AND at >= ? AND at < date(?, '+1 day')
               ORDER BY id DESC`,
            )
            .all(this.boardId, t, t);
          return { success: true, data: rows };
        }

        case 'changes_since': {
          if (!params.since) {
            return { success: false, error: 'Missing required parameter: since' };
          }
          const rows = this.db
            .prepare(
              `SELECT * FROM task_history
               WHERE board_id = ? AND at >= ?
               ORDER BY id DESC`,
            )
            .all(this.boardId, params.since);
          return { success: true, data: rows };
        }

        case 'changes_this_week': {
          const rows = this.db
            .prepare(
              `SELECT * FROM task_history
               WHERE board_id = ? AND at >= ? AND at <= ?
               ORDER BY id DESC`,
            )
            .all(this.boardId, weekStart(), weekEnd() + 'T23:59:59');
          return { success: true, data: rows };
        }

        /* ---------- Statistics ---------- */

        case 'statistics': {
          const tasks = this.getAllActiveTasks();
          const columnCounts: Record<string, number> = {};
          let overdueCount = 0;
          const assignees = new Set<string>();
          const t = today();

          for (const task of tasks) {
            const col = task.column ?? 'inbox';
            columnCounts[col] = (columnCounts[col] ?? 0) + 1;
            if (task.due_date && task.due_date < t && col !== 'done') {
              overdueCount++;
            }
            if (task.assignee) assignees.add(task.assignee);
          }

          const personCount = assignees.size || 1;
          return {
            success: true,
            data: {
              total_active: tasks.length,
              by_column: columnCounts,
              overdue: overdueCount,
              avg_tasks_per_person: +(tasks.length / personCount).toFixed(1),
            },
          };
        }

        case 'person_statistics': {
          const person = this.requirePerson(
            params.person_name ?? params.sender_name,
            'person_name or sender_name',
          );
          const tasks = this.getTasksByAssignee(person.person_id);
          const t = today();
          const columnCounts: Record<string, number> = {};
          let overdueCount = 0;

          for (const task of tasks) {
            const col = task.column ?? 'inbox';
            columnCounts[col] = (columnCounts[col] ?? 0) + 1;
            if (task.due_date && task.due_date < t && col !== 'done') {
              overdueCount++;
            }
          }

          const completed = this.db
            .prepare(
              `SELECT COUNT(*) as count FROM archive
               WHERE board_id = ? AND assignee = ?`,
            )
            .get(this.boardId, person.person_id) as { count: number };

          const totalEver = tasks.length + completed.count;
          const completionRate =
            totalEver > 0
              ? +((completed.count / totalEver) * 100).toFixed(1)
              : 0;

          return {
            success: true,
            data: {
              person: person.name,
              total_active: tasks.length,
              by_column: columnCounts,
              overdue: overdueCount,
              completed: completed.count,
              completion_rate: completionRate,
            },
          };
        }

        case 'month_statistics': {
          const ms = monthStart();
          const created = this.db
            .prepare(
              `SELECT COUNT(*) as count FROM tasks
               WHERE board_id = ? AND created_at >= ?`,
            )
            .get(this.boardId, ms) as { count: number };
          const completed = this.db
            .prepare(
              `SELECT COUNT(*) as count FROM archive
               WHERE board_id = ? AND archived_at >= ?
                 AND archived_at < date(?, '+1 month')`,
            )
            .get(this.boardId, ms, ms) as { count: number };
          return {
            success: true,
            data: {
              month: ms.slice(0, 7),
              created: created.count,
              completed: completed.count,
            },
          };
        }

        /* ---------- Summary ---------- */

        case 'summary': {
          const tasks = this.getAllActiveTasks();
          const t = today();
          let overdueCount = 0;
          let inProgressCount = 0;
          let blockingCount = 0;

          for (const task of tasks) {
            if (task.due_date && task.due_date < t && task.column !== 'done') {
              overdueCount++;
            }
            if (task.column === 'in_progress') inProgressCount++;
            // A task is "blocking" if its id appears in another task's blocked_by
            // We do a simpler approach: tasks that have a non-empty blocked_by referencing existing tasks
          }

          // Count tasks that are blocked (have non-empty blocked_by)
          for (const task of tasks) {
            try {
              const blockedBy = JSON.parse(task.blocked_by ?? '[]');
              if (Array.isArray(blockedBy) && blockedBy.length > 0) {
                blockingCount++;
              }
            } catch {
              // ignore malformed JSON
            }
          }

          return {
            success: true,
            data: {
              total_tasks: tasks.length,
              overdue: overdueCount,
              in_progress: inProgressCount,
              blocked: blockingCount,
            },
          };
        }

        /* ---------- Unknown ---------- */

        default:
          return {
            success: false,
            error: `Unknown query type: ${params.query}`,
          };
      }
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  undo — taskflow_undo                                             */
  /* ---------------------------------------------------------------- */

  undo(params: UndoParams): UndoResult {
    try {
      return this.db.transaction(() => {
      const now = new Date().toISOString();

      /* --- 1. Find the most recently mutated task --- */
      const latestRow = this.db
        .prepare(
          `SELECT id, board_id, _last_mutation FROM tasks
           WHERE ${this.visibleTaskScope()} AND _last_mutation IS NOT NULL
           ORDER BY json_extract(_last_mutation, '$.at') DESC LIMIT 1`,
        )
        .get(...this.visibleTaskParams()) as
        | { id: string; board_id: string; _last_mutation: string }
        | undefined;

      if (!latestRow) {
        return { success: false, error: 'Nothing to undo: no recent mutations found.' };
      }

      let latestTask: { id: string; mutation: any };
      try {
        latestTask = { id: latestRow.id, mutation: JSON.parse(latestRow._last_mutation) };
      } catch {
        return { success: false, error: 'Nothing to undo: no valid mutations found.' };
      }

      const { id: taskId, mutation } = latestTask;
      const taskBoardId = latestRow.board_id;
      const { action, by, at, snapshot } = mutation;

      /* --- 2. Time check: 60 seconds --- */
      const mutationTime = new Date(at).getTime();
      const nowTime = new Date(now).getTime();
      if (nowTime - mutationTime > 60_000) {
        return { success: false, error: 'Undo expired: mutation was more than 60 seconds ago.' };
      }

      /* --- 3. Permission: only the mutation author or a manager --- */
      const isMgr = this.isManager(params.sender_name);
      if (by !== params.sender_name && !isMgr) {
        return {
          success: false,
          error: `Permission denied: only "${by}" (mutation author) or a manager can undo.`,
        };
      }

      /* --- 4. Check if it was a creation --- */
      if (action === 'created') {
        return {
          success: false,
          error: 'Cannot undo creation. Use cancelar (admin cancel_task) instead.',
        };
      }

      /* --- 5. WIP guard: if restoring to in_progress, check WIP limit --- */
      if (snapshot?.column === 'in_progress') {
        const task = this.getTask(taskId);
        if (task?.assignee) {
          const wip = this.checkWipLimit(task.assignee);
          if (!wip.ok) {
            if (!params.force) {
              return {
                success: false,
                error: `WIP limit exceeded for ${wip.person_name}: ${wip.current} in progress (limit: ${wip.limit}). Use force (forcar) to override.`,
              };
            }
            /* force=true requires manager */
            if (!isMgr) {
              return {
                success: false,
                error: 'Permission denied: only managers can force undo past WIP limit.',
              };
            }
          }
        }
      }

      /* --- 6. Restore: replace task fields with snapshot values --- */
      if (snapshot && typeof snapshot === 'object') {
        const fields = Object.keys(snapshot);
        if (fields.length > 0) {
          const setClauses = fields.map((f) => `${f} = ?`).join(', ');
          const values = fields.map((f) => {
            const val = snapshot[f];
            /* JSON columns stored as strings */
            return val;
          });
          this.db
            .prepare(
              `UPDATE tasks SET ${setClauses}, _last_mutation = NULL, updated_at = ?
               WHERE board_id = ? AND id = ?`,
            )
            .run(...values, now, taskBoardId, taskId);
        } else {
          /* No snapshot fields, just clear _last_mutation */
          this.db
            .prepare(
              `UPDATE tasks SET _last_mutation = NULL, updated_at = ?
               WHERE board_id = ? AND id = ?`,
            )
            .run(now, taskBoardId, taskId);
        }
      } else {
        /* No snapshot object, just clear _last_mutation */
        this.db
          .prepare(
            `UPDATE tasks SET _last_mutation = NULL, updated_at = ?
             WHERE board_id = ? AND id = ?`,
          )
          .run(now, taskBoardId, taskId);
      }

      /* --- Record history --- */
      this.recordHistory(taskId, 'undone', params.sender_name, JSON.stringify({ undone_action: action }), taskBoardId);

      return {
        success: true,
        task_id: taskId,
        undone_action: action,
      };
      })(); // end transaction
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  admin — taskflow_admin                                           */
  /* ---------------------------------------------------------------- */

  admin(params: AdminParams): AdminResult {
    try {
      return this.db.transaction(() => {
      /* --- Permission check: process_inbox allows manager or delegate; all others require manager --- */
      if (params.action === 'process_inbox') {
        if (!this.isManagerOrDelegate(params.sender_name)) {
          return {
            success: false,
            error: `Permission denied: "${params.sender_name}" is not a manager or delegate.`,
          };
        }
      } else if (!this.isManager(params.sender_name)) {
        return {
          success: false,
          error: `Permission denied: "${params.sender_name}" is not a manager.`,
        };
      }

      switch (params.action) {
        /* ---- register_person ---- */
        case 'register_person': {
          if (!params.person_name) {
            return { success: false, error: 'Missing required parameter: person_name' };
          }

          /* Slugify name to create person_id */
          const personId = params.person_name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

          /* Check for duplicate */
          const existing = this.db
            .prepare(
              `SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?`,
            )
            .get(this.boardId, personId);
          if (existing) {
            return { success: false, error: `Person "${params.person_name}" (${personId}) already exists on this board.` };
          }

          this.db
            .prepare(
              `INSERT INTO board_people (board_id, person_id, name, phone, role, wip_limit)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              this.boardId,
              personId,
              params.person_name,
              params.phone ?? null,
              params.role ?? 'member',
              params.wip_limit ?? null,
            );

          let autoProvisionRequest: AdminResult['auto_provision_request'];
          if (params.phone && this.canDelegateDown()) {
            autoProvisionRequest = {
              person_id: personId,
              person_name: params.person_name,
              person_phone: params.phone,
              person_role: params.role ?? 'member',
              group_name: params.group_name,
              group_folder: params.group_folder,
              message: `Quadro filho para ${params.person_name} será provisionado automaticamente.`,
            };
          }

          return {
            success: true,
            person_id: personId,
            data: { name: params.person_name, person_id: personId },
            ...(autoProvisionRequest
              ? { auto_provision_request: autoProvisionRequest }
              : {}),
          };
        }

        /* ---- remove_person ---- */
        case 'remove_person': {
          const person = this.requirePerson(params.person_name, 'person_name');

          /* Check for active tasks */
          const activeTasks = this.db
            .prepare(
              `SELECT id, title FROM tasks
               WHERE board_id = ? AND assignee = ? AND column != 'done'
               ORDER BY id`,
            )
            .all(this.boardId, person.person_id) as Array<{ id: string; title: string }>;

          if (activeTasks.length > 0 && !params.force) {
            return {
              success: true,
              tasks_to_reassign: activeTasks.map((t) => ({ task_id: t.id, title: t.title })),
              data: {
                message: `${person.name} has ${activeTasks.length} active task(s). Use force=true to unassign them, or reassign first.`,
              },
            };
          }

          /* If force, unassign active tasks */
          if (activeTasks.length > 0 && params.force) {
            const now = new Date().toISOString();
            this.db
              .prepare(
                `UPDATE tasks SET assignee = NULL, updated_at = ?
                 WHERE board_id = ? AND assignee = ? AND column != 'done'`,
              )
              .run(now, this.boardId, person.person_id);
          }

          /* Delete from board_admins first (FK-like cleanup) */
          this.db
            .prepare(
              `DELETE FROM board_admins WHERE board_id = ? AND person_id = ?`,
            )
            .run(this.boardId, person.person_id);

          /* Delete from board_people */
          this.db
            .prepare(
              `DELETE FROM board_people WHERE board_id = ? AND person_id = ?`,
            )
            .run(this.boardId, person.person_id);

          return {
            success: true,
            data: { removed: person.name, tasks_unassigned: params.force ? activeTasks.length : 0 },
          };
        }

        /* ---- add_manager ---- */
        case 'add_manager': {
          const person = this.requirePerson(params.person_name, 'person_name');

          /* Check if already a manager */
          const existing = this.db
            .prepare(
              `SELECT 1 FROM board_admins
               WHERE board_id = ? AND person_id = ? AND admin_role = 'manager'`,
            )
            .get(this.boardId, person.person_id);
          if (existing) {
            return { success: false, error: `${person.name} is already a manager.` };
          }

          /* Get phone from board_people */
          const personRow = this.db
            .prepare(
              `SELECT phone FROM board_people WHERE board_id = ? AND person_id = ?`,
            )
            .get(this.boardId, person.person_id) as { phone: string | null } | undefined;

          this.db
            .prepare(
              `INSERT INTO board_admins (board_id, person_id, phone, admin_role)
               VALUES (?, ?, ?, 'manager')`,
            )
            .run(this.boardId, person.person_id, personRow?.phone ?? params.phone ?? '');

          return {
            success: true,
            person_id: person.person_id,
            data: { name: person.name, role: 'manager' },
          };
        }

        /* ---- add_delegate ---- */
        case 'add_delegate': {
          const person = this.requirePerson(params.person_name, 'person_name');

          /* Check if already a delegate */
          const existing = this.db
            .prepare(
              `SELECT 1 FROM board_admins
               WHERE board_id = ? AND person_id = ? AND admin_role = 'delegate'`,
            )
            .get(this.boardId, person.person_id);
          if (existing) {
            return { success: false, error: `${person.name} is already a delegate.` };
          }

          /* Get phone from board_people */
          const personRow = this.db
            .prepare(
              `SELECT phone FROM board_people WHERE board_id = ? AND person_id = ?`,
            )
            .get(this.boardId, person.person_id) as { phone: string | null } | undefined;

          this.db
            .prepare(
              `INSERT INTO board_admins (board_id, person_id, phone, admin_role)
               VALUES (?, ?, ?, 'delegate')`,
            )
            .run(this.boardId, person.person_id, personRow?.phone ?? params.phone ?? '');

          return {
            success: true,
            person_id: person.person_id,
            data: { name: person.name, role: 'delegate' },
          };
        }

        /* ---- remove_admin ---- */
        case 'remove_admin': {
          const person = this.requirePerson(params.person_name, 'person_name');

          /* Count remaining managers (excluding the person being removed) */
          const managerCount = this.db
            .prepare(
              `SELECT COUNT(*) as cnt FROM board_admins
               WHERE board_id = ? AND admin_role = 'manager' AND person_id != ?`,
            )
            .get(this.boardId, person.person_id) as { cnt: number };

          /* Check if person is a manager */
          const isPersonManager = this.db
            .prepare(
              `SELECT 1 FROM board_admins
               WHERE board_id = ? AND person_id = ? AND admin_role = 'manager'`,
            )
            .get(this.boardId, person.person_id);

          if (isPersonManager && managerCount.cnt === 0) {
            return {
              success: false,
              error: `Cannot remove ${person.name}: they are the last manager. Add another manager first.`,
            };
          }

          const changes = this.db
            .prepare(
              `DELETE FROM board_admins WHERE board_id = ? AND person_id = ?`,
            )
            .run(this.boardId, person.person_id);

          if (changes.changes === 0) {
            return { success: false, error: `${person.name} has no admin roles to remove.` };
          }

          return {
            success: true,
            data: { removed_admin: person.name },
          };
        }

        /* ---- set_wip_limit ---- */
        case 'set_wip_limit': {
          const person = this.requirePerson(params.person_name, 'person_name');

          if (params.wip_limit == null || params.wip_limit < 0) {
            return { success: false, error: 'Missing or invalid parameter: wip_limit (must be >= 0).' };
          }

          this.db
            .prepare(
              `UPDATE board_people SET wip_limit = ?
               WHERE board_id = ? AND person_id = ?`,
            )
            .run(params.wip_limit, this.boardId, person.person_id);

          return {
            success: true,
            data: { person: person.name, wip_limit: params.wip_limit },
          };
        }

        /* ---- cancel_task ---- */
        case 'cancel_task': {
          const task = this.requireTask(params.task_id);
          const now = new Date().toISOString();

          /* Authority-while-linked: child board cannot cancel parent board's tasks */
          if (task.child_exec_enabled === 1 && task.board_id !== this.boardId) {
            return { success: false, error: `Tarefa ${task.id} pertence ao quadro superior. Apenas o gestor do quadro superior pode cancelar.` };
          }

          /* Archive and delete task (resolves dependencies, handles subtasks) */
          this.archiveTask(task, 'cancelled');

          /* Record history (on the archive entry for reference) */
          this.recordHistory(task.id, 'cancelled', params.sender_name);

          return {
            success: true,
            data: { cancelled: task.id, title: task.title },
          };
        }

        /* ---- restore_task ---- */
        case 'restore_task': {
          if (!params.task_id) {
            return { success: false, error: 'Missing required parameter: task_id' };
          }

          const archived = this.db
            .prepare(
              `SELECT * FROM archive WHERE board_id = ? AND task_id = ?`,
            )
            .get(this.boardId, params.task_id) as any;

          if (!archived) {
            return { success: false, error: `Archived task not found: ${params.task_id}` };
          }

          /* Parse snapshot and restore */
          const snapshot = JSON.parse(archived.task_snapshot);
          const now = new Date().toISOString();
          this.restoreTaskRow(
            {
              ...snapshot,
              id: snapshot.id ?? archived.task_id,
              type: snapshot.type ?? archived.type,
              title: snapshot.title ?? archived.title,
              assignee: snapshot.assignee ?? archived.assignee ?? null,
            },
            this.boardId,
            now,
          );

          if (Array.isArray(snapshot.archived_subtasks)) {
            for (const child of snapshot.archived_subtasks) {
              if (!child?.snapshot?.id) continue;
              this.restoreTaskRow(child.snapshot, this.boardId, now);
            }
          }

          /* Delete from archive */
          this.db
            .prepare(
              `DELETE FROM archive WHERE board_id = ? AND task_id = ?`,
            )
            .run(this.boardId, params.task_id);

          /* Record history */
          this.recordHistory(params.task_id, 'restored', params.sender_name);

          return {
            success: true,
            data: { restored: params.task_id, title: archived.title, column: snapshot.column ?? 'inbox' },
          };
        }

        /* ---- process_inbox ---- */
        case 'process_inbox': {
          const inboxTasks = this.getTasksByColumn('inbox');
          return {
            success: true,
            tasks: inboxTasks,
            data: { count: inboxTasks.length },
          };
        }

        /* ---- manage_holidays ---- */
        case 'manage_holidays': {
          const op = params.holiday_operation;
          if (!op) return { success: false, error: 'Missing required parameter: holiday_operation' };

          const dateFormatRe = /^\d{4}-\d{2}-\d{2}$/;
          const validateHolidayDates = (holidays: Array<{ date: string }>): string | null => {
            for (const h of holidays) {
              if (!dateFormatRe.test(h.date)) return `Invalid date format "${h.date}". Expected YYYY-MM-DD.`;
            }
            return null;
          };

          switch (op) {
            case 'add': {
              if (!params.holidays || params.holidays.length === 0) {
                return { success: false, error: 'Missing required parameter: holidays (array of {date, label?})' };
              }
              const fmtErr = validateHolidayDates(params.holidays);
              if (fmtErr) return { success: false, error: fmtErr };
              const stmt = this.db.prepare(
                `INSERT OR REPLACE INTO board_holidays (board_id, holiday_date, label) VALUES (?, ?, ?)`,
              );
              for (const h of params.holidays) {
                stmt.run(this.boardId, h.date, h.label ?? null);
              }
              this._holidayCache = null;
              return {
                success: true,
                data: { added: params.holidays.length },
              };
            }
            case 'remove': {
              if (!params.holiday_dates || params.holiday_dates.length === 0) {
                return { success: false, error: 'Missing required parameter: holiday_dates (array of date strings)' };
              }
              const stmt = this.db.prepare(
                `DELETE FROM board_holidays WHERE board_id = ? AND holiday_date = ?`,
              );
              let removed = 0;
              for (const d of params.holiday_dates) {
                const r = stmt.run(this.boardId, d);
                removed += r.changes;
              }
              this._holidayCache = null;
              return {
                success: true,
                data: { removed },
              };
            }
            case 'set_year': {
              if (params.holiday_year == null) {
                return { success: false, error: 'Missing required parameter: holiday_year' };
              }
              if (!params.holidays) {
                return { success: false, error: 'Missing required parameter: holidays (array of {date, label?})' };
              }
              const fmtErr = validateHolidayDates(params.holidays);
              if (fmtErr) return { success: false, error: fmtErr };
              const yearStr = String(params.holiday_year);
              for (const h of params.holidays) {
                if (!h.date.startsWith(yearStr + '-')) {
                  return { success: false, error: `Holiday date "${h.date}" does not belong to year ${params.holiday_year}.` };
                }
              }
              const yearPrefix = `${params.holiday_year}-`;
              this.db
                .prepare(`DELETE FROM board_holidays WHERE board_id = ? AND holiday_date LIKE ?`)
                .run(this.boardId, `${yearPrefix}%`);
              const stmt = this.db.prepare(
                `INSERT INTO board_holidays (board_id, holiday_date, label) VALUES (?, ?, ?)`,
              );
              for (const h of params.holidays) {
                stmt.run(this.boardId, h.date, h.label ?? null);
              }
              this._holidayCache = null;
              return {
                success: true,
                data: { year: params.holiday_year, set: params.holidays.length },
              };
            }
            case 'list': {
              let rows;
              if (params.holiday_year != null) {
                rows = this.db
                  .prepare(`SELECT holiday_date, label FROM board_holidays WHERE board_id = ? AND holiday_date LIKE ? ORDER BY holiday_date`)
                  .all(this.boardId, `${params.holiday_year}-%`) as Array<{ holiday_date: string; label: string | null }>;
              } else {
                rows = this.db
                  .prepare(`SELECT holiday_date, label FROM board_holidays WHERE board_id = ? ORDER BY holiday_date`)
                  .all(this.boardId) as Array<{ holiday_date: string; label: string | null }>;
              }
              return {
                success: true,
                holidays: rows.map((r) => ({ date: r.holiday_date, label: r.label })),
                data: { count: rows.length },
              };
            }
            default:
              return { success: false, error: `Unknown holiday operation: ${op}` };
          }
        }

        default:
          return { success: false, error: `Unknown admin action: ${(params as any).action}` };
      }
      })(); // end transaction
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  report — taskflow_report                                         */
  /* ---------------------------------------------------------------- */

  report(params: ReportParams): ReportResult {
    try {
      const todayStr = today();
      const isDigestOrWeekly = params.type === 'digest' || params.type === 'weekly';
      const isWeekly = params.type === 'weekly';

      /* --- Build person lookup map (person_id → name) --- */
      const people = this.db
        .prepare(`SELECT person_id, name FROM board_people WHERE board_id = ?`)
        .all(this.boardId) as Array<{ person_id: string; name: string }>;
      const personMap = new Map(people.map((p) => [p.person_id, p.name]));
      const resolveName = (personId: string | null): string | null =>
        personId ? personMap.get(personId) ?? null : null;

      /* --- Overdue tasks --- */
      const overdue = this.db
        .prepare(
          `SELECT id, title, assignee, due_date FROM tasks
           WHERE ${this.visibleTaskScope()} AND due_date < ? AND column != 'done'
           ORDER BY due_date, id`,
        )
        .all(...this.visibleTaskParams(), todayStr) as Array<{ id: string; title: string; assignee: string | null; due_date: string }>;

      /* --- In-progress tasks --- */
      const inProgress = this.db
        .prepare(
          `SELECT id, title, assignee FROM tasks
           WHERE ${this.visibleTaskScope()} AND column = 'in_progress'
           ORDER BY id`,
        )
        .all(...this.visibleTaskParams()) as Array<{ id: string; title: string; assignee: string | null }>;

      /* --- Review tasks --- */
      const review = this.db
        .prepare(
          `SELECT id, title, assignee FROM tasks
           WHERE ${this.visibleTaskScope()} AND column = 'review'
           ORDER BY id`,
        )
        .all(...this.visibleTaskParams()) as Array<{ id: string; title: string; assignee: string | null }>;

      /* --- Due today --- */
      const dueToday = this.db
        .prepare(
          `SELECT id, title, assignee FROM tasks
           WHERE ${this.visibleTaskScope()} AND due_date = ? AND column != 'done'
           ORDER BY id`,
        )
        .all(...this.visibleTaskParams(), todayStr) as Array<{ id: string; title: string; assignee: string | null }>;

      /* --- Waiting tasks --- */
      const waiting = this.db
        .prepare(
          `SELECT id, title, assignee, waiting_for FROM tasks
           WHERE ${this.visibleTaskScope()} AND column = 'waiting'
           ORDER BY id`,
        )
        .all(...this.visibleTaskParams()) as Array<{ id: string; title: string; assignee: string | null; waiting_for: string | null }>;

      /* --- Blocked tasks (digest + weekly) --- */
      let blocked: Array<{ id: string; title: string; assignee: string | null; blocked_by_raw: string }> = [];
      if (isDigestOrWeekly) {
        blocked = this.db
          .prepare(
            `SELECT id, title, assignee, blocked_by AS blocked_by_raw FROM tasks
             WHERE ${this.visibleTaskScope()} AND column != 'done' AND blocked_by != '[]'
             ORDER BY id`,
          )
          .all(...this.visibleTaskParams()) as any[];
      }

      /* --- Completed today (digest + weekly) --- */
      let completedToday: Array<{ task_id: string }> = [];
      if (isDigestOrWeekly) {
        completedToday = this.db
          .prepare(
            `SELECT DISTINCT task_id FROM task_history
             WHERE board_id = ? AND action = 'moved'
               AND details LIKE '%"to_column":"done"%'
               AND at LIKE ?
             ORDER BY task_id`,
          )
          .all(this.boardId, `${todayStr}%`) as Array<{ task_id: string }>;
      }

      /* --- Changes today count (digest + weekly) --- */
      let changesTodayCount = 0;
      if (isDigestOrWeekly) {
        const row = this.db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM task_history
             WHERE board_id = ? AND at LIKE ?`,
          )
          .get(this.boardId, `${todayStr}%`) as { cnt: number };
        changesTodayCount = row.cnt;
      }

      /* --- Resolve completed_today task details --- */
      const completedTodayTasks: Array<{ id: string; title: string; assignee: string | null }> = [];
      if (isDigestOrWeekly) {
        for (const { task_id } of completedToday) {
          // First check active tasks
          const task = this.db
            .prepare(
              `SELECT id, title, assignee FROM tasks
               WHERE ${this.visibleTaskScope()} AND id = ?`,
            )
            .get(...this.visibleTaskParams(), task_id) as
            | { id: string; title: string; assignee: string | null }
            | undefined;
          if (task) {
            completedTodayTasks.push(task);
          } else {
            // Check archive
            const archived = this.db
              .prepare(`SELECT task_id AS id, title, assignee FROM archive WHERE board_id = ? AND task_id = ?`)
              .get(this.boardId, task_id) as { id: string; title: string; assignee: string | null } | undefined;
            if (archived) completedTodayTasks.push(archived);
          }
        }
      }

      /* --- Per-person subtask assignments (active, not done) --- */
      const subtaskCountByPerson = new Map<string, number>();
      const subtaskRows = this.db
        .prepare(
          `SELECT assignee, COUNT(*) AS cnt FROM tasks
           WHERE board_id = ? AND parent_task_id IS NOT NULL AND column != 'done' AND assignee IS NOT NULL
           GROUP BY assignee`,
        )
        .all(this.boardId) as Array<{ assignee: string; cnt: number }>;
      for (const row of subtaskRows) {
        subtaskCountByPerson.set(row.assignee, row.cnt);
      }

      /* --- Per-person summary --- */
      const perPerson: Array<{
        name: string;
        in_progress: number;
        waiting: number;
        subtask_assignments?: number;
        completed_today?: number;
        completed_week?: number;
      }> = [];

      // Count per-person completed today (digest + weekly)
      const completedTodayByPerson = new Map<string, number>();
      if (isDigestOrWeekly) {
        for (const t of completedTodayTasks) {
          if (t.assignee) {
            completedTodayByPerson.set(
              t.assignee,
              (completedTodayByPerson.get(t.assignee) ?? 0) + 1,
            );
          }
        }
      }

      // Count per-person completed this week (weekly only)
      const completedWeekByPerson = new Map<string, number>();
      if (isWeekly) {
        const ws = weekStart();
        const completedWeekRows = this.db
          .prepare(
            `SELECT th.task_id, t.assignee FROM task_history th
             LEFT JOIN tasks t ON t.board_id = th.board_id AND t.id = th.task_id
             WHERE th.board_id = ? AND th.action = 'moved'
               AND th.details LIKE '%"to_column":"done"%'
               AND th.at >= ?
             UNION
             SELECT th.task_id, a.assignee FROM task_history th
             LEFT JOIN archive a ON a.board_id = th.board_id AND a.task_id = th.task_id
             WHERE th.board_id = ? AND th.action = 'moved'
               AND th.details LIKE '%"to_column":"done"%'
               AND th.at >= ?
               AND th.task_id NOT IN (SELECT id FROM tasks WHERE board_id = ?)`,
          )
          .all(this.boardId, ws, this.boardId, ws, this.boardId) as Array<{ task_id: string; assignee: string | null }>;

        for (const row of completedWeekRows) {
          if (row.assignee) {
            completedWeekByPerson.set(
              row.assignee,
              (completedWeekByPerson.get(row.assignee) ?? 0) + 1,
            );
          }
        }
      }

      for (const person of people) {
        const ipCount = inProgress.filter((t) => t.assignee === person.person_id).length;
        const wCount = waiting.filter((t) => t.assignee === person.person_id).length;
        const subCount = subtaskCountByPerson.get(person.person_id) ?? 0;
        const entry: typeof perPerson[number] = {
          name: person.name,
          in_progress: ipCount,
          waiting: wCount,
          subtask_assignments: subCount,
        };
        if (isDigestOrWeekly) {
          entry.completed_today = completedTodayByPerson.get(person.person_id) ?? 0;
        }
        if (isWeekly) {
          entry.completed_week = completedWeekByPerson.get(person.person_id) ?? 0;
        }
        perPerson.push(entry);
      }

      /* --- Weekly stats --- */
      let stats: ReportResult['data'] extends undefined ? never : NonNullable<ReportResult['data']>['stats'] = undefined;
      if (isWeekly) {
        const ws = weekStart();
        const lws = lastWeekStart();
        const lwe = lastWeekEnd();

        // Total active tasks (not in done, not cancelled)
        const activeRow = this.db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM tasks
             WHERE board_id = ? AND column != 'done'`,
          )
          .get(this.boardId) as { cnt: number };

        // Completed this week
        const completedWeekRow = this.db
          .prepare(
            `SELECT COUNT(DISTINCT task_id) AS cnt FROM task_history
             WHERE board_id = ? AND action = 'moved'
               AND details LIKE '%"to_column":"done"%'
               AND at >= ?`,
          )
          .get(this.boardId, ws) as { cnt: number };

        // Created this week
        const createdWeekRow = this.db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM task_history
             WHERE board_id = ? AND action = 'created' AND at >= ?`,
          )
          .get(this.boardId, ws) as { cnt: number };

        // Completed last week (for trend)
        const completedLastWeekRow = this.db
          .prepare(
            `SELECT COUNT(DISTINCT task_id) AS cnt FROM task_history
             WHERE board_id = ? AND action = 'moved'
               AND details LIKE '%"to_column":"done"%'
               AND at >= ? AND at < ?`,
          )
          .get(this.boardId, lws, ws) as { cnt: number };

        const completedWeek = completedWeekRow.cnt;
        const completedLastWeek = completedLastWeekRow.cnt;
        const trend: 'up' | 'down' | 'same' =
          completedWeek > completedLastWeek
            ? 'up'
            : completedWeek < completedLastWeek
              ? 'down'
              : 'same';

        stats = {
          total_active: activeRow.cnt,
          completed_week: completedWeek,
          created_week: createdWeekRow.cnt,
          trend,
        };
      }

      /* --- Stale tasks: no update 3+ days (weekly only) --- */
      let staleTasks: Array<{ id: string; title: string; assignee: string | null; column: string; updated_at: string }> = [];
      if (isWeekly) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 3);
        const cutoffIso = cutoff.toISOString();
        staleTasks = this.db
          .prepare(
            `SELECT id, title, assignee, column, updated_at FROM tasks
             WHERE board_id = ? AND column IN ('next_action', 'in_progress', 'review') AND updated_at < ?
             ORDER BY updated_at ASC`,
          )
          .all(this.boardId, cutoffIso) as typeof staleTasks;
      }

      /* --- Auto-archive old done tasks (standup housekeeping) --- */
      if (params.type === 'standup') {
        try { this.archiveOldDoneTasks(); } catch { /* cleanup failure must not break standup */ }
      }

      /* --- Formatted board for standup --- */
      const formatted_board =
        params.type === 'standup' ? this.formatBoardView('standup') : undefined;

      /* --- Assemble result --- */
      return {
        success: true,
        data: {
          date: todayStr,
          ...(formatted_board ? { formatted_board } : {}),
          overdue: overdue.map((t) => ({
            id: t.id,
            title: t.title,
            assignee_name: resolveName(t.assignee),
            due_date: t.due_date,
          })),
          in_progress: inProgress.map((t) => ({
            id: t.id,
            title: t.title,
            assignee_name: resolveName(t.assignee),
          })),
          review: review.map((t) => ({
            id: t.id,
            title: t.title,
            assignee_name: resolveName(t.assignee),
          })),
          due_today: dueToday.map((t) => ({
            id: t.id,
            title: t.title,
            assignee_name: resolveName(t.assignee),
          })),
          waiting: waiting.map((t) => ({
            id: t.id,
            title: t.title,
            assignee_name: resolveName(t.assignee),
            waiting_for: t.waiting_for,
          })),
          blocked: isDigestOrWeekly
            ? blocked.map((t) => {
                let blockedByIds: string[] = [];
                try {
                  blockedByIds = JSON.parse(t.blocked_by_raw);
                } catch {}
                return {
                  id: t.id,
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                  blocked_by: blockedByIds,
                };
              })
            : [],
          completed_today: isDigestOrWeekly
            ? completedTodayTasks.map((t) => ({
                id: t.id,
                title: t.title,
                assignee_name: resolveName(t.assignee),
              }))
            : [],
          changes_today_count: isDigestOrWeekly ? changesTodayCount : 0,
          per_person: perPerson,
          ...(isWeekly && stats ? { stats } : {}),
          ...(isWeekly && staleTasks.length > 0
            ? {
                stale_tasks: staleTasks.map((t) => ({
                  id: t.id,
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                  column: t.column,
                  updated_at: t.updated_at,
                })),
              }
            : {}),
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  hierarchy — taskflow_hierarchy                                    */
  /* ---------------------------------------------------------------- */

  hierarchy(params: HierarchyParams): HierarchyResult {
    try {
      return this.db.transaction(() => {
      const now = new Date().toISOString();

      /* --- Fetch task --- */
      const task = this.requireTask(params.task_id);
      const taskBoardId = this.taskBoardId(task);
      const sender = this.resolvePerson(params.sender_name);
      const senderPersonId = sender?.person_id ?? null;
      const isMgr = this.isManager(params.sender_name);
      const isAssignee = senderPersonId != null && task.assignee === senderPersonId;

      /* Manager guard for link/unlink/refresh_rollup (tag_parent has its own permission model) */
      if (['link', 'unlink', 'refresh_rollup'].includes(params.action) && !isMgr) {
        return { success: false, error: `Only managers can manage hierarchy links. "${params.sender_name}" is not a manager.` };
      }

      switch (params.action) {
        /* ---- link ---- */
        case 'link': {
          if (!this.canDelegateDown()) {
            return { success: false, error: 'Cannot link tasks on a leaf board (max hierarchy depth reached).' };
          }
          if (!params.person_name) {
            return { success: false, error: 'Missing required parameter: person_name (target person with child board).' };
          }
          if (task.type === 'recurring') {
            return { success: false, error: 'Recurring tasks (RXXX) cannot be linked to child boards.' };
          }
          if (task.child_exec_enabled === 1) {
            return { success: false, error: `Task ${task.id} is already linked to a child board. Unlink first.` };
          }

          /* Resolve target person */
          const targetPerson = this.resolvePerson(params.person_name);
          if (!targetPerson) {
            return this.buildOfferRegisterError(params.person_name);
          }

          /* Check child board registration */
          const reg = this.getChildBoardRegistration(targetPerson.person_id);
          if (!reg) {
            return { success: false, error: `${targetPerson.name} does not have a child board registered.` };
          }
          if (!task.assignee || task.assignee !== targetPerson.person_id) {
            return {
              success: false,
              error: `Task ${task.id} assignee must match the child-board person. Reassign to ${targetPerson.name} first.`,
            };
          }

          /* Link */
          this.db
            .prepare(
              `UPDATE tasks SET child_exec_enabled = 1, child_exec_board_id = ?, child_exec_person_id = ?,
               child_exec_rollup_status = 'no_work_yet', updated_at = ?
               WHERE board_id = ? AND id = ?`,
            )
            .run(reg.child_board_id, targetPerson.person_id, now, taskBoardId, task.id);

          this.recordHistory(task.id, 'child_board_linked', params.sender_name,
            JSON.stringify({ child_board_id: reg.child_board_id, person: targetPerson.name }), taskBoardId);

          return {
            success: true,
            task_id: task.id,
            data: { linked_to: targetPerson.name, child_board_id: reg.child_board_id },
          };
        }

        /* ---- unlink ---- */
        case 'unlink': {
          if (task.child_exec_enabled !== 1) {
            return { success: false, error: `Task ${task.id} is not linked to a child board.` };
          }

          this.db
            .prepare(
              `UPDATE tasks SET child_exec_enabled = 0, child_exec_rollup_status = NULL,
               child_exec_last_rollup_at = NULL, child_exec_last_rollup_summary = NULL, updated_at = ?
               WHERE board_id = ? AND id = ?`,
            )
            .run(now, taskBoardId, task.id);

          this.recordHistory(task.id, 'child_board_unlinked', params.sender_name,
            JSON.stringify({
              was_board_id: task.child_exec_board_id,
              last_rollup_status: task.child_exec_rollup_status ?? null,
            }), taskBoardId);

          return {
            success: true,
            task_id: task.id,
            data: { unlinked: true },
          };
        }

        /* ---- refresh_rollup ---- */
        case 'refresh_rollup': {
          if (task.child_exec_enabled !== 1) {
            return { success: false, error: `Task ${task.id} is not linked to a child board.` };
          }

          const childBoardId = task.child_exec_board_id;
          const lastRollupAt = task.child_exec_last_rollup_at ?? '1970-01-01T00:00:00.000Z';

          /* Step 1 — Count active child work */
          const counts = this.db
            .prepare(
              `SELECT
                 COUNT(*) AS total_count,
                 SUM(CASE WHEN "column" != 'done' THEN 1 ELSE 0 END) AS open_count,
                 SUM(CASE WHEN "column" = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
                 SUM(CASE
                   WHEN due_date IS NOT NULL AND due_date < ? AND "column" != 'done'
                   THEN 1 ELSE 0 END) AS overdue_count,
                 MAX(updated_at) AS latest_child_update_at
               FROM tasks
               WHERE board_id = ?
                 AND linked_parent_board_id = ?
                 AND linked_parent_task_id = ?`,
            )
            .get(now.slice(0, 10), childBoardId, taskBoardId, task.id) as any;

          /* Step 2 — Count cancelled work since last rollup */
          const cancelRow = this.db
            .prepare(
              `SELECT COUNT(*) AS cancelled_count
               FROM archive
               WHERE board_id = ?
                 AND linked_parent_board_id = ?
                 AND linked_parent_task_id = ?
                 AND archive_reason = 'cancelled'
                 AND archived_at > ?`,
            )
            .get(childBoardId, taskBoardId, task.id, lastRollupAt) as any;

          const totalCount = counts.total_count ?? 0;
          const openCount = counts.open_count ?? 0;
          const waitingCount = counts.waiting_count ?? 0;
          const overdueCount = counts.overdue_count ?? 0;
          const cancelledCount = cancelRow.cancelled_count ?? 0;

          /* Step 3 — Apply mapping rules (priority order) */
          let rollupStatus: string;
          let newColumn: string | null = null;
          let waitingForValue: string | null = null;

          if (cancelledCount > 0 && openCount === 0) {
            rollupStatus = 'cancelled_needs_decision';
            // Keep current column
          } else if (totalCount > 0 && openCount === 0 && cancelledCount === 0) {
            rollupStatus = 'ready_for_review';
            newColumn = 'review';
          } else if (waitingCount > 0) {
            rollupStatus = 'blocked';
            newColumn = 'waiting';
            waitingForValue = `Quadro filho: ${waitingCount} tarefa(s) aguardando`;
          } else if (overdueCount > 0) {
            rollupStatus = 'at_risk';
            newColumn = 'in_progress';
          } else if (openCount > 0) {
            rollupStatus = 'active';
            newColumn = 'in_progress';
          } else if (totalCount === 0 && cancelledCount === 0) {
            rollupStatus = 'no_work_yet';
            // Keep current column (next_action)
          } else {
            rollupStatus = 'active';
            newColumn = 'in_progress';
          }

          /* Build summary */
          const parts: string[] = [];
          if (openCount > 0) parts.push(`${openCount} ativo(s)`);
          if (waitingCount > 0) parts.push(`${waitingCount} aguardando`);
          if (overdueCount > 0) parts.push(`${overdueCount} atrasado(s)`);
          if (cancelledCount > 0) parts.push(`${cancelledCount} cancelado(s)`);
          const doneCount = totalCount - openCount;
          if (doneCount > 0) parts.push(`${doneCount} concluído(s)`);
          const summary = parts.length > 0 ? parts.join(', ') : 'Sem atividade';

          /* Step 4 — Update parent task */
          if (newColumn) {
            this.db
              .prepare(
                `UPDATE tasks SET
                   child_exec_rollup_status = ?,
                   child_exec_last_rollup_at = ?,
                   child_exec_last_rollup_summary = ?,
                   "column" = ?,
                   waiting_for = CASE WHEN ? = 'waiting' THEN ? ELSE NULL END,
                   updated_at = ?
                 WHERE board_id = ? AND id = ?`,
              )
              .run(rollupStatus, now, summary, newColumn, newColumn, waitingForValue, now, taskBoardId, task.id);
          } else {
            this.db
              .prepare(
                `UPDATE tasks SET
                   child_exec_rollup_status = ?,
                   child_exec_last_rollup_at = ?,
                   child_exec_last_rollup_summary = ?,
                   updated_at = ?
                 WHERE board_id = ? AND id = ?`,
              )
              .run(rollupStatus, now, summary, now, taskBoardId, task.id);
          }

          this.recordHistory(task.id, 'child_rollup_updated', params.sender_name,
            JSON.stringify({ rollup_status: rollupStatus, summary, new_column: newColumn }), taskBoardId);
          if (task.child_exec_rollup_status !== rollupStatus) {
            const statusActionMap: Record<string, string> = {
              blocked: 'child_rollup_blocked',
              at_risk: 'child_rollup_at_risk',
              ready_for_review: 'child_rollup_completed',
              cancelled_needs_decision: 'child_rollup_cancelled',
            };
            const statusAction = statusActionMap[rollupStatus];
            if (statusAction) {
              this.recordHistory(
                task.id,
                statusAction,
                params.sender_name,
                JSON.stringify({
                  from: task.child_exec_rollup_status ?? null,
                  to: rollupStatus,
                }),
                taskBoardId,
              );
            }
          }

          return {
            success: true,
            task_id: task.id,
            rollup_status: rollupStatus,
            rollup_summary: summary,
            new_column: newColumn ?? task.column,
            data: {
              total: totalCount,
              open: openCount,
              waiting: waitingCount,
              overdue: overdueCount,
              cancelled: cancelledCount,
              done: doneCount,
            },
          };
        }

        /* ---- tag_parent ---- */
        case 'tag_parent': {
          if (!isMgr && !isAssignee) {
            return {
              success: false,
              error: `Permission denied: "${params.sender_name}" is neither the assignee nor a manager.`,
            };
          }
          if (taskBoardId !== this.boardId) {
            return {
              success: false,
              error: `Task ${task.id} is not local to this board. Parent-tagging only applies to local tasks.`,
            };
          }
          const boardInfo = this.db
            .prepare(`SELECT parent_board_id FROM boards WHERE id = ?`)
            .get(this.boardId) as { parent_board_id: string | null } | undefined;
          if (!boardInfo?.parent_board_id) {
            return {
              success: false,
              error: 'This is the root board. No parent board is available for tagging.',
            };
          }
          if (!params.parent_task_id) {
            return { success: false, error: 'Missing required parameter: parent_task_id' };
          }

          this.db
            .prepare(
              `UPDATE tasks SET linked_parent_board_id = ?, linked_parent_task_id = ?, updated_at = ?
               WHERE board_id = ? AND id = ?`,
            )
            .run(boardInfo.parent_board_id, params.parent_task_id, now, taskBoardId, task.id);

          this.recordHistory(
            task.id,
            'parent_linked',
            params.sender_name,
            JSON.stringify({
              linked_parent_board_id: boardInfo.parent_board_id,
              linked_parent_task_id: params.parent_task_id,
            }),
            taskBoardId,
          );

          return {
            success: true,
            task_id: task.id,
            data: {
              linked_parent_board_id: boardInfo.parent_board_id,
              linked_parent_task_id: params.parent_task_id,
            },
          };
        }

        default:
          return { success: false, error: `Unknown hierarchy action: ${(params as any).action}` };
      }
      })(); // end transaction
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  archiveOldDoneTasks — auto-archive done tasks older than 30 days */
  /* ---------------------------------------------------------------- */

  private archiveOldDoneTasks(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffIso = cutoff.toISOString();

    const oldDone = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE board_id = ? AND column = 'done' AND updated_at < ?`,
      )
      .all(this.boardId, cutoffIso) as any[];

    if (oldDone.length === 0) return;

    this.db.transaction(() => {
      for (const task of oldDone) {
        this.archiveTask(task, 'done');
      }
    })();
  }
}
