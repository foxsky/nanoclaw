import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcDeps, IpcHandler } from '../ipc.js';
import type { RegisteredGroup } from '../types.js';
import { register } from './provision-child-board.js';

describe('provision_child_board IPC plugin', () => {
  let registeredGroups: Record<string, RegisteredGroup>;
  let handler: IpcHandler;
  let deps: IpcDeps;
  let createGroup: ReturnType<typeof vi.fn>;
  let registerGroup: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let registered: IpcHandler | undefined;
    register((type, candidate) => {
      if (type === 'provision_child_board') registered = candidate;
    });
    if (!registered)
      throw new Error('provision_child_board handler not registered');
    handler = registered;

    createGroup = vi.fn(async (subject: string, participants: string[]) => ({
      jid: 'child-group@g.us',
      subject,
      participants,
    }));

    registerGroup = vi.fn();
    sendMessage = vi.fn(async () => {});

    registeredGroups = {
      'parent@g.us': {
        name: 'Parent TaskFlow',
        folder: 'parent-taskflow',
        trigger: '@Tars',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
        taskflowHierarchyLevel: 1,
        taskflowMaxDepth: 3,
      },
      'leaf@g.us': {
        name: 'Leaf TaskFlow',
        folder: 'leaf-taskflow',
        trigger: '@Tars',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
        taskflowHierarchyLevel: 3,
        taskflowMaxDepth: 3,
      },
      'plain@g.us': {
        name: 'Plain Group',
        folder: 'plain-group',
        trigger: '@Tars',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'no-depth@g.us': {
        name: 'No Depth TaskFlow',
        folder: 'no-depth-taskflow',
        trigger: '@Tars',
        added_at: '2024-01-01T00:00:00.000Z',
        taskflowManaged: true,
      },
    };

    deps = {
      sendMessage: sendMessage as IpcDeps['sendMessage'],
      registeredGroups: () => registeredGroups,
      registerGroup: registerGroup as IpcDeps['registerGroup'],
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
      createGroup: createGroup as IpcDeps['createGroup'],
    };
  });

  const validData = {
    person_id: 'joao',
    person_name: 'João Silva',
    person_phone: '5585999990000',
    person_role: 'desenvolvedor',
  };

  it('registers handler for provision_child_board type', () => {
    let registeredType: string | undefined;
    register((type) => {
      registeredType = type;
    });
    expect(registeredType).toBe('provision_child_board');
  });

  it('rejects non-TaskFlow groups', async () => {
    await handler(validData, 'plain-group', false, deps);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects groups without TaskFlow marker', async () => {
    await handler(validData, 'unknown-group', false, deps);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects leaf boards (level + 1 > max_depth)', async () => {
    await handler(validData, 'leaf-taskflow', false, deps);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects TaskFlow groups without depth metadata', async () => {
    await handler(validData, 'no-depth-taskflow', false, deps);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects when createGroup dep is not available', async () => {
    const depsWithoutCreateGroup = { ...deps, createGroup: undefined };
    await handler(validData, 'parent-taskflow', false, depsWithoutCreateGroup);
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('rejects missing person_id', async () => {
    await handler(
      { ...validData, person_id: '' },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects missing person_name', async () => {
    await handler(
      { ...validData, person_name: '' },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects missing person_phone', async () => {
    await handler(
      { ...validData, person_phone: '' },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects missing person_role', async () => {
    await handler(
      { ...validData, person_role: '' },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects non-string fields', async () => {
    await handler(
      { ...validData, person_id: 123 },
      'parent-taskflow',
      false,
      deps,
    );
    expect(createGroup).not.toHaveBeenCalled();
  });
});
