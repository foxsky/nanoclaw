/**
 * TaskflowEngine — read-only query engine for TaskFlow boards.
 *
 * All methods are SYNCHRONOUS (better-sqlite3 is sync by design).
 * Provides 36 query types covering board views, task details, search,
 * statistics, person queries, and change history.
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
