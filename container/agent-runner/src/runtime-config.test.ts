import { describe, expect, it } from 'vitest';

import {
  buildNanoclawMcpEnv,
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
        taskflowHierarchyLevel: 0,
        taskflowMaxDepth: 3,
      }),
    ).toEqual({
      NANOCLAW_CHAT_JID: '123@g.us',
      NANOCLAW_GROUP_FOLDER: 'taskflow-root',
      NANOCLAW_IS_MAIN: '0',
      NANOCLAW_IS_TASKFLOW_MANAGED: '1',
      NANOCLAW_TASKFLOW_HIERARCHY_LEVEL: '0',
      NANOCLAW_TASKFLOW_MAX_DEPTH: '3',
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
});
