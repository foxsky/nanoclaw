import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const validInput = {
  subject: 'Project Atlas - TaskFlow',
  participants: ['5511999000001@s.whatsapp.net', '5511999000002@s.whatsapp.net'],
};

describe('create_group MCP tool (container side)', () => {
  it('exports a tool definition with name "create_group"', async () => {
    const { createGroupTool } = await import('./create-group.ts');
    expect(createGroupTool.tool.name).toBe('create_group');
  });

  it('declares subject string + participants array as required', async () => {
    const { createGroupTool } = await import('./create-group.ts');
    const schema = createGroupTool.tool.inputSchema as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.properties.subject.type).toBe('string');
    expect(schema.properties.participants.type).toBe('array');
    expect(schema.required).toEqual(expect.arrayContaining(['subject', 'participants']));
  });

  it('errors when subject is empty', async () => {
    const { createGroupTool } = await import('./create-group.ts');
    const result = await createGroupTool.handler({ ...validInput, subject: '   ' });
    expect(result.isError).toBe(true);
  });

  it('errors when participants is missing', async () => {
    const { createGroupTool } = await import('./create-group.ts');
    const result = await createGroupTool.handler({ subject: 'Test' });
    expect(result.isError).toBe(true);
  });

  it('on valid input writes kind:"system" outbound row with action="create_group"', async () => {
    const { createGroupTool } = await import('./create-group.ts');
    const result = await createGroupTool.handler(validInput);
    expect(result.isError).toBeFalsy();
    const row = getOutboundDb().query('SELECT kind, content FROM messages_out').get() as {
      kind: string;
      content: string;
    };
    expect(row.kind).toBe('system');
    const content = JSON.parse(row.content);
    expect(content.action).toBe('create_group');
    expect(content.subject).toBe(validInput.subject);
    expect(content.participants).toEqual(validInput.participants);
  });
});

// SEC#11 (Codex whole-epic sign-off): create_group opens a new WhatsApp group with an attacker-choosable
// subject + participant list — a board-chat call must be HELD for admin approval. Main-control (no board
// env) and approved replay still emit the real row.
describe('create_group SEC#11 approval gate', () => {
  const SAVED = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    else process.env.NANOCLAW_TASKFLOW_BOARD_ID = SAVED;
  });

  it('PARKS a board-chat call for admin approval instead of creating the group', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-1';
    const { createGroupTool } = await import('./create-group.ts');
    const result = await createGroupTool.handler(validInput);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error_code).toBe('pending_approval');
    const row = getOutboundDb().query('SELECT content FROM messages_out').get() as { content: string };
    const content = JSON.parse(row.content);
    expect(content.action).toBe('taskflow_request_approval');
    expect(content.tool).toBe('create_group');
  });

  it('on approved replay emits the REAL create_group row (gate bypassed)', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-1';
    const { createGroupTool } = await import('./create-group.ts');
    const { runAsApprovedReplay } = await import('./taskflow-approval.ts');
    await runAsApprovedReplay(() => createGroupTool.handler(validInput));
    const row = getOutboundDb().query('SELECT content FROM messages_out').get() as { content: string };
    expect(JSON.parse(row.content).action).toBe('create_group');
  });
});
