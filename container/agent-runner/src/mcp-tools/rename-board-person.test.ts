/**
 * rename_board_person MCP tool — container side.
 *
 * Validates input and emits a `kind: 'system'` outbound row. The host handler
 * (src/modules/taskflow/rename-board-person.ts) owns the is_main_control gate
 * and the per-person cross-board UPDATE.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('rename_board_person MCP tool (container side)', () => {
  it('exports a tool named rename_board_person requiring board_id, person_id, name', async () => {
    const { renameBoardPersonTool } = await import('./rename-board-person.ts');
    expect(renameBoardPersonTool.tool.name).toBe('rename_board_person');
    const schema = renameBoardPersonTool.tool.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['board_id', 'person_id', 'name']));
  });

  it('errors when name is empty/whitespace', async () => {
    const { renameBoardPersonTool } = await import('./rename-board-person.ts');
    const r = await renameBoardPersonTool.handler({ board_id: 'b-1', person_id: 'jeff', name: '   ' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/name/i);
  });

  it('on valid input, writes a kind:"system" row with action=rename_board_person (host enforces the gate)', async () => {
    const { renameBoardPersonTool } = await import('./rename-board-person.ts');
    const r = await renameBoardPersonTool.handler({ board_id: 'b-1', person_id: 'jeff', name: 'Jefferson Corrected' });
    expect(r.isError).toBeFalsy();

    const row = getOutboundDb().query('SELECT kind, content FROM messages_out').get() as
      | { kind: string; content: string }
      | undefined;
    expect(row?.kind).toBe('system');
    const content = JSON.parse(row!.content);
    expect(content).toMatchObject({
      action: 'rename_board_person',
      board_id: 'b-1',
      person_id: 'jeff',
      name: 'Jefferson Corrected',
    });
  });
});
