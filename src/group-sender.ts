import { ASSISTANT_NAME } from './config.js';

/**
 * Derive the display name for outbound messages from a group's trigger pattern.
 * "@Case" → "Case", undefined → ASSISTANT_NAME.
 *
 * TaskFlow boards use per-group triggers (e.g. @Case) while the main group
 * uses the global ASSISTANT_NAME (e.g. Tars). This function resolves the
 * correct sender name for message prefixing and bot-message filtering.
 */
export function getGroupSenderName(trigger?: string): string {
  return trigger?.replace(/^@/, '') || ASSISTANT_NAME;
}
