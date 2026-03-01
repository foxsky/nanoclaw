import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcDeps, IpcHandler } from '../ipc.js';
import type { RegisteredGroup } from '../types.js';
import { register } from './create-group.js';

describe('create_group IPC plugin', () => {
  let registeredGroups: Record<string, RegisteredGroup>;
  let handler: IpcHandler;
  let deps: IpcDeps;
  let createGroup: any;

  beforeEach(() => {
    let registered: IpcHandler | undefined;
    register((type, candidate) => {
      if (type === 'create_group') registered = candidate;
    });
    if (!registered) throw new Error('create_group handler not registered');
    handler = registered;

    createGroup = vi.fn(async (subject: string, participants: string[]) => ({
      jid: 'created@g.us',
      subject,
      participants,
    }));

    registeredGroups = {
      'taskflow@g.us': {
        name: 'TaskFlow',
        folder: 'taskflow-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
        taskflowHierarchyLevel: 1,
        taskflowMaxDepth: 3,
      },
      'taskflow-leaf@g.us': {
        name: 'TaskFlow Leaf',
        folder: 'taskflow-leaf-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
        taskflowHierarchyLevel: 2,
        taskflowMaxDepth: 3,
      },
      'plain@g.us': {
        name: 'Plain',
        folder: 'plain-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'legacy-taskflow@g.us': {
        name: 'Legacy TaskFlow',
        folder: 'legacy-taskflow-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
      },
    };

    deps = {
      sendMessage: async () => {},
      registeredGroups: () => registeredGroups,
      registerGroup: () => {},
      syncGroupMetadata: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      createGroup: async (subject, participants) =>
        createGroup(subject, participants),
    };
  });

  it('allows main group to create a valid group', async () => {
    await handler(
      {
        subject: '  Ops War Room  ',
        participants: [
          '5585999998888@s.whatsapp.net',
          '5585999997777@s.whatsapp.net',
        ],
      },
      'main',
      true,
      deps,
    );

    expect(createGroup).toHaveBeenCalledOnce();
    expect(createGroup).toHaveBeenCalledWith('Ops War Room', [
      '5585999998888@s.whatsapp.net',
      '5585999997777@s.whatsapp.net',
    ]);
  });

  it('allows TaskFlow groups to create a valid group', async () => {
    await handler(
      {
        subject: 'Ops',
        participants: ['5585999998888@s.whatsapp.net'],
      },
      'taskflow-group',
      false,
      deps,
    );

    expect(createGroup).toHaveBeenCalledOnce();
    expect(createGroup).toHaveBeenCalledWith('Ops', [
      '5585999998888@s.whatsapp.net',
    ]);
  });

  it('blocks TaskFlow groups at their max hierarchy depth', async () => {
    await handler(
      {
        subject: 'Ops',
        participants: ['5585999998888@s.whatsapp.net'],
      },
      'taskflow-leaf-group',
      false,
      deps,
    );

    expect(createGroup).not.toHaveBeenCalled();
  });

  it('allows the root board to create the last permitted level', async () => {
    registeredGroups['taskflow-root@g.us'] = {
      name: 'TaskFlow Root',
      folder: 'taskflow-root-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      taskflowManaged: true,
      taskflowHierarchyLevel: 0,
      taskflowMaxDepth: 2,
    };

    await handler(
      {
        subject: 'Ops',
        participants: ['5585999998888@s.whatsapp.net'],
      },
      'taskflow-root-group',
      false,
      deps,
    );

    expect(createGroup).toHaveBeenCalledOnce();
  });

  it('blocks non-main groups without the TaskFlow marker', async () => {
    await handler(
      {
        subject: 'Ops',
        participants: ['5585999998888@s.whatsapp.net'],
      },
      'plain-group',
      false,
      deps,
    );

    expect(createGroup).not.toHaveBeenCalled();
  });

  it('blocks TaskFlow groups without explicit depth metadata', async () => {
    await handler(
      {
        subject: 'Ops',
        participants: ['5585999998888@s.whatsapp.net'],
      },
      'legacy-taskflow-group',
      false,
      deps,
    );

    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects invalid participant JIDs', async () => {
    await handler(
      {
        subject: 'Ops',
        participants: ['not-a-jid'],
      },
      'main',
      true,
      deps,
    );

    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects duplicate participants', async () => {
    await handler(
      {
        subject: 'Ops',
        participants: [
          '5585999998888@s.whatsapp.net',
          '5585999998888@s.whatsapp.net',
        ],
      },
      'main',
      true,
      deps,
    );

    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects blank subjects', async () => {
    await handler(
      {
        subject: '   ',
        participants: ['5585999998888@s.whatsapp.net'],
      },
      'main',
      true,
      deps,
    );

    expect(createGroup).not.toHaveBeenCalled();
  });
});
