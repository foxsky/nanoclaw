import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, closeTaskflowDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { MockProvider } from './providers/mock.js';
import {
  hasWakeTrigger,
  taskflowBareTaskDetailsCommand,
  taskflowCrossBoardNoteConfirmation,
  taskflowCrossBoardNotePrompt,
  taskflowDueDateNeedsTaskPrompt,
  taskflowExplicitCompletionCommand,
  taskflowForwardDetailsCommand,
  taskflowMeetingBatchUpdateCommand,
  taskflowPersonTasksCommand,
  taskflowPureGreetingReply,
  taskflowReviewBypassConfirmation,
  taskflowReviewBypassDiagnosticPrompt,
  taskflowReviewBypassRepairPrompt,
  taskflowStandaloneActivityPrompt,
} from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  closeTaskflowDb();
  delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(hasWakeTrigger(messages)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(hasWakeTrigger(messages)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('active-query follow-up gate also rejects trigger=0-only batches', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'background chatter' }, { trigger: 0 });
    const followUps = getPendingMessages().filter((m) => m.kind !== 'system');
    expect(followUps).toHaveLength(1);
    expect(hasWakeTrigger(followUps)).toBe(false);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('TaskFlow pure greeting guard', () => {
  it('returns a v1-style scope reply for pure greetings on TaskFlow boards', () => {
    const reply = taskflowPureGreetingReply(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'oi' }) }],
      true,
    );

    expect(reply).toBe('Oi, Carlos! Aqui só cuido de gestão de tarefas. Use `ajuda` ou `quadro` para começar.');
  });

  it('does not intercept non-greeting TaskFlow messages', () => {
    const reply = taskflowPureGreetingReply(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'oi, quadro' }) }],
      true,
    );

    expect(reply).toBeNull();
  });

  it('does not intercept greetings outside TaskFlow boards', () => {
    const reply = taskflowPureGreetingReply(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'oi' }) }],
      false,
    );

    expect(reply).toBeNull();
  });
});

describe('TaskFlow deterministic confirmation guards', () => {
  it('detects due-date commands that omit the task id', () => {
    expect(taskflowDueDateNeedsTaskPrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'prazo 22/04/26' }) }],
      true,
    )).toEqual({ dateText: '22/04' });

    expect(taskflowDueDateNeedsTaskPrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'vencimento para 22/04' }) }],
      true,
    )).toEqual({ dateText: '22/04' });
  });

  it('does not ask which task when due-date commands already include a task id', () => {
    expect(taskflowDueDateNeedsTaskPrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'P11.23 prazo 22/04/26' }) }],
      true,
    )).toBeNull();
  });

  it('detects meeting participant plus reschedule batches using prompt context date', () => {
    const raw = '<context timezone="America/Fortaleza" today="2026-04-14" weekday="terça-feira" />';
    expect(taskflowMeetingBatchUpdateCommand([
      { kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'adicionar Ana Beatriz em M2', phase2RawPrompt: raw }) },
      { kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'alterar M1 para quinta-feira 11h', phase2RawPrompt: raw }) },
      { kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'm1', phase2RawPrompt: raw }) },
    ], true)).toEqual({
      participantTaskId: 'M2',
      participantName: 'Ana Beatriz',
      meetingTaskId: 'M1',
      weekdayName: 'quinta',
      hour: 11,
      contextDate: '2026-04-14',
    });
  });

  it('detects meeting batches stored only in the raw phase prompt', () => {
    const raw = '<context timezone="America/Fortaleza" today="2026-04-14" weekday="terça-feira" />\n<messages>\n<message sender="Carlos Giovanni">adicionar Ana Beatriz em M2</message>\n<message sender="Carlos Giovanni">alterar M1 para quinta-feira 11h</message>\n<message sender="Carlos Giovanni">m1</message>\n</messages>';
    expect(taskflowMeetingBatchUpdateCommand([
      { kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'adicionar Ana Beatriz em M2', phase2RawPrompt: raw }) },
    ], true)).toMatchObject({
      participantTaskId: 'M2',
      meetingTaskId: 'M1',
      contextDate: '2026-04-14',
    });
  });

  it('detects forwarding details to a named destination', () => {
    expect(taskflowForwardDetailsCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'encaminhar os detalhes de M1 e M2 para Ana Beatriz' }) }],
      true,
    )).toEqual({ taskIds: ['M1', 'M2'], destinationName: 'Ana Beatriz' });
  });

  it('detects standalone activity phrases that v1 asked to triage', () => {
    expect(taskflowStandaloneActivityPrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'Submeter ao menos 1 proposta a financiador externo' }) }],
      true,
    )).toEqual({ text: 'Submeter ao menos 1 proposta a financiador externo' });

    expect(taskflowStandaloneActivityPrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'Aguardar e Acompanhar licitação para reforma do prédio pela SDU Leste' }) }],
      true,
    )).toEqual({ text: 'Aguardar e Acompanhar licitação para reforma do prédio pela SDU Leste' });
  });

  it('does not treat actionable task commands as standalone activity prompts', () => {
    expect(taskflowStandaloneActivityPrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'adicionar Ana Beatriz em M2' }) }],
      true,
    )).toBeNull();
  });

  it('detects person task-list requests', () => {
    expect(taskflowPersonTasksCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'atividades mariany' }) }],
      true,
    )).toEqual({ personName: 'mariany' });

    expect(taskflowPersonTasksCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'tarefas da Mariany Borges' }) }],
      true,
    )).toEqual({ personName: 'Mariany Borges' });
  });

  it('does not treat diagnostic task-id questions as person task-list requests', () => {
    expect(taskflowPersonTasksCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'Porque as atividades do João P6.7 não passou pela revisão?' }) }],
      true,
    )).toBeNull();
  });

  it('detects bare task detail requests with a task id', () => {
    expect(taskflowBareTaskDetailsCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'p15.7' }) }],
      true,
    )).toEqual({ taskId: 'P15.7' });

    expect(taskflowBareTaskDetailsCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'p11' }) }],
      true,
    )).toEqual({ taskId: 'P11' });
  });

  it('does not treat task-id commands with other words as bare details requests', () => {
    expect(taskflowBareTaskDetailsCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'concluir P15.7' }) }],
      true,
    )).toBeNull();
  });

  it('detects exact completion commands with a task id', () => {
    expect(taskflowExplicitCompletionCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'concluir atividade P20.2' }) }],
      true,
    )).toEqual({ taskId: 'P20.2' });

    expect(taskflowExplicitCompletionCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'p11.16 concluída' }) }],
      true,
    )).toEqual({ taskId: 'P11.16' });
  });

  it('does not treat diagnostic review questions as completion commands', () => {
    expect(taskflowExplicitCompletionCommand(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'P6.7 foi concluída não foi para revisão?' }) }],
      true,
    )).toBeNull();
  });

  it('detects review-bypass diagnostic questions scoped to the subtask id', () => {
    const prompt = taskflowReviewBypassDiagnosticPrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'Porque as atividades do João P6.7 não passou pela revisão?' }) }],
      true,
    );

    expect(prompt).toEqual({ taskId: 'P6.7' });
  });

  it('resolves bare confirmation to the exact review-bypass task id from recent outbound', () => {
    const action = taskflowReviewBypassConfirmation(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'Sim' }) }],
      [JSON.stringify({ text: 'P6.7 foi concluída sem passar pela revisão obrigatória. Deseja reabrir e exigir aprovação para P6.7?' })],
      true,
    );

    expect(action).toEqual({ taskId: 'P6.7' });
  });

  it('resolves review-bypass repair prompts to the latest exact task id from context', () => {
    const action = taskflowReviewBypassRepairPrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Mariany Borges', text: 'A tarefa foi concluida não foi para revisão?' }) }],
      [JSON.stringify({ text: '✅ *P6.7* reaberta e aprovação obrigatória ativada' })],
      true,
    );

    expect(action).toEqual({ taskId: 'P6.7' });
  });

  it('asks for cross-board note forwarding using the prior note command and destination clarification', () => {
    const prompt = taskflowCrossBoardNotePrompt(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'esta tarefa é do quadro da Laizys SEAF-SECTI' }) }],
      [JSON.stringify({ sender: 'Carlos Giovanni', text: 't43 nota Recebi a tarefa no meu quadro' })],
      true,
    );

    expect(prompt).toEqual({
      taskId: 'T43',
      noteText: 'Recebi a tarefa no meu quadro',
      destinationName: 'Laizys',
      text: 'Entendido. Posso encaminhar a nota "Recebi a tarefa no meu quadro" de T43 para o quadro da Laizys?',
    });
  });

  it('resolves bare confirmation to the pending cross-board note forward', () => {
    const action = taskflowCrossBoardNoteConfirmation(
      [{ kind: 'chat', content: JSON.stringify({ sender: 'Carlos Giovanni', text: 'sim' }) }],
      [JSON.stringify({ text: 'Entendido. Posso encaminhar a nota "Recebi a tarefa no meu quadro" de T43 para o quadro da Laizys?' })],
      true,
    );

    expect(action).toEqual({
      taskId: 'T43',
      noteText: 'Recebi a tarefa no meu quadro',
      destinationName: 'Laizys',
    });
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});
