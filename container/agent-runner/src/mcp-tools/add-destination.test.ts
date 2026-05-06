import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('add_destination MCP tool (container side)', () => {
  it('exports a tool with name "add_destination"', async () => {
    const { addDestinationTool } = await import('./add-destination.ts');
    expect(addDestinationTool.tool.name).toBe('add_destination');
  });

  it('declares local_name as required + both target fields optional', async () => {
    const { addDestinationTool } = await import('./add-destination.ts');
    const schema = addDestinationTool.tool.inputSchema as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.properties.local_name.type).toBe('string');
    expect(schema.properties.target_messaging_group_id.type).toBe('string');
    expect(schema.properties.target_agent_group_id.type).toBe('string');
    expect(schema.required).toEqual(['local_name']);
  });

  it('errors when local_name is empty', async () => {
    const { addDestinationTool } = await import('./add-destination.ts');
    const result = await addDestinationTool.handler({ local_name: '   ', target_messaging_group_id: 'mg-1' });
    expect(result.isError).toBe(true);
  });

  it('errors when neither target is provided', async () => {
    const { addDestinationTool } = await import('./add-destination.ts');
    const result = await addDestinationTool.handler({ local_name: 'caio' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/target/i);
  });

  it('errors when BOTH targets are provided (mutex)', async () => {
    const { addDestinationTool } = await import('./add-destination.ts');
    const result = await addDestinationTool.handler({
      local_name: 'caio',
      target_messaging_group_id: 'mg-1',
      target_agent_group_id: 'ag-1',
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/exactly one/i);
  });

  it('on valid input writes kind:"system" outbound row with action="add_destination"', async () => {
    const { addDestinationTool } = await import('./add-destination.ts');
    const result = await addDestinationTool.handler({
      local_name: 'caio',
      target_messaging_group_id: 'mg-caio',
    });
    expect(result.isError).toBeFalsy();
    const row = getOutboundDb().query('SELECT kind, content FROM messages_out').get() as {
      kind: string;
      content: string;
    };
    expect(row.kind).toBe('system');
    const content = JSON.parse(row.content);
    expect(content.action).toBe('add_destination');
    expect(content.local_name).toBe('caio');
    expect(content.target_messaging_group_id).toBe('mg-caio');
  });
});
