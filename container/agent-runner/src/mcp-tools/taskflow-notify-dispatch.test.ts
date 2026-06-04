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

  it('emits an in_chat_notice in-chat and EXCLUDES it from the host dispatch row (#399)', () => {
    const inChatCalls: string[] = [];
    const sessionCalls: Array<{ id: string; kind: string; content: string }> = [];
    dispatchNotificationEvents(
      [
        { kind: 'in_chat_notice', message: 'Convite pendente — encaminhe esta mensagem' },
        { kind: 'direct_message', target_chat_jid: '551199@s.whatsapp.net', message: 'reassigned' },
      ],
      {
        servicePath: undefined,
        id: 'fixed',
        emitInChat: (t) => inChatCalls.push(t),
        writeSession: (m) => {
          sessionCalls.push(m);
          return 1;
        },
      },
    );
    expect(inChatCalls).toEqual(['Convite pendente — encaminhe esta mensagem']);
    expect(sessionCalls).toHaveLength(1);
    const payload = JSON.parse(sessionCalls[0].content);
    expect(payload.events).toEqual([
      { kind: 'direct_message', target_chat_jid: '551199@s.whatsapp.net', message: 'reassigned' },
    ]);
  });

  it('an in_chat_notice-only batch emits in-chat and writes NO host row (#399)', () => {
    let wrote = false;
    const inChatCalls: string[] = [];
    dispatchNotificationEvents([{ kind: 'in_chat_notice', message: 'pendente' }], {
      servicePath: undefined,
      emitInChat: (t) => inChatCalls.push(t),
      writeSession: () => {
        wrote = true;
        return 1;
      },
    });
    expect(inChatCalls).toEqual(['pendente']);
    expect(wrote).toBe(false);
  });
});
