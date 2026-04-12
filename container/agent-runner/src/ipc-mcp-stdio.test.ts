import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Regression tests for `src/ipc-mcp-stdio.ts`.
 *
 * The module has top-level awaits and eager `server.connect(transport)`
 * plus required env vars (e.g. NANOCLAW_CHAT_JID), so it can't be imported
 * as a plain library. Instead, we parse the source and assert shape-level
 * invariants about the MCP tool handlers registered inside it.
 */

const SOURCE_PATH = path.join(__dirname, 'ipc-mcp-stdio.ts');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

/**
 * Extracts the body of a `server.tool('<name>', ..., async (...) => { ... })`
 * handler block by matching balanced braces starting at the first `async (`.
 * Returns null if not found.
 */
function extractToolHandlerBlock(toolName: string): string | null {
  // Find the `server.tool('<toolName>',` registration site.
  const registerIdx = source.indexOf(`server.tool(\n    '${toolName}'`)
    || source.indexOf(`server.tool(\n      '${toolName}'`);
  // Fall back to a broader search (indentation-agnostic) if the exact
  // indentation lookups above both returned 0 (which is falsy-misleading).
  const anchor = `'${toolName}'`;
  const serverToolIdx = source.indexOf(`server.tool(`);
  let scanIdx = serverToolIdx;
  let match = -1;
  while (scanIdx !== -1) {
    const anchorIdx = source.indexOf(anchor, scanIdx);
    const nextServer = source.indexOf('server.tool(', scanIdx + 1);
    if (anchorIdx === -1) break;
    if (nextServer !== -1 && anchorIdx > nextServer) {
      scanIdx = nextServer;
      continue;
    }
    // Make sure the anchor is the name argument to THIS server.tool call.
    const between = source.slice(scanIdx, anchorIdx);
    if (/^server\.tool\(\s*$/m.test(between) || /server\.tool\(\s*$/.test(between)) {
      match = anchorIdx;
      break;
    }
    scanIdx = source.indexOf('server.tool(', scanIdx + 1);
  }
  if (match === -1) return null;

  // From the anchor, find the first `async (` after it (start of handler).
  const asyncIdx = source.indexOf('async (', match);
  if (asyncIdx === -1) return null;
  // Find the opening brace of the handler body.
  const braceIdx = source.indexOf('{', asyncIdx);
  if (braceIdx === -1) return null;

  // Walk forward tracking brace depth (ignoring strings/template literals) to
  // find the matching close-brace.
  let depth = 0;
  let i = braceIdx;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === '*' && ch === '/') inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (ch === '\\') { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') inBacktick = false;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && source[i + 1] === '*') { inBlockComment = true; i++; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '`') { inBacktick = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(braceIdx, i + 1);
    }
  }
  return null;
}

describe('ipc-mcp-stdio tool handler shapes', () => {
  it('list_tasks catch block returns isError: true on failure', () => {
    const body = extractToolHandlerBlock('list_tasks');
    expect(body, 'list_tasks handler not found in ipc-mcp-stdio.ts').not.toBeNull();

    // Find the catch block inside list_tasks.
    const catchIdx = body!.indexOf('} catch');
    expect(catchIdx, 'list_tasks should have a catch block around fs read').toBeGreaterThan(-1);
    const catchBlock = body!.slice(catchIdx);

    // The failure response must set isError: true so that MCP clients /
    // the model know the response represents an error rather than data.
    expect(
      /isError:\s*true/.test(catchBlock),
      'list_tasks catch block must return { isError: true } — otherwise errors masquerade as successful "No scheduled tasks found." style responses.',
    ).toBe(true);
  });

  it('every tool handler that returns an error message uses isError: true', () => {
    // Guardrail: any `content: [{ type: 'text' ... Error` style response
    // inside a tool handler should also carry `isError: true`. This catches
    // future regressions where someone forgets the flag.
    const errorReturnPattern =
      /return\s*\{\s*content:\s*\[\s*\{\s*type:\s*'text'(?:\s+as\s+const)?,\s*text:\s*`?Error[^`']*`?[^}]*\}\s*\][^}]*\}/g;
    const matches = source.match(errorReturnPattern) || [];
    for (const m of matches) {
      expect(
        /isError:\s*true/.test(m),
        `Error-style return missing isError: true:\n${m}`,
      ).toBe(true);
    }
  });
});
