import path from 'path';

import { getTaskflowDb } from './dm-routing.js';
import { EmbeddingService } from './embedding-service.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { startTaskflowEmbeddingSync } from './taskflow-embedding-sync.js';

export interface EmbeddingFeeder {
  service: EmbeddingService;
  /** Halt the 15s taskflow sync + the background indexer and close the DB. */
  stop(): void;
}

type FeederEnv = {
  OLLAMA_HOST?: string;
  EMBEDDING_MODEL?: string;
  CONTEXT_FALLBACK_OLLAMA_HOST?: string;
};

/**
 * Host-side TaskFlow embedding feeder (add-embeddings + add-taskflow, #385).
 *
 * Builds/maintains `<dataDir>/embeddings/embeddings.db` via the EmbeddingService
 * background indexer (Ollama bge-m3) and a 15s `taskflow.db` sync, so the
 * in-container `api_query 'search'` can rank semantically instead of falling
 * back to lexical. Gated on `OLLAMA_HOST` — unset returns null (feature off,
 * zero behaviour change). `env` is injectable for tests; production reads `.env`.
 */
export function startEmbeddingFeeder(
  dataDir: string,
  env: FeederEnv = readEnvFile(['OLLAMA_HOST', 'EMBEDDING_MODEL', 'CONTEXT_FALLBACK_OLLAMA_HOST']),
): EmbeddingFeeder | null {
  if (!env.OLLAMA_HOST) return null;

  const model = env.EMBEDDING_MODEL || 'bge-m3';
  const service = new EmbeddingService(
    path.join(dataDir, 'embeddings', 'embeddings.db'),
    env.OLLAMA_HOST,
    model,
    env.CONTEXT_FALLBACK_OLLAMA_HOST,
  );
  service.startIndexer();

  const syncTimer = startTaskflowEmbeddingSync(service, getTaskflowDb(dataDir));
  log.info('Embedding feeder started', { ollamaHost: env.OLLAMA_HOST, model });

  return {
    service,
    stop() {
      if (syncTimer) clearInterval(syncTimer);
      service.close(); // also stops the indexer
    },
  };
}
