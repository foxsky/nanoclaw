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
import { enqueueOutboundMessage, type EnqueueOutboundParams } from '../db/taskflow-outbound.js';
import { emitDeterministicToolMessage } from './mutation-confirmation.js';
import type { NotificationEvent } from './taskflow-helpers.js';
import { getServiceOutboundDbPath, isTaskflowSubprocess } from './taskflow-helpers.js';
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
  /** R3: origin board for the bus payload (logging on the host, which routes by
   *  resolved JID). Optional — defaults to '' on the FastAPI bus path. */
  boardId?: string;
  /** R3: seam for the service-bus enqueue (tests). Defaults to enqueueOutboundMessage. */
  enqueueBus?: (path: string, params: EnqueueOutboundParams) => unknown;
}

export function dispatchNotificationEvents(
  events: NotificationEvent[],
  deps: DispatchDeps = {},
): void {
  if (!events.length) return;
  // The in-container WhatsApp agent dispatches via its session outbound.db. The
  // FastAPI subprocess has NO session DB — but it CANNOT just no-op: tf-mcontrol
  // is a Python process that can't deliver WhatsApp itself (R3-REFINED). Route
  // the resolved-JID events to the same service outbound bus the host
  // `taskflow_notify` action already drains. Gate on the reliable subprocess
  // signal (verbatim ids OR a service-outbound path), NOT servicePath alone:
  // --service-outbound-db is OPTIONAL, and a subprocess falling through to
  // writeMessageOut → DEFAULT_OUTBOUND_PATH (/workspace/outbound.db) would
  // double-send what the dashboard already returned to its own client.
  if (isTaskflowSubprocess(deps.servicePath)) {
    dispatchViaServiceBus(events, deps);
    return;
  }

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

/**
 * R3-REFINED (INBOUND tf-mcontrol 2026-06-10): FastAPI-subprocess delivery.
 * The engine already resolved each notification's chat JID in-subprocess; enqueue
 * those to the same service outbound bus the host `taskflow_notify` action drains
 * (`enqueueOutboundMessage` → resolved-JID → deliverTextToWhatsAppJid). This reuses
 * the ENTIRE existing host delivery path — no new IPC type, no tf-side delivery
 * logic, no host person→JID resolution (the host fail-closed-refuses person targets,
 * so only group-JID targets are enqueued).
 *
 * Only `direct_message` (target_chat_jid) and `parent_notification` (parent_group_jid)
 * carry a host-deliverable JID. `deferred_notification` (offline/unprovisioned —
 * target_person_id only), `destination_message` (symbolic, agent-resolved) and
 * `in_chat_notice` (the dashboard renders these from the JSON response) have no JID
 * and are skipped-with-reason — mirroring `planNotificationDeliveries`' skip policy.
 *
 * No service path = tf fail-mode (b) (partial-deploy window before the operator sets
 * --service-outbound-db): the events remain in the tool's JSON response, delivery is
 * skipped (NOT double-sent). Per-event fail-soft: the mutation already committed, so
 * a bus write failure must never bubble (would re-run the handler → duplicate sends).
 */
function dispatchViaServiceBus(events: NotificationEvent[], deps: DispatchDeps): void {
  const servicePath =
    deps.servicePath !== undefined ? deps.servicePath : getServiceOutboundDbPath();
  if (!servicePath) {
    log(
      `taskflow service-bus dispatch: no --service-outbound-db wired — ${events.length} event(s) left in the JSON response (not delivered)`,
    );
    return;
  }
  const enqueue = deps.enqueueBus ?? enqueueOutboundMessage;
  for (const ev of events) {
    const jid =
      ev.kind === 'direct_message'
        ? ev.target_chat_jid
        : ev.kind === 'parent_notification'
          ? ev.parent_group_jid
          : null;
    if (!jid) {
      log(`taskflow service-bus dispatch: skipping ${ev.kind} (no host-deliverable JID)`);
      continue;
    }
    try {
      enqueue(servicePath, {
        id: generateId(),
        board_id: deps.boardId ?? '',
        target: { kind: 'group', group_jid: jid },
        text: ev.message,
      });
    } catch (err) {
      log(`taskflow service-bus enqueue failed (${ev.kind}): ${String(err)}`);
    }
  }
}
