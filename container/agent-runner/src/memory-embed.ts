/**
 * Memory embedding client — turns memory text into a vector via a local Ollama host, for the
 * hybrid (FTS5 + vector) recall path. Direct call (no OneCLI gateway / no credential), gated
 * on an explicitly-configured embedding model: with no model set, embeddings are OFF and the
 * memory layer stays pure-FTS5. Best-effort — any failure returns null and the caller stores /
 * searches without a vector, so embeddings never break note-taking or recall.
 */
import type { Database } from 'bun:sqlite';

import { insertMemory, type MemoryInput } from './memory-store.js';
import { ensureHostBypassesProxy } from './ollama-util.js';

export interface EmbedDeps {
  fetchImpl?: typeof fetch;
  url?: string;
  model?: string;
  /** Per-call abort timeout (ms). Overrides the env/default. Interactive callers
   *  (memory_search) pass a shorter value so a slow/down Ollama can't stall the
   *  reply; background capture keeps the longer default. */
  timeoutMs?: number;
}

const DEFAULT_EMBED_URL = 'http://localhost:11434';
// Embeddings are fast (bge-m3 ≈ tens of ms); bound generously so a hung host can't stall a write.
const EMBED_TIMEOUT_MS = 15000;

function log(msg: string): void {
  console.error(`[memory-embed] ${msg}`);
}

/** Per-embed timeout (ms), env-overridable. The PreCompact hook budget derives from this. */
export function embedTimeoutMs(): number {
  const n = Number(process.env.NANOCLAW_MEMORY_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : EMBED_TIMEOUT_MS;
}

/** The effective embed timeout for a call: an explicit per-call `timeoutMs` (if a
 *  positive number) wins, else the env-overridable default. Extracted so the
 *  resolution order is unit-tested without poking AbortSignal internals. */
export function resolveEmbedTimeout(deps: EmbedDeps = {}): number {
  return typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? deps.timeoutMs
    : embedTimeoutMs();
}

/** The configured embedding model, or null when hybrid embeddings are disabled. */
export function embedModel(deps: EmbedDeps = {}): string | null {
  return deps.model ?? process.env.NANOCLAW_MEMORY_EMBED_MODEL ?? null;
}

/**
 * Embed text via Ollama POST /api/embed ({model, input} → {embeddings: number[][]}). Returns a
 * Float32Array, or null when no model is configured / text is empty / the call fails.
 */
export async function embedText(text: string, deps: EmbedDeps = {}): Promise<Float32Array | null> {
  const model = embedModel(deps);
  if (!model || !text.trim()) return null;
  const url = (deps.url ?? process.env.NANOCLAW_MEMORY_EMBED_URL ?? DEFAULT_EMBED_URL).replace(/\/+$/, '');
  ensureHostBypassesProxy(url);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(resolveEmbedTimeout(deps)),
    });
    if (!res.ok) {
      log(`embed failed (${res.status})`);
      return null;
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    const vec = data.embeddings?.[0];
    return vec && vec.length ? Float32Array.from(vec) : null;
  } catch (e) {
    log(`embed error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Embed-on-write: compute m.text's embedding (best-effort) and store it with the memory. A null
 * embedding (model disabled / call failed) stores the memory FTS5-only — embeddings never block
 * a write. A pre-supplied m.vector is respected (used by tests / future backfill).
 */
export async function embedAndInsert(db: Database, m: MemoryInput, deps: EmbedDeps = {}): Promise<string> {
  // Respect an explicitly-supplied vector (including null = "store unembedded"); only embed
  // when the caller left it undefined.
  const vector = m.vector !== undefined ? m.vector : await embedText(m.text, deps);
  return insertMemory(db, { ...m, vector });
}
