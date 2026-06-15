/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { denyIfExternalActorBlocked } from './chat-actor-guard.js';
import type { McpToolDefinition } from './types.js';
import { wellFormedError, wellFormedToolResult } from '../well-formed.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

/** Test-only: fetch the REGISTERED (post-wrap) tool definition by name. Used by
 *  chat-actor-guard.test.ts to assert every board-mutating tool's registered
 *  handler is gated by requiresChatActor (#419). */
export function getRegisteredToolForTesting(name: string): McpToolDefinition | undefined {
  return toolMap.get(name);
}

/**
 * Per-tool argument guard for the restricted (FastAPI) surface: keyed by
 * tool name, returns a rejection reason string to deny the call, or null
 * to allow it. Used to gate sub-modes of an otherwise-allowlisted tool
 * (e.g. `api_query`'s org-wide cross-board read modes) that the
 * tool-name-granular `allow` set can't express.
 */
export type ToolArgGuard = (args: Record<string, unknown>) => string | null;

/**
 * `allow` restricts the exposed surface to the named tools, gating BOTH
 * `tools/list` AND the `tools/call` path (a registered-but-disallowed
 * tool must be unlisted *and* uncallable — `tools/call` resolves from
 * `toolMap`, not the listed set). Omit `allow` for the full in-container
 * barrel; the standalone taskflow entrypoint passes its FastAPI-facing
 * allowlist so the subprocess can't reach `api_admin`/hierarchy/etc.
 *
 * `argGuards` (only consulted when `allow` is set, i.e. the FastAPI
 * surface) reject specific argument shapes of an allowlisted tool. The
 * in-container barrel passes neither, so its tools are never arg-gated.
 */
export async function startMcpServer(
  allow?: ReadonlySet<string>,
  argGuards?: ReadonlyMap<string, ToolArgGuard>,
): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });
  const exposed = allow ? allTools.filter((t) => allow.has(t.tool.name)) : allTools;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposed.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    // Every tools/call text exit is sanitized: a lone UTF-16 surrogate in tool
    // output (often DB/API text via JSON.stringify, or a model-supplied tool
    // name) would otherwise poison the next request's tool_result block and make
    // the Anthropic API reject the whole request (400 "no low surrogate ...").
    if (!tool || (allow && !allow.has(name))) {
      return wellFormedToolResult({ content: [{ type: 'text', text: `Unknown tool: ${name}` }] });
    }
    if (allow && argGuards) {
      const reason = argGuards.get(name)?.((args ?? {}) as Record<string, unknown>);
      if (reason) {
        return wellFormedToolResult({
          content: [
            { type: 'text', text: JSON.stringify({ success: false, error_code: 'permission_denied', error: reason }) },
          ],
        });
      }
    }
    // RC5-ext P3 (C7): external-safe capability gate. When the turn resolves to
    // an authenticated external actor, default-deny every tool but the narrow
    // grant-scoped flow — the B6 content-confinement control. No-op on normal
    // (board/system) turns and on the FastAPI/replay surfaces.
    const externalDeny = denyIfExternalActorBlocked(name, (args ?? {}) as Record<string, unknown>);
    if (externalDeny) return wellFormedToolResult(externalDeny);
    // A handler that THROWS bypasses wellFormedToolResult: the error propagates
    // and the SDK records it (PostToolUseFailure has no output-rewrite hook), so
    // a lone surrogate in the message would poison the next request. Sanitize
    // the thrown message here — the only reachable point for our own tools.
    try {
      return wellFormedToolResult(await tool.handler(args ?? {}));
    } catch (err) {
      throw wellFormedError(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${exposed.length} tools: ${exposed.map((t) => t.tool.name).join(', ')}`);
}
