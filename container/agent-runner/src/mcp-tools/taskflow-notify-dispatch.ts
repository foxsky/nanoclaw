/**
 * PARITY-BLOCKER (#389) — container emit half of deterministic
 * notification dispatch. Restores V1's `dispatchNotifications()`: the
 * engine generates cross-chat notifications, the api_* tools normalize
 * them into `notification_events`, and this emits them as ONE `system`
 * outbound row (`taskflow_dispatch_notifications`) that the host
 * delivery action delivers — the agent does NOT relay them (the generated
 * board CLAUDE.md says "do NOT relay").
 *
 * In-session ONLY. The standalone FastAPI subprocess
 * (`getServiceOutboundDbPath()` is set) has no session outbound.db and
 * returns notification_events in its JSON response for its own client —
 * so this is a deliberate no-op there, leaving the dashboard path
 * unchanged.
 */
import { writeMessageOut } from '../db/messages-out.js';
import type { NotificationEvent } from './taskflow-helpers.js';
import { getServiceOutboundDbPath } from './taskflow-helpers.js';
import { generateId, log } from './util.js';

export const DISPATCH_NOTIFICATIONS_ACTION = 'taskflow_dispatch_notifications';

export interface DispatchDeps {
  /** Override the subprocess detection (tests). Defaults to the process-level service path. */
  servicePath?: string | undefined;
  /** Seam for the session outbound writer (tests). */
  writeSession?: (msg: { id: string; kind: string; content: string }) => unknown;
  /** Fixed id for deterministic assertions (tests). */
  id?: string;
}

export function dispatchNotificationEvents(
  events: NotificationEvent[],
  deps: DispatchDeps = {},
): void {
  if (!events.length) return;
  // The FastAPI subprocess returns notification_events in its JSON
  // response; only the in-container WhatsApp agent dispatches via the
  // session outbound.db.
  const servicePath = deps.servicePath !== undefined ? deps.servicePath : getServiceOutboundDbPath();
  if (servicePath) return;

  // Best-effort, fire-and-forget: the mutation already succeeded. A failed
  // outbound write (no session DB in an engine-only / test context) must
  // NEVER fail the tool result — mirrors emitDeterministicToolMessage.
  try {
    const id = deps.id ?? generateId();
    (deps.writeSession ?? writeMessageOut)({
      id,
      kind: 'system',
      content: JSON.stringify({ action: DISPATCH_NOTIFICATIONS_ACTION, events }),
    });
  } catch (err) {
    log(`taskflow_dispatch_notifications emission failed: ${String(err)}`);
  }
}
