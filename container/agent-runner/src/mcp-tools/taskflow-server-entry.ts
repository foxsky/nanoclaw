/**
 * Standalone TaskFlow MCP server entrypoint for tf-mcontrol's FastAPI
 * MCP client (`MCPSubprocessClient`). Spawned as:
 *
 *   bun taskflow-server-entry.ts --db <taskflow.db path>
 *
 * Distinct from `index.ts` (the full in-container barrel). This imports
 * only the taskflow modules — but `taskflow-api-mutate.ts` transitively
 * registers WhatsApp-agent-only tools (`api_admin`, `api_hierarchy`,
 * `api_move`, `api_reassign`, `api_undo`, `api_report`, `api_create_task`,
 * `api_update_task`, `api_create_meeting_task`, …). Exposing those to the
 * FastAPI subprocess would let the API drive agent-only admin/hierarchy
 * operations, so the FastAPI-facing surface is restricted by
 * `FASTAPI_ALLOWLIST` below (gates BOTH `tools/list` and `tools/call`).
 *
 * Contract with tf-mcontrol's MCPSubprocessClient:
 *   - DB path comes from `--db <path>` (not the fixed /workspace mount)
 *   - the literal `MCP server ready` is emitted on stderr once connected
 *     (the parent blocks on that sentinel before handshaking)
 *   - MCP JSON-RPC over stdio (StdioServerTransport)
 */
import { initTaskflowDb } from '../db/connection.js';
import { setVerbatimIds } from './taskflow-helpers.js';
// Side-effect imports — each calls registerTools([...]) at module scope.
import './taskflow-api-read.js';
import './taskflow-api-mutate.js';
import './taskflow-api-update.js';
import './taskflow-api-notes.js';
import './taskflow-api-board.js';
import './taskflow-api-comment.js';
import { startMcpServer } from './server.js';

/**
 * The exact tool surface the tf-mcontrol FastAPI MCP client may use.
 * Only tools that are BOTH registered AND a real FastAPI call site
 * today — least-privilege, add-on-migration (Codex NICE 2026-05-16: do
 * not pre-authorize unbuilt names, or a future same-named tool would
 * auto-expose). Each new board mutation adds its name here in the same
 * commit that lands the tool. Everything else `taskflow-api-mutate.ts`
 * registers (`api_admin`/hierarchy/move/reassign/undo/report/
 * create_task/update_task/create_meeting_task/query/dependency) is
 * WhatsApp-agent orchestration — deliberately excluded.
 */
const FASTAPI_ALLOWLIST: ReadonlySet<string> = new Set([
  // task / note (already on the engine; FastAPI calls these in prod)
  'api_create_simple_task',
  'api_update_simple_task',
  'api_delete_simple_task',
  'api_task_add_note',
  'api_task_edit_note',
  'api_task_remove_note',
  // engine read tools (FastAPI call sites: board_activity/filter/linked)
  'api_board_activity',
  'api_filter_board_tasks',
  'api_linked_tasks',
  // board-config / people — built + registered (R2.7). Holiday/chat/
  // comment tools add their names here when they land.
  'api_create_board',
  'api_delete_board',
  'api_add_holiday',
  'api_remove_holiday',
  'api_update_board',
  'api_add_board_person',
  'api_remove_board_person',
  'api_update_board_person',
  // task comment (engine-backed; FastAPI-path push delivery is the
  // tracked 0h-v2 / Phase-3 item — the DB write + WhatsApp-path
  // notify land now).
  'api_task_add_comment',
]);

const dbIdx = process.argv.indexOf('--db');
const dbPath = dbIdx === -1 ? undefined : process.argv[dbIdx + 1];
if (!dbPath) {
  process.stderr.write('taskflow-server-entry: missing required --db <path>\n');
  process.exit(2);
}

// FastAPI passes canonical ids verbatim — disable normalizeAgentIds'
// board-prefixing/task-id-casing for the WHOLE subprocess (covers
// task/note/read tools too, not just the board tools). In-container
// barrel never calls this, so the WhatsApp agent is unaffected.
setVerbatimIds(true);
initTaskflowDb(dbPath);
await startMcpServer(FASTAPI_ALLOWLIST);
process.stderr.write('MCP server ready\n');
