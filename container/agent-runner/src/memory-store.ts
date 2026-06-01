/**
 * Native local memory store (v2) — a per-agent-group SQLite + FTS5 file, no external
 * service. Replaces the v1 agent-memory-server (external Redis) layer. Adopts Lossless
 * Claw's FTS5-over-local-store model.
 *
 * Durable path (production): /workspace/agent/memory/memory.db (the per-group mount,
 * NOT /workspace which is per-session). Memory's isolation boundary is therefore the
 * agent-group mount — identical to CLAUDE.local.md beside it. A separate-agent board gets
 * its own group/file; an agent-shared group shares memory like the rest of its workspace.
 * In practice the host resolves a group folder to a single board id at spawn time (current
 * policy: ORDER BY board_id LIMIT 1 — NOT a schema-enforced 1:1, since boards.group_folder
 * is not unique), so a file normally holds one board id. The board_id column scopes every
 * query regardless, so recall stays correct for the active board even if a file ever
 * accumulates more than one id (folder→board remap between spawns, replay override).
 * journal_mode=DELETE matches the cross-mount session-DB invariant; a truly-concurrent
 * second writer for the same group is a known P2 concern (host-side writer / board lock).
 *
 * Schema note: `id` is the public TEXT key but `rowid` is an explicit INTEGER PRIMARY KEY
 * so it is a stable rowid alias (not renumbered by VACUUM) — the FTS index joins on it.
 *
 * This module is the storage primitive only — capture wiring (PreCompact extraction, which
 * is what will populate source_session/source_ts) and the MCP tools live in later phases.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Database } from 'bun:sqlite';

/** Production location on the durable per-group mount. Tests pass ':memory:'. */
export const MEMORY_DB_PATH = '/workspace/agent/memory/memory.db';

export interface MemoryInput {
  board_id: string;
  text: string;
  kind?: string;
  source_session?: string | null;
  source_ts?: string | null;
  id?: string;
  /** Optional embedding for hybrid recall. NULL when embeddings are disabled/unavailable —
   *  the memory is still stored and findable via FTS5. */
  vector?: Float32Array | null;
}

export interface MemoryRow {
  id: string;
  board_id: string;
  kind: string;
  text: string;
  source_session: string | null;
  source_ts: string | null;
  created_at: string;
}

export function openMemoryDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      board_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      text TEXT NOT NULL,
      source_session TEXT,
      source_ts TEXT,
      created_at TEXT NOT NULL,
      vector BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_memories_board ON memories(board_id);
    -- Recency index: SQLite walks it in reverse for the ORDER BY created_at DESC used by
    -- recentMemories (auto-recall) and the keepTopN prune subquery, so a large board's prune
    -- transaction holds its write lock for ms not seconds (avoids busy-timeout on a concurrent
    -- same-group boot). Supersedes idx_memories_board for board-scoped lookups (prefix).
    CREATE INDEX IF NOT EXISTS idx_memories_board_created ON memories(board_id, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text);
  `);
  ensureVectorColumn(db);
  return db;
}

/** Add the `vector` column to a pre-embeddings memories table. CREATE...IF NOT EXISTS never
 *  alters an existing table, so a DB created before hybrid search needs this one-time ALTER. */
function ensureVectorColumn(db: Database): void {
  const cols = db.query('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'vector')) {
    db.exec('ALTER TABLE memories ADD COLUMN vector BLOB');
  }
}

/** Cosine similarity with a dim guard: a stored vector from a different model (wrong length)
 *  scores 0 rather than silently truncating to a false-high match. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Float32 vector → BLOB bytes for the SQLite column (a self-owned copy, decoupled from `v`). */
export function vectorToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/** BLOB bytes → Float32 vector. Copies into a fresh aligned buffer so an unaligned SQLite
 *  blob can't make the Float32Array constructor throw. */
export function blobToVector(blob: Uint8Array): Float32Array {
  const out = new Float32Array(Math.floor(blob.byteLength / 4));
  new Uint8Array(out.buffer).set(blob.subarray(0, out.length * 4));
  return out;
}

/** Open the production memory DB, creating its parent dir first. The per-group mount
 *  exists but the memory/ subdir may not. Shared by the MCP tools and PreCompact capture. */
export function openMemoryDbEnsuringDir(dbPath: string = MEMORY_DB_PATH): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return openMemoryDb(dbPath);
}

function genId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function insertMemory(db: Database, m: MemoryInput): string {
  const id = m.id ?? genId();
  const createdAt = new Date().toISOString();
  // Base row + FTS row in one transaction so a failure mid-insert can never leave a
  // stored-but-unsearchable memory (or an orphaned FTS row).
  const insert = db.transaction(() => {
    const { rowid } = db
      .query(
        `INSERT INTO memories (id, board_id, kind, text, source_session, source_ts, created_at, vector)
         VALUES ($id, $board, $kind, $text, $ss, $sts, $ca, $vec)
         RETURNING rowid`,
      )
      .get({
        $id: id,
        $board: m.board_id,
        $kind: m.kind ?? 'note',
        $text: m.text,
        $ss: m.source_session ?? null,
        $sts: m.source_ts ?? null,
        $ca: createdAt,
        $vec: m.vector ? vectorToBlob(m.vector) : null,
      }) as { rowid: number };
    db.query(`INSERT INTO memories_fts (rowid, text) VALUES ($r, $t)`).run({ $r: rowid, $t: m.text });
  });
  insert();
  return id;
}

/** True if the board already has a memory with this exact text (case/space-insensitive).
 *  Used by auto-capture to avoid re-storing the same fact every compaction. */
export function memoryExists(db: Database, boardId: string, text: string): boolean {
  const row = db
    .query(`SELECT 1 AS x FROM memories WHERE board_id = $b AND lower(trim(text)) = lower(trim($t)) LIMIT 1`)
    .get({ $b: boardId, $t: text });
  return row !== null;
}

/**
 * Tokenise to word chars only and quote each term so arbitrary agent/user text is a
 * safe FTS5 MATCH (no FTS5 operators injected, no syntax errors). Terms are space-joined
 * (FTS5 implicit AND). Returns '' when the query has no usable token (caller short-circuits).
 */
export function sanitizeFtsQuery(query: string): string {
  const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16);
  return terms.map((t) => `"${t}"`).join(' ');
}

/**
 * Reciprocal Rank Fusion of N ranked id-lists (each ordered best-first). Fuses on RANK, so
 * lists produced by different scorers — FTS5 bm25 vs cosine similarity — combine without any
 * score normalization: score(id) = Σ 1/(k + rank) over the lists containing it (rank 1-based),
 * higher = more relevant. `k` (default 60, the standard) damps the contribution of deep ranks.
 * A single list degrades to its own order; a missing list simply contributes nothing. Ties keep
 * first-seen order (Array.sort is stable), so the keyword list wins coin-flips by appearing first.
 */
export function fuseByRrf(
  rankedLists: string[][],
  opts: { k?: number; limit?: number } = {},
): Array<{ id: string; score: number }> {
  const k = opts.k ?? 60;
  const scores = new Map<string, number>();
  const seen: string[] = [];
  for (const list of rankedLists) {
    list.forEach((id, i) => {
      if (!scores.has(id)) seen.push(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  const fused = seen.map((id) => ({ id, score: scores.get(id) as number }));
  fused.sort((a, b) => b.score - a.score);
  return opts.limit === undefined ? fused : fused.slice(0, opts.limit);
}

export function searchMemory(db: Database, boardId: string, query: string, limit = 5): MemoryRow[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  return db
    .query(
      `SELECT m.id, m.board_id, m.kind, m.text, m.source_session, m.source_ts, m.created_at
       FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH $q AND m.board_id = $b
       ORDER BY rank
       LIMIT $lim`,
    )
    .all({ $q: match, $b: boardId, $lim: limit }) as MemoryRow[];
}

/** The N most-recent memories for a board (newest first). Used by once-per-session auto-recall
 *  to surface durable + auto-captured facts without the agent having to search for them. */
export function recentMemories(db: Database, boardId: string, limit = 10): MemoryRow[] {
  return db
    .query(
      `SELECT id, board_id, kind, text, source_session, source_ts, created_at
       FROM memories WHERE board_id = $b ORDER BY created_at DESC, rowid DESC LIMIT $lim`,
    )
    .all({ $b: boardId, $lim: limit }) as MemoryRow[];
}

export interface PruneOptions {
  /** Delete memories older than this many days (by created_at). Omit/≤0 = no age cap. */
  maxAgeDays?: number;
  /** Keep only the N most-recent per board; delete the older excess. Omit/≤0 = no budget cap. */
  keepTopN?: number;
  /** Injected for deterministic tests; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * P4 forgetting: bounded growth via opt-in age + budget caps, board-scoped. A memory is deleted
 * if it is older than maxAgeDays OR beyond the keepTopN most-recent (OR-union of the two caps).
 * With neither cap set this is a no-op (default = never forget). Victims are deleted from BOTH
 * `memories` and `memories_fts` by rowid in one transaction — `memories_fts` is a standalone FTS5
 * table kept in sync manually (no triggers), so a base-only delete would orphan/desync the index.
 * No VACUUM: rowid is a load-bearing FTS join alias and must not be renumbered. Returns the count
 * deleted. Within a container two processes write this DB — the main runner (boot prune +
 * PreCompact auto-capture) and the MCP-tool subprocess (memory_note) — but they serialize via
 * SQLite's file lock + busy_timeout (connection.ts), so the transaction stays consistent. A
 * truly-concurrent second CONTAINER for the same board is the separate known P-later gap.
 */
export function pruneMemories(db: Database, boardId: string, opts: PruneOptions): number {
  const hasAge = typeof opts.maxAgeDays === 'number' && opts.maxAgeDays > 0;
  const hasBudget = typeof opts.keepTopN === 'number' && opts.keepTopN > 0;
  if (!hasAge && !hasBudget) return 0;

  // Build the victim predicate as one SQL clause (board-scoped, age OR budget) so the DELETEs
  // need NO bound rowid list — a JS `IN (?,?,…)` list would hit SQLite's max-variable limit on a
  // large first-time prune and throw, which (being fail-soft) would silently prune nothing on
  // exactly the bloated boards that need it most.
  const params: Record<string, string | number> = { $b: boardId };
  const conds: string[] = [];
  if (hasAge) {
    params.$c = new Date((opts.nowMs ?? Date.now()) - opts.maxAgeDays! * 86_400_000).toISOString();
    conds.push('created_at < $c');
  }
  if (hasBudget) {
    params.$k = opts.keepTopN!;
    conds.push(
      'rowid NOT IN (SELECT rowid FROM memories WHERE board_id = $b ORDER BY created_at DESC, rowid DESC LIMIT $k)',
    );
  }
  const victimWhere = `board_id = $b AND (${conds.join(' OR ')})`;

  // memories_fts is a manual standalone FTS5 table (no triggers) — delete it FIRST, keyed off the
  // still-intact `memories` victim set, then delete the base rows. One transaction = all-or-nothing,
  // so the FTS index can never end up orphaned/desynced from the base table.
  const prune = db.transaction(() => {
    db.query(`DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE ${victimWhere})`).run(params);
    return db.query(`DELETE FROM memories WHERE ${victimWhere}`).run(params).changes;
  });
  return Number(prune());
}

// Per-modality candidate pool feeding the fusion; RRF does the final top-N ranking.
const HYBRID_CANDIDATES = 50;

/** Board-scoped FTS5 keyword match → ranked memory ids (best-first). */
function ftsRankedIds(db: Database, boardId: string, query: string, limit: number): string[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  return (
    db
      .query(
        `SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH $q AND m.board_id = $b ORDER BY rank LIMIT $lim`,
      )
      .all({ $q: match, $b: boardId, $lim: limit }) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** Board-scoped cosine ranking of stored vectors against queryVector → ranked memory ids. */
function vectorRankedIds(db: Database, boardId: string, queryVector: Float32Array, limit: number): string[] {
  const rows = db
    .query(`SELECT id, vector FROM memories WHERE board_id = $b AND vector IS NOT NULL`)
    .all({ $b: boardId }) as Array<{ id: string; vector: Uint8Array }>;
  return rows
    .map((r) => ({ id: r.id, score: cosineSimilarity(queryVector, blobToVector(r.vector)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.id);
}

/** Fetch full rows for ids, board-scoped, preserving the given id order. */
function rowsByIds(db: Database, boardId: string, ids: string[]): MemoryRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .query(
      `SELECT id, board_id, kind, text, source_session, source_ts, created_at
       FROM memories WHERE board_id = ? AND id IN (${placeholders})`,
    )
    .all(boardId, ...ids) as MemoryRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is MemoryRow => r !== undefined);
}

/**
 * Hybrid recall: fuse FTS5 keyword ranking with vector (cosine) ranking via RRF, board-scoped.
 * With no queryVector (embeddings disabled / embed failed) it is EXACTLY FTS5 searchMemory, so
 * hybrid is a strict, safe enhancement — keyword recall never regresses. With a vector, a
 * paraphrase sharing no keywords can still be recalled, and matches agreeing across both
 * modalities rank highest.
 */
export function hybridSearchMemory(
  db: Database,
  boardId: string,
  query: string,
  queryVector: Float32Array | null,
  limit = 5,
): MemoryRow[] {
  if (!queryVector) return searchMemory(db, boardId, query, limit);
  const fts = ftsRankedIds(db, boardId, query, HYBRID_CANDIDATES);
  const vec = vectorRankedIds(db, boardId, queryVector, HYBRID_CANDIDATES);
  const fusedIds = fuseByRrf([fts, vec], { limit }).map((r) => r.id);
  return rowsByIds(db, boardId, fusedIds);
}
