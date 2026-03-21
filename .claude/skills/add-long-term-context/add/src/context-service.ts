import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** DAG hierarchy levels */
export const Level = {
  LEAF: 0,
  DAILY: 1,
  WEEKLY: 2,
  MONTHLY: 3,
} as const;

const DEFAULT_OLLAMA_MODEL = 'qwen3-coder:latest';
const CLAUDE_API_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_DISPLAY_NAME = 'haiku-4.5';

/** Estimate token count from text length. Calibrated at 3.5 chars/token for Portuguese/English. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ContextConfig {
  summarizer: 'ollama' | 'claude';
  summarizerModel?: string;
  fallbackModel?: string; // CONTEXT_FALLBACK_MODEL — tried on same Ollama host when primary fails
  ollamaHost?: string;
  anthropicApiKey?: string; // passed from caller (reads .env via readEnvFile)
  retainDays: number;
}

export interface SessionMessage {
  sender: string;
  content: string;
  timestamp: string;
}

export interface ToolCallSummary {
  tool: string;
  resultSummary: string;
}

export interface CapturedTurn {
  userMessage: string;
  agentResponse: string;
  toolCalls: ToolCallSummary[];
  timestamp: string;
  senderName?: string;
}

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS context_cursors (
  group_folder  TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  last_entry_index INTEGER NOT NULL DEFAULT 0,
  last_byte_offset INTEGER NOT NULL DEFAULT 0,
  last_assistant_uuid TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_nodes (
  id            TEXT PRIMARY KEY,
  group_folder  TEXT NOT NULL,
  level         INTEGER NOT NULL,
  summary       TEXT,
  time_start    TEXT NOT NULL,
  time_end      TEXT NOT NULL,
  parent_id     TEXT REFERENCES context_nodes(id) ON DELETE SET NULL,
  token_count   INTEGER,
  model         TEXT,
  created_at    TEXT NOT NULL,
  pruned_at     TEXT
);

CREATE TABLE IF NOT EXISTS context_sessions (
  id            TEXT PRIMARY KEY,
  group_folder  TEXT NOT NULL,
  session_id    TEXT,
  messages      TEXT NOT NULL,
  agent_response TEXT,
  tool_calls    TEXT,
  created_at    TEXT NOT NULL,
  pruned_at     TEXT,
  FOREIGN KEY (id) REFERENCES context_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_group_level ON context_nodes(group_folder, level, time_start);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON context_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_pending ON context_nodes(level, summary) WHERE summary IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_group ON context_sessions(group_folder, created_at);
CREATE INDEX IF NOT EXISTS idx_nodes_pruned ON context_nodes(pruned_at) WHERE pruned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_group_time ON context_nodes(group_folder, time_start, time_end);

CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  node_id UNINDEXED,
  group_folder UNINDEXED,
  summary
);

CREATE VIRTUAL TABLE IF NOT EXISTS context_fts_vocab USING fts5vocab(context_fts, row);
`;

// Each trigger is a separate constant to avoid the splitting-on-semicolons
// bug that corrupts BEGIN...END blocks. Each is executed via db.exec().
const TRIGGER_FTS_INSERT = `
CREATE TRIGGER IF NOT EXISTS context_fts_insert AFTER INSERT ON context_nodes
  WHEN NEW.summary IS NOT NULL
  BEGIN INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary); END;
`;

const TRIGGER_FTS_UPDATE = `
CREATE TRIGGER IF NOT EXISTS context_fts_update AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NOT NULL AND OLD.summary IS NOT NULL
  BEGIN
    DELETE FROM context_fts WHERE node_id = OLD.id;
    INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary);
  END;
`;

const TRIGGER_FTS_FIRST = `
CREATE TRIGGER IF NOT EXISTS context_fts_first AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NOT NULL AND OLD.summary IS NULL
  BEGIN INSERT INTO context_fts(node_id, group_folder, summary) VALUES (NEW.id, NEW.group_folder, NEW.summary); END;
`;

const TRIGGER_FTS_CLEAR = `
CREATE TRIGGER IF NOT EXISTS context_fts_clear AFTER UPDATE OF summary ON context_nodes
  WHEN NEW.summary IS NULL AND OLD.summary IS NOT NULL
  BEGIN DELETE FROM context_fts WHERE node_id = OLD.id; END;
`;

const TRIGGER_FTS_DELETE = `
CREATE TRIGGER IF NOT EXISTS context_fts_delete AFTER DELETE ON context_nodes
  WHEN OLD.summary IS NOT NULL
  BEGIN DELETE FROM context_fts WHERE node_id = OLD.id; END;
`;

/* ------------------------------------------------------------------ */
/*  Summarization prompts                                              */
/* ------------------------------------------------------------------ */

const LEAF_PROMPT_TEMPLATE = `Summarize this conversation turn concisely. Include:
- Who sent the message and what they asked/reported
- What actions the assistant took (task updates, assignments, captures)
- Any decisions made or information exchanged
- Key outcome

User message:
{user_message}

Assistant response:
{agent_response}

Tools called: {tool_names}

Write a concise summary in the same language as the conversation.`;

const ROLLUP_PROMPTS: Record<string, string> = {
  day: `Summarize the day's activity from these session summaries. Group by theme, not chronologically. Highlight:
- Tasks created, completed, or moved
- Key decisions and their rationale
- Open questions or pending items
- Notable interactions

{summaries}

Write a concise daily summary in the same language as the sessions.`,

  week: `Summarize the week's activity from these daily summaries. Focus on:
- Overall progress and velocity
- Key accomplishments
- Recurring themes or blockers
- Status changes across the week

{summaries}

Write a concise weekly summary in the same language as the sessions.`,

  month: `Summarize the month's activity from these weekly summaries. Capture:
- Major milestones and deliverables
- Trends and patterns
- Strategic decisions
- State at month-end

{summaries}

Write a concise monthly summary in the same language as the sessions.`,
};

/* ------------------------------------------------------------------ */
/*  ContextService                                                     */
/* ------------------------------------------------------------------ */

export class ContextService {
  private static leafCounter = 0; // monotonic suffix to prevent timestamp collisions

  readonly db: Database.Database;
  private readonly config: ContextConfig;

  // Prepared statements — initialized in constructor after this.db is assigned
  private readonly stmtInsertNode: Database.Statement;
  private readonly stmtInsertSession: Database.Statement;
  private readonly stmtSelectPending: Database.Statement;
  private readonly stmtUpdateSummary: Database.Statement;
  private readonly stmtSelectChildrenForRollup: Database.Statement;
  private readonly stmtInsertRollupNode: Database.Statement;
  private readonly stmtSetParent: Database.Statement;
  private readonly stmtSelectExistingNode: Database.Statement;
  private readonly stmtPruneNodes: Database.Statement;
  private readonly stmtPruneSessions: Database.Statement;
  private readonly stmtVacuum: Database.Statement;

  constructor(dbPath: string, config: ContextConfig) {
    this.config = config;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    // Schema migration: add last_byte_offset if missing (for DBs created before this column)
    try {
      this.db.exec(
        'ALTER TABLE context_cursors ADD COLUMN last_byte_offset INTEGER NOT NULL DEFAULT 0',
      );
    } catch {
      // Column already exists — expected
    }

    // Execute each trigger as a separate db.exec() call — never split on ';'
    this.db.exec(TRIGGER_FTS_INSERT);
    this.db.exec(TRIGGER_FTS_UPDATE);
    this.db.exec(TRIGGER_FTS_FIRST);
    this.db.exec(TRIGGER_FTS_CLEAR);
    this.db.exec(TRIGGER_FTS_DELETE);

    // Prepare cached statements
    this.stmtInsertNode = this.db.prepare(`
      INSERT OR IGNORE INTO context_nodes (id, group_folder, level, summary, time_start, time_end, created_at)
      VALUES (?, ?, 0, NULL, ?, ?, ?)
    `);

    this.stmtInsertSession = this.db.prepare(`
      INSERT OR IGNORE INTO context_sessions (id, group_folder, session_id, messages, agent_response, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtSelectPending = this.db.prepare(`
      SELECT cn.id, cs.messages, cs.agent_response, cs.tool_calls
      FROM context_nodes cn
      JOIN context_sessions cs ON cs.id = cn.id
      WHERE cn.level = 0 AND cn.summary IS NULL AND cn.pruned_at IS NULL
      ORDER BY cn.created_at ASC
      LIMIT ?
    `);

    this.stmtUpdateSummary = this.db.prepare(`
      UPDATE context_nodes SET summary = ?, token_count = ?, model = ? WHERE id = ?
    `);

    this.stmtSelectChildrenForRollup = this.db.prepare(`
      SELECT id, summary FROM context_nodes
      WHERE group_folder = ? AND level = ? AND parent_id IS NULL
        AND time_start >= ? AND time_start < ?
        AND summary IS NOT NULL AND pruned_at IS NULL
      ORDER BY time_start ASC
    `);

    this.stmtInsertRollupNode = this.db.prepare(`
      INSERT INTO context_nodes (id, group_folder, level, summary, time_start, time_end, token_count, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtSetParent = this.db.prepare(`
      UPDATE context_nodes SET parent_id = ? WHERE id = ?
    `);

    this.stmtSelectExistingNode = this.db.prepare(`
      SELECT id FROM context_nodes WHERE id = ?
    `);

    this.stmtPruneNodes = this.db.prepare(`
      UPDATE context_nodes SET pruned_at = ?
      WHERE pruned_at IS NULL AND level <= 1 AND created_at < ?
    `);

    this.stmtPruneSessions = this.db.prepare(`
      UPDATE context_sessions SET pruned_at = ?
      WHERE pruned_at IS NULL AND id IN (
        SELECT cs.id FROM context_sessions cs
        JOIN context_nodes cn ON cn.id = cs.id
        WHERE cn.pruned_at IS NOT NULL AND cn.level = 0
        AND cs.pruned_at IS NULL
      )
    `);

    this.stmtVacuum = this.db.prepare(`
      DELETE FROM context_nodes WHERE pruned_at IS NOT NULL AND pruned_at < ?
    `);
  }

  /* ---------------------------------------------------------------- */
  /*  insertTurn — create leaf node + session record                   */
  /* ---------------------------------------------------------------- */

  insertTurn(
    groupFolder: string,
    sessionId: string,
    turn: CapturedTurn,
  ): number {
    // Add monotonic suffix to prevent collision when two turns share the same timestamp
    const suffix = String(ContextService.leafCounter++).padStart(4, '0');
    const nodeId = `leaf:${groupFolder}:${turn.timestamp}:${suffix}`;
    const now = new Date().toISOString();
    const messages: SessionMessage[] = [
      {
        sender: turn.senderName ?? 'user',
        content: turn.userMessage,
        timestamp: turn.timestamp,
      },
    ];

    this.db.transaction(() => {
      this.stmtInsertNode.run(
        nodeId,
        groupFolder,
        turn.timestamp,
        turn.timestamp,
        now,
      );
      this.stmtInsertSession.run(
        nodeId,
        groupFolder,
        sessionId,
        JSON.stringify(messages),
        turn.agentResponse,
        JSON.stringify(turn.toolCalls),
        now,
      );
    })();

    return 1;
  }

  /* ---------------------------------------------------------------- */
  /*  summarizePending — summarize unsummarized leaf nodes             */
  /* ---------------------------------------------------------------- */

  async summarizePending(limit = 5): Promise<number> {
    const pending = this.stmtSelectPending.all(limit) as Array<{
      id: string;
      messages: string;
      agent_response: string | null;
      tool_calls: string | null;
    }>;

    let count = 0;
    for (const row of pending) {
      try {
        const messages = JSON.parse(row.messages) as SessionMessage[];
        const userMsg = messages.map((m) => m.content).join('\n');
        const tools = row.tool_calls
          ? (JSON.parse(row.tool_calls) as ToolCallSummary[])
          : [];
        const toolNames = tools.map((t) => t.tool).join(', ') || 'none';

        const prompt = LEAF_PROMPT_TEMPLATE.replace('{user_message}', userMsg)
          .replace('{agent_response}', row.agent_response ?? '(no response)')
          .replace('{tool_names}', toolNames);

        const summary = await this.callSummarizer(prompt);
        if (summary && summary.length > 20) {
          const tokenCount = estimateTokens(summary);
          const model = this.getModelName();
          this.stmtUpdateSummary.run(summary, tokenCount, model, row.id);
          count++;
        }
      } catch (err) {
        logger.warn({ err, nodeId: row.id }, 'Failed to summarize leaf node');
      }
    }
    return count;
  }

  /* ---------------------------------------------------------------- */
  /*  Rollups — daily, weekly, monthly                                 */
  /* ---------------------------------------------------------------- */

  async rollupDaily(groupFolder: string, date: string): Promise<string | null> {
    const parentId = `daily:${groupFolder}:${date}`;
    // Range: [date, date+1day) to capture all leaf nodes within that day
    const rangeStart = date;
    const rangeEnd = this.addDays(date, 1);
    return this.rollup(groupFolder, 0, 1, parentId, rangeStart, rangeEnd);
  }

  async rollupWeekly(
    groupFolder: string,
    weekStart: string,
  ): Promise<string | null> {
    const weekLabel = this.isoWeek(weekStart);
    const parentId = `weekly:${groupFolder}:${weekLabel}`;
    // Range: [weekStart, weekStart+7days) to capture all daily nodes within that week
    const rangeEnd = this.addDays(weekStart, 7);
    return this.rollup(groupFolder, 1, 2, parentId, weekStart, rangeEnd);
  }

  async rollupMonthly(
    groupFolder: string,
    month: string,
  ): Promise<string | null> {
    const parentId = `monthly:${groupFolder}:${month}`;
    const monthStart = `${month}-01`;
    // Next month first day
    const [y, m] = month.split('-').map(Number);
    const nextMonth =
      m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const rangeEnd = `${nextMonth}-01`;
    return this.rollup(groupFolder, 2, 3, parentId, monthStart, rangeEnd);
  }

  private async rollup(
    groupFolder: string,
    childLevel: number,
    parentLevel: number,
    parentId: string,
    rangeStart: string,
    rangeEnd: string,
  ): Promise<string | null> {
    // Check if rollup already exists — if so, adopt any late-arriving orphans
    const existing = this.stmtSelectExistingNode.get(parentId);
    if (existing) {
      const orphans = this.stmtSelectChildrenForRollup.all(
        groupFolder,
        childLevel,
        rangeStart,
        rangeEnd,
      ) as Array<{ id: string; summary: string }>;
      if (orphans.length > 0) {
        for (const orphan of orphans) {
          this.stmtSetParent.run(parentId, orphan.id);
        }
        logger.info(
          { parentId, adopted: orphans.length },
          'Adopted orphaned children into existing rollup',
        );
      }
      return null;
    }

    // Get children within the range
    const children = this.stmtSelectChildrenForRollup.all(
      groupFolder,
      childLevel,
      rangeStart,
      rangeEnd,
    ) as Array<{ id: string; summary: string }>;

    if (children.length === 0) return null;

    const levelName =
      parentLevel === Level.DAILY
        ? 'day'
        : parentLevel === Level.WEEKLY
          ? 'week'
          : 'month';
    const combinedSummaries = children.map((c) => c.summary).join('\n\n');
    const prompt = ROLLUP_PROMPTS[levelName].replace(
      '{summaries}',
      combinedSummaries,
    );

    const summary = await this.callSummarizer(prompt);
    if (!summary || summary.length <= 20) return null;

    const now = new Date().toISOString();
    const tokenCount = estimateTokens(summary);
    const model = this.getModelName();

    // time_start = beginning of the range, time_end = last moment before rangeEnd
    const timeStart =
      rangeStart.length === 10 ? rangeStart + 'T00:00:00.000Z' : rangeStart;
    // rangeEnd is exclusive (first day of next period), so time_end is the last moment
    // of the previous day: subtract 1 day from rangeEnd and add T23:59:59.999Z
    const lastDay = this.addDays(rangeEnd.slice(0, 10), -1);
    const timeEnd = lastDay + 'T23:59:59.999Z';

    this.db.transaction(() => {
      this.stmtInsertRollupNode.run(
        parentId,
        groupFolder,
        parentLevel,
        summary,
        timeStart,
        timeEnd,
        tokenCount,
        model,
        now,
      );
      for (const child of children) {
        this.stmtSetParent.run(parentId, child.id);
      }
    })();

    return parentId;
  }

  /* ---------------------------------------------------------------- */
  /*  Retention and vacuum                                             */
  /* ---------------------------------------------------------------- */

  applyRetention(): number {
    const cutoff = new Date(
      Date.now() - this.config.retainDays * 86400000,
    ).toISOString();
    const now = new Date().toISOString();

    // Single transaction: prune nodes + sessions in lockstep (cached statements)
    const result = this.db.transaction(() => {
      const nodeResult = this.stmtPruneNodes.run(now, cutoff);
      this.stmtPruneSessions.run(now);
      return nodeResult;
    })();

    return result.changes;
  }

  vacuum(): number {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    // DELETE on context_nodes cascades to context_sessions via FK ON DELETE CASCADE
    return this.stmtVacuum.run(cutoff).changes;
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed — idempotent
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                   */
  /* ---------------------------------------------------------------- */

  private getModelName(): string {
    return this.config.summarizer === 'claude'
      ? CLAUDE_DISPLAY_NAME
      : (this.config.summarizerModel ?? DEFAULT_OLLAMA_MODEL);
  }

  /** Consecutive summarizer failures — used for alerting. */
  private consecutiveFailures = 0;
  private static readonly FAILURE_ALERT_THRESHOLD = 10;

  private async callSummarizer(prompt: string): Promise<string | null> {
    try {
      let result: string | null;
      if (this.config.summarizer === 'claude') {
        result = await this.callClaude(prompt);
      } else {
        result = await this.callOllama(prompt);
        // Fallback to a different Ollama model when primary fails
        if (!result && this.config.fallbackModel) {
          logger.info(
            { fallback: this.config.fallbackModel },
            'Primary Ollama model failed, trying fallback',
          );
          result = await this.callOllama(prompt, this.config.fallbackModel);
        }
      }
      if (result) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
        if (
          this.consecutiveFailures === ContextService.FAILURE_ALERT_THRESHOLD
        ) {
          logger.error(
            {
              failures: this.consecutiveFailures,
              model: this.getModelName(),
              summarizer: this.config.summarizer,
            },
            'Summarizer has failed 10 consecutive times — check model availability',
          );
        }
      }
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      logger.warn({ err }, 'Summarizer call failed');
      if (this.consecutiveFailures === ContextService.FAILURE_ALERT_THRESHOLD) {
        logger.error(
          { failures: this.consecutiveFailures, model: this.getModelName() },
          'Summarizer has failed 10 consecutive times — check model availability',
        );
      }
      return null;
    }
  }

  private async callOllama(
    prompt: string,
    modelOverride?: string,
  ): Promise<string | null> {
    if (!this.config.ollamaHost) return null;
    const model =
      modelOverride ?? this.config.summarizerModel ?? DEFAULT_OLLAMA_MODEL;
    const resp = await fetch(`${this.config.ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        keep_alive: -1,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status, model },
        'Ollama summarizer returned non-OK',
      );
      return null;
    }
    const data = (await resp.json()) as { response?: string };
    return data.response ?? null;
  }

  private async callClaude(prompt: string): Promise<string | null> {
    const apiKey = this.config.anthropicApiKey;
    if (!apiKey) return null;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_API_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'Claude summarizer returned non-OK');
      return null;
    }
    const data = (await resp.json()) as {
      content?: Array<{ text?: string }>;
    };
    return data.content?.[0]?.text ?? null;
  }

  private addDays(date: string, days: number): string {
    const d = new Date(date + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private isoWeek(date: string): string {
    const d = new Date(date + 'T00:00:00.000Z');
    // Set to Thursday of the week (ISO 8601 week date algorithm)
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }
}
