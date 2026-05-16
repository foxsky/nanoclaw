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

import type { McpToolDefinition } from './types.js';

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

/**
 * `allow` restricts the exposed surface to the named tools, gating BOTH
 * `tools/list` AND the `tools/call` path (a registered-but-disallowed
 * tool must be unlisted *and* uncallable — `tools/call` resolves from
 * `toolMap`, not the listed set). Omit `allow` for the full in-container
 * barrel; the standalone taskflow entrypoint passes its FastAPI-facing
 * allowlist so the subprocess can't reach `api_admin`/hierarchy/etc.
 */
export async function startMcpServer(allow?: ReadonlySet<string>): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });
  const exposed = allow ? allTools.filter((t) => allow.has(t.tool.name)) : allTools;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposed.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool || (allow && !allow.has(name))) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return tool.handler(args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${exposed.length} tools: ${exposed.map((t) => t.tool.name).join(', ')}`);
}
