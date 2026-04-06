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
  at?: string; // for meeting_minutes_at (YYYY-MM-DD)
  query_vector?: Float32Array; // pre-embedded search vector
  embedding_reader?: import('./embedding-reader.js').EmbeddingReader; // injected by MCP handler for semantic search
}

export interface TaskflowResult {
  success: boolean;
  data?: any;
  formatted?: string;
  error?: string;
  [key: string]: any;
}

/** Shared notification entry shape used across all result interfaces. */
export type NotificationEntry = {
  target_kind?: 'group' | 'dm';
  target_person_id?: string;
  target_external_id?: string;
  notification_group_jid?: string | null;
  target_chat_jid?: string | null;
  message: string;
};

export type ParentNotification = { parent_group_jid: string; message: string };

export interface CreateParams {
  board_id: string;
  type: 'simple' | 'project' | 'recurring' | 'inbox' | 'meeting';
  title: string;
  assignee?: string;
  requires_close_approval?: boolean;
  due_date?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  labels?: string[];
  subtasks?: Array<string | { title: string; assignee?: string }>;
  recurrence?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrence_anchor?: string;
  max_cycles?: number;
  recurrence_end_date?: string;
  participants?: string[];
  scheduled_at?: string;
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
  notifications?: NotificationEntry[];
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
  title?: string;
  from_column?: string;
  to_column?: string;
  approval_gate_applied?: boolean;
  wip_warning?: { person: string; current: number; limit: number };
  project_update?: { completed_subtask: string; next_subtask?: string; all_complete: boolean };
  recurring_cycle?: { cycle_number: number; expired: boolean; new_due_date?: string; new_scheduled_at?: string; reason?: 'max_cycles' | 'end_date' };
  archive_triggered?: boolean;
  notifications?: NotificationEntry[];
  parent_notification?: ParentNotification;
  unprocessed_minutes_warning?: boolean;
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
  notifications?: NotificationEntry[];
}

export interface UpdateParams {
  board_id: string;
  task_id: string;
  sender_name: string;
  sender_external_id?: string;
  updates: {
    title?: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    requires_close_approval?: boolean;
    due_date?: string | null;   // null = remove
    description?: string;
    next_action?: string;
    add_label?: string;
    remove_label?: string;
    add_note?: string;
    edit_note?: { id: number; text: string };
    remove_note?: number;
    parent_note_id?: number;
    scheduled_at?: string;
    add_participant?: string;
    remove_participant?: string;
    add_external_participant?: { name: string; phone: string };
    remove_external_participant?: { external_id?: string; phone?: string; name?: string };
    reinvite_external_participant?: { external_id?: string; phone?: string };
    set_note_status?: { id: number; status: 'open' | 'checked' | 'task_created' | 'inbox_created' | 'dismissed' };
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
  title?: string;
  changes?: string[];      // human-readable list of what changed
  offer_register?: { name: string; message: string };
  notifications?: NotificationEntry[];
  parent_notification?: ParentNotification;
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
  title?: string;
  change?: string;           // human-readable description of what changed
}

export interface UndoParams {
  board_id: string;
  sender_name: string;
  force?: boolean;  // override WIP guard
}

export interface UndoResult extends TaskflowResult {
  task_id?: string;
  title?: string;
  undone_action?: string;
}

export interface AdminParams {
  board_id: string;
  action: 'register_person' | 'remove_person' | 'add_manager' | 'add_delegate' | 'remove_admin' | 'set_wip_limit' | 'cancel_task' | 'restore_task' | 'process_inbox' | 'manage_holidays' | 'process_minutes' | 'process_minutes_decision' | 'accept_external_invite' | 'reparent_task' | 'detach_task';
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
  note_id?: number;
  decision?: 'create_task' | 'create_inbox';
  create?: {
    type: string;
    title: string;
    assignee?: string;
    labels?: string[];
  };
  sender_external_id?: string;
  target_parent_id?: string;
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
  notifications?: NotificationEntry[];
}

export interface ReportParams {
  board_id: string;
  type: 'standup' | 'digest' | 'weekly';
}

export interface ReportResult extends TaskflowResult {
  data?: {
    date: string;
    formatted_report?: string;
    overdue: Array<{ id: string; title: string; assignee_name: string | null; due_date: string }>;
    next_48h?: Array<{ id: string; title: string; assignee_name: string | null; due_date: string }>;
    in_progress: Array<{ id: string; title: string; assignee_name: string | null }>;
    review: Array<{ id: string; title: string; assignee_name: string | null }>;
    due_today: Array<{ id: string; title: string; assignee_name: string | null }>;
    waiting: Array<{ id: string; title: string; assignee_name: string | null; waiting_for: string | null }>;
    waiting_5d?: Array<{ id: string; title: string; assignee_name: string | null; waiting_for: string | null; updated_at: string }>;
    blocked: Array<{ id: string; title: string; assignee_name: string | null; blocked_by: string[] }>;
    completed_today: Array<{ id: string; title: string; assignee_name: string | null }>;
    completed_week?: Array<{ id: string; title: string; assignee_name: string | null }>;
    stale_24h?: Array<{ id: string; title: string; assignee_name: string | null; column: string; updated_at: string }>;
    stale_tasks?: Array<{ id: string; title: string; assignee_name: string | null; column: string; updated_at: string }>;
    inbox?: Array<{ id: string; title: string; assignee_name: string | null }>;
    next_week_deadlines?: Array<{ id: string; title: string; assignee_name: string | null; due_date: string }>;
    changes_today_count: number;
    completion_streak?: number;
    completed_yesterday_count?: number;
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
    upcoming_meetings?: Array<{ id: string; title: string; scheduled_at: string; participant_count: number }>;
    meetings_with_open_minutes?: Array<{ id: string; title: string; scheduled_at: string; open_count: number }>;
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
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Monday of the current ISO week (Mon-Sun). */
function weekStart(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const diff = day === 0 ? 6 : day - 1; // how many days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/** Sunday of the current ISO week. */
function weekEnd(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? 0 : 7 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function sevenDaysFromNow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

function monthStart(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Monday of the previous ISO week. */
function lastWeekStart(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff - 7);
  return d.toISOString().slice(0, 10);
}

/** Sunday of the previous ISO week. */
function lastWeekEnd(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff - 1);
  return d.toISOString().slice(0, 10);
}

/** Compute a reminder date by subtracting days from a due date. */
function reminderDateFromDue(dueDate: string, daysBefore: number): string {
  const d = new Date(dueDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysBefore);
  return d.toISOString().slice(0, 10);
}

/** Compute a reminder date by subtracting days from a scheduled datetime.
 *  Uses only the date portion of scheduledAt, forced to UTC — consistent with
 *  reminderDateFromDue. Avoids off-by-one when scheduledAt lacks a timezone
 *  designator (JS parses naive datetimes as local time). */
function reminderDateFromScheduledAt(scheduledAt: string, daysBefore: number): string {
  const d = new Date(scheduledAt.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysBefore);
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize a scheduled_at value to UTC.
 * - No 'Z' suffix and no offset → treat as local time in `tz`, convert to UTC.
 * - Has 'Z' or ±HH:MM offset → already timezone-aware, return as ISO string.
 * - Date-only (no T) → treat as midnight local time.
 * Returns the input unchanged for empty/unparseable values.
 */
function localToUtc(naive: string, tz: string): string {
  if (!naive) return naive; // guard empty/null

  // Already timezone-aware — keep as-is
  if (/[Zz]$/.test(naive) || /[+-]\d{2}:?\d{2}$/.test(naive)) {
    return new Date(naive).toISOString();
  }

  // Normalize date-only to midnight
  const input = naive.includes('T') ? naive : naive + 'T00:00:00';

  // Parse components from naive ISO string (e.g. "2026-03-26T08:00:00")
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return naive; // unparseable — return as-is
  const [, yr, mo, dy, hr, mn, sc = '0'] = match;

  try {
    // Step 1: Create a UTC timestamp with the naive components
    const utcGuess = Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc);

    // Step 2: Find what local time this UTC instant maps to in the target timezone
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const p = Object.fromEntries(
      fmt.formatToParts(new Date(utcGuess)).map(x => [x.type, x.value]),
    );
    // hour '24' means midnight — advance to next day
    let localDay = +p.day;
    let localHour = +p.hour;
    if (p.hour === '24') { localHour = 0; localDay += 1; }
    const localAtGuess = Date.UTC(+p.year, +p.month - 1, localDay, localHour, +p.minute, +p.second);

    // Step 3: offset = localAtGuess - utcGuess; actual UTC = utcGuess - offset
    const offsetMs = localAtGuess - utcGuess;
    return new Date(utcGuess - offsetMs).toISOString();
  } catch {
    return naive; // invalid timezone or other error — return as-is
  }
}

/**
 * Format a UTC ISO string as a human-readable local date/time.
 * Returns e.g. "26/03/2026 às 08:00".
 */
function utcToLocal(utcIso: string, tz: string): string {
  if (!utcIso) return ''; // guard null/empty
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return utcIso; // unparseable fallback
  try {
    const fmt = new Intl.DateTimeFormat('pt-BR', {
      timeZone: tz,
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).map(x => [x.type, x.value]),
    );
    const hour = parts.hour === '24' ? '00' : parts.hour; // midnight guard
    return `${parts.day}/${parts.month}/${parts.year} às ${hour}:${parts.minute}`;
  } catch {
    return utcIso; // invalid timezone — return raw value
  }
}

/** Read the board timezone from board_runtime_config. Queried per-call (no stale cache). */
function getBoardTimezone(db: Database.Database, boardId: string): string {
  const row = db.prepare(
    `SELECT timezone FROM board_runtime_config WHERE board_id = ?`,
  ).get(boardId) as { timezone: string } | undefined;
  return row?.timezone ?? 'America/Fortaleza';
}

/** Advance a date by a recurrence interval and return the ISO date string. */
function advanceDateByRecurrence(d: Date, recurrence: 'daily' | 'weekly' | 'monthly' | 'yearly'): string {
  switch (recurrence) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

/** Advance a full ISO datetime by a recurrence interval, preserving the time component.
 *  @param cycles Number of recurrence periods to advance (default 1). */
function advanceDateTimeByRecurrence(
  isoDateTime: string,
  recurrence: 'daily' | 'weekly' | 'monthly' | 'yearly',
  cycles: number = 1,
): string {
  const d = new Date(isoDateTime);
  switch (recurrence) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + 1 * cycles);
      break;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7 * cycles);
      break;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1 * cycles);
      break;
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + 1 * cycles);
      break;
  }
  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/*  Utility Functions                                                  */
/* ------------------------------------------------------------------ */

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** External participant access window: 7 days after scheduled occurrence. */
const ACCESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Build the DM invite message for an external meeting participant. */
function buildExternalInviteMessage(
  taskId: string,
  taskTitle: string,
  scheduledAt: string,
  organizerName: string,
  tz: string,
): string {
  const when = utcToLocal(scheduledAt, tz);
  return (
    `\u{1f4c5} *Convite para reuni\u00e3o*\n\n` +
    `Voc\u00ea foi convidado para *${taskId} \u2014 ${taskTitle}*\n` +
    `*Quando:* ${when}\n` +
    `*Organizador:* ${organizerName}\n\n` +
    `Responda nesta conversa para participar da pauta e da ata.\n` +
    `Para confirmar, diga: aceitar convite ${taskId}`
  );
}

/* ------------------------------------------------------------------ */
/*  TaskflowEngine                                                     */
/* ------------------------------------------------------------------ */

export class TaskflowEngine {
  /** Lazily cached board timezone (almost never changes per engine lifetime). */
  private _boardTz: string | null = null;

  /** Get the board timezone, cached after first call. */
  private get boardTz(): string {
    if (!this._boardTz) {
      this._boardTz = getBoardTimezone(this.db, this.boardId);
    }
    return this._boardTz;
  }

  private static readonly moveActionLabels: Record<MoveParams['action'], string> = {
    start: 'Movida para 🔄 Em Andamento',
    wait: 'Movida para ⏳ Aguardando',
    resume: 'Retomada → 🔄 Em Andamento',
    return: 'Devolvida → ⏭️ Próximas Ações',
    review: 'Enviada para 🔍 Revisão',
    approve: '✅ Aprovada',
    reject: '↩️ Rejeitada — retrabalho necessário',
    conclude: '✅ Concluída',
    reopen: 'Reaberta → ⏭️ Próximas Ações',
    force_start: 'Forçada para 🔄 Em Andamento',
  };

  constructor(
    private db: Database.Database,
    private boardId: string,
    options?: { readonly?: boolean },
  ) {
    this.db.pragma('busy_timeout = 5000');
    if (!options?.readonly) {
      this.ensureTaskSchema();
      this.migrateLegacyProjectSubtasks();
      this.reconcileDelegationLinks();
    }
  }

  private visibleTaskScope(alias = ''): string {
    const prefix = alias ? `${alias}.` : '';
    return `(${prefix}board_id = ? OR (${prefix}child_exec_board_id = ? AND ${prefix}child_exec_enabled = 1))`;
  }

  private visibleTaskParams(): [string, string] {
    return [this.boardId, this.boardId];
  }

  /** SQL fragment: exclude tasks whose status is managed by an active child-board rollup. */
  private static excludeActiveRollup(alias = ''): string {
    const p = alias ? `${alias}.` : '';
    return `AND NOT (${p}child_exec_enabled = 1 AND ${p}child_exec_rollup_status IS NOT NULL AND ${p}child_exec_rollup_status != 'no_work_yet')`;
  }

  /** JS predicate: true when a task's status is managed by an active child-board rollup. */
  private static isRollupActive(task: any): boolean {
    return task.child_exec_enabled === 1 && !!task.child_exec_rollup_status && task.child_exec_rollup_status !== 'no_work_yet';
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

  /** Display ID: prefix delegated tasks with source board's short_code.
   *  viewerBoardId overrides the perspective — used for notifications sent to child boards. */
  private displayId(task: any, viewerBoardId = this.boardId): string {
    const owning = task.owning_board_id ?? task.board_id;
    if (owning === viewerBoardId) return task.id;
    const sc = this.getBoardShortCode(owning);
    return sc ? `${sc}-${task.id}` : task.id;
  }

  /** Determine the viewer board for a notification recipient.
   *  If the target person has a child board under the task's board, they see it from the child board (needs prefix).
   *  Otherwise they see it from the task's board (no prefix). */
  private resolveViewerBoard(targetPersonId: string, taskBoardId: string): string {
    return this.getChildBoardRegistration(targetPersonId, taskBoardId)?.child_board_id ?? taskBoardId;
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
    const taskColumns = this.db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as Array<{ name: string }>;
    const hasRequiresCloseApproval = taskColumns.some(
      (column) => column.name === 'requires_close_approval',
    );
    if (!hasRequiresCloseApproval) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN requires_close_approval INTEGER NOT NULL DEFAULT 1`); } catch {}
      /* Zero out approval for unassigned tasks and self-assigned tasks (creator == assignee) */
      this.db.exec(`UPDATE tasks SET requires_close_approval = 0 WHERE assignee IS NULL`);
      this.db.exec(`
        UPDATE tasks
           SET requires_close_approval = 0
         WHERE assignee IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM task_history th
              JOIN board_people bp ON bp.board_id = tasks.board_id AND bp.name = th.by
             WHERE th.board_id = tasks.board_id
               AND th.task_id = tasks.id
               AND th.action = 'created'
               AND bp.person_id = tasks.assignee
           )
      `);
    }
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN max_cycles INTEGER`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_end_date TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_anchor TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN participants TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_at TEXT`); } catch {}
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(board_id, parent_task_id)
       WHERE parent_task_id IS NOT NULL`,
    );
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_linked_parent ON tasks(board_id, linked_parent_board_id, linked_parent_task_id) WHERE linked_parent_board_id IS NOT NULL`); } catch {}
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_archive_linked_parent ON archive(board_id, linked_parent_board_id, linked_parent_task_id)`); } catch {}

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

    // External contacts and meeting grants (cross-board, no board_id FK on external_contacts)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS external_contacts (
        external_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        direct_chat_jid TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meeting_external_participants (
        board_id TEXT NOT NULL,
        meeting_task_id TEXT NOT NULL,
        occurrence_scheduled_at TEXT NOT NULL,
        external_id TEXT NOT NULL,
        invite_status TEXT NOT NULL DEFAULT 'pending',
        invited_at TEXT,
        accepted_at TEXT,
        revoked_at TEXT,
        access_expires_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (board_id, meeting_task_id, occurrence_scheduled_at, external_id)
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
    /* Reconcile ALL tasks on this board with an assignee — not just subtasks/recurring.
       Top-level tasks also get child_exec_enabled via auto-link on create/assign,
       so they must be reconciled when child board registrations change.
       Scoped to this.boardId so we only touch tasks owned by this board. */
    const rows = this.db
      .prepare(
        `SELECT id, board_id, assignee, child_exec_enabled, child_exec_board_id, child_exec_person_id,
                child_exec_rollup_status
           FROM tasks
          WHERE board_id = ? AND assignee IS NOT NULL`,
      )
      .all(this.boardId) as Array<{
      id: string;
      board_id: string;
      assignee: string | null;
      child_exec_enabled: number;
      child_exec_board_id: string | null;
      child_exec_person_id: string | null;
      child_exec_rollup_status: string | null;
    }>;

    const update = this.db.prepare(
      `UPDATE tasks
          SET child_exec_enabled = ?, child_exec_board_id = ?, child_exec_person_id = ?
        WHERE board_id = ? AND id = ?`,
    );

    /* When a delegation link is broken (child board removed), also clear stale rollup
       metadata so the task reappears in stale/waiting reports. */
    const clearRollup = this.db.prepare(
      `UPDATE tasks
          SET child_exec_rollup_status = NULL, child_exec_last_rollup_at = NULL,
              child_exec_last_rollup_summary = NULL
        WHERE board_id = ? AND id = ?`,
    );

    /* Track explicitly unlinked tasks to avoid re-linking them on startup */
    const unlinkedTaskIds = new Set(
      (this.db.prepare(
        `SELECT DISTINCT task_id FROM task_history WHERE board_id = ? AND action = 'child_board_unlinked'`,
      ).all(this.boardId) as Array<{ task_id: string }>).map((r) => r.task_id),
    );

    for (const row of rows) {
      const expected = this.linkedChildBoardFor(row.board_id, row.assignee ?? null);
      /* Skip re-linking tasks that were explicitly unlinked by a user */
      if (row.child_exec_enabled === 0 && expected.child_exec_enabled === 1 && unlinkedTaskIds.has(row.id)) continue;
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
        /* Clear stale rollup data when delegation is removed OR child board changed */
        if (row.child_exec_rollup_status && (
          expected.child_exec_enabled === 0 ||
          (row.child_exec_board_id ?? null) !== expected.child_exec_board_id
        )) {
          clearRollup.run(row.board_id, row.id);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Public helpers (used by mutation tools later)                     */
  /* ---------------------------------------------------------------- */

  /** Resolve a human-readable name to a person_id + canonical name. */
  resolvePerson(name: string, boardId = this.boardId): { person_id: string; name: string } | null {
    // 1. Exact match by name (case-insensitive)
    const exact = this.db
      .prepare(
        `SELECT person_id, name FROM board_people
         WHERE board_id = ? AND LOWER(name) = LOWER(?)`,
      )
      .get(boardId, name) as
      | { person_id: string; name: string }
      | undefined;
    if (exact) return exact;

    // 2. Exact match by person_id
    const byId = this.db
      .prepare(
        `SELECT person_id, name FROM board_people
         WHERE board_id = ? AND LOWER(person_id) = LOWER(?)`,
      )
      .get(boardId, name) as
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
        .all(boardId) as Array<{ person_id: string; name: string }>;
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

  private static readonly SEP = '━━━━━━━━━━━━━━';

  /** Fetch a single active task by its id. Handles board-prefixed IDs (e.g. SEC-T10). */
  getTask(taskId: string): any {
    const { boardId: targetBoardId, rawId } = this.resolveInputTaskId(taskId);
    if (targetBoardId) {
      // Short-code resolved — still enforce visibility (local or delegated to this board)
      const task = this.db.prepare(TaskflowEngine.TASK_BY_BOARD_SQL).get(targetBoardId, rawId) as any | undefined;
      if (!task) return null;
      if (task.board_id === this.boardId) return task;
      if (task.child_exec_board_id === this.boardId && task.child_exec_enabled === 1) return task;
      // Allow cross-board visibility for meeting participants
      if (task.type === 'meeting' && this.isBoardMeetingParticipant(task)) return task;
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

  /**
   * Check if any person registered on this board is a participant or organizer
   * of the given meeting task (which may belong to a different board).
   */
  private isBoardMeetingParticipant(task: any): boolean {
    const participants: string[] = JSON.parse(task.participants ?? '[]');
    const involved = [task.assignee, ...participants].filter(Boolean);
    if (involved.length === 0) return false;
    const ph = involved.map(() => '?').join(',');
    return !!this.db.prepare(
      `SELECT 1 FROM board_people WHERE board_id = ? AND person_id IN (${ph}) LIMIT 1`,
    ).get(this.boardId, ...involved);
  }

  /** Active (non-revoked, non-expired) external participants for a meeting task. */
  private getActiveExternalParticipants(boardId: string, taskId: string): Array<{
    external_id: string;
    display_name: string;
    invite_status: string;
  }> {
    const now = new Date().toISOString();
    return this.db.prepare(
      `SELECT ec.external_id, ec.display_name, mep.invite_status
       FROM meeting_external_participants mep
       JOIN external_contacts ec ON ec.external_id = mep.external_id
       WHERE mep.board_id = ? AND mep.meeting_task_id = ?
         AND mep.invite_status NOT IN ('revoked', 'expired')
         AND (mep.access_expires_at IS NULL OR mep.access_expires_at >= ?)`,
    ).all(boardId, taskId, now) as Array<{
      external_id: string;
      display_name: string;
      invite_status: string;
    }>;
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
        `SELECT t.*, pt.title AS parent_title
         FROM tasks t
         LEFT JOIN tasks pt ON pt.board_id = t.board_id AND pt.id = t.parent_task_id
         WHERE ${this.visibleTaskScope('t')} AND t.assignee = ?
         ORDER BY t.id`,
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
          column, priority, requires_close_approval, due_date, description, labels, blocked_by,
          reminders, next_note_id, notes, _last_mutation, created_at, updated_at,
          child_exec_enabled, child_exec_board_id, child_exec_person_id,
          child_exec_rollup_status, child_exec_last_rollup_at,
          child_exec_last_rollup_summary,
          linked_parent_board_id, linked_parent_task_id, parent_task_id,
          subtasks, recurrence, recurrence_anchor, current_cycle,
          max_cycles, recurrence_end_date, participants, scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        snapshot.requires_close_approval ?? this.defaultRequiresCloseApproval(snapshot.assignee ?? null, null),
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
        snapshot.recurrence_anchor ?? null,
        snapshot.current_cycle ?? null,
        snapshot.max_cycles ?? null,
        snapshot.recurrence_end_date ?? null,
        snapshot.participants ?? null,
        snapshot.scheduled_at ?? null,
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
  private isManager(senderName: string, boardId = this.boardId): boolean {
    const person = this.resolvePerson(senderName, boardId);
    if (!person) return false;
    const row = this.db
      .prepare(
        `SELECT 1 FROM board_admins
         WHERE board_id = ? AND person_id = ? AND admin_role = 'manager'`,
      )
      .get(boardId, person.person_id);
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

  private defaultRequiresCloseApproval(
    assigneePersonId: string | null,
    senderPersonId: string | null,
  ): number {
    if (!assigneePersonId) return 0;
    return assigneePersonId === senderPersonId ? 0 : 1;
  }

  private taskRequiresCloseApproval(task: { requires_close_approval?: unknown }): boolean {
    return task.requires_close_approval === 1 || task.requires_close_approval === '1' || task.requires_close_approval === true;
  }

  private completionHistoryWhere(alias = ''): string {
    const prefix = alias ? `${alias}.` : '';
    return `(
      ${prefix}action IN ('moved', 'approve', 'conclude')
      AND (
        ${prefix}details LIKE '%"to_column":"done"%'
        OR ${prefix}details LIKE '%"to":"done"%'
      )
    )`;
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

  private syncCounterPastExistingIds(prefix: string, minimumNextNumber = 1): number {
    const maxRow = this.db.prepare(
      `SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) AS m FROM tasks WHERE board_id = ? AND id GLOB ? AND id NOT GLOB ?`
    ).get(this.boardId, `${prefix}[0-9]*`, `${prefix}*.*`) as any;
    const nextNumber = Math.max((maxRow?.m ?? 0) + 1, minimumNextNumber);
    const result = this.db
      .prepare(
        `UPDATE board_id_counters
            SET next_number = CASE WHEN next_number < ? THEN ? ELSE next_number END
          WHERE board_id = ? AND prefix = ?`,
      )
      .run(nextNumber, nextNumber, this.boardId, prefix);
    if (result.changes === 0) {
      this.db
        .prepare(`INSERT INTO board_id_counters (board_id, prefix, next_number) VALUES (?, ?, ?)`)
        .run(this.boardId, prefix, nextNumber);
    }
    return nextNumber;
  }

  private allocateTaskId(prefix: string): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const num = this.getNextNumberForPrefix(prefix);
      const taskId = `${prefix}${num}`;
      const exists = this.db
        .prepare(`SELECT 1 FROM tasks WHERE board_id = ? AND id = ?`)
        .get(this.boardId, taskId) as { 1: number } | undefined;
      if (!exists) return taskId;
      this.syncCounterPastExistingIds(prefix, num + 1);
    }

    throw new Error(`Could not allocate a unique ${prefix} task ID for board ${this.boardId}.`);
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

  /** Resolve notification target. Manager→assignee when someone else modifies; assignee→creator when self-modifying. */
  private resolveNotifTarget(
    assigneePersonId: string | null,
    modifierPersonId: string,
    taskId?: string,
    boardId = this.boardId,
  ): { target_person_id: string; notification_group_jid: string | null } | null {
    // Someone else modified → notify assignee
    if (assigneePersonId && assigneePersonId !== modifierPersonId) {
      const person = this.db
        .prepare(
          `SELECT notification_group_jid FROM board_people
           WHERE board_id = ? AND person_id = ?`,
        )
        .get(boardId, assigneePersonId) as
        | { notification_group_jid: string | null }
        | undefined;
      if (!person) return null;
      return {
        target_person_id: assigneePersonId,
        notification_group_jid: person.notification_group_jid ?? null,
      };
    }
    // Self-update → notify creator/delegator (if different from assignee)
    if (taskId && assigneePersonId === modifierPersonId) {
      const creator = this.db
        .prepare(
          `SELECT by FROM task_history
           WHERE board_id = ? AND task_id = ? AND action = 'created'
           ORDER BY at ASC LIMIT 1`,
        )
        .get(boardId, taskId) as { by: string } | undefined;
      if (!creator) return null;
      const creatorPerson = this.resolvePerson(creator.by, boardId);
      if (!creatorPerson || creatorPerson.person_id === modifierPersonId) return null;
      const personRow = this.db
        .prepare(
          `SELECT notification_group_jid FROM board_people
           WHERE board_id = ? AND person_id = ?`,
        )
        .get(boardId, creatorPerson.person_id) as
        | { notification_group_jid: string | null }
        | undefined;
      if (!personRow) return null;
      return {
        target_person_id: creatorPerson.person_id,
        notification_group_jid: personRow.notification_group_jid ?? null,
      };
    }
    return null;
  }

  /** Resolve display name for a person_id. */
  private personDisplayName(personId: string, boardId = this.boardId): string {
    const row = this.db
      .prepare(`SELECT name FROM board_people WHERE board_id = ? AND person_id = ?`)
      .get(boardId, personId) as { name: string } | undefined;
    return row?.name ?? personId;
  }

  /** Format a due date for display. */
  private static formatDue(dueDate: string | null): string {
    if (!dueDate) return 'sem prazo';
    const d = new Date(dueDate + 'T00:00:00Z');
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
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
    task: { id: string; title: string; assignee: string; due_date?: string | null; priority?: string | null; column?: string; type?: string; board_id?: string },
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    const target = this.resolveNotifTarget(task.assignee, modifierPersonId);
    if (!target) return null;
    const viewerBoard = this.resolveViewerBoard(target.target_person_id, task.board_id ?? this.boardId);
    const modName = this.personDisplayName(modifierPersonId);
    const col = TaskflowEngine.columnLabel(task.column ?? 'next_action');
    const due = TaskflowEngine.formatDue(task.due_date ?? null);
    const pri = TaskflowEngine.formatPriority(task.priority ?? null);
    const typeLabel = task.type === 'project' ? 'Novo projeto atribuído a você'
      : task.type === 'meeting' ? 'Nova reunião atribuída a você'
      : 'Nova tarefa atribuída a você';
    const did = this.displayId(task, viewerBoard);
    return {
      ...target,
      message: `🔔 *${typeLabel}*\n\n*${did}* — ${task.title}\n*Atribuído por:* ${modName}\n*Coluna:* ${col}\n\n• Prazo: ${due}\n• Prioridade: ${pri}\n\nDigite \`${did}\` para ver detalhes.`,
    };
  }

  /** Build a notification for task column transition. */
  private buildMoveNotification(
    task: { id: string; title: string; assignee: string; board_id?: string },
    action: MoveParams['action'],
    modifierPersonId: string,
    taskBoardId = this.boardId,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    const target = this.resolveNotifTarget(task.assignee, modifierPersonId, task.id, taskBoardId);
    if (!target) return null;
    const viewerBoard = this.resolveViewerBoard(target.target_person_id, task.board_id ?? taskBoardId);
    const modName = this.personDisplayName(modifierPersonId);
    const desc = TaskflowEngine.moveActionLabels[action] ?? action;
    const did = this.displayId(task, viewerBoard);
    return {
      ...target,
      message: `🔔 *Atualização na sua tarefa*\n\n*${did}* — ${task.title}\n*Por:* ${modName}\n\n• ${desc}\n\nDigite \`${did}\` para ver detalhes.`,
    };
  }

  /** Build a notification for task reassignment. */
  private buildReassignNotification(
    task: { id: string; title: string; board_id?: string },
    fromPersonId: string | null,
    targetPerson: { person_id: string; notification_group_jid: string | null },
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } {
    const viewerBoard = this.resolveViewerBoard(targetPerson.person_id, task.board_id ?? this.boardId);
    const modName = this.personDisplayName(modifierPersonId);
    const did = this.displayId(task, viewerBoard);
    const header = fromPersonId
      ? `🔔 *Tarefa reatribuída para você*\n\n*${did}* — ${task.title}\n*Reatribuída de:* ${this.personDisplayName(fromPersonId)}\n*Por:* ${modName}`
      : `🔔 *Tarefa atribuída para você*\n\n*${did}* — ${task.title}\n*Por:* ${modName}`;
    return {
      target_person_id: targetPerson.person_id,
      notification_group_jid: targetPerson.notification_group_jid ?? null,
      message: `${header}\n\nDigite \`${did}\` para ver detalhes.`,
    };
  }

  /** Build a notification for task field updates (priority, due date, etc.). */
  private buildUpdateNotification(
    task: { id: string; title: string; assignee: string; board_id?: string },
    changes: string[],
    modifierPersonId: string,
    taskBoardId = this.boardId,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    const target = this.resolveNotifTarget(task.assignee, modifierPersonId, task.id, taskBoardId);
    if (!target) return null;
    const viewerBoard = this.resolveViewerBoard(target.target_person_id, task.board_id ?? taskBoardId);
    const modName = this.personDisplayName(modifierPersonId);
    const changeList = changes.map(c => `• ${c}`).join('\n');
    const did = this.displayId(task, viewerBoard);
    return {
      ...target,
      message: `🔔 *Atualização na sua tarefa*\n\n*${did}* — ${task.title}\n*Modificado por:* ${modName}\n\n${changeList}\n\nDigite \`${did}\` para ver detalhes.`,
    };
  }

  private getBoardGroupJid(boardId: string): string | null {
    const row = this.db
      .prepare(`SELECT group_jid FROM boards WHERE id = ?`)
      .get(boardId) as { group_jid: string } | undefined;
    return row?.group_jid ?? null;
  }

  private buildParentNotification(
    task: { child_exec_enabled: number; board_id: string },
    message: string,
  ): ParentNotification | undefined {
    if (task.child_exec_enabled !== 1 || task.board_id === this.boardId) return undefined;
    const groupJid = this.getBoardGroupJid(task.board_id);
    if (!groupJid) return undefined;
    return { parent_group_jid: groupJid, message };
  }

  private deduplicateNotificationsForParent(
    notifications: NotificationEntry[],
    parentGroupJid: string,
  ): void {
    const deduped = notifications.filter(
      (n) => n.notification_group_jid !== parentGroupJid,
    );
    notifications.length = 0;
    notifications.push(...deduped);
  }

  private meetingNotificationRecipients(task: any): Omit<NotificationEntry, 'message'>[] {
    const participantIds: string[] = (() => {
      try {
        return JSON.parse(task.participants ?? '[]');
      } catch {
        return [];
      }
    })();
    const allRecipients = [...new Set(
      task.assignee && !participantIds.includes(task.assignee)
        ? [...participantIds, task.assignee]
        : [...participantIds],
    )];
    const results: Omit<NotificationEntry, 'message'>[] = [];
    if (allRecipients.length > 0) {
      const placeholders = allRecipients.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT person_id, notification_group_jid FROM board_people WHERE board_id = ? AND person_id IN (${placeholders})`,
      ).all(this.boardId, ...allRecipients) as Array<{ person_id: string; notification_group_jid: string | null }>;
      const jidMap = new Map(rows.map((r) => [r.person_id, r.notification_group_jid ?? null]));
      for (const personId of allRecipients) {
        results.push({
          target_kind: 'group',
          target_person_id: personId,
          notification_group_jid: jidMap.get(personId) ?? null,
        });
      }
    }
    // External participants with accepted grants (exclude past-expiry even if not yet lazily updated)
    const recipientNow = new Date().toISOString();
    const externals = this.db.prepare(
      `SELECT ec.external_id, ec.display_name, ec.direct_chat_jid, ec.phone
       FROM meeting_external_participants mep
       JOIN external_contacts ec ON ec.external_id = mep.external_id
       WHERE mep.board_id = ? AND mep.meeting_task_id = ?
         AND mep.invite_status = 'accepted'
         AND (mep.access_expires_at IS NULL OR mep.access_expires_at >= ?)
       GROUP BY ec.external_id`,
    ).all(this.boardId, task.id, recipientNow) as Array<{
      external_id: string; display_name: string; direct_chat_jid: string | null; phone: string;
    }>;
    for (const ext of externals) {
      results.push({
        target_kind: 'dm',
        target_external_id: ext.external_id,
        target_chat_jid: ext.direct_chat_jid ?? `${ext.phone}@s.whatsapp.net`,
      });
    }
    return results;
  }

  /** Scheduled meeting reminders keyed to scheduled_at. */
  getMeetingReminderNotifications(nowIso = new Date().toISOString()): Array<NotificationEntry & {
    task_id: string;
    reminder_days: number;
  }> {
    const tz = this.boardTz;
    const todayStr = nowIso.slice(0, 10);
    const meetings = this.db
      .prepare(
        `SELECT id, board_id, title, scheduled_at, participants, assignee, reminders FROM tasks
         WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
           AND scheduled_at IS NOT NULL AND reminders != '[]'`,
      )
      .all(...this.visibleTaskParams()) as Array<{
      id: string;
      board_id: string;
      title: string;
      scheduled_at: string;
      participants: string | null;
      assignee: string | null;
      reminders: string | null;
    }>;
    const notifications: Array<NotificationEntry & {
      task_id: string;
      reminder_days: number;
    }> = [];
    for (const meeting of meetings) {
      let reminders: Array<{ days: number; date: string }> = [];
      try {
        reminders = JSON.parse(meeting.reminders ?? '[]');
      } catch {
        continue;
      }
      let hasFired = false;
      for (const reminder of reminders) {
        if (reminder.date !== todayStr) continue;
        hasFired = true;
        for (const recipient of this.meetingNotificationRecipients(meeting)) {
          notifications.push({
            task_id: meeting.id,
            reminder_days: reminder.days,
            ...recipient,
            message: `📅 *Lembrete de reunião*\n\n*${meeting.id}* — ${meeting.title}\n*Quando:* ${utcToLocal(meeting.scheduled_at, tz)}\n*Faltam:* ${reminder.days} dia(s)`,
          });
        }
      }
      // Remove fired reminders so they don't re-fire on retry/re-run
      if (hasFired) {
        const remaining = reminders.filter((r) => r.date !== todayStr);
        this.db
          .prepare(`UPDATE tasks SET reminders = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(remaining), meeting.board_id, meeting.id);
      }
    }
    return notifications;
  }

  /** Exact-time meeting-start notifications keyed to scheduled_at. */
  getMeetingStartingNotifications(
    nowIso = new Date().toISOString(),
    windowMinutes = 5,
  ): Array<NotificationEntry & { task_id: string }> {
    const tz = this.boardTz;
    const nowMs = new Date(nowIso).getTime();
    const windowMs = windowMinutes * 60_000;
    const meetings = this.db
      .prepare(
        `SELECT id, title, scheduled_at, participants, assignee FROM tasks
         WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
           AND scheduled_at IS NOT NULL`,
      )
      .all(...this.visibleTaskParams()) as Array<{
      id: string;
      title: string;
      scheduled_at: string;
      participants: string | null;
      assignee: string | null;
    }>;
    const notifications: Array<NotificationEntry & { task_id: string }> = [];
    for (const meeting of meetings) {
      const scheduledMs = new Date(meeting.scheduled_at).getTime();
      if (Number.isNaN(scheduledMs)) continue;
      const delta = scheduledMs - nowMs;
      if (delta < 0 || delta > windowMs) continue;
      for (const recipient of this.meetingNotificationRecipients(meeting)) {
        notifications.push({
          task_id: meeting.id,
          ...recipient,
          message: `📅 *Reunião começando*\n\n*${meeting.id}* — ${meeting.title}\n*Agora:* ${utcToLocal(meeting.scheduled_at, tz)}`,
        });
      }
    }
    return notifications;
  }

  /** Determine meeting note phase based on the task's current column. */
  private getMeetingNotePhase(task: any): 'pre' | 'meeting' | 'post' | undefined {
    if (task.type !== 'meeting') return undefined;
    switch (task.column) {
      case 'inbox':
      case 'next_action': return 'pre';
      case 'in_progress':
      case 'waiting': return 'meeting';
      case 'review':
      case 'done': return 'post';
      default: return undefined;
    }
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
    const senderPersonId = this.resolvePerson(opts.senderName)?.person_id ?? null;
    const requiresCloseApproval = this.defaultRequiresCloseApproval(opts.assignee, senderPersonId);
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, board_id, type, title, assignee, column, requires_close_approval,
          parent_task_id, priority, labels,
          child_exec_enabled, child_exec_board_id, child_exec_person_id,
          _last_mutation, created_at, updated_at
        ) VALUES (?, ?, 'simple', ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(opts.subtaskId, boardId, opts.title, opts.assignee, opts.column, requiresCloseApproval,
        opts.parentTaskId, opts.priority,
        childLink.child_exec_enabled, childLink.child_exec_board_id, childLink.child_exec_person_id,
        subMutation, opts.now, opts.now);
    this.recordHistory(opts.subtaskId, 'created', opts.senderName,
      JSON.stringify({ type: 'subtask', parent: opts.parentTaskId, title: opts.title, assignee: opts.assignee, requires_close_approval: requiresCloseApproval === 1 }),
      boardId);
  }

  /** Build a notification for subtask assignment. */
  private buildSubtaskAssignNotification(
    subtask: { id: string; title: string; board_id?: string },
    project: { id: string; title: string; board_id?: string },
    assigneePersonId: string,
    modifierPersonId: string,
    boardId = this.boardId,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    const target = this.resolveNotifTarget(assigneePersonId, modifierPersonId, undefined, boardId);
    if (!target) return null;
    const viewerBoard = this.resolveViewerBoard(target.target_person_id, subtask.board_id ?? boardId);
    const modName = this.personDisplayName(modifierPersonId);
    return {
      ...target,
      message: `🔔 *Etapa atribuída para você*\n*${this.displayId(subtask, viewerBoard)}* — ${subtask.title}\n*Projeto:* ${this.displayId(project, viewerBoard)} — ${project.title}\n*Por:* ${modName}`,
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
    let result: CreateResult;
    try {
      result = this.db.transaction(() => this.createTaskInternal(params))();
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
    // Post-commit verification: confirm the row actually persisted
    if (result.success && result.task_id) {
      const verify = this.db
        .prepare('SELECT id FROM tasks WHERE id = ? AND board_id = ?')
        .get(result.task_id, this.boardId) as { id: string } | undefined;
      if (!verify) {
        return { success: false, error: `Task ${result.task_id} was not persisted after commit.` };
      }
    }
    return result;
  }

  private createTaskInternal(params: CreateParams): CreateResult {
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
            : params.type === 'meeting'
              ? 'M'
              : 'T';
      const taskId = this.allocateTaskId(prefix);

      /* --- Auto-assign to sender when no explicit assignee --- */
      if (!assigneePersonId) {
        const senderPerson = this.resolvePerson(params.sender_name);
        if (senderPerson) assigneePersonId = senderPerson.person_id;
      }

      /* --- Column placement --- */
      const column = params.type === 'inbox' ? 'inbox' : 'next_action';

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

      /* --- Participant resolution (meetings only) --- */
      let participantIds: string[] | null = null;
      if (params.type === 'meeting' && params.participants) {
        participantIds = [];
        for (const pName of params.participants) {
          const person = this.resolvePerson(pName);
          if (!person) return this.buildOfferRegisterError(pName);
          participantIds.push(person.person_id);
        }
      }

      /* --- Normalize scheduled_at from local time to UTC --- */
      if (params.scheduled_at) {
        const tz = this.boardTz;
        params = { ...params, scheduled_at: localToUtc(params.scheduled_at, tz) };
      }

      /* --- Recurring meeting validation --- */
      if (params.type === 'meeting' && params.recurrence && !params.scheduled_at) {
        return { success: false, error: 'Recurring meetings require scheduled_at for the first occurrence.' };
      }

      /* --- Default recurrence_anchor for meetings --- */
      if (params.type === 'meeting' && params.recurrence && params.scheduled_at && !params.recurrence_anchor) {
        params = { ...params, recurrence_anchor: params.scheduled_at };
      }

      /* --- Meetings never use due_date (reminders/overdue key off scheduled_at) --- */
      if (params.type === 'meeting' && params.due_date) {
        return { success: false, error: 'Meetings use scheduled_at, not due_date. Remove due_date or change the task type.' };
      }

      /* --- Recurrence --- */
      let recurrence: string | null = null;
      let dueDate: string | null = params.due_date ?? null;
      if ((params.type === 'recurring' || params.type === 'project' || params.type === 'meeting') && params.recurrence) {
        recurrence = params.recurrence;
        if (params.type !== 'meeting' && !dueDate) {
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

      const senderPerson = this.resolvePerson(params.sender_name);
      const senderPersonId = senderPerson?.person_id ?? params.sender_name;
      const requiresCloseApproval =
        params.requires_close_approval !== undefined
          ? (params.requires_close_approval ? 1 : 0)
          : this.defaultRequiresCloseApproval(assigneePersonId, senderPerson?.person_id ?? null);

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
            priority, requires_close_approval, due_date, labels, recurrence, recurrence_anchor,
            max_cycles, recurrence_end_date,
            child_exec_enabled, child_exec_board_id, child_exec_person_id,
            participants, scheduled_at,
            _last_mutation, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          this.boardId,
          storedType,
          params.title,
          assigneePersonId,
          column,
          params.priority ?? null,
          requiresCloseApproval,
          dueDate,
          params.labels ? JSON.stringify(params.labels) : '[]',
          recurrence,
          params.recurrence_anchor ?? null,
          params.max_cycles ?? null,
          params.recurrence_end_date ?? null,
          childExecEnabled,
          childExecBoardId,
          childExecPersonId,
          participantIds ? JSON.stringify(participantIds) : null,
          params.scheduled_at ?? null,
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
      detailsSummary.requires_close_approval = requiresCloseApproval === 1;
      if (params.priority) detailsSummary.priority = params.priority;
      if (dueDate) detailsSummary.due_date = dueDate;
      if (params.labels?.length) detailsSummary.labels = params.labels;
      if (subtaskDefs.length > 0) detailsSummary.subtasks_count = subtaskDefs.length;
      if (recurrence) detailsSummary.recurrence = recurrence;
      if (participantIds) detailsSummary.participants = participantIds;
      if (params.scheduled_at) detailsSummary.scheduled_at = params.scheduled_at;

      this.recordHistory(taskId, 'created', params.sender_name, JSON.stringify(detailsSummary));

      /* --- Notifications --- */
      const notifications: CreateResult['notifications'] = [];

      // Notify project assignee
      if (assigneePersonId) {
        const notif = this.buildCreateNotification(
          { id: taskId, title: params.title, assignee: assigneePersonId, due_date: dueDate, priority: params.priority, column, type: params.type, board_id: this.boardId },
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

      /* Notify participants (meetings) */
      if (participantIds && participantIds.length > 0) {
        for (const pid of participantIds) {
          if (pid === senderPersonId) continue;
          if (pid === assigneePersonId) continue;
          const notif = this.buildCreateNotification(
            { id: taskId, title: params.title, assignee: pid, due_date: dueDate, priority: params.priority, column, type: params.type, board_id: this.boardId },
            senderPersonId,
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
         WHERE ${this.visibleTaskScope()} AND assignee = ? AND column = 'in_progress' AND type != 'meeting'`,
      )
      .get(...this.visibleTaskParams(), personId) as { cnt: number };

    const current = countRow.cnt;
    if (wipLimit === null) {
      return { ok: true, current, limit: 0, person_name: personName };
    }
    return { ok: current < wipLimit, current, limit: wipLimit, person_name: personName };
  }

  /** Check if sender has manager or delegate role in board_admins. */
  private isManagerOrDelegate(senderName: string, boardId = this.boardId): boolean {
    const person = this.resolvePerson(senderName, boardId);
    if (!person) return false;
    const row = this.db
      .prepare(
        `SELECT 1 FROM board_admins
         WHERE board_id = ? AND person_id = ? AND admin_role IN ('manager', 'delegate')`,
      )
      .get(boardId, person.person_id);
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

    // Revoke active external participant grants for meeting tasks
    if (task.type === 'meeting') {
      this.db
        .prepare(
          `UPDATE meeting_external_participants
           SET invite_status = 'revoked', revoked_at = ?, updated_at = ?
           WHERE board_id = ? AND meeting_task_id = ?
             AND invite_status IN ('pending', 'invited', 'accepted')`,
        )
        .run(now, now, this.boardId, task.id);
    }

    if (task.type === 'project') {
      this.db
        .prepare(`DELETE FROM tasks WHERE board_id = ? AND parent_task_id = ?`)
        .run(taskBoardId, task.id);
    }
    this.db
      .prepare(`DELETE FROM tasks WHERE board_id = ? AND id = ?`)
      .run(taskBoardId, task.id);
  }

  /** Advance a recurring task: calculate next schedule and increment cycle. */
  private advanceRecurringTask(task: any): { cycle_number: number; expired: boolean; new_due_date?: string; new_scheduled_at?: string; reason?: 'max_cycles' | 'end_date' } {
    const recurrence = task.recurrence as 'daily' | 'weekly' | 'monthly' | 'yearly';
    const currentCycle = parseInt(task.current_cycle ?? '0', 10);
    const nextCycle = currentCycle + 1;
    const isMeeting = task.type === 'meeting';

    let newDueDate: string | undefined;
    let newScheduledAt: string | undefined;
    if (isMeeting) {
      const recurrenceBase =
        task.recurrence_anchor ??
        task.scheduled_at ??
        new Date().toISOString();
      newScheduledAt = advanceDateTimeByRecurrence(recurrenceBase, recurrence, nextCycle);
    } else {
      const anchor = task.due_date ? new Date(task.due_date) : new Date();
      newDueDate = advanceDateByRecurrence(anchor, recurrence);
      // Auto-shift recurring due dates off weekends/holidays (no user confirmation)
      newDueDate = this.shiftToBusinessDay(newDueDate);
    }

    // Check expiry bounds (mutually exclusive, but check both defensively)
    let expiryReason: 'max_cycles' | 'end_date' | null = null;
    if (task.max_cycles != null && nextCycle >= task.max_cycles) {
      expiryReason = 'max_cycles';
    } else if (task.recurrence_end_date && (isMeeting ? (newScheduledAt ?? '').slice(0, 10) : (newDueDate ?? '')) > task.recurrence_end_date) {
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

    // Archive meeting occurrence before cycle reset (selective fields only)
    if (task.type === 'meeting') {
      this.recordHistory(
        task.id,
        'meeting_occurrence_archived',
        'system',
        JSON.stringify({
          cycle_number: currentCycle,
          occurrence_scheduled_at: task.scheduled_at,
          snapshot: {
            id: task.id,
            title: task.title,
            scheduled_at: task.scheduled_at,
            participants: task.participants,
            recurrence_anchor: task.recurrence_anchor ?? null,
            notes: task.notes,
            assignee: task.assignee,
            current_cycle: currentCycle,
          },
        }),
        this.taskBoardId(task),
      );
    }

    // Normal advance: reset to next_action
    if (isMeeting) {
      this.db
        .prepare(
          `UPDATE tasks SET column = 'next_action', current_cycle = ?, reminders = '[]',
           notes = '[]', next_note_id = 1, blocked_by = '[]', next_action = NULL, waiting_for = NULL,
           scheduled_at = ?, updated_at = ?
           WHERE board_id = ? AND id = ?`,
        )
        .run(String(nextCycle), newScheduledAt ?? task.scheduled_at ?? null, now, this.taskBoardId(task), task.id);
      // Expire old-occurrence external participant grants so they don't bleed into the new cycle
      if (task.scheduled_at) {
        this.db
          .prepare(
            `UPDATE meeting_external_participants
             SET invite_status = 'expired', updated_at = ?
             WHERE board_id = ? AND meeting_task_id = ?
               AND occurrence_scheduled_at = ?
               AND invite_status IN ('pending', 'invited', 'accepted')`,
          )
          .run(now, this.taskBoardId(task), task.id, task.scheduled_at);
      }
    } else {
      this.db
        .prepare(
          `UPDATE tasks SET column = 'next_action', due_date = ?, current_cycle = ?, reminders = '[]',
           notes = '[]', next_note_id = 1, blocked_by = '[]', next_action = NULL, waiting_for = NULL, updated_at = ?
           WHERE board_id = ? AND id = ?`,
        )
        .run(newDueDate, String(nextCycle), now, this.taskBoardId(task), task.id);
    }

    /* Reset subtask rows for recurring projects */
    if (task.type === 'project') {
      this.db
        .prepare(
          `UPDATE tasks SET column = 'next_action', updated_at = ?
           WHERE board_id = ? AND parent_task_id = ? AND column = 'done'`,
        )
        .run(now, this.taskBoardId(task), task.id);
    }

    return isMeeting
      ? { cycle_number: nextCycle, expired: false, new_scheduled_at: newScheduledAt }
      : { cycle_number: nextCycle, expired: false, new_due_date: newDueDate };
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
        start:       { from: ['inbox', 'next_action'], to: 'in_progress' },
        force_start: { from: ['inbox', 'next_action'], to: 'in_progress' },
        wait:        { from: ['inbox', 'next_action', 'in_progress'], to: 'waiting' },
        resume:      { from: ['waiting'], to: 'in_progress' },
        return:      { from: ['in_progress', 'waiting', 'review'], to: 'next_action' },
        review:      { from: ['inbox', 'next_action', 'in_progress', 'waiting'], to: 'review' },
        approve:     { from: ['review'], to: 'done' },
        reject:      { from: ['review'], to: 'in_progress' },
        conclude:    { from: ['inbox', 'next_action', 'in_progress', 'waiting', 'review'], to: 'done' },
        reopen:      { from: ['done'], to: 'next_action' },
      };

      const baseTransition = transitions[params.action];
      if (!baseTransition) {
        return { success: false, error: `Unknown action: ${params.action}` };
      }

      /* --- Permission checks --- */
      const isAssignee = senderPersonId != null && task.assignee === senderPersonId;
      const isMgr = this.isManager(params.sender_name);
      const isMgrOrDelegate = this.isManagerOrDelegate(params.sender_name);
      const assigneeNeedsCloseApproval =
        params.action === 'conclude' &&
        isAssignee &&
        this.taskRequiresCloseApproval(task);

      // Allow any board member to start an unassigned inbox task (auto-assign)
      const canClaimUnassigned = params.action === 'start' && fromColumn === 'inbox' && !task.assignee && senderPersonId;

      switch (params.action) {
        case 'start':
        case 'wait':
        case 'resume':
        case 'return':
        case 'review':
          if (!isAssignee && !isMgr && !canClaimUnassigned) {
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

      let approvalGateApplied = false;
      let effectiveAction = params.action;
      let transition = baseTransition;
      if (assigneeNeedsCloseApproval) {
        if (fromColumn === 'review') {
          return {
            success: false,
            error: `Task ${params.task_id} already awaits approval in "review". A manager or delegate must approve it.`,
          };
        }
        approvalGateApplied = true;
        effectiveAction = 'review';
        transition = {
          from: ['inbox', 'next_action', 'in_progress', 'waiting'],
          to: 'review',
        };
      }

      /* --- Auto-assign inbox tasks when sender starts them --- */
      const autoAssigned = canClaimUnassigned && fromColumn === 'inbox' && !approvalGateApplied;

      /* --- Validate from column --- */
      if (!transition.from.includes(fromColumn)) {
        return {
          success: false,
          error: `Cannot "${params.action}" task ${params.task_id}: task is in "${fromColumn}", expected one of [${transition.from.join(', ')}].`,
        };
      }

      const toColumn = transition.to;

      /* --- Project conclude guard: all subtask rows must be done --- */
      if ((toColumn === 'done' || approvalGateApplied) && task.type === 'project') {
        const pendingSubs = this.db
          .prepare(
            `SELECT id, title, column FROM tasks
             WHERE board_id = ? AND parent_task_id = ? AND column != 'done'
             ORDER BY id`,
          )
          .all(taskBoardId, task.id) as Array<{ id: string; title: string; column: string }>;
        if (pendingSubs.length > 0) {
          const list = pendingSubs.map((s) => `${s.id} (${s.column})`).join(', ');
          return {
            success: false,
            error: `Cannot conclude project ${task.id}: ${pendingSubs.length} subtask(s) not done: ${list}`,
          };
        }
      }

      /* --- WIP limit check (start, resume, reject — NOT force_start, NOT meetings) --- */
      const wipPersonId = autoAssigned ? senderPersonId : task.assignee;
      if (['start', 'resume', 'reject'].includes(effectiveAction) && wipPersonId && task.type !== 'meeting') {
        const wip = this.checkWipLimit(wipPersonId);
        if (!wip.ok) {
          return {
            success: false,
            error: `WIP limit exceeded for ${wip.person_name}: ${wip.current} in progress (limit: ${wip.limit}).`,
            wip_warning: { person: wip.person_name, current: wip.current, limit: wip.limit },
          };
        }
      }

      /* --- Snapshot before mutation --- */
      const snapshotFields: Record<string, any> = {
        column: fromColumn,
        assignee: task.assignee,
        due_date: task.due_date,
        updated_at: task.updated_at,
      };
      /* Capture waiting_for so undo of wait/resume restores it correctly. */
      if (effectiveAction === 'wait' || fromColumn === 'waiting') {
        snapshotFields.waiting_for = task.waiting_for ?? null;
      }
      /* Recurring conclude/approve mutates many fields via advanceRecurringTask;
         capture them so undo can fully revert the cycle advance. */
      if (toColumn === 'done' && task.recurrence) {
        snapshotFields.scheduled_at = task.scheduled_at ?? null;
        snapshotFields.notes = task.notes ?? '[]';
        snapshotFields.next_note_id = task.next_note_id ?? 1;
        snapshotFields.current_cycle = task.current_cycle ?? null;
        snapshotFields.reminders = task.reminders ?? '[]';
        snapshotFields.blocked_by = task.blocked_by ?? '[]';
        snapshotFields.next_action = task.next_action ?? null;
        snapshotFields.waiting_for = task.waiting_for ?? null;
      }
      const snapshot = JSON.stringify({
        action: params.action,
        effective_action: effectiveAction,
        by: params.sender_name,
        at: now,
        snapshot: snapshotFields,
      });

      /* Apply deferred auto-assignment (after snapshot captures original null assignee) */
      if (autoAssigned) {
        task.assignee = senderPersonId;
        // Link child board for new assignee (mirrors reassign logic)
        if (task.type !== 'recurring') {
          const childLink = this.linkedChildBoardFor(taskBoardId, senderPersonId);
          task.child_exec_enabled = childLink.child_exec_enabled;
          task.child_exec_board_id = childLink.child_exec_board_id;
          task.child_exec_person_id = childLink.child_exec_person_id;
        }
      }

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
      if (approvalGateApplied) detailsObj.requested_action = params.action;
      if (params.reason) detailsObj.reason = params.reason;
      if (params.subtask_id) detailsObj.subtask_id = params.subtask_id;

      this.db
        .prepare(
          autoAssigned
            ? `UPDATE tasks SET column = ?, _last_mutation = ?, updated_at = ?, assignee = ?,
               child_exec_enabled = ?, child_exec_board_id = ?, child_exec_person_id = ?
               WHERE board_id = ? AND id = ?`
            : `UPDATE tasks SET column = ?, _last_mutation = ?, updated_at = ?, assignee = ?
               WHERE board_id = ? AND id = ?`,
        )
        .run(...(autoAssigned
          ? [toColumn, snapshot, now, task.assignee,
             task.child_exec_enabled, task.child_exec_board_id, task.child_exec_person_id,
             taskBoardId, task.id]
          : [toColumn, snapshot, now, task.assignee, taskBoardId, task.id]));

      /* --- If waiting, store reason in waiting_for --- */
      if (effectiveAction === 'wait' && params.reason) {
        this.db
          .prepare(
            `UPDATE tasks SET waiting_for = ? WHERE board_id = ? AND id = ?`,
          )
          .run(params.reason, taskBoardId, task.id);
      }

      /* --- Clear waiting_for when leaving waiting column --- */
      if (fromColumn === 'waiting') {
        this.db
          .prepare(
            `UPDATE tasks SET waiting_for = NULL WHERE board_id = ? AND id = ?`,
          )
          .run(taskBoardId, task.id);
      }

      /* --- Record history --- */
      this.recordHistory(
        task.id,
        effectiveAction,
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
      // Skip generic move notification for linked-task rejections — the explicit
      // rejection block below sends a more informative message to the same child-board JID.
      const skipGenericMoveNotif =
        effectiveAction === 'reject' && task.child_exec_enabled === 1 && !!task.child_exec_person_id;
      if (senderPersonId && !skipGenericMoveNotif) {
        const notif = this.buildMoveNotification(
          task,
          effectiveAction,
          senderPersonId,
          taskBoardId,
        );
        if (notif) notifications.push(notif);
      }

      /* --- Linked task review rejection (reset rollup + notify child board) --- */
      if (effectiveAction === 'reject' && task.child_exec_enabled === 1) {
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
              message: `🔔 *Atualização na sua tarefa*\n\n*${task.id}* — ${task.title}\n*Por:* ${senderDisplayName}\n\n• ↩️ Rejeitada — ajustes necessários antes de nova aprovação\n\nDigite \`${task.id}\` para ver detalhes.`,
            });
          }
        }
      }

      /* --- Parent board notification (linked task status change) --- */
      const emoji = toColumn === 'done' ? '✅' : toColumn === 'review' ? '📋' : '🔄';
      const statusText = TaskflowEngine.columnLabel(toColumn);
      const parentNotification = this.buildParentNotification(
        task,
        `🔔 *Atualização na tarefa*\n\n*${task.id}* — ${task.title}\n*Por:* ${senderDisplayName}\n\n• ${emoji} ${statusText}`,
      );

      /* Auto-trigger rollup on linked parent task */
      this.refreshLinkedParentRollup(task, taskBoardId, params.sender_name ?? 'system');

      if (parentNotification) {
        this.deduplicateNotificationsForParent(notifications, parentNotification.parent_group_jid);
      }

      /* --- Open meeting minutes warning --- */
      // Skip the warning for recurring meetings that were advanced (not expired):
      // advanceRecurringTask already cleared the notes from the task, so
      // process_minutes / process_minutes_decision would find nothing to triage.
      // The notes are preserved in meeting_occurrence_archived history.
      let unprocessedMinutesWarning: boolean | undefined;
      const recurringAdvanced = recurringCycle && !recurringCycle.expired;
      if (toColumn === 'done' && task.type === 'meeting' && !recurringAdvanced) {
        const notes: Array<any> = JSON.parse(task.notes ?? '[]');
        const hasOpenNotes = notes.some((n: any) => n.status === 'open');
        if (hasOpenNotes) unprocessedMinutesWarning = true;
      }

      /* --- Build result --- */
      const result: MoveResult = {
        success: true,
        task_id: task.id,
        title: task.title,
        from_column: fromColumn,
        to_column: toColumn,
      };
      if (approvalGateApplied) result.approval_gate_applied = true;
      if (notifications.length > 0) result.notifications = notifications;
      if (projectUpdate) result.project_update = projectUpdate;
      if (recurringCycle) result.recurring_cycle = recurringCycle;
      if (parentNotification) result.parent_notification = parentNotification;
      if (unprocessedMinutesWarning) result.unprocessed_minutes_warning = true;

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

        /* --- Same-person check (mirrors the bulk-transfer guard) --- */
        if (task.assignee === targetPerson.person_id) {
          return { success: false, error: `Task ${params.task_id} is already assigned to ${targetPerson.name}.` };
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
      /* For delegated tasks (single-task path where task.board_id != this.boardId),
         look up registrations on the task's owning board, not the current board.
         child_board_registrations are keyed by parent_board_id, so using the
         child board's ID would miss the registration and silently unlink. */
      const regBoardId = params.task_id && tasksToReassign.length === 1
        ? (tasksToReassign[0].board_id ?? this.boardId)
        : this.boardId;
      const targetChildReg = this.getChildBoardRegistration(targetPerson.person_id, regBoardId);

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

      /* --- WIP limit check for target person --- */
      const inProgressCount = tasksToReassign.filter(
        (t) => t.column === 'in_progress' && t.type !== 'meeting',
      ).length;
      if (inProgressCount > 0) {
        const wip = this.checkWipLimit(targetPerson.person_id);
        if (!wip.ok || (wip.limit > 0 && wip.current + inProgressCount > wip.limit)) {
          const projected = wip.current + inProgressCount;
          return {
            success: false,
            error: `WIP limit exceeded for ${wip.person_name}: reassignment would bring them to ${projected} in progress (limit: ${wip.limit}).`,
            wip_warning: { person: wip.person_name, current: wip.current, limit: wip.limit },
          } as ReassignResult;
        }
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

        /* --- Clear stale rollup data when child board changes or delegation removed --- */
        const childBoardChanged = (task.child_exec_board_id ?? null) !== newChildExecBoardId;
        const clearRollupFields = task.child_exec_rollup_status && (newChildExecEnabled === 0 || childBoardChanged);

        /* --- Auto-move inbox→next_action when assigning --- */
        const newColumn = task.column === 'inbox' ? 'next_action' : task.column;

        /* --- Update task --- */
        this.db
          .prepare(
            `UPDATE tasks SET assignee = ?, column = ?, child_exec_enabled = ?, child_exec_board_id = ?,
             child_exec_person_id = ?,
             child_exec_rollup_status = CASE WHEN ? THEN NULL ELSE child_exec_rollup_status END,
             child_exec_last_rollup_at = CASE WHEN ? THEN NULL ELSE child_exec_last_rollup_at END,
             child_exec_last_rollup_summary = CASE WHEN ? THEN NULL ELSE child_exec_last_rollup_summary END,
             _last_mutation = ?, updated_at = ?
             WHERE board_id = ? AND id = ?`,
          )
          .run(
            targetPerson.person_id,
            newColumn,
            newChildExecEnabled,
            newChildExecBoardId,
            newChildExecPersonId,
            clearRollupFields ? 1 : 0,
            clearRollupFields ? 1 : 0,
            clearRollupFields ? 1 : 0,
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
      const tz = getBoardTimezone(this.db, taskBoardId);

      /* --- Normalize scheduled_at from local time to UTC --- */
      if (updates.scheduled_at !== undefined) {
        updates.scheduled_at = localToUtc(updates.scheduled_at, tz);
      }

      /* --- Check task is active (not archived / done is still active in tasks table) --- */
      // Tasks only leave the tasks table when archived; if it's here, it's active.

      /* --- External sender resolution --- */
      const isExternalSender = !!params.sender_external_id;
      let hasExternalGrant = false;
      if (isExternalSender) {
        const grantNow = new Date().toISOString();
        // Expire only stale grants (past access_expires_at), leaving valid ones untouched.
        // This prevents a non-deterministic SELECT from picking an old occurrence's row
        // and the broad UPDATE from incorrectly expiring newer valid grants.
        this.db.prepare(
          `UPDATE meeting_external_participants SET invite_status = 'expired', updated_at = ?
           WHERE board_id = ? AND meeting_task_id = ? AND external_id = ?
             AND invite_status = 'accepted'
             AND access_expires_at IS NOT NULL AND access_expires_at < ?`
        ).run(grantNow, this.boardId, task.id, params.sender_external_id, grantNow);
        const grant = this.db.prepare(
          `SELECT invite_status FROM meeting_external_participants
           WHERE board_id = ? AND meeting_task_id = ? AND external_id = ?
             AND invite_status = 'accepted'
           ORDER BY occurrence_scheduled_at DESC LIMIT 1`
        ).get(this.boardId, task.id, params.sender_external_id) as any;
        if (grant) {
          hasExternalGrant = true;
        }
      }

      /* --- Block non-note operations for external senders --- */
      if (isExternalSender) {
        const allowedOps = ['add_note', 'edit_note', 'remove_note', 'set_note_status', 'parent_note_id'];
        const attemptedOps = Object.keys(updates).filter(k => (updates as any)[k] !== undefined);
        const disallowed = attemptedOps.filter(op => !allowedOps.includes(op));
        if (disallowed.length > 0) {
          return { success: false, error: `Permission denied: external participants can only interact with meeting notes.` };
        }
      }

      /* --- Permission: sender must be assignee or manager (or meeting participant for note ops) --- */
      const isAssignee = senderPersonId != null && task.assignee === senderPersonId;
      const isMgr = this.isManager(params.sender_name);
      const isOwnerMgr = this.isManager(params.sender_name, taskBoardId);

      const isMeetingNoteOperation =
        task.type === 'meeting' &&
        (updates.add_note !== undefined ||
          updates.edit_note !== undefined ||
          updates.remove_note !== undefined ||
          updates.set_note_status !== undefined);

      // Meeting note operations bypass the main gate, but only for note-specific fields.
      // If the request also includes privileged fields (title, priority, due_date, etc.),
      // the main assignee/manager gate must still apply to prevent participants from
      // modifying fields they shouldn't have access to.
      const hasPrivilegedUpdate =
        updates.title !== undefined ||
        updates.priority !== undefined ||
        updates.requires_close_approval !== undefined ||
        updates.due_date !== undefined ||
        updates.description !== undefined ||
        updates.next_action !== undefined ||
        updates.add_label !== undefined ||
        updates.remove_label !== undefined ||
        updates.scheduled_at !== undefined ||
        updates.add_participant !== undefined ||
        updates.remove_participant !== undefined ||
        updates.add_external_participant !== undefined ||
        updates.remove_external_participant !== undefined ||
        updates.reinvite_external_participant !== undefined ||
        updates.add_subtask !== undefined ||
        updates.rename_subtask !== undefined ||
        updates.reopen_subtask !== undefined ||
        updates.assign_subtask !== undefined ||
        updates.unassign_subtask !== undefined ||
        updates.recurrence !== undefined ||
        updates.max_cycles !== undefined ||
        updates.recurrence_end_date !== undefined;

      if ((!isMeetingNoteOperation || hasPrivilegedUpdate) && !isMgr && !isAssignee) {
        return {
          success: false,
          error: `Permission denied: "${params.sender_name}" is neither the assignee nor a manager.`,
        };
      }

      if (updates.requires_close_approval !== undefined && !isOwnerMgr) {
        return {
          success: false,
          error: 'Permission denied: only managers of the owning board can change whether close approval is required.',
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
          requires_close_approval: task.requires_close_approval,
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
          participants: task.participants,
          scheduled_at: task.scheduled_at,
          reminders: task.reminders,
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
        changes.push(`Título alterado para "${updates.title}"`);
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
        changes.push(`Prioridade: ${updates.priority}`);
      }

      /* Close approval policy */
      if (updates.requires_close_approval !== undefined) {
        const requiresCloseApproval = updates.requires_close_approval ? 1 : 0;
        this.db
          .prepare(`UPDATE tasks SET requires_close_approval = ? WHERE board_id = ? AND id = ?`)
          .run(requiresCloseApproval, taskBoardId, task.id);
        changes.push(
          requiresCloseApproval === 1
            ? 'Aprovação para concluir ativada'
            : 'Aprovação para concluir desativada',
        );
      }

      /* Due date */
      if (updates.due_date !== undefined) {
        /* Meeting reminders are keyed to scheduled_at, not due_date.
           Only touch reminders when the task is NOT a meeting. */
        const isMeetingTask = task.type === 'meeting';
        if (updates.due_date === null) {
          if (isMeetingTask) {
            this.db
              .prepare(`UPDATE tasks SET due_date = NULL WHERE board_id = ? AND id = ?`)
              .run(taskBoardId, task.id);
          } else {
            this.db
              .prepare(`UPDATE tasks SET due_date = NULL, reminders = '[]' WHERE board_id = ? AND id = ?`)
              .run(taskBoardId, task.id);
            const oldReminders: any[] = JSON.parse(task.reminders ?? '[]');
            if (oldReminders.length > 0) changes.push('Lembretes removidos (sem prazo)');
          }
          changes.push('Prazo removido');
        } else {
          /* Non-business-day check */
          const warning = this.checkNonBusinessDay(updates.due_date, !!updates.allow_non_business_day);
          if (warning) return warning;
          /* Recalculate reminder dates for the new due_date (non-meeting only) */
          const reminders: Array<{ days: number; date: string }> = JSON.parse(task.reminders ?? '[]');
          if (!isMeetingTask && reminders.length > 0) {
            for (const r of reminders) {
              r.date = reminderDateFromDue(updates.due_date, r.days);
            }
            this.db
              .prepare(`UPDATE tasks SET due_date = ?, reminders = ? WHERE board_id = ? AND id = ?`)
              .run(updates.due_date, JSON.stringify(reminders), taskBoardId, task.id);
            changes.push(`Prazo definido: ${updates.due_date}`);
            changes.push('Lembretes recalculados para novo prazo');
          } else {
            this.db
              .prepare(`UPDATE tasks SET due_date = ? WHERE board_id = ? AND id = ?`)
              .run(updates.due_date, taskBoardId, task.id);
            changes.push(`Prazo definido: ${updates.due_date}`);
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
        changes.push('Descrição atualizada');
      }

      /* Next action */
      if (updates.next_action !== undefined) {
        this.db
          .prepare(`UPDATE tasks SET next_action = ? WHERE board_id = ? AND id = ?`)
          .run(updates.next_action, taskBoardId, task.id);
        changes.push(`Próxima ação: "${updates.next_action}"`);
      }

      /* Add label */
      if (updates.add_label !== undefined) {
        const labels: string[] = JSON.parse(task.labels ?? '[]');
        if (!labels.includes(updates.add_label)) {
          labels.push(updates.add_label);
          this.db
            .prepare(`UPDATE tasks SET labels = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(labels), taskBoardId, task.id);
          changes.push(`Etiqueta "${updates.add_label}" adicionada`);
        }
        // idempotent: no error if already present, but no change entry either
      }

      /* Remove label */
      if (updates.remove_label !== undefined) {
        // Re-read labels from DB to pick up any preceding add_label in the same update call
        const freshLabelRow = this.db
          .prepare(`SELECT labels FROM tasks WHERE board_id = ? AND id = ?`)
          .get(taskBoardId, task.id) as { labels: string } | undefined;
        const labels: string[] = JSON.parse(freshLabelRow?.labels ?? task.labels ?? '[]');
        const idx = labels.indexOf(updates.remove_label);
        if (idx >= 0) {
          labels.splice(idx, 1);
          this.db
            .prepare(`UPDATE tasks SET labels = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(labels), taskBoardId, task.id);
          changes.push(`Etiqueta "${updates.remove_label}" removida`);
        }
      }

      /* Add note */
      if (updates.add_note !== undefined) {
        // Meeting note authorization: participants can add notes
        if (task.type === 'meeting' && !isMgr && !isAssignee) {
          const participants: string[] = JSON.parse(task.participants ?? '[]');
          if (!participants.includes(senderPersonId ?? '') && !hasExternalGrant) {
            return { success: false, error: `Permission denied: "${params.sender_name}" is not a participant of this meeting.` };
          }
        }

        const notes: Array<any> = JSON.parse(task.notes ?? '[]');
        const noteId = task.next_note_id ?? 1;
        const noteEntry: any = { id: noteId, text: updates.add_note, at: now, by: params.sender_name };

        // Stable author identity for permission checks
        if (senderPersonId) {
          noteEntry.author_actor_type = 'board_person';
          noteEntry.author_actor_id = senderPersonId;
          noteEntry.author_display_name = sender?.name ?? params.sender_name;
        }
        if (isExternalSender && params.sender_external_id) {
          noteEntry.author_actor_type = 'external_contact';
          noteEntry.author_actor_id = params.sender_external_id;
          const ext = this.db.prepare(`SELECT display_name FROM external_contacts WHERE external_id = ?`).get(params.sender_external_id) as any;
          noteEntry.author_display_name = ext?.display_name ?? params.sender_name;
        }

        // Meeting-only metadata
        const phase = this.getMeetingNotePhase(task);
        if (phase) {
          noteEntry.phase = phase;
          noteEntry.status = 'open';
        }
        if (updates.parent_note_id !== undefined) {
          const parentExists = notes.some((n: any) => n.id === updates.parent_note_id);
          if (!parentExists) {
            return { success: false, error: `Parent note #${updates.parent_note_id} not found.` };
          }
          noteEntry.parent_note_id = updates.parent_note_id;
        }

        notes.push(noteEntry);
        this.db
          .prepare(`UPDATE tasks SET notes = ?, next_note_id = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(notes), noteId + 1, taskBoardId, task.id);
        changes.push(`Nota: ${updates.add_note}`);
      }

      /* Edit note */
      if (updates.edit_note !== undefined) {
        // Re-read notes from DB to pick up any preceding add_note in the same update call
        const freshEditRow = this.db
          .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
          .get(taskBoardId, task.id) as { notes: string } | undefined;
        const notes: Array<any> = JSON.parse(freshEditRow?.notes ?? task.notes ?? '[]');
        const note = notes.find((n: any) => n.id === updates.edit_note!.id);
        if (!note) {
          return { success: false, error: `Note #${updates.edit_note.id} not found.` };
        }
        // Meeting note authorization: only author/organizer/manager can edit
        if (task.type === 'meeting' && !isMgr && !isAssignee) {
          if (isExternalSender && !hasExternalGrant) {
            return { success: false, error: `Permission denied: "${params.sender_name}" does not have active access to this meeting.` };
          }
          const isNoteAuthor = note.author_actor_id
            ? (
                (note.author_actor_type === 'board_person' && note.author_actor_id === senderPersonId && !isExternalSender) ||
                (note.author_actor_type === 'external_contact' && note.author_actor_id === params.sender_external_id)
              )
            : false;
          if (!isNoteAuthor) {
            return { success: false, error: `Permission denied: only the note author, organizer, or manager can edit note #${updates.edit_note.id}.` };
          }
        }
        note.text = updates.edit_note.text;
        this.db
          .prepare(`UPDATE tasks SET notes = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(notes), taskBoardId, task.id);
        changes.push(`Nota #${updates.edit_note.id} editada: ${updates.edit_note.text}`);
      }

      /* Remove note */
      if (updates.remove_note !== undefined) {
        // Re-read notes from DB to pick up any preceding add_note/edit_note in the same update call
        const freshRemoveRow = this.db
          .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
          .get(taskBoardId, task.id) as { notes: string } | undefined;
        const notes: Array<{ id: number; text: string; at: string; by: string }> = JSON.parse(freshRemoveRow?.notes ?? task.notes ?? '[]');
        const idx = notes.findIndex((n) => n.id === updates.remove_note);
        if (idx < 0) {
          return { success: false, error: `Note #${updates.remove_note} not found.` };
        }
        // Meeting note authorization: only author/organizer/manager can remove
        if (task.type === 'meeting' && !isMgr && !isAssignee) {
          if (isExternalSender && !hasExternalGrant) {
            return { success: false, error: `Permission denied: "${params.sender_name}" does not have active access to this meeting.` };
          }
          const noteAny = notes[idx] as any;
          const isNoteAuthor = noteAny.author_actor_id
            ? (
                (noteAny.author_actor_type === 'board_person' && noteAny.author_actor_id === senderPersonId && !isExternalSender) ||
                (noteAny.author_actor_type === 'external_contact' && noteAny.author_actor_id === params.sender_external_id)
              )
            : false;
          if (!isNoteAuthor) {
            return { success: false, error: `Permission denied: only the note author, organizer, or manager can remove note #${updates.remove_note}.` };
          }
        }
        const removedId = notes[idx].id;
        notes.splice(idx, 1);
        // Promote orphaned children to top-level so they remain visible
        for (const n of notes) {
          if ((n as any).parent_note_id === removedId) {
            delete (n as any).parent_note_id;
          }
        }
        this.db
          .prepare(`UPDATE tasks SET notes = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(notes), taskBoardId, task.id);
        changes.push(`Nota #${updates.remove_note} removida`);
      }

      /* Set note status (meeting only) */
      if (updates.set_note_status !== undefined) {
        if (task.type !== 'meeting') {
          return { success: false, error: 'Note status can only be set on meeting tasks.' };
        }
        // Meeting note authorization: only participants, organizer, or manager can set status
        if (!isMgr && !isAssignee) {
          const participants: string[] = JSON.parse(task.participants ?? '[]');
          if (!participants.includes(senderPersonId ?? '') && !hasExternalGrant) {
            return { success: false, error: `Permission denied: "${params.sender_name}" is not a participant of this meeting.` };
          }
        }
        // Re-read notes from DB to pick up any preceding add_note/edit_note/remove_note in the same update call
        const freshNotesRow = this.db
          .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
          .get(taskBoardId, task.id) as { notes: string } | undefined;
        const notes: Array<any> = JSON.parse(freshNotesRow?.notes ?? task.notes ?? '[]');
        const note = notes.find((n: any) => n.id === updates.set_note_status!.id);
        if (!note) {
          return { success: false, error: `Note #${updates.set_note_status.id} not found.` };
        }
        // External participants can only change status of their own notes
        if (isExternalSender && !isMgr && !isAssignee) {
          const isNoteAuthor = note.author_actor_id
            ? (
                (note.author_actor_type === 'board_person' && note.author_actor_id === senderPersonId && !isExternalSender) ||
                (note.author_actor_type === 'external_contact' && note.author_actor_id === params.sender_external_id)
              )
            : false;
          if (!isNoteAuthor) {
            return { success: false, error: `Permission denied: only the note author, organizer, or manager can change status of note #${updates.set_note_status.id}.` };
          }
        }
        note.status = updates.set_note_status.status;
        if (updates.set_note_status.status === 'open') {
          delete note.processed_at;
          delete note.processed_by;
        } else {
          note.processed_at = now;
          note.processed_by = params.sender_name;
        }
        this.db
          .prepare(`UPDATE tasks SET notes = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(notes), taskBoardId, task.id);
        changes.push(`Nota #${updates.set_note_status.id} status: ${updates.set_note_status.status}`);
      }

      /* Add participant (meeting only) */
      if (updates.add_participant !== undefined) {
        if (task.type !== 'meeting') {
          return { success: false, error: 'Participants can only be added to meeting tasks.' };
        }
        const person = this.resolvePerson(updates.add_participant);
        if (!person) return this.buildOfferRegisterError(updates.add_participant);
        const participants: string[] = JSON.parse(task.participants ?? '[]');
        if (!participants.includes(person.person_id)) {
          participants.push(person.person_id);
          this.db
            .prepare(`UPDATE tasks SET participants = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(participants), taskBoardId, task.id);
          changes.push(`Participante ${person.name} adicionado`);

          /* Notify the newly added participant (consistent with create() path) */
          if (senderPersonId && person.person_id !== senderPersonId) {
            const target = this.resolveNotifTarget(person.person_id, senderPersonId);
            if (target) {
              const modName = this.personDisplayName(senderPersonId);
              const scheduledInfo = task.scheduled_at ? `\n*Quando:* ${utcToLocal(task.scheduled_at, tz)}` : '';
              notifications.push({
                ...target,
                message: `📅 *Você foi adicionado(a) a uma reunião*\n\n*${task.id}* — ${task.title}${scheduledInfo}\n*Adicionado por:* ${modName}\n\nDigite \`${task.id}\` para ver detalhes.`,
              });
            }
          }
        }
      }

      /* Remove participant (meeting only) */
      if (updates.remove_participant !== undefined) {
        if (task.type !== 'meeting') {
          return { success: false, error: 'Participants can only be removed from meeting tasks.' };
        }
        const person = this.resolvePerson(updates.remove_participant);
        if (!person) return this.buildOfferRegisterError(updates.remove_participant);
        // Re-read from DB to pick up any preceding add_participant in the same update call
        const freshTask = this.requireTask(task.id);
        const participants: string[] = JSON.parse(freshTask.participants ?? '[]');
        const idx = participants.indexOf(person.person_id);
        if (idx >= 0) {
          participants.splice(idx, 1);
          this.db
            .prepare(`UPDATE tasks SET participants = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(participants), taskBoardId, task.id);
          changes.push(`Participante ${person.name} removido`);

          /* Notify removed participant */
          if (senderPersonId && person.person_id !== senderPersonId) {
            const target = this.resolveNotifTarget(person.person_id, senderPersonId);
            if (target) {
              const modName = this.personDisplayName(senderPersonId);
              notifications.push({
                ...target,
                message: `📅 *Você foi removido(a) de uma reunião*\n\n*${task.id}* — ${task.title}\n*Removido por:* ${modName}`,
              });
            }
          }
        }
      }

      /* Add external participant (meeting only) */
      if (updates.add_external_participant !== undefined) {
        if (task.type !== 'meeting') {
          return { success: false, error: 'External participants can only be added to meeting tasks.' };
        }
        if (!isMgr && !isAssignee) {
          return { success: false, error: 'Permission denied: only the organizer or a manager can add external participants.' };
        }
        if (!task.scheduled_at && !updates.scheduled_at) {
          return { success: false, error: 'Meeting must have scheduled_at set before inviting an external participant.' };
        }

        const phone = normalizePhone(updates.add_external_participant.phone);
        const displayName = updates.add_external_participant.name;

        // Upsert external contact
        let externalId: string;
        let existingChatJid: string | null = null;
        const existing = this.db.prepare(
          `SELECT external_id, direct_chat_jid FROM external_contacts WHERE phone = ?`
        ).get(phone) as { external_id: string; direct_chat_jid: string | null } | undefined;

        if (existing) {
          externalId = existing.external_id;
          existingChatJid = existing.direct_chat_jid;
          this.db.prepare(
            `UPDATE external_contacts SET display_name = ?, updated_at = ? WHERE external_id = ?`
          ).run(displayName, now, externalId);
        } else {
          externalId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          this.db.prepare(
            `INSERT INTO external_contacts (external_id, display_name, phone, status, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, ?)`
          ).run(externalId, displayName, phone, now, now);
        }

        // Create grant (upsert)
        const occurrenceScheduledAt = updates.scheduled_at ?? task.scheduled_at;
        const existingGrant = this.db.prepare(
          `SELECT invite_status, access_expires_at FROM meeting_external_participants
           WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ? AND external_id = ?`
        ).get(this.boardId, task.id, occurrenceScheduledAt, externalId) as { invite_status: string; access_expires_at: string | null } | undefined;

        let grantActioned = false;
        if (existingGrant) {
          const isExpiredByTime = (existingGrant.invite_status === 'invited' || existingGrant.invite_status === 'accepted')
            && existingGrant.access_expires_at != null && existingGrant.access_expires_at < now;
          if (existingGrant.invite_status === 'revoked' || existingGrant.invite_status === 'expired' || isExpiredByTime) {
            const freshExpiry = new Date(new Date(occurrenceScheduledAt).getTime() + ACCESS_WINDOW_MS).toISOString();
            this.db.prepare(
              `UPDATE meeting_external_participants
               SET invite_status = 'invited', revoked_at = NULL, accepted_at = NULL,
                   invited_at = ?, access_expires_at = ?, updated_at = ?
               WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ? AND external_id = ?`
            ).run(now, freshExpiry, now, this.boardId, task.id, occurrenceScheduledAt, externalId);
            grantActioned = true;
          }
          // else already invited/accepted — no-op, skip notification and audit
        } else {
          // Calculate access_expires_at: scheduled_at + 7 days
          const expiresAt = new Date(new Date(occurrenceScheduledAt).getTime() + ACCESS_WINDOW_MS).toISOString();
          this.db.prepare(
            `INSERT INTO meeting_external_participants
             (board_id, meeting_task_id, occurrence_scheduled_at, external_id, invite_status,
              invited_at, access_expires_at, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'invited', ?, ?, ?, ?, ?)`
          ).run(this.boardId, task.id, occurrenceScheduledAt, externalId, now, expiresAt, senderPersonId ?? params.sender_name, now, now);
          grantActioned = true;
        }

        if (grantActioned) {
          // Notify about the external participant invite.
          // Only send a DM if the contact has previously messaged the bot
          // (direct_chat_jid is set). Otherwise, WhatsApp may flag unsolicited
          // DMs as spam and ban the account.
          const organizerName = sender?.name ?? params.sender_name;

          if (existingChatJid) {
            notifications.push({
              target_kind: 'dm',
              target_external_id: externalId,
              target_chat_jid: existingChatJid,
              message: buildExternalInviteMessage(task.id, task.title, updates.scheduled_at ?? task.scheduled_at, organizerName, tz),
            });
          } else {
            // Contact never messaged the bot — generate a forwardable invite
            const meetingDate = updates.scheduled_at ?? task.scheduled_at;
            const localTime = meetingDate ? utcToLocal(meetingDate, tz) : '';
            const timeStr = localTime ? ` em ${localTime}` : '';

            notifications.push({
              target_kind: 'group',
              message:
                `\u{1f4c5} *Convite pendente \u2014 ${displayName}*\n\n` +
                `Encaminhe a mensagem abaixo para ${displayName}:\n\n` +
                `\u2014\u2014\u2014\n` +
                `Ol\u00e1, ${displayName}! ${organizerName} est\u00e1 te convidando para a reuni\u00e3o *${task.title}*${timeStr}.\n\n` +
                `Para acessar a pauta e confirmar presen\u00e7a, envie uma mensagem (ex: "oi") para este n\u00famero e depois digite:\n` +
                `*aceitar convite ${task.id}*\n` +
                `\u2014\u2014\u2014\n\n` +
                `Depois que ${displayName} responder, use: _reconvidar participante ${displayName}_`,
            });
          }

          // Audit trail
          this.db.prepare(
            `INSERT INTO task_history (board_id, task_id, action, by, at, details)
             VALUES (?, ?, 'add_external_participant', ?, ?, ?)`
          ).run(this.boardId, task.id, senderPersonId ?? params.sender_name, now,
            `External participant ${displayName} (${phone}) invited`);

          changes.push(`Participante externo ${displayName} convidado`);
        }
      }

      /* Remove external participant (meeting only) */
      if (updates.remove_external_participant !== undefined) {
        if (task.type !== 'meeting') {
          return { success: false, error: 'External participants can only be removed from meeting tasks.' };
        }
        if (!isMgr && !isAssignee) {
          return { success: false, error: 'Permission denied: only the organizer or a manager can remove external participants.' };
        }

        const { external_id, phone, name } = updates.remove_external_participant;
        let externalId = external_id;
        if (!externalId && phone) {
          const row = this.db.prepare(`SELECT external_id FROM external_contacts WHERE phone = ?`).get(normalizePhone(phone)) as { external_id: string } | undefined;
          externalId = row?.external_id;
        }
        if (!externalId && name) {
          const row = this.db.prepare(
            `SELECT ec.external_id FROM external_contacts ec
             JOIN meeting_external_participants mep ON mep.external_id = ec.external_id
             WHERE LOWER(ec.display_name) = LOWER(?)
               AND mep.board_id = ? AND mep.meeting_task_id = ?
               AND mep.invite_status IN ('pending', 'invited', 'accepted')
             LIMIT 1`
          ).get(name, this.boardId, task.id) as { external_id: string } | undefined;
          externalId = row?.external_id;
        }
        if (!externalId) {
          return { success: false, error: 'External participant not found.' };
        }

        const revokeResult = this.db.prepare(
          `UPDATE meeting_external_participants
           SET invite_status = 'revoked', revoked_at = ?, updated_at = ?
           WHERE board_id = ? AND meeting_task_id = ? AND external_id = ?
             AND invite_status IN ('pending', 'invited', 'accepted')`
        ).run(now, now, this.boardId, task.id, externalId);

        if (revokeResult.changes === 0) {
          return { success: false, error: 'This external contact is not an active participant of this meeting.' };
        }

        // Notify removed external participant via DM (only if they've messaged before)
        const contact = this.db.prepare(
          `SELECT display_name, phone, direct_chat_jid FROM external_contacts WHERE external_id = ?`
        ).get(externalId) as { display_name: string; phone: string; direct_chat_jid: string | null } | undefined;
        if (contact?.direct_chat_jid) {
          const organizerName = sender?.name ?? params.sender_name;
          notifications.push({
            target_kind: 'dm',
            target_external_id: externalId,
            target_chat_jid: contact.direct_chat_jid,
            message: `📅 *Participação cancelada*\n\n*${task.id}* — ${task.title}\n*Por:* ${organizerName}\n\nSeu acesso a esta reunião foi revogado.`,
          });
        }

        this.db.prepare(
          `INSERT INTO task_history (board_id, task_id, action, by, at, details)
           VALUES (?, ?, 'remove_external_participant', ?, ?, ?)`
        ).run(this.boardId, task.id, senderPersonId ?? params.sender_name, now, `External participant ${externalId} revoked`);

        changes.push(`Participante externo removido`);
      }

      /* Reinvite external participant (meeting only) */
      if (updates.reinvite_external_participant !== undefined) {
        if (task.type !== 'meeting') {
          return { success: false, error: 'External participants can only be reinvited on meeting tasks.' };
        }
        if (!isMgr && !isAssignee) {
          return { success: false, error: 'Permission denied: only the organizer or a manager can reinvite external participants.' };
        }
        if (!task.scheduled_at) {
          return { success: false, error: 'Meeting must have scheduled_at set.' };
        }

        const { external_id, phone } = updates.reinvite_external_participant;
        let externalId = external_id;
        if (!externalId && phone) {
          const row = this.db.prepare(`SELECT external_id FROM external_contacts WHERE phone = ?`).get(normalizePhone(phone)) as { external_id: string } | undefined;
          externalId = row?.external_id;
        }
        if (!externalId) {
          return { success: false, error: 'External contact not found.' };
        }

        // Reset grant with current schedule and fresh expiry window
        const reinviteExpiry = new Date(new Date(task.scheduled_at).getTime() + ACCESS_WINDOW_MS).toISOString();
        const reinviteResult = this.db.prepare(
          `UPDATE meeting_external_participants
           SET invite_status = 'invited', revoked_at = NULL, accepted_at = NULL,
               access_expires_at = ?, invited_at = ?, updated_at = ?
           WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ? AND external_id = ?
             AND invite_status IN ('revoked', 'expired')`
        ).run(reinviteExpiry, now, now, this.boardId, task.id, task.scheduled_at, externalId);
        if (reinviteResult.changes === 0) {
          return { success: false, error: 'No revoked or expired grant found for this participant on the current occurrence.' };
        }

        // Build invite notification (DM only if contact has messaged before)
        const contact = this.db.prepare(`SELECT display_name, phone, direct_chat_jid FROM external_contacts WHERE external_id = ?`).get(externalId) as any;
        const organizerName = sender?.name ?? params.sender_name;

        if (contact.direct_chat_jid) {
          notifications.push({
            target_kind: 'dm',
            target_external_id: externalId,
            target_chat_jid: contact.direct_chat_jid,
            message: buildExternalInviteMessage(task.id, task.title, task.scheduled_at, organizerName, tz),
          });
        } else {
          notifications.push({
            target_kind: 'group',
            message:
              `\u{1f4c5} *Reconvite pendente — ${contact.display_name}*\n\n` +
              `Para ${task.id} — ${task.title}\n\n` +
              `${contact.display_name} ainda n\u00e3o tem conversa com o assistente. ` +
              `Pe\u00e7a para enviar qualquer mensagem para este n\u00famero primeiro.`,
          });
        }

        changes.push(`Participante externo ${contact.display_name} reconvidado`);
      }

      /* Scheduled at (meeting only) */
      if (updates.scheduled_at !== undefined) {
        if (task.type !== 'meeting') {
          return { success: false, error: 'scheduled_at can only be set on meeting tasks.' };
        }
        const reminders: Array<{ days: number; date: string }> = JSON.parse(task.reminders ?? '[]');
        if (reminders.length > 0) {
          for (const r of reminders) {
            r.date = reminderDateFromScheduledAt(updates.scheduled_at, r.days);
          }
          this.db
            .prepare(`UPDATE tasks SET scheduled_at = ?, reminders = ? WHERE board_id = ? AND id = ?`)
            .run(updates.scheduled_at, JSON.stringify(reminders), taskBoardId, task.id);
          changes.push('Lembretes da reunião recalculados');
        } else {
          this.db
            .prepare(`UPDATE tasks SET scheduled_at = ? WHERE board_id = ? AND id = ?`)
            .run(updates.scheduled_at, taskBoardId, task.id);
        }
        changes.push(`Reunião reagendada para ${utcToLocal(updates.scheduled_at, tz)}`);

        // Notify all active meeting participants (internal + external) of the reschedule
        const rescheduleMsg = `📅 *Reunião reagendada*\n\n*${task.id}* — ${task.title}\n*Novo horário:* ${utcToLocal(updates.scheduled_at, tz)}\n*Por:* ${sender?.name ?? params.sender_name}`;
        for (const recipient of this.meetingNotificationRecipients(task)) {
          if (recipient.target_person_id && senderPersonId && recipient.target_person_id === senderPersonId) continue;
          notifications.push({ ...recipient, message: rescheduleMsg });
        }

        // Cascade to active external participant grants: update occurrence key + expiry in one statement
        const oldScheduledAt = task.scheduled_at;
        const newExpiry = new Date(new Date(updates.scheduled_at).getTime() + ACCESS_WINDOW_MS).toISOString();
        if (oldScheduledAt) {
          this.db.prepare(
            `UPDATE meeting_external_participants
             SET occurrence_scheduled_at = ?, access_expires_at = ?, updated_at = ?
             WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ?
               AND invite_status IN ('pending', 'invited', 'accepted')`
          ).run(updates.scheduled_at, newExpiry, now, this.boardId, task.id, oldScheduledAt);
        } else {
          this.db.prepare(
            `UPDATE meeting_external_participants
             SET access_expires_at = ?, updated_at = ?
             WHERE board_id = ? AND meeting_task_id = ?
               AND invite_status IN ('pending', 'invited', 'accepted')`
          ).run(newExpiry, now, this.boardId, task.id);
        }
      }

      /* Add subtask (project only) — creates a real task row */
      if (updates.add_subtask !== undefined) {
        if (task.type !== 'project') {
          return { success: false, error: 'Subtasks can only be added to project tasks.' };
        }
        const existingSubtasks = this.getSubtaskRows(task.id, taskBoardId);
        // Use max existing suffix, not count, to prevent ID collision after subtask deletion
        const maxNum = existingSubtasks.reduce((max: number, s: { id: string }) => {
          const parts = s.id.split('.');
          const num = parseInt(parts[parts.length - 1], 10);
          return Number.isNaN(num) ? max : Math.max(max, num);
        }, 0);
        const nextNum = maxNum + 1;
        const subtaskId = `${task.id}.${nextNum}`;
        const subColumn = task.assignee ? 'next_action' : 'inbox';
        this.insertSubtaskRow({
          boardId: taskBoardId,
          subtaskId, title: updates.add_subtask, assignee: task.assignee, column: subColumn,
          parentTaskId: task.id, priority: task.priority ?? null, senderName: params.sender_name, now,
        });
        changes.push(`Subtarefa ${subtaskId} "${updates.add_subtask}" adicionada`);

        // Notify subtask assignee (inherited from project)
        if (task.assignee && senderPersonId && task.assignee !== senderPersonId) {
          const notif = this.buildSubtaskAssignNotification(
            { id: subtaskId, title: updates.add_subtask },
            { id: task.id, title: task.title },
            task.assignee, senderPersonId, taskBoardId,
          );
          if (notif) notifications.push(notif);
        }
      }

      /* Rename subtask (project only) — operates on subtask task row */
      if (updates.rename_subtask !== undefined) {
        const check = this.requireProjectSubtask(task, updates.rename_subtask.id);
        if (!check.success) return check;
        this.db
          .prepare(`UPDATE tasks SET title = ?, updated_at = ? WHERE board_id = ? AND id = ?`)
          .run(updates.rename_subtask.title, now, taskBoardId, updates.rename_subtask.id);
        changes.push(`Subtarefa ${updates.rename_subtask.id} renomeada para "${updates.rename_subtask.title}"`);
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
        changes.push(`Subtarefa ${updates.reopen_subtask} reaberta`);
      }

      /* Assign subtask (project only) — reassigns a subtask to a different person */
      if (updates.assign_subtask !== undefined) {
        const check = this.requireProjectSubtask(task, updates.assign_subtask.id);
        if (!check.success) return check;
        const subPerson = this.resolvePerson(updates.assign_subtask.assignee);
        if (!subPerson) return this.buildOfferRegisterError(updates.assign_subtask.assignee);
        const childLink = this.linkedChildBoardFor(taskBoardId, subPerson.person_id);
        const subChildBoardChanged = (check.subTask.child_exec_board_id ?? null) !== childLink.child_exec_board_id;
        const subClearRollup = check.subTask.child_exec_rollup_status && (childLink.child_exec_enabled === 0 || subChildBoardChanged);
        this.db
          .prepare(`UPDATE tasks SET assignee = ?, child_exec_enabled = ?, child_exec_board_id = ?, child_exec_person_id = ?,
            child_exec_rollup_status = CASE WHEN ? THEN NULL ELSE child_exec_rollup_status END,
            child_exec_last_rollup_at = CASE WHEN ? THEN NULL ELSE child_exec_last_rollup_at END,
            child_exec_last_rollup_summary = CASE WHEN ? THEN NULL ELSE child_exec_last_rollup_summary END,
            column = CASE WHEN column = 'inbox' THEN 'next_action' ELSE column END, updated_at = ? WHERE board_id = ? AND id = ?`)
          .run(
            subPerson.person_id,
            childLink.child_exec_enabled,
            childLink.child_exec_board_id,
            childLink.child_exec_person_id,
            subClearRollup ? 1 : 0,
            subClearRollup ? 1 : 0,
            subClearRollup ? 1 : 0,
            now,
            taskBoardId,
            updates.assign_subtask.id,
          );
        this.recordHistory(updates.assign_subtask.id, 'reassigned', params.sender_name,
          JSON.stringify({ from_assignee: check.subTask.assignee, to_assignee: subPerson.person_id }), taskBoardId);
        changes.push(`Subtarefa ${updates.assign_subtask.id} atribuída a ${subPerson.name}`);

        // Notify subtask assignee
        if (senderPersonId) {
          const notif = this.buildSubtaskAssignNotification(
            { id: updates.assign_subtask.id, title: check.subTask.title },
            { id: task.id, title: task.title },
            subPerson.person_id, senderPersonId, taskBoardId,
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
        changes.push(`Subtarefa ${updates.unassign_subtask} desatribuída`);
      }

      /* Recurrence (recurring only) */
      if (updates.recurrence !== undefined) {
        if (!task.recurrence) {
          return { success: false, error: 'Recurrence can only be changed on recurring tasks.' };
        }
        this.db
          .prepare(`UPDATE tasks SET recurrence = ? WHERE board_id = ? AND id = ?`)
          .run(updates.recurrence, taskBoardId, task.id);
        changes.push(`Recorrência alterada para ${updates.recurrence}`);
      }

      /* max_cycles (recurring only — setting clears recurrence_end_date unless also provided) */
      if (updates.max_cycles !== undefined) {
        if (!task.recurrence) {
          return { success: false, error: 'max_cycles can only be set on tasks with recurrence.' };
        }
        // Only clear recurrence_end_date if it is NOT also being set in this same update call;
        // otherwise the later recurrence_end_date block handles it and we avoid overwrite conflicts.
        if (updates.recurrence_end_date !== undefined) {
          this.db
            .prepare(`UPDATE tasks SET max_cycles = ? WHERE board_id = ? AND id = ?`)
            .run(updates.max_cycles, taskBoardId, task.id);
        } else {
          this.db
            .prepare(`UPDATE tasks SET max_cycles = ?, recurrence_end_date = NULL WHERE board_id = ? AND id = ?`)
            .run(updates.max_cycles, taskBoardId, task.id);
        }
        changes.push(updates.max_cycles === null ? 'Limite de ciclos removido' : `Limite de ciclos: ${updates.max_cycles}`);
      }

      /* recurrence_end_date (recurring only — setting clears max_cycles unless also provided) */
      if (updates.recurrence_end_date !== undefined) {
        if (!task.recurrence) {
          return { success: false, error: 'recurrence_end_date can only be set on tasks with recurrence.' };
        }
        // Only clear max_cycles if it is NOT also being set in this same update call;
        // otherwise the preceding max_cycles block already wrote its value.
        if (updates.max_cycles !== undefined) {
          this.db
            .prepare(`UPDATE tasks SET recurrence_end_date = ? WHERE board_id = ? AND id = ?`)
            .run(updates.recurrence_end_date, taskBoardId, task.id);
        } else {
          this.db
            .prepare(`UPDATE tasks SET recurrence_end_date = ?, max_cycles = NULL WHERE board_id = ? AND id = ?`)
            .run(updates.recurrence_end_date, taskBoardId, task.id);
        }
        changes.push(updates.recurrence_end_date === null ? 'Data final de recorrência removida' : `Data final de recorrência: ${updates.recurrence_end_date}`);
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
          { id: task.id, title: task.title, assignee: task.assignee, board_id: task.board_id },
          changes,
          senderPersonId,
          taskBoardId,
        );
        if (notif) notifications.push(notif);
      }

      /* --- Parent board notification (linked task update) --- */
      let parentNotification: ParentNotification | undefined;
      if (changes.length > 0) {
        const modName = sender?.name ?? params.sender_name;
        const changeList = changes.map(c => `• ${c}`).join('\n');
        parentNotification = this.buildParentNotification(
          task,
          `🔔 *Atualização na sua tarefa*\n\n*${task.id}* — ${task.title}\n*Modificado por:* ${modName}\n\n${changeList}\n\nDigite \`${task.id}\` para ver detalhes.`,
        );
        if (parentNotification) {
          this.deduplicateNotificationsForParent(notifications, parentNotification.parent_group_jid);
        }
      }

      /* --- Build result --- */
      const result: UpdateResult = {
        success: true,
        task_id: task.id,
        title: task.title,
        changes,
      };
      if (notifications.length > 0) result.notifications = notifications;
      if (parentNotification) result.parent_notification = parentNotification;

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
          if (target.column === 'done') {
            return { success: false, error: `Tarefa ${params.target_task_id} já está concluída — dependência seria permanente.` };
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
          const reminderBase =
            task.type === 'meeting'
              ? task.scheduled_at ?? null
              : task.due_date ?? null;
          if (!reminderBase) {
            return {
              success: false,
              error:
                task.type === 'meeting'
                  ? 'Cannot add reminder: meeting has no scheduled_at.'
                  : 'Cannot add reminder: task has no due date.',
            };
          }
          if (params.reminder_days == null || params.reminder_days < 0) {
            return { success: false, error: 'Missing or invalid parameter: reminder_days (must be >= 0).' };
          }
          const reminderDate =
            task.type === 'meeting'
              ? reminderDateFromScheduledAt(reminderBase, params.reminder_days)
              : reminderDateFromDue(reminderBase, params.reminder_days);

          const reminders: Array<{ days: number; date: string }> = JSON.parse(task.reminders ?? '[]');
          reminders.push({ days: params.reminder_days, date: reminderDate });
          this.db
            .prepare(`UPDATE tasks SET reminders = ?, updated_at = ?, _last_mutation = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(reminders), now, snapshot, taskBoardId, task.id);

          change =
            task.type === 'meeting'
              ? `Reminder added: ${params.reminder_days} day(s) before scheduled_at (${reminderDate})`
              : `Reminder added: ${params.reminder_days} day(s) before due date (${reminderDate})`;
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
        title: task.title,
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
  /*  Formatted meeting minutes                                        */
  /* ---------------------------------------------------------------- */

  private formatMeetingMinutes(task: any, notes: Array<any>): string {
    const lines: string[] = [];
    const tz = getBoardTimezone(this.db, this.taskBoardId(task));
    const scheduledStr = task.scheduled_at
      ? utcToLocal(task.scheduled_at, tz)
      : 'sem data';
    lines.push(`📅 *${task.id} — ${task.title}* (${scheduledStr})`);
    lines.push('');

    const topLevel = notes.filter((n: any) => !n.parent_note_id);
    const replies = new Map<number, any[]>();
    for (const n of notes.filter((n: any) => n.parent_note_id)) {
      const arr = replies.get(n.parent_note_id) ?? [];
      arr.push(n);
      replies.set(n.parent_note_id, arr);
    }

    const statusMarker = (n: any): string => {
      switch (n.status) {
        case 'checked': return '✓';
        case 'task_created': return `⤷ ${n.created_task_id ?? ''}`;
        case 'inbox_created': return `📥 ${n.created_task_id ?? ''}`;
        case 'dismissed': return '—';
        default: return '';
      }
    };

    const preNotes = topLevel.filter((n: any) => n.phase === 'pre');
    const meetingNotes = topLevel.filter((n: any) => n.phase === 'meeting');
    const postNotes = topLevel.filter((n: any) => n.phase === 'post');
    const otherNotes = topLevel.filter((n: any) => !n.phase);

    if (preNotes.length > 0) {
      lines.push('*Pauta:*');
      for (let i = 0; i < preNotes.length; i++) {
        const n = preNotes[i];
        const marker = statusMarker(n);
        lines.push(`${i + 1}. ${marker ? marker + ' ' : ''}${n.text}`);
        for (const r of replies.get(n.id) ?? []) {
          const rMarker = statusMarker(r);
          const postTag = r.phase === 'post' ? ' _(pós-reunião)_' : '';
          lines.push(`   → ${rMarker ? rMarker + ' ' : ''}${r.text}${postTag}`);
        }
      }
    }

    if (meetingNotes.length > 0) {
      lines.push('');
      for (const n of meetingNotes) {
        const marker = statusMarker(n);
        lines.push(`*${marker ? marker + ' ' : ''}[Novo] ${n.text}*`);
        for (const r of replies.get(n.id) ?? []) {
          const rMarker = statusMarker(r);
          const postTag = r.phase === 'post' ? ' _(pós-reunião)_' : '';
          lines.push(`   → ${rMarker ? rMarker + ' ' : ''}${r.text}${postTag}`);
        }
      }
    }

    if (postNotes.length > 0) {
      lines.push('');
      lines.push('*[Pós-reunião]*');
      for (const n of postNotes) {
        const marker = statusMarker(n);
        lines.push(`   → ${marker ? marker + ' ' : ''}${n.text}`);
        for (const r of replies.get(n.id) ?? []) {
          const rMarker = statusMarker(r);
          lines.push(`   → ${rMarker ? rMarker + ' ' : ''}${r.text}`);
        }
      }
    }

    if (otherNotes.length > 0) {
      for (const n of otherNotes) {
        lines.push(`• ${n.text}`);
        for (const r of replies.get(n.id) ?? []) {
          const rMarker = statusMarker(r);
          lines.push(`   → ${rMarker ? rMarker + ' ' : ''}${r.text}`);
        }
      }
    }

    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- */
  /*  Shared task-fetching for board views                              */
  /* ---------------------------------------------------------------- */

  private fetchActiveTasks(): {
    allTasks: any[];
    topLevel: any[];
    subtaskMap: Map<string, any[]>;
    taskCount: number;
    projectCount: number;
    subtaskCount: number;
  } {
    const allTasks: any[] = this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${this.visibleTaskScope()} AND column != 'done' ORDER BY id`,
      )
      .all(...this.visibleTaskParams());

    const topLevel = allTasks.filter((t: any) => !t.parent_task_id);

    const subtaskMap = new Map<string, any[]>();
    for (const t of allTasks.filter((t: any) => t.parent_task_id)) {
      const arr = subtaskMap.get(t.parent_task_id);
      if (arr) arr.push(t);
      else subtaskMap.set(t.parent_task_id, [t]);
    }

    // Orphan subtask promotion: fetch parent from other board
    const topLevelIds = new Set(topLevel.map((t: any) => t.id));
    for (const [parentId, subs] of subtaskMap.entries()) {
      if (!topLevelIds.has(parentId)) {
        const parentBoardId = subs[0].owning_board_id ?? subs[0].board_id;
        const parent = this.db
          .prepare(TaskflowEngine.TASK_BY_BOARD_SQL)
          .get(parentBoardId, parentId) as any;
        if (parent) {
          topLevel.push(parent);
          topLevelIds.add(parent.id);
        }
      }
    }

    const projectCount = topLevel.filter((t: any) => t.type === 'project').length;
    const subtaskCount = allTasks.filter((t: any) => t.parent_task_id).length;
    const taskCount = topLevel.length;

    return { allTasks, topLevel, subtaskMap, taskCount, projectCount, subtaskCount };
  }

  /* ---------------------------------------------------------------- */
  /*  Compact board header (for digest/weekly reports)                  */
  /* ---------------------------------------------------------------- */

  private formatCompactBoard(completedCount: number, type: 'digest' | 'weekly'): string {
    const todayStr = today();
    const [y, m, d] = todayStr.split('-');
    const { topLevel, taskCount, projectCount, subtaskCount } = this.fetchActiveTasks();

    const byColumn = new Map<string, number>();
    for (const t of topLevel) {
      byColumn.set(t.column, (byColumn.get(t.column) ?? 0) + 1);
    }

    const lines: string[] = [];
    lines.push(`📋 *TASKFLOW BOARD* — ${d}/${m}/${y}`);
    lines.push(`📊 ${taskCount} tarefas • ${projectCount} projetos • ${subtaskCount} subtarefas`);
    lines.push(TaskflowEngine.SEP);

    const compactCols: Array<[string, string, string]> = [
      ['inbox', '📥', 'inbox'],
      ['next_action', '⏭️', 'próximas'],
      ['in_progress', '🔄', 'andamento'],
      ['waiting', '⏳', 'aguardando'],
      ['review', '🔍', 'revisão'],
    ];
    for (const [col, emoji, label] of compactCols) {
      const count = byColumn.get(col) ?? 0;
      if (count > 0) lines.push(`  ${emoji} ${count} ${label}`);
    }
    if (completedCount > 0) {
      const completedLabel = type === 'digest' ? 'hoje' : 'na semana';
      lines.push(`  ✅ ${completedCount} concluída(s) ${completedLabel}`);
    }

    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- */
  /*  Pre-formatted board view                                         */
  /* ---------------------------------------------------------------- */

  private formatBoardView(mode: 'board' | 'standup' = 'board'): string {
    const todayStr = today();
    const todayMs = new Date(todayStr).getTime();
    const tz = this.boardTz;

    /* --- Person name lookup --- */
    const people = this.db
      .prepare(`SELECT person_id, name FROM board_people WHERE board_id = ?`)
      .all(this.boardId) as Array<{ person_id: string; name: string }>;
    const nameOf = new Map(people.map((p) => [p.person_id, p.name]));
    const pName = (id: string | null) => (id ? nameOf.get(id) ?? id : null);

    /* --- Cross-board person name cache (avoids repeated lookups for the same delegate) --- */
    const extNameCache = new Map<string, string>();
    const extName = (personId: string): string => {
      const cached = extNameCache.get(personId);
      if (cached !== undefined) return cached;
      const row = this.db
        .prepare(`SELECT name FROM board_people WHERE person_id = ? LIMIT 1`)
        .get(personId) as { name: string } | undefined;
      const name = row?.name ?? personId;
      extNameCache.set(personId, name);
      return name;
    };

    /* --- Delegation lookup: for assignees not on this board, find the last
     *     internal assignee from task_history (the accountable person) --- */
    const delegatedFrom = new Map<string, { accountable: string; delegateName: string }>();
    const findAccountable = (taskId: string, assignee: string): string => {
      if (nameOf.has(assignee)) return assignee;
      const cached = delegatedFrom.get(taskId);
      if (cached) return cached.accountable;
      const hist = this.db
        .prepare(
          `SELECT details FROM task_history
           WHERE board_id = ? AND task_id = ? AND action = 'reassigned'
           ORDER BY at DESC`,
        )
        .all(this.boardId, taskId) as Array<{ details: string }>;
      for (const h of hist) {
        try {
          const d = JSON.parse(h.details);
          if (d.from_assignee && nameOf.has(d.from_assignee)) {
            delegatedFrom.set(taskId, {
              accountable: d.from_assignee,
              delegateName: extName(assignee),
            });
            return d.from_assignee;
          }
        } catch {}
      }
      return assignee;
    };
    const delegateInfo = (taskId: string) => delegatedFrom.get(taskId);
    const delegateSfx = (taskId: string, assignee: string | null): string => {
      if (assignee) findAccountable(taskId, assignee);
      const del = delegateInfo(taskId);
      return del ? ` \u27a4 _${del.delegateName}_` : '';
    };

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

    const { allTasks, topLevel, subtaskMap, taskCount, projectCount, subtaskCount } =
      this.fetchActiveTasks();

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

    /** Sort key: prefer due_date, fall back to scheduled_at date portion for meetings. */
    const sortDate = (t: any): string | null =>
      t.due_date ?? (t.scheduled_at ? t.scheduled_at.slice(0, 10) : null);

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
      if (t.type === 'meeting') return '\ud83d\udcc5 ';
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

    const meetingSfx = (t: any): string => {
      if (t.type !== 'meeting') return '';
      const parts: string[] = [];
      if (t.scheduled_at) {
        parts.push(utcToLocal(t.scheduled_at, tz));
      }
      if (t.participants) {
        try {
          const p = JSON.parse(t.participants);
          if (Array.isArray(p) && p.length > 0) {
            const organizerExtra = t.assignee && !p.includes(t.assignee) ? 1 : 0;
            const total = p.length + organizerExtra;
            parts.push(`${total} participantes`);
          }
        } catch {}
      }
      return parts.length > 0 ? ` (${parts.join(' \u2014 ')})` : '';
    };

    /* --- Build output --- */
    const lines: string[] = [];
    const SEP = TaskflowEngine.SEP;

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

    /* Board manager (owner) — listed first in each column */
    const managerRow = this.db
      .prepare(`SELECT person_id FROM board_admins WHERE board_id = ? AND admin_role = 'manager' LIMIT 1`)
      .get(this.boardId) as { person_id: string } | undefined;
    const managerId = managerRow?.person_id ?? null;

    /** Threshold: 3+ tasks → summary line; < 3 → show individual tasks */
    const SUMMARY_THRESHOLD = 3;

    /** Build a one-line summary for a person's tasks in a column */
    const summarizeTasks = (personTasks: any[], col: string): string => {
      let overdue = 0;
      let dueSoon = 0;
      for (const t of personTasks) {
        if (!t.due_date) continue;
        const d = daysDiff(t.due_date);
        if (d < 0) overdue++;
        else if (d <= 7) dueSoon++;
      }
      const meetings = personTasks.filter((t: any) => t.type === 'meeting');
      const projects = personTasks.filter((t: any) => t.type === 'project');
      const parts: string[] = [];
      if (overdue > 0) parts.push(`${overdue} atrasada(s)`);
      if (dueSoon > 0) parts.push(`${dueSoon} com prazo esta semana`);
      if (meetings.length > 0) parts.push(`${meetings.length} reunião(ões)`);
      if (projects.length > 0) parts.push(`${projects.length} projeto(s)`);
      if (col === 'waiting') {
        const withReason = personTasks.filter((t: any) => t.waiting_for);
        if (withReason.length > 0) parts.push(`aguardando respostas externas`);
      }
      const delegated = personTasks.filter((t: any) => delegateInfo(t.id));
      if (delegated.length > 0) parts.push(`${delegated.length} delegada(s)`);
      const rollupManaged = personTasks.filter(TaskflowEngine.isRollupActive);
      if (rollupManaged.length > 0) parts.push(`${rollupManaged.length} com progresso no quadro filho`);
      if (parts.length === 0) {
        parts.push(`${personTasks.length} tarefa(s)`);
      }
      return `  _${parts.join(', ')}_`;
    };

    for (const [col, label] of colOrder) {
      const tasks = byColumn.get(col);
      if (!tasks || tasks.length === 0) continue;

      lines.push('', SEP, '');

      if (col === 'inbox') {
        lines.push(`${label} (${tasks.length})`, '');
        if (tasks.length < SUMMARY_THRESHOLD) {
          for (const t of tasks) lines.push(`\u2022 ${dId(t)}: ${t.title}`);
        } else {
          const overdue = tasks.filter((t: any) => t.due_date && daysDiff(t.due_date) < 0);
          const parts: string[] = [`${tasks.length} itens para processar`];
          if (overdue.length > 0) parts.push(`${overdue.length} atrasado(s)`);
          lines.push(`_${parts.join(', ')}_`);
        }
        continue;
      }

      /* Group by person (resolve delegated tasks to their accountable person) */
      const byPerson = new Map<string, any[]>();
      for (const t of tasks) {
        const raw = t.assignee ?? '__none__';
        const key = raw === '__none__' ? raw : findAccountable(t.id, raw);
        const arr = byPerson.get(key);
        if (arr) arr.push(t);
        else byPerson.set(key, [t]);
      }

      /* Sort persons: board owner first, then by earliest date */
      const earliest = (list: any[]) =>
        list.reduce(
          (mn: string | null, t: any) => {
            const d = sortDate(t);
            return d && (!mn || d < mn) ? d : mn;
          },
          null as string | null,
        );
      const cmpDateNullable = (a: string | null, b: string | null): number => {
        if (a && b) return a.localeCompare(b);
        if (a) return -1;
        if (b) return 1;
        return 0;
      };
      const persons = [...byPerson.entries()].sort((a, b) => {
        // Board owner always first
        if (a[0] === managerId && b[0] !== managerId) return -1;
        if (b[0] === managerId && a[0] !== managerId) return 1;
        return cmpDateNullable(earliest(a[1]), earliest(b[1]));
      });

      lines.push(label, '');

      for (const [personId, pTasks] of persons) {
        const nm = personId === '__none__'
          ? (pName(managerId ?? '') ?? 'Sem responsável')
          : (pName(personId) ?? personId);
        const subCount = pTasks.reduce(
          (n, t) => n + (subtaskMap.get(t.id)?.length ?? 0),
          0,
        );
        lines.push(`\ud83d\udc64 *${nm}* (${pTasks.length + subCount})`);

        /* Sort tasks by date */
        const sorted = [...pTasks].sort((a, b) =>
          cmpDateNullable(sortDate(a), sortDate(b)),
        );


        if (sorted.length >= SUMMARY_THRESHOLD) {
          /* Summary mode */
          const summary = summarizeTasks(sorted, col);
          if (summary) lines.push(summary);
        } else {
          /* Detail mode — show individual tasks */
          for (const t of sorted) {
            const tid = dId(t);
            let line = `${pfx(t)}${tid}: ${t.title}${meetingSfx(t)}${dueSfx(t)}${notesSfx(t)}`;
            if (TaskflowEngine.isRollupActive(t) && t.child_exec_last_rollup_summary)
              line += ` → _📊 ${t.child_exec_last_rollup_summary}_`;
            else if (col === 'waiting' && t.waiting_for)
              line += ` \u2192 _${t.waiting_for}_`;
            line += delegateSfx(t.id, t.assignee);
            lines.push(line);

            /* Subtasks */
            const subs = subtaskMap.get(t.id);
            if (subs) {
              for (const st of subs) {
                lines.push(
                  `   \u21b3 ${dId(st)}: ${st.title}${dueSfx(st)}${notesSfx(st)}${delegateSfx(st.id, st.assignee)}`,
                );
              }
            }
          }
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private formatDigestOrWeeklyReport(
    type: 'digest' | 'weekly',
    data: NonNullable<ReportResult['data']>,
  ): string {
    const completedCount = type === 'digest'
      ? data.completed_today.length
      : (data.completed_week?.length ?? 0);
    const lines: string[] = [this.formatCompactBoard(completedCount, type)];
    const SEP = TaskflowEngine.SEP;
    const tz = this.boardTz;
    const taskLine = (
      task: { id: string; title: string; assignee_name?: string | null; due_date?: string; waiting_for?: string | null; column?: string; updated_at?: string },
      extras: string[] = [],
    ): string[] => {
      const assignee = task.assignee_name ? ` (${task.assignee_name})` : '';
      const first = `• *${task.id}*${assignee} — ${task.title}`;
      const more = [...extras];
      if (task.due_date) more.push(`⏰ ${task.due_date.slice(8, 10)}/${task.due_date.slice(5, 7)}`);
      if (task.waiting_for) more.push(`⏳ ${task.waiting_for}`);
      return [first, ...more.map((line) => `  ${line}`)];
    };
    const meetingLine = (meeting: { id: string; title: string; scheduled_at: string; participant_count: number }): string => {
      const when = utcToLocal(meeting.scheduled_at, tz);
      return `• *${meeting.id}* — ${meeting.title} (${when}) — ${meeting.participant_count} participante(s)`;
    };
    const staleExtras = (task: { column: string; updated_at: string }): string[] => [
      `🗂️ Coluna: ${task.column}`,
      `🕒 Última atualização: ${task.updated_at.slice(0, 10)}`,
    ];
    const renderStaleTasks = (
      staleTasks: Array<{ id: string; title: string; assignee_name?: string | null; column: string; updated_at: string }>,
      label: string,
    ): void => {
      lines.push('', `*${label}*`);
      if (staleTasks.length < 3) {
        for (const task of staleTasks) lines.push(...taskLine(task, staleExtras(task)));
      } else {
        const byPerson = new Map<string, number>();
        for (const t of staleTasks) {
          const name = t.assignee_name ?? 'Sem responsável';
          byPerson.set(name, (byPerson.get(name) ?? 0) + 1);
        }
        const summary = [...byPerson.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => `${count} de ${name}`)
          .join(', ');
        lines.push(`_${staleTasks.length} tarefas paradas: ${summary}_`);
      }
    };

    if (type === 'digest') {
      /* ====== SECTION 1: Celebration — lead with wins ====== */
      const streak = (data as any).completion_streak ?? 0;
      const yesterdayCount = (data as any).completed_yesterday_count ?? 0;

      if (completedCount > 0) {
        // Get board owner name to attribute unassigned tasks
        const ownerRow = this.db
          .prepare(
            `SELECT bp.name FROM board_admins ba JOIN board_people bp
             ON bp.board_id = ba.board_id AND bp.person_id = ba.person_id
             WHERE ba.board_id = ? AND ba.admin_role = 'manager' LIMIT 1`,
          )
          .get(this.boardId) as { name: string } | undefined;
        const ownerName = ownerRow?.name ?? 'Gestor';

        lines.push('', SEP, `🎉 *${completedCount} tarefa(s) concluída(s) hoje!*`, SEP);

        // Per-person recognition (attribute unassigned to board owner)
        const byPerson = new Map<string, number>();
        for (const t of data.completed_today) {
          const name = t.assignee_name ?? ownerName;
          byPerson.set(name, (byPerson.get(name) ?? 0) + 1);
        }
        // Show per-person summary (no individual task list — the motivational message covers the narrative)
        for (const [name, count] of [...byPerson.entries()].sort((a, b) => b[1] - a[1])) {
          lines.push(`  👤 ${name}: ${count} concluída(s)`);
        }
      } else {
        lines.push('', SEP, '📊 *Resumo do Dia*', SEP);
      }

      // Streak — only show when today has completions (otherwise streak counts past days)
      if (streak >= 2 && completedCount > 0) {
        lines.push(``, `🔥 *${streak}º dia consecutivo com entregas!*`);
      }
      // Daily comparison
      if (completedCount > 0 && yesterdayCount > 0) {
        const diff = completedCount - yesterdayCount;
        if (diff > 0) lines.push(`📈 +${diff} em relação a ontem`);
        else if (diff < 0) lines.push(`📉 ${diff} em relação a ontem`);
      }

      /* ====== SECTION 2: Momentum — what's in flight ====== */
      lines.push('', '*📌 Momentum:*');
      lines.push(`• ${data.in_progress.length} em andamento`);
      lines.push(`• ${data.changes_today_count} movimentações hoje`);

      /* ====== SECTION 3: Meetings (tomorrow) ====== */
      const meetings48h = (data.upcoming_meetings ?? []).filter((meeting) => {
        const delta = new Date(meeting.scheduled_at).getTime() - Date.now();
        return delta >= 0 && delta <= 48 * 60 * 60 * 1000;
      });
      if (meetings48h.length > 0) {
        lines.push('', '*📅 Próximas reuniões:*');
        for (const meeting of meetings48h.slice(0, 5)) {
          lines.push(meetingLine(meeting));
        }
      }

      /* No pendências, overdue, stale, or priority suggestions in the
       * evening digest — this is the last message before closing work.
       * Operational pressure belongs in the morning standup. */

      return lines.join('\n');
    }

    /* ====== SECTION 1: Week headline — celebration ====== */
    const completedWeekCount = data.completed_week?.length ?? 0;
    const streak = (data as any).completion_streak ?? 0;

    if (data.stats) {
      const trendEmoji = data.stats.trend === 'up' ? '📈' : data.stats.trend === 'down' ? '📉' : '➡️';
      const trendWord = data.stats.trend === 'up' ? 'acima' : data.stats.trend === 'down' ? 'abaixo' : 'igual';
      lines.push('', SEP, `🏆 *Revisão Semanal*`, SEP);
      lines.push(``, `*${completedWeekCount} tarefa(s) concluída(s)* esta semana ${trendEmoji} (${trendWord} da semana anterior)`);
      // Created vs completed ratio
      if (completedWeekCount > 0 || data.stats.created_week > 0) {
        const net = completedWeekCount - data.stats.created_week;
        if (net > 0) {
          lines.push(`✨ Backlog reduziu: ${net} tarefa(s) a menos que no início da semana`);
        } else if (net < 0) {
          lines.push(`📥 Backlog cresceu: ${Math.abs(net)} tarefa(s) a mais que no início`);
        } else {
          lines.push(`⚖️ Equilíbrio: mesma quantidade criada e concluída`);
        }
      }
      lines.push(`📊 ${data.stats.total_active} tarefa(s) ativas no quadro`);
    } else {
      lines.push('', SEP, '🏆 *Revisão Semanal*', SEP);
    }

    if (streak >= 3) {
      lines.push(``, `🔥 *${streak} dias consecutivos com entregas!*`);
    }

    /* ====== SECTION 2: Team recognition ====== */
    if (data.per_person.length > 0) {
      const withCompletions = data.per_person
        .filter((p) => (p.completed_week ?? 0) > 0)
        .sort((a, b) => (b.completed_week ?? 0) - (a.completed_week ?? 0));
      if (withCompletions.length > 0) {
        lines.push('', '*👥 Destaques da equipe:*');
        for (const person of withCompletions) {
          lines.push(`  🌟 *${person.name}*: ${person.completed_week} concluída(s)`);
        }
      }
    }

    /* ====== SECTION 3: Completed this week ====== */
    if (data.completed_week && data.completed_week.length > 0) {
      lines.push('', '*✅ Concluídas na semana:*');
      for (const task of data.completed_week) lines.push(...taskLine(task));
    }

    /* ====== SECTION 4: Operational — what needs attention ====== */
    const hasOperational = (data.inbox?.length ?? 0) > 0
      || (data.waiting_5d?.length ?? 0) > 0
      || data.overdue.length > 0
      || (data.stale_tasks?.length ?? 0) > 0;

    if (hasOperational) {
      lines.push('', SEP, '🔧 *Atenção necessária*', SEP);
      if (data.inbox && data.inbox.length > 0) {
        lines.push('', '*📥 Inbox para processar:*');
        for (const task of data.inbox.slice(0, 10)) lines.push(...taskLine(task));
      }
      if (data.overdue.length > 0) {
        lines.push('', '*⚠️ Em atraso:*');
        for (const task of data.overdue) lines.push(...taskLine(task));
      }
      if (data.waiting_5d && data.waiting_5d.length > 0) {
        lines.push('', '*⏳ Aguardando 5+ dias:*');
        for (const task of data.waiting_5d.slice(0, 10)) lines.push(...taskLine(task));
      }
      if (data.stale_tasks && data.stale_tasks.length > 0) {
        renderStaleTasks(data.stale_tasks, '💤 Sem atualização (3d+):');
      }
    }

    /* ====== SECTION 5: Upcoming ====== */
    if (data.next_week_deadlines && data.next_week_deadlines.length > 0) {
      lines.push('', '*🗓️ Próximos prazos:*');
      for (const task of data.next_week_deadlines.slice(0, 10)) lines.push(...taskLine(task));
    }
    if (data.upcoming_meetings && data.upcoming_meetings.length > 0) {
      lines.push('', '*📅 Próximas reuniões:*');
      for (const meeting of data.upcoming_meetings.slice(0, 7)) {
        lines.push(meetingLine(meeting));
      }
    }
    if (data.meetings_with_open_minutes && data.meetings_with_open_minutes.length > 0) {
      lines.push('', '*📝 Reuniões com ata pendente:*');
      for (const meeting of data.meetings_with_open_minutes) {
        lines.push(`• *${meeting.id}* — ${meeting.title} (${meeting.open_count} item(ns) aberto(s))`);
      }
    }

    /* ====== SECTION 6: Full team summary ====== */
    if (data.per_person.length > 0) {
      lines.push('', '*👥 Resumo por pessoa:*');
      for (const person of data.per_person) {
        const parts = [
          `${person.in_progress} em andamento`,
          `${person.waiting} aguardando`,
        ];
        if (person.completed_week != null) parts.push(`${person.completed_week} concluída(s)`);
        lines.push(`• *${person.name}* — ${parts.join(' • ')}`);
      }
    }

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
              `SELECT t.*, pt.title AS parent_title
               FROM tasks t
               LEFT JOIN tasks pt ON pt.board_id = t.board_id AND pt.id = t.parent_task_id
               WHERE ${this.visibleTaskScope('t')} AND t.assignee = ? AND t.column = 'waiting'
               ORDER BY t.id`,
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
              `SELECT t.*, pt.title AS parent_title
               FROM tasks t
               LEFT JOIN tasks pt ON pt.board_id = t.board_id AND pt.id = t.parent_task_id
               WHERE ${this.visibleTaskScope('t')} AND t.assignee = ? AND t.column = 'review'
               ORDER BY t.id`,
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
          const escapedText = params.search_text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
          const pattern = `%${escapedText}%`;
          const textMatches = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
               ORDER BY id`,
            )
            .all(...this.visibleTaskParams(), pattern, pattern) as any[];
          /* Also try resolving search_text as a task ID (raw or prefixed) */
          const idMatch = this.getTask(params.search_text);

          /* Semantic ranking — engine owns all ranking logic.
             The MCP handler embeds the query text (async) and injects both
             query_vector and an EmbeddingReader instance. The engine does
             the ranking (sync). Same reader pattern as buildContextSummary. */
          if (params.query_vector && params.embedding_reader) {
            try {
              const collection = `tasks:${this.boardId}`;
              const semanticResults = params.embedding_reader.search(
                collection, params.query_vector, { limit: 20, threshold: 0.3 },
              );

              if (semanticResults.length > 0) {
                // Use composite key (board_id:id) to avoid collision between
                // local and delegated tasks that share the same raw ID
                const scored = new Map<string, { task: any; score: number }>();
                for (const task of textMatches) {
                  scored.set(`${task.board_id}:${task.id}`, { task, score: 0.2 });
                }
                for (const sem of semanticResults) {
                  // Look up task first to get correct board_id for composite key
                  // (delegated tasks have a different board_id than this.boardId)
                  const task = this.getTask(sem.itemId);
                  if (!task) continue;
                  const compositeKey = `${task.board_id}:${task.id}`;
                  const existing = scored.get(compositeKey);
                  if (existing) {
                    existing.score += sem.score;
                  } else {
                    scored.set(compositeKey, { task, score: sem.score });
                  }
                }
                const ranked = [...scored.values()]
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 20)
                  .map(r => r.task);

                if (idMatch && !ranked.some((t: any) => t.id === idMatch.id && t.board_id === idMatch.board_id)) {
                  return { success: true, data: [idMatch, ...ranked] };
                }
                return { success: true, data: ranked };
              }
            } catch {
              // EmbeddingReader not available — fallback to lexical only
            }
          }

          if (idMatch && !textMatches.some((t: any) => t.id === idMatch.id && t.board_id === idMatch.board_id)) {
            return { success: true, data: [idMatch, ...textMatches] };
          }
          return { success: true, data: textMatches };
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
          const history = this.getHistory(task.id, 5, this.taskBoardId(task));
          const data: any = { task, recent_history: history };
          // Include subtask rows for project tasks
          if (task.type === 'project') {
            data.subtask_rows = this.getSubtaskRows(task.id, this.taskBoardId(task));
          }
          // Include parent project info for subtasks — always use the subtask's owning board
          // to avoid picking up a same-ID task from the local board.
          if (task.parent_task_id) {
            const parentBoardId = this.taskBoardId(task);
            const parent = this.db.prepare(TaskflowEngine.TASK_BY_BOARD_SQL).get(parentBoardId, task.parent_task_id) as any ?? null;
            if (parent) {
              data.parent_project = { id: parent.id, title: parent.title, column: parent.column };
            }
          }
          // Include external participants for meetings
          if (task.type === 'meeting') {
            data.external_participants = this.getActiveExternalParticipants(this.taskBoardId(task), task.id);
          }
          // Include delegation chain when assignee is not on this board
          if (task.assignee) {
            const isLocal = !!this.db
              .prepare(`SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?`)
              .get(this.boardId, task.assignee);
            if (!isLocal) {
              const chain: Array<{ person_id: string; name: string }> = [];
              const reassigns = this.db
                .prepare(
                  `SELECT details FROM task_history
                   WHERE board_id = ? AND task_id = ? AND action = 'reassigned'
                   ORDER BY at ASC`,
                )
                .all(this.taskBoardId(task), task.id) as Array<{ details: string }>;
              for (const h of reassigns) {
                try {
                  const d = JSON.parse(h.details);
                  if (d.from_assignee && chain.length === 0) {
                    const n = this.db.prepare(`SELECT name FROM board_people WHERE person_id = ? LIMIT 1`).get(d.from_assignee) as { name: string } | undefined;
                    chain.push({ person_id: d.from_assignee, name: n?.name ?? d.from_assignee });
                  }
                  if (d.to_assignee) {
                    const n = this.db.prepare(`SELECT name FROM board_people WHERE person_id = ? LIMIT 1`).get(d.to_assignee) as { name: string } | undefined;
                    chain.push({ person_id: d.to_assignee, name: n?.name ?? d.to_assignee });
                  }
                } catch {}
              }
              if (chain.length > 0) {
                data.delegation_chain = chain;
              }
            }
          }
          return { success: true, data };
        }

        case 'task_history': {
          const task = this.requireTask(params.task_id);
          const history = this.getHistory(task.id, undefined, this.taskBoardId(task));
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
          const escapedArchText = params.search_text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
          const archPattern = `%${escapedArchText}%`;
          const rows = this.db
            .prepare(
              `SELECT * FROM archive
               WHERE board_id = ? AND title LIKE ? ESCAPE '\\'
               ORDER BY archived_at DESC`,
            )
            .all(this.boardId, archPattern);
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

        /* ---------- Meetings ---------- */

        case 'meetings': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
               ORDER BY scheduled_at, id`,
            )
            .all(...this.visibleTaskParams());
          return { success: true, data: tasks };
        }

        case 'meeting_agenda': {
          if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
          const task = this.requireTask(params.task_id);
          if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
          const notes: Array<any> = JSON.parse(task.notes ?? '[]');
          const preNotes = notes.filter((n: any) => n.phase === 'pre');
          const topLevel = preNotes.filter((n: any) => !n.parent_note_id);
          const replyMap = new Map<number, any[]>();
          for (const n of preNotes.filter((r: any) => r.parent_note_id)) {
            const arr = replyMap.get(n.parent_note_id) ?? [];
            arr.push(n);
            replyMap.set(n.parent_note_id, arr);
          }
          const agenda = topLevel.map((n: any) => ({
            ...n,
            replies: replyMap.get(n.id) ?? [],
          }));
          return { success: true, data: agenda };
        }

        case 'meeting_minutes': {
          if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
          const task = this.requireTask(params.task_id);
          if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
          const notes: Array<any> = JSON.parse(task.notes ?? '[]');
          const formatted = this.formatMeetingMinutes(task, notes);
          return { success: true, data: { task, notes }, formatted };
        }

        case 'upcoming_meetings': {
          const nowIso = new Date().toISOString();
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
                 AND scheduled_at IS NOT NULL AND scheduled_at >= ?
               ORDER BY scheduled_at ASC`,
            )
            .all(...this.visibleTaskParams(), nowIso);
          return { success: true, data: tasks };
        }

        case 'meeting_participants': {
          if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
          const task = this.requireTask(params.task_id);
          if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
          const owningBoard = this.taskBoardId(task);
          const participantIds: string[] = JSON.parse(task.participants ?? '[]');
          const organizerRow = task.assignee
            ? this.db.prepare(`SELECT person_id, name, role FROM board_people WHERE board_id = ? AND person_id = ?`).get(owningBoard, task.assignee) as any
            : null;
          const people = participantIds.length === 0
            ? []
            : this.db
                .prepare(`SELECT person_id, name, role FROM board_people WHERE board_id = ? AND person_id IN (${participantIds.map(() => '?').join(',')})`)
                .all(owningBoard, ...participantIds) as Array<{ person_id: string; name: string; role: string }>;
          const externalParticipants = this.getActiveExternalParticipants(owningBoard, task.id);
          return {
            success: true,
            data: {
              organizer: organizerRow ?? { person_id: task.assignee, name: task.assignee },
              participants: people,
              external_participants: externalParticipants,
            },
          };
        }

        case 'meeting_open_items': {
          if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
          const task = this.requireTask(params.task_id);
          if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
          const notes: Array<any> = JSON.parse(task.notes ?? '[]');
          const openItems = notes.filter((n: any) => n.status === 'open');
          return { success: true, data: openItems };
        }

        case 'meeting_history': {
          if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
          const task = this.requireTask(params.task_id);
          const history = this.getHistory(task.id, undefined, this.taskBoardId(task));
          return { success: true, data: history };
        }

        case 'meeting_minutes_at': {
          if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
          if (!params.at) return { success: false, error: 'Missing required parameter: at (YYYY-MM-DD)' };
          const mTask = this.requireTask(params.task_id);
          const occurrences = this.getHistory(mTask.id, undefined, this.taskBoardId(mTask))
            .filter((h: any) => h.action === 'meeting_occurrence_archived');

          for (const row of occurrences) {
            try {
              const details = JSON.parse(row.details ?? '{}');
              const snapshot = details.snapshot;
              const snapshotDate = (snapshot?.scheduled_at ?? '').slice(0, 10);
              if (snapshotDate === params.at) {
                return { success: true, data: snapshot, formatted: this.formatMeetingMinutes(snapshot, JSON.parse(snapshot.notes ?? '[]')) };
              }
            } catch { /* skip malformed */ }
          }

          // Fallback: check current task if date matches
          if (mTask.scheduled_at?.startsWith(params.at)) {
            const notes = JSON.parse(mTask.notes ?? '[]');
            return { success: true, data: mTask, formatted: this.formatMeetingMinutes(mTask, notes) };
          }

          return { success: false, error: `No meeting occurrence found for ${params.task_id} on ${params.at}` };
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
          `SELECT id, title, board_id, _last_mutation FROM tasks
           WHERE ${this.visibleTaskScope()} AND _last_mutation IS NOT NULL
           ORDER BY json_extract(_last_mutation, '$.at') DESC LIMIT 1`,
        )
        .get(...this.visibleTaskParams()) as
        | { id: string; title: string; board_id: string; _last_mutation: string }
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

      /* --- 5. WIP guard: if restoring to in_progress, check WIP limit (meetings exempt) --- */
      /* Two cases need WIP check:
         (a) snapshot.column === 'in_progress' — move undo returns task to in_progress
         (b) snapshot has assignee but no column — reassign undo, task may already be in_progress */
      {
        const task = this.getTask(taskId);
        const restoredColumn = snapshot?.column;
        const restoredAssignee = snapshot?.assignee;
        const needsWipCheck =
          restoredColumn === 'in_progress' ||
          (restoredColumn === undefined && restoredAssignee !== undefined && task?.column === 'in_progress');
        const assigneeToCheck = restoredAssignee ?? task?.assignee;
        if (needsWipCheck && assigneeToCheck && task?.type !== 'meeting') {
          const wip = this.checkWipLimit(assigneeToCheck);
          if (!wip.ok) {
            if (!params.force) {
              return {
                success: false,
                error: `WIP limit exceeded for ${wip.person_name}: ${wip.current} in progress (limit: ${wip.limit}). Use force (forcar) to override.`,
              };
            }
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
        title: latestRow.title,
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
      const isExternalInviteAccept = params.action === 'accept_external_invite';
      if (params.action === 'process_inbox') {
        if (!this.isManagerOrDelegate(params.sender_name)) {
          return {
            success: false,
            error: `Permission denied: "${params.sender_name}" is not a manager or delegate.`,
          };
        }
      } else if (isExternalInviteAccept) {
        if (!params.sender_external_id) {
          return { success: false, error: 'Missing sender_external_id' };
        }
        // No manager check — action-specific grant validation happens in the case body
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

          /* Refresh linked parent rollup */
          this.refreshLinkedParentRollup(task, this.taskBoardId(task), params.sender_name);

          /* Notify on cancellation */
          const cancelNotifications: AdminResult['notifications'] = [];
          const senderPerson = this.resolvePerson(params.sender_name);
          const senderPersonId = senderPerson?.person_id ?? null;
          const cancelTaskBoard = task.board_id ?? this.boardId;
          if (task.type === 'meeting') {
            for (const recipient of this.meetingNotificationRecipients(task)) {
              if (senderPersonId && recipient.target_person_id === senderPersonId) continue;
              const vb = recipient.target_person_id ? this.resolveViewerBoard(recipient.target_person_id, cancelTaskBoard) : cancelTaskBoard;
              cancelNotifications.push({
                ...recipient,
                message: `📅 Reunião ${this.displayId(task, vb)} "${task.title}" foi cancelada.`,
              });
            }
          } else if (task.assignee && senderPersonId) {
            const cancelLabel = task.type === 'project' ? 'Projeto cancelado'
              : task.type === 'recurring' ? 'Tarefa recorrente cancelada'
              : 'Tarefa cancelada';
            const target = this.resolveNotifTarget(task.assignee, senderPersonId);
            if (target) {
              const vb = this.resolveViewerBoard(target.target_person_id, cancelTaskBoard);
              const modName = this.personDisplayName(senderPersonId);
              cancelNotifications.push({
                ...target,
                message: `🔔 *${cancelLabel}*\n\n*${this.displayId(task, vb)}* — ${task.title}\n*Por:* ${modName}`,
              });
            }
          }

          return {
            success: true,
            data: { cancelled: task.id, title: task.title },
            ...(cancelNotifications.length > 0 ? { notifications: cancelNotifications } : {}),
          };
        }

        /* ---- restore_task ---- */
        case 'restore_task': {
          if (!params.task_id) {
            return { success: false, error: 'Missing required parameter: task_id' };
          }

          const { boardId: resolvedBoard, rawId: resolvedId } = this.resolveInputTaskId(params.task_id);
          if (resolvedBoard && resolvedBoard !== this.boardId) {
            return { success: false, error: `Cannot restore tasks from another board. ${params.task_id} belongs to a different board.` };
          }
          const archived = this.db
            .prepare(
              `SELECT * FROM archive WHERE board_id = ? AND task_id = ?`,
            )
            .get(this.boardId, resolvedId) as any;

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
              _last_mutation: null,   // clear stale pre-cancellation mutation to prevent undo from reverting it
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
            .run(this.boardId, resolvedId);

          /* Record history */
          this.recordHistory(resolvedId, 'restored', params.sender_name);

          /* Refresh linked parent rollup */
          const restoredTask = this.db.prepare('SELECT * FROM tasks WHERE board_id = ? AND id = ?').get(this.boardId, resolvedId) as any;
          if (restoredTask) {
            this.refreshLinkedParentRollup(restoredTask, this.boardId, params.sender_name);
          }

          return {
            success: true,
            data: { restored: resolvedId, title: archived.title, column: snapshot.column ?? 'inbox' },
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

        case 'process_minutes': {
          const task = this.requireTask(params.task_id);
          if (task.type !== 'meeting') {
            return { success: false, error: `Task ${params.task_id} is not a meeting.` };
          }
          const notes: Array<any> = JSON.parse(task.notes ?? '[]');
          const openItems = notes.filter((n: any) => n.status === 'open');

          const grouped: Array<{ item: any; replies: any[] }> = [];
          const topLevel = openItems.filter((n: any) => !n.parent_note_id);
          for (const item of topLevel) {
            const replies = openItems.filter((n: any) => n.parent_note_id === item.id);
            grouped.push({ item, replies });
          }
          const coveredIds = new Set(grouped.flatMap((g) => [g.item.id, ...g.replies.map((r: any) => r.id)]));
          const orphans = openItems.filter((n: any) => !coveredIds.has(n.id));
          for (const o of orphans) grouped.push({ item: o, replies: [] });

          return {
            success: true,
            data: { open_items: openItems, grouped },
          };
        }

        case 'process_minutes_decision': {
          const task = this.requireTask(params.task_id);
          if (task.type !== 'meeting') {
            return { success: false, error: `Task ${params.task_id} is not a meeting.` };
          }
          if (params.note_id == null) {
            return { success: false, error: 'Missing required parameter: note_id' };
          }
          if (!params.decision) {
            return { success: false, error: 'Missing required parameter: decision' };
          }
          if (!params.create) {
            return { success: false, error: 'Missing required parameter: create' };
          }

          const notes: Array<any> = JSON.parse(task.notes ?? '[]');
          const note = notes.find((n: any) => n.id === params.note_id);
          if (!note) {
            return { success: false, error: `Note #${params.note_id} not found.` };
          }
          if (note.status !== 'open') {
            return { success: false, error: `Note #${params.note_id} is already processed (status: ${note.status}).` };
          }

          const now = new Date().toISOString();

          const createResult = this.createTaskInternal({
            board_id: this.boardId,
            type: params.create!.type as any,
            title: params.create!.title,
            assignee: params.create!.assignee,
            labels: params.create!.labels,
            sender_name: params.sender_name,
          });

          if (!createResult.success) {
            const errorMsg = createResult.error
              ?? (createResult as any).offer_register?.message
              ?? 'Unknown error creating task from meeting note';
            throw new Error(`Failed to create task: ${errorMsg}`);
          }

          note.status = params.decision === 'create_task' ? 'task_created' : 'inbox_created';
          note.processed_at = now;
          note.processed_by = params.sender_name;
          note.created_task_id = createResult.task_id;

          this.db
            .prepare(`UPDATE tasks SET notes = ?, _last_mutation = NULL WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(notes), this.taskBoardId(task), task.id);

          const resultNotifications = createResult.notifications ?? [];
          return {
            success: true,
            data: { created_task_id: createResult.task_id, note_id: params.note_id },
            ...(resultNotifications.length > 0 ? { notifications: resultNotifications } : {}),
          };
        }

        case 'accept_external_invite': {
          if (!params.task_id) return { success: false, error: 'Missing task_id' };
          if (!params.sender_external_id) return { success: false, error: 'Missing sender_external_id' };

          const task = this.requireTask(params.task_id);
          if (task.type !== 'meeting') return { success: false, error: 'Not a meeting task.' };

          const acceptNow = new Date().toISOString();
          const grant = this.db.prepare(
            `SELECT rowid, invite_status FROM meeting_external_participants
             WHERE board_id = ? AND meeting_task_id = ? AND external_id = ?
               AND invite_status IN ('pending', 'invited')
               AND (access_expires_at IS NULL OR access_expires_at >= ?)
             ORDER BY occurrence_scheduled_at DESC LIMIT 1`
          ).get(this.boardId, task.id, params.sender_external_id, acceptNow) as any;

          if (!grant) return { success: false, error: 'No pending invite found for this meeting.' };

          this.db.prepare(
            `UPDATE meeting_external_participants
             SET invite_status = 'accepted', accepted_at = ?, updated_at = ?
             WHERE rowid = ?`
          ).run(acceptNow, acceptNow, grant.rowid);

          this.db.prepare(
            `INSERT INTO task_history (board_id, task_id, action, by, at, details)
             VALUES (?, ?, 'external_invite_accepted', ?, ?, ?)`
          ).run(this.boardId, task.id, params.sender_external_id, acceptNow, 'External participant accepted invite');

          return { success: true, message: `Convite aceito para ${task.id} — ${task.title}` };
        }

        /* ---- reparent_task ---- */
        case 'reparent_task': {
          if (!params.task_id) {
            return { success: false, error: 'Missing required parameter: task_id' };
          }
          if (!params.target_parent_id) {
            return { success: false, error: 'Missing required parameter: target_parent_id' };
          }

          const task = this.requireTask(params.task_id);
          const taskBoardId = this.taskBoardId(task);
          const now = new Date().toISOString();

          if (task.parent_task_id) {
            return { success: false, error: `Task ${task.id} is already a subtask of ${task.parent_task_id}.` };
          }

          const parent = this.requireTask(params.target_parent_id);
          if (parent.type !== 'project') {
            return { success: false, error: `Target ${params.target_parent_id} is not a project (type: ${parent.type}).` };
          }

          const parentBoardId = this.taskBoardId(parent);
          if (taskBoardId !== parentBoardId) {
            return { success: false, error: `Task ${task.id} and project ${parent.id} are on different boards.` };
          }

          const reparentSnapshot = JSON.stringify({
            action: 'reparented',
            by: params.sender_name,
            at: now,
            snapshot: { parent_task_id: task.parent_task_id },
          });

          this.db
            .prepare(`UPDATE tasks SET parent_task_id = ?, _last_mutation = ?, updated_at = ? WHERE board_id = ? AND id = ?`)
            .run(parent.id, reparentSnapshot, now, taskBoardId, task.id);

          this.recordHistory(task.id, 'reparented', params.sender_name,
            JSON.stringify({ parent_task_id: parent.id, parent_title: parent.title }),
            taskBoardId);

          this.recordHistory(parent.id, 'subtask_added', params.sender_name,
            JSON.stringify({ subtask_id: task.id, subtask_title: task.title }),
            parentBoardId);

          return {
            success: true,
            task_id: task.id,
            data: {
              parent_task_id: parent.id,
              parent_title: parent.title,
            },
          };
        }

        /* ---- detach_task ---- */
        case 'detach_task': {
          if (!params.task_id) {
            return { success: false, error: 'Missing required parameter: task_id' };
          }

          const task = this.requireTask(params.task_id);
          const taskBoardId = this.taskBoardId(task);
          const now = new Date().toISOString();

          if (!task.parent_task_id) {
            return { success: false, error: `Task ${task.id} is not a subtask — nothing to detach.` };
          }

          const parentId = task.parent_task_id;
          // Look up parent on the subtask's owning board to avoid same-ID collision on the local board
          const parent = this.db.prepare(TaskflowEngine.TASK_BY_BOARD_SQL).get(taskBoardId, parentId) as any;
          if (!parent) return { success: false, error: `Parent task ${parentId} not found on board ${taskBoardId}.` };

          const detachSnapshot = JSON.stringify({
            action: 'detached',
            by: params.sender_name,
            at: now,
            snapshot: { parent_task_id: task.parent_task_id },
          });

          this.db
            .prepare(`UPDATE tasks SET parent_task_id = NULL, _last_mutation = ?, updated_at = ? WHERE board_id = ? AND id = ?`)
            .run(detachSnapshot, now, taskBoardId, task.id);

          this.recordHistory(task.id, 'detached', params.sender_name,
            JSON.stringify({ from_parent: parentId, from_parent_title: parent.title }),
            taskBoardId);

          this.recordHistory(parentId, 'subtask_removed', params.sender_name,
            JSON.stringify({ subtask_id: task.id, subtask_title: task.title }),
            taskBoardId);

          return {
            success: true,
            task_id: task.id,
            data: {
              detached_from: parentId,
              detached_from_title: parent.title,
            },
          };
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
          `SELECT id, board_id, title, assignee, due_date FROM tasks
           WHERE ${this.visibleTaskScope()} AND due_date < ? AND column != 'done'
           ORDER BY due_date, id`,
        )
        .all(...this.visibleTaskParams(), todayStr) as Array<{ id: string; title: string; assignee: string | null; due_date: string }>;

      /* --- In-progress tasks --- */
      const inProgress = this.db
        .prepare(
          `SELECT id, board_id, title, assignee, type FROM tasks
           WHERE ${this.visibleTaskScope()} AND column = 'in_progress'
           ORDER BY id`,
        )
        .all(...this.visibleTaskParams()) as Array<{ id: string; title: string; assignee: string | null; type: string }>;

      /* --- Review tasks --- */
      const review = this.db
        .prepare(
          `SELECT id, board_id, title, assignee FROM tasks
           WHERE ${this.visibleTaskScope()} AND column = 'review'
           ORDER BY id`,
        )
        .all(...this.visibleTaskParams()) as Array<{ id: string; title: string; assignee: string | null }>;

      /* --- Due today --- */
      const dueToday = this.db
        .prepare(
          `SELECT id, board_id, title, assignee FROM tasks
           WHERE ${this.visibleTaskScope()} AND due_date = ? AND column != 'done'
           ORDER BY id`,
        )
        .all(...this.visibleTaskParams(), todayStr) as Array<{ id: string; title: string; assignee: string | null }>;

      /* --- Due in next 48h (digest) / next week (weekly) --- */
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().slice(0, 10);
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const nextWeekStr = nextWeek.toISOString().slice(0, 10);

      let next48h: Array<{ id: string; title: string; assignee: string | null; due_date: string }> = [];
      let nextWeekDeadlines: Array<{ id: string; title: string; assignee: string | null; due_date: string }> = [];
      if (isDigestOrWeekly) {
        next48h = this.db
          .prepare(
            `SELECT id, board_id, title, assignee, due_date FROM tasks
             WHERE ${this.visibleTaskScope()} AND due_date >= ? AND due_date <= ? AND column != 'done'
             ORDER BY due_date, id`,
          )
          .all(...this.visibleTaskParams(), todayStr, tomorrowStr) as typeof next48h;
      }
      if (isWeekly) {
        nextWeekDeadlines = this.db
          .prepare(
            `SELECT id, board_id, title, assignee, due_date FROM tasks
             WHERE ${this.visibleTaskScope()} AND due_date >= ? AND due_date <= ? AND column != 'done'
             ORDER BY due_date, id`,
          )
          .all(...this.visibleTaskParams(), todayStr, nextWeekStr) as typeof nextWeekDeadlines;
      }

      /* --- Waiting tasks (exclude delegated tasks where the child board has active work — rollups manage their status) --- */
      const waiting = this.db
        .prepare(
          `SELECT id, board_id, title, assignee, waiting_for, type, updated_at FROM tasks
           WHERE ${this.visibleTaskScope()} AND column = 'waiting'
             ${TaskflowEngine.excludeActiveRollup()}
           ORDER BY id`,
        )
        .all(...this.visibleTaskParams()) as Array<{ id: string; title: string; assignee: string | null; waiting_for: string | null; type: string; updated_at: string }>;

      let waiting5d: Array<{ id: string; title: string; assignee: string | null; waiting_for: string | null; updated_at: string }> = [];
      if (isWeekly) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 5);
        const cutoffIso = cutoff.toISOString();
        waiting5d = waiting
          .filter((t) => t.updated_at < cutoffIso)
          .map((t) => ({
            id: t.id,
            title: t.title,
            assignee: t.assignee,
            waiting_for: t.waiting_for,
            updated_at: t.updated_at,
          }));
      }

      /* --- Blocked tasks (digest + weekly) --- */
      let blocked: Array<{ id: string; title: string; assignee: string | null; blocked_by_raw: string }> = [];
      if (isDigestOrWeekly) {
        blocked = this.db
          .prepare(
            `SELECT id, board_id, title, assignee, blocked_by AS blocked_by_raw FROM tasks
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
             WHERE board_id = ? AND ${this.completionHistoryWhere()}
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

      /* --- Completion streak: consecutive days with at least one completion --- */
      let completionStreak = 0;
      if (isDigestOrWeekly) {
        const checkDate = new Date();
        // If no completions today yet, start from yesterday
        if (completedToday.length === 0) {
          checkDate.setDate(checkDate.getDate() - 1);
        }
        for (let i = 0; i < 30; i++) {
          const dayStr = checkDate.toISOString().slice(0, 10);
          const dayRow = this.db
            .prepare(
              `SELECT COUNT(DISTINCT task_id) AS cnt FROM task_history
               WHERE board_id = ? AND ${this.completionHistoryWhere()}
                 AND at LIKE ?`,
            )
            .get(this.boardId, `${dayStr}%`) as { cnt: number };
          if (dayRow.cnt > 0) {
            completionStreak++;
            checkDate.setDate(checkDate.getDate() - 1);
          } else {
            break;
          }
        }
      }

      /* --- Yesterday's completions (for daily comparison) --- */
      let completedYesterdayCount = 0;
      if (isDigestOrWeekly) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        const ydRow = this.db
          .prepare(
            `SELECT COUNT(DISTINCT task_id) AS cnt FROM task_history
             WHERE board_id = ? AND ${this.completionHistoryWhere()}
               AND at LIKE ?`,
          )
          .get(this.boardId, `${yesterdayStr}%`) as { cnt: number };
        completedYesterdayCount = ydRow.cnt;
      }

      /* --- Helper: batch-resolve task details from IDs (tasks + archive fallback).
       *  Uses board_id = this.boardId (not visibleTaskScope) because the source IDs
       *  come from task_history scoped to this board — avoids collisions with
       *  delegated tasks that share an ID. --- */
      const resolveTaskDetails = (
        ids: Array<{ task_id: string }>,
      ): Array<{ id: string; title: string; assignee: string | null }> => {
        if (ids.length === 0) return [];
        const taskIds = ids.map((r) => r.task_id);
        const placeholders = taskIds.map(() => '?').join(',');
        const active = this.db
          .prepare(
            `SELECT id, title, assignee FROM tasks
             WHERE board_id = ? AND id IN (${placeholders})`,
          )
          .all(this.boardId, ...taskIds) as Array<{ id: string; title: string; assignee: string | null }>;
        const found = new Set(active.map((t) => t.id));
        const missing = taskIds.filter((id) => !found.has(id));
        let archived: Array<{ id: string; title: string; assignee: string | null }> = [];
        if (missing.length > 0) {
          const archPlaceholders = missing.map(() => '?').join(',');
          archived = this.db
            .prepare(
              `SELECT task_id AS id, title, assignee FROM archive
               WHERE board_id = ? AND task_id IN (${archPlaceholders})`,
            )
            .all(this.boardId, ...missing) as typeof archived;
        }
        return [...active, ...archived];
      };

      /* --- Resolve completed_today task details --- */
      const completedTodayTasks = isDigestOrWeekly ? resolveTaskDetails(completedToday) : [];

      let completedWeekTasks: Array<{ id: string; title: string; assignee: string | null }> = [];
      if (isWeekly) {
        const completedWeekIds = this.db
          .prepare(
            `SELECT DISTINCT task_id FROM task_history
             WHERE board_id = ? AND ${this.completionHistoryWhere()}
               AND at >= ?
             ORDER BY task_id`,
          )
          .all(this.boardId, weekStart()) as Array<{ task_id: string }>;
        completedWeekTasks = resolveTaskDetails(completedWeekIds);
      }

      let stale24h: Array<{ id: string; title: string; assignee: string | null; column: string; updated_at: string }> = [];
      if (isDigestOrWeekly) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 1);
        const cutoffIso = cutoff.toISOString();
        stale24h = this.db
          .prepare(
            `SELECT id, board_id, title, assignee, column, updated_at FROM tasks
             WHERE ${this.visibleTaskScope()} AND column IN ('next_action', 'in_progress', 'review')
               ${TaskflowEngine.excludeActiveRollup()}
               AND updated_at < ?
             ORDER BY updated_at ASC`,
          )
          .all(...this.visibleTaskParams(), cutoffIso) as typeof stale24h;
      }

      let inboxTasks: Array<{ id: string; title: string; assignee: string | null }> = [];
      if (isWeekly) {
        inboxTasks = this.db
          .prepare(
            `SELECT id, board_id, title, assignee FROM tasks
             WHERE ${this.visibleTaskScope()} AND column = 'inbox'
             ORDER BY id`,
          )
          .all(...this.visibleTaskParams()) as typeof inboxTasks;
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
             WHERE th.board_id = ? AND ${this.completionHistoryWhere('th')}
               AND th.at >= ?
             UNION
             SELECT th.task_id, a.assignee FROM task_history th
             LEFT JOIN archive a ON a.board_id = th.board_id AND a.task_id = th.task_id
             WHERE th.board_id = ? AND ${this.completionHistoryWhere('th')}
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
        /* Exclude meetings from per-person counts to match WIP limit semantics
           (meetings are shown in their own upcoming_meetings / open_minutes sections) */
        const ipCount = inProgress.filter((t) => t.assignee === person.person_id && t.type !== 'meeting').length;
        const wCount = waiting.filter((t) => t.assignee === person.person_id && t.type !== 'meeting').length;
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
             WHERE board_id = ? AND ${this.completionHistoryWhere()}
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
             WHERE board_id = ? AND ${this.completionHistoryWhere()}
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

      /* --- Stale tasks: no update 3+ days (weekly only, exclude delegated tasks with active child-board work) --- */
      let staleTasks: Array<{ id: string; title: string; assignee: string | null; column: string; updated_at: string }> = [];
      if (isWeekly) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 3);
        const cutoffIso = cutoff.toISOString();
        staleTasks = this.db
          .prepare(
            `SELECT id, board_id, title, assignee, column, updated_at FROM tasks
             WHERE ${this.visibleTaskScope()} AND column IN ('next_action', 'in_progress', 'review')
               ${TaskflowEngine.excludeActiveRollup()}
               AND updated_at < ?
             ORDER BY updated_at ASC`,
          )
          .all(...this.visibleTaskParams(), cutoffIso) as typeof staleTasks;
      }

      /* --- Upcoming meetings (next 7 days) --- */
      const nowStr = new Date().toISOString();
      const sevenDaysFromNow = new Date(Date.now() + 7 * 86400000).toISOString();
      const upcomingMeetings = this.db
        .prepare(
          `SELECT id, title, scheduled_at, participants, assignee, board_id, board_id AS owning_board_id FROM tasks
           WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
             AND scheduled_at IS NOT NULL AND scheduled_at >= ? AND scheduled_at <= ?
           ORDER BY scheduled_at`,
        )
        .all(...this.visibleTaskParams(), nowStr, sevenDaysFromNow) as Array<{
          id: string; title: string; scheduled_at: string; participants: string | null; assignee: string | null; board_id: string; owning_board_id: string;
        }>;

      const upcomingMeetingsFormatted = upcomingMeetings.map((m) => {
        let pArr: string[] = [];
        try { pArr = m.participants ? JSON.parse(m.participants) : []; } catch { /* skip malformed */ }
        const organizerExtra = m.assignee && !pArr.includes(m.assignee) ? 1 : 0;
        return {
          board_id: m.board_id,
          owning_board_id: m.owning_board_id,
          id: m.id,
          title: m.title,
          scheduled_at: m.scheduled_at,
          participant_count: pArr.length > 0 ? pArr.length + organizerExtra : 1,
        };
      });

      /* --- Meetings with open minutes (past scheduled_at, has open notes) --- */
      const pastMeetings = this.db
        .prepare(
          `SELECT id, title, scheduled_at, notes, board_id, board_id AS owning_board_id FROM tasks
           WHERE ${this.visibleTaskScope()} AND type = 'meeting' AND column != 'done'
             AND scheduled_at IS NOT NULL AND scheduled_at < ?
           ORDER BY scheduled_at`,
        )
        .all(...this.visibleTaskParams(), nowStr) as Array<{
          id: string; title: string; scheduled_at: string; notes: string; board_id: string; owning_board_id: string;
        }>;

      const meetingsWithOpenMinutes: Array<{ id: string; title: string; scheduled_at: string; open_count: number; board_id: string; owning_board_id: string }> = [];
      for (const m of pastMeetings) {
        try {
          const notes = JSON.parse(m.notes ?? '[]');
          const open_count = notes.filter((n: any) => n.status === 'open').length;
          if (open_count > 0) {
            meetingsWithOpenMinutes.push({ id: m.id, title: m.title, scheduled_at: m.scheduled_at, open_count, board_id: m.board_id, owning_board_id: m.owning_board_id });
          }
        } catch { /* skip malformed notes */ }
      }

      /* --- Auto-archive old done tasks (standup housekeeping) --- */
      if (params.type === 'standup') {
        try { this.archiveOldDoneTasks(); } catch { /* cleanup failure must not break standup */ }
      }

      /* --- Formatted board for standup --- */
      const formatted_board =
        params.type === 'standup' ? this.formatBoardView('standup') : undefined;

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

      /* --- Assemble result --- */
      const reportData: NonNullable<ReportResult['data']> = {
          date: todayStr,
          ...(formatted_board ? { formatted_board } : {}),
          overdue: overdue.map((t) => ({
            id: dId(t),
            title: t.title,
            assignee_name: resolveName(t.assignee),
            due_date: t.due_date,
          })),
          ...(isDigestOrWeekly
            ? {
                next_48h: next48h.map((t) => ({
                  id: dId(t),
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                  due_date: t.due_date,
                })),
              }
            : {}),
          in_progress: inProgress.map((t) => ({
            id: dId(t),
            title: t.title,
            assignee_name: resolveName(t.assignee),
          })),
          review: review.map((t) => ({
            id: dId(t),
            title: t.title,
            assignee_name: resolveName(t.assignee),
          })),
          due_today: dueToday.map((t) => ({
            id: dId(t),
            title: t.title,
            assignee_name: resolveName(t.assignee),
          })),
          waiting: waiting.map((t) => ({
            id: dId(t),
            title: t.title,
            assignee_name: resolveName(t.assignee),
            waiting_for: t.waiting_for,
          })),
          ...(isWeekly
            ? {
                waiting_5d: waiting5d.map((t) => ({
                  id: dId(t),
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                  waiting_for: t.waiting_for,
                  updated_at: t.updated_at,
                })),
              }
            : {}),
          blocked: isDigestOrWeekly
            ? blocked.map((t) => {
                let blockedByIds: string[] = [];
                try {
                  blockedByIds = JSON.parse(t.blocked_by_raw);
                } catch {}
                return {
                  id: dId(t),
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                  blocked_by: blockedByIds,
                };
              })
            : [],
          completed_today: isDigestOrWeekly
            ? completedTodayTasks.map((t) => ({
                id: dId(t),
                title: t.title,
                assignee_name: resolveName(t.assignee),
              }))
            : [],
          ...(isWeekly
            ? {
                completed_week: completedWeekTasks.map((t) => ({
                  id: dId(t),
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                })),
              }
            : {}),
          ...(isDigestOrWeekly
            ? {
                stale_24h: stale24h.map((t) => ({
                  id: dId(t),
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                  column: t.column,
                  updated_at: t.updated_at,
                })),
              }
            : {}),
          ...(isWeekly
            ? {
                inbox: inboxTasks.map((t) => ({
                  id: dId(t),
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                })),
                next_week_deadlines: nextWeekDeadlines.map((t) => ({
                  id: dId(t),
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                  due_date: t.due_date,
                })),
              }
            : {}),
          changes_today_count: isDigestOrWeekly ? changesTodayCount : 0,
          completion_streak: isDigestOrWeekly ? completionStreak : 0,
          completed_yesterday_count: isDigestOrWeekly ? completedYesterdayCount : 0,
          per_person: perPerson,
          ...(isWeekly && stats ? { stats } : {}),
          ...(isWeekly && staleTasks.length > 0
            ? {
                stale_tasks: staleTasks.map((t) => ({
                  id: dId(t),
                  title: t.title,
                  assignee_name: resolveName(t.assignee),
                  column: t.column,
                  updated_at: t.updated_at,
                })),
              }
            : {}),
          upcoming_meetings: upcomingMeetingsFormatted.map((m) => ({
            ...m,
            id: dId(m),
          })),
          meetings_with_open_minutes: meetingsWithOpenMinutes.map((m) => ({
            ...m,
            id: dId(m),
          })),
        };

      if (params.type === 'digest' || params.type === 'weekly') {
        reportData.formatted_report = this.formatDigestOrWeeklyReport(
          params.type,
          reportData,
        );
      }

      return {
        success: true,
        data: reportData,
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
              `UPDATE tasks SET child_exec_enabled = 0, child_exec_board_id = NULL,
               child_exec_person_id = NULL, child_exec_rollup_status = NULL,
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

          const result = this.computeAndApplyRollup(
            taskBoardId, task.id, childBoardId,
            task.child_exec_rollup_status ?? null, lastRollupAt, params.sender_name,
          );

          return {
            success: true,
            task_id: task.id,
            rollup_status: result.rollupStatus,
            rollup_summary: result.summary,
            new_column: result.newColumn ?? task.column,
            data: {
              total: result.totalCount,
              open: result.openCount,
              waiting: result.waitingCount,
              overdue: result.overdueCount,
              cancelled: result.cancelledCount,
              done: result.doneCount,
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
  /*  buildContextSummary — augmented prompt preamble via embeddings    */
  /* ---------------------------------------------------------------- */

  /**
   * Build a compact board context summary ranked by semantic similarity
   * to the user's message. Used to inject a preamble into the agent prompt.
   * @param queryVector — pre-embedded user message (Float32Array)
   * @param reader — EmbeddingReader instance (caller owns lifecycle)
   */
  buildContextSummary(
    queryVector: Float32Array,
    reader: import('./embedding-reader.js').EmbeddingReader,
  ): string | null {
    try {
      const collection = `tasks:${this.boardId}`;
      const ranked = reader.search(collection, queryVector, { limit: 10, threshold: 0.2 });
      if (ranked.length === 0) return null;

      // Column counts via visibleTaskScope
      const counts = this.db.prepare(
        `SELECT column, COUNT(*) as cnt FROM tasks
         WHERE ${this.visibleTaskScope()} AND column != 'done'
         GROUP BY column`
      ).all(...this.visibleTaskParams()) as Array<{ column: string; cnt: number }>;

      const countMap = new Map(counts.map(c => [c.column, c.cnt]));
      const overdue = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM tasks
         WHERE ${this.visibleTaskScope()} AND due_date < ? AND column != 'done'`
      ).get(...this.visibleTaskParams(), today()) as { cnt: number };

      const parts = ['inbox', 'next_action', 'in_progress', 'waiting', 'review']
        .filter(c => (countMap.get(c) ?? 0) > 0)
        .map(c => `${countMap.get(c)} ${c}`);
      if (overdue.cnt > 0) parts.push(`${overdue.cnt} overdue`);

      const lines = [`[Board context: ${parts.join(', ')}.`];
      lines.push('Relevant tasks for this message:');

      for (const item of ranked) {
        const task = this.getTask(item.itemId);
        if (!task) continue;
        const assigneeName = task.assignee ? this.personDisplayName(task.assignee) : null;
        const detail = [
          `- ${task.id} ${task.title} (${task.column}`,
          assigneeName ? `, ${assigneeName}` : '',
          task.due_date ? `, prazo ${task.due_date.slice(8, 10)}/${task.due_date.slice(5, 7)}` : '',
          task.next_action ? `, próxima ação: ${task.next_action}` : '',
          ')',
        ].join('');
        lines.push(detail);
      }

      // All other tasks as one-liners (use actual board_id from resolved tasks
      // to correctly handle delegated tasks whose board_id differs from this.boardId)
      const rankedIds = new Set<string>();
      for (const item of ranked) {
        const t = this.getTask(item.itemId);
        if (t) rankedIds.add(`${t.board_id}:${t.id}`);
      }
      const others = this.db.prepare(
        `SELECT id, board_id, title FROM tasks
         WHERE ${this.visibleTaskScope()} AND column != 'done'
         ORDER BY id`
      ).all(...this.visibleTaskParams()) as Array<{ id: string; board_id: string; title: string }>;

      const otherTasks = others.filter(t => !rankedIds.has(`${t.board_id}:${t.id}`));
      if (otherTasks.length > 0) {
        const shown = otherTasks.slice(0, 30);
        const suffix = otherTasks.length > 30 ? ` ... and ${otherTasks.length - 30} more` : '';
        lines.push(`Other tasks: ${shown.map(t => `${t.id} ${t.title}`).join(', ')}${suffix}]`);
      } else {
        lines[lines.length - 1] += ']';
      }

      return lines.join('\n');
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  computeAndApplyRollup — shared rollup logic                     */
  /* ---------------------------------------------------------------- */

  /**
   * Count child work, compute rollup status, UPDATE the parent task, and
   * record history (only when the status actually changed).
   * Used by both `refresh_rollup` (hierarchy action) and
   * `refreshLinkedParentRollup` (auto-rollup after moves/cancels).
   */
  private computeAndApplyRollup(
    parentBoardId: string,
    parentTaskId: string,
    childBoardId: string,
    currentRollupStatus: string | null,
    lastRollupAt: string,
    senderName: string,
  ): { rollupStatus: string; summary: string; newColumn: string | null; totalCount: number; openCount: number; doneCount: number; waitingCount: number; overdueCount: number; cancelledCount: number } {
    const now = new Date().toISOString();

    /* 1. Count active child work (includes subtasks of tagged projects) */
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
           AND (
             (linked_parent_board_id = ? AND linked_parent_task_id = ?)
             OR parent_task_id IN (
               SELECT id FROM tasks WHERE board_id = ? AND linked_parent_board_id = ? AND linked_parent_task_id = ?
             )
           )`,
      )
      .get(now.slice(0, 10), childBoardId, parentBoardId, parentTaskId, childBoardId, parentBoardId, parentTaskId) as any;

    /* 2. Count cancelled work since last rollup */
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
      .get(childBoardId, parentBoardId, parentTaskId, lastRollupAt) as any;

    const totalCount = counts.total_count ?? 0;
    const openCount = counts.open_count ?? 0;
    const waitingCount = counts.waiting_count ?? 0;
    const overdueCount = counts.overdue_count ?? 0;
    const cancelledCount = cancelRow.cancelled_count ?? 0;

    /* 3. Apply mapping rules (priority order) */
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

    /* 4. Update parent task */
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
        .run(rollupStatus, now, summary, newColumn, newColumn, waitingForValue, now, parentBoardId, parentTaskId);
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
        .run(rollupStatus, now, summary, now, parentBoardId, parentTaskId);
    }

    /* 5. Record history only when status changed */
    if (rollupStatus !== currentRollupStatus) {
      this.recordHistory(parentTaskId, 'child_rollup_updated', senderName,
        JSON.stringify({ rollup_status: rollupStatus, summary, new_column: newColumn }), parentBoardId);

      const statusActionMap: Record<string, string> = {
        blocked: 'child_rollup_blocked',
        at_risk: 'child_rollup_at_risk',
        ready_for_review: 'child_rollup_completed',
        cancelled_needs_decision: 'child_rollup_cancelled',
      };
      const statusAction = statusActionMap[rollupStatus];
      if (statusAction) {
        this.recordHistory(parentTaskId, statusAction, senderName,
          JSON.stringify({ from: currentRollupStatus ?? null, to: rollupStatus }), parentBoardId);
      }
    }

    return { rollupStatus, summary, newColumn, totalCount, openCount, doneCount, waitingCount, overdueCount, cancelledCount };
  }

  /* ---------------------------------------------------------------- */
  /*  refreshLinkedParentRollup — auto-rollup for linked parent tasks  */
  /* ---------------------------------------------------------------- */

  /**
   * Given a task on the child board, find the linked parent task on the parent
   * board and refresh its rollup counts.  Works for both directly-linked tasks
   * (linked_parent_board_id set on the task itself) and subtasks of a tagged
   * project (parent_task_id points to a project that has the linked fields).
   */
  private refreshLinkedParentRollup(task: any, taskBoardId: string, senderName: string): void {
    /* 1. Resolve upward link */
    let parentBoardId: string | null = task.linked_parent_board_id ?? null;
    let parentTaskId: string | null = task.linked_parent_task_id ?? null;

    if (!parentBoardId && task.parent_task_id) {
      const parentProject = this.db
        .prepare(`SELECT linked_parent_board_id, linked_parent_task_id FROM tasks WHERE board_id = ? AND id = ?`)
        .get(taskBoardId, task.parent_task_id) as any | undefined;
      if (parentProject) {
        parentBoardId = parentProject.linked_parent_board_id ?? null;
        parentTaskId = parentProject.linked_parent_task_id ?? null;
      }
    }

    if (!parentBoardId || !parentTaskId) return;

    /* 2. Load the parent task via direct SQL (do NOT use requireTask — it enforces board visibility) */
    const parentTask = this.db
      .prepare('SELECT * FROM tasks WHERE board_id = ? AND id = ?')
      .get(parentBoardId, parentTaskId) as any | undefined;
    if (!parentTask) return;

    /* 3. Verify parent is linked to a child board */
    if (parentTask.child_exec_enabled !== 1 || !parentTask.child_exec_board_id) return;

    const childBoardId = parentTask.child_exec_board_id;
    const lastRollupAt = parentTask.child_exec_last_rollup_at ?? '1970-01-01T00:00:00.000Z';

    this.computeAndApplyRollup(
      parentBoardId, parentTaskId, childBoardId,
      parentTask.child_exec_rollup_status ?? null, lastRollupAt, senderName,
    );
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
         WHERE board_id = ? AND column = 'done' AND updated_at < ?
           AND (parent_task_id IS NULL OR parent_task_id = '')`,
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
