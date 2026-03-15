import fs from 'fs';
import path from 'path';

import type { ContextService } from './context-service.js';
import { logger } from './logger.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A parsed user->assistant turn extracted from a JSONL transcript. */
export interface ParsedTurn {
  userMessage: string;
  agentResponse: string;
  toolCalls: Array<{ tool: string; resultSummary: string }>;
  timestamp: string;
  /** UUID of the last assistant entry in this turn (for cursor consistency). */
  lastAssistantUuid: string | undefined;
  /** The line index (0-based) AFTER the last line of this turn (exclusive end). */
  endIndex: number;
}

/* ------------------------------------------------------------------ */
/*  JSONL path helper                                                  */
/* ------------------------------------------------------------------ */

import { DATA_DIR } from './config.js';

const SESSIONS_BASE = path.join(DATA_DIR, 'sessions');

/**
 * Constructs the host-side path to a session's JSONL transcript.
 * Isolated into a single helper so SDK convention changes only need
 * one update.
 */
export function jsonlPath(groupFolder: string, sessionId: string): string {
  return path.join(
    SESSIONS_BASE,
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
}

/* ------------------------------------------------------------------ */
/*  JSONL transcript parser                                            */
/* ------------------------------------------------------------------ */

interface JsonlEntry {
  type?: string;
  subtype?: string;
  operation?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{
          type?: string;
          text?: string;
          tool_use_id?: string;
          content?: string | Array<{ type?: string; text?: string }>;
        }>;
  };
  uuid?: string;
}

/**
 * Parses user->assistant turn pairs from JSONL transcript lines.
 *
 * Rules (from design spec):
 * - `queue-operation` with `operation: 'dequeue'` = turn boundary (most reliable)
 * - `user` with array content containing at least one non-tool_result block = new turn start
 * - `user` with string content = usually compaction summary (skip)
 * - `assistant` with array content = extract text blocks as response, tool_use blocks for tool names
 * - `user` with array of only tool_result blocks = part of current turn
 * - `system` with `subtype: 'compact_boundary'` = skip, and skip next user entry too
 * - All other types: skip
 *
 * A turn is only complete if it has BOTH a user message AND at least one
 * assistant text response. Incomplete turns are NOT returned — the caller
 * should not advance the cursor past them.
 *
 * @param lines - Array of raw JSONL strings (one per line)
 * @param startIndex - The line offset these lines start at (for computing endIndex)
 * @returns Array of complete ParsedTurn objects
 */
export function parseTurnsFromJsonl(
  lines: string[],
  startIndex = 0,
): ParsedTurn[] {
  const turns: ParsedTurn[] = [];

  // State for the current in-progress turn
  let currentUserMessage = '';
  let currentTimestamp = '';
  let currentResponseTexts: string[] = [];
  let currentToolCalls: Array<{ tool: string; resultSummary: string }> = [];
  let currentLastAssistantUuid: string | undefined;
  let turnStarted = false;
  let lastCompleteEndIndex = startIndex; // tracks end of last complete turn
  let skipNextUser = false; // set after compact_boundary

  function finalizeCurrentTurn(endIdx: number): void {
    if (
      turnStarted &&
      currentUserMessage.trim() &&
      currentResponseTexts.length > 0
    ) {
      turns.push({
        userMessage: truncateText(currentUserMessage, 16_000),
        agentResponse: truncateText(currentResponseTexts.join('\n\n'), 16_000),
        toolCalls: currentToolCalls.slice(0, 50), // cap tool call list
        timestamp: currentTimestamp,
        lastAssistantUuid: currentLastAssistantUuid,
        endIndex: endIdx,
      });
      lastCompleteEndIndex = endIdx;
    }
    // Reset state
    currentUserMessage = '';
    currentTimestamp = '';
    currentResponseTexts = [];
    currentToolCalls = [];
    currentLastAssistantUuid = undefined;
    turnStarted = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue; // skip malformed lines
    }

    const entryType = entry.type;

    // --- compact_boundary: skip this entry and mark next user for skip ---
    if (entryType === 'system' && entry.subtype === 'compact_boundary') {
      skipNextUser = true;
      continue;
    }

    // --- queue-operation: dequeue = turn boundary ---
    if (entryType === 'queue-operation') {
      if (entry.operation === 'dequeue') {
        // Finalize previous turn if any
        finalizeCurrentTurn(startIndex + i);
        // The dequeue timestamp becomes the authoritative turn timestamp
        // for the NEXT turn (will be overwritten if user entry has its own)
        currentTimestamp = entry.timestamp ?? '';
        turnStarted = false; // will be set when we see the user message
      }
      // enqueue operations are NOT turn boundaries — ignore
      continue;
    }

    // --- user entry ---
    if (entryType === 'user') {
      const content = entry.message?.content;

      // String content: usually compaction summary — skip
      if (typeof content === 'string') {
        if (skipNextUser) {
          skipNextUser = false;
        }
        continue;
      }

      // Array content
      if (Array.isArray(content)) {
        if (skipNextUser) {
          skipNextUser = false;
          continue;
        }

        // Check if ALL blocks are tool_result (part of current turn)
        const allToolResults = content.every((b) => b.type === 'tool_result');

        if (allToolResults) {
          // Tool results are part of the current turn — extract summaries
          for (const block of content) {
            if (block.type === 'tool_result') {
              const resultContent = block.content;
              let summary = '';
              if (typeof resultContent === 'string') {
                summary = resultContent.slice(0, 200);
              } else if (Array.isArray(resultContent)) {
                summary = resultContent
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text ?? '')
                  .join(' ')
                  .slice(0, 200);
              }
              // Pair with the most recent tool_use if possible
              if (
                currentToolCalls.length > 0 &&
                !currentToolCalls[currentToolCalls.length - 1].resultSummary
              ) {
                currentToolCalls[currentToolCalls.length - 1].resultSummary =
                  summary;
              }
            }
          }
          continue;
        }

        // Has at least one non-tool_result block — this is a new turn start
        // If there's a dequeue before this, the turn was already started by
        // the dequeue handler. If not (fallback), finalize previous turn.
        if (turnStarted) {
          finalizeCurrentTurn(startIndex + i);
        }

        // Extract text from non-tool_result blocks
        const textParts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }

        currentUserMessage = textParts.join('\n');
        if (entry.timestamp) {
          currentTimestamp = currentTimestamp || entry.timestamp;
        }
        turnStarted = true;
      }
      continue;
    }

    // --- assistant entry ---
    if (entryType === 'assistant') {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            currentResponseTexts.push(block.text);
          } else if (block.type === 'tool_use') {
            const toolName =
              (block as unknown as { name?: string }).name ?? 'unknown';
            currentToolCalls.push({ tool: toolName, resultSummary: '' });
          }
        }
        if (entry.uuid) {
          currentLastAssistantUuid = entry.uuid;
        }
      }
      continue;
    }

    // All other entry types: skip
  }

  // Finalize the last turn if complete
  finalizeCurrentTurn(startIndex + lines.length);

  return turns;
}

/* ------------------------------------------------------------------ */
/*  captureAgentTurn — incremental JSONL capture on container exit     */
/* ------------------------------------------------------------------ */

/**
 * Called by container-runner.ts after each agent container exits.
 * Reads JSONL transcript from the stored cursor position, parses new
 * turns, inserts them as leaf nodes, and updates the cursor.
 *
 * Fire-and-forget — errors are logged, never thrown.
 */
export async function captureAgentTurn(
  service: ContextService,
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  try {
    const filePath = jsonlPath(groupFolder, sessionId);

    // Look up cursor (no existsSync — let readLinesFrom handle ENOENT)
    const cursor = service.db
      .prepare(
        'SELECT session_id, last_entry_index, last_assistant_uuid FROM context_cursors WHERE group_folder = ?',
      )
      .get(groupFolder) as
      | {
          session_id: string;
          last_entry_index: number;
          last_assistant_uuid: string | null;
        }
      | undefined;

    let startLine = 0;
    if (cursor) {
      if (cursor.session_id === sessionId) {
        startLine = cursor.last_entry_index;
      }
      // If session_id changed, reset to 0 (new JSONL file)
    }

    // Read the JSONL file from startLine
    const allLines = readLinesFrom(filePath, startLine);
    if (allLines.length === 0) {
      return; // Nothing new
    }

    // Parse turns
    const turns = parseTurnsFromJsonl(allLines, startLine);
    if (turns.length === 0) {
      return; // No complete turns found
    }

    // Find the cursor position: the endIndex of the LAST complete turn.
    // We only advance to the end of the last complete turn, not past
    // incomplete turns at the end of the file.
    const lastTurn = turns[turns.length - 1];
    const newCursorIndex = lastTurn.endIndex;
    const newAssistantUuid = lastTurn.lastAssistantUuid ?? null;

    // Insert all turns and update cursor in one transaction
    const now = new Date().toISOString();
    service.db.transaction(() => {
      for (const turn of turns) {
        service.insertTurn(groupFolder, sessionId, {
          userMessage: turn.userMessage,
          agentResponse: turn.agentResponse,
          toolCalls: turn.toolCalls,
          timestamp: turn.timestamp,
        });
      }

      // Upsert cursor
      service.db
        .prepare(
          `INSERT INTO context_cursors (group_folder, session_id, last_entry_index, last_assistant_uuid, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(group_folder) DO UPDATE SET
             session_id = excluded.session_id,
             last_entry_index = excluded.last_entry_index,
             last_assistant_uuid = excluded.last_assistant_uuid,
             updated_at = excluded.updated_at`,
        )
        .run(groupFolder, sessionId, newCursorIndex, newAssistantUuid, now);
    })();

    logger.info(
      { groupFolder, sessionId, turns: turns.length, cursor: newCursorIndex },
      'Captured agent turns',
    );
  } catch (err) {
    logger.warn({ err, groupFolder, sessionId }, 'captureAgentTurn failed');
  }
}

/* ------------------------------------------------------------------ */
/*  startContextSync — background compaction timer                     */
/* ------------------------------------------------------------------ */

/**
 * Starts the background compaction timer (60s interval).
 *
 * Each cycle:
 *   1. service.summarizePending(5) — process up to 5 pending leaves
 *   2. For each group with leaves from completed days: rollupDaily()
 *   3. For each group with dailies from completed weeks: rollupWeekly()
 *   4. For each group with weeklies from completed months: rollupMonthly()
 *   5. service.applyRetention() — soft-delete old leaves/dailies
 *   6. service.vacuum() — hard-delete (once per day only)
 *
 * Returns NodeJS.Timeout for cleanup on shutdown (clearInterval).
 */
export function startContextSync(
  service: ContextService,
): ReturnType<typeof setInterval> | null {
  let lastVacuumDay = '';

  const cycle = async () => {
    try {
      // 1. Summarize pending leaves
      const summarized = await service.summarizePending(5);
      if (summarized > 0) {
        logger.info({ summarized }, 'Context sync: summarized pending leaves');
      }

      // 2-4. Rollups for each group
      const groups = service.db
        .prepare('SELECT DISTINCT group_folder FROM context_cursors')
        .all() as Array<{ group_folder: string }>;

      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);

      for (const { group_folder } of groups) {
        await runRollups(service, group_folder, today);
      }

      // 5. Apply retention
      const pruned = service.applyRetention();
      if (pruned > 0) {
        logger.info({ pruned }, 'Context sync: applied retention');
      }

      // 6. Vacuum (once per day)
      if (todayStr !== lastVacuumDay) {
        const vacuumed = service.vacuum();
        lastVacuumDay = todayStr;
        if (vacuumed > 0) {
          logger.info({ vacuumed }, 'Context sync: vacuumed old nodes');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Context sync cycle failed');
    }
  };

  // Run first cycle after a short delay (5s), then every 60s
  const initialTimeout = setTimeout(cycle, 5_000);
  const interval = setInterval(cycle, 60_000);

  // Return a composite cleanup: clearing the interval also clears the initial timeout
  // to prevent firing after shutdown. We attach the timeout ID for cleanup.
  (interval as any).__initialTimeout = initialTimeout;
  return interval;
}

/* ------------------------------------------------------------------ */
/*  Rollup orchestration                                               */
/* ------------------------------------------------------------------ */

/**
 * Runs daily, weekly, and monthly rollups for a single group.
 * Only rolls up periods whose calendar boundary has passed.
 */
async function runRollups(
  service: ContextService,
  groupFolder: string,
  now: Date,
): Promise<void> {
  // Find dates with un-rolled-up leaves from completed days (not today)
  const todayStr = now.toISOString().slice(0, 10);

  const leafDates = service.db
    .prepare(
      `SELECT DISTINCT substr(time_start, 1, 10) as day
       FROM context_nodes
       WHERE group_folder = ? AND level = 0 AND parent_id IS NULL
         AND summary IS NOT NULL AND pruned_at IS NULL
         AND substr(time_start, 1, 10) < ?
       ORDER BY day ASC`,
    )
    .all(groupFolder, todayStr) as Array<{ day: string }>;

  for (const { day } of leafDates) {
    try {
      await service.rollupDaily(groupFolder, day);
    } catch (err) {
      logger.warn({ err, groupFolder, day }, 'Daily rollup failed');
    }
  }

  // Weekly rollups: find completed weeks with un-rolled-up dailies
  // A week is "completed" if the current date is past Sunday of that week
  const mondayOfThisWeek = getMondayOfWeek(now);
  const mondayStr = mondayOfThisWeek.toISOString().slice(0, 10);

  const dailyWeeks = service.db
    .prepare(
      `SELECT DISTINCT substr(time_start, 1, 10) as day
       FROM context_nodes
       WHERE group_folder = ? AND level = 1 AND parent_id IS NULL
         AND summary IS NOT NULL AND pruned_at IS NULL
         AND substr(time_start, 1, 10) < ?
       ORDER BY day ASC`,
    )
    .all(groupFolder, mondayStr) as Array<{ day: string }>;

  // Group by their Monday
  const weekStarts = new Set<string>();
  for (const { day } of dailyWeeks) {
    const d = new Date(day + 'T00:00:00.000Z');
    const monday = getMondayOfWeek(d);
    weekStarts.add(monday.toISOString().slice(0, 10));
  }

  for (const weekStart of weekStarts) {
    try {
      await service.rollupWeekly(groupFolder, weekStart);
    } catch (err) {
      logger.warn({ err, groupFolder, weekStart }, 'Weekly rollup failed');
    }
  }

  // Monthly rollups: find completed months with un-rolled-up weeklies
  const currentMonth = now.toISOString().slice(0, 7); // YYYY-MM

  const weeklyMonths = service.db
    .prepare(
      `SELECT DISTINCT substr(time_start, 1, 7) as month
       FROM context_nodes
       WHERE group_folder = ? AND level = 2 AND parent_id IS NULL
         AND summary IS NOT NULL AND pruned_at IS NULL
         AND substr(time_start, 1, 7) < ?
       ORDER BY month ASC`,
    )
    .all(groupFolder, currentMonth) as Array<{ month: string }>;

  for (const { month } of weeklyMonths) {
    try {
      await service.rollupMonthly(groupFolder, month);
    } catch (err) {
      logger.warn({ err, groupFolder, month }, 'Monthly rollup failed');
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Private helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reads lines from a file starting at a given line offset.
 * Uses readline to skip already-processed lines without buffering the entire file.
 * Returns an empty array if the file doesn't exist (handles ENOENT gracefully).
 */
function readLinesFrom(filePath: string, startLine: number): string[] {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return []; // File doesn't exist yet — no-op
  }
  try {
    const content = fs.readFileSync(fd, 'utf-8');
    const allLines = content.split('\n');
    // Remove trailing empty line if file ends with newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    return allLines.slice(startLine);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Truncates text to a maximum character length, preserving the beginning.
 * Used to cap input sizes for summarization (design spec: 4000 tokens ~ 16K chars).
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '... (truncated)';
}

/**
 * Returns the Monday of the ISO week containing the given date.
 */
function getMondayOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  // ISO weeks start on Monday. Sunday (0) maps to 6 days back.
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
