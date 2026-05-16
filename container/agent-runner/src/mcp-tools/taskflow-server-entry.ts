/**
 * Standalone TaskFlow MCP server entrypoint for tf-mcontrol's FastAPI
 * MCP client (`MCPSubprocessClient`). Spawned as:
 *
 *   bun taskflow-server-entry.ts --db <taskflow.db path>
 *
 * Distinct from `index.ts` — that barrel registers the FULL nanoclaw tool
 * surface (send_message, self-mod, scheduling, agents …) for the
 * in-container agent. Exposing that to the FastAPI subprocess would let
 * the API impersonate the agent, so this entrypoint registers ONLY the
 * TaskFlow `api_*` tools.
 *
 * Contract with tf-mcontrol's MCPSubprocessClient:
 *   - DB path comes from `--db <path>` (not the fixed /workspace mount)
 *   - the literal `MCP server ready` is emitted on stderr once connected
 *     (the parent blocks on that sentinel before handshaking)
 *   - MCP JSON-RPC over stdio (StdioServerTransport)
 */
import { initTaskflowDb } from '../db/connection.js';
// Side-effect imports — each calls registerTools([...]) at module scope.
// ONLY the taskflow modules; deliberately NOT './core.js' et al.
import './taskflow-api-read.js';
import './taskflow-api-mutate.js';
import './taskflow-api-update.js';
import './taskflow-api-notes.js';
import './taskflow-api-board.js';
import { startMcpServer } from './server.js';

const dbIdx = process.argv.indexOf('--db');
const dbPath = dbIdx === -1 ? undefined : process.argv[dbIdx + 1];
if (!dbPath) {
  process.stderr.write('taskflow-server-entry: missing required --db <path>\n');
  process.exit(2);
}

initTaskflowDb(dbPath);
await startMcpServer();
process.stderr.write('MCP server ready\n');
