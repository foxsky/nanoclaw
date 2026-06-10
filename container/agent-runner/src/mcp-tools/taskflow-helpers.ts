/** Helpers for TaskFlow actor + notification-event parsing.
 *  Exported for cross-repo consumers (Python REST roundtrip validators).
 *
 *  Mostly pure (parseActorArg, parseNotificationEvents,
 *  normalizeEngineNotificationEvents do no I/O). The ONE exception is the
 *  actor-binding branch at the END of `normalizeAgentIds` (#419): on the
 *  in-session chat surface it reads the per-turn authenticated actor from the
 *  outbound DB via `getTurnActor`. That branch is reached only AFTER the
 *  verbatim early-return, so FastAPI/cross-repo verbatim consumers never touch
 *  the DB. */
import { getTurnActor } from './turn-actor.js';
import { isApprovedReplay } from './replay-flag.js';

export type TaskflowPersonActor = {
  actor_type: 'taskflow_person';
  source_auth: 'jwt';
  user_id: string;
  board_id: string;
  person_id: string;
  display_name: string;
};

export type ApiServiceActor = {
  actor_type: 'api_service';
  source_auth: 'api_token';
  board_id: string;
  service_name: string;
};

export type ResolvedActor = TaskflowPersonActor | ApiServiceActor;

export type DeferredNotificationEvent = {
  kind: 'deferred_notification';
  target_person_id: string;
  message: string;
};

export type DirectMessageEvent = {
  kind: 'direct_message';
  target_chat_jid: string;
  message: string;
};

export type ParentNotificationEvent = {
  kind: 'parent_notification';
  parent_group_jid: string;
  message: string;
};

/** Routed by symbolic name; the receiving agent's send_message MCP tool
 *  resolves the name via its agent_destinations registry. Used by cross-
 *  board approval flows where engine can't know peer destination names. */
export type DestinationMessageEvent = {
  kind: 'destination_message';
  destination_name: string;
  message: string;
};

/** A group-targeted notification the engine produced with NO resolved JID
 *  (e.g. the "Convite pendente" forwardable invite card). Not host-
 *  dispatchable — the container shows it in the current chat. */
export type InChatNoticeEvent = {
  kind: 'in_chat_notice';
  message: string;
};

export type NotificationEvent =
  | DeferredNotificationEvent
  | DirectMessageEvent
  | ParentNotificationEvent
  | DestinationMessageEvent
  | InChatNoticeEvent;

type RawEngineNotification = {
  target_kind?: 'group' | 'dm';
  target_person_id?: string;
  notification_group_jid?: string | null;
  target_chat_jid?: string | null;
  destination_name?: string | null;
  message?: string;
};

type RawParentNotification = {
  parent_group_jid?: string;
  message?: string;
};

/**
 * Normalize user-facing ID args before forwarding to the engine.
 *
 * Two layers:
 *
 *   1. **`board_id` host-injection (v1 parity).** If the container env
 *      defines `NANOCLAW_TASKFLOW_BOARD_ID`, it OVERWRITES whatever the
 *      agent passed (or didn't pass). Matches v1's `engine.X({ ...args,
 *      board_id: boardId })` pattern — the agent never has to think about
 *      board_id for board-scoped operations. When the env var is absent
 *      (non-taskflow agents), fall back to the agent's value with a
 *      `board-` prefix added if missing.
 *
 *   2. **task ID case-folding.** Agents sometimes pass user-typed lowercase
 *      IDs (`p11.23` for `P11.23`). Uppercase every `*task_id` key,
 *      `subtask_id`, and string arrays under `*task_ids` so SQLite's
 *      BINARY-collated lookups still match.
 *
 * Returns a new object; the input is not mutated.
 */
/**
 * FastAPI-subprocess "verbatim ids" mode. The standalone taskflow MCP
 * entrypoint passes canonical ids exactly (plain-UUID board ids,
 * already-cased task ids) and must NOT have them rewritten — this is the
 * Codex-flagged BLOCKER fix applied to EVERY FastAPI-facing tool, not
 * just the 4 board tools. Set once by `taskflow-server-entry.ts` before
 * serving; the in-container barrel never sets it, so the WhatsApp
 * agent's id-injection/casing is unchanged (zero regression).
 * Process-level, not a request arg — can't be spoofed by MCP input.
 */
let _verbatimIds = false;
export function setVerbatimIds(verbatim: boolean): void {
  _verbatimIds = verbatim;
}
/** True iff running as the FastAPI/dashboard subprocess. taskflow-server-entry.ts
 *  sets verbatim ids UNCONDITIONALLY at startup, so this is a RELIABLE subprocess
 *  signal — unlike the optional `--service-outbound-db` (getServiceOutboundDbPath). */
export function getVerbatimIds(): boolean {
  return _verbatimIds;
}

/**
 * 0h-v2 Option A — the TaskFlow service session's `outbound.db` absolute
 * path, handed to this subprocess by tf-mcontrol via
 * `--service-outbound-db` (ACKed contract). `enqueueOutboundMessage`
 * callers (`api_send_chat`, the FastAPI comment push) read it here.
 * Process-level like `_verbatimIds` — set once at entrypoint from argv,
 * never a per-request MCP arg, so tool input can't redirect outbound
 * writes. Absent is legal: tf fail-mode (b) — the caller fail-closes
 * per-call (returns a routing-failure error_code) rather than the
 * subprocess refusing to start.
 */
let _serviceOutboundDbPath: string | undefined;
export function setServiceOutboundDbPath(path: string | undefined): void {
  _serviceOutboundDbPath = path;
}
export function getServiceOutboundDbPath(): string | undefined {
  return _serviceOutboundDbPath;
}

/**
 * True iff this process is the FastAPI/dashboard taskflow subprocess (or one
 * explicitly handed a service outbound DB) — a context that must NOT touch the
 * in-session pending-notification queue (neither enqueue nor drain). The
 * `--service-outbound-db` arg is OPTIONAL, so servicePath alone is unreliable;
 * getVerbatimIds() is set UNCONDITIONALLY by taskflow-server-entry.ts, so it's
 * the reliable subprocess signal (Codex xhigh 2026-06-05). Pass
 * `servicePathOverride` to inject the dep (tests / deps.servicePath);
 * omit/undefined reads the process-level value.
 */
export function isTaskflowSubprocess(servicePathOverride?: string | undefined): boolean {
  const servicePath =
    servicePathOverride !== undefined ? servicePathOverride : getServiceOutboundDbPath();
  return !!servicePath || getVerbatimIds();
}

export function normalizeAgentIds(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (_verbatimIds) return out;
  const envBoard = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (envBoard) {
    out.board_id = envBoard;
  } else if (typeof out.board_id === 'string' && !out.board_id.startsWith('board-')) {
    out.board_id = 'board-' + out.board_id;
  }
  for (const key of Object.keys(out)) {
    if ((key.endsWith('task_id') || key === 'subtask_id') && typeof out[key] === 'string') {
      out[key] = (out[key] as string).toUpperCase();
    } else if (
      key.endsWith('task_ids') &&
      Array.isArray(out[key]) &&
      (out[key] as unknown[]).every((value) => typeof value === 'string')
    ) {
      out[key] = (out[key] as string[]).map((value) => value.toUpperCase());
    }
  }
  // SEC#12 (#418): the chat surface must never let the model assert SERVICE authority. The engine treats
  // sender_is_service=true as manager-equivalent (taskflow-engine.ts apiAddNote/apiEditNote/apiRemoveNote
  // and the api_update tool), so a prompt-injected sender_is_service:true is a direct privilege bypass.
  // No legitimate chat caller sets it (only the FastAPI/verbatim entry, which returned above, and the
  // engine-internal scheduled paths). Force it off unconditionally — idempotent on the #407 replay path
  // (the parked args were already normalized at park time).
  if ('sender_is_service' in out) out.sender_is_service = false;

  // SEC#13 (#419): BIND the actor to the authenticated inbound sender. The engine authorizes every
  // admin/mutate action on sender_name (isManager / isAssignee / no-self-approval / audit attribution),
  // but on the chat surface sender_name is a MODEL arg — a prompt-injected agent could name any manager.
  // The poll-loop pins the single authenticated trigger=1 chat sender of this turn into the turn-actor
  // channel; bind sender_name to it (OVERWRITE the model value, like board_id). The REAL fail-closed
  // enforcement for an UNRESOLVED actor is `requiresChatActor` (chat-actor-guard.ts), which denies the
  // mutate tool BEFORE this runs — relying on a sentinel string is not enough (Codex #419 BLOCKER:
  // unprivileged mutations don't hit a person check). Here we DELETE sender_name when unresolved as a
  // belt-and-suspenders backstop (an unguarded mutate tool then gets no actor → engine person checks
  // fail; an unresolved READ of "my tasks" correctly can't resolve a person). sender_external_id is
  // STRIPPED: no authenticated external-id reaches the container today (resolveExternalDm is unwired),
  // so any model-supplied value is a spoof; the FastAPI/verbatim external-accept path returned above and
  // is untouched. Gated to the in-session chat surface (env board, not #407 replay — the parked args were
  // authenticated at park time and re-binding to a now-empty channel would wrongly DENY them).
  if (process.env.NANOCLAW_TASKFLOW_BOARD_ID && !isApprovedReplay()) {
    if ('sender_name' in out) {
      const actor = getTurnActor();
      if (actor.resolved) out.sender_name = actor.sender;
      else delete out.sender_name;
    }
    if ('sender_external_id' in out) delete out.sender_external_id;
  }
  return out;
}

export function parseActorArg(raw: unknown): ResolvedActor {
  if (!raw || typeof raw !== 'object') {
    throw new Error('actor: expected object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.actor_type === 'taskflow_person') {
    if (typeof obj.user_id !== 'string' || !obj.user_id) {
      throw new Error('actor.user_id: required string');
    }
    if (typeof obj.board_id !== 'string' || !obj.board_id) {
      throw new Error('actor.board_id: required string');
    }
    if (typeof obj.person_id !== 'string' || !obj.person_id) {
      throw new Error('actor.person_id: required string');
    }
    if (typeof obj.display_name !== 'string' || !obj.display_name) {
      throw new Error('actor.display_name: required string');
    }
    if (obj.source_auth !== 'jwt') {
      throw new Error('actor.source_auth: expected "jwt" for taskflow_person');
    }
    return obj as TaskflowPersonActor;
  }
  if (obj.actor_type === 'api_service') {
    if (typeof obj.board_id !== 'string' || !obj.board_id) {
      throw new Error('actor.board_id: required string');
    }
    if (typeof obj.service_name !== 'string' || !obj.service_name) {
      throw new Error('actor.service_name: required string');
    }
    if (obj.source_auth !== 'api_token') {
      throw new Error('actor.source_auth: expected "api_token" for api_service');
    }
    return obj as ApiServiceActor;
  }
  throw new Error(`actor.actor_type: unknown value "${String(obj.actor_type)}"`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label}: required non-empty string`);
  }
  return value;
}

function parseNotificationEvent(raw: unknown, label: string): NotificationEvent {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label}: expected object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'deferred_notification') {
    return {
      kind: 'deferred_notification',
      target_person_id: requireNonEmptyString(obj.target_person_id, `${label}.target_person_id`),
      message: requireNonEmptyString(obj.message, `${label}.message`),
    };
  }
  if (obj.kind === 'direct_message') {
    return {
      kind: 'direct_message',
      target_chat_jid: requireNonEmptyString(obj.target_chat_jid, `${label}.target_chat_jid`),
      message: requireNonEmptyString(obj.message, `${label}.message`),
    };
  }
  if (obj.kind === 'parent_notification') {
    return {
      kind: 'parent_notification',
      parent_group_jid: requireNonEmptyString(obj.parent_group_jid, `${label}.parent_group_jid`),
      message: requireNonEmptyString(obj.message, `${label}.message`),
    };
  }
  if (obj.kind === 'destination_message') {
    return {
      kind: 'destination_message',
      destination_name: requireNonEmptyString(obj.destination_name, `${label}.destination_name`),
      message: requireNonEmptyString(obj.message, `${label}.message`),
    };
  }
  if (obj.kind === 'in_chat_notice') {
    return {
      kind: 'in_chat_notice',
      message: requireNonEmptyString(obj.message, `${label}.message`),
    };
  }
  throw new Error(`${label}.kind: unknown value "${String(obj.kind)}"`);
}

export function parseNotificationEvents(raw: unknown): NotificationEvent[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('notification_events: expected array');
  }
  return raw.map((item, index) => parseNotificationEvent(item, `notification_events[${index}]`));
}

export function normalizeEngineNotificationEvents(raw: unknown): NotificationEvent[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('mutation_result: expected object');
  }
  const result = raw as Record<string, unknown>;
  const normalized: NotificationEvent[] = [];
  const notifiedJids = new Set<string>();

  const notifications = result.notifications;
  if (notifications != null) {
    if (!Array.isArray(notifications)) {
      throw new Error('mutation_result.notifications: expected array');
    }
    for (let index = 0; index < notifications.length; index++) {
      const item = notifications[index];
      if (!item || typeof item !== 'object') {
        throw new Error(`mutation_result.notifications[${index}]: expected object`);
      }
      const notification = item as RawEngineNotification;
      const message = requireNonEmptyString(
        notification.message,
        `mutation_result.notifications[${index}].message`,
      );
      if (notification.target_kind === 'dm') {
        const targetChatJid = requireNonEmptyString(
          notification.target_chat_jid,
          `mutation_result.notifications[${index}].target_chat_jid`,
        );
        normalized.push({ kind: 'direct_message', target_chat_jid: targetChatJid, message });
        notifiedJids.add(targetChatJid);
        continue;
      }
      if (
        typeof notification.notification_group_jid === 'string' &&
        notification.notification_group_jid
      ) {
        normalized.push({
          kind: 'direct_message',
          target_chat_jid: notification.notification_group_jid,
          message,
        });
        notifiedJids.add(notification.notification_group_jid);
        continue;
      }
      if (typeof notification.target_person_id === 'string' && notification.target_person_id) {
        normalized.push({
          kind: 'deferred_notification',
          target_person_id: notification.target_person_id,
          message,
        });
        continue;
      }
      if (typeof notification.destination_name === 'string' && notification.destination_name) {
        normalized.push({
          kind: 'destination_message',
          destination_name: notification.destination_name,
          message,
        });
        continue;
      }
      if (notification.target_kind === 'group') {
        // A group-targeted notification with NO resolved JID is an in-chat
        // card (the "Convite pendente" forwardable invite) — show it in the
        // current chat; it is NOT host-dispatchable. Pre-#399 this threw,
        // which made finalizeMutationResult return success:false despite a
        // committed DB write.
        normalized.push({ kind: 'in_chat_notice', message });
        continue;
      }
      throw new Error(`mutation_result.notifications[${index}]: missing routing target`);
    }
  }

  const parentNotification = result.parent_notification;
  if (parentNotification != null) {
    if (!parentNotification || typeof parentNotification !== 'object') {
      throw new Error('mutation_result.parent_notification: expected object');
    }
    const parent = parentNotification as RawParentNotification;
    const parentGroupJid = requireNonEmptyString(
      parent.parent_group_jid,
      'mutation_result.parent_notification.parent_group_jid',
    );
    const message = requireNonEmptyString(
      parent.message,
      'mutation_result.parent_notification.message',
    );
    if (!notifiedJids.has(parentGroupJid)) {
      normalized.push({ kind: 'parent_notification', parent_group_jid: parentGroupJid, message });
    }
  }

  return normalized;
}
