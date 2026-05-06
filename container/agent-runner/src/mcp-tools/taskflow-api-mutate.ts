/**
 * Mutate-side TaskFlow MCP tools.
 *
 * Each handler instantiates a fresh writable `TaskflowEngine`, calls the
 * matching engine method, and JSON-stringifies the result. The shared
 * MCP response shape is `{ success, data, notification_events }` for
 * happy paths and `{ success: false, error_code?, error }` otherwise.
 */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err, requireString } from './util.js';

function jsonResponse(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
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
    let priority: 'low' | 'normal' | 'high' | 'urgent' | undefined;
    if (args.priority !== undefined) {
      if (
        args.priority !== 'low' &&
        args.priority !== 'normal' &&
        args.priority !== 'high' &&
        args.priority !== 'urgent'
      ) {
        return err('priority: expected one of low | normal | high | urgent');
      }
      priority = args.priority;
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
      if (!result.success) {
        return jsonResponse({ success: false, error: result.error });
      }
      if (!result.task_id) {
        return jsonResponse({
          success: false,
          error: 'engine returned success without task_id',
        });
      }
      const taskId = result.task_id;
      const row = db
        .prepare(
          `SELECT t.*, b.short_code AS board_code FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND t.board_id = ?`,
        )
        .get(taskId, boardId) as Record<string, unknown>;
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
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const taskId = requireString(args, 'task_id');
    if (taskId === null) return err('task_id: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');
    let senderIsService: boolean | undefined;
    if (args.sender_is_service !== undefined) {
      if (typeof args.sender_is_service !== 'boolean') {
        return err('sender_is_service: expected boolean');
      }
      senderIsService = args.sender_is_service;
    }

    const engine = new TaskflowEngine(getTaskflowDb(), boardId);
    const result = engine.apiDeleteSimpleTask({
      board_id: boardId,
      task_id: taskId,
      sender_name: senderName,
      sender_is_service: senderIsService,
    });
    return jsonResponse(result);
  },
};

registerTools([apiCreateSimpleTaskTool, apiDeleteSimpleTaskTool]);
