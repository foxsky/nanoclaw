import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  getGroupSenderName,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { resolveExternalDm, getTaskflowDb } from './dm-routing.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

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
  ) => Promise<{ jid: string; subject: string }>;
  resolvePhoneJid?: (phone: string) => Promise<string>;
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
]);

function parseOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
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
      nextRun = scheduled.toISOString();
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const contextMode =
      data.context_mode === 'group' || data.context_mode === 'isolated'
        ? data.context_mode
        : 'isolated';
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
    });
    logger.info(
      { taskId, sourceGroup, targetFolder, contextMode },
      'Task created via IPC',
    );
  }
};

const handlePauseTask: IpcHandler = async (data, sourceGroup, isMain) => {
  if (data.taskId) {
    const task = getTaskById(data.taskId as string);
    if (task && (isMain || task.group_folder === sourceGroup)) {
      updateTask(data.taskId as string, { status: 'paused' });
      logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
    } else {
      logger.warn(
        { taskId: data.taskId, sourceGroup },
        'Unauthorized task pause attempt',
      );
    }
  }
};

const handleResumeTask: IpcHandler = async (data, sourceGroup, isMain) => {
  if (data.taskId) {
    const task = getTaskById(data.taskId as string);
    if (task && (isMain || task.group_folder === sourceGroup)) {
      updateTask(data.taskId as string, { status: 'active' });
      logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
    } else {
      logger.warn(
        { taskId: data.taskId, sourceGroup },
        'Unauthorized task resume attempt',
      );
    }
  }
};

const handleCancelTask: IpcHandler = async (data, sourceGroup, isMain) => {
  if (data.taskId) {
    const task = getTaskById(data.taskId as string);
    if (task && (isMain || task.group_folder === sourceGroup)) {
      deleteTask(data.taskId as string);
      logger.info(
        { taskId: data.taskId, sourceGroup },
        'Task cancelled via IPC',
      );
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

// Register core handlers
registerIpcHandler('schedule_task', handleScheduleTask);
registerIpcHandler('pause_task', handlePauseTask);
registerIpcHandler('resume_task', handleResumeTask);
registerIpcHandler('cancel_task', handleCancelTask);
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
  fs.writeFileSync(
    path.join(tasksDir, filename),
    JSON.stringify(data, null, 2),
  );
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

  // TTL guard: drop notifications older than 5 minutes
  const createdAt =
    typeof data.timestamp === 'string' ? new Date(data.timestamp).getTime() : 0;
  if (createdAt > 0 && Date.now() - createdAt > DEFERRED_NOTIFICATION_TTL_MS) {
    logger.warn(
      { personId, sourceGroup, age: Date.now() - createdAt },
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

// --- IPC watcher ---

let ipcWatcherRunning = false;

export async function startIpcWatcher(deps: IpcDeps): Promise<void> {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  await loadIpcPlugins();

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

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

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
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

                if (authResult === 'group') {
                  const targetGroup = registeredGroups[data.chatJid];
                  const sender =
                    typeof data.sender === 'string'
                      ? data.sender
                      : getGroupSenderName(targetGroup.trigger);
                  try {
                    await deps.sendMessage(data.chatJid, data.text, sender);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message sent',
                    );
                  } finally {
                    await deps.clearTyping?.(data.chatJid);
                  }
                } else if (authResult === 'dm') {
                  // Check disambiguation before sending — external contact
                  // may have grants spanning multiple groups
                  const tfDb = getTaskflowDb(DATA_DIR);
                  const dmRoute = tfDb
                    ? resolveExternalDm(tfDb, data.chatJid)
                    : null;
                  if (dmRoute?.needsDisambiguation) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC DM blocked: external contact has grants in multiple groups',
                    );
                  } else {
                    const sender =
                      typeof data.sender === 'string' ? data.sender : undefined;
                    try {
                      await deps.sendMessage(data.chatJid, data.text, sender);
                      logger.info(
                        { chatJid: data.chatJid, sourceGroup },
                        'IPC DM message sent to external contact',
                      );
                    } finally {
                      await deps.clearTyping?.(data.chatJid);
                    }
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
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
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
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
