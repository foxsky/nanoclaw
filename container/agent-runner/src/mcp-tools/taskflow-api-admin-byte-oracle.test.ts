import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';
import { apiAdminTool } from './taskflow-api-mutate.js';

/**
 * R2.6 byte-oracle safety net for the single-engine board-config rework
 * (design: .claude/skills/add-taskflow/docs/2026-05-16-single-engine-board-rework.md,
 * Revision 2.1). The next unit extracts `register_person`/`remove_person`/
 * `set_wip_limit` bodies out of the `api_admin` dispatcher into shared
 * engine cores and repoints the `api_admin` cases at them.
 *
 * WhatsApp byte-output MUST NOT change by a single byte. The parity break
 * surfaces are exactly: `finalizeMutationResult()` (taskflow-api-mutate.ts:119,
 * which nests engine `data` under another `data` key and appends
 * `notification_events`) and the `requirePerson()` throw → outer
 * `try/catch` at taskflow-engine.ts:9243 → `{success:false,error}` path.
 *
 * These assert the EXACT serialized MCP text (`content[0].text`), not a
 * parsed subset — that is the literal R2.6 requirement: capture
 * pre-extraction output, assert byte-identical post-extraction. Each
 * fixture's comment states WHY its shape is what it is so a future reader
 * can tell an intentional contract from a regression.
 */

const BOARD = 'board-b1';
let db: Database;

beforeEach(() => {
  // withBoardAdmins seeds `alice` as a board_admins manager so the
  // dispatcher's pre-switch `isManager(sender_name)` gate (8165) passes
  // for the success fixtures.
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
});

afterEach(() => {
  closeTaskflowDb();
});

function adminText(args: Record<string, unknown>): Promise<string> {
  return apiAdminTool.handler(args).then((r) => r.content[0].text);
}

describe('api_admin byte-oracle — set_wip_limit', () => {
  it('success: {success:true,data:{person,wip_limit},notification_events:[]}', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const text = await adminText({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
      wip_limit: 3,
    });
    // engine → {success:true,data:{person,wip_limit}}; finalizeMutationResult
    // re-nests engine `data` under its own `data` key (the nested `data.data`
    // is the real, load-bearing contract — UI/golden depends on it).
    expect(text).toBe(
      '{"success":true,"data":{"data":{"person":"bob","wip_limit":3}},"notification_events":[]}',
    );
  });

  it('wip_limit 0 is accepted (engine rejects null/negative, not 0)', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const text = await adminText({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
      wip_limit: 0,
    });
    expect(text).toBe('{"success":true,"data":{"data":{"person":"bob","wip_limit":0}},"notification_events":[]}');
  });

  it('negative wip_limit → engine error (success:false, no data nesting)', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const text = await adminText({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
      wip_limit: -1,
    });
    expect(text).toBe('{"success":false,"error":"Missing or invalid parameter: wip_limit (must be >= 0).","notification_events":[]}');
  });

  it('omitted wip_limit → engine null-branch rejection (≠ handler type-reject)', async () => {
    // wip_limit:null is rejected by the handler's typeof check BEFORE the
    // engine. The engine's `wip_limit == null` branch is reachable only
    // when the key is OMITTED (not added to adminParams → undefined).
    // The extraction must preserve this engine-side rejection.
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const text = await adminText({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'alice',
      person_name: 'bob',
    });
    expect(text).toBe('{"success":false,"error":"Missing or invalid parameter: wip_limit (must be >= 0).","notification_events":[]}');
  });
});

describe('api_admin byte-oracle — remove_person', () => {
  it('not-found: requirePerson throws → outer catch → {success:false,error}', async () => {
    const text = await adminText({
      board_id: BOARD,
      action: 'remove_person',
      sender_name: 'alice',
      person_name: 'ghost',
    });
    expect(text).toBe('{"success":false,"error":"Person not found: ghost","notification_events":[]}');
  });

  it('no active tasks → delete; {success:true,data:{removed,tasks_unassigned:0}}', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const text = await adminText({
      board_id: BOARD,
      action: 'remove_person',
      sender_name: 'alice',
      person_name: 'bob',
    });
    expect(text).toBe('{"success":true,"data":{"data":{"removed":"bob","tasks_unassigned":0}},"notification_events":[]}');
  });

  it('active tasks, no force → success:true + top-level tasks_to_reassign + data.message', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, column, created_at, updated_at)
       VALUES ('T1', ?, 'Task one', 'bob', 'inbox', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:00.000Z')`,
    ).run(BOARD);
    const text = await adminText({
      board_id: BOARD,
      action: 'remove_person',
      sender_name: 'alice',
      person_name: 'bob',
    });
    expect(text).toBe('{"success":true,"data":{"tasks_to_reassign":[{"task_id":"T1","title":"Task one"}],"data":{"message":"bob has 1 active task(s). Use force=true to unassign them, or reassign first."}},"notification_events":[]}');
  });

  it('active tasks + force → unassign + delete; {removed,tasks_unassigned:n}', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, assignee, column, created_at, updated_at)
       VALUES ('T1', ?, 'Task one', 'bob', 'inbox', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:00.000Z')`,
    ).run(BOARD);
    const text = await adminText({
      board_id: BOARD,
      action: 'remove_person',
      sender_name: 'alice',
      person_name: 'bob',
      force: true,
    });
    expect(text).toBe('{"success":true,"data":{"data":{"removed":"bob","tasks_unassigned":1}},"notification_events":[]}');
  });
});

/** `register_person` reads `boards.hierarchy_level/max_depth` (via
 *  `canDelegateDown()`) and INSERTs `board_people.phone` — all real prod
 *  columns the shared fixture omits. Add them per-test (boards hierarchy
 *  NULL ⇒ non-hierarchy/leaf, canDelegateDown false; set ⇒ hierarchy). */
function addRegisterCols(level: number | null, maxDepth: number | null): void {
  db.exec(`ALTER TABLE boards ADD COLUMN hierarchy_level INTEGER`);
  db.exec(`ALTER TABLE boards ADD COLUMN max_depth INTEGER`);
  db.exec(`ALTER TABLE board_people ADD COLUMN phone TEXT`);
  db.prepare(`UPDATE boards SET hierarchy_level = ?, max_depth = ? WHERE id = ?`).run(
    level,
    maxDepth,
    BOARD,
  );
}

describe('api_admin byte-oracle — register_person', () => {
  it('success-leaf (non-hierarchy): slug person_id, no auto_provision', async () => {
    addRegisterCols(null, null);
    const text = await adminText({
      board_id: BOARD,
      action: 'register_person',
      sender_name: 'alice',
      person_name: 'Bob Silva',
    });
    expect(text).toBe('{"success":true,"data":{"person_id":"bob-silva","data":{"name":"Bob Silva","person_id":"bob-silva"}},"notification_events":[]}');
  });

  it('duplicate register → engine {success:false,error} (exists)', async () => {
    addRegisterCols(null, null);
    await adminText({
      board_id: BOARD,
      action: 'register_person',
      sender_name: 'alice',
      person_name: 'Bob Silva',
    });
    const text = await adminText({
      board_id: BOARD,
      action: 'register_person',
      sender_name: 'alice',
      person_name: 'Bob Silva',
    });
    expect(text).toBe('{"success":false,"error":"Person \\"Bob Silva\\" (bob-silva) already exists on this board.","notification_events":[]}');
  });

  it('hierarchy board, missing phone/group_name/group_folder → reject', async () => {
    addRegisterCols(0, 2);
    const text = await adminText({
      board_id: BOARD,
      action: 'register_person',
      sender_name: 'alice',
      person_name: 'Bob Silva',
    });
    expect(text).toBe('{"success":false,"error":"register_person on a hierarchy board requires phone, group_name, group_folder alongside person_name — every new team member gets an auto-provisioned child board named after the division/sector, which needs the phone for the DM invite and group_name/group_folder for the board identity. Ask the user for the missing field(s) before retrying. (If the person is a manager/delegate who should NOT have their own child board, use add_manager/add_delegate on an existing board_people row instead of register_person.)","notification_events":[]}');
  });

  it('hierarchy board + phone/group fields → success w/ auto_provision_request', async () => {
    addRegisterCols(0, 2);
    const text = await adminText({
      board_id: BOARD,
      action: 'register_person',
      sender_name: 'alice',
      person_name: 'Bob Silva',
      phone: '5585999990000',
      group_name: 'Setor X',
      group_folder: 'setor-x',
    });
    expect(text).toBe('{"success":true,"data":{"person_id":"bob-silva","data":{"name":"Bob Silva","person_id":"bob-silva"},"auto_provision_request":{"person_id":"bob-silva","person_name":"Bob Silva","person_phone":"5585999990000","person_role":"member","group_name":"Setor X","group_folder":"setor-x","message":"Quadro filho para Bob Silva será provisionado automaticamente."}},"notification_events":[]}');
  });
});

describe('api_admin byte-oracle — permission denial', () => {
  it('non-manager sender → pre-switch gate {success:false,error}', async () => {
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'carol', 'carol', 'member')`,
    ).run(BOARD);
    const text = await adminText({
      board_id: BOARD,
      action: 'set_wip_limit',
      sender_name: 'carol',
      person_name: 'carol',
      wip_limit: 2,
    });
    expect(text).toBe('{"success":false,"error":"Permission denied: \\"carol\\" is not a manager.","notification_events":[]}');
  });
});
