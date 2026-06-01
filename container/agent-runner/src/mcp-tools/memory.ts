/**
 * memory_note / memory_search MCP tools — the agent-facing surface over the native
 * local memory store (memory-store.ts). Per-board, FTS5.
 *
 * Board scoping: the board id comes from NANOCLAW_TASKFLOW_BOARD_ID, host-injected at
 * spawn (container-runner.ts), NEVER from the model. The env's presence is also the
 * opt-in gate (same signal poll-loop uses for `taskflowEnabled`): absent → not a TaskFlow
 * board → the tools refuse without opening any DB. Isolation is the agent-group mount
 * boundary (the DB lives at /workspace/agent/memory/, beside CLAUDE.local.md), not a
 * per-board tier — a separate-agent board has its own group/file; an agent-shared group
 * shares its memory like the rest of its workspace.
 *
 * P1 stores only what memory_note is given; source_session/source_ts provenance is
 * populated later by P2 auto-capture (which has the session transcript).
 */
import type { Database } from 'bun:sqlite';

import { embedAndInsert, embedText } from '../memory-embed.js';
import {
  hybridSearchMemory,
  type MemoryRow,
  openMemoryDbEnsuringDir,
  pruneMemories,
  recentMemories,
} from '../memory-store.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err, log, nonEmptyString, ok, requireString } from './util.js';

const NOT_A_BOARD = 'Memory is only available on TaskFlow boards (no board is bound to this group).';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
// How many recent memories to prime the session system prompt with (once-per-session auto-recall).
const RECALL_ADDENDUM_LIMIT = 10;
// Per-memory preview cap in the addendum so one large memory can't bloat every session prompt;
// the full text is always available via memory_search. Bounds the section to ~10×this.
const RECALL_ADDENDUM_CHARS = 300;

/** The host-injected board id, or null when this group is not a TaskFlow board. */
function memoryBoardId(): string | null {
  return nonEmptyString(process.env.NANOCLAW_TASKFLOW_BOARD_ID);
}

function openBoardMemoryDb(): Database {
  return openMemoryDbEnsuringDir();
}

export function formatMemories(rows: MemoryRow[]): string {
  const head = rows.length === 1 ? '1 relevant memory' : `${rows.length} relevant memories`;
  const lines = rows.map((m, i) => {
    const date = m.created_at.slice(0, 10);
    const from = m.source_session ? `, from session ${m.source_session}` : '';
    return `${i + 1}. [${m.kind}] ${m.text}  (saved ${date}${from})`;
  });
  return `Found ${head}:\n${lines.join('\n')}`;
}

/**
 * The recent-memory section appended to the session system prompt (once-per-session auto-recall).
 * Returns '' when the board has no memories yet, so the prompt is untouched on a fresh board.
 */
export function recallAddendumText(db: Database, boardId: string, limit = RECALL_ADDENDUM_LIMIT): string {
  const recent = recentMemories(db, boardId, limit).map((m) =>
    m.text.length > RECALL_ADDENDUM_CHARS ? { ...m, text: `${m.text.slice(0, RECALL_ADDENDUM_CHARS)}…` } : m,
  );
  if (recent.length === 0) return '';
  return (
    `\n\n## Remembered for this board\n` +
    `Durable facts saved in past sessions (most recent first) — treat as established context. ` +
    `Use the memory_search tool to look up anything else.\n${formatMemories(recent)}`
  );
}

/**
 * Forgetting policy from env (opt-in; both unset = forgetting OFF, current behavior). Positive
 * values only — a non-positive/garbage value disables that cap rather than wiping the board.
 */
export function memoryPruneOptions(): { maxAgeDays?: number; keepTopN?: number } {
  const out: { maxAgeDays?: number; keepTopN?: number } = {};
  // Floor to integers so a float config (e.g. "500.9") works rather than silently disabling
  // forgetting at the SQL layer (LIMIT rejects a float → caught fail-soft → no prune).
  const age = Number(process.env.NANOCLAW_MEMORY_MAX_AGE_DAYS);
  if (Number.isFinite(age) && age > 0) out.maxAgeDays = Math.floor(age);
  const keep = Number(process.env.NANOCLAW_MEMORY_KEEP_TOP_N);
  if (Number.isFinite(keep) && keep > 0) out.keepTopN = Math.floor(keep);
  return out;
}

/**
 * Apply the board's forgetting policy at container start. No-op when this group is not a board,
 * or when no policy is configured. Best-effort + fail-soft (a DB error degrades to 0, never
 * aborts boot). Returns the count pruned.
 */
export function pruneBoardMemory(): number {
  const boardId = memoryBoardId();
  if (!boardId) return 0;
  const opts = memoryPruneOptions();
  if (opts.maxAgeDays === undefined && opts.keepTopN === undefined) return 0;
  let db: Database | null = null;
  try {
    db = openBoardMemoryDb();
    const n = pruneMemories(db, boardId, opts);
    if (n)
      log(
        `pruned ${n} memories for ${boardId} (maxAgeDays=${opts.maxAgeDays ?? '-'}, keepTopN=${opts.keepTopN ?? '-'})`,
      );
    return n;
  } catch (e) {
    log(`prune skipped: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      /* already failing — nothing useful to do */
    }
  }
}

export function buildMemoryRecallAddendum(): string {
  const boardId = memoryBoardId();
  if (!boardId) return '';
  // Best-effort: this runs at container startup, so a DB open/query failure must degrade to an
  // empty addendum, never throw and abort the agent's boot.
  let db: Database | null = null;
  try {
    db = openBoardMemoryDb();
    return recallAddendumText(db, boardId);
  } catch (e) {
    log(`recall addendum skipped: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  } finally {
    try {
      db?.close();
    } catch {
      /* already failing — nothing useful to do */
    }
  }
}

export async function noteMemory(db: Database, boardId: string, args: Record<string, unknown>) {
  const text = nonEmptyString(args.text);
  if (!text) return err('text is required — the fact to remember for this board.');
  const kind = requireString(args, 'kind') ?? 'note';
  // embed-on-write: stores the memory with an embedding for hybrid recall, or FTS5-only
  // (NULL vector) when embeddings are disabled/unavailable — never blocks the save.
  const id = await embedAndInsert(db, { board_id: boardId, text, kind });
  log(`memory_note: ${boardId} ${id} (${text.length}ch)`);
  return ok(`Saved memory ${id} for this board.`);
}

export async function recallMemory(db: Database, boardId: string, args: Record<string, unknown>) {
  const query = nonEmptyString(args.query);
  if (!query) return err("query is required — what to search this board's memories for.");
  let limit = DEFAULT_LIMIT;
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit)));
  }
  // Embed the query for hybrid recall; null (embeddings disabled / embed failed) → FTS5-only.
  const queryVector = await embedText(query);
  const hits = hybridSearchMemory(db, boardId, query, queryVector, limit);
  if (hits.length === 0) return ok('No stored memories match that query.');
  return ok(formatMemories(hits));
}

export const memoryNoteTool: McpToolDefinition = {
  tool: {
    name: 'memory_note',
    description:
      'Save a durable fact to this board\'s long-term memory so it can be recalled in future sessions. Use for stable, reusable facts (decisions, preferences, recurring context) — not transient chatter. Pass the fact as `text`; optionally a `kind` label (e.g. "fact", "decision", "preference").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The fact to remember (one self-contained statement).' },
        kind: {
          type: 'string',
          description: 'Optional category label, e.g. "fact", "decision", "preference". Defaults to "note".',
        },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const boardId = memoryBoardId();
    if (!boardId) return err(NOT_A_BOARD);
    const db = openBoardMemoryDb();
    try {
      return await noteMemory(db, boardId, args);
    } finally {
      db.close();
    }
  },
};

export const memorySearchTool: McpToolDefinition = {
  tool: {
    name: 'memory_search',
    description:
      "Search this board's long-term memory for durable facts saved in past sessions. Use when a request references something that may have been established earlier. Returns cited memories with their saved date. Pass keywords as `query`; optionally `limit` (default 5).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keywords to match against stored memories.' },
        limit: { type: 'number', description: 'Max results to return (default 5, max 20).' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const boardId = memoryBoardId();
    if (!boardId) return err(NOT_A_BOARD);
    const db = openBoardMemoryDb();
    try {
      return await recallMemory(db, boardId, args);
    } finally {
      db.close();
    }
  },
};

registerTools([memoryNoteTool, memorySearchTool]);
