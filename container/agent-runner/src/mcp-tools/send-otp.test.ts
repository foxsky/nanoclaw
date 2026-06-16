/**
 * v2 send_otp MCP tool — TDD-RED→GREEN spec (skill/taskflow-v2 sub-task 2.3.a.1).
 *
 * Container-side wrapper: validates input shape and emits a `kind: 'system'`
 * outbound row. The host-side delivery action handler is authoritative for
 * permission (per-chat is_main_control gate) and delivery.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { setServiceOutboundDbPath, setVerbatimIds } from './taskflow-helpers.js';

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

/**
 * FastAPI/dashboard subprocess path (Option A web-login OTP, 2026-06-16). The
 * branch is keyed on getVerbatimIds() — the PROCESS-level subprocess signal set
 * only by taskflow-server-entry.ts. These tests pin the two halves of the trust
 * boundary at the tool layer:
 *   - verbatim TRUE  → write the TRUSTED `service_send_otp` row to the SERVICE
 *     outbound (never the session outbound) + return the JSON {success:true}
 *     envelope the dashboard's client.call parses.
 *   - verbatim FALSE → the chat path, even when a service outbound path happens
 *     to be configured — a chat agent can NEVER emit `service_send_otp`.
 */
const SERVICE_DDL = `
  CREATE TABLE messages_out (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT,
    timestamp TEXT NOT NULL, deliver_after TEXT, recurrence TEXT,
    kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT,
    thread_id TEXT, content TEXT NOT NULL
  );
`;

function parseEnvelope(result: { content: unknown }): Record<string, unknown> {
  // jsonResponse wraps the object as content:[{type:'text',text:JSON}].
  const text = (result.content as Array<{ text: string }>)[0].text;
  return JSON.parse(text);
}

function serviceRows(path: string) {
  const d = new Database(path);
  try {
    return d.prepare('SELECT id, kind, content FROM messages_out').all() as Array<{
      id: string;
      kind: string;
      content: string;
    }>;
  } finally {
    d.close();
  }
}

describe('send_otp MCP tool — FastAPI service subprocess path', () => {
  let svcDir: string;
  let svcPath: string;

  beforeEach(() => {
    svcDir = mkdtempSync(join(tmpdir(), 'otp-svc-'));
    svcPath = join(svcDir, 'service-outbound.db');
    const d = new Database(svcPath);
    d.exec(SERVICE_DDL);
    d.close();
  });

  afterEach(() => {
    // Reset the process-level flags so the chat-path suite above is unaffected.
    setVerbatimIds(false);
    setServiceOutboundDbPath(undefined);
    rmSync(svcDir, { recursive: true, force: true });
  });

  it('verbatim=true writes service_send_otp to the SERVICE outbound and returns {success:true}', async () => {
    setVerbatimIds(true);
    setServiceOutboundDbPath(svcPath);
    const { sendOtpTool } = await import('./send-otp.ts');
    const result = await sendOtpTool.handler({ phone: '+5585999991234', message: 'Codigo: 123456' });

    expect(parseEnvelope(result)).toEqual({ success: true });
    // Wrote to the SERVICE db…
    const svc = serviceRows(svcPath);
    expect(svc).toHaveLength(1);
    expect(svc[0].kind).toBe('system');
    expect(JSON.parse(svc[0].content)).toEqual({
      action: 'service_send_otp',
      phone: '+5585999991234',
      message: 'Codigo: 123456',
    });
    // …and NOT to the session outbound.
    const sess = getOutboundDb().query('SELECT id FROM messages_out').all();
    expect(sess).toHaveLength(0);
  });

  it('verbatim=true with NO service path returns the service_unavailable envelope (fail-closed)', async () => {
    setVerbatimIds(true);
    setServiceOutboundDbPath(undefined);
    const { sendOtpTool } = await import('./send-otp.ts');
    const result = await sendOtpTool.handler({ phone: '+5585999991234', message: 'Codigo: 123456' });
    expect(parseEnvelope(result)).toMatchObject({ success: false, error_code: 'service_unavailable' });
    expect(getOutboundDb().query('SELECT id FROM messages_out').all()).toHaveLength(0);
  });

  it('verbatim=false uses the chat path (session outbound, action send_otp) even when a service path is set', async () => {
    setVerbatimIds(false);
    setServiceOutboundDbPath(svcPath);
    const { sendOtpTool } = await import('./send-otp.ts');
    const result = await sendOtpTool.handler({ phone: '+5585999991234', message: 'Codigo: 123456' });

    // Human-readable ok(string) ack, NOT the JSON envelope.
    expect(JSON.stringify(result.content)).toMatch(/submitted/i);
    // The service outbound stays empty — a chat agent can't emit service_send_otp.
    expect(serviceRows(svcPath)).toHaveLength(0);
    // Wrote the chat send_otp row to the SESSION outbound.
    const sess = getOutboundDb().query('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    expect(sess).toHaveLength(1);
    expect(JSON.parse(sess[0].content).action).toBe('send_otp');
  });
});
