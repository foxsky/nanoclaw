import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * Estimate token count from text length.
 * Calibrated at 3.5 chars/token for mixed Portuguese/English content.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Opens a SQLite database in read-only mode with graceful fallback.
 * Returns null if the file doesn't exist or the DB can't be opened.
 * Used by ContextReader and EmbeddingReader inside containers.
 */
export function openReadonlyDb(dbPath: string): Database.Database | null {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

/**
 * Closes a SQLite database idempotently.
 */
export function closeDb(db: Database.Database | null): void {
  try {
    db?.close();
  } catch {
    // already closed
  }
}

/**
 * Opens a SQLite database in writable mode with WAL journaling and a 5s
 * busy-timeout. Creates parent directories if missing. Throws on real
 * I/O failure (caller's responsibility to handle). Use for long-lived
 * sidecars where SQLITE_BUSY should wait, not error.
 */
export function openWritableDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export interface SelectWithinTokenBudgetOptions<T> {
  /**
   * Soft mode (default): always emits at least one item, even if it
   * overshoots the budget. Matches the historic conversation-recap
   * behavior so the preamble is never empty when items exist.
   *
   * Strict mode: filters items whose individual cost exceeds the
   * budget. Use when the items are user-controlled (e.g. memory facts)
   * and you do not want a single oversized item to dominate the prompt.
   * Pair with `truncateText` to keep facts but cap their length.
   */
  strict?: boolean;
  /**
   * If provided, items whose cost exceeds the per-item budget are
   * truncated to this many characters before re-evaluation. Combined
   * with `strict: true`, this gives a hard cap per item without
   * dropping facts entirely.
   */
  truncateChars?: number;
}

/**
 * Selects items into a token budget. Greedy: first-come, accumulating
 * until the next item would overflow.
 *
 * Returns selected items in their input order. With `strict: true`,
 * items whose individual cost would exceed the entire budget are
 * truncated (if `truncateChars` is set) or dropped.
 */
export function selectWithinTokenBudget<T>(
  items: readonly T[],
  getText: (item: T) => string,
  budgetTokens: number,
  options: SelectWithinTokenBudgetOptions<T> = {},
): T[] {
  const { strict = false, truncateChars } = options;
  const selected: T[] = [];
  let remaining = budgetTokens;
  for (const item of items) {
    let text = getText(item);
    let cost = estimateTokens(text);
    if (cost > budgetTokens) {
      if (truncateChars !== undefined) {
        text = text.slice(0, truncateChars);
        cost = estimateTokens(text);
      } else if (strict) {
        continue;
      }
    }
    if (remaining - cost < 0) {
      if (strict || selected.length > 0) break;
    }
    selected.push(item);
    remaining -= cost;
  }
  return selected;
}
