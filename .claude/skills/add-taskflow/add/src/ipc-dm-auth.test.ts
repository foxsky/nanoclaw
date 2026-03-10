import { describe, it, expect } from 'vitest';
import { isIpcMessageAuthorized } from './ipc.js';
import type { RegisteredGroup } from './types.js';

const groups: Record<string, RegisteredGroup> = {
  '120363408855255405@g.us': {
    name: 'Team',
    folder: 'team-alpha',
    trigger: '@Case',
    added_at: '2026-01-01',
    taskflowManaged: true,
  },
};

describe('isIpcMessageAuthorized', () => {
  it('allows TaskFlow container to send to DM JID', () => {
    expect(
      isIpcMessageAuthorized({
        chatJid: '5585999991234@s.whatsapp.net',
        sourceGroup: 'team-alpha',
        isMain: false,
        isTaskflow: true,
        isKnownExternalDm: true,
        registeredGroups: groups,
      }),
    ).toBe('dm');
  });

  it('blocks non-TaskFlow container from sending to DM JID', () => {
    expect(
      isIpcMessageAuthorized({
        chatJid: '5585999991234@s.whatsapp.net',
        sourceGroup: 'team-alpha',
        isMain: false,
        isTaskflow: false,
        isKnownExternalDm: true,
        registeredGroups: groups,
      }),
    ).toBe(false);
  });

  it('allows main group to send to DM JID', () => {
    expect(
      isIpcMessageAuthorized({
        chatJid: '5585999991234@s.whatsapp.net',
        sourceGroup: 'main',
        isMain: true,
        isTaskflow: false,
        isKnownExternalDm: true,
        registeredGroups: groups,
      }),
    ).toBe('dm');
  });

  it('blocks unknown DM target even for TaskFlow container', () => {
    expect(
      isIpcMessageAuthorized({
        chatJid: '5585000000000@s.whatsapp.net',
        sourceGroup: 'team-alpha',
        isMain: false,
        isTaskflow: true,
        isKnownExternalDm: false,
        registeredGroups: groups,
      }),
    ).toBe(false);
  });

  it('allows group-to-group for TaskFlow', () => {
    expect(
      isIpcMessageAuthorized({
        chatJid: '120363408855255405@g.us',
        sourceGroup: 'other-group',
        isMain: false,
        isTaskflow: true,
        isKnownExternalDm: false,
        registeredGroups: groups,
      }),
    ).toBe('group');
  });

  it('blocks non-registered group target', () => {
    expect(
      isIpcMessageAuthorized({
        chatJid: '999999@g.us',
        sourceGroup: 'team-alpha',
        isMain: false,
        isTaskflow: true,
        isKnownExternalDm: false,
        registeredGroups: groups,
      }),
    ).toBe(false);
  });
});
