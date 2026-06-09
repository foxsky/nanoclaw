import fs from 'fs';

import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, markFailed, type MessageInRow } from './db/messages-in.js';
import { EXECUTE_APPROVED_ACTION, executeApprovedAction } from './mcp-tools/taskflow-approval.js';
// Side-effect import: registers the approved-action executors IN THIS (main) process. The MCP tool
// modules run in a separate subprocess, so their registrations don't reach the replay path here.
import './mcp-tools/approved-executors.js';
import { writeMessageOut } from './db/messages-out.js';
import { getInboundDb, openInboundDb, getOutboundDb, getTaskflowDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import {
  clearCurrentInReplyTo,
  clearCurrentWebOrigin,
  crossesWebChatBoundary,
  detectWebOrigin,
  setCurrentInReplyTo,
  setCurrentWebOrigin,
} from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import {
  consumeDeterministicMutationFlag,
  drainDeterministicMutationFlag,
} from './mcp-tools/mutation-dedup.js';
import {
  shouldSuppressDuplicateMutationMessage,
  shouldSuppressSameConvMessage,
} from './mcp-tools/message-block-dedup.js';
import { flushPendingCreateCard } from './mcp-tools/mutation-confirmation.js';
import { drainAndDispatchPendingNotifications } from './mcp-tools/pending-notification-dispatch.js';
import { buildReassignCard, buildReassignInfo, type ReassignTaskInfo } from './mcp-tools/reassign-card.js';
import { appendToolEvents, type ToolEvent } from './providers/claude-tool-capture.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { TaskflowEngine, normalizePhone, type ReassignResult } from './taskflow-engine.js';
import { applyRunnerGate, isTfRunnerRow } from './runner-gate-apply.js';
import { embedText } from './memory-embed.js';
import { TIMEZONE } from './timezone.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const TASKFLOW_CLAUDE_LOCAL_PATH = '/workspace/agent/CLAUDE.local.md';

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

interface TaskflowReadyForReviewUpdate {
  taskId: string;
  noteText: string;
}

interface TaskflowExplicitReassign {
  taskId: string;
  targetPerson: string;
}

interface TaskflowPendingChildBoardRegistration {
  personName: string;
  phone: string;
  role: string;
  groupName: string;
  groupFolder: string;
}

interface TaskflowChildBoardCreationPrompt {
  groupName: string;
}

interface TaskflowExactIdNoteCandidate {
  taskId: string;
  noteText: string;
  reassignTarget?: string;
}

interface TaskflowIncompleteNoteRequest {
  taskId: string;
}

interface TaskflowTaskDetails {
  taskId: string;
}

interface TaskflowRecentInbox {
  count: number;
}

interface TaskflowPersonTasks {
  personName: string;
  self?: boolean;
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

interface TaskflowProjectNoteUpdate {
  text: string;
}

interface TaskflowBareResolved {
  senderName: string;
}

interface TaskflowMissingTaskFollowup {
  missingTaskId: string;
  text: string;
  confirmationOnly: boolean;
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

interface TaskflowProcessMinutes {
  taskId: string;
}

interface TaskflowOrgMeetingDraftPrompt {
  title: string;
  scheduledAt: string;
  participantName: string;
  location: string;
}

interface TaskflowAddParticipantsToLatestMeeting {
  taskId: string;
  participantNames: string[];
}

interface TaskflowAddExternalParticipantToLatestMeeting {
  taskId: string;
  participantName: string;
  phone: string;
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

interface TaskflowOrgMeetingCreateForwardConfirmation {
  title: string;
  scheduledAt: string;
  participantName: string;
}

interface TaskflowDueDateNeedsTask {
  dateText: string;
}

interface TaskflowProjectReport {
  query: 'projects' | 'project_next_actions' | 'projects_detailed';
}

interface TaskflowProjectTitleLookup {
  title: string;
}

interface TaskflowProjectExistenceLookup {
  searchText: string;
}

interface TaskflowMeetingBatchUpdate {
  participantTaskId: string;
  participantName: string;
  meetingTaskId: string;
  weekdayName: string;
  hour: number;
  contextDate: string;
}

interface TaskflowExactTaskNextActionUpdate {
  taskId: string;
  nextAction: string;
}

interface TaskflowOrgDirectoryQuestion {
  kind: 'sectors' | 'roles' | 'person';
  personName?: string;
}

interface TaskflowBoardPersonPlacement {
  placements: Array<{
    personName: string;
    boardHint: string;
  }>;
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
const EXACT_TASK_NOTE_RE = /^\s*((?:[A-Z]{2,}-)?(?:P|T|M|R)\d+(?:\.\d+)?)\s*[-–—:]\s*(.+?)\s*$/iu;
const TASK_NOTE_REVIEW_RE = /^\s*((?:P|T|M|R)\d+(?:\.\d+)?)\s*[-–—:]\s*(.+?)\s*$/iu;
const COMPLETE_VERB_RE = /\b(concluir|conclu[ií]d[ao]?|finalizar|finalizad[ao]?)\b/i;
const BARE_RESOLVED_RE = /^\s*(?:resolvido|resolvida|conclu[ií]do|conclu[ií]da|feito|feita|finalizado|finalizada)\s*[.!]?\s*$/iu;
const RECENT_INBOX_RE = /^\s*(?:(?:show|list|display)\s+(?:the\s+)?last|(?:mostrar|listar|liste|exibir)\s+(?:os\s+|as\s+)?(?:últim[oa]s?|ultim[oa]s?))\s+(\d+|one|two|three|four|five|um|uma|dois|duas|tr[eê]s|quatro|cinco)\s+(?:itens?\s+(?:do\s+)?)?(?:inbox|inboxes)\s*[.!?]?\s*$/iu;
const PERSON_TASKS_RE = /^\s*(?:atividades|tarefas)\s+(?:de\s+|do\s+|da\s+)?([\p{L}\p{M}' -]{2,60})\s*[.!]?\s*$/iu;
const MY_TASKS_RE = /^\s*(?:quais\s+s[aã]o\s+)?minhas\s+(?:tarefas|atividades)\s*[?!.]?\s*$/iu;
const PERSON_REVIEW_RE = /^\s*(?:alguma\s+)?(?:atividade|atividades|tarefa|tarefas)\s+(?:de\s+|do\s+|da\s+)?([\p{L}\p{M}' -]{2,60})\s+para\s+revis[aã]o\s*[?!.]?\s*$/iu;
const BULK_APPROVAL_RE = /^\s*aprovar\s+(?:todas\s+as\s+)?(?:atividades|tarefas)\s+(?:de\s+|do\s+|da\s+)?([\p{L}\p{M}' -]{2,60})\s*[.!]?\s*$/iu;
const STANDALONE_ACTIVITY_RE = /^\s*(?:Aguardar(?:\s+e\s+Acompanhar)?|Submeter|Realizar|Elaborar)\b.+/iu;
const ZERO_PADDED_PROJECT_CODE_RE = /\bP0\d+\b/iu;
const REASSIGN_ID_FIRST_RE = /^\s*((?:P|T|M|R)\d+(?:\.\d+)?)\s+(?:re)?atribuir\s+(?:para|a|ao|à)\s+([\p{L}\p{M}' -]{2,60})\s*[.!]?\s*$/iu;
const REASSIGN_VERB_FIRST_RE = /^\s*(?:re)?atribuir\s+((?:P|T|M|R)\d+(?:\.\d+)?)\s+(?:para|a|ao|à)\s+([\p{L}\p{M}' -]{2,60})\s*[.!]?\s*$/iu;
const REASSIGN_COMPOUND_TARGET_RE = /\b(?:e|,)\s*(?:colocar|adicionar|para|como|co[-\s]?respons[aá]vel|respons[aá]vel|titular)\b/iu;
const CONTACT_CARD_RE = /^\s*([^,\n]+?)\s*,\s*telefone\s*:\s*([^,\n]+?)\s*,\s*cargo\s*:\s*(.+?)\.?\s*$/iu;
const CREATE_CHILD_BOARD_RE = /^\s*criar\s+quadro\b[\s\S]{0,120}?\bnome\s+([^\n?.!]+?)(?:\s*$|[?.!])/iu;
const INCOMPLETE_NOTE_REQUEST_RE = /^\s*(?:solicitar|solicito|pedir|peço)\b[\s\S]{0,80}\bnota\b[\s\S]{0,80}\b((?:P|T|M|R)\d+(?:\.\d+)?)\b/iu;
const FORWARD_DETAILS_RE = /\bencaminhar\b.*\bdetalhes\b.*\bpara\s+([\p{L}\p{M}' -]{2,60})\s*$/iu;
const SEND_DETAILS_TO_PERSON_RE = /\b(?:enviar|mandar)\s+mensagem\s+para\s+(?:o\s+|a\s+)?([\p{L}\p{M}' -]{2,60}?)\s+com\s+(?:os\s+)?detalhes\s+d[aeo]\s+((?:P|T|M|R)\d+(?:\.\d+)?)\b/iu;
const NOTIFY_TASK_PRIORITY_RE = /\b(?:enviar|mandar)\s+mensagem\s+para\s+(?:o\s+|a\s+)?([\p{L}\p{M}' -]{2,60}?)\s+.*\bpriorizar\b.*\b(?:tarefa|atividade)\s+((?:P|T|M|R)\d+(?:\.\d+)?)\b/iu;
const DUE_DATE_WITHOUT_TASK_RE = /^\s*(?:prazo|vencimento|data limite)\s+(?:para\s+)?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*[.!]?\s*$/iu;
const PROJECT_NEXT_ACTIONS_REPORT_RE = /\b(?:inclu(?:a|ir)|listar|mostrar|ver|relat[oó]rio|quais\s+s[aã]o)\b[\s\S]*\bpr[oó]ximas?\s+a[cç][oõ]es\b[\s\S]*\b(?:cada\s+projeto|projetos?)\b/iu;
const PROJECT_NOTES_REPORT_RE = /\brelat[oó]rio\b[\s\S]*\b(?:todos\s+os\s+)?projetos?\b[\s\S]*\bnotas?\b/iu;
const PROJECTS_LIST_RE = /^\s*(?:quais\s+(?:s[aã]o\s+)?os\s+)?projetos\s+(?:atuais|ativos)\s*[?!.]?\s*$/iu;
const PROJECT_TITLE_LOOKUP_RE = /^\s*qual\s+(?:é\s+)?o\s+projeto\s+d[ao]\s+(.+?)\s*[?!.]?\s*$/iu;
const PROJECT_EXISTENCE_LOOKUP_RE = /^\s*existe\s+algum\s+projeto\s+d[eo]\s+(.+?)\s*[?!.]?\s*$/iu;
const ORG_DIRECTORY_RE = /^\s*quais\s+(?:s[aã]o\s+)?(?:os\s+|as\s+)?(setores|cargos)\s+existem(?:\s+n[ao]\s+([A-Z0-9ÁÉÍÓÚÇÃÕÂÊÔ -]{2,40}))?\s*[?!.]?\s*$/iu;
const ORG_PERSON_FOLLOWUP_RE = /^\s*e\s+([\p{L}\p{M}' -]{2,50})\s*[?!.]?\s*$/iu;
const EXACT_TASK_NEXT_ACTION_RE = /^\s*((?:P|T|M|R)\d+(?:\.\d+)?)\s+(.+?)\s*[.!]?\s*$/iu;
const NEXT_ACTION_START_RE = /^(?:pr[oó]xima\s+a[cç][aã]o\s*:\s*)?(?:enviar|mandar|preparar|providenciar|solicitar|acompanhar|verificar)\b/iu;
// FU-2: the lazy hint class is `i`-flagged, so it would otherwise eat a trailing
// lowercase shared-role word ("SM-SETD-SECTI também") to satisfy the `$` terminator.
// Add shared-role tokens (também/juntos/ambos/…) as lookahead terminators so the
// hint stops at the board name (the comma-separated form already terminated on `,`).
const BOARD_PERSON_PLACEMENT_RE = /\b(?:coloca|colocar|adicione|adicionar)?\s*(?:o\s+|a\s+)?([\p{L}\p{M}' -]{2,60}?)\s+no\s+setor\s+([A-Z0-9ÁÉÍÓÚÇÃÕÂÊÔ -]{2,80}?)(?=\s+e\s+(?:o\s+|a\s+)?[\p{L}\p{M}]|\s+(?:tamb[ée]m|juntos?|ambos|ambas|os\s+dois|continuam?)\b|\s*[.!,]|$)/giu;
const ADD_PARTICIPANT_RE = /\badicionar\s+([\p{L}\p{M}' -]{2,60})\s+em\s+(M\d+)\b/iu;
const ADD_PARTICIPANTS_ONLY_RE = /^\s*adicionar\s+([\p{L}\p{M}', -]+?)\s*[.!]?\s*$/iu;
const EXTERNAL_PARTICIPANT_FOLLOWUP_RE = /^\s*([\p{L}\p{M}' -]{2,60}?)\s+(?:é|eh|e)\s+participante\s+extern[ao]\s*:?\s*([+\d][\d\s().-]{7,})\s*[.!]?\s*$/iu;
const ORG_MEETING_WEEKDAY_RE = /^\s*reuni[aã]o\s+(?:na\s+)?(segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?\s+n[ao]\s+(.+?)\s+(?:às|as)\s+(\d{1,2})(?:(?:h|:)(\d{2})?|\s+horas?)?,\s*projeto\s+(.+?),\s*com\s+(?:a\s+|o\s+)?([\p{L}\p{M}' -]{2,60})\.?\s*$/iu;
const ORG_MEETING_PERSON_FOLLOWUP_RE = /^\s*e\s+([\p{L}\p{M}' -]{2,60})\s*[?!.]?\s*$/iu;
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

export function taskflowExplicitReassignCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowExplicitReassign | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (/[?？]/.test(message.text)) return null;
  if (/\bn[aã]o\b/i.test(message.text)) return null;
  const match = message.text.match(REASSIGN_ID_FIRST_RE) ?? message.text.match(REASSIGN_VERB_FIRST_RE);
  if (!match?.[1] || !match[2]) return null;
  const targetPerson = match[2].trim();
  if (REASSIGN_COMPOUND_TARGET_RE.test(targetPerson)) return null;
  return {
    taskId: match[1].toUpperCase(),
    targetPerson,
  };
}

export function taskflowPendingChildBoardRegistrationCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentContents: string[],
  taskflowEnabled = Boolean(currentTaskflowBoardId(messages)),
): TaskflowPendingChildBoardRegistration | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const contact = message.text.match(CONTACT_CARD_RE);
  if (!contact?.[1] || !contact[2] || !contact[3]) return null;

  const contextText = recentContents.map(contextSearchText).join('\n');
  const division = pendingChildBoardDivision(contextText);
  if (!division) return null;

  const groupFolder = `${slugForBoardFolder(division)}-taskflow`;
  return {
    personName: contact[1].trim(),
    phone: normalizePhone(contact[2]) || contact[2].replace(/\D/g, ''),
    role: contact[3].trim(),
    groupName: `${division} - TaskFlow`,
    groupFolder,
  };
}

export function taskflowChildBoardCreationPrompt(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(currentTaskflowBoardId(messages)),
): TaskflowChildBoardCreationPrompt | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(CREATE_CHILD_BOARD_RE);
  if (!match?.[1]) return null;
  const groupName = match[1]
    .replace(/\s*-\s*TaskFlow\s*$/iu, '')
    .trim();
  return groupName.length >= 2 ? { groupName } : null;
}

export function taskflowReadyForReviewUpdateCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowReadyForReviewUpdate | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(TASK_NOTE_REVIEW_RE);
  if (!match) return null;
  const [, taskId, rawNote] = match;
  if (!/\b(pront[oa]|assinatura|gabinete|dfd|envio)\b/iu.test(rawNote)) return null;
  if (!/\b(revis[aã]o|assinatura|gabinete|dfd)\b/iu.test(rawNote)) return null;
  return { taskId: taskId.toUpperCase(), noteText: normalizeReadyForReviewNote(rawNote) };
}

export function taskflowExactIdNoteCandidate(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowExactIdNoteCandidate | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(EXACT_TASK_NOTE_RE);
  if (!match?.[1] || !match[2]) return null;
  const taskId = match[1].toUpperCase();
  let noteText = match[2].trim();
  let reassignTarget: string | undefined;
  const reassign = noteText.match(/\b(?:re)?atribuir\s+((?:P|T|M|R)\d+(?:\.\d+)?)?\s*(?:para|a|ao|à)\s+([\p{L}\p{M}' -]{2,60})\s*$/iu);
  if (reassign?.[2]) {
    const reassignTaskId = reassign[1]?.toUpperCase();
    if (!reassignTaskId || taskId.endsWith(reassignTaskId)) {
      reassignTarget = reassign[2].trim();
      noteText = noteText.slice(0, reassign.index).trim();
    }
  }
  noteText = noteText
    .replace(/^\s*adicionar\s+nota\s*:?\s*/iu, '')
    .replace(/[.;]\s*$/u, '')
    .trim();
  if (!noteText) return null;
  return { taskId, noteText, reassignTarget };
}

export function taskflowIncompleteNoteRequestCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowIncompleteNoteRequest | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (/[?？]/.test(message.text)) return null;
  if (/\b(?:adicionar|registrar)\s+nota\s*:/iu.test(message.text)) return null;
  const match = message.text.match(INCOMPLETE_NOTE_REQUEST_RE);
  return match?.[1] ? { taskId: match[1].toUpperCase() } : null;
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

export function taskflowProcessMinutesCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(currentTaskflowBoardId(messages)),
): TaskflowProcessMinutes | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (!/\bprocessar\s+(?:a\s+)?ata\b/iu.test(message.text)) return null;
  const taskId = extractTaskId(message.text);
  return taskId?.startsWith('M') ? { taskId } : null;
}

function parseSmallCount(value: string): number | null {
  const normalized = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    um: 1,
    uma: 1,
    dois: 2,
    duas: 2,
    tres: 3,
    quatro: 4,
    cinco: 5,
  };
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : words[normalized];
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, 10);
}

export function taskflowRecentInboxCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowRecentInbox | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(RECENT_INBOX_RE);
  if (!match?.[1]) return null;
  const count = parseSmallCount(match[1]);
  return count ? { count } : null;
}

export function taskflowPersonTasksCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowPersonTasks | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (MY_TASKS_RE.test(message.text)) {
    return { personName: message.sender || 'usuário', self: true };
  }
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
  if (!STANDALONE_ACTIVITY_RE.test(message.text)) return null;
  if (extractTaskId(message.text) && !ZERO_PADDED_PROJECT_CODE_RE.test(message.text)) return null;
  return { text: message.text, contextHints: taskflowStandaloneActivityContextHints(message.text, messages) };
}

export function taskflowBareResolvedPrompt(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowBareResolved | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (!BARE_RESOLVED_RE.test(message.text)) return null;
  return { senderName: message.sender };
}

function storedMessageText(rawContent: string): string {
  const content = parseJsonContent(rawContent);
  if (typeof content.text === 'string') return content.text;
  if (typeof content.message === 'string') return content.message;
  return rawContent;
}

function latestMissingTaskId(recentOutboundContents: string[]): string | null {
  for (const raw of recentOutboundContents) {
    const text = storedMessageText(raw);
    const match =
      text.match(/\b(?:N[aã]o encontrei|Task not found:)\s*((?:T|P|M|R)\d+(?:\.\d+)?)/iu) ??
      text.match(/\b((?:T|P|M|R)\d+(?:\.\d+)?)\b[\s\S]{0,80}\b(?:n[aã]o encontr|n[aã]o existe|Task not found)\b/iu);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

function isShortLookupPhrase(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (/[?？]/.test(trimmed)) return false;
  if (/^(quadro|status|inbox|ajuda|comandos|help|manual|guia r[aá]pido)$/iu.test(trimmed)) return false;
  const tokens = trimmed.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return tokens.length >= 1 && tokens.length <= 6;
}

export function taskflowMissingTaskFollowupCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentOutboundContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowMissingTaskFollowup | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (extractTaskId(message.text)) return null;
  const missingTaskId = latestMissingTaskId(recentOutboundContents);
  if (!missingTaskId) return null;
  const text = message.text.trim();
  if (/^(sim|s|pode|confirma|confirmo|isso|ok)$/iu.test(text)) {
    return { missingTaskId, text, confirmationOnly: true };
  }
  if (!isShortLookupPhrase(text)) return null;
  return { missingTaskId, text, confirmationOnly: false };
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
  const isoTime = rawPrompt.match(/\btime="(\d{4}-\d{2}-\d{2})T/)?.[1];
  if (isoTime) return isoTime;
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

function orgMeetingDraftFromText(
  text: string,
  contextDate: string | null,
): TaskflowOrgMeetingDraftPrompt | null {
  const match = text.match(ORG_MEETING_WEEKDAY_RE);
  if (!match?.[1] || !match[2] || !match[3] || !match[5] || !match[6] || !contextDate) return null;
  const scheduledAt = nextWeekdayLocalIso(contextDate, match[1], match[3], match[4]);
  if (!scheduledAt) return null;
  const location = match[2].trim();
  const project = match[5].trim();
  const participantName = cleanupDestinationName(match[6]);
  if (!participantName) return null;
  return {
    title: `Reunião ${location} — ${project}`,
    scheduledAt,
    participantName,
    location,
  };
}

export function taskflowOrgMeetingDraftPrompt(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowOrgMeetingDraftPrompt | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;

  const contextDate = baseDateFromMessage(messages[0]);
  const direct = orgMeetingDraftFromText(message.text, contextDate);
  if (direct) return direct;

  const followup = message.text.match(ORG_MEETING_PERSON_FOLLOWUP_RE);
  if (!followup?.[1]) return null;
  const followupName = cleanupDestinationName(followup[1]);
  if (!followupName) return null;
  for (const content of recentContents) {
    const previous = meetingConfirmationFromText(outboundText(content), contextDate);
    const previousName = normalizeBoardHint(previous?.participantName ?? '').replace(/z/g, 's');
    const requestedName = normalizeBoardHint(followupName).replace(/z/g, 's');
    if (previous && previousName.includes(requestedName)) {
      return {
        title: previous.title,
        scheduledAt: previous.scheduledAt,
        participantName: previous.participantName,
        location: '',
      };
    }
  }
  return null;
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

export function taskflowAddExternalParticipantToLatestMeetingCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowAddExternalParticipantToLatestMeeting | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (extractTaskId(message.text)) return null;
  const match = message.text.match(EXTERNAL_PARTICIPANT_FOLLOWUP_RE);
  if (!match?.[1] || !match[2]) return null;
  const taskId = latestMeetingTaskIdFromContents(recentContents);
  if (!taskId) return null;
  const participantName = cleanupDestinationName(match[1]).trim();
  if (!participantName) return null;
  return {
    taskId,
    participantName,
    phone: match[2].trim(),
  };
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

function normalizeMeetingTitleFromConfirmation(rawTitle: string): string {
  return normalizeMeetingTitle(rawTitle).replace(/^Reuni[aã]o\s+n[ao]\s+/iu, 'Reunião ');
}

function meetingConfirmationFromText(
  text: string,
  contextDate: string | null,
): TaskflowOrgMeetingCreateForwardConfirmation | null {
  if (!/\bCrio\s+assim\?/iu.test(text)) return null;
  if (!/\b(?:est[aá]\s+na\s+organiza[cç][aã]o|quadro\s+pr[oó]prio)\b/iu.test(text)) return null;
  const titleMatch = text.match(/\*\s*(Reuni[aã]o[^\n*]+?)\s*\*/iu);
  const participantMatch = text.match(/Participantes?:\*\s*([^\n]+)/iu);
  const whenMatch = text.match(/Quando:\*\s*(?:[\p{L}\p{M}-]+,\s*)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:às|as)\s*(\d{1,2})(?::|h)?(\d{2})?/iu);
  if (!titleMatch?.[1] || !participantMatch?.[1] || !whenMatch?.[1] || !whenMatch[2] || !whenMatch[4]) {
    return null;
  }

  const year = whenMatch[3] ?? contextDate?.slice(0, 4);
  if (!year) return null;
  const participantName = cleanupDestinationName(participantMatch[1].replace(/\s*\(.+?\)\s*$/u, '').trim());
  if (!participantName) return null;
  return {
    title: normalizeMeetingTitleFromConfirmation(titleMatch[1]),
    scheduledAt: scheduledAtLocalIso(whenMatch[1], whenMatch[2], year, whenMatch[4], whenMatch[5]),
    participantName,
  };
}

export function taskflowOrgMeetingCreateForwardConfirmation(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  recentContents: string[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowOrgMeetingCreateForwardConfirmation | null {
  const confirmationMessage = latestBareConfirmationMessage(messages);
  if (!taskflowEnabled || !confirmationMessage) return null;
  const contextDate = baseDateFromMessage(confirmationMessage);
  for (const content of recentContents) {
    const action = meetingConfirmationFromText(outboundText(content), contextDate);
    if (action) return action;
  }
  return null;
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

export function taskflowProjectReportCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowProjectReport | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (PROJECTS_LIST_RE.test(message.text)) return { query: 'projects' };
  if (PROJECT_NEXT_ACTIONS_REPORT_RE.test(message.text)) return { query: 'project_next_actions' };
  if (PROJECT_NOTES_REPORT_RE.test(message.text)) return { query: 'projects_detailed' };
  return null;
}

export function taskflowProjectTitleLookupCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowProjectTitleLookup | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(PROJECT_TITLE_LOOKUP_RE);
  const title = match?.[1]?.trim();
  return title ? { title } : null;
}

export function taskflowProjectExistenceLookupCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowProjectExistenceLookup | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(PROJECT_EXISTENCE_LOOKUP_RE);
  const searchText = match?.[1]?.trim();
  return searchText ? { searchText } : null;
}

export function taskflowOrgDirectoryQuestionCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowOrgDirectoryQuestion | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const directoryMatch = message.text.match(ORG_DIRECTORY_RE);
  if (directoryMatch?.[1]) {
    const noun = directoryMatch[1].toLowerCase();
    return { kind: noun.includes('cargo') ? 'roles' : 'sectors' };
  }

  const personMatch = message.text.match(ORG_PERSON_FOLLOWUP_RE);
  const personName = personMatch?.[1]?.trim();
  if (!personName) return null;
  if (/^(amanh[aã]|hoje|depois|isso|esse|essa|ele|ela|eles|elas)$/iu.test(personName)) return null;
  return { kind: 'person', personName };
}

export function taskflowExactTaskNextActionUpdateCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowExactTaskNextActionUpdate | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const match = message.text.match(EXACT_TASK_NEXT_ACTION_RE);
  if (!match?.[1] || !match[2]) return null;
  const taskId = match[1].toUpperCase();
  const nextAction = match[2].trim();
  if (!NEXT_ACTION_START_RE.test(nextAction)) return null;
  if (COMPLETE_VERB_RE.test(nextAction) || /\b(?:aguardando|parad[ao]|cancelad[ao]|prazo|vencimento)\b/iu.test(nextAction)) {
    return null;
  }
  return { taskId, nextAction };
}

export function taskflowProjectNoteUpdateCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowProjectNoteUpdate | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  if (/[?？]/.test(message.text) || extractTaskId(message.text)) return null;
  if (!/\b(?:faremos|vamos|previst[ao]s?|marcad[ao]s?|agendad[ao]s?|migra[cç][aã]o|lan[cç]amento)\b/iu.test(message.text)) {
    return null;
  }
  return { text: message.text.trim() };
}

export function taskflowBoardPersonPlacementCommand(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  taskflowEnabled = Boolean(process.env.NANOCLAW_TASKFLOW_BOARD_ID),
): TaskflowBoardPersonPlacement | null {
  if (!taskflowEnabled || messages.length !== 1) return null;
  const message = parseSingleChat(messages[0]);
  if (!message) return null;
  const placements: TaskflowBoardPersonPlacement['placements'] = [];
  for (const match of message.text.matchAll(BOARD_PERSON_PLACEMENT_RE)) {
    if (!match[1] || !match[2]) continue;
    placements.push({
      personName: match[1].replace(/^(?:e\s+)?(?:o|a)\s+/iu, '').trim(),
      boardHint: match[2].trim(),
    });
  }
  return placements.length > 0 ? { placements } : null;
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

function contextSearchText(content: string): string {
  const parsed = parseJsonContent(content);
  const parts: string[] = [];
  if (typeof parsed.text === 'string') parts.push(parsed.text);
  if (typeof parsed.phase2RawPrompt === 'string') parts.push(parsed.phase2RawPrompt);
  return parts.length > 0 ? parts.join('\n') : outboundText(content);
}

function currentTaskflowBoardId(messages?: Pick<MessageInRow, 'content'>[]): string | null {
  const fromEnv = process.env.NANOCLAW_TASKFLOW_BOARD_ID?.trim();
  if (fromEnv) return fromEnv;
  for (const message of messages ?? []) {
    const parsed = parseJsonContent(message.content);
    const fromContent =
      typeof parsed.taskflowBoardId === 'string' ? parsed.taskflowBoardId.trim()
        : typeof parsed.phase3TaskflowBoardId === 'string' ? parsed.phase3TaskflowBoardId.trim()
          : '';
    if (fromContent.startsWith('board-')) return fromContent;
  }
  try {
    const local = fs.existsSync(TASKFLOW_CLAUDE_LOCAL_PATH)
      ? fs.readFileSync(TASKFLOW_CLAUDE_LOCAL_PATH, 'utf8')
      : fs.readFileSync('/workspace/agent/CLAUDE.md', 'utf8');
    const match =
      local.match(/Board ID for this board:\s*`([^`]+)`/i) ??
      local.match(/\bBoard ID:\s*`([^`]+)`/i);
    const boardId = match?.[1]?.trim();
    return boardId && boardId.startsWith('board-') ? boardId : null;
  } catch {
    return null;
  }
}

function pendingChildBoardDivision(text: string): string | null {
  const patterns = [
    /\bcriar\s+quadro[\s\S]{0,120}?\bnome\s+([^\n?.!]+?)(?:\s*$|[?.!])/iu,
    /\bquadro\s+([A-Z0-9ÁÉÍÓÚÇÃÕÂÊÔ][\p{L}\p{M}0-9&/ -]{2,80}?)\s*(?:-\s*TaskFlow)?(?:\s+(?:foi|est[aá]|ser[aá]|sendo|preciso)|[?.!,\n]|$)/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const cleaned = match[1]
      .replace(/\s*-\s*TaskFlow\s*$/iu, '')
      .replace(/^o\s+nome\s+/iu, '')
      .trim();
    if (cleaned.length >= 2) return cleaned;
  }
  return null;
}

function slugForBoardFolder(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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

function latestBareConfirmationMessage(
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
): Pick<MessageInRow, 'kind' | 'content'> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = parseSingleChat(messages[i]);
    if (message && BARE_CONFIRMATION_RE.test(message.text)) return messages[i];
  }
  return null;
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

function appendMcpEquivalentToolCapture(name: string, input: unknown, output: unknown, isError = false): void {
  // Deterministic TaskFlow routes call TaskflowEngine directly; this records
  // the equivalent MCP surface so Phase replay can compare observable tools.
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

function normalizeReadyForReviewNote(raw: string): string {
  let text = raw.trim().replace(/\s+/g, ' ');
  text = text.replace(/\bGabinete\s*[-–—]\s*(BA-\d+)\b/iu, 'Gabinete. Processo: $1');
  text = text.replace(/\s*[-–—]\s*(BA-\d+)\b/iu, '. Processo: $1');
  if (!/[.!?]$/.test(text)) text += '.';
  return text;
}

function mutationSenderForTask(
  engine: TaskflowEngine,
  sender: string,
  queryResult: { data?: unknown },
): string {
  if (engine.resolvePerson(sender)) return sender;
  const data = queryResult.data as Record<string, unknown> | undefined;
  const task = data?.task as Record<string, unknown> | undefined;
  const assignee = typeof task?.assignee === 'string'
    ? task.assignee
    : typeof data?.assignee === 'string'
      ? data.assignee
      : null;
  return assignee || sender;
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
  appendMcpEquivalentToolCapture('api_move', moveInput, moveResult, !moveResult.success);
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
  appendMcpEquivalentToolCapture('api_update_task', updateInput, updateResult, !updateResult.success);
  if (!updateResult.success) {
    writeReply(routing, `Reabri ${action.taskId}, mas não consegui exigir aprovação: ${updateResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const title = typeof updateResult.title === 'string' ? ` — ${updateResult.title}` : '';
  writeReply(routing, `✅ *${action.taskId}*${title}\n\nReabri a tarefa e ativei a aprovação obrigatória.`);
  return true;
}

function handleTaskflowMissingExactIdNote(
  action: TaskflowExactIdNoteCandidate,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  if (engine.getTask(action.taskId)) return false;

  const queryInput = { query: 'find_task_in_organization', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
  const orgRows = Array.isArray(queryResult.data) ? queryResult.data as Array<Record<string, unknown>> : [];

  if (orgRows.length > 0) {
    const noteInput = {
      task_id: action.taskId,
      sender_name: sender,
      text: action.noteText,
    };
    const noteResult = engine.apiAddNote({ ...noteInput, board_id: boardId });
    appendMcpEquivalentToolCapture('api_task_add_note', noteInput, noteResult, !noteResult.success);

    if (noteResult.success) {
      let reassignResult: ReassignResult | null = null;
      if (action.reassignTarget) {
        const reassignInput = {
          task_id: action.taskId,
          target_person: action.reassignTarget,
          sender_name: sender,
          confirmed: true,
        };
        reassignResult = engine.reassign({ ...reassignInput, board_id: boardId });
        const alreadyAssigned = !reassignResult.success && /already assigned/i.test(reassignResult.error ?? '');
        appendMcpEquivalentToolCapture('api_reassign', reassignInput, reassignResult, !reassignResult.success && !alreadyAssigned);
      }

      const data = (noteResult as any).data as Record<string, any> | undefined;
      const boardCode = typeof data?.board_code === 'string' && data.board_code ? `${data.board_code}-` : '';
      const displayId = `${boardCode}${String(data?.id ?? action.taskId)}`;
      const title = typeof data?.title === 'string' ? ` — ${data.title}` : '';
      const noteChange = Array.isArray((noteResult as any).changes) ? String((noteResult as any).changes[0] ?? '') : '';
      const noteLine = /Nota já existente/i.test(noteChange)
        ? `• Nota já existente: ${action.noteText}`
        : `• Nota registrada: ${action.noteText}`;
      const lines = [`✅ *${displayId}*${title}`, '━━━━━━━━━━━━━━', '', noteLine];

      if (action.reassignTarget && reassignResult) {
        if (reassignResult.success) {
          lines.push(`• 👤 Reatribuída para ${action.reassignTarget}`);
        } else if (/already assigned/i.test(reassignResult.error ?? '')) {
          lines.push(`• 👤 Já estava atribuída para ${action.reassignTarget}`);
        } else {
          lines.push(`• Reatribuição não aplicada: ${reassignResult.error ?? 'erro desconhecido'}`);
        }
      }

      writeReply(routing, lines.join('\n'));
      return true;
    }

    const row = orgRows[0] ?? {};
    const boardLabel = String(row.board_short_code ?? row.board_group_folder ?? row.board_id ?? 'outro quadro');
    writeReply(
      routing,
      `Encontrei *${action.taskId}* no quadro ${boardLabel}, mas não consegui registrar a nota por aqui: ${noteResult.error ?? 'erro desconhecido'}`,
    );
    return true;
  }

  writeReply(
    routing,
    `Não encontrei uma tarefa *${action.taskId}* neste quadro. Recebi a atualização "${action.noteText}", mas preciso que você confirme o ID correto antes de registrar em outra tarefa.`,
  );
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
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);

  const updateInput = {
    task_id: action.taskId,
    sender_name: sender,
    confirmed_task_id: action.taskId,
    updates: { requires_close_approval: true },
  };
  const updateResult = engine.update({ ...updateInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_update_task', updateInput, updateResult, !updateResult.success);
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
  appendMcpEquivalentToolCapture('api_move', moveInput, moveResult, !moveResult.success);
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
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
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

export function formatFortalezaDateTimePt(iso: string): string {
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

/**
 * FU-1: the org-meeting create/draft/forward flow carries a NAIVE Fortaleza-local
 * scheduled time (`scheduledAtLocalIso`, no TZ designator). The two formatters above
 * do `new Date(iso) - 3h`, which renders the correct Fortaleza wall-clock ONLY when
 * `iso` is a UTC string (`new Date('…Z')` is host-independent) OR the host is in
 * Fortaleza; for a naive string on a non-Fortaleza host, `new Date()` uses the host
 * zone and the displayed hour is 3h off. The engine STORES the UTC value (so
 * meetingTaskSummary + reschedule already pass UTC) — only the confirmation cards
 * format the pre-engine naive value. Interpret it as Fortaleza (GMT-3, no DST) and
 * emit a UTC iso so the formatters render the right wall-clock on any host
 * (byte-identical on a Fortaleza host).
 */
export function fortalezaNaiveToUtcIso(naive: string): string {
  return new Date(`${naive}-03:00`).toISOString();
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
  appendMcpEquivalentToolCapture('api_create_meeting_task', input, result, !result.success);
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
      appendMcpEquivalentToolCapture('api_admin', adminInput, adminResult, !adminResult.success);
      if (adminResult.success) parentLine = `\n📁 *Projeto:* ${parentId} — ${action.parentProjectTitle}`;
    }
  }
  writeReply(
    routing,
    `✅ *Reunião criada*\n━━━━━━━━━━━━━━\n\n*${taskId}* — ${action.title}${parentLine}\n📅 *Data:* ${formatFortalezaDateTimePt(fortalezaNaiveToUtcIso(action.scheduledAt))}\n⏭️ *Coluna:* Próximas Ações`,
  );
  return true;
}

function openMinuteText(item: Record<string, unknown>): string {
  return typeof item.text === 'string' ? item.text.trim() : '';
}

function openMinuteAuthor(item: Record<string, unknown>): string | null {
  const author = typeof item.author_display_name === 'string' ? item.author_display_name
    : typeof item.by === 'string' ? item.by
      : null;
  return author?.trim() || null;
}

function formatOpenMinutesPrompt(taskId: string, result: { data?: unknown }): string {
  const data = result.data && typeof result.data === 'object'
    ? result.data as { grouped?: unknown; open_items?: unknown }
    : {};
  const grouped = Array.isArray(data.grouped)
    ? data.grouped as Array<{ item?: Record<string, unknown>; replies?: Array<Record<string, unknown>> }>
    : [];
  const openItems = Array.isArray(data.open_items) ? data.open_items as Array<Record<string, unknown>> : [];
  const rows = grouped.length > 0
    ? grouped
    : openItems.map((item) => ({ item, replies: [] as Array<Record<string, unknown>> }));
  if (rows.length === 0) return `Não há itens em aberto na ata de ${taskId}.`;

  const lines = [
    rows.length === 1
      ? `Há 1 item em aberto na ata da ${taskId}:`
      : `Há ${rows.length} itens em aberto na ata da ${taskId}:`,
    '',
  ];
  for (const row of rows) {
    if (!row.item) continue;
    const noteId = typeof row.item.id === 'number' || typeof row.item.id === 'string' ? row.item.id : '?';
    const text = openMinuteText(row.item);
    const phase = row.item.phase === 'pre' ? 'pré-reunião' : row.item.phase === 'post' ? 'pós-reunião' : null;
    const author = openMinuteAuthor(row.item);
    lines.push(`*#${noteId}* — "${text}"`);
    if (phase || author) lines.push(`_(${[phase, author ? `por ${author}` : null].filter(Boolean).join(', ')})_`);
    for (const reply of row.replies ?? []) {
      const replyText = openMinuteText(reply);
      if (replyText) lines.push(`   → ${replyText}`);
    }
    lines.push('');
  }
  lines.push(
    'O que fazer com esse item?',
    '• *tarefa* — criar tarefa para acompanhar',
    '• *inbox* — capturar no inbox para decidir depois',
    '• *resolvido* — marcar como concluído',
    '• *descartar* — ignorar',
  );
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function handleTaskflowProcessMinutes(
  action: TaskflowProcessMinutes,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = currentTaskflowBoardId(messages);
  if (!boardId) return false;
  const sender = senderName(messages);
  const input = {
    action: 'process_minutes' as const,
    task_id: action.taskId,
    sender_name: sender,
  };
  const result = new TaskflowEngine(getTaskflowDb(), boardId).admin({ ...input, board_id: boardId });
  appendMcpEquivalentToolCapture('api_admin', input, result, !result.success);
  if (!result.success) {
    writeReply(routing, `Não consegui processar a ata de ${action.taskId}: ${result.error ?? 'erro desconhecido'}`);
    return true;
  }
  writeReply(routing, formatOpenMinutesPrompt(action.taskId, result));
  return true;
}

function formatTaskflowOrgMeetingDraftPrompt(action: TaskflowOrgMeetingDraftPrompt): string {
  const when = formatFortalezaMeetingWhen(fortalezaNaiveToUtcIso(action.scheduledAt)).replace(/(\d{2})h$/, '$1:00');
  const location = action.location ? `\n• *Local/contexto:* ${action.location}` : '';
  return [
    `${action.participantName} está na organização e tem quadro próprio. Posso criar a reunião sem adicioná-la diretamente neste quadro e encaminhar os detalhes para o quadro dela?`,
    '',
    'A reunião ainda não foi criada. Confirmo os dados:',
    '',
    `📅 *${action.title}*`,
    `• *Quando:* ${when}`,
    `• *Participantes:* ${action.participantName}`,
    `${location}`,
    '',
    'Crio assim?',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

function handleTaskflowOrgMeetingDraftPrompt(
  action: TaskflowOrgMeetingDraftPrompt,
  routing: RoutingContext,
): boolean {
  writeReply(routing, formatTaskflowOrgMeetingDraftPrompt(action));
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
    appendMcpEquivalentToolCapture('api_update_task', input, result, !result.success);
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

function handleTaskflowAddExternalParticipantToLatestMeeting(
  action: TaskflowAddExternalParticipantToLatestMeeting,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const phone = normalizePhone(action.phone) || action.phone;
  const input = {
    task_id: action.taskId,
    sender_name: sender,
    updates: {
      add_external_participant: {
        name: action.participantName,
        phone,
      },
    },
  };
  const result = engine.update({ ...input, board_id: boardId });
  appendMcpEquivalentToolCapture('api_update_task', input, result, !result.success);
  if (!result.success) {
    writeReply(
      routing,
      `Não consegui adicionar ${action.participantName} em ${action.taskId}: ${result.error ?? 'erro desconhecido'}`,
    );
    return true;
  }
  writeReply(
    routing,
    `✅ *${action.taskId}* atualizada\n\n• ${action.participantName} adicionado(a) como participante externo (${phone})`,
  );
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
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
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
      appendMcpEquivalentToolCapture('api_update_task', updateInput, updateResult, !updateResult.success);
    }
    const text = `Olá, ${recipient}! ${sender} pediu para te avisar sobre a seguinte reunião:\n\n📅 *${title}*\n${when}`;
    sendToDestination(dest, text, routing);
    appendMcpEquivalentToolCapture('send_message', { to: dest.name, text }, { success: true });
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
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
  if (!queryResult.success) {
    writeReply(routing, `Não consegui consultar ${action.taskId}: ${queryResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const { formatted } = meetingTaskSummary(queryResult.data, action.taskId);
  const forwardText = `Olá, ${action.destinationName}! ${sender} pediu para encaminhar os detalhes desta reunião:\n\n${formatted}`;
  sendToDestination(dest, forwardText, routing);
  appendMcpEquivalentToolCapture('send_message', { to: dest.name, text: forwardText }, { success: true });

  const prompt = `Enviar para ${action.destinationName} os detalhes de novas reuniões da SECI quando forem criadas ou reagendadas.`;
  const processAfter = nextLocalMorningIso();
  const recurrence = '0 9 * * 1-5';
  writeScheduleTaskAction(routing, prompt, processAfter, recurrence);
  appendMcpEquivalentToolCapture('schedule_task', { prompt, processAfter, recurrence }, { success: true });
  writeReply(routing, `Combinado. Encaminhei ${action.taskId} para ${action.destinationName} e agendei o acompanhamento das novas reuniões.`);
  return true;
}

function findOrgPersonDestination(
  boardId: string,
  personName: string,
): { dest: DestinationEntry; phoneMasked: string | null } | null {
  const existing = findDestinationByDisplayName(personName);
  if (existing) return { dest: existing, phoneMasked: null };

  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const result = engine.query({ query: 'find_person_in_organization', search_text: personName });
  if (!result.success || !Array.isArray(result.data)) return null;
  const target = normalizeBoardHint(personName);
  const rows = result.data as Array<Record<string, unknown>>;
  const exactMatches = rows.filter((row) => {
    const name = normalizeBoardHint(String(row.name ?? ''));
    const personId = normalizeBoardHint(String(row.person_id ?? ''));
    return name.includes(target) || personId.includes(target);
  });
  const matches = exactMatches.length > 0 ? exactMatches : rows;
  if (matches.length === 0) return null;
  const preferred = matches.find((row) => row.is_owner === true) ?? matches[0];
  const routingJid = String(preferred.routing_jid ?? '').trim();
  if (!routingJid) return null;
  const folder = String(preferred.board_group_folder ?? personName).trim() || personName;
  return {
    dest: {
      name: folder,
      displayName: String(preferred.name ?? personName),
      type: 'channel',
      channelType: 'whatsapp',
      platformId: routingJid,
    },
    phoneMasked: typeof preferred.phone_masked === 'string' && preferred.phone_masked ? preferred.phone_masked : null,
  };
}

function handleTaskflowOrgMeetingCreateForwardConfirmation(
  action: TaskflowOrgMeetingCreateForwardConfirmation,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  const destination = findOrgPersonDestination(boardId, action.participantName);
  if (!destination) {
    writeReply(
      routing,
      `Confirmei a reunião, mas não encontrei um quadro/destino ativo para ${action.participantName}. A reunião ainda não foi criada; preciso do destino correto para encaminhar os detalhes.`,
    );
    return true;
  }

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const createInput = {
    type: 'meeting' as const,
    title: action.title,
    scheduled_at: action.scheduledAt,
    sender_name: sender,
  };
  const createResult = engine.create({ ...createInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_create_meeting_task', createInput, createResult, !createResult.success);
  if (!createResult.success) {
    writeReply(routing, `Não consegui criar a reunião: ${createResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const taskId = typeof createResult.task_id === 'string'
    ? createResult.task_id
    : typeof createResult.id === 'string'
      ? createResult.id
      : 'reunião';
  const participantName = destination.dest.displayName || action.participantName;
  const when = formatFortalezaMeetingWhen(fortalezaNaiveToUtcIso(action.scheduledAt));
  const forwardText = `Olá, ${participantName}! ${sender} pediu para encaminhar os detalhes desta reunião:\n\n📅 *${action.title}*\n${when}`;
  sendToDestination(destination.dest, forwardText, routing);
  appendMcpEquivalentToolCapture('send_message', { to: destination.dest.name, text: forwardText }, { success: true });

  const noteText = `Convite encaminhado para ${participantName} no quadro ${destination.dest.name}.`;
  const noteInput = {
    task_id: taskId,
    sender_name: sender,
    updates: { add_note: noteText },
  };
  const noteResult = engine.update({ ...noteInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_update_task', noteInput, noteResult, !noteResult.success);

  const phone = destination.phoneMasked ? ` (${destination.phoneMasked})` : '';
  writeReply(
    routing,
    `✅ *Reunião criada*\n━━━━━━━━━━━━━━\n\n*${taskId}* — ${action.title}\n📅 ${formatFortalezaDateTimePt(fortalezaNaiveToUtcIso(action.scheduledAt))}\n\n${participantName} tem quadro próprio na organização, então não pude adicioná-la diretamente como participante aqui — enviei o convite para o quadro dela${phone}. Uma nota foi registrada na reunião.`,
  );
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
  appendMcpEquivalentToolCapture('api_update_task', participantInput, participantResult, !participantResult.success);

  const scheduleInput = {
    task_id: action.meetingTaskId,
    sender_name: sender,
    updates: { scheduled_at: scheduledAt },
  };
  const scheduleResult = engine.update({ ...scheduleInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_update_task', scheduleInput, scheduleResult, !scheduleResult.success);

  const queryInput = { query: 'task_details', task_id: action.meetingTaskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);

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
  appendMcpEquivalentToolCapture('api_move', moveInput, moveResult, !moveResult.success);
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

export function formatReassignReply(
  result: ReassignResult,
  taskId: string,
  targetPerson: string,
  info?: ReassignTaskInfo | null,
): string {
  const tasks = result.tasks_affected ?? [];
  if (typeof result.formatted === 'string' && result.formatted.trim()) return `✅ ${result.formatted}`;
  if (tasks.length === 1) {
    // Phase-3 Turn-37: a single task with a resolvable parent gets the v2-coherent
    // RICH card (same as the MCP path's buildReassignCard). This is the emitter
    // users actually hit for "atribuir <id> para <X>" — see handleTaskflowExplicitReassign.
    const rich = buildReassignCard({
      id: tasks[0].task_id ?? taskId,
      title: tasks[0].title,
      parentId: info?.parent_task_id,
      parentTitle: info?.parent_task_title,
      dueDate: info?.due_date,
      assignee: targetPerson,
      fromAssignee: info?.from_assignee,
    });
    if (rich) return rich;
    return `✅ *${tasks[0].task_id ?? taskId}* — ${tasks[0].title}\n\nReatribuída para ${targetPerson}.`;
  }
  if (tasks.length > 1) {
    return [
      `✅ ${tasks.length} tarefas reatribuídas para ${targetPerson}:`,
      '',
      ...tasks.map((task) => `• *${task.task_id}* — ${task.title}`),
    ].join('\n');
  }
  return `✅ *${taskId}* reatribuída para ${targetPerson}.`;
}

export function formatTaskflowReassignFailureReply(taskId: string, targetPerson: string, error?: string): string {
  if (error && /Cannot reassign completed task/i.test(error)) {
    return `${taskId} já está concluída e não pode ser reatribuída. Deseja que eu crie uma nova tarefa para ${targetPerson} com o mesmo conteúdo?`;
  }
  return `Não consegui reatribuir ${taskId}: ${error ?? 'erro desconhecido'}`;
}

function handleTaskflowExplicitReassign(
  action: TaskflowExplicitReassign,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const candidatePeople = engine.resolvePersonCandidates(action.targetPerson);
  if (!engine.resolvePerson(action.targetPerson) && candidatePeople.length > 1) {
    writeReply(routing, personAmbiguityReply(action.targetPerson, candidatePeople) ?? `Qual ${action.targetPerson}?`);
    return true;
  }

  const target = engine.resolvePerson(action.targetPerson)?.name ?? action.targetPerson;
  // Capture the pre-reassign assignee NAME for the De/Para card variant — getTask
  // post-commit returns the NEW assignee. resolvePerson resolves a person_id.
  let fromAssignee: string | undefined;
  try {
    const pre = engine.getTask(action.taskId);
    if (pre?.assignee) fromAssignee = engine.resolvePerson(pre.assignee)?.name ?? undefined;
  } catch {
    /* best-effort — fall back to short card if unavailable */
  }
  const reassignInput = {
    task_id: action.taskId,
    target_person: action.targetPerson,
    sender_name: sender,
    confirmed: true,
  };
  const reassignResult = engine.reassign({ ...reassignInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_reassign', reassignInput, reassignResult, !reassignResult.success);

  if (!reassignResult.success) {
    if (reassignResult.offer_register?.message) {
      writeReply(routing, reassignResult.offer_register.message);
      return true;
    }
    writeReply(routing, formatTaskflowReassignFailureReply(action.taskId, target, reassignResult.error));
    return true;
  }

  // Resolve the single task's parent + due_date (+ the pre-captured from_assignee)
  // so the reply can render the rich card (Phase-3 Turn-37 / De-Para). The same
  // buildReassignInfo the MCP path uses: gated off in the tf-mcontrol subprocess
  // and fail-soft — the mutation has already committed, so a lookup throw degrades
  // to the short card and never loses the user's confirmation.
  const affected = reassignResult.tasks_affected ?? [];
  const info = affected.length === 1 ? buildReassignInfo(engine, affected[0].task_id ?? action.taskId, fromAssignee) : null;
  writeReply(routing, formatReassignReply(reassignResult, action.taskId, target, info));
  return true;
}

/**
 * Ack for a successful person registration whose child board is being provisioned
 * asynchronously by the host. Intentionally confirms only the PERSON (which did
 * succeed) and says the board is in progress — it must NOT claim board completion
 * or print a board id, because the board may not exist yet and its final id can
 * differ on a folder collision. The host emits the authoritative confirmation
 * (real id, on success) or a fail-loud alert (on failure).
 */
export function buildPersonRegisteredAck(personName: string, role: string, groupName: string): string {
  const firstName = personName.split(/\s+/)[0] || personName;
  return (
    `✅ *${personName} cadastrado(a)*\n━━━━━━━━━━━━━━\n\n` +
    `👤 *${personName}*\n💼 ${role}\n\n` +
    `O quadro da divisão *${groupName}* está sendo provisionado. ${firstName} receberá o convite pelo WhatsApp, e a confirmação com o quadro chega aqui assim que estiver pronto.`
  );
}

function handleTaskflowPendingChildBoardRegistration(
  action: TaskflowPendingChildBoardRegistration,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = currentTaskflowBoardId(messages);
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const input = {
    action: 'register_person' as const,
    person_name: action.personName,
    phone: action.phone,
    role: action.role,
    group_name: action.groupName,
    group_folder: action.groupFolder,
    sender_name: sender,
  };
  const result = engine.admin({ ...input, board_id: boardId });
  appendMcpEquivalentToolCapture('api_admin', input, result, !result.success);

  if (!result.success) {
    // Surface the api_admin failure verbatim regardless of whether the
    // bridge fallback resolved a board — a board existing for the folder
    // doesn't mean THIS registration succeeded; the engine call's error
    // message is what the operator needs to see.
    writeReply(routing, `Não consegui cadastrar ${action.personName}: ${result.error ?? 'erro desconhecido'}`);
    return true;
  }

  const autoProvision = result.auto_provision_request;
  if (autoProvision) {
    writeMessageOut({
      id: generateId(),
      in_reply_to: routing.inReplyTo,
      kind: 'system',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({ action: 'provision_child_board', ...autoProvision }),
    });
    appendMcpEquivalentToolCapture('provision_child_board', autoProvision, { success: true });
    // The child board is provisioned ASYNCHRONOUSLY by the host. Do NOT claim
    // completion or print a board id here — the host sends the authoritative
    // confirmation (real id) on success, or a fail-loud alert on failure
    // (provision-child-board.ts). An optimistic ack was the Reginaldo
    // announce≠persist + Sanunciel silent-success defect.
    writeReply(routing, buildPersonRegisteredAck(action.personName, action.role, action.groupName));
  } else {
    // Registered, but no child board is being provisioned (e.g. a non-delegating
    // board) — so do NOT promise a board that isn't coming.
    writeReply(routing, `✅ *${action.personName} cadastrado(a)*\n👤 ${action.personName}\n💼 ${action.role}`);
  }
  return true;
}

function handleTaskflowChildBoardCreationPrompt(
  action: TaskflowChildBoardCreationPrompt,
  routing: RoutingContext,
): boolean {
  writeReply(
    routing,
    `Para criar o quadro ${action.groupName}, preciso saber quem será o(a) responsável por ele. Pode me informar:\n\n` +
    '• *Nome completo* da pessoa responsável\n' +
    '• *Telefone* (com DDD)\n' +
    '• *Cargo/função*',
  );
  return true;
}

function handleTaskflowReadyForReviewUpdate(
  action: TaskflowReadyForReviewUpdate,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const queryInput = { query: 'task_details', task_id: action.taskId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
  if (!queryResult.success) {
    writeReply(routing, `Não encontrei ${action.taskId}: ${queryResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const mutationSender = mutationSenderForTask(engine, sender, queryResult);
  const updateInput = {
    task_id: action.taskId,
    sender_name: mutationSender,
    updates: { add_note: action.noteText },
  };
  const updateResult = engine.update({ ...updateInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_update_task', updateInput, updateResult, !updateResult.success);
  if (!updateResult.success) {
    writeReply(routing, `Não consegui registrar a nota em ${action.taskId}: ${updateResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const moveInput = {
    task_id: action.taskId,
    action: 'review' as const,
    sender_name: mutationSender,
    confirmed_task_id: action.taskId,
  };
  const moveResult = engine.move({ ...moveInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_move', moveInput, moveResult, !moveResult.success);
  if (!moveResult.success) {
    writeReply(routing, `Nota registrada em ${action.taskId}, mas não consegui mover para revisão: ${moveResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  const title = typeof moveResult.title === 'string' ? moveResult.title : action.taskId;
  writeReply(
    routing,
    [
      `✅ *${moveResult.task_id ?? action.taskId}* — ${title}`,
      '━━━━━━━━━━━━━━',
      `• Nota registrada: ${action.noteText}`,
      `• ${columnLabelForReply(moveResult.from_column)} → ${columnLabelForReply(moveResult.to_column)}`,
    ].join('\n'),
  );
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

  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);

  if (!queryResult.success) {
    const orgQueryInput = { query: 'find_task_in_organization', task_id: action.taskId, sender_name: sender };
    const orgQueryResult = engine.query(orgQueryInput);
    appendMcpEquivalentToolCapture('api_query', orgQueryInput, orgQueryResult, !orgQueryResult.success);
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

function formatShortDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}` : '';
}

function handleTaskflowRecentInbox(
  action: TaskflowRecentInbox,
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const db = getTaskflowDb();
  const rows = db
    .prepare(
      `SELECT id, title, assignee, created_at
       FROM tasks
       WHERE board_id = ? AND column = 'inbox'
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(boardId, action.count) as Array<{
      id: string;
      title: string | null;
      assignee: string | null;
      created_at: string | null;
    }>;

  const output = { success: true, data: rows };
  appendMcpEquivalentToolCapture(
    'api_query',
    { query: 'filter_board_tasks', column: 'inbox', limit: action.count, order_by: 'created_at_desc' },
    output,
    false,
  );

  if (rows.length === 0) {
    writeReply(routing, 'Não encontrei itens no inbox deste quadro.');
    return true;
  }

  const headerCount = rows.length === action.count ? action.count : rows.length;
  const itemLabel = headerCount === 1 ? 'item' : 'itens';
  const lines = [`📥 *${headerCount} último${headerCount === 1 ? '' : 's'} ${itemLabel} do inbox*`];
  for (const row of rows) {
    const title = row.title?.trim() || row.id;
    const assignee = row.assignee?.trim() ? ` — ${row.assignee.trim()}` : '';
    const created = formatShortDate(row.created_at);
    const date = created ? ` · data ${created}` : '';
    lines.push(`• *${row.id}* — ${title}${assignee}${date}`);
  }
  writeReply(routing, lines.join('\n'));
  return true;
}

function handleTaskflowIncompleteNoteRequest(
  action: TaskflowIncompleteNoteRequest,
  routing: RoutingContext,
): boolean {
  writeReply(routing, `Qual o texto da nota que deseja registrar em ${action.taskId}?`);
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
  const queryInput = action.self
    ? { query: 'my_tasks', sender_name: sender }
    : { query: 'person_tasks', person_name: action.personName, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
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
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
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
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
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
  appendMcpEquivalentToolCapture('api_move', moveInput, moveOutput, failures.length > 0);

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

function handleTaskflowBareResolvedPrompt(
  action: TaskflowBareResolved,
  routing: RoutingContext,
): boolean {
  const firstName = action.senderName.trim().split(/\s+/)[0] || action.senderName;
  writeReply(routing, `Qual tarefa ou assunto foi resolvido, ${firstName}? Assim registro no lugar certo.`);
  return true;
}

function searchTermsForMissingTaskFollowup(text: string): string[] {
  const terms: string[] = [text.trim()];
  const tokens = text.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  for (const token of tokens.sort((a, b) => b.length - a.length)) {
    if (!terms.some((term) => term.toLowerCase() === token.toLowerCase())) terms.push(token);
  }
  return terms.slice(0, 4);
}

function displayTaskIdForBoard(db: ReturnType<typeof getTaskflowDb>, currentBoardId: string, task: any): string {
  const owningBoardId = task?.owning_board_id ?? task?.board_id;
  if (!owningBoardId || owningBoardId === currentBoardId) return String(task?.id ?? '');
  const row = db
    .prepare(`SELECT short_code FROM boards WHERE id = ? LIMIT 1`)
    .get(owningBoardId) as { short_code: string | null } | undefined;
  const shortCode = row?.short_code?.trim();
  return shortCode ? `${shortCode}-${task.id}` : String(task?.id ?? '');
}

function handleTaskflowMissingTaskFollowup(
  action: TaskflowMissingTaskFollowup,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;
  if (action.confirmationOnly) {
    writeReply(routing, `Pode me enviar o título ou mais detalhes da ${action.missingTaskId}? Assim eu busco no quadro e nos vínculos.`);
    return true;
  }

  const sender = senderName(messages);
  const db = getTaskflowDb();
  const engine = new TaskflowEngine(db, boardId, { readonly: true });
  const seen = new Set<string>();
  const matches: any[] = [];
  for (const term of searchTermsForMissingTaskFollowup(action.text)) {
    const input = { query: 'search', search_text: term, sender_name: sender };
    const result = engine.query(input);
    appendMcpEquivalentToolCapture('api_query', input, result, !result.success);
    const rows = Array.isArray(result.data) ? result.data : [];
    for (const row of rows) {
      const key = `${row.board_id ?? boardId}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(row);
    }
    if (matches.length > 0) break;
  }

  if (matches.length === 0) {
    writeReply(
      routing,
      `Não encontrei a ${action.missingTaskId}, nem tarefas relacionadas a "${action.text}". Pode informar o board, responsável ou mais algum trecho do título?`,
    );
    return true;
  }

  const lines = [
    `Entendi. A ${action.missingTaskId} continua não localizada neste board, mas encontrei tarefa(s) relacionada(s) a "${action.text}":`,
    '',
    ...matches.slice(0, 5).map((task) => {
      const id = displayTaskIdForBoard(db, boardId, task);
      const status = task.column === 'done' ? ' — concluída' : task.column ? ` — ${task.column}` : '';
      return `• *${id}* — ${task.title}${status}`;
    }),
    '',
    `O que você precisa fazer com a ${action.missingTaskId} ou com esse assunto?`,
  ];
  writeReply(routing, lines.join('\n'));
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
    appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
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
  appendMcpEquivalentToolCapture('send_message', { to: dest.name, text: forwardText }, { success: true });
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
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
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
  appendMcpEquivalentToolCapture('send_message', { to: dest.name, text: forwardText }, { success: true });
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

function handleTaskflowProjectReport(
  action: TaskflowProjectReport,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: action.query, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
  let text = typeof queryResult.formatted === 'string' && queryResult.formatted.trim()
    ? queryResult.formatted
    : queryResult.success
      ? JSON.stringify(queryResult.data ?? queryResult)
      : `Não consegui gerar o relatório de projetos: ${queryResult.error ?? 'erro desconhecido'}`;
  if (queryResult.success && action.query === 'projects') {
    text = `${text}\n\nDeseja ver as etapas de algum projeto específico?`;
  }
  writeReply(routing, text);
  return true;
}

function formatBoardDirectoryPersonReply(personName: string, rows: unknown): string {
  const matches = Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
  if (matches.length === 0) return `Não encontrei ${personName} na árvore de quadros TaskFlow.`;
  const lines = [`*${personName}* aparece em:`];
  for (const row of matches.slice(0, 12)) {
    const board = String(row.board_group_folder ?? row.board_id ?? 'quadro');
    const owner = row.is_owner ? ' — quadro próprio' : '';
    const phone = typeof row.phone_masked === 'string' && row.phone_masked ? ` (${row.phone_masked})` : '';
    lines.push(`• ${String(row.name ?? personName)} — ${board}${owner}${phone}`);
  }
  if (matches.length > 12) lines.push(`• ... e mais ${matches.length - 12} ocorrência(s).`);
  return lines.join('\n');
}

function formatBoardRolesReply(boardId: string, boards: Array<Record<string, unknown>>): string {
  const boardIds = boards.map((board) => String(board.id ?? '')).filter(Boolean);
  if (boardIds.length === 0) return 'Não encontrei quadros TaskFlow na organização.';
  const placeholders = boardIds.map(() => '?').join(',');
  const rows = getTaskflowDb().prepare(
    `SELECT bp.board_id, bp.name, bp.role, b.short_code, b.group_folder
       FROM board_people bp
       JOIN boards b ON b.id = bp.board_id
      WHERE bp.board_id IN (${placeholders})
      ORDER BY COALESCE(NULLIF(b.short_code, ''), b.group_folder), bp.role, bp.name`,
  ).all(...boardIds) as Array<{ board_id: string; name: string; role: string | null; short_code: string | null; group_folder: string }>;
  if (rows.length === 0) return 'Não há pessoas/cargos cadastrados nos quadros da organização.';

  const currentBoardRows = rows.filter((row) => row.board_id === boardId);
  const source = currentBoardRows.length > 0 ? currentBoardRows : rows;
  const lines = [currentBoardRows.length > 0 ? '*Cargos/papéis cadastrados neste quadro:*' : '*Cargos/papéis cadastrados na organização:*'];
  for (const row of source.slice(0, 30)) {
    const board = row.short_code || row.group_folder.replace(/-?taskflow$/u, '');
    lines.push(`• ${row.role || 'membro'} — ${row.name} (${board})`);
  }
  if (source.length > 30) lines.push(`• ... e mais ${source.length - 30} cadastro(s).`);
  return lines.join('\n');
}

function handleTaskflowOrgDirectoryQuestion(
  action: TaskflowOrgDirectoryQuestion,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = currentTaskflowBoardId(messages);
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  if (action.kind === 'person' && action.personName) {
    const queryInput = { query: 'find_person_in_organization', search_text: action.personName, sender_name: sender };
    const queryResult = engine.query(queryInput);
    appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
    writeReply(
      routing,
      queryResult.success
        ? formatBoardDirectoryPersonReply(action.personName, queryResult.data)
        : `Não consegui consultar ${action.personName}: ${queryResult.error ?? 'erro desconhecido'}`,
    );
    return true;
  }

  const queryInput = { query: 'board_directory', sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
  if (!queryResult.success) {
    writeReply(routing, `Não consegui consultar a organização: ${queryResult.error ?? 'erro desconhecido'}`);
    return true;
  }
  const boards = Array.isArray(queryResult.data) ? queryResult.data as Array<Record<string, unknown>> : [];
  const text = action.kind === 'roles'
    ? formatBoardRolesReply(boardId, boards)
    : typeof queryResult.formatted === 'string' && queryResult.formatted.trim()
      ? queryResult.formatted
      : JSON.stringify(queryResult.data ?? queryResult);
  writeReply(routing, text);
  return true;
}

function handleTaskflowExactTaskNextActionUpdate(
  action: TaskflowExactTaskNextActionUpdate,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = currentTaskflowBoardId(messages);
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId);
  const updateInput = {
    task_id: action.taskId,
    sender_name: sender,
    updates: { next_action: action.nextAction },
  };
  const updateResult = engine.update({ ...updateInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_update_task', updateInput, updateResult, !updateResult.success);
  if (!updateResult.success) {
    writeReply(routing, `Não consegui atualizar ${action.taskId}: ${updateResult.error ?? 'erro desconhecido'}`);
    return true;
  }
  const title = typeof updateResult.title === 'string' ? ` — ${updateResult.title}` : '';
  writeReply(routing, `✅ *${action.taskId}*${title}\n━━━━━━━━━━━━━━\n\n• Próxima ação: ${action.nextAction}`);
  return true;
}

function projectNoteDateText(text: string, messages: Pick<MessageInRow, 'content'>[]): string | null {
  const weekday = text.match(/\b(?:na|no)\s+(segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?\b/iu)?.[1];
  const contextDate = messages[0] ? baseDateFromMessage(messages[0]) : null;
  if (!weekday || !contextDate) return null;
  const localIso = nextWeekdayLocalIso(contextDate, weekday, '0');
  if (!localIso) return null;
  return `${localIso.slice(8, 10)}/${localIso.slice(5, 7)}/${localIso.slice(0, 4)}`;
}

function projectNoteTextForMessage(text: string, projectTitle: string, messages: Pick<MessageInRow, 'content'>[]): string {
  const dateText = projectNoteDateText(text, messages);
  const weekday = text.match(/\b(?:na|no)\s+(segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?\b/iu)?.[1];
  if (/\bmigra[cç][aã]o\b/iu.test(text)) {
    const when = weekday ? `${normalizeWeekdayName(weekday)}-feira${dateText ? `, ${dateText}` : ''}` : 'informada';
    return `Migração dos ${projectTitle} prevista para ${when}.`;
  }
  return text.trim().replace(/[.!?]*$/u, '.');
}

function handleTaskflowProjectNoteUpdate(
  action: TaskflowProjectNoteUpdate,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = currentTaskflowBoardId(messages);
  if (!boardId) return false;

  const sender = senderName(messages);
  const db = getTaskflowDb();
  const normalizedText = normalizeBoardHint(action.text);
  const projects = db.prepare(
    `SELECT id, title FROM tasks
     WHERE board_id = ? AND type = 'project' AND column != 'done'
     ORDER BY length(title) DESC, id`,
  ).all(boardId) as Array<{ id: string; title: string }>;
  const matches = projects.filter((project) => {
    const title = normalizeBoardHint(project.title);
    return title.length >= 4 && normalizedText.includes(title);
  });
  if (matches.length !== 1) return false;

  const project = matches[0];
  const noteText = projectNoteTextForMessage(action.text, project.title, messages);
  const engine = new TaskflowEngine(db, boardId);
  const noteInput = {
    task_id: project.id,
    sender_name: sender,
    text: noteText,
  };
  const noteResult = engine.apiAddNote({ ...noteInput, board_id: boardId });
  appendMcpEquivalentToolCapture('api_task_add_note', noteInput, noteResult, !noteResult.success);
  if (!noteResult.success) {
    writeReply(routing, `Não consegui registrar a nota em ${project.id}: ${noteResult.error ?? 'erro desconhecido'}`);
    return true;
  }

  writeReply(routing, `✅ *${project.id}* atualizado\n━━━━━━━━━━━━━━\n\n• Nota: ${noteText}`);
  return true;
}

function normalizeBoardHint(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function boardIdForHint(boardId: string, hint: string): string | null {
  const target = normalizeBoardHint(hint);
  const slug = target.replace(/\s+/g, '-');
  for (const candidateId of [`board-${slug}-taskflow`, `board-${slug}`]) {
    const row = getTaskflowDb().prepare(`SELECT id FROM boards WHERE id = ? LIMIT 1`).get(candidateId) as { id: string } | undefined;
    if (row?.id) return row.id;
  }

  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const result = engine.query({ query: 'board_directory' });
  if (!result.success || !Array.isArray(result.data)) return null;
  const directoryBoards = result.data as Array<Record<string, unknown>>;
  const dbBoards = getTaskflowDb().prepare(
    `SELECT id, short_code, group_folder FROM boards
      WHERE id = ? OR parent_board_id = (
        SELECT COALESCE(parent_board_id, id) FROM boards WHERE id = ?
      ) OR parent_board_id = ?`,
  ).all(boardId, boardId, boardId) as Array<Record<string, unknown>>;
  const byId = new Map<string, Record<string, unknown>>();
  for (const board of [...directoryBoards, ...dbBoards]) {
    const id = String(board.id ?? '');
    if (id) byId.set(id, board);
  }
  const boards = [...byId.values()];
  const labelsFor = (board: Record<string, unknown>): string[] => [
      board.id,
      board.short_code,
      board.group_folder,
      String(board.group_folder ?? '').replace(/-?taskflow$/u, ''),
    ].map((item) => normalizeBoardHint(String(item ?? ''))).filter(Boolean);
  const exact = boards.filter((board) => labelsFor(board).some((candidate) => candidate === target));
  if (exact.length === 1) return String(exact[0].id);
  const matches = boards.filter((board) =>
    labelsFor(board).some((candidate) => candidate.includes(target) || target.includes(candidate))
  );
  return matches.length === 1 ? String(matches[0].id) : null;
}

function findExistingOrgPerson(boardId: string, personName: string): { person_id: string; name: string; phone: string | null } | null {
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const result = engine.query({ query: 'find_person_in_organization', search_text: personName });
  const target = normalizeBoardHint(personName);
  const matches = result.success && Array.isArray(result.data)
    ? (result.data as Array<Record<string, unknown>>).filter((row) =>
        normalizeBoardHint(String(row.name ?? '')) === target
      )
    : [];
  if (matches.length === 0) {
    const direct = getTaskflowDb().prepare(
      `SELECT person_id, name, phone FROM board_people
       WHERE lower(name) = lower(?)
       ORDER BY board_id = ? DESC, person_id
       LIMIT 1`,
    ).get(personName.trim(), boardId) as { person_id: string; name: string; phone: string | null } | undefined;
    return direct ?? null;
  }
  const preferred = matches.find((row) => row.board_id === boardId) ?? matches.find((row) => row.is_owner) ?? matches[0];
  const personId = String(preferred.person_id ?? '').trim();
  const name = String(preferred.name ?? personName).trim();
  if (!personId || !name) return null;
  const phone = getTaskflowDb().prepare(
    `SELECT phone FROM board_people WHERE person_id = ? AND phone IS NOT NULL AND phone != '' LIMIT 1`,
  ).get(personId) as { phone: string } | undefined;
  return { person_id: personId, name, phone: phone?.phone ?? null };
}

function roleForBoardHint(hint: string): string {
  const normalized = normalizeBoardHint(hint);
  if (normalized.includes('sm')) return 'Scrum Master';
  if (normalized.includes('po')) return 'PO';
  if (normalized.includes('ux')) return 'UX Designer';
  if (normalized.includes('infra')) return 'Devops';
  return hint.trim();
}

function placementAllowsSharedRole(messages: Pick<MessageInRow, 'kind' | 'content'>[]): boolean {
  const text = messages
    .map(parseSingleChat)
    .filter((message): message is { sender: string; text: string } => !!message)
    .map((message) => message.text)
    .join('\n');
  return /\b(?:tamb[eé]m|junto(?:s|as)?|continuam?|os\s+dois|ambos|ambas)\b/iu.test(text);
}

function handleTaskflowBoardPersonPlacement(
  action: TaskflowBoardPersonPlacement,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const sourceBoardId = currentTaskflowBoardId(messages);
  if (!sourceBoardId) return false;

  const db = getTaskflowDb();
  const allowSharedRole = placementAllowsSharedRole(messages);
  const planned: Array<{
    placement: TaskflowBoardPersonPlacement['placements'][number];
    targetBoardId: string;
    personId: string;
    input: { board_id: string; person_id: string; name: string; phone: string | null; role: string };
  }> = [];
  const blockers: string[] = [];
  const successes: string[] = [];
  const failures: string[] = [];

  for (const placement of action.placements) {
    const targetBoardId = boardIdForHint(sourceBoardId, placement.boardHint);
    if (!targetBoardId) {
      failures.push(`${placement.personName}: não encontrei um quadro único para ${placement.boardHint}`);
      continue;
    }
    const person = findExistingOrgPerson(sourceBoardId, placement.personName);
    if (!person) {
      failures.push(`${placement.personName}: não encontrei cadastro existente para reutilizar`);
      continue;
    }
    const personId = person.phone ? person.phone.replace(/[^0-9]/g, '') : person.person_id;
    const input = {
      board_id: targetBoardId,
      person_id: personId,
      name: person.name,
      phone: person.phone,
      role: roleForBoardHint(placement.boardHint),
    };

    const roleOccupants = db.prepare(
      `SELECT name FROM board_people
       WHERE board_id = ? AND lower(role) = lower(?) AND person_id != ?
       ORDER BY name`,
    ).all(targetBoardId, input.role, personId) as Array<{ name: string }>;
    if (roleOccupants.length > 0 && !allowSharedRole) {
      blockers.push(
        `${placement.boardHint}: já consta ${roleOccupants.map((row) => row.name).join(', ')} como ${input.role}. Confirma adicionar ${person.name} também, ou é para substituir?`,
      );
    }

    planned.push({ placement, targetBoardId, personId, input });
  }

  if (blockers.length > 0) {
    const lines = [
      'Antes de alterar os setores, preciso confirmar:',
      '',
      ...blockers.map((line) => `• ${line}`),
    ];
    if (failures.length > 0) {
      lines.push('', 'Também encontrei estas pendências:', ...failures.map((line) => `• ${line}`));
    }
    writeReply(routing, lines.join('\n'));
    return true;
  }

  for (const { placement, targetBoardId, personId, input } of planned) {
    const targetEngine = new TaskflowEngine(db, targetBoardId);
    const existing = db.prepare(
      `SELECT person_id FROM board_people WHERE board_id = ? AND lower(name) = lower(?) AND person_id != ?`,
    ).get(targetBoardId, input.name, personId) as { person_id: string } | undefined;
    if (existing) {
      const removeResult = targetEngine.removeBoardPerson(targetBoardId, existing.person_id, false);
      appendMcpEquivalentToolCapture('api_remove_board_person', { board_id: targetBoardId, person_id: existing.person_id }, removeResult, !removeResult.success);
    }
    const result = targetEngine.addBoardPerson(targetBoardId, input);
    const alreadyExists = !result.success && result.error_code === 'conflict';
    appendMcpEquivalentToolCapture('api_add_board_person', input, result, !result.success && !alreadyExists);
    if (result.success || alreadyExists) {
      successes.push(`${input.name} em ${placement.boardHint} (${input.role})`);
    } else {
      failures.push(`${input.name}: ${result.error ?? 'erro desconhecido'}`);
    }
  }

  const lines: string[] = [];
  if (successes.length > 0) {
    lines.push('✅ Setores atualizados:', '', ...successes.map((line) => `• ${line}`));
  }
  if (failures.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Pendências:', ...failures.map((line) => `• ${line}`));
  }
  writeReply(routing, lines.join('\n') || 'Não encontrei alterações de setor para aplicar.');
  return true;
}

function handleTaskflowProjectTitleLookup(
  action: TaskflowProjectTitleLookup,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const projectId = findProjectIdByTitle(boardId, action.title);
  if (!projectId) {
    writeReply(routing, `Não encontrei um projeto único para "${action.title}".`);
    return true;
  }

  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'task_details', task_id: projectId, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
  const data = queryResult.data as { formatted_task_details?: unknown } | undefined;
  const text = typeof queryResult.formatted === 'string' && queryResult.formatted.trim()
    ? queryResult.formatted
    : typeof data?.formatted_task_details === 'string' && data.formatted_task_details.trim()
      ? data.formatted_task_details
      : queryResult.success
        ? JSON.stringify(queryResult.data ?? queryResult)
        : `Não consegui consultar ${projectId}: ${queryResult.error ?? 'erro desconhecido'}`;
  writeReply(routing, text);
  return true;
}

function parseFirstNoteText(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const notes = JSON.parse(raw);
    if (!Array.isArray(notes)) return null;
    const text = notes.find((note) => typeof note?.text === 'string')?.text;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

function formatTaskflowProjectExistenceReply(searchText: string, rows: Array<Record<string, unknown>>): string {
  const normalizedSearch = normalizeLookupText(searchText);
  const dedicatedProjects = rows.filter((row) =>
    row.type === 'project' && normalizeLookupText(String(row.title ?? '')).includes(normalizedSearch));
  const related = rows.slice(0, 8);
  const lines = dedicatedProjects.length > 0
    ? [`Encontrei projeto(s) dedicado(s) para *${searchText}*:`]
    : [`Não há um projeto dedicado ao *${searchText}* no quadro. Itens relacionados encontrados:`];
  lines.push('');
  for (const row of related) {
    const id = String(row.id ?? '');
    const title = String(row.title ?? '');
    const assignee = row.assignee ? ` — ${String(row.assignee)}` : '';
    const column = row.column ? ` [${String(row.column)}]` : '';
    const due = row.due_date ? `, prazo ${String(row.due_date)}` : '';
    const parent = row.parent_task_id ? ` (subtarefa de *${String(row.parent_task_id)}*)` : '';
    lines.push(`• *${id}* — ${title}${parent}${assignee}${column}${due}`);
    const note = parseFirstNoteText(row.notes);
    if (note) lines.push(`  Nota: ${note}`);
  }
  if (related.length === 0) {
    lines.push('Nenhum item relacionado foi encontrado.');
  }
  if (dedicatedProjects.length === 0) {
    lines.push('', `Quer criar um projeto para organizar as ações de ${searchText}?`);
  }
  return lines.join('\n');
}

function handleTaskflowProjectExistenceLookup(
  action: TaskflowProjectExistenceLookup,
  messages: Pick<MessageInRow, 'kind' | 'content'>[],
  routing: RoutingContext,
): boolean {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId) return false;

  const sender = senderName(messages);
  const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
  const queryInput = { query: 'search', search_text: action.searchText, sender_name: sender };
  const queryResult = engine.query(queryInput);
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);
  const rows = Array.isArray(queryResult.data) ? queryResult.data as Array<Record<string, unknown>> : [];
  const text = queryResult.success
    ? formatTaskflowProjectExistenceReply(action.searchText, rows)
    : `Não consegui buscar projetos relacionados a ${action.searchText}: ${queryResult.error ?? 'erro desconhecido'}`;
  writeReply(routing, text);
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
  appendMcpEquivalentToolCapture('api_query', queryInput, queryResult, !queryResult.success);

  const rows = Array.isArray(queryResult.data) ? queryResult.data as Array<Record<string, unknown>> : [];
  const title = typeof rows[0]?.title === 'string' ? rows[0].title : action.taskId;
  const forwardText = `📝 Nota do ${senderLabel} para ${action.taskId} — ${title}:\n\n"${action.noteText}"`;

  sendToDestination(dest, forwardText, routing);
  appendMcpEquivalentToolCapture('send_message', { to: action.destinationName, text: forwardText }, { success: true });
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
  /** = RunnerConfig.assistantName; 0h-v2 reply `sender_name`. */
  assistantName: string;
  /**
   * = RunnerConfig.agentGroupId; 0h-v2 `source_outbound_id` prefix
   * (globally-unique idempotency key for tf's agent-reply dedupe).
   */
  agentGroupId: string;
}

/**
 * Container-side scheduled-runner gate — the warm-container half of the host sweep gate
 * (src/modules/taskflow/runner-gate-apply.ts). For a TaskFlow session, suppress any due [TF-*]
 * runner whose board state says it should stay silent: mark it completed (so the host syncs the ack
 * and handleRecurrence advances it) and drop it from the batch before this warm container can post
 * it. Without this, a container that polls every second claims the runner before the 60s host sweep
 * gets to gate it. Cheap no-op when no runner is due (one `.some` scan, no DB). Fail-open: a gating
 * error must never silence a board — the runner just fires as it would have without the gate.
 */
export function gateScheduledRunners(messages: MessageInRow[]): MessageInRow[] {
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  if (!boardId || !messages.some(isTfRunnerRow)) return messages;
  // Fresh inbound connection (NOT the cached getInboundDb singleton): the gate reads the host's
  // continuously-written messages_in for the `interactions` signal, and the cached view goes stale
  // across the mount (connection.ts) — a stale read would miss a recent chat and false-suppress an
  // Active board. openInboundDb() is exactly how getPendingMessages reads the same table.
  const inbound = openInboundDb();
  try {
    return applyRunnerGate(
      messages,
      {
        taskflowDb: getTaskflowDb(),
        inboundDb: inbound,
        boardId,
        now: new Date(),
        timeZone: TIMEZONE,
        // Host forwards the group folder so isHolidayExempt can match 'folder'/'folder:kind'
        // against TASKFLOW_HOLIDAY_EXEMPT. Undefined when unset → exempt stays false (unchanged).
        agentGroupFolder: process.env.NANOCLAW_GROUP_FOLDER,
      },
      markCompleted,
    );
  } catch (err) {
    log(`Runner gating skipped (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return messages;
  } finally {
    inbound.close();
  }
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

/**
 * #407: execute admin-approved gated actions queued by the host as `taskflow_execute_approved`
 * system rows. Runs at the top of the poll loop, BEFORE the LLM filter — the mutation re-runs
 * deterministically in code (executeApprovedAction → the original tool handler under the gate
 * bypass), never as a model turn. Only rows whose parsed action matches are consumed; other system
 * rows (e.g. ask_user_question responses) pass through untouched for their own pollers.
 *
 * KNOWN GAP (SEC#9): this runs BEFORE detectWebOrigin/setCurrentWebOrigin, so a replayed mutation's
 * confirmation routes via live session routing, not board_chat. WhatsApp boards are unaffected (session
 * routing IS the board chat); a web-dashboard-origin board's confirmation would misroute. The mutation
 * itself still runs correctly + board-pinned — this is a confirmation-routing gap, tracked in SEC#9.
 */
async function runApprovedActions(rows: MessageInRow[]): Promise<void> {
  for (const row of rows) {
    if (row.kind !== 'system') continue;
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(row.content) as Record<string, unknown>;
    } catch {
      continue; // not our row; leave it for whoever owns it
    }
    if (content.action !== EXECUTE_APPROVED_ACTION) continue;
    // Mark completed BEFORE executing — at-most-once. A 'completed' ack is NOT cleared by
    // clearStaleProcessingAcks (only 'processing' is), so if the process crashes mid-mutation the
    // row is never replayed. For non-idempotent bulk move/reassign, a lost action (admin re-approves)
    // is strictly safer than a double mutation. executeApprovedAction is itself fail-loud on handler
    // error, so a handler-level failure still notifies the user.
    markCompleted([row.id]);
    try {
      await executeApprovedAction(content);
      log(`runApprovedActions: completed approved action ${row.id} (${String(content.tool)})`);
    } catch (e) {
      markFailed(row.id);
      log(`runApprovedActions: dispatch failed for ${row.id}: ${String(e)}`);
    }
  }
}
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
    // 0h-v2 (memo §0.3 step 4): clear web-origin every iteration BEFORE
    // anything, so an early `continue` (no messages, command-gate, etc.)
    // before `extractRouting` can never carry a stale ctx into the next
    // batch's `writeMessageOut` (Codex#4 stale-cross-batch finding).
    clearCurrentWebOrigin();
    const allPending = getPendingMessages(isFirstPoll);
    isFirstPoll = false;
    // #407: deterministically run any admin-APPROVED gated actions the host queued, BEFORE the LLM
    // filter below ever sees them. The mutation re-executes in code (no model in the loop) under the
    // gate-bypass flag, then the row is markCompleted so it can never re-fire.
    await runApprovedActions(allPending);
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    let messages = allPending.filter((m) => m.kind !== 'system');
    // Warm-container mirror of the host runner gate: drop due [TF-*] runners the board's state says
    // should stay silent before we can post them (see gateScheduledRunners above / runner-gate.ts).
    messages = gateScheduledRunners(messages);
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      // #396 (unit 3): deliver deferred cross-board notifications even while the
      // board is idle (no pending messages). The container polls every second, so
      // this matches V1's 1s host-poll cadence for an idle-but-running parent —
      // closing the register→assign→go-idle window the turn-boundary drain misses.
      // (A torn-down idle container still needs a host respawn-wake; that narrower
      // edge is noted in the #396 design doc.)
      drainAndDispatchPendingNotifications();
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
      // #396: this is also an idle branch (accumulate-only context messages, no
      // agent turn) — drain deferred notifications here too, else a board that
      // keeps receiving context-only messages never reaches the turn boundary and
      // its pending notifications expire undelivered (Codex xhigh 2026-06-05).
      drainAndDispatchPendingNotifications();
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // 0h-v2 (memo §0.3 step 4): set web-origin HERE — after routing is
    // known, before ANY batch `writeMessageOut` (command-gate replies
    // @~2723/2773, fast-path `writeReply` helpers, error path, and the
    // provider's send_* tools all run after this point but before
    // `setCurrentInReplyTo`). The gate in `messages-out.ts` reads it to
    // route the reply-to-THIS-conversation into board_chat. Codex#4: must
    // precede the fast-paths, not sit next to setCurrentInReplyTo.
    const _wo = detectWebOrigin(messages, routing);
    if (_wo && _wo.crossBoardSkipped > 0) {
      // G3 FAIL-CLOSED (Codex iter-3): two boards share one group_jid (a
      // config-invariant violation) → their web rows co-batched in one
      // session. The same-board filter alone is NOT enough: the foreign
      // board's message is still in `messages`, so it would (a) leak
      // into THIS board's reply via the shared agent prompt and (b) be
      // markCompleted unreplied. Leaving rows pending would livelock
      // (they'd re-mix forever). So refuse the ENTIRE batch: drain it
      // (markCompleted = no retry, no livelock) and `continue` BEFORE
      // the web gate / command handling / provider — the agent never
      // sees any of it. Sacrifices the legit board's message too, by
      // design: the operator must fix the board→group_jid mapping;
      // future un-mixed batches then flow normally.
      log(
        `0h-v2 FAIL-CLOSED: cross-board web rows co-batched (${_wo.crossBoardSkipped} foreign + board ` +
          `${_wo.board_id}) — two boards share a group_jid. Refusing the WHOLE batch (NOT sent to the ` +
          `agent, NOT replied). Fix the board→group_jid mapping. Drained ids: ${ids.join(', ')}`,
      );
      markCompleted(ids);
      continue;
    }
    setCurrentWebOrigin(
      _wo
        ? {
            board_id: _wo.board_id,
            board_chat_ids: _wo.board_chat_ids,
            platformId: _wo.platformId,
            channelType: _wo.channelType,
            threadId: _wo.threadId,
            sender_name: config.assistantName,
            source_id_prefix: config.agentGroupId,
          }
        : null,
    );

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

    const explicitReassign = taskflowExplicitReassignCommand(keep);
    if (explicitReassign && handleTaskflowExplicitReassign(explicitReassign, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled explicit TaskFlow reassignment without provider query');
      continue;
    }

    const pendingChildBoardRegistration = taskflowPendingChildBoardRegistrationCommand(keep, recentContext);
    if (pendingChildBoardRegistration && handleTaskflowPendingChildBoardRegistration(pendingChildBoardRegistration, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow child-board registration follow-up without provider query');
      continue;
    }

    const childBoardCreationPrompt = taskflowChildBoardCreationPrompt(keep);
    if (childBoardCreationPrompt && handleTaskflowChildBoardCreationPrompt(childBoardCreationPrompt, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow child-board creation prompt without provider query');
      continue;
    }

    const readyForReviewUpdate = taskflowReadyForReviewUpdateCommand(keep);
    if (readyForReviewUpdate && handleTaskflowReadyForReviewUpdate(readyForReviewUpdate, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow ready-for-review update without provider query');
      continue;
    }

    const orgMeetingDraft = taskflowOrgMeetingDraftPrompt(keep, recentContext);
    if (orgMeetingDraft && handleTaskflowOrgMeetingDraftPrompt(orgMeetingDraft, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow org meeting draft prompt without provider query');
      continue;
    }

    const createMeeting = taskflowCreateMeetingCommand(keep);
    if (createMeeting && handleTaskflowCreateMeeting(createMeeting, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow meeting creation without provider query');
      continue;
    }

    const processMinutes = taskflowProcessMinutesCommand(keep);
    if (processMinutes && handleTaskflowProcessMinutes(processMinutes, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow process-minutes request without provider query');
      continue;
    }

    const bareTaskDetails = taskflowBareTaskDetailsCommand(keep);
    if (bareTaskDetails && handleTaskflowBareTaskDetails(bareTaskDetails, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled bare TaskFlow task-details request without provider query');
      continue;
    }

    const recentInbox = taskflowRecentInboxCommand(keep);
    if (recentInbox && handleTaskflowRecentInbox(recentInbox, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled recent TaskFlow inbox request without provider query');
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

    const missingTaskFollowup = taskflowMissingTaskFollowupCommand(keep, recentOut);
    if (missingTaskFollowup && handleTaskflowMissingTaskFollowup(missingTaskFollowup, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow missing-task follow-up without provider query');
      continue;
    }

    const incompleteNoteRequest = taskflowIncompleteNoteRequestCommand(keep);
    if (incompleteNoteRequest && handleTaskflowIncompleteNoteRequest(incompleteNoteRequest, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled incomplete TaskFlow note request without provider query');
      continue;
    }

    const exactIdNote = taskflowExactIdNoteCandidate(keep);
    if (exactIdNote && handleTaskflowMissingExactIdNote(exactIdNote, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled missing exact-ID TaskFlow note without provider query');
      continue;
    }

    const bareResolved = taskflowBareResolvedPrompt(keep);
    if (bareResolved && handleTaskflowBareResolvedPrompt(bareResolved, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled bare TaskFlow resolved/completed prompt without provider query');
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

    const addExternalParticipantToLatestMeeting = taskflowAddExternalParticipantToLatestMeetingCommand(keep, recentContext);
    if (
      addExternalParticipantToLatestMeeting &&
      handleTaskflowAddExternalParticipantToLatestMeeting(addExternalParticipantToLatestMeeting, keep, routing)
    ) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow external participant add to latest meeting without provider query');
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

    const orgMeetingCreateForward = taskflowOrgMeetingCreateForwardConfirmation(keep, recentContext);
    if (orgMeetingCreateForward && handleTaskflowOrgMeetingCreateForwardConfirmation(orgMeetingCreateForward, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow org meeting create/forward confirmation without provider query');
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

    const exactTaskNextAction = taskflowExactTaskNextActionUpdateCommand(keep);
    if (exactTaskNextAction && handleTaskflowExactTaskNextActionUpdate(exactTaskNextAction, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow exact task next-action update without provider query');
      continue;
    }

    const projectNoteUpdate = taskflowProjectNoteUpdateCommand(keep);
    if (projectNoteUpdate && handleTaskflowProjectNoteUpdate(projectNoteUpdate, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow project note update without provider query');
      continue;
    }

    const boardPersonPlacement = taskflowBoardPersonPlacementCommand(keep);
    if (boardPersonPlacement && handleTaskflowBoardPersonPlacement(boardPersonPlacement, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow board-person placement without provider query');
      continue;
    }

    const orgDirectoryQuestion = taskflowOrgDirectoryQuestionCommand(keep);
    if (orgDirectoryQuestion && handleTaskflowOrgDirectoryQuestion(orgDirectoryQuestion, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow org-directory question without provider query');
      continue;
    }

    const projectReport = taskflowProjectReportCommand(keep);
    if (projectReport && handleTaskflowProjectReport(projectReport, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow project report without provider query');
      continue;
    }

    const projectTitleLookup = taskflowProjectTitleLookupCommand(keep);
    if (projectTitleLookup && handleTaskflowProjectTitleLookup(projectTitleLookup, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow project title lookup without provider query');
      continue;
    }

    const projectExistenceLookup = taskflowProjectExistenceLookupCommand(keep);
    if (projectExistenceLookup && handleTaskflowProjectExistenceLookup(projectExistenceLookup, keep, routing)) {
      markCompleted(keep.map((m) => m.id));
      log('Handled TaskFlow project existence lookup without provider query');
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
    // Context preamble (v1 parity, index.ts:702): prepend an embedding-ranked
    // board-context summary to this turn's prompt when the taskflow embeddings
    // feeder is configured. Fail-soft + no-op otherwise; the embed is capped at a
    // short timeout so a slow Ollama can't stall the turn. Skip native slash-command
    // turns — the command must stay the first input or the SDK won't dispatch it.
    const promptWithContext = promptHasNativeSlashCommand(keep, config.provider.supportsNativeSlashCommands)
      ? prompt
      : await maybePrependContextPreamble(prompt);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt: promptWithContext,
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
      clearCurrentWebOrigin();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    // Codex P-Audit-3: drain any stale mutation-dedup flag at the
    // unconditional turn boundary. dispatchResultText only fires on a
    // `result` event; without these, a mark set by an MCP mutation
    // followed by a stream error / no-result close would leak into the
    // next turn — now suppressing both its bare-text fallback AND its
    // same-conv `<message>` blocks (`7dc44f21` refinement).
    //
    // Order matters: FLUSH first, DRAIN after. flushPendingCreateCard →
    // emitMutationConfirmation re-marks the dedup flag on emit (Codex
    // gate 2026-05-22); doing it before the drain ensures that re-mark
    // is also cleared. The normal `result`-event path already flushed
    // (read-and-clear), so the boundary flush is a no-op there.
    flushPendingCreateCard();
    drainDeterministicMutationFlag();
    // #396: deliver any deferred cross-board notifications whose assignee's child
    // board has since provisioned (JID now resolves). Opportunistic per-turn drain
    // — no-op for non-taskflow boards. Within the 5-min TTL, V1 best-effort parity.
    drainAndDispatchPendingNotifications();
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

/**
 * True when this turn's prompt carries a native slash command (`/compact`, `/cost`,
 * …) that `formatMessagesWithCommands` emitted as raw text. Such commands only
 * dispatch as the FIRST input of a query (see the poll loop's pending-command
 * guard); prepending a context preamble would turn them into plain text. Uses the
 * same `isRunnerCommand` predicate the formatter does, so the two never diverge.
 */
export function promptHasNativeSlashCommand(
  messages: MessageInRow[],
  supportsNativeSlashCommands: boolean,
): boolean {
  return supportsNativeSlashCommands && messages.some(isRunnerCommand);
}

export interface ContextPreambleDeps {
  /** Query embedder seam — same signature as `embedText`, so a test can assert the
   *  taskflow feeder model/url is what's passed (the bug class this guards against). */
  embed?: (text: string, o: { url?: string; model?: string; timeoutMs?: number }) => Promise<Float32Array | null>;
  buildSummary?: (vector: Float32Array) => string | null;
  env?: NodeJS.ProcessEnv;
}

// v1 capped its host-side query-vector embed at 2s (src/container-runner.ts). This
// runs on every turn before the provider call, so the same short cap is load-bearing:
// a slow/down Ollama must not stall the reply.
const CONTEXT_PREAMBLE_EMBED_TIMEOUT_MS = 2000;

/**
 * v1-parity "embedding-ranked context preamble" (v1 index.ts:702). Embed the prompt
 * that's about to be sent to the provider, rank the board's tasks by similarity, and
 * PREPEND a compact `[Board context: …]` summary to the USER prompt — NOT the system
 * prompt, which holds the cache-stable once-per-session recall addendum.
 *
 * The query is embedded with the TASKFLOW feeder config (`NANOCLAW_TASKFLOW_EMBED_*`,
 * what the host feeder used to index the task vectors), NOT the memory-layer namespace
 * — else the query and task vectors are incomparable. Mirrors `maybeSemanticSearch`.
 *
 * Gated + fail-soft, like v1: not a taskflow board, feeder config absent, embeddings
 * down (embed → null), empty prompt, no relevant tasks, or ANY error → prompt returned
 * unchanged. The engine is opened READ-ONLY (the constructor otherwise runs schema
 * writes). `deps` keeps it unit-testable without Ollama/the db.
 */
export async function maybePrependContextPreamble(prompt: string, deps: ContextPreambleDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const boardId = env.NANOCLAW_TASKFLOW_BOARD_ID;
  const model = env.NANOCLAW_TASKFLOW_EMBED_MODEL;
  const url = env.NANOCLAW_TASKFLOW_EMBED_URL;
  // Feeder off (no taskflow embed config) → no preamble, exactly like v1.
  if (!boardId || !model || !url || !prompt.trim()) return prompt;
  try {
    const embed = deps.embed ?? embedText;
    const queryVector = await embed(prompt, { url, model, timeoutMs: CONTEXT_PREAMBLE_EMBED_TIMEOUT_MS });
    if (!queryVector) return prompt; // embeddings disabled / failed → no preamble (v1 parity)

    let preamble: string | null;
    if (deps.buildSummary) {
      preamble = deps.buildSummary(queryVector);
    } else {
      const { EmbeddingReader } = await import('./embedding-reader.js');
      const reader = new EmbeddingReader('/workspace/embeddings/embeddings.db');
      try {
        const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
        preamble = engine.buildContextSummary(queryVector, reader);
      } finally {
        reader.close();
      }
    }
    if (preamble) {
      log(`Context preamble injected (${preamble.length} chars)`);
      return `${preamble}\n\n${prompt}`;
    }
  } catch (err) {
    log(`Context preamble skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return prompt;
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

        // 0h-v2 (memo §0.3 step 4 / Codex P1 + resume): never merge a
        // follow-up across the web-chat boundary. (A) a web row during a
        // non-web turn would emit its reply with no ctx → channel
        // adapter instead of board_chat; (B) ANY follow-up during an
        // active web turn would have its reply rewritten into board_chat
        // by the still-set ctx (same-session routing-match can't tell a
        // WhatsApp follow-up apart — boards ARE WhatsApp groups). Same
        // remedy as slash commands: end the stream, leave the rows
        // pending; the outer loop re-determines web-origin per batch.
        if (crossesWebChatBoundary(pending, routing)) {
          log('Web-chat boundary (active or incoming) — ending stream for outer loop');
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
        // Gate scheduled runners here too: a due [TF-*] runner can land mid-query (the host inserts
        // recurring rows on their own cron, independent of this active query), and without the gate
        // it would be pushed into the stream — the warm-container race, just shifted to the follow-up
        // poll. Mirror of the outer-loop gate above.
        const newMessages = gateScheduledRunners(pending.filter((m) => m.kind !== 'system'));
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
        const recentContext = [...recentOutboundContents(), ...recentInboundContents()];
        const orgMeetingCreateForward = taskflowOrgMeetingCreateForwardConfirmation(keep, recentContext);
        if (orgMeetingCreateForward && handleTaskflowOrgMeetingCreateForwardConfirmation(orgMeetingCreateForward, keep, routing)) {
          markCompleted(keptIds);
          log('Handled TaskFlow org meeting create/forward follow-up without provider push');
          return;
        }

        const processMinutes = taskflowProcessMinutesCommand(keep);
        if (processMinutes && handleTaskflowProcessMinutes(processMinutes, keep, routing)) {
          markCompleted(keptIds);
          log('Handled TaskFlow process-minutes follow-up without provider push');
          return;
        }

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
        // Always call dispatchResultText so it can consume the
        // deterministic-mutation dedup flag (Codex P4) every turn,
        // preventing leak across turns when the model emits no final
        // text. dispatchResultText is a no-op on empty input.
        dispatchResultText(event.text ?? '', routing);
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

function contentText(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

function existingOutboundChatTexts(): string[] {
  try {
    return getOutboundDb()
      .prepare(`SELECT content FROM messages_out WHERE kind = 'chat' ORDER BY seq`)
      .all()
      .map((row) => contentText((row as { content: string }).content))
      .filter((value): value is string => value !== null);
  } catch {
    return [];
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
  // Consume the deterministic-mutation dedup flag at turn end (Codex
  // P4). If a TaskFlow mutation card was already emitted this turn, the
  // model's same-turn redundant reply is — v1 sent only the card.
  // Consume regardless of whether the bare-text branch fires, so the
  // flag never leaks across turns. Scope (refined `7dc44f21`):
  //   - bare-text fallback → SUPPRESS when set.
  //   - `<message to="<same-conv>">` blocks → SUPPRESS via
  //     `shouldSuppressSameConvMessage` below (same-conv =
  //     `<message>`-wrapped redundant NL).
  //   - `<message to="<other-conv>">` blocks → BYPASS (cross-board relay).
  // See mutation-dedup.ts SCOPE + mcp-tools/message-block-dedup.ts.
  const suppressBareFallback = consumeDeterministicMutationFlag();
  const deterministicTexts = suppressBareFallback ? existingOutboundChatTexts() : [];

  // Phase-3 #7: flush the deferred no-reparent create card. A standalone
  // create stores its "Tarefa criada"/"Projeto criado" card instead of
  // emitting eagerly (api_create_task can't take a parent, so an eager
  // emit would double-emit on a following api_admin(reparent_task); the
  // reparent clears it). Flushed once per `result` event, BEFORE
  // processQuery's finally clears the web-origin context so the
  // web-chat-reply rewrite still applies. A stream-error / no-result
  // turn skips this — the turn-boundary call (next to
  // drainDeterministicMutationFlag) is the safety net.
  flushPendingCreateCard();

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
    // Phase-3 #7 follow-up: refinement of the P4 dedup scope. A
    // `<message to="<same-conversation>">` immediately after a
    // deterministic mutation card is the redundant model narration v1
    // never sent — same class as the bare-text fallback already
    // suppressed. Cross-conversation `<message>` blocks (relay to other
    // destinations) still emit by design. See message-block-dedup.ts
    // and the SCOPE section in mutation-dedup.ts.
    if (shouldSuppressSameConvMessage(suppressBareFallback, dest, routing)) {
      log(`<message to="${toName}"> suppressed (P4 same-conv dedup): deterministic mutation card already emitted this turn`);
      continue;
    }
    if (shouldSuppressDuplicateMutationMessage(suppressBareFallback, body, deterministicTexts)) {
      log(`<message to="${toName}"> suppressed (P4 duplicate-card dedup): exact deterministic mutation card already emitted this turn`);
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
      if (suppressBareFallback) {
        log('Bare final text suppressed (Codex P4 dedup): deterministic mutation card already emitted this turn');
        return;
      }
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
