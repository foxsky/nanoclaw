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
    // RC5-ext C4c (Codex R3 IMPORTANT): an EXTERNAL sender's tool result must not
    // carry board-private task data (description, other notes, assignee/creator
    // ids, notification target metadata) — the model could reflect it into the
    // external's allowed reply. normalizeAgentIds set sender_external_id from the
    // authenticated channel iff this is a resolved external turn.
    const isExternalSender = typeof args.sender_external_id === 'string' && args.sender_external_id.length > 0;
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
      // RC5-ext (C4): the authenticated external id, bound channel-only by
      // normalizeAgentIds (P3.3) — the engine re-checks the per-meeting grant.
      sender_external_id: typeof args.sender_external_id === 'string' ? args.sender_external_id : undefined,
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
    // Codex R4 IMPORTANT: the deterministic confirmation card can carry board
    // context (the note card / "already registered" card) and is emitted OUTSIDE
    // the sanitized JSON path — skip it for an external sender. Their only
    // model-/external-visible output is the minimal response below + the model's
    // own reply (out-of-band board notifications still dispatch).
    if (!isExternalSender) emitMutationConfirmation(finalResult);
    if (!result.success) {
      // External: a generic denial — never echo board context from the failure.
      if (isExternalSender) {
        return jsonResponse({ success: false, error_code: 'permission_denied', error: 'Not authorized to add a note to this task.' });
      }
      return jsonResponse(finalResult);
    }
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
    // External: notifications dispatched OUT OF BAND above; the model-visible
    // result is a minimal confirmation only — no task data, notes, person ids, or
    // notification target metadata that the model could reflect to the external.
    if (isExternalSender) {
      return jsonResponse({
        success: true,
        note_added: true,
        task_id: parsed.taskId,
        formatted_response: `Nota registrada em ${parsed.taskId}.`,
      });
    }
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
      sender_external_id: typeof args.sender_external_id === 'string' ? args.sender_external_id : undefined,
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
      sender_external_id: typeof args.sender_external_id === 'string' ? args.sender_external_id : undefined,
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
