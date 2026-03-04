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
        column: fromColumn,
        assignee: task.assignee,
        due_date: task.due_date,
        updated_at: task.updated_at,
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
}
