import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { startEmbeddingFeeder } from './embedding-feeder.js';

const DIR = path.join(import.meta.dirname, '..', 'test-embed-feeder');
const EMB_DB = path.join(DIR, 'embeddings', 'embeddings.db');

afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe('startEmbeddingFeeder', () => {
  it('returns null (feature off) and creates nothing when OLLAMA_HOST is unset', () => {
    const feeder = startEmbeddingFeeder(DIR, {});
    expect(feeder).toBeNull();
    expect(fs.existsSync(EMB_DB)).toBe(false);
  });

  it('starts a feeder + creates embeddings.db when OLLAMA_HOST is set; stop() is safe + idempotent', () => {
    const feeder = startEmbeddingFeeder(DIR, {
      OLLAMA_HOST: 'http://localhost:11434',
      EMBEDDING_MODEL: 'bge-m3',
    });
    expect(feeder).not.toBeNull();
    expect(fs.existsSync(EMB_DB)).toBe(true);
    // No taskflow.db in the test dataDir → the sync is disabled (timer null);
    // stop() must still be safe, and safe to call twice.
    expect(() => feeder!.stop()).not.toThrow();
    expect(() => feeder!.stop()).not.toThrow();
  });
});
