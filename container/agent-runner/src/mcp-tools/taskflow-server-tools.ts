/**
 * Shared FastAPI TaskFlow tool surface — the SINGLE SOURCE OF TRUTH for which
 * tools the tf-mcontrol FastAPI MCP client may see/call. Imported by BOTH:
 *   - `taskflow-server-entry.ts` (the running server passes `FASTAPI_ALLOWLIST`
 *     to `startMcpServer`, which gates `tools/list` AND `tools/call`), and
 *   - `contract.ts` (the published contract artifact filters the registry by the
 *     SAME allowlist), so the committed `contract.json` can never drift from what
 *     the server actually exposes.
 *
 * The side-effect imports below each call `registerTools([...])` at module scope,
 * so importing this module populates the registry. `taskflow-api-board.ts` is
 * registered here (FastAPI-only; the in-container chat barrel `index.ts`
 * deliberately omits it).
 */
// Side-effect imports — each calls registerTools([...]) at module scope.
import './taskflow-api-read.js';
import './taskflow-api-mutate.js';
import './taskflow-api-update.js';
import './taskflow-api-notes.js';
import './taskflow-api-board.js';
import './taskflow-api-comment.js';
import './taskflow-api-chat.js';
// R5: serialized board-scoped READ tools — FastAPI-only (NOT in the chat barrel
// index.ts), allowlisted below so the dashboard routes reads through the engine.
import './taskflow-api-serialized-read.js';

/**
 * The exact tool surface the tf-mcontrol FastAPI MCP client may use.
 * Only tools that are BOTH registered AND a real FastAPI call site
 * today — least-privilege, add-on-migration (Codex NICE 2026-05-16: do
 * not pre-authorize unbuilt names, or a future same-named tool would
 * auto-expose). Each new board mutation adds its name here in the same
 * commit that lands the tool. The remaining tools `taskflow-api-mutate.ts`
 * registers but does NOT allowlist — `api_admin`, `api_report`,
 * `api_dependency` — stay WhatsApp-agent orchestration, deliberately
 * excluded. (move/reassign/hierarchy/create_task/update_task/
 * create_meeting_task/reschedule_meeting/note_meeting/query were added in
 * #385 §6; api_query is additionally sub-mode-gated; api_undo was added by
 * R2 `ea37203f`, the five serialized read tools by R5 `b5ca9de9`.)
 */
export const FASTAPI_ALLOWLIST: ReadonlySet<string> = new Set([
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
  // reads). Sub-mode-gated by the entry's FASTAPI_ARG_GUARDS: api_query also
  // exposes org-wide cross-board read modes that the board-local dashboard
  // must NOT reach.
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
  // R5 (INBOUND tf-mcontrol 2026-06-10): serialized board-scoped READ tools so the dashboard
  // routes taskflow-domain reads through the engine (kills visibleTaskScope + enrichment drift).
  // Each returns the canonical serialized shape; FastAPI does ZERO enrichment. Board-scoped reads
  // (normalizeAgentIds pins board_id), so no fastApiOnly fail-closed guard is needed.
  'api_board_tasks',
  'api_board_detail',
  'api_list_holidays',
  'api_list_comments',
  'api_runner_status',
  'api_runner_status_batch', // all-boards variant (tf-mcontrol 2026-06-11) — replaces the per-board fan-out
]);
