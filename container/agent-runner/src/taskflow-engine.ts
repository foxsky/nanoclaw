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
  subtasks?: string[];
  recurrence?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrence_anchor?: string;
  sender_name: string;
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
  recurring_cycle?: { new_due_date: string; cycle_number: number };
  archive_triggered?: boolean;
  notifications?: Array<{ target_person_id: string; notification_group_jid: string | null; message: string }>;
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
    recurrence?: string;          // change frequency
  };
}

export interface UpdateResult extends TaskflowResult {
  task_id?: string;
  changes?: string[];      // human-readable list of what changed
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
  action: 'register_person' | 'remove_person' | 'add_manager' | 'add_delegate' | 'remove_admin' | 'set_wip_limit' | 'cancel_task' | 'restore_task' | 'process_inbox';
  sender_name: string;
  person_name?: string;
  phone?: string;
  role?: string;
  wip_limit?: number;
  task_id?: string;
  confirmed?: boolean;
  force?: boolean;
}

export interface AdminResult extends TaskflowResult {
  person_id?: string;
  tasks_to_reassign?: Array<{ task_id: string; title: string }>;
  tasks?: any[];
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

/* ------------------------------------------------------------------ */
/*  TaskflowEngine                                                     */
/* ------------------------------------------------------------------ */

export class TaskflowEngine {
  constructor(
    private db: Database.Database,
    private boardId: string,
  ) {
    this.db.pragma('busy_timeout = 5000');
  }

  /* ---------------------------------------------------------------- */
  /*  Public helpers (used by mutation tools later)                     */
  /* ---------------------------------------------------------------- */

  /** Resolve a human-readable name to a person_id + canonical name. */
  resolvePerson(name: string): { person_id: string; name: string } | null {
    const row = this.db
      .prepare(
        `SELECT person_id, name FROM board_people
         WHERE board_id = ? AND LOWER(name) = LOWER(?)`,
      )
      .get(this.boardId, name) as
      | { person_id: string; name: string }
      | undefined;
    return row ?? null;
  }

  /** Fetch a single active task by its id. */
  getTask(taskId: string): any {
    return (
      this.db
        .prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = ?`)
        .get(this.boardId, taskId) ?? null
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  private getAllActiveTasks(): any[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE board_id = ? ORDER BY id`)
      .all(this.boardId);
  }

  private getTasksByColumn(column: string): any[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE board_id = ? AND column = ? ORDER BY id`,
      )
      .all(this.boardId, column);
  }

  private getTasksByAssignee(personId: string): any[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE board_id = ? AND assignee = ? ORDER BY id`,
      )
      .all(this.boardId, personId);
  }

  private getLinkedTasks(): any[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE child_exec_board_id = ? ORDER BY id`,
      )
      .all(this.boardId);
  }

  private getHistory(taskId: string, limit?: number): any[] {
    const sql = limit
      ? `SELECT * FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM task_history WHERE board_id = ? AND task_id = ? ORDER BY id DESC`;
    return limit
      ? this.db.prepare(sql).all(this.boardId, taskId, limit)
      : this.db.prepare(sql).all(this.boardId, taskId);
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

  /** Read next_task_number from board_config, increment it, return the old value. */
  private getNextTaskNumber(): number {
    const row = this.db
      .prepare(`SELECT next_task_number FROM board_config WHERE board_id = ?`)
      .get(this.boardId) as { next_task_number: number } | undefined;
    const num = row?.next_task_number ?? 1;
    this.db
      .prepare(
        `UPDATE board_config SET next_task_number = ? WHERE board_id = ?`,
      )
      .run(num + 1, this.boardId);
    return num;
  }

  /** Insert a row into task_history. */
  recordHistory(taskId: string, action: string, by: string, details?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_history (board_id, task_id, action, by, at, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.boardId, taskId, action, by, now, details ?? null);
  }

  /** Build a notification object if assignee differs from the modifier. */
  private buildNotification(
    task: { id: string; title: string; assignee: string },
    action: string,
    modifierPersonId: string,
  ): { target_person_id: string; notification_group_jid: string | null; message: string } | null {
    if (!task.assignee || task.assignee === modifierPersonId) return null;
    const person = this.db
      .prepare(
        `SELECT name, notification_group_jid FROM board_people
         WHERE board_id = ? AND person_id = ?`,
      )
      .get(this.boardId, task.assignee) as
      | { name: string; notification_group_jid: string | null }
      | undefined;
    if (!person) return null;
    return {
      target_person_id: task.assignee,
      notification_group_jid: person.notification_group_jid ?? null,
      message: `${task.id} "${task.title}" was ${action} and assigned to you.`,
    };
  }

  /** List all team member names for the current board. */
  private listTeamNames(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM board_people WHERE board_id = ? ORDER BY name`)
      .all(this.boardId) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /** Check if an assignee has a child board registered. */
  private getChildBoardRegistration(
    personId: string,
  ): { child_board_id: string } | null {
    const row = this.db
      .prepare(
        `SELECT child_board_id FROM child_board_registrations
         WHERE parent_board_id = ? AND person_id = ?`,
      )
      .get(this.boardId, personId) as { child_board_id: string } | undefined;
    return row ?? null;
  }

  /* ---------------------------------------------------------------- */
  /*  create — taskflow_create                                         */
  /* ---------------------------------------------------------------- */

  create(params: CreateParams): CreateResult {
    try {
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
        if (!person) {
          const teamNames = this.listTeamNames();
          return {
            success: false,
            offer_register: {
              name: params.assignee,
              message: `${params.assignee} not registered. Current team: ${teamNames.join(', ')}`,
            },
          };
        }
        assigneePersonId = person.person_id;
      }

      /* --- ID generation --- */
      const num = this.getNextTaskNumber();
      const prefix =
        params.type === 'project'
          ? 'P'
          : params.type === 'recurring'
            ? 'R'
            : 'T';
      const taskId = `${prefix}-${String(num).padStart(3, '0')}`;

      /* --- Column placement --- */
      const column = params.type === 'inbox' || !assigneePersonId ? 'inbox' : 'next_action';

      /* --- Type mapping (inbox → simple for storage) --- */
      const storedType = params.type === 'inbox' ? 'simple' : params.type;

      /* --- Subtasks for projects --- */
      let subtasksJson: string | null = null;
      if (params.type === 'project' && params.subtasks && params.subtasks.length > 0) {
        subtasksJson = JSON.stringify(
          params.subtasks.map((title, idx) => ({
            id: `${taskId}.${idx + 1}`,
            title,
            status: 'pending',
          })),
        );
      }

      /* --- Recurrence --- */
      let recurrence: string | null = null;
      let dueDate: string | null = params.due_date ?? null;
      if (params.type === 'recurring' && params.recurrence) {
        recurrence = params.recurrence;
        if (!dueDate) {
          // Calculate initial due date based on recurrence type
          const d = new Date();
          switch (params.recurrence) {
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
          dueDate = d.toISOString().slice(0, 10);
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

      /* --- Undo snapshot --- */
      const lastMutation = JSON.stringify({
        action: 'created',
        by: params.sender_name,
        at: now,
      });

      /* --- INSERT task --- */
      this.db
        .prepare(
          `INSERT INTO tasks (
            id, board_id, type, title, assignee, column,
            priority, due_date, labels, subtasks, recurrence,
            child_exec_enabled, child_exec_board_id, child_exec_person_id,
            _last_mutation, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          subtasksJson,
          recurrence,
          childExecEnabled,
          childExecBoardId,
          childExecPersonId,
          lastMutation,
          now,
          now,
        );

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
      if (subtasksJson) detailsSummary.subtasks_count = params.subtasks!.length;
      if (recurrence) detailsSummary.recurrence = recurrence;

      this.recordHistory(taskId, 'created', params.sender_name, JSON.stringify(detailsSummary));

      /* --- Notification --- */
      const notifications: CreateResult['notifications'] = [];
      if (assigneePersonId) {
        const senderPerson = this.resolvePerson(params.sender_name);
        const senderPersonId = senderPerson?.person_id ?? params.sender_name;
        const notif = this.buildNotification(
          { id: taskId, title: params.title, assignee: assigneePersonId },
          'created',
          senderPersonId,
        );
        if (notif) notifications.push(notif);
      }

      return {
        success: true,
        task_id: taskId,
        column,
        ...(notifications.length > 0 ? { notifications } : {}),
      };
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
         WHERE board_id = ? AND assignee = ? AND column = 'in_progress'`,
      )
      .get(this.boardId, personId) as { cnt: number };

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
  private resolveDependencies(taskId: string): void {
    const tasks = this.db
      .prepare(
        `SELECT id, blocked_by FROM tasks
         WHERE board_id = ? AND blocked_by LIKE ?`,
      )
      .all(this.boardId, `%"${taskId}"%`) as Array<{ id: string; blocked_by: string }>;

    for (const t of tasks) {
      try {
        const blockedBy: string[] = JSON.parse(t.blocked_by ?? '[]');
        const updated = blockedBy.filter((id) => id !== taskId);
        this.db
          .prepare(
            `UPDATE tasks SET blocked_by = ?, updated_at = ?
             WHERE board_id = ? AND id = ?`,
          )
          .run(JSON.stringify(updated), new Date().toISOString(), this.boardId, t.id);
      } catch {
        // skip malformed JSON
      }
    }
  }

  /** Advance a recurring task: calculate next due_date and increment cycle. */
  private advanceRecurringTask(task: any): { new_due_date: string; cycle_number: number } {
    const recurrence = task.recurrence as string;
    const anchor = task.due_date ? new Date(task.due_date) : new Date();
    const currentCycle = parseInt(task.current_cycle ?? '0', 10);
    const nextCycle = currentCycle + 1;

    switch (recurrence) {
      case 'daily':
        anchor.setDate(anchor.getDate() + 1);
        break;
      case 'weekly':
        anchor.setDate(anchor.getDate() + 7);
        break;
      case 'monthly':
        anchor.setMonth(anchor.getMonth() + 1);
        break;
      case 'yearly':
        anchor.setFullYear(anchor.getFullYear() + 1);
        break;
    }

    const newDueDate = anchor.toISOString().slice(0, 10);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET column = 'next_action', due_date = ?, current_cycle = ?, updated_at = ?
         WHERE board_id = ? AND id = ?`,
      )
      .run(newDueDate, String(nextCycle), now, this.boardId, task.id);

    return { new_due_date: newDueDate, cycle_number: nextCycle };
  }

  /* ---------------------------------------------------------------- */
  /*  move — taskflow_move                                             */
  /* ---------------------------------------------------------------- */

  move(params: MoveParams): MoveResult {
    try {
      const now = new Date().toISOString();

      /* --- Resolve sender --- */
      const sender = this.resolvePerson(params.sender_name);
      const senderPersonId = sender?.person_id ?? null;

      /* --- Fetch task --- */
      const task = this.requireTask(params.task_id);
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

      /* --- Project subtask completion --- */
      let projectUpdate: MoveResult['project_update'];
      if (params.subtask_id && task.subtasks) {
        try {
          const subtasks: Array<{ id: string; title: string; status: string }> = JSON.parse(task.subtasks);
          let found = false;
          let nextSubtask: string | undefined;
          let foundIndex = -1;
          for (let i = 0; i < subtasks.length; i++) {
            if (subtasks[i].id === params.subtask_id) {
              subtasks[i].status = 'done';
              found = true;
              foundIndex = i;
            }
          }
          if (found) {
            // Find the next pending subtask
            for (let i = foundIndex + 1; i < subtasks.length; i++) {
              if (subtasks[i].status === 'pending') {
                nextSubtask = subtasks[i].id;
                break;
              }
            }
            // If none found after, check from the beginning
            if (!nextSubtask) {
              for (let i = 0; i < foundIndex; i++) {
                if (subtasks[i].status === 'pending') {
                  nextSubtask = subtasks[i].id;
                  break;
                }
              }
            }
            const allComplete = subtasks.every((s) => s.status === 'done');
            this.db
              .prepare(
                `UPDATE tasks SET subtasks = ?, updated_at = ?
                 WHERE board_id = ? AND id = ?`,
              )
              .run(JSON.stringify(subtasks), now, this.boardId, task.id);
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
        .run(toColumn, snapshot, now, this.boardId, task.id);

      /* --- If waiting, store reason in waiting_for --- */
      if (params.action === 'wait' && params.reason) {
        this.db
          .prepare(
            `UPDATE tasks SET waiting_for = ? WHERE board_id = ? AND id = ?`,
          )
          .run(params.reason, this.boardId, task.id);
      }

      /* --- Record history --- */
      this.recordHistory(
        task.id,
        params.action,
        params.sender_name,
        JSON.stringify(detailsObj),
      );

      /* --- Side effects on completion (approve / conclude) --- */
      let recurringCycle: MoveResult['recurring_cycle'];
      if (toColumn === 'done') {
        // Dependency resolution
        this.resolveDependencies(task.id);

        // Recurring cycle advance
        if (task.recurrence) {
          recurringCycle = this.advanceRecurringTask(task);
        }
      }

      /* --- Notifications --- */
      const notifications: MoveResult['notifications'] = [];
      if (senderPersonId) {
        const notif = this.buildNotification(
          { id: task.id, title: task.title, assignee: task.assignee },
          params.action,
          senderPersonId,
        );
        if (notif) notifications.push(notif);
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

      return result;
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  reassign — taskflow_reassign                                     */
  /* ---------------------------------------------------------------- */

  reassign(params: ReassignParams): ReassignResult {
    try {
      /* --- Must specify either task_id or source_person --- */
      if (!params.task_id && !params.source_person) {
        return { success: false, error: 'Must provide either task_id (single) or source_person (bulk transfer).' };
      }

      /* --- Resolve target person --- */
      const targetPerson = this.resolvePerson(params.target_person);
      if (!targetPerson) {
        const teamNames = this.listTeamNames();
        return {
          success: false,
          offer_register: {
            name: params.target_person,
            message: `${params.target_person} not registered. Current team: ${teamNames.join(', ')}`,
          },
        };
      }

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

      /* --- Build affected tasks list with relink info --- */
      const tasksAffected: ReassignResult['tasks_affected'] = [];
      for (const task of tasksToReassign) {
        const wasLinked = task.child_exec_enabled === 1;
        let relinkedTo: string | undefined;

        if (wasLinked) {
          const reg = this.getChildBoardRegistration(targetPerson.person_id);
          if (reg) {
            relinkedTo = reg.child_board_id;
          }
        }

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

        /* --- Auto-relink logic --- */
        let newChildExecEnabled = task.child_exec_enabled;
        let newChildExecBoardId = task.child_exec_board_id;
        let newChildExecPersonId = task.child_exec_person_id;

        if (wasLinked) {
          const reg = this.getChildBoardRegistration(targetPerson.person_id);
          if (reg) {
            newChildExecBoardId = reg.child_board_id;
            newChildExecPersonId = targetPerson.person_id;
          } else {
            newChildExecEnabled = 0;
            newChildExecBoardId = null;
            newChildExecPersonId = null;
          }
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
            this.boardId,
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
        this.recordHistory(task.id, 'reassigned', params.sender_name, JSON.stringify(details));

        /* --- Notification for new assignee --- */
        if (targetPerson.person_id !== senderPersonId) {
          const person = this.db
            .prepare(
              `SELECT name, notification_group_jid FROM board_people
               WHERE board_id = ? AND person_id = ?`,
            )
            .get(this.boardId, targetPerson.person_id) as
            | { name: string; notification_group_jid: string | null }
            | undefined;
          if (person) {
            notifications.push({
              target_person_id: targetPerson.person_id,
              notification_group_jid: person.notification_group_jid ?? null,
              message: `${task.id} "${task.title}" was reassigned to you.`,
            });
          }
        }
      }

      /* --- Build result --- */
      const result: ReassignResult = {
        success: true,
        tasks_affected: tasksAffected,
      };
      if (notifications.length > 0) result.notifications = notifications;

      return result;
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  update — taskflow_update                                         */
  /* ---------------------------------------------------------------- */

  update(params: UpdateParams): UpdateResult {
    try {
      const now = new Date().toISOString();
      const { updates } = params;

      /* --- Resolve sender --- */
      const sender = this.resolvePerson(params.sender_name);
      const senderPersonId = sender?.person_id ?? null;

      /* --- Fetch task --- */
      const task = this.requireTask(params.task_id);

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
          updated_at: task.updated_at,
        },
      });

      /* --- Process each update field --- */
      const changes: string[] = [];

      /* Title */
      if (updates.title !== undefined) {
        if (!updates.title || updates.title.trim() === '') {
          return { success: false, error: 'Title cannot be empty.' };
        }
        this.db
          .prepare(`UPDATE tasks SET title = ? WHERE board_id = ? AND id = ?`)
          .run(updates.title, this.boardId, task.id);
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
          .run(updates.priority, this.boardId, task.id);
        changes.push(`Priority set to ${updates.priority}`);
      }

      /* Due date */
      if (updates.due_date !== undefined) {
        if (updates.due_date === null) {
          this.db
            .prepare(`UPDATE tasks SET due_date = NULL WHERE board_id = ? AND id = ?`)
            .run(this.boardId, task.id);
          changes.push('Due date removed');
        } else {
          this.db
            .prepare(`UPDATE tasks SET due_date = ? WHERE board_id = ? AND id = ?`)
            .run(updates.due_date, this.boardId, task.id);
          changes.push(`Due date set to ${updates.due_date}`);
        }
      }

      /* Description */
      if (updates.description !== undefined) {
        if (updates.description.length > 500) {
          return { success: false, error: 'Description exceeds 500 character limit.' };
        }
        this.db
          .prepare(`UPDATE tasks SET description = ? WHERE board_id = ? AND id = ?`)
          .run(updates.description, this.boardId, task.id);
        changes.push('Description updated');
      }

      /* Next action */
      if (updates.next_action !== undefined) {
        this.db
          .prepare(`UPDATE tasks SET next_action = ? WHERE board_id = ? AND id = ?`)
          .run(updates.next_action, this.boardId, task.id);
        changes.push(`Next action set to "${updates.next_action}"`);
      }

      /* Add label */
      if (updates.add_label !== undefined) {
        const labels: string[] = JSON.parse(task.labels ?? '[]');
        if (!labels.includes(updates.add_label)) {
          labels.push(updates.add_label);
          this.db
            .prepare(`UPDATE tasks SET labels = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(labels), this.boardId, task.id);
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
            .run(JSON.stringify(labels), this.boardId, task.id);
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
          .run(JSON.stringify(notes), noteId + 1, this.boardId, task.id);
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
          .run(JSON.stringify(notes), this.boardId, task.id);
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
          .run(JSON.stringify(notes), this.boardId, task.id);
        changes.push(`Note #${updates.remove_note} removed`);
      }

      /* Add subtask (project only) */
      if (updates.add_subtask !== undefined) {
        if (task.type !== 'project') {
          return { success: false, error: 'Subtasks can only be added to project tasks.' };
        }
        const subtasks: Array<{ id: string; title: string; status: string }> = JSON.parse(task.subtasks ?? '[]');
        const nextNum = subtasks.length + 1;
        const subtaskId = `${task.id}.${nextNum}`;
        subtasks.push({ id: subtaskId, title: updates.add_subtask, status: 'pending' });
        this.db
          .prepare(`UPDATE tasks SET subtasks = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(subtasks), this.boardId, task.id);
        changes.push(`Subtask ${subtaskId} "${updates.add_subtask}" added`);
      }

      /* Rename subtask (project only) */
      if (updates.rename_subtask !== undefined) {
        if (task.type !== 'project') {
          return { success: false, error: 'Subtasks can only be modified on project tasks.' };
        }
        const subtasks: Array<{ id: string; title: string; status: string }> = JSON.parse(task.subtasks ?? '[]');
        const sub = subtasks.find((s) => s.id === updates.rename_subtask!.id);
        if (!sub) {
          return { success: false, error: `Subtask ${updates.rename_subtask.id} not found.` };
        }
        sub.title = updates.rename_subtask.title;
        this.db
          .prepare(`UPDATE tasks SET subtasks = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(subtasks), this.boardId, task.id);
        changes.push(`Subtask ${updates.rename_subtask.id} renamed to "${updates.rename_subtask.title}"`);
      }

      /* Reopen subtask (project only) */
      if (updates.reopen_subtask !== undefined) {
        if (task.type !== 'project') {
          return { success: false, error: 'Subtasks can only be modified on project tasks.' };
        }
        const subtasks: Array<{ id: string; title: string; status: string }> = JSON.parse(task.subtasks ?? '[]');
        const sub = subtasks.find((s) => s.id === updates.reopen_subtask);
        if (!sub) {
          return { success: false, error: `Subtask ${updates.reopen_subtask} not found.` };
        }
        sub.status = 'pending';
        this.db
          .prepare(`UPDATE tasks SET subtasks = ? WHERE board_id = ? AND id = ?`)
          .run(JSON.stringify(subtasks), this.boardId, task.id);
        changes.push(`Subtask ${updates.reopen_subtask} reopened`);
      }

      /* Recurrence (recurring only) */
      if (updates.recurrence !== undefined) {
        if (task.type !== 'recurring') {
          return { success: false, error: 'Recurrence can only be changed on recurring tasks.' };
        }
        this.db
          .prepare(`UPDATE tasks SET recurrence = ? WHERE board_id = ? AND id = ?`)
          .run(updates.recurrence, this.boardId, task.id);
        changes.push(`Recurrence changed to ${updates.recurrence}`);
      }

      /* --- After all updates: set updated_at, _last_mutation, record history --- */
      this.db
        .prepare(
          `UPDATE tasks SET _last_mutation = ?, updated_at = ?
           WHERE board_id = ? AND id = ?`,
        )
        .run(snapshot, now, this.boardId, task.id);

      this.recordHistory(
        task.id,
        'updated',
        params.sender_name,
        JSON.stringify({ changes }),
      );

      /* --- Notification --- */
      const notifications: UpdateResult['notifications'] = [];
      if (senderPersonId) {
        const notif = this.buildNotification(
          { id: task.id, title: task.title, assignee: task.assignee },
          'updated',
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
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  dependency — taskflow_dependency                                  */
  /* ---------------------------------------------------------------- */

  dependency(params: DependencyParams): DependencyResult {
    try {
      const now = new Date().toISOString();

      /* --- Fetch task --- */
      const task = this.requireTask(params.task_id);

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
            .run(JSON.stringify(blockedBy), now, snapshot, this.boardId, task.id);

          change = `Dependency added: ${params.task_id} now blocked by ${params.target_task_id}`;
          this.recordHistory(task.id, 'dep_added', params.sender_name, JSON.stringify({ target: params.target_task_id }));
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
            .run(JSON.stringify(blockedBy), now, snapshot, this.boardId, task.id);

          change = `Dependency removed: ${params.task_id} no longer blocked by ${params.target_task_id}`;
          this.recordHistory(task.id, 'dep_removed', params.sender_name, JSON.stringify({ target: params.target_task_id }));
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
          const dueDate = new Date(task.due_date + 'T00:00:00Z');
          dueDate.setUTCDate(dueDate.getUTCDate() - params.reminder_days);
          const reminderDate = dueDate.toISOString().slice(0, 10);

          const reminders: Array<{ days: number; date: string }> = JSON.parse(task.reminders ?? '[]');
          reminders.push({ days: params.reminder_days, date: reminderDate });
          this.db
            .prepare(`UPDATE tasks SET reminders = ?, updated_at = ?, _last_mutation = ? WHERE board_id = ? AND id = ?`)
            .run(JSON.stringify(reminders), now, snapshot, this.boardId, task.id);

          change = `Reminder added: ${params.reminder_days} day(s) before due date (${reminderDate})`;
          this.recordHistory(task.id, 'reminder_added', params.sender_name, JSON.stringify({ days: params.reminder_days, date: reminderDate }));
          break;
        }

        /* ---- remove_reminder ---- */
        case 'remove_reminder': {
          this.db
            .prepare(`UPDATE tasks SET reminders = '[]', updated_at = ?, _last_mutation = ? WHERE board_id = ? AND id = ?`)
            .run(now, snapshot, this.boardId, task.id);

          change = `All reminders removed from ${params.task_id}`;
          this.recordHistory(task.id, 'reminder_removed', params.sender_name);
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
            data: { columns: grouped, linked_tasks: linked },
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
               WHERE board_id = ? AND assignee = ? AND column = 'waiting'
               ORDER BY id`,
            )
            .all(this.boardId, person.person_id);
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
               WHERE board_id = ? AND assignee = ? AND column = 'review'
               ORDER BY id`,
            )
            .all(this.boardId, person.person_id);
          return { success: true, data: tasks };
        }

        /* ---------- Due-date filters ---------- */

        case 'overdue': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE board_id = ? AND due_date < ? AND column != 'done'
               ORDER BY due_date, id`,
            )
            .all(this.boardId, today());
          return { success: true, data: tasks };
        }

        case 'due_today': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE board_id = ? AND due_date = ?
               ORDER BY id`,
            )
            .all(this.boardId, today());
          return { success: true, data: tasks };
        }

        case 'due_tomorrow': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE board_id = ? AND due_date = ?
               ORDER BY id`,
            )
            .all(this.boardId, tomorrow());
          return { success: true, data: tasks };
        }

        case 'due_this_week': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE board_id = ? AND due_date >= ? AND due_date <= ?
               ORDER BY due_date, id`,
            )
            .all(this.boardId, weekStart(), weekEnd());
          return { success: true, data: tasks };
        }

        case 'next_7_days': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE board_id = ? AND due_date >= ? AND due_date <= ?
               ORDER BY due_date, id`,
            )
            .all(this.boardId, today(), sevenDaysFromNow());
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
               WHERE board_id = ? AND (title LIKE ? OR description LIKE ?)
               ORDER BY id`,
            )
            .all(this.boardId, pattern, pattern);
          return { success: true, data: tasks };
        }

        case 'urgent': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE board_id = ? AND priority = 'urgent'
               ORDER BY id`,
            )
            .all(this.boardId);
          return { success: true, data: tasks };
        }

        case 'high_priority': {
          const tasks = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE board_id = ? AND priority IN ('urgent', 'high')
               ORDER BY id`,
            )
            .all(this.boardId);
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
               WHERE board_id = ? AND labels LIKE ?
               ORDER BY id`,
            )
            .all(this.boardId, pattern);
          return { success: true, data: tasks };
        }

        /* ---------- Task details & history ---------- */

        case 'task_details': {
          const task = this.requireTask(params.task_id);
          const history = this.getHistory(params.task_id!, 5);
          return { success: true, data: { task, recent_history: history } };
        }

        case 'task_history': {
          this.requireTask(params.task_id);
          const history = this.getHistory(params.task_id!);
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
               WHERE board_id = ? AND due_date < ? AND column != 'done'
               ORDER BY due_date, id`,
            )
            .all(this.boardId, t);
          const dueToday = this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE board_id = ? AND due_date = ?
               ORDER BY id`,
            )
            .all(this.boardId, t);
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
               WHERE board_id = ? AND due_date >= ? AND due_date <= ?
               ORDER BY due_date, id`,
            )
            .all(this.boardId, weekStart(), weekEnd());
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
      const now = new Date().toISOString();

      /* --- 1. Find the most recently mutated task --- */
      const rows = this.db
        .prepare(
          `SELECT id, _last_mutation FROM tasks
           WHERE board_id = ? AND _last_mutation IS NOT NULL`,
        )
        .all(this.boardId) as Array<{ id: string; _last_mutation: string }>;

      if (rows.length === 0) {
        return { success: false, error: 'Nothing to undo: no recent mutations found.' };
      }

      /* Parse and find the one with the most recent `at` timestamp */
      let latestTask: { id: string; mutation: any } | null = null;
      let latestAt = '';

      for (const row of rows) {
        try {
          const mutation = JSON.parse(row._last_mutation);
          if (mutation.at && mutation.at > latestAt) {
            latestAt = mutation.at;
            latestTask = { id: row.id, mutation };
          }
        } catch {
          // skip malformed JSON
        }
      }

      if (!latestTask) {
        return { success: false, error: 'Nothing to undo: no valid mutations found.' };
      }

      const { id: taskId, mutation } = latestTask;
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
            .run(...values, now, this.boardId, taskId);
        } else {
          /* No snapshot fields, just clear _last_mutation */
          this.db
            .prepare(
              `UPDATE tasks SET _last_mutation = NULL, updated_at = ?
               WHERE board_id = ? AND id = ?`,
            )
            .run(now, this.boardId, taskId);
        }
      } else {
        /* No snapshot object, just clear _last_mutation */
        this.db
          .prepare(
            `UPDATE tasks SET _last_mutation = NULL, updated_at = ?
             WHERE board_id = ? AND id = ?`,
          )
          .run(now, this.boardId, taskId);
      }

      /* --- Record history --- */
      this.recordHistory(taskId, 'undone', params.sender_name, JSON.stringify({ undone_action: action }));

      return {
        success: true,
        task_id: taskId,
        undone_action: action,
      };
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  admin — taskflow_admin                                           */
  /* ---------------------------------------------------------------- */

  admin(params: AdminParams): AdminResult {
    try {
      /* --- Permission check: all admin actions require manager --- */
      if (!this.isManager(params.sender_name)) {
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

          return {
            success: true,
            person_id: personId,
            data: { name: params.person_name, person_id: personId },
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

          /* Gather history for the task */
          const history = this.getHistory(task.id);

          /* Save snapshot to archive */
          this.db
            .prepare(
              `INSERT INTO archive (board_id, task_id, type, title, assignee, archive_reason,
               linked_parent_board_id, linked_parent_task_id, archived_at, task_snapshot, history)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              this.boardId,
              task.id,
              task.type,
              task.title,
              task.assignee,
              'cancelled',
              task.linked_parent_board_id ?? null,
              task.linked_parent_task_id ?? null,
              now,
              JSON.stringify(task),
              JSON.stringify(history),
            );

          /* If task was linked, clear the link */
          if (task.child_exec_enabled === 1) {
            /* No cross-board cleanup needed here — just archive locally */
          }

          /* Delete from tasks */
          this.db
            .prepare(
              `DELETE FROM tasks WHERE board_id = ? AND id = ?`,
            )
            .run(this.boardId, task.id);

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

          this.db
            .prepare(
              `INSERT INTO tasks (
                id, board_id, type, title, assignee, next_action, waiting_for,
                column, priority, due_date, description, labels, blocked_by,
                reminders, next_note_id, notes, _last_mutation, created_at, updated_at,
                child_exec_enabled, child_exec_board_id, child_exec_person_id,
                child_exec_rollup_status, child_exec_last_rollup_at,
                child_exec_last_rollup_summary,
                linked_parent_board_id, linked_parent_task_id,
                subtasks, recurrence, current_cycle
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              snapshot.id ?? archived.task_id,
              this.boardId,
              snapshot.type ?? archived.type,
              snapshot.title ?? archived.title,
              snapshot.assignee ?? archived.assignee ?? null,
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
              snapshot.subtasks ?? null,
              snapshot.recurrence ?? null,
              snapshot.current_cycle ?? null,
            );

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

        default:
          return { success: false, error: `Unknown admin action: ${(params as any).action}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }
}
