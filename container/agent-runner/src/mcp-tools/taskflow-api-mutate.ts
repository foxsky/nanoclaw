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
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { normalizeEngineNotificationEvents } from './taskflow-helpers.js';
import { err, jsonResponse, parseTaskActorArgs, requireString } from './util.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

const MOVE_ACTIONS = [
  'start', 'wait', 'resume', 'return', 'review',
  'approve', 'reject', 'conclude', 'reopen', 'force_start',
] as const;
type MoveAction = (typeof MOVE_ACTIONS)[number];

interface CreateLikeResult {
  success: boolean;
  task_id?: string;
  error?: string;
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
  return jsonResponse({ success: true, data, notification_events });
}

export const apiCreateSimpleTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_create_simple_task',
    description: 'Create a simple task via the REST API',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        title: { type: 'string' },
        sender_name: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        due_date: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
      },
      required: ['board_id', 'title', 'sender_name'],
    },
  },
  async handler(args) {
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
        board_id: { type: 'string' },
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
      },
      required: ['board_id', 'title', 'sender_name'],
    },
  },
  async handler(args) {
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
        board_id: { type: 'string' },
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
      },
      required: ['board_id', 'task_id', 'sender_name'],
    },
  },
  async handler(args) {
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
      'Move a task across the state machine. Actions: start, wait, resume, return, review, approve, reject, conclude, reopen, force_start. Engine enforces from-column transition + role-based permissions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        task_id: { type: 'string' },
        action: { type: 'string', enum: [...MOVE_ACTIONS] },
        sender_name: { type: 'string' },
        reason: { type: 'string' },
        subtask_id: { type: 'string' },
        confirmed_task_id: { type: 'string' },
      },
      required: ['board_id', 'task_id', 'action', 'sender_name'],
    },
  },
  async handler(args) {
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    const { boardId, taskId, senderName } = parsed;
    if (typeof args.action !== 'string' || !MOVE_ACTIONS.includes(args.action as MoveAction)) {
      return err(`action: expected one of ${MOVE_ACTIONS.join(' | ')}`);
    }
    const action = args.action as MoveAction;

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
      const result = engine.move({
        board_id: boardId,
        task_id: taskId,
        action,
        sender_name: senderName,
        reason,
        subtask_id: subtaskId,
        confirmed_task_id: confirmedTaskId,
      });
      // Strip `notifications` (rewritten as `notification_events`) but
      // preserve every other engine field on both paths so callers see
      // structured fields they may need: success → wip_warning,
      // project_update, parent_notification etc.; failure → error_code,
      // expected_task_id, actual_task_id (magnetism retry contract,
      // required to honor confirmed_task_id on retry).
      const { notifications: _notifications, success, ...rest } = result;
      const notification_events = normalizeEngineNotificationEvents(result);
      if (!success) return jsonResponse({ success: false, ...rest, notification_events });
      return jsonResponse({ success: true, data: rest, notification_events });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

registerTools([apiCreateSimpleTaskTool, apiCreateMeetingTaskTool, apiMoveTool, apiDeleteSimpleTaskTool]);
