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
  it('send_message includes turn correlation fields from the shared interaction context', () => {
    const body = extractToolHandlerBlock('send_message');
    expect(body, 'send_message handler not found in ipc-mcp-stdio.ts').not.toBeNull();
    expect(body).toContain('...buildTurnContextFields()');
  });

  it('schedule_task includes turn correlation fields from the shared interaction context', () => {
    const body = extractToolHandlerBlock('schedule_task');
    expect(body, 'schedule_task handler not found in ipc-mcp-stdio.ts').not.toBeNull();
    expect(body).toContain('...buildTurnContextFields()');
  });

  it('child-board provisioning IPC carries the turn correlation fields', () => {
    const provisioningCalls = source.match(
      /type:\s*'provision_child_board'[\s\S]{0,400}?\.\.\.buildTurnContextFields\(\)/g,
    ) || [];
    expect(provisioningCalls.length).toBeGreaterThanOrEqual(2);
  });

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

  it('memory audit DB lives under the persistent /workspace/group mount, not the ephemeral /workspace/memory path', () => {
    // Container runs with --rm; only paths under host-mounted dirs survive
    // across turns. /workspace/group is per-group host mount; /workspace/memory
    // is NOT mounted and would silently break ownership tracking.
    expect(source).toContain("'/workspace/group/memory/memory.db'");
    expect(source).not.toContain("'/workspace/memory/memory.db'");
  });

  it('memory_store enforces TaskFlow scope, per-turn quota, and audit-log on write', () => {
    const body = extractToolHandlerBlock('memory_store');
    expect(body, 'memory_store handler not found').not.toBeNull();
    expect(body).toContain('memoryEnabled');
    expect(body).toContain('storeMemory(args.text');
    expect(body).toContain('audit.countWritesInTurn(turnId)');
    expect(body).toContain('MAX_MEMORY_WRITES_PER_TURN');
    expect(body).toContain('audit.recordStore(');
    // Soft fail must surface as isError so the model knows the fact was NOT saved.
    expect(body).toContain('isError: true');
    expect(body).toContain('fact NOT saved');
  });

  it('memory_recall delegates to memory-client and reports relevance hint', () => {
    const body = extractToolHandlerBlock('memory_recall');
    expect(body, 'memory_recall handler not found').not.toBeNull();
    expect(body).toContain('memoryEnabled');
    expect(body).toContain('searchMemory(');
    expect(body).toContain('lower dist = closer match');
    // Network failure path must be isError so the agent knows recall returned nothing.
    expect(body).toContain('isError: true');
  });

  it('memory_list reads from the local audit DB (not the shared server)', () => {
    const body = extractToolHandlerBlock('memory_list');
    expect(body, 'memory_list handler not found').not.toBeNull();
    expect(body).toContain('memoryEnabled');
    expect(body).toContain('audit.listOwnedForBoard(taskflowBoardId!');
  });

  it('memory_forget gates the DELETE on local sidecar ownership (no TOCTOU)', () => {
    const body = extractToolHandlerBlock('memory_forget');
    expect(body, 'memory_forget handler not found').not.toBeNull();
    expect(body).toContain('memoryEnabled');
    expect(body).toContain('audit.isOwned(args.memory_id, taskflowBoardId!)');
    expect(body).toContain('deleteMemoryById(');
    expect(body).toContain('audit.removeOwned(args.memory_id)');
    // No GET-then-DELETE pattern (the source of the prior TOCTOU).
    expect(body).not.toContain("method: 'GET'");
    expect(body).toContain('not owned by this board');
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
