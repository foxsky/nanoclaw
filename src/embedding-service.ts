import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS embeddings (
  collection TEXT NOT NULL,
  item_id TEXT NOT NULL,
  vector BLOB,
  source_text TEXT NOT NULL,
  model TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, item_id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_collection ON embeddings(collection);
CREATE INDEX IF NOT EXISTS idx_embeddings_pending ON embeddings(collection) WHERE vector IS NULL;
`;

export class EmbeddingService {
  readonly db: Database.Database;
  private readonly ollamaHost: string;
  private readonly fallbackOllamaHost: string | null;
  private readonly model: string;
  private indexerTimer: ReturnType<typeof setInterval> | null = null;

  private indexerRunning = false; // re-entrancy guard for overlapping cycles

  // Prepared statements (cached for performance — avoids re-parsing on every call)
  private readonly stmtSelectExisting: Database.Statement;
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtDelete: Database.Statement;

  constructor(
    dbPath: string,
    ollamaHost: string,
    model: string,
    fallbackOllamaHost?: string,
  ) {
    this.ollamaHost = ollamaHost;
    this.fallbackOllamaHost =
      fallbackOllamaHost && fallbackOllamaHost !== ollamaHost
        ? fallbackOllamaHost
        : null;
    this.model = model;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);

    this.stmtSelectExisting = this.db.prepare(
      'SELECT source_text, model FROM embeddings WHERE collection = ? AND item_id = ?',
    );
    this.stmtUpsert = this.db.prepare(
      `INSERT INTO embeddings (collection, item_id, vector, source_text, model, metadata, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT (collection, item_id) DO UPDATE SET
         vector = NULL, source_text = excluded.source_text, model = excluded.model,
         metadata = excluded.metadata, updated_at = excluded.updated_at`,
    );
    this.stmtDelete = this.db.prepare(
      'DELETE FROM embeddings WHERE collection = ? AND item_id = ?',
    );
  }

  /* ---------------------------------------------------------------- */
  /*  index / remove / query helpers                                   */
  /* ---------------------------------------------------------------- */

  index(
    collection: string,
    itemId: string,
    text: string,
    metadata?: Record<string, any>,
  ): void {
    const existing = this.stmtSelectExisting.get(collection, itemId) as
      | { source_text: string; model: string }
      | undefined;

    if (
      existing &&
      existing.source_text === text &&
      existing.model === this.model
    ) {
      return; // unchanged — preserve existing vector
    }

    this.stmtUpsert.run(
      collection,
      itemId,
      text,
      this.model,
      JSON.stringify(metadata ?? {}),
      new Date().toISOString(),
    );
  }

  remove(collection: string, itemId: string): void {
    this.stmtDelete.run(collection, itemId);
  }

  removeCollection(collection: string): void {
    this.db
      .prepare('DELETE FROM embeddings WHERE collection = ?')
      .run(collection);
  }

  getCollections(prefix?: string): string[] {
    if (prefix) {
      const escaped = prefix
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      return (
        this.db
          .prepare(
            "SELECT DISTINCT collection FROM embeddings WHERE collection LIKE ? ESCAPE '\\' ORDER BY collection",
          )
          .all(escaped + '%') as Array<{ collection: string }>
      ).map((r) => r.collection);
    }
    return (
      this.db
        .prepare(
          'SELECT DISTINCT collection FROM embeddings ORDER BY collection',
        )
        .all() as Array<{ collection: string }>
    ).map((r) => r.collection);
  }

  getItemIds(collection: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT item_id FROM embeddings WHERE collection = ? ORDER BY item_id',
        )
        .all(collection) as Array<{ item_id: string }>
    ).map((r) => r.item_id);
  }

  /* ---------------------------------------------------------------- */
  /*  Background indexer                                               */
  /* ---------------------------------------------------------------- */

  async runIndexerCycle(): Promise<void> {
    if (this.indexerRunning) return; // prevent overlap when cycle exceeds interval
    this.indexerRunning = true;
    try {
      // Step 1: Model change detection — only update if mismatched rows exist
      const mismatch = this.db
        .prepare(
          'SELECT COUNT(*) as cnt FROM embeddings WHERE model != ? AND vector IS NOT NULL',
        )
        .get(this.model) as { cnt: number };
      if (mismatch.cnt > 0) {
        this.db
          .prepare('UPDATE embeddings SET vector = NULL WHERE model != ?')
          .run(this.model);
        logger.info(
          { count: mismatch.cnt, model: this.model },
          'Embedding indexer: model change detected, re-embedding',
        );
      }

      // Step 2: Query pending items (deterministic order, no starvation)
      const pending = this.db
        .prepare(
          `SELECT collection, item_id, source_text FROM embeddings
           WHERE vector IS NULL ORDER BY updated_at ASC LIMIT 20`,
        )
        .all() as Array<{
        collection: string;
        item_id: string;
        source_text: string;
      }>;

      if (pending.length === 0) return;

      // Step 3: Batch-call Ollama (with fallback host)
      const texts = pending.map((p) => p.source_text);
      const embedBody = JSON.stringify({
        model: this.model,
        input: texts,
        keep_alive: -1,
      });

      let response = await this.fetchEmbed(this.ollamaHost, embedBody);
      if (!response?.ok && this.fallbackOllamaHost) {
        logger.info(
          { fallback: this.fallbackOllamaHost },
          'Embedding indexer: primary failed, trying fallback',
        );
        response = await this.fetchEmbed(this.fallbackOllamaHost, embedBody);
      }

      if (!response?.ok) {
        logger.warn(
          { status: response?.status },
          'Embedding indexer: Ollama request failed',
        );
        return;
      }

      const data = (await response.json()) as { embeddings: number[][] };
      if (!data.embeddings || data.embeddings.length !== pending.length) {
        logger.warn(
          'Embedding indexer: unexpected embedding count from Ollama',
        );
        return;
      }

      // Step 4: Update vectors in a single transaction
      const now = new Date().toISOString();
      // Guard: only update if source_text hasn't changed since we read the pending row.
      // If index() updated the row during the Ollama fetch, source_text won't match
      // and the UPDATE affects 0 rows — leaving vector=NULL for the next cycle.
      const update = this.db.prepare(
        'UPDATE embeddings SET vector = ?, model = ?, updated_at = ? WHERE collection = ? AND item_id = ? AND source_text = ?',
      );
      this.db.transaction(() => {
        for (let i = 0; i < pending.length; i++) {
          const vector = Buffer.from(
            new Float32Array(data.embeddings[i]).buffer,
          );
          update.run(
            vector,
            this.model,
            now,
            pending[i].collection,
            pending[i].item_id,
            pending[i].source_text,
          );
        }
      })();

      logger.info(
        { count: pending.length },
        'Embedding indexer: batch processed',
      );
    } catch (err) {
      logger.warn({ err }, 'Embedding indexer cycle failed');
    } finally {
      this.indexerRunning = false;
    }
  }

  startIndexer(intervalMs = 10_000): void {
    if (this.indexerTimer) return;
    this.indexerTimer = setInterval(() => {
      this.runIndexerCycle().catch((err) =>
        logger.warn({ err }, 'Embedding indexer unhandled error'),
      );
    }, intervalMs);
    // Run first cycle immediately
    this.runIndexerCycle().catch(() => {});
  }

  stopIndexer(): void {
    if (this.indexerTimer) {
      clearInterval(this.indexerTimer);
      this.indexerTimer = null;
    }
  }

  close(): void {
    this.stopIndexer();
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  private async fetchEmbed(
    host: string,
    body: string,
  ): Promise<Response | null> {
    try {
      return await fetch(`${host}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.warn({ err, host }, 'Embedding fetch failed');
      return null;
    }
  }
}
