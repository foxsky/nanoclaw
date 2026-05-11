/** Pure-function helpers for TaskFlow actor + notification-event parsing.
 *  Exported for cross-repo consumers (Python REST roundtrip validators).
 *  No DB access; no I/O. */

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

export type NotificationEvent =
  | DeferredNotificationEvent
  | DirectMessageEvent
  | ParentNotificationEvent
  | DestinationMessageEvent;

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
