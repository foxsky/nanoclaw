/**
 * Three note-mutation MCP tools — trivial delegates to engine methods.
 * V1 lines 532-583 of taskflow-mcp-server.ts at sha ec84a745.
 */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err, requireString } from './util.js';

function jsonResponse(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

type CommonNoteArgs = {
  ok: true;
  boardId: string;
  taskId: string;
  senderName: string;
  senderIsService: boolean | undefined;
};
type CommonNoteParseResult = CommonNoteArgs | { ok: false; error: ReturnType<typeof err> };

/** Validates required board_id, task_id, sender_name, optional sender_is_service. */
function parseCommonNoteArgs(args: Record<string, unknown>): CommonNoteParseResult {
  const boardId = requireString(args, 'board_id');
  if (boardId === null) return { ok: false, error: err('board_id: required string') };
  const taskId = requireString(args, 'task_id');
  if (taskId === null) return { ok: false, error: err('task_id: required string') };
  const senderName = requireString(args, 'sender_name');
  if (senderName === null) return { ok: false, error: err('sender_name: required string') };
  let senderIsService: boolean | undefined;
  if (args.sender_is_service !== undefined) {
    if (typeof args.sender_is_service !== 'boolean') {
      return { ok: false, error: err('sender_is_service: expected boolean') };
    }
    senderIsService = args.sender_is_service;
  }
  return { ok: true, boardId, taskId, senderName, senderIsService };
}

export const apiTaskAddNoteTool: McpToolDefinition = {
  tool: {
    name: 'api_task_add_note',
    description: 'Add a note to a task; delegates to engine.apiAddNote (shares engine.update logic)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
        text: { type: 'string' },
        parent_note_id: { type: 'integer' },
      },
      required: ['board_id', 'task_id', 'sender_name', 'text'],
    },
  },
  async handler(args) {
    const parsed = parseCommonNoteArgs(args);
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
    description: 'Edit a note on a task; delegates to engine.apiEditNote',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
        note_id: { type: 'integer' },
        text: { type: 'string' },
      },
      required: ['board_id', 'task_id', 'sender_name', 'note_id', 'text'],
    },
  },
  async handler(args) {
    const parsed = parseCommonNoteArgs(args);
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
    description: 'Remove a note from a task; delegates to engine.apiRemoveNote',
    inputSchema: {
      type: 'object' as const,
      properties: {
        board_id: { type: 'string' },
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
        note_id: { type: 'integer' },
      },
      required: ['board_id', 'task_id', 'sender_name', 'note_id'],
    },
  },
  async handler(args) {
    const parsed = parseCommonNoteArgs(args);
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
