import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  getAgentTurn,
  getAgentTurnMessages,
  createTask,
  deleteTask,
  getTaskById,
  recordSendMessageLog,
  updateTask,
} from './db.js';
import { resolveExternalDm, getTaskflowDb } from './dm-routing.js';
import { getGroupSenderName } from './group-sender.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  AgentTurnMessageRef,
  RegisteredGroup,
  SendTargetKind,
} from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  clearTyping?: (jid: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  createGroup?: (
    subject: string,
    participants: string[],
  ) => Promise<{
    jid: string;
    subject: string;
    inviteLink?: string;
    droppedParticipants?: string[];
  }>;
  resolvePhoneJid?: (phone: string) => Promise<string>;
  lookupPhoneJid?: (phone: string) => Promise<string | null>;
  onTasksChanged: () => void;
}

export type IpcHandler = (
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
) => Promise<void>;

const handlers = new Map<string, IpcHandler>();
// Allowlist: only reviewed plugins may run in the host process.
// Adding a new plugin requires adding its filename here.
const ALLOWED_IPC_PLUGIN_FILES = new Set([
  'create-group.js',
  'provision-child-board.js',
  'provision-root-board.js',
  'send-otp.js',
]);

function parseOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

export function getTurnId(data: Record<string, unknown>): string | undefined {
  return parseOptionalString(data.turnId);
}

function getSingleTurnMessage(
  data: Record<string, unknown>,
): (AgentTurnMessageRef & { turnId: string }) | undefined {
  const turnId = getTurnId(data);
  if (!turnId) return undefined;
  const turnMessages = getAgentTurnMessages(turnId);
  if (turnMessages.length !== 1) {
    return undefined;
  }
  const [message] = turnMessages;
  return {
    turnId,
    messageId: message.message_id,
    chatJid: message.message_chat_jid,
    sender: message.sender,
    senderName: message.sender_name,
    timestamp: message.message_timestamp,
  };
}

function hasKnownTurnForGroup(
  turnId: string | undefined,
  sourceGroup: string,
): boolean {
  if (!turnId) return false;
  const turn = getAgentTurn(turnId);
  return turn?.group_folder === sourceGroup;
}

export function registerIpcHandler(type: string, handler: IpcHandler): void {
  if (handlers.has(type)) {
    logger.warn({ type }, 'IPC handler already registered, overwriting');
  }
  handlers.set(type, handler);
}

// --- Core handlers ---

const handleScheduleTask: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  const registeredGroups = deps.registeredGroups();
  if (
    data.prompt &&
    data.schedule_type &&
    data.schedule_value &&
    data.targetJid
  ) {
    const targetJid = data.targetJid as string;
    const targetGroupEntry = registeredGroups[targetJid];

    if (!targetGroupEntry) {
      logger.warn(
        { targetJid },
        'Cannot schedule task: target group not registered',
      );
      return;
    }

    const targetFolder = targetGroupEntry.folder;

    if (!isMain && targetFolder !== sourceGroup) {
      logger.warn(
        { sourceGroup, targetFolder },
        'Unauthorized schedule_task attempt blocked',
      );
      return;
    }

    const VALID_SCHEDULE_TYPES = new Set(['cron', 'interval', 'once']);
    const rawScheduleType = data.schedule_type as string;
    if (!VALID_SCHEDULE_TYPES.has(rawScheduleType)) {
      logger.warn(
        { scheduleType: rawScheduleType },
        'Invalid schedule_type in schedule_task',
      );
      return;
    }
    const scheduleType = rawScheduleType as 'cron' | 'interval' | 'once';

    let nextRun: string | null = null;
    if (scheduleType === 'cron') {
      try {
        const interval = CronExpressionParser.parse(
          data.schedule_value as string,
          {
            tz: TIMEZONE,
          },
        );
        nextRun = interval.next().toISOString();
      } catch {
        logger.warn(
          { scheduleValue: data.schedule_value },
          'Invalid cron expression',
        );
        return;
      }
    } else if (scheduleType === 'interval') {
      const ms = parseInt(data.schedule_value as string, 10);
      if (isNaN(ms) || ms <= 0) {
        logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
        return;
      }
      nextRun = new Date(Date.now() + ms).toISOString();
    } else if (scheduleType === 'once') {
      const scheduled = new Date(data.schedule_value as string);
      if (isNaN(scheduled.getTime())) {
        logger.warn(
          { scheduleValue: data.schedule_value },
          'Invalid timestamp',
        );
        return;
      }
      if (scheduled.getTime() < Date.now()) {
        logger.warn(
          { scheduleValue: data.schedule_value },
          'schedule_task rejected: once task timestamp is in the past',
        );
        return;
      }
      nextRun = scheduled.toISOString();
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const contextMode =
      data.context_mode === 'group' || data.context_mode === 'isolated'
        ? data.context_mode
        : 'isolated';
    const triggerTurnId = getTurnId(data);
    const hasKnownTurn =
      triggerTurnId === undefined ||
      hasKnownTurnForGroup(triggerTurnId, sourceGroup);
    if (!hasKnownTurn) {
      logger.warn(
        { sourceGroup, triggerTurnId },
        'Ignoring unknown or foreign turn ID on schedule_task IPC',
      );
    }
    const singleTurnMessage =
      hasKnownTurn && triggerTurnId
        ? getSingleTurnMessage({ turnId: triggerTurnId })
        : undefined;
    createTask({
      id: taskId,
      group_folder: targetFolder,
      chat_jid: targetJid,
      prompt: data.prompt as string,
      schedule_type: scheduleType,
      schedule_value: data.schedule_value as string,
      context_mode: contextMode,
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
      trigger_message_id: singleTurnMessage?.messageId ?? null,
      trigger_chat_jid: singleTurnMessage?.chatJid ?? null,
      trigger_sender: singleTurnMessage?.sender ?? null,
      trigger_sender_name: singleTurnMessage?.senderName ?? null,
      trigger_message_timestamp: singleTurnMessage?.timestamp ?? null,
      trigger_turn_id: hasKnownTurn ? triggerTurnId ?? null : null,
    });
    logger.info(
      { taskId, sourceGroup, targetFolder, contextMode },
      'Task created via IPC',
    );
    deps.onTasksChanged();

    // Auto-ack: when the schedule was user-initiated (has trigger turn context),
    // emit a terse confirmation to the originating chat. Agents sometimes skip
    // the ack — e.g., when the user says "fale menos" in the same message —
    // and schedule_task has no tool-return notification contract, so this is
    // the only guaranteed acknowledgment path for interactive lembretes.
    const ackChatJid = singleTurnMessage?.chatJid;
    if (hasKnownTurn && ackChatJid) {
      deps
        .sendMessage(
          ackChatJid,
          formatScheduleAck(scheduleType, data.schedule_value as string, nextRun),
        )
        .catch((err) => {
          logger.warn(
            { err: String(err), ackChatJid, taskId },
            'Auto-ack emission failed (task still created)',
          );
        });
    }
  }
};

function formatScheduleAck(
  scheduleType: 'once' | 'cron' | 'interval',
  scheduleValue: string,
  nextRun: string | null,
): string {
  if (scheduleType === 'once') {
    const iso = nextRun ?? scheduleValue;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      const when = d.toLocaleString('pt-BR', {
        timeZone: TIMEZONE,
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `⏰ Lembrete agendado para ${when}.`;
    }
    return `⏰ Lembrete agendado.`;
  }
  if (scheduleType === 'cron') {
    return `⏰ Tarefa recorrente agendada (${scheduleValue}).`;
  }
  return `⏰ Tarefa periódica agendada.`;
}

const handlePauseTask: IpcHandler = async (data, sourceGroup, isMain, deps) => {
  if (data.taskId) {
    const task = getTaskById(data.taskId as string);
    if (task && (isMain || task.group_folder === sourceGroup)) {
      updateTask(data.taskId as string, { status: 'paused' });
      logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
      deps.onTasksChanged();
    } else {
      logger.warn(
        { taskId: data.taskId, sourceGroup },
        'Unauthorized task pause attempt',
      );
    }
  }
};

const handleResumeTask: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  if (data.taskId) {
    const task = getTaskById(data.taskId as string);
    if (task && (isMain || task.group_folder === sourceGroup)) {
      updateTask(data.taskId as string, { status: 'active' });
      logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
      deps.onTasksChanged();
    } else {
      logger.warn(
        { taskId: data.taskId, sourceGroup },
        'Unauthorized task resume attempt',
      );
    }
  }
};

const handleCancelTask: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  if (data.taskId) {
    const task = getTaskById(data.taskId as string);
    if (task && (isMain || task.group_folder === sourceGroup)) {
      deleteTask(data.taskId as string);
      logger.info(
        { taskId: data.taskId, sourceGroup },
        'Task cancelled via IPC',
      );
      deps.onTasksChanged();
    } else {
      logger.warn(
        { taskId: data.taskId, sourceGroup },
        'Unauthorized task cancel attempt',
      );
    }
  }
};

const handleRefreshGroups: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  const registeredGroups = deps.registeredGroups();
  if (isMain) {
    logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
    await deps.syncGroups(true);
    const availableGroups = deps.getAvailableGroups();
    deps.writeGroupsSnapshot(
      sourceGroup,
      true,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );
  } else {
    logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
  }
};

const handleRegisterGroup: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
    return;
  }
  if (data.jid && data.name && data.folder && data.trigger) {
    if (!isValidGroupFolder(data.folder as string)) {
      logger.warn(
        { sourceGroup, folder: data.folder },
        'Invalid register_group request - unsafe folder name',
      );
      return;
    }
    const taskflowManaged =
      typeof data.taskflowManaged === 'boolean'
        ? data.taskflowManaged
        : undefined;
    const taskflowHierarchyLevel = parseOptionalNonNegativeInteger(
      data.taskflowHierarchyLevel,
    );
    const taskflowMaxDepth = parseOptionalNonNegativeInteger(
      data.taskflowMaxDepth,
    );

    if (
      taskflowManaged === true &&
      (taskflowHierarchyLevel === undefined || taskflowMaxDepth === undefined)
    ) {
      logger.warn(
        {
          sourceGroup,
          folder: data.folder,
          rawTaskflowHierarchyLevel: data.taskflowHierarchyLevel,
          rawTaskflowMaxDepth: data.taskflowMaxDepth,
        },
        'Invalid register_group request - TaskFlow groups require valid hierarchy metadata',
      );
      return;
    }

    if (
      taskflowManaged === true &&
      taskflowHierarchyLevel !== undefined &&
      taskflowMaxDepth !== undefined &&
      taskflowHierarchyLevel > taskflowMaxDepth
    ) {
      logger.warn(
        {
          sourceGroup,
          folder: data.folder,
          taskflowHierarchyLevel,
          taskflowMaxDepth,
        },
        'Invalid register_group request - TaskFlow hierarchy level exceeds max depth',
      );
      return;
    }

    deps.registerGroup(data.jid as string, {
      name: data.name as string,
      folder: data.folder as string,
      trigger: data.trigger as string,
      added_at: new Date().toISOString(),
      containerConfig:
        data.containerConfig as RegisteredGroup['containerConfig'],
      requiresTrigger: data.requiresTrigger as boolean | undefined,
      taskflowManaged,
      taskflowHierarchyLevel:
        taskflowManaged === true ? taskflowHierarchyLevel : undefined,
      taskflowMaxDepth: taskflowManaged === true ? taskflowMaxDepth : undefined,
    });
  } else {
    logger.warn(
      { data },
      'Invalid register_group request - missing required fields',
    );
  }
};

const handleUpdateTask: IpcHandler = async (
  data,
  sourceGroup,
  isMain,
  deps,
) => {
  if (data.taskId) {
    const task = getTaskById(data.taskId as string);
    if (!task) {
      logger.warn(
        { taskId: data.taskId, sourceGroup },
        'Task not found for update',
      );
      return;
    }
    if (!isMain && task.group_folder !== sourceGroup) {
      logger.warn(
        { taskId: data.taskId, sourceGroup },
        'Unauthorized task update attempt',
      );
      return;
    }

    const updates: Parameters<typeof updateTask>[1] = {};
    if (data.prompt !== undefined) updates.prompt = data.prompt as string;
    if (data.schedule_type !== undefined)
      updates.schedule_type = data.schedule_type as
        | 'cron'
        | 'interval'
        | 'once';
    if (data.schedule_value !== undefined)
      updates.schedule_value = data.schedule_value as string;

    // Recompute next_run if schedule changed
    if (data.schedule_type || data.schedule_value) {
      const updatedTask = {
        ...task,
        ...updates,
      };
      if (updatedTask.schedule_type === 'cron') {
        try {
          const interval = CronExpressionParser.parse(
            updatedTask.schedule_value,
            { tz: TIMEZONE },
          );
          updates.next_run = interval.next().toISOString();
        } catch {
          logger.warn(
            { taskId: data.taskId, value: updatedTask.schedule_value },
            'Invalid cron in task update',
          );
          return;
        }
      } else if (updatedTask.schedule_type === 'interval') {
        const ms = parseInt(updatedTask.schedule_value, 10);
        if (!isNaN(ms) && ms > 0) {
          updates.next_run = new Date(Date.now() + ms).toISOString();
        }
      }
    }

    updateTask(data.taskId as string, updates);
    logger.info(
      { taskId: data.taskId, sourceGroup, updates },
      'Task updated via IPC',
    );
    deps.onTasksChanged();
  }
};

// Register core handlers
registerIpcHandler('schedule_task', handleScheduleTask);
registerIpcHandler('pause_task', handlePauseTask);
registerIpcHandler('resume_task', handleResumeTask);
registerIpcHandler('cancel_task', handleCancelTask);
registerIpcHandler('update_task', handleUpdateTask);
registerIpcHandler('refresh_groups', handleRefreshGroups);
registerIpcHandler('register_group', handleRegisterGroup);

// Deferred notifications: dispatched once the target person's board is provisioned.
// Re-queues up to ~5 minutes (TTL based on original timestamp).
const DEFERRED_NOTIFICATION_TTL_MS = 5 * 60 * 1000;

function reQueueDeferredNotification(
  data: Record<string, unknown>,
  sourceGroup: string,
): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(tasksDir, filename);
  // Atomic write: temp then rename, so the IPC watcher never reads partial JSON
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
}

const handleDeferredNotification: IpcHandler = async (
  data,
  sourceGroup,
  _isMain,
  deps,
) => {
  const personId = data.target_person_id as string | undefined;
  const text = data.text as string | undefined;
  if (!personId || !text) return;

  // TTL guard: drop notifications older than 5 minutes.
  // If the timestamp is missing or malformed, stamp it now so that future
  // re-queue cycles can expire the notification instead of looping forever.
  const parsedTimestamp =
    typeof data.timestamp === 'string' ? new Date(data.timestamp).getTime() : NaN;
  if (!Number.isFinite(parsedTimestamp) || parsedTimestamp <= 0) {
    data.timestamp = new Date().toISOString();
  } else if (Date.now() - parsedTimestamp > DEFERRED_NOTIFICATION_TTL_MS) {
    logger.warn(
      { personId, sourceGroup, age: Date.now() - parsedTimestamp },
      'Deferred notification expired (TTL exceeded), dropping',
    );
    return;
  }

  const tfDb = getTaskflowDb(DATA_DIR);
  if (!tfDb) {
    // DB unavailable — re-queue instead of silently dropping
    reQueueDeferredNotification(data, sourceGroup);
    return;
  }

  const row = tfDb
    .prepare(
      'SELECT notification_group_jid FROM board_people WHERE person_id = ? AND notification_group_jid IS NOT NULL LIMIT 1',
    )
    .get(personId) as { notification_group_jid: string } | undefined;

  if (row) {
    const registeredGroups = deps.registeredGroups();
    const targetGroup = registeredGroups[row.notification_group_jid];
    const sender = targetGroup
      ? getGroupSenderName(targetGroup.trigger)
      : undefined;
    await deps.sendMessage(row.notification_group_jid, text, sender);
    logger.info(
      { personId, targetJid: row.notification_group_jid, sourceGroup },
      'Deferred notification delivered',
    );
  } else {
    reQueueDeferredNotification(data, sourceGroup);
    logger.info(
      { personId, sourceGroup },
      'Deferred notification re-queued (board not yet provisioned)',
    );
  }
};
registerIpcHandler('deferred_notification', handleDeferredNotification);

// --- Plugin loader ---

async function loadIpcPlugins(): Promise<void> {
  const pluginDir = new URL('./ipc-plugins', import.meta.url).pathname;
  if (!fs.existsSync(pluginDir)) return;
  for (const file of fs.readdirSync(pluginDir)) {
    if (file !== path.basename(file)) continue;
    if (!file.endsWith('.js') || file.endsWith('.test.js')) continue;
    if (!ALLOWED_IPC_PLUGIN_FILES.has(file)) {
      logger.warn({ file }, 'Skipping IPC plugin outside allowlist');
      continue;
    }
    const plugin = await import(
      new URL(`./ipc-plugins/${file}`, import.meta.url).href
    );
    if (typeof plugin.register === 'function') {
      plugin.register(registerIpcHandler);
      logger.info({ file }, 'Loaded IPC plugin');
    }
  }
}

// --- IPC message authorization ---

/** Determine if an IPC message from sourceGroup is authorized to target chatJid. */
export function isIpcMessageAuthorized(opts: {
  chatJid: string;
  sourceGroup: string;
  isMain: boolean;
  isTaskflow: boolean;
  isKnownExternalDm: boolean;
  registeredGroups: Record<string, RegisteredGroup>;
}): 'group' | 'dm' | false {
  const targetGroup = opts.registeredGroups[opts.chatJid];
  if (
    targetGroup &&
    (opts.isMain ||
      targetGroup.folder === opts.sourceGroup ||
      (opts.isTaskflow && targetGroup.taskflowManaged))
  ) {
    return 'group';
  }
  const isDmTarget = !targetGroup && opts.chatJid.endsWith('@s.whatsapp.net');
  if (
    isDmTarget &&
    opts.isKnownExternalDm &&
    (opts.isMain || opts.isTaskflow)
  ) {
    return 'dm';
  }
  return false;
}

// --- IPC error handling ---

const IPC_MAX_RETRIES = 5;
const IPC_ERROR_RETAIN_DAYS = 7;
const IPC_ERROR_MAX_FILES = 1000;
const ipcRetryCounts = new Map<string, number>();

/**
 * Returns true if the error is permanent (bad data) and should be quarantined immediately.
 * Transient errors (send failures, network) should be retried.
 */
function isPermanentIpcError(err: unknown): boolean {
  // SyntaxError = bad JSON, TypeError = missing fields, RangeError = bad data shape
  // All indicate malformed IPC payloads that won't improve on retry
  return (
    err instanceof SyntaxError ||
    err instanceof TypeError ||
    err instanceof RangeError
  );
}

/**
 * Handle an IPC file processing error.
 * Permanent errors → quarantine immediately.
 * Transient errors → leave in place for retry, quarantine after IPC_MAX_RETRIES.
 */
function handleIpcFileError(
  filePath: string,
  file: string,
  sourceGroup: string,
  err: unknown,
  ipcBaseDir: string,
): void {
  if (isPermanentIpcError(err)) {
    // Bad data — quarantine immediately
    if (moveToErrorDir(filePath, file, sourceGroup, ipcBaseDir)) {
      ipcRetryCounts.delete(filePath);
    }
    return;
  }

  // Transient error — increment retry count
  const retries = (ipcRetryCounts.get(filePath) ?? 0) + 1;
  ipcRetryCounts.set(filePath, retries);

  if (retries >= IPC_MAX_RETRIES) {
    logger.warn(
      { file, sourceGroup, retries },
      'IPC file exceeded max retries, quarantining',
    );
    if (moveToErrorDir(filePath, file, sourceGroup, ipcBaseDir)) {
      ipcRetryCounts.delete(filePath);
    }
    // If move failed, retry count stays high — prevents infinite 5-retry loops
  } else {
    logger.debug(
      { file, sourceGroup, retries, maxRetries: IPC_MAX_RETRIES },
      'Transient IPC error, will retry',
    );
    // Leave file in place — next poll cycle will pick it up again
  }
}

function moveToErrorDir(
  filePath: string,
  file: string,
  sourceGroup: string,
  ipcBaseDir: string,
): boolean {
  try {
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    const errorName = `${sourceGroup}-${Date.now()}-${file}`;
    fs.renameSync(filePath, path.join(errorDir, errorName));
    return true;
  } catch (moveErr) {
    logger.warn({ moveErr, filePath }, 'Failed to move IPC file to error dir');
    return false;
  }
}

/**
 * Evict old error files: remove files older than IPC_ERROR_RETAIN_DAYS,
 * then cap at IPC_ERROR_MAX_FILES (removing oldest).
 */
export function evictErrorFiles(ipcBaseDir: string): void {
  const errorDir = path.join(ipcBaseDir, 'errors');
  if (!fs.existsSync(errorDir)) return;

  try {
    const files = fs.readdirSync(errorDir);
    const cutoff = Date.now() - IPC_ERROR_RETAIN_DAYS * 86400000;
    const remaining: Array<{ name: string; mtime: number }> = [];

    for (const file of files) {
      const filePath = path.join(errorDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        } else {
          remaining.push({ name: file, mtime: stat.mtimeMs });
        }
      } catch {
        // Skip files we can't stat
      }
    }

    // Cap at max files — remove oldest
    if (remaining.length > IPC_ERROR_MAX_FILES) {
      remaining.sort((a, b) => a.mtime - b.mtime);
      const toRemove = remaining.slice(
        0,
        remaining.length - IPC_ERROR_MAX_FILES,
      );
      for (const { name } of toRemove) {
        try {
          fs.unlinkSync(path.join(errorDir, name));
        } catch {
          // Best-effort
        }
      }
      logger.info(
        { removed: toRemove.length, remaining: IPC_ERROR_MAX_FILES },
        'Evicted old IPC error files',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Error evicting IPC error files');
  }
}

// --- IPC watcher ---

let ipcWatcherRunning = false;
let lastEvictionTime = 0;

export async function startIpcWatcher(deps: IpcDeps): Promise<void> {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  await loadIpcPlugins();

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Evict old error files on startup
  evictErrorFiles(ipcBaseDir);

  // Notification consolidation: when the LLM makes two tool calls on the same
  // task in quick succession (note + move → 2 parent_notifications to the same
  // group), hold notification-type IPC files for a short window and merge them
  // into a single WhatsApp message before delivery. Non-notification messages
  // are sent immediately — no hold.
  interface PendingNotification {
    filePath: string;
    data: Record<string, unknown> & {
      chatJid: string;
      text: string;
      sender?: string;
      groupFolder?: string;
      type: string;
    };
    sourceGroup: string;
    isMain: boolean;
    isTaskflow: boolean;
    firstSeen: number;
  }
  const NOTIF_HOLD_WINDOW_MS = 5_000;
  const pendingNotifications = new Map<string, PendingNotification[]>();

  function isBufferableNotification(text: string, chatJid: string): boolean {
    // Only buffer group-targeted TaskFlow notifications (not DMs, not user messages).
    // DM notifications (chatJid ending @s.whatsapp.net) must be sent immediately —
    // the flush path only handles group auth.
    if (chatJid.endsWith('@s.whatsapp.net')) return false;
    return /^🔔 \*(?:Atualização|Nova tarefa|Tarefa reatribuída|Lembrete)/.test(text);
  }

  function extractNotifGroupKey(
    sourceGroup: string,
    chatJid: string,
    turnId?: string,
  ): string {
    return `${sourceGroup}:${chatJid}:${turnId ?? ''}`;
  }

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();
    const groupByFolder = new Map(
      Object.values(registeredGroups).map((g) => [g.folder, g]),
    );

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const sourceGroupEntry = groupByFolder.get(sourceGroup);
      const isTaskflow = sourceGroupEntry?.taskflowManaged === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      const otpDir = path.join(ipcBaseDir, sourceGroup, 'otp');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'))
            .sort();
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Hold group-targeted TaskFlow notifications for consolidation.
                // Delete the file immediately to prevent re-buffering on the
                // next poll (Codex review: held files on disk get re-read every
                // 1s poll, duplicating the entry in the pending buffer).
                if (isBufferableNotification(data.text, data.chatJid)) {
                  const key = extractNotifGroupKey(
                    sourceGroup,
                    data.chatJid,
                    getTurnId(data),
                  );
                  if (!pendingNotifications.has(key)) {
                    pendingNotifications.set(key, []);
                  }
                  pendingNotifications.get(key)!.push({
                    filePath,
                    data,
                    sourceGroup,
                    isMain,
                    isTaskflow,
                    firstSeen: Date.now(),
                  });
                  try { fs.unlinkSync(filePath); } catch {}
                  continue;
                }
                const authResult = isIpcMessageAuthorized({
                  chatJid: data.chatJid,
                  sourceGroup,
                  isMain,
                  isTaskflow,
                  isKnownExternalDm:
                    data.chatJid.endsWith('@s.whatsapp.net') &&
                    (() => {
                      const tfDb = getTaskflowDb(DATA_DIR);
                      return (
                        tfDb !== null &&
                        resolveExternalDm(tfDb, data.chatJid) !== null
                      );
                    })(),
                  registeredGroups,
                });

                // Track the kind that actually got delivered so the
                // single post-send audit-log write below can reuse it.
                // `null` means the send was blocked (unauthorized, DM
                // disambiguation failure) — nothing to log.
                let deliveredKind: SendTargetKind | null = null;
                let deliveredSender: string | undefined;

                if (authResult === 'group') {
                  const targetGroup = registeredGroups[data.chatJid];
                  deliveredSender =
                    typeof data.sender === 'string'
                      ? data.sender
                      : getGroupSenderName(targetGroup.trigger);
                  await deps.sendMessage(data.chatJid, data.text, deliveredSender);
                  deliveredKind = 'group';
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                  await deps
                    .clearTyping?.(data.chatJid)
                    ?.catch((err: unknown) => {
                      logger.warn(
                        { chatJid: data.chatJid, err },
                        'clearTyping failed after IPC send',
                      );
                    });
                } else if (authResult === 'dm') {
                  // Check disambiguation before sending — external contact
                  // may have grants spanning multiple groups
                  const tfDb = getTaskflowDb(DATA_DIR);
                  const dmRoute = tfDb
                    ? resolveExternalDm(tfDb, data.chatJid)
                    : null;
                  if (!dmRoute || dmRoute.needsDisambiguation) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC DM blocked: route unavailable or grants in multiple groups',
                    );
                  } else {
                    deliveredSender =
                      typeof data.sender === 'string' ? data.sender : undefined;
                    await deps.sendMessage(data.chatJid, data.text, deliveredSender);
                    deliveredKind = 'dm';
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC DM message sent to external contact',
                    );
                    await deps
                      .clearTyping?.(data.chatJid)
                      ?.catch((err: unknown) => {
                        logger.warn(
                          { chatJid: data.chatJid, err },
                          'clearTyping failed after IPC DM send',
                        );
                      });
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }

                if (deliveredKind !== null) {
                  const triggerTurnId = getTurnId(data);
                  const hasKnownTurn =
                    triggerTurnId === undefined ||
                    hasKnownTurnForGroup(triggerTurnId, sourceGroup);
                  if (!hasKnownTurn) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup, triggerTurnId },
                      'Ignoring unknown or foreign turn ID on send_message IPC',
                    );
                  }
                  const singleTurnMessage =
                    hasKnownTurn && triggerTurnId
                      ? getSingleTurnMessage({ turnId: triggerTurnId })
                      : undefined;
                  try {
                    recordSendMessageLog({
                      sourceGroupFolder: sourceGroup,
                      targetChatJid: data.chatJid,
                      targetKind: deliveredKind,
                      senderLabel: deliveredSender ?? null,
                      contentPreview: data.text,
                      deliveredAt: new Date().toISOString(),
                      triggerMessage: singleTurnMessage,
                      triggerTurnId: hasKnownTurn ? triggerTurnId ?? null : null,
                    });
                  } catch (err) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup, targetKind: deliveredKind, err },
                      'recordSendMessageLog failed after send',
                    );
                  }
                }
              }
              fs.unlinkSync(filePath);
              ipcRetryCounts.delete(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              handleIpcFileError(filePath, file, sourceGroup, err, ipcBaseDir);
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'))
            .sort();
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
              ipcRetryCounts.delete(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              handleIpcFileError(filePath, file, sourceGroup, err, ipcBaseDir);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process OTP task files from this group's IPC directory
      try {
        if (fs.existsSync(otpDir)) {
          const otpFiles = fs
            .readdirSync(otpDir)
            .filter((f) => f.endsWith('.json'))
            .sort();
          for (const file of otpFiles) {
            const filePath = path.join(otpDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
              ipcRetryCounts.delete(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC OTP task',
              );
              handleIpcFileError(filePath, file, sourceGroup, err, ipcBaseDir);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC OTP directory');
      }
    }

    // Flush held notifications whose hold window has expired.
    // Multiple notifications to the same chatJid from the same group within
    // 5 seconds are merged into one WhatsApp message (preserves all content,
    // reduces buzz count from N to 1). This fixes the two-tool-call pattern
    // where note + move produce 2 separate parent_notifications.
    const now = Date.now();
    for (const [key, pending] of pendingNotifications) {
      if (pending.length === 0) {
        pendingNotifications.delete(key);
        continue;
      }
      const oldest = Math.min(...pending.map((p) => p.firstSeen));
      if (now - oldest < NOTIF_HOLD_WINDOW_MS) continue;

      // Merge all held notifications into one message
      const first = pending[0];
      const mergedText =
        pending.length === 1
          ? first.data.text
          : pending.map((p) => p.data.text).join('\n\n━━━━━━━━━━━━━━\n\n');

      const authResult = isIpcMessageAuthorized({
        chatJid: first.data.chatJid,
        sourceGroup: first.sourceGroup,
        isMain: first.isMain,
        isTaskflow: first.isTaskflow,
        isKnownExternalDm: false,
        registeredGroups: deps.registeredGroups(),
      });

      if (authResult === 'group') {
        const targetGroup = deps.registeredGroups()[first.data.chatJid];
        const sender =
          typeof first.data.sender === 'string'
            ? first.data.sender
            : getGroupSenderName(targetGroup?.trigger);
        try {
          await deps.sendMessage(first.data.chatJid, mergedText, sender);
          logger.info(
            {
              chatJid: first.data.chatJid,
              sourceGroup: first.sourceGroup,
              merged: pending.length,
            },
            pending.length > 1
              ? `IPC notifications consolidated (${pending.length} → 1)`
              : 'IPC notification sent',
          );
          await deps
            .clearTyping?.(first.data.chatJid)
            ?.catch(() => {});
          try {
            const triggerTurnId = getTurnId(first.data);
            const hasKnownTurn =
              triggerTurnId === undefined ||
              hasKnownTurnForGroup(triggerTurnId, first.sourceGroup);
            const singleTurnMessage =
              hasKnownTurn && triggerTurnId
                ? getSingleTurnMessage({ turnId: triggerTurnId })
                : undefined;
            recordSendMessageLog({
              sourceGroupFolder: first.sourceGroup,
              targetChatJid: first.data.chatJid,
              targetKind: 'group',
              senderLabel: sender ?? null,
              contentPreview: mergedText,
              deliveredAt: new Date().toISOString(),
              triggerMessage: singleTurnMessage,
              triggerTurnId: hasKnownTurn ? triggerTurnId ?? null : null,
            });
          } catch {}
        } catch (err) {
          logger.error(
            { chatJid: first.data.chatJid, sourceGroup: first.sourceGroup, err },
            'Error sending consolidated notification',
          );
        }
      }

      // Files were already deleted at buffer time (prevents re-buffering).
      pendingNotifications.delete(key);
    }

    // Periodic eviction of old error files (every 5 minutes)
    if (Date.now() - lastEvictionTime > 300_000) {
      evictErrorFiles(ipcBaseDir);
      lastEvictionTime = Date.now();
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const type = data.type as string;
  const handler = handlers.get(type);
  if (handler) {
    await handler(data, sourceGroup, isMain, deps);
  } else {
    logger.warn({ type }, 'Unknown IPC task type');
  }
}
