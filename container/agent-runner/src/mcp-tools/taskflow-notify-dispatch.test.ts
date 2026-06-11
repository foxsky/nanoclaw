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
import { setVerbatimIds } from './taskflow-helpers.ts';

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

  it('never writes a session row in the FastAPI subprocess (verbatim ids), even with NO service path (no /workspace double-send)', () => {
    // The subprocess sets verbatim ids UNCONDITIONALLY, but --service-outbound-db
    // is OPTIONAL. With servicePath absent, a servicePath-only gate falls through
    // and writeMessageOut lazily opens DEFAULT_OUTBOUND_PATH (/workspace/outbound.db)
    // — writing a host-deliverable row the dashboard already returned to its own
    // client (DOUBLE-SEND). getVerbatimIds() is the reliable subprocess signal, so
    // the gate must honor it too (matches the #396 enqueue/drain gates).
    setVerbatimIds(true);
    try {
      let wroteSession = false;
      let enqueuedBus = false;
      dispatchNotificationEvents(EVENTS, {
        servicePath: undefined,
        writeSession: () => {
          wroteSession = true;
          return 1;
        },
        enqueueBus: () => {
          enqueuedBus = true;
          return 1;
        },
      });
      // Never the session row (no /workspace double-send). And with NO service
      // path there's no bus to enqueue to either — tf fail-mode (b): the events
      // stay in the JSON response, delivery is skipped (not double-sent).
      expect(wroteSession).toBe(false);
      expect(enqueuedBus).toBe(false);
    } finally {
      setVerbatimIds(false);
    }
  });

  it('R3: in the FastAPI subprocess with a service path, ENQUEUES resolved-JID events to the taskflow_notify bus (group target), not a session row', () => {
    // R3-REFINED (INBOUND tf-mcontrol 2026-06-10): the dashboard path can't no-op —
    // FastAPI is a Python process that can't call deliverTextToWhatsAppJid. The
    // engine already resolved the JID in-subprocess; enqueue it to the same
    // service outbound bus that taskflow_notify drains (group target, since the
    // host fail-closed-refuses person targets).
    const bus: Array<{ path: string; params: Record<string, unknown> }> = [];
    let wroteSession = false;
    dispatchNotificationEvents(
      [
        { kind: 'direct_message', target_chat_jid: '551199@s.whatsapp.net', message: 'reassigned to you' },
        { kind: 'parent_notification', parent_group_jid: '120363@g.us', message: 'rollup' },
      ],
      {
        servicePath: '/tmp/service-outbound.db',
        boardId: 'board-x',
        writeSession: () => {
          wroteSession = true;
          return 1;
        },
        enqueueBus: (path, params) => {
          bus.push({ path, params: params as unknown as Record<string, unknown> });
          return 1;
        },
      },
    );
    expect(wroteSession).toBe(false); // never the in-session row on the subprocess
    expect(bus).toHaveLength(2);
    expect(bus[0].path).toBe('/tmp/service-outbound.db');
    expect(bus[0].params.board_id).toBe('board-x');
    expect(bus[0].params.target).toEqual({ kind: 'group', group_jid: '551199@s.whatsapp.net' });
    expect(bus[0].params.text).toBe('reassigned to you');
    expect(bus[1].params.target).toEqual({ kind: 'group', group_jid: '120363@g.us' });
    expect(bus[1].params.text).toBe('rollup');
  });

  it('R3: skips no-JID events (deferred_notification / in_chat_notice / destination_message) on the bus path', () => {
    const bus: Array<{ params: Record<string, unknown> }> = [];
    dispatchNotificationEvents(
      [
        { kind: 'deferred_notification', target_person_id: 'p1', message: 'offline' },
        { kind: 'in_chat_notice', message: 'pendente' },
        { kind: 'destination_message', destination_name: 'peer', message: 'symbolic' },
        { kind: 'direct_message', target_chat_jid: '551199@s.whatsapp.net', message: 'deliverable' },
      ],
      {
        servicePath: '/tmp/service-outbound.db',
        boardId: 'board-x',
        enqueueBus: (_path, params) => {
          bus.push({ params: params as unknown as Record<string, unknown> });
          return 1;
        },
      },
    );
    // Only the direct_message (resolved JID) is enqueued; the rest have no
    // host-deliverable JID and are skipped-with-reason.
    expect(bus).toHaveLength(1);
    expect(bus[0].params.text).toBe('deliverable');
  });

  it('R3: a bus enqueue throw never bubbles (fire-and-forget; the mutation already committed)', () => {
    expect(() =>
      dispatchNotificationEvents(EVENTS, {
        servicePath: '/tmp/service-outbound.db',
        enqueueBus: () => {
          throw new Error('unable to open database file');
        },
      }),
    ).not.toThrow();
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
