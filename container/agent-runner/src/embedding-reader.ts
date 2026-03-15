import Database from 'better-sqlite3';
import fs from 'fs';

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom ? dot / denom : 0; // falsy catches both 0 and NaN
}

export class EmbeddingReader {
  private db: Database.Database | null = null;

  constructor(dbPath: string) {
    try {
      if (!fs.existsSync(dbPath)) {
        return; // DB not created yet — graceful no-op
      }
      this.db = new Database(dbPath, { readonly: true });
      this.db.pragma('busy_timeout = 5000');
    } catch {
      this.db = null; // corrupted or locked — graceful fallback
    }
  }

  /**
   * Search a collection for items similar to queryVector.
   * Returns ranked results above the threshold.
   */
  search(
    collection: string,
    queryVector: Float32Array,
    opts: { limit?: number; threshold?: number } = {},
  ): Array<{ itemId: string; score: number; metadata: Record<string, any> }> {
    if (!this.db) return [];
    const { limit = 20, threshold = 0.3 } = opts;

    const rows = this.db
      .prepare(
        'SELECT item_id, vector, metadata FROM embeddings WHERE collection = ? AND vector IS NOT NULL',
      )
      .all(collection) as Array<{
      item_id: string;
      vector: Buffer;
      metadata: string;
    }>;

    const results: Array<{
      itemId: string;
      score: number;
      metadata: Record<string, any>;
    }> = [];
    for (const row of rows) {
      const stored = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4,
      );
      const score = cosineSimilarity(queryVector, stored);
      if (score >= threshold) {
        let metadata: Record<string, any> = {};
        try {
          metadata = JSON.parse(row.metadata);
        } catch {}
        results.push({ itemId: row.item_id, score, metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Find the single most similar item above threshold (for duplicate detection).
   */
  findSimilar(
    collection: string,
    queryVector: Float32Array,
    threshold = 0.85,
  ): { itemId: string; score: number; metadata: Record<string, any> } | null {
    const results = this.search(collection, queryVector, {
      limit: 1,
      threshold,
    });
    return results.length > 0 ? results[0] : null;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }
}
