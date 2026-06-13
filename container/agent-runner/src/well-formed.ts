/**
 * Replace unpaired UTF-16 surrogates with U+FFFD so any string serialized into
 * an Anthropic API request body stays valid UTF-8/JSON.
 *
 * A lone surrogate — a chat message whose emoji was truncated mid-pair upstream,
 * or already-corrupt platform text (WhatsApp pushName, caption, transcript) —
 * makes the API reject the ENTIRE request with
 * `400 invalid_request_error: ... no low surrogate in string`, which would
 * otherwise wedge the whole session. Sanitizing at the request boundary catches
 * the bad char regardless of which upstream path introduced it.
 *
 * Uses the native String.prototype.toWellFormed (ES2024, present in Bun) with a
 * regex fallback for older runtimes.
 */
export function toWellFormedText(s: string): string {
  const tw = (s as unknown as { toWellFormed?: () => string }).toWellFormed;
  if (typeof tw === 'function') return tw.call(s);
  // Fallback: a high surrogate not followed by a low surrogate, or a low
  // surrogate not preceded by a high surrogate, becomes U+FFFD.
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/**
 * Sanitize every `type:'text'` content item of an MCP tool result so a lone
 * surrogate in DB/API-derived tool output (frequently JSON.stringify'd) can't
 * poison the next request's `tool_result` block. Non-text items and other
 * fields pass through unchanged.
 *
 * Scope: NanoClaw's own tools are text-only, so only `content[].text` is
 * handled. If a tool later returns `resource.text` or `structuredContent`,
 * extend this to walk those too. Results from EXTERNAL/config-wired MCP servers
 * never reach this wrapper — the Claude SDK talks to them directly — so a
 * non-NanoClaw server returning a lone surrogate remains a documented residual
 * (no in-repo chokepoint; the SDK owns that transport).
 */
export function wellFormedToolResult<T>(result: T): T {
  const r = result as unknown as { content?: unknown };
  if (!r || !Array.isArray(r.content)) return result;
  return {
    ...(result as object),
    content: r.content.map((c) => {
      const item = c as { type?: unknown; text?: unknown };
      return item && item.type === 'text' && typeof item.text === 'string'
        ? { ...item, text: toWellFormedText(item.text) }
        : c;
    }),
  } as unknown as T;
}
