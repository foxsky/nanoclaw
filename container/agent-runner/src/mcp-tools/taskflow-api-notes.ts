/** Three note-mutation MCP tools — trivial delegates to engine methods. */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import { normalizeAgentIds } from './taskflow-helpers.js';
import type { McpToolDefinition } from './types.js';
import { err, jsonResponse, parseTaskActorArgs } from './util.js';

export const apiTaskAddNoteTool: McpToolDefinition = {
  tool: {
    name: 'api_task_add_note',
    description: 'Add a note to a task; delegates to engine.apiAddNote (shares engine.update logic). Preserve board-prefixed task IDs exactly, e.g. SEC-T41 must stay SEC-T41, not T41.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
        text: { type: 'string' },
        parent_note_id: { type: 'integer' },
      },
      required: ['task_id', 'sender_name', 'text'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    if (typeof args.text !== 'string' || args.text.length === 0) {
      return err('text: required non-empty string');
    }
    let parentNoteId: number | undefined;
    if (args.parent_note_id !== undefined) {
      if (typeof args.parent_note_id !== 'number' || !Number.isInteger(args.parent_note_id)) {
        return err('parent_note_id: expected integer');
      }
      parentNoteId = args.parent_note_id;
    }
    const engine = new TaskflowEngine(getTaskflowDb(), parsed.boardId);
    const result = engine.apiAddNote({
      board_id: parsed.boardId,
      task_id: parsed.taskId,
      sender_name: parsed.senderName,
      sender_is_service: parsed.senderIsService,
      text: args.text,
      parent_note_id: parentNoteId,
    });
    return jsonResponse(result);
  },
};

export const apiTaskEditNoteTool: McpToolDefinition = {
  tool: {
    name: 'api_task_edit_note',
    description: 'Edit a note on a task; delegates to engine.apiEditNote. Preserve board-prefixed task IDs exactly, e.g. SEC-T41 must stay SEC-T41, not T41.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
        note_id: { type: 'integer' },
        text: { type: 'string' },
      },
      required: ['task_id', 'sender_name', 'note_id', 'text'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    if (typeof args.note_id !== 'number' || !Number.isInteger(args.note_id)) {
      return err('note_id: expected integer');
    }
    if (typeof args.text !== 'string' || args.text.length === 0) {
      return err('text: required non-empty string');
    }
    const engine = new TaskflowEngine(getTaskflowDb(), parsed.boardId);
    const result = engine.apiEditNote({
      board_id: parsed.boardId,
      task_id: parsed.taskId,
      sender_name: parsed.senderName,
      sender_is_service: parsed.senderIsService,
      note_id: args.note_id,
      text: args.text,
    });
    return jsonResponse(result);
  },
};

export const apiTaskRemoveNoteTool: McpToolDefinition = {
  tool: {
    name: 'api_task_remove_note',
    description: 'Remove a note from a task; delegates to engine.apiRemoveNote. Preserve board-prefixed task IDs exactly, e.g. SEC-T41 must stay SEC-T41, not T41.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
        note_id: { type: 'integer' },
      },
      required: ['task_id', 'sender_name', 'note_id'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    if (typeof args.note_id !== 'number' || !Number.isInteger(args.note_id)) {
      return err('note_id: expected integer');
    }
    const engine = new TaskflowEngine(getTaskflowDb(), parsed.boardId);
    const result = engine.apiRemoveNote({
      board_id: parsed.boardId,
      task_id: parsed.taskId,
      sender_name: parsed.senderName,
      sender_is_service: parsed.senderIsService,
      note_id: args.note_id,
    });
    return jsonResponse(result);
  },
};

registerTools([apiTaskAddNoteTool, apiTaskEditNoteTool, apiTaskRemoveNoteTool]);
