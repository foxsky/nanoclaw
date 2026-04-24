import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DATA_DIR } from './config.js';
import {
  _initTestDatabase,
  createAgentTurn,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    const turn = createAgentTurn({
      groupFolder: 'other-group',
      chatJid: 'other@g.us',
      messages: [
        {
          messageId: 'msg-101',
          chatJid: 'other@g.us',
          sender: '123@s.whatsapp.net',
          senderName: 'Alice',
          timestamp: '2026-04-19T10:00:00.000Z',
        },
      ],
    });
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        targetJid: 'other@g.us',
        turnId: turn.id,
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
    expect(allTasks[0].trigger_message_id).toBe('msg-101');
    expect(allTasks[0].trigger_sender_name).toBe('Alice');
    expect(allTasks[0].trigger_turn_id).toBe(turn.id);
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('ignores a foreign turn ID when scheduling a task', async () => {
    const foreignTurn = createAgentTurn({
      groupFolder: 'third-group',
      chatJid: 'third@g.us',
      messages: [
        {
          messageId: 'msg-foreign',
          chatJid: 'third@g.us',
          sender: '999@s.whatsapp.net',
          senderName: 'Mallory',
          timestamp: '2026-04-19T10:01:00.000Z',
        },
      ],
    });

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        targetJid: 'other@g.us',
        turnId: foreignTurn.id,
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks).toHaveLength(1);
    expect(allTasks[0].trigger_turn_id).toBeNull();
    expect(allTasks[0].trigger_message_id).toBeNull();
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2027-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2027-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2027-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2027-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2027-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2027-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2027-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- schedule_task auto-ack (silent-lembrete fix) ---

describe('schedule_task auto-ack', () => {
  let ackSpy: Array<{ jid: string; text: string }>;

  function seedTurn(messageId: string, chatJid = 'other@g.us') {
    return createAgentTurn({
      groupFolder: 'other-group',
      chatJid,
      messages: [
        {
          messageId,
          chatJid,
          sender: '123@s.whatsapp.net',
          senderName: 'Joao',
          timestamp: '2026-04-21T15:08:46.000Z',
        },
      ],
    });
  }

  // Two microtask ticks: one for the IIFE to start, one for its `await` to
  // settle. Reliable because our mocks resolve synchronously (same tick).
  async function flushAck(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    ackSpy = [];
    deps.sendMessage = async (jid, text) => {
      ackSpy.push({ jid, text });
    };
  });

  it('emits a terse ack to the trigger chat when scheduled with turn context', async () => {
    const turn = seedTurn('msg-ack-1');
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Envie um resumo amanhã',
        schedule_type: 'once',
        schedule_value: '2027-06-01T12:00:00',
        targetJid: 'other@g.us',
        turnId: turn.id,
      },
      'other-group',
      false,
      deps,
    );
    await flushAck();

    expect(getAllTasks()).toHaveLength(1);
    expect(ackSpy).toHaveLength(1);
    expect(ackSpy[0].jid).toBe('other@g.us');
    expect(ackSpy[0].text).toMatch(/^⏰ Lembrete agendado para /);
  });

  it('does NOT ack when task is scheduled without turn context (system/cron)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'system task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );
    await flushAck();

    expect(getAllTasks()).toHaveLength(1);
    expect(ackSpy).toHaveLength(0);
  });

  it('cron ack wording when scheduled with turn context', async () => {
    const turn = seedTurn('msg-ack-cron');
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'standup diario',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'other@g.us',
        turnId: turn.id,
      },
      'other-group',
      false,
      deps,
    );
    await flushAck();

    expect(ackSpy).toHaveLength(1);
    expect(ackSpy[0].text).toContain('recorrente');
    expect(ackSpy[0].text).toContain('0 9 * * *');
  });

  it('swallows async sendMessage failures without losing the task', async () => {
    deps.sendMessage = async () => {
      throw new Error('simulated WA outage');
    };

    const turn = seedTurn('msg-ack-err-async');
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'still schedules',
        schedule_type: 'once',
        schedule_value: '2027-06-01T12:00:00',
        targetJid: 'other@g.us',
        turnId: turn.id,
      },
      'other-group',
      false,
      deps,
    );
    await flushAck();

    expect(getAllTasks()).toHaveLength(1);
  });

  it('swallows SYNCHRONOUS sendMessage throws without losing the task', async () => {
    // Regression guard: prod deps.sendMessage at src/index.ts:1337 throws
    // synchronously if no channel matches the JID. The IIFE's await
    // converts the sync throw into a rejected promise caught by try/catch.
    deps.sendMessage = () => {
      throw new Error(`No channel for JID: other@g.us`);
    };

    const turn = seedTurn('msg-ack-err-sync');
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'still schedules on sync throw',
        schedule_type: 'once',
        schedule_value: '2027-06-01T12:00:00',
        targetJid: 'other@g.us',
        turnId: turn.id,
      },
      'other-group',
      false,
      deps,
    );
    await flushAck();

    expect(getAllTasks()).toHaveLength(1);
  });

  it('handler does NOT block on slow sendMessage (fire-and-forget)', async () => {
    // Non-blocking is load-bearing for the IPC watcher serial loop —
    // a hung WA send must not delay subsequent task files.
    let sendResolved = false;
    deps.sendMessage = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          sendResolved = true;
          resolve();
        }, 500);
      });

    const turn = seedTurn('msg-ack-slow');
    const handlerStart = Date.now();
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'slow send',
        schedule_type: 'once',
        schedule_value: '2027-06-01T12:00:00',
        targetJid: 'other@g.us',
        turnId: turn.id,
      },
      'other-group',
      false,
      deps,
    );
    const handlerMs = Date.now() - handlerStart;

    expect(getAllTasks()).toHaveLength(1);
    // Handler must return well before the 500ms sendMessage settles.
    expect(handlerMs).toBeLessThan(100);
    expect(sendResolved).toBe(false);
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

// --- deferred_notification TTL safety ---
//
// Regression: if a deferred_notification payload is missing/invalid
// `timestamp`, the TTL guard was skipped. When the target person's board
// wasn't yet provisioned (or the taskflow DB was unavailable), the handler
// would re-queue the same payload every poll cycle forever — burning CPU
// and never expiring. The fix stamps `data.timestamp` when missing so the
// next cycle can TTL-expire the notification.

describe('deferred_notification TTL stamping', () => {
  const TEST_SOURCE_GROUP = 'ipc-test-deferred-notification';
  const testTasksDir = path.join(
    DATA_DIR,
    'ipc',
    TEST_SOURCE_GROUP,
    'tasks',
  );

  afterEach(() => {
    try {
      fs.rmSync(path.join(DATA_DIR, 'ipc', TEST_SOURCE_GROUP), {
        recursive: true,
        force: true,
      });
    } catch {
      // best-effort cleanup
    }
  });

  it('stamps timestamp on re-queue when original payload lacks one', async () => {
    fs.mkdirSync(testTasksDir, { recursive: true });

    // Process a deferred_notification with NO timestamp field. Because the
    // taskflow DB is not present in the test env, the handler will hit the
    // `tfDb === null` branch and call reQueueDeferredNotification. Without
    // the fix, the re-queued payload would still lack a timestamp and
    // never TTL-expire.
    await processTaskIpc(
      {
        type: 'deferred_notification',
        target_person_id: 'person-123',
        text: 'hello',
        // no `timestamp` field on purpose
      },
      TEST_SOURCE_GROUP,
      false,
      deps,
    );

    const files = fs
      .readdirSync(testTasksDir)
      .filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);

    const requeued = JSON.parse(
      fs.readFileSync(path.join(testTasksDir, files[0]), 'utf-8'),
    );
    expect(requeued.type).toBe('deferred_notification');
    expect(requeued.target_person_id).toBe('person-123');
    expect(typeof requeued.timestamp).toBe('string');
    const stamped = new Date(requeued.timestamp as string).getTime();
    expect(Number.isFinite(stamped)).toBe(true);
    // The stamp should be close to "now" (within a few seconds).
    expect(Math.abs(Date.now() - stamped)).toBeLessThan(5000);
  });
});
