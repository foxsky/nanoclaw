/**
 * PARITY-BLOCKER (#389) — container emit half. The in-container WhatsApp
 * agent dispatches the engine's cross-chat notifications deterministically
 * by writing ONE `system` outbound row the host drains
 * (`taskflow_dispatch_notifications`). The FastAPI subprocess (which has a
 * service-outbound path, NOT a session outbound.db) keeps returning
 * notification_events in its JSON response — so this emitter is a NO-OP
 * there, leaving the dashboard path untouched.
 */
import { describe, expect, it } from 'bun:test';

import { dispatchNotificationEvents } from './taskflow-notify-dispatch.ts';
import type { NotificationEvent } from './taskflow-helpers.ts';

const EVENTS: NotificationEvent[] = [
  { kind: 'direct_message', target_chat_jid: '551199@s.whatsapp.net', message: 'reassigned to you' },
];

describe('dispatchNotificationEvents', () => {
  it('emits one taskflow_dispatch_notifications system row in-session (no service path)', () => {
    const calls: Array<{ id: string; kind: string; content: string }> = [];
    dispatchNotificationEvents(EVENTS, {
      servicePath: undefined,
      id: 'fixed-id',
      writeSession: (msg) => {
        calls.push(msg);
        return 1;
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('system');
    expect(calls[0].id).toBe('fixed-id');
    const payload = JSON.parse(calls[0].content);
    expect(payload.action).toBe('taskflow_dispatch_notifications');
    expect(payload.events).toEqual(EVENTS);
  });

  it('does NOT emit when the event list is empty (no empty system rows)', () => {
    let called = false;
    dispatchNotificationEvents([], {
      servicePath: undefined,
      writeSession: () => {
        called = true;
        return 1;
      },
    });
    expect(called).toBe(false);
  });

  it('is a NO-OP in the FastAPI subprocess (service path set) — dashboard path unchanged', () => {
    let called = false;
    dispatchNotificationEvents(EVENTS, {
      servicePath: '/tmp/service-outbound.db',
      writeSession: () => {
        called = true;
        return 1;
      },
    });
    expect(called).toBe(false);
  });

  it('never throws when the outbound write fails — the mutation already succeeded (fire-and-forget)', () => {
    expect(() =>
      dispatchNotificationEvents(EVENTS, {
        servicePath: undefined,
        writeSession: () => {
          throw new Error('unable to open database file');
        },
      }),
    ).not.toThrow();
  });
});
