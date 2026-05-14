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

interface TaskflowExplicitCompletion {
  taskId: string;
}

interface TaskflowTaskDetails {
  taskId: string;
}

interface TaskflowPersonTasks {
  personName: string;
}

interface TaskflowPersonReview {
  personName: string;
}

interface TaskflowBulkApproval {
  personName: string;
}

interface TaskflowStandaloneActivity {
  text: string;
  contextHints: string[];
}

interface TaskflowForwardDetails {
  taskIds: string[];
  destinationName: string;
}

interface TaskflowNotifyTaskPriority {
  taskId: string;
  destinationName: string;
}

interface TaskflowCreateMeeting {
  title: string;
  scheduledAt: string;
  intendedWeekday?: string;
  parentProjectTitle?: string;
}

interface TaskflowAddParticipantsToLatestMeeting {
  taskId: string;
  participantNames: string[];
}

interface TaskflowNotifyMeetingAbove {
  taskId: string;
  recipientNames?: string[];
  useParticipants: boolean;
}

interface TaskflowAutoForwardMeetingConfirmation {
  taskId: string;
  destinationName: string;
}

interface TaskflowDueDateNeedsTask {
  dateText: string;
}

interface TaskflowMeetingBatchUpdate {
  participantTaskId: string;
  participantName: string;
  meetingTaskId: string;
  weekdayName: string;
  hour: number;
  contextDate: string;
}

interface TaskflowOrgTaskLookupRow {
  task_id?: unknown;
  board_id?: unknown;
  title?: unknown;
  column?: unknown;
  assignee?: unknown;
  assignee_name?: unknown;
  due_date?: unknown;
  board_group_folder?: unknown;
  board_short_code?: unknown;
  board_name?: unknown;
}

const BARE_CONFIRMATION_RE = /^(sim|s|pode|confirmo|confirma|ok|perfeito)[.!?\s]*$/i;
const TASK_ID_RE = /\b((?:P|T|M|R)\d+(?:\.\d+)?)\b/i;
const TASK_ID_RE_GLOBAL = /\b((?:P|T|M|R)\d+(?:\.\d+)?)\b/gi;
const BARE_TASK_ID_RE = /^\s*((?:P|T|M|R)\d+(?:\.\d+)?)\s*[.!]?\s*$/i;
const COMPLETE_VERB_RE = /\b(concluir|conclu[ií]d[ao]?|finalizar|finalizad[ao]?)\b/i;
const PERSON_TASKS_RE = /^\s*(?:atividades|tarefas)\s+(?:de\s+|do\s+|da\s+)?([\p{L}\p{M}' -]{2,60})\s*[.!]?\s*$/iu;
const PERSON_REVIEW_RE = /^\s*(?:alguma\s+)?(?:atividade|atividades|tarefa|tarefas)\s+(?:de\s+|do\s+|da\s+)?([\p{L}\p{M}' -]{2,60})\s+para\s+revis[aã]o\s*[?!.]?\s*$/iu;
const BULK_APPROVAL_RE = /^\s*aprovar\s+(?:todas\s+as\s+)?(?:atividades|tarefas)\s+(?:de\s+|do\s+|da\s+)?([\p{L}\p{M}' -]{2,60})\s*[.!]?\s*$/iu;
const STANDALONE_ACTIVITY_RE = /^\s*(?:Aguardar(?:\s+e\s+Acompanhar)?|Submeter|Realizar)\b.+/iu;
const FORWARD_DETAILS_RE = /\bencaminhar\b.*\bdetalhes\b.*\bpara\s+([\p{L}\p{M}' -]{2,60})\s*$/iu;
const SEND_DETAILS_TO_PERSON_RE = /\b(?:enviar|mandar)\s+mensagem\s+para\s+(?:o\s+|a\s+)?([\p{L}\p{M}' -]{2,60}?)\s+com\s+(?:os\s+)?detalhes\s+d[aeo]\s+((?:P|T|M|R)\d+(?:\.\d+)?)\b/iu;
const NOTIFY_TASK_PRIORITY_RE = /\b(?:enviar|mandar)\s+mensagem\s+para\s+(?:o\s+|a\s+)?([\p{L}\p{M}' -]{2,60}?)\s+.*\bpriorizar\b.*\b(?:tarefa|atividade)\s+((?:P|T|M|R)\d+(?:\.\d+)?)\b/iu;
const DUE_DATE_WITHOUT_TASK_RE = /^\s*(?:prazo|vencimento|data limite)\s+(?:para\s+)?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*[.!]?\s*$/iu;
const ADD_PARTICIPANT_RE = /\badicionar\s+([\p{L}\p{M}' -]{2,60})\s+em\s+(M\d+)\b/iu;
const ADD_PARTICIPANTS_ONLY_RE = /^\s*adicionar\s+([\p{L}\p{M}', -]+?)\s*[.!]?\s*$/iu;
const CREATE_MEETING_DATE_RE = /^\s*(?:agendar|marcar)\s+(.+?)\s+no\s+dia\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(?:às|as)\s+(\d{1,2})(?:(?:h|:)(\d{2})?)?\s*[.!]?\s*$/iu;
const CREATE_PROJECT_MEETING_WEEKDAY_RE = /^\s*adicionar\s+uma\s+tarefa\s+no\s+projeto\s+d[ao]\s+(.+?):\s*(.+?)\s+para\s+(segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?\s+(?:às|as)\s+(\d{1,2})(?:(?:h|:)(\d{2})?)?\s*[.!]?\s*$/iu;
const NOTIFY_MEETING_ABOVE_RE = /^\s*avisar\s+(?:o\s+|a\s+|os\s+|as\s+)?([\p{L}\p{M}', -]+?)\s+sobre\s+a\s+reuni[aã]o\s+acima\s*[.!]?\s*$/iu;
const NOTIFY_MEETING_PARTICIPANTS_RE = /^\s*(?:enviar|mandar)\s+mensagem\s+para\s+eles\s+avisando\s+da\s+reuni[aã]o\s*[.!]?\s*$/iu;
const AUTO_FORWARD_MEETINGS_CONFIRMATION_RE = /^\s*sim\s+e\s+todas\s+as\s+novas\s+reuni[oõ]es\s*[.!]?\s*$/iu;
const RESCHEDULE_MEETING_RE = /\balterar\s+(M\d+)\s+para\s+(segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?\s+(\d{1,2})(?:h|:\d{2})?\b/iu;
const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  terça: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
  sábado: 6,
};

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

  return { taskId };
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

export function taskflowExplicitCompletionCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowExplicitCompletion | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (/[?？]/.test(message.text)) return null;
  if (/\bn[aã]o\b/i.test(message.text)) return null;
  if (!COMPLETE_VERB_RE.test(message.text)) return null;
  const taskId = extractTaskId(message.text);
  return taskId ? { taskId } : null;
}

export function taskflowBareTaskDetailsCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowTaskDetails | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(BARE_TASK_ID_RE);
  return match?.[1] ? { taskId: match[1].toUpperCase() } : null;
}

export function taskflowPersonTasksCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowPersonTasks | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (/[?？]/.test(message.text)) return null;
  if (extractTaskId(message.text)) return null;
  const match = message.text.match(PERSON_TASKS_RE);
  const personName = match?.[1]?.trim();
  return personName ? { personName } : null;
}

export function taskflowPersonReviewCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowPersonReview | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (extractTaskId(message.text)) return null;
  const match = message.text.match(PERSON_REVIEW_RE);
  const personName = match?.[1]?.trim();
  return personName ? { personName } : null;
}

export function taskflowBulkApprovalCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowBulkApproval | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (extractTaskId(message.text)) return null;
  const match = message.text.match(BULK_APPROVAL_RE);
  const personName = match?.[1]?.trim();
  return personName ? { personName } : null;
}

export function taskflowStandaloneActivityPrompt(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowStandaloneActivity | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (/[?？]/.test(message.text)) return null;
  if (extractTaskId(message.text)) return null;
  if (!STANDALONE_ACTIVITY_RE.test(message.text)) return null;
  return { text: message.text, contextHints: taskflowStandaloneActivityContextHints(message.text, messages) };
}

export function taskflowStandaloneActivityContextHints(
  activityText: string,
  messages: Pick<MessageInRow, 'content'>[],
): string[] {
  const rawPrompts = messages
    .map((message) => parseJsonContent(message.content).phase2RawPrompt)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (rawPrompts.length === 0) return [];

  const activityTokens = normalizedTokenSet(activityText);
  const financingContext = /\b(financiador|financiamento|proposta|capt[aç][aã]o|recurso externo|externo)\b/iu.test(activityText);
  const innovationContext = /\binova\b/iu.test(activityText);
  const extraTokens = new Set<string>();
  if (financingContext) {
    for (const token of ['captacao', 'recursos', 'habilitacao', 'ctinova']) extraTokens.add(token);
  }

  const scores = new Map<string, { displayIds: string[]; score: number; order: number }>();
  let order = 0;
  for (const rawPrompt of rawPrompts) {
    for (const candidate of extractRawPromptTaskCandidates(rawPrompt)) {
      const projectId = candidate.id.includes('.') ? candidate.id.split('.')[0] : candidate.id;
      if (!projectId.startsWith('P')) continue;
      const titleTokens = normalizedTokenSet(candidate.title);
      let score = 0;
      for (const token of activityTokens) {
        if (contextHintTokenMatches(token, titleTokens)) score += 2;
      }
      for (const token of extraTokens) {
        if (titleTokens.has(token)) score += 1;
      }
      if (financingContext && (projectId === 'P17' || projectId === 'P12')) score += 3;
      if (innovationContext && projectId === 'P13') score += 3;
      if (score <= 0) continue;

      const displayIds = candidate.id.includes('.') && financingContext && projectId === 'P17'
        ? [projectId, candidate.id]
        : [projectId];
      const key = displayIds.join('/');
      const previous = scores.get(key);
      if (!previous || score > previous.score) scores.set(key, { displayIds, score, order });
      order += 1;
    }
  }

  const ranked = [...scores.values()].sort((a, b) => b.score - a.score || a.order - b.order);
  const maxScore = ranked[0]?.score ?? 0;
  const threshold = Math.max(3, maxScore - 3);
  return ranked
    .filter((hint) => hint.score >= threshold)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 3)
    .map((hint) => hint.displayIds.map((id) => `*${id}*`).join(' / '));
}

export function taskflowForwardDetailsCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowForwardDetails | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const sendDetails = message.text.match(SEND_DETAILS_TO_PERSON_RE);
  if (sendDetails?.[1] && sendDetails[2]) {
    return {
      taskIds: [sendDetails[2].toUpperCase()],
      destinationName: cleanupDestinationName(sendDetails[1]),
    };
  }
  const forward = message.text.match(FORWARD_DETAILS_RE);
  if (!forward?.[1]) return null;
  const taskIds = [...message.text.matchAll(TASK_ID_RE_GLOBAL)]
    .map((match) => match[1].toUpperCase());
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) return null;
  return {
    taskIds: uniqueTaskIds,
    destinationName: cleanupDestinationName(forward[1]),
  };
}

export function taskflowNotifyTaskPriorityCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowNotifyTaskPriority | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(NOTIFY_TASK_PRIORITY_RE);
  if (!match?.[1] || !match[2]) return null;
  return {
    destinationName: cleanupDestinationName(match[1]),
    taskId: match[2].toUpperCase(),
  };
}

function normalizeMeetingTitle(raw: string): string {
  const title = raw.replace(/^(?:uma\s+)?reuni[aã]o\b/iu, 'Reunião').trim();
  return /^reuni[aã]o\b/iu.test(title) ? title : `Reunião ${title}`;
}

function scheduledAtLocalIso(day: string, month: string, year: string, hour: string, minute?: string): string {
  const yyyy = year.length === 2 ? `20${year}` : year;
  return `${yyyy}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${(minute || '00').padStart(2, '0')}:00`;
}

function baseDateFromMessage(message: Pick<MessageInRow, 'content'>): string | null {
  const content = parseJsonContent(message.content);
  const rawPrompt = typeof content.phase2RawPrompt === 'string' ? content.phase2RawPrompt : '';
  const today = rawPrompt.match(/\btoday="(\d{4}-\d{2}-\d{2})"/)?.[1];
  if (today) return today;
  const time = rawPrompt.match(/\btime="([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4}),/);
  if (!time?.[1] || !time[2] || !time[3]) return null;
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const month = months[time[1]];
  if (!month) return null;
  return `${time[3]}-${month}-${time[2].padStart(2, '0')}`;
}

function nextWeekdayLocalIso(contextDate: string, weekdayName: string, hour: string, minute?: string): string | null {
  const targetDow = WEEKDAY_INDEX[normalizeWeekdayName(weekdayName)];
  if (targetDow === undefined) return null;
  const [year, month, day] = contextDate.split('-').map((part) => Number.parseInt(part, 10));
  const parsedHour = Number.parseInt(hour, 10);
  if (!year || !month || !day || !Number.isInteger(parsedHour)) return null;
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  let delta = (targetDow - base.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  const target = new Date(Date.UTC(year, month - 1, day + delta, 12, 0, 0));
  return scheduledAtLocalIso(
    String(target.getUTCDate()),
    String(target.getUTCMonth() + 1),
    String(target.getUTCFullYear()),
    String(parsedHour),
    minute,
  );
}

function weekdayNameForLocalIso(localIso: string): string | undefined {
  const [datePart] = localIso.split('T');
  const [year, month, day] = datePart.split('-').map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return undefined;
  const names = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  return names[new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay()];
}

export function taskflowCreateMeetingCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowCreateMeeting | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(CREATE_MEETING_DATE_RE);
  if (match?.[1] && match[2] && match[3] && match[4] && match[5]) {
    const scheduledAt = scheduledAtLocalIso(match[2], match[3], match[4], match[5], match[6]);
    return {
      title: normalizeMeetingTitle(match[1]),
      scheduledAt,
      intendedWeekday: weekdayNameForLocalIso(scheduledAt),
    };
  }
  const projectMatch = message.text.match(CREATE_PROJECT_MEETING_WEEKDAY_RE);
  if (!projectMatch?.[1] || !projectMatch[2] || !projectMatch[3] || !projectMatch[4]) return null;
  const contextDate = baseDateFromMessage(messages[0]);
  if (!contextDate) return null;
  const scheduledAt = nextWeekdayLocalIso(contextDate, projectMatch[3], projectMatch[4], projectMatch[5]);
  if (!scheduledAt) return null;
  return {
    title: normalizeMeetingTitle(projectMatch[2]),
    scheduledAt,
    intendedWeekday: weekdayNameForLocalIso(scheduledAt),
    parentProjectTitle: projectMatch[1].trim(),
  };
}

function splitPersonNames(raw: string): string[] {
  return raw
    .split(/\s*,\s*|\s+e\s+/iu)
    .map((part) => cleanupDestinationName(part).replace(/^(?:o|a|os|as)\s+/iu, '').trim())
    .filter((part) => part.length > 0);
}

export function taskflowAddParticipantsToLatestMeetingCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowAddParticipantsToLatestMeeting | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (extractTaskId(message.text)) return null;
  const match = message.text.match(ADD_PARTICIPANTS_ONLY_RE);
  if (!match?.[1]) return null;
  const taskId = latestMeetingTaskIdFromContents(recentContents);
  if (!taskId) return null;
  const participantNames = splitPersonNames(match[1]);
  return participantNames.length > 0 ? { taskId, participantNames } : null;
}

export function taskflowNotifyMeetingAboveCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowNotifyMeetingAbove | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const taskId = latestMeetingTaskIdFromContents(recentContents);
  if (!taskId) return null;
  const participants = message.text.match(NOTIFY_MEETING_PARTICIPANTS_RE);
  if (participants) return { taskId, useParticipants: true };
  const explicit = message.text.match(NOTIFY_MEETING_ABOVE_RE);
  if (!explicit?.[1]) return null;
  const recipientNames = splitPersonNames(explicit[1]);
  return recipientNames.length > 0 ? { taskId, recipientNames, useParticipants: false } : null;
}

export function taskflowAutoForwardMeetingConfirmation(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowAutoForwardMeetingConfirmation | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message || !AUTO_FORWARD_MEETINGS_CONFIRMATION_RE.test(message.text)) return null;
  const taskId = latestMeetingTaskIdFromContents(recentContents);
  const destinationName = latestMeetingVisibilityDestination(recentContents);
  return taskId && destinationName ? { taskId, destinationName } : null;
}

export function taskflowDueDateNeedsTaskPrompt(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowDueDateNeedsTask | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (/[?？]/.test(message.text)) return null;
  if (extractTaskId(message.text)) return null;
  const match = message.text.match(DUE_DATE_WITHOUT_TASK_RE);
  if (!match?.[1]) return null;
  return { dateText: match[1].replace(/^(\d{1,2}\/\d{1,2})\/\d{2,4}$/u, '$1') };
}

function contextDateFromMessages(messages: Pick<MessageInRow, 'content'>[]): string | null {
  for (const message of messages) {
    const content = parseJsonContent(message.content);
    const rawPrompt = typeof content.phase2RawPrompt === 'string' ? content.phase2RawPrompt : '';
    const match = rawPrompt.match(/\btoday="(\d{4}-\d{2}-\d{2})"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function rawPromptTextsFromMessages(messages: Pick<MessageInRow, 'content'>[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    const content = parseJsonContent(message.content);
    const rawPrompt = typeof content.phase2RawPrompt === 'string' ? content.phase2RawPrompt : '';
    for (const match of rawPrompt.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/g)) {
      const text = match[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
      if (text) texts.push(text);
    }
  }
  return texts;
}

function extractRawPromptTaskCandidates(rawPrompt: string): { id: string; title: string }[] {
  const candidates: { id: string; title: string }[] = [];
  const relevant = rawPrompt.match(/Relevant tasks for this message:\n([\s\S]*?)(?:\nOther tasks:|\]\n\n<context|\n<context|$)/);
  if (relevant?.[1]) {
    for (const line of relevant[1].split('\n')) {
      const match = line.match(/^-\s+((?:P|T|M|R)\d+(?:\.\d+)?)\s+(.+)$/i);
      if (match?.[1] && match[2]) {
        candidates.push({ id: match[1].toUpperCase(), title: match[2].trim() });
      }
    }
  }

  const other = rawPrompt.match(/Other tasks:\s*([\s\S]*?)(?:\]\n\n<context|\n<context|$)/);
  if (other?.[1]) {
    const taskPattern = /\b((?:P|T|M|R)\d+(?:\.\d+)?)\s+([^,\]\n]+)/gi;
    for (const match of other[1].matchAll(taskPattern)) {
      if (match[1] && match[2]) {
        candidates.push({ id: match[1].toUpperCase(), title: match[2].trim() });
      }
    }
  }

  return candidates;
}

const CONTEXT_HINT_STOPWORDS = new Set([
  'para',
  'pela',
  'pelo',
  'com',
  'das',
  'dos',
  'uma',
  'uns',
  'nas',
  'nos',
  'mais',
  'menos',
  'atividade',
  'atividades',
  'tarefa',
  'tarefas',
  'realizar',
  'submeter',
  'aguardar',
  'acompanhar',
  'mensais',
  'mensal',
]);

function normalizedTokenSet(text: string): Set<string> {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(tokens.filter((token) => !/^\d+$/.test(token) && !CONTEXT_HINT_STOPWORDS.has(token)));
}

function contextHintTokenMatches(activityToken: string, titleTokens: Set<string>): boolean {
  if (titleTokens.has(activityToken)) return true;
  if (activityToken.length < 5) return false;
  for (const titleToken of titleTokens) {
    if (titleToken.length >= 5 && (titleToken.startsWith(activityToken) || activityToken.startsWith(titleToken))) {
      return true;
    }
  }
  return false;
}

export function taskflowMeetingBatchUpdateCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowMeetingBatchUpdate | null {
  if (!taskflowEnabled) return null;
  const parsed = messages.map(parseSingleChat).filter((msg): msg is { sender: string; text: string } => !!msg);
  const rawPromptTexts = rawPromptTextsFromMessages(messages);
  const texts = rawPromptTexts.length > parsed.length ? rawPromptTexts : parsed.map((msg) => msg.text);
  if (texts.length < 2) return null;
  const participantMatch = texts.map((text) => text.match(ADD_PARTICIPANT_RE)).find(Boolean);
  const rescheduleMatch = texts.map((text) => text.match(RESCHEDULE_MEETING_RE)).find(Boolean);
  if (!participantMatch?.[1] || !participantMatch[2] || !rescheduleMatch?.[1] || !rescheduleMatch[2] || !rescheduleMatch[3]) {
    return null;
  }
  const detailRequested = texts.some((text) => text.trim().toUpperCase() === rescheduleMatch[1].toUpperCase());
  if (!detailRequested) return null;
  const contextDate = contextDateFromMessages(messages);
  if (!contextDate) return null;
  return {
    participantTaskId: participantMatch[2].toUpperCase(),
    participantName: participantMatch[1].trim(),
    meetingTaskId: rescheduleMatch[1].toUpperCase(),
    weekdayName: rescheduleMatch[2].toLowerCase(),
    hour: Number.parseInt(rescheduleMatch[3], 10),
    contextDate,
  };
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

function latestMeetingTaskIdFromContents(contents: string[]): string | null {
  for (const content of contents) {
    const text = outboundText(content);
    for (const match of text.matchAll(TASK_ID_RE_GLOBAL)) {
      const taskId = match[1].toUpperCase();
      if (taskId.startsWith('M')) return taskId;
    }
    const parsed = parseJsonContent(content);
    if (typeof parsed.text === 'string') {
      for (const match of parsed.text.matchAll(TASK_ID_RE_GLOBAL)) {
        const taskId = match[1].toUpperCase();
        if (taskId.startsWith('M')) return taskId;
      }
    }
  }
  return null;
}

function latestMeetingVisibilityDestination(contents: string[]): string | null {
  for (const content of contents) {
    const text = outboundText(content);
    const inbound = text.match(/\ba\s+([\p{L}\p{M}' ]{2,60}?)\s+n[aã]o\s+est[aá]\s+visualizando\s+os\s+detalhes\s+d[aeo]\s+M\d+/iu);
    if (inbound?.[1]) return cleanupDestinationName(inbound[1]);
    const outbound = text.match(/reuni[oõ]es?\s+(?:com\s+)?(?:a\s+|o\s+)?([\p{L}\p{M}' ]{2,60}?)(?:,|\s+eu\s+envio|\s+receba|\s+visualize)/iu);
    if (outbound?.[1]) return cleanupDestinationName(outbound[1]);
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

function normalizeDestinationLookup(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueDestinations(destinations: DestinationEntry[]): DestinationEntry[] {
  const seen = new Set<string>();
  const unique: DestinationEntry[] = [];
  for (const destination of destinations) {
    const key = `${destination.type}:${destination.name}:${destination.platformId ?? destination.agentGroupId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(destination);
  }
  return unique;
}

function destinationCandidatesByDisplayName(name: string): DestinationEntry[] {
  const target = normalizeDestinationLookup(name);
  if (!target) return [];
  const destinations = getAllDestinations();
  const exactNormalized = destinations.filter((destination) =>
    normalizeDestinationLookup(destination.name) === target ||
    normalizeDestinationLookup(destination.displayName) === target
  );
  if (exactNormalized.length > 0) return uniqueDestinations(exactNormalized);
  const partial = destinations.filter((destination) => {
    const names = [destination.name, destination.displayName].map(normalizeDestinationLookup);
    return names.some((candidate) => candidate.startsWith(`${target} `) || candidate.includes(` ${target} `));
  });
  if (partial.length > 0) return uniqueDestinations(partial);

  const targetTokens = target.split(/\s+/).filter((token) => token.length > 0);
  if (targetTokens.length === 0) return [];
  const tokenMatches = destinations.filter((destination) => {
    const names = [destination.name, destination.displayName].map(normalizeDestinationLookup);
    return names.some((candidate) => {
      const candidateTokens = new Set(candidate.split(/\s+/).filter(Boolean));
      return targetTokens.every((token) => candidateTokens.has(token));
    });
  });
  return uniqueDestinations(tokenMatches);
}

function findDestinationByDisplayName(name: string): DestinationEntry | undefined {
  const exact = findByName(name);
  if (exact) return exact;
  const candidates = destinationCandidatesByDisplayName(name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function ambiguityOptions(names: string[]): string {
  return names.map((name) => `- ${name}`).join('\n');
}

function destinationAmbiguityReply(rawName: string, candidates: DestinationEntry[]): string | null {
  if (candidates.length <= 1) return null;
  return `Encontrei mais de um destino para "${rawName}":\n${ambiguityOptions(candidates.map((candidate) => candidate.displayName || candidate.name))}\n\nQual deles?`;
}

function personAmbiguityReply(rawName: string, candidates: Array<{ name: string }>): string | null {
  if (candidates.length <= 1) return null;
  return `Encontrei mais de uma pessoa para "${rawName}":\n${ambiguityOptions(candidates.map((candidate) => candidate.name))}\n\nQual delas?`;
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

function formatHistoryLine(row: Record<string, unknown>): string {
  const at = typeof row['at'] === 'string' ? row['at'] : '';
  const date = at ? `${at.slice(8, 10)}/${at.slice(5, 7)} ${at.slice(11, 16)}` : '';
  const action = String(row['action'] ?? 'alterada');
  const by = typeof row['by'] === 'string' && row['by'] ? ` por ${row['by']}` : '';
  return `• ${date} — ${action}${by}`.trim();
}

function handleTaskflowReviewBypassDiagnosticPrompt(
  action: TaskflowReviewBypassPrompt,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'task_details', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);
  if (!queryResult.success) {
    writeReply(routing, `Não consegui conferir ${action.taskId}: ${queryResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const data = queryResult.data as {
    task?: Record<string, unknown>;
    parent_project?: { id?: string; title?: string };
    recent_history?: Array<Record<string, unknown>>;
    formatted_task_details?: string;
  };
  const task = data.task ?? {};
  const title = typeof task['title'] === 'string' ? task['title'] : action.taskId;
  const approvalRequired =
    task['requires_close_approval'] === 1 ||
    task['requires_close_approval'] === '1' ||
    task['requires_close_approval'] === true;
  const column = typeof task['column'] === 'string' ? task['column'] : '';
  const parent = data.parent_project?.id
    ? `📁 *${data.parent_project.id}*${data.parent_project.title ? ` — ${data.parent_project.title}` : ''}\n   `
    : '';
  const statusLine = column === 'done'
    ? `${action.taskId} foi concluída *diretamente*, sem passar pela revisão`
    : `${action.taskId} não está em revisão`;
  const reason = approvalRequired
    ? 'A tarefa está com aprovação obrigatória ativa agora; pelo histórico, é preciso conferir quando essa regra foi aplicada.'
    : `Isso aconteceu porque ${action.taskId} está sem exigência de aprovação (\`requires_close_approval: false\`).`;
  const history = Array.isArray(data.recent_history) && data.recent_history.length > 0
    ? `\n\nHistórico recente:\n${data.recent_history.map(formatHistoryLine).join('\n')}`
    : '';

  writeReply(
    routing,
    `${parent}📋 *${action.taskId}* — ${title}\n━━━━━━━━━━━━━━\n\n${statusLine}.\n\n${reason}${history}\n\nDeseja *reabrir* e exigir aprovação para ${action.taskId}? Posso reabrir e ativar a revisão obrigatória.`,
  );
  return true;
}

function columnLabelForReply(column: string | undefined): string {
  switch (column) {
    case 'inbox': return '📥 Inbox';
    case 'next_action': return '⏭️ Próximas Ações';
    case 'in_progress': return '🚧 Em Progresso';
    case 'waiting': return '⏸️ Aguardando';
    case 'review': return '🔍 Revisão';
    case 'done': return '✅ Concluída';
    default: return column ?? 'desconhecida';
  }
}

function formatPersonTasksReply(personName: string, rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const tasks = rows as Array<Record<string, unknown>>;
  const label = personName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const active = tasks.filter((task) => task['column'] !== 'done');
  const lines = [`👤 *${label}* — ${active.length} tarefa${active.length === 1 ? '' : 's'} ativa${active.length === 1 ? '' : 's'}`];
  const groups: Array<[string, string]> = [
    ['in_progress', '🔄 *Em andamento:*'],
    ['next_action', '⏭️ *Próximas Ações:*'],
    ['waiting', '⏸️ *Aguardando:*'],
    ['review', '🔍 *Revisão:*'],
    ['inbox', '📥 *Inbox:*'],
  ];
  for (const [column, header] of groups) {
    const group = active.filter((task) => task['column'] === column);
    if (group.length === 0) continue;
    lines.push('', header);
    for (const task of group.slice(0, 20)) {
      const id = String(task['id'] ?? '');
      const title = String(task['title'] ?? '');
      const dueDate = typeof task['due_date'] === 'string' && task['due_date']
        ? ` ⏰ ${task['due_date'].slice(8, 10)}/${task['due_date'].slice(5, 7)}`
        : '';
      const parentId = typeof task['parent_task_id'] === 'string' && task['parent_task_id']
        ? ` ↳ ${task['parent_task_id']}`
        : '';
      lines.push(`• *${id}* — ${title}${parentId}${dueDate}`);
    }
    if (group.length > 20) lines.push(`• ... +${group.length - 20} tarefas`);
  }
  return lines.join('\n');
}

function formatPersonReviewReply(personName: string, rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const tasks = (rows as Array<Record<string, unknown>>).filter((task) => task['column'] === 'review');
  const label = personName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  if (tasks.length === 0) return `Nenhuma atividade de ${label} está em revisão no momento.`;

  const parentId = typeof tasks[0]?.['parent_task_id'] === 'string' ? tasks[0]['parent_task_id'] as string : null;
  const parentTitle = typeof tasks[0]?.['parent_title'] === 'string' ? tasks[0]['parent_title'] as string : null;
  const lines = [`Tarefas do ${label} em revisão:`, ''];
  if (parentId) {
    lines.push(`📁 *${parentId}*${parentTitle ? ` — ${parentTitle}` : ''}`);
    lines.push('━━━━━━━━━━━━━━', '');
  }

  for (const task of tasks) {
    const id = String(task['id'] ?? '');
    const title = String(task['title'] ?? '');
    lines.push(`🔍 *${id}* — ${title}`);
    if (typeof task['due_date'] === 'string' && task['due_date']) {
      lines.push(`   ⏰ Prazo: ${task['due_date'].slice(8, 10)}/${task['due_date'].slice(5, 7)}`);
    }
    if (typeof task['next_action'] === 'string' && task['next_action']) {
      lines.push(`   • Próxima ação: ${task['next_action']}`);
    }
    const labels = parseStringArrayField(task['labels']);
    if (labels.length > 0) lines.push(`   • 🏷️ ${labels.join(', ')}`);
    const note = firstNoteText(task['notes']);
    if (note) lines.push(`   • 💬 Nota: ${note}`);
    lines.push('');
  }

  const ids = tasks.map((task) => String(task['id'] ?? '')).filter(Boolean);
  const approval = ids.length === 1
    ? `Essa tarefa precisa de aprovação. Para aprovar: \`${ids[0]} aprovada\`.`
    : `Ambas precisam de aprovação. Para aprovar: ${ids.map((id) => `\`${id} aprovada\``).join(' ou ')}.`;
  lines.push(approval);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function parseStringArrayField(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function firstNoteText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const note = parsed.find((item) => item && typeof item === 'object' && typeof item.text === 'string');
    return note?.text?.trim() || null;
  } catch {
    return null;
  }
}

function formatOrgTaskLookupReply(row: TaskflowOrgTaskLookupRow): string {
  const taskId = typeof row.task_id === 'string' ? row.task_id : 'Tarefa';
  const title = typeof row.title === 'string' ? row.title : '';
  const boardCode = typeof row.board_short_code === 'string' && row.board_short_code.trim()
    ? row.board_short_code.trim()
    : null;
  const boardName = typeof row.board_name === 'string' && row.board_name.trim()
    ? row.board_name.trim()
    : null;
  const boardFolder = typeof row.board_group_folder === 'string' && row.board_group_folder.trim()
    ? row.board_group_folder.trim()
    : null;
  const boardLabel = [boardCode, boardName ?? boardFolder].filter(Boolean).join(' - ');
  const assignee = typeof row.assignee_name === 'string' && row.assignee_name.trim()
    ? row.assignee_name
    : typeof row.assignee === 'string' && row.assignee.trim()
      ? row.assignee
      : 'sem responsável';
  const column = typeof row.column === 'string'
    ? columnLabelForReply(row.column).replace(/^[^ ]+ /u, '')
    : 'desconhecida';
  const dueDate = typeof row.due_date === 'string' && row.due_date.trim()
    ? `${row.due_date.slice(8, 10)}/${row.due_date.slice(5, 7)}`
    : 'sem prazo';

  return [
    `📋 *${taskId}*${title ? ` — ${title}` : ''}`,
    '━━━━━━━━━━━━━━',
    '',
    boardLabel ? `_Quadro: ${boardLabel}_` : null,
    '',
    `👤 *Responsável:* ${assignee}`,
    `⏭️ *Coluna:* ${column}`,
    `⏰ *Prazo:* ${dueDate}`,
  ].filter((line): line is string => line !== null).join('\n');
}

function formatRecentlyApprovedDoneReply(taskId: string, data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as {
    task?: Record<string, unknown>;
    recent_history?: Array<Record<string, unknown>>;
  };
  if (record.task?.['column'] !== 'done') return null;
  const latestAction = record.recent_history?.[0]?.['action'];
  if (latestAction !== 'approve') return null;
  return `${taskId} foi aprovada há pouco e está ✅ Concluída. Posso ajudar em algo mais sobre ela?`;
}

function normalizeWeekdayName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function nextWeekdayUtcIso(contextDate: string, weekdayName: string, hour: number): string | null {
  const targetDow = WEEKDAY_INDEX[normalizeWeekdayName(weekdayName)];
  if (targetDow === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const [year, month, day] = contextDate.split('-').map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return null;
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const currentDow = base.getUTCDay();
  let delta = (targetDow - currentDow + 7) % 7;
  if (delta === 0) delta = 7;
  const target = new Date(Date.UTC(year, month - 1, day + delta, hour + 3, 0, 0, 0));
  return target.toISOString();
}

function formatFortalezaDateTimePt(iso: string): string {
  const date = new Date(iso);
  const local = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const day = String(local.getUTCDate()).padStart(2, '0');
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const year = local.getUTCFullYear();
  const hour = String(local.getUTCHours()).padStart(2, '0');
  return `${day}/${month}/${year} às ${hour}:00`;
}

function formatFortalezaMeetingWhen(iso: string): string {
  const date = new Date(iso);
  const local = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const weekday = weekdays[local.getUTCDay()];
  const day = String(local.getUTCDate()).padStart(2, '0');
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const hour = String(local.getUTCHours()).padStart(2, '0');
  const minute = String(local.getUTCMinutes()).padStart(2, '0');
  return `${weekday}, ${day}/${month} às ${hour}h${minute === '00' ? '' : minute}`;
}

function meetingTaskSummary(data: unknown, taskId: string): { title: string; scheduledAt: string | null; formatted: string } {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const task = record.task && typeof record.task === 'object' ? record.task as Record<string, unknown> : {};
  const title = typeof task.title === 'string' ? task.title : taskId;
  const scheduledAt = typeof task.scheduled_at === 'string' ? task.scheduled_at : null;
  const formatted = typeof record.formatted_task_details === 'string' && record.formatted_task_details.trim()
    ? record.formatted_task_details
    : `📅 *${taskId}* — ${title}${scheduledAt ? `\nData: ${formatFortalezaDateTimePt(scheduledAt)}` : ''}`;
  return { title, scheduledAt, formatted };
}

function participantNamesForMeeting(boardId: string, taskId: string): string[] {
  const db = getTaskflowDb();
  const row = db.prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
    .get(boardId, taskId) as { participants?: string | null } | undefined;
  if (!row?.participants) return [];
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(row.participants);
    if (Array.isArray(parsed)) ids = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
  if (ids.length === 0) return [];
  const people = db.prepare(`SELECT person_id, name FROM board_people WHERE board_id = ?`)
    .all(boardId) as Array<{ person_id: string; name: string }>;
  const names = new Map(people.map((person) => [person.person_id, person.name]));
  return ids.map((id) => names.get(id) ?? id);
}

function nextLocalMorningIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(9, 0, 0, 0);
  while (local.getUTCDay() === 0 || local.getUTCDay() === 6) {
    local.setUTCDate(local.getUTCDate() + 1);
  }
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}T09:00:00`;
}

function writeScheduleTaskAction(routing: RoutingContext, prompt: string, processAfter: string, recurrence: string): void {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeMessageOut({
    id,
    in_reply_to: routing.inReplyTo,
    kind: 'system',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({
      action: 'schedule_task',
      taskId: id,
      prompt,
      script: null,
      processAfter,
      recurrence,
      platformId: routing.platformId,
      channelType: routing.channelType,
      threadId: routing.threadId,
    }),
  });
}

function normalizeLookupText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findProjectIdByTitle(boardId: string, title: string): string | null {
  const target = normalizeLookupText(title);
  if (!target) return null;
  const rows = getTaskflowDb().prepare(`SELECT id, title FROM tasks WHERE board_id = ? AND type = 'project'`)
    .all(boardId) as Array<{ id: string; title: string }>;
  const exact = rows.find((row) => normalizeLookupText(row.title) === target);
  if (exact) return exact.id;
  const targetTokens = target.split(' ').filter(Boolean);
  const matches = rows.filter((row) => {
    const normalized = normalizeLookupText(row.title);
    return targetTokens.every((token) => normalized.includes(token));
  });
  return matches.length === 1 ? matches[0].id : null;
}

function handleTaskflowCreateMeeting(
  action: TaskflowCreateMeeting,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const input = {
    type: 'meeting' as const,
    title: action.title,
    scheduled_at: action.scheduledAt,
    sender_name: sender,
    intended_weekday: action.intendedWeekday,
  };
  const result = engine.create({ ...input, board_id: boardId });
  appendSyntheticToolCall('api_create_meeting_task', input, result, !result.success);
  if (!result.success) {
    writeReply(routing, `Não consegui criar a reunião: ${result.error ?? 'erro desconhecido'}`);
    return true;
  }
  const taskId = typeof result.task_id === 'string' ? result.task_id : typeof result.id === 'string' ? result.id : 'reunião';
  let parentLine = '';
  if (action.parentProjectTitle && taskId !== 'reunião') {
    const parentId = findProjectIdByTitle(boardId, action.parentProjectTitle);
    if (parentId) {
      const adminInput = {
        action: 'reparent_task' as const,
        task_id: taskId,
        target_parent_id: parentId,
        sender_name: sender,
      };
      const adminResult = engine.admin({ ...adminInput, board_id: boardId });
      appendSyntheticToolCall('api_admin', adminInput, adminResult, !adminResult.success);
      if (adminResult.success) parentLine = `\n📁 *Projeto:* ${parentId} — ${action.parentProjectTitle}`;
    }
  }
  writeReply(
    routing,
    `✅ *Reunião criada*\n━━━━━━━━━━━━━━\n\n*${taskId}* — ${action.title}${parentLine}\n📅 *Data:* ${formatFortalezaDateTimePt(action.scheduledAt)}\n⏭️ *Coluna:* Próximas Ações`,
  );
  return true;
}

function handleTaskflowAddParticipantsToLatestMeeting(
  action: TaskflowAddParticipantsToLatestMeeting,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  for (const participantName of action.participantNames) {
    if (engine.resolvePerson(participantName)) continue;
    const ambiguity = personAmbiguityReply(participantName, engine.resolvePersonCandidates(participantName));
    if (ambiguity) {
      writeReply(routing, ambiguity);
      return true;
    }
  }
  const successes: string[] = [];
  const failures: string[] = [];
  for (const participantName of action.participantNames) {
    const input = {
      task_id: action.taskId,
      sender_name: sender,
      updates: { add_participant: participantName },
    };
    const result = engine.update({ ...input, board_id: boardId });
    appendSyntheticToolCall('api_update_task', input, result, !result.success);
    if (result.success) successes.push(participantName);
    else failures.push(`${participantName}: ${result.error ?? 'erro desconhecido'}`);
  }
  if (successes.length > 0) {
    writeReply(routing, `✅ ${successes.join(' e ')} adicionados em *${action.taskId}*.`);
  } else {
    writeReply(routing, `Não consegui adicionar participantes em ${action.taskId}:\n${failures.join('\n')}`);
  }
  return true;
}

function handleTaskflowNotifyMeetingAbove(
  action: TaskflowNotifyMeetingAbove,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: false });
  const queryInput = { query: 'task_details', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);
  if (!queryResult.success) {
    writeReply(routing, `Não consegui consultar ${action.taskId}: ${queryResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const recipients = action.useParticipants
    ? participantNamesForMeeting(boardId, action.taskId)
    : action.recipientNames ?? [];
  if (recipients.length === 0) return false;
  if (!action.useParticipants) {
    for (const recipient of recipients) {
      if (engine.resolvePerson(recipient)) continue;
      const ambiguity = personAmbiguityReply(recipient, engine.resolvePersonCandidates(recipient));
      if (ambiguity) {
        writeReply(routing, ambiguity);
        return true;
      }
    }
  }

  const { title, scheduledAt } = meetingTaskSummary(queryResult.data, action.taskId);
  const when = scheduledAt ? formatFortalezaMeetingWhen(scheduledAt) : 'data não informada';
  const sent: string[] = [];
  for (const recipient of recipients) {
    const dest = findDestinationByDisplayName(recipient);
    if (!dest) {
      const ambiguity = destinationAmbiguityReply(recipient, destinationCandidatesByDisplayName(recipient));
      if (ambiguity) {
        writeReply(routing, ambiguity);
        return true;
      }
      continue;
    }
    if (!action.useParticipants) {
      const updateInput = {
        task_id: action.taskId,
        sender_name: sender,
        updates: { add_participant: recipient },
      };
      const updateResult = engine.update({ ...updateInput, board_id: boardId });
      appendSyntheticToolCall('api_update_task', updateInput, updateResult, !updateResult.success);
    }
    const text = `Olá, ${recipient}! ${sender} pediu para te avisar sobre a seguinte reunião:\n\n📅 *${title}*\n${when}`;
    sendToDestination(dest, text, routing);
    appendSyntheticToolCall('send_message', { to: dest.name, text }, { success: true });
    sent.push(recipient);
  }

  if (sent.length === 0) return false;
  writeReply(routing, `${sent.join(' e ')} avisados sobre a reunião ${scheduledAt ? `de ${when}` : action.taskId}.`);
  return true;
}

function handleTaskflowAutoForwardMeetingConfirmation(
  action: TaskflowAutoForwardMeetingConfirmation,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const dest = findDestinationByDisplayName(action.destinationName);
  if (!dest) {
    const ambiguity = destinationAmbiguityReply(action.destinationName, destinationCandidatesByDisplayName(action.destinationName));
    if (ambiguity) {
      writeReply(routing, ambiguity);
      return true;
    }
    return false;
  }

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'task_details', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);
  if (!queryResult.success) {
    writeReply(routing, `Não consegui consultar ${action.taskId}: ${queryResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const { formatted } = meetingTaskSummary(queryResult.data, action.taskId);
  const forwardText = `Olá, ${action.destinationName}! ${sender} pediu para encaminhar os detalhes desta reunião:\n\n${formatted}`;
  sendToDestination(dest, forwardText, routing);
  appendSyntheticToolCall('send_message', { to: dest.name, text: forwardText }, { success: true });

  const prompt = `Enviar para ${action.destinationName} os detalhes de novas reuniões da SECI quando forem criadas ou reagendadas.`;
  const processAfter = nextLocalMorningIso();
  const recurrence = '0 9 * * 1-5';
  writeScheduleTaskAction(routing, prompt, processAfter, recurrence);
  appendSyntheticToolCall('schedule_task', { prompt, processAfter, recurrence }, { success: true });
  writeReply(routing, `Combinado. Encaminhei ${action.taskId} para ${action.destinationName} e agendei o acompanhamento das novas reuniões.`);
  return true;
}

function handleTaskflowMeetingBatchUpdate(
  action: TaskflowMeetingBatchUpdate,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const scheduledAt = nextWeekdayUtcIso(action.contextDate, action.weekdayName, action.hour);
  if (!scheduledAt) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const participantInput = {
    task_id: action.participantTaskId,
    sender_name: sender,
    updates: { add_participant: action.participantName },
  };
  const participantResult = engine.update({ ...participantInput, board_id: boardId });
  appendSyntheticToolCall('api_update_task', participantInput, participantResult, !participantResult.success);

  const scheduleInput = {
    task_id: action.meetingTaskId,
    sender_name: sender,
    updates: { scheduled_at: scheduledAt },
  };
  const scheduleResult = engine.update({ ...scheduleInput, board_id: boardId });
  appendSyntheticToolCall('api_update_task', scheduleInput, scheduleResult, !scheduleResult.success);

  const queryInput = { query: 'task_details', task_id: action.meetingTaskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);

  if (!participantResult.success || !scheduleResult.success) {
    const errors = [
      !participantResult.success ? `${action.participantTaskId}: ${participantResult.error ?? 'erro desconhecido'}` : null,
      !scheduleResult.success ? `${action.meetingTaskId}: ${scheduleResult.error ?? 'erro desconhecido'}` : null,
    ].filter(Boolean).join('\n');
    writeReply(routing, `Não consegui concluir todas as alterações:\n${errors}`);
    return true;
  }

  const participantChanged = Array.isArray(participantResult.changes) && participantResult.changes.length > 0;
  const participantLine = participantChanged
    ? `✅ *${action.participantTaskId}* — ${action.participantName} adicionada como participante.`
    : `ℹ️ *${action.participantTaskId}* — ${action.participantName} já estava registrada como participante (sem alteração necessária).`;
  const title = typeof scheduleResult.title === 'string' ? scheduleResult.title : action.meetingTaskId;
  const weekday = action.weekdayName.includes('feira') ? action.weekdayName : `${action.weekdayName}-feira`;
  writeReply(
    routing,
    [
      participantLine,
      '',
      `✅ *${action.meetingTaskId}* reagendada para ${weekday}, ${formatFortalezaDateTimePt(scheduledAt)}.`,
      '',
      '---',
      '',
      `📅 *${action.meetingTaskId}* — ${title}`,
    ].join('\n'),
  );
  return true;
}

function handleTaskflowExplicitCompletion(
  action: TaskflowExplicitCompletion,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const moveInput = {
    task_id: action.taskId,
    action: 'conclude' as const,
    sender_name: sender,
    confirmed_task_id: action.taskId,
  };
  const moveResult = engine.move({ ...moveInput, board_id: boardId });
  appendSyntheticToolCall('api_move', moveInput, moveResult, !moveResult.success);
  if (!moveResult.success) {
    writeReply(routing, `Não consegui concluir ${action.taskId}: ${moveResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const title = typeof moveResult.title === 'string' ? ` — ${moveResult.title}` : '';
  const lines = [
    `✅ *${moveResult.task_id ?? action.taskId}*${title}`,
    '',
    `• De ${columnLabelForReply(moveResult.from_column)} para ${columnLabelForReply(moveResult.to_column)}`,
  ];
  if (moveResult.approval_gate_applied) {
    lines.push('', 'A tarefa foi enviada para revisão obrigatória.');
  } else if (moveResult.project_update?.next_subtask) {
    lines.push('', `Próxima etapa do projeto: *${moveResult.project_update.next_subtask}*`);
  } else if (moveResult.project_update?.all_complete) {
    lines.push('', 'Todas as etapas do projeto foram concluídas.');
  }
  writeReply(routing, lines.join('\n'));
  return true;
}

function handleTaskflowBareTaskDetails(
  action: TaskflowTaskDetails,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'task_details', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);

  if (queryResult.success) {
    const recentlyApprovedReply = formatRecentlyApprovedDoneReply(action.taskId, queryResult.data);
    if (recentlyApprovedReply) {
      writeReply(routing, recentlyApprovedReply);
      return true;
    }
  }

  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);

  if (!queryResult.success) {
    const orgQueryInput = { query: 'find_task_in_organization', task_id: action.taskId, sender_name: sender };
    const orgQueryResult = engine.query(orgQueryInput);
    appendSyntheticToolCall('api_query', orgQueryInput, orgQueryResult, !orgQueryResult.success);
    if (orgQueryResult.success && Array.isArray(orgQueryResult.data) && orgQueryResult.data.length > 0) {
      writeReply(routing, formatOrgTaskLookupReply(orgQueryResult.data[0] as TaskflowOrgTaskLookupRow));
      return true;
    }
  }

  const data = queryResult.data as { formatted_task_details?: unknown } | undefined;
  const text = typeof queryResult.formatted === 'string' && queryResult.formatted.trim()
    ? queryResult.formatted
    : typeof data?.formatted_task_details === 'string' && data.formatted_task_details.trim()
      ? data.formatted_task_details
    : queryResult.success
      ? JSON.stringify(queryResult.data ?? queryResult)
      : `Não encontrei ${action.taskId}: ${queryResult.error ?? 'erro desconhecido'}`;
  writeReply(routing, text);
  return true;
}

function handleTaskflowPersonTasks(
  action: TaskflowPersonTasks,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'person_tasks', person_name: action.personName, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);
  const formattedPersonTasks = formatPersonTasksReply(action.personName, queryResult.data);
  const text = typeof queryResult.formatted === 'string' && queryResult.formatted.trim()
    ? queryResult.formatted
    : formattedPersonTasks
      ? formattedPersonTasks
    : queryResult.success
      ? JSON.stringify(queryResult.data ?? queryResult)
      : `Não encontrei atividades de ${action.personName}: ${queryResult.error ?? 'erro desconhecido'}`;
  writeReply(routing, text);
  return true;
}

function handleTaskflowPersonReview(
  action: TaskflowPersonReview,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'person_review', person_name: action.personName, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);
  const formattedReview = formatPersonReviewReply(action.personName, queryResult.data);
  const text = formattedReview
    ? formattedReview
    : queryResult.success
      ? JSON.stringify(queryResult.data ?? queryResult)
      : `Não consegui conferir atividades de ${action.personName} em revisão: ${queryResult.error ?? 'erro desconhecido'}`;
  writeReply(routing, text);
  return true;
}

function handleTaskflowBulkApproval(
  action: TaskflowBulkApproval,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const queryInput = { query: 'person_review', person_name: action.personName, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);
  if (!queryResult.success) {
    writeReply(
      routing,
      `Não consegui conferir atividades de ${action.personName} em revisão: ${queryResult.error ?? 'erro desconhecido'}`,
    );
    return true;
  }

  const tasks = Array.isArray(queryResult.data)
    ? (queryResult.data as Array<Record<string, unknown>>).filter((task) => task['column'] === 'review')
    : [];
  if (tasks.length === 0) {
    writeReply(routing, `${action.personName} não possui nenhuma tarefa em revisão no momento. Nada a aprovar.`);
    return true;
  }

  const taskIds = tasks
    .map((task) => typeof task['id'] === 'string' ? task['id'] : '')
    .filter(Boolean);
  const results = taskIds.map((taskId) => engine.move({
    board_id: boardId,
    task_id: taskId,
    action: 'approve',
    sender_name: sender,
    confirmed_task_id: taskId,
  }));
  const successes = results.filter((result) => result.success);
  const failures = results.filter((result) => !result.success);
  const moveInput = { task_ids: taskIds, action: 'approve', sender_name: sender };
  const moveOutput = {
    success: failures.length === 0,
    data: {
      bulk: true,
      action: 'approve',
      processed_count: results.length,
      success_count: successes.length,
      failure_count: failures.length,
      results,
    },
  };
  appendSyntheticToolCall('api_move', moveInput, moveOutput, failures.length > 0);

  if (successes.length === 0) {
    writeReply(
      routing,
      `Não consegui aprovar as tarefas de ${action.personName}: ${failures.map((r) => r.error ?? 'erro desconhecido').join('; ')}`,
    );
    return true;
  }

  const lines = [
    `✅ ${successes.length} de ${results.length} tarefa(s) de ${action.personName} aprovada(s).`,
    ...successes.map((result) => `- *${result.task_id}*${result.title ? ` — ${result.title}` : ''}`),
  ];
  if (failures.length > 0) {
    lines.push('', 'Falhas:');
    lines.push(...failures.map((result) => `- ${result.task_id ?? 'tarefa'}: ${result.error ?? 'erro desconhecido'}`));
  }
  writeReply(routing, lines.join('\n'));
  return true;
}

function handleTaskflowStandaloneActivityPrompt(
  action: TaskflowStandaloneActivity,
  routing: RoutingContext,
): boolean {
  const related = action.contextHints.length > 0
    ? `\n\nPode se relacionar a:\n${action.contextHints.map((hint) => `- ${hint}`).join('\n')}`
    : '';
  writeReply(
    routing,
    `Essa atividade — *${action.text}* — não está cadastrada diretamente.${related}\n\nDeseja:\n1. Criar tarefa simples\n2. Adicionar como etapa de um projeto existente\n3. Capturar no inbox para triagem`,
  );
  return true;
}

function handleTaskflowForwardDetails(
  action: TaskflowForwardDetails,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const dest = findDestinationByDisplayName(action.destinationName);
  if (!dest) {
    const ambiguity = destinationAmbiguityReply(action.destinationName, destinationCandidatesByDisplayName(action.destinationName));
    if (ambiguity) {
      writeReply(routing, ambiguity);
      return true;
    }
    return false;
  }

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const details: string[] = [];
  for (const taskId of action.taskIds) {
    const queryInput = { query: 'task_details', task_id: taskId, sender_name: sender };
    const queryResult = engine.query(queryInput);
    appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);
    if (!queryResult.success) {
      details.push(`*${taskId}* — não consegui consultar: ${queryResult.error ?? 'erro desconhecido'}`);
      continue;
    }
    const data = queryResult.data as { formatted_task_details?: unknown } | undefined;
    const formatted = typeof data?.formatted_task_details === 'string' && data.formatted_task_details.trim()
      ? data.formatted_task_details
      : JSON.stringify(queryResult.data ?? queryResult);
    details.push(formatted);
  }

  const forwardText = `Olá, ${action.destinationName}! ${sender} pediu para encaminhar os detalhes abaixo:\n\n${details.join('\n\n---\n\n')}`;
  sendToDestination(dest, forwardText, routing);
  appendSyntheticToolCall('send_message', { to: dest.name, text: forwardText }, { success: true });
  writeReply(routing, `Detalhes de ${action.taskIds.join(' e ')} encaminhados para ${action.destinationName}.`);
  return true;
}

function handleTaskflowNotifyTaskPriority(
  action: TaskflowNotifyTaskPriority,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const dest = findDestinationByDisplayName(action.destinationName);
  if (!dest) {
    const ambiguity = destinationAmbiguityReply(action.destinationName, destinationCandidatesByDisplayName(action.destinationName));
    if (ambiguity) {
      writeReply(routing, ambiguity);
      return true;
    }
    return false;
  }

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'task_details', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendSyntheticToolCall('api_query', queryInput, queryResult, !queryResult.success);
  if (!queryResult.success) {
    writeReply(routing, `Não consegui consultar ${action.taskId}: ${queryResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const data = queryResult.data as Record<string, unknown> | undefined;
  const task = data?.task as Record<string, unknown> | undefined;
  const title = typeof data?.title === 'string'
    ? data.title
    : typeof task?.title === 'string'
      ? task.title
      : action.taskId;
  const column = typeof data?.column === 'string' ? data.column : typeof task?.column === 'string' ? task.column : '';
  const status = column ? `\nStatus atual: ${columnLabelForReply(column)}` : '';
  const forwardText = `${action.destinationName}, ${sender} pede para você priorizar a tarefa *${action.taskId}* — ${title}.${status}`;

  sendToDestination(dest, forwardText, routing);
  appendSyntheticToolCall('send_message', { to: dest.name, text: forwardText }, { success: true });
  writeReply(routing, `Mensagem sobre ${action.taskId} encaminhada para ${action.destinationName}.`);
  return true;
}

function handleTaskflowDueDateNeedsTaskPrompt(
  action: TaskflowDueDateNeedsTask,
  routing: RoutingContext,
): boolean {
  writeReply(routing, `Para qual tarefa você quer definir o prazo de ${action.dateText}?`);
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
    const recentIn = recentInboundContents();
    const recentContext = [...recentOut, ...recentIn];
    const explicitCompletion = taskflowExplicitCompletionCommand(keep);
    if (explicitCompletion && handleTaskflowExplicitCompletion(explicitCompletion, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled explicit TaskFlow completion without provider query');
      continue;
    }

    const createMeeting = taskflowCreateMeetingCommand(keep);
    if (createMeeting && handleTaskflowCreateMeeting(createMeeting, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow meeting creation without provider query');
      continue;
    }

    const bareTaskDetails = taskflowBareTaskDetailsCommand(keep);
    if (bareTaskDetails && handleTaskflowBareTaskDetails(bareTaskDetails, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled bare TaskFlow task-details request without provider query');
      continue;
    }

    const bulkApproval = taskflowBulkApprovalCommand(keep);
    if (bulkApproval && handleTaskflowBulkApproval(bulkApproval, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow bulk approval without provider query');
      continue;
    }

    const personReview = taskflowPersonReviewCommand(keep);
    if (personReview && handleTaskflowPersonReview(personReview, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow person-review request without provider query');
      continue;
    }

    const personTasks = taskflowPersonTasksCommand(keep);
    if (personTasks && handleTaskflowPersonTasks(personTasks, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow person-tasks request without provider query');
      continue;
    }

    const standaloneActivity = taskflowStandaloneActivityPrompt(keep);
    if (standaloneActivity && handleTaskflowStandaloneActivityPrompt(standaloneActivity, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled standalone TaskFlow activity prompt without provider query');
      continue;
    }

    const notifyTaskPriority = taskflowNotifyTaskPriorityCommand(keep);
    if (notifyTaskPriority && handleTaskflowNotifyTaskPriority(notifyTaskPriority, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow priority notification without provider query');
      continue;
    }

    const addParticipantsToLatestMeeting = taskflowAddParticipantsToLatestMeetingCommand(keep, recentContext);
    if (addParticipantsToLatestMeeting && handleTaskflowAddParticipantsToLatestMeeting(addParticipantsToLatestMeeting, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow participant add to latest meeting without provider query');
      continue;
    }

    const notifyMeetingAbove = taskflowNotifyMeetingAboveCommand(keep, recentContext);
    if (notifyMeetingAbove && handleTaskflowNotifyMeetingAbove(notifyMeetingAbove, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow meeting notification without provider query');
      continue;
    }

    const autoForwardMeetingConfirmation = taskflowAutoForwardMeetingConfirmation(keep, recentContext);
    if (autoForwardMeetingConfirmation && handleTaskflowAutoForwardMeetingConfirmation(autoForwardMeetingConfirmation, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow meeting auto-forward confirmation without provider query');
      continue;
    }

    const forwardDetails = taskflowForwardDetailsCommand(keep);
    if (forwardDetails && handleTaskflowForwardDetails(forwardDetails, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow details forwarding without provider query');
      continue;
    }

    const meetingBatchUpdate = taskflowMeetingBatchUpdateCommand(keep);
    if (meetingBatchUpdate && handleTaskflowMeetingBatchUpdate(meetingBatchUpdate, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow meeting batch update without provider query');
      continue;
    }

    const dueDateNeedsTask = taskflowDueDateNeedsTaskPrompt(keep);
    if (dueDateNeedsTask && handleTaskflowDueDateNeedsTaskPrompt(dueDateNeedsTask, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow due-date clarification without provider query');
      continue;
    }

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
    if (reviewBypassPrompt && handleTaskflowReviewBypassDiagnosticPrompt(reviewBypassPrompt, keep, routing)) {
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
 * The agent should wrap output in <message to="name">...</message> blocks.
 * As a delivery safety net, bare final text is sent to the sole configured
 * destination when there is exactly one; with multiple destinations, bare
 * text remains scratchpad because routing would be ambiguous.
 */
function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  let sawMessageBlock = false;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    sawMessageBlock = true;
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

  if (sent === 0 && !sawMessageBlock && scratchpad) {
    const destinations = getAllDestinations();
    if (destinations.length === 1) {
      sendToDestination(destinations[0], scratchpad, routing);
      log('Sent bare final text to sole configured destination');
      return;
    }
  }

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
