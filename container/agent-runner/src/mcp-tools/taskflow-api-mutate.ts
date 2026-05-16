/**
 * Mutate-side TaskFlow MCP tools.
 *
 * Each handler instantiates a fresh writable `TaskflowEngine`, calls the
 * matching engine method, and JSON-stringifies the result. The shared
 * MCP response shape is `{ success, data, notification_events }` for
 * happy paths and `{ success: false, error_code?, error }` otherwise.
 */
import type { Database } from 'bun:sqlite';
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import type { AdminParams, DependencyParams, HierarchyParams, MoveResult, QueryParams, ReassignParams, ReassignResult, ReportParams, UndoParams, UpdateParams } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { normalizeAgentIds, normalizeEngineNotificationEvents } from './taskflow-helpers.js';
import { err, jsonResponse, parseTaskActorArgs, requireString } from './util.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

const MOVE_ACTIONS = [
  'start', 'wait', 'resume', 'return', 'review',
  'approve', 'reject', 'conclude', 'reopen', 'force_start',
] as const;
type MoveAction = (typeof MOVE_ACTIONS)[number];

const REPORT_TYPES = ['standup', 'digest', 'weekly'] as const;
type ReportType = (typeof REPORT_TYPES)[number];

const HIERARCHY_ACTIONS = ['link', 'unlink', 'refresh_rollup', 'tag_parent'] as const;
type HierarchyAction = (typeof HIERARCHY_ACTIONS)[number];

const DEPENDENCY_ACTIONS = ['add_dep', 'remove_dep', 'add_reminder', 'remove_reminder'] as const;
type DependencyAction = (typeof DEPENDENCY_ACTIONS)[number];

const CREATE_TASK_TYPES = ['simple', 'project', 'recurring', 'inbox'] as const;
type CreateTaskType = (typeof CREATE_TASK_TYPES)[number];

const RECURRENCES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
type Recurrence = (typeof RECURRENCES)[number];

const ADMIN_ACTIONS = [
  'register_person', 'remove_person', 'add_manager', 'add_delegate', 'remove_admin',
  'set_wip_limit', 'cancel_task', 'restore_task', 'process_inbox', 'manage_holidays',
  'process_minutes', 'process_minutes_decision', 'accept_external_invite',
  'reparent_task', 'detach_task', 'merge_project', 'handle_subtask_approval',
] as const;
type AdminAction = (typeof ADMIN_ACTIONS)[number];

const HOLIDAY_OPS = ['add', 'remove', 'set_year', 'list'] as const;
type HolidayOp = (typeof HOLIDAY_OPS)[number];

const ADMIN_DECISIONS = ['approve', 'reject', 'create_task', 'create_inbox'] as const;
type AdminDecision = (typeof ADMIN_DECISIONS)[number];

interface CreateLikeResult {
  success: boolean;
  task_id?: string;
  error?: string;
  unresolved_participants?: string[];
  offer_register?: { name: string; message: string };
  notifications?: Array<{ target_person_id?: string; message: string }>;
}

/**
 * Post-create result shaping shared by `api_create_simple_task` and
 * `api_create_meeting_task`: turn an engine `CreateResult` into the
 * MCP-tool JSON response `{ success, data, notification_events }`.
 * Re-queries the row + JOIN on boards so serializeApiTask receives the
 * full denormalized shape; engine.create's post-commit verification
 * only selects `id`, not the joined columns.
 */
function finalizeCreatedTaskResult(
  db: Database,
  engine: TaskflowEngine,
  boardId: string,
  result: CreateLikeResult,
) {
  if (!result.success) return jsonResponse({ success: false, error: result.error });
  if (!result.task_id) {
    return jsonResponse({ success: false, error: 'engine returned success without task_id' });
  }
  const row = db
    .prepare(
      `SELECT t.*, b.short_code AS board_code FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND t.board_id = ?`,
    )
    .get(result.task_id, boardId) as Record<string, unknown>;
  const data = engine.serializeApiTask(row);
  const notification_events = (result.notifications ?? [])
    .filter((n) => n.target_person_id)
    .map((n) => ({
      kind: 'deferred_notification',
      board_id: boardId,
      target_person_id: n.target_person_id!,
      message: n.message,
    }));
  return jsonResponse({
    success: true,
    data,
    notification_events,
    ...(result.unresolved_participants ? { unresolved_participants: result.unresolved_participants } : {}),
    ...(result.offer_register ? { offer_register: result.offer_register } : {}),
  });
}

/**
 * Post-mutation result shaping shared by `api_move`, `api_admin`, and
 * `api_reassign`. Strips `notifications` (rewritten as `notification_events`
 * via the shared normalizer) and preserves every other engine field on
 * BOTH paths:
 *   success → `{success: true, data: rest, notification_events}` keeps
 *     wip_warning, project_update, parent_notification, tasks_affected,
 *     requires_confirmation (dry run), auto_provision_request, etc.
 *   failure → `{success: false, ...rest, notification_events}` keeps
 *     error_code, expected_task_id, actual_task_id (magnetism retry
 *     contract), offer_register, etc. — without us picking winners on
 *     which engine fields to forward.
 */
function finalizeMutationResult(result: { success: boolean; notifications?: unknown }) {
  const { notifications: _notifications, success, ...rest } = result;
  const notification_events = normalizeEngineNotificationEvents(result);
  if (!success) return jsonResponse({ success: false, ...rest, notification_events });
  return jsonResponse({ success: true, data: rest, notification_events });
}

function addMoveFormattedResult(result: MoveResult, action: MoveAction): MoveResult {
  if (!result.success || result.formatted) return result;
  const title = result.title ? ` — ${result.title}` : '';
  const transition = result.from_column && result.to_column
    ? ` (${result.from_column} → ${result.to_column})`
    : '';
  return {
    ...result,
    formatted: `${result.task_id ?? 'Tarefa'}${title}: ação "${action}" concluída${transition}.`,
  };
}

function addReassignFormattedResult(result: ReassignResult, targetPerson: string): ReassignResult {
  if (!result.success || result.formatted || result.requires_confirmation) return result;
  const tasks = result.tasks_affected ?? [];
  if (tasks.length === 0) return result;
  const taskLines = tasks.map((task) => `- ${task.task_id} — ${task.title}`);
  return {
    ...result,
    formatted: tasks.length === 1
      ? `${tasks[0].task_id} — ${tasks[0].title}: reatribuída para ${targetPerson}.`
      : `${tasks.length} tarefas reatribuídas para ${targetPerson}:\n${taskLines.join('\n')}`,
  };
}

function pickTaskSummary(task: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!task) return null;
  const summary: Record<string, unknown> = {};
  for (const key of [
    'id',
    'type',
    'title',
    'description',
    'assignee',
    'assignee_name',
    'column',
    'priority',
    'due_date',
    'scheduled_at',
    'parent_task_id',
  ]) {
    if (task[key] !== undefined && task[key] !== null && task[key] !== '') summary[key] = task[key];
  }
  return summary;
}

function compactTaskDetailsQueryResult(result: unknown): unknown {
  if (
    !result ||
    typeof result !== 'object' ||
    (result as { success?: unknown }).success !== true
  ) {
    return result;
  }
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return result;

  const details = data as Record<string, unknown>;
  const compact: Record<string, unknown> = {
    formatted_task_details: details.formatted_task_details,
    task: pickTaskSummary(details.task as Record<string, unknown> | null | undefined),
  };

  if (Array.isArray(details.subtask_rows)) {
    compact.subtask_count = details.subtask_rows.length;
    compact.subtasks = details.subtask_rows.map((row) => pickTaskSummary(row as Record<string, unknown>));
  }
  for (const key of ['parent_project', 'recent_history', 'external_participants', 'delegation_chain']) {
    if (details[key] !== undefined) compact[key] = details[key];
  }

  return { success: true, data: compact };
}

function compactFindTaskInOrganizationQueryResult(result: unknown): unknown {
  if (
    !result ||
    typeof result !== 'object' ||
    (result as { success?: unknown }).success !== true
  ) {
    return result;
  }
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return result;

  const compactRows = data.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const source = row as Record<string, unknown>;
    const formatted = source.formatted_current_board_project_summary;
    const compact: Record<string, unknown> = {};
    if (formatted !== undefined) compact.formatted_task_details = formatted;
    for (const key of [
      'task_id',
      'board_id',
      'board_group_folder',
      'board_short_code',
      'type',
      'title',
      'column',
      'assignee_name',
      'assignee',
      'due_date',
      'parent_task_id',
      'current_board_related_task_count',
      'current_board_related_tasks',
    ]) {
      if (source[key] !== undefined) compact[key] = source[key];
    }
    return compact;
  });

  return { success: true, primary_match: compactRows[0] ?? null, data: compactRows };
}

export const apiCreateSimpleTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_create_simple_task',
    description: 'Create a simple task via the REST API',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        sender_name: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        due_date: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
      },
      required: ['title', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const title = requireString(args, 'title');
    if (title === null) return err('title: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');

    let assignee: string | undefined;
    if (args.assignee !== undefined) {
      if (typeof args.assignee !== 'string') return err('assignee: expected string');
      assignee = args.assignee;
    }
    let priority: Priority | undefined;
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority as Priority)) {
        return err(`priority: expected one of ${PRIORITIES.join(' | ')}`);
      }
      priority = args.priority as Priority;
    }
    let dueDate: string | null | undefined;
    if (args.due_date !== undefined) {
      if (args.due_date !== null && typeof args.due_date !== 'string') {
        return err('due_date: expected string or null');
      }
      dueDate = args.due_date;
    }
    if (args.description !== undefined) {
      if (args.description !== null && typeof args.description !== 'string') {
        return err('description: expected string or null');
      }
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      const result = engine.create({
        board_id: boardId,
        type: 'inbox',
        title,
        sender_name: senderName,
        assignee,
        priority,
        due_date: dueDate ?? undefined,
      });
      return finalizeCreatedTaskResult(db, engine, boardId, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiCreateMeetingTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_create_meeting_task',
    description:
      'Create a meeting-type task. Meetings use scheduled_at (not due_date) and can carry participants. Engine will reject if due_date is supplied or if recurrence is set without scheduled_at.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        sender_name: { type: 'string' },
        scheduled_at: { type: ['string', 'null'] },
        participants: { type: 'array', items: { type: 'string' } },
        assignee: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        recurrence: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
        recurrence_anchor: { type: 'string' },
        recurrence_end_date: { type: 'string' },
        max_cycles: { type: 'integer' },
        intended_weekday: { type: 'string' },
        allow_non_business_day: { type: 'boolean' },
        due_date: { type: ['string', 'null'] },
        requires_close_approval: { type: 'boolean' },
      },
      required: ['title', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const title = requireString(args, 'title');
    if (title === null) return err('title: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');

    let scheduledAt: string | undefined;
    if (args.scheduled_at !== undefined && args.scheduled_at !== null) {
      if (typeof args.scheduled_at !== 'string') return err('scheduled_at: expected string or null');
      scheduledAt = args.scheduled_at;
    }
    let participants: string[] | undefined;
    if (args.participants !== undefined) {
      if (!Array.isArray(args.participants) || args.participants.some((p) => typeof p !== 'string')) {
        return err('participants: expected array of strings');
      }
      participants = args.participants as string[];
    }
    let assignee: string | undefined;
    if (args.assignee !== undefined) {
      if (typeof args.assignee !== 'string') return err('assignee: expected string');
      assignee = args.assignee;
    }
    let priority: Priority | undefined;
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority as Priority)) {
        return err(`priority: expected one of ${PRIORITIES.join(' | ')}`);
      }
      priority = args.priority as Priority;
    }
    let recurrence: 'daily' | 'weekly' | 'monthly' | 'yearly' | undefined;
    if (args.recurrence !== undefined) {
      if (
        args.recurrence !== 'daily' &&
        args.recurrence !== 'weekly' &&
        args.recurrence !== 'monthly' &&
        args.recurrence !== 'yearly'
      ) {
        return err('recurrence: expected one of daily | weekly | monthly | yearly');
      }
      recurrence = args.recurrence;
    }
    let recurrenceAnchor: string | undefined;
    if (args.recurrence_anchor !== undefined) {
      if (typeof args.recurrence_anchor !== 'string') return err('recurrence_anchor: expected string');
      recurrenceAnchor = args.recurrence_anchor;
    }
    let recurrenceEndDate: string | undefined;
    if (args.recurrence_end_date !== undefined) {
      if (typeof args.recurrence_end_date !== 'string') return err('recurrence_end_date: expected string');
      recurrenceEndDate = args.recurrence_end_date;
    }
    let maxCycles: number | undefined;
    if (args.max_cycles !== undefined) {
      if (typeof args.max_cycles !== 'number' || !Number.isInteger(args.max_cycles)) {
        return err('max_cycles: expected integer');
      }
      maxCycles = args.max_cycles;
    }
    let intendedWeekday: string | undefined;
    if (args.intended_weekday !== undefined) {
      if (typeof args.intended_weekday !== 'string') return err('intended_weekday: expected string');
      intendedWeekday = args.intended_weekday;
    }
    let allowNonBusinessDay: boolean | undefined;
    if (args.allow_non_business_day !== undefined) {
      if (typeof args.allow_non_business_day !== 'boolean') {
        return err('allow_non_business_day: expected boolean');
      }
      allowNonBusinessDay = args.allow_non_business_day;
    }
    let dueDate: string | undefined;
    if (args.due_date !== undefined && args.due_date !== null) {
      if (typeof args.due_date !== 'string') return err('due_date: expected string or null');
      dueDate = args.due_date;
    }
    let requiresCloseApproval: boolean | undefined;
    if (args.requires_close_approval !== undefined) {
      if (typeof args.requires_close_approval !== 'boolean') {
        return err('requires_close_approval: expected boolean');
      }
      requiresCloseApproval = args.requires_close_approval;
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      const result = engine.create({
        board_id: boardId,
        type: 'meeting',
        title,
        sender_name: senderName,
        assignee,
        priority,
        scheduled_at: scheduledAt,
        participants,
        recurrence,
        recurrence_anchor: recurrenceAnchor,
        recurrence_end_date: recurrenceEndDate,
        max_cycles: maxCycles,
        intended_weekday: intendedWeekday,
        allow_non_business_day: allowNonBusinessDay,
        due_date: dueDate,
        requires_close_approval: requiresCloseApproval,
      });
      return finalizeCreatedTaskResult(db, engine, boardId, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiDeleteSimpleTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_delete_simple_task',
    description: 'Delete a simple task via the REST API, enforcing creator/Gestor/service ownership',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
      },
      required: ['task_id', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;

    const engine = new TaskflowEngine(getTaskflowDb(), parsed.boardId);
    const result = engine.apiDeleteSimpleTask({
      board_id: parsed.boardId,
      task_id: parsed.taskId,
      sender_name: parsed.senderName,
      sender_is_service: parsed.senderIsService,
    });
    return jsonResponse(result);
  },
};

export const apiMoveTool: McpToolDefinition = {
  tool: {
    name: 'api_move',
    description:
      'Move one task or a batch of tasks across the state machine. Preserve board-prefixed task IDs exactly, e.g. SEC-T41 must stay SEC-T41, not T41. Actions: start, wait, resume, return, review, approve, reject, conclude, reopen, force_start. Use task_ids for explicit bulk approvals such as "aprovar todas as tarefas de Nome" after querying review candidates. Engine enforces from-column transition + role-based permissions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'string' } },
        action: { type: 'string', enum: [...MOVE_ACTIONS] },
        sender_name: { type: 'string' },
        reason: { type: 'string' },
        subtask_id: { type: 'string' },
        confirmed_task_id: { type: 'string' },
      },
      required: ['action', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');
    if (typeof args.action !== 'string' || !MOVE_ACTIONS.includes(args.action as MoveAction)) {
      return err(`action: expected one of ${MOVE_ACTIONS.join(' | ')}`);
    }
    const action = args.action as MoveAction;

    let taskIds: string[];
    if (args.task_ids !== undefined) {
      if (!Array.isArray(args.task_ids) || args.task_ids.some((id) => typeof id !== 'string')) {
        return err('task_ids: expected array of strings');
      }
      taskIds = args.task_ids as string[];
      if (taskIds.length === 0) return err('task_ids: expected at least one task id');
      if (args.task_id !== undefined) return err('provide either task_id or task_ids, not both');
    } else {
      const taskId = requireString(args, 'task_id');
      if (taskId === null) return err('task_id: required string');
      taskIds = [taskId];
    }

    let reason: string | undefined;
    if (args.reason !== undefined) {
      if (typeof args.reason !== 'string') return err('reason: expected string');
      reason = args.reason;
    }
    let subtaskId: string | undefined;
    if (args.subtask_id !== undefined) {
      if (typeof args.subtask_id !== 'string') return err('subtask_id: expected string');
      subtaskId = args.subtask_id;
    }
    let confirmedTaskId: string | undefined;
    if (args.confirmed_task_id !== undefined) {
      if (typeof args.confirmed_task_id !== 'string') return err('confirmed_task_id: expected string');
      confirmedTaskId = args.confirmed_task_id;
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      if (taskIds.length === 1) {
        const result = engine.move({
          board_id: boardId,
          task_id: taskIds[0],
          action,
          sender_name: senderName,
          reason,
          subtask_id: subtaskId,
          confirmed_task_id: confirmedTaskId,
        });
        return finalizeMutationResult(addMoveFormattedResult(result, action));
      }

      const results: MoveResult[] = [];
      const notifications: unknown[] = [];
      for (const taskId of taskIds) {
        const result = engine.move({
          board_id: boardId,
          task_id: taskId,
          action,
          sender_name: senderName,
          reason,
          subtask_id: subtaskId,
          confirmed_task_id: confirmedTaskId,
        });
        results.push(result);
        if (Array.isArray(result.notifications)) notifications.push(...result.notifications);
      }
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);
      const formatted = [
        `${successes.length} de ${results.length} tarefa(s) processada(s) com ação "${action}".`,
        ...successes.map((r) => `- ${r.task_id} — ${r.title ?? ''}`.trim()),
        ...failures.map((r) => `- ${r.task_id ?? 'unknown'} falhou: ${r.error ?? 'erro desconhecido'}`),
      ].join('\n');
      return jsonResponse({
        success: failures.length === 0,
        data: {
          bulk: true,
          action,
          processed_count: results.length,
          success_count: successes.length,
          failure_count: failures.length,
          results: results.map(({ notifications: _notifications, ...result }) => result),
          formatted,
        },
        notification_events: normalizeEngineNotificationEvents({ success: failures.length === 0, notifications }),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiAdminTool: McpToolDefinition = {
  tool: {
    name: 'api_admin',
    description:
      'Board/team administration actions. Engine validates per-action required params (e.g. cancel_task needs task_id; set_wip_limit needs person_name + wip_limit; reparent_task needs task_id + target_parent_id; manage_holidays needs holiday_operation).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...ADMIN_ACTIONS] },
        sender_name: { type: 'string' },
        person_name: { type: 'string' },
        phone: { type: 'string' },
        role: { type: 'string' },
        wip_limit: { type: 'number' },
        task_id: { type: 'string' },
        confirmed: { type: 'boolean' },
        force: { type: 'boolean' },
        group_name: { type: 'string' },
        group_folder: { type: 'string' },
        holiday_operation: { type: 'string', enum: [...HOLIDAY_OPS] },
        holidays: { type: 'array' },
        holiday_dates: { type: 'array', items: { type: 'string' } },
        holiday_year: { type: 'integer' },
        note_id: { type: 'integer' },
        create: { type: 'object' },
        sender_external_id: { type: 'string' },
        target_parent_id: { type: 'string' },
        source_project_id: { type: 'string' },
        target_project_id: { type: 'string' },
        request_id: { type: 'string' },
        decision: { type: 'string', enum: [...ADMIN_DECISIONS] },
        reason: { type: 'string' },
      },
      required: ['action', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');
    if (typeof args.action !== 'string' || !ADMIN_ACTIONS.includes(args.action as AdminAction)) {
      return err(`action: expected one of ${ADMIN_ACTIONS.join(' | ')}`);
    }
    const action = args.action as AdminAction;

    // Type-check each AdminParams optional field. Engine handles
    // per-action presence/value validation; we only police shapes.
    const adminParams: AdminParams = {
      board_id: boardId,
      action,
      sender_name: senderName,
    };

    for (const key of [
      'person_name', 'phone', 'role', 'task_id', 'group_name', 'group_folder',
      'sender_external_id', 'target_parent_id', 'source_project_id',
      'target_project_id', 'request_id', 'reason',
    ] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'string') return err(`${key}: expected string`);
        adminParams[key] = args[key];
      }
    }
    if (args.wip_limit !== undefined) {
      if (typeof args.wip_limit !== 'number') return err('wip_limit: expected number');
      adminParams.wip_limit = args.wip_limit;
    }
    for (const key of ['holiday_year', 'note_id'] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'number' || !Number.isInteger(args[key])) {
          return err(`${key}: expected integer`);
        }
        adminParams[key] = args[key];
      }
    }
    for (const key of ['confirmed', 'force'] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'boolean') return err(`${key}: expected boolean`);
        adminParams[key] = args[key];
      }
    }
    if (args.holiday_operation !== undefined) {
      if (typeof args.holiday_operation !== 'string' ||
          !HOLIDAY_OPS.includes(args.holiday_operation as HolidayOp)) {
        return err(`holiday_operation: expected one of ${HOLIDAY_OPS.join(' | ')}`);
      }
      adminParams.holiday_operation = args.holiday_operation as HolidayOp;
    }
    if (args.decision !== undefined) {
      if (typeof args.decision !== 'string' ||
          !ADMIN_DECISIONS.includes(args.decision as AdminDecision)) {
        return err(`decision: expected one of ${ADMIN_DECISIONS.join(' | ')}`);
      }
      // Per-action narrowing: handle_subtask_approval only accepts approve|reject
      // (engine reads it as an approval verdict). process_minutes_decision only
      // accepts create_task|create_inbox (engine reads it as a routing choice and
      // mishandles approve/reject — see taskflow-engine.ts:8004).
      if (action === 'handle_subtask_approval' && args.decision !== 'approve' && args.decision !== 'reject') {
        return err(`decision: handle_subtask_approval requires "approve" or "reject"`);
      }
      if (action === 'process_minutes_decision' && args.decision !== 'create_task' && args.decision !== 'create_inbox') {
        return err(`decision: process_minutes_decision requires "create_task" or "create_inbox"`);
      }
      adminParams.decision = args.decision as AdminDecision;
    }
    if (args.holidays !== undefined) {
      if (!Array.isArray(args.holidays)) return err('holidays: expected array');
      for (let i = 0; i < args.holidays.length; i++) {
        const h = args.holidays[i];
        if (!h || typeof h !== 'object' || Array.isArray(h)) {
          return err(`holidays[${i}]: expected object`);
        }
        if (typeof (h as { date?: unknown }).date !== 'string') {
          return err(`holidays[${i}].date: expected string`);
        }
        const label = (h as { label?: unknown }).label;
        if (label !== undefined && typeof label !== 'string') {
          return err(`holidays[${i}].label: expected string`);
        }
      }
      adminParams.holidays = args.holidays;
    }
    if (args.holiday_dates !== undefined) {
      if (!Array.isArray(args.holiday_dates) ||
          args.holiday_dates.some((d) => typeof d !== 'string')) {
        return err('holiday_dates: expected array of strings');
      }
      adminParams.holiday_dates = args.holiday_dates;
    }
    if (args.create !== undefined) {
      if (typeof args.create !== 'object' || args.create === null || Array.isArray(args.create)) {
        return err('create: expected object');
      }
      const c = args.create as Record<string, unknown>;
      if (typeof c.type !== 'string') return err('create.type: expected string');
      if (typeof c.title !== 'string') return err('create.title: expected string');
      if (c.assignee !== undefined && typeof c.assignee !== 'string') {
        return err('create.assignee: expected string');
      }
      if (c.labels !== undefined) {
        if (!Array.isArray(c.labels) || c.labels.some((l) => typeof l !== 'string')) {
          return err('create.labels: expected array of strings');
        }
      }
      adminParams.create = args.create as AdminParams['create'];
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const result = engine.admin(adminParams);
      return finalizeMutationResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiReassignTool: McpToolDefinition = {
  tool: {
    name: 'api_reassign',
    description:
      'Reassign a single task (task_id) or bulk-transfer all active tasks from one person (source_person) to another (target_person). Use this for explicit assignment commands such as "atribuir P11.23 para Rodrigo"; do not route those through api_update_simple_task. Engine requires confirmed=true to commit; confirmed=false runs a dry-run that returns a human-readable summary in `requires_confirmation`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_person: { type: 'string' },
        sender_name: { type: 'string' },
        confirmed: { type: 'boolean' },
        task_id: { type: 'string' },
        source_person: { type: 'string' },
      },
      required: ['target_person', 'sender_name', 'confirmed'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const targetPerson = requireString(args, 'target_person');
    if (targetPerson === null) return err('target_person: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');
    if (typeof args.confirmed !== 'boolean') return err('confirmed: required boolean');
    const confirmed = args.confirmed;

    let taskId: string | undefined;
    if (args.task_id !== undefined) {
      if (typeof args.task_id !== 'string') return err('task_id: expected string');
      taskId = args.task_id;
    }
    let sourcePerson: string | undefined;
    if (args.source_person !== undefined) {
      if (typeof args.source_person !== 'string') return err('source_person: expected string');
      sourcePerson = args.source_person;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const reassignParams: ReassignParams = {
        board_id: boardId,
        target_person: targetPerson,
        sender_name: senderName,
        confirmed,
        task_id: taskId,
        source_person: sourcePerson,
      };
      const result = engine.reassign(reassignParams);
      return finalizeMutationResult(addReassignFormattedResult(result, targetPerson));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiUndoTool: McpToolDefinition = {
  tool: {
    name: 'api_undo',
    description:
      'Undo the most recent task mutation on the board. Only the mutation author or a manager may undo. Engine rejects undo of creation (use api_admin cancel_task instead) and undo into in_progress that exceeds the assignee WIP limit (set force=true to override, manager-only).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sender_name: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');

    let force: boolean | undefined;
    if (args.force !== undefined) {
      if (typeof args.force !== 'boolean') return err('force: expected boolean');
      force = args.force;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const undoParams: UndoParams = {
        board_id: boardId,
        sender_name: senderName,
        force,
      };
      const result = engine.undo(undoParams);
      return finalizeMutationResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiReportTool: McpToolDefinition = {
  tool: {
    name: 'api_report',
    description:
      'Build a board report. type=standup returns the daily-standup shape (overdue/in_progress/review/due_today/waiting/blocked/per_person) AND runs the bundled housekeeping that v1 ran inline: auto-archives done tasks older than 30 days (cleanup failures are swallowed and never break the report). type=digest adds next_48h, completed_today, stale_24h, inbox, and a formatted_report string. type=weekly adds completed_week, waiting_5d, next_week_deadlines, stale_tasks, and stats (total_active, completed_week, created_week, trend).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: [...REPORT_TYPES] },
      },
      required: ['type'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    if (typeof args.type !== 'string' || !REPORT_TYPES.includes(args.type as ReportType)) {
      return err(`type: expected one of ${REPORT_TYPES.join(' | ')}`);
    }
    const reportType = args.type as ReportType;

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const reportParams: ReportParams = { board_id: boardId, type: reportType };
      const result = engine.report(reportParams);
      return jsonResponse(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiCreateTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_create_task',
    description:
      'Create a task of type simple/project/recurring/inbox. Use this only when the user explicitly asks to create/register/add/capture work. MUST NOT call this for bare standalone goal/activity phrases like "Aguardar e acompanhar X", "Submeter X", or "Realizar X"; those are ambiguous and must be confirmed first. type=simple goes to next_action; type=inbox stays in inbox; type=project allocates a P-prefix id and creates subtask rows; type=recurring allocates the recurrence cycle. Use api_create_meeting_task for meetings. If the user is adding a new task to an existing project by explicit ID (for example "P11 acrescentar tarefa X" or "adicionar em P3 a tarefa X"), first create type=simple, then call api_admin action=reparent_task with task_id=data.id and target_parent_id=P11/P3. If the user names the existing project by title (for example "Projeto de Operação da SECTI adicionar tarefa X") and the project is identifiable, do NOT use api_create_task; use api_update_task with updates.add_subtask on the matched project id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: [...CREATE_TASK_TYPES] },
        title: { type: 'string' },
        sender_name: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        due_date: { type: ['string', 'null'] },
        labels: { type: 'array', items: { type: 'string' } },
        subtasks: { type: 'array' },
        recurrence: { type: 'string', enum: [...RECURRENCES] },
        recurrence_anchor: { type: 'string' },
        recurrence_end_date: { type: 'string' },
        max_cycles: { type: 'integer' },
        allow_non_business_day: { type: 'boolean' },
        intended_weekday: { type: 'string' },
        requires_close_approval: { type: 'boolean' },
      },
      required: ['title', 'sender_name', 'type'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const title = requireString(args, 'title');
    if (title === null) return err('title: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');
    if (
      typeof args.type !== 'string' ||
      !CREATE_TASK_TYPES.includes(args.type as CreateTaskType)
    ) {
      return err(`type: expected one of ${CREATE_TASK_TYPES.join(' | ')}`);
    }
    const taskType = args.type as CreateTaskType;

    let assignee: string | undefined;
    if (args.assignee !== undefined) {
      if (typeof args.assignee !== 'string') return err('assignee: expected string');
      assignee = args.assignee;
    }
    let priority: Priority | undefined;
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority as Priority)) {
        return err(`priority: expected one of ${PRIORITIES.join(' | ')}`);
      }
      priority = args.priority as Priority;
    }
    let dueDate: string | undefined;
    if (args.due_date !== undefined && args.due_date !== null) {
      if (typeof args.due_date !== 'string') return err('due_date: expected string or null');
      dueDate = args.due_date;
    }
    let labels: string[] | undefined;
    if (args.labels !== undefined) {
      if (!Array.isArray(args.labels) || args.labels.some((l) => typeof l !== 'string')) {
        return err('labels: expected array of strings');
      }
      labels = args.labels as string[];
    }
    // Subtasks accept either a string (title-only) or {title, assignee?}.
    // We validate shape but defer assignee-resolution to the engine.
    let subtasks: Array<string | { title: string; assignee?: string }> | undefined;
    if (args.subtasks !== undefined) {
      if (!Array.isArray(args.subtasks)) return err('subtasks: expected array');
      const validated: Array<string | { title: string; assignee?: string }> = [];
      for (let i = 0; i < args.subtasks.length; i++) {
        const sub = args.subtasks[i];
        if (typeof sub === 'string') {
          validated.push(sub);
        } else if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
          const s = sub as Record<string, unknown>;
          if (typeof s.title !== 'string') return err(`subtasks[${i}].title: expected string`);
          if (s.assignee !== undefined && typeof s.assignee !== 'string') {
            return err(`subtasks[${i}].assignee: expected string`);
          }
          validated.push({ title: s.title, assignee: s.assignee as string | undefined });
        } else {
          return err(`subtasks[${i}]: expected string or object`);
        }
      }
      subtasks = validated;
    }
    let recurrence: Recurrence | undefined;
    if (args.recurrence !== undefined) {
      if (
        typeof args.recurrence !== 'string' ||
        !RECURRENCES.includes(args.recurrence as Recurrence)
      ) {
        return err(`recurrence: expected one of ${RECURRENCES.join(' | ')}`);
      }
      recurrence = args.recurrence as Recurrence;
    }
    let recurrenceAnchor: string | undefined;
    if (args.recurrence_anchor !== undefined) {
      if (typeof args.recurrence_anchor !== 'string') return err('recurrence_anchor: expected string');
      recurrenceAnchor = args.recurrence_anchor;
    }
    let recurrenceEndDate: string | undefined;
    if (args.recurrence_end_date !== undefined) {
      if (typeof args.recurrence_end_date !== 'string') return err('recurrence_end_date: expected string');
      recurrenceEndDate = args.recurrence_end_date;
    }
    let maxCycles: number | undefined;
    if (args.max_cycles !== undefined) {
      if (typeof args.max_cycles !== 'number' || !Number.isInteger(args.max_cycles)) {
        return err('max_cycles: expected integer');
      }
      maxCycles = args.max_cycles;
    }
    let intendedWeekday: string | undefined;
    if (args.intended_weekday !== undefined) {
      if (typeof args.intended_weekday !== 'string') return err('intended_weekday: expected string');
      intendedWeekday = args.intended_weekday;
    }
    let allowNonBusinessDay: boolean | undefined;
    if (args.allow_non_business_day !== undefined) {
      if (typeof args.allow_non_business_day !== 'boolean') {
        return err('allow_non_business_day: expected boolean');
      }
      allowNonBusinessDay = args.allow_non_business_day;
    }
    let requiresCloseApproval: boolean | undefined;
    if (args.requires_close_approval !== undefined) {
      if (typeof args.requires_close_approval !== 'boolean') {
        return err('requires_close_approval: expected boolean');
      }
      requiresCloseApproval = args.requires_close_approval;
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      const result = engine.create({
        board_id: boardId,
        type: taskType,
        title,
        sender_name: senderName,
        assignee,
        priority,
        due_date: dueDate,
        labels,
        subtasks,
        recurrence,
        recurrence_anchor: recurrenceAnchor,
        recurrence_end_date: recurrenceEndDate,
        max_cycles: maxCycles,
        intended_weekday: intendedWeekday,
        allow_non_business_day: allowNonBusinessDay,
        requires_close_approval: requiresCloseApproval,
      });
      return finalizeCreatedTaskResult(db, engine, boardId, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiUpdateTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_update_task',
    description:
      "Apply a v1-shape composite update to a task. The `updates` object accepts any field engine.update's UpdateParams.updates supports: title, priority, requires_close_approval, due_date, description, next_action, add_label, remove_label, add_note, edit_note ({id, text}), remove_note, parent_note_id, scheduled_at, participant ops, set_note_status, subtask ops (add/rename/reopen/assign/unassign), recurrence ops. Engine validates per-sub-key. Use updates.add_subtask for explicit subtask/step wording like \"adicionar etapa P3: X\" and for named-project requests like \"Projeto de Operação da SECTI adicionar tarefa X\". Do not use this for explicit project-ID task-add commands like \"adicionar em P3 a tarefa X\"; those mirror v1 as api_create_task(type=simple) followed by api_admin(reparent_task).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        updates: { type: 'object' },
        sender_external_id: { type: 'string' },
        confirmed_task_id: { type: 'string' },
      },
      required: ['task_id', 'sender_name', 'updates'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    const { boardId, taskId, senderName } = parsed;

    if (args.updates === undefined) return err('updates: required object');
    if (
      args.updates === null ||
      typeof args.updates !== 'object' ||
      Array.isArray(args.updates)
    ) {
      return err('updates: expected object');
    }
    let senderExternalId: string | undefined;
    if (args.sender_external_id !== undefined) {
      if (typeof args.sender_external_id !== 'string') return err('sender_external_id: expected string');
      senderExternalId = args.sender_external_id;
    }
    let confirmedTaskId: string | undefined;
    if (args.confirmed_task_id !== undefined) {
      if (typeof args.confirmed_task_id !== 'string') return err('confirmed_task_id: expected string');
      confirmedTaskId = args.confirmed_task_id;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const updateParams: UpdateParams = {
        board_id: boardId,
        task_id: taskId,
        sender_name: senderName,
        updates: args.updates as UpdateParams['updates'],
        sender_external_id: senderExternalId,
        confirmed_task_id: confirmedTaskId,
      };
      const result = engine.update(updateParams);
      return finalizeMutationResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiQueryTool: McpToolDefinition = {
  tool: {
    name: 'api_query',
    description:
      "Composite read-side wrapper for engine.query. The `query` discriminator selects the sub-query: board, projects (compact active project list), project_next_actions (one-shot next actions for every project), projects_detailed (projects + activities + note excerpts), task_details (needs task_id and returns compact formatted_task_details plus small task/subtask summaries; use this for IDs like P11), task_history (needs task_id), find_task_in_organization (needs task_id; scoped read across this board's org tree — use this when task_details returns 'not found' for a task that may live on a sibling/parent board, mirrors find_person_in_organization), audit_v1_bugs (optional `since` ISO timestamp; returns same-task / same-user / <60min self-correction pairs on this board — date_field_correction, reassign_round_trip, conclude_reopen — for daily v1-bug monitoring), my_tasks/next_action/overdue/waiting/urgent/review/upcoming_meetings/meetings/summary/statistics/month_statistics (board-wide views), person_tasks/person_waiting/person_completed/person_review/person_statistics (need person_name), search/archive_search (need search_text), and others. Exact IDs stay exact: if the user says P6.7, call task_details/task_history with task_id=P6.7, not parent P6 or sibling P6.* tasks. Engine rejects unknown discriminators.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        sender_name: { type: 'string' },
        person_name: { type: 'string' },
        task_id: { type: 'string' },
        search_text: { type: 'string' },
        label: { type: 'string' },
        since: { type: 'string' },
        at: { type: 'string' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const query = requireString(args, 'query');
    if (query === null) return err('query: required string');

    const queryParams: QueryParams = { query };
    for (const key of [
      'sender_name', 'person_name', 'task_id', 'search_text', 'label', 'since', 'at',
    ] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'string') return err(`${key}: expected string`);
        (queryParams as unknown as Record<string, unknown>)[key] = args[key];
      }
    }

    try {
      // {readonly: true} matches the other read-side tools (api_board_activity,
      // api_filter_board_tasks, api_linked_tasks). Without it the constructor
      // runs migrations + delegation-link reconciliation that mutates rows on
      // a supposedly read-only path. Codex flagged 2026-05-10.
      // Note: query: 'search' falls back to lexical because query_vector /
      // embedding_reader aren't exposed through this MCP schema (engine still
      // supports semantic ranking via those fields).
      const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
      const result = engine.query(queryParams);
      if (query === 'task_details') {
        return jsonResponse(compactTaskDetailsQueryResult(result));
      }
      if (query === 'find_task_in_organization') {
        return jsonResponse(compactFindTaskInOrganizationQueryResult(result));
      }
      return jsonResponse(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiHierarchyTool: McpToolDefinition = {
  tool: {
    name: 'api_hierarchy',
    description:
      "Hierarchy / parent-board linking ops via engine.hierarchy. Actions: link (delegate task to a child board owned by person_name); unlink (sever the child-board delegation); refresh_rollup (recompute the linked task's rollup status); tag_parent (mark this task as a child of parent_task_id on the parent board). User phrases like 'atualizar status P11.19' or 'sincronizar P11.19' mean action=refresh_rollup, not a request to ask which status to set.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...HIERARCHY_ACTIONS] },
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        person_name: { type: 'string' },
        parent_task_id: { type: 'string' },
      },
      required: ['action', 'task_id', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    const { boardId, taskId, senderName } = parsed;
    if (typeof args.action !== 'string' || !HIERARCHY_ACTIONS.includes(args.action as HierarchyAction)) {
      return err(`action: expected one of ${HIERARCHY_ACTIONS.join(' | ')}`);
    }
    const action = args.action as HierarchyAction;

    let personName: string | undefined;
    if (args.person_name !== undefined) {
      if (typeof args.person_name !== 'string') return err('person_name: expected string');
      personName = args.person_name;
    }
    let parentTaskId: string | undefined;
    if (args.parent_task_id !== undefined) {
      if (typeof args.parent_task_id !== 'string') return err('parent_task_id: expected string');
      parentTaskId = args.parent_task_id;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const params: HierarchyParams = {
        board_id: boardId,
        action,
        task_id: taskId,
        sender_name: senderName,
        person_name: personName,
        parent_task_id: parentTaskId,
      };
      const result = engine.hierarchy(params);
      return finalizeMutationResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiDependencyTool: McpToolDefinition = {
  tool: {
    name: 'api_dependency',
    description:
      "Dependency + reminder ops via engine.dependency. Actions: add_dep / remove_dep (manage task blockers via target_task_id); add_reminder / remove_reminder (schedule a follow-up nudge via reminder_days from now).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...DEPENDENCY_ACTIONS] },
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        target_task_id: { type: 'string' },
        reminder_days: { type: 'integer' },
      },
      required: ['action', 'task_id', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    const { boardId, taskId, senderName } = parsed;
    if (
      typeof args.action !== 'string' ||
      !DEPENDENCY_ACTIONS.includes(args.action as DependencyAction)
    ) {
      return err(`action: expected one of ${DEPENDENCY_ACTIONS.join(' | ')}`);
    }
    const action = args.action as DependencyAction;

    let targetTaskId: string | undefined;
    if (args.target_task_id !== undefined) {
      if (typeof args.target_task_id !== 'string') return err('target_task_id: expected string');
      targetTaskId = args.target_task_id;
    }
    let reminderDays: number | undefined;
    if (args.reminder_days !== undefined) {
      if (typeof args.reminder_days !== 'number' || !Number.isInteger(args.reminder_days)) {
        return err('reminder_days: expected integer');
      }
      reminderDays = args.reminder_days;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const params: DependencyParams = {
        board_id: boardId,
        action,
        task_id: taskId,
        sender_name: senderName,
        target_task_id: targetTaskId,
        reminder_days: reminderDays,
      };
      const result = engine.dependency(params);
      return finalizeMutationResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

registerTools([
  apiCreateSimpleTaskTool, apiCreateMeetingTaskTool, apiCreateTaskTool,
  apiMoveTool, apiAdminTool, apiReassignTool, apiUndoTool, apiReportTool,
  apiUpdateTaskTool, apiQueryTool, apiHierarchyTool, apiDependencyTool,
  apiDeleteSimpleTaskTool,
]);
