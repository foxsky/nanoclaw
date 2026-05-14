import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, closeTaskflowDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { setupEngineDb } from './mcp-tools/taskflow-test-fixtures.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
  closeTaskflowDb();
  delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('asks which task for due-date commands that omit a task id', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    setupEngineDb('board-test');

    insertMessage(
      'm-due-date',
      { sender: 'Carlos Giovanni', text: 'prazo 22/04/26' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Para qual tarefa você quer definir o prazo de 22/04?');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].in_reply_to).toBe('m-due-date');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('falls back to org-scoped MCP lookup for bare cross-board task ids', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test', { withBoardAdmins: true });
    const now = new Date().toISOString();
    taskflow.exec(`ALTER TABLE boards ADD COLUMN parent_board_id TEXT`);
    taskflow.exec(`
      INSERT INTO boards (id, short_code, name, group_folder, group_jid, parent_board_id)
      VALUES ('board-root', 'ROOT', 'Root', 'root', 'root@g.us', NULL);
      INSERT INTO boards (id, short_code, name, group_folder, group_jid, parent_board_id)
      VALUES ('board-laizys', 'SEAF', '', 'laizys-taskflow', 'laizys@g.us', 'board-root');
      UPDATE boards SET parent_board_id = 'board-root' WHERE id = 'board-test';
    `);
    taskflow
      .prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES ('board-laizys', 'laizys', 'Laizys', 'member')`)
      .run();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES ('T43', 'board-laizys', 'simple', 'Cobrar ofício João Pessoa - Giovanni', 'laizys', 'next_action', 0, ?, ?)`,
      )
      .run(now, now);

    insertMessage(
      'm-cross-board-task',
      { sender: 'Carlos Giovanni', text: 't43' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('*T43*');
    expect(text).toContain('Cobrar ofício João Pessoa - Giovanni');
    expect(text).toContain('_Quadro: SEAF - laizys-taskflow_');
    expect(text).toContain('*Responsável:* Laizys');
    expect(text).not.toContain('Não encontrei');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('answers recently approved done task ids with the v1 no-tool confirmation shape', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test', { withBoardAdmins: true });
    const now = new Date().toISOString();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES ('P11.20', 'board-test', 'simple', 'Enviar documento', 'alice', 'done', 0, ?, ?)`,
      )
      .run(now, now);
    taskflow
      .prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, 'approve', 'alice', ?, ?)`)
      .run('board-test', 'P11.20', now, JSON.stringify({ from: 'review', to: 'done' }));

    insertMessage(
      'm-approved-done',
      { sender: 'Carlos Giovanni', text: 'p11.20' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('P11.20 foi aprovada há pouco e está ✅ Concluída. Posso ajudar em algo mais sobre ela?');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('uses prompt context date for meeting reschedule batches instead of runtime today', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test', { withBoardAdmins: true });
    const now = new Date().toISOString();
    taskflow
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role)
         VALUES ('board-test', 'ana-beatriz', 'Ana Beatriz', 'member')`,
      )
      .run();
    taskflow
      .prepare(
        `INSERT INTO board_people (board_id, person_id, name, role)
         VALUES ('board-test', 'giovanni', 'Carlos Giovanni', 'manager')`,
      )
      .run();
    taskflow
      .prepare(`INSERT INTO board_admins (board_id, person_id, admin_role) VALUES ('board-test', 'giovanni', 'manager')`)
      .run();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, participants, scheduled_at, requires_close_approval, created_at, updated_at)
         VALUES ('M1', 'board-test', 'meeting', 'Reunião de alinhamento', 'giovanni', 'next_action', '["ana-beatriz"]', '2026-04-14T14:00:00.000Z', 0, ?, ?)`,
      )
      .run(now, now);
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, participants, scheduled_at, requires_close_approval, created_at, updated_at)
         VALUES ('M2', 'board-test', 'meeting', 'Pesquisa TIC Governo 2025', 'giovanni', 'next_action', '["ana-beatriz"]', '2026-04-15T11:00:00.000Z', 0, ?, ?)`,
      )
      .run(now, now);
    const raw = '<context timezone="America/Fortaleza" today="2026-04-14" weekday="terça-feira" />';

    insertMessage(
      'm-batch-1',
      { sender: 'Carlos Giovanni', text: 'adicionar Ana Beatriz em M2', phase2RawPrompt: raw },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );
    insertMessage(
      'm-batch-2',
      { sender: 'Carlos Giovanni', text: 'alterar M1 para quinta-feira 11h', phase2RawPrompt: raw },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );
    insertMessage(
      'm-batch-3',
      { sender: 'Carlos Giovanni', text: 'm1', phase2RawPrompt: raw },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('16/04/2026 às 11:00');
    expect(text).not.toContain('17/04');
    expect(text).not.toContain('14/05');
    const m1 = taskflow.prepare(`SELECT scheduled_at FROM tasks WHERE board_id='board-test' AND id='M1'`).get() as { scheduled_at: string };
    expect(m1.scheduled_at).toBe('2026-04-16T14:00:00.000Z');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('forwards TaskFlow details to the named destination and confirms to origin', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test');
    const now = new Date().toISOString();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('ana-beatriz', 'Ana Beatriz', 'channel', 'discord', 'chan-ana', NULL)`,
      )
      .run();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, scheduled_at, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'meeting', ?, NULL, 'next_action', ?, 0, ?, ?)`,
      )
      .run('M1', 'board-test', 'Reunião de alinhamento entre ATI-Timon e SECTI', '2026-04-23T14:00:00.000Z', now, now);
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, scheduled_at, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'meeting', ?, NULL, 'next_action', ?, 0, ?, ?)`,
      )
      .run('M2', 'board-test', 'Pesquisa TIC Governo 2025', '2026-04-15T11:00:00.000Z', now, now);

    insertMessage(
      'm-forward',
      { sender: 'Carlos Giovanni', text: 'encaminhar os detalhes de M1 e M2 para Ana Beatriz' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const forwarded = out.find((message) => message.platform_id === 'chan-ana');
    const confirmation = out.find((message) => message.platform_id === 'chan-1');
    expect(forwarded).toBeDefined();
    expect(JSON.parse(forwarded!.content).text).toContain('M1');
    expect(JSON.parse(forwarded!.content).text).toContain('M2');
    expect(confirmation).toBeDefined();
    expect(JSON.parse(confirmation!.content).text).toContain('encaminhados para Ana Beatriz');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('forwards TaskFlow details from "send message with details" wording', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test');
    const now = new Date().toISOString();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('ana-beatriz', 'Ana Beatriz', 'channel', 'discord', 'chan-ana', NULL)`,
      )
      .run();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, scheduled_at, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'meeting', ?, NULL, 'next_action', ?, 0, ?, ?)`,
      )
      .run('M4', 'board-test', 'Reunião sobre CPSI na SEMAM', '2026-04-16T14:00:00.000Z', now, now);

    insertMessage(
      'm-send-details',
      { sender: 'Carlos Giovanni', text: 'enviar mensagem para a Ana Beatriz com os detalhes da M4' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const forwarded = out.find((message) => message.platform_id === 'chan-ana');
    const confirmation = out.find((message) => message.platform_id === 'chan-1');
    expect(JSON.parse(forwarded!.content).text).toContain('M4');
    expect(JSON.parse(forwarded!.content).text).toContain('Reunião sobre CPSI');
    expect(JSON.parse(confirmation!.content).text).toContain('encaminhados para Ana Beatriz');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('forwards TaskFlow details to a unique compound-name token destination', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test');
    const now = new Date().toISOString();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('ana-beatriz', 'Ana Beatriz', 'channel', 'discord', 'chan-ana', NULL)`,
      )
      .run();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, scheduled_at, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'meeting', ?, NULL, 'next_action', ?, 0, ?, ?)`,
      )
      .run('M4', 'board-test', 'Reunião sobre CPSI na SEMAM', '2026-04-16T14:00:00.000Z', now, now);

    insertMessage(
      'm-send-details-token',
      { sender: 'Carlos Giovanni', text: 'enviar mensagem para Beatriz com os detalhes da M4' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const forwarded = out.find((message) => message.platform_id === 'chan-ana');
    const confirmation = out.find((message) => message.platform_id === 'chan-1');
    expect(JSON.parse(forwarded!.content).text).toContain('M4');
    expect(JSON.parse(forwarded!.content).text).toContain('Reunião sobre CPSI');
    expect(JSON.parse(confirmation!.content).text).toContain('encaminhados para Beatriz');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('asks for clarification when a compound-name token matches multiple destinations', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test');
    const now = new Date().toISOString();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('ana-silva', 'Ana Silva', 'channel', 'discord', 'chan-ana', NULL)`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('mariana-silva', 'Mariana Silva', 'channel', 'discord', 'chan-mariana', NULL)`,
      )
      .run();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, scheduled_at, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'meeting', ?, NULL, 'next_action', ?, 0, ?, ?)`,
      )
      .run('M4', 'board-test', 'Reunião sobre CPSI na SEMAM', '2026-04-16T14:00:00.000Z', now, now);

    insertMessage(
      'm-send-details-ambiguous-token',
      { sender: 'Carlos Giovanni', text: 'enviar mensagem para Silva com os detalhes da M4' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 1, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('mais de um destino');
    expect(text).toContain('Ana Silva');
    expect(text).toContain('Mariana Silva');
    expect(out[0].platform_id).toBe('chan-1');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('sends task-priority notifications through named destinations without querying the provider', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test');
    const now = new Date().toISOString();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('Mauro Cesar', 'Mauro Cesar', 'channel', 'discord', 'chan-mauro', NULL)`,
      )
      .run();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'simple', ?, NULL, 'next_action', 0, ?, ?)`,
      )
      .run('P2.5', 'board-test', 'Elaborar convênio entre SECTI e INOVATHE', now, now);

    insertMessage(
      'm-priority',
      { sender: 'Carlos Giovanni', text: 'enviar mensagem para o Mauro priorizar a tarefa p2.5' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const forwarded = out.find((message) => message.platform_id === 'chan-mauro');
    const confirmation = out.find((message) => message.platform_id === 'chan-1');
    expect(JSON.parse(forwarded!.content).text).toContain('priorizar a tarefa *P2.5*');
    expect(JSON.parse(forwarded!.content).text).toContain('Elaborar convênio');
    expect(JSON.parse(confirmation!.content).text).toContain('encaminhada para Mauro');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('explains review-bypass diagnostics before asking for repair', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test');
    const now = new Date().toISOString();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'project', ?, NULL, 'next_action', 0, ?, ?)`,
      )
      .run('P6', 'board-test', 'Projeto HomeLab', now, now);
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'simple', ?, NULL, 'done', ?, 0, ?, ?)`,
      )
      .run('P6.7', 'board-test', 'Definir um Ponto de Instalação próximo ao Aeroporto', 'P6', now, now);
    taskflow
      .prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-test', 'P6.7', 'created', 'Mauro', now, JSON.stringify({ requires_close_approval: false }));
    taskflow
      .prepare(`INSERT INTO task_history (board_id, task_id, action, "by", "at", details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('board-test', 'P6.7', 'conclude', 'João', now, JSON.stringify({ from: 'next_action', to: 'done' }));

    insertMessage(
      'm-review-diagnostic',
      { sender: 'Mariany Borges', text: 'Porque as atividades do João P6.7 não passou pela revisão?' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('*P6.7*');
    expect(text).toContain('sem passar pela revisão');
    expect(text).toContain('requires_close_approval: false');
    expect(text).toContain('Deseja *reabrir*');
    expect(text).toContain('exigir aprovação para P6.7');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('asks for triage on standalone TaskFlow activity phrases without querying the provider', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    setupEngineDb('board-test');

    insertMessage(
      'm-standalone',
      { sender: 'Mariany Borges', text: 'Submeter ao menos 1 proposta a financiador externo' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('Submeter ao menos 1 proposta');
    expect(text).toContain('não está cadastrada');
    expect(text).toContain('Deseja');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].in_reply_to).toBe('m-standalone');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('answers TaskFlow person task-list requests without querying the provider', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test');
    const now = new Date().toISOString();
    taskflow
      .prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, ?, ?, 'member')`)
      .run('board-test', 'mariany', 'Mariany Borges');
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'simple', ?, ?, ?, 0, ?, ?)`,
      )
      .run('P22', 'board-test', 'Cidadão Beneficiário dos Programas Sociais', 'mariany', 'next_action', now, now);

    insertMessage(
      'm-person-tasks',
      { sender: 'Mariany Borges', text: 'atividades mariany' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('Mariany');
    expect(text).toContain('P22');
    expect(text).toContain('Cidadão Beneficiário');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].in_reply_to).toBe('m-person-tasks');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('bulk-approves a person review queue without querying the provider', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test', { withBoardAdmins: true });
    const now = new Date().toISOString();
    taskflow
      .prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, ?, ?, 'member')`)
      .run('board-test', 'mauro', 'Mauro Cesar');
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'simple', ?, ?, 'review', 1, ?, ?)`,
      )
      .run('P1.11', 'board-test', 'Priorizar BID Lab', 'mauro', now, now);
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'simple', ?, ?, 'review', 1, ?, ?)`,
      )
      .run('P1.12', 'board-test', 'Atualizar CIIAR', 'mauro', now, now);

    insertMessage(
      'm-bulk-approve',
      { sender: 'alice', text: 'aprovar todas as atividades de Mauro' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('2 de 2 tarefa(s) de Mauro aprovada(s)');
    expect(text).toContain('P1.11');
    expect(text).toContain('P1.12');
    const rows = taskflow
      .prepare(`SELECT id, column FROM tasks WHERE board_id='board-test' AND id IN ('P1.11', 'P1.12') ORDER BY id`)
      .all() as Array<{ id: string; column: string }>;
    expect(rows.map((row) => [row.id, row.column])).toEqual([['P1.11', 'done'], ['P1.12', 'done']]);
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('answers empty bulk approval queues without querying the provider', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test', { withBoardAdmins: true });
    taskflow
      .prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, ?, ?, 'member')`)
      .run('board-test', 'mauro', 'Mauro Cesar');

    insertMessage(
      'm-empty-bulk-approve',
      { sender: 'alice', text: 'aprovar todas as atividades de Mauro.' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Mauro não possui nenhuma tarefa em revisão no momento. Nada a aprovar.');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('answers bare TaskFlow task-id lookups without querying the provider', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test');
    const now = new Date().toISOString();
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'simple', ?, NULL, ?, 0, ?, ?)`,
      )
      .run('P15.7', 'board-test', 'Ampliar institucionalização da governança', 'next_action', now, now);

    insertMessage(
      'm-details',
      { sender: 'Carlos Giovanni', text: 'p15.7' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('*P15.7*');
    expect(text).toContain('Ampliar institucionalização da governança');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].in_reply_to).toBe('m-details');
    expect(provider.queryCalls).toBe(0);
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('handles explicit TaskFlow completion without querying the provider', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test';
    const taskflow = setupEngineDb('board-test', { withBoardAdmins: true });
    const now = new Date().toISOString();
    taskflow
      .prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, ?, ?, 'member')`)
      .run('board-test', 'mariany', 'Mariany Borges');
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('P20', 'board-test', 'project', 'Participação da SECTI na Feira do Empreendedor', 'mariany', 'next_action', 0, now, now);
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'simple', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('P20.2', 'board-test', 'Garantir participação institucional', 'mariany', 'next_action', 'P20', 0, now, now);
    taskflow
      .prepare(
        `INSERT INTO tasks (id, board_id, type, title, assignee, column, parent_task_id, requires_close_approval, created_at, updated_at)
         VALUES (?, ?, 'simple', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('P20.5', 'board-test', 'Organizar próximos encaminhamentos', 'mariany', 'next_action', 'P20', 0, now, now);

    insertMessage(
      'm-complete',
      { sender: 'Mariany Borges', text: 'concluir atividade P20.2' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new CountingProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('*P20.2*');
    expect(text).toContain('Concluída');
    expect(text).toContain('Próxima etapa do projeto: *P20.5*');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].in_reply_to).toBe('m-complete');
    expect(provider.queryCalls).toBe(0);

    const row = taskflow
      .prepare(`SELECT "column" FROM tasks WHERE board_id = ? AND id = ?`)
      .get('board-test', 'P20.2') as { column: string } | null;
    expect(row?.column).toBe('done');
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage('m-discord', { sender: 'Alice', text: 'from discord' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' });
    insertMessage('m-slack', { sender: 'Bob', text: 'from slack' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' });

    // Agent replies to both destinations
    const provider = new MockProvider({}, () =>
      '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('bare text routes to the sole configured destination as a safety fallback', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    // Agent responds with bare text — no <message to="..."> wrapping
    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait long enough for the poll loop to process
    await sleep(1000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('I am thinking about this...');
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('bare text remains scratchpad when multiple destinations are configured', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await sleep(1000);
    controller.abort();

    expect(getUndeliveredMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="nonexistent">dropped</message><message to="discord-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // Only the valid destination should produce output
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const discord = out.find((m) => m.platform_id === 'chan-1');
    const slack = out.find((m) => m.platform_id === 'chan-2');
    expect(discord).toBeDefined();
    expect(JSON.parse(discord!.content).text).toBe('for discord');
    expect(slack).toBeDefined();
    expect(JSON.parse(slack!.content).text).toBe('for slack');

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-new', 'Slack New', 'channel', 'slack', 'chan-new', NULL)`,
      )
      .run();

    // Only insert a message from discord — slack-new has never sent anything
    insertMessage('m1', { sender: 'Alice', text: 'tell slack' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' });

    const provider = new MockProvider({}, () => '<message to="slack-new">hello slack</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-new');
    expect(out[0].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage('m-old', { sender: 'Alice', text: 'old' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old' });
    insertMessage('m-new', { sender: 'Alice', text: 'new' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new' });

    const provider = new MockProvider({}, () => '<message to="discord-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('thread-new');
    expect(out[0].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<internal>thinking about this...</internal><message to="discord-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('handles mixed task + chat batch with correct origin metadata', async () => {
    // Seed destination for routing lookup
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'discord' });
    // Task with same routing — simulates a scheduled task in a channel session
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('t-task', 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'daily check' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('should inject destination reminder after a compacted event', async () => {
    // Two destinations — required for the reminder to fire (single-destination
    // groups have a fallback path that works without <message to="…"> wrapping).
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('discord-second', 'Discord Second', 'channel', 'discord', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'First message' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new CompactingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2500);

    await waitFor(() => getUndeliveredMessages().length > 0, 2500);
    controller.abort();

    expect(provider.pushes.length).toBeGreaterThanOrEqual(1);
    const reminder = provider.pushes.find((p) => p.includes('Context was just compacted'));
    expect(reminder).toBeDefined();
    expect(reminder).toContain('2 destinations');
    expect(reminder).toContain('discord-test');
    expect(reminder).toContain('discord-second');
    expect(reminder).toContain('<message to="name">');

    await loopPromise.catch(() => {});
  });

  it('should NOT inject destination reminder with a single destination', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'First message' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new CompactingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2500);

    await waitFor(() => getUndeliveredMessages().length > 0, 2500);
    controller.abort();

    // Only the original prompt push (if any) — no reminder, since beforeEach
    // seeds exactly one destination.
    const reminders = provider.pushes.filter((p) => p.includes('Context was just compacted'));
    expect(reminders).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that emits a single compacted event mid-stream, then returns a
 * result. Captures every push() call so tests can assert on the injected
 * reminder content.
 */
class CompactingProvider {
  readonly supportsNativeSlashCommands = false;
  readonly pushes: string[] = [];

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const pushes = this.pushes;
    let ended = false;
    let aborted = false;
    let resolveWaiter: (() => void) | null = null;

    async function* events() {
      yield { type: 'activity' as const };
      yield { type: 'init' as const, continuation: 'compaction-test-session' };
      yield { type: 'activity' as const };
      yield { type: 'compacted' as const, text: 'Context compacted (50,000 tokens compacted).' };

      // Wait for poll-loop to push the reminder (or end / abort)
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
        // Belt-and-braces: don't hang forever if the reminder never arrives
        setTimeout(resolve, 200);
      });

      yield { type: 'activity' as const };
      yield { type: 'result' as const, text: '<message to="discord-test">ack</message>' };
      while (!ended && !aborted) {
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
          setTimeout(resolve, 50);
        });
      }
    }

    return {
      push(message: string) {
        pushes.push(message);
        resolveWaiter?.();
      },
      end() {
        ended = true;
        resolveWaiter?.();
      },
      abort() {
        aborted = true;
        resolveWaiter?.();
      },
      events: events(),
    };
  }
}

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CountingProvider extends MockProvider {
  queryCalls = 0;

  query(input: Parameters<MockProvider['query']>[0]) {
    this.queryCalls++;
    return super.query(input);
  }
}

describe('poll loop — provider error recovery', () => {
  it('writes error to outbound and continues loop on provider throw', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'trigger error' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ThrowingProvider('API rate limit exceeded');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');
    expect(JSON.parse(out[0].content).text).toContain('API rate limit exceeded');

    // Input message should be marked completed despite the error
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — stale session recovery', () => {
  it('clears continuation when provider reports session invalid', async () => {
    // Pre-seed a continuation so the local variable in runPollLoop is set.
    // Without this, the `if (continuation && isSessionInvalid)` check skips.
    setContinuation('mock', 'pre-existing-session');

    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // Error was written to outbound
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');

    // Continuation was cleared (isSessionInvalid returned true)
    expect(getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /clear command', () => {
  it('clears session, writes confirmation, skips query', async () => {
    // Seed a continuation so we can verify it gets cleared
    setContinuation('mock', 'existing-session-id');
    expect(getContinuation('mock')).toBe('existing-session-id');

    // Insert a /clear command
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-clear', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/clear' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Session cleared.');

    // Continuation was cleared
    expect(getContinuation('mock')).toBeUndefined();

    // Command message was completed
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that throws on every query, simulating API failures.
 */
class ThrowingProvider {
  readonly supportsNativeSlashCommands = false;
  private errorMessage: string;

  constructor(errorMessage: string) {
    this.errorMessage = errorMessage;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const errorMessage = this.errorMessage;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        throw new Error(errorMessage);
      })(),
    };
  }
}

/**
 * Provider that throws with an error that triggers isSessionInvalid.
 * First emits an init event (setting continuation), then throws.
 */
class InvalidSessionProvider {
  readonly supportsNativeSlashCommands = false;

  isSessionInvalid(): boolean {
    return true;
  }

  query(_input: { prompt: string; cwd: string }) {
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'doomed-session' };
        throw new Error('session not found');
      })(),
    };
  }
}
