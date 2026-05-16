import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const validInput = {
  person_id: 'p-002',
  person_name: 'Laizys Costa',
  person_phone: '+5585999992345',
  person_role: 'developer',
};

describe('provision_child_board MCP tool (container side)', () => {
  it('exports a tool definition with name "provision_child_board"', async () => {
    const { provisionChildBoardTool } = await import('./provision-child-board.ts');
    expect(provisionChildBoardTool).toBeDefined();
    expect(provisionChildBoardTool.tool.name).toBe('provision_child_board');
  });

  it('declares the 4 required string fields', async () => {
    const { provisionChildBoardTool } = await import('./provision-child-board.ts');
    const schema = provisionChildBoardTool.tool.inputSchema as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    for (const field of ['person_id', 'person_name', 'person_phone', 'person_role']) {
      expect(schema.properties[field]?.type).toBe('string');
      expect(schema.required).toContain(field);
    }
  });

  it('errors when any required field is empty', async () => {
    const { provisionChildBoardTool } = await import('./provision-child-board.ts');
    const result = await provisionChildBoardTool.handler({ ...validInput, person_role: '   ' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/role/i);
  });

  it('errors without group_folder or group_name so child boards never fall back to person names', async () => {
    const { provisionChildBoardTool } = await import('./provision-child-board.ts');
    const result = await provisionChildBoardTool.handler(validInput);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/group_folder/i);
  });

  it('derives group_folder from group_name when the model omits it', async () => {
    const { provisionChildBoardTool } = await import('./provision-child-board.ts');
    const result = await provisionChildBoardTool.handler({
      ...validInput,
      group_name: 'SEAF-PATRIMÔNIO - TaskFlow',
      short_code: 'SEAFP',
    });
    expect(result.isError).toBeFalsy();

    const row = getOutboundDb().query('SELECT kind, content FROM messages_out').get() as {
      kind: string;
      content: string;
    };
    expect(row.kind).toBe('system');
    const content = JSON.parse(row.content);
    expect(content.group_name).toBe('SEAF-PATRIMÔNIO - TaskFlow');
    expect(content.group_folder).toBe('seaf-patrimonio-taskflow');
  });

  it('on valid input writes kind:"system" outbound row with action="provision_child_board"', async () => {
    const { provisionChildBoardTool } = await import('./provision-child-board.ts');
    const result = await provisionChildBoardTool.handler({
      ...validInput,
      group_folder: 'ux-setd-secti-taskflow',
      group_name: 'UX-SETD-SECTI - TaskFlow',
      short_code: 'UXSETD',
    });
    expect(result.isError).toBeFalsy();

    const row = getOutboundDb().query('SELECT kind, content FROM messages_out').get() as {
      kind: string;
      content: string;
    };
    expect(row.kind).toBe('system');
    const content = JSON.parse(row.content);
    expect(content.action).toBe('provision_child_board');
    expect(content.person_id).toBe(validInput.person_id);
    expect(content.person_role).toBe(validInput.person_role);
    expect(content.group_folder).toBe('ux-setd-secti-taskflow');
    expect(content.short_code).toBe('UXSETD');
  });
});
