import Database from 'better-sqlite3';
import fs from 'fs';

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
