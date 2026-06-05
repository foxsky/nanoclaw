/**
 * PARITY-BLOCKER (#389) — container emit half of deterministic
 * notification dispatch. Restores V1's `dispatchNotifications()`: the
 * engine generates cross-chat notifications, the api_* tools normalize
 * them into `notification_events`, and this emits them as ONE `system`
 * outbound row (`taskflow_dispatch_notifications`) that the host
 * delivery action delivers — the agent does NOT relay them (the generated
 * board CLAUDE.md says "do NOT relay").
 *
 * In-session ONLY. The standalone FastAPI subprocess (detected via
 * `isTaskflowSubprocess()` — verbatim-ids OR a service-outbound path; the
 * latter is OPTIONAL so verbatim is the reliable signal) has no session
 * outbound.db and returns notification_events in its JSON response for its
 * own client — so this is a deliberate no-op there, leaving the dashboard
 * path unchanged.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { emitDeterministicToolMessage } from './mutation-confirmation.js';
import type { NotificationEvent } from './taskflow-helpers.js';
import { isTaskflowSubprocess } from './taskflow-helpers.js';
import { generateId, log } from './util.js';

export const DISPATCH_NOTIFICATIONS_ACTION = 'taskflow_dispatch_notifications';

export interface DispatchDeps {
  /** Override the subprocess detection (tests). Defaults to the process-level service path. */
  servicePath?: string | undefined;
  /** Seam for the session outbound writer (tests). */
  writeSession?: (msg: { id: string; kind: string; content: string }) => unknown;
  /** Seam for the in-chat emitter (tests). Defaults to emitDeterministicToolMessage. */
  emitInChat?: (text: string) => void;
  /** Fixed id for deterministic assertions (tests). */
  id?: string;
}

export function dispatchNotificationEvents(
  events: NotificationEvent[],
  deps: DispatchDeps = {},
): void {
  if (!events.length) return;
  // The FastAPI subprocess returns notification_events in its JSON response;
  // only the in-container WhatsApp agent dispatches via the session
  // outbound.db. Gate on the reliable subprocess signal (verbatim ids OR a
  // service-outbound path), NOT servicePath alone: --service-outbound-db is
  // OPTIONAL, and a subprocess without it would otherwise fall through to
  // writeMessageOut → DEFAULT_OUTBOUND_PATH (/workspace/outbound.db) →
  // double-send. Mirrors the #396 enqueue/drain gates.
  if (isTaskflowSubprocess(deps.servicePath)) return;

  // in_chat_notice entries are current-chat messages with NO JID (the
  // "Convite pendente" forwardable invite card) — show them in the current
  // chat (composing with the confirmation card); they are NOT
  // host-dispatchable, so exclude them from the host row. (#399)
  const dispatchable: NotificationEvent[] = [];
  for (const ev of events) {
    if (ev.kind === 'in_chat_notice') {
      (deps.emitInChat ?? emitDeterministicToolMessage)(ev.message);
    } else {
      dispatchable.push(ev);
    }
  }
  if (!dispatchable.length) return;

  // Best-effort, fire-and-forget: the mutation already succeeded. A failed
  // outbound write (no session DB in an engine-only / test context) must
  // NEVER fail the tool result — mirrors emitDeterministicToolMessage.
  try {
    const id = deps.id ?? generateId();
    (deps.writeSession ?? writeMessageOut)({
      id,
      kind: 'system',
      content: JSON.stringify({ action: DISPATCH_NOTIFICATIONS_ACTION, events: dispatchable }),
    });
  } catch (err) {
    log(`taskflow_dispatch_notifications emission failed: ${String(err)}`);
  }
}
