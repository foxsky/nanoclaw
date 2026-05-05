/**
 * send-otp module — host-side handler for the `send_otp` system action.
 *
 * Registered on import. The container-side MCP tool
 * (container/agent-runner/src/mcp-tools/send-otp.ts) writes the outbound
 * system row; this module's handler validates + delivers.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleSendOtp } from './handler.js';

registerDeliveryAction('send_otp', handleSendOtp);
