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

/**
 * Selects items into a token budget. Greedy: first-come, accumulating
 * until the next item would overflow (but always emits at least one
 * item even if it overshoots — same semantics as the conversation-recap
 * preamble at index.ts:752).
 */
export function selectWithinTokenBudget<T>(
  items: readonly T[],
  getText: (item: T) => string,
  budgetTokens: number,
): T[] {
  const selected: T[] = [];
  let remaining = budgetTokens;
  for (const item of items) {
    const cost = estimateTokens(getText(item));
    if (remaining - cost < 0 && selected.length > 0) break;
    selected.push(item);
    remaining -= cost;
  }
  return selected;
}
