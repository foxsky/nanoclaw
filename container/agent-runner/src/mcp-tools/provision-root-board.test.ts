/**
 * Container-side MCP tool: validates input and writes a kind:'system'
 * outbound row carrying { action: 'provision_root_board', ...payload }.
 * The host-side delivery action handler enforces permission and runs the
 * actual provisioning.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const validInput = {
  subject: 'Setor de Engenharia',
  person_id: 'p-001',
  person_name: 'Caio Guimarães',
  person_phone: '+5585999991234',
  short_code: 'ENG',
};

describe('provision_root_board MCP tool (container side)', () => {
  it('exports a tool definition with name "provision_root_board"', async () => {
    const { provisionRootBoardTool } = await import('./provision-root-board.ts');
    expect(provisionRootBoardTool).toBeDefined();
    expect(provisionRootBoardTool.tool.name).toBe('provision_root_board');
  });

  it('declares the 5 required string fields', async () => {
    const { provisionRootBoardTool } = await import('./provision-root-board.ts');
    const schema = provisionRootBoardTool.tool.inputSchema as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    for (const field of ['subject', 'person_id', 'person_name', 'person_phone', 'short_code']) {
      expect(schema.properties[field]?.type).toBe('string');
      expect(schema.required).toContain(field);
    }
  });

  it('errors when any required field is empty', async () => {
    const { provisionRootBoardTool } = await import('./provision-root-board.ts');
    const result = await provisionRootBoardTool.handler({ ...validInput, subject: '   ' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/subject/i);
  });

  it('on valid input writes kind:"system" outbound row with action="provision_root_board" + full payload', async () => {
    const { provisionRootBoardTool } = await import('./provision-root-board.ts');
    const result = await provisionRootBoardTool.handler(validInput);
    expect(result.isError).toBeFalsy();

    const row = getOutboundDb().query('SELECT id, kind, content FROM messages_out').get() as
      | { id: string; kind: string; content: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('system');
    const content = JSON.parse(row!.content);
    expect(content.action).toBe('provision_root_board');
    expect(content.subject).toBe(validInput.subject);
    expect(content.person_id).toBe(validInput.person_id);
    expect(content.person_name).toBe(validInput.person_name);
    expect(content.person_phone).toBe(validInput.person_phone);
    expect(content.short_code).toBe(validInput.short_code);
  });

  it('forwards optional fields verbatim into the outbound payload', async () => {
    const { provisionRootBoardTool } = await import('./provision-root-board.ts');
    const result = await provisionRootBoardTool.handler({
      ...validInput,
      participants: ['5511999000001@s.whatsapp.net'],
      trigger: '@Case',
      requires_trigger: false,
      language: 'pt-BR',
      timezone: 'America/Fortaleza',
      wip_limit: 7,
      max_depth: 4,
      model: 'claude-sonnet-4-6',
      group_context: 'Test board context',
    });
    expect(result.isError).toBeFalsy();

    const row = getOutboundDb().query('SELECT content FROM messages_out').get() as { content: string };
    const content = JSON.parse(row.content);
    expect(content.participants).toEqual(['5511999000001@s.whatsapp.net']);
    expect(content.trigger).toBe('@Case');
    expect(content.requires_trigger).toBe(false);
    expect(content.wip_limit).toBe(7);
    expect(content.max_depth).toBe(4);
    expect(content.model).toBe('claude-sonnet-4-6');
  });
});
