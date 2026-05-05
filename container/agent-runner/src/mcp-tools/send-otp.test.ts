/**
 * v2 send_otp MCP tool — TDD-RED→GREEN spec (skill/taskflow-v2 sub-task 2.3.a.1).
 *
 * Container-side wrapper: validates input shape and emits a `kind: 'system'`
 * outbound row. The host-side delivery action handler is authoritative for
 * permission (per-chat is_main_control gate) and delivery.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_otp MCP tool (container side)', () => {
  it('exports a tool definition with name "send_otp"', async () => {
    const { sendOtpTool } = await import('./send-otp.ts');
    expect(sendOtpTool).toBeDefined();
    expect(sendOtpTool.tool.name).toBe('send_otp');
  });

  it('declares "phone" and "message" as required string inputs', async () => {
    const { sendOtpTool } = await import('./send-otp.ts');
    const schema = sendOtpTool.tool.inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties.phone.type).toBe('string');
    expect(schema.properties.message.type).toBe('string');
    expect(schema.required).toEqual(expect.arrayContaining(['phone', 'message']));
  });

  it('returns an error response when phone is empty', async () => {
    const { sendOtpTool } = await import('./send-otp.ts');
    const result = await sendOtpTool.handler({ phone: '   ', message: 'Codigo: 123456' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/phone/i);
  });

  it('returns an error response when message is empty', async () => {
    const { sendOtpTool } = await import('./send-otp.ts');
    const result = await sendOtpTool.handler({ phone: '+5585999991234', message: '' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/message/i);
  });

  it('on valid input, writes a kind:"system" outbound row with action="send_otp"', async () => {
    const { sendOtpTool } = await import('./send-otp.ts');
    const result = await sendOtpTool.handler({ phone: '+5585999991234', message: 'Codigo: 123456' });
    expect(result.isError).toBeFalsy();

    const row = getOutboundDb().query('SELECT id, kind, content FROM messages_out').get() as
      | { id: string; kind: string; content: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('system');
    const content = JSON.parse(row!.content);
    expect(content.action).toBe('send_otp');
    expect(content.phone).toBe('+5585999991234');
    expect(content.message).toBe('Codigo: 123456');
  });

  it('returns the outbound message id in the success response', async () => {
    const { sendOtpTool } = await import('./send-otp.ts');
    const result = await sendOtpTool.handler({ phone: '+5585999991234', message: 'Codigo: 123456' });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/msg-/);
  });
});
