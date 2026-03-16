import Database from 'better-sqlite3';

import { closeDb, openReadonlyDb } from './db-util.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ContextNode {
  id: string;
  group_folder: string;
  level: number;
  summary: string | null;
  time_start: string;
  time_end: string;
  parent_id: string | null;
  token_count: number | null;
  model: string | null;
  created_at: string;
}

export interface ContextSession {
  id: string;
  group_folder: string;
  messages: Array<{ sender: string; content: string; timestamp: string }>;
  agent_response: string | null;
  tool_calls: Array<{ tool: string; resultSummary: string }>;
  created_at: string;
}

export interface RecallResult {
  summary: ContextNode;
  sessions: ContextSession[];
  children: ContextNode[];
  detail_pruned: boolean;
}

export interface TopicEntry {
  topic: string;
  nodeCount: number;
  lastSeen: string;
}

/* ------------------------------------------------------------------ */
/*  Stop words — filtered from topics extraction                       */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'was', 'are',
  'were', 'been', 'have', 'has', 'had', 'not', 'but', 'what', 'all',
  'can', 'her', 'she', 'his', 'him', 'how', 'its', 'may', 'new',
  'now', 'old', 'see', 'way', 'who', 'did', 'get', 'let', 'say',
  'too', 'use', 'will', 'about', 'also', 'into', 'just', 'more',
  'most', 'much', 'must', 'only', 'other', 'over', 'such', 'than',
  'them', 'then', 'they', 'very', 'when', 'which', 'your', 'after',
  'being', 'could', 'each', 'made', 'make', 'like', 'long', 'look',
  'many', 'some', 'take', 'come', 'good', 'know', 'should',
  'would', 'their', 'there', 'these', 'those', 'where', 'while',
  'para', 'uma', 'com', 'que', 'por', 'dos', 'das', 'nos', 'nas',
  'foi', 'ser', 'ter', 'como', 'mais', 'sem', 'ele', 'ela',
]);

/* ------------------------------------------------------------------ */
/*  ContextReader                                                      */
/* ------------------------------------------------------------------ */

export class ContextReader {
  private db: Database.Database | null = null;

  constructor(dbPath: string) {
    this.db = openReadonlyDb(dbPath);
  }

  /* ---------------------------------------------------------------- */
  /*  getRecentSummaries                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Returns the N most recent leaf-level (level 0) summaries for the group.
   * Only returns nodes where summary IS NOT NULL and pruned_at IS NULL.
   */
  getRecentSummaries(group: string, limit: number): ContextNode[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT * FROM context_nodes
           WHERE group_folder = ? AND level = 0 AND summary IS NOT NULL AND pruned_at IS NULL
           ORDER BY time_start DESC LIMIT ?`,
        )
        .all(group, limit) as ContextNode[];
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------------- */
  /*  search                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * FTS5 full-text search with group isolation.
   * Supports optional date range filtering.
   */
  search(
    group: string,
    query: string,
    options?: { dateFrom?: string; dateTo?: string; limit?: number },
  ): ContextNode[] {
    if (!this.db) return [];
    const limit = options?.limit ?? 20;

    try {
      let sql = `
        SELECT cn.* FROM context_fts cf
        JOIN context_nodes cn ON cn.id = cf.node_id
        WHERE context_fts MATCH ? AND cf.group_folder = ? AND cn.pruned_at IS NULL`;
      const params: Array<string | number> = [query, group];

      if (options?.dateFrom) {
        sql += ` AND cn.time_start >= ?`;
        params.push(options.dateFrom);
      }
      if (options?.dateTo) {
        sql += ` AND cn.time_end <= ?`;
        // Append time suffix if date-only (e.g., '2026-03-15' → '2026-03-15T23:59:59.999Z')
        const dateTo = options.dateTo.length === 10 ? options.dateTo + 'T23:59:59.999Z' : options.dateTo;
        params.push(dateTo);
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      return this.db.prepare(sql).all(...params) as ContextNode[];
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------------- */
  /*  recall                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Expand a node to see children/sessions.
   * For leaf nodes: returns summary + original session messages.
   * For rollup nodes: returns summary + non-pruned child node summaries.
   * SECURITY: group_folder enforced via WHERE id = ? AND group_folder = ?
   */
  recall(group: string, nodeId: string): RecallResult | null {
    if (!this.db) return null;

    try {
      // Fetch the root node — must match group
      const node = this.db
        .prepare(
          `SELECT * FROM context_nodes WHERE id = ? AND group_folder = ? AND pruned_at IS NULL`,
        )
        .get(nodeId, group) as ContextNode | undefined;

      if (!node) return null;

      // Fetch non-pruned children (for rollup nodes)
      const children = this.db
        .prepare(
          `SELECT * FROM context_nodes WHERE parent_id = ? AND group_folder = ? AND pruned_at IS NULL`,
        )
        .all(nodeId, group) as ContextNode[];

      // Fetch session data (for leaf nodes)
      const rawSessions = this.db
        .prepare(
          `SELECT * FROM context_sessions WHERE id = ? AND group_folder = ? AND pruned_at IS NULL`,
        )
        .all(nodeId, group) as Array<{
        id: string;
        group_folder: string;
        messages: string;
        agent_response: string | null;
        tool_calls: string | null;
        created_at: string;
      }>;

      const sessions: ContextSession[] = rawSessions.map((raw) => ({
        id: raw.id,
        group_folder: raw.group_folder,
        messages: this.parseJson(raw.messages, []),
        agent_response: raw.agent_response,
        tool_calls: this.parseJson(raw.tool_calls, []),
        created_at: raw.created_at,
      }));

      // Determine detail_pruned:
      // For rollup nodes (level > 0): true if node has no non-pruned children
      // For leaf nodes (level 0): true if session data has been pruned
      let detailPruned = false;
      if (node.level > 0) {
        // Check if there are ANY children (including pruned ones)
        const totalChildren = this.db
          .prepare(
            `SELECT COUNT(*) as cnt FROM context_nodes WHERE parent_id = ? AND group_folder = ?`,
          )
          .get(nodeId, group) as { cnt: number };
        // If there were children but all are now pruned
        detailPruned = totalChildren.cnt > 0 && children.length === 0;
      } else {
        // Leaf node: check if session was pruned
        const totalSessions = this.db
          .prepare(
            `SELECT COUNT(*) as cnt FROM context_sessions WHERE id = ? AND group_folder = ?`,
          )
          .get(nodeId, group) as { cnt: number };
        detailPruned = totalSessions.cnt > 0 && sessions.length === 0;
      }

      return {
        summary: node,
        sessions,
        children,
        detail_pruned: detailPruned,
      };
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  timeline                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Chronological summary list for a date range.
   * Auto-selects best level by ordering higher-level nodes first.
   */
  timeline(group: string, dateFrom: string, dateTo: string): ContextNode[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT * FROM context_nodes
           WHERE group_folder = ? AND time_start >= ? AND time_end <= ? AND pruned_at IS NULL
           ORDER BY level DESC, time_start ASC
           LIMIT 200`,
        )
        .all(
          group,
          dateFrom,
          dateTo.length === 10 ? dateTo + 'T23:59:59.999Z' : dateTo,
        ) as ContextNode[];
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------------- */
  /*  topics                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Extracts top terms from FTS5 using fts5vocab with group-scoped counts.
   * Returns top 20 terms ranked by group-specific occurrence count.
   */
  topics(group: string): TopicEntry[] {
    if (!this.db) return [];

    try {
      // Single query: fetch all non-pruned summaries + time_end for this group.
      // Tokenize and count in JS — eliminates N+1 FTS MATCH queries entirely.
      const rows = this.db
        .prepare(
          `SELECT summary, time_end FROM context_nodes
           WHERE group_folder = ? AND summary IS NOT NULL AND pruned_at IS NULL`,
        )
        .all(group) as Array<{ summary: string; time_end: string }>;

      if (rows.length === 0) return [];

      // Count term frequency and track lastSeen across all summaries
      const termCounts = new Map<string, { count: number; lastSeen: string }>();

      for (const row of rows) {
        // Simple word tokenization: lowercase, split on non-alphanumeric, filter short + stop words
        const words = row.summary
          .toLowerCase()
          .split(/[^a-záàâãéèêíïóôõúüçñ0-9]+/)
          .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

        // Deduplicate within a single summary (count each term once per document)
        const unique = new Set(words);
        for (const term of unique) {
          const existing = termCounts.get(term);
          if (existing) {
            existing.count++;
            if (row.time_end > existing.lastSeen) {
              existing.lastSeen = row.time_end;
            }
          } else {
            termCounts.set(term, { count: 1, lastSeen: row.time_end });
          }
        }
      }

      // Sort by count descending, return top 20
      const results: TopicEntry[] = [];
      for (const [topic, { count, lastSeen }] of termCounts) {
        results.push({ topic, nodeCount: count, lastSeen });
      }
      results.sort((a, b) => b.nodeCount - a.nodeCount);
      return results.slice(0, 20);
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------------- */
  /*  getNodeCount                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Count of non-pruned nodes for the group (used for progressive tool unlock).
   */
  getNodeCount(group: string): number {
    if (!this.db) return 0;
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM context_nodes WHERE group_folder = ? AND pruned_at IS NULL`,
        )
        .get(group) as { cnt: number };
      return row.cnt;
    } catch {
      return 0;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  close                                                            */
  /* ---------------------------------------------------------------- */

  close(): void {
    closeDb(this.db);
    this.db = null;
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                   */
  /* ---------------------------------------------------------------- */

  private parseJson<T>(value: string | null, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
}
