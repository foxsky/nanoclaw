import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  closeSessionDb,
  closeTaskflowDb,
  getInboundDb,
  getOutboundDb,
  initTestSessionDb,
} from './db/connection.ts';
import { applyBoardConfigColumns, setupEngineDb } from './mcp-tools/taskflow-test-fixtures.ts';
import {
  handleTaskflowAddExternalParticipantToLatestMeeting,
  handleTaskflowExplicitReassign,
} from './poll-loop.ts';
import { TaskflowEngine } from './taskflow-engine.ts';

// Delta-parity audit 2026-06-10 (HIGH): V1 had NO deterministic fast-paths —
// every mutation ran through the MCP tool layer, which always called
// dispatchNotifications() after a committed mutation (main:ipc-mcp-stdio.ts).
// V2's deterministic poll-loop handlers committed mutations and emitted only
// the in-chat card, silently discarding the engine's assignee/parent/invite
// notifications. These tests pin the restored contract: a successful
// deterministic mutation dispatches the SAME taskflow_dispatch_notifications
// system row its MCP-equivalent tool would (#389/#396/#397 finalizer contract).

const BOARD = 'board-det-dispatch';
const ROUTING = {
  inReplyTo: null as string | null,
  platformId: '120363400000000000@g.us',
  channelType: 'whatsapp',
  threadId: null as string | null,
};

const chatMsg = (text: string, sender = 'alice') =>
  [{ kind: 'chat', content: JSON.stringify({ sender, text }) }];

const outboundRows = () =>
  getOutboundDb().prepare('SELECT kind, content FROM messages_out').all() as Array<{
    kind: string;
    content: string;
  }>;

const dispatchedEvents = (): Array<Record<string, unknown>> =>
  outboundRows()
    .filter((r) => r.kind === 'system')
    .map((r) => JSON.parse(r.content))
    .filter((c) => c.action === 'taskflow_dispatch_notifications')
    .flatMap((c) => c.events as Array<Record<string, unknown>>);

beforeEach(() => {
  initTestSessionDb();
  // session_routing is host-written on container wake; the in_chat_notice
  // emitter (emitDeterministicToolMessage) refuses to emit without it.
  getInboundDb()
    .prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)')
    .run('whatsapp', ROUTING.platformId, ROUTING.threadId);
  process.env.NANOCLAW_TASKFLOW_BOARD_ID = BOARD;
});

afterEach(() => {
  delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  closeSessionDb();
  closeTaskflowDb();
});

describe('deterministic poll-loop mutation handlers dispatch engine notifications (V1 parity)', () => {
  it('explicit "atribuir <id> para <X>" delivers the assignee notification a V1 reassign always sent', () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
       VALUES (?, 'bob', 'bob', 'member', '120363400000000111@g.us')`,
    ).run(BOARD);
    const engine = new TaskflowEngine(db, BOARD);
    const created = engine.create({ board_id: BOARD, type: 'simple', title: 'Treinamento E-governe', sender_name: 'alice' });
    expect(created.success).toBe(true);
    const taskId = String(created.task_id ?? created.id);

    const handled = handleTaskflowExplicitReassign(
      { taskId, targetPerson: 'bob' },
      chatMsg(`atribuir ${taskId} para bob`),
      ROUTING,
    );
    expect(handled).toBe(true);

    // The confirmation card still goes to the originating chat…
    const cards = outboundRows().filter((r) => r.kind === 'chat');
    expect(cards.length).toBe(1);
    expect(JSON.parse(cards[0].content).text).toContain(taskId);

    // …AND the engine's assignee notification is host-dispatched, exactly as
    // the MCP api_reassign path does. bob's JID resolved → direct_message.
    const events = dispatchedEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'direct_message', target_chat_jid: '120363400000000111@g.us' }),
    );
  });

  it('explicit reassign to a null-JID person dispatches a deferred_notification (host-skipped, #396 contract)', () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const engine = new TaskflowEngine(db, BOARD);
    const created = engine.create({ board_id: BOARD, type: 'simple', title: 'Mapear contratos', sender_name: 'alice' });
    expect(created.success).toBe(true);
    const taskId = String(created.task_id ?? created.id);

    const handled = handleTaskflowExplicitReassign(
      { taskId, targetPerson: 'bob' },
      chatMsg(`atribuir ${taskId} para bob`),
      ROUTING,
    );
    expect(handled).toBe(true);

    const events = dispatchedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'deferred_notification', target_person_id: 'bob' }),
    );
  });

  it('deterministic add-external-participant emits the invite the MCP path would (was: silently dropped)', () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const engine = new TaskflowEngine(db, BOARD);
    const created = engine.create({
      board_id: BOARD,
      type: 'meeting',
      title: 'Reunião de alinhamento',
      scheduled_at: '2026-06-15T14:00:00.000Z',
      sender_name: 'alice',
    });
    expect(created.success).toBe(true);
    const taskId = String(created.task_id ?? created.id);

    const handled = handleTaskflowAddExternalParticipantToLatestMeeting(
      { taskId, participantName: 'Joana Externa', phone: '85988887777' },
      chatMsg(`adicionar Joana Externa (85 98888-7777) na reunião ${taskId}`),
      ROUTING,
    );
    expect(handled).toBe(true);

    // The engine builds an external-invite notification for a never-contacted
    // participant. Whichever shape it takes (in_chat_notice invite card →
    // extra chat row, or a JID-routed direct_message → system event), it must
    // NOT be silently dropped: something beyond the bare confirmation card
    // must carry the invite.
    const rows = outboundRows();
    const chatTexts = rows.filter((r) => r.kind === 'chat').map((r) => String(JSON.parse(r.content).text ?? ''));
    const inviteInChat = chatTexts.some((t) => /convite/i.test(t));
    const inviteDispatched = dispatchedEvents().length > 0;
    expect(inviteInChat || inviteDispatched).toBe(true);
  });

  it('resolves a manager authenticated by WhatsApp JID so a deterministic mutation is not denied (live-adapter parity)', () => {
    // On the native WhatsApp adapter the sender is the participant JID. Without
    // resolving it to the board person, engine.reassign's isManager check fails
    // and a legitimate manager reassignment is "Permission denied". senderName
    // must map alice's JID → 'alice' (manager) via board_people.phone.
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    applyBoardConfigColumns(db); // board_people.phone is host schema
    db.prepare(`UPDATE board_people SET phone = '5586981111111' WHERE board_id = ? AND person_id = 'alice'`).run(BOARD);
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const engine = new TaskflowEngine(db, BOARD);
    const created = engine.create({ board_id: BOARD, type: 'simple', title: 'Tarefa X', sender_name: 'alice' });
    const taskId = String(created.task_id ?? created.id);

    const handled = handleTaskflowExplicitReassign(
      { taskId, targetPerson: 'bob' },
      // chat sender is alice's authenticated WhatsApp phone JID, not her name
      chatMsg(`atribuir ${taskId} para bob`, '5586981111111@s.whatsapp.net'),
      ROUTING,
    );
    expect(handled).toBe(true);
    // Reassign succeeded → the card confirms it (no "Permission denied" reply).
    const reply = JSON.parse(outboundRows().filter((r) => r.kind === 'chat')[0].content).text as string;
    expect(reply).not.toMatch(/Permission denied|Não consegui/);
    expect(reply).toContain(taskId);
    // And the task is now bob's.
    const row = db.prepare(`SELECT assignee FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD, taskId) as {
      assignee: string;
    };
    expect(row.assignee).toBe('bob');
  });
});
