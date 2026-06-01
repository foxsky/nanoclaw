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
import { hybridSearchMemory, type MemoryRow, openMemoryDbEnsuringDir } from '../memory-store.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { err, log, nonEmptyString, ok, requireString } from './util.js';

const NOT_A_BOARD = 'Memory is only available on TaskFlow boards (no board is bound to this group).';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

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
