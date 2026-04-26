import { describe, expect, it } from 'vitest';

import {
  buildNanoclawMcpEnv,
  isSessionSlashCommand,
  NANOCLAW_ALLOWED_TOOLS,
} from './runtime-config.js';

describe('agent-runner runtime config', () => {
  it('allows SQLite MCP tools for SQLite-backed TaskFlow boards', () => {
    expect(NANOCLAW_ALLOWED_TOOLS).toContain('mcp__sqlite__*');
  });

  it('passes TaskFlow metadata into the NanoClaw MCP server env', () => {
    expect(
      buildNanoclawMcpEnv({
        prompt: 'test',
        groupFolder: 'taskflow-root',
        chatJid: '123@g.us',
        isMain: false,
        isTaskflowManaged: true,
        taskflowBoardId: 'board-taskflow-root',
        taskflowHierarchyLevel: 0,
        taskflowMaxDepth: 3,
      }),
    ).toEqual({
      NANOCLAW_CHAT_JID: '123@g.us',
      NANOCLAW_GROUP_FOLDER: 'taskflow-root',
      NANOCLAW_IS_MAIN: '0',
      NANOCLAW_IS_TASKFLOW_MANAGED: '1',
      NANOCLAW_TASKFLOW_BOARD_ID: 'board-taskflow-root',
      NANOCLAW_TASKFLOW_HIERARCHY_LEVEL: '0',
      NANOCLAW_TASKFLOW_MAX_DEPTH: '3',
    });
  });

  describe('isSessionSlashCommand', () => {
    it('matches /compact on its own', () => {
      expect(isSessionSlashCommand('/compact')).toBe(true);
      expect(isSessionSlashCommand('  /compact  \n')).toBe(true);
    });

    it('does NOT match when prompt has been mutated with prepended context', () => {
      // Regression: context recap / embedding preamble are prepended to the
      // prompt before slash-command detection. If detection runs on the
      // mutated prompt, /compact is silently demoted to a chat message.
      const recap = '--- Recent conversation history ---\n[Apr 10 10:00] Prior chat\n---';
      const mutated = `${recap}\n\n/compact`;
      expect(isSessionSlashCommand(mutated)).toBe(false);
      // But the ORIGINAL prompt still matches, which is the whole point:
      // callers must pass the raw user prompt, not the mutated one.
      expect(isSessionSlashCommand('/compact')).toBe(true);
    });

    it('does not match unknown slash commands', () => {
      expect(isSessionSlashCommand('/unknown')).toBe(false);
      expect(isSessionSlashCommand('hello /compact world')).toBe(false);
    });
  });

  it('still marks non-TaskFlow groups explicitly as unmanaged', () => {
    expect(
      buildNanoclawMcpEnv({
        prompt: 'test',
        groupFolder: 'plain-group',
        chatJid: '456@g.us',
        isMain: false,
      }),
    ).toEqual({
      NANOCLAW_CHAT_JID: '456@g.us',
      NANOCLAW_GROUP_FOLDER: 'plain-group',
      NANOCLAW_IS_MAIN: '0',
      NANOCLAW_IS_TASKFLOW_MANAGED: '0',
    });
  });

  it('passes through the host-issued turn ID when present', () => {
    expect(
      buildNanoclawMcpEnv({
        prompt: 'test',
        groupFolder: 'plain-group',
        chatJid: '456@g.us',
        isMain: false,
        turnContext: { turnId: 'turn-123' },
      }),
    ).toEqual({
      NANOCLAW_CHAT_JID: '456@g.us',
      NANOCLAW_GROUP_FOLDER: 'plain-group',
      NANOCLAW_IS_MAIN: '0',
      NANOCLAW_IS_TASKFLOW_MANAGED: '0',
      NANOCLAW_TURN_ID: 'turn-123',
    });
  });

  it('emits the sender JID env var when the turn carries one (audit attribution)', () => {
    const env = buildNanoclawMcpEnv({
      prompt: 'test',
      groupFolder: 'taskflow-root',
      chatJid: '123@g.us',
      isMain: false,
      isTaskflowManaged: true,
      taskflowBoardId: 'board-foo',
      turnContext: {
        turnId: 'turn-99',
        senderJid: '5586999999999@s.whatsapp.net',
      },
    });
    expect(env.NANOCLAW_TURN_SENDER_JID).toBe('5586999999999@s.whatsapp.net');
  });

  it('omits the sender JID env var when no sender is present (e.g. scheduled tasks)', () => {
    const env = buildNanoclawMcpEnv({
      prompt: 'test',
      groupFolder: 'taskflow-root',
      chatJid: '123@g.us',
      isMain: false,
      isTaskflowManaged: true,
      taskflowBoardId: 'board-foo',
      turnContext: { turnId: 'turn-99' },
    });
    expect(env).not.toHaveProperty('NANOCLAW_TURN_SENDER_JID');
  });
});
