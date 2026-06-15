/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { resolveTaskflowBoardId } from '../../taskflow-db.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

/**
 * Defense-in-depth host layer: a TaskFlow board session must not persist a task `script`. The
 * container MCP gate (scheduling.ts) and execution gate (task-script.ts) already refuse scripts on
 * boards, but there was no host-side check — unlike install_packages' two layers. Strip + warn if
 * a script reaches here for a board session.
 */
function stripBoardScript(session: Session, script: string | null): string | null {
  if (!script) return script;
  const ag = getAgentGroup(session.agent_group_id);
  if (!ag) {
    // Can't resolve the agent group → can't confirm this is a non-board session. Fail CLOSED.
    log.warn('Host scheduling: stripping task script — agent group unresolved (cannot confirm non-board)', {
      agentGroupId: session.agent_group_id,
    });
    return null;
  }
  // Residual fail-open: resolveTaskflowBoardId swallows a taskflow.db open error and returns
  // undefined (indistinguishable from a genuine non-board session), so a board script could slip
  // through if taskflow.db is unreadable at this instant. Narrow + pre-existing — the board's
  // container just used taskflow.db to emit this very system message — and the container MCP gate
  // (scheduling.ts) + execution gate (task-script.ts) are the primary controls.
  const boardId = resolveTaskflowBoardId(ag.folder, true);
  if (boardId) {
    log.warn('Host scheduling: stripped task script for a TaskFlow board session', {
      agentGroupId: session.agent_group_id,
      boardId,
    });
    return null;
  }
  return script;
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = stripBoardScript(session, content.script as string | null);
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  insertTask(inDb, {
    id: taskId,
    processAfter,
    recurrence,
    platformId: (content.platformId as string) ?? null,
    channelType: (content.channelType as string) ?? null,
    threadId: (content.threadId as string) ?? null,
    content: JSON.stringify({ prompt, script }),
  });
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  cancelTask(inDb, taskId);
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  pauseTask(inDb, taskId);
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  resumeTask(inDb, taskId);
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = stripBoardScript(session, content.script as string | null);
  }
  const touched = updateTask(inDb, taskId, update);
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
