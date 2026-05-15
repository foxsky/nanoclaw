import fs from 'node:fs';
import path from 'node:path';

import { isWhatsAppJid } from '../src/phone.js';

export type Phase3ContextMode = 'fresh' | 'chain';
export type Phase3SemanticAction = 'ask' | 'read' | 'mutate' | 'forward' | 'no-op';
export type Phase3ClassificationKind =
  | 'match'
  | 'provider_error'
  | 'no_outbound_timeout'
  | 'missing_context'
  | 'state_snapshot_missing'
  | 'state_drift'
  | 'state_allocation_drift'
  | 'ask_context_hint_gap'
  | 'destination_registration_gap'
  | 'documented_tool_surface_change'
  | 'missing_api_capability'
  | 'v1_bug_flagged'
  | 'real_divergence'
  | 'read_only_extra';

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface OutboundRow {
  kind: string;
  content: string;
}

export interface Phase3ExpectedBehavior {
  action?: Phase3SemanticAction;
  task_ids?: string[];
  allow_extra_task_ids?: boolean;
  mutation_types?: string[];
  board_refs?: string[];
  recipient?: string;
  recipient_aliases?: string[];
  outbound_intent?: string;
}

// Annotation for corpus turns where v1's recorded behavior is itself a bug
// (e.g. weekday-resolution error, magnetism mis-target). The Phase 3 parity
// comparator treats v1 as ground truth, so without this flag a v2 that
// CORRECTS the bug would be marked `real_divergence` and a v2 that REPEATS
// the bug would be marked `match`. Surface these turns explicitly so they
// require manual verification before cutover.
export interface Phase3V1BugAnnotation {
  description: string;
  detected_by: 'auditor_self_correction' | 'manual_review';
  // Wall-clock timestamp of the user's correction message (the second half
  // of the same-task / same-user / <60min mutation pair). Used to cross-
  // reference task_history and the source JSONL.
  corrected_at?: string;
  // Best-effort description of what v2 *should* produce. The comparator
  // does not value-check task update payloads; this field is currently
  // documentation-only.
  expected_correction?: string;
}

export interface Phase3StateDriftAnnotation {
  description: string;
  evidence?: string;
  expected_with_historical_snapshot?: string;
}

export interface Phase3TurnMetadata {
  turn_index: number;
  context_mode: Phase3ContextMode;
  taskflow_board_id?: string;
  source_jsonl?: string;
  source_turn_index?: number;
  prior_turn_depth?: number;
  state_snapshot?: string;
  target_state_snapshot?: string;
  requires_state_snapshot?: boolean;
  expected_behavior?: Phase3ExpectedBehavior;
  v1_bug?: Phase3V1BugAnnotation;
  state_drift?: Phase3StateDriftAnnotation;
}

export interface Phase3CorpusTurn {
  jsonl?: string;
  turn_index?: number;
  taskflow_board_id?: string;
  context_mode?: Phase3ContextMode;
  source_jsonl?: string;
  source_turn_index?: number;
  prior_turn_depth?: number;
  state_snapshot?: string;
  db_snapshot?: string;
  target_state_snapshot?: string;
  requires_state_snapshot?: boolean;
  expected_behavior?: Phase3ExpectedBehavior;
  v1_bug?: Phase3V1BugAnnotation;
  state_drift?: Phase3StateDriftAnnotation;
}

export interface Phase3TurnResult {
  turn_index: number;
  text: string;
  v1: { tools: ToolCall[]; final_response?: string | null };
  v2: { tools: ToolCall[]; outbound: OutboundRow[]; settle_reason?: string };
  phase3?: {
    metadata?: Phase3TurnMetadata;
    db_snapshot_status?: 'restored' | 'missing' | 'not_requested';
  };
}

export interface SemanticSummary {
  action: Phase3SemanticAction;
  task_ids: string[];
  mutation_types: string[];
  board_refs: string[];
  recipient: string | null;
  outbound_intent: string;
}

export interface SemanticComparison {
  turn_index: number;
  expected: SemanticSummary;
  actual: SemanticSummary;
  matches: {
    action: boolean;
    task_ids: boolean;
    mutation_types: boolean;
    board_refs: boolean;
    recipient: boolean;
    // True when the outbound intent classes are equivalent. Distinguishes
    // "v2 grounded with a clarifying ask" from "v2 quietly failed to find
    // what v1 found": both produce action=read with the same task_ids,
    // but the intent class flips informational → asks_user / not_found,
    // which must not be excused as a match.
    outbound_intent: boolean;
  };
  classification: {
    kind: Phase3ClassificationKind;
    note: string;
  };
}

export interface RawSqliteDecision {
  turn_index: number;
  sqlite_tools: string[];
  classification: Exclude<
    Phase3ClassificationKind,
    'match' | 'read_only_extra' | 'real_divergence'
  >;
  recommendation: string;
}

const DEFAULT_CHAIN_DEPTHS: Record<number, number> = {
  16: 1,
  22: 1,
  23: 1,
  25: 1,
  27: 1,
};

const MUTATION_TOOL_PATTERNS = [
  /taskflow_(create|update|delete|move|admin|reassign|undo|hierarchy|dependency)/,
  /api_(create|update|delete|move|admin|reassign|undo|hierarchy|dependency)/,
  /api_task_(add_note|edit_note|remove_note)/,
  /mcp__sqlite__write_query/,
];

const READ_TOOL_PATTERNS = [
  /taskflow_(query|report)/,
  /api_(query|report|board_activity|filter_board_tasks|linked_tasks)/,
  /mcp__sqlite__read_query/,
  /^(Read|Grep|Glob|Bash|Agent|Monitor|TaskOutput)$/,
];

function normalizedToolName(name: string): string {
  return name.startsWith('mcp__nanoclaw__') ? name.slice('mcp__nanoclaw__'.length) : name;
}

function canonicalMutationType(name: string): string | null {
  const normalized = normalizedToolName(name);
  if (normalized === 'mcp__sqlite__write_query') return 'sqlite_write';
  if (/^api_task_(add_note|edit_note|remove_note)$/.test(normalized)) return 'update';
  const match = normalized.match(/^(?:taskflow|api)_(create|create_task|create_simple_task|update|update_task|update_simple_task|delete|delete_simple_task|move|admin|reassign|undo|hierarchy|dependency)/);
  if (!match) return null;
  const raw = match[1];
  if (raw === 'create_task' || raw === 'create_simple_task') return 'create';
  if (raw === 'update_task' || raw === 'update_simple_task') return 'update';
  if (raw === 'delete_simple_task') return 'delete';
  return raw;
}

export function loadPhase3Metadata(pathname: string | undefined): Map<number, Phase3TurnMetadata> {
  if (!pathname || !fs.existsSync(pathname)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8'));
  const rows: Phase3TurnMetadata[] = Array.isArray(parsed) ? parsed : parsed.turns;
  if (!Array.isArray(rows)) throw new Error(`Invalid Phase 3 metadata file: ${pathname}`);
  return new Map(rows.map((row) => [row.turn_index, row]));
}

export function inferPhase3Metadata(
  turn: Phase3CorpusTurn,
  corpusIndex: number,
  override?: Phase3TurnMetadata,
  options?: { useDefaultChainDepths?: boolean },
): Phase3TurnMetadata {
  if (override) {
    return {
      ...override,
      turn_index: override.turn_index ?? corpusIndex,
      context_mode: override.context_mode ?? 'fresh',
    };
  }

  const useDefaultChainDepths = options?.useDefaultChainDepths ?? true;
  const depth = turn.prior_turn_depth ?? (useDefaultChainDepths ? DEFAULT_CHAIN_DEPTHS[corpusIndex] : undefined);
  const contextMode = turn.context_mode ?? (depth ? 'chain' : 'fresh');
  return {
    turn_index: corpusIndex,
    context_mode: contextMode,
    taskflow_board_id: turn.taskflow_board_id,
    source_jsonl: turn.source_jsonl ?? turn.jsonl,
    source_turn_index: turn.source_turn_index ?? turn.turn_index,
    prior_turn_depth: contextMode === 'chain' ? depth ?? 1 : undefined,
    state_snapshot: turn.state_snapshot ?? turn.db_snapshot,
    target_state_snapshot: turn.target_state_snapshot,
    requires_state_snapshot: turn.requires_state_snapshot,
    expected_behavior: turn.expected_behavior,
    v1_bug: turn.v1_bug,
    state_drift: turn.state_drift,
  };
}

export function taskflowDbPath(dataDir: string): string {
  return path.join(dataDir, 'taskflow', 'taskflow.db');
}

function sqliteSidecarPaths(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

function copyIfExists(from: string, to: string): boolean {
  if (!fs.existsSync(from)) return false;
  fs.copyFileSync(from, to);
  return true;
}

function removeSQLiteSidecars(dbPath: string): void {
  for (const sidecar of sqliteSidecarPaths(dbPath)) {
    fs.rmSync(sidecar, { force: true });
  }
}

export function restoreDbSnapshot(
  snapshotPath: string | undefined,
  dataDir: string,
  required = false,
): 'restored' | 'missing' | 'not_requested' {
  if (!snapshotPath) return required ? 'missing' : 'not_requested';
  if (!fs.existsSync(snapshotPath)) return 'missing';
  const livePath = taskflowDbPath(dataDir);
  removeSQLiteSidecars(livePath);
  fs.copyFileSync(snapshotPath, livePath);
  removeSQLiteSidecars(livePath);
  return 'restored';
}

export function withTaskflowDbSnapshot<T>(dataDir: string, fn: () => T): T {
  const livePath = taskflowDbPath(dataDir);
  const snapshot = `${livePath}.phase3-${process.pid}-${Date.now()}`;
  const sidecarSnapshots = sqliteSidecarPaths(livePath).map((sidecar) => ({
    live: sidecar,
    snapshot: `${sidecar}.phase3-${process.pid}-${Date.now()}`,
    existed: false,
  }));
  fs.copyFileSync(livePath, snapshot);
  for (const sidecar of sidecarSnapshots) {
    sidecar.existed = copyIfExists(sidecar.live, sidecar.snapshot);
  }
  try {
    return fn();
  } finally {
    removeSQLiteSidecars(livePath);
    fs.copyFileSync(snapshot, livePath);
    for (const sidecar of sidecarSnapshots) {
      if (sidecar.existed) {
        fs.copyFileSync(sidecar.snapshot, sidecar.live);
      } else {
        fs.rmSync(sidecar.live, { force: true });
      }
      fs.rmSync(sidecar.snapshot, { force: true });
    }
    fs.rmSync(snapshot, { force: true });
  }
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
  return out;
}

export function extractTaskIdsFromTools(tools: ToolCall[]): string[] {
  const ids = new Set<string>();
  for (const tool of tools) {
    for (const s of collectStrings(tool.input)) {
      for (const match of s.toUpperCase().matchAll(/\b(?:P|T|M|R)\d+(?:\.\d+)?\b/g)) {
        ids.add(match[0]);
      }
    }
  }
  return [...ids].sort();
}

export function extractTaskIdsFromText(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.toUpperCase().matchAll(/\b(?:P|T|M|R)\d+(?:\.\d+)?\b/g)) {
    ids.add(match[0]);
  }
  return [...ids].sort();
}

function normalizeBoardRef(value: string): string | null {
  const normalized = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[*_`]/g, '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return normalized
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

export function extractBoardRefsFromText(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/\bboard[ \t]+(?:(?:do|da|de)[ \t]+)?([A-Z0-9][A-Za-z0-9_-]*)/g)) {
    const ref = normalizeBoardRef(match[1]);
    if (ref) refs.add(ref);
  }
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])quadro:\s*([^\n_*]+)/gim)) {
    for (const part of match[1].trim().split(/\s+-\s+|\s+—\s+/)) {
      const ref = normalizeBoardRef(part);
      if (ref) refs.add(ref);
    }
  }
  for (const match of text.matchAll(/\b([A-Z]{2,})-(?:T|P|M|R)\d+(?:\.\d+)?\b/g)) {
    const ref = normalizeBoardRef(match[1]);
    if (ref) refs.add(ref);
  }
  return [...refs].sort();
}

export function extractRecipient(tools: ToolCall[], outbound: OutboundRow[]): string | null {
  for (const tool of tools) {
    const input = tool.input && typeof tool.input === 'object'
      ? tool.input as Record<string, unknown>
      : {};
    for (const key of ['destination', 'target_chat_jid', 'destination_name', 'recipient', 'to']) {
      if (typeof input[key] === 'string' && input[key]) return input[key];
    }
  }
  for (const row of outbound) {
    try {
      const parsed = JSON.parse(row.content) as Record<string, unknown>;
      if (typeof parsed.destination === 'string') return parsed.destination;
      if (typeof parsed.to === 'string') return parsed.to;
    } catch {}
  }
  return null;
}

function toolInputRecord(tool: ToolCall): Record<string, unknown> {
  return tool.input && typeof tool.input === 'object'
    ? tool.input as Record<string, unknown>
    : {};
}

function sendMessageHasRecipient(tool: ToolCall): boolean {
  if (normalizedToolName(tool.name) !== 'send_message') return false;
  const input = toolInputRecord(tool);
  return ['destination', 'target_chat_jid', 'destination_name', 'recipient', 'to'].some((key) =>
    typeof input[key] === 'string' && input[key],
  );
}

function sendMessageTexts(tools: ToolCall[]): string[] {
  const texts: string[] = [];
  for (const tool of tools) {
    if (normalizedToolName(tool.name) !== 'send_message') continue;
    const input = toolInputRecord(tool);
    if (typeof input.text === 'string') texts.push(input.text);
  }
  return texts;
}

export function summarizeSemanticBehavior(
  tools: ToolCall[],
  outbound: OutboundRow[] = [],
  finalResponse?: string | null,
): SemanticSummary {
  const names = tools.map((tool) => normalizedToolName(tool.name));
  const hasForward = tools.some(sendMessageHasRecipient);
  const hasMutation = names.some((name) => MUTATION_TOOL_PATTERNS.some((pattern) => pattern.test(name)));
  const hasRead = names.some((name) => READ_TOOL_PATTERNS.some((pattern) => pattern.test(name)));
  const text = [
    finalResponse ?? '',
    ...sendMessageTexts(tools),
    ...outbound.map((row) => outboundContentText(row.content)),
  ].join('\n');
  const asks = /\?|\b(deseja|qual|confirma|confirme|confirmar|pode confirmar|como deseja|quer que|preciso que voc[eê] confirme)\b/i.test(text);
  const outboundIntent = classifyOutboundIntent(text);
  const failedMutationIntent = hasMutation &&
    (outboundIntent === 'asks_user' || outboundIntent === 'not_found_or_unclear') &&
    /\b(n[aã]o encontr|n[aã]o localizada|n[aã]o existe|confirma|confirmar)\b/i.test(text) &&
    !/\b(j[aá]|foi|foram)\b[\s\S]{0,80}\b(atualizad[ao]?|adicionad[ao]?|registrad[ao]?)\b/i.test(text);
  const blockedMutationIntent = hasMutation &&
    outboundIntent === 'informational' &&
    /\b(pertence ao quadro pai|apenas vinculad[ao]|precisa ser feita|faca a reatribuicao|faça a reatribuiç[aã]o|n[aã]o pode)\b/i.test(text) &&
    !/\b(j[aá]|foi|foram)\b[\s\S]{0,80}\b(atualizad[ao]?|adicionad[ao]?|registrad[ao]?|reatribu[ií]d[ao]?)\b/i.test(text);
  const effectiveHasMutation = hasMutation && !failedMutationIntent && !blockedMutationIntent;
  const textTaskIds = extractTaskIdsFromText(text);

  // Action priority: substantive tool work beats a trailing "Deseja...?" CTA.
  // Otherwise turns that read + suggest a follow-up (a common v1 pattern,
  // see seci turn 21) score as "ask" and look like a v2 divergence even
  // though the underlying work is identical to v2's read-only response.
  let action: Phase3SemanticAction;
  if (hasForward) action = 'forward';
  else if (effectiveHasMutation) action = 'mutate';
  else if (hasRead && asks && outboundIntent === 'asks_user' && /\b(voc[eê]\s+quis\s+dizer|preciso que voc[eê] confirme|confirme o ID|me confirma)\b/i.test(text)) action = 'ask';
  else if (hasRead) action = 'read';
  else if (textTaskIds.length > 0 && outboundIntent === 'informational') action = 'read';
  else if (asks && outboundIntent === 'asks_user') action = 'ask';
  else action = 'no-op';
  if (failedMutationIntent && outboundIntent === 'asks_user') action = 'ask';

  const toolTaskIds = extractTaskIdsFromTools(tools);
  const taskIds = outboundIntent === 'informational'
    ? [...new Set([...toolTaskIds, ...textTaskIds])].sort()
    : (toolTaskIds.length > 0 ? toolTaskIds : textTaskIds);
  return {
    action,
    task_ids: taskIds,
    mutation_types: effectiveHasMutation
      ? [...new Set(names.map(canonicalMutationType).filter((value): value is string => value !== null))].sort()
      : [],
    board_refs: extractBoardRefsFromText(text),
    recipient: extractRecipient(tools, outbound),
    outbound_intent: outboundIntent,
  };
}

function outboundContentText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;
  } catch {
    // Fall through: some tests and older artifacts pass plain text here.
  }
  return content;
}

export function classifyOutboundIntent(text: string): string {
  if (!text.trim()) return 'none';
  if (/\bAPI Error:\s*\d{3}\b/i.test(text)) return 'provider_error';
  if (
    /\b(n[aã]o encontr\w*|n[aã]o localizada|n[aã]o existe)\b/i.test(text) &&
    /\b(?:encontrei\s+[\s\S]{0,80})?(relacionad[ao]s?|candidat[ao]s?|op[cç][oõ]es)\b/i.test(text) &&
    extractTaskIdsFromText(text).length > 0
  ) {
    return 'informational';
  }
  if (
    /\b(n[aã]o encontr\w*|n[aã]o localizada|n[aã]o existe)\b/i.test(text) &&
    /\b(voc[eê]\s+quis\s+dizer|preciso que voc[eê] confirme|confirme o ID|me confirma)\b/i.test(text)
  ) {
    return 'asks_user';
  }
  if (/\b(n[aã]o encontr\w*|n[aã]o localizada|n[aã]o existe)\b/i.test(text)) return 'not_found_or_unclear';
  if (/\b(encaminh|enviei|detalhes.*encaminhados)\b/i.test(text)) return 'forward_confirmation';
  if (
    /\b(?:Em atraso|Vence hoje|Pr[oó]ximas A[cç][oõ]es|Inbox|Aguardando|Conclu[ií]das)\s*:/i.test(text) &&
    extractTaskIdsFromText(text).length >= 2
  ) {
    return 'informational';
  }
  if (/\b(j[aá]|foi|foram)\b[\s\S]{0,80}\b(atualizad[ao]?|adicionad[ao]?|registrad[ao]?)\b/i.test(text)) return 'mutation_confirmation';
  if (
    /\b(TASKFLOW BOARD|Board|QUADRO TASKFLOW|Vinculada conclu[ií]da|TAREFAS VINCULADAS|Respons[aá]vel|Coluna)\b/i.test(text) &&
    extractTaskIdsFromText(text).length > 0
  ) {
    return 'informational';
  }
  if (/\?|\b(deseja|qual|confirma|confirme|confirmar|como deseja|quer que)\b/i.test(text)) return 'asks_user';
  if (/\b(conclu[ií]d|movid[ao]?|atualizad[ao]?|adicionad[ao]?|criad[ao]?|registrad[ao]?)\b/i.test(text)) return 'mutation_confirmation';
  return 'informational';
}

function sameStringSet(a: string[], b: string[]): boolean {
  const aa = [...new Set(a)].sort();
  const bb = [...new Set(b)].sort();
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

function stringSetContains(container: string[], expectedSubset: string[]): boolean {
  const values = new Set(container);
  return expectedSubset.every((value) => values.has(value));
}

function boardRefsMatch(expected: string[], actual: string[]): boolean {
  if (expected.length === 0) return true;
  if (actual.length === 0) return false;
  return expected.every((expectedRef) =>
    actual.some((actualRef) => {
      if (expectedRef === actualRef) return true;
      if (expectedRef.length <= 3) return actualRef.startsWith(`${expectedRef}-`);
      return actualRef.includes(expectedRef) || expectedRef.includes(actualRef);
    }),
  );
}

// Outbound intent classes that flag "v2 produced the same shape but failed
// the underlying request" — these must not be silently collapsed with v1's
// informational reply (the canonical case: v1 read a sibling-board task
// and showed details; v2 returned "Task not found" and asked the user to
// clarify, so action=read and task_ids both look identical, but the
// substance diverges). Other intent transitions remain match-eligible.
const INTENT_SUBSTANTIVE_FAILURE = new Set(['asks_user', 'not_found_or_unclear']);

function outboundIntentMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === 'unspecified' || actual === 'unspecified') return true;
  // v1 produced a visible reply but v2 produced nothing. This is never
  // compliance-equivalent: even when the tool/action shape is correct, the
  // observable user behavior is a silent turn.
  if (actual === 'none' && expected !== 'none') return false;
  // v1 found and reported a task; v2 had to ask or returned not-found.
  // This is the divergence we cannot let slip through as match.
  if (expected === 'informational' && INTENT_SUBSTANTIVE_FAILURE.has(actual)) return false;
  // The mirror direction (v1 asks_user, v2 informational) usually means
  // v2 grounded with a read before answering — that's read_only_extra, not
  // a regression. Leave it to the downstream classifier.
  return true;
}

export function compareSemanticTurn(turn: Phase3TurnResult): SemanticComparison {
  const expected = turn.phase3?.metadata?.expected_behavior
    ? expectedToSummary(turn.phase3.metadata.expected_behavior)
    : summarizeSemanticBehavior(turn.v1.tools, [], turn.v1.final_response);
  const actual = summarizeSemanticBehavior(turn.v2.tools, turn.v2.outbound);
  const recipientAliases = turn.phase3?.metadata?.expected_behavior?.recipient_aliases ?? [];
  const allowExtraTaskIds = turn.phase3?.metadata?.expected_behavior?.allow_extra_task_ids === true;
  const matches = {
    action: expected.action === actual.action,
    task_ids: expected.task_ids.length === 0 || sameStringSet(expected.task_ids, actual.task_ids) || (allowExtraTaskIds && stringSetContains(actual.task_ids, expected.task_ids)),
    mutation_types: expected.mutation_types.length === 0 || sameStringSet(expected.mutation_types, actual.mutation_types),
    board_refs: boardRefsMatch(expected.board_refs, actual.board_refs),
    recipient: expected.recipient === null || recipientMatches(expected.recipient, recipientAliases, actual.recipient),
    outbound_intent: outboundIntentMatches(expected.outbound_intent, actual.outbound_intent),
  };
  return {
    turn_index: turn.turn_index,
    expected,
    actual,
    matches,
    classification: classifySemanticComparison(turn, matches, expected, actual),
  };
}

function expectedToSummary(expected: Phase3ExpectedBehavior): SemanticSummary {
  return {
    action: expected.action ?? 'no-op',
    task_ids: [...new Set(expected.task_ids ?? [])].map((id) => id.toUpperCase()).sort(),
    mutation_types: [...new Set(expected.mutation_types ?? [])].sort(),
    board_refs: [...new Set(expected.board_refs ?? [])]
      .map((ref) => normalizeBoardRef(ref))
      .filter((ref): ref is string => ref !== null)
      .sort(),
    recipient: expected.recipient ?? null,
    outbound_intent: expected.outbound_intent ?? 'unspecified',
  };
}

function recipientMatches(expected: string, aliases: string[], actual: string | null): boolean {
  if (expected === actual) return true;
  if (actual === null) return false;
  return aliases.includes(actual);
}

// Heuristic: detect freshly-allocated sequence IDs that v2 hands out when no
// historical snapshot pins the next-id counter. Used to separate "v2 created
// a fresh task with the next free ID" (state allocation drift) from "v2 wrote
// to the wrong existing task" (real bug).
const FRESH_ALLOCATION_PATTERN = /^[TM]\d+$/;

function looksLikeFreshAllocation(
  expected: string[],
  actual: string[],
): boolean {
  if (expected.length === 0 || actual.length === 0) return false;
  if (expected.length !== actual.length) return false;
  return expected.every((value, index) => {
    const actualValue = actual[index];
    if (value === actualValue) return true;
    if (!FRESH_ALLOCATION_PATTERN.test(value) || !FRESH_ALLOCATION_PATTERN.test(actualValue)) return false;
    const expectedNum = Number.parseInt(value.slice(1), 10);
    const actualNum = Number.parseInt(actualValue.slice(1), 10);
    // v2's allocator hands out a numerically larger free ID than the v1
    // historical one, because earlier corpus turns already advanced the
    // counter in the cumulative DB. Same prefix, larger v2 number.
    return value[0] === actualValue[0] && Number.isFinite(expectedNum) && Number.isFinite(actualNum) && actualNum > expectedNum;
  });
}

// `isWhatsAppJid` lives in src/phone.ts. Used here to detect v1 raw-JID
// forwards where v2 either (a) didn't forward at all, or (b) forwarded to
// a local destination name because no agent_destinations row matches the
// JID. Prod has these pre-wired; the Phase 3 test seed does not.

// Named predicates for the classification rules below. Each captures one
// load-bearing condition; the rules table renders the priority order.

// Match gate is an explicit conjunction (not Object.values(...).every) so
// adding a future `matches.foo` field forces a compile-time decision about
// whether it participates instead of silently widening it.
function allDimensionsMatch(m: SemanticComparison['matches']): boolean {
  return (
    m.action && m.task_ids && m.mutation_types && m.board_refs && m.recipient && m.outbound_intent
  );
}

function hasProviderError(actual: SemanticSummary): boolean {
  return actual.outbound_intent === 'provider_error';
}

function snapshotMissing(turn: Phase3TurnResult): boolean {
  return turn.phase3?.db_snapshot_status === 'missing';
}

// Corpus turn is explicitly annotated as a v1 bug (auditor self-correction
// detector flagged this user/task within 60 min as bot-error+correction, or
// a human review marked it). Surfaces above `match` so a v2 that reproduces
// the v1 mistake doesn't silently pass and a v2 that corrects the mistake
// doesn't get flagged as a regression.
function isV1BugFlagged(turn: Phase3TurnResult): boolean {
  return !!turn.phase3?.metadata?.v1_bug;
}

function stateDriftAnnotation(turn: Phase3TurnResult): Phase3StateDriftAnnotation | undefined {
  return turn.phase3?.metadata?.state_drift;
}

function isNoOutboundTimeout(
  turn: Phase3TurnResult,
  expected: SemanticSummary,
  actual: SemanticSummary,
): boolean {
  if (expected.outbound_intent === 'none' || expected.outbound_intent === 'unspecified') return false;
  if (actual.outbound_intent !== 'none') return false;
  return turn.v2.settle_reason === 'timeout' || turn.v2.outbound.length === 0;
}

// Forward intent expected but v2 either didn't deliver or delivered to a
// local destination — no agent_destinations row matches the v1 recipient
// JID. Checked before the chain/source gate because a missing destination
// is the same gap whether chain context is set up or not. Restricted to
// no-mutation forward/no-op shapes so a v2 run that also mutated state
// cannot hide behind this class.
function isUnregisteredJidForward(
  matches: SemanticComparison['matches'],
  expected: SemanticSummary,
  actual: SemanticSummary,
): boolean {
  return (
    expected.action === 'forward' &&
    isWhatsAppJid(expected.recipient) &&
    !matches.recipient &&
    actual.mutation_types.length === 0 &&
    (actual.action === 'forward' || actual.action === 'no-op')
  );
}

function isChainTurnWithoutSource(turn: Phase3TurnResult): boolean {
  const md = turn.phase3?.metadata;
  return md?.context_mode === 'chain' && !md.source_jsonl;
}

function usedRawSqlite(turn: Phase3TurnResult): boolean {
  return turn.v1.tools.some((tool) => tool.name.startsWith('mcp__sqlite__'));
}

// Task-IDs are the only mismatch and they look like fresh allocator output
// (T### / M### with larger v2 numbers) on an otherwise identical create/
// admin flow. v1's historical IDs (T84/T85) drift to v2's next free ID
// (T96) when cumulative state advances the counter. Requires the turn to
// have actually allocated something (`create` in mutation_types) so a
// reassign/update mismatch can't be papered over as "drift".
function isFreshAllocationDrift(
  matches: SemanticComparison['matches'],
  expected: SemanticSummary,
  actual: SemanticSummary,
): boolean {
  return (
    matches.action && matches.mutation_types && matches.board_refs && matches.recipient && !matches.task_ids &&
    actual.mutation_types.includes('create') &&
    looksLikeFreshAllocation(expected.task_ids, actual.task_ids)
  );
}

function isAskContextHintGap(
  matches: SemanticComparison['matches'],
  expected: SemanticSummary,
  actual: SemanticSummary,
): boolean {
  return (
    matches.action &&
    matches.mutation_types &&
    matches.board_refs &&
    matches.recipient &&
    matches.outbound_intent &&
    !matches.task_ids &&
    expected.action === 'ask' &&
    actual.action === 'ask' &&
    expected.mutation_types.length === 0 &&
    actual.mutation_types.length === 0
  );
}

function isReadStateDrift(
  turn: Phase3TurnResult,
  matches: SemanticComparison['matches'],
  expected: SemanticSummary,
  actual: SemanticSummary,
): boolean {
  return (
    turn.phase3?.db_snapshot_status !== 'restored' &&
    matches.action &&
    matches.mutation_types &&
    matches.board_refs &&
    matches.recipient &&
    !matches.task_ids &&
    expected.action === 'read' &&
    actual.action === 'read' &&
    actual.outbound_intent === 'informational' &&
    expected.outbound_intent !== 'none'
  );
}

// v2 grounded with extra reads before answering. Suppressed when explicit
// metadata says the expected action is something else (the metadata wins).
function isReadOnlyExtra(turn: Phase3TurnResult, matches: SemanticComparison['matches']): boolean {
  const expectedAction = turn.phase3?.metadata?.expected_behavior?.action;
  if (expectedAction !== undefined) return false;
  if (!matches.task_ids || !matches.board_refs || !matches.recipient || !matches.outbound_intent) return false;
  if (turn.v2.tools.length <= turn.v1.tools.length) return false;
  return !turn.v2.tools.some((tool) =>
    MUTATION_TOOL_PATTERNS.some((pattern) => pattern.test(normalizedToolName(tool.name))),
  );
}

// Each rule's predicate is checked in priority order; the first hit wins.
// Ordering is load-bearing: snapshot_missing precedes everything else so
// state-sensitive turns don't get classified as bugs; destination wiring
// precedes missing_context so the same gap doesn't change class depending
// on whether chain metadata happens to be set.
type ClassificationRule = {
  test: (
    turn: Phase3TurnResult,
    matches: SemanticComparison['matches'],
    expected: SemanticSummary,
    actual: SemanticSummary,
  ) => boolean;
  result: SemanticComparison['classification'];
};

const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    test: (_t, _m, _e, a) => hasProviderError(a),
    result: {
      kind: 'provider_error',
      note: 'Replay hit a provider/API error, so this turn must be re-run before behavior can be judged.',
    },
  },
  {
    test: (t, _m, e, a) => isNoOutboundTimeout(t, e, a),
    result: {
      kind: 'no_outbound_timeout',
      note: 'v1 produced a user-visible reply, but v2 produced no outbound message before the replay timeout. Tool/action parity is not enough for compliance.',
    },
  },
  {
    test: (t) => isV1BugFlagged(t),
    result: {
      kind: 'v1_bug_flagged',
      note: 'Corpus turn annotated as a v1 bug (auditor self-correction or manual review). Manual verification required — v2 may correctly diverge from v1 here, or may reproduce the same mistake.',
    },
  },
  {
    test: (_t, m) => allDimensionsMatch(m),
    result: {
      kind: 'match',
      note: 'Semantic action, task IDs, mutation type, recipient, and outbound intent match the expected behavior.',
    },
  },
  {
    test: (t) => snapshotMissing(t),
    result: {
      kind: 'state_snapshot_missing',
      note: 'Per-turn DB snapshot is unavailable; state-sensitive parity cannot be concluded.',
    },
  },
  {
    test: (_t, m, e, a) => isUnregisteredJidForward(m, e, a),
    result: {
      kind: 'destination_registration_gap',
      note: 'v1 forwarded to a raw JID; v2 has no agent_destinations entry for it. Register the destination (or rely on prod wiring) — not a v2 product bug.',
    },
  },
  {
    test: (t) => isChainTurnWithoutSource(t),
    result: {
      kind: 'missing_context',
      note: 'Turn requires context-chain replay but no source JSONL is available.',
    },
  },
  {
    test: (t) => usedRawSqlite(t),
    result: {
      kind: 'documented_tool_surface_change',
      note: 'v1 used raw sqlite; v2 sqlite remains blocked and must use first-class api_* equivalents.',
    },
  },
  {
    test: (_t, m, e, a) => isFreshAllocationDrift(m, e, a),
    result: {
      kind: 'state_allocation_drift',
      note: 'Create+admin tool sequence matches; task IDs differ only because v2 allocated the next free sequence number. Provide a per-turn DB snapshot to compare exact IDs.',
    },
  },
  {
    test: (_t, m, e, a) => isAskContextHintGap(m, e, a),
    result: {
      kind: 'ask_context_hint_gap',
      note: 'Both versions asked instead of mutating, but v2 omitted or changed the contextual task/project hints that v1 mentioned. This is observable prose drift, not an engine mutation bug.',
    },
  },
  {
    test: (t, m, e, a) => isReadStateDrift(t, m, e, a),
    result: {
      kind: 'state_drift',
      note: 'Both versions performed a read and answered informationally, but the task set differs without a restored per-turn DB snapshot. Treat as state drift unless a matching historical snapshot proves otherwise.',
    },
  },
  {
    test: (t, m) => isReadOnlyExtra(t, m),
    result: {
      kind: 'read_only_extra',
      note: 'v2 performed additional read-side grounding without mutation.',
    },
  },
];

const REAL_DIVERGENCE: SemanticComparison['classification'] = {
  kind: 'real_divergence',
  note: 'Observed semantic behavior differs from expected behavior under available context/state.',
};

function classifySemanticComparison(
  turn: Phase3TurnResult,
  matches: SemanticComparison['matches'],
  expected: SemanticSummary,
  actual: SemanticSummary,
): SemanticComparison['classification'] {
  if (hasProviderError(actual)) {
    return {
      kind: 'provider_error',
      note: 'Replay hit a provider/API error, so this turn must be re-run before behavior can be judged.',
    };
  }
  if (isNoOutboundTimeout(turn, expected, actual)) {
    return {
      kind: 'no_outbound_timeout',
      note: 'v1 produced a user-visible reply, but v2 produced no outbound message before the replay timeout. Tool/action parity is not enough for compliance.',
    };
  }
  if (isV1BugFlagged(turn)) {
    return {
      kind: 'v1_bug_flagged',
      note: 'Corpus turn annotated as a v1 bug (auditor self-correction or manual review). Manual verification required — v2 may correctly diverge from v1 here, or may reproduce the same mistake.',
    };
  }
  const drift = stateDriftAnnotation(turn);
  if (drift && !allDimensionsMatch(matches)) {
    const suffix = drift.evidence ? ` Evidence: ${drift.evidence}` : '';
    return {
      kind: 'state_drift',
      note: `Annotated DB state drift: ${drift.description}${suffix}`,
    };
  }
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test(turn, matches, expected, actual)) return rule.result;
  }
  return REAL_DIVERGENCE;
}

export function classifyRawSqliteTurn(turn: Phase3TurnResult): RawSqliteDecision | null {
  const sqliteTools = turn.v1.tools.map((tool) => tool.name).filter((name) => name.startsWith('mcp__sqlite__'));
  if (sqliteTools.length === 0) return null;
  const semantic = compareSemanticTurn(turn);
  if (semantic.classification.kind === 'match') {
    return {
      turn_index: turn.turn_index,
      sqlite_tools: sqliteTools,
      classification: 'documented_tool_surface_change',
      recommendation: 'Covered by first-class api_* / MCP equivalent; keep raw sqlite blocked.',
    };
  }
  const text = turn.text.toLowerCase();
  if (text.includes('t43')) {
    return {
      turn_index: turn.turn_index,
      sqlite_tools: sqliteTools,
      classification: 'missing_api_capability',
      recommendation: 'Consider a first-class api_* cross-board task lookup if T43-style sibling-board reads must remain parity behavior without raw sqlite.',
    };
  }
  if (text.includes('esta tarefa') || text.includes('sim')) {
    return {
      turn_index: turn.turn_index,
      sqlite_tools: sqliteTools,
      classification: 'missing_context',
      recommendation: 'Validate with context-chain replay before treating the raw sqlite call as a v2 capability gap.',
    };
  }
  return {
    turn_index: turn.turn_index,
    sqlite_tools: sqliteTools,
    classification: 'documented_tool_surface_change',
    recommendation: 'Keep sqlite blocked; document the v1→v2 tool-surface change or add a narrower api_* equivalent.',
  };
}
