import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
  SWARM_SSH_TARGET,
  SWARM_ENABLED,
  SWARM_REPOS,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import {
  spawnAgent,
  checkAgents,
  redirectAgent,
  killAgent,
  updateTaskStatus,
  readAgentLog,
  runReview,
  runCleanup,
} from './agent-swarm.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
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
}

function writeIpcResponse(sourceGroup: string, requestId: string, result: string): void {
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${requestId}.json`);
  fs.writeFileSync(responsePath, result);
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

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
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
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
              // Pass source group identity to processTaskIpc for authorization
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
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For agent swarm
    requestId?: string;
    repo?: string;
    branchName?: string;
    model?: string;
    priority?: string;
    message?: string;
    cleanup?: boolean;
    status?: string;
    lines?: number;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
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
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
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
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
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
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
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
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
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
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
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
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    // --- Agent Swarm IPC handlers ---

    case 'swarm_spawn': {
      // NOTE: The IPC task file in data/ipc/{group}/tasks/ contains the full
      // prompt text. This is a known limitation — the prompt sits unencrypted on
      // the host filesystem until the IPC file is processed and removed.
      if (!isMain) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can spawn swarm agents');
        break;
      }
      if (!SWARM_ENABLED) {
        logger.warn('Swarm operation attempted but SWARM_SSH_TARGET not configured');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
        break;
      }
      const repoConfig = SWARM_REPOS[data.repo!];
      if (!repoConfig) {
        logger.warn({ repo: data.repo }, 'Unknown repo in swarm_spawn');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Error: unknown repo "${data.repo}"`);
        break;
      }
      try {
        const spawnedTaskId = await spawnAgent(SWARM_SSH_TARGET, {
          repo: data.repo!,
          repoPath: repoConfig.path,
          branchName: data.branchName!,
          prompt: data.prompt!,
          model: data.model!,
          priority: data.priority as any,
        });
        logger.info({ taskId: spawnedTaskId, repo: data.repo, model: data.model }, 'Swarm agent spawned');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Agent spawned: ${spawnedTaskId} (${data.model} on ${data.repo}, branch ${data.branchName})`);
      } catch (err) {
        logger.error({ err, repo: data.repo }, 'Failed to spawn swarm agent');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Spawn failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'swarm_check': {
      if (!isMain) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can check swarm agents');
        break;
      }
      if (!SWARM_ENABLED) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
        break;
      }
      try {
        const statuses = await checkAgents(SWARM_SSH_TARGET);
        const result = JSON.stringify(statuses, null, 2);
        logger.info({ count: statuses.length }, 'Swarm status check complete');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, result);
      } catch (err) {
        logger.error({ err }, 'Failed to check swarm agents');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Check failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'swarm_redirect': {
      if (!isMain) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can redirect swarm agents');
        break;
      }
      if (!SWARM_ENABLED) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
        break;
      }
      try {
        await redirectAgent(SWARM_SSH_TARGET, data.taskId!, data.message!);
        logger.info({ taskId: data.taskId }, 'Swarm agent redirected');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Redirect sent to ${data.taskId}`);
      } catch (err) {
        logger.error({ err, taskId: data.taskId }, 'Failed to redirect swarm agent');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Redirect failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'swarm_kill': {
      if (!isMain) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can kill swarm agents');
        break;
      }
      if (!SWARM_ENABLED) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
        break;
      }
      try {
        await killAgent(SWARM_SSH_TARGET, data.taskId!, data.cleanup);
        logger.info({ taskId: data.taskId, cleanup: data.cleanup }, 'Swarm agent killed');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Killed agent ${data.taskId}${data.cleanup ? ' (cleaned up)' : ''}`);
      } catch (err) {
        logger.error({ err, taskId: data.taskId }, 'Failed to kill swarm agent');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Kill failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'swarm_output': {
      if (!isMain) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can read swarm agent output');
        break;
      }
      if (!SWARM_ENABLED) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
        break;
      }
      try {
        const output = await readAgentLog(SWARM_SSH_TARGET, data.taskId!, data.lines);
        logger.info({ taskId: data.taskId }, 'Swarm agent output retrieved');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, output);
      } catch (err) {
        logger.error({ err, taskId: data.taskId }, 'Failed to get swarm agent output');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Output retrieval failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'swarm_review': {
      if (!isMain) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can run swarm reviews');
        break;
      }
      if (!SWARM_ENABLED) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
        break;
      }
      try {
        await runReview(SWARM_SSH_TARGET, data.taskId!);
        logger.info({ taskId: data.taskId }, 'Swarm PR review complete');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Review complete for ${data.taskId}`);
      } catch (err) {
        logger.error({ err, taskId: data.taskId }, 'Failed to run swarm review');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Review failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'swarm_update_status': {
      if (!isMain) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can update swarm task status');
        break;
      }
      if (!SWARM_ENABLED) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
        break;
      }
      try {
        await updateTaskStatus(SWARM_SSH_TARGET, data.taskId!, data.status as any);
        logger.info({ taskId: data.taskId, status: data.status }, 'Swarm task status updated');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Updated ${data.taskId} to ${data.status}`);
      } catch (err) {
        logger.error({ err, taskId: data.taskId, status: data.status }, 'Failed to update swarm task status');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Status update failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'swarm_cleanup': {
      if (!isMain) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can run swarm cleanup');
        break;
      }
      if (!SWARM_ENABLED) {
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
        break;
      }
      try {
        await runCleanup(SWARM_SSH_TARGET);
        logger.info('Swarm cleanup completed');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Cleanup complete');
      } catch (err) {
        logger.error({ err }, 'Failed to run swarm cleanup');
        if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Cleanup failed: ${(err as Error).message}`);
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
