import fs from 'node:fs';
import path from 'node:path';

export type Phase3ContextMode = 'fresh' | 'chain';
export type Phase3SemanticAction = 'ask' | 'read' | 'mutate' | 'forward' | 'no-op';
export type Phase3ClassificationKind =
  | 'match'
  | 'missing_context'
  | 'state_snapshot_missing'
  | 'state_drift'
  | 'documented_tool_surface_change'
  | 'missing_api_capability'
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
  mutation_types?: string[];
  recipient?: string;
  outbound_intent?: string;
}

export interface Phase3TurnMetadata {
  turn_index: number;
  context_mode: Phase3ContextMode;
  source_jsonl?: string;
  source_turn_index?: number;
  prior_turn_depth?: number;
  state_snapshot?: string;
  requires_state_snapshot?: boolean;
  expected_behavior?: Phase3ExpectedBehavior;
}

export interface Phase3CorpusTurn {
  jsonl?: string;
  turn_index?: number;
  context_mode?: Phase3ContextMode;
  source_jsonl?: string;
  source_turn_index?: number;
  prior_turn_depth?: number;
  state_snapshot?: string;
  db_snapshot?: string;
  requires_state_snapshot?: boolean;
  expected_behavior?: Phase3ExpectedBehavior;
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
    recipient: boolean;
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
): Phase3TurnMetadata {
  if (override) {
    return {
      ...override,
      turn_index: override.turn_index ?? corpusIndex,
      context_mode: override.context_mode ?? 'fresh',
    };
  }

  const depth = turn.prior_turn_depth ?? DEFAULT_CHAIN_DEPTHS[corpusIndex];
  const contextMode = turn.context_mode ?? (depth ? 'chain' : 'fresh');
  return {
    turn_index: corpusIndex,
    context_mode: contextMode,
    source_jsonl: turn.source_jsonl ?? turn.jsonl,
    source_turn_index: turn.source_turn_index ?? turn.turn_index,
    prior_turn_depth: contextMode === 'chain' ? depth ?? 1 : undefined,
    state_snapshot: turn.state_snapshot ?? turn.db_snapshot,
    requires_state_snapshot: turn.requires_state_snapshot,
    expected_behavior: turn.expected_behavior,
  };
}

export function taskflowDbPath(dataDir: string): string {
  return path.join(dataDir, 'taskflow', 'taskflow.db');
}

export function restoreDbSnapshot(
  snapshotPath: string | undefined,
  dataDir: string,
  required = false,
): 'restored' | 'missing' | 'not_requested' {
  if (!snapshotPath) return required ? 'missing' : 'not_requested';
  if (!fs.existsSync(snapshotPath)) return 'missing';
  fs.copyFileSync(snapshotPath, taskflowDbPath(dataDir));
  return 'restored';
}

export function withTaskflowDbSnapshot<T>(dataDir: string, fn: () => T): T {
  const livePath = taskflowDbPath(dataDir);
  const snapshot = `${livePath}.phase3-${process.pid}-${Date.now()}`;
  fs.copyFileSync(livePath, snapshot);
  try {
    return fn();
  } finally {
    fs.copyFileSync(snapshot, livePath);
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

export function extractRecipient(tools: ToolCall[], outbound: OutboundRow[]): string | null {
  for (const tool of tools) {
    const input = tool.input && typeof tool.input === 'object'
      ? tool.input as Record<string, unknown>
      : {};
    for (const key of ['destination', 'target_chat_jid', 'destination_name', 'recipient']) {
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

export function summarizeSemanticBehavior(
  tools: ToolCall[],
  outbound: OutboundRow[] = [],
  finalResponse?: string | null,
): SemanticSummary {
  const names = tools.map((tool) => normalizedToolName(tool.name));
  const hasForward = names.includes('send_message');
  const hasMutation = names.some((name) => MUTATION_TOOL_PATTERNS.some((pattern) => pattern.test(name)));
  const hasRead = names.some((name) => READ_TOOL_PATTERNS.some((pattern) => pattern.test(name)));
  const text = [
    finalResponse ?? '',
    ...outbound.map((row) => row.content),
  ].join('\n');
  const asks = /\?|\b(deseja|qual|confirma|pode confirmar|como deseja|quer que)\b/i.test(text);

  let action: Phase3SemanticAction;
  if (hasForward) action = 'forward';
  else if (hasMutation) action = 'mutate';
  else if (asks) action = 'ask';
  else if (hasRead) action = 'read';
  else action = 'no-op';

  return {
    action,
    task_ids: extractTaskIdsFromTools(tools),
    mutation_types: [...new Set(names.map(canonicalMutationType).filter((value): value is string => value !== null))].sort(),
    recipient: extractRecipient(tools, outbound),
    outbound_intent: classifyOutboundIntent(text),
  };
}

export function classifyOutboundIntent(text: string): string {
  if (!text.trim()) return 'none';
  if (/\?|\b(deseja|qual|confirma|como deseja|quer que)\b/i.test(text)) return 'asks_user';
  if (/\b(encaminh|enviei|detalhes.*encaminhados)\b/i.test(text)) return 'forward_confirmation';
  if (/\b(conclu[ií]d|movid|atualizad|adicionad|criad|registrad)\b/i.test(text)) return 'mutation_confirmation';
  if (/\b(n[aã]o encontr|não está cadastrada|n[aã]o localizada)\b/i.test(text)) return 'not_found_or_unclear';
  return 'informational';
}

function sameStringSet(a: string[], b: string[]): boolean {
  const aa = [...new Set(a)].sort();
  const bb = [...new Set(b)].sort();
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

export function compareSemanticTurn(turn: Phase3TurnResult): SemanticComparison {
  const expected = turn.phase3?.metadata?.expected_behavior
    ? expectedToSummary(turn.phase3.metadata.expected_behavior)
    : summarizeSemanticBehavior(turn.v1.tools, [], turn.v1.final_response);
  const actual = summarizeSemanticBehavior(turn.v2.tools, turn.v2.outbound);
  const matches = {
    action: expected.action === actual.action,
    task_ids: expected.task_ids.length === 0 || sameStringSet(expected.task_ids, actual.task_ids),
    mutation_types: expected.mutation_types.length === 0 || sameStringSet(expected.mutation_types, actual.mutation_types),
    recipient: expected.recipient === null || expected.recipient === actual.recipient,
  };
  return {
    turn_index: turn.turn_index,
    expected,
    actual,
    matches,
    classification: classifySemanticComparison(turn, matches),
  };
}

function expectedToSummary(expected: Phase3ExpectedBehavior): SemanticSummary {
  return {
    action: expected.action ?? 'no-op',
    task_ids: [...new Set(expected.task_ids ?? [])].map((id) => id.toUpperCase()).sort(),
    mutation_types: [...new Set(expected.mutation_types ?? [])].sort(),
    recipient: expected.recipient ?? null,
    outbound_intent: expected.outbound_intent ?? 'unspecified',
  };
}

function classifySemanticComparison(
  turn: Phase3TurnResult,
  matches: SemanticComparison['matches'],
): SemanticComparison['classification'] {
  if (Object.values(matches).every(Boolean)) {
    return { kind: 'match', note: 'Semantic action, task IDs, mutation type, and recipient match the expected behavior.' };
  }
  const status = turn.phase3?.db_snapshot_status;
  if (status === 'missing') {
    return { kind: 'state_snapshot_missing', note: 'Per-turn DB snapshot is unavailable; state-sensitive parity cannot be concluded.' };
  }
  const metadata = turn.phase3?.metadata;
  if (metadata?.context_mode === 'chain' && !metadata.source_jsonl) {
    return { kind: 'missing_context', note: 'Turn requires context-chain replay but no source JSONL is available.' };
  }
  if (turn.v1.tools.some((tool) => tool.name.startsWith('mcp__sqlite__'))) {
    return { kind: 'documented_tool_surface_change', note: 'v1 used raw sqlite; v2 sqlite remains blocked and must use first-class api_* equivalents.' };
  }
  const expectedAction = turn.phase3?.metadata?.expected_behavior?.action;
  if (expectedAction === undefined && turn.v2.tools.length > turn.v1.tools.length && !turn.v2.tools.some((tool) => MUTATION_TOOL_PATTERNS.some((pattern) => pattern.test(normalizedToolName(tool.name))))) {
    return { kind: 'read_only_extra', note: 'v2 performed additional read-side grounding without mutation.' };
  }
  return { kind: 'real_divergence', note: 'Observed semantic behavior differs from expected behavior under available context/state.' };
}

export function classifyRawSqliteTurn(turn: Phase3TurnResult): RawSqliteDecision | null {
  const sqliteTools = turn.v1.tools.map((tool) => tool.name).filter((name) => name.startsWith('mcp__sqlite__'));
  if (sqliteTools.length === 0) return null;
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
