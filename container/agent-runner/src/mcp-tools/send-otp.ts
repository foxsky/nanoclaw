/**
 * send_otp MCP tool — container side (skill/taskflow-v2).
 *
 * The agent calls this tool to deliver a transactional OTP message to a
 * phone number via WhatsApp. The tool validates input shape and writes a
 * `kind: 'system'` outbound row carrying `{ action: 'send_otp', phone,
 * message }`. The host-side delivery action handler
 * (src/modules/send-otp/handler.ts) is authoritative for permission and
 * does the WhatsApp lookup + send.
 *
 * Layer split: this tool does NOT gate calls. Per Codex (2026-05-04) the
 * container layer is "mirror only" — host enforces. Without the host
 * module installed, the row gets logged "Unknown system action" and
 * dropped; the agent gets no error response (fire-and-forget).
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
      'Send a transactional WhatsApp message (OTP, invitation, code) to a specific phone number. The host validates that the phone is registered on WhatsApp and delivers the message; failures are logged but no error is returned to you (fire-and-forget). Only the operator-designated main control agent can use this — non-main agents will see calls silently dropped on the host side.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phone: {
          type: 'string',
          description:
            'Phone in international format, with or without "+" / dashes / spaces. Brazilian numbers without country code get "55" prepended automatically by the WhatsApp adapter.',
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
    return ok(`OTP send queued (id=${requestId}). Delivery is fire-and-forget — the host will lookup the WhatsApp JID and deliver, or silently drop if the phone is not on WhatsApp or you're not the main control agent.`);
  },
};

registerTools([sendOtpTool]);
