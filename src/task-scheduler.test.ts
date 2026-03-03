import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getDueTasks,
  getTaskById,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  describe('computeNextRun', () => {
    it('returns a future ISO date for cron tasks', () => {
      const task = {
        id: 'task-cron',
        group_folder: 'main',
        chat_jid: 'test@g.us',
        prompt: 'run',
        schedule_type: 'cron' as const,
        schedule_value: '0 9 * * *', // daily at 9am
        context_mode: 'isolated' as const,
        next_run: null,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-02-22T00:00:00.000Z',
      };

      const nextRun = computeNextRun(task);
      expect(nextRun).toBeTruthy();
      expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    });

    it('returns a future ISO date for interval tasks', () => {
      const task = {
        id: 'task-interval',
        group_folder: 'main',
        chat_jid: 'test@g.us',
        prompt: 'run',
        schedule_type: 'interval' as const,
        schedule_value: '300000', // 5 minutes
        context_mode: 'isolated' as const,
        next_run: null,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-02-22T00:00:00.000Z',
      };

      const nextRun = computeNextRun(task);
      expect(nextRun).toBeTruthy();
      const expectedMin = Date.now() + 300000 - 1000; // allow 1s tolerance
      expect(new Date(nextRun!).getTime()).toBeGreaterThanOrEqual(expectedMin);
    });

    it('returns null for once tasks', () => {
      const task = {
        id: 'task-once',
        group_folder: 'main',
        chat_jid: 'test@g.us',
        prompt: 'run',
        schedule_type: 'once' as const,
        schedule_value: '2026-02-22T00:00:00.000Z',
        context_mode: 'isolated' as const,
        next_run: null,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-02-22T00:00:00.000Z',
      };

      const nextRun = computeNextRun(task);
      expect(nextRun).toBeNull();
    });
  });

  describe('double-pickup prevention', () => {
    it('advances next_run for cron tasks before execution so getDueTasks skips them', async () => {
      const now = Date.now();
      const pastTime = new Date(now - 60_000).toISOString();

      createTask({
        id: 'task-cron-double',
        group_folder: 'main',
        chat_jid: 'test@g.us',
        prompt: 'long running task',
        schedule_type: 'cron',
        schedule_value: '*/5 * * * *', // every 5 minutes
        context_mode: 'isolated',
        next_run: pastTime,
        status: 'active',
        created_at: '2026-02-22T00:00:00.000Z',
      });

      // Verify the task is initially due
      const dueBefore = getDueTasks();
      expect(dueBefore).toHaveLength(1);
      expect(dueBefore[0].id).toBe('task-cron-double');

      // Track DB state after the task function starts (synchronous part)
      // but before container execution completes.
      let dueDuringExecution: ReturnType<typeof getDueTasks> = [];

      const enqueueTask = vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          const promise = fn();
          // After fn starts (synchronous part ran: next_run advanced),
          // check if task is still returned by getDueTasks.
          dueDuringExecution = getDueTasks();
          return promise;
        },
      );

      startSchedulerLoop({
        registeredGroups: () => ({
          'test@g.us': {
            name: 'Test',
            folder: 'main',
            trigger: '@test',
            added_at: '2026-01-01T00:00:00.000Z',
          },
        }),
        getSessions: () => ({}),
        queue: { enqueueTask } as any,
        onProcess: () => {},
        sendMessage: async () => {},
      });

      await vi.advanceTimersByTimeAsync(10);

      expect(enqueueTask).toHaveBeenCalledTimes(1);

      // During execution, getDueTasks should NOT return this task
      // because next_run was advanced to the future
      const taskDuring = dueDuringExecution.find(
        (t) => t.id === 'task-cron-double',
      );
      expect(taskDuring).toBeUndefined();

      // Verify the task's next_run in DB is now in the future
      const taskAfter = getTaskById('task-cron-double');
      expect(taskAfter).toBeDefined();
      expect(taskAfter!.next_run).toBeTruthy();
      expect(new Date(taskAfter!.next_run!).getTime()).toBeGreaterThan(now);
    });

    it('advances next_run for interval tasks before execution', async () => {
      const now = Date.now();
      const pastTime = new Date(now - 60_000).toISOString();

      createTask({
        id: 'task-interval-double',
        group_folder: 'main',
        chat_jid: 'test@g.us',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '600000', // 10 minutes
        context_mode: 'isolated',
        next_run: pastTime,
        status: 'active',
        created_at: '2026-02-22T00:00:00.000Z',
      });

      let dueDuringExecution: ReturnType<typeof getDueTasks> = [];

      const enqueueTask = vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          const promise = fn();
          dueDuringExecution = getDueTasks();
          return promise;
        },
      );

      startSchedulerLoop({
        registeredGroups: () => ({
          'test@g.us': {
            name: 'Test',
            folder: 'main',
            trigger: '@test',
            added_at: '2026-01-01T00:00:00.000Z',
          },
        }),
        getSessions: () => ({}),
        queue: { enqueueTask } as any,
        onProcess: () => {},
        sendMessage: async () => {},
      });

      await vi.advanceTimersByTimeAsync(10);

      expect(enqueueTask).toHaveBeenCalledTimes(1);

      // During execution, task should not be due
      const taskDuring = dueDuringExecution.find(
        (t) => t.id === 'task-interval-double',
      );
      expect(taskDuring).toBeUndefined();

      // Verify next_run is ~10 minutes in the future
      const taskAfter = getTaskById('task-interval-double');
      expect(taskAfter).toBeDefined();
      expect(taskAfter!.next_run).toBeTruthy();
      const nextRunTime = new Date(taskAfter!.next_run!).getTime();
      expect(nextRunTime).toBeGreaterThanOrEqual(now + 600000 - 1000);
    });
  });
});
