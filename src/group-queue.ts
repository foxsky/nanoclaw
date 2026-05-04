import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { log } from './log.js';
import { AgentTurnContext } from './v1-types.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
/** Max time a queued task waits for a busy container before forcing close */
const TASK_STARVATION_MS = 120_000; // 2 minutes

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  inputDir: string | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pendingClose: boolean;
  taskStarvationTimer: ReturnType<typeof setTimeout> | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups = new Set<string>();
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null = null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        inputDir: null,
        retryCount: 0,
        retryTimer: null,
        pendingClose: false,
        taskStarvationTimer: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      if (state.idleWaiting) {
        log.debug('Container idle, closing so queued messages become a fresh exact turn', { groupJid });
        this.closeStdin(groupJid);
      }
      log.debug('Container active, message queued', { groupJid });
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      log.debug('At concurrency limit, message queued', { groupJid, activeCount: this.activeCount });
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      log.error('Unhandled error in runForGroup', { groupJid, err }),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      log.debug('Task already running, skipping', { groupJid, taskId });
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      log.debug('Task already queued, skipping', { groupJid, taskId });
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!state.isTaskContainer && state.idleWaiting) {
        log.debug('Container idle, closing so queued task can run next', { groupJid, taskId });
        this.closeStdin(groupJid);
      } else if (!state.isTaskContainer && !state.idleWaiting) {
        log.debug('Container busy processing, task queued — will run after current query', { groupJid, taskId });
        // Start starvation timer — if container doesn't go idle in time, force close
        if (!state.taskStarvationTimer) {
          state.taskStarvationTimer = setTimeout(() => {
            state.taskStarvationTimer = null;
            if (state.active && !state.idleWaiting && state.pendingTasks.length > 0) {
              log.warn('Task starvation: container busy too long, forcing close', {
                groupJid,
                taskId,
                pendingCount: state.pendingTasks.length,
              });
              this.closeStdin(groupJid);
            }
          }, TASK_STARVATION_MS);
        }
      } else {
        log.debug('Task container active, queued task will wait for drain', { groupJid, taskId });
      }
      log.debug('Container active, task queued', { groupJid, taskId });
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.waitingGroups.add(groupJid);
      log.debug('At concurrency limit, task queued', { groupJid, taskId, activeCount: this.activeCount });
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      log.error('Unhandled error in runTask', { groupJid, taskId, err }),
    );
  }

  registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) {
      state.groupFolder = groupFolder;
      state.inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
      fs.mkdirSync(state.inputDir, { recursive: true });
    }
    // Flush deferred close if preemption was requested before inputDir was set
    if (state.pendingClose) {
      state.pendingClose = false;
      this.closeStdin(groupJid);
    }
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    // Clear starvation timer — container went idle naturally
    if (state.taskStarvationTimer) {
      clearTimeout(state.taskStarvationTimer);
      state.taskStarvationTimer = null;
    }
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
      return;
    }
    if (state.pendingMessages) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string, turnContext?: AgentTurnContext): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active) {
      log.debug('sendMessage: no active container', { groupJid });
      return false;
    }
    if (!state.inputDir) {
      log.debug('sendMessage: inputDir not set', { groupJid });
      return false;
    }
    if (state.isTaskContainer) {
      log.debug('sendMessage: container running a task', { groupJid });
      return false;
    }
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    try {
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(state.inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'message',
          text,
          turnContext: turnContext ?? undefined,
        }),
      );
      fs.renameSync(tempPath, filepath);
      return true;
    } catch (err) {
      log.warn('sendMessage: failed to write IPC file', { groupJid, err });
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active) return;
    if (!state.inputDir) {
      // Container still starting — record intent for registerProcess
      state.pendingClose = true;
      return;
    }
    state.pendingClose = false;
    try {
      fs.writeFileSync(path.join(state.inputDir, '_close'), '');
    } catch (err) {
      log.warn('closeStdin: failed to write _close sentinel', { groupJid, err });
    }
  }

  private async runForGroup(groupJid: string, reason: 'messages' | 'drain'): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    // Cancel any pending retry timer — this run supersedes it
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    this.activeCount++;

    log.debug('Starting container for group', { groupJid, reason, activeCount: this.activeCount });

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      log.error('Error processing messages for group', { groupJid, err });
      this.scheduleRetry(groupJid, state);
    } finally {
      this.cleanupRun(groupJid, state);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    log.debug('Running queued task', { groupJid, taskId: task.id, activeCount: this.activeCount });

    try {
      await task.fn();
    } catch (err) {
      log.error('Error running task', { groupJid, taskId: task.id, err });
    } finally {
      state.isTaskContainer = false;
      state.runningTaskId = null;
      this.cleanupRun(groupJid, state);
    }
  }

  private cleanupRun(groupJid: string, state: GroupState): void {
    state.active = false;
    state.pendingClose = false;
    if (state.taskStarvationTimer) {
      clearTimeout(state.taskStarvationTimer);
      state.taskStarvationTimer = null;
    }
    state.process = null;
    state.containerName = null;
    state.groupFolder = null;
    state.inputDir = null;
    this.activeCount--;
    this.drainGroup(groupJid);
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      log.error('Max retries exceeded, dropping messages (will retry on next incoming message)', {
        groupJid,
        retryCount: state.retryCount,
      });
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    log.info('Scheduling retry with backoff', { groupJid, retryCount: state.retryCount, delayMs });
    const expectedRetryCount = state.retryCount;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      // Skip if a successful drain already reset retryCount (stale timer guard)
      if (!this.shuttingDown && state.retryCount === expectedRetryCount) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // User messages first — a human waiting for a response takes priority
    // over scheduled tasks (standups, digests) that can tolerate delay.
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        log.error('Unhandled error in runForGroup (drain)', { groupJid, err }),
      );
      return;
    }

    // Then scheduled tasks
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        log.error('Unhandled error in runTask (drain)', { groupJid, taskId: task.id, err }),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    for (const nextJid of this.waitingGroups) {
      if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) break;

      const state = this.getGroup(nextJid);
      this.waitingGroups.delete(nextJid);

      // Prioritize user messages over scheduled tasks
      if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          log.error('Unhandled error in runForGroup (waiting)', { groupJid: nextJid, err }),
        );
      } else if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          log.error('Unhandled error in runTask (waiting)', { groupJid: nextJid, taskId: task.id, err }),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Cancel all pending retry and starvation timers to allow clean
    // event-loop drain and prevent post-shutdown filesystem writes
    // (the starvation timer fires closeStdin, which writes a _close sentinel).
    for (const [, state] of this.groups) {
      if (state.retryTimer !== null) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
      if (state.taskStarvationTimer !== null) {
        clearTimeout(state.taskStarvationTimer);
        state.taskStarvationTimer = null;
      }
    }

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    log.info('GroupQueue shutting down (containers detached, not killed)', {
      activeCount: this.activeCount,
      detachedContainers: activeContainers,
    });
  }
}
