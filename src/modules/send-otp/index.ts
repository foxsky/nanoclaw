/**
 * send-otp module — host-side handler for the `send_otp` system action.
 *
 * Registered on import. The container-side MCP tool
 * (container/agent-runner/src/mcp-tools/send-otp.ts) writes the outbound
 * system row; this module's handler validates + delivers.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleSendOtp, handleServiceSendOtp } from './handler.js';

registerDeliveryAction('send_otp', handleSendOtp);
// Web-login OTP (Option A, 2026-06-16): the FastAPI service session's TRUSTED,
// ungated path. Distinct action so only the FastAPI subprocess can reach it.
registerDeliveryAction('service_send_otp', handleServiceSendOtp);
