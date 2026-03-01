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
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  createGroup?: (subject: string, participants: string[]) => Promise<{ jid: string; subject: string }>;
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
const ALLOWED_IPC_PLUGIN_FILES = new Set(['create-group.js']);

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

const handleScheduleTask: IpcHandler = async (data, sourceGroup, isMain, deps) => {
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

    const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

    let nextRun: string | null = null;
    if (scheduleType === 'cron') {
      try {
        const interval = CronExpressionParser.parse(data.schedule_value as string, {
          tz: TIMEZONE,
        });
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
        logger.warn(
          { scheduleValue: data.schedule_value },
          'Invalid interval',
        );
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
      logger.info(
        { taskId: data.taskId, sourceGroup },
        'Task paused via IPC',
      );
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
      logger.info(
        { taskId: data.taskId, sourceGroup },
        'Task resumed via IPC',
      );
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

const handleRefreshGroups: IpcHandler = async (data, sourceGroup, isMain, deps) => {
  const registeredGroups = deps.registeredGroups();
  if (isMain) {
    logger.info(
      { sourceGroup },
      'Group metadata refresh requested via IPC',
    );
    await deps.syncGroupMetadata(true);
    const availableGroups = deps.getAvailableGroups();
    deps.writeGroupsSnapshot(
      sourceGroup,
      true,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );
  } else {
    logger.warn(
      { sourceGroup },
      'Unauthorized refresh_groups attempt blocked',
    );
  }
};

const handleRegisterGroup: IpcHandler = async (data, sourceGroup, isMain, deps) => {
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized register_group attempt blocked',
    );
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
      containerConfig: data.containerConfig as RegisteredGroup['containerConfig'],
      requiresTrigger: data.requiresTrigger as boolean | undefined,
      taskflowManaged,
      taskflowHierarchyLevel:
        taskflowManaged === true ? taskflowHierarchyLevel : undefined,
      taskflowMaxDepth:
        taskflowManaged === true ? taskflowMaxDepth : undefined,
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
    const plugin = await import(new URL(`./ipc-plugins/${file}`, import.meta.url).href);
    if (typeof plugin.register === 'function') {
      plugin.register(registerIpcHandler);
      logger.info({ file }, 'Loaded IPC plugin');
    }
  }
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

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
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
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  targetGroup &&
                  (isMain || targetGroup.folder === sourceGroup)
                ) {
                  const sender =
                    typeof data.sender === 'string' ? data.sender : undefined;
                  await deps.sendMessage(data.chatJid, data.text, sender);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
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
