/**
 * send_otp MCP tool — container side (skill/taskflow-v2).
 *
 * The agent calls this tool to deliver a transactional OTP message to a
 * phone number via WhatsApp. The tool validates input shape and writes a
 * `kind: 'system'` outbound row carrying `{ action: 'send_otp', phone,
 * message }`. The host-side delivery action handler
 * (src/modules/send-otp/handler.ts) is authoritative for permission
 * (per-chat is_main_control gate) and does the WhatsApp lookup + send.
 *
 * Layer split: this tool does NOT gate calls. The host enforces. The
 * agent receives a "submitted" success even when the host will silently
 * drop — same as v1 IPC fire-and-forget semantics (the v1 caller also
 * had no visibility into host-side dropping). If you're not the main
 * control's agent, your call is ack'd by the tool but discarded by the
 * host.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export const sendOtpTool: McpToolDefinition = {
  tool: {
    name: 'send_otp',
    description:
      'Send a transactional WhatsApp message (OTP, invitation, code) to a specific phone number. Only callable from the operator-designated main control chat — calls from elsewhere are silently dropped on the host. Fire-and-forget: the tool ack returns when your call is submitted, not when the message is delivered. The host validates the phone is on WhatsApp and delivers; failures (phone-not-on-WhatsApp, non-main caller) are dropped without notifying you.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phone: {
          type: 'string',
          description:
            'Phone in international format (with or without "+" / dashes / spaces). Brazilian numbers without country code get "55" prepended automatically by the WhatsApp adapter.',
        },
        message: {
          type: 'string',
          description: 'Plain-text message body. Will be delivered as a WhatsApp text message to the resolved JID.',
        },
      },
      required: ['phone', 'message'],
    },
  },
  async handler(args) {
    const phone = nonEmptyString(args.phone);
    if (!phone) return err('phone is required and must be a non-empty string');
    const message = nonEmptyString(args.message);
    if (!message) return err('message is required and must be a non-empty string');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'send_otp', phone, message }),
    });

    log(`send_otp: ${requestId} → ${phone} (msg ${message.length}ch)`);
    return ok(`OTP send submitted (id=${requestId}). Fire-and-forget — host will drop silently if you're not the main control chat or the phone isn't on WhatsApp.`);
  },
};

registerTools([sendOtpTool]);
