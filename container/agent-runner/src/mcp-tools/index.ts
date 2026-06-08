/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import './send-otp.js';
import './transcribe-audio.js';
import './provision-root-board.js';
import './provision-child-board.js';
import './create-group.js';
import './add-destination.js';
import './taskflow-api-read.js';
import './taskflow-api-mutate.js';
import './taskflow-api-update.js';
import './taskflow-api-notes.js';
// taskflow-api-board.js is INTENTIONALLY NOT imported into the chat barrel: its tools read
// board_id verbatim (no normalizeAgentIds) and rely on FastAPI-side owner auth, so exposing them
// to chat is a cross-board escape. They are registered only by taskflow-server-entry.ts (FastAPI),
// and additionally fail-closed on !getVerbatimIds() (see fastApiOnly in taskflow-api-board.ts).
import './rename-board-person.js';
import './taskflow-api-comment.js';
import './memory.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
