/**
 * Unit #406 — evaluateDestructiveAction wired into the destructive mutate MCP tools.
 *
 * WHY these tests matter (not just WHAT): the security boundary is the TOOL LAYER,
 * not the agent prompt. An indirect-prompt-injection can talk the model into
 * *calling* a legitimate tool ("remove the board", "reassign everything to X"). The
 * gate must REFUSE the high-impact call BEFORE any DB write — so each test asserts
 * the DB state is UNCHANGED after a gated call (a true no-op refusal), not merely
 * that the return shape differs. The contract (post-#407) is: gated → success:false,
 * error_code:'pending_approval', ZERO rows mutated, AND a taskflow_request_approval system row
 * written to outbound.db so the host can route it to a human approver.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeSessionDb, closeTaskflowDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { setVerbatimIds } from './taskflow-helpers.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';

let db: Database;

const BOARD = 'board-b1';

beforeEach(() => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
  initTestSessionDb(); // parkForApproval writes a taskflow_request_approval system row to outbound.db
});

afterEach(() => {
  closeTaskflowDb();
  closeSessionDb();
  setVerbatimIds(false);
  delete process.env.TASKFLOW_GATE_MASS;
});

/** Assert a gated call actually PARKED (wrote the request row) — proves the round-trip is initiated,
 *  not merely refused. Returns the parsed taskflow_request_approval content. */
function parkRow(): { action: string; tool: string; category: string; summary: string } {
  const row = getOutboundDb()
    .query("SELECT content FROM messages_out WHERE kind = 'system'")
    .get() as { content: string } | undefined;
  if (!row) throw new Error('expected a parked taskflow_request_approval row in outbound.db');
  return JSON.parse(row.content);
}

/** Directly seed an active task assigned to `assignee` (skips the create-default
 *  assignee semantics so the bulk-reassign source-person query is deterministic). */
function seedTask(id: string, assignee: string, column = 'next_action'): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, board_id, title, assignee, column, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, BOARD, `Task ${id}`, assignee, column, now, now);
}

function addPerson(personId: string, name = personId, role = 'member'): void {
  db.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, ?, ?, ?)`,
  ).run(BOARD, personId, name, role);
}

describe('api_admin structure gate (#406)', () => {
  it('remove_person is REFUSED before mutating — the board_person row survives', async () => {
    // WHY: a prompt-injected "remove Bob from the board" must be refused at the
    // tool layer, not just labeled. Assert the row still exists post-call.
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'remove_person',
      sender_name: 'alice',
      person_name: 'bob',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('pending_approval');
    expect(result.gate.category).toBe('structure');
    // No mutation: bob is still on the board.
    const row = db
      .prepare('SELECT person_id FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, 'bob');
    expect(row).not.toBeNull();
    // Round-trip initiated: a request row was parked for the host with the original tool + a summary.
    const parked = parkRow();
    expect(parked.action).toBe('taskflow_request_approval');
    expect(parked.tool).toBe('api_admin');
    expect(parked.category).toBe('structure');
    expect(parked.summary).toContain('remove_person');
  });

  it('remove_child_board is REFUSED before mutating — the registration row survives', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    db.prepare(
      `INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, 'bob', 'board-child')`,
    ).run(BOARD);
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'remove_child_board',
      sender_name: 'alice',
      person_name: 'bob',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('pending_approval');
    expect(result.gate.category).toBe('structure');
    const reg = db
      .prepare('SELECT child_board_id FROM child_board_registrations WHERE parent_board_id = ? AND person_id = ?')
      .get(BOARD, 'bob');
    expect(reg).not.toBeNull();
  });

  it('remove_admin is REFUSED with pending_approval/structure', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob', 'bob', 'manager');
    db.prepare(
      `INSERT INTO board_admins (board_id, person_id, admin_role) VALUES (?, 'bob', 'manager')`,
    ).run(BOARD);
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'remove_admin',
      sender_name: 'alice',
      person_name: 'bob',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('pending_approval');
    expect(result.gate.category).toBe('structure');
    const adminRow = db
      .prepare('SELECT person_id FROM board_admins WHERE board_id = ? AND person_id = ?')
      .get(BOARD, 'bob');
    expect(adminRow).not.toBeNull();
  });

  it('additive admin actions (set_wip_limit) are NOT gated — they commit normally', async () => {
    // Guards against over-gating that would block legitimate admin work.
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
      wip_limit: 3,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.error_code).toBeUndefined();
    const row = db
      .prepare('SELECT wip_limit FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, 'bob') as { wip_limit: number };
    expect(row.wip_limit).toBe(3);
  });

  it('tf-mcontrol/FastAPI path (verbatim ids) is NEVER gated — remove_person executes', async () => {
    // Protects the dashboard contract: the gate is chat-only. The FastAPI
    // subprocess sets verbatim ids and must not be approval-blocked.
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    setVerbatimIds(true);
    const response = await apiAdminTool.handler({
      board_id: BOARD,
      action: 'remove_person',
      sender_name: 'alice',
      person_name: 'bob',
    });
    const result = JSON.parse(response.content[0].text);
    // Not gated: the engine ran (success or an engine-level error, but NOT a gate refusal).
    expect(result.error_code).not.toBe('pending_approval');
  });
});

describe('api_move bulk mass_mutation gate (#406)', () => {
  it('task_ids of length >= massMutation(5) is REFUSED and NO task moves', async () => {
    // Encodes the threshold boundary + the fail-closed (no mutation) contract:
    // a 5-task bulk move must refuse and leave every column unchanged.
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const ids = ['T1', 'T2', 'T3', 'T4', 'T5'];
    for (const id of ids) seedTask(id, 'alice', 'next_action');
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_ids: ids,
      action: 'start',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('pending_approval');
    expect(result.gate.category).toBe('mass_mutation');
    // No mutation: every task is still in next_action.
    const moved = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND column != 'next_action'`)
      .get(BOARD) as { n: number };
    expect(moved.n).toBe(0);
  });

  it('task_ids of length 4 (< 5) commits normally (boundary just below threshold)', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const ids = ['T1', 'T2', 'T3', 'T4'];
    for (const id of ids) seedTask(id, 'alice', 'next_action');
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_ids: ids,
      action: 'start',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).not.toBe('pending_approval');
    // At least one task actually moved out of next_action.
    const moved = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND column = 'in_progress'`)
      .get(BOARD) as { n: number };
    expect(moved.n).toBeGreaterThan(0);
  });

  it('single task_id is never gated (affected=1)', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    seedTask('T1', 'alice', 'next_action');
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_id: 'T1',
      action: 'start',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).not.toBe('pending_approval');
  });

  it('verbatim path: a 5-task bulk move is NOT gated (dashboard contract)', async () => {
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    const ids = ['T1', 'T2', 'T3', 'T4', 'T5'];
    for (const id of ids) seedTask(id, 'alice', 'next_action');
    setVerbatimIds(true);
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_ids: ids,
      action: 'start',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).not.toBe('pending_approval');
  });

  it('env override TASKFLOW_GATE_MASS=2 gates a 2-task bulk move (no rebuild)', async () => {
    // Confirms the wired call honors resolveThresholds() overrides at runtime.
    const { apiMoveTool } = await import('./taskflow-api-mutate.ts');
    process.env.TASKFLOW_GATE_MASS = '2';
    seedTask('T1', 'alice', 'next_action');
    seedTask('T2', 'alice', 'next_action');
    const response = await apiMoveTool.handler({
      board_id: BOARD,
      task_ids: ['T1', 'T2'],
      action: 'start',
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('pending_approval');
    const moved = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND column != 'next_action'`)
      .get(BOARD) as { n: number };
    expect(moved.n).toBe(0);
  });
});

describe('api_reassign bulk mass_mutation gate (#406)', () => {
  it('source_person with >= 5 active tasks is REFUSED and assignees are UNCHANGED', async () => {
    // The DB-state assertion is load-bearing: a refusal must be a true no-op,
    // not just a different return shape. Strategy (i) runs an engine dry-run to
    // count; that dry-run must commit nothing.
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    addPerson('carol');
    for (let i = 1; i <= 5; i++) seedTask(`T${i}`, 'bob', 'next_action');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 'carol',
      source_person: 'bob',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('pending_approval');
    expect(result.gate.category).toBe('mass_mutation');
    // No mutation: all 5 tasks still assigned to bob, none to carol.
    const stillBob = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND assignee = 'bob'`)
      .get(BOARD) as { n: number };
    expect(stillBob.n).toBe(5);
    const toCarol = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND assignee = 'carol'`)
      .get(BOARD) as { n: number };
    expect(toCarol.n).toBe(0);
  });

  it('source_person with 4 active tasks (< 5) commits normally', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    addPerson('carol');
    for (let i = 1; i <= 4; i++) seedTask(`T${i}`, 'bob', 'next_action');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 'carol',
      source_person: 'bob',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).not.toBe('pending_approval');
    expect(result.success).toBe(true);
    const toCarol = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND assignee = 'carol'`)
      .get(BOARD) as { n: number };
    expect(toCarol.n).toBe(4);
  });

  it('single task_id reassign is never gated (affected=1)', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    seedTask('T1', 'alice', 'next_action');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      task_id: 'T1',
      target_person: 'bob',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).not.toBe('pending_approval');
    expect(result.success).toBe(true);
    const row = db.prepare('SELECT assignee FROM tasks WHERE id = ?').get('T1') as { assignee: string };
    expect(row.assignee).toBe('bob');
  });

  it('dry-run (confirmed=false) is NOT refused — the agent needs the summary to decide', async () => {
    // requires_confirmation is a DIFFERENT mechanism; don't conflate it with the
    // pending_approval gate. The gate fires ONLY on the confirmed=true path.
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    addPerson('carol');
    for (let i = 1; i <= 6; i++) seedTask(`T${i}`, 'bob', 'next_action');
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 'carol',
      source_person: 'bob',
      sender_name: 'alice',
      confirmed: false,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).not.toBe('pending_approval');
    expect(result.success).toBe(true);
    expect(result.data.requires_confirmation).toBeDefined();
  });

  it('verbatim path: a >=5 bulk transfer is NOT gated (dashboard contract)', async () => {
    const { apiReassignTool } = await import('./taskflow-api-mutate.ts');
    addPerson('bob');
    addPerson('carol');
    for (let i = 1; i <= 5; i++) seedTask(`T${i}`, 'bob', 'next_action');
    setVerbatimIds(true);
    const response = await apiReassignTool.handler({
      board_id: BOARD,
      target_person: 'carol',
      source_person: 'bob',
      sender_name: 'alice',
      confirmed: true,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).not.toBe('pending_approval');
  });
});

describe('api_delete_simple_task gate seat (#406)', () => {
  it('with defaults is NOT gated and still archives the task (affected=1, no history erase)', async () => {
    // Documents the deliberate OPEN state: the single recoverable delete archives
    // (does not erase history), so the delete gate never fires under defaults.
    // A future bulk-delete/purge change becomes a VISIBLE test diff here, not a
    // silent behavior shift.
    const { apiCreateSimpleTaskTool, apiDeleteSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const created = await apiCreateSimpleTaskTool.handler({
      board_id: BOARD,
      title: 'Delete me',
      sender_name: 'alice',
    });
    const taskId = JSON.parse(created.content[0].text).data.id;
    const response = await apiDeleteSimpleTaskTool.handler({
      board_id: BOARD,
      task_id: taskId,
      sender_name: 'alice',
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.error_code).not.toBe('pending_approval');
    // Archived (recoverable), live row gone.
    const live = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
    expect(live).toBeNull();
    const archived = db.prepare('SELECT task_id FROM archive WHERE task_id = ?').get(taskId);
    expect(archived).not.toBeNull();
  });
});

// #407 — the approved re-run. When the host approves a parked action it triggers a deterministic
// replay (isApprovedReplay) that must BYPASS the gate (else the approved action would re-park forever)
// while still pinning the board. These verify the bypass and the executor wiring the replay depends on.
describe('approved-replay bypass + executor registry (#407)', () => {
  it('isApprovedReplay() bypasses the structure gate — the approved re-run is not re-parked', async () => {
    const { apiAdminTool } = await import('./taskflow-api-mutate.ts');
    const { runAsApprovedReplay } = await import('./taskflow-approval.ts');
    addPerson('bob');
    // alice is a board admin (withBoardAdmins), so under the bypass the engine actually runs.
    const response = await runAsApprovedReplay(() =>
      apiAdminTool.handler({ board_id: BOARD, action: 'remove_person', sender_name: 'alice', person_name: 'bob' }),
    );
    const result = JSON.parse(response.content[0].text);
    expect(result.error_code).not.toBe('pending_approval'); // gate skipped on the approved re-run
    // And it actually executed: bob is gone (the whole point of approving).
    expect(db.prepare('SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?').get(BOARD, 'bob')).toBeFalsy();
  });

  it('registers an approved executor for every gated tool the host can replay', async () => {
    await import('./taskflow-api-mutate.ts'); // registration side-effect
    const { getApprovedExecutor } = await import('./taskflow-approval.ts');
    for (const tool of ['api_admin', 'api_move', 'api_reassign', 'api_delete_simple_task']) {
      expect(getApprovedExecutor(tool)).toBeDefined();
    }
  });
});
