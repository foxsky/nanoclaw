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
import { setServiceOutboundDbPath, setVerbatimIds } from './taskflow-helpers.js';
// Side-effect imports — each calls registerTools([...]) at module scope.
import './taskflow-api-read.js';
import './taskflow-api-mutate.js';
import './taskflow-api-update.js';
import './taskflow-api-notes.js';
import './taskflow-api-board.js';
import './taskflow-api-comment.js';
import './taskflow-api-chat.js';
import { startMcpServer, type ToolArgGuard } from './server.js';

/**
 * The exact tool surface the tf-mcontrol FastAPI MCP client may use.
 * Only tools that are BOTH registered AND a real FastAPI call site
 * today — least-privilege, add-on-migration (Codex NICE 2026-05-16: do
 * not pre-authorize unbuilt names, or a future same-named tool would
 * auto-expose). Each new board mutation adds its name here in the same
 * commit that lands the tool. The remaining tools `taskflow-api-mutate.ts`
 * registers but does NOT allowlist — `api_admin`, `api_undo`,
 * `api_report`, `api_dependency` — stay WhatsApp-agent orchestration,
 * deliberately excluded. (move/reassign/hierarchy/create_task/update_task/
 * create_meeting_task/reschedule_meeting/note_meeting/query were added to
 * the allowlist below in #385 §6; api_query is additionally sub-mode-gated.)
 */
const FASTAPI_ALLOWLIST: ReadonlySet<string> = new Set([
  // task / note (already on the engine; FastAPI calls these in prod)
  'api_create_simple_task',
  'api_update_simple_task',
  'api_delete_simple_task',
  // Task moves go through the state machine (start/wait/review/approve/reject/
  // conclude/reopen) instead of a raw column-set, so transition rules, role
  // gates and the approval/review workflow are enforced. The dashboard POST
  // /boards/{id}/tasks/{id}/move uses api_move_to_column (engine resolves the
  // action from the target column — one source of truth); api_move stays for
  // explicit-action callers / future batch approvals.
  'api_move',
  'api_move_to_column',
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
  // web-chat ingress (0h-v2 §0.3): board_chat round-trip, dashboard-
  // only, NOT WhatsApp. tf-mcontrol POST /chat → this tool.
  'api_send_chat',
  // composite read-side wrapper (stats / archive / completed / meeting
  // reads). Sub-mode-gated below: api_query also exposes org-wide
  // cross-board read modes that the board-local dashboard must NOT reach.
  'api_query',
  // meeting tools (#385 §6): create + name/M-id-resolved reschedule/note.
  // Reschedule/note resolve the meeting by name; a 2+-match returns a
  // success:true + data.candidates disambiguation (no mutation).
  'api_create_meeting_task',
  'api_reschedule_meeting',
  'api_note_meeting',
  // reassign (single + dry-run bulk transfer), hierarchy link/unlink/
  // refresh_rollup/tag_parent (NOT reparent/detach — those stay api_admin,
  // unexposed), and the rich create/update tools (#385 §6). NOTE: their
  // shared-helper failure paths (parseTaskActorArgs arg-shape, codeless
  // create/dispatcher results) are NOT yet structured — see the coordination
  // doc residuals; the per-handler arg-shape rejections map cleanly here.
  'api_reassign',
  'api_hierarchy',
  'api_create_task',
  'api_update_task',
  // R2 (INBOUND tf-mcontrol 2026-06-10): the dashboard UndoSnackbar routes through the
  // transactional engine.undo (60s window + WIP + author/manager gate) instead of a raw column
  // re-PATCH. Arg-shape rejections → validation_error; engine refusals → conflict /
  // permission_denied (engine.undo error codes). FastAPI resolves the actor (sender_name).
  'api_undo',
]);

/**
 * `api_query` is ONE tool gating ALL its read sub-modes (the `query`
 * discriminator). Most are board-local (scoped to the constructor
 * board_id), but three deliberately read ACROSS the board's org tree via
 * `orgScopeOrNull()` and leak cross-board data:
 *   - find_person_in_organization → people incl. `routing_jid` across the
 *     whole subtree (taskflow-engine.ts findPersonInOrganization)
 *   - find_task_in_organization   → sibling/parent/child board task rows
 *   - board_directory             → org-tree board structure + responsible
 *     people (buildBoardDirectory)
 * The dashboard is a board-local product, so the FastAPI surface rejects
 * these. The in-container WhatsApp agent keeps full access (it calls
 * `startMcpServer()` with no allowlist, so `argGuards` is never consulted)
 * — it uses them for cross-board sends/provisioning per the tool
 * description. KEEP IN SYNC with engine `query()` modes that call
 * `orgScopeOrNull()` / `getBoardLineage()`.
 *
 * SCOPE LIMIT (flagged in coordination doc §8): this arg-level guard blocks
 * the 3 ORG-ENUMERATION modes above — they scan BEYOND this board's own view
 * (the whole org subtree) and are decidable from the args alone. It does NOT
 * (and by design need not) block the modes that surface this board's OWN
 * legitimate view, which the engine intentionally extends past `board_id =
 * this.boardId` by TWO further mechanisms — the same data the in-container
 * WhatsApp agent for this board already sees:
 *   - child_exec DELEGATION: `visibleTaskScope()` (engine ~1116) adds
 *     `OR (child_exec_board_id = this.boardId AND child_exec_enabled = 1)`,
 *     and `getLinkedTasks()` (~2422) returns delegated parent-board task rows.
 *     ~25 list modes (board/inbox/overdue/due_today/due_this_week/search/
 *     urgent/by_label/statistics/summary/meetings/agenda/my_tasks/
 *     person_tasks/…) surface
 *     tasks a parent board DELEGATED to this board for execution.
 *   - lineage PARTICIPANT reads: `getVisibleTask()` (~1891) can return a
 *     PARENT/ancestor-board MEETING when this board is a participant. 8 modes
 *     (task_details/task_history/meeting_agenda/meeting_minutes/
 *     meeting_participants/meeting_open_items/meeting_history/
 *     meeting_minutes_at).
 * Both return ANCESTOR data this board legitimately executes/participates in
 * (not org-wide enumeration), so they are NOT in the denylist. Whether the
 * dashboard should present an even STRICTER board-only view (excluding
 * delegated-in + participant data the WhatsApp agent shows) is an OPEN product
 * decision; sealing it needs a board-strict engine flag (collapse
 * visibleTaskScope to `board_id = ?` and use getTask not getVisibleTask on the
 * FastAPI path) — a deeper cross-consumer change NOT made in this clean-subset
 * build. Found by the falsification review (workflow w3t40tjo1).
 */
const ORG_WIDE_QUERY_MODES: ReadonlySet<string> = new Set([
  'find_person_in_organization',
  'find_task_in_organization',
  'board_directory',
]);

const FASTAPI_ARG_GUARDS: ReadonlyMap<string, ToolArgGuard> = new Map([
  [
    'api_query',
    (args) => {
      const mode = typeof args.query === 'string' ? args.query : '';
      return ORG_WIDE_QUERY_MODES.has(mode)
        ? `query mode '${mode}' is org-wide (cross-board) and not permitted on the dashboard surface`
        : null;
    },
  ],
]);

const dbIdx = process.argv.indexOf('--db');
const dbPath = dbIdx === -1 ? undefined : process.argv[dbIdx + 1];
if (!dbPath) {
  process.stderr.write('taskflow-server-entry: missing required --db <path>\n');
  process.exit(2);
}

// 0h-v2 Option A: the TaskFlow service session's outbound.db path
// (ACKed `--service-outbound-db` contract). OPTIONAL — unlike `--db`,
// absence does NOT exit: tf fail-mode (b) is that `enqueueOutboundMessage`
// callers fail-closed per-call, keeping non-notify tools usable during
// the partial-deploy window before the operator sets the env.
const svcIdx = process.argv.indexOf('--service-outbound-db');
const svcOutboundDb = svcIdx === -1 ? undefined : process.argv[svcIdx + 1];
setServiceOutboundDbPath(svcOutboundDb);

// FastAPI passes canonical ids verbatim — disable normalizeAgentIds'
// board-prefixing/task-id-casing for the WHOLE subprocess (covers
// task/note/read tools too, not just the board tools). In-container
// barrel never calls this, so the WhatsApp agent is unaffected.
setVerbatimIds(true);
initTaskflowDb(dbPath);
await startMcpServer(FASTAPI_ALLOWLIST, FASTAPI_ARG_GUARDS);
process.stderr.write('MCP server ready\n');
