/**
 * PARITY-BLOCKER (#389) — `taskflow_dispatch_notifications` host delivery
 * action. Restores V1's deterministic `dispatchNotifications()`
 * (ipc-mcp-stdio.ts:918): the engine generates cross-chat notifications,
 * the in-container WhatsApp agent emits them as one `system` outbound row,
 * and this handler delivers each — WITHOUT the agent having to relay them
 * (the generated board CLAUDE.md says "do NOT relay").
 *
 * Codex#3 host-zero-taskflow-reads contract: the host never reads
 * taskflow.db, so it can only deliver notification kinds that already
 * carry an engine-resolved JID — `direct_message` (reassign / external
 * invite DMs) and `parent_notification` (rollups). `destination_message`
 * (needs central-DB destination resolution — #395) and
 * `deferred_notification` (needs offline re-queue — #396) are
 * skipped-with-reason and logged, NEVER silently dropped.
 *
 * `planNotificationDeliveries` is the pure routing/policy seam (unit
 * tested exhaustively); the handler is a thin shell over the shared
 * `deliverTextToWhatsAppJid` primitive.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { deliverTextToWhatsAppJid } from './taskflow-notify.js';

export interface PlannedDelivery {
  kind: 'direct_message' | 'parent_notification';
  jid: string;
  text: string;
}

export interface SkippedDelivery {
  kind: string;
  reason: string;
}

function eventMessage(ev: Record<string, unknown>): string | null {
  const message = ev.message;
  return typeof message === 'string' && message.trim() ? message : null;
}

/** WhatsApp group JID. `parent_group_jid` is always a board group. */
function isGroupJid(s: unknown): s is string {
  return typeof s === 'string' && s.endsWith('@g.us');
}

/** WhatsApp group OR direct (DM) JID. `target_chat_jid` may be either. */
function isWhatsAppJid(s: unknown): s is string {
  return typeof s === 'string' && (s.endsWith('@g.us') || s.endsWith('@s.whatsapp.net'));
}

/**
 * Pure: split the emitted notification_events into deliveries the host can
 * execute now (JID already resolved) and skips with a human reason. Never
 * throws — a malformed payload becomes a skip, so one bad event can't sink
 * the rest of the batch.
 */
export function planNotificationDeliveries(raw: unknown): {
  deliveries: PlannedDelivery[];
  skipped: SkippedDelivery[];
} {
  const deliveries: PlannedDelivery[] = [];
  const skipped: SkippedDelivery[] = [];

  if (!Array.isArray(raw)) {
    skipped.push({ kind: 'unknown', reason: 'events payload is not an array' });
    return { deliveries, skipped };
  }

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      skipped.push({ kind: 'unknown', reason: 'event is not an object' });
      continue;
    }
    const ev = item as Record<string, unknown>;
    const kind = typeof ev.kind === 'string' ? ev.kind : String(ev.kind);
    const message = eventMessage(ev);
    if (!message) {
      skipped.push({ kind, reason: 'missing or empty message' });
      continue;
    }

    if (kind === 'direct_message') {
      const jid = ev.target_chat_jid;
      if (isWhatsAppJid(jid)) deliveries.push({ kind, jid, text: message });
      else skipped.push({ kind, reason: 'target_chat_jid is not a resolved WhatsApp JID' });
    } else if (kind === 'parent_notification') {
      const jid = ev.parent_group_jid;
      if (isGroupJid(jid)) deliveries.push({ kind, jid, text: message });
      else skipped.push({ kind, reason: 'parent_group_jid is not a WhatsApp group JID' });
    } else if (kind === 'destination_message') {
      skipped.push({ kind, reason: 'destination_name resolution not yet implemented (#395)' });
    } else if (kind === 'deferred_notification') {
      skipped.push({ kind, reason: 'offline re-queue not yet implemented (#396)' });
    } else {
      skipped.push({ kind, reason: `unknown notification kind "${kind}"` });
    }
  }

  return { deliveries, skipped };
}

export async function handleTaskflowDispatchNotifications(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const ctx = { sessionId: session.id, boardId: content.board_id };
  const { deliveries, skipped } = planNotificationDeliveries(content.events);

  for (const s of skipped) {
    log.warn(`taskflow_dispatch_notifications: skipped — ${s.reason}`, { ...ctx, kind: s.kind });
  }
  for (const d of deliveries) {
    if (await deliverTextToWhatsAppJid(d.jid, d.text, { ...ctx, kind: d.kind })) {
      log.info('taskflow_dispatch_notifications delivered', { ...ctx, kind: d.kind, jid: d.jid });
    }
  }
}
