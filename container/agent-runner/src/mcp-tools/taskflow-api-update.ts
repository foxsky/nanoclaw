/**
 * api_update_simple_task. The entire field/column/assignee/role-gate flow
 * lives in this handler — there is no engine method for "update".
 */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import { normalizeAgentIds } from './taskflow-helpers.js';
import type { McpToolDefinition } from './types.js';
import { err, jsonResponse, parseTaskActorArgs } from './util.js';

export const apiUpdateSimpleTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_update_simple_task',
    description: 'Update a simple task via the REST API (flat field updates and column moves). Do not use for explicit assignment commands like "atribuir P11.23 para Rodrigo"; use api_reassign so v1 reassignment semantics, confirmations, and already-assigned handling are preserved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
        column: { type: 'string' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        assignee: { type: ['string', 'null'] },
        priority: { type: 'string' },
        due_date: { type: ['string', 'null'] },
        labels: { type: ['array', 'null'], items: { type: 'string' } },
      },
      required: ['task_id', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    const { boardId, taskId, senderName, senderIsService } = parsed;

    // Optional field shapes (zod parity):
    //   z.string().optional()                → string | undefined
    //   z.string().nullable().optional()     → string | null | undefined
    //   z.array(z.string().trim().min(1)).nullable().optional()
    //
    // `.optional()` accepts both key-absent AND key-present-with-undefined; the
    // v1 SET-clause builder ANDs with `'X' in params` and pushes `?? null`,
    // which means explicit `undefined` on a non-nullable field clears the
    // column to NULL (and would fail v1's NOT NULL constraint — the buggy
    // behavior must be preserved for byte parity).
    const hasColumn = 'column' in args;
    if (hasColumn && args.column !== undefined && typeof args.column !== 'string') {
      return err('column: expected string');
    }
    const hasTitle = 'title' in args;
    if (hasTitle && args.title !== undefined && typeof args.title !== 'string') {
      return err('title: expected string');
    }
    const hasDescription = 'description' in args;
    if (
      hasDescription &&
      args.description !== null &&
      args.description !== undefined &&
      typeof args.description !== 'string'
    ) {
      return err('description: expected string or null');
    }
    const hasAssignee = 'assignee' in args;
    if (
      hasAssignee &&
      args.assignee !== null &&
      args.assignee !== undefined &&
      typeof args.assignee !== 'string'
    ) {
      return err('assignee: expected string or null');
    }
    const hasPriority = 'priority' in args;
    if (hasPriority && args.priority !== undefined && typeof args.priority !== 'string') {
      return err('priority: expected string');
    }
    const hasDueDate = 'due_date' in args;
    if (
      hasDueDate &&
      args.due_date !== null &&
      args.due_date !== undefined &&
      typeof args.due_date !== 'string'
    ) {
      return err('due_date: expected string or null');
    }
    const hasLabels = 'labels' in args;
    let labelsArr: string[] | null = null;
    if (
      hasLabels &&
      args.labels !== null &&
      args.labels !== undefined &&
      !Array.isArray(args.labels)
    ) {
      return err('labels: expected array or null');
    }
    if (hasLabels && Array.isArray(args.labels)) {
      labelsArr = [];
      for (const l of args.labels) {
        if (typeof l !== 'string') return err('labels: each item must be a string');
        // v1 zod `.trim().min(1)` transforms the input — store the trimmed value.
        const trimmed = l.trim();
        if (trimmed.length === 0) {
          return err('labels: each item must be non-empty after trim');
        }
        labelsArr.push(trimmed);
      }
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);

      const existing = db
        .prepare(
          `SELECT t.*, b.short_code AS board_code FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND t.board_id = ?`,
        )
        .get(taskId, boardId) as Record<string, unknown> | null;
      if (!existing) {
        const visibleTask = engine.getTask(taskId) as Record<string, unknown> | null;
        const visibleTaskBoardId = typeof visibleTask?.board_id === 'string' ? visibleTask.board_id : null;
        if (visibleTask && visibleTaskBoardId && visibleTaskBoardId !== boardId) {
          if (hasColumn || hasAssignee || hasLabels) {
            return jsonResponse({
              success: false,
              error_code: 'not_found',
              error: `Task not found: ${taskId}`,
            });
          }

          const updates: Parameters<TaskflowEngine['update']>[0]['updates'] = {};
          if (hasTitle) updates.title = args.title as string;
          if (hasDescription && args.description !== null) updates.description = args.description as string;
          if (hasPriority) {
            const priorityMap: Record<string, 'low' | 'normal' | 'high' | 'urgent'> = {
              urgent: 'urgent',
              high: 'high',
              normal: 'normal',
              low: 'low',
              urgente: 'urgent',
              alta: 'high',
              baixa: 'low',
            };
            updates.priority = priorityMap[(args.priority as string) ?? ''] ?? (args.priority as any);
          }
          if (hasDueDate) updates.due_date = (args.due_date as string | null | undefined) ?? null;

          const result = engine.update({
            board_id: boardId,
            task_id: taskId,
            sender_name: senderName,
            updates,
          });
          return jsonResponse(result);
        }

        return jsonResponse({
          success: false,
          error_code: 'not_found',
          error: `Task not found: ${taskId}`,
        });
      }

      const senderPerson = senderIsService
        ? undefined
        : (db
            .prepare(`SELECT person_id, role FROM board_people WHERE board_id = ? AND name = ?`)
            .get(boardId, senderName) as { person_id: string; role: string } | null) ?? undefined;

      if (!senderIsService) {
        const isGestor = senderPerson?.role === 'Gestor';
        if (!isGestor) {
          const createdBy = existing['created_by'] as string | null;
          const assignee = existing['assignee'] as string | null;
          const isCreatorOrUnowned = createdBy === null || createdBy === senderName;
          const isAssignee = assignee !== null && assignee === senderName;
          if (!isCreatorOrUnowned && !isAssignee) {
            return jsonResponse({
              success: false,
              error_code: 'actor_type_not_allowed',
              error: 'Not authorized to modify this task',
            });
          }
        }
      }

      if (hasColumn && args.column === 'done' && existing['requires_close_approval']) {
        return jsonResponse({
          success: false,
          error_code: 'conflict',
          error: 'Task requires close approval before moving to done',
        });
      }

      let resolvedAssignee: string | null | undefined = undefined;
      let newAssigneePersonId: string | null = null;
      if (hasAssignee) {
        if (args.assignee == null) {
          resolvedAssignee = null;
        } else {
          const person = db
            .prepare(
              `SELECT person_id, name FROM board_people WHERE board_id = ? AND (name = ? OR person_id = ?)`,
            )
            .get(boardId, args.assignee as string, args.assignee as string) as
            | { person_id: string; name: string }
            | null;
          if (!person) {
            return jsonResponse({
              success: false,
              error_code: 'validation_error',
              error: `Assignee not found: ${args.assignee}`,
            });
          }
          resolvedAssignee = person.name;
          newAssigneePersonId = person.person_id;
        }
      }

      const now = new Date().toISOString();
      const setClauses: string[] = ['updated_at = ?'];
      const setValues: (string | number | null)[] = [now];

      if (hasColumn) {
        setClauses.push('"column" = ?');
        setValues.push((args.column as string | null) ?? null);
      }
      if (hasTitle) {
        setClauses.push('title = ?');
        setValues.push((args.title as string | null) ?? null);
      }
      if (hasDescription) {
        setClauses.push('description = ?');
        setValues.push((args.description as string | null) ?? null);
      }
      if (hasAssignee) {
        setClauses.push('assignee = ?');
        setValues.push(resolvedAssignee ?? null);
      }
      let resolvedPriority: string | null = null;
      if (hasPriority) {
        const priorityMap: Record<string, string> = {
          urgent: 'urgente',
          high: 'alta',
          normal: 'normal',
          low: 'baixa',
          urgente: 'urgente',
          alta: 'alta',
          baixa: 'baixa',
        };
        resolvedPriority = priorityMap[args.priority as string] ?? (args.priority as string) ?? null;
        setClauses.push('priority = ?');
        setValues.push(resolvedPriority);
      }
      if (hasDueDate) {
        setClauses.push('due_date = ?');
        setValues.push((args.due_date as string | null) ?? null);
      }
      let labelsJson: string | null = null;
      if (hasLabels) {
        labelsJson = labelsArr === null ? '[]' : JSON.stringify(labelsArr);
        setClauses.push('labels = ?');
        setValues.push(labelsJson);
      }

      db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ? AND board_id = ?`).run(
        ...setValues,
        taskId,
        boardId,
      );

      const priorColumn = existing['column'] as string;
      const columnChanged = hasColumn && args.column !== priorColumn;
      engine.recordHistory(
        taskId,
        'updated',
        senderName,
        columnChanged ? JSON.stringify({ from: priorColumn, to: args.column }) : undefined,
      );

      const row: Record<string, unknown> = { ...existing, updated_at: now };
      if (hasColumn) row['column'] = args.column;
      if (hasTitle) row['title'] = args.title;
      if (hasDescription) row['description'] = args.description;
      if (hasAssignee) row['assignee'] = resolvedAssignee;
      if (hasPriority) row['priority'] = resolvedPriority;
      if (hasDueDate) row['due_date'] = args.due_date;
      if (hasLabels) row['labels'] = labelsJson;
      const data = engine.serializeApiTask(row);

      const notification_events: Array<{
        kind: string;
        board_id: string;
        target_person_id: string;
        message: string;
      }> = [];
      if (newAssigneePersonId) {
        if (!senderPerson || senderPerson.person_id !== newAssigneePersonId) {
          notification_events.push({
            kind: 'deferred_notification',
            board_id: boardId,
            target_person_id: newAssigneePersonId,
            message: `${senderName} assigned you: ${(row['title'] as string) ?? taskId}`,
          });
        }
      }
      if (hasColumn && args.column !== (existing['column'] as string)) {
        const existingAssigneeName = existing['assignee'] as string | null;
        if (existingAssigneeName) {
          const assigneePerson = db
            .prepare(`SELECT person_id FROM board_people WHERE board_id = ? AND name = ?`)
            .get(boardId, existingAssigneeName) as { person_id: string } | null;
          if (
            assigneePerson &&
            assigneePerson.person_id !== newAssigneePersonId &&
            (!senderPerson || senderPerson.person_id !== assigneePerson.person_id)
          ) {
            const fromColumn = existing['column'] as string;
            const toColumn = args.column as string;
            const title = (row['title'] as string) ?? taskId;
            const base = { taskId, title, assigneeName: existingAssigneeName };
            let message: string;
            if (toColumn === 'done') {
              const taskRow = {
                recurrence: (existing['recurrence'] as string | null) ?? null,
                requires_close_approval: existing['requires_close_approval'],
                created_at: (existing['created_at'] as string | null) ?? null,
              };
              const variant = TaskflowEngine.completionVariant(taskRow);
              const renderParams =
                variant === 'quiet'
                  ? { variant, ...base }
                  : variant === 'loud'
                    ? {
                        variant,
                        ...base,
                        createdAt: taskRow.created_at,
                        flow: TaskflowEngine.computeTaskFlow(db, boardId, taskId),
                      }
                    : { variant, ...base, fromColumn };
              message = TaskflowEngine.renderCompletionMessage(renderParams);
            } else {
              const oldLabel = TaskflowEngine.columnLabelPlain(fromColumn);
              const newLabel = TaskflowEngine.columnLabelPlain(toColumn);
              message = `\u{1F514} *Tarefa movida*\n\n*${taskId}* — ${title}\n*${oldLabel}* → *${newLabel}*\n\nDigite \`${taskId}\` para ver detalhes.`;
            }
            notification_events.push({
              kind: 'deferred_notification',
              board_id: boardId,
              target_person_id: assigneePerson.person_id,
              message,
            });
          }
        }
      }

      return jsonResponse({ success: true, data, notification_events });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error_code: 'internal_error', error: msg });
    }
  },
};

registerTools([apiUpdateSimpleTaskTool]);
