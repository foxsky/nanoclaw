/** Three note-mutation MCP tools — trivial delegates to engine methods. */
import { getTaskflowDb } from '../db/connection.js';
import { TaskflowEngine } from '../taskflow-engine.js';
import { emitMutationConfirmation } from './mutation-confirmation.js';
import { registerTools } from './server.js';
import { addEditNoteFormattedResult, addNoteFormattedResult, safeNotificationEvents } from './taskflow-api-mutate.js';
import { enqueueDeferredNotificationsInSession } from './pending-notification-dispatch.js';
import { dispatchNotificationEvents } from './taskflow-notify-dispatch.js';
import { requiresChatActor } from './chat-actor-guard.js';
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
    // engine.apiAddNote returns {success, data: serializedTask, changes}, so
    // emission bypasses finalizeMutationResult to avoid double-nesting `data`.
    const finalResult = addNoteFormattedResult(result, {
      task_id: parsed.taskId,
      text: args.text,
      parent_note_id: parentNoteId,
    });
    emitMutationConfirmation(finalResult);
    if (!result.success) return jsonResponse(finalResult);
    // V1 parity (EX-019): apiAddNote now builds the owner/parent notification
    // (it was silent). Deliver it deterministically like every other mutation —
    // normalize → enqueue-deferred-first → dispatch, in-session-gated + fail-soft —
    // AND surface it as `notification_events` while stripping the raw engine
    // notification fields, exactly as api_task_add_comment / finalizeMutationResult
    // do. This keeps the FastAPI/no-service-bus path working (the dashboard reads
    // notification_events from the response when the bus no-ops) and avoids leaking
    // dispatch-only fields. (Codex review 2026-06-11.)
    const notification_events = safeNotificationEvents(result);
    enqueueDeferredNotificationsInSession(parsed.boardId, notification_events, parsed.taskId, {});
    dispatchNotificationEvents(notification_events, parsed.boardId ? { boardId: parsed.boardId } : {});
    const { notifications: _rawNotifs, parent_notification: _rawParent, ...responseBody } =
      finalResult as Record<string, unknown>;
    return jsonResponse({ ...responseBody, notification_events });
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
    const finalResult = addEditNoteFormattedResult(result, {
      task_id: parsed.taskId,
      note_id: args.note_id,
      text: args.text,
    });
    emitMutationConfirmation(finalResult);
    return jsonResponse(finalResult);
  },
};

export const apiTaskRemoveNoteTool: McpToolDefinition = {
  tool: {
    name: 'api_task_remove_note',
    description: 'Remove a note from a task; delegates to engine.apiRemoveNote. Preserve board-prefixed task IDs exactly, e.g. SEC-T41 must stay SEC-T41, not T41. If the note is already absent, the tool returns success with no_op=true; tell the user it was not found and do not retry or forward the request.',
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
    if (
      result.success === false &&
      (result as any).error_code === 'validation_error' &&
      typeof result.error === 'string' &&
      /^Note #\d+ not found\./.test(result.error)
    ) {
      return jsonResponse({
        success: true,
        no_op: true,
        reason: 'note_not_found',
        task_id: parsed.taskId,
        note_id: args.note_id,
        formatted_response: `A nota #${args.note_id} não foi encontrada em ${parsed.taskId}.`,
      });
    }
    return jsonResponse(result);
  },
};

// #419: note mutations require an authenticated chat actor (see chat-actor-guard.ts).
registerTools([
  requiresChatActor(apiTaskAddNoteTool),
  requiresChatActor(apiTaskEditNoteTool),
  requiresChatActor(apiTaskRemoveNoteTool),
]);
