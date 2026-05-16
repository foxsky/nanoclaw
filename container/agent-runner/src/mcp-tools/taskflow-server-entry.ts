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
// Side-effect imports — each calls registerTools([...]) at module scope.
import './taskflow-api-read.js';
import './taskflow-api-mutate.js';
import './taskflow-api-update.js';
import './taskflow-api-notes.js';
import './taskflow-api-board.js';
import { startMcpServer } from './server.js';

/**
 * The exact tool surface the tf-mcontrol FastAPI MCP client may use:
 * the 6 already-migrated task/note mutations + the 3 engine read tools
 * + the 10 board/people/holiday/chat/comment mutations (present and
 * to-land). Everything else `taskflow-api-mutate.ts` registers
 * (`api_admin`/hierarchy/move/reassign/undo/report/create_task/
 * update_task/create_meeting_task/query/dependency) is WhatsApp-agent
 * orchestration — deliberately excluded. Add a name here only when an
 * endpoint legitimately needs it.
 */
const FASTAPI_ALLOWLIST: ReadonlySet<string> = new Set([
  // task / note (already on the engine; FastAPI calls these in prod)
  'api_create_simple_task',
  'api_update_simple_task',
  'api_delete_simple_task',
  'api_task_add_note',
  'api_task_edit_note',
  'api_task_remove_note',
  // engine read tools
  'api_board_activity',
  'api_filter_board_tasks',
  'api_linked_tasks',
  // the 10 board-config / people / holiday / chat / comment mutations
  'api_create_board',
  'api_update_board',
  'api_delete_board',
  'api_add_board_person',
  'api_remove_board_person',
  'api_update_board_person',
  'api_add_holiday',
  'api_remove_holiday',
  'api_send_chat',
  'api_add_task_comment',
]);

const dbIdx = process.argv.indexOf('--db');
const dbPath = dbIdx === -1 ? undefined : process.argv[dbIdx + 1];
if (!dbPath) {
  process.stderr.write('taskflow-server-entry: missing required --db <path>\n');
  process.exit(2);
}

initTaskflowDb(dbPath);
await startMcpServer(FASTAPI_ALLOWLIST);
process.stderr.write('MCP server ready\n');
