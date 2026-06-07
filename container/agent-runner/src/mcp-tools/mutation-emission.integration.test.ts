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

  // #397: helper — the dispatched notification events, if any.
  const dispatchedEvents = (): unknown[] | null => {
    const row = (
      getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'system'").all() as Array<{
        content: string;
      }>
    )
      .map((r) => JSON.parse(r.content))
      .find((c) => c.action === 'taskflow_dispatch_notifications');
    return row ? row.events : null;
  };

  it('#397: create with a RESOLVED-JID assignee dispatches a direct_message (parity with reassign), not a dropped deferred', async () => {
    // V1 fired create-assignee notifications synchronously (dispatchNotifications).
    // V2's create path force-mapped ALL assignee notifications to
    // deferred_notification and never dispatched — so creating a task for a
    // teammate whose board IS provisioned never notified them, while the
    // identical reassign delivered. WHY this matters: at cutover, a normal
    // "create task for Bob" must reach Bob exactly as a reassign would.
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid) VALUES (?, 'bob', 'bob', 'member', '120363400000000111@g.us')`,
    ).run(BOARD);

    const result = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD, type: 'simple', title: 'Treinamento E-governe', sender_name: 'alice', assignee: 'bob',
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const events = dispatchedEvents();
    expect(events).not.toBeNull();
    expect(events!.length).toBe(1);
    expect(events![0]).toMatchObject({ kind: 'direct_message', target_chat_jid: '120363400000000111@g.us' });
    expect((events![0] as { message: string }).message).toContain('Nova tarefa atribuída a você');
    // The JSON response still carries notification_events for the dashboard.
    expect(result.notification_events?.[0]).toMatchObject({ kind: 'direct_message' });
  });

  it('#397/#396 boundary: create with a NULL-JID assignee dispatches a deferred_notification (host-skipped until #396), not a direct_message', async () => {
    // The assignee is registered but their board is not yet provisioned
    // (no notification_group_jid). The event must normalize to a
    // deferred_notification (carrying target_person_id, no JID) — the host
    // skips it with reason '#396' rather than delivering. This pins the
    // boundary so the #396 work doesn't silently change create semantics.
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);

    const result = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD, type: 'simple', title: 'X', sender_name: 'alice', assignee: 'bob',
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const events = dispatchedEvents();
    expect(events).not.toBeNull();
    expect(events!.length).toBe(1);
    expect(events![0]).toMatchObject({ kind: 'deferred_notification', target_person_id: 'bob' });
    expect((events![0] as { target_chat_jid?: string }).target_chat_jid).toBeUndefined();
  });

  it('#396: create for a cross-board (registered, unprovisioned) assignee enqueues a pending_notification', async () => {
    // bob is a cross-board delegate (has a child board registration) whose board
    // is still provisioning → no notification_group_jid yet. The create defers his
    // notification AND persists it so unit 3 can deliver it once his board provisions.
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`).run(BOARD);
    db.prepare(`INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, 'bob', 'child-bob')`).run(BOARD);

    const result = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD, type: 'simple', title: 'Cross-board task', sender_name: 'alice', assignee: 'bob',
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const pending = db
      .query('SELECT target_person_id, task_id, message FROM pending_notifications')
      .all() as Array<{ target_person_id: string; task_id: string; message: string }>;
    expect(pending.length).toBe(1);
    expect(pending[0]).toMatchObject({ target_person_id: 'bob', task_id: result.data.id });
    expect(pending[0].message).toContain('Nova tarefa atribuída a você');
  });

  it('#396: reassign to a cross-board (registered, unprovisioned) person enqueues a pending_notification', async () => {
    // finalizeMutationResult resolves the board from NANOCLAW_TASKFLOW_BOARD_ID
    // (set in-session in production); set it here so the reassign enqueue fires.
    const savedEnv = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = BOARD;
    try {
      const db = setupEngineDb(BOARD, { withBoardAdmins: true });
      const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
      db.prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`).run(BOARD);
      db.prepare(`INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, 'bob', 'child-bob')`).run(BOARD);

      const taskId = JSON.parse(
        (await apiCreateSimpleTaskTool.handler({ board_id: BOARD, title: 'Solicitar acesso', sender_name: 'alice' })).content[0].text,
      ).data.id;
      const r = JSON.parse(
        (await apiReassignTool.handler({ board_id: BOARD, task_id: taskId, target_person: 'bob', sender_name: 'alice', confirmed: true })).content[0].text,
      );
      expect(r.success).toBe(true);

      const pending = db
        .query("SELECT target_person_id, task_id, message FROM pending_notifications WHERE target_person_id = 'bob'")
        .all() as Array<{ target_person_id: string; task_id: string; message: string }>;
      expect(pending.length).toBe(1);
      expect(pending[0].message).toContain('reatribuída para você');
      // #405: the reassign deferred now carries task_id (derived from
      // tasks_affected[0]), so liveness drops it if the task is later deleted.
      expect(pending[0].task_id).toBe(taskId);
    } finally {
      if (savedEnv === undefined) delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
      else process.env.NANOCLAW_TASKFLOW_BOARD_ID = savedEnv;
    }
  });

  it('#396: create for a SAME-GROUP (unregistered) assignee does NOT enqueue (avoid churn)', async () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`).run(BOARD); // no child-board registration
    const result = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD, type: 'simple', title: 'Same-group task', sender_name: 'alice', assignee: 'bob',
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);
    expect((db.query('SELECT count(*) AS n FROM pending_notifications').get() as { n: number }).n).toBe(0);
  });

  it('#397: create assigned to the SENDER themselves emits NO notification (no self-notify regression)', async () => {
    // resolveNotifTarget returns null when assignee === modifier on create
    // (no taskId), so no event is built and nothing is dispatched.
    setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool } = await import('./taskflow-api-mutate.ts');
    const result = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD, type: 'simple', title: 'Self task', sender_name: 'alice', assignee: 'alice',
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);
    expect(dispatchedEvents()).toBeNull();
    expect(result.notification_events?.length ?? 0).toBe(0);
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

  it('api_create_task + api_delete_simple_task in the same turn → flush emits NO orphan CARD', async () => {
    // Invariant: when v2 creates and then immediately deletes a task (e.g.,
    // the cross-board forward flow: create locally → reparent failed → delete →
    // forward via send_message), the deferred "Tarefa criada" CARD MUST NOT
    // flush. Otherwise the user sees a confirmation for a task that no
    // longer exists. Mirrors how api_admin(reparent_task) already clears
    // the pending card to avoid double-emit.
    // #397: the assignee NOTIFICATION is a separate channel — V1 fired it
    // synchronously at create time, so v2 dispatches it eagerly too. bob's
    // board is unprovisioned (no JID) → it is a host-skipped deferred_notification,
    // asserted explicitly below; it is NOT cleared on delete (a #396-era concern).
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
    const rows = getOutboundDb()
      .prepare('SELECT kind, content FROM messages_out')
      .all() as Array<{ kind: string; content: string }>;
    // The invariant: NO orphan "Tarefa criada" CARD (chat row) for the deleted task.
    expect(rows.filter((r) => r.kind === 'chat').length).toBe(0);
    // #397: the create eagerly dispatched bob's assignee notification. bob has
    // no JID → it is a host-skipped deferred_notification (no delivery), and it
    // is NOT cleared by the delete (a #396-era concern). Document it explicitly.
    const dispatched = rows
      .filter((r) => r.kind === 'system')
      .map((r) => JSON.parse(r.content))
      .filter((c) => c.action === 'taskflow_dispatch_notifications');
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].events[0]).toMatchObject({ kind: 'deferred_notification', target_person_id: 'bob' });
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
    // No CARD yet (the create card is deferred to turn-end). The first create
    // DID dispatch bob's assignee notification as a system row (#397, host-skipped
    // deferred since bob has no JID) — so assert on chat/card rows, not total.
    expect(cardCount()).toBe(0);

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

    const chatRows = (
      getOutboundDb()
        .prepare('SELECT kind, platform_id, channel_type, content FROM messages_out')
        .all() as Array<{ kind: string; platform_id: string | null; channel_type: string | null; content: string }>
    ).filter((r) => r.kind === 'chat');
    // EXACTLY ONE dup-detect CHAT prompt (the first create's assignee notification
    // is a separate system row, not counted here).
    expect(chatRows.length).toBe(1);
    expect(chatRows[0]).toMatchObject({
      kind: 'chat',
      platform_id: ROUTING.platform_id,
      channel_type: ROUTING.channel_type,
    });
    const id = first.data.id;
    expect(JSON.parse(chatRows[0].content).text).toBe(
      `Já existe a **${id} — SEMEC/MEI/Prestação de Contas** atribuída ao bob (Próximas Ações). Parece ser o mesmo assunto.\n\nDeseja usar a ${id} existente ou criar uma tarefa separada mesmo assim?`,
    );
  });

  it('api_reassign emits EXACTLY ONE row with the v1-canonicalized De/Para card (P1 + P5 combined)', async () => {
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
    // P1: the *Para:* line shows the canonical 'Lucas' (raw input was 'lucas').
    // The card is the De/Para form — alice created the task so it carried her as
    // the prior assignee — matching the poll-loop deterministic path.
    const chatRows = rows.filter((r) => r.kind === 'chat');
    expect(chatRows.length).toBe(1);
    expect(JSON.parse(chatRows[0].content).text).toBe(
      `✅ *${taskId}* reatribuída\n━━━━━━━━━━━━━━\n\n👤 *De:* alice\n👤 *Para:* Lucas`,
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
