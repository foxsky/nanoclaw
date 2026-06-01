/**
 * Shared helpers for talking to a local/LAN Ollama host directly.
 *
 * Ollama calls (chat extraction, embeddings) must NOT go through the OneCLI credential
 * gateway — they need no credential and the gateway may block unknown hosts. Bun's fetch
 * honors HTTP(S)_PROXY from the env (the gateway sets these in the container), so the
 * per-host NO_PROXY opt-out below is what keeps these calls genuinely direct.
 */

/** Add a URL's host to NO_PROXY/no_proxy (idempotent) so Bun's fetch bypasses the env proxy. */
export function ensureHostBypassesProxy(targetUrl: string): void {
  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return;
  }
  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    const entries = (process.env[key] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!entries.includes(host)) {
      entries.push(host);
      process.env[key] = entries.join(',');
    }
  }
}
