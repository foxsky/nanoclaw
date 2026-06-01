/**
 * Memory embedding client — turns memory text into a vector via a local Ollama host, for the
 * hybrid (FTS5 + vector) recall path. Direct call (no OneCLI gateway / no credential), gated
 * on an explicitly-configured embedding model: with no model set, embeddings are OFF and the
 * memory layer stays pure-FTS5. Best-effort — any failure returns null and the caller stores /
 * searches without a vector, so embeddings never break note-taking or recall.
 */
import { ensureHostBypassesProxy } from './ollama-util.js';

export interface EmbedDeps {
  fetchImpl?: typeof fetch;
  url?: string;
  model?: string;
}

const DEFAULT_EMBED_URL = 'http://localhost:11434';
// Embeddings are fast (bge-m3 ≈ tens of ms); bound generously so a hung host can't stall a write.
const EMBED_TIMEOUT_MS = 15000;

function log(msg: string): void {
  console.error(`[memory-embed] ${msg}`);
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
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
