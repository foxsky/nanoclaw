/**
 * Mutate-side TaskFlow MCP tools.
 *
 * Each handler instantiates a fresh writable `TaskflowEngine`, calls the
 * matching engine method, and JSON-stringifies the result. The shared
 * MCP response shape is `{ success, data, notification_events }` for
 * happy paths and `{ success: false, error_code?, error }` otherwise.
 */
import type { Database } from 'bun:sqlite';
import { getTaskflowDb } from '../db/connection.js';
import { parseIsoCalendarDate } from '../iso-date.js';
import { getBoardTimezone, TaskflowEngine } from '../taskflow-engine.js';
import type { AdminParams, AdminResult, DependencyParams, HierarchyParams, MoveResult, QueryParams, ReassignParams, ReassignResult, ReportParams, UndoParams, UpdateParams } from '../taskflow-engine.js';
import { writeMessageOut } from '../db/messages-out.js';
import { enqueueDeferredNotificationsInSession } from './pending-notification-dispatch.js';
import { emitDeterministicToolMessage, emitMutationConfirmation } from './mutation-confirmation.js';
import { clearPendingCreateCard, setPendingCreateCard } from './mutation-dedup.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { isTaskflowSubprocess, normalizeAgentIds, normalizeEngineNotificationEvents } from './taskflow-helpers.js';
import { buildReassignCard, buildReassignInfo, type ReassignTaskInfo } from './reassign-card.js';
import { dispatchNotificationEvents } from './taskflow-notify-dispatch.js';
import { err, generateId, jsonResponse, log, parseTaskActorArgs, requireString } from './util.js';
import { EmbeddingReader } from '../embedding-reader.js';
import { embedText } from '../memory-embed.js';

// Structured arg-shape rejection for the FastAPI surface (HTTP 422), as
// opposed to raw `err()` text (which the dashboard parser can't decode → 503).
// Mirrors the helper in taskflow-api-chat.ts / taskflow-api-comment.ts.
function validationError(error: string) {
  return jsonResponse({ success: false, error_code: 'validation_error', error });
}

const EMBEDDINGS_DB_PATH = '/workspace/embeddings/embeddings.db';

/**
 * #385 semantic search. For `query: 'search'`, embed the search text via Ollama
 * (the same NANOCLAW_TASKFLOW_EMBED_* config container-runner forwards — i.e.
 * the host feeder's model, so query/task vectors are comparable) and inject a
 * read-only EmbeddingReader so `engine.query` ranks semantically (collection
 * `tasks:<board>`, merged with lexical hits). No-op (→ pure lexical) when the
 * query isn't 'search', there's no search_text, the embed config is absent
 * (feeder off), or the embed call returns null. Returns the reader for the
 * caller to `close()`. `deps` is an injectable seam for tests.
 */
export async function maybeSemanticSearch(
  queryParams: QueryParams,
  deps: {
    embed?: (text: string, o: { url?: string; model?: string }) => Promise<Float32Array | null>;
    readerPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<EmbeddingReader | null> {
  if (queryParams.query !== 'search' || !queryParams.search_text) return null;
  const env = deps.env ?? process.env;
  const model = env.NANOCLAW_TASKFLOW_EMBED_MODEL;
  const url = env.NANOCLAW_TASKFLOW_EMBED_URL;
  if (!model || !url) return null;
  const embed = deps.embed ?? embedText;
  const vector = await embed(queryParams.search_text, { url, model });
  if (!vector) return null;
  const reader = new EmbeddingReader(deps.readerPath ?? EMBEDDINGS_DB_PATH);
  queryParams.query_vector = vector;
  queryParams.embedding_reader = reader;
  return reader;
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

const MOVE_ACTIONS = [
  'start', 'wait', 'resume', 'return', 'review',
  'approve', 'reject', 'conclude', 'reopen', 'force_start',
] as const;
type MoveAction = (typeof MOVE_ACTIONS)[number];

const REPORT_TYPES = ['standup', 'digest', 'weekly'] as const;
type ReportType = (typeof REPORT_TYPES)[number];

const HIERARCHY_ACTIONS = ['link', 'unlink', 'refresh_rollup', 'tag_parent'] as const;
type HierarchyAction = (typeof HIERARCHY_ACTIONS)[number];

const DEPENDENCY_ACTIONS = ['add_dep', 'remove_dep', 'add_reminder', 'remove_reminder'] as const;
type DependencyAction = (typeof DEPENDENCY_ACTIONS)[number];

const CREATE_TASK_TYPES = ['simple', 'project', 'recurring', 'inbox'] as const;
type CreateTaskType = (typeof CREATE_TASK_TYPES)[number];

const RECURRENCES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
type Recurrence = (typeof RECURRENCES)[number];

const ADMIN_ACTIONS = [
  'register_person', 'remove_person', 'remove_child_board', 'add_manager', 'add_delegate', 'remove_admin',
  'set_wip_limit', 'set_cross_board_subtask_mode', 'cancel_task', 'restore_task', 'process_inbox', 'manage_holidays',
  'process_minutes', 'process_minutes_decision', 'accept_external_invite',
  'reparent_task', 'detach_task', 'merge_project', 'handle_subtask_approval',
] as const;
type AdminAction = (typeof ADMIN_ACTIONS)[number];

const CROSS_BOARD_SUBTASK_MODES = ['open', 'approval', 'blocked'] as const;
type CrossBoardSubtaskMode = (typeof CROSS_BOARD_SUBTASK_MODES)[number];

const HOLIDAY_OPS = ['add', 'remove', 'set_year', 'list'] as const;
type HolidayOp = (typeof HOLIDAY_OPS)[number];

const ADMIN_DECISIONS = ['approve', 'reject', 'create_task', 'create_inbox'] as const;
type AdminDecision = (typeof ADMIN_DECISIONS)[number];

interface CreateLikeResult {
  success: boolean;
  task_id?: string;
  error?: string;
  unresolved_participants?: string[];
  offer_register?: { name: string; message: string };
  notifications?: Array<{ target_person_id?: string; message: string }>;
}

const DUPLICATE_TITLE_STOPWORDS = new Set([
  'a', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'no', 'o', 'os', 'para', 'por',
]);

function titleTokens(value: string): Set<string> {
  return new Set(
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length > 1 && !DUPLICATE_TITLE_STOPWORDS.has(token)),
  );
}

function titleSimilarity(a: string, b: string): number {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (left.size < 3 || right.size < 3) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / Math.max(left.size, right.size);
}

function columnLabel(column: string | null | undefined): string {
  switch (column) {
    case 'inbox': return 'Inbox';
    case 'next_action': return 'Próximas Ações';
    case 'in_progress': return 'Em Progresso';
    case 'waiting': return 'Aguardando';
    case 'review': return 'Revisão';
    case 'done': return 'Concluída';
    default: return column || 'sem coluna';
  }
}

function findDuplicateCreateCandidate(
  db: Database,
  engine: TaskflowEngine,
  boardId: string,
  taskType: CreateTaskType,
  title: string,
  assignee?: string,
): Record<string, unknown> | null {
  if (taskType !== 'simple' && taskType !== 'project') return null;
  const resolvedAssignee = assignee ? engine.resolvePerson(assignee) : null;
  const rows = db
    .prepare(
      `SELECT t.*, b.short_code AS board_code, bp.name AS assignee_name
       FROM tasks t
       JOIN boards b ON b.id = t.board_id
       LEFT JOIN board_people bp ON bp.board_id = t.board_id AND bp.person_id = t.assignee
       WHERE t.board_id = ?
         AND t.type = ?
         AND t.column != 'done'
       ORDER BY t.updated_at DESC`,
    )
    .all(boardId, taskType) as Array<Record<string, unknown>>;

  let best: { row: Record<string, unknown>; score: number } | null = null;
  for (const row of rows) {
    if (resolvedAssignee && row.assignee !== resolvedAssignee.person_id) continue;
    const score = titleSimilarity(title, String(row.title ?? ''));
    if (score < 0.75) continue;
    if (!best || score > best.score) best = { row, score };
  }
  return best?.row ?? null;
}

function duplicateCreateResponse(engine: TaskflowEngine, row: Record<string, unknown>) {
  const data = engine.serializeApiTask(row);
  const taskId = String(row.id ?? data.id ?? 'tarefa');
  const title = String(row.title ?? data.title ?? taskId);
  const assignee = typeof row.assignee_name === 'string' && row.assignee_name.trim()
    ? row.assignee_name
    : typeof row.assignee === 'string' && row.assignee.trim()
      ? row.assignee
      : 'sem responsável';
  const formatted =
    `Já existe a **${taskId} — ${title}** atribuída ao ${assignee} (${columnLabel(String(row.column ?? ''))}). Parece ser o mesmo assunto.\n\n` +
    `Deseja usar a ${taskId} existente ou criar uma tarefa separada mesmo assim?`;
  // Mirror finalizeMutationResult / pending-create-card flush: dup-detect
  // is the only create-path branch that otherwise depends on the model
  // echoing the formatted text. Also marks the dedup flag (suppresses a
  // model echo from doubling the user-visible prompt).
  emitMutationConfirmation({ success: true, formatted });
  return jsonResponse({
    success: true,
    data: {
      duplicate_candidate: true,
      task: data,
      formatted,
    },
    notification_events: [],
  });
}

// #392 — create-time duplicate thresholds (cosine). >= HARD refuses the create
// (near-identical); [SOFT, HARD) returns a duplicate_candidate the agent asks the
// user about. Mirrors V1's 0.85 soft / 0.95 hard dup-detection.
const SEMANTIC_DUP_SOFT = 0.85;
const SEMANTIC_DUP_HARD = 0.95;

type EmbedFn = (text: string, o: { url?: string; model?: string }) => Promise<Float32Array | null>;
type SearchFn = (
  collection: string,
  vector: Float32Array,
) => Promise<Array<{ itemId: string; score: number }>>;

// How many top semantic hits to revalidate against the live table. >1 so a stale
// top vector (a just-deleted/done task, ~15s feeder window) can't mask a lower
// LIVE duplicate (Codex #392 finding 1).
const SEMANTIC_DUP_TOPN = 5;

/**
 * #392 — semantic (embeddings) duplicate detection on create. Embeds the new
 * task's title and finds the most-similar EXISTING active SAME-TYPE task in the
 * board's `tasks:<board>` collection. Returns the matched live task row + its
 * cosine score, or null. NO-OP (→ pure lexical, no semantic check) when the
 * embed env is absent — same gate as maybeSemanticSearch — so a board without
 * Ollama is unaffected. Only `simple`/`project` tasks are checked, and the match
 * must be the SAME type (mirrors the lexical findDuplicateCreateCandidate gate +
 * its `t.type = ?` filter; inbox/recurring/meeting are skipped). The caller
 * decides soft-vs-hard from the score.
 */
export async function maybeFindEmbedDuplicate(
  db: Database,
  boardId: string,
  taskType: CreateTaskType,
  title: string,
  deps: { embed?: EmbedFn; search?: SearchFn; readerPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ row: Record<string, unknown>; score: number } | null> {
  if (taskType !== 'simple' && taskType !== 'project') return null;
  const env = deps.env ?? process.env;
  const model = env.NANOCLAW_TASKFLOW_EMBED_MODEL;
  const url = env.NANOCLAW_TASKFLOW_EMBED_URL;
  if (!model || !url) return null;

  const vector = await (deps.embed ?? embedText)(title, { url, model });
  if (!vector) return null;

  const search: SearchFn =
    deps.search ??
    (async (collection, vec) => {
      const reader = new EmbeddingReader(deps.readerPath ?? EMBEDDINGS_DB_PATH);
      try {
        return reader.search(collection, vec, { limit: SEMANTIC_DUP_TOPN, threshold: SEMANTIC_DUP_SOFT });
      } finally {
        reader.close();
      }
    });
  const hits = await search(`tasks:${boardId}`, vector);

  // hits are score-desc. The collection can lag the live table (15s feeder
  // cycle), so revalidate each against the live table IN SCORE ORDER and return
  // the first match that is still an open, same-type task on THIS board — never
  // a deleted/done/foreign/other-type task, and never letting a stale top hit
  // hide a lower live duplicate.
  const stmt = db.prepare(
    `SELECT t.*, b.short_code AS board_code, bp.name AS assignee_name
     FROM tasks t JOIN boards b ON b.id = t.board_id
     LEFT JOIN board_people bp ON bp.board_id = t.board_id AND bp.person_id = t.assignee
     WHERE t.board_id = ? AND t.id = ? AND t.type = ? AND t.column != 'done'`,
  );
  for (const hit of hits) {
    const row = stmt.get(boardId, hit.itemId, taskType) as Record<string, unknown> | null;
    if (row) return { row, score: hit.score };
  }
  return null;
}

/** #392 threshold policy: a semantic match >= SEMANTIC_DUP_HARD hard-blocks the
 *  create; a weaker match [SOFT, HARD) returns the soft duplicate_candidate (the
 *  same response the lexical path uses). The create handler delegates here. */
export function resolveEmbedDuplicate(
  engine: TaskflowEngine,
  embedDup: { row: Record<string, unknown>; score: number },
) {
  return embedDup.score >= SEMANTIC_DUP_HARD
    ? duplicateHardBlockResponse(engine, embedDup.row)
    : duplicateCreateResponse(engine, embedDup.row);
}

/** #392 hard-block: a >= SEMANTIC_DUP_HARD match refuses the create (success:false)
 *  and points at the existing task. Overridable by re-calling with force_create. */
function duplicateHardBlockResponse(engine: TaskflowEngine, row: Record<string, unknown>) {
  const data = engine.serializeApiTask(row);
  const taskId = String(row.id ?? data.id ?? 'tarefa');
  const title = String(row.title ?? data.title ?? taskId);
  return jsonResponse({
    success: false,
    error_code: 'duplicate_hard_block',
    error:
      `Já existe **${taskId} — ${title}**, praticamente idêntica à que você pediu — não criei uma nova ` +
      `para evitar duplicata. Se for mesmo uma tarefa diferente, repita o comando com \`force_create\`.`,
    duplicate_task: data,
  });
}

/**
 * Post-create result shaping shared by `api_create_simple_task` and
 * `api_create_meeting_task`: turn an engine `CreateResult` into the
 * MCP-tool JSON response `{ success, data, notification_events }`.
 * Re-queries the row + JOIN on boards so serializeApiTask receives the
 * full denormalized shape; engine.create's post-commit verification
 * only selects `id`, not the joined columns.
 */
export function finalizeCreatedTaskResult(
  db: Database,
  engine: TaskflowEngine,
  boardId: string,
  result: CreateLikeResult,
) {
  if (!result.success) return jsonResponse({ success: false, error: result.error });
  if (!result.task_id) {
    return jsonResponse({ success: false, error: 'engine returned success without task_id' });
  }
  const row = db
    .prepare(
      `SELECT t.*, b.short_code AS board_code FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND t.board_id = ?`,
    )
    .get(result.task_id, boardId) as Record<string, unknown>;
  const data = engine.serializeApiTask(row);
  // v1 emits a standalone "Tarefa criada"/"Projeto criado" card for a
  // no-reparent create (Phase-3 #7). Deferred, not emitted now: "add to
  // project" is create THEN api_admin(reparent_task), and an eager emit
  // would double-emit. The card is STORED — the poll-loop turn-end
  // flushes it, or a following reparent clears it (emitting its own
  // superseding "adicionada" card). buildCreatedTaskCard → null outside
  // the v1-faithful scope (non-next_action, recurring/meeting).
  const createdCard = buildCreatedTaskCard(data);
  if (createdCard) setPendingCreateCard(result.task_id, createdCard);
  // Assignee notification (#397): dispatch the engine's create-assignee
  // notification exactly as move/admin/reassign do (finalizeMutationResult) —
  // normalizeEngineNotificationEvents maps a resolved notification_group_jid to
  // a host-deliverable 'direct_message' and a null one to a 'deferred_notification'
  // (host-skipped until #396). V1 fired create notifications SYNCHRONOUSLY at
  // create time (no pending-hold, no clear-on-cancel — confirmed against
  // git main), so we dispatch eagerly here and do NOT defer/clear them. This is
  // independent of the "Tarefa criada" CARD above, which is the in-chat
  // confirmation that stays deferred-to-turn-end and cleared on a same-turn
  // delete/reparent. in_chat_notice events (invite cards) render in-chat.
  // Fail-soft (shared with finalizeMutationResult): the create has already
  // committed, so a malformed engine notification must not flip it to
  // success:false (→ agent retries → duplicate task).
  const notification_events = safeNotificationEvents(result);
  // #396: a cross-board assignee whose child board is still provisioning has a
  // null JID, so dispatch host-skips their deferred_notification. PERSIST it
  // FIRST (before dispatch, in-session only, fail-soft) so a crash mid-dispatch
  // can't lose it — the turn-boundary drain delivers it once their board
  // provisions.
  enqueueDeferredNotificationsInSession(boardId, notification_events, result.task_id, { db });
  dispatchNotificationEvents(notification_events);
  return jsonResponse({
    success: true,
    data,
    notification_events,
    ...(result.unresolved_participants ? { unresolved_participants: result.unresolved_participants } : {}),
    ...(result.offer_register ? { offer_register: result.offer_register } : {}),
  });
}

/**
 * The single task id used for a deferred notification's liveness check: the
 * engine's top-level `task_id`, or — for single-task mutations that only return
 * `tasks_affected` (e.g. `reassign`) — that one task's id. Multi-task results
 * have no single liveness id (null → dropped only on the board-level TTL).
 * (Codex xhigh #405.)
 */
function singleDeferredTaskId(result: { task_id?: unknown; tasks_affected?: unknown }): string | null {
  if (typeof result.task_id === 'string') return result.task_id;
  const affected = result.tasks_affected;
  if (Array.isArray(affected) && affected.length === 1) {
    const id = (affected[0] as { task_id?: unknown })?.task_id;
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * Post-mutation result shaping shared by `api_move`, `api_admin`, and
 * `api_reassign`. Strips `notifications` (rewritten as `notification_events`
 * via the shared normalizer) and preserves every other engine field on
 * BOTH paths:
 *   success → `{success: true, data: rest, notification_events}` keeps
 *     wip_warning, project_update, parent_notification, tasks_affected,
 *     requires_confirmation (dry run), auto_provision_request, etc.
 *   failure → `{success: false, ...rest, notification_events}` keeps
 *     error_code, expected_task_id, actual_task_id (magnetism retry
 *     contract), offer_register, etc. — without us picking winners on
 *     which engine fields to forward.
 */
/**
 * normalizeEngineNotificationEvents, fail-soft for the POST-commit finalizers.
 * The normalizer validates the engine's notification shape and THROWS on
 * anything malformed; in a finalizer that runs AFTER the mutation committed, a
 * throw would flip a committed write to success:false (the agent then retries →
 * double-apply). #399 fixed one shape (invite-pending group/no-JID); this guards
 * the rest — drop the notifications (logged loudly), never the success. Shared
 * by finalizeMutationResult and finalizeCreatedTaskResult.
 */
export function safeNotificationEvents(
  result: unknown,
): ReturnType<typeof normalizeEngineNotificationEvents> {
  try {
    return normalizeEngineNotificationEvents(result);
  } catch (err) {
    log(`mutation notification normalization failed (notifications dropped): ${String(err)}`);
    return [];
  }
}

/**
 * The board timezone for POST-commit card formatting, guaranteed Intl-usable.
 * getBoardTimezone returns the raw board_runtime_config value with no
 * validation, so a garbage tz (or a read error) would make the downstream
 * `toLocaleDateString(..., { timeZone })` throw and flip a committed update to
 * success:false. Validate it against Intl and fall back to the default zone.
 */
export function safeBoardTimeZone(db: Database, boardId: string): string {
  try {
    const tz = getBoardTimezone(db, boardId);
    // toLocaleDateString throws a RangeError on an unknown/invalid zone.
    new Date().toLocaleDateString('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return 'America/Fortaleza';
  }
}

/**
 * Per-success notification events for the bulk api_move path, which does NOT go
 * through finalizeMutationResult (it normalizes each committed sub-move directly,
 * keeping per-task parent_notification rollups separate). Fail-soft PER result:
 * the sub-moves have already committed, so a malformed notification from one must
 * not throw and flip the whole bulk result to success:false — it drops only its
 * own events. Returns one event array per input, index-aligned for enqueue.
 */
export function bulkMoveNotificationEvents(
  successes: { notifications?: unknown }[],
): ReturnType<typeof normalizeEngineNotificationEvents>[] {
  return successes.map((r) => safeNotificationEvents(r));
}

export function finalizeMutationResult(result: {
  success: boolean;
  notifications?: unknown;
  task_id?: unknown;
  tasks_affected?: unknown;
}) {
  const { notifications: _notifications, success, ...rest } = result;
  const notification_events = safeNotificationEvents(result);
  if (!success) return jsonResponse({ success: false, ...rest, notification_events });
  emitMutationConfirmation(result);
  // #396: persist any cross-board deferred (null-JID) notification (e.g. a
  // reassign/move to a teammate whose child board is still provisioning) so the
  // turn-boundary drain delivers it once their board provisions. In-session
  // only, before dispatch, fail-soft. board = the container's env board.
  const taskId = singleDeferredTaskId(result);
  enqueueDeferredNotificationsInSession(process.env.NANOCLAW_TASKFLOW_BOARD_ID, notification_events, taskId, {});
  // Deterministic cross-chat dispatch (#389): the engine's reassign /
  // parent-rollup / invite notifications are delivered by the host, not
  // relayed by the agent. In-session only — the FastAPI subprocess no-ops.
  dispatchNotificationEvents(notification_events);
  return jsonResponse({ success: true, data: rest, notification_events });
}

/**
 * V1 parity (#390): `register_person` on a hierarchy board that can delegate
 * down returns an `auto_provision_request` (the engine builds it only when a
 * phone is given AND `canDelegateDown()` — the leaf gate). V1's
 * `taskflow_admin` auto-emitted the `provision_child_board` IPC row; emit it
 * here so the child board is provisioned deterministically rather than
 * depending on the agent relaying it (the template says no agent action
 * needed). Mirrors the CONTACT_CARD_RE fast-path emit (poll-loop.ts:2813).
 * Fail-soft: the registration already committed, so a failed emit must NOT
 * turn into success:false. Returns whether a row was emitted.
 */
export function emitAutoProvisionIfRequested(
  result: AdminResult,
  deps: { emit?: (msg: { id: string; kind: string; content: string }) => unknown; id?: string } = {},
): boolean {
  if (!result.success || !result.auto_provision_request) return false;
  // Defense-in-depth: never emit a session on-wake row from the FastAPI subprocess.
  // api_admin is not FastAPI-allowlisted today, but gate on the reliable subprocess
  // signal so an allowlist change can't turn this into a leak (writeMessageOut →
  // /workspace/outbound.db). Mirrors dispatchNotificationEvents / mutation-dedup.
  if (isTaskflowSubprocess()) return false;
  try {
    (deps.emit ?? writeMessageOut)({
      id: deps.id ?? generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'provision_child_board', ...result.auto_provision_request }),
    });
    return true;
  } catch (e) {
    log(`provision_child_board auto-emit failed: ${String(e)}`);
    return false;
  }
}

function addMoveFormattedResult(result: MoveResult, action: MoveAction): MoveResult {
  if (!result.success || result.formatted) return result;
  const title = result.title ? ` — ${result.title}` : '';
  const transition = result.from_column && result.to_column
    ? ` (${result.from_column} → ${result.to_column})`
    : '';
  return {
    ...result,
    formatted: `${result.task_id ?? 'Tarefa'}${title}: ação "${action}" concluída${transition}.`,
  };
}

export function addReassignFormattedResult(
  result: ReassignResult,
  targetPerson: string,
  info?: ReassignTaskInfo | null,
): ReassignResult {
  if (!result.success || result.formatted || result.requires_confirmation) return result;
  const tasks = result.tasks_affected ?? [];
  if (tasks.length === 0) return result;
  // Single task → v2-coherent RICH card (Phase-3 Turn-37 richness gap): the parent
  // tree when there's a resolvable parent, else De/Para when the previous assignee
  // is known. v1's reassign confirmation was LLM-composed (no source to byte-port),
  // so this reuses v2's OWN create/update card vocabulary. The lookup lives in the
  // CALLER (buildReassignInfo, fail-soft) — keeping it out of the formatter is what
  // prevents a post-commit lookup throw from surfacing as a failed mutation. Falls
  // through to the short form when the card is null (no parent + no from, or the
  // tf-mcontrol subprocess where info is null), and never for multi-task.
  if (tasks.length === 1) {
    const rich = buildReassignCard({
      id: tasks[0].task_id,
      title: tasks[0].title,
      parentId: info?.parent_task_id,
      parentTitle: info?.parent_task_title,
      dueDate: info?.due_date,
      assignee: targetPerson,
      fromAssignee: info?.from_assignee,
    });
    if (rich) return { ...result, formatted: rich };
  }
  // Short single / multi form — prior behavior; kept for no-parent + multi-task
  // + info-less callers (e.g. tf-mcontrol, which has no WhatsApp emission anyway).
  return {
    ...result,
    formatted: tasks.length === 1
      ? `✅ *${tasks[0].task_id}* — ${tasks[0].title}\n\nReatribuída para ${targetPerson}.`
      : [
          `✅ ${tasks.length} tarefas reatribuídas para ${targetPerson}:`,
          '',
          ...tasks.map((task) => `• *${task.task_id}* — ${task.title}`),
        ].join('\n'),
  };
}

// buildReassignCard / buildReassignInfo / ReassignTaskInfo live in the
// side-effect-free ./reassign-card.js (Codex NICE) and are re-imported above.

// BYTE-FAITHFUL mirror of v1's generic "task created under a project"
// card. No reusable v1 formatter exists; ground truth is the corpus
// v1.final_response (seci Turn 0). KEEP IN SYNC. Only the with-parent
// shape has a ground-truth exemplar — no-parent and the ID-conflict
// "atualizada/↳" variants are intentionally NOT built here (return
// null; follow-up increments + the Codex hot-path gate).
export function buildCreateCard(data: {
  id?: unknown;
  title?: unknown;
  parent_task_id?: unknown;
  parent_task_title?: unknown;
}): string | null {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const id = str(data.id);
  const title = str(data.title);
  const parentId = str(data.parent_task_id);
  const parentTitle = str(data.parent_task_title);
  if (!id || !title || !parentId || !parentTitle) return null;
  return [
    `✅ *${id} adicionada*`,
    '━━━━━━━━━━━━━━',
    '',
    `📁 *${parentId}* — ${parentTitle}`,
    `   📋 *${id}* — ${title}`,
  ].join('\n');
}

// BYTE-FAITHFUL mirror of v1's standalone (no-reparent) create card.
// Ground truth: sec-secti GATE v1 final_responses — simple →
// "✅ *Tarefa criada*", project → "✅ *Projeto criado*" (Phase-3 #7).
// Scope: next_action column only — inbox creates use the separate
// "📥 Capturada no Inbox" variant (no in-scope exemplar); recurring/
// meeting have none → null. Conditional Prazo/Prioridade/Nota lines
// (seen on other boards) are NOT emitted: no in-scope ground truth for
// their exact format → no fabrication.
export function buildCreatedTaskCard(data: {
  id?: unknown;
  title?: unknown;
  type?: unknown;
  assignee?: unknown;
  column?: unknown;
}): string | null {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const id = str(data.id);
  const title = str(data.title);
  const assignee = str(data.assignee);
  const type = str(data.type);
  const column = str(data.column);
  if (!id || !title || !assignee) return null;
  if (column !== 'next_action') return null;
  if (type !== 'simple' && type !== 'project') return null;
  const isProject = type === 'project';
  return [
    isProject ? '✅ *Projeto criado*' : '✅ *Tarefa criada*',
    '━━━━━━━━━━━━━━',
    '',
    `*${id}* — ${title}`,
    `👤 *${isProject ? 'Atribuído' : 'Atribuída'} a:* ${assignee}`,
    '⏭️ *Coluna:* Próximas Ações',
  ].join('\n');
}

// Shared header for v1's "atualizada" card variants (update, add_note).
// Extracted because byte-faithfulness keeps these three lines identical
// across builders; each variant appends its own bullet lines.
function buildAtualizadaHeader(taskId: string): string[] {
  return [`✅ *${taskId}* atualizada`, '━━━━━━━━━━━━━━', ''];
}

// BYTE-FAITHFUL mirror of v1's `✅ *id* atualizada` update card.
// Scope: title + due_date only; other keys → null (no fabrication).
const UPDATE_CARD_KEYS = new Set(['title', 'due_date']);

export function buildUpdateCard(
  taskId: string,
  updates: Record<string, unknown>,
): string | null {
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  const keys = Object.keys(updates);
  if (keys.length === 0) return null;
  for (const k of keys) if (!UPDATE_CARD_KEYS.has(k)) return null;

  const lines: string[] = [];
  if ('title' in updates) {
    const title = updates.title;
    if (typeof title !== 'string') return null;
    lines.push(`• Título alterado para *${title}*`);
  }
  if ('due_date' in updates) {
    const iso = parseIsoCalendarDate(updates.due_date);
    if (!iso) return null;
    lines.push(`• ⏰ Prazo definido: ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`);
  }
  return [...buildAtualizadaHeader(taskId), ...lines].join('\n');
}

function resultChanges(result: { changes?: unknown }): string[] {
  return Array.isArray(result.changes)
    ? result.changes.filter((change): change is string => typeof change === 'string')
    : [];
}

function buildParticipantAddedCard(
  taskId: string,
  updates: Record<string, unknown>,
  result: { changes?: unknown },
): string | null {
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  const keys = Object.keys(updates);
  if (keys.length !== 1 || keys[0] !== 'add_participant') return null;
  if (typeof updates.add_participant !== 'string' || updates.add_participant.trim().length === 0) return null;
  const requestedName = updates.add_participant.trim();
  const changes = resultChanges(result);
  const added = changes
    .map((change) => change.match(/^Participante (.+) adicionado$/)?.[1])
    .find((name): name is string => typeof name === 'string' && name.length > 0);
  if (added) return `✅ *${taskId}* — ${added} adicionada como participante.`;
  if (changes.length === 0) {
    return `ℹ️ *${taskId}* — ${requestedName} já estava registrada como participante (sem alteração necessária).`;
  }
  return null;
}

function formatLocalScheduledAt(value: unknown, timeZone: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const weekday = part('weekday');
  const day = part('day');
  const month = part('month');
  const year = part('year');
  const hour = part('hour');
  const minute = part('minute');
  if (!weekday || !day || !month || !year || !hour || !minute) return null;
  return `${weekday}, ${day}/${month}/${year} às ${hour}:${minute}`;
}

function buildScheduledAtCard(
  taskId: string,
  updates: Record<string, unknown>,
  result: { changes?: unknown },
  timeZone: string,
): string | null {
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  const keys = Object.keys(updates);
  if (keys.length !== 1 || keys[0] !== 'scheduled_at') return null;
  if (!resultChanges(result).some((change) => change.startsWith('Reunião reagendada para '))) return null;
  const formatted = formatLocalScheduledAt(updates.scheduled_at, timeZone);
  if (!formatted) return null;
  return `✅ *${taskId}* reagendada para ${formatted}.`;
}

export function addUpdateFormattedResult<
  T extends { success?: boolean; formatted?: unknown; task_id?: unknown; changes?: unknown },
>(result: T, updates: Record<string, unknown>, today?: string, timeZone = 'America/Fortaleza'): T {
  if (!result.success || result.formatted) return result;
  const taskId = typeof result.task_id === 'string' ? result.task_id : '';
  if (!taskId) return result;
  // Title/due_date update card.
  const updateCard = buildUpdateCard(taskId, updates);
  if (updateCard) return { ...result, formatted: updateCard };
  const participantCard = buildParticipantAddedCard(taskId, updates, result);
  if (participantCard) return { ...result, formatted: participantCard };
  const scheduledAtCard = buildScheduledAtCard(taskId, updates, result, timeZone);
  if (scheduledAtCard) return { ...result, formatted: scheduledAtCard };
  // add_subtask card. Scope: updates = {add_subtask only}; multi-key
  // {add_subtask, due_date} returns null because the date applies to the
  // PARENT under engine.update semantics, not the sub (no fabrication).
  const keys = Object.keys(updates);
  if (keys.length === 1 && keys[0] === 'add_subtask') {
    const rawTitle = (result as { title?: unknown }).title;
    const parentTitle = typeof rawTitle === 'string' ? rawTitle : '';
    const sub = (result as { subtask?: unknown }).subtask as
      | { id: unknown; title: unknown; due_date?: unknown }
      | undefined;
    if (parentTitle && sub && typeof sub.id === 'string' && typeof sub.title === 'string') {
      const subArg: { id: string; title: string; due_date?: string } = { id: sub.id, title: sub.title };
      if (typeof sub.due_date === 'string') subArg.due_date = sub.due_date;
      const card = buildAddSubtaskCard({ id: taskId, title: parentTitle }, subArg, today);
      if (card) return { ...result, formatted: card };
    }
  }
  return result;
}

const ROLLUP_STATUS_LABELS: Record<string, string> = {
  no_work_yet: 'sem atividade',
  active: 'em andamento',
  at_risk: 'em risco',
  blocked: 'bloqueado',
  ready_for_review: 'pronto para revisão',
  cancelled_needs_decision: 'cancelamento pendente',
};

const ROLLUP_COLUMN_LABELS: Record<string, string> = {
  inbox: '📥 Inbox',
  next_action: '⏭️ Próximas Ações',
  in_progress: '🔄 Em Andamento',
  waiting: '⏳ Aguardando',
  review: '🔍 Revisão',
  done: '✅ Concluída',
  cancelled: '🚫 Cancelada',
};

function rollupStatusLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return ROLLUP_STATUS_LABELS[value] ?? value.replace(/_/g, ' ');
}

function rollupColumnLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return ROLLUP_COLUMN_LABELS[value] ?? value;
}

// BYTE-FAITHFUL mirror of v1's refresh-rollup confirmation card for
// linked parent tasks. Ground truth: seci Phase-3 Turn 18. The engine
// returns structured rollup data but no formatted user-facing card, so
// build it at the MCP compatibility boundary before deterministic
// confirmation emission.
export function addHierarchyFormattedResult<
  T extends {
    success?: boolean;
    formatted?: unknown;
    task_id?: unknown;
    rollup_status?: unknown;
    rollup_summary?: unknown;
    new_column?: unknown;
  },
>(result: T, action: string): T {
  if (action !== 'refresh_rollup' || !result.success || result.formatted) return result;
  const taskId = typeof result.task_id === 'string' && result.task_id.trim().length > 0
    ? result.task_id.trim()
    : '';
  const status = rollupStatusLabel(result.rollup_status);
  const column = rollupColumnLabel(result.new_column);
  if (!taskId || !status || !column) return result;
  const summary = typeof result.rollup_summary === 'string' ? result.rollup_summary.trim() : '';
  const statusLine = summary
    ? `• Status: _${status}_ — ${summary}`
    : `• Status: _${status}_`;
  return {
    ...result,
    formatted: [
      `🔗 *${taskId}* — Rollup atualizado`,
      '━━━━━━━━━━━━━━',
      '',
      statusLine,
      `• Coluna mantida: ${column}`,
    ].join('\n'),
  };
}

// v2-coherent SUBSET of v1's add_subtask card. Header uses whole-line
// bold (NOT buildAtualizadaHeader's `*id* atualizada`). The (hoje) tag
// is appended only when `today` matches `sub.due_date`. v1 template
// variants and corpus references live in `add-subtask-card.test.ts`.
export function buildAddSubtaskCard(
  parent: { id: string; title: string },
  sub: { id: string; title: string; due_date?: string },
  today?: string,
): string | null {
  if (typeof parent.id !== 'string' || parent.id.length === 0) return null;
  if (typeof parent.title !== 'string' || parent.title.length === 0) return null;
  if (typeof sub.id !== 'string' || sub.id.length === 0) return null;
  if (typeof sub.title !== 'string' || sub.title.length === 0) return null;
  const lines = [
    `✅ *${parent.id} atualizada*`, // whole-line bold — NOT buildAtualizadaHeader
    '━━━━━━━━━━━━━━',
    '',
    `📁 *${parent.id}* — ${parent.title}`,
    `   📋 *${sub.id}* — ${sub.title} adicionada`,
  ];
  if (sub.due_date !== undefined) {
    const iso = parseIsoCalendarDate(sub.due_date);
    if (iso) {
      const relativeTag = today === iso ? ' (hoje)' : '';
      lines.push(`   ⏰ Prazo: ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}${relativeTag}`);
    }
  }
  return lines.join('\n');
}

// BYTE-FAITHFUL mirror of v1's add_note "atualizada" card. Scope: simple
// add_note only (parent_note_id reply has no corpus exemplar; no fabrication).
export function buildNoteCard(taskId: string, noteText: string): string | null {
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  if (typeof noteText !== 'string' || noteText.length === 0) return null;
  return [...buildAtualizadaHeader(taskId), `• Nota: ${noteText}`].join('\n');
}

export function addNoteFormattedResult<
  T extends { success?: boolean; formatted?: unknown; changes?: unknown },
>(
  result: T,
  args: { task_id: string; text: string; parent_note_id?: number },
): T {
  if (!result.success || result.formatted) return result;
  if (args.parent_note_id !== undefined) return result;
  // Engine signals dedup via changes: ['Nota já existente: <text>'] with
  // success:true. v1 ground truth (seci Turn 35): emit a deterministic
  // "Nota já existente na <id> — '<text>' já estava registrada
  // anteriormente. Nenhuma duplicata foi adicionada." card so the user
  // sees the truth without depending on model echo.
  const changes = Array.isArray(result.changes) ? result.changes : [];
  if (typeof changes[0] === 'string' && changes[0].startsWith('Nota já existente:')) {
    return {
      ...result,
      formatted: `Nota já existente na ${args.task_id} — "${args.text}" já estava registrada anteriormente. Nenhuma duplicata foi adicionada.`,
    };
  }
  const card = buildNoteCard(args.task_id, args.text);
  if (!card) return result;
  return { ...result, formatted: card };
}

export function buildEditNoteCard(taskId: string, noteId: number, noteText: string): string | null {
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  if (!Number.isInteger(noteId) || noteId < 1) return null;
  if (typeof noteText !== 'string' || noteText.length === 0) return null;
  return [...buildAtualizadaHeader(taskId), `• Nota #${noteId} editada: ${noteText}`].join('\n');
}

export function addEditNoteFormattedResult<
  T extends { success?: boolean; formatted?: unknown },
>(
  result: T,
  args: { task_id: string; note_id: number; text: string },
): T {
  if (!result.success || result.formatted) return result;
  const card = buildEditNoteCard(args.task_id, args.note_id, args.text);
  if (!card) return result;
  return { ...result, formatted: card };
}

// Wire the v1-faithful create card onto the api_admin(reparent_task)
// completion: seci "add task X to project P11" is api_create_task →
// api_admin(reparent_task), and v1's "✅ *id* adicionada … 📁 parent"
// confirmation reflects the POST-reparent state. Routes through
// finalizeMutationResult (unit-1 emit). Mirrors addReassignFormattedResult.
export function addReparentFormattedResult<
  T extends { success?: boolean; formatted?: unknown; task_id?: unknown; data?: unknown },
>(result: T, action: string): T {
  if (action !== 'reparent_task' || !result.success || result.formatted) return result;
  const d = (result.data ?? {}) as {
    parent_task_id?: unknown;
    parent_title?: unknown;
    task_title?: unknown;
  };
  const card = buildCreateCard({
    id: result.task_id,
    title: d.task_title,
    parent_task_id: d.parent_task_id,
    parent_task_title: d.parent_title,
  });
  if (!card) return result;
  return { ...result, formatted: card };
}

function pickTaskSummary(task: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!task) return null;
  const summary: Record<string, unknown> = {};
  for (const key of [
    'id',
    'type',
    'title',
    'description',
    'assignee',
    'assignee_name',
    'column',
    'priority',
    'due_date',
    'scheduled_at',
    'parent_task_id',
    'parent_title',
  ]) {
    if (task[key] !== undefined && task[key] !== null && task[key] !== '') summary[key] = task[key];
  }
  return summary;
}

function compactTaskDetailsQueryResult(result: unknown): unknown {
  if (
    !result ||
    typeof result !== 'object' ||
    (result as { success?: unknown }).success !== true
  ) {
    return result;
  }
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return result;

  const details = data as Record<string, unknown>;
  const compact: Record<string, unknown> = {
    formatted_task_details: details.formatted_task_details,
    task: pickTaskSummary(details.task as Record<string, unknown> | null | undefined),
  };

  if (Array.isArray(details.subtask_rows)) {
    compact.subtask_count = details.subtask_rows.length;
    compact.subtasks = details.subtask_rows.map((row) => pickTaskSummary(row as Record<string, unknown>));
  }
  for (const key of ['parent_project', 'recent_history', 'external_participants', 'delegation_chain']) {
    if (details[key] !== undefined) compact[key] = details[key];
  }

  return { success: true, data: compact };
}

function compactFindTaskInOrganizationQueryResult(result: unknown): unknown {
  if (
    !result ||
    typeof result !== 'object' ||
    (result as { success?: unknown }).success !== true
  ) {
    return result;
  }
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return result;

  const compactRows = data.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const source = row as Record<string, unknown>;
    const formatted = source.formatted_current_board_project_summary;
    const compact: Record<string, unknown> = {};
    if (formatted !== undefined) compact.formatted_task_details = formatted;
    for (const key of [
      'task_id',
      'board_id',
      'board_group_folder',
      'board_short_code',
      'type',
      'title',
      'column',
      'assignee_name',
      'assignee',
      'due_date',
      'parent_task_id',
      'current_board_related_task_count',
      'current_board_related_tasks',
    ]) {
      if (source[key] !== undefined) compact[key] = source[key];
    }
    return compact;
  });

  return { success: true, primary_match: compactRows[0] ?? null, data: compactRows };
}

function formatSearchDate(value: unknown): string | null {
  const iso = parseIsoCalendarDate(value);
  if (!iso) return null;
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function formatSearchResults(rows: Array<Record<string, unknown>>, searchText: string | undefined): string {
  if (rows.length === 0) {
    return searchText
      ? `Nenhuma tarefa encontrada para "${searchText}".`
      : 'Nenhuma tarefa encontrada.';
  }

  const header = rows.length === 1 ? '1 tarefa encontrada:' : `${rows.length} tarefas encontradas:`;
  const lines = rows.slice(0, 10).map((row) => {
    const id = typeof row.id === 'string' ? row.id : 'sem-id';
    const title = typeof row.title === 'string' ? row.title : 'Sem título';
    const parts: string[] = [];
    if (typeof row.column === 'string' && row.column.length > 0) parts.push(row.column);
    const dueDate = formatSearchDate(row.due_date);
    if (dueDate) parts.push(`prazo ${dueDate}`);
    if (typeof row.parent_task_id === 'string' && row.parent_task_id.length > 0) {
      const parentTitle = typeof row.parent_title === 'string' && row.parent_title.length > 0
        ? ` — ${row.parent_title}`
        : '';
      parts.push(`projeto ${row.parent_task_id}${parentTitle}`);
    }
    return `• ${id} — ${title}${parts.length ? ` (${parts.join('; ')})` : ''}`;
  });
  return [header, ...lines].join('\n');
}

function compactSearchQueryResult(result: unknown, searchText: string | undefined): unknown {
  if (
    !result ||
    typeof result !== 'object' ||
    (result as { success?: unknown }).success !== true
  ) {
    return result;
  }
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return result;

  const rows = data
    .map((row) => pickTaskSummary(row as Record<string, unknown> | null | undefined))
    .filter((row): row is Record<string, unknown> => row !== null);

  return {
    success: true,
    result_count: rows.length,
    primary_match: rows[0] ?? null,
    formatted_search_results: formatSearchResults(rows, searchText),
    data: rows,
  };
}

export const apiCreateSimpleTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_create_simple_task',
    description: 'Create a simple task via the REST API',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        sender_name: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        due_date: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
      },
      required: ['title', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const title = requireString(args, 'title');
    if (title === null) return err('title: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');

    let assignee: string | undefined;
    if (args.assignee !== undefined) {
      if (typeof args.assignee !== 'string') return err('assignee: expected string');
      assignee = args.assignee;
    }
    let priority: Priority | undefined;
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority as Priority)) {
        return err(`priority: expected one of ${PRIORITIES.join(' | ')}`);
      }
      priority = args.priority as Priority;
    }
    let dueDate: string | null | undefined;
    if (args.due_date !== undefined) {
      if (args.due_date !== null && typeof args.due_date !== 'string') {
        return err('due_date: expected string or null');
      }
      dueDate = args.due_date;
    }
    if (args.description !== undefined) {
      if (args.description !== null && typeof args.description !== 'string') {
        return err('description: expected string or null');
      }
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      const result = engine.create({
        board_id: boardId,
        type: 'inbox',
        title,
        sender_name: senderName,
        assignee,
        priority,
        due_date: dueDate ?? undefined,
      });
      return finalizeCreatedTaskResult(db, engine, boardId, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiCreateMeetingTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_create_meeting_task',
    description:
      'Create a meeting-type task. Meetings use scheduled_at (not due_date) and can carry participants. Engine will reject if due_date is supplied or if recurrence is set without scheduled_at.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        sender_name: { type: 'string' },
        scheduled_at: { type: ['string', 'null'] },
        participants: { type: 'array', items: { type: 'string' } },
        assignee: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        recurrence: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
        recurrence_anchor: { type: 'string' },
        recurrence_end_date: { type: 'string' },
        max_cycles: { type: 'integer' },
        intended_weekday: { type: 'string' },
        allow_non_business_day: { type: 'boolean' },
        due_date: { type: ['string', 'null'] },
        requires_close_approval: { type: 'boolean' },
      },
      required: ['title', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return validationError('board_id: required string');
    const title = requireString(args, 'title');
    if (title === null) return validationError('title: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return validationError('sender_name: required string');

    let scheduledAt: string | undefined;
    if (args.scheduled_at !== undefined && args.scheduled_at !== null) {
      if (typeof args.scheduled_at !== 'string') return validationError('scheduled_at: expected string or null');
      scheduledAt = args.scheduled_at;
    }
    let participants: string[] | undefined;
    if (args.participants !== undefined) {
      if (!Array.isArray(args.participants) || args.participants.some((p) => typeof p !== 'string')) {
        return validationError('participants: expected array of strings');
      }
      participants = args.participants as string[];
    }
    let assignee: string | undefined;
    if (args.assignee !== undefined) {
      if (typeof args.assignee !== 'string') return validationError('assignee: expected string');
      assignee = args.assignee;
    }
    let priority: Priority | undefined;
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority as Priority)) {
        return validationError(`priority: expected one of ${PRIORITIES.join(' | ')}`);
      }
      priority = args.priority as Priority;
    }
    let recurrence: 'daily' | 'weekly' | 'monthly' | 'yearly' | undefined;
    if (args.recurrence !== undefined) {
      if (
        args.recurrence !== 'daily' &&
        args.recurrence !== 'weekly' &&
        args.recurrence !== 'monthly' &&
        args.recurrence !== 'yearly'
      ) {
        return validationError('recurrence: expected one of daily | weekly | monthly | yearly');
      }
      recurrence = args.recurrence;
    }
    let recurrenceAnchor: string | undefined;
    if (args.recurrence_anchor !== undefined) {
      if (typeof args.recurrence_anchor !== 'string') return validationError('recurrence_anchor: expected string');
      recurrenceAnchor = args.recurrence_anchor;
    }
    let recurrenceEndDate: string | undefined;
    if (args.recurrence_end_date !== undefined) {
      if (typeof args.recurrence_end_date !== 'string') return validationError('recurrence_end_date: expected string');
      recurrenceEndDate = args.recurrence_end_date;
    }
    let maxCycles: number | undefined;
    if (args.max_cycles !== undefined) {
      if (typeof args.max_cycles !== 'number' || !Number.isInteger(args.max_cycles)) {
        return validationError('max_cycles: expected integer');
      }
      maxCycles = args.max_cycles;
    }
    let intendedWeekday: string | undefined;
    if (args.intended_weekday !== undefined) {
      if (typeof args.intended_weekday !== 'string') return validationError('intended_weekday: expected string');
      intendedWeekday = args.intended_weekday;
    }
    let allowNonBusinessDay: boolean | undefined;
    if (args.allow_non_business_day !== undefined) {
      if (typeof args.allow_non_business_day !== 'boolean') {
        return validationError('allow_non_business_day: expected boolean');
      }
      allowNonBusinessDay = args.allow_non_business_day;
    }
    let dueDate: string | undefined;
    if (args.due_date !== undefined && args.due_date !== null) {
      if (typeof args.due_date !== 'string') return validationError('due_date: expected string or null');
      dueDate = args.due_date;
    }
    let requiresCloseApproval: boolean | undefined;
    if (args.requires_close_approval !== undefined) {
      if (typeof args.requires_close_approval !== 'boolean') {
        return validationError('requires_close_approval: expected boolean');
      }
      requiresCloseApproval = args.requires_close_approval;
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      const result = engine.create({
        board_id: boardId,
        type: 'meeting',
        title,
        sender_name: senderName,
        assignee,
        priority,
        scheduled_at: scheduledAt,
        participants,
        recurrence,
        recurrence_anchor: recurrenceAnchor,
        recurrence_end_date: recurrenceEndDate,
        max_cycles: maxCycles,
        intended_weekday: intendedWeekday,
        allow_non_business_day: allowNonBusinessDay,
        due_date: dueDate,
        requires_close_approval: requiresCloseApproval,
      });
      return finalizeCreatedTaskResult(db, engine, boardId, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiDeleteSimpleTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_delete_simple_task',
    description: 'Delete a simple task via the REST API, enforcing creator/Gestor/service ownership',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        sender_is_service: { type: 'boolean' },
      },
      required: ['task_id', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;

    const engine = new TaskflowEngine(getTaskflowDb(), parsed.boardId);
    const result = engine.apiDeleteSimpleTask({
      board_id: parsed.boardId,
      task_id: parsed.taskId,
      sender_name: parsed.senderName,
      sender_is_service: parsed.senderIsService,
    });
    // Mirror api_admin(reparent_task): a same-turn create-then-delete must
    // not leave its pending "Tarefa criada" card behind. Task-id-matched
    // so an unrelated sibling create's card is preserved.
    if (result.success) clearPendingCreateCard(parsed.taskId);
    return jsonResponse(result);
  },
};

export const apiMoveTool: McpToolDefinition = {
  tool: {
    name: 'api_move',
    description:
      'Move one task or a batch of tasks across the state machine. Preserve board-prefixed task IDs exactly, e.g. SEC-T41 must stay SEC-T41, not T41. Actions: start, wait, resume, return, review, approve, reject, conclude, reopen, force_start. Use task_ids for explicit bulk approvals such as "aprovar todas as tarefas de Nome" after querying review candidates. Engine enforces from-column transition + role-based permissions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'string' } },
        action: { type: 'string', enum: [...MOVE_ACTIONS] },
        sender_name: { type: 'string' },
        reason: { type: 'string' },
        subtask_id: { type: 'string' },
        confirmed_task_id: { type: 'string' },
      },
      required: ['action', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');
    if (typeof args.action !== 'string' || !MOVE_ACTIONS.includes(args.action as MoveAction)) {
      return err(`action: expected one of ${MOVE_ACTIONS.join(' | ')}`);
    }
    const action = args.action as MoveAction;

    let taskIds: string[];
    if (args.task_ids !== undefined) {
      if (!Array.isArray(args.task_ids) || args.task_ids.some((id) => typeof id !== 'string')) {
        return err('task_ids: expected array of strings');
      }
      taskIds = args.task_ids as string[];
      if (taskIds.length === 0) return err('task_ids: expected at least one task id');
      if (args.task_id !== undefined) return err('provide either task_id or task_ids, not both');
    } else {
      const taskId = requireString(args, 'task_id');
      if (taskId === null) return err('task_id: required string');
      taskIds = [taskId];
    }

    let reason: string | undefined;
    if (args.reason !== undefined) {
      if (typeof args.reason !== 'string') return err('reason: expected string');
      reason = args.reason;
    }
    let subtaskId: string | undefined;
    if (args.subtask_id !== undefined) {
      if (typeof args.subtask_id !== 'string') return err('subtask_id: expected string');
      subtaskId = args.subtask_id;
    }
    let confirmedTaskId: string | undefined;
    if (args.confirmed_task_id !== undefined) {
      if (typeof args.confirmed_task_id !== 'string') return err('confirmed_task_id: expected string');
      confirmedTaskId = args.confirmed_task_id;
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      if (taskIds.length === 1) {
        const result = engine.move({
          board_id: boardId,
          task_id: taskIds[0],
          action,
          sender_name: senderName,
          reason,
          subtask_id: subtaskId,
          confirmed_task_id: confirmedTaskId,
        });
        return finalizeMutationResult(addMoveFormattedResult(result, action));
      }

      const results: MoveResult[] = [];
      for (const taskId of taskIds) {
        const result = engine.move({
          board_id: boardId,
          task_id: taskId,
          action,
          sender_name: senderName,
          reason,
          subtask_id: subtaskId,
          confirmed_task_id: confirmedTaskId,
        });
        results.push(result);
      }
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);
      const formatted = [
        `${successes.length} de ${results.length} tarefa(s) processada(s) com ação "${action}".`,
        ...successes.map((r) => `- ${r.task_id} — ${r.title ?? ''}`.trim()),
        ...failures.map((r) => `- ${r.task_id ?? 'unknown'} falhou: ${r.error ?? 'erro desconhecido'}`),
      ].join('\n');
      // Normalize each SUCCESSFUL result individually so per-task
      // parent_notification rollups (returned separately from notifications,
      // engine move:5070) survive — and so one task's notification can't
      // suppress another's via the normalizer's per-result jid-dedup.
      // (#389; Codex High-2). Fail-soft per result (these moves have committed,
      // so a malformed notification must not throw and fail the bulk result).
      const eventsPerSuccess = bulkMoveNotificationEvents(successes);
      const notification_events = eventsPerSuccess.flat();
      // #396: persist each sub-move's deferred cross-board notifications (keyed by
      // that sub-task's id) before dispatch — the bulk path doesn't go through
      // finalizeMutationResult, so it must enqueue here too. In-session, fail-soft.
      // Reuse the already-normalized events (was normalized a second time here).
      successes.forEach((r, i) => {
        enqueueDeferredNotificationsInSession(
          process.env.NANOCLAW_TASKFLOW_BOARD_ID,
          eventsPerSuccess[i],
          typeof r.task_id === 'string' ? r.task_id : null,
          {},
        );
      });
      dispatchNotificationEvents(notification_events);
      return jsonResponse({
        success: failures.length === 0,
        data: {
          bulk: true,
          action,
          processed_count: results.length,
          success_count: successes.length,
          failure_count: failures.length,
          results: results.map(({ notifications: _notifications, ...result }) => result),
          formatted,
        },
        notification_events,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

/**
 * Drag-to-column move for UI clients (the dashboard Kanban). Accepts a target
 * column and resolves the state-machine action engine-side via
 * resolveColumnMoveAction, so the transition table has a single source of truth
 * (no FastAPI/engine drift). Permission + transition rules and structured
 * error_codes come from move(). FastAPI maps error_code → HTTP status.
 */
export const apiMoveToColumnTool: McpToolDefinition = {
  tool: {
    name: 'api_move_to_column',
    description:
      'Move a single task to a target column (UI drag/drop). The engine resolves the right state-machine action from (current column → to_column) and enforces transition + role rules. to_column one of: inbox, next_action, in_progress, waiting, review, done. Cancelling a task is NOT a move — use api_admin cancel_task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        to_column: { type: 'string' },
        sender_name: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['task_id', 'to_column', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const taskId = requireString(args, 'task_id');
    if (taskId === null) return err('task_id: required string');
    const toColumn = requireString(args, 'to_column');
    if (toColumn === null) return err('to_column: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');
    let reason: string | undefined;
    if (args.reason !== undefined) {
      if (typeof args.reason !== 'string') return err('reason: expected string');
      reason = args.reason;
    }
    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      const result = engine.moveToColumn({ board_id: boardId, task_id: taskId, to_column: toColumn, sender_name: senderName, reason });
      // Reuse the move formatter when an action actually ran (success path).
      return finalizeMutationResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiAdminTool: McpToolDefinition = {
  tool: {
    name: 'api_admin',
    description:
      'Board/team administration actions. Engine validates per-action required params (e.g. cancel_task needs task_id; set_wip_limit needs person_name + wip_limit; set_cross_board_subtask_mode needs cross_board_subtask_mode=open|approval|blocked; reparent_task needs task_id + target_parent_id; manage_holidays needs holiday_operation).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...ADMIN_ACTIONS] },
        sender_name: { type: 'string' },
        person_name: { type: 'string' },
        phone: { type: 'string' },
        role: { type: 'string' },
        wip_limit: { type: 'number' },
        cross_board_subtask_mode: { type: 'string', enum: [...CROSS_BOARD_SUBTASK_MODES] },
        task_id: { type: 'string' },
        confirmed: { type: 'boolean' },
        force: { type: 'boolean' },
        group_name: { type: 'string' },
        group_folder: { type: 'string' },
        holiday_operation: { type: 'string', enum: [...HOLIDAY_OPS] },
        holidays: { type: 'array' },
        holiday_dates: { type: 'array', items: { type: 'string' } },
        holiday_year: { type: 'integer' },
        note_id: { type: 'integer' },
        create: { type: 'object' },
        sender_external_id: { type: 'string' },
        target_parent_id: { type: 'string' },
        source_project_id: { type: 'string' },
        target_project_id: { type: 'string' },
        request_id: { type: 'string' },
        decision: { type: 'string', enum: [...ADMIN_DECISIONS] },
        reason: { type: 'string' },
      },
      required: ['action', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');
    if (typeof args.action !== 'string' || !ADMIN_ACTIONS.includes(args.action as AdminAction)) {
      return err(`action: expected one of ${ADMIN_ACTIONS.join(' | ')}`);
    }
    const action = args.action as AdminAction;

    // Type-check each AdminParams optional field. Engine handles
    // per-action presence/value validation; we only police shapes.
    const adminParams: AdminParams = {
      board_id: boardId,
      action,
      sender_name: senderName,
    };

    for (const key of [
      'person_name', 'phone', 'role', 'task_id', 'group_name', 'group_folder',
      'sender_external_id', 'target_parent_id', 'source_project_id',
      'target_project_id', 'request_id', 'reason',
    ] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'string') return err(`${key}: expected string`);
        adminParams[key] = args[key];
      }
    }
    if (args.wip_limit !== undefined) {
      if (typeof args.wip_limit !== 'number') return err('wip_limit: expected number');
      adminParams.wip_limit = args.wip_limit;
    }
    if (args.cross_board_subtask_mode !== undefined) {
      if (typeof args.cross_board_subtask_mode !== 'string' ||
          !CROSS_BOARD_SUBTASK_MODES.includes(args.cross_board_subtask_mode as CrossBoardSubtaskMode)) {
        return err(`cross_board_subtask_mode: expected one of ${CROSS_BOARD_SUBTASK_MODES.join(' | ')}`);
      }
      adminParams.cross_board_subtask_mode = args.cross_board_subtask_mode as CrossBoardSubtaskMode;
    }
    for (const key of ['holiday_year', 'note_id'] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'number' || !Number.isInteger(args[key])) {
          return err(`${key}: expected integer`);
        }
        adminParams[key] = args[key];
      }
    }
    for (const key of ['confirmed', 'force'] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'boolean') return err(`${key}: expected boolean`);
        adminParams[key] = args[key];
      }
    }
    if (args.holiday_operation !== undefined) {
      if (typeof args.holiday_operation !== 'string' ||
          !HOLIDAY_OPS.includes(args.holiday_operation as HolidayOp)) {
        return err(`holiday_operation: expected one of ${HOLIDAY_OPS.join(' | ')}`);
      }
      adminParams.holiday_operation = args.holiday_operation as HolidayOp;
    }
    if (args.decision !== undefined) {
      if (typeof args.decision !== 'string' ||
          !ADMIN_DECISIONS.includes(args.decision as AdminDecision)) {
        return err(`decision: expected one of ${ADMIN_DECISIONS.join(' | ')}`);
      }
      // Per-action narrowing: handle_subtask_approval only accepts approve|reject
      // (engine reads it as an approval verdict). process_minutes_decision only
      // accepts create_task|create_inbox (engine reads it as a routing choice and
      // mishandles approve/reject — see taskflow-engine.ts:8004).
      if (action === 'handle_subtask_approval' && args.decision !== 'approve' && args.decision !== 'reject') {
        return err(`decision: handle_subtask_approval requires "approve" or "reject"`);
      }
      if (action === 'process_minutes_decision' && args.decision !== 'create_task' && args.decision !== 'create_inbox') {
        return err(`decision: process_minutes_decision requires "create_task" or "create_inbox"`);
      }
      adminParams.decision = args.decision as AdminDecision;
    }
    if (args.holidays !== undefined) {
      if (!Array.isArray(args.holidays)) return err('holidays: expected array');
      for (let i = 0; i < args.holidays.length; i++) {
        const h = args.holidays[i];
        if (!h || typeof h !== 'object' || Array.isArray(h)) {
          return err(`holidays[${i}]: expected object`);
        }
        if (typeof (h as { date?: unknown }).date !== 'string') {
          return err(`holidays[${i}].date: expected string`);
        }
        const label = (h as { label?: unknown }).label;
        if (label !== undefined && typeof label !== 'string') {
          return err(`holidays[${i}].label: expected string`);
        }
      }
      adminParams.holidays = args.holidays;
    }
    if (args.holiday_dates !== undefined) {
      if (!Array.isArray(args.holiday_dates) ||
          args.holiday_dates.some((d) => typeof d !== 'string')) {
        return err('holiday_dates: expected array of strings');
      }
      adminParams.holiday_dates = args.holiday_dates;
    }
    if (args.create !== undefined) {
      if (typeof args.create !== 'object' || args.create === null || Array.isArray(args.create)) {
        return err('create: expected object');
      }
      const c = args.create as Record<string, unknown>;
      if (typeof c.type !== 'string') return err('create.type: expected string');
      if (typeof c.title !== 'string') return err('create.title: expected string');
      if (c.assignee !== undefined && typeof c.assignee !== 'string') {
        return err('create.assignee: expected string');
      }
      if (c.labels !== undefined) {
        if (!Array.isArray(c.labels) || c.labels.some((l) => typeof l !== 'string')) {
          return err('create.labels: expected array of strings');
        }
      }
      adminParams.create = args.create as AdminParams['create'];
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const result = engine.admin(adminParams);
      // #390: register_person on a delegating hierarchy board returns an
      // auto_provision_request — emit provision_child_board deterministically
      // (V1 parity) so the child board is created without the agent relaying.
      emitAutoProvisionIfRequested(result);
      // A successful reparent supersedes the pending standalone create
      // card for THE REPARENTED task — create-then-reparent nets ONE
      // card (the reparent's "adicionada"). Task-id-matched so a reparent
      // of an unrelated task can't drop a sibling create. See mutation-dedup.ts #7.
      if (adminParams.action === 'reparent_task' && result.success && adminParams.task_id) {
        clearPendingCreateCard(adminParams.task_id);
      }
      return finalizeMutationResult(addReparentFormattedResult(result, adminParams.action));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiReassignTool: McpToolDefinition = {
  tool: {
    name: 'api_reassign',
    description:
      'Reassign a single task (task_id) or bulk-transfer all active tasks from one person (source_person) to another (target_person). Use this for explicit assignment commands such as "atribuir P11.23 para Rodrigo"; do not route those through api_update_simple_task. Engine requires confirmed=true to commit; confirmed=false runs a dry-run that returns a human-readable summary in `requires_confirmation`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_person: { type: 'string' },
        sender_name: { type: 'string' },
        confirmed: { type: 'boolean' },
        task_id: { type: 'string' },
        source_person: { type: 'string' },
      },
      required: ['target_person', 'sender_name', 'confirmed'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return validationError('board_id: required string');
    const targetPerson = requireString(args, 'target_person');
    if (targetPerson === null) return validationError('target_person: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return validationError('sender_name: required string');
    if (typeof args.confirmed !== 'boolean') return validationError('confirmed: required boolean');
    const confirmed = args.confirmed;

    let taskId: string | undefined;
    if (args.task_id !== undefined) {
      if (typeof args.task_id !== 'string') return validationError('task_id: expected string');
      taskId = args.task_id;
    }
    let sourcePerson: string | undefined;
    if (args.source_person !== undefined) {
      if (typeof args.source_person !== 'string') return validationError('source_person: expected string');
      sourcePerson = args.source_person;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      // Capture the pre-reassign assignee NAME for the De/Para card — getTask
      // post-commit returns the NEW assignee. Best-effort: never block the
      // mutation on this (mirrors the poll-loop deterministic path).
      let fromAssignee: string | undefined;
      try {
        if (taskId) {
          const pre = engine.getTask(taskId);
          if (pre?.assignee) fromAssignee = engine.resolvePerson(pre.assignee)?.name ?? undefined;
        }
      } catch {
        /* best-effort — fall back to the short card */
      }
      const reassignParams: ReassignParams = {
        board_id: boardId,
        target_person: targetPerson,
        sender_name: senderName,
        confirmed,
        task_id: taskId,
        source_person: sourcePerson,
      };
      const result = engine.reassign(reassignParams);
      // Mirror v1 (poll-loop.ts:2320,2339): canonicalize raw target_person
      // to the board_people display name before formatting the v1 card.
      // Codex hot-path gate P1: raw input drift (e.g. 'lucas' → 'Lucas').
      // Fail-soft: this is a post-commit DB read inside the broad catch below, so
      // a throw here must NOT turn the committed reassign into success:false —
      // fall back to the raw target (same invariant as buildReassignInfo).
      let canonicalTarget = targetPerson;
      try {
        canonicalTarget = engine.resolvePerson(targetPerson)?.name ?? targetPerson;
      } catch {
        /* keep raw targetPerson */
      }
      // Rich single-task card (Phase-3 Turn-37 / De-Para). buildReassignInfo gates
      // the lookup off in the tf-mcontrol subprocess and is fail-soft — the
      // reassign has already committed, so a lookup throw must NOT escape into the
      // catch below and report success:false. Same resolver as the poll-loop path.
      const affected = result.tasks_affected ?? [];
      const info = affected.length === 1 ? buildReassignInfo(engine, affected[0].task_id, fromAssignee) : null;
      return finalizeMutationResult(addReassignFormattedResult(result, canonicalTarget, info));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiUndoTool: McpToolDefinition = {
  tool: {
    name: 'api_undo',
    description:
      'Undo the most recent task mutation on the board. Only the mutation author or a manager may undo. Engine rejects undo of creation (use api_admin cancel_task instead) and undo into in_progress that exceeds the assignee WIP limit (set force=true to override, manager-only).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sender_name: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return err('sender_name: required string');

    let force: boolean | undefined;
    if (args.force !== undefined) {
      if (typeof args.force !== 'boolean') return err('force: expected boolean');
      force = args.force;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const undoParams: UndoParams = {
        board_id: boardId,
        sender_name: senderName,
        force,
      };
      const result = engine.undo(undoParams);
      return finalizeMutationResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiReportTool: McpToolDefinition = {
  tool: {
    name: 'api_report',
    description:
      'Build a board report. type=standup returns the daily-standup shape (overdue/in_progress/review/due_today/waiting/blocked/per_person) AND runs the bundled housekeeping that v1 ran inline: auto-archives done tasks older than 30 days (cleanup failures are swallowed and never break the report). type=digest adds next_48h, completed_today, stale_24h, inbox, and a formatted_report string. type=weekly adds completed_week, waiting_5d, next_week_deadlines, stale_tasks, and stats (total_active, completed_week, created_week, trend).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: [...REPORT_TYPES] },
      },
      required: ['type'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return err('board_id: required string');
    if (typeof args.type !== 'string' || !REPORT_TYPES.includes(args.type as ReportType)) {
      return err(`type: expected one of ${REPORT_TYPES.join(' | ')}`);
    }
    const reportType = args.type as ReportType;

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const reportParams: ReportParams = { board_id: boardId, type: reportType };
      const result = engine.report(reportParams);
      return jsonResponse(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiCreateTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_create_task',
    description:
      'Create a task of type simple/project/recurring/inbox. Use this only when the user explicitly asks to create/register/add/capture work. MUST NOT call this for bare standalone goal/activity phrases like "Aguardar e acompanhar X", "Submeter X", or "Realizar X"; those are ambiguous and must be confirmed first. Portuguese "Anotar: X. Atribuir/Delegar/Responsável: Y" is an explicit assigned task creation command, not a note update request and not a reason to ask for a task ID. type=simple goes to next_action; type=inbox stays in inbox; type=project allocates a P-prefix id and creates subtask rows; type=recurring allocates the recurrence cycle. Use api_create_meeting_task for meetings. If the user is adding a new task to an existing project by explicit ID (for example "P11 acrescentar tarefa X" or "adicionar em P3 a tarefa X"), first create type=simple, then call api_admin action=reparent_task with task_id=data.id and target_parent_id=P11/P3. If the user names the existing project by title (for example "Projeto de Operação da SECTI adicionar tarefa X") and the project is identifiable, do NOT use api_create_task; use api_update_task with updates.add_subtask on the matched project id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: [...CREATE_TASK_TYPES] },
        title: { type: 'string' },
        sender_name: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        due_date: { type: ['string', 'null'] },
        labels: { type: 'array', items: { type: 'string' } },
        subtasks: { type: 'array' },
        recurrence: { type: 'string', enum: [...RECURRENCES] },
        recurrence_anchor: { type: 'string' },
        recurrence_end_date: { type: 'string' },
        max_cycles: { type: 'integer' },
        allow_non_business_day: { type: 'boolean' },
        intended_weekday: { type: 'string' },
        requires_close_approval: { type: 'boolean' },
        force_create: {
          type: 'boolean',
          description:
            'Set true to bypass duplicate detection (lexical + semantic) and create the task anyway. Use ONLY after the user has explicitly confirmed they want it despite a near-duplicate warning.',
        },
      },
      required: ['title', 'sender_name', 'type'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return validationError('board_id: required string');
    const title = requireString(args, 'title');
    if (title === null) return validationError('title: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return validationError('sender_name: required string');
    if (
      typeof args.type !== 'string' ||
      !CREATE_TASK_TYPES.includes(args.type as CreateTaskType)
    ) {
      return validationError(`type: expected one of ${CREATE_TASK_TYPES.join(' | ')}`);
    }
    const taskType = args.type as CreateTaskType;

    let assignee: string | undefined;
    if (args.assignee !== undefined) {
      if (typeof args.assignee !== 'string') return validationError('assignee: expected string');
      assignee = args.assignee;
    }
    let priority: Priority | undefined;
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority as Priority)) {
        return validationError(`priority: expected one of ${PRIORITIES.join(' | ')}`);
      }
      priority = args.priority as Priority;
    }
    let dueDate: string | undefined;
    if (args.due_date !== undefined && args.due_date !== null) {
      if (typeof args.due_date !== 'string') return validationError('due_date: expected string or null');
      dueDate = args.due_date;
    }
    let labels: string[] | undefined;
    if (args.labels !== undefined) {
      if (!Array.isArray(args.labels) || args.labels.some((l) => typeof l !== 'string')) {
        return validationError('labels: expected array of strings');
      }
      labels = args.labels as string[];
    }
    // Subtasks accept either a string (title-only) or {title, assignee?}.
    // We validate shape but defer assignee-resolution to the engine.
    let subtasks: Array<string | { title: string; assignee?: string }> | undefined;
    if (args.subtasks !== undefined) {
      if (!Array.isArray(args.subtasks)) return validationError('subtasks: expected array');
      const validated: Array<string | { title: string; assignee?: string }> = [];
      for (let i = 0; i < args.subtasks.length; i++) {
        const sub = args.subtasks[i];
        if (typeof sub === 'string') {
          validated.push(sub);
        } else if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
          const s = sub as Record<string, unknown>;
          if (typeof s.title !== 'string') return validationError(`subtasks[${i}].title: expected string`);
          if (s.assignee !== undefined && typeof s.assignee !== 'string') {
            return validationError(`subtasks[${i}].assignee: expected string`);
          }
          validated.push({ title: s.title, assignee: s.assignee as string | undefined });
        } else {
          return validationError(`subtasks[${i}]: expected string or object`);
        }
      }
      subtasks = validated;
    }
    let recurrence: Recurrence | undefined;
    if (args.recurrence !== undefined) {
      if (
        typeof args.recurrence !== 'string' ||
        !RECURRENCES.includes(args.recurrence as Recurrence)
      ) {
        return validationError(`recurrence: expected one of ${RECURRENCES.join(' | ')}`);
      }
      recurrence = args.recurrence as Recurrence;
    }
    let recurrenceAnchor: string | undefined;
    if (args.recurrence_anchor !== undefined) {
      if (typeof args.recurrence_anchor !== 'string') return validationError('recurrence_anchor: expected string');
      recurrenceAnchor = args.recurrence_anchor;
    }
    let recurrenceEndDate: string | undefined;
    if (args.recurrence_end_date !== undefined) {
      if (typeof args.recurrence_end_date !== 'string') return validationError('recurrence_end_date: expected string');
      recurrenceEndDate = args.recurrence_end_date;
    }
    let maxCycles: number | undefined;
    if (args.max_cycles !== undefined) {
      if (typeof args.max_cycles !== 'number' || !Number.isInteger(args.max_cycles)) {
        return validationError('max_cycles: expected integer');
      }
      maxCycles = args.max_cycles;
    }
    let intendedWeekday: string | undefined;
    if (args.intended_weekday !== undefined) {
      if (typeof args.intended_weekday !== 'string') return validationError('intended_weekday: expected string');
      intendedWeekday = args.intended_weekday;
    }
    let allowNonBusinessDay: boolean | undefined;
    if (args.allow_non_business_day !== undefined) {
      if (typeof args.allow_non_business_day !== 'boolean') {
        return validationError('allow_non_business_day: expected boolean');
      }
      allowNonBusinessDay = args.allow_non_business_day;
    }
    let requiresCloseApproval: boolean | undefined;
    if (args.requires_close_approval !== undefined) {
      if (typeof args.requires_close_approval !== 'boolean') {
        return validationError('requires_close_approval: expected boolean');
      }
      requiresCloseApproval = args.requires_close_approval;
    }

    if (args.force_create !== undefined && typeof args.force_create !== 'boolean') {
      return validationError('force_create: expected boolean');
    }

    try {
      const db = getTaskflowDb();
      const engine = new TaskflowEngine(db, boardId);
      // force_create (template L1270) bypasses BOTH dup checks — the user has
      // explicitly confirmed they want the task despite a near-duplicate.
      if (args.force_create !== true) {
        const duplicate = findDuplicateCreateCandidate(db, engine, boardId, taskType, title, assignee);
        if (duplicate) return duplicateCreateResponse(engine, duplicate);
        // #392 semantic check (env-gated → no-op without Ollama). >= hard refuses;
        // [soft, hard) asks the user — same duplicate_candidate as the lexical path.
        const embedDup = await maybeFindEmbedDuplicate(db, boardId, taskType, title);
        if (embedDup) return resolveEmbedDuplicate(engine, embedDup);
      }
      const result = engine.create({
        board_id: boardId,
        type: taskType,
        title,
        sender_name: senderName,
        assignee,
        priority,
        due_date: dueDate,
        labels,
        subtasks,
        recurrence,
        recurrence_anchor: recurrenceAnchor,
        recurrence_end_date: recurrenceEndDate,
        max_cycles: maxCycles,
        intended_weekday: intendedWeekday,
        allow_non_business_day: allowNonBusinessDay,
        requires_close_approval: requiresCloseApproval,
      });
      return finalizeCreatedTaskResult(db, engine, boardId, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiUpdateTaskTool: McpToolDefinition = {
  tool: {
    name: 'api_update_task',
    description:
      "Apply a v1-shape composite update to a task. The `updates` object accepts any field engine.update's UpdateParams.updates supports: title, priority, requires_close_approval, due_date, description, next_action, add_label, remove_label, add_note, edit_note ({id, text}), remove_note, parent_note_id, scheduled_at, participant ops, set_note_status, subtask ops (add/rename/reopen/assign/unassign), recurrence ops. Engine validates per-sub-key. Use updates.add_subtask for subtask/step/ACTIVITY wording — \"adicionar etapa P3: X\", \"incluir na P22 uma atividade X\", \"adicionar atividade no P3\" — where etapa/atividade/step/activity all denote a subtask; also for named-project requests like \"Projeto de Operação da SECTI adicionar tarefa X\". This is ALWAYS a single api_update_task call — never split it into api_update_task + api_create_task. updates.add_subtask accepts either a string title or an object `{title, due_date?}` where due_date is ISO YYYY-MM-DD applied to the new subtask. Only the literal-\"tarefa\" project-ID add command — \"adicionar em P3 a tarefa X\" — mirrors v1 as api_create_task(type=simple) followed by api_admin(reparent_task); subtask/activity wording does NOT.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        updates: { type: 'object' },
        sender_external_id: { type: 'string' },
        confirmed_task_id: { type: 'string' },
      },
      required: ['task_id', 'sender_name', 'updates'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    const { boardId, taskId, senderName } = parsed;

    if (args.updates === undefined) return validationError('updates: required object');
    if (
      args.updates === null ||
      typeof args.updates !== 'object' ||
      Array.isArray(args.updates)
    ) {
      return validationError('updates: expected object');
    }
    let senderExternalId: string | undefined;
    if (args.sender_external_id !== undefined) {
      if (typeof args.sender_external_id !== 'string') return validationError('sender_external_id: expected string');
      senderExternalId = args.sender_external_id;
    }
    let confirmedTaskId: string | undefined;
    if (args.confirmed_task_id !== undefined) {
      if (typeof args.confirmed_task_id !== 'string') return validationError('confirmed_task_id: expected string');
      confirmedTaskId = args.confirmed_task_id;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const updates = args.updates as Record<string, unknown>;
      const updateParams: UpdateParams = {
        board_id: boardId,
        task_id: taskId,
        sender_name: senderName,
        updates: updates as UpdateParams['updates'],
        sender_external_id: senderExternalId,
        confirmed_task_id: confirmedTaskId,
      };
      const result = engine.update(updateParams);
      // (hoje) tag needs today in board-local tz; only computed when relevant.
      let today: string | undefined;
      let timeZone = 'America/Fortaleza';
      if (updates.add_subtask !== undefined || updates.scheduled_at !== undefined) {
        timeZone = safeBoardTimeZone(getTaskflowDb(), boardId);
        if (updates.add_subtask !== undefined) {
          today = new Date().toLocaleDateString('en-CA', { timeZone });
        }
      }
      return finalizeMutationResult(addUpdateFormattedResult(result, updates, today, timeZone));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiQueryTool: McpToolDefinition = {
  tool: {
    name: 'api_query',
    description:
      "Composite read-side wrapper for engine.query. The `query` discriminator selects the sub-query: board, board_directory (org-tree board names and responsible people), projects (compact active project list), project_next_actions (one-shot next actions for every project), projects_detailed (projects + activities + note excerpts), task_details (needs task_id and returns compact formatted_task_details plus small task/subtask summaries; use this for IDs like P11), task_history (needs task_id), find_person_in_organization (needs search_text; scoped read across this board's org tree; returns person_id/name/phone_masked/board_id/board_group_folder/routing_jid/is_owner so cross-board sends/provisioning can reuse existing contacts instead of asking for phone numbers), find_task_in_organization (needs task_id; scoped read across this board's org tree — use this when task_details returns 'not found' for a task that may live on a sibling/parent board, mirrors find_person_in_organization), audit_v1_bugs (optional `since` ISO timestamp; returns same-task / same-user / <60min self-correction pairs on this board — date_field_correction, reassign_round_trip, conclude_reopen — for daily v1-bug monitoring), my_tasks/next_action/overdue/waiting/urgent/review/upcoming_meetings/meetings/summary/statistics/month_statistics (board-wide views), person_tasks/person_waiting/person_completed/person_review/person_statistics (need person_name), search/archive_search (need search_text), and others. Exact IDs stay exact: if the user says P6.7, call task_details/task_history with task_id=P6.7, not parent P6 or sibling P6.* tasks. Engine rejects unknown discriminators.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        sender_name: { type: 'string' },
        person_name: { type: 'string' },
        task_id: { type: 'string' },
        search_text: { type: 'string' },
        label: { type: 'string' },
        since: { type: 'string' },
        at: { type: 'string' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) {
      return validationError('board_id: required string');
    }
    const query = requireString(args, 'query');
    if (query === null) {
      return validationError('query: required string');
    }

    const queryParams: QueryParams = { query };
    for (const key of [
      'sender_name', 'person_name', 'task_id', 'search_text', 'label', 'since', 'at',
    ] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'string') {
          return validationError(`${key}: expected string`);
        }
        (queryParams as unknown as Record<string, unknown>)[key] = args[key];
      }
    }

    try {
      // {readonly: true} matches the other read-side tools (api_board_activity,
      // api_filter_board_tasks, api_linked_tasks). Without it the constructor
      // runs migrations + delegation-link reconciliation that mutates rows on
      // a supposedly read-only path. Codex flagged 2026-05-10.
      const engine = new TaskflowEngine(getTaskflowDb(), boardId, { readonly: true });
      // #385: query='search' now embeds the query + injects an EmbeddingReader
      // so the engine ranks semantically (collection tasks:<board>, merged with
      // lexical). No-op → lexical when the embed config / db is absent.
      const semanticReader = await maybeSemanticSearch(queryParams);
      try {
        const result = engine.query(queryParams);
        if (query === 'task_details') {
          return jsonResponse(compactTaskDetailsQueryResult(result));
        }
        if (query === 'find_task_in_organization') {
          return jsonResponse(compactFindTaskInOrganizationQueryResult(result));
        }
        if (query === 'search') {
          const compact = compactSearchQueryResult(result, queryParams.search_text);
          if (
            compact &&
            typeof compact === 'object' &&
            typeof (compact as { formatted_search_results?: unknown }).formatted_search_results === 'string'
          ) {
            emitDeterministicToolMessage(
              (compact as { formatted_search_results: string }).formatted_search_results,
            );
          }
          return jsonResponse(compact);
        }
        return jsonResponse(result);
      } finally {
        semanticReader?.close();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiHierarchyTool: McpToolDefinition = {
  tool: {
    name: 'api_hierarchy',
    description:
      "Hierarchy / parent-board linking ops via engine.hierarchy. Actions: link (delegate task to a child board owned by person_name); unlink (sever the child-board delegation); refresh_rollup (recompute the linked task's rollup status); tag_parent (mark this task as a child of parent_task_id on the parent board). User phrases like 'atualizar status P11.19' or 'sincronizar P11.19' mean action=refresh_rollup, not a request to ask which status to set.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...HIERARCHY_ACTIONS] },
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        person_name: { type: 'string' },
        parent_task_id: { type: 'string' },
      },
      required: ['action', 'task_id', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    const { boardId, taskId, senderName } = parsed;
    if (typeof args.action !== 'string' || !HIERARCHY_ACTIONS.includes(args.action as HierarchyAction)) {
      return validationError(`action: expected one of ${HIERARCHY_ACTIONS.join(' | ')}`);
    }
    const action = args.action as HierarchyAction;

    let personName: string | undefined;
    if (args.person_name !== undefined) {
      if (typeof args.person_name !== 'string') return validationError('person_name: expected string');
      personName = args.person_name;
    }
    let parentTaskId: string | undefined;
    if (args.parent_task_id !== undefined) {
      if (typeof args.parent_task_id !== 'string') return validationError('parent_task_id: expected string');
      parentTaskId = args.parent_task_id;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const params: HierarchyParams = {
        board_id: boardId,
        action,
        task_id: taskId,
        sender_name: senderName,
        person_name: personName,
        parent_task_id: parentTaskId,
      };
      const result = engine.hierarchy(params);
      return finalizeMutationResult(addHierarchyFormattedResult(result, action));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiDependencyTool: McpToolDefinition = {
  tool: {
    name: 'api_dependency',
    description:
      "Dependency + reminder ops via engine.dependency. Actions: add_dep / remove_dep (manage task blockers via target_task_id); add_reminder / remove_reminder (schedule a follow-up nudge via reminder_days from now).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: [...DEPENDENCY_ACTIONS] },
        task_id: { type: 'string' },
        sender_name: { type: 'string' },
        target_task_id: { type: 'string' },
        reminder_days: { type: 'integer' },
      },
      required: ['action', 'task_id', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const parsed = parseTaskActorArgs(args);
    if (!parsed.ok) return parsed.error;
    const { boardId, taskId, senderName } = parsed;
    if (
      typeof args.action !== 'string' ||
      !DEPENDENCY_ACTIONS.includes(args.action as DependencyAction)
    ) {
      return err(`action: expected one of ${DEPENDENCY_ACTIONS.join(' | ')}`);
    }
    const action = args.action as DependencyAction;

    let targetTaskId: string | undefined;
    if (args.target_task_id !== undefined) {
      if (typeof args.target_task_id !== 'string') return err('target_task_id: expected string');
      targetTaskId = args.target_task_id;
    }
    let reminderDays: number | undefined;
    if (args.reminder_days !== undefined) {
      if (typeof args.reminder_days !== 'number' || !Number.isInteger(args.reminder_days)) {
        return err('reminder_days: expected integer');
      }
      reminderDays = args.reminder_days;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const params: DependencyParams = {
        board_id: boardId,
        action,
        task_id: taskId,
        sender_name: senderName,
        target_task_id: targetTaskId,
        reminder_days: reminderDays,
      };
      const result = engine.dependency(params);
      return finalizeMutationResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

type MeetingResolution =
  | { ok: true; taskId: string }
  | { ok: false; response: ReturnType<typeof jsonResponse> };

// Resolve a `meeting` arg (explicit M-id or free-text name) to a unique task id.
// Shared by api_reschedule_meeting and api_note_meeting so the M-id type guard,
// name resolution, and 0/2+ ambiguity messages live in exactly one place.
function resolveMeetingTaskId(engine: TaskflowEngine, meeting: string, boardId: string): MeetingResolution {
  if (/^M\d+(?:\.\d+)?$/i.test(meeting.trim())) {
    // Explicit M-id may target a done meeting, but it MUST be a meeting ON THIS
    // board. getTask() also resolves meetings merely delegated here (child_exec) —
    // broader than this tool's contract and inconsistent with the board-local
    // name-resolution path below, so reject anything not owned by this board.
    const taskId = meeting.trim().toUpperCase();
    const task = engine.getTask(taskId);
    if (task?.type !== 'meeting' || task.board_id !== boardId) {
      return {
        ok: false,
        response: jsonResponse({ success: false, error_code: 'not_found', error: `${taskId} não é uma reunião neste quadro.` }),
      };
    }
    return { ok: true, taskId };
  }
  // Name → unique meeting among this board's non-done meetings; 0 or 2+ → ask.
  const candidates = engine.resolveMeetingCandidates(meeting);
  if (candidates.length === 0) {
    return {
      ok: false,
      response: jsonResponse({ success: false, error_code: 'not_found', error: `Não encontrei nenhuma reunião que corresponda a "${meeting}".` }),
    };
  }
  if (candidates.length > 1) {
    const list = candidates.map((m) => `${m.id} — ${m.title}`).join('; ');
    // 2+-match is a "did you mean?" disambiguation, NOT an error (Q6): the
    // payload is success:true with the candidates under `data` so the FastAPI
    // dashboard parser (keeps only result.data on success) renders a picker
    // instead of a 502. The discriminated-union `ok` stays FALSE, so both
    // callers short-circuit BEFORE engine.update — no mutation on an ambiguous
    // match. `error` carries the human prompt the WhatsApp agent relays.
    return {
      ok: false,
      response: jsonResponse({ success: true, error: `Encontrei ${candidates.length} reuniões que correspondem a "${meeting}". Qual delas? ${list}`, data: { candidates } }),
    };
  }
  return { ok: true, taskId: candidates[0].id };
}

export const apiRescheduleMeetingTool: McpToolDefinition = {
  tool: {
    name: 'api_reschedule_meeting',
    description:
      'Reschedule a meeting that the user referenced by NAME rather than by M-id. Use this — NOT api_query + api_update_task — for "reagendar/remarcar a reunião X para ...", "a reunião da SEMEC amanhã, muda o horário para 11h", "Reunião SDU Sul foi remarcada para terça às 9h". Pass `meeting` as the M-id OR a free-text name/description; the engine resolves it against THIS board\'s non-done meetings (scoped to meetings only, so simple tasks that share a keyword do not cause ambiguity) and reschedules the unique match. If zero or 2+ meetings match it returns an error/ambiguity so you can ask which one — do NOT fall back to listing tasks. `scheduled_at` is the new time as YYYY-MM-DDTHH:MM:SS in board-local time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting: { type: 'string' },
        scheduled_at: { type: 'string' },
        sender_name: { type: 'string' },
        sender_external_id: { type: 'string' },
        confirmed_task_id: { type: 'string' },
      },
      required: ['meeting', 'scheduled_at', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return validationError('board_id: required string');
    const meeting = requireString(args, 'meeting');
    if (meeting === null) return validationError('meeting: required string');
    const scheduledAt = requireString(args, 'scheduled_at');
    if (scheduledAt === null) return validationError('scheduled_at: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return validationError('sender_name: required string');

    let senderExternalId: string | undefined;
    if (args.sender_external_id !== undefined) {
      if (typeof args.sender_external_id !== 'string') return validationError('sender_external_id: expected string');
      senderExternalId = args.sender_external_id;
    }
    let confirmedTaskId: string | undefined;
    if (args.confirmed_task_id !== undefined) {
      if (typeof args.confirmed_task_id !== 'string') return validationError('confirmed_task_id: expected string');
      confirmedTaskId = args.confirmed_task_id;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const resolved = resolveMeetingTaskId(engine, meeting, boardId);
      if (!resolved.ok) return resolved.response;
      const taskId = resolved.taskId;

      const updateParams: UpdateParams = {
        board_id: boardId,
        task_id: taskId,
        sender_name: senderName,
        updates: { scheduled_at: scheduledAt } as UpdateParams['updates'],
        sender_external_id: senderExternalId,
        confirmed_task_id: confirmedTaskId,
      };
      const result = engine.update(updateParams);
      const timeZone = safeBoardTimeZone(getTaskflowDb(), boardId);
      return finalizeMutationResult(addUpdateFormattedResult(result, { scheduled_at: scheduledAt }, undefined, timeZone));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

export const apiNoteMeetingTool: McpToolDefinition = {
  tool: {
    name: 'api_note_meeting',
    description:
      'Add a note/decision to a MEETING the user referenced by NAME (not M-id). Use for "Reunião sobre X: ficou definido ...", "anota na reunião Y que ...". Resolves the name against THIS board\'s meetings (scoped to meetings, so a same-named PROJECT is NOT picked by mistake — a meeting "Projeto Novos Sites — Reunião Interna" wins over a project "Novos Sites") and adds the note to the unique match; 0/2+ → ask. Pass `meeting` (name or M-id) and `text` (the note). Do NOT attach a meeting decision to a project that merely shares the name. If the same message also contains a follow-up action item ("enviar ofício…"), create that as a separate task with api_create_task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting: { type: 'string' },
        text: { type: 'string' },
        sender_name: { type: 'string' },
        sender_external_id: { type: 'string' },
        confirmed_task_id: { type: 'string' },
      },
      required: ['meeting', 'text', 'sender_name'],
    },
  },
  async handler(args) {
    args = normalizeAgentIds(args);
    const boardId = requireString(args, 'board_id');
    if (boardId === null) return validationError('board_id: required string');
    const meeting = requireString(args, 'meeting');
    if (meeting === null) return validationError('meeting: required string');
    const text = requireString(args, 'text');
    if (text === null) return validationError('text: required string');
    const senderName = requireString(args, 'sender_name');
    if (senderName === null) return validationError('sender_name: required string');

    let senderExternalId: string | undefined;
    if (args.sender_external_id !== undefined) {
      if (typeof args.sender_external_id !== 'string') return validationError('sender_external_id: expected string');
      senderExternalId = args.sender_external_id;
    }
    let confirmedTaskId: string | undefined;
    if (args.confirmed_task_id !== undefined) {
      if (typeof args.confirmed_task_id !== 'string') return validationError('confirmed_task_id: expected string');
      confirmedTaskId = args.confirmed_task_id;
    }

    try {
      const engine = new TaskflowEngine(getTaskflowDb(), boardId);
      const resolved = resolveMeetingTaskId(engine, meeting, boardId);
      if (!resolved.ok) return resolved.response;
      const taskId = resolved.taskId;

      const updateParams: UpdateParams = {
        board_id: boardId,
        task_id: taskId,
        sender_name: senderName,
        updates: { add_note: text } as UpdateParams['updates'],
        sender_external_id: senderExternalId,
        confirmed_task_id: confirmedTaskId,
      };
      const result = engine.update(updateParams);
      return finalizeMutationResult(addUpdateFormattedResult(result, { add_note: text }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ success: false, error: msg });
    }
  },
};

registerTools([
  apiCreateSimpleTaskTool, apiCreateMeetingTaskTool, apiCreateTaskTool,
  apiMoveTool, apiMoveToColumnTool, apiAdminTool, apiReassignTool, apiUndoTool, apiReportTool,
  apiUpdateTaskTool, apiQueryTool, apiHierarchyTool, apiDependencyTool,
  apiDeleteSimpleTaskTool, apiRescheduleMeetingTool, apiNoteMeetingTool,
]);
