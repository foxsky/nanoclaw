/**
 * Native local memory store (v2) — a per-agent-group SQLite + FTS5 file, no external
 * service. Replaces the v1 agent-memory-server (external Redis) layer. Adopts Lossless
 * Claw's FTS5-over-local-store + provenance model.
 *
 * Durable path (production): /workspace/agent/memory/memory.db (the per-group mount,
 * NOT /workspace which is per-session). journal_mode=DELETE matches the cross-mount
 * session-DB invariant; a truly-concurrent second writer for the same group is a known
 * P2 concern (host-side writer / board lock).
 *
 * This module is the storage primitive only — capture wiring (PreCompact extraction)
 * and the MCP tools live in later phases.
 */
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
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      text TEXT NOT NULL,
      source_session TEXT,
      source_ts TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_board ON memories(board_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text);
  `);
  return db;
}

function genId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function insertMemory(db: Database, m: MemoryInput): string {
  const id = m.id ?? genId();
  const createdAt = new Date().toISOString();
  const { rowid } = db
    .query(
      `INSERT INTO memories (id, board_id, kind, text, source_session, source_ts, created_at)
       VALUES ($id, $board, $kind, $text, $ss, $sts, $ca)
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
    }) as { rowid: number };
  db.query(`INSERT INTO memories_fts (rowid, text) VALUES ($r, $t)`).run({ $r: rowid, $t: m.text });
  return id;
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
