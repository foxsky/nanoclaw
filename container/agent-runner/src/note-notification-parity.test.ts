import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.ts';
import { closeTaskflowDb } from './mcp-tools/db/taskflow-db.ts';
import { setupEngineDb } from './mcp-tools/taskflow-test-fixtures.ts';
import { __resetTurnActorForTesting, setTurnActor } from './mcp-tools/turn-actor.ts';
import { handleTaskflowProjectNoteUpdate } from './poll-loop.ts';
import { TaskflowEngine } from './taskflow-engine.ts';

// EX-019 restore (Codex full-review 2026-06-11): V1 routed an added note through
// engine.update(add_note), which pinged the task owner + parent board. V2's
// engine.apiAddNote was SILENT (no notifications), so adding a note to a
// teammate's task no longer notified them — a V1→V2 parity break across BOTH the
// MCP api_task_add_note tool and the deterministic poll-loop note handlers. These
// tests pin the restored behavior: apiAddNote builds the owner notification (and
// skips self), and the MCP tool dispatches it like api_task_add_comment does.

const BOARD = 'board-note-notif';

beforeEach(() => {
  initTestSessionDb();
  process.env.NANOCLAW_TASKFLOW_BOARD_ID = BOARD;
});
afterEach(() => {
  delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  closeSessionDb();
  closeTaskflowDb();
});

function seedBoardWithBob(): TaskflowEngine {
  const db = setupEngineDb(BOARD, { withBoardAdmins: true });
  db.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
     VALUES (?, 'bob', 'bob', 'member', '120363400000000111@g.us')`,
  ).run(BOARD);
  return new TaskflowEngine(db, BOARD);
}

describe('apiAddNote restores the V1 owner notification (EX-019)', () => {
  it("notifies the task owner when a DIFFERENT person adds a note (manager alice → bob's task)", () => {
    const engine = seedBoardWithBob();
    const created = engine.create({ board_id: BOARD, type: 'simple', title: 'Mapear contratos', sender_name: 'alice', assignee: 'bob' });
    const taskId = String(created.task_id ?? created.id);

    const res = engine.apiAddNote({ board_id: BOARD, task_id: taskId, sender_name: 'alice', text: 'precisa do anexo' }) as {
      success: boolean;
      notifications?: Array<{ target_person_id?: string; notification_group_jid?: string | null; message: string }>;
    };
    expect(res.success).toBe(true);
    expect(Array.isArray(res.notifications)).toBe(true);
    expect(res.notifications!.length).toBeGreaterThanOrEqual(1);
    const ownerNotif = res.notifications!.find((n) => n.target_person_id === 'bob');
    expect(ownerNotif).toBeTruthy();
    expect(ownerNotif!.notification_group_jid).toBe('120363400000000111@g.us');
    expect(ownerNotif!.message).toContain('Atualização na sua tarefa');
    expect(ownerNotif!.message).toContain('precisa do anexo');
  });

  it('on a self-note by the assignee, notifies the CREATOR/delegator — not the assignee (V1 parity)', () => {
    // alice (manager) created + assigned to bob; bob (assignee) self-notes → the
    // delegator alice is pinged, bob is NOT (resolveNotifTarget self-update branch).
    const engine = seedBoardWithBob();
    const created = engine.create({ board_id: BOARD, type: 'simple', title: 'Próprio', sender_name: 'alice', assignee: 'bob' });
    const taskId = String(created.task_id ?? created.id);

    const res = engine.apiAddNote({ board_id: BOARD, task_id: taskId, sender_name: 'bob', text: 'andamento' }) as {
      success: boolean;
      notifications?: Array<{ target_person_id?: string }>;
    };
    expect(res.success).toBe(true);
    const targets = (res.notifications ?? []).map((n) => n.target_person_id);
    expect(targets).toContain('alice');
    expect(targets).not.toContain('bob');
  });

  it('produces NO notification when the creator self-notes their own self-assigned task (creator == modifier)', () => {
    // alice (manager) creates + self-assigns, then self-notes → creator == modifier → no ping.
    const engine = seedBoardWithBob();
    const created = engine.create({ board_id: BOARD, type: 'simple', title: 'Solo', sender_name: 'alice', assignee: 'alice' });
    const taskId = String(created.task_id ?? created.id);

    const res = engine.apiAddNote({ board_id: BOARD, task_id: taskId, sender_name: 'alice', text: 'só pra mim' }) as {
      success: boolean;
      notifications?: unknown[];
    };
    expect(res.success).toBe(true);
    expect(res.notifications ?? []).toHaveLength(0);
  });
});

describe('api_task_add_note MCP tool dispatches the owner notification (V1 parity)', () => {
  it('emits a taskflow_dispatch_notifications system row for a note added to another person’s task', async () => {
    const engine = seedBoardWithBob();
    const created = engine.create({ board_id: BOARD, type: 'simple', title: 'Tarefa do Bob', sender_name: 'alice', assignee: 'bob' });
    const taskId = String(created.task_id ?? created.id);

    __resetTurnActorForTesting();
    setTurnActor(['alice']); // host-authenticated actor (normalizeAgentIds binds sender_name to it)
    const { apiTaskAddNoteTool } = await import('./mcp-tools/taskflow-api-notes.ts');
    const out = JSON.parse(
      (await apiTaskAddNoteTool.handler({ board_id: BOARD, task_id: taskId, sender_name: 'alice', text: 'revisar' })).content[0].text,
    );
    expect(out.success).toBe(true);

    const dispatched = (
      getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'system'").all() as Array<{ content: string }>
    )
      .map((r) => JSON.parse(r.content))
      .filter((c) => c.action === 'taskflow_dispatch_notifications')
      .flatMap((c) => c.events as Array<Record<string, unknown>>);
    expect(dispatched).toContainEqual(
      expect.objectContaining({ kind: 'direct_message', target_chat_jid: '120363400000000111@g.us' }),
    );
  });
});

describe('apiAddNote builds the parent-board notification for a delegated task (V1 parity)', () => {
  it('sets parent_notification when noting a child_exec delegated parent-board task', () => {
    // Mirrors the update(add_note) delegated-parent test: a note on a parent-board
    // task that this board executes must notify the parent board, same as V1.
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const now = new Date().toISOString();
    const parentBoardId = 'board-parent-note';
    db.exec(`ALTER TABLE boards ADD COLUMN parent_board_id TEXT`);
    db.exec(
      `INSERT INTO boards (id, short_code, name, board_role, group_folder, group_jid)
       VALUES ('${parentBoardId}', 'SECI', 'Parent', 'standard', 'seci-tf', 'parent@g.us');
       UPDATE boards SET parent_board_id = '${parentBoardId}' WHERE id = '${BOARD}';
       INSERT INTO board_people (board_id, person_id, name, role) VALUES ('${parentBoardId}', 'alice', 'alice', 'member');
       INSERT INTO tasks (id, board_id, type, title, assignee, column, child_exec_enabled, child_exec_board_id, child_exec_person_id, created_at, updated_at)
       VALUES ('P11.11', '${parentBoardId}', 'simple', 'Delegated', 'alice', 'waiting', 1, '${BOARD}', 'alice', '${now}', '${now}')`,
    );
    const engine = new TaskflowEngine(db, BOARD);
    const res = engine.apiAddNote({ board_id: BOARD, task_id: 'P11.11', sender_name: 'alice', text: 'nota cross-board' }) as {
      success: boolean;
      parent_notification?: { parent_group_jid?: string; message?: string };
    };
    expect(res.success).toBe(true);
    expect(res.parent_notification).toBeTruthy();
    expect(res.parent_notification!.parent_group_jid).toBe('parent@g.us');
    expect(res.parent_notification!.message).toContain('Atualização na sua tarefa');
  });
});

describe('deterministic note handler dispatches the notification (V1 parity)', () => {
  it('handleTaskflowProjectNoteUpdate dispatches the owner notification for a note on a project assigned to someone else', () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid)
       VALUES (?, 'bob', 'bob', 'member', '120363400000000111@g.us')`,
    ).run(BOARD);
    const engine = new TaskflowEngine(db, BOARD);
    const created = engine.create({ board_id: BOARD, type: 'project', title: 'Operacao Especial', sender_name: 'alice', assignee: 'bob' });
    expect(created.success).toBe(true);

    const handled = handleTaskflowProjectNoteUpdate(
      { text: 'Operacao Especial precisa de atencao' },
      [{ kind: 'chat', content: JSON.stringify({ sender: 'alice', text: 'Operacao Especial precisa de atencao' }) }],
      { inReplyTo: null, platformId: '120363400000000000@g.us', channelType: 'whatsapp', threadId: null },
    );
    expect(handled).toBe(true);

    const dispatched = (
      getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'system'").all() as Array<{ content: string }>
    )
      .map((r) => JSON.parse(r.content))
      .filter((c) => c.action === 'taskflow_dispatch_notifications')
      .flatMap((c) => c.events as Array<Record<string, unknown>>);
    expect(dispatched).toContainEqual(
      expect.objectContaining({ kind: 'direct_message', target_chat_jid: '120363400000000111@g.us' }),
    );
  });
});
