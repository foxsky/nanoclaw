/**
 * Live runtime-acceptance probe for P2 memory auto-capture (#384).
 *
 * Verifies the make-or-break assumption: a raw Bun fetch to the Anthropic Messages API,
 * routed through the OneCLI gateway, gets the credential injected (via the placeholder
 * header it rewrites) AND the MITM CA is trusted — so PreCompact auto-capture actually
 * stores facts instead of silently logging a 401/TLS error.
 *
 * Run it INSIDE the gateway-wired runtime (so HTTPS_PROXY + the CA env are set):
 *
 *   onecli auth login                                    # once, interactive, current key
 *   onecli run --agent <agent-group-id> -- bun scripts/probe-memory-capture.ts
 *
 * (--agent must be an agent whose OneCLI vault has the Anthropic secret assigned, i.e. a
 * real TaskFlow board agent. For highest fidelity to production Bun 1.3.12, run the same
 * command inside the nanoclaw-agent image instead of host bun.)
 *
 * Exit 0 = facts returned (success). Exit 1 = none; the [probe]/[memory-capture] stderr
 * lines show why (raw HTTP status: 401 = credential not injected, TLS error = CA not
 * trusted, 404/400 = model id / request shape, timeout = proxy not reachable).
 */
import { type CaptureMessage, extractMemories } from '../container/agent-runner/src/memory-capture.ts';

const messages: CaptureMessage[] = [
  { role: 'user', content: 'Decision: the production deploy window is every Tuesday 09:00 America/Fortaleza. Please remember that.' },
  { role: 'assistant', content: 'Understood — deploys go out Tuesdays at 9am Fortaleza time. Anything else to lock in?' },
  { role: 'user', content: 'Yes: Ana owns the API board and Bruno owns the mobile board. Standup is daily at 10am.' },
  { role: 'assistant', content: 'Noted: Ana → API board, Bruno → mobile board, daily standup 10am.' },
  { role: 'user', content: 'Also we decided to freeze releases the last week of each quarter.' },
  { role: 'assistant', content: 'Got it — release freeze in the final week of every quarter.' },
  { role: 'user', content: 'Great, that covers the recurring policies for now.' },
  { role: 'assistant', content: 'Summary captured. Ready for the next topic whenever you are.' },
];

console.error(
  `[probe] HTTPS_PROXY=${process.env.HTTPS_PROXY ? 'set' : 'UNSET'} ` +
    `NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS ? 'set' : 'UNSET'} ` +
    `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL || '(default api.anthropic.com)'}`,
);

// 1) Raw diagnostic fetch — mirrors extractMemories' request shape but surfaces the exact
//    HTTP status / TLS error (extractMemories itself swallows these to []).
const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
if (process.env.ANTHROPIC_BASE_URL) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN || 'placeholder'}`;
else headers['x-api-key'] = process.env.ANTHROPIC_API_KEY || 'placeholder';
const init: RequestInit & { proxy?: string } = {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model: process.env.NANOCLAW_MEMORY_EXTRACT_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  }),
  signal: AbortSignal.timeout(20000),
};
if (process.env.HTTPS_PROXY) init.proxy = process.env.HTTPS_PROXY;
try {
  const res = await fetch(`${baseUrl}/v1/messages`, init);
  console.error(`[probe] raw fetch status=${res.status} body=${(await res.text()).slice(0, 300)}`);
} catch (e) {
  console.error(`[probe] raw fetch THREW: ${e instanceof Error ? e.message : String(e)}`);
}

// 2) The real extraction path (what PreCompact runs).
const facts = await extractMemories(messages);
console.log(JSON.stringify({ ok: facts.length > 0, count: facts.length, facts }, null, 2));
process.exit(facts.length > 0 ? 0 : 1);
