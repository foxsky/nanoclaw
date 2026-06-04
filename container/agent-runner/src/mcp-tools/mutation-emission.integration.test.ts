import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  closeSessionDb,
  closeTaskflowDb,
  getInboundDb,
  getOutboundDb,
  initTestSessionDb,
} from '../db/connection.ts';
import { flushPendingCreateCard } from './mutation-confirmation.ts';
import { __resetDedupForTesting } from './mutation-dedup.ts';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.ts';

// Phase-3 unit-2-core / Codex gate P5: session-DB-backed end-to-end
// integration asserting that a mutation tool writes EXACTLY ONE
// messages_out row with the byte-exact v1 card. Closes the coverage
// hole flagged by Codex (mutation-confirmation.test.ts only DI-tests
// the emitter; existing taskflow-api-mutate integration tests only
// log a caught SQLiteError because no session DB is mounted). Also
// regression-guards P4 dedup: if a future change ever causes the
// deterministic card AND the model's bare-text final reply to both
// land in messages_out, the `rows.length === 1` assertion catches it.

const BOARD = 'board-emit-int';
const ROUTING = { channel_type: 'whatsapp', platform_id: '120363400000000000@g.us', thread_id: null as string | null };

beforeEach(() => {
  __resetDedupForTesting();
  initTestSessionDb();
  // session_routing is host-written on container wake. Seed it here so
  // emitMutationConfirmation's routing guard passes. The table itself
  // is created by initTestSessionDb (2026-05-23, send_message same-conv
  // dedup follow-up needed it for the carve-out test too).
  getInboundDb()
    .prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)')
    .run(ROUTING.channel_type, ROUTING.platform_id, ROUTING.thread_id);
});

afterEach(() => {
  closeSessionDb();
  closeTaskflowDb();
});

describe('mutation emission integration (Codex gate P5 — exactly-one messages_out per mutation)', () => {
  // #389: mutations that produce engine notifications (reassign / move /
  // reparent via finalizeMutationResult) now ALSO emit a deterministic
  // notification dispatch row (kind:'system'). These tests guard the
  // user-visible CARD (no double-emit, correct deferral), so they count
  // `chat` rows specifically; notification dispatch has its own coverage
  // (taskflow-dispatch.test.ts + the api_reassign case below).
  const cardCount = () =>
    (
      getOutboundDb()
        .prepare("SELECT count(*) AS n FROM messages_out WHERE kind = 'chat'")
        .get() as { n: number }
    ).n;
  it('api_admin(reparent_task) emits EXACTLY ONE row with the byte-exact v1 "adicionada" card', async () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool, apiCreateSimpleTaskTool, apiAdminTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const proj = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD, type: 'project', title: 'Operação da SECTI', sender_name: 'alice', assignee: 'bob',
        })
      ).content[0].text,
    );
    const child = JSON.parse(
      (
        await apiCreateSimpleTaskTool.handler({
          board_id: BOARD, title: 'Treinamento E-governe', sender_name: 'alice',
        })
      ).content[0].text,
    );

    // Sanity: no CARD has been emitted pre-reparent — both creates defer
    // their cards (the project's assignee notification is a system row).
    expect(cardCount()).toBe(0);

    const result = JSON.parse(
      (
        await apiAdminTool.handler({
          board_id: BOARD, action: 'reparent_task', sender_name: 'alice',
          task_id: child.data.id, target_parent_id: proj.data.id,
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const cards = (
      getOutboundDb()
        .prepare('SELECT kind, platform_id, channel_type, thread_id, content FROM messages_out')
        .all() as Array<{ kind: string; platform_id: string | null; channel_type: string | null; thread_id: string | null; content: string }>
    ).filter((r) => r.kind === 'chat');
    expect(cards.length).toBe(1); // P5 + P4 dedup regression guard (one CARD)
    expect(cards[0]).toMatchObject({
      kind: 'chat',
      platform_id: ROUTING.platform_id,
      channel_type: ROUTING.channel_type,
      thread_id: null,
    });
    expect(JSON.parse(cards[0].content).text).toBe(
      `✅ *${child.data.id} adicionada*\n━━━━━━━━━━━━━━\n\n📁 *${proj.data.id}* — Operação da SECTI\n   📋 *${child.data.id}* — Treinamento E-governe`,
    );
  });

  it('a no-reparent create DEFERS its card, then flushPendingCreateCard emits EXACTLY ONE byte-exact row (Phase-3 #7)', async () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);

    const result = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD, type: 'simple', title: 'Treinamento E-governe', sender_name: 'alice', assignee: 'bob',
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    // Deferred: the create CARD is NOT emitted at api_create_task time —
    // an eager emit would double-emit on a following api_admin(reparent_task).
    // (The assignee notification IS dispatched now as a system row.)
    expect(cardCount()).toBe(0);

    // The poll-loop turn-boundary flush emits exactly ONE byte-exact
    // v1 "Tarefa criada" card.
    flushPendingCreateCard();
    const cards = (
      getOutboundDb().prepare('SELECT kind, content FROM messages_out').all() as Array<{ kind: string; content: string }>
    ).filter((r) => r.kind === 'chat');
    expect(cards.length).toBe(1);
    expect(cards[0].kind).toBe('chat');
    expect(JSON.parse(cards[0].content).text).toBe(
      `✅ *Tarefa criada*\n━━━━━━━━━━━━━━\n\n*${result.data.id}* — Treinamento E-governe\n👤 *Atribuída a:* bob\n⏭️ *Coluna:* Próximas Ações`,
    );

    // Read-and-clear: a second flush (the turn-boundary safety net) is a no-op.
    flushPendingCreateCard();
    expect(cardCount()).toBe(1);
  });

  it('api_task_add_note on a duplicate note emits EXACTLY ONE byte-exact "Nota já existente..." row deterministically', async () => {
    // Invariant: when the engine detects a duplicate note (success:true,
    // changes: ['Nota já existente: <text>'], changed:false), v2 emits a
    // v1-faithful card via emitMutationConfirmation — does NOT depend on
    // model echo (seci Turn 35: same tool path, baseline emitted, rerun
    // went silent for 360s. Codex follow-up to 90f2ddf7 dup-create-emit).
    setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const { apiTaskAddNoteTool } = await import('./taskflow-api-notes.ts');

    const created = JSON.parse(
      (
        await apiCreateSimpleTaskTool.handler({
          board_id: BOARD, title: 'Solicitar acesso', sender_name: 'alice',
        })
      ).content[0].text,
    );
    const taskId = created.data.id;

    const noteText = 'Verificar se a melhor opção é usar Tailscale ou AnyDesk';
    const first = JSON.parse(
      (
        await apiTaskAddNoteTool.handler({
          board_id: BOARD, task_id: taskId, sender_name: 'alice', text: noteText,
        })
      ).content[0].text,
    );
    expect(first.success).toBe(true);
    // First add emits the fresh "atualizada · Nota: ..." card.
    expect((getOutboundDb().prepare('SELECT count(*) AS n FROM messages_out').get() as { n: number }).n).toBe(1);

    // Second add of the SAME text → engine returns dedup signal. v2 must
    // emit a deterministic "Nota já existente" card so the user sees the
    // truth regardless of model echo.
    const second = JSON.parse(
      (
        await apiTaskAddNoteTool.handler({
          board_id: BOARD, task_id: taskId, sender_name: 'alice', text: noteText,
        })
      ).content[0].text,
    );
    expect(second.success).toBe(true);

    const rows = getOutboundDb()
      .prepare('SELECT kind, content FROM messages_out ORDER BY seq')
      .all() as Array<{ kind: string; content: string }>;
    expect(rows.length).toBe(2);
    expect(JSON.parse(rows[1].content).text).toBe(
      `Nota já existente na ${taskId} — "${noteText}" já estava registrada anteriormente. Nenhuma duplicata foi adicionada.`,
    );
  });

  it('api_create_task + api_delete_simple_task in the same turn → flush emits NOTHING (no orphan card)', async () => {
    // Invariant: when v2 creates and then immediately deletes a task (e.g.,
    // the cross-board forward flow: create locally → reparent failed → delete →
    // forward via send_message), the deferred "Tarefa criada" card MUST NOT
    // flush. Otherwise the user sees a confirmation for a task that no
    // longer exists. Mirrors how api_admin(reparent_task) already clears
    // the pending card to avoid double-emit.
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool, apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);

    const created = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD,
          type: 'simple',
          title: 'Forward this elsewhere',
          sender_name: 'alice',
          assignee: 'bob',
        })
      ).content[0].text,
    );
    expect(created.success).toBe(true);

    const deleted = JSON.parse(
      (
        await apiDeleteSimpleTaskTool.handler({
          board_id: BOARD,
          task_id: created.data.id,
          sender_name: 'alice',
          sender_is_service: true,
        })
      ).content[0].text,
    );
    expect(deleted.success).toBe(true);

    flushPendingCreateCard();
    expect((getOutboundDb().prepare('SELECT count(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);
  });

  it('api_task_add_note emits EXACTLY ONE row with the byte-exact v1 "atualizada • Nota: <text>" card', async () => {
    setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const { apiTaskAddNoteTool } = await import('./taskflow-api-notes.ts');
    const taskId = JSON.parse(
      (
        await apiCreateSimpleTaskTool.handler({
          board_id: BOARD, title: 'Solicitar acesso', sender_name: 'alice',
        })
      ).content[0].text,
    ).data.id;

    expect((getOutboundDb().prepare('SELECT count(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);

    const result = JSON.parse(
      (
        await apiTaskAddNoteTool.handler({
          board_id: BOARD, task_id: taskId, sender_name: 'alice', text: 'Demanda no chamado CAST 38876',
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const rows = getOutboundDb()
      .prepare('SELECT kind, content FROM messages_out')
      .all() as Array<{ kind: string; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('chat');
    expect(JSON.parse(rows[0].content).text).toBe(
      `✅ *${taskId}* atualizada\n━━━━━━━━━━━━━━\n\n• Nota: Demanda no chamado CAST 38876`,
    );
  });

  it('api_create_task on duplicate-detect emits EXACTLY ONE row with the byte-exact "Já existe..." formatted text', async () => {
    // Invariant: dup-detect emits the formatted prompt deterministically,
    // not via model echo. Mirrors the other emission tests in this file.
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);

    const first = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD,
          type: 'simple',
          title: 'SEMEC/MEI/Prestação de Contas',
          sender_name: 'alice',
          assignee: 'bob',
        })
      ).content[0].text,
    );
    expect(first.success).toBe(true);
    expect((getOutboundDb().prepare('SELECT count(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);

    const second = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD,
          type: 'simple',
          title: 'SEMEC/MEI/Prestação de Contas',
          sender_name: 'alice',
          assignee: 'bob',
        })
      ).content[0].text,
    );
    expect(second.success).toBe(true);
    expect(second.data.duplicate_candidate).toBe(true);

    const rows = getOutboundDb()
      .prepare('SELECT kind, platform_id, channel_type, content FROM messages_out')
      .all() as Array<{ kind: string; platform_id: string | null; channel_type: string | null; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      kind: 'chat',
      platform_id: ROUTING.platform_id,
      channel_type: ROUTING.channel_type,
    });
    const id = first.data.id;
    expect(JSON.parse(rows[0].content).text).toBe(
      `Já existe a **${id} — SEMEC/MEI/Prestação de Contas** atribuída ao bob (Próximas Ações). Parece ser o mesmo assunto.\n\nDeseja usar a ${id} existente ou criar uma tarefa separada mesmo assim?`,
    );
  });

  it('api_reassign emits EXACTLY ONE row with the v1-canonicalized "Reatribuída" card (P1 + P5 combined)', async () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'lucas', 'Lucas', 'member')`,
    ).run(BOARD);
    const taskId = JSON.parse(
      (
        await apiCreateSimpleTaskTool.handler({
          board_id: BOARD, title: 'Solicitar acesso', sender_name: 'alice',
        })
      ).content[0].text,
    ).data.id;

    expect((getOutboundDb().prepare('SELECT count(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);

    const result = JSON.parse(
      (
        await apiReassignTool.handler({
          board_id: BOARD, task_id: taskId, target_person: 'lucas', sender_name: 'alice', confirmed: true,
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const rows = getOutboundDb()
      .prepare('SELECT kind, content FROM messages_out ORDER BY seq')
      .all() as Array<{ kind: string; content: string }>;

    // P5: EXACTLY ONE confirmation CARD (no double-emit of the card).
    const chatRows = rows.filter((r) => r.kind === 'chat');
    expect(chatRows.length).toBe(1);
    expect(JSON.parse(chatRows[0].content).text).toBe(
      `✅ *${taskId}* — Solicitar acesso\n\nReatribuída para Lucas.`,
    );

    // #389: the reassign notification is also dispatched deterministically
    // as a single taskflow_dispatch_notifications system row (the host
    // delivers it — the agent does not relay). Lucas has no routing JID, so
    // the engine emits a deferred_notification (host-skipped until #396);
    // the cross-board WITH-jid case becomes a delivered direct_message.
    const systemRows = rows.filter((r) => r.kind === 'system');
    expect(systemRows.length).toBe(1);
    const dispatch = JSON.parse(systemRows[0].content);
    expect(dispatch.action).toBe('taskflow_dispatch_notifications');
    expect(Array.isArray(dispatch.events)).toBe(true);
    expect(dispatch.events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('#390 — api_admin register_person auto-provisions the child board (V1 parity)', () => {
  it('emits a provision_child_board system row for a delegating board, and returns success:true', async () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    applyBoardConfigColumns(db);
    // Make BOARD a non-leaf hierarchy board so canDelegateDown() is true and
    // the engine builds the auto_provision_request on register_person.
    db.prepare('UPDATE boards SET hierarchy_level = 0, max_depth = 2 WHERE id = ?').run(BOARD);
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');

    const res = JSON.parse(
      (
        await apiAdminTool.handler({
          board_id: BOARD,
          action: 'register_person',
          sender_name: 'alice',
          person_name: 'Katia',
          phone: '5585999990000',
          group_name: 'Divisão de Inovação',
          group_folder: 'div-inovacao',
        })
      ).content[0].text,
    );
    expect(res.success).toBe(true);

    const provision = (
      getOutboundDb().prepare('SELECT kind, content FROM messages_out').all() as Array<{ kind: string; content: string }>
    )
      .filter((r) => r.kind === 'system')
      .map((r) => JSON.parse(r.content))
      .find((c) => c.action === 'provision_child_board');
    // Pre-#390 nothing was emitted (api_admin only returned auto_provision_request
    // in JSON; the template said "no agent action needed") → silent boardless
    // registration.
    expect(provision).toBeDefined();
    expect(provision.person_name).toBe('Katia');
    expect(provision.group_folder).toBe('div-inovacao');
    expect(provision.person_phone).toBe('5585999990000');
  });
});
