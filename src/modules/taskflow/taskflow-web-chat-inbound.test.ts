/**
 * 0h-v2 web-chat INGRESS host delivery-action (memo §0.3 step 2).
 *
 * Drains the `taskflow_web_chat_inbound` system row the engine enqueued
 * (api_send_chat → enqueueWebChatInbound) into the TaskFlow service
 * session's outbound.db; `delivery.ts` pollSweep → handleSystemAction
 * dispatches here. NOT a `taskflow_notify` clone — opposite operation:
 * `taskflow_notify` resolves group_jid then DELIVERS to the WhatsApp
 * adapter (egress); this resolves the SAME shared primitive
 * (`getMessagingGroupByPlatform`) then INJECTS a trigger-bypassed
 * `messages_in` row into the board's session (ingress, never the
 * adapter). Shared logic = that one already-shared db primitive; zero
 * duplicated business logic, `taskflow_notify` untouched.
 *
 * Codex#3-safe: the payload carries the engine-resolved `group_jid`, so
 * the host does ZERO taskflow.db reads — only `group_jid →
 * messaging_group (central v2.db) → session`. FAIL-CLOSED (Codex#2): any
 * unresolvable hop logs an error and writes NOTHING. Idempotent on
 * `taskflow-web:${board_chat_id}` (insertMessage is NOT id-idempotent;
 * a crash-then-redrain would otherwise throw UNIQUE).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types.js';

const writeSessionMessage = vi.fn();
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => writeSessionMessage(...a),
}));

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { log } from '../../log.js';

const GROUP_JID = '120363000000000042@g.us';
const svc: Session = {
  id: 'taskflow-service',
  agent_group_id: 'taskflow-service',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-05-17T00:00:00Z',
};

function seedRoute() {
  createAgentGroup({
    id: 'ag-board',
    name: 'Board AG',
    folder: 'ag-board',
    agent_provider: null,
    created_at: '2026-05-17T00:00:00Z',
  });
  createMessagingGroup({
    id: 'mg-board',
    channel_type: 'whatsapp',
    platform_id: GROUP_JID,
    name: 'Board WA group',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: '2026-05-17T00:00:00Z',
  });
  createSession({
    id: 'sess-board',
    agent_group_id: 'ag-board',
    messaging_group_id: 'mg-board',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: '2026-05-17T00:00:00Z',
  });
}

function payload(over: Record<string, unknown> = {}) {
  return {
    action: 'taskflow_web_chat_inbound',
    board_id: 'board-1',
    board_chat_id: 42,
    sender_name: 'web:Alice',
    content: 'hello from the dashboard',
    created_at: '2026-05-17T12:00:00.000Z',
    group_jid: GROUP_JID,
    ...over,
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  writeSessionMessage.mockReset();
  errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
  errSpy.mockRestore();
  infoSpy.mockRestore();
});

async function ingest(content: Record<string, unknown>) {
  const { handleTaskflowWebChatInbound } = await import('./taskflow-web-chat-inbound.js');
  await handleTaskflowWebChatInbound(content, svc, {} as never);
}

describe('handleTaskflowWebChatInbound', () => {
  it('injects a trigger-bypassed web-origin messages_in row into the board session', async () => {
    seedRoute();
    await ingest(payload());
    expect(writeSessionMessage).toHaveBeenCalledOnce();
    const [agId, sessId, msg] = writeSessionMessage.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(agId).toBe('ag-board');
    expect(sessId).toBe('sess-board');
    expect(msg.id).toBe('taskflow-web:42');
    expect(msg.kind).toBe('chat');
    expect(msg.trigger).toBe(1); // wakes the agent with NO @mention (V1 !hasWebOrigin parity)
    expect(msg.timestamp).toBe('2026-05-17T12:00:00.000Z');
    const c = JSON.parse(msg.content as string);
    expect(c.text).toBe('hello from the dashboard');
    expect(c.sender).toBe('web:Alice');
    expect(c.origin).toBe('taskflow_web'); // the load-bearing marker the poll-loop reply-router keys on
    expect(c.board_id).toBe('board-1');
    expect(c.board_chat_id).toBe(42);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED on missing group_jid (engine did not resolve it) — no write', async () => {
    seedRoute();
    await ingest(payload({ group_jid: '' }));
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED when group_jid maps to no messaging_group — no write', async () => {
    seedRoute();
    await ingest(payload({ group_jid: 'unknown@g.us' }));
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED when the messaging_group has no active session — no write', async () => {
    createMessagingGroup({
      id: 'mg-nosess',
      channel_type: 'whatsapp',
      platform_id: GROUP_JID,
      name: 'No session',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: '2026-05-17T00:00:00Z',
    });
    await ingest(payload());
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('FAIL-CLOSED on missing content/text — no write', async () => {
    seedRoute();
    await ingest(payload({ content: '   ' }));
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('is idempotent — a UNIQUE clash on redrain is a no-op, NOT an error', async () => {
    seedRoute();
    writeSessionMessage.mockImplementationOnce(() => {
      throw new Error('UNIQUE constraint failed: messages_in.id');
    });
    await ingest(payload());
    // already-ingested (crash-then-redrain): logged as info, not error,
    // and the handler does not rethrow.
    expect(errSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
  });
});
