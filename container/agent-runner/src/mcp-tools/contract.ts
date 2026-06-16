/**
 * Published MCP contract artifact (L4 cross-agent seam with tf-mcontrol).
 *
 * `buildMcpContract()` returns the engine's FastAPI `tools/list` surface — the
 * EXACT set `taskflow-server-entry.ts` exposes (the registry filtered by
 * `FASTAPI_ALLOWLIST`) — in the raw `tools/list` shape tf-mcontrol's drift
 * checker normalizes (`taskflow-api/tests/test_mcp_contract_drift.py`): keyed by
 * `name`, `inputSchema` IS the contract, `description` is prompt text. We emit
 * the raw array (incl. `description`); their checker drops it.
 *
 * The committed `contract.json` (regenerate: `bun mcp-tools/taskflow-server-entry.ts
 * --dump-contract > mcp-tools/contract.json`) lets the dashboard CI diff its
 * golden baseline against this WITHOUT booting bun. `contract.test.ts` asserts
 * the committed file equals this builder's output, so the artifact can never go
 * stale: change an allowlisted tool's schema → that test fails until you
 * regenerate + commit. See `2026-06-15-INBOUND-from-tf-mcontrol-...` and the
 * coordination request.
 *
 * Importing this module registers the FastAPI tools (via taskflow-server-tools).
 */
import './taskflow-server-tools.js';
import { FASTAPI_ALLOWLIST } from './taskflow-server-tools.js';
import { getAllRegisteredTools, SERVER_INFO } from './server.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** The MCP protocol version the SDK speaks (pinned for the contract; if the SDK
 *  bumps it, the dashboard re-baselines — it's informational, not the boundary). */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpContract {
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  tools: Tool[];
}

/** The FastAPI tools/list surface, sorted by name for stable diffs. */
export function buildMcpContract(): McpContract {
  const tools = getAllRegisteredTools()
    .map((t) => t.tool)
    .filter((tool) => FASTAPI_ALLOWLIST.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools,
  };
}
