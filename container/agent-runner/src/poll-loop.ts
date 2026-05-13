import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getInboundDb, getOutboundDb, getTaskflowDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import { appendToolEvents, type ToolEvent } from './providers/claude-tool-capture.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { TaskflowEngine } from './taskflow-engine.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function hasWakeTrigger(messages: Pick<MessageInRow, 'trigger'>[]): boolean {
  return messages.some((m) => m.trigger === 1);
}

export function taskflowPureGreetingReply(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): string | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const [msg] = messages;
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return null;
  const content = parseJsonContent(msg.content);
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!/^(oi|ol[aá]|bom dia|boa tarde|boa noite)[.!?\s]*$/i.test(text)) return null;

  const sender = typeof content.sender === 'string' ? content.sender.trim() : '';
  const firstName = sender.split(/\s+/)[0] || '';
  const greeting = firstName ? `Oi, ${firstName}!` : 'Oi!';
  return `${greeting} Aqui só cuido de gestão de tarefas. Use \`ajuda\` ou \`quadro\` para começar.`;
}

interface TaskflowReviewBypassPrompt {
  taskId: string;
  text: string;
}

interface TaskflowReviewBypassConfirmation {
  taskId: string;
}

interface TaskflowReviewBypassRepair {
  taskId: string;
}

interface TaskflowCrossBoardNotePrompt {
  taskId: string;
  noteText: string;
  destinationName: string;
  text: string;
}

interface TaskflowCrossBoardNoteConfirmation {
  taskId: string;
  noteText: string;
  destinationName: string;
}

const BARE_CONFIRMATION_RE = /^(sim|s|pode|confirmo|confirma|ok|perfeito)[.!?\s]*$/i;
const TASK_ID_RE = /\b((?:P|T|M|R)\d+(?:\.\d+)?)\b/i;

export function taskflowReviewBypassDiagnosticPrompt(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowReviewBypassPrompt | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const taskId = extractTaskId(message.text);
  if (!taskId || !taskId.includes('.')) return null;
  if (!/\b(porque|por que|pq)\b/i.test(message.text)) return null;
  if (!/\b(revis[aã]o|aprova[cç][aã]o)\b/i.test(message.text)) return null;
  if (!/\b(n[aã]o passou|passou|exigir|obrigat[oó]ria)\b/i.test(message.text)) return null;

  return {
    taskId,
    text: `${taskId} foi concluída sem passar pela revisão obrigatória. Deseja reabrir e exigir aprovação para ${taskId}?`,
  };
}

export function taskflowReviewBypassConfirmation(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentOutboundContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowReviewBypassConfirmation | null {
  if (!taskflowEnabled || !isSingleBareConfirmation(messages)) return null;
  for (const content of recentOutboundContents) {
    const text = outboundText(content);
    const match = text.match(/exigir aprova[cç][aã]o para ((?:P|T|M|R)\d+(?:\.\d+)?)/i);
    if (match?.[1]) return { taskId: match[1].toUpperCase() };
  }
  return null;
}

export function taskflowReviewBypassRepairPrompt(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowReviewBypassRepair | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (!/\btarefa\b/i.test(message.text)) return null;
  if (!/\bconclu[ií]d[ao]?\b/i.test(message.text)) return null;
  if (!/\bn[aã]o\b.*\brevis[aã]o\b/i.test(message.text)) return null;

  const taskId = extractTaskId(message.text) ?? latestTaskIdFromContents(recentContents);
  return taskId ? { taskId } : null;
}

export function taskflowCrossBoardNotePrompt(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentInboundContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowCrossBoardNotePrompt | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const current = parseSingleChat(messages[0]);
  if (!current) return null;
  const destMatch = current.text.match(/\bquadro da ([A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][\p{L}\p{M}' -]{1,40})/iu);
  if (!destMatch?.[1]) return null;
  const destinationName = cleanupDestinationName(destMatch[1]);
  if (!destinationName) return null;

  for (const content of recentInboundContents) {
    const previous = parseJsonContent(content);
    const text = typeof previous.text === 'string' ? previous.text.trim() : '';
    const note = text.match(/\b((?:P|T|M|R)\d+(?:\.\d+)?)\s+nota\s+(.+)/i);
    if (!note?.[1] || !note?.[2]) continue;
    const taskId = note[1].toUpperCase();
    const noteText = note[2].trim();
    return {
      taskId,
      noteText,
      destinationName,
      text: `Entendido. Posso encaminhar a nota "${noteText}" de ${taskId} para o quadro da ${destinationName}?`,
    };
  }

  return null;
}

export function taskflowCrossBoardNoteConfirmation(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentOutboundContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowCrossBoardNoteConfirmation | null {
  if (!taskflowEnabled || !isSingleBareConfirmation(messages)) return null;
  for (const content of recentOutboundContents) {
    const text = outboundText(content);
    const match = text.match(/encaminhar a nota ["“](.+?)["”](?:\s+de\s+((?:P|T|M|R)\d+(?:\.\d+)?))?\s+para o quadro da ([^?]+)\?/i);
    if (!match?.[1] || !match?.[3]) continue;
    const taskId = match[2]?.toUpperCase() ?? extractTaskId(text);
    if (!taskId) continue;
    return {
      taskId,
      noteText: match[1].trim(),
      destinationName: cleanupDestinationName(match[3]),
    };
  }
  return null;
}

function parseJsonContent(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return { text: content };
  }
}

function parseSingleChat(message: Pick<MessageInRow, 'kind' | 'content'>): { sender: string; text: string } | null {
  if (message.kind !== 'chat' && message.kind !== 'chat-sdk') return null;
  const content = parseJsonContent(message.content);
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!text) return null;
  const sender = typeof content.sender === 'string' ? content.sender.trim() : '';
  return { sender, text };
}

function extractTaskId(text: string): string | null {
  return text.match(TASK_ID_RE)?.[1]?.toUpperCase() ?? null;
}

function latestTaskIdFromContents(contents: string[]): string | null {
  for (const content of contents) {
    const taskId = extractTaskId(outboundText(content));
    if (taskId) return taskId;
    const parsed = parseJsonContent(content);
    if (typeof parsed.text === 'string') {
      const parsedId = extractTaskId(parsed.text);
      if (parsedId) return parsedId;
    }
  }
  return null;
}

function isSingleBareConfirmation(messages: Pick<MessageInRow, 'kind' | 'content'>[]): boolean {
  if (messages.length !== 1) return false;
  const message = parseSingleChat(messages[0]);
  return !!message && BARE_CONFIRMATION_RE.test(message.text);
}

function cleanupDestinationName(raw: string): string {
  return raw
    .replace(/\b(?:SEAF|SECTI|SEC|SECI|TASKFLOW|QUADRO)\b.*$/i, '')
    .replace(/[.?!]+$/g, '')
    .trim();
}

function outboundText(content: string): string {
  const parsed = parseJsonContent(content);
  return typeof parsed.text === 'string' ? parsed.text : content;
}

function recentOutboundContents(limit = 10): string[] {
  try {
    const rows = getOutboundDb().prepare(
      `SELECT content FROM messages_out
       WHERE kind IN ('chat', 'chat-sdk')
       ORDER BY COALESCE(seq, rowid) DESC
       LIMIT ?`,
    ).all(limit) as Array<{ content: string }>;
    return rows.map((row) => row.content);
  } catch (err) {
    log(`recentOutboundContents error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function recentInboundContents(limit = 10): string[] {
  try {
    const rows = getInboundDb().prepare(
      `SELECT content FROM messages_in
       WHERE kind IN ('chat', 'chat-sdk')
       ORDER BY COALESCE(seq, rowid) DESC
       LIMIT ?`,
    ).all(limit) as Array<{ content: string }>;
    return rows.map((row) => row.content);
  } catch (err) {
    log(`recentInboundContents error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function appendSyntheticToolCall(name: string, input: unknown, output: unknown, isError = false): void {
  const capturePath = process.env.NANOCLAW_TOOL_USES_PATH;
  if (!capturePath) return;
  const id = `det-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const events: ToolEvent[] = [
    { kind: 'tool_use', id, name, input },
    { kind: 'tool_result', id, output, is_error: isError },
  ];
  appendToolEvents(capturePath, events);
}

function senderName(messages: Pick<MessageInRow, 'kind' | 'content'>[]): string {
  const first = messages.map(parseSingleChat).find((msg): msg is { sender: string; text: string } => !!msg);
  return first?.sender || 'usuário';
}

function writeReply(routing: RoutingContext, text: string): void {
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

function handleTaskflowReviewBypassConfirmation(
  action: TaskflowReviewBypassConfirmation,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const moveInput = {
    task_id: action.taskId,
    action: 'reopen' as const,
    sender_name: sender,
    confirmed_task_id: action.taskId,
  };
  const moveResult = engine.move({ ...moveInput, board_id: boardId });
  appendSyntheticToolCall('api_move', moveInput, moveResult, !moveResult.success);
  if (!moveResult.success) {
    writeReply(routing, `Não consegui reabrir ${action.taskId}: ${moveResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const updateInput = {
    task_id: action.taskId,
    sender_name: sender,
    confirmed_task_id: action.taskId,
    updates: { requires_close_approval: true },
  };
  const updateResult = engine.update({ ...updateInput, board_id: boardId });
  appendSyntheticToolCall('api_update_task', updateInput, updateResult, !updateResult.success);
  if (!updateResult.success) {
    writeReply(routing, `Reabri ${action.taskId}, mas não consegui exigir aprovação: ${updateResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const title = typeof updateResult.title === 'string' ? ` — ${updateResult.title}` : '';
  writeReply(routing, `✅ *${action.taskId}*${title}\n\nReabri a tarefa e ativei a aprovação obrigatória.`);
  return true;
}

function handleTaskflowReviewBypassRepair(
  action: TaskflowReviewBypassRepair,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const task = engine.getTask(action.taskId) as { column?: string; requires_close_approval?: unknown; title?: string } | null;
  const approvalRequired =
    task?.requires_close_approval === 1 ||
    task?.requires_close_approval === '1' ||
    task?.requires_close_approval === true;

  if (!task || task.column !== 'done' || approvalRequired) return false;

  const queryInput = { query: 'task_details', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);

  const updateInput = {
    task_id: action.taskId,
    sender_name: sender,
    confirmed_task_id: action.taskId,
    updates: { requires_close_approval: true },
  };
  const updateResult = engine.update({ ...updateInput, board_id: boardId });
  appendSyntheticToolCall('api_update_task', updateInput, updateResult, !updateResult.success);
  if (!updateResult.success) {
    writeReply(routing, `Não consegui ativar a aprovação obrigatória para ${action.taskId}: ${updateResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const moveInput = {
    task_id: action.taskId,
    action: 'reopen' as const,
    sender_name: sender,
    confirmed_task_id: action.taskId,
  };
  const moveResult = engine.move({ ...moveInput, board_id: boardId });
  appendSyntheticToolCall('api_move', moveInput, moveResult, !moveResult.success);
  if (!moveResult.success) {
    writeReply(routing, `Ativei a aprovação obrigatória para ${action.taskId}, mas não consegui reabrir: ${moveResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const title = typeof task.title === 'string' ? ` — ${task.title}` : '';
  writeReply(
    routing,
    `✅ Pronto! Agora está correto:\n\n*${action.taskId}*${title}\n\n• Reaberta para Próximas Ações\n• Aprovação obrigatória: *ativada* ✅\n\nDa próxima vez que o responsável concluir, irá para revisão.`,
  );
  return true;
}

function handleTaskflowCrossBoardNoteConfirmation(
  action: TaskflowCrossBoardNoteConfirmation,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const dest = findByName(action.destinationName);
  if (!dest) return false;

  const sender = senderName(messages);
  const senderLabel = sender.split(/\s+/).filter(Boolean).at(-1) || sender;
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'find_task_in_organization', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);

  const rows = Array.isArray(queryResult.data) ? queryResult.data as Array<Record<string, unknown>> : [];
  const title = typeof rows[0]?.title === 'string' ? rows[0].title : action.taskId;
  const forwardText = `📝 Nota do ${senderLabel} para ${action.taskId} — ${title}:\n\n"${action.noteText}"`;

  sendToDestination(dest, forwardText, routing);
  appendSyntheticToolCall('send_message', { to: action.destinationName, text: forwardText }, { success: true });
  writeReply(routing, `Mensagem encaminhada para o quadro da ${action.destinationName}.`);
  return true;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!hasWakeTrigger(messages)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    const taskflowGreeting = taskflowPureGreetingReply(keep);
    if (taskflowGreeting) {
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: taskflowGreeting }),
      });
      markCompleted(keep.map((m) => m.id));
      log('Handled pure TaskFlow greeting without provider query');
      continue;
    }

    const recentOut = recentOutboundContents();
    const crossBoardNoteConfirmation = taskflowCrossBoardNoteConfirmation(keep, recentOut);
    if (crossBoardNoteConfirmation && handleTaskflowCrossBoardNoteConfirmation(crossBoardNoteConfirmation, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow cross-board note confirmation without provider query');
      continue;
    }

    const reviewBypassConfirmation = taskflowReviewBypassConfirmation(keep, recentOut);
    if (reviewBypassConfirmation && handleTaskflowReviewBypassConfirmation(reviewBypassConfirmation, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow review-bypass confirmation without provider query');
      continue;
    }

    const recentIn = recentInboundContents();
    const reviewBypassRepair = taskflowReviewBypassRepairPrompt(keep, [...recentOut, ...recentIn]);
    if (reviewBypassRepair && handleTaskflowReviewBypassRepair(reviewBypassRepair, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow review-bypass repair without provider query');
      continue;
    }

    const crossBoardNotePrompt = taskflowCrossBoardNotePrompt(keep, recentIn);
    if (crossBoardNotePrompt) {
      writeReply(routing, crossBoardNotePrompt.text);
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow cross-board note prompt without provider query');
      continue;
    }

    const reviewBypassPrompt = taskflowReviewBypassDiagnosticPrompt(keep);
    if (reviewBypassPrompt) {
      writeReply(routing, reviewBypassPrompt.text);
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow review-bypass diagnostic prompt without provider query');
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(query, routing, processingIds, config.providerName);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
    } finally {
      clearCurrentInReplyTo();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration via the
        // canonical command path + formatMessagesWithCommands.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;
        if (!hasWakeTrigger(newMessages)) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        query.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        if (event.text) {
          dispatchResultText(event.text, routing);
        }
      } else if (event.type === 'compacted') {
        // The SDK auto-compacted the conversation. After compaction the
        // model often drops the learned `<message to="…">` wrapping
        // discipline (the destinations are still in the system prompt,
        // but the behavioral pattern is summarized away). Inject a
        // reminder back into the live query so the next turn re-anchors
        // on the destination model. Only do this when there's >1
        // destination — single-destination groups have a fallback that
        // works without wrapping. See qwibitai/nanoclaw#2325.
        const destinations = getAllDestinations();
        if (destinations.length > 1) {
          const names = destinations.map((d) => d.name).join(', ');
          query.push(
            `[system] Context was just compacted. Reminder: you have ${destinations.length} destinations (${names}). ` +
              `Use <message to="name"> blocks to address them. Bare text goes to the scratchpad fallback only.`,
          );
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'compacted':
      log(`Compacted: ${event.text}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
